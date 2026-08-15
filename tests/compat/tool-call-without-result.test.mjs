import assert from "node:assert/strict";

import {
	assertNonEmptyAssistantText,
	assertStructuredProviderRejection,
	assertToolCall,
	chatCompletion,
	compatTest,
	forceToolChoice,
	REQUIRED_LIVE_ENV,
	weatherTool,
} from "./helpers.mjs";

compatTest("tool-call-without-result.test: orphaned tool calls are handled deliberately", REQUIRED_LIVE_ENV, async () => {
	const initialUser = {
		role: "user",
		content: "Use get_weather for Tokyo and wait for the result before answering.",
	};

	const first = await chatCompletion({
		messages: [initialUser],
		tools: [weatherTool],
		toolChoice: forceToolChoice("get_weather"),
		maxTokens: 96,
	});
	assertToolCall(first, "get_weather");

	const assistantWithOrphanedToolCall = first.choices[0].message;
	const followUpUser = {
		role: "user",
		content: "No tool result is available. Reply with a brief graceful fallback.",
	};

	try {
		const orphaned = await chatCompletion({
			messages: [initialUser, assistantWithOrphanedToolCall, followUpUser],
			tools: [weatherTool],
			maxTokens: 64,
		});
		assertNonEmptyAssistantText(orphaned);
	} catch (error) {
		assertStructuredProviderRejection(error);
	}

	const sanitized = await chatCompletion({
		messages: [
			initialUser,
			{
				role: "assistant",
				content: "I could not use the weather tool because no tool result was returned.",
			},
			followUpUser,
		],
		maxTokens: 64,
	});

	assert.ok(
		assertNonEmptyAssistantText(sanitized).trim().length > 0,
		"Expected a sanitized follow-up to succeed after dropping the orphaned tool call.",
	);
});
