import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { startTestDatabase } from "../helpers/test-db";
import { createFakeAuthProvider } from "../helpers/fake-auth-provider";
import { fetchedSourceIds, scriptedModel } from "../helpers/scripted-model";
import { ACME_CONFIG_YAML, createAcmeFetcher, EVIL_URL } from "../fixtures/acme";
import { ApiUnavailable, type ApiRoundTrip } from "../../src/tracker/api-client";
import { createApiTraceRecorder } from "../../src/tracker/trace";
import { randomUUID } from "node:crypto";

process.env.APP_ENV = "test";
process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.TRACKER_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "intersearch-runs-"));

const DETAIL = (id: number) => `https://boards-api.greenhouse.io/v1/boards/acme/jobs/${id}`;

let server: Server;
let baseUrl: string;
let stopDb: () => Promise<void>;

// Loaded lazily so DATABASE_URL points at the test database before Prisma is imported.
let modules: {
	TrackerApi: typeof import("../../src/tracker/api-client").TrackerApi;
	executeRun: typeof import("../../src/tracker/run").executeRun;
	parseConfig: typeof import("../../src/tracker/config").parseConfig;
	ProviderError: typeof import("../../src/tracker/failure").ProviderError;
};

async function newApi(username: string, onRoundTrip?: (trip: ApiRoundTrip) => void) {
	await fetch(`${baseUrl}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "secret123" }) });
	const api = new modules.TrackerApi(baseUrl, onRoundTrip);
	await api.login(username, "secret123");
	return api;
}

before(async () => {
	stopDb = (await startTestDatabase()).stop;
	const fake = createFakeAuthProvider();
	const { createApp } = await import("../../src/app");
	server = createApp({ authProvider: fake.provider }).listen(0);
	await new Promise((resolve) => server.once("listening", resolve));
	const address = server.address();
	baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	modules = {
		TrackerApi: (await import("../../src/tracker/api-client")).TrackerApi,
		executeRun: (await import("../../src/tracker/run")).executeRun,
		parseConfig: (await import("../../src/tracker/config")).parseConfig,
		ProviderError: (await import("../../src/tracker/failure")).ProviderError,
	};
});

after(async () => {
	await new Promise((resolve) => server.close(resolve));
	const { closePrisma } = await import("../../src/lib/prisma");
	await closePrisma();
	await stopDb();
});

describe("tracker end to end (scripted model, fixture transport, real API + database)", () => {
	let api: InstanceType<typeof modules.TrackerApi>;
	let run1Id: string;
	let run2Id: string;
	const acme = createAcmeFetcher([1001, 1002, 1003]);
	const log = () => undefined;

	test("run 1: list, fetch, resist injection, finish; report ranks and cites sources", async () => {
		api = await newApi("tracker-user");
		const config = modules.parseConfig(ACME_CONFIG_YAML);
		const model = scriptedModel([
			{ tool: "list_company_jobs", args: { company_id: "acme" } },
			{ tool: "fetch_article", args: { url: DETAIL(1001) } },
			{ tool: "fetch_article", args: { url: DETAIL(1002) } },
			{ tool: "fetch_article", args: { url: DETAIL(1003) } },
			{ tool: "fetch_article", args: { url: EVIL_URL } },
			// Pretend the model obeyed the injected text; the guardrail must still refuse.
			{ tool: "fetch_article", args: { url: "http://169.254.169.254/latest/meta-data" } },
			{ tool: "set_budget", args: { max_fetches: 999 } },
			{
				tool: "finish",
				args: (messages) => {
					const ids = fetchedSourceIds(messages);
					return {
						candidates: [
							{ source_id: ids.get(DETAIL(1001)), supporting_quote: "Build and scale backend services that process payments for millions of users." },
							{ source_id: ids.get(DETAIL(1003)), supporting_quote: "This quote is not in the posting." },
						],
					};
				},
			},
		]);

		const result = await modules.executeRun({ config, api, callModel: model.callModel, search: null, log, fetcher: acme.fetcher });
		run1Id = result.runId;
		assert.equal(result.outcome.status, "complete", result.outcome.stopReason ?? "");
		assert.equal(result.uploaded, true, result.uploadError ?? "");

		// The metadata address was never requested; the fake transport would have recorded it.
		assert.ok(!acme.requests.some((url) => url.includes("169.254")), "guardrail rejected before any request");

		// The injected text reached the model only inside a tool result, never as an instruction.
		const lastCall = model.calls.at(-1)!;
		assert.equal(lastCall[0]!.role, "system");
		assert.doesNotMatch(String(lastCall[0]!.content), /IGNORE ALL PREVIOUS/);
		const injected = lastCall.filter((message) => typeof message.content === "string" && message.content.includes("IGNORE ALL PREVIOUS"));
		assert.ok(injected.every((message) => message.role === "tool"));

		const report = result.body.report;
		assert.equal(report.items[0]!.title, "Software Engineering Intern, Backend (Summer 2027)");
		assert.equal(report.items[0]!.section, "new");
		assert.ok(report.items.every((item) => item.section === "new"), "first run: everything is new");
		assert.ok(!report.items.some((item) => /London/.test(item.locations.join())), "London role excluded by location");
		assert.ok(!report.items.some((item) => /img|evil/i.test(item.title)), "injection page is not an internship match");
		assert.equal(report.items[0]!.agentNote?.quote, "Build and scale backend services that process payments for millions of users.");
		assert.ok(!report.items.some((item) => item.agentNote?.quote === "This quote is not in the posting."), "unsupported model note dropped");
		assert.match(report.items[0]!.summary, /\$52 per hour/);

		// Every cited quote exists in its stored source (the API also enforced this at finalize).
		for (const item of report.items) {
			for (const evidence of item.evidence) {
				const doc = await api.document(evidence.sourceDocumentId);
				const haystack = `${doc.text}\n${doc.title ?? ""}`.replace(/\s+/g, " ").toLowerCase();
				assert.ok(haystack.includes(evidence.quote.replace(/\s+/g, " ").toLowerCase()), `quote "${evidence.quote}" is in its source`);
			}
		}

		const sources = await fetch(`${baseUrl}/api/tracker/runs/${run1Id}/sources`, { headers: { authorization: `Bearer ${(api as unknown as { token: string }).token}` } }).then((res) => res.json());
		const statuses = sources.sources.map((row: { status: string }) => row.status).sort();
		assert.deepEqual(statuses, ["fetched", "fetched", "fetched", "fetched", "rejected"]);
		const rejected = sources.sources.find((row: { status: string }) => row.status === "rejected");
		assert.match(rejected.reason, /linkLocal/);

		// Trace: every model call and tool call is logged with step, status, latency, and tokens.
		const lines = fs.readFileSync(result.tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const modelEvents = lines.filter((event) => event.category === "model");
		assert.equal(modelEvents.length, 8);
		assert.ok(modelEvents.every((event) => typeof event.inputTokens === "number" && typeof event.latencyMs === "number"));
		assert.ok(lines.some((event) => event.category === "tool" && event.tool === "fetch_article" && event.status === "ok"));
		assert.ok(lines.some((event) => event.category === "tool" && event.status === "invalid" && event.tool === "set_budget"), "unknown tool rejected and logged");
		assert.ok(fs.existsSync(result.reportPath));
	});

	test("run 2: skips cached articles, recognizes an alias URL, and separates new, still, and dropped", async () => {
		acme.setListed([1001, 1002, 1005]); // 1003 disappears from the feed; 1005 is new
		const before = acme.requests.length;
		const config = modules.parseConfig(ACME_CONFIG_YAML.replace("max_steps: 12", "max_steps: 11")); // limits-only edit keeps the comparison
		const model = scriptedModel([
			{ tool: "list_company_jobs", args: { company_id: "acme" } },
			{ tool: "fetch_article", args: { url: DETAIL(1001) } },
			{ tool: "fetch_article", args: { url: DETAIL(1005) } },
			{ tool: "fetch_article", args: { url: "https://careers.acme.example/jobs/1001?gh_jid=1001&utm_source=newsletter" } },
			{ tool: "finish", args: { candidates: [] } },
		]);
		const result = await modules.executeRun({ config, api, callModel: model.callModel, search: null, log, fetcher: acme.fetcher });
		run2Id = result.runId;
		assert.equal(result.outcome.status, "complete");
		assert.equal(result.uploaded, true, result.uploadError ?? "");

		const newRequests = acme.requests.slice(before);
		assert.ok(!newRequests.includes(DETAIL(1001)), "cached article was not re-fetched");
		const report = result.body.report;
		assert.equal(report.comparison.baselineRunId, run1Id);
		assert.equal(report.stats.skipped, 1);

		const byTitle = new Map(report.items.map((item) => [item.title, item]));
		assert.equal(byTitle.get("Software Engineering Intern, Backend (Summer 2027)")?.section, "still");
		assert.equal(byTitle.get("Backend Software Engineer Intern (Summer 2027)")?.section, "new");
		const backend = byTitle.get("Software Engineering Intern, Backend (Summer 2027)")!;
		assert.ok(backend.sources.length >= 2, "alias URL added as a second source of the same development");
		assert.equal(report.items.filter((item) => item.identityKey === "greenhouse:acme:1001").length, 1, "alias did not create a duplicate");

		const dropped = report.dropped.find((item) => item.title === "Data Engineer Intern (Summer 2027)");
		assert.ok(dropped, "role missing from the feed is dropped");
		assert.match(dropped!.reason, /no longer listed/);
		assert.match(result.body.markdown, /## New since last run[\s\S]*## Still in top K[\s\S]*## Dropped/);
	});

	test("budget exhaustion stops without an extra model call and saves a partial report that does not replace the baseline", async () => {
		const config = modules.parseConfig(ACME_CONFIG_YAML.replace("max_steps: 12", "max_steps: 2"));
		const model = scriptedModel([
			{ tool: "list_company_jobs", args: { company_id: "acme" } },
			{ tool: "fetch_article", args: { url: DETAIL(1002) } },
			{ tool: "fetch_article", args: { url: DETAIL(1005) } },
		]);
		const result = await modules.executeRun({ config, api, callModel: model.callModel, search: null, log, fetcher: acme.fetcher });
		assert.equal(result.outcome.status, "partial");
		assert.match(result.outcome.stopReason ?? "", /max_steps/);
		assert.equal(model.calls.length, 2, "no model call after the budget ran out");
		assert.equal(result.body.report.status, "partial");
		assert.equal(result.uploaded, true);
		assert.equal(result.body.report.comparison.baselineRunId, run2Id);

		const state = await api.state();
		assert.equal(state.baseline?.runId, run2Id, "partial run did not become the baseline");
	});

	test("a bad API key is terminal: one attempt, failed status, clear reason", async () => {
		const config = modules.parseConfig(ACME_CONFIG_YAML);
		const model = scriptedModel([{ error: new modules.ProviderError("groq", "auth", "groq returned HTTP 401: the API key is missing or invalid", 401) }]);
		const result = await modules.executeRun({ config, api, callModel: model.callModel, search: null, log, fetcher: acme.fetcher });
		assert.equal(result.outcome.status, "failed");
		assert.equal(model.calls.length, 1, "auth errors are never retried");
		assert.match(result.outcome.stopReason ?? "", /invalid/);
		assert.equal(result.uploaded, true);
	});

	test("a daily quota 429 is not retried; a per-minute 429 is retried then succeeds", async () => {
		const { classifyHttpFailure } = await import("../../src/tracker/failure");
		const config = modules.parseConfig(ACME_CONFIG_YAML);
		const daily = classifyHttpFailure({ provider: "groq", status: 429, body: "Rate limit reached for model on tokens per day (TPD): Limit 100000. Please try again in 7m12s." });
		const quota = scriptedModel([{ error: daily }]);
		const failed = await modules.executeRun({ config, api, callModel: quota.callModel, search: null, log, fetcher: acme.fetcher });
		assert.equal(failed.outcome.status, "failed");
		assert.equal(failed.outcome.errorCode, "quota_exhausted");
		assert.equal(quota.calls.length, 1);

		const minute = classifyHttpFailure({ provider: "groq", status: 429, body: "Rate limit reached on tokens per minute (TPM). Please try again in 0.2s." });
		const recovering = scriptedModel([{ error: minute }, { tool: "finish", args: { candidates: [] } }]);
		const ok = await modules.executeRun({ config, api, callModel: recovering.callModel, search: null, log, fetcher: acme.fetcher });
		assert.equal(ok.outcome.status, "complete");
		assert.equal(recovering.calls.length, 2, "retried once after waiting");
	});

	test("another user cannot read this user's tracker data", async () => {
		const other = await newApi("someone-else");
		await assert.rejects(other.report(run1Id), (error: { status?: number }) => error.status === 404);
		const state = await other.state();
		assert.equal(state.opportunities.length, 0);
	});

	test("network cut while loading state leaves a partial report and can be synced", async () => {
		const client = await newApi("state-outage");
		const loadState = client.state.bind(client);
		const checkpoint = client.checkpoint.bind(client);
		client.state = async () => { throw new ApiUnavailable("Simulated state network cut"); };
		client.checkpoint = async () => { throw new ApiUnavailable("Simulated upload network cut"); };
		const model = scriptedModel([{ tool: "finish", args: { candidates: [] } }]);
		const result = await modules.executeRun({ config: modules.parseConfig(ACME_CONFIG_YAML), api: client, callModel: model.callModel, search: null, log });
		assert.equal(model.calls.length, 0);
		assert.equal(result.outcome.status, "partial");
		assert.equal(result.uploaded, false);
		assert.match(fs.readFileSync(result.reportPath, "utf8"), /partial/);
		assert.match(fs.readFileSync(result.tracePath, "utf8"), /api_unavailable/);
		assert.ok(result.body.report.notes.some(note => /Previous state could not be loaded/.test(note)));
		client.state = loadState;
		client.checkpoint = checkpoint;
		const pending = JSON.parse(fs.readFileSync(path.join(path.dirname(result.reportPath), "pending.json"), "utf8"));
		await client.checkpoint(result.runId, pending);
		await client.finalize(result.runId, result.body);
		assert.equal((await client.report(result.runId)).report.status, "partial");
		assert.equal((await client.state()).baseline, null);
	});

	test("mid-run network cut preserves gathered evidence locally through bounded retries", async () => {
		const client = await newApi("mid-run-outage");
		client.checkpoint = async () => { throw new ApiUnavailable("Simulated upload network cut"); };
		const model = scriptedModel([
			{ tool: "fetch_article", args: { url: DETAIL(1001) } },
			{ error: new modules.ProviderError("groq", "transient", "Simulated provider network cut") },
		]);
		const result = await modules.executeRun({ config: modules.parseConfig(ACME_CONFIG_YAML), api: client, callModel: model.callModel, search: null, log, fetcher: createAcmeFetcher([1001]).fetcher });
		assert.equal(result.outcome.status, "partial");
		assert.equal(result.uploaded, false);
		assert.equal(model.calls.length, 3, "one successful call and two bounded failed attempts");
		assert.equal(result.body.report.items.length, 1);
		assert.match(fs.readFileSync(result.reportPath, "utf8"), /\$52 per hour/);
		const pending = JSON.parse(fs.readFileSync(path.join(path.dirname(result.reportPath), "pending.json"), "utf8"));
		assert.equal(pending.documents.length, 1);
	});

	test("trace includes login, config import, run creation and finalization with real start times", async () => {
		const recorder = createApiTraceRecorder();
		const client = await newApi("trace-startup", recorder.record);
		const model = scriptedModel([{ tool: "finish", args: { candidates: [] } }]);
		const result = await modules.executeRun({ config: modules.parseConfig(ACME_CONFIG_YAML), api: client, callModel: model.callModel, search: null, log, onTrace: recorder.attach });
		const events = fs.readFileSync(result.tracePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
		const trips = events.filter(event => event.category === "api");
		assert.deepEqual(trips.slice(0, 3).map(event => event.arguments.path), ["/api/auth/login", "/api/tracker/config", "/api/tracker/runs"]);
		assert.ok(trips.some(event => /finalize$/.test(event.arguments.path)));
		assert.ok(events.every(event => !(event.arguments && ("password" in event.arguments || "token" in event.arguments))));
		const modelEvent = events.find(event => event.category === "model");
		assert.ok(trips.slice(0, 3).every(event => Date.parse(event.startedAt) + event.latencyMs <= Date.parse(modelEvent.startedAt)));
		const finish = events.find(event => event.category === "tool" && event.tool === "finish");
		assert.equal(typeof finish.latencyMs, "number");
	});

	test("finalize API rejects a fabricated note reason and rejects an invented quote", async () => {
		const client = await newApi("quote-validation");
		const model = scriptedModel([{ tool: "fetch_article", args: { url: DETAIL(1001) } }, { tool: "finish", args: { candidates: [] } }]);
		const result = await modules.executeRun({ config: modules.parseConfig(ACME_CONFIG_YAML), api: client, callModel: model.callModel, search: null, log, fetcher: createAcmeFetcher([1001]).fetcher });
		const started = await client.startRun(randomUUID());
		const body = structuredClone(result.body);
		body.report.runId = started.runId;
		body.report.items[0]!.agentNote = { quote: "Build and scale backend services that process payments for millions of users." };
		Object.assign(body.report.items[0]!.agentNote, { reason: "This internship pays $1 million per year." });
		await assert.rejects(client.finalize(started.runId, body), (error: { status?: number }) => error.status === 400);
		body.report.items[0]!.agentNote = { quote: "This internship pays $1 million per year." };
		await assert.rejects(client.finalize(started.runId, body), (error: { status?: number }) => error.status === 400);
		body.report.items[0]!.agentNote = { quote: "Build and scale backend services that process payments for millions of users." };
		await client.finalize(started.runId, body);
		assert.deepEqual((await client.report(started.runId)).report.items[0]!.agentNote, body.report.items[0]!.agentNote);
	});
});
