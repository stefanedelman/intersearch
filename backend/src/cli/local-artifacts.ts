import path from "node:path";
import { paths } from "../lib/env";

// Local run folder (gitignored): runs/<runId>/. The 1B tracker wrote trace.jsonl here; orchestrated
// runs write one JSONL per service.

export function runDir(runId: string): string {
	return path.join(process.env.TRACKER_RUNS_DIR ?? path.join(paths.repoRoot, "runs"), runId);
}

export const artifacts = {
	tracePath: (runId: string) => path.join(runDir(runId), "trace.jsonl"),
};
