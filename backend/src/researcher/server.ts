import { researchRequestSchema, researchResponseSchema, type ResearchPayload, type ResearchResult } from "../shared/contract";
import { loadConfig } from "../shared/config";
import { createGroqModel } from "../shared/providers/groq";
import { TraceLog } from "../shared/trace-log";
import { createWorkerApp, listenWorker } from "../shared/worker/app";
import { defaultTraceFile } from "../shared/worker-env";
import { researcherEnv } from "./env";
import { createTavilySearch } from "./providers/tavily";
import { createResearchHandler } from "./research";

/**
 * The researcher service (`npm run dev:researcher`, port 4001): the 1B tracker loop behind
 * POST /research. It listens on localhost only by default; the orchestrator runs on the same machine.
 */
async function main() {
	const env = researcherEnv();
	const config = loadConfig(env.TRACKER_CONFIG_PATH);
	const timeoutMs = config.limits.request_timeout_seconds * 1000;
	const callModel = createGroqModel(env.GROQ_API_KEY, timeoutMs);
	const search = config.tools.includes("search_web") && env.TAVILY_API_KEY ? createTavilySearch(env.TAVILY_API_KEY, timeoutMs) : null;
	if (config.tools.includes("search_web") && !search) console.error("! TAVILY_API_KEY is not set; search_web will report an auth error if the model calls it.");

	const log = new TraceLog("researcher", { file: env.RESEARCHER_TRACE_FILE ?? defaultTraceFile("researcher", env.APP_ENV), stdout: env.APP_ENV === "production" });
	const { app } = createWorkerApp<ResearchPayload, ResearchResult>({
		service: "researcher",
		token: env.RESEARCHER_TOKEN,
		log,
		// One research run at a time: the model's per-minute token limit is shared by everything this process does.
		maxConcurrent: 1,
		route: {
			path: "/research",
			requestSchema: researchRequestSchema,
			responseSchema: researchResponseSchema,
			emptyResult: { developments: [] },
			handle: createResearchHandler({ configPath: env.TRACKER_CONFIG_PATH, callModel, search }),
		},
	});
	await listenWorker(app, env.RESEARCHER_PORT, env.RESEARCHER_HOST);
	console.error(`researcher listening on ${env.RESEARCHER_HOST}:${env.RESEARCHER_PORT} (model ${config.model.id})`);
}

main().catch((error) => {
	console.error(`researcher failed to start: ${(error as Error).message}`);
	process.exit(1);
});
