import type {
	RequestUrlParam,
	RequestUrlResponse,
} from "obsidian";
import type {
	MarvinTransport,
	MarvinTransportResponse,
} from "@open-horizon/marvin-client";

export type ObsidianRequestUrl = (
	request: RequestUrlParam,
) => Promise<RequestUrlResponse>;

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
	);
}

/**
 * Adapts Obsidian's CORS-free request API to the shared Marvin transport.
 *
 * Obsidian does not expose request cancellation, so timeoutMs is advisory for
 * this adapter. Automatic retries remain disabled to avoid duplicate writes.
 */
export function createObsidianTransport(
	requestUrl: ObsidianRequestUrl,
): MarvinTransport {
	return {
		async request(request): Promise<MarvinTransportResponse> {
			const response = await requestUrl({
				url: request.url,
				method: request.method,
				headers: request.headers,
				...(request.body === undefined ? {} : { body: request.body }),
				throw: false,
			});

			return {
				status: response.status,
				headers: normalizeHeaders(response.headers),
				text: response.text,
			};
		},
	};
}
