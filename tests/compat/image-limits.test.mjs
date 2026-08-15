import assert from "node:assert/strict";

import {
	assertNonEmptyAssistantText,
	chatCompletion,
	compatTest,
	redImageContent,
	REQUIRED_VISION_ENV,
	visionModel,
} from "./helpers.mjs";

compatTest("image-limits.test: accepts a small inline image input", REQUIRED_VISION_ENV, async () => {
	const response = await chatCompletion({
		model: visionModel(),
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "This image is a single red pixel. What is its dominant color? Answer with one word.",
					},
					redImageContent(),
				],
			},
		],
		maxTokens: 32,
	});

	assert.match(assertNonEmptyAssistantText(response).toLowerCase(), /red|crimson|scarlet/);
});
