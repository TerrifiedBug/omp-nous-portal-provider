import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport, UsageWindow } from "@oh-my-pi/pi-ai";

import { DEFAULT_INFERENCE_BASE_URL, PROVIDER_ID } from "./models.ts";
import { timedFetch } from "./provider-requests.ts";

/**
 * Nous Portal publishes no usage or credits endpoint. Probes of `/v1/credits`,
 * `/v1/usage`, `/v1/me`, `/v1/account`, `/v1/billing/credits`, `/v1/subscription`
 * and the `portal.` origin all return 404, and `GET /v1/models` carries no quota
 * headers. The only response that reports quota is `POST /v1/chat/completions`,
 * which returns `x-ratelimit-*` for a rolling hour.
 *
 * So quota arrives two ways:
 *   - `parseRateLimitHeaders` reads the headers omp already captures on real
 *     traffic. Free, but only populated once a request has been made.
 *   - `fetchUsage` issues one minimal completion so `/usage` has data on a cold
 *     start. The probe targets a `:free` model, which bills `cost: 0`.
 *
 * Only the rolling hour is reported. Nous also sends per-minute counters, but a
 * 60-second window is a burst guard rather than a budget: it resets faster than
 * the panel refreshes and only adds noise to the card.
 */

/** Free model used for the cold-start probe; override if it is ever retired. */
const PROBE_MODEL = process.env.NOUS_USAGE_PROBE_MODEL?.trim() || "stepfun/step-3.7-flash:free";
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MESSAGE = "Nous usage probe timed out";

/** Each window Nous reports, as (header suffix, window id, label, duration). */
const WINDOWS = [{ suffix: "-1h", id: "1h", label: "1 Hour", durationMs: 3_600_000 }] as const;

/** Each metered unit, as (header infix, unit, label). */
const METERS = [
	{ infix: "requests", unit: "requests", label: "Requests" },
	{ infix: "tokens", unit: "tokens", label: "Tokens" },
] as const;

function readNumber(headers: Record<string, string>, key: string): number | undefined {
	const raw = headers[key];
	if (raw === undefined) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

export const nousPortalUsageProvider: UsageProvider = {
	id: PROVIDER_ID,

	/** The probe authenticates upstream, so it doubles as a credential health check. */
	validatesCredentials: true,

	// A failed or empty poll must not erase the last header-derived snapshot.
	retainLastGoodOnFailure: true,

	/**
	 * Cold-start probe: the cheapest call that still reports quota. Uses the
	 * caller's abort signal so a hung poll cannot pin the usage widget.
	 */
	async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
		const bearer = params.credential.accessToken ?? params.credential.apiKey;
		if (!bearer) return null;

		const base = (params.baseUrl ?? params.credential.apiEndpoint ?? DEFAULT_INFERENCE_BASE_URL).replace(/\/+$/, "");

		const response = await timedFetch({
			fetchFn: ctx.fetch,
			url: `${base}/chat/completions`,
			init: {
				method: "POST",
				headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
				body: JSON.stringify({
					model: PROBE_MODEL,
					messages: [{ role: "user", content: "." }],
					max_tokens: 1,
				}),
			},
			timeoutMs: PROBE_TIMEOUT_MS,
			timeoutMessage: PROBE_TIMEOUT_MESSAGE,
			signal: params.signal,
		});
		// Drain the body so the connection can be reused; the quota lives in headers.
		await response.arrayBuffer().catch(() => undefined);

		// 401/403 must propagate so omp purges stale quota instead of replaying it.
		if (response.status === 401 || response.status === 403) {
			throw new Error(`Nous usage probe rejected the credential (HTTP ${response.status})`);
		}

		const headers: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			headers[key.toLowerCase()] = value;
		});
		return this.parseRateLimitHeaders?.(headers, Date.now(), { responseStatus: response.status }) ?? null;
	},

	parseRateLimitHeaders(headers: Record<string, string>, now = Date.now()): UsageReport | null {
		const limits: UsageLimit[] = [];

		for (const meter of METERS) {
			for (const window of WINDOWS) {
				const limit = readNumber(headers, `x-ratelimit-limit-${meter.infix}${window.suffix}`);
				const remaining = readNumber(headers, `x-ratelimit-remaining-${meter.infix}${window.suffix}`);
				if (limit === undefined || remaining === undefined) continue;

				const resetSeconds = readNumber(headers, `x-ratelimit-reset-${meter.infix}${window.suffix}`);
				const usageWindow: UsageWindow = {
					id: window.id,
					label: window.label,
					durationMs: window.durationMs,
					...(resetSeconds !== undefined ? { resetsAt: now + resetSeconds * 1000 } : {}),
				};

				const used = Math.max(0, limit - remaining);
				const remainingFraction = limit > 0 ? Math.max(0, Math.min(1, remaining / limit)) : undefined;

				limits.push({
					id: `${meter.infix}-${window.id}`,
					label: meter.label,
					scope: { provider: PROVIDER_ID, windowId: window.id },
					window: usageWindow,
					amount: {
						used,
						limit,
						remaining,
						unit: meter.unit,
						...(remainingFraction !== undefined
							? { usedFraction: 1 - remainingFraction, remainingFraction }
							: {}),
					},
					status: remaining <= 0 ? "exhausted" : remainingFraction !== undefined && remainingFraction < 0.1 ? "warning" : "ok",
				});
			}
		}

		if (limits.length === 0) return null;

		// `host: oscar-free` marks a free-tier route; paid traffic reports a
		// different backend. Surfacing it explains why limits differ per account.
		const tier = headers.host;
		return {
			provider: PROVIDER_ID,
			fetchedAt: now,
			limits,
			notes: ["Rolling-hour limits reported by Nous on each completion; no credit balance API exists."],
			...(tier ? { metadata: { tier } } : {}),
		};
	},
};
