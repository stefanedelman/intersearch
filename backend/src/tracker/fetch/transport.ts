import type { LookupFunction } from "node:net";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { Agent, request, type Dispatcher } from "undici";
import { resolvePublic, systemResolver, type ResolvedAddress, type Resolver } from "./dns";
import { checkUrlStatic, isIpLiteral, type Rejection, type UrlPolicy } from "./url-policy";

export type TransportLimits = {
	timeoutMs: number;
	maxBytes: number;
	maxRedirects: number;
};

export type FetchSuccess = {
	ok: true;
	status: number;
	finalUrl: string;
	contentType: string;
	body: string;
	bytes: number;
	redirects: number;
	latencyMs: number;
};

export type FetchFailure = {
	ok: false;
	kind: "rejected" | "failed";
	code: string;
	reason: string;
	status?: number;
	transient: boolean;
	finalUrl?: string;
	latencyMs: number;
	redirects: number;
};

export type FetchResult = FetchSuccess | FetchFailure;

export type SourceRoundTrip = {
	url: string;
	startedAt: Date;
	latencyMs: number;
	status: number | "network_error";
	errorCode: string | null;
	redirectHop: number;
};

export type TransportOptions = {
	resolver?: Resolver;
	accept?: string;
	/** Called after validation, immediately before EACH HTTP hop. May throw to stop the run. */
	beforeRequest?: (url: string) => void;
	onRoundTrip?: (trip: SourceRoundTrip) => void;
	/** Test-only injection; runtime callers use the DNS-pinned agent. */
	dispatcher?: Dispatcher;
};

const ACCEPTED_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|application\/json|application\/ld\+json)\b/i;
const USER_AGENT = "IntersearchBot/0.1 (NYU FNMS course project; fetches a few allowlisted public job pages per run)";

/** Static policy + DNS check. Used before connecting and again on every redirect hop. */
export async function checkUrl(
	raw: string,
	policy: UrlPolicy,
	resolver: Resolver = systemResolver,
): Promise<{ ok: true; url: URL; hostname: string; addresses: ResolvedAddress[] } | Rejection> {
	const decision = checkUrlStatic(raw, policy);
	if (!decision.ok) {
		// For a non-allowlisted hostname, still report when it points somewhere internal, so the
		// rejection reason is specific (e.g. a public name that resolves to 127.0.0.1).
		if (decision.code === "host_not_allowed") {
			try {
				const hostname = new URL(raw).hostname;
				if (!isIpLiteral(hostname)) {
					const dns = await resolvePublic(hostname, resolver, 2000);
					if (!dns.ok && dns.code === "non_public_address") return dns;
				}
			} catch {
				// Keep the original rejection.
			}
		}
		return decision;
	}
	const dns = await resolvePublic(decision.hostname, resolver);
	if (!dns.ok) return dns;
	return { ...decision, addresses: dns.addresses };
}

/** A lookup function that can only ever return the addresses we already validated. */
function pinnedLookup(hostname: string, addresses: ResolvedAddress[]): LookupFunction {
	return ((host: string, options: { all?: boolean; family?: number } | number, callback: (...args: unknown[]) => void) => {
		const cb = typeof options === "function" ? (options as (...args: unknown[]) => void) : callback;
		const opts = typeof options === "object" && options ? options : {};
		if (host.toLowerCase() !== hostname) {
			cb(new Error(`unexpected lookup for ${host}`));
			return;
		}
		const family = typeof opts.family === "number" && opts.family !== 0 ? opts.family : undefined;
		const candidates = family ? addresses.filter((entry) => entry.family === family) : addresses;
		if (candidates.length === 0) {
			cb(new Error(`no validated ${family === 6 ? "IPv6" : "IPv4"} address for ${host}`));
			return;
		}
		if (opts.all) cb(null, candidates.map((entry) => ({ address: entry.address, family: entry.family })));
		else cb(null, candidates[0]!.address, candidates[0]!.family);
	}) as unknown as LookupFunction;
}

function decoderFor(encoding: string | undefined): NodeJS.ReadWriteStream | null {
	switch ((encoding ?? "").trim().toLowerCase()) {
		case "":
		case "identity":
			return null;
		case "gzip":
		case "x-gzip":
			return zlib.createGunzip();
		case "deflate":
			return zlib.createInflate();
		case "br":
			return zlib.createBrotliDecompress();
		default:
			throw Object.assign(new Error(`unsupported content-encoding ${encoding}`), { code: "unsupported_encoding" });
	}
}

/** Drops an unread body; undici emits an 'error' on destroy that nothing else would handle. */
function discard(body: { on(event: "error", listener: () => void): unknown; destroy(): unknown }) {
	body.on("error", () => undefined);
	body.destroy();
}

/** Reads at most maxBytes of (decompressed) body; aborts as soon as the limit is crossed. */
async function readLimited(body: Readable, encoding: string | undefined, maxBytes: number): Promise<Buffer> {
	body.on("error", () => undefined);
	const decoder = decoderFor(encoding);
	decoder?.on("error", () => undefined);
	const stream: AsyncIterable<Buffer> = decoder ? (body.pipe(decoder) as unknown as AsyncIterable<Buffer>) : body;
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for await (const chunk of stream) {
			total += chunk.length;
			if (total > maxBytes) {
				throw Object.assign(new Error(`response exceeded ${maxBytes} bytes`), { code: "too_large" });
			}
			chunks.push(chunk);
		}
	} finally {
		body.destroy();
		(decoder as unknown as Readable | null)?.destroy?.();
	}
	return Buffer.concat(chunks);
}

function charsetOf(contentType: string): string {
	const match = contentType.match(/charset=["']?([\w-]+)/i);
	try {
		return new TextDecoder(match?.[1] ?? "utf-8").encoding;
	} catch {
		return "utf-8";
	}
}

function classifyNetworkError(error: unknown): { code: string; reason: string; transient: boolean } {
	const err = error as { code?: string; name?: string; message?: string };
	const code = err.code ?? err.name ?? "network_error";
	if (code === "too_large") return { code: "too_large", reason: err.message ?? "response too large", transient: false };
	if (code === "unsupported_encoding") return { code, reason: err.message ?? code, transient: false };
	if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "TimeoutError" || code === "AbortError") {
		return { code: "timeout", reason: "request timed out", transient: true };
	}
	if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET", "ENOTFOUND"].includes(code)) {
		return { code: code.toLowerCase(), reason: `network error (${code})`, transient: true };
	}
	return { code: "network_error", reason: `network error: ${err.message ?? code}`, transient: true };
}

/**
 * Guarded GET used by fetch_article and the job-board adapter. Every hop is re-validated
 * (scheme, host allowlist, DNS to public addresses only), sockets can only connect to the
 * validated addresses, redirects are followed manually up to a limit, and the body is
 * streamed with a hard byte cap that also applies after decompression.
 */
export async function guardedGet(
	rawUrl: string,
	policy: UrlPolicy,
	limits: TransportLimits,
	options: TransportOptions = {},
): Promise<FetchResult> {
	const started = Date.now();
	const deadline = AbortSignal.timeout(limits.timeoutMs);
	let current = rawUrl;
	let redirects = 0;

	for (;;) {
		const check = await checkUrl(current, policy, options.resolver);
		const elapsed = () => Date.now() - started;
		if (!check.ok) {
			return { ok: false, kind: "rejected", code: check.code, reason: check.reason, transient: false, finalUrl: current, latencyMs: elapsed(), redirects };
		}

		// Keep budget failures outside the network-error catch: they must stop the agent,
		// not turn into a retryable source failure. Redirects pass through this too.
		options.beforeRequest?.(check.url.toString());
		const hopStartedAt = new Date();
		const hopIndex = redirects;
		let hopStatus: SourceRoundTrip["status"] = "network_error";
		let hopError: string | null = null;
		const agent = options.dispatcher ?? new Agent({
			connect: { lookup: pinnedLookup(check.hostname, check.addresses), timeout: limits.timeoutMs },
			headersTimeout: limits.timeoutMs,
			bodyTimeout: limits.timeoutMs,
		});

		try {
			const response = await request(check.url, {
				method: "GET",
				dispatcher: agent,
				signal: deadline,
				headers: {
					"user-agent": USER_AGENT,
					accept: options.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8",
					"accept-encoding": "gzip, deflate, br",
				},
			});
			hopStatus = response.statusCode;

			if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
				discard(response.body);
				if (redirects >= limits.maxRedirects) {
					return { ok: false, kind: "failed", code: "too_many_redirects", reason: `more than ${limits.maxRedirects} redirects`, transient: false, finalUrl: check.url.toString(), latencyMs: elapsed(), redirects };
				}
				const location = Array.isArray(response.headers.location) ? response.headers.location[0]! : response.headers.location;
				current = new URL(location, check.url).toString();
				redirects += 1;
				continue;
			}

			const contentType = String(response.headers["content-type"] ?? "application/octet-stream");
			if (response.statusCode >= 400) {
				discard(response.body);
				const status = response.statusCode;
				const transient = status === 429 || status >= 500;
				const code = status === 404 || status === 410 ? "unavailable" : status === 401 || status === 403 ? "blocked" : status === 429 ? "rate_limited" : "http_error";
				return { ok: false, kind: "failed", code, reason: `HTTP ${status}`, status, transient, finalUrl: check.url.toString(), latencyMs: elapsed(), redirects };
			}
			if (!ACCEPTED_TYPES.test(contentType)) {
				discard(response.body);
				return { ok: false, kind: "rejected", code: "unsupported_content_type", reason: `content type ${contentType.split(";")[0]} is not fetched`, transient: false, finalUrl: check.url.toString(), latencyMs: elapsed(), redirects };
			}
			const declared = Number(response.headers["content-length"]);
			if (Number.isFinite(declared) && declared > limits.maxBytes) {
				discard(response.body);
				return { ok: false, kind: "failed", code: "too_large", reason: `declared size ${declared} exceeds ${limits.maxBytes} bytes`, transient: false, finalUrl: check.url.toString(), latencyMs: elapsed(), redirects };
			}

			const encodingHeader = response.headers["content-encoding"];
			const buffer = await readLimited(response.body as unknown as Readable, Array.isArray(encodingHeader) ? encodingHeader[0] : encodingHeader, limits.maxBytes);
			const body = new TextDecoder(charsetOf(contentType), { fatal: false }).decode(buffer);
			return { ok: true, status: response.statusCode, finalUrl: check.url.toString(), contentType, body, bytes: buffer.length, redirects, latencyMs: elapsed() };
		} catch (error) {
			const classified = classifyNetworkError(error);
			hopError = classified.code;
			return { ok: false, kind: "failed", ...classified, finalUrl: check.url.toString(), latencyMs: elapsed(), redirects };
		} finally {
			options.onRoundTrip?.({ url: check.url.toString(), startedAt: hopStartedAt, latencyMs: Date.now() - hopStartedAt.getTime(), status: hopStatus, errorCode: hopError, redirectHop: hopIndex });
			if (!options.dispatcher) void agent.close().catch(() => undefined);
		}
	}
}

/** Exposed for unit tests of the byte cap and decompression limits. */
export const readLimitedForTest = readLimited;
