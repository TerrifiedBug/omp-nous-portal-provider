export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type TimedRequestOptions = {
	fetchFn: FetchLike;
	url: string;
	init: RequestInit;
	timeoutMs: number;
	timeoutMessage: string;
	signal?: AbortSignal;
};

export function abortError(signal?: AbortSignal): Error {
	return signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

export function assertNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}

export function createTimedSignal(
	timeoutMs: number,
	timeoutMessage: string,
	parent?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const abortFromParent = () => controller.abort(parent?.reason);
	if (parent?.aborted) controller.abort(parent.reason);
	else parent?.addEventListener("abort", abortFromParent, { once: true });
	if (timeoutMs > 0) timeout = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs);
	return {
		signal: controller.signal,
		cleanup: () => {
			if (timeout) clearTimeout(timeout);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

export async function timedFetch(options: TimedRequestOptions): Promise<Response> {
	const { signal, cleanup } = createTimedSignal(options.timeoutMs, options.timeoutMessage, options.signal);
	try {
		return await options.fetchFn(options.url, { ...options.init, signal });
	} finally {
		cleanup();
	}
}

export async function parseJsonOrTextResponse(response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) return response.json();
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

export async function readBoundedTextBody(response: Response, maxBytes: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) {
		const text = await response.text();
		if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("Response body exceeds size limit");
		return text;
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			throw new Error("Response body exceeds size limit");
		}
		chunks.push(value);
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}
