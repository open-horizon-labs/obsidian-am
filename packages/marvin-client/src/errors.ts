import type {
	MarvinErrorSummary,
	MarvinOrigin,
} from "./types.js";

type ErrorKind = MarvinErrorSummary["kind"];
type ConcreteOrigin = Exclude<MarvinOrigin, "mixed">;

export interface MarvinErrorOptions {
	kind: ErrorKind;
	message: string;
	operation: string;
	origin: ConcreteOrigin;
	endpoint?: string;
	method?: string;
	status?: number;
	statusText?: string;
	responseBody?: string;
	retryAfterMs?: number;
	cause?: unknown;
}

export class MarvinError extends Error {
	readonly kind: ErrorKind;
	readonly operation: string;
	readonly origin: ConcreteOrigin;
	readonly endpoint: string | undefined;
	readonly method: string | undefined;
	readonly status: number | undefined;
	readonly statusText: string | undefined;
	readonly responseBody: string | undefined;
	readonly retryAfterMs: number | undefined;
	override readonly cause: unknown;

	constructor(options: MarvinErrorOptions) {
		super(options.message);
		this.name = "MarvinError";
		this.kind = options.kind;
		this.operation = options.operation;
		this.origin = options.origin;
		this.endpoint = options.endpoint;
		this.method = options.method;
		this.status = options.status;
		this.statusText = options.statusText;
		this.responseBody = options.responseBody;
		this.retryAfterMs = options.retryAfterMs;
		this.cause = options.cause;
	}

	isTransient(): boolean {
		return this.kind === "transport"
			|| this.kind === "throttle"
			|| (this.status !== undefined && this.status >= 500);
	}

	toSummary(): MarvinErrorSummary {
		return {
			kind: this.kind,
			message: this.message,
			operation: this.operation,
			origin: this.origin,
			...(this.endpoint === undefined ? {} : { endpoint: this.endpoint }),
			...(this.method === undefined ? {} : { method: this.method }),
			...(this.status === undefined ? {} : { status: this.status }),
			...(this.statusText === undefined ? {} : { statusText: this.statusText }),
			...(this.responseBody === undefined ? {} : { responseBody: this.responseBody }),
			...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
		};
	}
}

export class MarvinRouteError extends MarvinError {
	readonly attempts: MarvinError[];

	constructor(operation: string, attempts: MarvinError[]) {
		const last = attempts[attempts.length - 1];
		super({
			kind: "route",
			message: `Amazing Marvin ${operation} failed via ${attempts
				.map((attempt) => attempt.origin)
				.join(" then ")}`,
			operation,
			origin: last?.origin ?? "public",
			...(last?.endpoint === undefined ? {} : { endpoint: last.endpoint }),
			...(last?.method === undefined ? {} : { method: last.method }),
			...(last?.status === undefined ? {} : { status: last.status }),
			...(last?.statusText === undefined ? {} : { statusText: last.statusText }),
			...(last?.responseBody === undefined ? {} : { responseBody: last.responseBody }),
			...(last?.retryAfterMs === undefined ? {} : { retryAfterMs: last.retryAfterMs }),
			cause: last,
		});
		this.name = "MarvinRouteError";
		this.attempts = attempts;
	}

	override isTransient(): boolean {
		return this.attempts.at(-1)?.isTransient() ?? false;
	}
}

export function asMarvinError(
	error: unknown,
	context: Pick<MarvinErrorOptions, "operation" | "origin"> & Partial<MarvinErrorOptions>,
): MarvinError {
	if (error instanceof MarvinError) {
		return error;
	}

	const cause = error instanceof Error ? error : undefined;
	return new MarvinError({
		kind: "transport",
		message: cause?.message ?? String(error),
		operation: context.operation,
		origin: context.origin,
		...(context.endpoint === undefined ? {} : { endpoint: context.endpoint }),
		...(context.method === undefined ? {} : { method: context.method }),
		cause: error,
	});
}
