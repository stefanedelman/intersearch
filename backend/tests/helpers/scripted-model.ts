import type { CallModel, ModelMessage, ModelResponse } from "../../src/tracker/providers/groq";

export type ScriptStep =
	| { tool: string; args: Record<string, unknown> | ((messages: ModelMessage[]) => Record<string, unknown>) }
	| { text: string }
	| { error: Error };

/** Source ids returned by fetch_article so far, keyed by the URL the model asked for. */
export function fetchedSourceIds(messages: ModelMessage[]): Map<string, string> {
	const ids = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "tool" || typeof message.content !== "string") continue;
		try {
			const parsed = JSON.parse(message.content.replace(/…\[truncated\]$/, ""));
			const data = parsed.untrusted_web_data;
			if (parsed.tool === "fetch_article" && data?.source_id) ids.set(data.url, data.source_id);
		} catch {
			// Truncated older results are fine to skip.
		}
	}
	return ids;
}

/**
 * Deterministic stand-in for the LLM: returns scripted tool calls in order and records every
 * request it was sent, so tests can check what the model saw.
 */
export function scriptedModel(script: ScriptStep[]) {
	const calls: ModelMessage[][] = [];
	let index = 0;
	const callModel: CallModel = async (input) => {
		calls.push(structuredClone(input.messages));
		const step = script[Math.min(index, script.length - 1)]!;
		index += 1;
		if ("error" in step) throw step.error;
		const usage = { input: Math.ceil(JSON.stringify(input.messages).length / 4), output: 40 };
		if ("text" in step) return { content: step.text, toolCalls: [], usage, finishReason: "stop", requestId: null } satisfies ModelResponse;
		const args = typeof step.args === "function" ? step.args(input.messages) : step.args;
		return {
			content: null,
			toolCalls: [{ id: `call_${index}`, name: step.tool, arguments: JSON.stringify(args) }],
			usage,
			finishReason: "tool_calls",
			requestId: null,
		} satisfies ModelResponse;
	};
	return { callModel, calls };
}
