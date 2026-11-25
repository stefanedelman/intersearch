/**
 * Demo API for working on the dashboard without Supabase, Groq, or Tavily (`npm run demo:api`).
 *
 * The real Express app, orchestrator, researcher runtime, and verifier runtime, with:
 * - an in-memory Postgres (PGlite) built from the migrations, reset on every start;
 * - fake auth (register any username in the UI);
 * - scripted models and the Acme fixture pages instead of Groq and the web;
 * - the researcher on :4001 and the verifier on :4002, which can be stopped and started to show
 *   the failure states: POST http://127.0.0.1:4099/{researcher|verifier}/{stop|start}.
 *
 * Development only. Nothing here touches the course database or any external service.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import YAML from "yaml";

process.env.APP_ENV = "test"; // do not load backend/.env: no course credentials in the demo
process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "demo-service-role-key";
process.env.CORS_ALLOWED_ORIGINS = "http://localhost:5173";

const DETAIL = (id: number) => `https://boards-api.greenhouse.io/v1/boards/acme/jobs/${id}`;
const RESEARCHER_TOKEN = "demo-researcher-token-0123456789abcdef";
const VERIFIER_TOKEN = "demo-verifier-token-0123456789abcdef01";
const MODEL_DELAY_MS = Number(process.env.DEMO_MODEL_DELAY_MS ?? 900);
const PORT = Number(process.env.PORT ?? 3000);

async function main() {
	const { startTestDatabase } = await import("../helpers/test-db");
	await startTestDatabase();
	const { createFakeAuthProvider } = await import("../helpers/fake-auth-provider");
	const { ACME_CONFIG_YAML, createAcmeFetcher } = await import("../fixtures/acme");
	const { fetchedSourceIds } = await import("../helpers/scripted-model");
	const { createApp } = await import("../../src/app");
	const { createJobRunner } = await import("../../src/orchestrator/jobs");
	const contract = await import("../../src/shared/contract");
	const { parseConfig } = await import("../../src/shared/config");
	const { TraceLog } = await import("../../src/shared/trace-log");
	const { createWorkerApp, listenWorker } = await import("../../src/shared/worker/app");
	const { createResearchHandler } = await import("../../src/researcher/research");
	const { createVerifyHandler } = await import("../../src/verifier/verify");
	type CallModel = import("../../src/shared/providers/groq").CallModel;

	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	// Three different shortlists in rotation, so consecutive runs show new / still / returned / dropped.
	const rotations = [
		[1001, 1005],
		[1005, 1003],
		[1001, 1005, 1003],
	];
	let researchRuns = 0;

	// Stateless script: the step is the number of model turns so far, so every request starts over.
	const researcherModel: CallModel = async (input) => {
		await sleep(MODEL_DELAY_MS);
		const turn = input.messages.filter((message) => message.role === "assistant").length;
		if (turn === 0) researchRuns += 1;
		const ids = rotations[(researchRuns - 1) % rotations.length]!;
		const usage = { input: 1800 + turn * 400, output: 60 };
		const call = (name: string, args: unknown) => ({ content: null, toolCalls: [{ id: `call_${turn}`, name, arguments: JSON.stringify(args) }], usage, finishReason: "tool_calls", requestId: null });
		if (turn === 0) return call("list_company_jobs", { company_id: "acme" });
		if (turn <= ids.length) return call("fetch_article", { url: DETAIL(ids[turn - 1]!) });
		const sources = fetchedSourceIds(input.messages);
		return call("finish", {
			candidates: ids.map((id) => ({ source_id: sources.get(DETAIL(id)), ...(id === 1001 ? { claims: ["The intern builds backend services in Go and Python.", "The hourly pay is $52 per hour."] } : {}) })),
		});
	};
	const verifierModel: CallModel = async (input) => {
		await sleep(MODEL_DELAY_MS);
		const data = JSON.parse(String(input.messages[1]!.content)) as { claims: { claim_id: string; text: string }[] };
		const verdicts = data.claims.map((claim) => (/pay/i.test(claim.text) ? { claim_id: claim.claim_id, verdict: "unsupported", evidence: null } : { claim_id: claim.claim_id, verdict: "supported", evidence: "Acme is hiring." }));
		return { content: JSON.stringify({ verdicts }), toolCalls: [], usage: { input: 900, output: 90 }, finishReason: "stop", requestId: null };
	};

	const researcherApp = () =>
		createWorkerApp({
			service: "researcher",
			token: RESEARCHER_TOKEN,
			log: researcherLog,
			maxConcurrent: 1,
			route: {
				path: "/research",
				requestSchema: contract.researchRequestSchema,
				responseSchema: contract.researchResponseSchema,
				emptyResult: { developments: [] },
				handle: createResearchHandler({ configPath: "unused.yaml", loadConfig: () => parseConfig(ACME_CONFIG_YAML), callModel: researcherModel, search: null, fetcher: createAcmeFetcher([1001, 1002, 1003, 1005]).fetcher }),
			},
		}).app;
	const verifierApp = () =>
		createWorkerApp({
			service: "verifier",
			token: VERIFIER_TOKEN,
			log: verifierLog,
			route: {
				path: "/verify",
				requestSchema: contract.verifyRequestSchema,
				responseSchema: contract.verifyResponseSchema,
				emptyResult: { verdicts: [] },
				handle: createVerifyHandler({ callModel: verifierModel, model: "demo-verifier-model", fetcher: createAcmeFetcher([1001, 1002, 1003, 1005]).fetcher }),
			},
		}).app;
	const researcherLog = new TraceLog("researcher");
	const verifierLog = new TraceLog("verifier");

	const workers: Record<"researcher" | "verifier", { port: number; make: () => Parameters<typeof listenWorker>[0]; server: Server | null }> = {
		researcher: { port: 4001, make: researcherApp, server: null },
		verifier: { port: 4002, make: verifierApp, server: null },
	};
	const startWorker = async (name: "researcher" | "verifier") => {
		const worker = workers[name];
		if (!worker.server) worker.server = await listenWorker(worker.make(), worker.port, "127.0.0.1");
	};
	const stopWorker = async (name: "researcher" | "verifier") => {
		const worker = workers[name];
		if (!worker.server) return;
		const server = worker.server;
		worker.server = null;
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	};
	await startWorker("researcher");
	await startWorker("verifier");

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intersearch-demo-"));
	const configPath = path.join(dir, "config.yaml");
	const orchestration = {
		total_budget: { max_steps: 24, max_fetches: 24, max_tokens: 190_000 },
		split: { researcher: 0.7 },
		min_verify_share: { steps: 1, fetches: 1, tokens: 2_000 },
		time_budget_ms: { researcher: 60_000, verifier_per_chunk: 20_000 },
		run_deadline_ms: 300_000,
		timeouts: { grace_ms: 5_000, verifier_cold_start_ms: 0, healthz_wake_ms: 10_000 },
		retries: { max_attempts: 3, base_ms: 1_000, max_backoff_ms: 5_000, max_retry_after_ms: 60_000 },
	};
	fs.writeFileSync(configPath, `${ACME_CONFIG_YAML}\n${YAML.stringify({ orchestration })}`);
	const runner = createJobRunner({
		researcher: { url: "http://127.0.0.1:4001", token: RESEARCHER_TOKEN },
		verifier: { url: "http://127.0.0.1:4002", token: VERIFIER_TOKEN },
		configPath,
		runsDir: path.join(dir, "runs"),
		heartbeatMs: 2_000,
		traceTimeoutMs: 3_000,
	});
	const fake = createFakeAuthProvider();
	createApp({ authProvider: fake.provider, runner }).listen(PORT, () => {
		console.log(`Demo API on http://localhost:${PORT} (in-memory database, fake auth, scripted workers). Register any username in the UI.`);
		console.log(`Stop/start workers: curl -X POST http://127.0.0.1:4099/verifier/stop   (researcher|verifier, stop|start)`);
	});

	http
		.createServer((req, res) => {
			const match = /^\/(researcher|verifier)\/(stop|start)$/.exec(req.url ?? "");
			if (req.method !== "POST" || !match) {
				res.writeHead(404).end();
				return;
			}
			const [, name, action] = match as unknown as [string, "researcher" | "verifier", "stop" | "start"];
			void (action === "stop" ? stopWorker(name) : startWorker(name)).then(() => {
				console.log(`${name} ${action === "stop" ? "stopped" : "started"}`);
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ [name]: action === "stop" ? "stopped" : "running" }));
			});
		})
		.listen(4099, "127.0.0.1");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
