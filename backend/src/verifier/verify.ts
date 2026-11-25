import type { ClaimInput, Verdict, VerifyPayload, VerifyRequest, VerifyResult, WorkerError, WorkerErrorCode } from "../shared/contract";
import { extract } from "../shared/fetch/extract";
import type { Resolver } from "../shared/fetch/dns";
import { guardedGet, type TransportLimits } from "../shared/fetch/transport";
import { checkUrlStatic, publicWebPolicy } from "../shared/fetch/url-policy";
import { checkEvidence } from "../shared/normalize-evidence";
import { ProviderError } from "../shared/providers/failure";
import type { CallModel, ModelMessage } from "../shared/providers/groq";
import { WorkerUnavailable, type WorkContext, type WorkOutcome } from "../shared/worker/app";
import { selectPassages } from "./passages";
import { buildMessages, parseModelReply, RETRY_PROMPT } from "./prompt";

export type VerifierLimits = {
	fetchTimeoutMs: number;
	maxResponseBytes: number;
	maxRedirects: number;
	maxExtractedChars: number;
	passageChars: number;
	maxOutputTokens: number;
	/** Longest per-minute rate-limit wait the verifier will sit through mid-request. */
	maxRateLimitWaitMs: number;
};

export const DEFAULT_VERIFIER_LIMITS: VerifierLimits = {
	fetchTimeoutMs: 10_000,
	maxResponseBytes: 1_500_000,
	maxRedirects: 3,
	maxExtractedChars: 60_000,
	passageChars: 6_000,
	maxOutputTokens: 800,
	maxRateLimitWaitMs: 20_000,
};

export type VerifierDeps = {
	callModel: CallModel;
	model: string;
	limits?: Partial<VerifierLimits>;
	/** Test injection: the guarded transport and DNS resolver. */
	fetcher?: typeof guardedGet;
	resolver?: Resolver;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

class StopWork extends Error {
	constructor(
		readonly code: WorkerErrorCode,
		reason: string,
	) {
		super(reason);
	}
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});

/** Same URL text → one fetch and one model call for all its claims. Fragments never reach the server, so they do not split groups. */
function groupKey(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		return parsed.href;
	} catch {
		return url;
	}
}

/** Conservative token reservation (byte-level), as the researcher does: never under-reserve. */
function reserveTokens(messages: ModelMessage[], maxOutputTokens: number): number {
	return Buffer.byteLength(JSON.stringify(messages), "utf8") + 512 + 256 * messages.length + maxOutputTokens;
}

const hostOf = (url: string) => {
	try {
		return new URL(url).host;
	} catch {
		return "invalid-url";
	}
};

/**
 * The verifier's handler: for each cited URL, guard → fetch → one model call for that page's
 * claims → code checks every excerpt. It never sees anything but claim text and URLs.
 */
export function createVerifyHandler(deps: VerifierDeps) {
	const limits: VerifierLimits = { ...DEFAULT_VERIFIER_LIMITS, ...deps.limits };
	const policy = publicWebPolicy();
	const transport: TransportLimits = { timeoutMs: limits.fetchTimeoutMs, maxBytes: limits.maxResponseBytes, maxRedirects: limits.maxRedirects };
	const fetcher = deps.fetcher ?? guardedGet;
	const sleep = deps.sleep ?? defaultSleep;

	return async function handle(request: VerifyRequest, ctx: WorkContext<VerifyResult>): Promise<WorkOutcome<VerifyResult>> {
		const { budget } = request;
		const claims: VerifyPayload["claims"] = request.payload.claims;
		const decided = new Map<string, Verdict>();
		const ordered = (): Verdict[] => claims.flatMap((claim) => (decided.has(claim.claim_id) ? [decided.get(claim.claim_id)!] : []));
		const decide = (claim: ClaimInput, verdict: Verdict) => {
			decided.set(claim.claim_id, verdict);
			ctx.setPartial({ verdicts: ordered() });
		};
		const unreachable = (group: ClaimInput[]) => group.forEach((claim) => decide(claim, { claim_id: claim.claim_id, verdict: "unreachable", evidence: null }));
		const timeLeft = () => ctx.remainingMs() > 250 && !ctx.signal.aborted;

		const groups = new Map<string, ClaimInput[]>();
		for (const claim of claims) {
			const key = groupKey(claim.source_url);
			groups.set(key, [...(groups.get(key) ?? []), claim]);
		}

		let stop: StopWork | null = null;
		let skippedGroup: WorkerError | null = null;

		try {
			for (const [url, group] of groups) {
				if (!timeLeft()) throw new StopWork("time_budget_exhausted", "the time budget ran out");

				// 1. Guard with no network: scheme, port, credentials, local names, literal addresses.
				const staticCheck = checkUrlStatic(url, policy);
				if (!staticCheck.ok) {
					ctx.trace({ step: ctx.usage.steps, endpoint_or_tool: "guard", status: "rejected", latency_ms: 0, tokens: null, error_code: staticCheck.code, detail: { host: hostOf(url) } });
					unreachable(group);
					continue;
				}

				// 2. Fetch. DNS answers and every redirect hop are re-checked inside guardedGet; each hop is one fetch.
				if (ctx.usage.fetches >= budget.max_fetches) throw new StopWork("fetch_budget_exhausted", `the fetch budget (${budget.max_fetches}) ran out`);
				let fetchBudgetHit = false;
				const result = await fetcher(staticCheck.url.toString(), policy, transport, {
					signal: ctx.signal,
					resolver: deps.resolver,
					beforeRequest: () => {
						if (ctx.usage.fetches >= budget.max_fetches) {
							fetchBudgetHit = true;
							throw new StopWork("fetch_budget_exhausted", `the fetch budget (${budget.max_fetches}) ran out during redirects`);
						}
						ctx.usage.fetches += 1;
					},
					onRoundTrip: (trip) =>
						ctx.trace({
							ts: trip.startedAt,
							step: ctx.usage.steps,
							endpoint_or_tool: `fetch ${hostOf(trip.url)}`,
							status: trip.status,
							latency_ms: trip.latencyMs,
							tokens: null,
							error_code: trip.errorCode,
							detail: trip.redirectHop > 0 ? { redirect_hop: trip.redirectHop } : undefined,
						}),
				});
				if (fetchBudgetHit) throw new StopWork("fetch_budget_exhausted", `the fetch budget (${budget.max_fetches}) ran out`);
				if (!result.ok) {
					if (result.code === "aborted") throw new StopWork("time_budget_exhausted", "the time budget ran out while fetching");
					if (result.kind === "rejected") {
						ctx.trace({ step: ctx.usage.steps, endpoint_or_tool: "guard", status: "rejected", latency_ms: result.latencyMs, tokens: null, error_code: result.code, detail: { host: hostOf(result.finalUrl ?? url), redirects: result.redirects } });
					}
					unreachable(group);
					continue;
				}

				const extracted = extract(result.body, result.contentType, result.finalUrl, limits.maxExtractedChars);
				const pageText = extracted.title && !extracted.text.includes(extracted.title) ? `${extracted.title}\n${extracted.text}` : extracted.text;
				if (!pageText.trim()) {
					unreachable(group);
					continue;
				}

				// 3. One model call for this page's claims (plus one retry if the reply is malformed).
				const messages = buildMessages({ sourceUrl: url, claims: group, passages: selectPassages(pageText, group.map((claim) => claim.text), limits.passageChars) });
				const reply = await askModel(messages, group);
				if (!reply) {
					skippedGroup = { code: "model_output_invalid", message: `the model's reply for ${hostOf(url)} was not valid JSON twice`, retryable: false };
					continue;
				}

				// 4. Code decides what stands: the excerpt must really be on the page.
				for (const claim of group) {
					const answer = reply.verdicts.find((entry) => entry.claim_id === claim.claim_id);
					if (answer?.verdict === "supported") {
						const excerpt = (answer.evidence ?? "").trim();
						const check = checkEvidence(excerpt, pageText);
						if (check.ok) {
							decide(claim, { claim_id: claim.claim_id, verdict: "supported", evidence: excerpt });
							continue;
						}
						ctx.trace({ step: ctx.usage.steps, endpoint_or_tool: "evidence_check", status: "downgraded", latency_ms: 0, tokens: null, error_code: `evidence_${check.reason}`, detail: { claim_id: claim.claim_id } });
					}
					decide(claim, { claim_id: claim.claim_id, verdict: "unsupported", evidence: null });
				}
			}
		} catch (error) {
			if (!(error instanceof StopWork)) throw error;
			stop = error;
		}

		const verdicts = ordered();
		if (verdicts.length === claims.length) return { status: "complete", result: { verdicts } };
		const reason = stop ?? skippedGroup;
		const code: WorkerErrorCode = reason instanceof StopWork ? reason.code : (reason?.code ?? "internal");
		const why = reason instanceof StopWork ? reason.message : (reason?.message ?? "some claims were not checked");
		if (verdicts.length === 0 && (code === "model_auth_failed" || code === "model_quota_exhausted")) {
			return { status: "failed", error: { code, message: why, retryable: false } };
		}
		return { status: "partial", result: { verdicts }, error: { code, message: `stopped after ${verdicts.length} of ${claims.length} claims: ${why}`, retryable: false } };

		/** Returns the parsed reply, null after two malformed replies; throws StopWork / WorkerUnavailable to end the request. */
		async function askModel(initial: ModelMessage[], group: ClaimInput[]) {
			const messages = [...initial];
			let malformed = 0;
			let replyWasInvalid = false;
			for (;;) {
				if (replyWasInvalid) messages.push({ role: "user", content: RETRY_PROMPT });
				replyWasInvalid = false;
				if (!timeLeft()) throw new StopWork("time_budget_exhausted", "the time budget ran out before the model call");
				if (ctx.usage.steps >= budget.max_steps) throw new StopWork("step_budget_exhausted", `the step budget (${budget.max_steps}) ran out`);
				const reservation = reserveTokens(messages, limits.maxOutputTokens);
				if (ctx.usage.tokens + reservation > budget.max_tokens) throw new StopWork("token_budget_exhausted", `the next model call needs up to ${reservation} tokens and only ${budget.max_tokens - ctx.usage.tokens} are left`);

				ctx.usage.steps += 1;
				const step = ctx.usage.steps;
				const startedAt = new Date();
				const started = performance.now();
				try {
					const response = await deps.callModel({ model: deps.model, messages, temperature: 0, maxOutputTokens: limits.maxOutputTokens, responseFormat: "json_object", signal: ctx.signal });
					const tokens = response.usage ? response.usage.input + response.usage.output : reservation;
					ctx.usage.tokens += tokens;
					ctx.trace({ ts: startedAt, step, endpoint_or_tool: `groq ${deps.model}`, status: 200, latency_ms: Math.round(performance.now() - started), tokens, detail: { claims: group.length } });
					const reply = parseModelReply(response.content);
					if (reply) return reply;
					malformed += 1;
					replyWasInvalid = true;
				} catch (error) {
					const definite = error instanceof ProviderError && error.status !== undefined;
					const charged = definite ? 0 : reservation;
					ctx.usage.tokens += charged;
					ctx.trace({
						ts: startedAt,
						step,
						endpoint_or_tool: `groq ${deps.model}`,
						status: error instanceof ProviderError ? (error.status ?? "network_error") : "error",
						latency_ms: Math.round(performance.now() - started),
						tokens: charged || null,
						error_code: error instanceof ProviderError ? error.failure : "error",
					});
					if (ctx.signal.aborted) throw new StopWork("time_budget_exhausted", "the time budget ran out during the model call");
					if (!(error instanceof ProviderError)) throw error;
					switch (error.failure) {
						case "auth":
						case "permission":
							throw new StopWork("model_auth_failed", "the model API key is missing or invalid");
						case "payment":
						case "quota_exhausted":
							throw new StopWork("model_quota_exhausted", "the model's daily quota is used up");
						case "rate_limit_minute":
						case "rate_limit_unknown": {
							const waitMs = Math.max(500, error.retryAfterMs ?? 10_000);
							// Nothing decided yet: say "not now" (503 + Retry-After) instead of doing half a job.
							if (decided.size === 0) throw new WorkerUnavailable("model_rate_limited", "the model's per-minute rate limit is reached", waitMs / 1000);
							if (waitMs > limits.maxRateLimitWaitMs || waitMs >= ctx.remainingMs() - 1000) throw new StopWork("model_rate_limited", "the model's per-minute rate limit is reached");
							ctx.trace({ step, endpoint_or_tool: "rate_wait", status: "waiting", latency_ms: waitMs, tokens: null });
							await sleep(waitMs, ctx.signal);
							continue;
						}
						case "transient":
							malformed += 1; // one retry for a transient failure, shared with the malformed-reply retry
							break;
						case "bad_request":
							if (/malformed model output/i.test(error.message)) {
								malformed += 1;
								replyWasInvalid = true;
								break;
							}
							throw new StopWork("internal", `the model rejected the request: ${error.message.slice(0, 200)}`);
					}
				}
				if (malformed >= 2) return null;
			}
		}
	};
}
