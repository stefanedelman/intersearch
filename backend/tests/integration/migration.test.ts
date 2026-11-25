import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { reportJsonSchema, reportJsonV2Schema } from "../../src/contracts/report";

const migrationsDir = path.join(__dirname, "../../prisma/migrations");
const migrations = fs.readdirSync(migrationsDir).filter((name) => /^\d+_/.test(name)).sort();
const ORCHESTRATION = "20261124000000_orchestration";
const sql = (name: string) => fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8");

const ids = {
	profile: "10000000-0000-4000-8000-000000000001",
	tracker: "10000000-0000-4000-8000-000000000002",
	run: "10000000-0000-4000-8000-000000000003",
	report: "10000000-0000-4000-8000-000000000004",
	run2: "10000000-0000-4000-8000-000000000005",
};

test("the orchestration migration is additive: a 1B run and its report survive unchanged, with defaults for the new columns", async () => {
	assert.ok(migrations.includes(ORCHESTRATION), "the migration exists");
	assert.equal(migrations.at(-1), ORCHESTRATION, "it is the latest migration");
	const text = sql(ORCHESTRATION);
	const statements = text.replace(/--.*$/gm, "");
	assert.doesNotMatch(statements, /^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b|DROP (COLUMN|CONSTRAINT|TABLE|TYPE)|ALTER COLUMN|RENAME/im, "nothing is dropped, deleted, or rewritten");

	const db = await PGlite.create();
	try {
		for (const name of migrations.filter((entry) => entry < ORCHESTRATION)) await db.exec(sql(name));

		// A 1B run as it exists in NYUgrader's history today.
		const v1Report = {
			schemaVersion: 1, runId: ids.run, status: "complete", stopReason: null, generatedAt: "2026-10-06T01:58:00.000Z", topic: "t", k: 5, season: "summer-2027",
			comparison: { baselineRunId: null, reset: false, note: null }, items: [], dropped: [], notes: [],
			stats: { fetched: 0, skipped: 7, rejected: 0, failed: 0, searches: 0, modelCalls: 14, inputTokens: 47233, outputTokens: 1115, searchCredits: 0, networkRequests: 19, elapsedMs: 355000 },
		};
		await db.exec(`
			INSERT INTO "Profile" (id, username, "normalizedUsername", "updatedAt") VALUES ('${ids.profile}', 'NYUgrader', 'nyugrader', now());
			INSERT INTO "Tracker" (id, "profileId", "updatedAt") VALUES ('${ids.tracker}', '${ids.profile}', now());
			INSERT INTO "Run" (id, "trackerId", "idempotencyKey", status, "configSnapshot", "configHash", "comparisonKey", "budgetTotals")
				VALUES ('${ids.run}', '${ids.tracker}', 'run-1-key', 'complete', '{}', 'h', 'c', '{"modelCalls":14}');
			INSERT INTO "Report" (id, "runId", status, "reportJson", markdown) VALUES ('${ids.report}', '${ids.run}', 'complete', '${JSON.stringify(v1Report)}', '# Run 1');
		`);
		const before = await db.query(`SELECT r.*, rep."reportJson", rep.markdown FROM "Run" r JOIN "Report" rep ON rep."runId" = r.id`);

		await db.exec(text);

		const after = await db.query<Record<string, unknown>>(`SELECT r.*, rep."reportJson", rep.markdown FROM "Run" r JOIN "Report" rep ON rep."runId" = r.id`);
		const row = after.rows[0]!;
		for (const [key, value] of Object.entries(before.rows[0] as Record<string, unknown>)) assert.deepEqual(row[key], value, `${key} is unchanged`);
		assert.equal(row.kind, "tracker");
		assert.equal(row.phase, null);
		assert.deepEqual(row.failedWorkers, []);
		assert.equal(row.stale, false);
		assert.equal(row.cancelRequested, false);
		assert.equal(row.ledger, null);
		assert.equal(reportJsonSchema.safeParse(row.reportJson).success, true, "the 1B report still validates");

		// New rows work, and deleting a run still cascades (tracker reset keeps working).
		await db.exec(`
			INSERT INTO "Run" (id, "trackerId", "idempotencyKey", status, "configSnapshot", "configHash", "comparisonKey", kind, phase, "failedWorkers")
				VALUES ('${ids.run2}', '${ids.tracker}', 'a2-key', 'partial', '{}', 'h', 'c', 'orchestrated', 'done', ARRAY['verifier']);
			INSERT INTO "WorkerCall" (id, "runId", "requestId", service, endpoint, share, outcome)
				VALUES ('20000000-0000-4000-8000-000000000001', '${ids.run2}', '20000000-0000-4000-8000-000000000002', 'verifier', '/verify', '{"time_budget_ms":45000}', 'unanswered');
			INSERT INTO "Claim" (id, "runId", "developmentId", "claimId", text, "sourceUrl", label)
				VALUES ('20000000-0000-4000-8000-000000000003', '${ids.run2}', 'greenhouse:acme:1', '1.1', 'The role is in New York.', 'https://example.org/job', 'unverified');
		`);
		await assert.rejects(db.exec(`INSERT INTO "Claim" (id, "runId", "developmentId", "claimId", text, "sourceUrl", label) VALUES ('20000000-0000-4000-8000-000000000004', '${ids.run2}', 'd', '1.1', 't', 'u', 'supported')`), /unique/i, "claim ids are unique per run");
		await assert.rejects(db.exec(`INSERT INTO "Claim" (id, "runId", "developmentId", "claimId", text, "sourceUrl", label) VALUES ('20000000-0000-4000-8000-000000000005', '${ids.run2}', 'd', '1.2', 't', 'u', 'maybe')`), /enum|invalid input/i);
		await db.exec(`DELETE FROM "Run" WHERE id = '${ids.run2}'`);
		assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "WorkerCall"`)).rows[0]!.n, 0);
		assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "Claim"`)).rows[0]!.n, 0);

		const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('WorkerCall', 'Claim')`);
		assert.deepEqual(rls.rows.map((entry) => [entry.relname, entry.relrowsecurity]).sort(), [["Claim", true], ["WorkerCall", true]]);
	} finally {
		await db.close();
	}
});

test("a v2 report validates, and the discriminated union tells the versions apart", () => {
	const v2 = {
		schemaVersion: 2, runId: ids.run2, status: "partial", stopReason: "verifier did not answer", generatedAt: new Date().toISOString(), topic: "t", k: 5,
		stale: false, failedWorkers: ["verifier"], workers: { researcher: "complete", verifier: "failed" },
		comparison: { baselineRunId: ids.run, note: null },
		items: [{ rank: 1, section: "new", developmentId: "greenhouse:acme:1", title: "Acme — Intern", summary: "s", stale: false, fromRunId: null, claims: [{ claimId: "1.1", text: "c", sourceUrl: "https://example.org/job", label: "unverified", evidence: null }] }],
		dropped: [], notes: [],
		stats: { claims: { supported: 0, unsupported: 0, unreachable: 0, unverified: 1 }, workerCalls: 3, elapsedMs: 1000, budget: { total: { steps: 24, fetches: 24, tokens: 190000 }, charged: { steps: 10, fetches: 9, tokens: 50000 } } },
	};
	assert.equal(reportJsonV2Schema.safeParse(v2).success, true);
	const parsed = reportJsonSchema.parse(v2);
	assert.equal(parsed.schemaVersion, 2);
	assert.equal(reportJsonSchema.safeParse({ ...v2, schemaVersion: 3 }).success, false);
});
