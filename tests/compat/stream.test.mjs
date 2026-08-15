import assert from "node:assert/strict";

import {
	assertNonEmptyAssistantText,
	chatCompletion,
	compatTest,
	forceToolChoice,
	REQUIRED_LIVE_ENV,
	streamChatCompletion,
	weatherTool,
} from "./helpers.mjs";

compatTest("stream.test: completes a basic text response", REQUIRED_LIVE_ENV, async () => {
	const response = await chatCompletion({
		messages: [
			{
				role: "user",
				content: "Reply with only this token: nous-compatible",
			},
		],
		maxTokens: 32,
	});

	assert.equal(response.choices?.[0]?.message?.role, "assistant");
	const text = assertNonEmptyAssistantText(response);
	assert.match(text.toLowerCase(), /nous[- ]compatible/);
});

compatTest("stream.test: streams text deltas", REQUIRED_LIVE_ENV, async () => {
	const stream = await streamChatCompletion({
		messages: [
			{
				role: "user",
				content: "In one short sentence, explain why provider streaming matters.",
			},
		],
		maxTokens: 96,
	});

	assert.ok(stream.chunks.length > 0, "Expected at least one streamed SSE chunk.");
	assert.ok(stream.text.trim().length > 0, "Expected streamed text deltas.");
	assert.ok(
		stream.sawDone || stream.finishReasons.length > 0,
		"Expected a terminal stream marker or finish reason.",
	);
});

compatTest("stream.test: streams tool-call deltas", REQUIRED_LIVE_ENV, async () => {
	const stream = await streamChatCompletion({
		messages: [
			{
				role: "user",
				content: "Use the get_weather tool for Paris and do not answer directly.",
			},
		],
		tools: [weatherTool],
		toolChoice: forceToolChoice("get_weather"),
		maxTokens: 96,
	});

	const toolDeltas = stream.chunks.flatMap((chunk) =>
		(chunk.choices ?? []).flatMap(
			(choice) => choice.delta?.tool_calls ?? choice.message?.tool_calls ?? [],
		),
	);

	assert.ok(toolDeltas.length > 0, "Expected streamed tool-call chunks.");
});
