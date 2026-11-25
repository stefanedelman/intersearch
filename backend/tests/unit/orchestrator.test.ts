import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { checkResearchResult, checkVerdicts, researchResponseSchema, verifyResponseSchema, type Development, type ResearchResult, type VerifyResult } from "../../src/shared/contract";
import { ORCHESTRATION_DEFAULTS, parseConfig } from "../../src/shared/config";
import { TraceLog } from "../../src/shared/trace-log";
import type { ReportJsonV1 } from "../../src/contracts/report";
import { Ledger, LedgerError, researcherShare, verifierShare } from "../../src/orchestrator/ledger";
import { baselineFrom, buildReport, renderMarkdown, type ReportInput } from "../../src/orchestrator/report";
import { interpretCall } from "../../src/orchestrator/interpret";
import { backoffMs, createWorkerClient, parseRetryAfter, type CallResult } from "../../src/orchestrator/worker-client";
import { ACME_CONFIG_YAML } from "../fixtures/acme";

const RUN = "6f1c2a4e-8b7d-4c3e-9a1f-2b3c4d5e6f70";

describe("ledger", () => {
	const total = { steps: 10, fetches: 10, tokens: 10_000 };

	test("a request is charged once: a second charge (a retry or a replay) changes nothing", () => {
		const ledger = new Ledger(total);
		ledger.reserve("a", "verifier", { steps: 2, fetches: 2, tokens: 1000 });
		ledger.charge("a", { steps: 1, fetches: 1, tokens: 500 });
		ledger.charge("a", { steps: 2, fetches: 2, tokens: 1000 });
		assert.deepEqual(ledger.charged, { steps: 1, fetches: 1, tokens: 500 });
		assert.equal(ledger.get("a")!.basis, "reported");
	});

	test("a request with no usable answer is charged its full share", () => {
		const ledger = new Ledger(total);
		ledger.reserve("a", "researcher", { steps: 7, fetches: 7, tokens: 7000 });
		ledger.charge("a", null);
		assert.deepEqual(ledger.charged, { steps: 7, fetches: 7, tokens: 7000 });
		assert.equal(ledger.get("a")!.basis, "full_share");
	});

	test("a refused request (400/401) is charged nothing", () => {
		const ledger = new Ledger(total);
		ledger.reserve("a", "verifier", { steps: 2, fetches: 2, tokens: 1000 });
		ledger.charge("a", null, "none");
		assert.deepEqual(ledger.charged, { steps: 0, fetches: 0, tokens: 0 });
	});

	test("reporting more than the share is charged as reported and flagged as an overrun", () => {
		const ledger = new Ledger(total);
		ledger.reserve("a", "verifier", { steps: 1, fetches: 1, tokens: 1000 });
		const entry = ledger.charge("a", { steps: 3, fetches: 1, tokens: 1000 });
		assert.equal(entry.overrun, true);
		assert.deepEqual(ledger.charged, { steps: 3, fetches: 1, tokens: 1000 });
	});

	test("negative or fractional usage is clamped and floored", () => {
		const ledger = new Ledger(total);
		ledger.reserve("a", "verifier", { steps: 1, fetches: 1, tokens: 1000 });
		ledger.charge("a", { steps: -4, fetches: 0.7, tokens: 12.9 });
		assert.deepEqual(ledger.charged, { steps: 0, fetches: 0, tokens: 12 });
	});

	test("a share that does not fit what is left is refused; ids cannot be reused", () => {
		const ledger = new Ledger(total);
		ledger.reserve("a", "researcher", { steps: 7, fetches: 7, tokens: 7000 });
		assert.equal(ledger.canCover({ steps: 4, fetches: 1, tokens: 1 }), false, "the outstanding reservation counts");
		assert.throws(() => ledger.reserve("b", "verifier", { steps: 4, fetches: 1, tokens: 1 }), LedgerError);
		assert.throws(() => ledger.reserve("a", "verifier", { steps: 1, fetches: 1, tokens: 1 }), LedgerError);
		ledger.charge("a", { steps: 3, fetches: 3, tokens: 3000 });
		assert.deepEqual(ledger.remaining, { steps: 7, fetches: 7, tokens: 7000 }, "the unused part of the researcher's share goes back");
	});

	test("the researcher gets split × total; verifier chunks share the remainder, never less than the minimum", () => {
		assert.deepEqual(researcherShare(ORCHESTRATION_DEFAULTS), { steps: 16, fetches: 16, tokens: 133_000 });
		const min = { steps: 1, fetches: 1, tokens: 2000 };
		assert.deepEqual(verifierShare({ steps: 10, fetches: 9, tokens: 60_000 }, 4, min), { steps: 2, fetches: 2, tokens: 15_000 });
		assert.deepEqual(verifierShare({ steps: 2, fetches: 2, tokens: 3000 }, 5, min), { steps: 1, fetches: 1, tokens: 2000 }, "the higher-ranked chunk gets the minimum first");
		assert.equal(verifierShare({ steps: 0, fetches: 5, tokens: 50_000 }, 1, min), null);
		assert.equal(verifierShare({ steps: 5, fetches: 5, tokens: 1999 }, 1, min), null);
	});
});

describe("config", () => {
	test("configs without an orchestration block (1B snapshots) get the defaults", () => {
		assert.deepEqual(parseConfig(ACME_CONFIG_YAML).orchestration, ORCHESTRATION_DEFAULTS);
	});

	test("the orchestration block is strict", () => {
		assert.throws(() => parseConfig(`${ACME_CONFIG_YAML}\norchestration:\n  total_budget: { max_steps: 1, max_fetches: 1, max_tokens: 1 }\n`), /orchestration/);
	});
});

describe("worker client", () => {
	type Reply = { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number };
	let server: http.Server;
	let url: string;
	let replies: Reply[] = [];
	const received: { body: string; attempt: string | undefined; auth: string | undefined }[] = [];

	before(async () => {
		server = http.createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				received.push({ body, attempt: req.headers["x-attempt"] as string | undefined, auth: req.headers.authorization });
				const reply = replies.shift() ?? { status: 200, body: { ok: true } };
				setTimeout(() => {
					if (res.destroyed) return;
					res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
					res.end(JSON.stringify(reply.body ?? { error: { code: "x", message: "m", retryable: false } }));
				}, reply.delayMs ?? 0);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	after(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections(); // the client keeps connections alive
			}),
	);

	function client(overrides: Partial<Parameters<typeof createWorkerClient>[0]["retries"]> = {}) {
		const waits: number[] = [];
		const c = createWorkerClient({
			service: "verifier",
			baseUrl: url,
			token: "t".repeat(32),
			retries: { max_attempts: 3, base_ms: 100, max_backoff_ms: 1000, max_retry_after_ms: 60_000, ...overrides },
			random: () => 0.5,
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		const log = new TraceLog("orchestrator");
		const post = (extra: Partial<Parameters<typeof c.post>[0]> = {}) =>
			c.post({ path: "/verify", body: '{"same":"bytes"}', runId: RUN, requestId: randomUUID(), step: 1, log, attemptTimeoutMs: 2000, deadlineAt: Date.now() + 60_000, signal: new AbortController().signal, ...extra });
		return { post, waits, log };
	}

	const reset = (next: Reply[]) => {
		replies = next;
		received.length = 0;
	};

	test("503 is retried after Retry-After, with the same bytes, the token, and X-Attempt 1..n", async () => {
		reset([{ status: 503, headers: { "retry-after": "7" } }, { status: 503, headers: { "retry-after": "2" } }, { status: 200, body: { done: true } }]);
		const { post, waits, log } = client();
		const result = await post();
		assert.equal(result.response?.status, 200);
		assert.equal(result.gaveUp, null);
		assert.deepEqual(waits, [7000, 2000]);
		assert.deepEqual(received.map((entry) => entry.body), ['{"same":"bytes"}', '{"same":"bytes"}', '{"same":"bytes"}']);
		assert.deepEqual(received.map((entry) => entry.attempt), ["1", "2", "3"]);
		assert.ok(received.every((entry) => entry.auth === `Bearer ${"t".repeat(32)}`));
		const lines = log.lines({ runId: RUN });
		assert.deepEqual(lines.map((line) => [line.attempt, line.status]), [[1, 503], [2, 503], [3, 200]]);
		assert.ok(lines.every((line) => line.direction === "out" && line.endpoint_or_tool === "POST verifier /verify" && typeof line.latency_ms === "number"));
		assert.ok(!JSON.stringify(lines).includes("t".repeat(32)), "the token is never traced");
	});

	test("502/504 and connection errors back off exponentially with jitter", async () => {
		reset([{ status: 502 }, { status: 504 }, { status: 200 }]);
		const { post, waits } = client();
		const result = await post();
		assert.equal(result.response?.status, 200);
		assert.deepEqual(waits, [100, 200]);
		const refused = createWorkerClient({ service: "verifier", baseUrl: "http://127.0.0.1:1", token: "x", retries: { max_attempts: 2, base_ms: 1, max_backoff_ms: 1, max_retry_after_ms: 1000 }, sleep: async () => undefined });
		const down = await refused.post({ path: "/verify", body: "{}", runId: RUN, requestId: randomUUID(), step: 1, log: new TraceLog("orchestrator"), attemptTimeoutMs: 1000, deadlineAt: Date.now() + 10_000, signal: new AbortController().signal });
		assert.equal(down.response, null);
		assert.deepEqual(down.attempts.map((attempt) => attempt.status), ["network_error", "network_error"]);
		assert.equal(down.gaveUp?.reason, "attempts_exhausted");
	});

	for (const status of [400, 401, 409, 500]) {
		test(`HTTP ${status} is terminal: no retry`, async () => {
			reset([{ status }, { status: 200 }]);
			const { post, waits } = client();
			const result = await post();
			assert.equal(result.attempts.length, 1);
			assert.equal(result.response?.status, status);
			assert.equal(result.gaveUp, null);
			assert.deepEqual(waits, []);
		});
	}

	test("our own timeout is retried; the attempt timeout is what the caller set", async () => {
		reset([{ status: 200, delayMs: 400 }, { status: 200, body: { second: true } }]);
		const { post } = client();
		const started = Date.now();
		const result = await post({ attemptTimeoutMs: 150 });
		assert.deepEqual(result.attempts.map((attempt) => attempt.status), ["timeout", 200]);
		assert.ok(result.attempts[0]!.latencyMs >= 140 && result.attempts[0]!.latencyMs < 380);
		assert.deepEqual(result.response?.json, { second: true });
		assert.ok(Date.now() - started < 2000);
	});

	test("no retry that could not finish before the run deadline", async () => {
		reset([{ status: 503, headers: { "retry-after": "5" } }]);
		const { post } = client();
		const result = await post({ attemptTimeoutMs: 1000, deadlineAt: Date.now() + 5500 });
		assert.equal(result.attempts.length, 1);
		assert.equal(result.gaveUp?.reason, "deadline");
	});

	test("a Retry-After above the limit ends the request instead of retrying early", async () => {
		reset([{ status: 503, headers: { "retry-after": "120" } }]);
		const { post } = client();
		const result = await post();
		assert.equal(result.gaveUp?.reason, "retry_after_too_long");
	});

	test("cancelling aborts the request in flight", async () => {
		reset([{ status: 200, delayMs: 1000 }]);
		const { post } = client();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		const result = await post({ signal: controller.signal });
		assert.equal(result.gaveUp?.reason, "cancelled");
		assert.deepEqual(result.attempts.map((attempt) => attempt.status), ["aborted"]);
	});

	test("Retry-After accepts seconds and HTTP-dates; backoff stays within ±20 %", () => {
		const now = Date.parse("2026-11-25T12:00:00Z");
		assert.equal(parseRetryAfter("3", now), 3000);
		assert.equal(parseRetryAfter("Wed, 25 Nov 2026 12:00:10 GMT", now), 10_000);
		assert.equal(parseRetryAfter("Wed, 25 Nov 2026 11:00:00 GMT", now), 0);
		assert.equal(parseRetryAfter("soon", now), null);
		assert.equal(parseRetryAfter(undefined, now), null);
		const policy = { base_ms: 1000, max_backoff_ms: 20_000 };
		for (let attempt = 1; attempt <= 6; attempt += 1) {
			const raw = Math.min(20_000, 1000 * 2 ** (attempt - 1));
			for (const r of [0, 0.5, 0.999]) {
				const value = backoffMs(attempt, policy, () => r);
				assert.ok(value >= raw * 0.8 - 1 && value <= raw * 1.2 + 1, `${attempt}/${r}: ${value}`);
			}
		}
	});
});

describe("response validation", () => {
	const ids = { requestId: randomUUID(), runId: RUN };
	const usage = { steps: 1, fetches: 1, tokens: 900, elapsed_ms: 1200 };
	const answer = (status: number, json: unknown): CallResult => ({ attempts: [], latencyMs: 5, response: { status, body: JSON.stringify(json), json }, gaveUp: null });
	const verify = (json: unknown, status = 200, sent = ["1.1", "1.2"]) => interpretCall<VerifyResult>(answer(status, json), verifyResponseSchema, ids, (result) => checkVerdicts(result, sent));
	const envelope = (result: unknown, extra: Record<string, unknown> = {}) => ({ request_id: ids.requestId, run_id: RUN, service: "verifier", status: "complete", result, error: null, usage, ...extra });

	test("a valid answer is used; missing verdicts are allowed (they stay unverified)", () => {
		const out = verify(envelope({ verdicts: [{ claim_id: "1.1", verdict: "supported", evidence: "on the page" }] }));
		assert.equal(out.outcome, "complete");
		assert.equal(out.result!.verdicts.length, 1);
		assert.equal(out.basis, "reported");
	});

	test("a verdict for a claim_id that was not sent rejects the whole answer", () => {
		const out = verify(envelope({ verdicts: [{ claim_id: "1.1", verdict: "unsupported", evidence: null }, { claim_id: "9.9", verdict: "supported", evidence: "x" }] }));
		assert.equal(out.outcome, "malformed");
		assert.equal(out.result, null);
		assert.match(out.errorMessage!, /9\.9/);
	});

	test("duplicate verdicts, supported without evidence, and evidence over 300 characters are malformed", () => {
		assert.equal(verify(envelope({ verdicts: [{ claim_id: "1.1", verdict: "unsupported", evidence: null }, { claim_id: "1.1", verdict: "unsupported", evidence: null }] })).outcome, "malformed");
		assert.equal(verify(envelope({ verdicts: [{ claim_id: "1.1", verdict: "supported", evidence: null }] })).outcome, "malformed");
		assert.equal(verify(envelope({ verdicts: [{ claim_id: "1.1", verdict: "supported", evidence: "x".repeat(301) }] })).outcome, "malformed");
	});

	test("an answer naming another request_id, or HTTP 200 carrying status failed, is malformed", () => {
		assert.equal(verify(envelope({ verdicts: [] }, { request_id: randomUUID() })).outcome, "malformed");
		const failed = verify(envelope(null, { status: "failed", error: { code: "internal", message: "x", retryable: false } }));
		assert.equal(failed.outcome, "malformed");
		assert.equal(failed.basis, "reported", "the usage in a well-formed envelope is still charged");
	});

	test("HTTP 500 with a failed envelope is a failed call charged as reported", () => {
		const out = verify(envelope(null, { status: "failed", error: { code: "model_auth_failed", message: "bad key", retryable: false } }), 500);
		assert.equal(out.outcome, "failed");
		assert.equal(out.errorCode, "model_auth_failed");
	});

	test("more than k developments, or duplicate claim ids, reject the research answer", () => {
		const dev = (id: string, claimId: string): Development => ({ id, title: "Acme — Intern", summary: "", claims: [{ claim_id: claimId, text: "a claim", source_url: "https://example.org/" }] });
		const research = (developments: Development[], k: number) =>
			interpretCall<ResearchResult>(answer(200, { ...envelope({ developments }), service: "researcher" }), researchResponseSchema, ids, (result) => checkResearchResult(result, k));
		assert.equal(research([dev("a", "1.1"), dev("b", "2.1")], 2).outcome, "complete");
		assert.equal(research([dev("a", "1.1"), dev("b", "2.1")], 1).outcome, "malformed");
		assert.equal(research([dev("a", "1.1"), dev("b", "1.1")], 2).outcome, "malformed");
		const javascript = { ...dev("a", "1.1"), claims: [{ claim_id: "1.1", text: "x", source_url: "javascript:alert(1)" }] };
		assert.equal(research([javascript], 2).outcome, "malformed");
	});

	test("400/401 are refused at no charge; 409 and an unanswered request are charged in full", () => {
		assert.deepEqual([verify({ error: { code: "unauthorized", message: "no", retryable: false } }, 401).outcome, verify({}, 401).basis], ["rejected", "none"]);
		assert.equal(verify({}, 400).basis, "none");
		assert.equal(verify({}, 409).basis, "full_share");
		const none = interpretCall<VerifyResult>({ attempts: [], latencyMs: 1, response: null, gaveUp: { reason: "attempts_exhausted", message: "timeout" } }, verifyResponseSchema, ids, () => ({ ok: true }));
		assert.deepEqual([none.outcome, none.basis], ["unanswered", "full_share"]);
	});
});

describe("report", () => {
	const dev = (id: string, claims: string[] = ["c"]): Development => ({ id, title: `Acme — ${id}`, summary: `About ${id}`, claims: claims.map((claimId) => ({ claim_id: claimId, text: `claim ${claimId}`, source_url: `https://example.org/${id}` })) });
	const base = (overrides: Partial<ReportInput>): ReportInput => ({
		runId: RUN,
		status: "complete",
		stopReason: null,
		topic: "t",
		k: 3,
		developments: [],
		verdicts: new Map(),
		baseline: null,
		everReported: new Set(),
		workers: { researcher: "complete", verifier: "complete" },
		failedWorkers: [],
		notes: [],
		stats: { workerCalls: 2, elapsedMs: 1000, budget: { total: { steps: 1, fetches: 1, tokens: 1 }, charged: { steps: 1, fetches: 1, tokens: 1 } } },
		now: new Date("2026-11-25T00:00:00Z"),
		...overrides,
	});
	const previous = { runId: randomUUID(), items: [{ developmentId: "a", rank: 1, title: "Acme — a", summary: "", claims: [] }, { developmentId: "gone", rank: 2, title: "Acme — gone", summary: "", claims: [] }] };

	test("new, still, returned and dropped against the previous top K; labels default to unverified", () => {
		const report = buildReport(
			base({
				developments: [dev("a", ["1.1", "1.2"]), dev("back", ["2.1"]), dev("fresh", ["3.1"])],
				verdicts: new Map([
					["1.1", { label: "supported", evidence: "quote" }],
					["2.1", { label: "unreachable", evidence: null }],
				]),
				baseline: previous,
				everReported: new Set(["back", "a", "gone"]),
			}),
		);
		assert.deepEqual(report.items.map((item) => [item.developmentId, item.section]), [["a", "still"], ["back", "returned"], ["fresh", "new"]]);
		assert.deepEqual(report.dropped.map((item) => [item.developmentId, item.previousRank]), [["gone", 2]]);
		assert.deepEqual(report.items[0]!.claims.map((claim) => [claim.label, claim.evidence]), [["supported", "quote"], ["unverified", null]]);
		assert.deepEqual(report.stats.claims, { supported: 1, unsupported: 0, unreachable: 1, unverified: 2 });
		assert.equal(report.comparison.baselineRunId, previous.runId);
	});

	test("with no developments (researcher down) the previous top K is shown, marked stale, and nothing is dropped", () => {
		const report = buildReport(base({ developments: null, baseline: previous, workers: { researcher: "failed", verifier: "skipped" }, failedWorkers: ["researcher"] }));
		assert.equal(report.stale, true);
		assert.ok(report.items.every((item) => item.stale && item.fromRunId === previous.runId));
		assert.deepEqual(report.dropped, []);
		assert.match(report.notes[0]!, /No new results this run \(researcher unavailable\)/);
		assert.deepEqual(report.stats.claims, { supported: 0, unsupported: 0, unreachable: 0, unverified: 0 });
	});

	test("a 1B v1 report becomes a baseline without claims", () => {
		const v1 = { schemaVersion: 1, items: [{ rank: 1, identityKey: "greenhouse:acme:1", company: "Acme", title: "Intern", summary: "s" }] } as unknown as ReportJsonV1;
		assert.deepEqual(baselineFrom(RUN, v1).items, [{ developmentId: "greenhouse:acme:1", rank: 1, title: "Acme — Intern", summary: "s", claims: [] }]);
	});

	test("markdown escapes worker-written text", () => {
		const evil = { ...dev("x"), title: "Acme — <img src=x onerror=alert(1)> [click](javascript:alert(2))" };
		const markdown = renderMarkdown(buildReport(base({ developments: [evil] })), { trackerName: "Intersearch", configHash: "abc" });
		assert.doesNotMatch(markdown, /(?<!\\)<img/, "no unescaped HTML");
		assert.doesNotMatch(markdown, /(?<!\\)\]\(javascript/, "no live link");
		assert.match(markdown, /\\<img/);
	});
});
