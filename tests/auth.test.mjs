import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_CLIENT_ID,
	DEFAULT_MIN_TOKEN_TTL_SECONDS,
	DEFAULT_SCOPE,
	getClientId,
	getMinTokenTtlSeconds,
	loginNousPortal,
	refreshNousPortalCredentials,
} from "../extensions/nous-portal/auth.ts";

function jsonResponse(payload, status = 200) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function invokeJwt(exp, scope = DEFAULT_SCOPE) {
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode({ exp, scope })}.signature`;
}

function deviceCode(overrides = {}) {
	return {
		device_code: "device-code",
		user_code: "USER-CODE",
		verification_uri: "https://portal.example/manage-subscription",
		verification_uri_complete: "https://portal.example/manage-subscription?user_code=USER-CODE",
		expires_in: 600,
		interval: 1,
		...overrides,
	};
}

function fetchSequence(steps) {
	const calls = [];
	return {
		calls,
		fetchFn: async (input, init = {}) => {
			calls.push({ url: String(input), init, body: String(init.body ?? "") });
			const step = steps.shift();
			if (!step) throw new Error(`Unexpected fetch call to ${input}`);
			return jsonResponse(step.body, step.status);
		},
	};
}

test("defaults match the current Nous invoke-JWT contract", () => {
	assert.equal(DEFAULT_CLIENT_ID, "hermes-cli");
	assert.equal(DEFAULT_SCOPE, "inference:invoke");
	assert.equal(DEFAULT_MIN_TOKEN_TTL_SECONDS, 120);
	assert.equal(getClientId({}), "hermes-cli");
	assert.equal(getClientId({ NOUS_CLIENT_ID: "custom-client" }), "custom-client");
	assert.equal(getMinTokenTtlSeconds({ NOUS_MIN_TOKEN_TTL_SECONDS: "240" }), 240);
});

test("device login uses onAuth and stores the invoke JWT directly", async () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const hardExpiry = now + 900_000;
	const access = invokeJwt(hardExpiry / 1000);
	const { calls, fetchFn } = fetchSequence([
		{ body: deviceCode() },
		{
			body: {
				access_token: access,
				refresh_token: "refresh-token",
				expires_in: 900,
				scope: DEFAULT_SCOPE,
				token_type: "Bearer",
			},
		},
	]);
	const auth = [];
	const progress = [];

	const credentials = await loginNousPortal(
		{
			onAuth: (info) => auth.push(info),
			onPrompt: async () => "",
			onProgress: (message) => progress.push(message),
		},
		{
			fetchFn,
			sleepFn: async () => {},
			now: () => now,
			portalBaseUrl: "https://portal.example",
		},
	);

	assert.equal(calls.length, 2, "invoke JWT flow must not call legacy /api/oauth/agent-key");
	assert.equal(calls[0].url, "https://portal.example/api/oauth/device/code");
	assert.match(calls[0].body, /client_id=hermes-cli/);
	assert.match(calls[0].body, /scope=inference%3Ainvoke/);
	assert.equal(calls[1].url, "https://portal.example/api/oauth/token");
	assert.equal(calls[0].init.redirect, "error");
	assert.equal(calls[1].init.redirect, "error");
	assert.equal(auth[0].url, deviceCode().verification_uri_complete);
	assert.match(auth[0].instructions, /USER-CODE/);
	assert.match(progress[0], /USER-CODE/);
	assert.equal(credentials.access, access);
	assert.equal(credentials.refresh, "refresh-token");
	assert.equal(credentials.expires, hardExpiry - DEFAULT_MIN_TOKEN_TTL_SECONDS * 1000);
});

test("device login handles authorization_pending and additive slow_down", async () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const access = invokeJwt(now / 1000 + 900);
	const { fetchFn } = fetchSequence([
		{ body: deviceCode() },
		{ status: 400, body: { error: "authorization_pending" } },
		{ status: 400, body: { error: "slow_down" } },
		{ body: { access_token: access, refresh_token: "refresh", expires_in: 900, scope: DEFAULT_SCOPE } },
	]);
	const sleeps = [];

	await loginNousPortal(
		{ onAuth: () => {}, onPrompt: async () => "" },
		{
			fetchFn,
			sleepFn: async (ms) => sleeps.push(ms),
			now: () => now,
			portalBaseUrl: "https://portal.example",
		},
	);

	assert.deepEqual(sleeps, [1000, 2000]);
});

test("refresh sends the single-use token in x-nous-refresh-token and preserves rotation", async () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const access = invokeJwt(now / 1000 + 1800);
	const { calls, fetchFn } = fetchSequence([
		{
			body: {
				access_token: access,
				refresh_token: "rotated-refresh",
				expires_in: 1800,
				scope: DEFAULT_SCOPE,
			},
		},
	]);

	const credentials = await refreshNousPortalCredentials(
		{
			access: "expired",
			refresh: "single-use-refresh",
			expires: 0,
			portalBaseUrl: "https://portal.example",
			clientId: "hermes-cli",
			scope: DEFAULT_SCOPE,
		},
		{ fetchFn, now: () => now },
	);

	assert.equal(calls[0].init.headers["x-nous-refresh-token"], "single-use-refresh");
	assert.match(calls[0].body, /grant_type=refresh_token/);
	assert.doesNotMatch(calls[0].body, /single-use-refresh/);
	assert.equal(credentials.access, access);
	assert.equal(credentials.refresh, "rotated-refresh");
});

test("refresh rejects terminal token errors with re-login guidance", async () => {
	const { fetchFn } = fetchSequence([
		{ status: 400, body: { error: "refresh_token_reused", error_description: "already consumed" } },
	]);

	await assert.rejects(
		refreshNousPortalCredentials(
		{
			access: "expired",
			refresh: "reused",
			expires: 0,
			portalBaseUrl: "https://portal.example",
		},
		{ fetchFn },
		),
		/invalid_grant:.*refresh_token_reused.*Run \/login nous-portal again/,
	);
});

test("login rejects a token without inference:invoke scope", async () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const { fetchFn } = fetchSequence([
		{ body: deviceCode() },
		{
			body: {
				access_token: invokeJwt(now / 1000 + 900, "inference:mint_agent_key"),
				refresh_token: "refresh",
				expires_in: 900,
				scope: "inference:mint_agent_key",
			},
		},
	]);

	await assert.rejects(
		loginNousPortal(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetchFn, now: () => now, portalBaseUrl: "https://portal.example" },
		),
		/missing the required inference:invoke scope/,
	);
});
