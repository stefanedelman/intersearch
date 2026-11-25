/**
 * The assignment's "Test it yourself" matrix against a live worker (ORCHESTRATION_PLAN.md §13).
 *
 *   npm run contract-check -- --target verifier                  (VERIFIER_URL, VERIFIER_TOKEN)
 *   npm run contract-check -- --target researcher                (RESEARCHER_URL, RESEARCHER_TOKEN)
 *   npm run contract-check -- --target verifier --url https://… --save
 *
 * Options: --url URL (default: RESEARCHER_URL / VERIFIER_URL from backend/.env), --save (writes
 * docs/contract-check-<target>-<date>.md), --claim-url URL (verifier: the page for the real claim).
 * Tokens come from backend/.env.local (or the environment) and are never printed.
 *
 * Cost: one real request per target. The researcher check uses max_steps 2 (two model calls); the
 * verifier check makes one model call. The other rows are refused before any work, or are replays.
 *
 * Every 200/500 body is validated against the shared contract (src/shared/contract.ts).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { rejectionBodySchema, researchResponseSchema, verifyResponseSchema } from "../shared/contract";
import { backendRoot, loadLocalEnv } from "../shared/load-env";

type Target = "researcher" | "verifier";
type Row = { check: string; expected: string; actual: string; ok: boolean };

const args = process.argv.slice(2);
const arg = (name: string) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const target = arg("--target") as Target | undefined;
if (target !== "researcher" && target !== "verifier") {
	console.error("Usage: npm run contract-check -- --target researcher|verifier [--url URL] [--save] [--claim-url URL]");
	process.exit(2);
}

loadLocalEnv();
const prefix = target === "researcher" ? "RESEARCHER" : "VERIFIER";
const base = (arg("--url") ?? process.env[`${prefix}_URL`] ?? (target === "researcher" ? "http://127.0.0.1:4001" : "http://127.0.0.1:4002")).replace(/\/+$/, "");
const token = process.env[`${prefix}_TOKEN`];
if (!token) {
	console.error(`${prefix}_TOKEN is not set (backend/.env.local; run node scripts/setup-env.mjs).`);
	process.exit(2);
}
const path_ = target === "researcher" ? "/research" : "/verify";
const responseSchema: z.ZodType = target === "researcher" ? researchResponseSchema : verifyResponseSchema;
const claimUrl = arg("--claim-url") ?? "https://example.com/";

type Reply = { status: number | string; text: string; json: unknown; headers: Headers | null; ms: number };

async function send(method: string, route: string, options: { body?: unknown; raw?: string; auth?: string | null; timeoutMs?: number } = {}): Promise<Reply> {
	const started = performance.now();
	const headers: Record<string, string> = { accept: "application/json" };
	if (options.body !== undefined || options.raw !== undefined) headers["content-type"] = "application/json";
	const auth = options.auth === undefined ? `Bearer ${token}` : options.auth;
	if (auth) headers.authorization = auth;
	try {
		const res = await fetch(`${base}${route}`, { method, headers, body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)), signal: AbortSignal.timeout(options.timeoutMs ?? 120_000) });
		const text = await res.text();
		let json: unknown = null;
		try {
			json = JSON.parse(text);
		} catch {
			json = null;
		}
		return { status: res.status, text, json, headers: res.headers, ms: Math.round(performance.now() - started) };
	} catch (error) {
		return { status: (error as Error).name === "TimeoutError" ? "timeout" : "network_error", text: (error as Error).message, json: null, headers: null, ms: Math.round(performance.now() - started) };
	}
}

/** The run_id/request_id echo and the response schema, for 200 and 500 answers. */
function contractProblem(reply: Reply, sent: { request_id: string; run_id: string }): string | null {
	const parsed = responseSchema.safeParse(reply.json);
	if (!parsed.success) return `body breaks the contract: ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`;
	const body = parsed.data as { request_id: string; run_id: string; service: string; status: string };
	if (body.request_id !== sent.request_id || body.run_id !== sent.run_id) return "request_id/run_id not echoed";
	if (body.service !== target) return `service is ${body.service}`;
	if ((reply.status === 200) === (body.status === "failed")) return `HTTP ${reply.status} with status ${body.status}`;
	return null;
}

function rejection(reply: Reply): string {
	const parsed = rejectionBodySchema.safeParse(reply.json);
	return parsed.success ? parsed.data.error.code : "no error body";
}

async function traceLines(requestId: string) {
	const reply = await send("GET", `/trace?request_id=${requestId}`);
	return ((reply.json as { lines?: { direction: string; endpoint_or_tool: string; idempotency?: string }[] } | null)?.lines ?? []) as { direction: string; endpoint_or_tool: string; idempotency?: string; status: unknown }[];
}

function envelope(payload: unknown, overrides: Record<string, unknown> = {}) {
	const budget = target === "researcher" ? { max_steps: 2, max_fetches: 3, max_tokens: 20_000 } : { max_steps: 2, max_fetches: 4, max_tokens: 12_000 };
	return { request_id: randomUUID(), run_id: randomUUID(), time_budget_ms: target === "researcher" ? 90_000 : 45_000, budget, payload, ...overrides };
}

const realPayload =
	target === "researcher"
		? { topic: "Summer 2027 software engineering internships", k: 3 }
		: {
				claims: [
					{ claim_id: "c.1", text: "The page says this domain is for use in documentation examples.", source_url: claimUrl },
					{ claim_id: "c.2", text: "The page offers concert tickets for sale.", source_url: claimUrl },
				],
			};

const rows: Row[] = [];
const row = (check: string, expected: string, actual: string, ok: boolean) => {
	rows.push({ check, expected, actual, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${check}: ${actual}`);
};

async function main() {
	console.log(`Contract check: ${target} at ${base}\n`);
	const health = await send("GET", "/healthz", { auth: null, timeoutMs: 120_000 });
	row("GET /healthz (no auth)", "200 {status: ok}", `${health.status} in ${health.ms} ms`, health.status === 200);

	// Auth runs before the body is parsed: a garbage body without a token is 401, not 400.
	const noToken = await send("POST", path_, { raw: "{not json", auth: null });
	row("no token (and a body that is not JSON)", "401", `${noToken.status} ${rejection(noToken)}`, noToken.status === 401);
	const wrongToken = await send("POST", path_, { body: envelope(realPayload), auth: "Bearer wrong-0123456789abcdef0123456789abcdef" });
	row("wrong token", "401", `${wrongToken.status} ${rejection(wrongToken)}`, wrongToken.status === 401);

	const invalid = await send("POST", path_, { body: { ...envelope(realPayload), budget: { max_steps: -1 }, extra: true } });
	row("schema-invalid body", "400", `${invalid.status} ${rejection(invalid)}`, invalid.status === 400);

	// One real request, used for in-flight, replay, and conflict.
	const real = envelope(realPayload);
	let finished = false;
	const first = send("POST", path_, { body: real, timeoutMs: 180_000 }).then((reply) => {
		finished = true;
		return reply;
	});
	// Duplicates every 100 ms until one arrives while the first is still running (no fixed guess of how long the work takes).
	let duplicate: Reply | null = null;
	let tries = 0;
	while (!finished && tries < 600) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (finished) break;
		tries += 1;
		const reply = await send("POST", path_, { body: real });
		if (reply.status !== 200) {
			duplicate = reply;
			break;
		}
	}
	const retryAfter = duplicate?.headers?.get("retry-after");
	row(
		"same request_id while the first is still running",
		"503 + Retry-After",
		duplicate ? `${duplicate.status} ${rejection(duplicate)}, Retry-After: ${retryAfter ?? "none"} (duplicate #${tries})` : "the first request finished before a duplicate arrived",
		duplicate?.status === 503 && Number(retryAfter) >= 1,
	);

	const answered = await first;
	const problem = answered.status === 200 || answered.status === 500 ? contractProblem(answered, real) : `HTTP ${answered.status}`;
	const summary = (answered.json as { status?: string; usage?: { steps: number; fetches: number; tokens: number } } | null) ?? {};
	row(
		"the real request answers within its time budget, in contract shape",
		"200 complete/partial (or 500 failed), valid envelope",
		`${answered.status} ${summary.status ?? ""} in ${(answered.ms / 1000).toFixed(1)} s; usage ${summary.usage ? `${summary.usage.steps} steps, ${summary.usage.fetches} fetches, ${summary.usage.tokens} tokens` : "?"}${problem ? `; ${problem}` : ""}`,
		answered.status === 200 && problem === null,
	);

	const outBefore = (await traceLines(real.request_id)).filter((line) => line.direction === "out").length;
	const replay = await send("POST", path_, { body: real });
	const linesAfter = await traceLines(real.request_id);
	const outAfter = linesAfter.filter((line) => line.direction === "out").length;
	const replayIn = linesAfter.filter((line) => line.direction === "in" && line.idempotency === "replay").length;
	row(
		"same request_id and body again, after it finished",
		"identical body; no new `out` lines in the trace",
		`${replay.status}, ${replay.text === answered.text ? "identical body" : "DIFFERENT body"}, out lines ${outBefore} → ${outAfter}, replay in-lines ${replayIn}`,
		replay.status === answered.status && replay.text === answered.text && outBefore === outAfter && outBefore > 0 && replayIn >= 1,
	);

	const conflict = await send("POST", path_, { body: { ...real, time_budget_ms: real.time_budget_ms - 1 } });
	row("same request_id, different body", "409", `${conflict.status} ${rejection(conflict)}`, conflict.status === 409);

	const tiny = envelope(realPayload, { time_budget_ms: 1 });
	const short = await send("POST", path_, { body: tiny });
	const shortBody = short.json as { status?: string; error?: { code?: string } } | null;
	const shortProblem = short.status === 200 ? contractProblem(short, tiny) : null;
	row("time_budget_ms: 1", "200 partial", `${short.status} ${shortBody?.status ?? ""} (${shortBody?.error?.code ?? "no error"})${shortProblem ? `; ${shortProblem}` : ""}`, short.status === 200 && shortBody?.status === "partial" && !shortProblem);

	if (target === "verifier") {
		const internal = envelope({
			claims: [
				{ claim_id: "i.1", text: "Cloud metadata is readable.", source_url: "http://169.254.169.254/latest/meta-data/" },
				{ claim_id: "i.2", text: "A local admin page exists.", source_url: "http://localhost/admin" },
			],
		});
		const guarded = await send("POST", path_, { body: internal });
		const verdicts = ((guarded.json as { result?: { verdicts?: { claim_id: string; verdict: string }[] } } | null)?.result?.verdicts ?? []).map((verdict) => `${verdict.claim_id} ${verdict.verdict}`);
		const fetches = (await traceLines(internal.request_id)).filter((line) => line.direction === "out" && line.endpoint_or_tool.startsWith("fetch ")).length;
		row(
			"claims citing 169.254.169.254 and localhost",
			"both unreachable; no `fetch` line in the trace",
			`${guarded.status}: ${verdicts.join(", ") || "no verdicts"}; ${fetches} fetch lines`,
			guarded.status === 200 && verdicts.length === 2 && verdicts.every((verdict) => verdict.endsWith("unreachable")) && fetches === 0,
		);
	}

	const passed = rows.filter((entry) => entry.ok).length;
	console.log(`\n${passed}/${rows.length} passed.`);

	if (args.includes("--save")) {
		const date = new Date().toISOString().slice(0, 10);
		const file = path.resolve(backendRoot, "..", "docs", `contract-check-${target}-${date}.md`);
		const text = [
			`# Contract check: ${target} (${date})`,
			"",
			`Target: \`${new URL(base).host}\`. Command: \`npm run contract-check -- --target ${target}${arg("--url") ? " --url …" : ""} --save\`. Generated by \`backend/src/cli/contract-check.ts\`; every 200 body is validated against \`src/shared/contract.ts\`.`,
			"",
			"| Check | Expected | Actual | Result |",
			"| --- | --- | --- | --- |",
			...rows.map((entry) => `| ${entry.check} | ${entry.expected} | ${entry.actual.replace(/\|/g, "\\|")} | ${entry.ok ? "PASS" : "**FAIL**"} |`),
			"",
			`**${passed}/${rows.length} passed** at ${new Date().toISOString()}.`,
			"",
		].join("\n");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
		console.log(`Saved ${path.relative(path.resolve(backendRoot, ".."), file)}.`);
	}
	process.exit(passed === rows.length ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
