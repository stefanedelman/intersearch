import fs from "node:fs";
import path from "node:path";
import { paths, trackerEnv } from "../lib/env";
import { redact } from "../lib/logger";
import { ApiRequestError, ApiUnavailable, TrackerApi } from "./api-client";
import { ConfigError, configHash, loadConfig, type TrackerConfig } from "./config";
import { ProviderError } from "./failure";
import { artifacts, runDir } from "./local-artifacts";
import { createGroqModel } from "./providers/groq";
import { createTavilySearch } from "./providers/tavily";
import { executeRun } from "./run";
import { createApiTraceRecorder } from "./trace";

const log = (message: string) => console.log(message);
const fail = (message: string, code = 1): never => {
	console.error(`\n✖ ${message}`);
	process.exit(code);
};

function argValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function readConfig(): TrackerConfig {
	const env = trackerEnv();
	try {
		return loadConfig(env.TRACKER_CONFIG_PATH);
	} catch (error) {
		if (error instanceof ConfigError) return fail(error.message);
		throw error;
	}
}

async function connect(onRoundTrip?: ConstructorParameters<typeof TrackerApi>[1]) {
	const env = trackerEnv();
	if (!env.TRACKER_USERNAME || !env.TRACKER_PASSWORD) {
		fail("TRACKER_USERNAME and TRACKER_PASSWORD must be set (backend/.env sets them to the course grader account).");
	}
	const api = new TrackerApi(env.TRACKER_API_BASE_URL, onRoundTrip);
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
	const config = readConfig();
	log(`config.yaml is valid: ${config.companies.length} companies, K=${config.tracker.k}, model ${config.model.id}.`);
	log(`config hash ${configHash(config).slice(0, 12)}`);
}

async function commandRun() {
	const env = trackerEnv();
	const config = readConfig();

	// Fail fast, before creating a run or spending anything, when a required key is missing.
	let callModel: ReturnType<typeof createGroqModel>;
	try {
		callModel = createGroqModel(env.GROQ_API_KEY, config.limits.request_timeout_seconds * 1000);
	} catch (error) {
		return fail((error as Error).message);
	}
	const search = config.tools.includes("search_web") && env.TAVILY_API_KEY ? createTavilySearch(env.TAVILY_API_KEY, config.limits.request_timeout_seconds * 1000) : null;
	if (config.tools.includes("search_web") && !search) log("! TAVILY_API_KEY is not set; search_web will report an auth error if the model calls it.");

	const apiTrace = createApiTraceRecorder();
	const { api, user } = await connect(apiTrace.record);
	log(`Logged in as ${user.username}.`);

	let interrupted = false;
	process.once("SIGINT", () => {
		interrupted = true;
		log("\nInterrupted: finishing with a partial report (press Ctrl-C again to force quit)...");
		process.once("SIGINT", () => process.exit(130));
	});

	let result: Awaited<ReturnType<typeof executeRun>>;
	try {
		result = await executeRun({ config, api, callModel, search, log, isInterrupted: () => interrupted, onTrace: apiTrace.attach });
	} catch (error) {
		if (error instanceof ApiRequestError && error.code === "RUN_IN_PROGRESS") return fail(`${error.message} Wait for it to finish (runs idle for 10 minutes are closed automatically).`);
		if (error instanceof ApiRequestError) return fail(`The API rejected the request: ${error.message} ${JSON.stringify(error.details ?? "")}`);
		if (error instanceof ApiUnavailable) return fail(error.message);
		throw error;
	}

	const { runId, outcome, body, budget } = result;
	const rel = (file: string) => path.relative(process.cwd(), file) || file;
	log("");
	log(`Run ${runId}: ${outcome.status.toUpperCase()}${outcome.stopReason ? ` (${outcome.stopReason})` : ""}`);
	log(`  ${body.report.items.length} ranked, ${body.report.items.filter((item) => item.section === "new").length} new, ${body.report.dropped.length} dropped`);
	log(`  articles: ${body.report.stats.fetched} fetched, ${body.report.stats.skipped} skipped (already seen), ${body.report.stats.rejected} rejected, ${body.report.stats.failed} failed`);
	log(`  ${budget.modelCalls} model calls, ${budget.inputTokens + budget.outputTokens} tokens, ${budget.searches} searches, ${budget.networkRequests} external requests, ${(budget.elapsedMs / 1000).toFixed(1)}s`);
	log(`  report: ${rel(result.reportPath)}`);
	log(`  trace:  ${rel(result.tracePath)}`);
	if (!result.uploaded) {
		log(`  ! Not saved to the API (${result.uploadError ?? "unreachable"}). When the backend is reachable again, run: npm run tracker:sync -- --run ${runId}`);
		process.exit(1);
	}
	log(`  saved to the dashboard. Export with: npm run tracker:export -- --run ${runId} --label run1`);
	process.exit(outcome.status === "complete" ? 0 : outcome.status === "partial" ? 2 : 1);
}

async function commandSync(args: string[]) {
	const runId = argValue(args, "--run") ?? fail("Usage: npm run tracker:sync -- --run RUN_ID");
	const pending = artifacts.loadPending(runId);
	const finalize = artifacts.loadFinalize(runId);
	if (!pending && !finalize) fail(`Nothing saved locally for run ${runId} (looked in ${runDir(runId)}).`);
	const { api } = await connect();
	if (pending && (pending.documents.length || pending.fetchAttempts.length || pending.events.length)) {
		for (let i = 0; i < Math.max(pending.documents.length, 1); i += 20) {
			await api.checkpoint(runId, { documents: pending.documents.slice(i, i + 20), fetchAttempts: i === 0 ? pending.fetchAttempts : [], events: i === 0 ? pending.events.slice(0, 500) : [] });
		}
		for (let i = 500; i < pending.events.length; i += 500) await api.checkpoint(runId, { documents: [], fetchAttempts: [], events: pending.events.slice(i, i + 500) });
		artifacts.savePending(runId, { documents: [], fetchAttempts: [], events: [] });
		log(`Uploaded ${pending.documents.length} documents, ${pending.fetchAttempts.length} fetch attempts, ${pending.events.length} trace events.`);
	}
	if (finalize) {
		const result = await api.finalize(runId, finalize);
		log(result.alreadyFinalized ? "Report was already saved." : "Report saved to the dashboard.");
	}
}

async function commandExport(args: string[]) {
	const runId = argValue(args, "--run") ?? fail("Usage: npm run tracker:export -- --run RUN_ID --label run1");
	const label = argValue(args, "--label") ?? fail("Pass --label (for example run1 or run2).");
	if (!/^[a-z0-9_-]{1,40}$/i.test(label)) fail("Label may contain letters, digits, dash, and underscore only.");
	const { api } = await connect();
	const { markdown } = await api.report(runId);
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
	fs.mkdirSync(path.dirname(reportFile), { recursive: true });
	fs.mkdirSync(path.dirname(traceFile), { recursive: true });
	fs.writeFileSync(reportFile, markdown);
	fs.writeFileSync(traceFile, events.map((event) => JSON.stringify(redact(event))).join("\n") + "\n");
	log(`Wrote ${path.relative(paths.repoRoot, reportFile)} and ${path.relative(paths.repoRoot, traceFile)} (${events.length} trace events).`);
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
		case "run":
			return commandRun();
		case "config":
			return commandConfig();
		case "sync":
			return commandSync(args);
		case "export":
			return commandExport(args);
		case "reset":
			return commandReset(args);
		default:
			fail("Usage: tracker <run | config | sync --run ID | export --run ID --label NAME | reset --confirm intersearch-development>");
	}
}

main().catch((error) => {
	if (error instanceof ApiUnavailable || error instanceof ProviderError || error instanceof ApiRequestError) fail(error.message);
	fail(`Unexpected error: ${(error as Error).stack ?? error}`);
});
