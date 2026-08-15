import {
	assertCompletionUsage,
	assertNonEmptyAssistantText,
	chatCompletion,
	compatTest,
	REQUIRED_LIVE_ENV,
} from "./helpers.mjs";

compatTest("total-tokens.test: total token usage matches prompt plus completion", REQUIRED_LIVE_ENV, async () => {
	const systemPrompt = `You are a concise token accounting test assistant. ${"Count carefully. ".repeat(200)}`;
	const first = await chatCompletion({
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: "Reply with a short sentence about token accounting." },
		],
		maxTokens: 48,
	});
	assertCompletionUsage(first, { totalMatchesParts: true });
	const firstText = assertNonEmptyAssistantText(first);

	const second = await chatCompletion({
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: "Reply with a short sentence about token accounting." },
			{ role: "assistant", content: firstText },
			{ role: "user", content: "Now reply with a different short sentence." },
		],
		maxTokens: 48,
	});
	assertCompletionUsage(second, { totalMatchesParts: true });
	assertNonEmptyAssistantText(second);
});
