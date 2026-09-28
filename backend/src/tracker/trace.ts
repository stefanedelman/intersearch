import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redact } from "../lib/logger";

export type TraceCategory = "run" | "model" | "tool" | "http" | "api" | "budget";

export type TraceEvent = {
	eventId: string;
	parentEventId: string | null;
	runId: string;
	step: number;
	category: TraceCategory;
	service: string | null;
	tool: string | null;
	arguments: unknown;
	status: string;
	startedAt: string;
	latencyMs: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	searchCredits: number | null;
	estimatedCost: number | null;
	errorCode: string | null;
	detail: unknown;
};

type EventInput = Partial<Omit<TraceEvent, "runId" | "startedAt" | "category" | "status">> & {
	category: TraceCategory;
	status: string;
	startedAt?: Date;
};

/**
 * Structured trace: every model call, tool call, and outbound HTTP round trip becomes one JSONL
 * line, appended to the local run folder immediately (so it survives crashes and outages) and
 * queued for upload to the API. Arguments and details are redacted before they are written.
 *
 * Counting convention for network round trips: only `http` events are round trips; `model` and
 * `tool` events are the logical operations that contain them, linked by parentEventId.
 */
export class Trace {
	private readonly file: string;
	private pending: TraceEvent[] = [];
	readonly all: TraceEvent[] = [];

	constructor(
		readonly runId: string,
		runDir: string,
	) {
		fs.mkdirSync(runDir, { recursive: true });
		this.file = path.join(runDir, "trace.jsonl");
	}

	record(input: EventInput): TraceEvent {
		const event: TraceEvent = {
			eventId: input.eventId ?? randomUUID(),
			parentEventId: input.parentEventId ?? null,
			runId: this.runId,
			step: input.step ?? 0,
			category: input.category,
			service: input.service ?? null,
			tool: input.tool ?? null,
			arguments: redact(input.arguments ?? null),
			status: input.status,
			startedAt: (input.startedAt ?? new Date()).toISOString(),
			latencyMs: input.latencyMs ?? null,
			inputTokens: input.inputTokens ?? null,
			outputTokens: input.outputTokens ?? null,
			searchCredits: input.searchCredits ?? null,
			estimatedCost: input.estimatedCost ?? null,
			errorCode: input.errorCode ?? null,
			detail: redact(input.detail ?? null),
		};
		fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`);
		this.all.push(event);
		this.pending.push(event);
		return event;
	}

	/** Times an async operation and records it, success or failure. */
	async span<T>(input: Omit<EventInput, "status" | "latencyMs">, run: (eventId: string) => Promise<T>, describe?: (result: T) => Partial<EventInput>): Promise<T> {
		const eventId = randomUUID();
		const startedAt = new Date();
		try {
			const result = await run(eventId);
			const extra = describe?.(result) ?? {};
			this.record({ ...input, eventId, status: "ok", ...extra, startedAt, latencyMs: Date.now() - startedAt.getTime() });
			return result;
		} catch (error) {
			const err = error as { failure?: string; code?: string; message?: string };
			this.record({
				...input,
				eventId,
				status: "error",
				startedAt,
				latencyMs: Date.now() - startedAt.getTime(),
				errorCode: err.failure ?? err.code ?? "error",
				detail: { ...(typeof input.detail === "object" && input.detail ? input.detail : {}), message: err.message },
			});
			throw error;
		}
	}

	takePending(): TraceEvent[] {
		const batch = this.pending;
		this.pending = [];
		return batch;
	}

	restorePending(batch: TraceEvent[]) {
		this.pending = [...batch, ...this.pending];
	}

	get path() {
		return this.file;
	}
}
