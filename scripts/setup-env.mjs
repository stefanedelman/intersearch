// Creates or completes backend/.env.local (ignored by git):
// - provider-key slots (GROQ_API_KEY, TAVILY_API_KEY, VERIFIER_GROQ_API_KEY, VERIFIER_MODEL), left empty;
// - the two service tokens (RESEARCHER_TOKEN, VERIFIER_TOKEN), generated if missing.
// Existing values are never changed, and no secret is printed.
//
//   node scripts/setup-env.mjs            (run by `npm run setup`)
//   SETUP_ENV_FILE=/tmp/x.env node scripts/setup-env.mjs   (another file, for testing)
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.env.SETUP_ENV_FILE ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "backend", ".env.local");
const relative = process.env.SETUP_ENV_FILE ? target : "backend/.env.local";

const SLOTS = [
	{ key: "GROQ_API_KEY", comment: "Researcher model key: https://console.groq.com/keys" },
	{ key: "TAVILY_API_KEY", comment: "Researcher web search: https://app.tavily.com" },
	{ key: "RESEARCHER_TOKEN", comment: "Service token the API sends to the researcher (generated).", generate: true },
	{ key: "VERIFIER_TOKEN", comment: "Service token the API sends to the verifier (generated). Set the same value in Render.", generate: true },
	{ key: "VERIFIER_GROQ_API_KEY", comment: "Only for a local verifier (npm run dev:verifier); on Render it lives in the service's environment." },
	{ key: "VERIFIER_MODEL", comment: "Only for a local verifier: a different Groq model id from the researcher's." },
];

const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
const present = new Set((existing ?? "").split("\n").map((line) => /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1]).filter(Boolean));
const missing = SLOTS.filter((slot) => !present.has(slot.key));

if (missing.length === 0) {
	console.log(`${relative} already has every key; leaving it unchanged.`);
	process.exit(0);
}

const lines = [];
if (existing === null) lines.push("# Local secrets. Never commit this file.");
else lines.push("", `# Added by scripts/setup-env.mjs on ${new Date().toISOString().slice(0, 10)}`);
for (const slot of missing) {
	lines.push(`# ${slot.comment}`);
	lines.push(`${slot.key}=${slot.generate ? randomBytes(32).toString("hex") : ""}`);
}
const text = `${lines.join("\n")}\n`;

if (existing === null) fs.writeFileSync(target, text, { mode: 0o600 });
else fs.appendFileSync(target, (existing.endsWith("\n") ? "" : "\n") + text);
fs.chmodSync(target, 0o600);

const generated = missing.filter((slot) => slot.generate).map((slot) => slot.key);
const empty = missing.filter((slot) => !slot.generate).map((slot) => slot.key);
console.log(`${existing === null ? "Created" : "Updated"} ${relative}.`);
if (generated.length) console.log(`  generated: ${generated.join(", ")}`);
if (empty.length) console.log(`  to fill in: ${empty.join(", ")}`);
