import { createHash, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { bodyHash, LIMITS, type WorkerError, type WorkerErrorCode, type WorkerService } from "../contract";
import type { TraceInput, TraceLog } from "../trace-log";
import { IdempotencyStore } from "./idempotency";

/**
 * The HTTP runtime both workers share. A worker supplies one route (`/research` or `/verify`):
 * a request schema, a response schema, an empty result, and a handler. This module owns
 * everything the contract requires around that handler:
 *
 *   GET /healthz → { status: "ok" }, no auth
 *   every other request: bearer token checked BEFORE the body is parsed (401 learns nothing about
 *   the schema) → JSON body (≤256 KB) → envelope validation (400) → idempotency (409 / 503 /
 *   stored replay) → the handler, with a deadline that starts when the request arrived → the
 *   response envelope, validated against the contract before it is sent → stored for replays.
 *
 * Every request received is written to the trace as one `in` line when its response is sent.
 */

export type WorkUsage = { steps: number; fetches: number; tokens: number };

export type WorkOutcome<R> =
	| { status: "complete"; result: R }
	| { status: "partial"; result: R; error: WorkerError }
	| { status: "failed"; error: WorkerError };

/** Thrown by a handler that cannot take the request now (model per-minute limit before any work). → 503, not stored. */
export class WorkerUnavailable extends Error {
	constructor(
		readonly code: WorkerErrorCode,
		message: string,
		readonly retryAfterSeconds: number,
	) {
		super(message);
	}
}

export type WorkContext<R> = {
	service: WorkerService;
	requestId: string;
	runId: string;
	/** The orchestrator's attempt number for this request (X-Attempt header, default 1). */
	attempt: number;
	/** Epoch ms by which the worker must answer: arrival + time_budget_ms. */
	deadlineAt: number;
	/** Aborts at deadlineAt. Pass it to every model call and fetch. */
	signal: AbortSignal;
	remainingMs(): number;
	/** What this request has spent so far. The handler increments it; it becomes the response's `usage`. */
	usage: WorkUsage;
	/**
	 * Record the best result so far. If the handler has not returned shortly after the deadline,
	 * the runtime answers `partial` with this result instead of hanging the caller.
	 */
	setPartial(result: R): void;
	/** Write an `out` line for a call this worker made, with run_id/request_id/attempt filled in. */
	trace(line: Omit<TraceInput, "run_id" | "request_id" | "direction" | "attempt"> & { attempt?: number }): void;
	log: TraceLog;
};

type Envelope<P> = { request_id: string; run_id: string; time_budget_ms: number; budget: { max_steps: number; max_fetches: number; max_tokens: number }; payload: P };

export type WorkerRoute<P, R> = {
	path: "/research" | "/verify";
	requestSchema: z.ZodType<Envelope<P>>;
	responseSchema: z.ZodType;
	/** The result to report when time runs out before anything was found (partial needs a result). */
	emptyResult: R;
	handle(request: Envelope<P>, ctx: WorkContext<R>): Promise<WorkOutcome<R>>;
};

export type WorkerAppOptions<P, R> = {
	service: WorkerService;
	token: string;
	log: TraceLog;
	route: WorkerRoute<P, R>;
	store?: IdempotencyStore;
	/** New requests beyond this many running at once get 503 overloaded. */
	maxConcurrent?: number;
	/** How long after the deadline to wait for the handler before answering partial with what it recorded. */
	backstopMs?: number;
};

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time bearer check. Comparing digests keeps the comparison length-independent. */
export function bearerMatches(header: string | undefined, token: string): boolean {
	if (!token) return false;
	const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
	if (!match) return false;
	return timingSafeEqual(digest(match[1]!), digest(token));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids from a body that failed validation are only echoed into the trace if they are well-formed. */
const idOrNull = (value: unknown) => (typeof value === "string" && UUID.test(value) ? value : null);

function attemptOf(req: Request): number {
	const value = Number(req.header("x-attempt"));
	return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 1;
}

function rejection(code: WorkerErrorCode, message: string, retryable: boolean) {
	return JSON.stringify({ error: { code, message: message.slice(0, LIMITS.errorMessageChars), retryable } });
}

function summarizeIssues(error: z.ZodError): string {
	return error.issues
		.slice(0, 5)
		.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`)
		.join("; ");
}

export function createWorkerApp<P, R>(options: WorkerAppOptions<P, R>) {
	const { service, token, log, route } = options;
	if (!token) throw new Error(`${service}: a service token is required`);
	const store = options.store ?? new IdempotencyStore();
	const maxConcurrent = options.maxConcurrent ?? 4;
	const backstopMs = options.backstopMs ?? 3000;
	let running = 0;

	const app = express();
	app.disable("x-powered-by");
	app.set("etag", false);

	const send = (res: Response, statusCode: number, body: string, headers: Record<string, string> = {}) => {
		for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
		res.status(statusCode).type("application/json").send(body);
	};

	const traceIn = (req: Request, fields: Omit<TraceInput, "direction" | "endpoint_or_tool" | "attempt"> & { attempt?: number }) =>
		log.write({ direction: "in", endpoint_or_tool: `${req.method} ${req.path}`, attempt: attemptOf(req), ...fields });

	app.get("/healthz", (_req, res) => {
		res.json({ status: "ok" });
	});

	// Auth runs before the JSON parser: an unauthenticated caller gets 401 for any body, valid or not.
	const requireToken: RequestHandler = (req, res, next) => {
		if (bearerMatches(req.header("authorization"), token)) return next();
		const started = performance.now();
		send(res, 401, rejection("unauthorized", "Missing or invalid service token.", false), { "WWW-Authenticate": 'Bearer realm="worker"' });
		traceIn(req, { run_id: null, request_id: null, step: 0, status: 401, latency_ms: Math.round(performance.now() - started), tokens: null, error_code: "unauthorized" });
	};
	app.use(requireToken);
	app.use(express.json({ limit: LIMITS.maxRequestBytes, strict: true }));

	app.get("/trace", (req, res) => {
		const runId = idOrNull(req.query.run_id);
		const requestId = idOrNull(req.query.request_id);
		if (!runId && !requestId) {
			send(res, 400, rejection("bad_request", "Pass run_id or request_id (a UUID).", false));
			return;
		}
		res.json({ lines: log.lines({ runId: runId ?? undefined, requestId: requestId ?? undefined }) });
	});

	app.post(route.path, async (req, res) => {
		const started = performance.now();
		const receivedAt = Date.now();
		const raw = req.body as unknown;
		const parsed = route.requestSchema.safeParse(raw);
		if (!parsed.success) {
			const body = raw as { run_id?: unknown; request_id?: unknown } | undefined;
			send(res, 400, rejection("bad_request", summarizeIssues(parsed.error), false));
			traceIn(req, { run_id: idOrNull(body?.run_id), request_id: idOrNull(body?.request_id), step: 0, status: 400, latency_ms: Math.round(performance.now() - started), tokens: null, error_code: "bad_request" });
			return;
		}
		const request = parsed.data;
		const ids = { run_id: request.run_id, request_id: request.request_id };
		const deadlineAt = receivedAt + request.time_budget_ms;
		const elapsed = () => Math.round(performance.now() - started);

		const begin = store.begin(request.request_id, bodyHash(raw), deadlineAt);
		if (begin.kind === "conflict") {
			send(res, 409, rejection("idempotency_conflict", "This request_id was already used with a different body.", false));
			traceIn(req, { ...ids, step: 0, status: 409, latency_ms: elapsed(), tokens: null, idempotency: "conflict", error_code: "idempotency_conflict" });
			return;
		}
		if (begin.kind === "in_flight") {
			send(res, 503, rejection("in_flight", "This request is still being processed; retry later.", true), { "Retry-After": String(begin.retryAfterSeconds) });
			traceIn(req, { ...ids, step: 0, status: 503, latency_ms: elapsed(), tokens: null, idempotency: "in_flight", error_code: "in_flight" });
			return;
		}
		if (begin.kind === "replay") {
			send(res, begin.response.statusCode, begin.response.body);
			traceIn(req, { ...ids, step: 0, status: begin.response.statusCode, latency_ms: elapsed(), tokens: 0, idempotency: "replay" });
			return;
		}
		if (running >= maxConcurrent) {
			store.abandon(request.request_id);
			send(res, 503, rejection("overloaded", `This worker is already running ${running} requests.`, true), { "Retry-After": "5" });
			traceIn(req, { ...ids, step: 0, status: 503, latency_ms: elapsed(), tokens: null, idempotency: "new", error_code: "overloaded" });
			return;
		}

		running += 1;
		const controller = new AbortController();
		const deadlineTimer = setTimeout(() => controller.abort(), request.time_budget_ms);
		deadlineTimer.unref();
		let partial: R | null = null;
		const usage: WorkUsage = { steps: 0, fetches: 0, tokens: 0 };
		const attempt = attemptOf(req);
		const ctx: WorkContext<R> = {
			service,
			requestId: request.request_id,
			runId: request.run_id,
			attempt,
			deadlineAt,
			signal: controller.signal,
			remainingMs: () => deadlineAt - Date.now(),
			usage,
			setPartial: (result) => {
				partial = result;
			},
			trace: (line) => log.write({ attempt, ...line, ...ids, direction: "out" }),
			log,
		};

		// The handler keeps running if the caller disconnects: its stored response is what a retry
		// with the same request_id will get back.
		let backstopTimer: NodeJS.Timeout | undefined;
		const backstop = new Promise<WorkOutcome<R>>((resolve) => {
			backstopTimer = setTimeout(() => {
				resolve({
					status: "partial",
					result: partial ?? route.emptyResult,
					error: { code: "time_budget_exhausted", message: `stopped at the ${request.time_budget_ms} ms time budget`, retryable: false },
				});
			}, request.time_budget_ms + backstopMs);
			backstopTimer.unref();
		});

		let outcome: WorkOutcome<R>;
		// `running` counts handlers actually executing, even one still going after the backstop answered.
		const work = Promise.resolve().then(() => route.handle(request, ctx));
		void work.then(
			() => (running -= 1),
			() => (running -= 1),
		);
		try {
			outcome = await Promise.race([work, backstop]);
		} catch (error) {
			if (error instanceof WorkerUnavailable) {
				store.abandon(request.request_id);
				send(res, 503, rejection(error.code, error.message, true), { "Retry-After": String(Math.max(1, Math.ceil(error.retryAfterSeconds))) });
				traceIn(req, { ...ids, step: usage.steps, status: 503, latency_ms: elapsed(), tokens: usage.tokens, idempotency: "new", error_code: error.code });
				return;
			}
			outcome = { status: "failed", error: { code: "internal", message: `${service} failed: ${(error as Error).message ?? "unexpected error"}`, retryable: false } };
		} finally {
			clearTimeout(deadlineTimer);
			clearTimeout(backstopTimer);
		}

		let envelope: Record<string, unknown> = {
			...ids,
			service,
			status: outcome.status,
			result: outcome.status === "failed" ? null : outcome.result,
			error: outcome.status === "complete" ? null : outcome.error,
			usage: { ...usage, elapsed_ms: Math.max(0, Date.now() - receivedAt) },
		};
		// Never send something the contract would reject: the orchestrator would count it as this
		// worker failing anyway, so say so explicitly.
		const checked = route.responseSchema.safeParse(envelope);
		if (!checked.success) {
			envelope = {
				...envelope,
				status: "failed",
				result: null,
				error: { code: "internal", message: `${service} produced an invalid response: ${summarizeIssues(checked.error)}`.slice(0, LIMITS.errorMessageChars), retryable: false },
			};
		}
		const statusCode = envelope.status === "failed" ? 500 : 200;
		const body = JSON.stringify(envelope);
		store.complete(request.request_id, { statusCode, body });
		send(res, statusCode, body);
		const error = envelope.error as WorkerError | null;
		traceIn(req, { ...ids, step: usage.steps, status: statusCode, latency_ms: elapsed(), tokens: usage.tokens, idempotency: "new", error_code: error?.code ?? null, detail: { outcome: envelope.status } });
	});

	app.use((req, res) => {
		send(res, 404, rejection("bad_request", `No route ${req.method} ${req.path}.`, false));
	});

	const onError: ErrorRequestHandler = (error, req, res, _next) => {
		const type = (error as { type?: string }).type;
		const message =
			type === "entity.parse.failed" ? "Request body is not valid JSON." : type === "entity.too.large" ? `Request body is larger than ${LIMITS.maxRequestBytes} bytes.` : null;
		if (message) {
			send(res, 400, rejection("bad_request", message, false));
			traceIn(req, { run_id: null, request_id: null, step: 0, status: 400, latency_ms: null, tokens: null, error_code: "bad_request" });
			return;
		}
		send(res, 500, rejection("internal", "Unexpected worker error.", false));
		traceIn(req, { run_id: null, request_id: null, step: 0, status: 500, latency_ms: null, tokens: null, error_code: "internal" });
	};
	app.use(onError);

	return { app, store };
}

/**
 * Listen with timeouts that suit long requests behind a proxy:
 * - no socket inactivity timeout, so an 8-minute research request is not cut off;
 * - requestTimeout only bounds receiving the request itself (slow-upload protection);
 * - keep-alive longer than common proxy idle timeouts, headersTimeout just above it.
 */
export function listenWorker(app: express.Express, port: number, host?: string): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = app.listen(port, host ?? "0.0.0.0", (error?: Error) => (error ? reject(error) : resolve(server)));
		server.timeout = 0;
		server.requestTimeout = 120_000;
		server.keepAliveTimeout = 75_000;
		server.headersTimeout = 76_000;
	});
}
