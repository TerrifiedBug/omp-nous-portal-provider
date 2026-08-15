import assert from "node:assert/strict";

import {
	assertUsageObject,
	compatTest,
	REQUIRED_LIVE_ENV,
	streamChatCompletion,
} from "./helpers.mjs";

compatTest("tokens.test: aborted stream does not require final usage", REQUIRED_LIVE_ENV, async () => {
	const controller = new AbortController();
	const stream = await streamChatCompletion({
		messages: [
			{
				role: "user",
				content:
					"Write a long numbered list of provider compatibility checks. Keep going until stopped.",
			},
		],
		maxTokens: 512,
		signal: controller.signal,
		onChunk: ({ text, chunks }) => {
			if (text.length >= 120 || chunks.length >= 4) {
				controller.abort();
			}
		},
	});

	assert.ok(stream.aborted, "Expected the streaming request to be aborted.");
	assert.ok(
		stream.text.length > 0 || stream.chunks.length > 0,
		"Expected partial stream output before abort.",
	);

	// OpenAI-compatible streams commonly report usage only in the final chunk.
	// When we abort before that final chunk, usage may be absent; if present, it
	// should still follow the native usage shape.
	if (stream.usage) {
		assertUsageObject(stream.usage);
	}
});
