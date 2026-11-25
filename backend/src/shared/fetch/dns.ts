import dns from "node:dns";
import { nonPublicReason, reject, type Rejection } from "./url-policy";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
	const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
	return results.map((result) => ({ address: result.address, family: result.family === 6 ? 6 : 4 }));
};

/**
 * Resolves every A/AAAA answer and rejects the host if ANY answer is non-public, so a mixed
 * public/private answer cannot be used to reach an internal service. The returned addresses are
 * the only ones the transport may connect to (DNS pinning), which closes the rebinding gap between
 * this check and the connection.
 */
export async function resolvePublic(
	hostname: string,
	resolver: Resolver = systemResolver,
	timeoutMs = 5000,
): Promise<{ ok: true; addresses: ResolvedAddress[] } | Rejection> {
	let addresses: ResolvedAddress[];
	try {
		addresses = await Promise.race([
			resolver(hostname),
			new Promise<never>((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error("DNS lookup timed out")), timeoutMs).unref()),
		]);
	} catch (error) {
		return reject("dns_failed", `DNS lookup failed for ${hostname}: ${(error as Error).message}`);
	}
	if (addresses.length === 0) return reject("dns_failed", `DNS returned no addresses for ${hostname}`);
	for (const { address } of addresses) {
		const reason = nonPublicReason(address);
		if (reason) return reject("non_public_address", `host ${hostname} resolves to a ${reason}`);
	}
	return { ok: true, addresses };
}
