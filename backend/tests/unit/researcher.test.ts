import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { researchRequestSchema, researchResponseSchema, type ResearchPayload, type ResearchResult } from "../../src/shared/contract";
import { parseConfig } from "../../src/shared/config";
import { ProviderError } from "../../src/shared/providers/failure";
import type { ModelMessage } from "../../src/shared/providers/groq";
import { TraceLog } from "../../src/shared/trace-log";
import { createWorkerApp } from "../../src/shared/worker/app";
import { applyShare, createResearchHandler } from "../../src/researcher/research";
import { ACME_CONFIG_YAML, createAcmeFetcher, EVIL_URL } from "../fixtures/acme";
import { fetchedSourceIds, scriptedModel, type ScriptStep } from "../helpers/scripted-model";

const TOKEN = "researcher-test-token-0123456789abcdef";
const auth = { Authorization: `Bearer ${TOKEN}` };
const RUN = "6f1c2a4e-8b7d-4c3e-9a1f-2b3c4d5e6f70";
const config = parseConfig(ACME_CONFIG_YAML);
const DETAIL = (id: number) => `https://boards-api.greenhouse.io/v1/boards/acme/jobs/${id}`;

/** List jobs, fetch two postings, then finish with model-written claims about the first. */
const happyScript: ScriptStep[] = [
	{ tool: "list_company_jobs", args: { company_id: "acme" } },
	{ tool: "fetch_article", args: { url: DETAIL(1001) } },
	{ tool: "fetch_article", args: { url: DETAIL(1005) } },
	{
		tool: "finish",
		args: (messages: ModelMessage[]) => {
			const ids = fetchedSourceIds(messages);
			return {
				candidates: [
					{ source_id: ids.get(DETAIL(1001)), claims: ["The intern builds backend services in Go and Python.", "The hourly pay is $52 per hour."] },
					{ source_id: ids.get(DETAIL(1005)) },
				],
			};
		},
	},
];

function setup(script: ScriptStep[], options: { jobs?: number[] } = {}) {
	const model = scriptedModel(script);
	const fixture = createAcmeFetcher(options.jobs ?? [1001, 1002, 1003, 1005]);
	const log = new TraceLog("researcher");
	const { app } = createWorkerApp<ResearchPayload, ResearchResult>({
		service: "researcher",
		token: TOKEN,
		log,
		maxConcurrent: 1,
		route: {
			path: "/research",
			requestSchema: researchRequestSchema,
			responseSchema: researchResponseSchema,
			emptyResult: { developments: [] },
			handle: createResearchHandler({ configPath: "unused.yaml", loadConfig: () => parseConfig(ACME_CONFIG_YAML), callModel: model.callModel, search: null, fetcher: fixture.fetcher }),
		},
	});
	const body = (overrides: Record<string, unknown> = {}) => ({
		request_id: randomUUID(),
		run_id: RUN,
		time_budget_ms: 30_000,
		budget: { max_steps: 10, max_fetches: 10, max_tokens: 100_000 },
		payload: { topic: "Summer 2027 backend internships at Acme", k: 3 },
		...overrides,
	});
	const send = (sent: object) => request(app).post("/research").set(auth).send(sent);
	return { send, body, model, fixture, log };
}

describe("POST /research", () => {
	test("returns ranked developments whose claims each cite one fetched page", async () => {
		const { send, body, fixture } = setup(happyScript);
		const res = await send(body());
		assert.equal(res.status, 200);
		assert.equal(researchResponseSchema.safeParse(res.body).success, true);
		assert.equal(res.body.status, "complete");
		const developments = res.body.result.developments as ResearchResult["developments"];
		assert.deepEqual(developments.map((development) => development.id), ["greenhouse:acme:1005", "greenhouse:acme:1001"]);
		const [, backend] = developments;
		const texts = backend!.claims.map((claim) => claim.text);
		assert.ok(texts.includes("The intern builds backend services in Go and Python."), "model claims are carried");
		assert.ok(texts.includes("The position is for Summer 2027."), "code claims are included");
		assert.ok(backend!.claims.every((claim) => claim.source_url === DETAIL(1001)));
		assert.ok(developments[0]!.claims.every((claim) => claim.source_url === DETAIL(1005)));
		const fetched = fixture.requests.filter((url) => url.includes("/jobs/"));
		assert.equal(fetched.length, 2);
		assert.deepEqual(res.body.usage.steps, 4);
		assert.deepEqual(res.body.usage.fetches, 3, "one feed request + two postings");
	});

	test("the topic and k come from the request; the share can only lower config limits", () => {
		const request = researchRequestSchema.parse({
			request_id: randomUUID(),
			run_id: RUN,
			time_budget_ms: 60_000,
			budget: { max_steps: 3, max_fetches: 2, max_tokens: 9_000_000 > 1_000_000 ? 900_000 : 0 },
			payload: { topic: "New topic", k: 4 },
		});
		const shared = applyShare(config, request, 45_000);
		assert.equal(shared.tracker.topic, "New topic");
		assert.equal(shared.tracker.k, 4);
		assert.equal(shared.limits.max_steps, 3);
		assert.equal(shared.limits.max_model_calls, 3);
		assert.equal(shared.limits.max_total_tokens, config.limits.max_total_tokens, "a share above the config ceiling does not raise it");
		assert.equal(shared.limits.max_elapsed_seconds, 45);
	});

	test("k caps the number of developments", async () => {
		const { send, body } = setup(happyScript);
		const res = await send(body({ payload: { topic: "Acme internships", k: 1 } }));
		assert.equal(res.body.result.developments.length, 1);
		assert.equal(res.body.result.developments[0].id, "greenhouse:acme:1005");
	});

	test("the step share stops the loop and returns partial with what it found", async () => {
		const { send, body } = setup(happyScript);
		const res = await send(body({ budget: { max_steps: 2, max_fetches: 10, max_tokens: 100_000 } }));
		assert.equal(res.status, 200);
		assert.equal(res.body.status, "partial");
		assert.equal(res.body.error.code, "step_budget_exhausted");
		assert.equal(res.body.usage.steps, 2);
		assert.ok(res.body.result.developments.length <= 1);
	});

	test("the fetch share counts every page request (feeds and articles) and withdraws the tools when used up", async () => {
		const { send, body, fixture } = setup(happyScript);
		const res = await send(body({ budget: { max_steps: 10, max_fetches: 2, max_tokens: 100_000 } }));
		assert.equal(res.body.usage.fetches, 2);
		assert.equal(fixture.requests.length, 2, "no third page request was made");
		assert.ok(["complete", "partial"].includes(res.body.status));
	});

	test("a step share of 0 does no work", async () => {
		const { send, body, model } = setup(happyScript);
		const res = await send(body({ budget: { max_steps: 0, max_fetches: 5, max_tokens: 1000 } }));
		assert.equal(res.body.status, "partial");
		assert.equal(res.body.error.code, "step_budget_exhausted");
		assert.equal(model.calls.length, 0);
	});

	test("a tiny time budget returns partial", async () => {
		const { send, body } = setup(happyScript);
		const res = await send(body({ time_budget_ms: 1 }));
		assert.equal(res.status, 200);
		assert.equal(res.body.status, "partial");
		assert.equal(res.body.error.code, "time_budget_exhausted");
	});

	test("a bad model key is 500 failed", async () => {
		const { send, body } = setup([{ error: new ProviderError("groq", "auth", "groq returned HTTP 401: the API key is missing or invalid", 401) }]);
		const res = await send(body());
		assert.equal(res.status, 500);
		assert.equal(res.body.status, "failed");
		assert.equal(res.body.error.code, "model_auth_failed");
	});

	test("a per-minute rate limit before any work is 503 with Retry-After", async () => {
		const { send, body } = setup([{ error: new ProviderError("groq", "rate_limit_unknown", "groq returned HTTP 429", 429) }]);
		const res = await send(body());
		assert.equal(res.status, 503);
		assert.ok(Number(res.headers["retry-after"]) >= 1);
		assert.equal(res.body.error.code, "model_rate_limited");
	});

	test("a page with injected instructions changes nothing the code controls", async () => {
		const script: ScriptStep[] = [
			{ tool: "fetch_article", args: { url: EVIL_URL } },
			{ tool: "finish", args: (messages: ModelMessage[]) => ({ candidates: [{ source_id: fetchedSourceIds(messages).get(EVIL_URL) }] }) },
		];
		const { send, body, model } = setup(script);
		const res = await send(body());
		assert.equal(res.status, 200);
		const tools = model.calls[1]!.map((message) => message.role);
		assert.ok(tools.includes("tool"));
		for (const development of res.body.result.developments) for (const claim of development.claims) assert.match(claim.source_url, /^https:\/\//);
	});

	test("a repeated request replays the stored response: no new model calls or page requests", async () => {
		const { send, body, model, fixture } = setup(happyScript);
		const sent = body();
		const first = await send(sent);
		const calls = model.calls.length;
		const pages = fixture.requests.length;
		const second = await send(sent);
		assert.equal(second.text, first.text);
		assert.equal(model.calls.length, calls);
		assert.equal(fixture.requests.length, pages);
	});

	test("every model call and page request is an `out` line with the run and request ids", async () => {
		const { send, body, log } = setup(happyScript);
		const sent = body();
		await send(sent);
		const lines = log.lines({ requestId: sent.request_id });
		const out = lines.filter((line) => line.direction === "out");
		assert.equal(out.filter((line) => line.endpoint_or_tool.startsWith("groq ")).length, 4);
		assert.equal(out.filter((line) => line.endpoint_or_tool.startsWith("fetch ")).length, 3);
		assert.ok(out.every((line) => line.run_id === RUN && line.service === "researcher"));
		assert.ok(out.filter((line) => line.endpoint_or_tool.startsWith("groq ")).every((line) => typeof line.tokens === "number" && line.tokens > 0));
		assert.equal(lines.filter((line) => line.direction === "in").length, 1);
	});
});

describe("finish is lenient where strictness would lose the run's result", () => {
	test("one unknown source_id and out-of-range claims are dropped, not the whole finish; the trace shows what happened", async () => {
		const script: ScriptStep[] = [
			{ tool: "list_company_jobs", args: { company_id: "acme" } },
			{ tool: "fetch_article", args: { url: DETAIL(1001) } },
			{
				tool: "finish",
				args: (messages: ModelMessage[]) => ({
					candidates: [
						{ source_id: "made-up-id" },
						{
							source_id: fetchedSourceIds(messages).get(DETAIL(1001)),
							claims: ["short", "The intern builds backend services in Go and Python.", "x".repeat(400), "The hourly pay is $52 per hour.", "The role is based in New York, NY.", "The team works on payments infrastructure.", "One claim too many for this posting."],
						},
					],
				}),
			},
		];
		const { send, body, log } = setup(script);
		const sent = body();
		const res = await send(sent);
		assert.equal(res.body.status, "complete", "an accepted finish completes the run");
		const texts = (res.body.result.developments as ResearchResult["developments"]).flatMap((development) => development.claims.map((claim) => claim.text));
		assert.ok(texts.includes("The intern builds backend services in Go and Python."));
		assert.ok(texts.includes("The team works on payments infrastructure."), "the fourth usable claim is kept");
		assert.ok(!texts.includes("One claim too many for this posting."), "claims past the fourth are dropped");
		assert.ok(!texts.some((text) => text === "short" || text.startsWith("xxx")));
		const finish = log.lines({ requestId: sent.request_id }).find((line) => line.endpoint_or_tool === "tool finish");
		assert.equal(finish?.status, "ok");
		assert.deepEqual((finish?.detail as { claims: number; dropped_claims: number; errors: string[] }).claims, 4);
		assert.match((finish?.detail as { errors: string[] }).errors[0]!, /made-up-id/);
	});

	test("a finish with no usable candidate is still rejected, so the model can correct it", async () => {
		const script: ScriptStep[] = [
			{ tool: "fetch_article", args: { url: DETAIL(1001) } },
			{ tool: "finish", args: { candidates: [{ source_id: "made-up-id" }] } },
			{ tool: "finish", args: (messages: ModelMessage[]) => ({ candidates: [{ source_id: fetchedSourceIds(messages).get(DETAIL(1001)) }] }) },
		];
		const { send, body, log, model } = setup(script);
		const sent = body();
		const res = await send(sent);
		assert.equal(res.body.status, "complete");
		assert.equal(model.calls.length, 3);
		assert.deepEqual(log.lines({ requestId: sent.request_id }).filter((line) => line.endpoint_or_tool === "tool finish").map((line) => line.status), ["invalid", "ok"]);
	});
});

describe("service boundaries", () => {
	const sources = (dir: string): string[] =>
		fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : []));
	const src = path.resolve(__dirname, "../../src");

	for (const worker of ["researcher", "verifier"] as const) {
		test(`${worker} code imports only its own files and src/shared`, () => {
			const offenders: string[] = [];
			for (const file of sources(path.join(src, worker))) {
				for (const match of fs.readFileSync(file, "utf8").matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
					const target = path.resolve(path.dirname(file), match[1]!);
					const relative = path.relative(src, target);
					if (!relative.startsWith(`${worker}${path.sep}`) && !relative.startsWith(`shared${path.sep}`) && relative !== worker) offenders.push(`${path.relative(src, file)} → ${match[1]}`);
				}
				if (/@prisma|generated\/prisma|@supabase/.test(fs.readFileSync(file, "utf8"))) offenders.push(`${path.relative(src, file)} uses Prisma or Supabase`);
			}
			assert.deepEqual(offenders, []);
		});
	}

	test("the orchestrator talks to workers only over HTTP: it imports no researcher or verifier code", () => {
		const offenders: string[] = [];
		for (const file of sources(path.join(src, "orchestrator"))) {
			for (const match of fs.readFileSync(file, "utf8").matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
				const relative = path.relative(src, path.resolve(path.dirname(file), match[1]!));
				if (relative.startsWith(`researcher${path.sep}`) || relative.startsWith(`verifier${path.sep}`)) offenders.push(`${path.relative(src, file)} → ${match[1]}`);
			}
		}
		assert.deepEqual(offenders, []);
	});

	test("shared code imports nothing outside src/shared", () => {
		const offenders: string[] = [];
		for (const file of sources(path.join(src, "shared"))) {
			for (const match of fs.readFileSync(file, "utf8").matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
				const relative = path.relative(src, path.resolve(path.dirname(file), match[1]!));
				if (!relative.startsWith(`shared${path.sep}`)) offenders.push(`${path.relative(src, file)} → ${match[1]}`);
			}
		}
		assert.deepEqual(offenders, []);
	});
});
