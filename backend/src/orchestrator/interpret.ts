import type { z } from "zod";
import type { CheckResult, Usage, WorkerError, WorkStatus } from "../shared/contract";
import type { CallOutcome } from "./persist";
import type { CallResult } from "./worker-client";

/**
 * Turning a worker's HTTP answer into something the orchestrator may use. Pure: no database, no
 * network. Routing depends only on the HTTP status, the validated `status` enum, and these checks.
 */

type Envelope<R> = { request_id: string; run_id: string; status: WorkStatus; result: R | null; error: WorkerError | null; usage: Usage };

type Interpreted<R> = {
	outcome: Exclude<CallOutcome, "pending" | "refused_budget">;
	result: R | null;
	usage: Usage | null;
	/** How the ledger charges this request: what the worker reported, its full share, or nothing (it provably did no work). */
	basis: "reported" | "full_share" | "none";
	errorCode: string | null;
	errorMessage: string | null;
	cancelled: boolean;
};

export const FAILURES = new Set<CallOutcome>(["failed", "malformed", "unanswered", "rejected"]);

function issueSummary(error: z.ZodError): string {
	return error.issues
		.slice(0, 3)
		.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`)
		.join("; ");
}

/**
 * Validates a worker's answer against the contract and against what was sent. Anything that does
 * not match is `malformed`: none of its content is used.
 */
export function interpretCall<R>(call: CallResult, schema: z.ZodType<unknown>, ids: { requestId: string; runId: string }, check: (result: R) => CheckResult): Interpreted<R> {
	const res = call.response;
	if (call.gaveUp || !res) {
		const cancelled = call.gaveUp?.reason === "cancelled";
		return { outcome: "unanswered", result: null, usage: null, basis: "full_share", errorCode: cancelled ? "cancelled" : (call.gaveUp?.reason ?? "no_response"), errorMessage: call.gaveUp?.message ?? "no answer", cancelled };
	}
	const malformed = (message: string, usage: Usage | null = null): Interpreted<R> => ({
		outcome: "malformed",
		result: null,
		usage,
		basis: usage ? "reported" : "full_share",
		errorCode: "malformed_response",
		errorMessage: message,
		cancelled: false,
	});
	if (res.status === 200 || res.status === 500) {
		const parsed = schema.safeParse(res.json);
		if (!parsed.success) return malformed(`HTTP ${res.status} body does not match the contract: ${issueSummary(parsed.error)}`);
		const envelope = parsed.data as Envelope<R>;
		if (envelope.request_id !== ids.requestId || envelope.run_id !== ids.runId) return malformed("the response names a different request_id or run_id");
		if ((res.status === 200) !== (envelope.status !== "failed")) return malformed(`HTTP ${res.status} with status "${envelope.status}"`, envelope.usage);
		if (envelope.status === "failed") return { outcome: "failed", result: null, usage: envelope.usage, basis: "reported", errorCode: envelope.error!.code, errorMessage: envelope.error!.message, cancelled: false };
		const checked = check(envelope.result as R);
		if (!checked.ok) return malformed(checked.problems.slice(0, 5).join("; "), envelope.usage);
		return { outcome: envelope.status, result: envelope.result, usage: envelope.usage, basis: "reported", errorCode: envelope.error?.code ?? null, errorMessage: envelope.error?.message ?? null, cancelled: false };
	}
	const error = (res.json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
	const code = typeof error?.code === "string" ? error.code : `http_${res.status}`;
	const message = typeof error?.message === "string" ? error.message : "";
	// 400, 401 and 404 are refused before any work; anything else may have cost something.
	const basis = [400, 401, 404].includes(res.status) ? "none" : "full_share";
	return { outcome: "rejected", result: null, usage: null, basis, errorCode: code, errorMessage: `HTTP ${res.status}${message ? `: ${message}` : ""}`, cancelled: false };
}

