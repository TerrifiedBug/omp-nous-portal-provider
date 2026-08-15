import assert from "node:assert/strict";
import test from "node:test";

import nousPortalProvider, {
	PROVIDER_ID,
	PROVIDER_NAME,
	loginNousPortal,
	refreshNousPortalCredentials,
} from "../extensions/nous-portal/index.ts";

function captureRegistration(apiKey) {
	const previous = process.env.NOUS_API_KEY;
	if (apiKey === undefined) delete process.env.NOUS_API_KEY;
	else process.env.NOUS_API_KEY = apiKey;
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

test("registers one omp-native dynamic provider without shadowing OAuth", () => {
	const { id, config } = captureRegistration();
	assert.equal(id, PROVIDER_ID);
	assert.equal(id, "nous-portal");
	assert.equal(PROVIDER_NAME, "Nous Research Portal");
	assert.equal(config.baseUrl, "https://inference-api.nousresearch.com/v1");
	assert.equal(config.apiKey, undefined);
	assert.equal(config.api, "openai-completions");
	assert.equal(config.authHeader, undefined);
	assert.equal(config.models, undefined);
	assert.equal(typeof config.fetchDynamicModels, "function");
	assert.equal(config.oauth.name, PROVIDER_NAME);
	assert.equal(config.oauth.login, loginNousPortal);
	assert.equal(config.oauth.refreshToken, refreshNousPortalCredentials);
	assert.equal(config.oauth.getApiKey({ access: "invoke-jwt" }), "invoke-jwt");
});

test("registers the direct API-key override only when configured", () => {
	const { config } = captureRegistration("sk-nous-test");
	assert.equal(config.apiKey, "NOUS_API_KEY");
});

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
