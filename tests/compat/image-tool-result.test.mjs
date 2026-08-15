import assert from "node:assert/strict";

import {
	assertNonEmptyAssistantText,
	chatCompletion,
	compatTest,
	imageTool,
	redImageContent,
	REQUIRED_VISION_ENV,
	visionModel,
} from "./helpers.mjs";

compatTest("image-tool-result.test: accepts image content returned by a tool", REQUIRED_VISION_ENV, async () => {
	const response = await chatCompletion({
		model: visionModel(),
		messages: [
			{
				role: "user",
				content: "Use the reference image tool result and describe the image color.",
			},
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_reference_image",
						type: "function",
						function: { name: "get_reference_image", arguments: "{}" },
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "call_reference_image",
				name: "get_reference_image",
				content: [
					{ type: "text", text: "The tool returned a tiny image for inspection." },
					redImageContent(),
				],
			},
			{ role: "user", content: "What color is the tool image? Answer with one word." },
		],
		tools: [imageTool],
		maxTokens: 32,
	});

	assert.match(assertNonEmptyAssistantText(response).toLowerCase(), /red|crimson|scarlet/);
});
