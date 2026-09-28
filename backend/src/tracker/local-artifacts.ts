import fs from "node:fs";
import path from "node:path";
import { paths } from "../lib/env";
import type { CheckpointBody, FinalizeBody } from "../contracts/tracker";

// Local run folder (gitignored): runs/<runId>/{trace.jsonl, report.md, report.json, pending.json, finalize.json}.
// Everything is written here first, so a network cut or crash still leaves the report and trace.

export function runDir(runId: string): string {
	return path.join(process.env.TRACKER_RUNS_DIR ?? path.join(paths.repoRoot, "runs"), runId);
}

export function writeJson(file: string, value: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(value, null, 2));
	fs.renameSync(temp, file);
}

export function readJson<T>(file: string): T | null {
	return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : null;
}

export type PendingUploads = Required<CheckpointBody>;

export const artifacts = {
	pendingFile: (runId: string) => path.join(runDir(runId), "pending.json"),
	finalizeFile: (runId: string) => path.join(runDir(runId), "finalize.json"),
	reportMarkdownFile: (runId: string) => path.join(runDir(runId), "report.md"),
	reportJsonFile: (runId: string) => path.join(runDir(runId), "report.json"),
	tracePath: (runId: string) => path.join(runDir(runId), "trace.jsonl"),

	savePending(runId: string, pending: PendingUploads) {
		writeJson(this.pendingFile(runId), pending);
	},
	loadPending(runId: string): PendingUploads | null {
		return readJson<PendingUploads>(this.pendingFile(runId));
	},
	saveFinalize(runId: string, body: FinalizeBody) {
		writeJson(this.finalizeFile(runId), body);
		fs.writeFileSync(this.reportMarkdownFile(runId), body.markdown);
		writeJson(this.reportJsonFile(runId), body.report);
	},
	loadFinalize(runId: string): FinalizeBody | null {
		return readJson<FinalizeBody>(this.finalizeFile(runId));
	},
};
