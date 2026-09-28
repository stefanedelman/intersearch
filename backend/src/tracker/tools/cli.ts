import fs from "node:fs";
import path from "node:path";
import { paths, trackerEnv } from "../../lib/env";
import { ApiRequestError, ApiUnavailable, TrackerApi } from "../api-client";
import { Budget } from "../budget";
import { ConfigError, configHash, loadConfig } from "../config";
import { extractObservation } from "../domain/facts";
import type { Extracted } from "../fetch/extract";
import { ProviderError } from "../failure";
import { buildFinalizeBody } from "../finalize";
import { createTavilySearch } from "../providers/tavily";
import { Trace } from "../trace";
import { emptyMemory, policyFor, transportFor, type ToolContext } from "./context";
import { fetchArticle } from "./fetch-article";
import { finishArgsSchema, validateFinish } from "./finish";
import { listCompanyJobs } from "./list-jobs";
import { searchWeb } from "./search-web";

// Model-free tool entry point:
//   python -m tracker.tools fetch_article <url>
//   npm run tracker:tools -- fetch_article <url>
// Standalone calls use the same policy, guardrails, and transport as the agent. They need no
// backend, no login, and no model key; nothing is persisted (except `finish`, which saves a report).

const USAGE = `Usage:
  fetch_article <url>
  search_web <query>
  list_company_jobs <company_id>
  finish --run RUN_ID --file draft.json`;

function print(value: unknown) {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function standaloneContext(): ToolContext {
	const env = trackerEnv();
	const config = loadConfig(env.TRACKER_CONFIG_PATH);
	return {
		config,
		policy: policyFor(config),
		transport: transportFor(config),
		budget: new Budget(config.limits),
		trace: new Trace("standalone-tools", path.join(paths.repoRoot, "runs", "standalone-tools")),
		step: 0,
		parentEventId: null,
		store: null,
		search: env.TAVILY_API_KEY ? createTavilySearch(env.TAVILY_API_KEY, config.limits.request_timeout_seconds * 1000) : null,
		memory: emptyMemory(),
	};
}

async function finishFromDraft(args: string[]) {
	const runId = args[args.indexOf("--run") + 1];
	const file = args[args.indexOf("--file") + 1];
	if (!args.includes("--run") || !args.includes("--file") || !runId || !file) throw new Error(USAGE);
	const draft = finishArgsSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
	if (!draft.success) throw new Error(`Draft is invalid: ${draft.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);

	const env = trackerEnv();
	const config = loadConfig(env.TRACKER_CONFIG_PATH);
	const api = new TrackerApi(env.TRACKER_API_BASE_URL);
	await api.login(env.TRACKER_USERNAME ?? "", env.TRACKER_PASSWORD ?? "");
	const state = await api.state(runId);
	const memory = emptyMemory();
	const texts = new Map<string, string>();
	for (const candidate of draft.data.candidates) {
		let doc;
		try {
			doc = await api.document(candidate.source_id);
		} catch (error) {
			if (error instanceof ApiRequestError && error.status === 404) throw new Error(`source_id ${candidate.source_id} is not a document saved for this tracker`);
			throw error;
		}
		const extracted: Extracted = { title: doc.title, text: doc.text, sourceKind: doc.sourceKind as Extracted["sourceKind"], contentHash: doc.contentHash, structured: (doc.metadata as Extracted["structured"]) ?? undefined };
		memory.observations.set(doc.id, extractObservation({ extracted, url: doc.finalUrl, finalUrl: doc.finalUrl, sourceDocumentId: doc.id, fetchedAt: doc.fetchedAt, config }));
		texts.set(doc.id, doc.text);
	}
	const verdict = validateFinish(memory, draft.data, (id) => texts.get(id) ?? null);
	if (!verdict.ok) throw new Error(`finish rejected: ${verdict.errors.join("; ")}`);
	const body = buildFinalizeBody({
		runId,
		config,
		configHash: configHash(config),
		outcome: { status: "complete", stopReason: "finished from a draft file (tracker:tools finish)", errorCode: null },
		memory,
		state,
		store: null,
		notes: verdict.notes,
		budget: new Budget(config.limits),
		extraNotes: [],
	});
	const result = await api.finalize(runId, body);
	return { status: result.alreadyFinalized ? "already_finalized" : "saved", runId, items: body.report.items.length, droppedNotes: verdict.droppedNotes };
}

async function main() {
	const [tool, ...args] = process.argv.slice(2);
	if (!tool || tool === "--help" || tool === "-h") {
		console.log(USAGE);
		return 0;
	}
	switch (tool) {
		case "fetch_article": {
			if (!args[0]) throw new Error(USAGE);
			const result = await fetchArticle(standaloneContext(), args[0]);
			print({
				tool: "fetch_article",
				status: result.status,
				url: result.url,
				final_url: result.finalUrl,
				title: result.title,
				reason: result.reason,
				fetched_at: result.fetchedAt,
				bytes: result.bytes,
				latency_ms: result.latencyMs,
				facts: result.observation?.facts ?? null,
				excerpt: result.text?.slice(0, 600) ?? null,
			});
			return result.status === "fetched" ? 0 : result.status === "rejected" ? 3 : 4;
		}
		case "search_web": {
			if (!args.length) throw new Error(USAGE);
			print({ tool: "search_web", ...(await searchWeb(standaloneContext(), args.join(" "))) });
			return 0;
		}
		case "list_company_jobs": {
			if (!args[0]) throw new Error(USAGE);
			const result = await listCompanyJobs(standaloneContext(), args[0]);
			print({ tool: "list_company_jobs", ...result });
			return result.ok ? 0 : 4;
		}
		case "finish":
			print({ tool: "finish", ...(await finishFromDraft(args)) });
			return 0;
		default:
			throw new Error(`Unknown tool "${tool}".\n${USAGE}`);
	}
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		const known = error instanceof ConfigError || error instanceof ProviderError || error instanceof ApiUnavailable || error instanceof ApiRequestError;
		console.error(known || /^Usage|^Unknown tool|^Draft|^finish|^source_id/.test((error as Error).message) ? (error as Error).message : (error as Error).stack);
		process.exit(error instanceof ProviderError ? 5 : 2);
	});
