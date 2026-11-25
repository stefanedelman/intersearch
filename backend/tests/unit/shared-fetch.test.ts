import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent } from "undici";
import { checkUrlStatic, publicWebPolicy } from "../../src/shared/fetch/url-policy";
import { checkUrl, guardedGet } from "../../src/shared/fetch/transport";
import { checkEvidence, normalizeEvidence } from "../../src/shared/normalize-evidence";

const verifier = publicWebPolicy();
const limits = { timeoutMs: 2000, maxBytes: 100_000, maxRedirects: 3 };
const publicAnswer = async () => [{ address: "104.18.0.1", family: 4 as const }];

describe("verifier policy: any public host", () => {
	test("accepts arbitrary public hostnames and public IP literals", () => {
		assert.equal(checkUrlStatic("https://news.example.org/2027/internships", verifier).ok, true);
		assert.equal(checkUrlStatic("http://8.8.8.8/", verifier).ok, true);
		assert.equal(checkUrlStatic("http://[2606:4700::6810:1]/", verifier).ok, true);
	});

	for (const [url, pattern] of [
		["http://169.254.169.254/", /linkLocal/],
		["http://169.254.169.254/latest/meta-data/iam/security-credentials/", /linkLocal/],
		["http://localhost/", /local-only/],
		["http://LOCALHOST./", /local-only/],
		["http://api.localhost/", /local-only/],
		["http://metadata.google.internal/", /local-only/],
		["http://printer.local/", /local-only/],
		["http://127.0.0.1/", /loopback/],
		["http://2130706433/", /loopback/],
		["http://0.0.0.0/", /unspecified/],
		["http://10.1.2.3/", /private/],
		["http://[::1]/", /loopback/],
		["http://[::]/", /unspecified/],
		["http://[fc00::1]/", /uniqueLocal/],
		["http://[fd12:3456::1]/", /uniqueLocal/],
		["http://[fe80::1]/", /linkLocal/],
		["http://[::ffff:169.254.169.254]/", /IPv4-mapped linkLocal/],
		["ftp://example.org/x", /scheme "ftp"/],
		["file:///etc/passwd", /scheme "file"/],
		["https://user:pw@example.org/", /credentials/],
		["https://example.org:8443/", /port 8443/],
	] as const) {
		test(`still rejects ${url}`, () => {
			const result = checkUrlStatic(url, verifier);
			assert.equal(result.ok, false);
			if (!result.ok) assert.match(result.reason, pattern);
		});
	}

	test("resolves the hostname and checks the address itself, not only the URL text", async () => {
		for (const address of ["169.254.169.254", "127.0.0.1", "10.0.0.7", "::1", "fd00::5", "fe80::9"]) {
			const result = await checkUrl("https://innocent.example.org/job", verifier, async () => [{ address, family: address.includes(":") ? 6 : 4 }]);
			assert.equal(result.ok, false, address);
			if (!result.ok) assert.equal(result.code, "non_public_address", address);
		}
	});
});

describe("guarded fetch: redirects and the caller's deadline", () => {
	test("a public URL that redirects to the metadata address is stopped at the hop, before connecting", async () => {
		const mock = new MockAgent();
		mock.disableNetConnect();
		mock.get("https://innocent.example.org").intercept({ path: "/job" }).reply(302, "", { headers: { location: "http://169.254.169.254/latest/meta-data/" } });
		let metadataContacted = false;
		mock.get("http://169.254.169.254").intercept({ path: "/latest/meta-data/" }).reply(() => {
			metadataContacted = true;
			return { statusCode: 200, data: "secret" };
		});
		const hops: string[] = [];
		try {
			const result = await guardedGet("https://innocent.example.org/job", verifier, limits, { dispatcher: mock, resolver: publicAnswer, onRoundTrip: (trip) => hops.push(trip.url) });
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.kind, "rejected");
				assert.equal(result.code, "non_public_address");
				assert.equal(result.redirects, 1);
			}
			assert.equal(metadataContacted, false);
			assert.deepEqual(hops, ["https://innocent.example.org/job"]);
		} finally {
			await mock.close();
		}
	});

	test("a redirect to a hostname that resolves to a private address is stopped too (re-resolved per hop)", async () => {
		const mock = new MockAgent();
		mock.disableNetConnect();
		mock.get("https://innocent.example.org").intercept({ path: "/job" }).reply(301, "", { headers: { location: "https://rebind.example.net/admin" } });
		const resolver = async (host: string) => [{ address: host === "rebind.example.net" ? "192.168.0.10" : "104.18.0.1", family: 4 as const }];
		try {
			const result = await guardedGet("https://innocent.example.org/job", verifier, limits, { dispatcher: mock, resolver });
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.code, "non_public_address");
		} finally {
			await mock.close();
		}
	});

	test("the redirect cap applies", async () => {
		const mock = new MockAgent();
		mock.disableNetConnect();
		for (let i = 0; i < 4; i += 1) mock.get("https://loop.example.org").intercept({ path: `/${i}` }).reply(302, "", { headers: { location: `/${i + 1}` } });
		try {
			const result = await guardedGet("https://loop.example.org/0", verifier, { ...limits, maxRedirects: 3 }, { dispatcher: mock, resolver: publicAnswer });
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.code, "too_many_redirects");
		} finally {
			await mock.close();
		}
	});

	test("a guard rejection makes no request at all", async () => {
		const mock = new MockAgent();
		mock.disableNetConnect();
		const hops: string[] = [];
		try {
			const result = await guardedGet("http://localhost/", verifier, limits, { dispatcher: mock, resolver: publicAnswer, onRoundTrip: (trip) => hops.push(trip.url) });
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.kind, "rejected");
			assert.deepEqual(hops, []);
		} finally {
			await mock.close();
		}
	});

	test("an already-expired caller deadline stops before any lookup or request", async () => {
		let lookedUp = false;
		const result = await guardedGet("https://news.example.org/", verifier, limits, {
			signal: AbortSignal.abort(),
			resolver: async () => {
				lookedUp = true;
				return [{ address: "104.18.0.1", family: 4 }];
			},
		});
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, "aborted");
			assert.equal(result.transient, false);
		}
		assert.equal(lookedUp, false);
	});

	test("the caller's deadline aborts a slow response", async () => {
		const mock = new MockAgent();
		mock.disableNetConnect();
		mock.get("https://slow.example.org").intercept({ path: "/" }).reply(200, "late", { headers: { "content-type": "text/plain" } }).delay(1500);
		try {
			const started = Date.now();
			const result = await guardedGet("https://slow.example.org/", verifier, { ...limits, timeoutMs: 10_000 }, { dispatcher: mock, resolver: publicAnswer, signal: AbortSignal.timeout(100) });
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.code, "aborted");
			assert.ok(Date.now() - started < 1400, "returned before the response arrived");
		} finally {
			await mock.close();
		}
	});

	test("the researcher's allowlist policy is unchanged: other hosts are still refused", () => {
		const allowlist = { allowedSchemes: ["http", "https"], allowedPorts: [80, 443], allowedHosts: ["stripe.com"] };
		assert.equal(checkUrlStatic("https://stripe.com/jobs", allowlist).ok, true);
		const other = checkUrlStatic("https://news.example.org/", allowlist);
		assert.equal(other.ok, false);
		if (!other.ok) assert.equal(other.code, "host_not_allowed");
		const ip = checkUrlStatic("http://8.8.8.8/", allowlist);
		assert.equal(ip.ok, false);
		if (!ip.ok) assert.equal(ip.code, "host_not_allowed");
	});
});

describe("evidence normalisation (spec §9)", () => {
	test("applies the four steps in order", () => {
		assert.equal(normalizeEvidence("Tom &amp; Jerry"), "tom & jerry");
		assert.equal(normalizeEvidence("it&#x27;s &#39;here&#39;"), "it's 'here'");
		assert.equal(normalizeEvidence("New&nbsp;York,\n\t  NY"), "new york, ny", "&nbsp; decodes to U+00A0, which is whitespace and collapses");
		assert.equal(normalizeEvidence("ＦＵＬＬ ｗｉｄｔｈ"), "full width", "NFKC folds fullwidth letters");
		assert.equal(normalizeEvidence("eﬃcient"), "efficient", "NFKC expands the ligature");
		assert.equal(normalizeEvidence("PAY: $55 — $55"), "pay: $55 — $55", "thin spaces are whitespace");
	});

	test("decodes entities before NFKC, so an encoded fullwidth letter is folded too", () => {
		assert.equal(normalizeEvidence("&#xFF21;BC"), "abc");
	});

	test("does not touch punctuation the spec does not mention", () => {
		assert.notEqual(normalizeEvidence("“quoted”"), normalizeEvidence('"quoted"'));
		assert.notEqual(normalizeEvidence("a–b"), normalizeEvidence("a-b"));
	});
});

describe("evidence check", () => {
	const page = "<p>The Software Engineering Intern (Summer 2027) role is based in New&nbsp;York, NY.</p>\n\nPay:  $55 &mdash; $55 USD per hour.";

	test("an excerpt that appears in the page passes, despite case, entities, and spacing", () => {
		assert.deepEqual(checkEvidence("based in New York, NY", page), { ok: true });
		assert.deepEqual(checkEvidence("PAY: $55 — $55 USD", page), { ok: true });
		assert.deepEqual(checkEvidence("  software engineering intern  ", page), { ok: true });
	});

	test("a fabricated or paraphrased excerpt fails", () => {
		assert.deepEqual(checkEvidence("based in San Francisco, CA", page), { ok: false, reason: "not_found" });
		assert.deepEqual(checkEvidence("located in New York", page), { ok: false, reason: "not_found" });
	});

	test("an excerpt over 300 characters fails even if it appears", () => {
		const long = "x".repeat(301);
		assert.deepEqual(checkEvidence(long, long), { ok: false, reason: "too_long" });
		assert.deepEqual(checkEvidence("x".repeat(300), long), { ok: true });
	});

	test("an empty or whitespace-only excerpt fails", () => {
		assert.deepEqual(checkEvidence("", page), { ok: false, reason: "empty" });
		assert.deepEqual(checkEvidence(" \n ", page), { ok: false, reason: "empty" });
	});
});
