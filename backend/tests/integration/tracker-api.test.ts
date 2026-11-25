import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import request from "supertest";
import YAML from "yaml";
import { startTestDatabase } from "../helpers/test-db";
import { createFakeAuthProvider } from "../helpers/fake-auth-provider";
import { ACME_CONFIG_YAML } from "../fixtures/acme";
import { CLOSED, closeWorkers, listen, RESEARCHER_TOKEN, script, startResearcher, startVerifier, TEST_ORCHESTRATION, VERIFIER_TOKEN } from "../helpers/workers";
import type { JobRunner, RunnerSettings } from "../../src/orchestrator/jobs";

process.env.APP_ENV = "test";
process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.CORS_ALLOWED_ORIGINS = "http://localhost:5173";

let stopDb: () => Promise<void>;
let fake: ReturnType<typeof createFakeAuthProvider>;
let prisma: typeof import("../../src/lib/prisma").prisma;
let createApp: typeof import("../../src/app").createApp;
let createJobRunner: typeof import("../../src/orchestrator/jobs").createJobRunner;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "intersearch-api-"));
const configPath = path.join(tempDir, "config.yaml");

before(async () => {
	stopDb = (await startTestDatabase()).stop;
	fake = createFakeAuthProvider();
	prisma = (await import("../../src/lib/prisma")).prisma;
	createApp = (await import("../../src/app")).createApp;
	createJobRunner = (await import("../../src/orchestrator/jobs")).createJobRunner;
});

after(async () => {
	closeWorkers();
	const { closePrisma } = await import("../../src/lib/prisma");
	await closePrisma();
	await stopDb();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
	await prisma.profile.deleteMany();
	fake.users.clear();
	writeConfig();
});

/** config.yaml as the API re-reads it at every run start: the Acme fixture plus fast orchestration numbers. */
function writeConfig(text = `${ACME_CONFIG_YAML}\n${YAML.stringify({ orchestration: TEST_ORCHESTRATION })}`) {
	fs.writeFileSync(configPath, text);
}

async function setup(urls: { researcher: string; verifier: string }, overrides: Partial<RunnerSettings> = {}) {
	const runner: JobRunner = createJobRunner({
		researcher: { url: urls.researcher, token: RESEARCHER_TOKEN },
		verifier: { url: urls.verifier, token: VERIFIER_TOKEN },
		configPath,
		runsDir: path.join(tempDir, "runs"),
		heartbeatMs: 200,
		traceTimeoutMs: 2_000,
		...overrides,
	});
	const app: Express = createApp({ authProvider: fake.provider, runner });
	const register = async (username: string) => {
		const res = await request(app).post("/api/auth/register").send({ username, password: "Courant2026!" });
		assert.equal(res.status, 201, JSON.stringify(res.body));
		return { Authorization: `Bearer ${res.body.token as string}` };
	};
	return { app, runner, register };
}

const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;

describe("tracker run API", () => {
	test("POST /runs returns 202 and runs in the background; the same key never starts a second run; a different key is 409 while it runs", async () => {
		const researcher = await startResearcher(script([1001, 1005]), { delayMs: 400 });
		const verifier = await startVerifier();
		const { app, runner, register } = await setup({ researcher: researcher.url, verifier: verifier.url });
		const auth = await register("NYUgrader");
		const idempotencyKey = key();

		const started = await request(app).post("/api/tracker/runs").set(auth).send({ idempotencyKey });
		assert.equal(started.status, 202, JSON.stringify(started.body));
		const runId = started.body.runId as string;
		const live = await request(app).get(`/api/tracker/runs/${runId}`).set(auth);
		assert.equal(live.body.run.status, "running");
		assert.equal(live.body.run.kind, "orchestrated");
		assert.ok(["starting", "researching"].includes(live.body.run.phase));

		const again = await request(app).post("/api/tracker/runs").set(auth).send({ idempotencyKey });
		assert.equal(again.status, 202);
		assert.equal(again.body.runId, runId);
		const other = await request(app).post("/api/tracker/runs").set(auth).send({ idempotencyKey: key() });
		assert.equal(other.status, 409);
		assert.equal(other.body.error.code, "RUN_IN_PROGRESS");

		await runner.idle();
		assert.equal(researcher.model.calls.length, 4, "the researcher ran once");
		const done = await request(app).get(`/api/tracker/runs/${runId}`).set(auth);
		assert.equal(done.body.run.status, "complete", done.body.run.stopReason);
		assert.equal(done.body.run.phase, "done");
		assert.deepEqual(done.body.run.workerCalls.map((call: { endpoint: string; outcome: string }) => [call.endpoint, call.outcome]), [
			["/healthz", "complete"],
			["/research", "complete"],
			["/verify", "complete"],
			["/verify", "complete"],
		]);
		assert.ok(done.body.run.ledger.charged.steps > 0);
		assert.ok(!JSON.stringify(done.body).includes(VERIFIER_TOKEN) && !JSON.stringify(done.body).includes(RESEARCHER_TOKEN), "worker tokens never reach the browser");

		const claims = await request(app).get(`/api/tracker/runs/${runId}/claims`).set(auth);
		assert.equal(claims.status, 200);
		assert.ok(claims.body.claims.length > 0);
		assert.equal(claims.body.claims[0].rank, 1);
		assert.ok(claims.body.counts.supported > 0 && claims.body.counts.unsupported > 0);
		const supported = await request(app).get(`/api/tracker/runs/${runId}/claims?label=supported`).set(auth);
		assert.ok(supported.body.claims.length === claims.body.counts.supported && supported.body.claims.every((claim: { label: string; evidence: string }) => claim.label === "supported" && claim.evidence));
		assert.equal((await request(app).get(`/api/tracker/runs/${runId}/claims?label=maybe`).set(auth)).status, 400);

		assert.deepEqual(done.body.run.claimCounts, claims.body.counts);
		const history = await request(app).get("/api/tracker/runs").set(auth);
		assert.deepEqual(history.body.runs[0].claimCounts, claims.body.counts);
		const report = await request(app).get(`/api/tracker/runs/${runId}/report`).set(auth);
		assert.equal(report.body.report.schemaVersion, 2);
		const latest = await request(app).get("/api/tracker/report/latest").set(auth);
		assert.equal(latest.body.run.id, runId);
		const overview = await request(app).get("/api/tracker").set(auth);
		assert.deepEqual(overview.body.tracker.config.orchestration.totalBudget, TEST_ORCHESTRATION.total_budget);
		assert.equal(overview.body.runInProgress, null);
	});

	test("another user's run is 404 for read, claims, and cancel", async () => {
		const researcher = await startResearcher(script([1005]));
		const { app, runner, register } = await setup({ researcher: researcher.url, verifier: (await startVerifier()).url });
		const owner = await register("owner");
		const stranger = await register("stranger");
		const runId = (await request(app).post("/api/tracker/runs").set(owner).send({ idempotencyKey: key() })).body.runId;
		for (const [method, url] of [
			["get", `/api/tracker/runs/${runId}`],
			["get", `/api/tracker/runs/${runId}/claims`],
			["post", `/api/tracker/runs/${runId}/cancel`],
		] as const) {
			assert.equal((await request(app)[method](url).set(stranger)).status, 404, url);
		}
		await runner.idle();
	});

	test("cancel stops the request in flight at once and the run ends partial; cancelling a finished run is 409", async () => {
		const researcher = await startResearcher(script([1001]), { delayMs: 5_000 });
		const { app, runner, register } = await setup({ researcher: researcher.url, verifier: (await startVerifier()).url });
		const auth = await register("NYUgrader");
		const runId = (await request(app).post("/api/tracker/runs").set(auth).send({ idempotencyKey: key() })).body.runId;
		await new Promise((resolve) => setTimeout(resolve, 200));
		const begin = Date.now();
		const cancel = await request(app).post(`/api/tracker/runs/${runId}/cancel`).set(auth).send({});
		assert.equal(cancel.status, 202);
		assert.equal(cancel.body.stoppedNow, true);
		await runner.idle();
		assert.ok(Date.now() - begin < 4_000, "did not wait for the researcher");
		const run = (await request(app).get(`/api/tracker/runs/${runId}`).set(auth)).body.run;
		assert.equal(run.status, "partial");
		assert.match(run.stopReason, /cancelled from the dashboard/);
		assert.equal(run.cancelRequested, true);
		const again = await request(app).post(`/api/tracker/runs/${runId}/cancel`).set(auth).send({});
		assert.equal(again.status, 409);
		assert.equal(again.body.error.code, "RUN_NOT_RUNNING");
	});

	test("GET /workers probes both workers from the server; wake waits for the verifier", async () => {
		const researcher = await startResearcher(script([1001]));
		const { app, register } = await setup({ researcher: researcher.url, verifier: CLOSED });
		assert.equal((await request(app).get("/api/tracker/workers")).status, 401);
		const auth = await register("NYUgrader");
		const res = await request(app).get("/api/tracker/workers").set(auth);
		assert.equal(res.status, 200);
		assert.equal(res.body.researcher.state, "up");
		assert.equal(typeof res.body.researcher.latencyMs, "number");
		assert.equal(res.body.verifier.state, "down");
		assert.ok(!JSON.stringify(res.body).includes(RESEARCHER_TOKEN));

		// A verifier that accepts connections but does not answer yet looks asleep (a Render cold start).
		const express = (await import("express")).default;
		const sleepy = express();
		sleepy.get("/healthz", (_req, res) => setTimeout(() => res.json({ status: "ok" }), 3_500));
		const asleep = await setup({ researcher: researcher.url, verifier: (await listen(sleepy)).url });
		const sleepyAuth = await asleep.register("sleeper");
		assert.equal((await request(asleep.app).get("/api/tracker/workers").set(sleepyAuth)).body.verifier.state, "asleep");
		await request(asleep.app).put("/api/tracker/config").set(sleepyAuth).send({ config: { ...YAML.parse(ACME_CONFIG_YAML), orchestration: { ...TEST_ORCHESTRATION, timeouts: { ...TEST_ORCHESTRATION.timeouts, healthz_wake_ms: 6_000 } } } });
		const wake = await request(asleep.app).post("/api/tracker/workers/verifier/wake").set(sleepyAuth).send({});
		assert.equal(wake.body.verifier.state, "up");
		assert.ok(wake.body.verifier.latencyMs >= 3_400, "reports how long waking took");
		assert.equal(wake.body.timeoutMs, 6_000);
	});

	test("missing worker tokens are a 503 that names them; an invalid config.yaml is a 400; neither creates a run", async () => {
		const missing = await setup({ researcher: CLOSED, verifier: CLOSED }, { verifier: { url: CLOSED, token: undefined } });
		const auth = await missing.register("NYUgrader");
		const res = await request(missing.app).post("/api/tracker/runs").set(auth).send({ idempotencyKey: key() });
		assert.equal(res.status, 503);
		assert.equal(res.body.error.code, "WORKERS_NOT_CONFIGURED");
		assert.match(res.body.error.message, /VERIFIER_TOKEN/);
		assert.equal((await request(missing.app).get("/api/tracker/workers").set(auth)).body.verifier.state, "not_configured");

		writeConfig(ACME_CONFIG_YAML.replace("k: 3", "k: 99"));
		const configured = await setup({ researcher: CLOSED, verifier: CLOSED });
		const bad = await request(configured.app).post("/api/tracker/runs").set(await configured.register("other")).send({ idempotencyKey: key() });
		assert.equal(bad.status, 400);
		assert.equal(bad.body.error.code, "CONFIG_INVALID");
		assert.equal(await prisma.run.count(), 0);
	});

	test("startup sweep closes orchestrated runs left running by a previous process, so a new run can start", async () => {
		const researcher = await startResearcher(script([1005]));
		const { app, runner, register } = await setup({ researcher: researcher.url, verifier: (await startVerifier()).url });
		const auth = await register("NYUgrader");
		const first = (await request(app).post("/api/tracker/runs").set(auth).send({ idempotencyKey: key() })).body.runId;
		await runner.idle();
		// Simulate a process that died mid-run: a run still marked running that no job owns.
		await prisma.run.update({ where: { id: first }, data: { status: "running", phase: "researching" } });
		assert.equal((await request(app).post("/api/tracker/runs").set(auth).send({ idempotencyKey: key() })).status, 409);
		const restarted = createJobRunner(runner.settings);
		assert.deepEqual(await restarted.sweep(), [first]);
		const swept = await prisma.run.findUniqueOrThrow({ where: { id: first } });
		assert.deepEqual([swept.status, swept.stopReason, swept.phase], ["partial", "orchestrator restarted mid-run", "done"]);
		assert.equal((await request(app).post("/api/tracker/runs").set(auth).send({ idempotencyKey: key() })).status, 202);
		await runner.idle();
	});
});
