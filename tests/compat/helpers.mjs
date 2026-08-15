import assert from "node:assert/strict";
import { test } from "node:test";

export const DEFAULT_BASE_URL = "https://inference-api.nousresearch.com/v1";
export const DEFAULT_TEST_TIMEOUT_MS = 60_000;

export const REQUIRED_LIVE_ENV = ["NOUS_API_KEY", "NOUS_COMPAT_MODEL"];
export const REQUIRED_VISION_ENV = ["NOUS_API_KEY", "NOUS_COMPAT_VISION_MODEL"];
export const REQUIRED_CONTEXT_OVERFLOW_ENV = [
	"NOUS_API_KEY",
	"NOUS_COMPAT_MODEL",
	"NOUS_COMPAT_RUN_CONTEXT_OVERFLOW",
];

const RED_PIXEL_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/l6pS3wAAAABJRU5ErkJggg==";

export class ChatCompletionError extends Error {
	constructor(response, bodyText) {
		const preview = bodyText.replace(/\s+/g, " ").slice(0, 600);
		super(
			`Nous compatibility request failed (${response.status} ${response.statusText}): ${preview}`,
		);
		this.name = "ChatCompletionError";
		this.status = response.status;
		this.statusText = response.statusText;
		this.bodyText = bodyText;
	}
}

export function envValue(name) {
	return process.env[name]?.trim() ?? "";
}

export function compatModel() {
	return envValue("NOUS_COMPAT_MODEL");
}

export function visionModel() {
	return envValue("NOUS_COMPAT_VISION_MODEL");
}

export function inferenceBaseUrl() {
	return (envValue("NOUS_INFERENCE_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function missingEnv(requiredEnv) {
	return requiredEnv.filter((name) => !envValue(name));
}

export function skipReason(requiredEnv) {
	const missing = missingEnv(requiredEnv);
	if (missing.length === 0) return undefined;
	return `Set ${missing.join(", ")} to run Nous Portal live compatibility tests.`;
}

export function compatTest(name, requiredEnv, fn, options = {}) {
	const testOptions = { timeout: DEFAULT_TEST_TIMEOUT_MS, ...options };
	const skip = skipReason(requiredEnv);
	if (skip) testOptions.skip = skip;
	return test(name, testOptions, fn);
}

function requestBody({
	messages,
	model = compatModel(),
	stream = false,
	tools,
	toolChoice,
	maxTokens = 128,
	temperature = 0,
	extraBody = {},
}) {
	const body = {
		model,
		messages,
		temperature,
		max_tokens: maxTokens,
		...extraBody,
	};
	if (stream) body.stream = true;
	if (tools) body.tools = tools;
	if (toolChoice) body.tool_choice = toolChoice;
	return body;
}

async function fetchChatCompletion(options) {
	const response = await fetch(`${inferenceBaseUrl()}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${envValue("NOUS_API_KEY")}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(requestBody(options)),
		signal: options.signal,
	});

	if (!response.ok) {
		throw new ChatCompletionError(response, await response.text());
	}

	return response;
}

export async function chatCompletion(options) {
	const response = await fetchChatCompletion(options);
	return response.json();
}

export async function streamChatCompletion(options) {
	let response;
	const state = {
		text: "",
		chunks: [],
		finishReasons: [],
		usage: null,
		sawDone: false,
		aborted: false,
		error: null,
	};

	try {
		response = await fetchChatCompletion({ ...options, stream: true });
	} catch (error) {
		if (isAbortError(error, options.signal)) {
			return { ...state, aborted: true, error };
		}
		throw error;
	}

	assert.ok(response.body, "Expected the streaming response to include a body.");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const processLine = async (line) => {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) return;

		const data = trimmed.slice("data:".length).trim();
		if (!data) return;
		if (data === "[DONE]") {
			state.sawDone = true;
			return;
		}

		const chunk = JSON.parse(data);
		state.chunks.push(chunk);
		if (chunk.usage) state.usage = chunk.usage;

		for (const choice of chunk.choices ?? []) {
			state.text += contentToText(choice.delta?.content ?? choice.message?.content);
			if (choice.finish_reason) state.finishReasons.push(choice.finish_reason);
		}

		if (options.onChunk) {
			await options.onChunk({ ...state, chunk });
		}
	};

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				await processLine(line);
			}
		}

		buffer += decoder.decode();
		for (const line of buffer.split(/\r?\n/)) {
			await processLine(line);
		}
	} catch (error) {
		if (isAbortError(error, options.signal)) {
			return { ...state, aborted: true, error };
		}
		throw error;
	}

	return state;
}

function isAbortError(error, signal) {
	return signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function contentToText(content) {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (typeof part?.text === "string") return part.text;
			if (typeof part?.content === "string") return part.content;
			return "";
		})
		.join("");
}

export function extractAssistantText(json) {
	return contentToText(json?.choices?.[0]?.message?.content);
}

export function assertNonEmptyAssistantText(json, message = "Expected a non-empty assistant response.") {
	const text = extractAssistantText(json);
	assert.ok(text.trim().length > 0, message);
	return text;
}

export function assertUsageObject(usage, { totalMatchesParts = false } = {}) {
	assert.equal(typeof usage, "object", "Expected a usage object.");
	assert.notEqual(usage, null, "Expected a usage object.");

	for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
		assert.equal(typeof usage[field], "number", `Expected usage.${field} to be numeric.`);
		assert.ok(Number.isFinite(usage[field]), `Expected usage.${field} to be finite.`);
		assert.ok(usage[field] >= 0, `Expected usage.${field} to be non-negative.`);
	}

	if (totalMatchesParts) {
		assert.equal(
			usage.total_tokens,
			usage.prompt_tokens + usage.completion_tokens,
			"Expected total_tokens to equal prompt_tokens + completion_tokens.",
		);
	}
}

export function assertCompletionUsage(json, options) {
	assertUsageObject(json?.usage, options);
}

export function isProviderRejection(error) {
	return error instanceof ChatCompletionError && error.status >= 400 && error.status < 500;
}

export function assertStructuredProviderRejection(error) {
	assert.ok(
		isProviderRejection(error),
		`Expected a structured 4xx provider rejection, got: ${error?.stack ?? error}`,
	);
}

export function functionTool({ name, description, properties = {}, required = [] }) {
	return {
		type: "function",
		function: {
			name,
			description,
			parameters: {
				type: "object",
				properties,
				required,
			},
		},
	};
}

export function forceToolChoice(name) {
	return { type: "function", function: { name } };
}

export function toolCallsFrom(json) {
	return json?.choices?.[0]?.message?.tool_calls ?? [];
}

export function assertToolCall(json, expectedName) {
	const toolCalls = toolCallsFrom(json);
	assert.ok(toolCalls.length > 0, "Expected the provider to return a tool call.");
	if (expectedName) {
		assert.equal(toolCalls[0]?.function?.name, expectedName);
	}
	return toolCalls;
}

export function redImageContent() {
	return {
		type: "image_url",
		image_url: {
			url: `data:image/png;base64,${RED_PIXEL_PNG_BASE64}`,
		},
	};
}

export const weatherTool = functionTool({
	name: "get_weather",
	description: "Look up deterministic weather for a city.",
	properties: {
		location: { type: "string", description: "City name." },
	},
	required: ["location"],
});

export const handoffTool = functionTool({
	name: "get_handoff_status",
	description: "Return a deterministic handoff status.",
	properties: {},
});

export const imageTool = functionTool({
	name: "get_reference_image",
	description: "Return a deterministic reference image.",
	properties: {},
});
