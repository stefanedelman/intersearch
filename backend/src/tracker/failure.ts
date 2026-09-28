import { BudgetExhausted, type Budget } from "./budget";

export type FailureClass =
	| "transient" // timeout, connection reset, 5xx: retry with backoff
	| "rate_limit_minute" // per-minute limit: wait (Retry-After) if it fits the deadline
	| "quota_exhausted" // daily/monthly quota or plan limit: stop now, never retry
	| "auth" // bad or missing key: stop now
	| "payment" // payment required: stop now
	| "permission" // key lacks access: stop now
	| "rate_limit_unknown" // 429 we cannot classify: stop safely rather than guess
	| "bad_request"; // our request was wrong: do not retry the same request

export class ProviderError extends Error {
	constructor(
		readonly provider: string,
		readonly failure: FailureClass,
		message: string,
		readonly status?: number,
		readonly retryAfterMs?: number,
	) {
		super(message);
	}

	get terminal(): boolean {
		return this.failure !== "transient" && this.failure !== "rate_limit_minute";
	}
}

function retryAfterMs(headers: Headers | Record<string, string | string[] | undefined> | undefined, body: string): number | undefined {
	const get = (name: string) => {
		if (!headers) return undefined;
		if (headers instanceof Headers) return headers.get(name) ?? undefined;
		const value = headers[name] ?? headers[name.toLowerCase()];
		return Array.isArray(value) ? value[0] : value;
	};
	const header = get("retry-after");
	if (header) {
		const seconds = Number(header);
		if (Number.isFinite(seconds)) return seconds * 1000;
		const date = Date.parse(header);
		if (Number.isFinite(date)) return Math.max(0, date - Date.now());
	}
	// Groq puts the wait in the message: "Please try again in 7.66s" or "in 1m30.5s".
	const match = body.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
	if (match) return (Number(match[1] ?? 0) * 60 + Number(match[2])) * 1000;
	return undefined;
}

/**
 * Turns a provider HTTP error into a failure class. A 429 is not automatically retryable:
 * a per-minute limit is (after waiting), but a daily quota or plan cap is terminal, because
 * retrying it only burns time and requests until tomorrow.
 */
export function classifyHttpFailure(input: {
	provider: string;
	status: number;
	headers?: Headers | Record<string, string | string[] | undefined>;
	body: string;
}): ProviderError {
	const { provider, status, body } = input;
	const text = body.slice(0, 2000);
	const wait = retryAfterMs(input.headers, text);
	const summary = `${provider} returned HTTP ${status}`;

	if (status === 401) return new ProviderError(provider, "auth", `${summary}: the API key is missing or invalid`, status);
	if (status === 402) return new ProviderError(provider, "payment", `${summary}: payment required`, status);
	if (status === 403) return new ProviderError(provider, "permission", `${summary}: the key is not allowed to do this`, status);
	// Tavily: 432 = plan credit limit reached, 433 = pay-as-you-go limit reached.
	if (status === 432 || status === 433) return new ProviderError(provider, "quota_exhausted", `${summary}: plan usage limit reached`, status);
	if (status === 429) {
		if (/per day|\(TPD\)|\(RPD\)|daily|quota|per month|monthly|usage limit|exceeded your current quota/i.test(text)) {
			return new ProviderError(provider, "quota_exhausted", `${summary}: daily or monthly quota exhausted`, status, wait);
		}
		if (/per minute|\(TPM\)|\(RPM\)|per second|too many requests/i.test(text) || (wait !== undefined && wait <= 60_000)) {
			return new ProviderError(provider, "rate_limit_minute", `${summary}: per-minute rate limit`, status, wait ?? 10_000);
		}
		return new ProviderError(provider, "rate_limit_unknown", `${summary}: rate limited, and the response does not say whether the limit is per minute or per day`, status, wait);
	}
	if (status === 408 || status === 425 || status === 498 || status >= 500) {
		return new ProviderError(provider, "transient", `${summary}: temporary server error`, status, wait);
	}
	return new ProviderError(provider, "bad_request", `${summary}: ${text.slice(0, 200) || "request rejected"}`, status);
}

export function classifyNetworkFailure(provider: string, error: unknown): ProviderError {
	const err = error as { name?: string; code?: string; cause?: { code?: string }; message?: string };
	const code = err.code ?? err.cause?.code ?? err.name ?? "network";
	return new ProviderError(provider, "transient", `${provider} network error (${code}): ${err.message ?? "request failed"}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry wrapper used for every provider request. Transient failures get jittered exponential
 * backoff (1s, 2s, 4s ...) up to max_retries. Per-minute rate limits wait for Retry-After, but
 * only if the wait fits in the remaining run time. Everything else is thrown immediately.
 * Each attempt passes through `attempt`, which reserves budget, so retries are counted.
 */
export async function withRetries<T>(
	budget: Budget,
	maxRetries: number,
	attempt: (attemptNumber: number) => Promise<T>,
	onRetry?: (error: ProviderError, waitMs: number, attemptNumber: number) => void,
): Promise<T> {
	for (let attemptNumber = 0; ; attemptNumber += 1) {
		try {
			return await attempt(attemptNumber);
		} catch (error) {
			if (error instanceof BudgetExhausted || !(error instanceof ProviderError)) throw error;
			if (error.terminal) throw error; // quota, auth, payment, permission, unknown 429, bad request
			if (attemptNumber >= maxRetries) throw error;

			const backoff = 1000 * 2 ** attemptNumber + Math.floor(Math.random() * 400);
			const waitMs = error.failure === "rate_limit_minute" ? Math.max(error.retryAfterMs ?? 10_000, 500) : backoff;
			if (waitMs > 60_000 || waitMs >= budget.remainingMs() - 1000) {
				throw new ProviderError(error.provider, error.failure, `${error.message}; waiting ${Math.round(waitMs / 1000)}s would exceed the run's time budget`, error.status, error.retryAfterMs);
			}
			budget.recordRetry();
			onRetry?.(error, waitMs, attemptNumber + 1);
			await sleep(waitMs);
		}
	}
}
