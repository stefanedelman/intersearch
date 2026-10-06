import { canonicalizeUrl, identityFor } from "../domain/normalize";
import { isInternshipTitle, listGreenhouseJobs } from "../providers/greenhouse";
import type { ToolContext } from "./context";
import { sourceTransport } from "./source-transport";

const MAX_LISTINGS_FOR_MODEL = 20;

function relevance(title: string): number {
	const t = title.toLowerCase();
	if (/backend|back-end|software (engineer|developer|engineering)/.test(t)) return 3;
	if (/engineer|developer/.test(t)) return 2;
	return 1;
}

/**
 * list_company_jobs(company_id): reads the company's public Greenhouse job feed. It accepts
 * only a configured company id; the URL is built from config, never from model text. The feed
 * is a mutable discovery resource, so it is refreshed every run (unlike article pages).
 */
export async function listCompanyJobs(ctx: ToolContext, companyId: string) {
	const company = ctx.config.companies.find((candidate) => candidate.id === companyId);
	if (!company) {
		return { ok: false as const, error: `Unknown company_id "${companyId}". Valid ids: ${ctx.config.companies.map((c) => c.id).join(", ")}` };
	}
	if (company.adapter !== "greenhouse" || !company.board_token) {
		return { ok: false as const, error: `${company.name} has no job-board feed; use search_web instead.` };
	}

	const feed = await listGreenhouseJobs(company.board_token, ctx.policy, ctx.transport, ctx.fetcher, sourceTransport(ctx, "list_company_jobs", { company_id: companyId }));
	if (!feed.ok) {
		return { ok: false as const, error: `Could not read ${company.name}'s job feed: ${feed.result.ok ? "unknown error" : feed.result.reason}` };
	}

	ctx.memory.feeds.set(company.id, { jobIds: new Set(feed.jobs.map((job) => job.jobId)), fetchedAt: new Date().toISOString() });

	const internships = feed.jobs
		.filter((job) => isInternshipTitle(job.title))
		.sort((a, b) => relevance(b.title) - relevance(a.title) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

	const listings = internships.slice(0, MAX_LISTINGS_FOR_MODEL).map((job) => {
		const identity = identityFor({ company: { id: company.id, name: company.name, boardToken: company.board_token ?? null }, jobId: job.jobId, url: job.detailUrl, title: job.title, location: job.location, season: null });
		return {
			job_id: job.jobId,
			title: job.title,
			location: job.location,
			updated: job.updatedAt?.slice(0, 10) ?? null,
			fetch_url: job.detailUrl,
			already_fetched: Boolean(ctx.store?.findCached(canonicalizeUrl(job.detailUrl))),
			previously_reported: ctx.memory.everReported.has(identity.key),
		};
	});

	return {
		ok: true as const,
		company: company.name,
		total_jobs: feed.jobs.length,
		internships_found: internships.length,
		listings,
		note:
			internships.length > MAX_LISTINGS_FOR_MODEL
				? `Showing the ${MAX_LISTINGS_FOR_MODEL} most relevant of ${internships.length} internship listings.`
				: undefined,
	};
}
