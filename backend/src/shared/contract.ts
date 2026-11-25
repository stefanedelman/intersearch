/**
 * The wire contract between the orchestrator and its two workers (researcher, verifier).
 *
 * This is the one file all three services share. It holds schemas and pure helpers only: no
 * network, no database, no service logic. Workers validate every request with these schemas;
 * the orchestrator validates every response with them, then checks the response against what it
 * actually sent (`checkResearchResult`, `checkVerdicts`).
 *
 * Request envelope: exactly the assignment's. Response envelope: ours (the spec leaves it open);
 * see ORCHESTRATION_PLAN.md §2 and ORCHESTRATION.md §1.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Limits (one place, so workers and orchestrator agree)
// ---------------------------------------------------------------------------------------------

export const LIMITS = {
	maxTimeBudgetMs: 900_000,
	maxSteps: 100,
	maxFetches: 200,
	maxTokens: 1_000_000,
	topicChars: 300,
	maxK: 10,
	maxClaimsPerVerify: 40,
	maxClaimsPerDevelopment: 12,
	claimIdChars: 64,
	claimTextChars: 500,
	urlChars: 2048,
	developmentIdChars: 400,
	titleChars: 300,
	summaryChars: 1000,
	evidenceChars: 300,
	errorMessageChars: 500,
	/** Request bodies above this are rejected before parsing (413/400). */
	maxRequestBytes: 256 * 1024,
} as const;

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

const nonNegativeInt = (max: number) => z.number().int().min(0).max(max);

export const claimIdSchema = z
	.string()
	.min(1)
	.max(LIMITS.claimIdChars)
	.regex(/^[A-Za-z0-9._:-]+$/, "claim_id may contain letters, digits, '.', '_', ':' and '-' only");

/** True for absolute http: or https: URLs. Syntax only: reachability and address checks are the verifier's guard. */
export function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

const httpUrlSchema = z.string().min(1).max(LIMITS.urlChars).refine(isHttpUrl, "must be an absolute http(s) URL");

// ---------------------------------------------------------------------------------------------
// Request envelope (orchestrator → worker)
// ---------------------------------------------------------------------------------------------

/** Each worker enforces its share. A step is one model call; a fetch is one HTTP request to a web page, each redirect hop included. */
export const budgetSchema = z.strictObject({
	max_steps: nonNegativeInt(LIMITS.maxSteps),
	max_fetches: nonNegativeInt(LIMITS.maxFetches),
	max_tokens: nonNegativeInt(LIMITS.maxTokens),
});

function envelope<P extends z.ZodType>(payload: P) {
	return z.strictObject({
		request_id: z.uuid(),
		run_id: z.uuid(),
		time_budget_ms: z.number().int().min(1).max(LIMITS.maxTimeBudgetMs),
		budget: budgetSchema,
		payload,
	});
}

export const researchPayloadSchema = z.strictObject({
	topic: z.string().trim().min(1).max(LIMITS.topicChars),
	k: z.number().int().min(1).max(LIMITS.maxK),
});

/**
 * The verifier gets only claim text and the cited URL: never the researcher's summary, reasoning,
 * quotes, or fetched pages. `source_url` is deliberately any string here: a non-http(s) or
 * internal URL is not a malformed request, it is a claim the verifier marks `unreachable` without
 * fetching. (The orchestrator never forwards a non-http(s) URL; see `checkResearchResult`.)
 */
export const claimInputSchema = z.strictObject({
	claim_id: claimIdSchema,
	text: z.string().trim().min(1).max(LIMITS.claimTextChars),
	source_url: z.string().min(1).max(LIMITS.urlChars),
});

export const verifyPayloadSchema = z.strictObject({
	claims: z
		.array(claimInputSchema)
		.min(1)
		.max(LIMITS.maxClaimsPerVerify)
		.refine((claims) => new Set(claims.map((claim) => claim.claim_id)).size === claims.length, "claim_id values must be unique"),
});

export const researchRequestSchema = envelope(researchPayloadSchema);
export const verifyRequestSchema = envelope(verifyPayloadSchema);

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export const researchClaimSchema = z.strictObject({
	claim_id: claimIdSchema,
	text: z.string().min(1).max(LIMITS.claimTextChars),
	source_url: httpUrlSchema,
});

export const developmentSchema = z.strictObject({
	id: z.string().min(1).max(LIMITS.developmentIdChars),
	title: z.string().min(1).max(LIMITS.titleChars),
	summary: z.string().max(LIMITS.summaryChars),
	claims: z.array(researchClaimSchema).max(LIMITS.maxClaimsPerDevelopment),
});

/** Developments in rank order, best first. */
export const researchResultSchema = z.strictObject({
	developments: z.array(developmentSchema).max(LIMITS.maxK),
});

export const verdictValues = ["supported", "unsupported", "unreachable"] as const;
export type VerdictValue = (typeof verdictValues)[number];

/** `evidence` is a string on supported verdicts and null otherwise. */
export const verdictSchema = z
	.strictObject({
		claim_id: claimIdSchema,
		verdict: z.enum(verdictValues),
		evidence: z.string().min(1).max(LIMITS.evidenceChars).nullable(),
	})
	.refine((verdict) => (verdict.verdict === "supported") === (verdict.evidence !== null), {
		message: "evidence must be a string when verdict is supported, and null otherwise",
		path: ["evidence"],
	});

export const verifyResultSchema = z.strictObject({
	verdicts: z.array(verdictSchema).max(LIMITS.maxClaimsPerVerify),
});

// ---------------------------------------------------------------------------------------------
// Response envelope (worker → orchestrator)
// ---------------------------------------------------------------------------------------------

export const workerErrorCodes = [
	"time_budget_exhausted",
	"step_budget_exhausted",
	"fetch_budget_exhausted",
	"token_budget_exhausted",
	"model_rate_limited",
	"model_quota_exhausted",
	"model_auth_failed",
	"model_output_invalid",
	"in_flight",
	"overloaded",
	"idempotency_conflict",
	"bad_request",
	"unauthorized",
	"internal",
] as const;
export type WorkerErrorCode = (typeof workerErrorCodes)[number];

export const workerErrorSchema = z.strictObject({
	code: z.enum(workerErrorCodes),
	message: z.string().max(LIMITS.errorMessageChars),
	retryable: z.boolean(),
});

/** What the worker spent on this request. The orchestrator's ledger charges this, once per request_id. */
export const usageSchema = z.strictObject({
	steps: nonNegativeInt(LIMITS.maxSteps * 10),
	fetches: nonNegativeInt(LIMITS.maxFetches * 10),
	tokens: nonNegativeInt(LIMITS.maxTokens * 10),
	elapsed_ms: nonNegativeInt(LIMITS.maxTimeBudgetMs * 10),
});

export const workerServices = ["researcher", "verifier"] as const;
export type WorkerService = (typeof workerServices)[number];
export const workStatuses = ["complete", "partial", "failed"] as const;
export type WorkStatus = (typeof workStatuses)[number];

/**
 * HTTP 200 carries `complete` or `partial`; HTTP 500 carries `failed`.
 * complete: result, no error. partial: result and error (why it stopped). failed: error, no result.
 */
function responseEnvelope<S extends WorkerService, R extends z.ZodType>(service: S, result: R) {
	return z
		.strictObject({
			request_id: z.uuid(),
			run_id: z.uuid(),
			service: z.literal(service),
			status: z.enum(workStatuses),
			result: result.nullable(),
			error: workerErrorSchema.nullable(),
			usage: usageSchema,
		})
		.superRefine((parsed, ctx) => {
			// The generic result type hides `result` from the compiler; the shape is known here.
			const body = parsed as unknown as { status: WorkStatus; result: unknown; error: unknown };
			const fail = (message: string, path: string) => ctx.addIssue({ code: "custom", message, path: [path] });
			if (body.status === "complete") {
				if (body.result === null) fail("a complete response must include result", "result");
				if (body.error !== null) fail("a complete response must not include error", "error");
			} else if (body.status === "partial") {
				if (body.result === null) fail("a partial response must include result (what it had)", "result");
				if (body.error === null) fail("a partial response must say why it stopped", "error");
			} else {
				if (body.result !== null) fail("a failed response must not include result", "result");
				if (body.error === null) fail("a failed response must say why it failed", "error");
			}
		});
}

export const researchResponseSchema = responseEnvelope("researcher", researchResultSchema);
export const verifyResponseSchema = responseEnvelope("verifier", verifyResultSchema);

/** Body of 400, 401, 409, and 503 responses: the request was not (or not yet) worked on. */
export const rejectionBodySchema = z.strictObject({
	error: workerErrorSchema,
});

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type Budget = z.infer<typeof budgetSchema>;
export type ResearchPayload = z.infer<typeof researchPayloadSchema>;
export type VerifyPayload = z.infer<typeof verifyPayloadSchema>;
export type ClaimInput = z.infer<typeof claimInputSchema>;
export type ResearchRequest = z.infer<typeof researchRequestSchema>;
export type VerifyRequest = z.infer<typeof verifyRequestSchema>;
export type Development = z.infer<typeof developmentSchema>;
export type ResearchResult = z.infer<typeof researchResultSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type VerifyResult = z.infer<typeof verifyResultSchema>;
export type WorkerError = z.infer<typeof workerErrorSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type ResearchResponse = z.infer<typeof researchResponseSchema>;
export type VerifyResponse = z.infer<typeof verifyResponseSchema>;
export type RejectionBody = z.infer<typeof rejectionBodySchema>;

// ---------------------------------------------------------------------------------------------
// Cross-checks the orchestrator runs after schema validation
// ---------------------------------------------------------------------------------------------

export type CheckResult = { ok: true } | { ok: false; problems: string[] };

const done = (problems: string[]): CheckResult => (problems.length ? { ok: false, problems } : { ok: true });

/** At most k developments, unique development ids, and claim_ids unique across the whole result. */
export function checkResearchResult(result: ResearchResult, k: number): CheckResult {
	const problems: string[] = [];
	if (result.developments.length > k) problems.push(`returned ${result.developments.length} developments for k=${k}`);
	const developmentIds = new Set<string>();
	const claimIds = new Set<string>();
	for (const development of result.developments) {
		if (developmentIds.has(development.id)) problems.push(`duplicate development id ${JSON.stringify(development.id)}`);
		developmentIds.add(development.id);
		for (const claim of development.claims) {
			if (claimIds.has(claim.claim_id)) problems.push(`duplicate claim_id ${JSON.stringify(claim.claim_id)}`);
			claimIds.add(claim.claim_id);
		}
	}
	return done(problems);
}

/**
 * Every verdict must answer a claim_id the orchestrator sent, at most once. A verdict for a claim
 * it never sent means the response is not about this request: the whole response is rejected.
 * Claims with no verdict are allowed (partial work); they stay unverified.
 */
export function checkVerdicts(result: VerifyResult, sentClaimIds: Iterable<string>): CheckResult {
	const sent = new Set(sentClaimIds);
	const seen = new Set<string>();
	const problems: string[] = [];
	for (const verdict of result.verdicts) {
		if (!sent.has(verdict.claim_id)) problems.push(`verdict for claim_id ${JSON.stringify(verdict.claim_id)}, which was not sent`);
		if (seen.has(verdict.claim_id)) problems.push(`more than one verdict for claim_id ${JSON.stringify(verdict.claim_id)}`);
		seen.add(verdict.claim_id);
	}
	return done(problems);
}

// ---------------------------------------------------------------------------------------------
// Request identity: "the same body" means the same JSON once parsed
// ---------------------------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted (recursively), array order kept, no whitespace.
 * Key order and formatting of the original text therefore do not matter.
 * `undefined` object members are dropped, as JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const text = JSON.stringify(value);
		if (text === undefined) throw new TypeError(`cannot canonicalise a value of type ${typeof value}`);
		return text;
	}
	if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
	const entries = Object.keys(value)
		.sort()
		.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
	return `{${entries.join(",")}}`;
}

/** sha256 hex of the canonical JSON. Two requests with the same request_id and different hashes are a 409. */
export function bodyHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
