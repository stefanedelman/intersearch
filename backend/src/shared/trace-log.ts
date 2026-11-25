import fs from "node:fs";
import path from "node:path";
import { redact } from "./redact";

export type TraceService = "orchestrator" | "researcher" | "verifier";
export type TraceDirection = "in" | "out";

/**
 * One JSON line per request a service receives (`in`) and per call it makes (`out`), with the
 * assignment's fields (spec §13). `run_id` and `request_id` let one request be followed across all
 * three services' logs.
 *
 * - `latency_ms`: on `out` lines, measured by the caller around the call (the authoritative
 *   cross-service number); on `in` lines, the worker's own processing time. Clocks on different
 *   machines are never compared.
 * - `status`: an HTTP status code, or a short word when there is none (`rejected`, `timeout`,
 *   `network_error`, `aborted`).
 * - `tokens`: model tokens (input + output) for a model call; the request's total on `in` lines.
 * - Optional extras: `idempotency`, `error_code`, `detail`.
 */
export type TraceLine = {
	ts: string;
	service: TraceService;
	run_id: string | null;
	request_id: string | null;
	step: number;
	direction: TraceDirection;
	endpoint_or_tool: string;
	status: number | string;
	latency_ms: number | null;
	attempt: number;
	tokens: number | null;
	idempotency?: "new" | "replay" | "in_flight" | "conflict";
	error_code?: string | null;
	detail?: unknown;
};

export type TraceInput = Omit<TraceLine, "ts" | "service"> & { ts?: Date };

export type TraceLogOptions = {
	/** Append every line to this file (created with its folder). */
	file?: string | null;
	/** Also print each line to stdout (Render's log viewer). */
	stdout?: boolean;
	/** How many recent lines to keep in memory for GET /trace. */
	ringSize?: number;
};

/**
 * Append-only JSONL trace for one service. Every line is redacted before it is written anywhere,
 * so a token or key placed in `detail` by mistake never reaches a file, stdout, or GET /trace.
 */
export class TraceLog {
	private readonly ring: TraceLine[] = [];
	private readonly ringSize: number;

	constructor(
		readonly service: TraceService,
		private readonly options: TraceLogOptions = {},
	) {
		this.ringSize = options.ringSize ?? 5000;
		if (options.file) fs.mkdirSync(path.dirname(options.file), { recursive: true });
	}

	write(input: TraceInput): TraceLine {
		const { ts, ...rest } = input;
		const line = redact({ ts: (ts ?? new Date()).toISOString(), service: this.service, ...rest }) as TraceLine;
		const text = JSON.stringify(line);
		if (this.options.file) fs.appendFileSync(this.options.file, `${text}\n`);
		if (this.options.stdout) process.stdout.write(`${text}\n`);
		this.ring.push(line);
		if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
		return line;
	}

	/** Recent lines, filtered by run and/or request. Lost on restart; collect them right after a run. */
	lines(filter: { runId?: string; requestId?: string } = {}): TraceLine[] {
		return this.ring.filter((line) => (!filter.runId || line.run_id === filter.runId) && (!filter.requestId || line.request_id === filter.requestId));
	}
}

/** Times an outbound call and writes its `out` line, success or failure. `describe` turns the result into status/tokens. */
export async function traced<T>(
	log: TraceLog,
	base: Omit<TraceInput, "direction" | "status" | "latency_ms" | "tokens"> & { tokens?: number | null },
	call: () => Promise<T>,
	describe: (result: T) => { status: number | string; tokens?: number | null; error_code?: string | null; detail?: unknown },
): Promise<T> {
	const startedAt = new Date();
	const started = performance.now();
	try {
		const result = await call();
		log.write({ ...base, ts: startedAt, direction: "out", latency_ms: Math.round(performance.now() - started), tokens: base.tokens ?? null, ...describe(result) });
		return result;
	} catch (error) {
		const err = error as { code?: string; failure?: string; name?: string; message?: string };
		log.write({
			...base,
			ts: startedAt,
			direction: "out",
			status: "error",
			latency_ms: Math.round(performance.now() - started),
			tokens: base.tokens ?? null,
			error_code: err.failure ?? err.code ?? err.name ?? "error",
			detail: { message: err.message?.slice(0, 300) },
		});
		throw error;
	}
}
