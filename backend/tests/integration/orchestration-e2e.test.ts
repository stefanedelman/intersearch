import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { startTestDatabase } from "../helpers/test-db";
import { ACME_CONFIG_YAML } from "../fixtures/acme";
import { CLOSED, closeWorkers, listen, makeVerifier, RESEARCHER_TOKEN, script, startResearcher, startVerifier, TEST_ORCHESTRATION, VERIFIER_TOKEN, type Orchestration } from "../helpers/workers";
import { parseConfig } from "../../src/shared/config";
import type { TraceLine } from "../../src/shared/trace-log";
import { reportJsonSchema, type ReportJsonV2 } from "../../src/contracts/report";

process.env.APP_ENV = "test";
process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

type Prisma = typeof import("../../src/lib/prisma").prisma;
let prisma: Prisma;
let stopDb: () => Promise<void>;
let trackerService: typeof import("../../src/services/tracker.service").trackerService;
let runOrchestration: typeof import("../../src/orchestrator/run").runOrchestration;
let runsDir: string;
let profileId: string;
const tempDirs: string[] = [];

const ORCHESTRATION = TEST_ORCHESTRATION;

before(async () => {
	stopDb = (await startTestDatabase()).stop;
	prisma = (await import("../../src/lib/prisma")).prisma;
	trackerService = (await import("../../src/services/tracker.service")).trackerService;
	runOrchestration = (await import("../../src/orchestrator/run")).runOrchestration;
});

after(async () => {
	closeWorkers();
	const { closePrisma } = await import("../../src/lib/prisma");
	await closePrisma();
	await stopDb();
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	await prisma.profile.deleteMany();
	profileId = (await prisma.profile.create({ data: { id: randomUUID(), username: "NYUgrader", normalizedUsername: "nyugrader" } })).id;
	runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "intersearch-runs-"));
	tempDirs.push(runsDir);
	await importConfig(ORCHESTRATION);
});

async function importConfig(orchestration: Orchestration) {
	const config = { ...parseConfig(ACME_CONFIG_YAML), orchestration };
	await trackerService.importConfig(profileId, config);
}

async function run(urls: { researcher: string; verifier: string }, options: { signal?: AbortSignal; heartbeatMs?: number } = {}) {
	const started = await trackerService.startRun(profileId, `key-${Math.random().toString(36).slice(2)}`);
	await runOrchestration(
		{ researcher: { url: urls.researcher, token: RESEARCHER_TOKEN }, verifier: { url: urls.verifier, token: VERIFIER_TOKEN }, runsDir, traceTimeoutMs: 2_000, heartbeatMs: options.heartbeatMs ?? 200 },
		started.runId,
		options.signal,
	);
	const row = await prisma.run.findUniqueOrThrow({ where: { id: started.runId }, include: { report: true, workerCalls: { orderBy: { startedAt: "asc" } }, claims: true } });
	const report = reportJsonSchema.parse(row.report!.reportJson) as ReportJsonV2;
	assert.equal(report.schemaVersion, 2);
	const dir = path.join(runsDir, row.id);
	const lines = (name: string): TraceLine[] => (fs.existsSync(path.join(dir, `${name}.jsonl`)) ? fs.readFileSync(path.join(dir, `${name}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
	return { row, report, dir, lines, calls: row.workerCalls.filter((call) => call.endpoint !== "/healthz") };
}

const labels = (report: ReportJsonV2) => report.items.flatMap((item) => item.claims.map((claim) => claim.label));

describe("orchestrated run", () => {
	test("happy path: complete report with labelled claims; calls, claims and three trace files share the run and request ids", async () => {
		const researcher = await startResearcher(script([1001, 1005]));
		const verifier = await startVerifier();
		const { row, report, dir, lines, calls } = await run({ researcher: researcher.url, verifier: verifier.url });

		assert.equal(row.status, "complete", row.stopReason ?? "");
		assert.equal(row.kind, "orchestrated");
		assert.equal(row.phase, "done");
		assert.deepEqual(row.failedWorkers, []);
		assert.deepEqual(report.workers, { researcher: "complete", verifier: "complete" });
		assert.deepEqual(report.items.map((item) => [item.developmentId, item.section]), [["greenhouse:acme:1005", "new"], ["greenhouse:acme:1001", "new"]]);
		assert.ok(labels(report).includes("supported") && labels(report).includes("unsupported"));
		assert.ok(!labels(report).includes("unverified"));
		const supported = report.items.flatMap((item) => item.claims).filter((claim) => claim.label === "supported");
		assert.ok(supported.every((claim) => claim.evidence === "Acme is hiring."));

		// Persistence: one Claim row per claim, linked to its report item and to the verify request that labelled it.
		assert.equal(row.claims.length, report.items.reduce((sum, item) => sum + item.claims.length, 0));
		const verifyIds = new Set(calls.filter((call) => call.service === "verifier").map((call) => call.requestId));
		assert.ok(row.claims.every((claim) => claim.reportItemId && claim.verifyRequestId && verifyIds.has(claim.verifyRequestId)));
		assert.deepEqual(calls.map((call) => [call.service, call.endpoint, call.outcome, call.attempts]), [
			["researcher", "/research", "complete", 1],
			["verifier", "/verify", "complete", 1],
			["verifier", "/verify", "complete", 1],
		]);
		assert.equal(row.workerCalls.find((call) => call.endpoint === "/healthz")?.outcome, "complete", "the verifier was woken");

		// The ledger charged each request once, from the worker's reported usage, within the total.
		const ledger = row.ledger as { total: Record<string, number>; charged: Record<string, number>; entries: { requestId: string; basis: string }[] };
		assert.deepEqual(new Set(ledger.entries.map((entry) => entry.requestId)), new Set(calls.map((call) => call.requestId)));
		assert.ok(ledger.entries.every((entry) => entry.basis === "reported"));
		for (const dim of ["steps", "fetches", "tokens"]) assert.ok(ledger.charged[dim]! <= ledger.total[dim]!);
		assert.deepEqual(report.stats.budget.charged, ledger.charged);

		// Traces: the same run_id everywhere; each worker's `in` line carries the orchestrator's request_id.
		const orchestrator = lines("orchestrator");
		const researcherLines = lines("researcher");
		const verifierLines = lines("verifier");
		for (const set of [orchestrator, researcherLines, verifierLines]) assert.ok(set.length > 0 && set.every((line) => line.run_id === row.id));
		for (const call of calls) {
			assert.ok(orchestrator.some((line) => line.request_id === call.requestId && line.direction === "out" && line.status === 200));
			const worker = call.service === "researcher" ? researcherLines : verifierLines;
			assert.ok(worker.some((line) => line.request_id === call.requestId && line.direction === "in" && line.status === 200));
		}
		for (const field of ["ts", "service", "run_id", "request_id", "step", "direction", "endpoint_or_tool", "status", "latency_ms", "attempt", "tokens"]) {
			assert.ok(orchestrator.every((line) => field in line), `orchestrator lines have ${field}`);
		}
		assert.match(fs.readFileSync(path.join(dir, "report.md"), "utf8"), /SUPPORTED/);
		assert.ok(!fs.readFileSync(path.join(dir, "orchestrator.jsonl"), "utf8").includes(VERIFIER_TOKEN));
	});

	test("verifier down: claims are unverified, the run is partial, and failedWorkers names the verifier", async () => {
		const researcher = await startResearcher(script([1001, 1005]));
		const { row, report, calls } = await run({ researcher: researcher.url, verifier: CLOSED });
		assert.equal(row.status, "partial");
		assert.deepEqual(row.failedWorkers, ["verifier"]);
		assert.equal(report.workers.verifier, "failed");
		assert.ok(report.items.length === 2 && labels(report).every((label) => label === "unverified"));
		const verify = calls.filter((call) => call.service === "verifier");
		assert.ok(verify.every((call) => call.outcome === "unanswered" && call.attempts === 3));
		assert.ok(verify.every((call) => (call.attemptLog as { status: unknown }[]).every((attempt) => attempt.status === "network_error")));
		assert.match(row.stopReason!, /verifier failed for 2 of 2/);
		const ledger = row.ledger as { entries: { service: string; basis: string }[] };
		assert.ok(ledger.entries.filter((entry) => entry.service === "verifier").every((entry) => entry.basis === "full_share"), "an unanswered request is charged its full share");
	});

	test("researcher down: no new results, the previous top K is shown stale, and verification is skipped", async () => {
		const first = await run({ researcher: (await startResearcher(script([1001, 1005]))).url, verifier: (await startVerifier()).url });
		assert.equal(first.row.status, "complete");
		const verifier = await startVerifier();
		const { row, report, calls } = await run({ researcher: CLOSED, verifier: verifier.url });
		assert.equal(row.status, "partial");
		assert.equal(row.stale, true);
		assert.deepEqual(row.failedWorkers, ["researcher"]);
		assert.deepEqual(report.workers, { researcher: "failed", verifier: "skipped" });
		assert.deepEqual(report.items.map((item) => item.developmentId), first.report.items.map((item) => item.developmentId));
		assert.ok(report.items.every((item) => item.stale && item.fromRunId === first.row.id));
		assert.match(report.notes[0]!, /No new results this run \(researcher unavailable\)/);
		assert.deepEqual(calls.map((call) => [call.service, call.outcome]), [["researcher", "unanswered"]]);
		assert.equal(verifier.modelCalls.length, 0);
		assert.equal(row.claims.length, 0, "stale items' claims belong to the earlier run");
	});

	test("researcher down on the first run: nothing to show, so the run fails with a report that says why", async () => {
		const { row, report } = await run({ researcher: CLOSED, verifier: (await startVerifier()).url });
		assert.equal(row.status, "failed");
		assert.equal(report.items.length, 0);
		assert.match(row.stopReason!, /researcher unavailable/);
	});

	test("a verifier answer about a claim_id that was not sent is rejected whole: nothing from it reaches the report", async () => {
		const researcher = await startResearcher(script([1001, 1005]));
		const verifier = await startVerifier({
			handle: async (request) => ({ status: "complete", result: { verdicts: [{ claim_id: "zzz.9", verdict: "supported", evidence: "Acme is hiring." }, ...request.payload.claims.map((claim) => ({ claim_id: claim.claim_id, verdict: "supported" as const, evidence: "Acme is hiring." }))] } }),
		});
		const { row, report, calls } = await run({ researcher: researcher.url, verifier: verifier.url });
		assert.equal(row.status, "partial");
		assert.deepEqual(row.failedWorkers, ["verifier"]);
		assert.ok(labels(report).every((label) => label === "unverified"));
		assert.ok(calls.filter((call) => call.service === "verifier").every((call) => call.outcome === "malformed" && /zzz\.9/.test(call.errorMessage ?? "")));
	});

	test("a verifier slower than the client timeout: the retry gets 503 + Retry-After, then the stored answer; one charge, one model call", async () => {
		await importConfig({ ...ORCHESTRATION, time_budget_ms: { researcher: 20_000, verifier_per_chunk: 1_500 }, timeouts: { ...ORCHESTRATION.timeouts, grace_ms: 0 } });
		let slowed = 0;
		const researcher = await startResearcher(script([1005]));
		const verifier = await startVerifier({
			handle: async (request, ctx, real) => {
				const outcome = await real(request as Parameters<typeof real>[0], ctx);
				if (slowed++ === 0) await new Promise((resolve) => setTimeout(resolve, 1_900)); // answer after the client gave up
				return outcome;
			},
		});
		const { row, report, calls, lines } = await run({ researcher: researcher.url, verifier: verifier.url });
		const [verify] = calls.filter((call) => call.service === "verifier");
		assert.deepEqual((verify!.attemptLog as { status: unknown }[]).map((attempt) => attempt.status), ["timeout", 503, 200]);
		assert.equal(verify!.outcome, "complete");
		assert.ok(!labels(report).includes("unverified"));
		assert.equal(row.status, "complete", row.stopReason ?? "");
		assert.equal(verifier.modelCalls.length, 1, "the worker did the work once");
		const ledger = row.ledger as { entries: { requestId: string; basis: string; charged: { steps: number } }[] };
		const entries = ledger.entries.filter((entry) => entry.requestId === verify!.requestId);
		assert.equal(entries.length, 1);
		assert.deepEqual([entries[0]!.basis, entries[0]!.charged.steps], ["reported", 1]);
		const received = lines("verifier").filter((line) => line.request_id === verify!.requestId && line.direction === "in");
		assert.deepEqual(received.map((line) => [line.attempt, line.idempotency]).sort(), [[1, "new"], [2, "in_flight"], [3, "replay"]]);
		assert.equal(lines("verifier").filter((line) => line.request_id === verify!.requestId && line.endpoint_or_tool.startsWith("groq")).length, 1);
	});

	test("verifier restarted between attempts: the new instance recomputes (its store is gone), and the orchestrator still charges once", async () => {
		const modelCalls: string[][] = [];
		const before = makeVerifier({ modelCalls });
		const restarted = makeVerifier({ modelCalls });
		let crashed = false;
		// One port, two processes: the first POST is worked on by the old instance, which dies before answering.
		const front = express();
		front.use((req, res) => {
			if (req.method === "POST" && !crashed) {
				crashed = true;
				res.end = (() => {
					req.socket.destroy();
					return res;
				}) as typeof res.end;
				before.app(req, res);
				return;
			}
			restarted.app(req, res);
		});
		const { url } = await listen(front);
		const researcher = await startResearcher(script([1005]));
		const { row, report, calls } = await run({ researcher: researcher.url, verifier: url });
		const [verify] = calls.filter((call) => call.service === "verifier");
		assert.deepEqual((verify!.attemptLog as { status: unknown }[]).map((attempt) => attempt.status), ["network_error", 200]);
		assert.equal(modelCalls.length, 2, "real spend doubled: both instances called the model");
		const ledger = row.ledger as { entries: { requestId: string; basis: string }[] };
		assert.equal(ledger.entries.filter((entry) => entry.requestId === verify!.requestId).length, 1, "charged once");
		assert.equal(row.status, "complete");
		assert.ok(!labels(report).includes("unverified"));
	});

	test("a tiny researcher time budget returns partial with what it found so far", async () => {
		await importConfig({ ...ORCHESTRATION, time_budget_ms: { researcher: 1_000, verifier_per_chunk: 5_000 } });
		// Each model call takes 350 ms, so the 1 s budget ends after the first posting is fetched.
		const { row, report, calls } = await run({ researcher: (await startResearcher(script([1001, 1005]), { modelDelayMs: 350 })).url, verifier: (await startVerifier()).url });
		assert.ok(report.items.length >= 1, "what it found before the deadline is reported");
		assert.equal(calls[0]!.outcome, "partial");
		assert.equal(calls[0]!.errorCode, "time_budget_exhausted");
		assert.equal(report.workers.researcher, "partial");
		assert.equal(row.status, "partial");
		assert.match(row.stopReason!, /researcher stopped early \(time_budget_exhausted\)/);
		assert.deepEqual(row.failedWorkers, [], "the researcher answered: it did not fail");
	});

	test("a time budget under 1 s is not sent at all", async () => {
		await importConfig({ ...ORCHESTRATION, time_budget_ms: { researcher: 1, verifier_per_chunk: 5_000 } });
		const { row, calls } = await run({ researcher: (await startResearcher(script([1001]))).url, verifier: (await startVerifier()).url });
		assert.deepEqual(calls.map((call) => [call.service, call.outcome, call.errorCode]), [["researcher", "refused_budget", "time_budget_exhausted"]]);
		assert.equal(row.status, "failed");
	});

	test("the verifier's share comes from what is left; a chunk that cannot be covered is not sent and its claims stay unverified", async () => {
		await importConfig({ ...ORCHESTRATION, total_budget: { max_steps: 5, max_fetches: 10, max_tokens: 200_000 }, split: { researcher: 0.8 } });
		const verifier = await startVerifier();
		const { row, report, calls } = await run({ researcher: (await startResearcher(script([1001, 1005]))).url, verifier: verifier.url });
		assert.deepEqual(calls.map((call) => [call.service, call.outcome]), [["researcher", "complete"], ["verifier", "complete"], ["verifier", "refused_budget"]]);
		assert.equal(verifier.modelCalls.length, 1);
		assert.equal(row.status, "partial");
		assert.match(row.stopReason!, /budget_exhausted: 1 of 2 verify requests not sent/);
		assert.deepEqual(row.failedWorkers, [], "a request we chose not to send is not a worker failure");
		assert.deepEqual(report.items[1]!.claims.map((claim) => claim.label).filter((label) => label !== "unverified"), []);
		const ledger = row.ledger as { total: { steps: number }; charged: { steps: number } };
		assert.ok(ledger.charged.steps <= ledger.total.steps);
	});

	test("cancel from the dashboard (cancelRequested) aborts the request in flight and writes a partial report", async () => {
		const researcher = await startResearcher(script([1001]), { delayMs: 3_000 });
		const started = await trackerService.startRun(profileId, "cancel-key-0001");
		// Prisma queries run only when awaited (a bare `void` would never send it).
		setTimeout(async () => {
			await prisma.run.update({ where: { id: started.runId }, data: { cancelRequested: true } });
		}, 300);
		const begin = Date.now();
		await runOrchestration({ researcher: { url: researcher.url, token: RESEARCHER_TOKEN }, verifier: { url: (await startVerifier()).url, token: VERIFIER_TOKEN }, runsDir, heartbeatMs: 100, traceTimeoutMs: 2_000 }, started.runId);
		assert.ok(Date.now() - begin < 2_900, "did not wait for the researcher");
		const row = await prisma.run.findUniqueOrThrow({ where: { id: started.runId }, include: { workerCalls: true } });
		assert.equal(row.status, "partial");
		assert.match(row.stopReason!, /cancelled from the dashboard/);
		assert.deepEqual(row.failedWorkers, []);
		assert.equal(row.workerCalls.find((call) => call.endpoint === "/research")?.outcome, "unanswered");
	});

	test("a second run is compared with the first: still, new, and dropped", async () => {
		const first = await run({ researcher: (await startResearcher(script([1001, 1005]))).url, verifier: (await startVerifier()).url });
		assert.equal(first.row.status, "complete");
		const second = await run({ researcher: (await startResearcher(script([1005, 1003]))).url, verifier: (await startVerifier()).url });
		assert.equal(second.report.comparison.baselineRunId, first.row.id);
		const sections = Object.fromEntries(second.report.items.map((item) => [item.developmentId, item.section]));
		assert.equal(sections["greenhouse:acme:1005"], "still");
		assert.deepEqual(sections, { "greenhouse:acme:1005": "still", "greenhouse:acme:1003": "new" });
		assert.deepEqual(second.report.dropped.map((item) => item.developmentId), ["greenhouse:acme:1001"]);
		const third = await run({ researcher: (await startResearcher(script([1001, 1005]))).url, verifier: (await startVerifier()).url });
		const back = third.report.items.find((item) => item.developmentId === "greenhouse:acme:1001");
		assert.equal(back?.section, "returned");
		const listed = await trackerService.listRuns(profileId, undefined, 10);
		assert.ok(listed.runs.every((entry) => entry.kind === "orchestrated" && entry.hasReport));
	});
});
