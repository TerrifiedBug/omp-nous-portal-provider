import assert from "node:assert/strict";
import test from "node:test";

import nousPortalProvider from "../extensions/nous-portal/index.ts";

function captureRegistration() {
	const previous = process.env.NOUS_API_KEY;
	delete process.env.NOUS_API_KEY;
	try {
		let registration;
		const pi = {
			registerProvider(id, config) {
				registration = { id, config };
			},
		};
		nousPortalProvider(pi);
		return registration;
	} finally {
		if (previous === undefined) delete process.env.NOUS_API_KEY;
		else process.env.NOUS_API_KEY = previous;
	}
}

test("dynamic discovery maps the public Nous catalog without credentials", async () => {
	const { config } = captureRegistration();
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input, init) => {
		calls.push({ input: String(input), init });
		return new Response(
			JSON.stringify({
				data: [
					{
						id: "openai/gpt-5.5",
						architecture: { output_modalities: ["text"] },
						pricing: { prompt: "0.000001", completion: "0.000004" },
					},
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	try {
		const models = await config.fetchDynamicModels(undefined);
		assert.equal(models[0].id, "openai/gpt-5.5");
		assert.deepEqual(models[0].cost, { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 });
		assert.equal(calls[0].init.headers.Authorization, undefined);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
