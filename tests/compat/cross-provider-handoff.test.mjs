import assert from "node:assert/strict";

import {
	assertNonEmptyAssistantText,
	chatCompletion,
	compatTest,
	handoffTool,
	REQUIRED_LIVE_ENV,
} from "./helpers.mjs";

compatTest("cross-provider-handoff.test: replays prior assistant context", REQUIRED_LIVE_ENV, async () => {
	const response = await chatCompletion({
		messages: [
			{
				role: "system",
				content: "You are receiving a conversation replayed from another provider.",
			},
			{ role: "user", content: "Remember the transfer code alpha-731." },
			{ role: "assistant", content: "The transfer code is alpha-731." },
			{ role: "user", content: "What transfer code was handed off?" },
		],
		maxTokens: 32,
	});

	assert.match(assertNonEmptyAssistantText(response).toLowerCase(), /alpha-731/);
});

compatTest("cross-provider-handoff.test: replays transferred tool results", REQUIRED_LIVE_ENV, async () => {
	const response = await chatCompletion({
		messages: [
			{ role: "user", content: "Look up the handoff status." },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_handoff_status",
						type: "function",
						function: { name: "get_handoff_status", arguments: "{}" },
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "call_handoff_status",
				name: "get_handoff_status",
				content: JSON.stringify({ answer: "handoff-green", emoji: "🙈" }),
			},
			{ role: "user", content: "Reply with only the answer value from the transferred tool result." },
		],
		tools: [handoffTool],
		maxTokens: 32,
	});

	assert.match(assertNonEmptyAssistantText(response).toLowerCase(), /handoff-green/);
});
