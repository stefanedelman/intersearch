import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths, trackerEnv } from "../lib/env";
import { redact } from "../shared/redact";
import { ApiRequestError, ApiUnavailable, TrackerApi } from "./api-client";
import { ConfigError, configHash, loadConfig } from "../shared/config";
import { artifacts, runDir } from "./local-artifacts";

// Console helpers around the Intersearch API. `tracker:run` starts a run through the same endpoint
// as the dashboard's Run button and follows it; the CLI never runs agents itself.

const log = (message: string) => console.log(message);
const fail = (message: string, code = 1): never => {
	console.error(`\n✖ ${message}`);
	process.exit(code);
};

function argValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

async function connect() {
	const env = trackerEnv();
	if (!env.TRACKER_USERNAME || !env.TRACKER_PASSWORD) {
		fail("TRACKER_USERNAME and TRACKER_PASSWORD must be set (backend/.env sets them to the course grader account).");
	}
	const api = new TrackerApi(env.TRACKER_API_BASE_URL);
	try {
		const user = await api.login(env.TRACKER_USERNAME!, env.TRACKER_PASSWORD!);
		return { api, user };
	} catch (error) {
		if (error instanceof ApiUnavailable) return fail(error.message);
		if (error instanceof ApiRequestError && error.status === 401) return fail(`Login failed for ${env.TRACKER_USERNAME}. Check TRACKER_USERNAME/TRACKER_PASSWORD, or run npm run db:seed.`);
		throw error;
	}
}

async function commandConfig() {
	try {
		const config = loadConfig(trackerEnv().TRACKER_CONFIG_PATH);
		log(`config.yaml is valid: ${config.companies.length} companies, K=${config.tracker.k}, model ${config.model.id}.`);
		log(`config hash ${configHash(config).slice(0, 12)}`);
	} catch (error) {
		if (error instanceof ConfigError) fail(error.message);
		throw error;
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function commandRun() {
	const { api, user } = await connect();
	const workers = await api.workers();
	log(`Workers: researcher ${workers.researcher.state}${workers.researcher.latencyMs !== null ? ` (${workers.researcher.latencyMs} ms)` : ""}, verifier ${workers.verifier.state}${workers.verifier.latencyMs !== null ? ` (${workers.verifier.latencyMs} ms)` : ""}`);
	const started = await api.startRun(randomUUID());
	log(`Started run ${started.runId} as ${user.username}${started.baselineRunId ? ` (compared with ${started.baselineRunId})` : ""}. Ctrl-C cancels it.`);
	let cancelling = false;
	process.on("SIGINT", () => {
		if (cancelling) process.exit(130);
		cancelling = true;
		log("\nCancelling…");
		void api.cancel(started.runId).catch((error) => console.error(`cancel failed: ${(error as Error).message}`));
	});
	let lastPhase: string | null = null;
	const seen = new Map<string, string>();
	for (;;) {
		const { run } = await api.runDetail(started.runId);
		if (run.phase !== lastPhase) {
			log(`· ${run.phase ?? "starting"}`);
			lastPhase = run.phase;
		}
		for (const call of run.workerCalls) {
			const line = `  ${call.service} ${call.endpoint}: ${call.outcome} (${call.attempts} attempt${call.attempts === 1 ? "" : "s"}, last ${call.finalStatus ?? "—"}${call.latencyMs !== null ? `, ${call.latencyMs} ms` : ""})${call.errorMessage ? ` ${call.errorMessage}` : ""}`;
			if (call.outcome !== "pending" && seen.get(call.requestId) !== line) {
				log(line);
				seen.set(call.requestId, line);
			}
		}
		if (run.status !== "running") {
			const ledger = run.ledger;
			log(`\nRun ${run.id}: ${run.status.toUpperCase()}${run.stopReason ? ` (${run.stopReason})` : ""}`);
			if (run.failedWorkers.length) log(`Failed worker: ${run.failedWorkers.join(", ")}${run.stale ? " (showing the previous top K, stale)" : ""}`);
			if (ledger) log(`Budget charged: ${ledger.charged.steps}/${ledger.total.steps} steps, ${ledger.charged.fetches}/${ledger.total.fetches} fetches, ${ledger.charged.tokens}/${ledger.total.tokens} tokens`);
			const { markdown } = await api.report(run.id);
			log(`\n${markdown}`);
			log(`Export it with: npm run tracker:export -- --run ${run.id} --label a2-runN`);
			process.exit(run.status === "failed" ? 1 : 0);
		}
		await sleep(2000);
	}
}

async function commandExport(args: string[]) {
	const runId = argValue(args, "--run") ?? fail("Usage: npm run tracker:export -- --run RUN_ID --label run1");
	const label = argValue(args, "--label") ?? fail("Pass --label (for example run1 or run2).");
	if (!/^[a-z0-9_-]{1,40}$/i.test(label)) fail("Label may contain letters, digits, dash, and underscore only.");
	const { api } = await connect();
	const { markdown, report } = await api.report(runId);
	if (report.schemaVersion === 2) return exportOrchestrated(runId, label, markdown);
	// Prefer the local trace: it is complete, including the final upload round trips that happen
	// after the API stops accepting events for a finalized run. Fall back to the API copy.
	let events: Record<string, unknown>[] = [];
	const localTrace = artifacts.tracePath(runId);
	if (fs.existsSync(localTrace)) {
		events = fs.readFileSync(localTrace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
	} else {
		let cursor: string | undefined;
		do {
			const page = await api.trace(runId, cursor);
			events.push(...page.events);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
	}

	const reportFile = path.join(paths.repoRoot, "reports", `${label}.md`);
	const traceFile = path.join(paths.repoRoot, "traces", `${label}.jsonl`);
	for (const file of [reportFile, traceFile]) {
		if (fs.existsSync(file)) fail(`${path.relative(paths.repoRoot, file)} already exists. Exported evidence is never overwritten; choose another --label.`);
	}
	fs.mkdirSync(path.dirname(reportFile), { recursive: true });
	fs.mkdirSync(path.dirname(traceFile), { recursive: true });
	fs.writeFileSync(reportFile, markdown);
	fs.writeFileSync(traceFile, events.map((event) => JSON.stringify(redact(event))).join("\n") + "\n");
	log(`Wrote ${path.relative(paths.repoRoot, reportFile)} and ${path.relative(paths.repoRoot, traceFile)} (${events.length} trace events).`);
}

/** Assignment 2 evidence: reports/<label>.md and traces/<label>/{orchestrator,researcher,verifier}.jsonl from runs/<id>/. */
function exportOrchestrated(runId: string, label: string, markdown: string) {
	const reportFile = path.join(paths.repoRoot, "reports", `${label}.md`);
	const traceDir = path.join(paths.repoRoot, "traces", label);
	for (const target of [reportFile, traceDir]) {
		if (fs.existsSync(target)) fail(`${path.relative(paths.repoRoot, target)} already exists. Exported evidence is never overwritten; choose another --label.`);
	}
	const source = runDir(runId);
	const services = ["orchestrator", "researcher", "verifier"].filter((service) => fs.existsSync(path.join(source, `${service}.jsonl`)));
	if (!services.includes("orchestrator")) fail(`${path.relative(paths.repoRoot, source)}/orchestrator.jsonl not found: export on the machine that ran the API.`);
	fs.mkdirSync(path.dirname(reportFile), { recursive: true });
	fs.mkdirSync(traceDir, { recursive: true });
	fs.writeFileSync(reportFile, markdown);
	for (const service of services) {
		const lines = fs.readFileSync(path.join(source, `${service}.jsonl`), "utf8").split("\n").filter(Boolean);
		fs.writeFileSync(path.join(traceDir, `${service}.jsonl`), lines.map((line) => JSON.stringify(redact(JSON.parse(line)))).join("\n") + "\n");
		log(`Wrote ${path.relative(paths.repoRoot, path.join(traceDir, `${service}.jsonl`))} (${lines.length} lines).`);
	}
	const missing = ["researcher", "verifier"].filter((service) => !services.includes(service));
	if (missing.length) log(`! No ${missing.join(" or ")} trace was collected for this run (the worker was unreachable after the run).`);
	log(`Wrote ${path.relative(paths.repoRoot, reportFile)}.`);
}

async function commandReset(args: string[]) {
	const confirm = argValue(args, "--confirm");
	if (confirm !== "intersearch-development") fail("This deletes the tracker's saved history for the logged-in account. Re-run with: npm run tracker:reset -- --confirm intersearch-development");
	const { api, user } = await connect();
	const result = await api.reset(confirm!);
	log(`Reset tracker history for ${user.username}: ${JSON.stringify(result.deleted)}. The account and config.yaml are unchanged.`);
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	switch (command) {
		case "config":
			return commandConfig();
		case "run":
			return commandRun();
		case "export":
			return commandExport(args);
		case "reset":
			return commandReset(args);
		default:
			fail("Usage: tracker <config | run | export --run ID --label NAME | reset --confirm intersearch-development>");
	}
}

main().catch((error) => {
	if (error instanceof ApiUnavailable || error instanceof ApiRequestError) fail(error.message);
	fail(`Unexpected error: ${(error as Error).stack ?? error}`);
});
