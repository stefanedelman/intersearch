import { BudgetExhausted, type Budget } from "./budget";
import { ProviderError } from "../shared/providers/failure";

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
