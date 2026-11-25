import { Agent, request, type Dispatcher } from "undici";
import type { WorkerService } from "../shared/contract";
import type { TraceLog } from "../shared/trace-log";

/**
 * The orchestrator's HTTP client for one worker.
 *
 * - Every attempt of one logical request sends the same request_id and the **same bytes**: the
 *   body is serialised once by the caller and never rebuilt (time_budget_ms is not shrunk).
 * - Each attempt has its own client timeout (`attemptTimeoutMs`, which the caller sets above the
 *   request's time_budget_ms) and also stops when the run is cancelled.
 * - Transient failures are retried with exponential backoff and jitter: connection errors, our own
 *   timeout, 503 (honouring Retry-After), and gateway errors (502/504, Render waking up), plus 429.
 * - Everything else is terminal and returned as is: 200 and 500 carry a result envelope for the
 *   caller to validate; 400, 401, 409 mean the request was refused.
 * - A retry is only made if it can finish before the run's deadline.
 * - Each attempt writes one `out` trace line with caller-side latency.
 */

export type RetryPolicy = { max_attempts: number; base_ms: number; max_backoff_ms: number; max_retry_after_ms: number };

export type AttemptStatus = number | "timeout" | "network_error" | "aborted";

export type AttemptRecord = {
	attempt: number;
	startedAt: string;
	status: AttemptStatus;
	latencyMs: number;
	/** The wait before the next attempt (Retry-After or backoff); null when there was none. */
	waitMs: number | null;
	retryAfterMs: number | null;
	errorCode: string | null;
};

export type CallResult = {
	attempts: AttemptRecord[];
	/** Caller-side time over all attempts and waits. */
	latencyMs: number;
	/** The last attempt's HTTP response, if it got one. */
	response: { status: number; body: string; json: unknown } | null;
	/** Why no further attempt was made (null when the last attempt was a final answer). */
	gaveUp: null | { reason: "attempts_exhausted" | "deadline" | "retry_after_too_long" | "cancelled"; message: string };
};

export type WorkerClientOptions = {
	service: WorkerService;
	baseUrl: string;
	token: string;
	retries: RetryPolicy;
	dispatcher?: Dispatcher;
	/** Tests: deterministic jitter and fast waits. */
	random?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Long requests (an 8-minute research call) must not hit undici's default 300 s header/body timeouts: each attempt's own AbortSignal bounds it instead. */
export const longRequestAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 }, keepAliveTimeout: 10_000 });

/** Retry-After: delay-seconds or an HTTP-date. Returns milliseconds, or null if absent or unreadable. */
export function parseRetryAfter(value: string | string[] | undefined, now = Date.now()): number | null {
	const raw = Array.isArray(value) ? value[0] : value;
	if (!raw) return null;
	const trimmed = raw.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) return null;
	return Math.max(0, date - now);
}

/** base × 2^(attempt−1), capped, with ±20 % jitter. `attempt` is the attempt that just failed (1-based). */
export function backoffMs(attempt: number, policy: Pick<RetryPolicy, "base_ms" | "max_backoff_ms">, random: () => number = Math.random): number {
	const raw = Math.min(policy.max_backoff_ms, policy.base_ms * 2 ** (attempt - 1));
	return Math.round(raw * (0.8 + 0.4 * random()));
}

export function isRetryableStatus(status: AttemptStatus): boolean {
	return status === "timeout" || status === "network_error" || (typeof status === "number" && RETRYABLE_STATUS.has(status));
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

async function readCapped(body: Dispatcher.ResponseData["body"]): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of body) {
		size += (chunk as Buffer).length;
		if (size > MAX_RESPONSE_BYTES) {
			body.destroy();
			throw Object.assign(new Error(`response is larger than ${MAX_RESPONSE_BYTES} bytes`), { code: "response_too_large" });
		}
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function tokensOf(json: unknown): number | null {
	const tokens = (json as { usage?: { tokens?: unknown } } | null)?.usage?.tokens;
	return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null;
}

export function createWorkerClient(options: WorkerClientOptions) {
	const dispatcher = options.dispatcher ?? longRequestAgent;
	const random = options.random ?? Math.random;
	const sleep = options.sleep ?? defaultSleep;
	const base = options.baseUrl.replace(/\/+$/, "");

	/** One HTTP exchange. Never throws: transport failures become an AttemptStatus. */
	async function exchange(input: {
		method: "GET" | "POST";
		path: string;
		body?: string;
		timeoutMs: number;
		attempt: number;
		signal: AbortSignal;
		auth: boolean;
	}): Promise<{ status: AttemptStatus; latencyMs: number; startedAt: Date; response: CallResult["response"]; retryAfterMs: number | null; errorCode: string | null }> {
		const startedAt = new Date();
		const started = performance.now();
		const timeout = AbortSignal.timeout(input.timeoutMs);
		const signal = AbortSignal.any([input.signal, timeout]);
		const headers: Record<string, string> = { accept: "application/json", "x-attempt": String(input.attempt) };
		if (input.auth) headers.authorization = `Bearer ${options.token}`;
		if (input.body !== undefined) headers["content-type"] = "application/json";
		const elapsed = () => Math.round(performance.now() - started);
		try {
			const res = await request(`${base}${input.path}`, { method: input.method, headers, body: input.body, signal, dispatcher });
			const text = await readCapped(res.body);
			let json: unknown = null;
			try {
				json = JSON.parse(text);
			} catch {
				json = null;
			}
			return {
				status: res.statusCode,
				latencyMs: elapsed(),
				startedAt,
				response: { status: res.statusCode, body: text, json },
				retryAfterMs: parseRetryAfter(res.headers["retry-after"]),
				errorCode: null,
			};
		} catch (error) {
			const err = error as { code?: string; name?: string };
			if (input.signal.aborted) return { status: "aborted", latencyMs: elapsed(), startedAt, response: null, retryAfterMs: null, errorCode: "cancelled" };
			if (timeout.aborted) return { status: "timeout", latencyMs: elapsed(), startedAt, response: null, retryAfterMs: null, errorCode: "client_timeout" };
			return { status: "network_error", latencyMs: elapsed(), startedAt, response: null, retryAfterMs: null, errorCode: err.code ?? err.name ?? "network_error" };
		}
	}

	return {
		service: options.service,

		/**
		 * POST a serialised envelope, retrying transient failures. `body` is sent byte-for-byte on
		 * every attempt.
		 */
		async post(input: {
			path: string;
			body: string;
			runId: string;
			requestId: string;
			step: number;
			/** The run's orchestrator trace: one `out` line per attempt. */
			log: TraceLog;
			attemptTimeoutMs: number;
			/** Epoch ms after which no new attempt starts. */
			deadlineAt: number;
			signal: AbortSignal;
			onAttempt?: (record: AttemptRecord) => Promise<void> | void;
		}): Promise<CallResult> {
			const attempts: AttemptRecord[] = [];
			const started = performance.now();
			const total = () => Math.round(performance.now() - started);
			for (let attempt = 1; ; attempt += 1) {
				const result = await exchange({ method: "POST", path: input.path, body: input.body, timeoutMs: input.attemptTimeoutMs, attempt, signal: input.signal, auth: true });
				const record: AttemptRecord = {
					attempt,
					startedAt: result.startedAt.toISOString(),
					status: result.status,
					latencyMs: result.latencyMs,
					waitMs: null,
					retryAfterMs: result.retryAfterMs,
					errorCode: result.errorCode ?? (result.response && typeof result.status === "number" && result.status >= 400 ? errorCodeOf(result.response.json) : null),
				};
				attempts.push(record);
				const finish = (gaveUp: CallResult["gaveUp"]): CallResult => ({ attempts, latencyMs: total(), response: result.response, gaveUp });

				const traceLine = () =>
					input.log.write({
						ts: result.startedAt,
						run_id: input.runId,
						request_id: input.requestId,
						step: input.step,
						direction: "out",
						endpoint_or_tool: `POST ${options.service} ${input.path}`,
						status: result.status,
						latency_ms: result.latencyMs,
						attempt,
						tokens: result.response ? tokensOf(result.response.json) : null,
						error_code: record.errorCode,
						...(record.waitMs !== null ? { detail: { wait_ms: record.waitMs, ...(record.retryAfterMs !== null ? { retry_after_ms: record.retryAfterMs } : {}) } } : {}),
					});

				if (result.status === "aborted") {
					traceLine();
					await input.onAttempt?.(record);
					return finish({ reason: "cancelled", message: "the run was cancelled while this request was in flight" });
				}
				if (!isRetryableStatus(result.status)) {
					traceLine();
					await input.onAttempt?.(record);
					return finish(null);
				}

				const describe = typeof result.status === "number" ? `HTTP ${result.status}` : result.status === "timeout" ? `no answer within ${input.attemptTimeoutMs} ms` : `network error (${record.errorCode})`;
				if (attempt >= options.retries.max_attempts) {
					traceLine();
					await input.onAttempt?.(record);
					return finish({ reason: "attempts_exhausted", message: `${describe} on all ${attempt} attempts` });
				}
				if (result.retryAfterMs !== null && result.retryAfterMs > options.retries.max_retry_after_ms) {
					traceLine();
					await input.onAttempt?.(record);
					return finish({ reason: "retry_after_too_long", message: `${describe}; the worker asked to wait ${Math.round(result.retryAfterMs / 1000)} s, longer than the ${options.retries.max_retry_after_ms / 1000} s limit` });
				}
				const wait = result.retryAfterMs ?? backoffMs(attempt, options.retries, random);
				if (Date.now() + wait + input.attemptTimeoutMs > input.deadlineAt) {
					traceLine();
					await input.onAttempt?.(record);
					return finish({ reason: "deadline", message: `${describe}; another attempt would not finish before the run deadline` });
				}
				record.waitMs = wait;
				traceLine();
				await input.onAttempt?.(record);
				await sleep(wait, input.signal);
				if (input.signal.aborted) return finish({ reason: "cancelled", message: "the run was cancelled while waiting to retry" });
			}
		},

		/** GET /healthz (no auth). One attempt; used to wake the verifier and to probe health. */
		async healthz(input: { log: TraceLog; runId: string | null; step: number; timeoutMs: number; signal: AbortSignal }) {
			const result = await exchange({ method: "GET", path: "/healthz", timeoutMs: input.timeoutMs, attempt: 1, signal: input.signal, auth: false });
			input.log.write({
				ts: result.startedAt,
				run_id: input.runId,
				request_id: null,
				step: input.step,
				direction: "out",
				endpoint_or_tool: `GET ${options.service} /healthz`,
				status: result.status,
				latency_ms: result.latencyMs,
				attempt: 1,
				tokens: null,
				error_code: result.errorCode,
			});
			const up = result.status === 200 && (result.response?.json as { status?: unknown } | null)?.status === "ok";
			return { up, status: result.status, latencyMs: result.latencyMs, startedAt: result.startedAt };
		},

		/** GET /trace?run_id= : the worker's trace lines for this run (from its in-memory ring). */
		async trace(input: { log: TraceLog; runId: string; step: number; timeoutMs: number; signal: AbortSignal }) {
			const result = await exchange({ method: "GET", path: `/trace?run_id=${encodeURIComponent(input.runId)}`, timeoutMs: input.timeoutMs, attempt: 1, signal: input.signal, auth: true });
			input.log.write({
				ts: result.startedAt,
				run_id: input.runId,
				request_id: null,
				step: input.step,
				direction: "out",
				endpoint_or_tool: `GET ${options.service} /trace`,
				status: result.status,
				latency_ms: result.latencyMs,
				attempt: 1,
				tokens: null,
				error_code: result.errorCode,
			});
			const lines = (result.response?.json as { lines?: unknown } | null)?.lines;
			return result.status === 200 && Array.isArray(lines) ? (lines as unknown[]) : null;
		},
	};
}

export type WorkerClient = ReturnType<typeof createWorkerClient>;

function errorCodeOf(json: unknown): string | null {
	const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
	return typeof code === "string" ? code.slice(0, 60) : null;
}
