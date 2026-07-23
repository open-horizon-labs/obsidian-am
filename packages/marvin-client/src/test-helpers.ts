import type {
	MarvinTransport,
	MarvinTransportRequest,
	MarvinTransportResponse,
} from "./types";

type QueuedResult = MarvinTransportResponse | Error;

export function jsonResponse(
	status: number,
	value: unknown,
	headers: Record<string, string> = {},
): MarvinTransportResponse {
	return {
		status,
		statusText: status >= 200 && status < 300 ? "OK" : "Error",
		headers,
		text: JSON.stringify(value),
	};
}

export class QueueTransport implements MarvinTransport {
	readonly requests: MarvinTransportRequest[] = [];
	private readonly queue: QueuedResult[];

	constructor(...results: QueuedResult[]) {
		this.queue = [...results];
	}

	push(...results: QueuedResult[]): void {
		this.queue.push(...results);
	}

	async request(request: MarvinTransportRequest): Promise<MarvinTransportResponse> {
		this.requests.push(request);
		const next = this.queue.shift();
		if (!next) {
			throw new Error(`No fake response queued for ${request.method} ${request.url}`);
		}
		if (next instanceof Error) {
			throw next;
		}
		return next;
	}
}
