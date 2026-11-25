// Smoke test for a deployed (or local) verifier, ORCHESTRATION_PLAN.md step 11.
//
//   node scripts/smoke-verifier.mjs                       URL from VERIFIER_URL in backend/.env
//   node scripts/smoke-verifier.mjs https://x.onrender.com
//   node scripts/smoke-verifier.mjs URL --save            also append the result to docs/verifier-smoke.md
//
// The token is read from VERIFIER_TOKEN in backend/.env.local and never printed. The real /verify
// check makes one model call on the verifier's Groq key (about 1–2K tokens).
// For the cold-start number, run it after the service has been idle for 15+ minutes.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const save = args.includes("--save");

function readEnv(file) {
	const values = {};
	if (!fs.existsSync(file)) return values;
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
		if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
	}
	return values;
}

const env = { ...readEnv(path.join(root, "backend", ".env")), ...readEnv(path.join(root, "backend", ".env.local")), ...process.env };
const base = (args.find((arg) => !arg.startsWith("--")) ?? env.VERIFIER_URL ?? "").replace(/\/+$/, "");
const token = env.VERIFIER_TOKEN;
if (!base) {
	console.error("Pass the verifier URL, or set VERIFIER_URL in backend/.env.");
	process.exit(2);
}
if (!token) {
	console.error("VERIFIER_TOKEN is not set in backend/.env.local (run: node scripts/setup-env.mjs).");
	process.exit(2);
}

const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function call(method, route, { body, auth = true, rawBody, timeoutMs = 30_000 } = {}) {
	const started = performance.now();
	try {
		const response = await fetch(`${base}${route}`, {
			method,
			headers: { accept: "application/json", ...(body !== undefined || rawBody ? { "content-type": "application/json" } : {}), ...(auth === true ? { authorization: `Bearer ${token}` } : typeof auth === "string" ? { authorization: auth } : {}) },
			body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			json = null;
		}
		return { status: response.status, json, text, ms: Math.round(performance.now() - started) };
	} catch (error) {
		return { status: error.name === "TimeoutError" ? "timeout" : "network_error", json: null, text: String(error.message), ms: Math.round(performance.now() - started) };
	}
}

const envelope = (claims, extra = {}) => ({
	request_id: randomUUID(),
	run_id: randomUUID(),
	time_budget_ms: 45_000,
	budget: { max_steps: 2, max_fetches: 4, max_tokens: 12_000 },
	payload: { claims },
	...extra,
});

console.log(`Verifier: ${base}\n`);

// 1. Cold start: the first request after Render has put the service to sleep.
const cold = await call("GET", "/healthz", { auth: false, timeoutMs: 120_000 });
check("GET /healthz (first request: wakes a sleeping service)", cold.status === 200 && cold.json?.status === "ok", `${cold.status}, ${(cold.ms / 1000).toFixed(1)} s`);
const warm = await call("GET", "/healthz", { auth: false });
check("GET /healthz (warm)", warm.status === 200, `${warm.status}, ${warm.ms} ms`);

// 2. Auth before parsing: no token or a wrong token is 401, even with a broken body.
const none = await call("POST", "/verify", { auth: false, rawBody: "{not json" });
check("POST /verify without a token → 401", none.status === 401, String(none.status));
const wrong = await call("POST", "/verify", { auth: "Bearer wrong-token-0123456789abcdef0123456789", body: envelope([{ claim_id: "x", text: "x", source_url: "https://example.com/" }]) });
check("POST /verify with a wrong token → 401", wrong.status === 401, String(wrong.status));
const invalid = await call("POST", "/verify", { body: { request_id: "not-a-uuid" } });
check("POST /verify with an invalid body → 400", invalid.status === 400, String(invalid.status));

// 3. SSRF guard: a claim citing the cloud metadata address is unreachable, and nothing was fetched.
const metadata = envelope([{ claim_id: "m.1", text: "The metadata service is reachable.", source_url: "http://169.254.169.254/latest/meta-data/" }]);
const guarded = await call("POST", "/verify", { body: metadata });
const verdict = guarded.json?.result?.verdicts?.[0];
check("metadata-address claim → unreachable, 0 fetches", guarded.status === 200 && verdict?.verdict === "unreachable" && guarded.json?.usage?.fetches === 0, `${guarded.status}, ${verdict?.verdict ?? guarded.json?.error?.code}`);

// 4. A real verification: fetch a stable public page and ask the model.
const real = envelope([
	{ claim_id: "r.1", text: "The example.com domain is meant for use in documentation examples.", source_url: "https://example.com/" },
	{ claim_id: "r.2", text: "example.com sells concert tickets.", source_url: "https://example.com/" },
]);
const answer = await call("POST", "/verify", { body: real, timeoutMs: 90_000 });
const verdicts = Object.fromEntries((answer.json?.result?.verdicts ?? []).map((entry) => [entry.claim_id, entry]));
check(
	"real /verify: one fetch and one model call, a verdict per claim",
	answer.status === 200 && answer.json?.status === "complete" && verdicts["r.1"] && verdicts["r.2"],
	`${answer.status}, ${answer.json?.status ?? answer.text.slice(0, 120)}, ${(answer.ms / 1000).toFixed(1)} s, ${answer.json?.usage?.tokens ?? "?"} tokens`,
);
console.log(`      r.1 → ${verdicts["r.1"]?.verdict ?? "—"}${verdicts["r.1"]?.evidence ? ` "${verdicts["r.1"].evidence}"` : ""}`);
console.log(`      r.2 → ${verdicts["r.2"]?.verdict ?? "—"}  (expected: unsupported)`);

// 5. Idempotency: the same request again returns the stored answer without new work.
const replay = await call("POST", "/verify", { body: real, timeoutMs: 30_000 });
check("same request_id and body again → identical stored answer", replay.status === answer.status && replay.text === answer.text, `${replay.status}, ${replay.ms} ms`);
const trace = await call("GET", `/trace?run_id=${real.run_id}`);
const modelLines = (trace.json?.lines ?? []).filter((line) => line.direction === "out" && String(line.endpoint_or_tool).startsWith("groq "));
check("the replay added no model call (GET /trace)", trace.status === 200 && modelLines.length === 1, `${modelLines.length} model call line(s)`);

const passed = results.filter((result) => result.ok).length;
console.log(`\n${passed}/${results.length} passed. Cold start (first /healthz): ${(cold.ms / 1000).toFixed(1)} s.`);

if (save) {
	const file = path.join(root, "docs", "verifier-smoke.md");
	const host = new URL(base).host;
	const lines = [
		fs.existsSync(file) ? "" : "# Verifier smoke tests\n\nOutput of `node scripts/smoke-verifier.mjs URL --save` (ORCHESTRATION_PLAN.md step 11). Newest last.\n",
		`## ${new Date().toISOString()} · ${host}`,
		"",
		"| Check | Result | Detail |",
		"| --- | --- | --- |",
		...results.map((result) => `| ${result.name} | ${result.ok ? "PASS" : "FAIL"} | ${String(result.detail ?? "").replace(/\|/g, "\\|")} |`),
		"",
		`Cold start (first /healthz after idle): **${(cold.ms / 1000).toFixed(1)} s**. Real /verify: r.1 → ${verdicts["r.1"]?.verdict ?? "—"}, r.2 → ${verdicts["r.2"]?.verdict ?? "—"}.`,
		"",
	];
	fs.appendFileSync(file, lines.join("\n"));
	console.log(`Saved to ${path.relative(root, file)}.`);
}
process.exit(passed === results.length ? 0 : 1);
