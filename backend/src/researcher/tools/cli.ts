import { Budget } from "../budget";
import { ConfigError, loadConfig } from "../../shared/config";
import { ProviderError } from "../../shared/providers/failure";
import { toolEnv } from "../env";
import { createTavilySearch } from "../providers/tavily";
import { Trace } from "../trace";
import { emptyMemory, policyFor, transportFor, type ToolContext } from "./context";
import { fetchArticle } from "./fetch-article";
import { listCompanyJobs } from "./list-jobs";
import { searchWeb } from "./search-web";

// Model-free tool entry point:
//   python -m tracker.tools fetch_article <url>
//   npm run tracker:tools -- fetch_article <url>
// Standalone calls use the same policy, guardrails, and transport as the agent. They need no
// backend, no login, and no model key; nothing is persisted.

const USAGE = `Usage:
  fetch_article <url>
  search_web <query>
  list_company_jobs <company_id>`;

function print(value: unknown) {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function standaloneContext(): ToolContext {
	const env = toolEnv();
	const config = loadConfig(env.TRACKER_CONFIG_PATH);
	return {
		config,
		policy: policyFor(config),
		transport: transportFor(config),
		budget: new Budget(config.limits),
		trace: new Trace("standalone-tools"),
		step: 0,
		parentEventId: null,
		store: null,
		search: env.TAVILY_API_KEY ? createTavilySearch(env.TAVILY_API_KEY, config.limits.request_timeout_seconds * 1000) : null,
		memory: emptyMemory(),
	};
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
		default:
			throw new Error(`Unknown tool "${tool}".\n${USAGE}`);
	}
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		const known = error instanceof ConfigError || error instanceof ProviderError;
		console.error(known || /^Usage|^Unknown tool/.test((error as Error).message) ? (error as Error).message : (error as Error).stack);
		process.exit(error instanceof ProviderError ? 5 : 2);
	});
