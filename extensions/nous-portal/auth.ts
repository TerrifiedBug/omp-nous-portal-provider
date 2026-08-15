import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import { normalizeBaseUrl } from "./models.ts";
import {
	abortError,
	assertNotAborted,
	parseJsonOrTextResponse,
	timedFetch,
	type FetchLike,
} from "./provider-requests.ts";

export const DEFAULT_PORTAL_BASE_URL = "https://portal.nousresearch.com";
export const DEFAULT_CLIENT_ID = "hermes-cli";
export const DEFAULT_SCOPE = "inference:invoke";
export const DEFAULT_MIN_TOKEN_TTL_SECONDS = 120;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
export const DEVICE_POLL_INTERVAL_CAP_SECONDS = 30;

const TERMINAL_REFRESH_ERRORS = new Set(["invalid_grant", "invalid_token", "refresh_token_reused"]);

type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export type NousOAuthOptions = {
	fetchFn?: FetchLike;
	sleepFn?: SleepFn;
	now?: () => number;
	portalBaseUrl?: string;
	clientId?: string;
	scope?: string;
	minTokenTtlSeconds?: number;
	requestTimeoutMs?: number;
};

type RuntimeConfig = Required<Omit<NousOAuthOptions, "fetchFn" | "sleepFn" | "now">> & {
	fetchFn: FetchLike;
	sleepFn: SleepFn;
	now: () => number;
};

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
};

type TokenResponse = {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	token_type?: string;
	scope?: string;
};

export type NousOAuthCredentials = OAuthCredentials & {
	tokenType?: string;
	scope?: string;
	portalBaseUrl?: string;
	clientId?: string;
};

class PortalHttpError extends Error {
	readonly status: number;
	readonly code?: string;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = "PortalHttpError";
		this.status = status;
		this.code = code;
	}
}

export function getPortalBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	return normalizeBaseUrl(env.NOUS_PORTAL_BASE_URL, DEFAULT_PORTAL_BASE_URL);
}

export function getClientId(env: NodeJS.ProcessEnv = process.env): string {
	return env.NOUS_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
}

export function getMinTokenTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number(env.NOUS_MIN_TOKEN_TTL_SECONDS);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MIN_TOKEN_TTL_SECONDS;
}

function resolveOptions(options: NousOAuthOptions = {}): RuntimeConfig {
	return {
		fetchFn: options.fetchFn ?? fetch,
		sleepFn: options.sleepFn ?? sleep,
		now: options.now ?? Date.now,
		portalBaseUrl: normalizeBaseUrl(options.portalBaseUrl ?? process.env.NOUS_PORTAL_BASE_URL, DEFAULT_PORTAL_BASE_URL),
		clientId: options.clientId?.trim() || getClientId(),
		scope: options.scope?.trim() || DEFAULT_SCOPE,
		minTokenTtlSeconds: Math.max(60, Math.floor(options.minTokenTtlSeconds ?? getMinTokenTtlSeconds())),
		requestTimeoutMs: Math.max(1, Math.floor(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)),
	};
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timeout);
			cleanup();
			reject(abortError(signal));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

async function request(
	config: RuntimeConfig,
	url: string,
	init: RequestInit,
	parentSignal?: AbortSignal,
): Promise<Response> {
	return timedFetch({
		fetchFn: config.fetchFn,
		url,
		init,
		timeoutMs: config.requestTimeoutMs,
		timeoutMessage: "Nous Portal request timed out",
		signal: parentSignal,
	});
}

async function postForm(
	config: RuntimeConfig,
	path: string,
	body: Record<string, string>,
	parentSignal?: AbortSignal,
	headers: Record<string, string> = {},
): Promise<Response> {
	return request(
		config,
		`${config.portalBaseUrl}${path}`,
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
				...headers,
			},
			redirect: "error",
			body: new URLSearchParams(body).toString(),
		},
		parentSignal,
	);
}

async function responseError(response: Response, fallback: string): Promise<PortalHttpError> {
	const payload = asRecord(await parseJsonOrTextResponse(response).catch(() => ({})));
	const code = asString(payload.error);
	const description = asString(payload.error_description) ?? asString(payload.message);
	return new PortalHttpError(`${code ? `${code}: ` : ""}${description ?? fallback}`, response.status, code);
}

async function requestDeviceCode(config: RuntimeConfig, signal?: AbortSignal): Promise<DeviceCodeResponse> {
	const response = await postForm(
		config,
		"/api/oauth/device/code",
		{ client_id: config.clientId, scope: config.scope },
		signal,
	);
	if (!response.ok) throw await responseError(response, "Device code request failed");
	const data = asRecord(await parseJsonOrTextResponse(response));
	const required = ["device_code", "user_code", "verification_uri", "verification_uri_complete"];
	const missing = required.filter((key) => !asString(data[key]));
	if (missing.length > 0) throw new Error(`Device code response missing fields: ${missing.join(", ")}`);
	const expiresIn = asNumber(data.expires_in);
	const interval = asNumber(data.interval);
	if (!expiresIn || !interval) throw new Error("Device code response missing expires_in or interval");
	return {
		device_code: asString(data.device_code)!,
		user_code: asString(data.user_code)!,
		verification_uri: asString(data.verification_uri)!,
		verification_uri_complete: asString(data.verification_uri_complete)!,
		expires_in: expiresIn,
		interval,
	};
}

function validateTokenResponse(payload: unknown): TokenResponse {
	const data = asRecord(payload);
	const accessToken = asString(data.access_token);
	if (!accessToken) throw new Error("Token response missing access_token");
	return {
		access_token: accessToken,
		refresh_token: asString(data.refresh_token),
		expires_in: asNumber(data.expires_in),
		token_type: asString(data.token_type),
		scope: asString(data.scope),
	};
}

async function pollForToken(
	config: RuntimeConfig,
	device: DeviceCodeResponse,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	const deadline = config.now() + Math.max(1, device.expires_in) * 1000;
	let intervalSeconds = Math.max(1, Math.min(device.interval, DEVICE_POLL_INTERVAL_CAP_SECONDS));
	while (config.now() < deadline) {
		assertNotAborted(signal);
		const response = await postForm(
			config,
			"/api/oauth/token",
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: config.clientId,
				device_code: device.device_code,
			},
			signal,
		);
		if (response.ok) return validateTokenResponse(await parseJsonOrTextResponse(response));

		const error = await responseError(response, "Token polling failed");
		if (error.code === "authorization_pending") {
			await config.sleepFn(intervalSeconds * 1000, signal);
			continue;
		}
		if (error.code === "slow_down") {
			intervalSeconds = Math.min(intervalSeconds + 1, DEVICE_POLL_INTERVAL_CAP_SECONDS);
			await config.sleepFn(intervalSeconds * 1000, signal);
			continue;
		}
		if (error.code === "access_denied" || error.code === "authorization_denied") {
			throw new Error("Nous Portal login was denied.");
		}
		if (error.code === "expired_token") throw new Error("Nous Portal device authorization expired.");
		throw error;
	}
	throw new Error(
		`Timed out waiting for Nous Portal device authorization. Complete any CAPTCHA at ${config.portalBaseUrl}/login and try again.`,
	);
}

function jwtClaims(token: string): Record<string, unknown> {
	const payload = token.split(".")[1];
	if (!payload) return {};
	try {
		return asRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
	} catch {
		return {};
	}
}

function tokenScopes(token: TokenResponse, fallbackScope: string): Set<string> {
	const claims = jwtClaims(token.access_token);
	const values = [token.scope, fallbackScope, asString(claims.scope)];
	const scp = claims.scp;
	if (typeof scp === "string") values.push(scp);
	if (Array.isArray(scp)) values.push(...scp.filter((item): item is string => typeof item === "string"));
	return new Set(values.flatMap((value) => value?.split(/[ ,]+/).filter(Boolean) ?? []));
}

function tokenCredentials(
	config: RuntimeConfig,
	token: TokenResponse,
	refreshToken: string,
	previous?: NousOAuthCredentials,
): NousOAuthCredentials {
	const scope = token.scope ?? previous?.scope ?? config.scope;
	if (!tokenScopes(token, scope).has(DEFAULT_SCOPE)) {
		throw new Error(`Nous Portal token is missing the required ${DEFAULT_SCOPE} scope. Run /login nous-portal again.`);
	}
	const claimExpiry = asNumber(jwtClaims(token.access_token).exp);
	const hardExpiry = claimExpiry ? claimExpiry * 1000 : config.now() + Math.max(60, Math.floor(token.expires_in ?? 3600)) * 1000;
	return {
		...previous,
		refresh: token.refresh_token ?? refreshToken,
		access: token.access_token,
		expires: hardExpiry - config.minTokenTtlSeconds * 1000,
		tokenType: token.token_type ?? previous?.tokenType ?? "Bearer",
		scope,
		portalBaseUrl: previous?.portalBaseUrl ?? config.portalBaseUrl,
		clientId: previous?.clientId ?? config.clientId,
	};
}

function presentDeviceCode(callbacks: OAuthLoginCallbacks, device: DeviceCodeResponse): void {
	callbacks.onAuth({
		url: device.verification_uri_complete,
		instructions: `Approve the login as user code ${device.user_code}. If the page does not prefill it, open ${device.verification_uri} and enter the code manually.`,
	});
	callbacks.onProgress?.(`Waiting for Nous Portal approval of code ${device.user_code}...`);
}

export async function loginNousPortal(
	callbacks: OAuthLoginCallbacks,
	options: NousOAuthOptions = {},
): Promise<OAuthCredentials> {
	const config = resolveOptions({ ...options, fetchFn: options.fetchFn ?? callbacks.fetch });
	const device = await requestDeviceCode(config, callbacks.signal);
	presentDeviceCode(callbacks, device);
	const token = await pollForToken(config, device, callbacks.signal);
	if (!token.refresh_token) throw new Error("Token response missing refresh_token");
	return tokenCredentials(config, token, token.refresh_token);
}

export async function refreshNousPortalCredentials(
	credentials: OAuthCredentials,
	options: NousOAuthOptions = {},
): Promise<OAuthCredentials> {
	const current = credentials as NousOAuthCredentials;
	if (!current.refresh?.trim()) throw new Error("Nous Portal refresh token is missing. Run /login nous-portal again.");
	const config = resolveOptions({
		...options,
		portalBaseUrl: options.portalBaseUrl ?? current.portalBaseUrl,
		clientId: options.clientId ?? current.clientId,
		scope: options.scope ?? current.scope,
	});
	const response = await postForm(
		config,
		"/api/oauth/token",
		{ grant_type: "refresh_token", client_id: config.clientId },
		undefined,
		{ "x-nous-refresh-token": current.refresh },
	);
	if (!response.ok) {
		const error = await responseError(response, "Refresh token exchange failed");
		if (error.code && TERMINAL_REFRESH_ERRORS.has(error.code)) {
			throw new Error(`invalid_grant: Nous Portal session expired (${error.code}). Run /login nous-portal again.`);
		}
		throw error;
	}
	return tokenCredentials(
		config,
		validateTokenResponse(await parseJsonOrTextResponse(response)),
		current.refresh,
		current,
	);
}

export function getNousPortalApiKey(credentials: OAuthCredentials): string {
	return credentials.access;
}
