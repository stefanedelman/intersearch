import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { MockAgent } from "undici";
import { Budget, BudgetExhausted } from "../../src/tracker/budget";
import { parseConfig } from "../../src/tracker/config";
import { guardedGet } from "../../src/tracker/fetch/transport";
import { runAgentLoop, tokenPacingWaitMs } from "../../src/tracker/loop";
import { emptyMemory, policyFor, transportFor, type ToolContext } from "../../src/tracker/tools/context";
import { fetchArticle } from "../../src/tracker/tools/fetch-article";
import { listCompanyJobs } from "../../src/tracker/tools/list-jobs";
import { parseToolCall } from "../../src/tracker/tools/registry";
import { Trace } from "../../src/tracker/trace";
import { ACME_CONFIG_YAML } from "../fixtures/acme";
import { scriptedModel } from "../helpers/scripted-model";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "intersearch-safety-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let sequence = 0;
function context(): ToolContext {
	const config = parseConfig(ACME_CONFIG_YAML);
	return { config, policy: policyFor(config), transport: transportFor(config), budget: new Budget(config.limits), trace: new Trace("test", path.join(temp, String(sequence++))), step: 1, parentEventId: null, store: null, search: null, memory: emptyMemory() };
}

for (const tool of ["fetch_article", "list_company_jobs"] as const) {
	test(`${tool}: a redirect cannot exceed the request budget`, async () => {
		const ctx = context();
		ctx.budget = new Budget({ ...ctx.config.limits, max_network_requests: 1 });
		const mock = new MockAgent();
		mock.disableNetConnect();
		const start = tool === "fetch_article" ? "/article" : "/v1/boards/acme/jobs";
		mock.get("https://boards-api.greenhouse.io").intercept({ path: start }).reply(302, "", { headers: { location: "https://careers.acme.example/redirected" } });
		let reachedRedirect = false;
		mock.get("https://careers.acme.example").intercept({ path: "/redirected" }).reply(() => { reachedRedirect = true; return { statusCode: 200, data: "{}" }; });
		ctx.fetcher = (url, policy, limits, options) => guardedGet(url, policy, limits, { ...options, dispatcher: mock, resolver: async () => [{ address: "104.18.0.1", family: 4 }] });
		try {
			await assert.rejects(tool === "fetch_article" ? fetchArticle(ctx, "https://boards-api.greenhouse.io/article") : listCompanyJobs(ctx, "acme"), (e: unknown) => e instanceof BudgetExhausted && e.limit === "max_network_requests");
			assert.equal(reachedRedirect, false);
			assert.equal(ctx.budget.snapshot.networkRequests, 1);
			assert.equal(ctx.trace.all.filter(e => e.category === "http").length, 1);
		} finally { await mock.close(); }
	});
}

test("redirect trace counts each host once and links it to the tool span", async () => {
	const ctx = context();
	const mock = new MockAgent();
	mock.disableNetConnect();
	mock.get("https://boards-api.greenhouse.io").intercept({ path: "/article" }).reply(302, "", { headers: { location: "https://careers.acme.example/redirected" } });
	mock.get("https://careers.acme.example").intercept({ path: "/redirected" }).reply(200, "Software engineering internship", { headers: { "content-type": "text/plain" } });
	ctx.fetcher = (url, policy, limits, options) => guardedGet(url, policy, limits, { ...options, dispatcher: mock, resolver: async () => [{ address: "104.18.0.1", family: 4 }] });
	try {
		await ctx.trace.span({ eventId: "tool-parent", category: "tool", tool: "fetch_article" }, async id => {
			ctx.parentEventId = id;
			assert.equal((await fetchArticle(ctx, "https://boards-api.greenhouse.io/article")).status, "fetched");
		});
		const http = ctx.trace.all.filter(e => e.category === "http");
		assert.deepEqual(http.map(e => e.service), ["boards-api.greenhouse.io", "careers.acme.example"]);
		assert.ok(http.every(e => e.parentEventId === "tool-parent"));
		assert.equal(ctx.budget.snapshot.networkRequests, 2);
		const output = execFileSync(process.execPath, [path.resolve(__dirname, "../../../scripts/trace-stats.mjs"), ctx.trace.path], { encoding: "utf8" });
		assert.match(output, /network round trips: 2/);
		assert.match(output, /boards-api.greenhouse.io\s+1\s+0/);
		assert.match(output, /careers.acme.example\s+1\s+0/);
	} finally { await mock.close(); }
});

test("a dense Unicode prompt cannot pass the token cap using the old average estimate", async () => {
	const ctx = context();
	ctx.config.instructions = "漢字🧪".repeat(500);
	ctx.config.limits.max_total_tokens = 5000;
	ctx.budget = new Budget(ctx.config.limits);
	const model = scriptedModel([{ tool: "finish", args: { candidates: [] } }]);
	const outcome = await runAgentLoop({ config: ctx.config, state: null, ctx, callModel: model.callModel, isInterrupted: () => false, log: () => undefined });
	assert.equal(outcome.status, "partial");
	assert.equal(outcome.errorCode, "max_total_tokens");
	assert.equal(model.calls.length, 0);
	assert.equal(ctx.budget.snapshot.networkRequests, 0, "a blocked call did not make a round trip");
});

test("finish rejects a fabricated salary reason even when accompanied by a valid quote", () => {
	const result = parseToolCall(["finish"], "finish", JSON.stringify({ candidates: [{ source_id: "source", reason: "This pays $1 million per year.", supporting_quote: "Build backend services." }] }));
	assert.equal(result.ok, false);
});

test("finish cannot succeed with an unknown source on an empty run", async () => {
	const ctx = context();
	ctx.config.limits.max_steps = 1;
	ctx.budget = new Budget(ctx.config.limits);
	const model = scriptedModel([{ tool: "finish", args: { candidates: [{ source_id: "invented" }] } }]);
	const result = await runAgentLoop({ config: ctx.config, state: null, ctx, callModel: model.callModel, isInterrupted: () => false, log: () => undefined });
	assert.equal(result.status, "partial");
	assert.equal(result.errorCode, "max_steps");
});

test("model calls wait for the per-minute token bucket to refill enough for the next request", () => {
	const rate = { limitTokens: 8000, remainingTokens: 2000, observedAt: 0 };
	const pacing = { rate, tokensPerByte: 0.25 };
	// 12,000 bytes ≈ 3,000 prompt tokens, ×1.1 headroom = 3,300, plus the 1,000-token output ceiling.
	assert.equal(tokenPacingWaitMs(pacing, 12_000, 1000, 0), 17_250);
	// The bucket refills at limit / 60 per second, so the wait shrinks as time passes.
	assert.equal(tokenPacingWaitMs(pacing, 12_000, 1000, 17_250), 0);
	// A request larger than the whole bucket waits only for a full bucket, never forever.
	assert.equal(tokenPacingWaitMs(pacing, 1_000_000, 1000, 0), 45_000);
	assert.equal(tokenPacingWaitMs(null, 12_000, 1000, 0), 0);
});

test("the last allowed step offers only finish and tells the model to call it", async () => {
	const ctx = context();
	ctx.config.limits.max_steps = 2;
	ctx.budget = new Budget(ctx.config.limits);
	const model = scriptedModel([{ text: "Planning." }, { tool: "list_company_jobs", args: { company_id: "acme" } }]);
	const outcome = await runAgentLoop({ config: ctx.config, state: null, ctx, callModel: model.callModel, isInterrupted: () => false, log: () => undefined });
	assert.equal(outcome.errorCode, "max_steps");
	const lastRequest = model.calls[1]!;
	assert.match(String(lastRequest.at(-1)!.content), /last step\. Call finish now/);
	assert.doesNotMatch(String(model.calls[0]!.at(-1)!.content), /last step/);
	// The non-finish call on the last step was refused, so no job feed was requested.
	assert.equal(ctx.budget.snapshot.networkRequests, 2, "only the two model calls");
});

test("a tool whose own allowance is used up is withdrawn without ending the run", async () => {
	const ctx = context();
	ctx.config.limits.max_fetches = 0;
	ctx.budget = new Budget(ctx.config.limits);
	const model = scriptedModel([{ tool: "fetch_article", args: { url: "https://careers.acme.example/jobs/1" } }, { tool: "finish", args: { candidates: [] } }]);
	const outcome = await runAgentLoop({ config: ctx.config, state: null, ctx, callModel: model.callModel, isInterrupted: () => false, log: () => undefined });
	assert.equal(outcome.status, "complete");
	assert.equal(ctx.budget.snapshot.fetches, 0);
	assert.equal(ctx.budget.snapshot.networkRequests, 2, "only the two model calls");
});
