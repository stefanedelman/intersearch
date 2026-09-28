import type { TrackerConfig } from "../config";

// Marketing/tracking parameters are removed; identity-bearing ones (gh_jid, job ids) are kept.
const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|_hs[a-z]+|ref|ref_src|source|src|gh_src|lever-source|trk)$/i;

export function canonicalizeUrl(raw: string): string {
	const url = new URL(raw);
	url.hash = "";
	url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
	const kept = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAM.test(key)).sort(([a], [b]) => a.localeCompare(b));
	url.search = "";
	for (const [key, value] of kept) url.searchParams.append(key, value);
	if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
	return url.toString();
}

export function normalizeTitle(title: string): string {
	return title
		.normalize("NFKC")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9+#]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

export function locationKey(location: string | null | undefined): string | null {
	if (!location) return null;
	return location
		.toLowerCase()
		.split(/[;|•]|\s+-\s+/)
		.map((part) => part.replace(/[^a-z ]+/g, " ").trim().replace(/\s+/g, " "))
		.filter(Boolean)
		.sort()
		.join("|");
}

export type CompanyRef = { id: string; name: string; boardToken: string | null };

/** Which configured company a URL belongs to, from its Greenhouse board path or careers host. */
export function companyForUrl(raw: string, config: TrackerConfig): CompanyRef | null {
	const url = new URL(raw);
	const host = url.hostname.toLowerCase().replace(/^www\./, "");
	const byToken = (token: string | undefined) => config.companies.find((company) => company.board_token === token);

	const boardPath = url.pathname.match(/^\/(?:v1\/boards\/)?([a-z0-9-]+)\/jobs(?:\/|$)/i);
	if (host.endsWith("greenhouse.io") && boardPath) {
		const company = byToken(boardPath[1]!.toLowerCase());
		if (company) return { id: company.id, name: company.name, boardToken: company.board_token ?? null };
	}
	const token = url.searchParams.get("for");
	if (host.endsWith("greenhouse.io") && token) {
		const company = byToken(token.toLowerCase());
		if (company) return { id: company.id, name: company.name, boardToken: company.board_token ?? null };
	}
	for (const company of config.companies) {
		const careersHost = new URL(company.careers_url).hostname.toLowerCase().replace(/^www\./, "");
		if (host === careersHost || host.endsWith(`.${careersHost}`)) {
			return { id: company.id, name: company.name, boardToken: company.board_token ?? null };
		}
	}
	return null;
}

/** The provider's stable job id when the URL carries one (Greenhouse API, board page, or gh_jid). */
export function greenhouseJobIdFromUrl(raw: string): string | null {
	const url = new URL(raw);
	const fromParam = url.searchParams.get("gh_jid") ?? url.searchParams.get("token");
	if (fromParam && /^\d{4,}$/.test(fromParam)) return fromParam;
	const fromPath = url.pathname.match(/\/jobs\/(\d{4,})(?:\/|$)/) ?? url.pathname.match(/\/(?:detail|listing\/[^/]+)\/(\d{4,})(?:\/|$)/);
	return fromPath?.[1] ?? null;
}

export type Identity = { key: string; method: "provider_id" | "title_location_season"; providerJobId: string | null };

/**
 * Development identity, strongest evidence first:
 * 1. company + Greenhouse job id (from JSON, board URL, or gh_jid on a careers-site URL);
 * 2. company + normalized title + location + season when no id is available.
 * Two postings with the same title but different job ids stay separate on purpose.
 */
export function identityFor(input: {
	company: CompanyRef | null;
	jobId?: string | null;
	url: string;
	title: string;
	location: string | null;
	season: string | null;
}): Identity {
	const companyId = input.company?.id ?? `host:${new URL(input.url).hostname}`;
	const jobId = input.jobId ?? greenhouseJobIdFromUrl(input.url);
	if (jobId && input.company) return { key: `greenhouse:${input.company.boardToken ?? input.company.id}:${jobId}`, method: "provider_id", providerJobId: jobId };
	return {
		key: `title:${companyId}:${normalizeTitle(input.title)}:${locationKey(input.location) ?? "unknown"}:${input.season ?? "unknown"}`,
		method: "title_location_season",
		providerJobId: null,
	};
}

/** Whitespace- and quote-insensitive containment check used to validate every cited quote. */
export function normalizeForMatch(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[‘’‚′]/g, "'")
		.replace(/[“”„″]/g, '"')
		.replace(/[‐-―]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

export function quoteAppearsIn(quote: string, text: string): boolean {
	const needle = normalizeForMatch(quote);
	return needle.length >= 3 && normalizeForMatch(text).includes(needle);
}
