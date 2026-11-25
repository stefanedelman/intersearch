import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ACME_CONFIG_YAML, createAcmeFetcher } from "../fixtures/acme";
import { fetchedSourceIds, scriptedModel, type ScriptStep } from "./scripted-model";
import { researchRequestSchema, researchResponseSchema, verifyRequestSchema, verifyResponseSchema, type ResearchPayload, type ResearchResult, type VerifyPayload, type VerifyResult } from "../../src/shared/contract";
import { parseConfig } from "../../src/shared/config";
import type { CallModel, ModelMessage } from "../../src/shared/providers/groq";
import { TraceLog } from "../../src/shared/trace-log";
import { createWorkerApp, listenWorker, type WorkContext, type WorkOutcome } from "../../src/shared/worker/app";
import { createResearchHandler } from "../../src/researcher/research";
import { createVerifyHandler } from "../../src/verifier/verify";

// In-process researcher and verifier services on ephemeral ports, with scripted models and the
// Acme fixture pages, for orchestrator and API integration tests.

export const RESEARCHER_TOKEN = "researcher-e2e-token-0123456789abcdef";
export const VERIFIER_TOKEN = "verifier-e2e-token-0123456789abcdef01";
export const CLOSED = "http://127.0.0.1:1"; // nothing listens here: connection refused
export const DETAIL = (id: number) => `https://boards-api.greenhouse.io/v1/boards/acme/jobs/${id}`;

/** Small, fast numbers for tests. */
export const TEST_ORCHESTRATION = {
	total_budget: { max_steps: 30, max_fetches: 30, max_tokens: 200_000 },
	split: { researcher: 0.6 },
	min_verify_share: { steps: 1, fetches: 1, tokens: 1_000 },
	time_budget_ms: { researcher: 20_000, verifier_per_chunk: 5_000 },
	run_deadline_ms: 60_000,
	timeouts: { grace_ms: 2_000, verifier_cold_start_ms: 0, healthz_wake_ms: 2_000 },
	retries: { max_attempts: 3, base_ms: 20, max_backoff_ms: 100, max_retry_after_ms: 5_000 },
};
export type Orchestration = typeof TEST_ORCHESTRATION;

const servers: Server[] = [];

export function closeWorkers() {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		server.close();
	}
}

export async function listen(app: Parameters<typeof listenWorker>[0]) {
	const server = await listenWorker(app, 0, "127.0.0.1");
	servers.push(server);
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/** finish() with model claims about 1001 and code claims for both postings. */
export const finishWith = (ids: number[]): ScriptStep => ({
	tool: "finish",
	args: (messages: ModelMessage[]) => {
		const sources = fetchedSourceIds(messages);
		return { candidates: ids.map((id) => ({ source_id: sources.get(DETAIL(id)), ...(id === 1001 ? { claims: ["The intern builds backend services in Go and Python.", "The hourly pay is $52 per hour."] } : {}) })) };
	},
});
export const script = (ids: number[]): ScriptStep[] => [{ tool: "list_company_jobs", args: { company_id: "acme" } }, ...ids.map((id) => ({ tool: "fetch_article", args: { url: DETAIL(id) } })), finishWith(ids)];

export async function startResearcher(steps: ScriptStep[], options: { delayMs?: number; modelDelayMs?: number } = {}) {
	const scripted = scriptedModel(steps);
	const model = {
		...scripted,
		callModel: (async (input) => {
			if (options.modelDelayMs) await new Promise((resolve) => setTimeout(resolve, options.modelDelayMs));
			return scripted.callModel(input);
		}) satisfies CallModel,
	};
	const fixture = createAcmeFetcher([1001, 1002, 1003, 1005]);
	const log = new TraceLog("researcher");
	const handle = createResearchHandler({ configPath: "unused.yaml", loadConfig: () => parseConfig(ACME_CONFIG_YAML), callModel: model.callModel, search: null, fetcher: fixture.fetcher });
	const { app } = createWorkerApp<ResearchPayload, ResearchResult>({
		service: "researcher",
		token: RESEARCHER_TOKEN,
		log,
		maxConcurrent: 1,
		route: {
			path: "/research",
			requestSchema: researchRequestSchema,
			responseSchema: researchResponseSchema,
			emptyResult: { developments: [] },
			handle: async (request, ctx) => {
				if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
				return handle(request, ctx);
			},
		},
	});
	return { ...(await listen(app)), model, log };
}

/** A verifier whose model supports every claim with a sentence that is on every Acme page, except claims about pay. */
export type VerifierOptions = { handle?: (request: { payload: VerifyPayload }, ctx: WorkContext<VerifyResult>, real: ReturnType<typeof createVerifyHandler>) => Promise<WorkOutcome<VerifyResult>>; modelCalls?: string[][] };

export async function startVerifier(options: VerifierOptions = {}) {
	const verifier = makeVerifier(options);
	return { ...(await listen(verifier.app)), ...verifier };
}

/** One verifier "process": its own idempotency store and trace ring. */
export function makeVerifier(options: VerifierOptions = {}) {
	const modelCalls: string[][] = options.modelCalls ?? [];
	const callModel: CallModel = async (input) => {
		const data = JSON.parse(String(input.messages[1]!.content)) as { claims: { claim_id: string; text: string }[] };
		modelCalls.push(data.claims.map((claim) => claim.claim_id));
		const verdicts = data.claims.map((claim) => (/pay/i.test(claim.text) ? { claim_id: claim.claim_id, verdict: "unsupported", evidence: null } : { claim_id: claim.claim_id, verdict: "supported", evidence: "Acme is hiring." }));
		return { content: JSON.stringify({ verdicts }), toolCalls: [], usage: { input: 800, output: 80 }, finishReason: "stop", requestId: null };
	};
	const fixture = createAcmeFetcher([1001, 1002, 1003, 1005]);
	const real = createVerifyHandler({ callModel, model: "test-verifier-model", fetcher: fixture.fetcher });
	const log = new TraceLog("verifier");
	const { app } = createWorkerApp<VerifyPayload, VerifyResult>({
		service: "verifier",
		token: VERIFIER_TOKEN,
		log,
		route: {
			path: "/verify",
			requestSchema: verifyRequestSchema,
			responseSchema: verifyResponseSchema,
			emptyResult: { verdicts: [] },
			handle: options.handle ? (request, ctx) => options.handle!(request, ctx, real) : real,
		},
	});
	return { app, modelCalls, log, fixture };
}

