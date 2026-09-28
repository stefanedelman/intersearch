import { randomUUID } from "node:crypto";
import { extractObservation, type Observation } from "../domain/facts";
import { canonicalizeUrl } from "../domain/normalize";
import { extract, type Extracted } from "../fetch/extract";
import { checkUrl, guardedGet, type FetchResult } from "../fetch/transport";
import { checkUrlStatic } from "../fetch/url-policy";
import type { ToolContext } from "./context";

export type FetchArticleOutcome = {
	status: "fetched" | "skipped_seen" | "rejected" | "failed";
	url: string;
	canonicalUrl: string | null;
	finalUrl: string | null;
	title: string | null;
	reason: string | null;
	fetchedAt: string | null;
	sourceDocumentId: string | null;
	bytes: number | null;
	latencyMs: number | null;
	retryCount: number;
	observation: Observation | null;
	text: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function outcome(url: string, partial: Partial<FetchArticleOutcome> & Pick<FetchArticleOutcome, "status">): FetchArticleOutcome {
	return { url, canonicalUrl: null, finalUrl: null, title: null, reason: null, fetchedAt: null, sourceDocumentId: null, bytes: null, latencyMs: null, retryCount: 0, observation: null, text: null, ...partial };
}

/**
 * fetch_article(url). Order of checks, before any connection to the target:
 * 1. URL policy: http(s) only, no credentials, allowed port, exact allowlisted host, IP-literal ranges.
 * 2. Cache: a URL already saved for this tracker is reused (status skipped_seen, no request).
 * 3. DNS: every resolved address must be public; the socket is pinned to those addresses.
 * 4. Transport: timeout, redirect re-validation, byte cap, content-type allowlist.
 * The same function backs the agent loop and the standalone CLI, so the CLI is not a bypass.
 */
export async function fetchArticle(ctx: ToolContext, rawUrl: string): Promise<FetchArticleOutcome> {
	const attemptId = randomUUID();
	const attemptedAt = new Date().toISOString();
	const record = (result: FetchArticleOutcome) => {
		ctx.memory.attempts.push({ status: result.status, url: rawUrl });
		ctx.store?.recordAttempt({
			eventId: attemptId,
			requestedUrl: rawUrl.slice(0, 4096),
			canonicalUrl: result.canonicalUrl,
			sourceDocumentId: result.sourceDocumentId,
			status: result.status,
			reason: result.reason,
			title: result.title,
			attemptedAt,
			latencyMs: result.latencyMs,
			bytes: result.bytes,
			retryCount: result.retryCount,
		});
		return result;
	};

	const staticCheck = checkUrlStatic(rawUrl, ctx.policy);
	if (!staticCheck.ok) {
		// Re-run through the full check so the reason is specific (e.g. "resolves to loopback").
		const full = await checkUrl(rawUrl, ctx.policy);
		const reason = full.ok ? staticCheck.reason : full.reason;
		return record(outcome(rawUrl, { status: "rejected", reason }));
	}

	const canonicalUrl = canonicalizeUrl(staticCheck.url.toString());

	const cached = ctx.store?.findCached(canonicalUrl);
	if (cached) {
		try {
			const doc = await ctx.store!.loadText(cached);
			const extracted: Extracted = {
				title: doc.title,
				text: doc.text ?? "",
				sourceKind: doc.sourceKind ?? "html",
				contentHash: doc.contentHash,
				structured: (doc.metadata as Extracted["structured"]) ?? undefined,
			};
			const observation = extractObservation({ extracted, url: rawUrl, finalUrl: doc.finalUrl ?? canonicalUrl, sourceDocumentId: doc.id, fetchedAt: doc.fetchedAt, config: ctx.config });
			ctx.memory.observations.set(doc.id, observation);
			return record(
				outcome(rawUrl, {
					status: "skipped_seen",
					canonicalUrl,
					finalUrl: doc.finalUrl,
					title: doc.title,
					reason: `already fetched on ${doc.fetchedAt}; reused the saved copy`,
					fetchedAt: doc.fetchedAt,
					sourceDocumentId: doc.id,
					observation,
					text: doc.text,
				}),
			);
		} catch (error) {
			return record(outcome(rawUrl, { status: "failed", canonicalUrl, reason: `saved copy unavailable: ${(error as Error).message}` }));
		}
	}

	ctx.budget.reserveFetch();
	let result: FetchResult | null = null;
	let retryCount = 0;
	for (let attempt = 0; attempt <= ctx.config.limits.max_retries; attempt += 1) {
		ctx.budget.reserveNetwork();
		const started = new Date();
		result = await (ctx.fetcher ?? guardedGet)(staticCheck.url.toString(), ctx.policy, ctx.transport);
		if (result.redirects > 0) ctx.budget.chargeExtraNetwork(result.redirects);
		ctx.trace.record({
			category: "http",
			service: staticCheck.hostname,
			tool: "fetch_article",
			step: ctx.step,
			parentEventId: ctx.parentEventId,
			arguments: { url: rawUrl, attempt },
			status: result.ok ? "ok" : result.kind,
			startedAt: started,
			latencyMs: result.latencyMs,
			errorCode: result.ok ? null : result.code,
			detail: { httpStatus: result.ok ? result.status : (result.status ?? null), redirects: result.redirects, bytes: result.ok ? result.bytes : null },
		});
		if (result.ok || !result.transient || result.code === "rate_limited" || attempt === ctx.config.limits.max_retries) break;
		const wait = 1000 * 2 ** attempt + Math.floor(Math.random() * 300);
		if (wait >= ctx.budget.remainingMs() - 1000) break;
		retryCount += 1;
		ctx.budget.recordRetry();
		await sleep(wait);
	}

	if (!result!.ok) {
		const failure = result!;
		return record(outcome(rawUrl, { status: failure.kind === "rejected" ? "rejected" : "failed", canonicalUrl, finalUrl: failure.finalUrl ?? null, reason: failure.reason, latencyMs: failure.latencyMs, retryCount }));
	}

	const success = result!;
	const extracted = extract(success.body, success.contentType, success.finalUrl, ctx.config.limits.max_extracted_characters);
	const fetchedAt = new Date().toISOString();
	const sourceDocumentId = randomUUID();
	ctx.store?.addDocument({
		id: sourceDocumentId,
		canonicalUrl,
		finalUrl: success.finalUrl,
		sourceKind: extracted.sourceKind,
		title: extracted.title,
		text: extracted.text,
		contentHash: extracted.contentHash,
		httpStatus: success.status,
		metadata: extracted.structured ?? null,
		fetchedAt,
	});
	const observation = extractObservation({ extracted, url: rawUrl, finalUrl: success.finalUrl, sourceDocumentId, fetchedAt, config: ctx.config });
	ctx.memory.observations.set(sourceDocumentId, observation);
	return record(
		outcome(rawUrl, {
			status: "fetched",
			canonicalUrl,
			finalUrl: success.finalUrl,
			title: extracted.title,
			fetchedAt,
			sourceDocumentId,
			bytes: success.bytes,
			latencyMs: success.latencyMs,
			retryCount,
			observation,
			text: extracted.text,
		}),
	);
}

/** What the model sees: compact, clearly labeled as untrusted page data. */
export function fetchResultForModel(result: FetchArticleOutcome) {
	if (result.status === "rejected" || result.status === "failed") {
		return { status: result.status, url: result.url, reason: result.reason };
	}
	const facts = result.observation?.facts;
	return {
		status: result.status,
		source_id: result.sourceDocumentId,
		url: result.finalUrl ?? result.url,
		note: result.status === "skipped_seen" ? "Already fetched in an earlier run; the saved copy was reused (no new request)." : undefined,
		extracted_by_code: facts
			? {
					company: facts.company,
					title: facts.title,
					locations: facts.locations,
					season: facts.season,
					is_internship: facts.isInternship,
					skills: facts.skills,
					compensation_quote: facts.compensation,
				}
			: null,
		untrusted_page_excerpt: (result.text ?? "").slice(0, 700),
	};
}
