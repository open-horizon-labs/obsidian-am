import type {
	MarvinTransport,
	MarvinTransportRequest,
	MarvinTransportResponse,
} from "./types.js";

export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

function responseHeaders(headers: Headers): Record<string, string> {
	return Object.fromEntries(
		Array.from(headers.entries()).map(([key, value]) => [key.toLowerCase(), value]),
	);
}

export class FetchTransport implements MarvinTransport {
	constructor(private readonly fetch: FetchLike = globalThis.fetch) {
		if (!fetch) {
			throw new Error("A fetch implementation is required");
		}
	}

	async request(request: MarvinTransportRequest): Promise<MarvinTransportResponse> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), request.timeoutMs);

		try {
			const response = await this.fetch(request.url, {
				method: request.method,
				headers: request.headers,
				...(request.body === undefined ? {} : { body: request.body }),
				signal: controller.signal,
			});

			return {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders(response.headers),
				text: await response.text(),
			};
		} finally {
			clearTimeout(timeout);
		}
	}
}
