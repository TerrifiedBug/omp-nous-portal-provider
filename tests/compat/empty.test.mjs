import assert from "node:assert/strict";

import {
	assertStructuredProviderRejection,
	chatCompletion,
	compatTest,
	extractAssistantText,
	REQUIRED_LIVE_ENV,
} from "./helpers.mjs";

async function expectResponseOrStructuredRejection(messages) {
	try {
		const response = await chatCompletion({ messages, maxTokens: 64 });
		assert.ok(response.choices?.length > 0, "Expected choices when the request succeeds.");
		assert.ok(
			extractAssistantText(response).trim().length > 0 || response.choices?.[0]?.finish_reason,
			"Expected content or an explicit finish reason for a successful empty-input response.",
		);
	} catch (error) {
		assertStructuredProviderRejection(error);
		if (error.status !== 413) {
			assert.match(error.bodyText ?? error.message, /message|content|empty|invalid|input|blank/i);
		}
	}
}

compatTest("empty.test: handles an empty string user message", REQUIRED_LIVE_ENV, async () => {
	await expectResponseOrStructuredRejection([{ role: "user", content: "" }]);
});

compatTest("empty.test: handles a whitespace-only user message", REQUIRED_LIVE_ENV, async () => {
	await expectResponseOrStructuredRejection([{ role: "user", content: "   \n\t   " }]);
});

compatTest("empty.test: handles an empty content array", REQUIRED_LIVE_ENV, async () => {
	await expectResponseOrStructuredRejection([{ role: "user", content: [] }]);
});

compatTest("empty.test: handles an empty assistant message in context", REQUIRED_LIVE_ENV, async () => {
	await expectResponseOrStructuredRejection([
		{ role: "user", content: "Remember that the answer token is empty-context-ok." },
		{ role: "assistant", content: "" },
		{ role: "user", content: "Reply with the answer token." },
	]);
});
