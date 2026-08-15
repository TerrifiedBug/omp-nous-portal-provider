import {
	assertNonEmptyAssistantText,
	chatCompletion,
	compatTest,
	REQUIRED_LIVE_ENV,
} from "./helpers.mjs";

compatTest("unicode-surrogate.test: accepts emoji and unpaired surrogate tool output", REQUIRED_LIVE_ENV, async () => {
	const danglingHighSurrogate = String.fromCharCode(0xd83d);
	const response = await chatCompletion({
		messages: [
			{
				role: "user",
				content: "Fetch the profile and then summarize it without emitting JSON.",
			},
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_unicode_profile",
						type: "function",
						function: { name: "get_profile", arguments: "{}" },
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "call_unicode_profile",
				name: "get_profile",
				content: `Profile text includes an emoji 🙈 and a dangling high surrogate: ${danglingHighSurrogate}`,
			},
			{ role: "user", content: "Reply with a short confirmation that the profile was read." },
		],
		maxTokens: 64,
	});

	assertNonEmptyAssistantText(response);
});
