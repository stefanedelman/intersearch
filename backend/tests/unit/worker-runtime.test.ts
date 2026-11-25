import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { verifyRequestSchema, verifyResponseSchema, type VerifyPayload, type VerifyResult } from "../../src/shared/contract";
import { TraceLog, type TraceLine } from "../../src/shared/trace-log";
import { bearerMatches, createWorkerApp, WorkerUnavailable, type WorkContext, type WorkOutcome } from "../../src/shared/worker/app";
import { IdempotencyStore } from "../../src/shared/worker/idempotency";

const TOKEN = "test-verifier-token-0123456789abcdef";
const auth = { Authorization: `Bearer ${TOKEN}` };

type Handler = (req: { payload: VerifyPayload; time_budget_ms: number }, ctx: WorkContext<VerifyResult>) => Promise<WorkOutcome<VerifyResult>>;

function setup(handler: Handler, options: { maxConcurrent?: number; backstopMs?: number } = {}) {
	const log = new TraceLog("verifier");
	let calls = 0;
	const { app, store } = createWorkerApp<VerifyPayload, VerifyResult>({
		service: "verifier",
		token: TOKEN,
		log,
		maxConcurrent: options.maxConcurrent,
		backstopMs: options.backstopMs,
		route: {
			path: "/verify",
			requestSchema: verifyRequestSchema,
			responseSchema: verifyResponseSchema,
			emptyResult: { verdicts: [] },
			handle: (req, ctx) => {
				calls += 1;
				return handler(req, ctx);
			},
		},
	});
	return { app, store, log, calls: () => calls };
}

function body(overrides: Record<string, unknown> = {}) {
	return {
		request_id: randomUUID(),
		run_id: "6f1c2a4e-8b7d-4c3e-9a1f-2b3c4d5e6f70",
		time_budget_ms: 5000,
		budget: { max_steps: 3, max_fetches: 3, max_tokens: 9000 },
		payload: { claims: [{ claim_id: "0-1", text: "The role is in New York.", source_url: "https://example.org/job" }] },
		...overrides,
	};
}

const supported: Handler = async (req, ctx) => {
	ctx.usage.steps += 1;
	ctx.usage.fetches += 1;
	ctx.usage.tokens += 1200;
	ctx.trace({ step: 1, endpoint_or_tool: "groq:chat.completions", status: 200, latency_ms: 5, tokens: 1200 });
	return { status: "complete", result: { verdicts: req.payload.claims.map((claim) => ({ claim_id: claim.claim_id, verdict: "supported" as const, evidence: "New York" })) } };
};

const deferred = <T = void>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
};

describe("authentication comes first", () => {
	const { app } = setup(supported);

	test("GET /healthz needs no token", async () => {
		const res = await request(app).get("/healthz");
		assert.equal(res.status, 200);
		assert.deepEqual(res.body, { status: "ok" });
	});

	test("missing and wrong tokens are 401", async () => {
		assert.equal((await request(app).post("/verify").send(body())).status, 401);
		assert.equal((await request(app).post("/verify").set("Authorization", "Bearer nope").send(body())).status, 401);
		assert.equal((await request(app).post("/verify").set("Authorization", TOKEN).send(body())).status, 401, "the Bearer scheme is required");
		const res = await request(app).post("/verify").send(body());
		assert.equal(res.body.error.code, "unauthorized");
		assert.equal(res.body.error.retryable, false);
	});

	test("an unauthenticated caller learns nothing about the schema: bad JSON and bad bodies are 401, not 400", async () => {
		const badJson = await request(app).post("/verify").set("content-type", "application/json").send("{not json");
		assert.equal(badJson.status, 401);
		const badBody = await request(app).post("/verify").send({ hello: "world" });
		assert.equal(badBody.status, 401);
		assert.doesNotMatch(JSON.stringify(badBody.body), /claims|request_id|payload/);
	});

	test("GET /trace needs the token", async () => {
		assert.equal((await request(app).get(`/trace?run_id=${randomUUID()}`)).status, 401);
	});

	test("bearerMatches: exact token only", () => {
		assert.equal(bearerMatches(`Bearer ${TOKEN}`, TOKEN), true);
		assert.equal(bearerMatches(`Bearer ${TOKEN}x`, TOKEN), false);
		assert.equal(bearerMatches(`bearer ${TOKEN}`, TOKEN), false);
		assert.equal(bearerMatches(undefined, TOKEN), false);
		assert.equal(bearerMatches("Bearer ", TOKEN), false);
		assert.equal(bearerMatches(`Bearer ${TOKEN}`, ""), false);
	});
});

describe("request validation", () => {
	const { app, calls } = setup(supported);

	test("a body that fails the schema is 400 and the handler never runs", async () => {
		for (const bad of [{ ...body(), time_budget_ms: 0 }, { ...body(), extra: 1 }, { ...body(), payload: { claims: [] } }, { ...body(), request_id: "nope" }]) {
			const res = await request(app).post("/verify").set(auth).send(bad);
			assert.equal(res.status, 400, JSON.stringify(bad));
			assert.equal(res.body.error.code, "bad_request");
			assert.equal(res.body.error.retryable, false);
		}
		assert.equal(calls(), 0);
	});

	test("malformed JSON with a valid token is 400", async () => {
		const res = await request(app).post("/verify").set(auth).set("content-type", "application/json").send('{"request_id":');
		assert.equal(res.status, 400);
		assert.equal(res.body.error.code, "bad_request");
	});

	test("a body over 256 KB is 400", async () => {
		const huge = body({ payload: { claims: [{ claim_id: "x", text: "y", source_url: "z".repeat(300_000) }] } });
		const res = await request(app).post("/verify").set(auth).send(huge);
		assert.equal(res.status, 400);
	});
});

describe("work, idempotency, and duplicates", () => {
	test("complete work returns the response envelope with usage", async () => {
		const { app } = setup(supported);
		const sent = body();
		const res = await request(app).post("/verify").set(auth).send(sent);
		assert.equal(res.status, 200);
		assert.equal(verifyResponseSchema.safeParse(res.body).success, true);
		assert.equal(res.body.status, "complete");
		assert.equal(res.body.request_id, sent.request_id);
		assert.deepEqual({ ...res.body.usage, elapsed_ms: 0 }, { steps: 1, fetches: 1, tokens: 1200, elapsed_ms: 0 });
	});

	test("the same request_id and body twice: same response, and the second does no work", async () => {
		const { app, calls, log } = setup(supported);
		const sent = body();
		const first = await request(app).post("/verify").set(auth).send(sent);
		const second = await request(app).post("/verify").set(auth).send(sent);
		assert.equal(second.status, first.status);
		assert.equal(second.text, first.text, "byte-for-byte replay");
		assert.equal(calls(), 1);
		const lines = log.lines({ requestId: sent.request_id });
		assert.equal(lines.filter((line) => line.direction === "out").length, 1, "only the first copy made calls");
		assert.deepEqual(lines.filter((line) => line.direction === "in").map((line) => line.idempotency), ["new", "replay"]);
	});

	test("the same body with different key order and whitespace is the same request", async () => {
		const { app, calls } = setup(supported);
		const sent = body();
		await request(app).post("/verify").set(auth).send(sent);
		const reordered = `{
			"payload": {"claims": [{"source_url": "https://example.org/job", "text": "The role is in New York.", "claim_id": "0-1"}]},
			"budget": {"max_tokens": 9000, "max_fetches": 3, "max_steps": 3},
			"time_budget_ms": 5000, "run_id": "${sent.run_id}", "request_id": "${sent.request_id}"
		}`;
		const res = await request(app).post("/verify").set(auth).set("content-type", "application/json").send(reordered);
		assert.equal(res.status, 200);
		assert.equal(calls(), 1);
	});

	test("the same request_id with a different body is 409, including a shrunk time budget", async () => {
		const { app, calls } = setup(supported);
		const sent = body();
		await request(app).post("/verify").set(auth).send(sent);
		const shrunk = await request(app).post("/verify").set(auth).send({ ...sent, time_budget_ms: 4000 });
		assert.equal(shrunk.status, 409);
		assert.equal(shrunk.body.error.code, "idempotency_conflict");
		assert.equal(shrunk.body.error.retryable, false);
		assert.equal(calls(), 1);
	});

	test("a duplicate while the first copy is still running gets 503 with Retry-After, and the work is not started twice", async () => {
		const entered = deferred();
		const release = deferred();
		const { app, calls } = setup(async (req, ctx) => {
			entered.resolve();
			await release.promise;
			return supported(req, ctx);
		});
		const sent = body({ time_budget_ms: 20_000 });
		const first = request(app).post("/verify").set(auth).send(sent).then((res) => res);
		await entered.promise;
		const duplicate = await request(app).post("/verify").set(auth).send(sent);
		assert.equal(duplicate.status, 503);
		assert.equal(duplicate.body.error.code, "in_flight");
		assert.equal(duplicate.body.error.retryable, true);
		const retryAfter = Number(duplicate.headers["retry-after"]);
		assert.ok(retryAfter >= 1 && retryAfter <= 30, `Retry-After ${retryAfter}`);
		release.resolve();
		const original = await first;
		const later = await request(app).post("/verify").set(auth).send(sent);
		assert.equal(later.text, original.text);
		assert.equal(calls(), 1);
	});

	test("503 for 'cannot take it now' is not stored: a retry runs the work", async () => {
		let attempt = 0;
		const { app, calls } = setup(async (req, ctx) => {
			attempt += 1;
			if (attempt === 1) throw new WorkerUnavailable("model_rate_limited", "per-minute token limit", 7.2);
			return supported(req, ctx);
		});
		const sent = body();
		const first = await request(app).post("/verify").set(auth).send(sent);
		assert.equal(first.status, 503);
		assert.equal(first.headers["retry-after"], "8");
		assert.equal(first.body.error.code, "model_rate_limited");
		const retry = await request(app).post("/verify").set(auth).send(sent);
		assert.equal(retry.status, 200);
		assert.equal(calls(), 2);
	});

	test("an unexpected handler error is a stored 500 failed: never retried into new work", async () => {
		const { app, calls } = setup(async () => {
			throw new Error("boom");
		});
		const sent = body();
		const first = await request(app).post("/verify").set(auth).send(sent);
		assert.equal(first.status, 500);
		assert.equal(first.body.status, "failed");
		assert.equal(first.body.error.retryable, false);
		assert.equal(verifyResponseSchema.safeParse(first.body).success, true);
		const again = await request(app).post("/verify").set(auth).send(sent);
		assert.equal(again.text, first.text);
		assert.equal(calls(), 1);
	});

	test("a handler result that breaks the contract is turned into 500 failed instead of being sent", async () => {
		const { app } = setup(async () => ({ status: "complete", result: { verdicts: [{ claim_id: "0-1", verdict: "supported", evidence: null }] } }));
		const res = await request(app).post("/verify").set(auth).send(body());
		assert.equal(res.status, 500);
		assert.equal(res.body.status, "failed");
		assert.match(res.body.error.message, /invalid response/);
	});

	test("new requests beyond the concurrency limit get 503 overloaded; a duplicate of a running one still gets in_flight", async () => {
		const entered = deferred();
		const release = deferred();
		const { app, calls } = setup(
			async (req, ctx) => {
				entered.resolve();
				await release.promise;
				return supported(req, ctx);
			},
			{ maxConcurrent: 1 },
		);
		const a = body({ time_budget_ms: 20_000 });
		const pending = request(app).post("/verify").set(auth).send(a).then((res) => res);
		await entered.promise;
		const b = await request(app).post("/verify").set(auth).send(body());
		assert.equal(b.status, 503);
		assert.equal(b.body.error.code, "overloaded");
		assert.equal((await request(app).post("/verify").set(auth).send(a)).body.error.code, "in_flight");
		release.resolve();
		assert.equal((await pending).status, 200);
		assert.equal(calls(), 1);
	});
});

describe("deadlines and partial results", () => {
	test("the handler sees a deadline from arrival and can stop with partial", async () => {
		const { app } = setup(async (req, ctx) => {
			await new Promise((resolve) => setTimeout(resolve, req.time_budget_ms + 20));
			assert.equal(ctx.signal.aborted, true);
			return { status: "partial", result: { verdicts: [] }, error: { code: "time_budget_exhausted", message: "stopped after 0 of 1 claims", retryable: false } };
		});
		const res = await request(app).post("/verify").set(auth).send(body({ time_budget_ms: 30 }));
		assert.equal(res.status, 200);
		assert.equal(res.body.status, "partial");
		assert.equal(res.body.error.code, "time_budget_exhausted");
	});

	test("a handler that ignores the deadline is answered by the backstop with what it recorded", async () => {
		const { app, store } = setup(
			async (req, ctx) => {
				ctx.usage.fetches += 1;
				ctx.setPartial({ verdicts: [{ claim_id: "0-1", verdict: "unreachable", evidence: null }] });
				await new Promise(() => undefined); // never returns
				throw new Error("unreachable");
			},
			{ backstopMs: 20 },
		);
		const sent = body({ time_budget_ms: 30 });
		const started = Date.now();
		const res = await request(app).post("/verify").set(auth).send(sent);
		assert.ok(Date.now() - started < 2000);
		assert.equal(res.status, 200);
		assert.equal(res.body.status, "partial");
		assert.deepEqual(res.body.result.verdicts, [{ claim_id: "0-1", verdict: "unreachable", evidence: null }]);
		assert.equal(res.body.usage.fetches, 1);
		assert.equal(store.begin(sent.request_id, "irrelevant", 0).kind, "conflict", "the partial response was stored");
	});
});

describe("trace lines", () => {
	const SPEC_FIELDS = ["ts", "service", "run_id", "request_id", "step", "direction", "endpoint_or_tool", "status", "latency_ms", "attempt", "tokens"];

	test("every received request and every call becomes a line with the spec's fields, and GET /trace returns them", async () => {
		const { app } = setup(supported);
		const sent = body();
		await request(app).post("/verify").set(auth).set("X-Attempt", "2").send(sent);
		const res = await request(app).get(`/trace?run_id=${sent.run_id}`).set(auth);
		assert.equal(res.status, 200);
		const lines = (res.body.lines as TraceLine[]).filter((line) => line.request_id === sent.request_id);
		assert.deepEqual(lines.map((line) => line.direction), ["out", "in"]);
		for (const line of lines) {
			for (const field of SPEC_FIELDS) assert.ok(field in line, `${line.direction} line has ${field}`);
			assert.equal(line.service, "verifier");
			assert.equal(line.attempt, 2);
		}
		const inbound = lines.find((line) => line.direction === "in")!;
		assert.equal(inbound.endpoint_or_tool, "POST /verify");
		assert.equal(inbound.status, 200);
		assert.equal(inbound.tokens, 1200);
	});

	test("rejected requests are logged too (401 and 400), without ids they did not prove", async () => {
		const { app, log } = setup(supported);
		await request(app).post("/verify").send(body());
		await request(app).post("/verify").set(auth).send({ request_id: "not-a-uuid" });
		const statuses = log.lines().map((line) => line.status);
		assert.deepEqual(statuses, [401, 400]);
		assert.ok(log.lines().every((line) => line.request_id === null));
	});

	test("trace lines never contain the token, even if a handler puts it in detail", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intersearch-trace-"));
		const file = path.join(dir, "verifier.jsonl");
		const log = new TraceLog("verifier", { file });
		log.write({ run_id: null, request_id: null, step: 0, direction: "out", endpoint_or_tool: "x", status: 200, latency_ms: 1, attempt: 1, tokens: null, detail: { authorization: `Bearer ${TOKEN}`, verifier_token: TOKEN, note: `Bearer ${TOKEN}` } });
		const text = fs.readFileSync(file, "utf8");
		assert.doesNotMatch(text, new RegExp(TOKEN));
		assert.equal(text.trim().split("\n").length, 1);
		assert.doesNotThrow(() => JSON.parse(text));
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe("idempotency store", () => {
	test("finished entries expire after the TTL; running ones are never evicted", () => {
		let now = 0;
		const store = new IdempotencyStore({ ttlMs: 1000, maxEntries: 2, now: () => now });
		assert.equal(store.begin("a", "h", 50_000).kind, "new");
		store.complete("a", { statusCode: 200, body: "{}" });
		assert.equal(store.begin("a", "h", 0).kind, "replay");
		now = 1001;
		assert.equal(store.begin("a", "h", 0).kind, "new", "expired entries are forgotten");

		const running = new IdempotencyStore({ maxEntries: 1, now: () => now });
		running.begin("r1", "h", now + 10_000);
		running.begin("r2", "h", now + 10_000);
		assert.equal(running.begin("r1", "h", 0).kind, "in_flight");
		assert.equal(running.begin("r2", "h", 0).kind, "in_flight");
	});

	test("over capacity, the least recently used finished entry goes first", () => {
		const store = new IdempotencyStore({ maxEntries: 2 });
		for (const id of ["a", "b"]) {
			store.begin(id, "h", Date.now() + 1000);
			store.complete(id, { statusCode: 200, body: id });
		}
		store.begin("a", "h", 0); // replay refreshes "a"
		store.begin("c", "h", Date.now() + 1000);
		assert.equal(store.begin("a", "h", 0).kind, "replay");
		assert.equal(store.begin("b", "h", 0).kind, "new", "b was evicted");
	});

	test("Retry-After is the time left on the first copy, clamped to 1..30 s", () => {
		let now = 0;
		const store = new IdempotencyStore({ now: () => now });
		store.begin("x", "h", 12_400);
		assert.deepEqual(store.begin("x", "h", 0), { kind: "in_flight", retryAfterSeconds: 13 });
		now = 12_390;
		assert.deepEqual(store.begin("x", "h", 0), { kind: "in_flight", retryAfterSeconds: 1 });
		store.begin("y", "h", 600_000);
		assert.deepEqual(store.begin("y", "h", 0), { kind: "in_flight", retryAfterSeconds: 30 });
	});

	test("a restart loses everything: the same request is new again", () => {
		const before = new IdempotencyStore();
		before.begin("x", "h", Date.now() + 1000);
		before.complete("x", { statusCode: 200, body: "{}" });
		const afterRestart = new IdempotencyStore();
		assert.equal(afterRestart.begin("x", "h", Date.now() + 1000).kind, "new");
	});
});
