// Runs the whole stack in one terminal with prefixed output (development only):
//   API + orchestrator (:3000), researcher (:4001), a local verifier (:4002), and the frontend (:5173).
//
//   npm run dev:all                      everything local
//   npm run dev:all -- --remote-verifier use VERIFIER_URL from backend/.env (the Render service)
//   npm run dev:all -- --demo            demo API (no Supabase, no Groq) + frontend
//
// Ctrl-C stops everything. Secrets are never printed: this script only checks which keys are set.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

/** Keys that have a non-empty value in a dotenv file (values are not kept). */
function keysSet(file) {
	if (!fs.existsSync(file)) return new Set();
	const keys = new Set();
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
		if (match && match[2].replace(/^["']|["']$/g, "").trim() !== "") keys.add(match[1]);
	}
	return keys;
}

const env = new Set([...keysSet(path.join(root, "backend", ".env")), ...keysSet(path.join(root, "backend", ".env.local"))]);
const missing = (...keys) => keys.filter((key) => !env.has(key) && !process.env[key]);

const services = [];
if (args.has("--demo")) {
	services.push({ name: "demo-api", color: 33, cmd: ["npm", "run", "demo:api", "--prefix", "backend"] });
} else {
	const apiEnv = {};
	const problems = [];
	if (missing("DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY").length) problems.push(`api: ${missing("DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY").join(", ")} missing in backend/.env (see backend/.env.example)`);
	if (missing("RESEARCHER_TOKEN", "VERIFIER_TOKEN").length) problems.push(`api: ${missing("RESEARCHER_TOKEN", "VERIFIER_TOKEN").join(", ")} missing; run: node scripts/setup-env.mjs`);
	if (missing("GROQ_API_KEY").length) problems.push("researcher: GROQ_API_KEY is empty in backend/.env.local");
	services.push({ name: "api", color: 36, cmd: ["npm", "run", "dev", "--prefix", "backend"], env: apiEnv });
	services.push({ name: "researcher", color: 35, cmd: ["npm", "run", "dev:researcher", "--prefix", "backend"] });
	if (args.has("--remote-verifier")) {
		if (missing("VERIFIER_URL").length) problems.push("verifier: --remote-verifier needs VERIFIER_URL in backend/.env");
	} else if (missing("VERIFIER_GROQ_API_KEY", "VERIFIER_MODEL").length) {
		problems.push(`verifier: not started locally (${missing("VERIFIER_GROQ_API_KEY", "VERIFIER_MODEL").join(", ")} empty in backend/.env.local); the API uses VERIFIER_URL from backend/.env`);
	} else {
		services.push({ name: "verifier", color: 32, cmd: ["npm", "run", "dev:verifier", "--prefix", "backend"] });
		apiEnv.VERIFIER_URL = "http://127.0.0.1:4002"; // a shell variable wins over backend/.env
	}
	for (const problem of problems) console.log(`\x1b[33m! ${problem}\x1b[0m`);
}
services.push({ name: "frontend", color: 34, cmd: ["npm", "run", "dev", "--prefix", "frontend"] });

const width = Math.max(...services.map((service) => service.name.length));
const children = [];
let stopping = false;

function pipe(stream, prefix) {
	let buffer = "";
	stream.on("data", (chunk) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop();
		for (const line of lines) process.stdout.write(`${prefix} ${line}\n`);
	});
	stream.on("end", () => buffer && process.stdout.write(`${prefix} ${buffer}\n`));
}

for (const service of services) {
	const prefix = `\x1b[${service.color}m${service.name.padEnd(width)} |\x1b[0m`;
	// Own process group, so Ctrl-C can stop npm and the server it started together.
	const child = spawn(service.cmd[0], service.cmd.slice(1), { cwd: root, env: { ...process.env, FORCE_COLOR: "1", ...service.env }, detached: true });
	children.push(child);
	pipe(child.stdout, prefix);
	pipe(child.stderr, prefix);
	child.on("exit", (code, signal) => {
		if (!stopping) process.stdout.write(`${prefix} exited (${signal ?? `code ${code}`}); the others keep running. Ctrl-C stops all.\n`);
	});
}

function stopAll() {
	if (stopping) return;
	stopping = true;
	for (const child of children) {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
	setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
