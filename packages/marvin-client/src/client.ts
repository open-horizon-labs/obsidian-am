import { asMarvinError, MarvinError } from "./errors.js";
import type {
	AddTaskRequest,
	Category,
	MarkDoneResult,
	MarvinOrigin,
	MarvinTransport,
	MarvinTransportRequest,
	Project,
	Task,
	TaskOrProject,
} from "./types.js";

const DEFAULT_PUBLIC_BASE_URL = "https://serv.amazingmarvin.com/api";

export interface MarvinApiClientOptions {
	apiToken: string;
	transport: MarvinTransport;
	origin: Exclude<MarvinOrigin, "mixed">;
	baseUrl?: string;
	timeoutMs?: number;
}

function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
	if (!value) {
		return undefined;
	}

	const seconds = Number(value);
	if (!Number.isNaN(seconds)) {
		return Math.max(0, Math.floor(seconds * 1_000));
	}

	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function requireArray<T>(
	value: unknown,
	context: {
		operation: string;
		origin: Exclude<MarvinOrigin, "mixed">;
		endpoint: string;
		method: string;
	},
): T[] {
	if (!Array.isArray(value)) {
		throw new MarvinError({
			kind: "validation",
			message: `Amazing Marvin ${context.operation} returned a non-array response`,
			...context,
		});
	}
	return value as T[];
}

function requireTask(
	value: unknown,
	context: {
		operation: string;
		origin: Exclude<MarvinOrigin, "mixed">;
		endpoint: string;
		method: string;
	},
): Task {
	if (
		typeof value !== "object"
		|| value === null
		|| typeof (value as Partial<Task>)._id !== "string"
		|| typeof (value as Partial<Task>).title !== "string"
	) {
		throw new MarvinError({
			kind: "validation",
			message: `Amazing Marvin ${context.operation} returned an invalid task`,
			...context,
		});
	}
	return value as Task;
}

export class MarvinApiClient {
	readonly origin: Exclude<MarvinOrigin, "mixed">;
	private readonly apiToken: string;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly transport: MarvinTransport;

	constructor(options: MarvinApiClientOptions) {
		if (!options.apiToken.trim()) {
			throw new Error("Amazing Marvin API token is required");
		}
		this.apiToken = options.apiToken;
		this.transport = options.transport;
		this.origin = options.origin;
		this.baseUrl = (options.baseUrl ?? DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, "");
		this.timeoutMs = options.timeoutMs ?? 10_000;
		if (this.timeoutMs <= 0) {
			throw new Error("Amazing Marvin timeout must be greater than zero");
		}
	}

	async getTodayItems(date?: string): Promise<TaskOrProject[]> {
		const endpoint = this.withQuery("/todayItems", date ? { date } : {});
		const value = await this.requestJson("today items", endpoint, "GET");
		return requireArray<TaskOrProject>(value, this.context("today items", endpoint, "GET"));
	}

	async getDueItems(by?: string): Promise<TaskOrProject[]> {
		const endpoint = this.withQuery("/dueItems", by ? { by } : {});
		const value = await this.requestJson("due items", endpoint, "GET");
		return requireArray<TaskOrProject>(value, this.context("due items", endpoint, "GET"));
	}

	async getCategories(): Promise<(Category | Project)[]> {
		const endpoint = "/categories";
		const value = await this.requestJson("categories", endpoint, "GET");
		return requireArray<Category | Project>(
			value,
			this.context("categories", endpoint, "GET"),
		);
	}

	async getChildren(parentId: string): Promise<(Task | Project)[]> {
		const endpoint = this.withQuery("/children", { parentId });
		const value = await this.requestJson("children", endpoint, "GET");
		return requireArray<Task | Project>(value, this.context("children", endpoint, "GET"));
	}

	async addTask(task: AddTaskRequest): Promise<Task> {
		const endpoint = "/addTask";
		const value = await this.requestJson("add task", endpoint, "POST", {
			done: false,
			...task,
		});
		return requireTask(value, this.context("add task", endpoint, "POST"));
	}

	async markDone(itemId: string, timeZoneOffset?: number): Promise<MarkDoneResult> {
		const endpoint = "/markDone";
		const value = await this.requestJson(
			"mark done",
			endpoint,
			"POST",
			{
				itemId,
				...(timeZoneOffset === undefined ? {} : { timeZoneOffset }),
			},
			true,
		);

		if (value === null) {
			return null;
		}
		if (typeof value !== "object" || Array.isArray(value)) {
			throw new MarvinError({
				kind: "validation",
				message: "Amazing Marvin mark done returned an invalid response",
				...this.context("mark done", endpoint, "POST"),
			});
		}
		return value as Record<string, unknown>;
	}

	private context(
		operation: string,
		endpoint: string,
		method: MarvinTransportRequest["method"],
	) {
		return {
			operation,
			origin: this.origin,
			endpoint,
			method,
		};
	}

	private withQuery(endpoint: string, query: Record<string, string>): string {
		const params = new URLSearchParams(query);
		const serialized = params.toString();
		return serialized ? `${endpoint}?${serialized}` : endpoint;
	}

	private async requestJson(
		operation: string,
		endpoint: string,
		method: MarvinTransportRequest["method"],
		body?: unknown,
		allowEmpty = false,
	): Promise<unknown> {
		const request: MarvinTransportRequest = {
			url: `${this.baseUrl}${endpoint}`,
			method,
			headers: {
				"Content-Type": "application/json",
				"X-API-Token": this.apiToken,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			timeoutMs: this.timeoutMs,
		};

		let response;
		try {
			response = await this.transport.request(request);
		} catch (error) {
			throw asMarvinError(error, {
				kind: "transport",
				...this.context(operation, endpoint, method),
			});
		}

		if (response.status < 200 || response.status >= 300) {
			const retryAfterMs = parseRetryAfter(response.headers["retry-after"]);
			throw new MarvinError({
				kind: response.status === 429 ? "throttle" : "http",
				message: `Amazing Marvin ${operation} failed with HTTP ${response.status}`,
				...this.context(operation, endpoint, method),
				status: response.status,
				...(response.statusText === undefined ? {} : { statusText: response.statusText }),
				responseBody: response.text,
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			});
		}

		if (!response.text.trim()) {
			if (allowEmpty) {
				return null;
			}
			throw new MarvinError({
				kind: "parse",
				message: `Amazing Marvin ${operation} returned an empty response`,
				...this.context(operation, endpoint, method),
			});
		}

		try {
			return JSON.parse(response.text) as unknown;
		} catch (error) {
			throw new MarvinError({
				kind: "parse",
				message: `Amazing Marvin ${operation} returned invalid JSON`,
				...this.context(operation, endpoint, method),
				responseBody: response.text,
				cause: error,
			});
		}
	}
}
