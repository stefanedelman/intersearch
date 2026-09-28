// Summarizes a tracker trace for AGENT.md: network round trips per service, where the time went,
// and token/credit usage.
//
//   node scripts/trace-stats.mjs traces/run1.jsonl
//
// Counting convention: every `model`, `http`, and `api` event is exactly one network round trip.
// `tool` events wrap the round trips they caused (linked by parentEventId) and are not counted
// again; `run` and `budget` events are bookkeeping.
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
	console.error("Usage: node scripts/trace-stats.mjs traces/run1.jsonl");
	process.exit(2);
}

const events = fs
	.readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));

const roundTrips = events.filter((event) => ["model", "http", "api"].includes(event.category));
const byService = new Map();
for (const event of roundTrips) {
	const key = event.service ?? event.category;
	const entry = byService.get(key) ?? { trips: 0, errors: 0, latency: [], inputTokens: 0, outputTokens: 0, credits: 0 };
	entry.trips += 1;
	if (!["ok", "200", "201"].includes(String(event.status))) entry.errors += 1;
	if (typeof event.latencyMs === "number") entry.latency.push(event.latencyMs);
	entry.inputTokens += event.inputTokens ?? 0;
	entry.outputTokens += event.outputTokens ?? 0;
	entry.credits += event.searchCredits ?? 0;
	byService.set(key, entry);
}

const sum = (values) => values.reduce((total, value) => total + value, 0);
const pct = (values, p) => {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

const started = events.map((event) => Date.parse(event.startedAt)).filter(Number.isFinite);
const wall = started.length ? Math.max(...events.map((event) => Date.parse(event.startedAt) + (event.latencyMs ?? 0))) - Math.min(...started) : 0;

console.log(`Trace: ${file}`);
console.log(`Events: ${events.length}; network round trips: ${roundTrips.length}; wall clock: ${(wall / 1000).toFixed(1)} s\n`);
console.log("service                          trips  errors  total s   median ms  p90 ms   tokens in/out     credits");
const rows = [...byService.entries()].sort((a, b) => sum(b[1].latency) - sum(a[1].latency));
for (const [service, entry] of rows) {
	console.log(
		`${service.padEnd(32)} ${String(entry.trips).padStart(5)}  ${String(entry.errors).padStart(6)}  ${(sum(entry.latency) / 1000).toFixed(1).padStart(7)}   ${String(pct(entry.latency, 50)).padStart(8)}  ${String(pct(entry.latency, 90)).padStart(6)}   ${`${entry.inputTokens}/${entry.outputTokens}`.padStart(14)}  ${String(entry.credits).padStart(8)}`,
	);
}
const totalLatency = sum(rows.map(([, entry]) => sum(entry.latency)));
console.log(`\nSum of round-trip latencies: ${(totalLatency / 1000).toFixed(1)} s (calls are sequential, so this approximates time spent waiting on the network).`);
const retries = events.filter((event) => event.category === "budget" && event.status === "retry");
if (retries.length) console.log(`Retries: ${retries.length} (${retries.map((event) => event.errorCode).join(", ")})`);
const stop = events.findLast?.((event) => event.category === "run" && event.status !== "started");
if (stop) console.log(`Outcome: ${stop.status}${stop.detail?.stopReason ? ` (${stop.detail.stopReason})` : ""}`);
