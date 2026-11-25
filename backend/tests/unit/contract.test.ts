import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	bodyHash,
	canonicalJson,
	checkResearchResult,
	checkVerdicts,
	rejectionBodySchema,
	researchRequestSchema,
	researchResponseSchema,
	verifyRequestSchema,
	verifyResponseSchema,
	type ResearchResult,
	type VerifyResult,
} from "../../src/shared/contract";

const RUN = "6f1c2a4e-8b7d-4c3e-9a1f-2b3c4d5e6f70";
const REQ = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const budget = { max_steps: 10, max_fetches: 8, max_tokens: 40000 };
const research = { request_id: REQ, run_id: RUN, time_budget_ms: 60000, budget, payload: { topic: "Summer 2027 backend internships", k: 5 } };
const verify = {
	request_id: REQ,
	run_id: RUN,
	time_budget_ms: 60000,
	budget,
	payload: {
		claims: [
			{ claim_id: "0-1", text: "The internship is in New York.", source_url: "https://boards-api.greenhouse.io/v1/boards/stripe/jobs/1" },
			{ claim_id: "0-2", text: "Pay is $55 per hour.", source_url: "https://boards-api.greenhouse.io/v1/boards/stripe/jobs/1" },
		],
	},
};
const usage = { steps: 2, fetches: 1, tokens: 3100, elapsed_ms: 4200 };

const issuesOf = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
	(result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ");

describe("request envelope", () => {
	test("accepts the spec's example shapes", () => {
		assert.equal(researchRequestSchema.safeParse(research).success, true);
		assert.equal(verifyRequestSchema.safeParse(verify).success, true);
	});

	for (const [name, mutate] of [
		["missing request_id", (body: Record<string, unknown>) => delete body.request_id],
		["non-uuid run_id", (body: Record<string, unknown>) => (body.run_id = "run-1")],
		["zero time budget", (body: Record<string, unknown>) => (body.time_budget_ms = 0)],
		["fractional time budget", (body: Record<string, unknown>) => (body.time_budget_ms = 1.5)],
		["time budget over the cap", (body: Record<string, unknown>) => (body.time_budget_ms = 900_001)],
		["negative step budget", (body: Record<string, unknown>) => (body.budget = { ...budget, max_steps: -1 })],
		["budget missing max_tokens", (body: Record<string, unknown>) => (body.budget = { max_steps: 1, max_fetches: 1 })],
		["unknown top-level key", (body: Record<string, unknown>) => (body.priority = "high")],
		["unknown budget key", (body: Record<string, unknown>) => (body.budget = { ...budget, max_dollars: 1 })],
		["payload missing", (body: Record<string, unknown>) => delete body.payload],
	] as const) {
		test(`rejects: ${name}`, () => {
			const body = structuredClone(research) as Record<string, unknown>;
			mutate(body);
			assert.equal(researchRequestSchema.safeParse(body).success, false);
		});
	}

	test("research payload: topic and k bounds", () => {
		for (const payload of [{ topic: "", k: 5 }, { topic: "   ", k: 5 }, { topic: "x".repeat(301), k: 5 }, { topic: "t", k: 0 }, { topic: "t", k: 11 }, { topic: "t", k: 2.5 }, { topic: "t" }]) {
			assert.equal(researchRequestSchema.safeParse({ ...research, payload }).success, false, JSON.stringify(payload));
		}
	});

	test("verify payload: duplicate claim_ids, empty list, bad ids, long text are 400s", () => {
		const claim = verify.payload.claims[0]!;
		for (const claims of [
			[],
			[claim, claim],
			[{ ...claim, claim_id: "has space" }],
			[{ ...claim, claim_id: "" }],
			[{ ...claim, text: "x".repeat(501) }],
			[{ ...claim, extra: true }],
			Array.from({ length: 41 }, (_, i) => ({ ...claim, claim_id: `c${i}` })),
		]) {
			assert.equal(verifyRequestSchema.safeParse({ ...verify, payload: { claims } }).success, false);
		}
	});

	test("verify payload accepts internal and non-http URLs: the verifier marks them unreachable, not 400", () => {
		for (const source_url of ["http://169.254.169.254/", "http://localhost/", "ftp://example.com/x"]) {
			const body = { ...verify, payload: { claims: [{ claim_id: "x", text: "claim", source_url }] } };
			assert.equal(verifyRequestSchema.safeParse(body).success, true, source_url);
		}
	});
});

describe("response envelope", () => {
	const researchResult: ResearchResult = {
		developments: [
			{
				id: "greenhouse:stripe:1",
				title: "Software Engineer Intern",
				summary: "Backend internship in New York.",
				claims: [{ claim_id: "0-1", text: "The internship is in New York.", source_url: "https://stripe.com/jobs/1" }],
			},
		],
	};
	const base = { request_id: REQ, run_id: RUN, usage };

	test("complete, partial, and failed shapes", () => {
		assert.equal(researchResponseSchema.safeParse({ ...base, service: "researcher", status: "complete", result: researchResult, error: null }).success, true);
		const partial = { ...base, service: "researcher", status: "partial", result: researchResult, error: { code: "time_budget_exhausted", message: "stopped after 3 of 5 companies", retryable: false } };
		assert.equal(researchResponseSchema.safeParse(partial).success, true);
		const failed = { ...base, service: "researcher", status: "failed", result: null, error: { code: "model_auth_failed", message: "bad model key", retryable: false } };
		assert.equal(researchResponseSchema.safeParse(failed).success, true);
	});

	test("status, result, and error must agree", () => {
		const error = { code: "internal", message: "x", retryable: false };
		for (const body of [
			{ status: "complete", result: null, error: null },
			{ status: "complete", result: researchResult, error },
			{ status: "partial", result: null, error },
			{ status: "partial", result: researchResult, error: null },
			{ status: "failed", result: researchResult, error },
			{ status: "failed", result: null, error: null },
		]) {
			assert.equal(researchResponseSchema.safeParse({ ...base, service: "researcher", ...body }).success, false, JSON.stringify(body));
		}
	});

	test("a researcher response is not a valid verifier response", () => {
		const body = { ...base, service: "researcher", status: "complete", result: { verdicts: [] }, error: null };
		assert.equal(verifyResponseSchema.safeParse(body).success, false);
	});

	test("research claims must cite an http(s) URL", () => {
		const bad = structuredClone(researchResult);
		bad.developments[0]!.claims[0]!.source_url = "javascript:alert(1)";
		const result = researchResponseSchema.safeParse({ ...base, service: "researcher", status: "complete", result: bad, error: null });
		assert.equal(result.success, false);
		assert.match(issuesOf(result), /http\(s\) URL/);
	});

	test("evidence: string exactly when supported, at most 300 characters", () => {
		const wrap = (verdicts: unknown[]) => verifyResponseSchema.safeParse({ ...base, service: "verifier", status: "complete", result: { verdicts }, error: null });
		assert.equal(wrap([{ claim_id: "a", verdict: "supported", evidence: "New York, NY" }]).success, true);
		assert.equal(wrap([{ claim_id: "a", verdict: "unsupported", evidence: null }]).success, true);
		assert.equal(wrap([{ claim_id: "a", verdict: "unreachable", evidence: null }]).success, true);
		assert.equal(wrap([{ claim_id: "a", verdict: "supported", evidence: null }]).success, false);
		assert.equal(wrap([{ claim_id: "a", verdict: "unsupported", evidence: "New York" }]).success, false);
		assert.equal(wrap([{ claim_id: "a", verdict: "supported", evidence: "x".repeat(301) }]).success, false);
		assert.equal(wrap([{ claim_id: "a", verdict: "unverified", evidence: null }]).success, false, "unverified is the orchestrator's label, never a worker verdict");
	});

	test("usage is required and non-negative", () => {
		const body = { request_id: REQ, run_id: RUN, service: "verifier", status: "complete", result: { verdicts: [] }, error: null };
		assert.equal(verifyResponseSchema.safeParse(body).success, false);
		assert.equal(verifyResponseSchema.safeParse({ ...body, usage: { ...usage, tokens: -1 } }).success, false);
	});

	test("rejection bodies (400/401/409/503)", () => {
		assert.equal(rejectionBodySchema.safeParse({ error: { code: "in_flight", message: "still running", retryable: true } }).success, true);
		assert.equal(rejectionBodySchema.safeParse({ error: { code: "teapot", message: "x", retryable: false } }).success, false);
	});
});

describe("cross-checks after schema validation", () => {
	const claim = (claim_id: string) => ({ claim_id, text: "t", source_url: "https://stripe.com/jobs/1" });
	const dev = (id: string, ...claimIds: string[]) => ({ id, title: "t", summary: "", claims: claimIds.map(claim) });

	test("research result: more than k, duplicate development ids, duplicate claim_ids", () => {
		assert.deepEqual(checkResearchResult({ developments: [dev("a", "1"), dev("b", "2")] }, 2), { ok: true });
		const tooMany = checkResearchResult({ developments: [dev("a"), dev("b"), dev("c")] }, 2);
		assert.equal(tooMany.ok, false);
		const duplicates = checkResearchResult({ developments: [dev("a", "1"), dev("a", "1")] }, 5);
		assert.equal(duplicates.ok, false);
		if (!duplicates.ok) assert.equal(duplicates.problems.length, 2);
	});

	test("verdicts must answer claims that were sent, at most once; missing verdicts are allowed", () => {
		const verdict = (claim_id: string) => ({ claim_id, verdict: "unsupported" as const, evidence: null });
		const sent = ["0-1", "0-2", "0-3"];
		assert.deepEqual(checkVerdicts({ verdicts: [verdict("0-1"), verdict("0-2")] }, sent), { ok: true });
		const foreign: VerifyResult = { verdicts: [verdict("0-1"), verdict("9-9")] };
		const foreignCheck = checkVerdicts(foreign, sent);
		assert.equal(foreignCheck.ok, false);
		if (!foreignCheck.ok) assert.match(foreignCheck.problems[0]!, /not sent/);
		assert.equal(checkVerdicts({ verdicts: [verdict("0-1"), verdict("0-1")] }, sent).ok, false);
	});
});

describe("canonical JSON and body hash", () => {
	test("key order and whitespace do not matter", () => {
		const a = JSON.parse('{"run_id":"r","budget":{"max_tokens":1,"max_steps":2},"payload":{"k":5,"topic":"t"}}');
		const b = JSON.parse(`{
			"payload": { "topic": "t", "k": 5 },
			"budget":  { "max_steps": 2, "max_tokens": 1 },
			"run_id":  "r"
		}`);
		assert.equal(canonicalJson(a), canonicalJson(b));
		assert.equal(bodyHash(a), bodyHash(b));
		assert.equal(canonicalJson(a), '{"budget":{"max_steps":2,"max_tokens":1},"payload":{"k":5,"topic":"t"},"run_id":"r"}');
	});

	test("any change in value, including a shrunk time budget, changes the hash", () => {
		assert.notEqual(bodyHash(research), bodyHash({ ...research, time_budget_ms: 59999 }));
		assert.notEqual(bodyHash(research), bodyHash({ ...research, payload: { ...research.payload, k: 4 } }));
	});

	test("array order is significant; nested objects are sorted", () => {
		assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
		assert.equal(canonicalJson([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
	});

	test("strings, unicode, null, booleans, and numbers round-trip as JSON", () => {
		const value = { s: 'quote " and \\ backslash', u: "café ✳", n: null, t: true, f: false, x: 1.5, z: 0 };
		assert.deepEqual(JSON.parse(canonicalJson(value)), value);
	});

	test("undefined members are dropped like JSON.stringify", () => {
		assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
		assert.equal(bodyHash({ a: 1, b: undefined }), bodyHash({ a: 1 }));
	});

	test("hash is sha256 hex", () => {
		assert.match(bodyHash(research), /^[0-9a-f]{64}$/);
	});
});
