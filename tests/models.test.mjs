import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_INFERENCE_BASE_URL,
	OPENROUTER_REASONING_COMPAT,
	fetchModelCatalog,
	parseModelCatalog,
} from "../extensions/nous-portal/models.ts";

function jsonResponse(payload, status = 200) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("maps Nous discounted pricing and capabilities into omp units", () => {
	const models = parseModelCatalog({
		data: [
			{
				id: "qwen/qwen3.8-27b",
				name: "Qwen: Qwen3.8 27B",
				context_length: 262144,
				architecture: {
					input_modalities: ["text", "image", "video"],
					output_modalities: ["text"],
				},
				top_provider: { max_completion_tokens: 131072 },
				supported_parameters: ["tools", "reasoning", "include_reasoning"],
				pricing: {
					prompt: "0.00000036",
					completion: "0.00000256",
					input_cache_read: "0.00000009",
					input_cache_write: "0.00000045",
					original: { prompt: "0.00000045", completion: "0.0000032" },
				},
			},
		],
	});

	assert.equal(models.length, 1);
	assert.equal(models[0].api, "openai-completions");
	assert.equal(models[0].name, "Qwen: Qwen3.8 27B");
	assert.equal(models[0].reasoning, true);
	assert.deepEqual(models[0].input, ["text", "image"]);
	assert.equal(models[0].contextWindow, 262144);
	assert.equal(models[0].maxTokens, 131072);
	assert.deepEqual(models[0].cost, { input: 0.36, output: 2.56, cacheRead: 0.09, cacheWrite: 0.45 });
	assert.deepEqual(models[0].compat, OPENROUTER_REASONING_COMPAT);
});

test("routes Anthropic catalog IDs through the OpenAI-compatible Nous endpoint", () => {
	const [model] = parseModelCatalog({
		data: [
			{
				id: "anthropic/claude-opus-4.8",
				name: "Claude Opus 4.8",
				context_length: 1000000,
				architecture: {},
				supported_parameters: [],
				pricing: { prompt: "0.000004", completion: "0.000020" },
			},
		],
	});

	assert.equal(model.api, "openai-completions");
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.maxTokens, 128000);
	assert.deepEqual(model.compat, OPENROUTER_REASONING_COMPAT);
	assert.deepEqual(model.cost, { input: 4, output: 20, cacheRead: 0, cacheWrite: 0 });
});

test("filters non-chat surfaces and de-duplicates chat models in response order", () => {
	const models = parseModelCatalog({
		data: [
			{
				id: "voyageai/voyage-code-4",
				architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] },
				context_length: 32000,
			},
			{ id: "chat-a", architecture: { output_modalities: ["text"] } },
			{ id: "chat-a", architecture: { output_modalities: ["text"] } },
			{ id: "  " },
			{},
		],
	});

	assert.deepEqual(models.map((model) => model.id), ["chat-a"]);
});

test("bounds and sanitizes remote catalog fields", () => {
	const data = Array.from({ length: 1001 }, (_, index) => `model-${index}`);
	data[0] = { id: "safe-model", name: "Safe\u001b]52;clipboard\u0007\nName", pricing: { prompt: "1e100" } };
	data[1] = { id: "unsafe\u001b-model" };
	const models = parseModelCatalog({ data });

	assert.equal(models.length, 999);
	assert.equal(models[0].id, "safe-model");
	assert.equal(models[0].name, "Safe ]52;clipboard Name");
	assert.equal(models[0].cost.input, 0);
	assert.equal(models.at(-1).id, "model-999");
});

test("fetches public discovery without auth and sends Bearer when available", async () => {
	const calls = [];
	const fetchFn = async (input, init) => {
		calls.push({ input: String(input), init });
		return jsonResponse({ data: [{ id: "live", architecture: { output_modalities: ["text"] } }] });
	};

	const publicModels = await fetchModelCatalog(undefined, "https://inference.example/v1/", { fetchFn });
	const authenticatedModels = await fetchModelCatalog("invoke-jwt", "https://inference.example/v1/", { fetchFn });

	assert.equal(publicModels[0].id, "live");
	assert.equal(authenticatedModels[0].id, "live");
	assert.equal(calls[0].input, "https://inference.example/v1/models");
	assert.equal(calls[0].init.headers.Authorization, undefined);
	assert.equal(calls[1].init.headers.Authorization, "Bearer invoke-jwt");
});

test("preserves model endpoint errors", async () => {
	await assert.rejects(
		fetchModelCatalog(undefined, DEFAULT_INFERENCE_BASE_URL, {
			fetchFn: async () => new Response("service unavailable", { status: 503 }),
		}),
		/Nous \/models request failed with status 503: service unavailable/,
	);
});

test("rejects oversized catalog responses", async () => {
	await assert.rejects(
		fetchModelCatalog(undefined, DEFAULT_INFERENCE_BASE_URL, {
			fetchFn: async () =>
				new Response(" ".repeat(4 * 1024 * 1024 + 1), {
					headers: { "content-type": "application/json" },
				}),
		}),
		/Response body exceeds size limit/,
	);
});
