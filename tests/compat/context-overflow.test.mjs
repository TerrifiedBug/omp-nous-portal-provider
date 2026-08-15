import assert from "node:assert/strict";

import {
	assertStructuredProviderRejection,
	chatCompletion,
	compatTest,
	envValue,
	REQUIRED_CONTEXT_OVERFLOW_ENV,
} from "./helpers.mjs";

compatTest(
	"context-overflow.test: rejects an oversized prompt with a context-limit error",
	REQUIRED_CONTEXT_OVERFLOW_ENV,
	async () => {
		const requestedChars = Number.parseInt(envValue("NOUS_COMPAT_CONTEXT_CHARS") || "600000", 10);
		const contextChars = Number.isFinite(requestedChars) ? Math.max(requestedChars, 1000) : 600000;
		const oversizedContext = "lorem ipsum dolor sit amet ".repeat(
			Math.ceil(contextChars / "lorem ipsum dolor sit amet ".length),
		).slice(0, contextChars);

		try {
			await chatCompletion({
				messages: [
					{ role: "system", content: oversizedContext },
					{ role: "user", content: "Reply with only: context-overflow-not-triggered" },
				],
				maxTokens: 16,
			});
			assert.fail("Expected the oversized request to be rejected by the provider.");
		} catch (error) {
			assertStructuredProviderRejection(error);
			if (error.status !== 413) {
				assert.match(
					error.bodyText ?? error.message,
					/context|token|length|too long|maximum|limit|overflow/i,
				);
			}
		}
	},
	{ timeout: 180_000 },
);
