import { checkUrlStatic } from "../fetch/url-policy";
import { withRetries, ProviderError } from "../failure";
import type { ToolContext } from "./context";

const MAX_RESULTS = 6;

/**
 * search_web(query): one Tavily "basic" search (1 credit), restricted to the allowlisted hosts.
 * Results are discovery hints only; a claim must come from a page fetched with fetch_article.
 */
export async function searchWeb(ctx: ToolContext, query: string) {
	if (!ctx.search) throw new ProviderError("tavily", "auth", "TAVILY_API_KEY is not set. Add it to backend/.env.local (see README).");
	const trimmed = query.trim().slice(0, 300);
	const domains = ctx.config.fetch_policy.allowed_hosts.slice(0, 20);

	const result = await withRetries(
		ctx.budget,
		ctx.config.limits.max_retries,
		async (attempt) => {
			ctx.budget.reserveSearch(1);
			const started = new Date();
			try {
				const response = await ctx.search!(trimmed, domains, MAX_RESULTS);
				ctx.trace.record({
					category: "http",
					service: "api.tavily.com",
					tool: "search_web",
					step: ctx.step,
					parentEventId: ctx.parentEventId,
					arguments: { query: trimmed, attempt },
					status: "ok",
					startedAt: started,
					latencyMs: Date.now() - started.getTime(),
					searchCredits: response.credits,
					detail: { results: response.hits.length, requestId: response.requestId },
				});
				return response;
			} catch (error) {
				ctx.trace.record({
					category: "http",
					service: "api.tavily.com",
					tool: "search_web",
					step: ctx.step,
					parentEventId: ctx.parentEventId,
					arguments: { query: trimmed, attempt },
					status: "error",
					startedAt: started,
					latencyMs: Date.now() - started.getTime(),
					searchCredits: error instanceof ProviderError && error.status === 429 ? 0 : 1,
					errorCode: error instanceof ProviderError ? error.failure : "error",
					detail: { message: (error as Error).message },
				});
				throw error;
			}
		},
	);

	return {
		query: trimmed,
		results: result.hits.map((hit) => ({
			title: hit.title,
			url: hit.url,
			snippet: hit.snippet.slice(0, 200),
			fetchable: checkUrlStatic(hit.url, ctx.policy).ok,
		})),
		note: "Search snippets are hints, not evidence. Fetch a result before relying on it.",
	};
}
