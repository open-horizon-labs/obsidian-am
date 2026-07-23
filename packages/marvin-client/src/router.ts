import { MarvinApiClient } from "./client.js";
import {
	MarvinReadCache,
	type MarvinCachePolicy,
} from "./cache.js";
import {
	MarvinError,
	MarvinRouteError,
	asMarvinError,
} from "./errors.js";
import type {
	AddTaskRequest,
	Category,
	MarkDoneResult,
	MarvinErrorSummary,
	MarvinItem,
	MarvinOrigin,
	MarvinReadResult,
	Project,
	Task,
	TaskOrProject,
} from "./types.js";

const LOCAL_FALLBACK_STATUSES = new Set([404, 405, 500, 501, 502, 503, 504]);
const DEFAULT_THROTTLE_BLOCK_MS = 60_000;

const DEFAULT_CACHE_POLICIES = {
	today: { freshTtlMs: 30_000, staleIfErrorMs: 10 * 60_000 },
	due: { freshTtlMs: 30_000, staleIfErrorMs: 10 * 60_000 },
	children: { freshTtlMs: 60_000, staleIfErrorMs: 15 * 60_000 },
	categories: { freshTtlMs: 5 * 60_000, staleIfErrorMs: 60 * 60_000 },
} satisfies Record<ReadKind, MarvinCachePolicy>;

type ReadKind = "today" | "due" | "children" | "categories";

export interface MarvinRouterOptions {
	publicClient: MarvinApiClient;
	localClient?: MarvinApiClient;
	cache?: MarvinReadCache;
	cachePolicies?: Partial<Record<ReadKind, MarvinCachePolicy>>;
	now?: () => number;
}

interface RoutedValue<T> {
	data: T;
	origin: Exclude<MarvinOrigin, "mixed">;
	warnings: MarvinErrorSummary[];
}

export function dedupeById<T extends BaseId>(items: Iterable<T>): T[] {
	const byId = new Map<string, T>();
	for (const item of items) {
		if (!byId.has(item._id)) {
			byId.set(item._id, item);
		}
	}
	return Array.from(byId.values());
}

interface BaseId {
	_id: string;
}

export function marvinDeepLink(item: Pick<MarvinItem, "_id" | "type">): string {
	const isContainer = item.type === "project" || item.type === "category";
	return `https://app.amazingmarvin.com/#${isContainer ? "p" : "t"}=${item._id}`;
}

export class MarvinRouter {
	private readonly publicClient: MarvinApiClient;
	private readonly localClient: MarvinApiClient | undefined;
	private readonly cache: MarvinReadCache;
	private readonly policies: Record<ReadKind, MarvinCachePolicy>;
	private readonly now: () => number;
	private readonly inFlight = new Map<string, Promise<MarvinReadResult<unknown>>>();
	private publicBlockedUntil = 0;

	constructor(options: MarvinRouterOptions) {
		this.publicClient = options.publicClient;
		this.localClient = options.localClient;
		this.cache = options.cache ?? new MarvinReadCache();
		this.policies = {
			...DEFAULT_CACHE_POLICIES,
			...options.cachePolicies,
		};
		this.now = options.now ?? Date.now;
	}

	getTodayItems(date?: string): Promise<MarvinReadResult<TaskOrProject[]>> {
		return this.readThrough(
			`today:${date ?? "server-today"}`,
			this.policies.today,
			"today items",
			(client) => client.getTodayItems(date),
		);
	}

	getDueItems(by?: string): Promise<MarvinReadResult<TaskOrProject[]>> {
		return this.readThrough(
			`due:${by ?? "server-today"}`,
			this.policies.due,
			"due items",
			(client) => client.getDueItems(by),
		);
	}

	getCategories(): Promise<MarvinReadResult<(Category | Project)[]>> {
		return this.readThrough(
			"categories",
			this.policies.categories,
			"categories",
			(client) => client.getCategories(),
		);
	}

	getChildren(parentId: string): Promise<MarvinReadResult<(Task | Project)[]>> {
		return this.readThrough(
			`children:${parentId}`,
			this.policies.children,
			"children",
			(client) => client.getChildren(parentId),
		);
	}

	async getTodayAndDue(date: string): Promise<MarvinReadResult<TaskOrProject[]>> {
		const [today, due] = await Promise.all([
			this.getTodayItems(date),
			this.getDueItems(date),
		]);
		const fetchedAt = Math.min(today.fetchedAt, due.fetchedAt);

		return {
			data: dedupeById([...today.data, ...due.data]),
			freshness: this.leastFresh(today.freshness, due.freshness),
			origin: today.origin === due.origin ? today.origin : "mixed",
			fetchedAt,
			ageMs: Math.max(0, this.now() - fetchedAt),
			warnings: [...today.warnings, ...due.warnings],
		};
	}

	async addTask(task: AddTaskRequest): Promise<Task> {
		try {
			return await this.runPublic("add task", (client) => client.addTask(task));
		} finally {
			this.invalidateTaskLists();
		}
	}

	async markDone(itemId: string, timeZoneOffset?: number): Promise<MarkDoneResult> {
		try {
			return await this.runPublic(
				"mark done",
				(client) => client.markDone(itemId, timeZoneOffset),
			);
		} finally {
			this.invalidateTaskLists();
		}
	}

	clearCache(): void {
		this.cache.clear();
	}

	private invalidateTaskLists(): void {
		this.cache.invalidatePrefixes(["today:", "due:", "children:"]);
	}

	private async readThrough<T>(
		key: string,
		policy: MarvinCachePolicy,
		operation: string,
		read: (client: MarvinApiClient) => Promise<T>,
	): Promise<MarvinReadResult<T>> {
		const startedAt = this.now();
		const cached = this.cache.get<T>(key, startedAt);
		if (cached && cached.expiresAt > startedAt) {
			return {
				data: cached.data,
				freshness: "cached",
				origin: cached.origin,
				fetchedAt: cached.fetchedAt,
				ageMs: Math.max(0, startedAt - cached.fetchedAt),
				warnings: cached.warnings,
			};
		}

		const existing = this.inFlight.get(key) as Promise<MarvinReadResult<T>> | undefined;
		if (existing) {
			return existing;
		}

		const pending = this.fetchAndCache(
			key,
			policy,
			operation,
			read,
			cached,
		).finally(() => {
			this.inFlight.delete(key);
		});
		this.inFlight.set(key, pending as Promise<MarvinReadResult<unknown>>);
		return pending;
	}

	private async fetchAndCache<T>(
		key: string,
		policy: MarvinCachePolicy,
		operation: string,
		read: (client: MarvinApiClient) => Promise<T>,
		stale: ReturnType<MarvinReadCache["get"]> | undefined,
	): Promise<MarvinReadResult<T>> {
		try {
			const routed = await this.routeRead(operation, read);
			const fetchedAt = this.now();
			this.cache.set(key, { ...routed, fetchedAt }, policy);
			return {
				...routed,
				freshness: "fresh",
				fetchedAt,
				ageMs: 0,
			};
		} catch (error) {
			const routeError = error instanceof MarvinRouteError
				? error
				: new MarvinRouteError(operation, [
					asMarvinError(error, { operation, origin: "public" }),
				]);
			const now = this.now();
			if (stale && stale.staleUntil > now && routeError.isTransient()) {
				return {
					data: stale.data as T,
					freshness: "stale",
					origin: stale.origin,
					fetchedAt: stale.fetchedAt,
					ageMs: Math.max(0, now - stale.fetchedAt),
					warnings: [
						...stale.warnings,
						...routeError.attempts.map((attempt) => attempt.toSummary()),
					],
				};
			}
			throw routeError;
		}
	}

	private async routeRead<T>(
		operation: string,
		read: (client: MarvinApiClient) => Promise<T>,
	): Promise<RoutedValue<T>> {
		const attempts: MarvinError[] = [];

		if (this.localClient) {
			try {
				return {
					data: await read(this.localClient),
					origin: "local",
					warnings: [],
				};
			} catch (error) {
				const localError = asMarvinError(error, {
					operation,
					origin: "local",
				});
				attempts.push(localError);
				if (!this.mayFallBackFromLocal(localError)) {
					throw new MarvinRouteError(operation, attempts);
				}
			}
		}

		try {
			return {
				data: await this.runPublic(operation, read),
				origin: "public",
				warnings: attempts.map((attempt) => attempt.toSummary()),
			};
		} catch (error) {
			attempts.push(asMarvinError(error, { operation, origin: "public" }));
			throw new MarvinRouteError(operation, attempts);
		}
	}

	private mayFallBackFromLocal(error: MarvinError): boolean {
		return error.kind === "transport"
			|| (error.status !== undefined && LOCAL_FALLBACK_STATUSES.has(error.status));
	}

	private async runPublic<T>(
		operation: string,
		call: (client: MarvinApiClient) => Promise<T>,
	): Promise<T> {
		const now = this.now();
		if (this.publicBlockedUntil > now) {
			throw new MarvinError({
				kind: "throttle",
				message: `Amazing Marvin public API is throttled for ${this.publicBlockedUntil - now}ms`,
				operation,
				origin: "public",
				status: 429,
				retryAfterMs: this.publicBlockedUntil - now,
			});
		}

		try {
			return await call(this.publicClient);
		} catch (error) {
			const marvinError = asMarvinError(error, {
				operation,
				origin: "public",
			});
			if (marvinError.status === 429) {
				this.publicBlockedUntil = now
					+ (marvinError.retryAfterMs ?? DEFAULT_THROTTLE_BLOCK_MS);
			}
			throw marvinError;
		}
	}

	private leastFresh(
		left: MarvinReadResult<unknown>["freshness"],
		right: MarvinReadResult<unknown>["freshness"],
	): MarvinReadResult<unknown>["freshness"] {
		const score = { fresh: 0, cached: 1, stale: 2 } as const;
		return score[left] >= score[right] ? left : right;
	}
}
