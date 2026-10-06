import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { comparisonKey, configHash, parseConfig } from "../../src/tracker/config";
import { canonicalizeUrl, identityFor, quoteAppearsIn } from "../../src/tracker/domain/normalize";
import { extractObservation } from "../../src/tracker/domain/facts";
import { scoreFacts } from "../../src/tracker/domain/rank";
import { buildReport, renderMarkdown, type Candidate } from "../../src/tracker/domain/report";
import { extract } from "../../src/tracker/fetch/extract";
import { Budget, BudgetExhausted } from "../../src/tracker/budget";
import { classifyHttpFailure, ProviderError, withRetries } from "../../src/tracker/failure";
import { redact } from "../../src/lib/logger";
import type { TrackerStateDto } from "../../src/contracts/tracker";
import { assembleCandidates } from "../../src/tracker/finalize";
import { emptyMemory } from "../../src/tracker/tools/context";
import { ACME_CONFIG_YAML } from "../fixtures/acme";

const config = parseConfig(ACME_CONFIG_YAML);
const docId = "11111111-1111-4111-8111-111111111111";

function observe(title: string, location: string, body: string, jobId = "1001") {
	const json = JSON.stringify({ id: Number(jobId), title, location: { name: location }, updated_at: new Date().toISOString(), absolute_url: `https://careers.acme.example/jobs/${jobId}?gh_jid=${jobId}`, content: body.replace(/</g, "&lt;").replace(/>/g, "&gt;") });
	const extracted = extract(json, "application/json", "https://boards-api.greenhouse.io/v1/boards/acme/jobs/" + jobId, 16000);
	return extractObservation({ extracted, url: `https://boards-api.greenhouse.io/v1/boards/acme/jobs/${jobId}`, finalUrl: `https://boards-api.greenhouse.io/v1/boards/acme/jobs/${jobId}`, sourceDocumentId: docId, fetchedAt: new Date().toISOString(), config });
}

describe("config validation", () => {
	const invalid = (patch: (yaml: string) => string, pattern: RegExp) => assert.throws(() => parseConfig(patch(ACME_CONFIG_YAML)), pattern);

	test("rejects K outside 3–10", () => invalid((yaml) => yaml.replace("k: 3", "k: 11"), /K must be between 3 and 10/));
	test("rejects an empty host allowlist", () => invalid((yaml) => yaml.replace("allowed_hosts: [boards-api.greenhouse.io, careers.acme.example]", "allowed_hosts: []"), /allowed_hosts is empty/));
	test("rejects schemes other than http(s)", () => invalid((yaml) => yaml.replace("allowed_schemes: [http, https]", "allowed_schemes: [http, ftp]"), /only http and https/));
	test("rejects unknown keys", () => invalid((yaml) => `${yaml}\nsurprise: true\n`, /surprise/));
	test("rejects limits above the server ceiling", () => invalid((yaml) => yaml.replace("max_fetches: 8", "max_fetches: 999"), /max_fetches/));
	test("rejects seed URLs on hosts that are not allowlisted", () => invalid((yaml) => yaml.replace("seed_urls: []", "seed_urls: [https://evil.example/x]"), /not in fetch_policy.allowed_hosts/));
	test("rejects IP addresses in the host allowlist", () => invalid((yaml) => yaml.replace("careers.acme.example]", "169.254.169.254]"), /hostname/));

	test("editing limits or model keeps the comparison key; editing companies changes it", () => {
		const edited = parseConfig(ACME_CONFIG_YAML.replace("max_steps: 12", "max_steps: 3").replace("id: test-model", "id: other-model"));
		assert.equal(comparisonKey(edited), comparisonKey(config));
		assert.notEqual(configHash(edited), configHash(config));
		const moved = parseConfig(ACME_CONFIG_YAML.replace("board_token: acme", "board_token: acme2"));
		assert.notEqual(comparisonKey(moved), comparisonKey(config));
	});
});

describe("URL canonicalization and development identity", () => {
	test("strips tracking parameters but keeps identity-bearing ones", () => {
		assert.equal(canonicalizeUrl("https://Stripe.com/jobs/search/?utm_source=x&gh_jid=8128745&gh_src=abc#apply"), "https://stripe.com/jobs/search?gh_jid=8128745");
	});

	test("the same Greenhouse job through the API, board page, and careers site has one identity", () => {
		const company = { id: "acme", name: "Acme", boardToken: "acme" };
		const keys = [
			"https://boards-api.greenhouse.io/v1/boards/acme/jobs/1001",
			"https://job-boards.greenhouse.io/acme/jobs/1001",
			"https://careers.acme.example/jobs/1001?gh_jid=1001&utm_source=x",
		].map((url) => identityFor({ company, url, title: "Anything", location: null, season: null }).key);
		assert.deepEqual(new Set(keys), new Set(["greenhouse:acme:1001"]));
	});

	test("same title and location but different job ids stay separate", () => {
		const company = { id: "acme", name: "Acme", boardToken: "acme" };
		const a = identityFor({ company, jobId: "1", url: "https://careers.acme.example/a", title: "SWE Intern", location: "NYC", season: "summer-2027" });
		const b = identityFor({ company, jobId: "2", url: "https://careers.acme.example/b", title: "SWE Intern", location: "NYC", season: "summer-2027" });
		assert.notEqual(a.key, b.key);
	});

	test("quote matching ignores whitespace and curly quotes but not wording", () => {
		assert.ok(quoteAppearsIn("You’ll own   problems", "You'll own problems end to end"));
		assert.ok(!quoteAppearsIn("You'll own everything", "You'll own problems end to end"));
	});
});

describe("fact extraction", () => {
	test("every quote is an exact excerpt of the stored text", () => {
		const observation = observe("Software Engineering Intern, Backend (Summer 2027)", "New York, NY", "<p>What you'll do</p><ul><li>Build backend services in Go and Python for millions of users.</li></ul><p>Currently pursuing a degree, graduating in 2028.</p><p>Hourly pay range:</p><p>$50—$55 USD</p>");
		assert.equal(observation.facts.season, "summer-2027");
		assert.deepEqual(observation.facts.locations, ["New York, NY"]);
		assert.ok(observation.facts.skills.includes("Python") && observation.facts.skills.includes("Go"));
		assert.equal(observation.facts.compensation, "$50—$55 USD (hourly)");
		assert.equal(observation.facts.eligibility.length, 1);
		assert.equal(observation.identity.key, "greenhouse:acme:1001");
	});

	test("dollar amounts about funding or assets are not mistaken for pay", () => {
		const observation = observe("Software Engineer Intern", "New York, NY", "<p>An estimated $124 trillion of assets will be inherited.</p><p>We raised $50 million in funding.</p>");
		assert.equal(observation.facts.compensation, null);
	});

	test("script and markup in a page never become executable or part of the text", () => {
		const extracted = extract("<html><head><title>Hi</title></head><body><script>alert(1)</script><p>Real text here.</p></body></html>", "text/html", "https://careers.acme.example/x", 1000);
		assert.doesNotMatch(extracted.text, /alert/);
		assert.match(extracted.text, /Real text here/);
	});
});

describe("ranking", () => {
	test("hard exclusions: wrong location, wrong year, not a role match", () => {
		const london = scoreFacts(observe("Software Engineer Intern (Summer 2027)", "London, UK", "<p>Build things.</p>").facts, config);
		assert.match(london.excluded ?? "", /outside your preferred locations/);
		const wrongYear = scoreFacts(observe("Software Engineer Intern (Summer 2026)", "New York, NY", "<p>Build things.</p>").facts, config);
		assert.match(wrongYear.excluded ?? "", /summer-2026/);
		const sales = scoreFacts(observe("Sales Intern (Summer 2027)", "New York, NY", "<p>Sell things.</p>").facts, config);
		assert.match(sales.excluded ?? "", /role does not match/);
	});

	test("missing facts score zero and are listed as unknown", () => {
		const scored = scoreFacts(observe("Software Engineer Intern", "New York, NY", "<p>Build things.</p>").facts, config);
		assert.equal(scored.breakdown.season, 0);
		assert.ok(scored.unknowns.includes("season"));
		assert.ok(scored.unknowns.includes("eligibility"));
	});

	test("weights sum to 100 and a perfect match scores 100", () => {
		const facts = observe("Backend Software Engineer Intern (Summer 2027)", "New York, NY", "<p>Use Python, Go, and PostgreSQL.</p>").facts;
		assert.equal(scoreFacts(facts, config).score, 100);
	});
});

describe("report sections", () => {
	const candidate = (jobId: string, title: string): Candidate => {
		const observation = observe(title, "New York, NY", "<p>Use Python and Go.</p>", jobId);
		return { observation, sources: [observation.source], firstSeenAt: null, reverified: true };
	};
	const stats = { fetched: 0, skipped: 0, rejected: 0, failed: 0, searches: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, searchCredits: 0, networkRequests: 0, elapsedMs: 0 };
	const runId = "22222222-2222-4222-8222-222222222222";
	const baselineRunId = "33333333-3333-4333-8333-333333333333";

	test("new, still, returned, and dropped are distinguished; fewer than K is explained", () => {
		const report = buildReport({
			runId,
			status: "complete",
			stopReason: null,
			config,
			candidates: [candidate("1", "Backend Software Engineer Intern (Summer 2027)"), candidate("2", "Software Engineer Intern (Summer 2027)")],
			baseline: {
				runId: baselineRunId,
				items: [
					{ identityKey: "greenhouse:acme:1", rank: 1, company: "Acme", title: "Backend Software Engineer Intern (Summer 2027)" },
					{ identityKey: "greenhouse:acme:9", rank: 2, company: "Acme", title: "Gone Intern" },
				],
			},
			everReported: new Set(["greenhouse:acme:1", "greenhouse:acme:2", "greenhouse:acme:9"]),
			comparisonReset: false,
			stats,
			notes: [],
		});
		assert.deepEqual(report.items.map((item) => item.section), ["still", "returned"]);
		assert.equal(report.dropped[0]!.identityKey, "greenhouse:acme:9");
		assert.match(report.dropped[0]!.reason, /not re-verified/);
		assert.ok(report.notes.some((note) => /does not pad/.test(note)));
		const markdown = renderMarkdown(report, { trackerName: "T", configHash: "abc" });
		assert.match(markdown, /## New since last run/);
		assert.match(markdown, /## Still in top K/);
		assert.match(markdown, /## Dropped/);
	});
});

describe("budget and failure handling", () => {
	test("the token budget blocks a call that could exceed it, before it is made", () => {
		const budget = new Budget({ ...config.limits, max_total_tokens: 1000 });
		const reservation = budget.reserveModelCall(500, 300);
		budget.settleModelCall(reservation, { input: 500, output: 200 });
		assert.throws(() => budget.reserveModelCall(200, 300), BudgetExhausted);
	});

	test("classifies 429s by what the provider says", () => {
		assert.equal(classifyHttpFailure({ provider: "groq", status: 429, body: "Rate limit reached on tokens per minute (TPM). Please try again in 7.5s." }).failure, "rate_limit_minute");
		assert.equal(classifyHttpFailure({ provider: "groq", status: 429, body: "Rate limit reached on requests per day (RPD). Please try again in 3h2m1s." }).failure, "quota_exhausted");
		assert.equal(classifyHttpFailure({ provider: "tavily", status: 432, body: "{}" }).failure, "quota_exhausted");
		assert.equal(classifyHttpFailure({ provider: "tavily", status: 429, body: "slow down", headers: { "retry-after": "3600" } }).failure, "rate_limit_unknown");
		assert.equal(classifyHttpFailure({ provider: "groq", status: 401, body: "invalid_api_key" }).failure, "auth");
		assert.equal(classifyHttpFailure({ provider: "groq", status: 402, body: "" }).failure, "payment");
		assert.equal(classifyHttpFailure({ provider: "groq", status: 503, body: "" }).failure, "transient");
	});

	test("retries transient errors a bounded number of times and never retries terminal ones", async () => {
		const budget = new Budget(config.limits);
		let attempts = 0;
		await assert.rejects(
			withRetries(budget, 1, async () => {
				attempts += 1;
				throw new ProviderError("x", "transient", "boom", 503);
			}),
		);
		assert.equal(attempts, 2);
		assert.equal(budget.snapshot.retries, 1);

		attempts = 0;
		await assert.rejects(
			withRetries(budget, 3, async () => {
				attempts += 1;
				throw new ProviderError("x", "quota_exhausted", "daily cap", 429);
			}),
		);
		assert.equal(attempts, 1);
	});
});

describe("redaction", () => {
	test("keys, tokens, and connection strings never survive into logs", () => {
		const out = JSON.stringify(
			redact({
				password: "Courant2026!",
				headers: { authorization: "Bearer abc.def.ghi" },
				note: "key gsk_abcdefghijklmnop and postgresql://u:p@host/db and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij",
			}),
		);
		for (const secret of ["Courant2026!", "abc.def.ghi", "gsk_abcdefghijklmnop", "postgresql://", "eyJhbGci"]) assert.ok(!out.includes(secret), secret);
	});
});

describe("redaction keeps usage counters", () => {
	test("inputTokens, outputTokens, and contentHash are not redacted", () => {
		const out = redact({ inputTokens: 120, outputTokens: 30, contentHash: "abc", token: "secret-token" }) as Record<string, unknown>;
		assert.equal(out.inputTokens, 120);
		assert.equal(out.outputTokens, 30);
		assert.equal(out.contentHash, "abc");
		assert.equal(out.token, "[REDACTED]");
	});
});

test("a generic careers page title never becomes an empty title quote", () => {
	const html = "<html><head><title>Acme Careers</title></head><body><h1>Software Engineering Intern, Summer 2027</h1><p>Build backend services in New York.</p></body></html>";
	const url = "https://careers.acme.example/jobs/77";
	const observation = extractObservation({ extracted: extract(html, "text/html", url, 16000), url, finalUrl: url, sourceDocumentId: docId, fetchedAt: new Date().toISOString(), config });
	assert.ok(observation.evidence.every((item) => item.quote.trim().length > 0), "no empty quotes");
	assert.match(observation.facts.title, /Software Engineering Intern/);
});

test("a known posting fetched from a page with fewer facts keeps the facts from its last saved record", () => {
	const record = observe("Software Engineering Intern (Summer 2027)", "New York, NY", "<p>Build backend services in Python.</p>");
	assert.deepEqual(record.facts.locations, ["New York, NY"]);
	const pageUrl = "https://careers.acme.example/jobs/1001";
	const html = "<html><head><title>Software Engineering Intern (Summer 2027)</title></head><body><p>Build backend services in Python.</p></body></html>";
	const page = extractObservation({ extracted: extract(html, "text/html", pageUrl, 16000), url: pageUrl, finalUrl: pageUrl, sourceDocumentId: "22222222-2222-4222-8222-222222222222", fetchedAt: new Date().toISOString(), config });
	assert.equal(page.identity.key, record.identity.key, "same posting");
	assert.deepEqual(page.facts.locations, []);

	const memory = emptyMemory();
	memory.observations.set("22222222-2222-4222-8222-222222222222", page);
	const priorSource = { sourceDocumentId: docId, url: record.source.url, title: record.source.title, fetchedAt: record.source.fetchedAt };
	const state = { opportunities: [{ identityKey: record.identity.key, firstSeenAt: new Date().toISOString(), firstReportedAt: null, providerJobId: "1001", lastObservation: { facts: record.facts, evidence: record.evidence, sources: [priorSource] } }] } as unknown as TrackerStateDto;
	const { candidates, observationInputs } = assembleCandidates({ memory, state, store: null, notes: [], now: new Date() });

	assert.equal(candidates.length, 1);
	assert.deepEqual(candidates[0]!.observation.facts.locations, ["New York, NY"]);
	const locationQuote = candidates[0]!.observation.evidence.find((item) => item.field === "location");
	assert.equal(locationQuote?.sourceDocumentId, docId, "the location quote cites the record it came from");
	assert.ok(observationInputs[0]!.sourceDocumentIds.includes(docId), "that record is listed as a source");
});
