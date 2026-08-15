import assert from "node:assert/strict";

import {
	assertNonEmptyAssistantText,
	chatCompletion,
	compatTest,
	REQUIRED_LIVE_ENV,
	streamChatCompletion,
} from "./helpers.mjs";

compatTest("abort.test: mid-stream abort recovers for the next request", REQUIRED_LIVE_ENV, async () => {
	const controller = new AbortController();
	const aborted = await streamChatCompletion({
		messages: [
			{
				role: "user",
				content: "Write a long paragraph about cancellation semantics for streaming providers.",
			},
		],
		maxTokens: 512,
		signal: controller.signal,
		onChunk: ({ text, chunks }) => {
			if (text.length > 0 || chunks.length >= 2) {
				controller.abort();
			}
		},
	});

	assert.ok(aborted.aborted, "Expected the first stream to abort.");

	const followUp = await chatCompletion({
		messages: [{ role: "user", content: "Reply with only: abort-recovered" }],
		maxTokens: 32,
	});
	assert.match(assertNonEmptyAssistantText(followUp).toLowerCase(), /abort-recovered/);
});

compatTest("abort.test: immediately aborted stream does not call through", REQUIRED_LIVE_ENV, async () => {
	const controller = new AbortController();
	controller.abort();

	const aborted = await streamChatCompletion({
		messages: [{ role: "user", content: "This request should be aborted immediately." }],
		maxTokens: 64,
		signal: controller.signal,
	});

	assert.ok(aborted.aborted, "Expected an already-aborted signal to stop the stream.");
	assert.equal(aborted.chunks.length, 0);
});
