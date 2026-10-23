import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, RemoteAuthCredentialStore, type AuthBrokerServerHandle } from "@oh-my-pi/pi-ai/auth-broker";
import { mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { Server } from "bun";
import { startNousPortalBroker } from "../../broker.ts";
import { refreshNousPortalCredentials } from "../../extensions/nous-portal/auth.ts";

const BEARER = "isolated-nous-broker-test";
const PROVIDER = "nous-portal";
const MCP_PROVIDER = mcpOAuthCredentialId("https://mcp.example/mcp", "default");

function accessToken(provider: string, generation: number): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({
		exp: Math.floor(Date.now() / 1000) + 3600,
		scope: "inference:invoke",
		provider,
		generation,
		"https://api.openai.com/auth": { chatgpt_account_id: "test-workspace", chatgpt_plan_type: "plus" },
	})}.signature`;
}

let directory: string;
let agentDir: string;
let tokenFile: string;
let endpoint: Server<undefined>;
let broker: AuthBrokerServerHandle | undefined;
let remoteAuth: AuthStorage | undefined;
let calls: Record<string, string[]>;
let minted: Record<string, string>;
let acceptedRefresh: Record<string, string>;

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "nous-plugin-broker-"));
	agentDir = path.join(directory, "agent");
	tokenFile = path.join(directory, "broker.token");
	await Bun.write(tokenFile, BEARER);
	calls = { nous: [], codex: [], mcp: [] };
	minted = {};
	acceptedRefresh = { nous: "nous-initial", codex: "codex-initial", mcp: "mcp-initial" };
	endpoint = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const route = new URL(request.url).pathname;
			const provider = route === "/api/oauth/token" ? "nous" : route === "/codex-token" ? "codex" : "mcp";
			const raw = await request.text();
			const body = request.headers.get("content-type")?.includes("application/json")
				? JSON.parse(raw)
				: Object.fromEntries(new URLSearchParams(raw));
			const refresh = provider === "nous" ? request.headers.get("x-nous-refresh-token") : body.refresh_token;
			if (body.grant_type !== "refresh_token" || refresh !== acceptedRefresh[provider]) {
				return Response.json({ error: "invalid_grant" }, { status: 400 });
			}
			calls[provider].push(refresh);
			minted[provider] = accessToken(provider, calls[provider].length);
			acceptedRefresh[provider] = `${provider}-${calls[provider].length}`;
			return Response.json({
				access_token: minted[provider],
				id_token: minted[provider],
				refresh_token: acceptedRefresh[provider],
				expires_in: 3600,
				scope: "inference:invoke",
			});
		},
	});
	const realFetch = globalThis.fetch;
	spyOn(globalThis, "fetch").mockImplementation(Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === "https://auth.openai.com/oauth/token") return realFetch(`${endpoint.url}codex-token`, init);
			if (new URL(url).hostname === "127.0.0.1") return realFetch(input, init);
			throw new Error(`Test refused an external request to ${new URL(url).hostname}`);
		},
		{ preconnect: realFetch.preconnect },
	));
	const auth = await AuthStorage.create(path.join(agentDir, "agent.db"));
	try {
		const credential = {
			type: "oauth" as const,
			access: "expired-nous-access",
			refresh: "nous-initial",
			expires: Date.now() - 60_000,
			portalBaseUrl: endpoint.url.origin,
			clientId: "hermes-cli",
			scope: "inference:invoke",
		};
		await auth.credentials.set(PROVIDER, credential);
	} finally {
		auth.close();
	}
});

afterEach(async () => {
	remoteAuth?.close();
	remoteAuth = undefined;
	await broker?.close();
	broker = undefined;
	endpoint.stop(true);
	mock.restore();
	await fs.rm(directory, { recursive: true, force: true });
});

test("stock OMP broker renews Nous grants across requests and restart while retaining other refreshers", async () => {
	broker = await startNousPortalBroker({ bind: "127.0.0.1:0", agentDir, tokenFile });
	let client = new AuthBrokerClient({ url: broker.url, token: BEARER });
	let snapshot = await client.fetchSnapshot();
	if (snapshot.status !== 200) throw new Error("Expected a broker snapshot");
	const nousId = snapshot.snapshot.credentials.find(entry => entry.provider === PROVIDER)!.id;
	await client.refreshCredential(nousId, undefined, "auth-recovery");
	remoteAuth = new AuthStorage(new RemoteAuthCredentialStore({ client, streamSnapshots: false }));
	await remoteAuth.credentials.revalidate();
	expect(await remoteAuth.keys.get(PROVIDER)).toBe(minted.nous);
	const visible = remoteAuth.credentials.get(PROVIDER);
	expect(visible?.type === "oauth" ? visible.refresh : undefined).toBe(REMOTE_REFRESH_SENTINEL);
	expect((await fetch(`${broker.url}/v1/snapshot`, { headers: { Authorization: "Bearer wrong-token" } })).status).toBe(401);

	await client.uploadCredential("openai-codex", {
		type: "oauth",
		access: "expired-codex-access",
		refresh: "codex-initial",
		expires: Date.now() - 60_000,
		accountId: "test-workspace",
	});
	const mcpCredential = {
		type: "oauth" as const,
		access: "expired-mcp-access",
		refresh: "mcp-initial",
		expires: Date.now() - 60_000,
		tokenUrl: `${endpoint.url}mcp-token`,
		clientId: "test-mcp-client",
	};
	await client.uploadCredential(MCP_PROVIDER, mcpCredential);
	snapshot = await client.fetchSnapshot();
	if (snapshot.status !== 200) throw new Error("Expected newly stored accounts");
	for (const [provider, expected] of [["openai-codex", "codex"], [MCP_PROVIDER, "mcp"]]) {
		const id = snapshot.snapshot.credentials.find(entry => entry.provider === provider)!.id;
		const result = await client.refreshCredential(id);
		expect(result.entry.credential.type === "oauth" ? result.entry.credential.access : undefined).toBe(minted[expected]);
		expect(calls[expected]).toEqual([`${expected}-initial`]);
	}

	const beforeRenewal = minted.nous;
	const renewed = await client.refreshCredential(nousId);
	expect(renewed.entry.credential.type === "oauth" ? renewed.entry.credential.access : undefined).toBe(minted.nous);
	expect(renewed.entry.credential.type === "oauth" ? renewed.entry.credential.access : undefined).not.toBe(beforeRenewal);
	remoteAuth.close();
	remoteAuth = undefined;
	await broker.close();
	broker = undefined;

	const persisted = await AuthStorage.create(path.join(agentDir, "agent.db"));
	try {
		await persisted.credentials.reload();
		const credential = persisted.credentials.get(PROVIDER);
		expect(credential?.type === "oauth" ? credential.refresh : undefined).toBe(acceptedRefresh.nous);
		expect(persisted.credentials.list(PROVIDER)[0].id).toBe(nousId);
	} finally {
		persisted.close();
	}
	broker = await startNousPortalBroker({ bind: "127.0.0.1:0", agentDir, tokenFile });
	client = new AuthBrokerClient({ url: broker.url, token: BEARER });
	const beforeRestartRenewal = minted.nous;
	const restarted = await client.refreshCredential(nousId);
	expect(restarted.entry.credential.type === "oauth" ? restarted.entry.credential.access : undefined).toBe(minted.nous);
	expect(restarted.entry.credential.type === "oauth" ? restarted.entry.credential.access : undefined).not.toBe(beforeRestartRenewal);
	snapshot = await client.fetchSnapshot();
	if (snapshot.status !== 200) throw new Error("Expected a restarted broker snapshot");
	for (const entry of snapshot.snapshot.credentials) {
		expect(entry.credential.type === "oauth" ? entry.credential.refresh : undefined).toBe(REMOTE_REFRESH_SENTINEL);
	}
});

test("Nous refresh cancellation interrupts the pending token exchange", async () => {
	const arrived = Promise.withResolvers<void>();
	const response = Promise.withResolvers<Response>();
	const stalled = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { arrived.resolve(); return response.promise; } });
	const controller = new AbortController();
	const reason = new Error("refresh ownership ended");
	try {
		const refresh = refreshNousPortalCredentials(
			{ access: "expired", refresh: "unused-refresh", expires: 0 },
			{ portalBaseUrl: stalled.url.origin },
			controller.signal,
		);
		await arrived.promise;
		controller.abort(reason);
		await expect(refresh).rejects.toBe(reason);
	} finally {
		response.resolve(Response.json({ error: "cancelled" }, { status: 503 }));
		stalled.stop(true);
	}
});
