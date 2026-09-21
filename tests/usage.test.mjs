import assert from "node:assert/strict";
import test from "node:test";

import nousPortalProvider, { PROVIDER_ID } from "../extensions/nous-portal/index.ts";
import { nousPortalUsageProvider } from "../extensions/nous-portal/usage.ts";

/** Headers observed from a live `POST /v1/chat/completions` on the free tier. */
const LIVE_HEADERS = {
	"x-ratelimit-limit-requests": "400",
	"x-ratelimit-limit-requests-1h": "16800",
	"x-ratelimit-limit-tokens": "4000000",
	"x-ratelimit-limit-tokens-1h": "168000000",
	"x-ratelimit-remaining-requests": "399",
	"x-ratelimit-remaining-requests-1h": "16792",
	"x-ratelimit-remaining-tokens": "3999832",
	"x-ratelimit-remaining-tokens-1h": "167999475",
	"x-ratelimit-reset-requests": "59.999",
	"x-ratelimit-reset-requests-1h": "129.249",
	"x-ratelimit-reset-tokens": "56.899",
	"x-ratelimit-reset-tokens-1h": "125.899",
	host: "oscar-free",
};

function probeContext(response) {
	const calls = [];
	return {
		calls,
		ctx: {
			fetch: async (input, init) => {
				calls.push({ url: String(input), init, body: JSON.parse(init.body) });
				return response;
			},
		},
	};
}

test("registration exposes the usage provider alongside OAuth", () => {
	let registration;
	nousPortalProvider({
		registerProvider(id, config) {
			registration = { id, config };
		},
	});
	assert.equal(registration.id, PROVIDER_ID);
	assert.equal(registration.config.usage, nousPortalUsageProvider);
	assert.equal(registration.config.oauth.name, "Nous Research Portal");
});

test("parses the rolling-hour quota and ignores the per-minute burst counters", () => {
	const now = 1_700_000_000_000;
	const report = nousPortalUsageProvider.parseRateLimitHeaders(LIVE_HEADERS, now);

	assert.equal(report.provider, PROVIDER_ID);
	assert.equal(report.metadata.tier, "oscar-free");
	// Per-minute counters must not surface: a 60s window resets before it can be read.
	assert.deepEqual(
		report.limits.map(limit => limit.id),
		["requests-1h", "tokens-1h"],
	);

	const requests = report.limits[0];
	assert.equal(requests.amount.used, 8);
	assert.equal(requests.amount.limit, 16800);
	assert.equal(requests.amount.remaining, 16792);
	assert.equal(requests.amount.unit, "requests");
	assert.equal(requests.window.resetsAt, now + 129_249);

	const tokens = report.limits[1];
	assert.equal(tokens.amount.used, 525);
	assert.equal(tokens.amount.unit, "tokens");
});

test("marks a fully consumed window as exhausted", () => {
	const report = nousPortalUsageProvider.parseRateLimitHeaders({
		"x-ratelimit-limit-requests-1h": "100",
		"x-ratelimit-remaining-requests-1h": "0",
	});
	assert.equal(report.limits[0].status, "exhausted");
	assert.equal(report.limits[0].amount.remainingFraction, 0);
});

test("returns no report when the response carries no quota headers", () => {
	assert.equal(nousPortalUsageProvider.parseRateLimitHeaders({}, 1), null);
	assert.equal(nousPortalUsageProvider.parseRateLimitHeaders({ host: "oscar-free" }, 1), null);
});

test("probes a free model so usage polling never incurs cost", async () => {
	const { calls, ctx } = probeContext(new Response("{}", { status: 200, headers: LIVE_HEADERS }));
	const report = await nousPortalUsageProvider.fetchUsage(
		{
			provider: PROVIDER_ID,
			credential: { type: "oauth", accessToken: "invoke-jwt" },
			baseUrl: "https://inference-api.nousresearch.com/v1",
		},
		ctx,
	);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://inference-api.nousresearch.com/v1/chat/completions");
	assert.equal(calls[0].init.headers.authorization, "Bearer invoke-jwt");
	// The probe must stay on the free path; a paid model would bill the account.
	assert.match(calls[0].body.model, /:free$/u);
	assert.equal(report.limits.length, 2);
});

test("skips the probe when the credential carries no bearer bytes", async () => {
	const { calls, ctx } = probeContext(new Response("{}", { status: 200 }));
	const report = await nousPortalUsageProvider.fetchUsage(
		{ provider: PROVIDER_ID, credential: { type: "oauth" } },
		ctx,
	);
	assert.equal(report, null);
	assert.equal(calls.length, 0);
});

test("propagates a rejected credential so stale quota is not replayed", async () => {
	const { ctx } = probeContext(new Response("{}", { status: 401 }));
	await assert.rejects(
		nousPortalUsageProvider.fetchUsage(
			{
				provider: PROVIDER_ID,
				credential: { type: "oauth", accessToken: "revoked" },
				baseUrl: "https://inference-api.nousresearch.com/v1",
			},
			ctx,
		),
		/HTTP 401/u,
	);
});
