import ipaddr from "ipaddr.js";

export type UrlPolicy = {
	allowedSchemes: readonly string[];
	allowedPorts: readonly number[];
	allowedHosts: readonly string[];
};

export type Rejection = { ok: false; reason: string; code: RejectionCode };
export type RejectionCode =
	| "malformed_url"
	| "scheme_not_allowed"
	| "credentials_in_url"
	| "port_not_allowed"
	| "non_public_address"
	| "host_not_allowed"
	| "dns_failed";

const MAX_URL_LENGTH = 2048;
const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443 };

export function reject(code: RejectionCode, reason: string): Rejection {
	return { ok: false, code, reason };
}

/**
 * Returns a reason if the address is anything other than public unicast: loopback, private,
 * link-local (including the 169.254.169.254 metadata service), CGNAT, multicast, unspecified,
 * reserved, or IPv6 forms that embed or translate to IPv4 (mapped, 6to4, Teredo, NAT64).
 */
export function nonPublicReason(address: string): string | null {
	let parsed: ipaddr.IPv4 | ipaddr.IPv6;
	try {
		parsed = ipaddr.parse(address);
	} catch {
		return `unparseable address ${address}`;
	}
	if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
		const inner = nonPublicReason((parsed as ipaddr.IPv6).toIPv4Address().toString());
		return inner ? `IPv4-mapped ${inner}` : null;
	}
	const range = parsed.range();
	return range === "unicast" ? null : `${range} address ${parsed.toString()}`;
}

function stripBrackets(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isIpLiteral(hostname: string): boolean {
	return ipaddr.isValid(stripBrackets(hostname));
}

/**
 * Static checks that need no network: syntax, scheme, embedded credentials, port, IP-literal
 * ranges, and the exact-host allowlist. DNS checks happen separately in dns.ts.
 */
export function checkUrlStatic(raw: string, policy: UrlPolicy): { ok: true; url: URL; hostname: string } | Rejection {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
		return reject("malformed_url", "URL is empty or longer than 2048 characters");
	}
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return reject("malformed_url", "URL could not be parsed");
	}

	const scheme = url.protocol.replace(/:$/, "").toLowerCase();
	if (!policy.allowedSchemes.includes(scheme) || !(url.protocol in DEFAULT_PORTS)) {
		return reject("scheme_not_allowed", `scheme "${scheme}" is not allowed; only http and https are fetched`);
	}
	if (url.username || url.password) return reject("credentials_in_url", "URLs with embedded credentials are not allowed");

	const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol]!;
	if (!policy.allowedPorts.includes(port)) return reject("port_not_allowed", `port ${port} is not allowed`);

	// The WHATWG parser already canonicalizes tricks like http://2130706433/ and http://0x7f.1/
	// into dotted IPv4, so a single range check covers them.
	const hostname = stripBrackets(url.hostname.toLowerCase().replace(/\.$/, ""));
	if (isIpLiteral(hostname)) {
		const reason = nonPublicReason(hostname);
		if (reason) return reject("non_public_address", `host is a ${reason}`);
		return reject("host_not_allowed", "IP-address hosts are not allowed; use an allowlisted hostname");
	}
	if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
		return reject("non_public_address", `host ${hostname} is a local-only name`);
	}
	if (!policy.allowedHosts.includes(hostname)) {
		return reject("host_not_allowed", `host ${hostname} is not in fetch_policy.allowed_hosts`);
	}

	url.hash = "";
	return { ok: true, url, hostname };
}
