import Groq from "groq-sdk";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "groq-sdk/resources/chat/completions";
import { classifyHttpFailure, classifyNetworkFailure, ProviderError } from "../failure";

export type ModelMessage = ChatCompletionMessageParam;
export type ModelTool = ChatCompletionTool;

export type ModelResponse = {
	content: string | null;
	toolCalls: { id: string; name: string; arguments: string }[];
	usage: { input: number; output: number } | null;
	finishReason: string | null;
	requestId: string | null;
	/** Groq's per-minute token bucket as of this response, from its x-ratelimit headers. */
	rateLimit?: RateLimitSnapshot | null;
};

export type RateLimitSnapshot = { limitTokens: number; remainingTokens: number; observedAt: number };

function readRateLimit(headers: Headers): RateLimitSnapshot | null {
	const limitTokens = Number(headers.get("x-ratelimit-limit-tokens"));
	const remainingTokens = Number(headers.get("x-ratelimit-remaining-tokens"));
	if (!headers.has("x-ratelimit-limit-tokens") || !Number.isFinite(limitTokens) || limitTokens <= 0 || !Number.isFinite(remainingTokens)) return null;
	return { limitTokens, remainingTokens, observedAt: Date.now() };
}

/**
 * One model request, no hidden retries: the SDK's own retry loop is disabled so our wrapper
 * counts and classifies every attempt. The model only proposes tool calls; our loop runs them.
 */
export function createGroqModel(apiKey: string | undefined, timeoutMs: number) {
	if (!apiKey) {
		throw new ProviderError("groq", "auth", "GROQ_API_KEY is not set. Add it to backend/.env.local (see README).");
	}
	const client = new Groq({ apiKey, maxRetries: 0, timeout: timeoutMs * 2 });

	return async function callModel(input: {
		model: string;
		messages: ModelMessage[];
		tools: ModelTool[];
		temperature: number;
		maxOutputTokens: number;
		reasoningEffort?: "none" | "default" | "low" | "medium" | "high";
	}): Promise<ModelResponse> {
		try {
			const { data, response } = await client.chat.completions
				.create({
					model: input.model,
					messages: input.messages,
					tools: input.tools,
					tool_choice: "auto",
					parallel_tool_calls: false,
					temperature: input.temperature,
					max_completion_tokens: input.maxOutputTokens,
					...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
				})
				.withResponse();
			const choice = data.choices[0];
			return {
				content: choice?.message.content ?? null,
				toolCalls: (choice?.message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })),
				usage: data.usage ? { input: data.usage.prompt_tokens ?? 0, output: data.usage.completion_tokens ?? 0 } : null,
				finishReason: choice?.finish_reason ?? null,
				requestId: response.headers.get("x-request-id"),
				rateLimit: readRateLimit(response.headers),
			};
		} catch (error) {
			if (error instanceof Groq.APIConnectionError || error instanceof Groq.APIConnectionTimeoutError) {
				throw classifyNetworkFailure("groq", error);
			}
			const body = error instanceof Groq.APIError ? (error.error as { error?: { code?: string; failed_generation?: unknown } } | undefined)?.error : undefined;
			if (error instanceof Groq.APIError && error.status === 400 && (body?.code === "tool_use_failed" || body?.code === "output_parse_failed" || body?.failed_generation !== undefined)) {
				// Groq rejected the model's own output (a malformed tool call, or text it could not
				// parse). Say so up front so the loop recognizes it even though the provider message is
				// long and gets truncated.
				throw new ProviderError("groq", "bad_request", `groq returned HTTP 400 malformed model output (${body?.code ?? "unknown"}): ${error.message.slice(0, 300)}`, 400);
			}
			if (error instanceof Groq.APIError && typeof error.status === "number") {
				throw classifyHttpFailure({ provider: "groq", status: error.status, headers: error.headers, body: `${JSON.stringify(error.error ?? {})} ${error.message}` });
			}
			throw classifyNetworkFailure("groq", error);
		}
	};
}

export type CallModel = ReturnType<typeof createGroqModel>;
