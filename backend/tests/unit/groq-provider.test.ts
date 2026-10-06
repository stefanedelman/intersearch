import { after, test } from "node:test";
import assert from "node:assert/strict";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { ProviderError } from "../../src/tracker/failure";
import { createGroqModel } from "../../src/tracker/providers/groq";

const original = getGlobalDispatcher();
after(() => setGlobalDispatcher(original));

test("a long tool_use_failed rejection is still recognized as the model's malformed tool call", async () => {
	const mock = new MockAgent();
	mock.disableNetConnect();
	setGlobalDispatcher(mock);
	const message = `Tool call validation failed: tool call validation failed: attempted to call tool 'commentary' which was not in request.tools ${"x".repeat(300)}`;
	mock
		.get("https://api.groq.com")
		.intercept({ path: "/openai/v1/chat/completions", method: "POST" })
		.reply(400, { error: { message, type: "invalid_request_error", code: "tool_use_failed" } }, { headers: { "content-type": "application/json" } });

	const callModel = createGroqModel("test-key", 5000);
	await assert.rejects(
		callModel({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }], tools: [], temperature: 1, maxOutputTokens: 100 }),
		(error: unknown) => error instanceof ProviderError && error.failure === "bad_request" && /malformed model output \(tool_use_failed\)/.test(error.message),
	);
});

test("output Groq could not parse is also recognized as malformed model output", async () => {
	const mock = new MockAgent();
	mock.disableNetConnect();
	setGlobalDispatcher(mock);
	const message = `Parsing failed. The model generated output that could not be parsed. Please adjust your prompt. See 'failed_generation' for more details. ${"x".repeat(200)}`;
	mock
		.get("https://api.groq.com")
		.intercept({ path: "/openai/v1/chat/completions", method: "POST" })
		.reply(400, { error: { message, type: "invalid_request_error", code: "output_parse_failed", failed_generation: "<|channel|>commentary" } }, { headers: { "content-type": "application/json" } });

	const callModel = createGroqModel("test-key", 5000);
	await assert.rejects(
		callModel({ model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "hi" }], tools: [], temperature: 1, maxOutputTokens: 100 }),
		(error: unknown) => error instanceof ProviderError && /malformed model output \(output_parse_failed\)/.test(error.message),
	);
});
