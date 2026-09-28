import { classifyHttpFailure, classifyNetworkFailure, ProviderError } from "../failure";

export type SearchHit = { title: string; url: string; snippet: string; publishedDate: string | null; score: number | null };

const TAVILY_URL = "https://api.tavily.com/search";

/**
 * Tavily search in "basic" depth (1 credit per request) with no raw content or answer
 * generation, restricted to the configured hosts. The key is sent only to Tavily's fixed URL.
 */
export function createTavilySearch(apiKey: string | undefined, timeoutMs: number) {
	if (!apiKey) {
		throw new ProviderError("tavily", "auth", "TAVILY_API_KEY is not set. Add it to backend/.env.local (see README).");
	}

	return async function search(query: string, includeDomains: string[], maxResults: number): Promise<{ hits: SearchHit[]; credits: number; requestId: string | null }> {
		let response: Response;
		try {
			response = await fetch(TAVILY_URL, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({
					query,
					search_depth: "basic",
					max_results: maxResults,
					include_domains: includeDomains,
					include_answer: false,
					include_raw_content: false,
					include_images: false,
					include_usage: true,
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			throw classifyNetworkFailure("tavily", error);
		}
		const text = await response.text();
		if (!response.ok) throw classifyHttpFailure({ provider: "tavily", status: response.status, headers: response.headers, body: text });

		let data: { results?: { title?: string; url?: string; content?: string; published_date?: string; score?: number }[]; usage?: { credits?: number }; request_id?: string };
		try {
			data = JSON.parse(text);
		} catch {
			throw new ProviderError("tavily", "transient", "tavily returned a response that is not JSON");
		}
		const hits = (data.results ?? [])
			.filter((result) => typeof result.url === "string")
			.map((result) => ({
				title: (result.title ?? "").slice(0, 200),
				url: result.url!,
				snippet: (result.content ?? "").replace(/\s+/g, " ").slice(0, 300),
				publishedDate: result.published_date ?? null,
				score: typeof result.score === "number" ? result.score : null,
			}));
		return { hits, credits: data.usage?.credits ?? 1, requestId: data.request_id ?? response.headers.get("x-request-id") };
	};
}

export type Search = ReturnType<typeof createTavilySearch>;
