import { parseLenientJson } from "../fetch/extract";
import { guardedGet, type TransportLimits, type TransportOptions } from "../fetch/transport";
import type { UrlPolicy } from "../fetch/url-policy";

export type JobListing = {
	jobId: string;
	title: string;
	location: string | null;
	updatedAt: string | null;
	absoluteUrl: string | null;
	detailUrl: string;
};

const MAX_JOBS = 2000;

export function boardFeedUrl(boardToken: string) {
	return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs`;
}

export function jobDetailUrl(boardToken: string, jobId: string) {
	return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(jobId)}`;
}

/**
 * Greenhouse's public Job Board API (no key required). The URL is built from a configured
 * board token only, never from model input, and fetched through the same guarded transport.
 */
export async function listGreenhouseJobs(boardToken: string, policy: UrlPolicy, limits: TransportLimits, fetcher: typeof guardedGet = guardedGet, options: TransportOptions = {}) {
	const url = boardFeedUrl(boardToken);
	const result = await fetcher(url, policy, limits, { ...options, accept: "application/json" });
	if (!result.ok) return { ok: false as const, url, result };

	let parsed: { jobs?: unknown[] };
	try {
		parsed = parseLenientJson(result.body) as { jobs?: unknown[] };
	} catch {
		return { ok: false as const, url, result: { ...result, ok: false as const, kind: "failed" as const, code: "bad_json", reason: "feed is not valid JSON", transient: false } };
	}

	const jobs: JobListing[] = [];
	for (const raw of (parsed.jobs ?? []).slice(0, MAX_JOBS)) {
		const job = raw as { id?: number | string; title?: string; location?: { name?: string } | null; updated_at?: string; absolute_url?: string };
		if (job.id === undefined || typeof job.title !== "string") continue;
		const jobId = String(job.id);
		jobs.push({
			jobId,
			title: job.title.trim(),
			location: job.location?.name ?? null,
			updatedAt: job.updated_at ?? null,
			absoluteUrl: job.absolute_url ?? null,
			detailUrl: jobDetailUrl(boardToken, jobId),
		});
	}
	return { ok: true as const, url, jobs, bytes: result.bytes, latencyMs: result.latencyMs, redirects: result.redirects };
}

/** Internship listings only; "internal" and "international" are not internships. */
export function isInternshipTitle(title: string): boolean {
	return /\bintern(ship)?s?\b|\bco-?op\b/i.test(title) && !/\binternal\b|\binternational\b/i.test(title);
}
