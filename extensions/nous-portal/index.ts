import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	getNousPortalApiKey,
	loginNousPortal,
	refreshNousPortalCredentials,
} from "./auth.ts";
import {
	DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
	PROVIDER_ID,
	PROVIDER_NAME,
	fetchModelCatalog,
	getInferenceBaseUrl,
} from "./models.ts";

export default function nousPortalProvider(pi: ExtensionAPI): void {
	const baseUrl = getInferenceBaseUrl();
	pi.registerProvider(PROVIDER_ID, {
		baseUrl,
		...(process.env.NOUS_API_KEY?.trim() ? { apiKey: "NOUS_API_KEY" } : {}),
		api: "openai-completions",
		fetchDynamicModels: (apiKey) =>
			fetchModelCatalog(apiKey, baseUrl, { timeoutMs: DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS }),
		oauth: {
			name: PROVIDER_NAME,
			login: loginNousPortal,
			refreshToken: refreshNousPortalCredentials,
			getApiKey: getNousPortalApiKey,
		},
	});
}

export {
	PROVIDER_ID,
	PROVIDER_NAME,
	fetchModelCatalog,
	loginNousPortal,
	refreshNousPortalCredentials,
};
