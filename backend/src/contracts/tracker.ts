import { z } from "zod";

// The tracker API's request contracts. A run is started by POST /api/tracker/runs (202) and runs in
// the API process (the orchestrator); the 1B CLI write path (state, documents, checkpoint, finalize) is gone.

export const startRunBodySchema = z.object({
	idempotencyKey: z.string().min(8).max(100),
});

export type StartRunBody = z.infer<typeof startRunBodySchema>;

export type StartRunResponse = {
	runId: string;
	status: "running" | "complete" | "partial" | "failed";
	baselineRunId: string | null;
	abandonedRunIds: string[];
};
