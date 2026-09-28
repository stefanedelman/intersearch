import { describe, test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { checkUrlStatic, nonPublicReason } from "../../src/tracker/fetch/url-policy";
import { resolvePublic } from "../../src/tracker/fetch/dns";
import { checkUrl, guardedGet } from "../../src/tracker/fetch/transport";

const policy = { allowedSchemes: ["http", "https"], allowedPorts: [80, 443], allowedHosts: ["boards-api.greenhouse.io", "stripe.com"] };
const publicResolver = async () => [{ address: "104.18.0.1", family: 4 as const }];

describe("URL policy (no network)", () => {
	for (const [url, pattern] of [
		["file:///etc/passwd", /scheme "file"/],
		["ftp://stripe.com/x", /scheme "ftp"/],
		["data:text/html,<script>alert(1)</script>", /scheme "data"/],
		["javascript:alert(1)", /scheme "javascript"/],
		["gopher://stripe.com/", /scheme/],
		["https://user:pass@stripe.com/jobs", /credentials/],
		["https://stripe.com:8443/jobs", /port 8443/],
		["http://127.0.0.1/", /loopback/],
		["http://2130706433/", /loopback/],
		["http://0x7f.0.0.1/", /loopback/],
		["http://[::1]/", /loopback/],
		["http://[::ffff:127.0.0.1]/", /IPv4-mapped loopback/],
		["http://10.0.0.5/", /private/],
		["http://192.168.1.1/", /private/],
		["http://172.16.0.1/", /private/],
		["http://169.254.169.254/latest/meta-data", /linkLocal/],
		["http://100.64.0.1/", /carrierGradeNat/],
		["http://0.0.0.0/", /unspecified/],
		["http://[fe80::1]/", /linkLocal/],
		["http://[fc00::1]/", /uniqueLocal/],
		["http://localhost:80/", /local-only/],
		["http://metadata.google.internal/", /local-only/],
		["https://boards-api.greenhouse.io.evil.com/", /not in fetch_policy.allowed_hosts/],
		["https://evilstripe.com/", /not in fetch_policy.allowed_hosts/],
		["https://8.8.8.8/", /IP-address hosts are not allowed/],
		["not a url", /could not be parsed/],
	] as const) {
		test(`rejects ${url}`, () => {
			const result = checkUrlStatic(url, policy);
			assert.equal(result.ok, false);
			if (!result.ok) assert.match(result.reason, pattern);
		});
	}

	test("accepts allowlisted http and https hosts, ignoring case and trailing dots", () => {
		assert.equal(checkUrlStatic("https://STRIPE.com./jobs?gh_jid=1", policy).ok, true);
		assert.equal(checkUrlStatic("http://stripe.com/jobs", policy).ok, true);
	});

	test("classifies public unicast addresses as public", () => {
		assert.equal(nonPublicReason("104.18.0.1"), null);
		assert.equal(nonPublicReason("2606:4700::6810:1"), null);
		assert.match(nonPublicReason("64:ff9b::7f00:1") ?? "", /rfc6052/);
	});
});

describe("DNS validation", () => {
	test("rejects when ANY answer is private (mixed public/private)", async () => {
		const result = await resolvePublic("stripe.com", async () => [
			{ address: "104.18.0.1", family: 4 },
			{ address: "10.0.0.7", family: 4 },
		]);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /private/);
	});

	test("rejects IPv6 loopback and IPv4-mapped private answers", async () => {
		const v6 = await resolvePublic("stripe.com", async () => [{ address: "::1", family: 6 }]);
		const mapped = await resolvePublic("stripe.com", async () => [{ address: "::ffff:192.168.0.1", family: 6 }]);
		assert.equal(v6.ok, false);
		assert.equal(mapped.ok, false);
	});

	test("accepts all-public answers and returns them for pinning", async () => {
		const result = await resolvePublic("stripe.com", publicResolver);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.addresses, [{ address: "104.18.0.1", family: 4 }]);
	});

	test("an allowlisted name that resolves to a private address is rejected before connecting", async () => {
		const result = await checkUrl("https://stripe.com/jobs", policy, async () => [{ address: "127.0.0.1", family: 4 }]);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "non_public_address");
		const fetched = await guardedGet("https://stripe.com/jobs", policy, { timeoutMs: 2000, maxBytes: 1000, maxRedirects: 1 }, { resolver: async () => [{ address: "169.254.169.254", family: 4 }] });
		assert.equal(fetched.ok, false);
		if (!fetched.ok) assert.equal(fetched.kind, "rejected");
	});

	test("DNS failures are reported, not thrown", async () => {
		const result = await resolvePublic("stripe.com", async () => {
			throw new Error("ENOTFOUND");
		});
		assert.equal(result.ok, false);
	});
});

describe("body limits", async () => {
	const { readLimitedForTest } = await import("../../src/tracker/fetch/transport");

	test("stops a decompression bomb at the byte cap (decompressed size counts)", async () => {
		const bomb = zlib.gzipSync(Buffer.alloc(5_000_000, 0));
		assert.ok(bomb.length < 10_000, "the compressed payload is tiny");
		await assert.rejects(readLimitedForTest(Readable.from([bomb]), "gzip", 1_000_000), /exceeded 1000000 bytes/);
	});

	test("stops an oversized chunked body without Content-Length", async () => {
		const chunks = Array.from({ length: 50 }, () => Buffer.alloc(100_000, 97));
		await assert.rejects(readLimitedForTest(Readable.from(chunks), undefined, 1_000_000), /exceeded/);
	});

	test("reads a body under the cap", async () => {
		const body = await readLimitedForTest(Readable.from([Buffer.from("hello")]), "identity", 1000);
		assert.equal(body.toString(), "hello");
	});

	test("refuses unknown content encodings", async () => {
		await assert.rejects(readLimitedForTest(Readable.from([Buffer.from("x")]), "compress", 1000), /unsupported content-encoding/);
	});
});
