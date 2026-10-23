#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import {
	getAuthBrokerTokenFilePath,
	openAuthCredentialStore,
	startAuthBroker,
	type AuthBrokerServerHandle,
} from "@oh-my-pi/pi-ai/auth-broker";
import { refreshBrokerOAuthCredential } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { logger, VERSION } from "@oh-my-pi/pi-utils";
import { setTransports } from "@oh-my-pi/pi-utils/logger";
import { refreshNousPortalCredentials } from "./extensions/nous-portal/auth.ts";
import { PROVIDER_ID } from "./extensions/nous-portal/models.ts";

export interface NousPortalBrokerOptions {
	bind?: string;
	agentDir?: string;
	tokenFile?: string;
}

/** Start stock OMP's credential broker with the Nous refresher available on its host. */
export async function startNousPortalBroker(options: NousPortalBrokerOptions = {}): Promise<AuthBrokerServerHandle> {
	const tokenFile = options.tokenFile ?? getAuthBrokerTokenFilePath();
	const token = (await fs.readFile(tokenFile, "utf8")).trim();
	if (!token) throw new Error("The broker bearer token file is empty; initialize it with `omp auth-broker token`.");

	// This is the vault owner, never a client of OMP_AUTH_BROKER_URL.
	const { store, sourceLabel } = await openAuthCredentialStore({ brokerConfig: null, agentDir: options.agentDir });
	const storage = new AuthStorage(store, {
		sourceLabel,
		refreshOAuthCredential: (provider, _credentialId, credential, signal) =>
			provider === PROVIDER_ID
				? refreshNousPortalCredentials(credential, undefined, signal)
				: refreshBrokerOAuthCredential(provider, credential, signal),
	});
	try {
		await storage.credentials.reload();
		const broker = startAuthBroker({
			storage,
			bind: options.bind,
			bearerTokens: [token],
			version: VERSION,
		});
		return {
			url: broker.url,
			port: broker.port,
			hostname: broker.hostname,
			async close() {
				try {
					await broker.close();
				} finally {
					storage.close();
				}
			},
		};
	} catch (error) {
		storage.close();
		throw error;
	}
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			bind: { type: "string", short: "b" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		process.stdout.write("Usage: omp-nous-broker [--bind=host:port]\nUses OMP's existing local vault and auth-broker.token file. Requires Bun.\n");
	} else {
		setTransports({ console: true, file: false });
		try {
			const broker = await startNousPortalBroker({ bind: values.bind });
			logger.info("auth-broker listening", { url: broker.url, provider: PROVIDER_ID });
			let stopping = false;
			const shutdown = async () => {
				if (stopping) return;
				stopping = true;
				try {
					await broker.close();
					process.exit(0);
				} catch (error) {
					logger.error("auth-broker shutdown failed", { error: String(error) });
					process.exit(1);
				}
			};
			process.once("SIGINT", () => void shutdown());
			process.once("SIGTERM", () => void shutdown());
		} catch (error) {
			logger.error("auth-broker startup failed", { error: String(error) });
			process.exitCode = 1;
		}
	}
}
