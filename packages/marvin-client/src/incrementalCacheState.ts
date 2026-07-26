import type { Category, Project, Task } from "./types.js";

// Shared with src/marvin/incrementalCache.ts (the Obsidian plugin's writer/
// hydrator) and packages/marvin-mcp (a read-only, best-effort consumer of
// whatever cache file the plugin already maintains). Kept here so both
// parse and query the SAME persisted shape — two independent
// re-implementations of this logic drifting apart is exactly the kind of
// bug this repo has already paid for once.

type CouchSequence = unknown;

/** The plugin writes its incremental cache here, inside its own plugin data
 * directory. Named once, shared, so the writer and the cross-process reader
 * can't drift apart. */
export const INCREMENTAL_CACHE_FILENAME = "marvin-incremental-cache-v1.json";

/** Sentinel the MCP server drops beside the cache file to ask the running
 * plugin for a sync. A file, not a socket: the MCP server already has this
 * directory path (it reads the cache from it), so this needs no network
 * listener on the plugin side and no shared secret between the processes.
 * The plugin polls for it, syncs, and deletes it. */
export const INCREMENTAL_SYNC_REQUEST_FILENAME = "marvin-sync-request.json";

export interface IncrementalSyncRequest {
	/** When the request was written, so the plugin can ignore ancient ones
	 * and the requester can tell its own request from a stale leftover. */
	requestedAt: number;
}

export function parseIncrementalSyncRequest(
	value: unknown,
): IncrementalSyncRequest | undefined {
	if (
		typeof value !== "object"
		|| value === null
		|| typeof (value as Partial<IncrementalSyncRequest>).requestedAt !== "number"
	) {
		return undefined;
	}
	return { requestedAt: (value as IncrementalSyncRequest).requestedAt };
}

export type CachedMarvinItem = Category | Project | Task;
export type CachedMarvinContainer = Category | Project;

/** Every field here must be **derived** — reconstructible by re-reading
 * Amazing Marvin from scratch. That invariant is what makes the file
 * disposable: a failed parse re-hydrates instead of migrating, and "Reset
 * cache" is a recovery step rather than data loss.
 *
 * Do not add a field holding the only copy of something. The tempting case is
 * completion history, since Marvin's REST API cannot list what was completed
 * on a day — which is exactly why storing it here would make this a system of
 * record rather than a cache. Durable user data goes in the vault, where it is
 * versioned, backed up, and readable without this plugin.
 *
 * See "Cache holds only derived data" in
 * docs/architecture/marvin-client-and-mcp.md. */
export interface IncrementalCacheState {
	version: 1;
	sourceKey: string;
	lastSeq: CouchSequence;
	categories: CachedMarvinContainer[];
	children: Record<string, CachedMarvinItem[]>;
	lastSuccessfulSyncAt: number;
	projectionPending: boolean;
}

/** Parses a raw persisted value into a validated IncrementalCacheState, or
 * undefined if it doesn't match the expected shape.
 *
 * Pass `expectedSourceKey` when the caller knows exactly which credentials
 * should have produced this file (the plugin, which owns those
 * credentials) — a mismatch means stale/foreign state and is rejected.
 * Omit it for a best-effort cross-process reader (e.g. the MCP server)
 * that has no independent way to know the source key and is only ever
 * reading an already-trusted file, never writing to it. */
export function parseIncrementalCacheState(
	value: unknown,
	expectedSourceKey?: string,
): IncrementalCacheState | undefined {
	if (
		typeof value !== "object"
		|| value === null
		|| (value as Partial<IncrementalCacheState>).version !== 1
		|| (
			expectedSourceKey !== undefined
			&& (value as Partial<IncrementalCacheState>).sourceKey !== expectedSourceKey
		)
		|| !Array.isArray((value as Partial<IncrementalCacheState>).categories)
		|| typeof (value as Partial<IncrementalCacheState>).children !== "object"
		|| (value as Partial<IncrementalCacheState>).children === null
		|| Array.isArray((value as Partial<IncrementalCacheState>).children)
		|| typeof (value as Partial<IncrementalCacheState>).lastSuccessfulSyncAt !== "number"
		|| !("lastSeq" in value)
		|| (value as Partial<IncrementalCacheState>).lastSeq === undefined
	) {
		return undefined;
	}
	const stored = value as IncrementalCacheState;
	if (
		!stored.categories.every(isCachedContainer)
		|| !Object.values(stored.children).every((items) => (
			Array.isArray(items) && items.every(isCachedItem)
		))
	) {
		return undefined;
	}
	return {
		...stored,
		projectionPending: stored.projectionPending !== false,
	};
}

export function isCachedContainer(value: unknown): value is CachedMarvinContainer {
	return (
		isCachedItem(value)
		&& (value.type === "category" || value.type === "project")
	);
}

export function isCachedItem(value: unknown): value is CachedMarvinItem {
	if (
		typeof value !== "object"
		|| value === null
		|| typeof (value as { _id?: unknown })._id !== "string"
		|| typeof (value as { title?: unknown }).title !== "string"
	) {
		return false;
	}
	const item = value as {
		type?: unknown;
		done?: unknown;
		parentId?: unknown;
	};
	if (
		item.type !== undefined
		&& item.type !== "task"
		&& item.type !== "category"
		&& item.type !== "project"
	) {
		return false;
	}
	if (item.parentId !== undefined && typeof item.parentId !== "string") {
		return false;
	}
	return (
		item.type === "category"
		|| item.type === "project"
		|| typeof item.done === "boolean"
	);
}

/** Categories/projects reachable from root through the cached tree. An item
 * whose parent chain is broken (missing parent, cycle) is excluded — it
 * cannot be rendered as a structural ancestor and must not be surfaced as
 * if it could. */
export function projectableCategories(
	categories: readonly CachedMarvinContainer[],
): CachedMarvinContainer[] {
	const byId = new Map(categories.map((item) => [item._id, item]));
	const projectable = new Set<string>();
	const rejected = new Set<string>();

	const reachesRoot = (item: CachedMarvinContainer): boolean => {
		const path: string[] = [];
		const visited = new Set<string>();
		let current: CachedMarvinContainer | undefined = item;
		while (current) {
			if (projectable.has(current._id)) {
				for (const id of path) {
					projectable.add(id);
				}
				return true;
			}
			if (rejected.has(current._id) || visited.has(current._id)) {
				for (const id of path) {
					rejected.add(id);
				}
				return false;
			}
			visited.add(current._id);
			path.push(current._id);
			if (!current.parentId || current.parentId === "root") {
				for (const id of path) {
					projectable.add(id);
				}
				return true;
			}
			current = byId.get(current.parentId);
			if (!current) {
				for (const id of path) {
					rejected.add(id);
				}
				return false;
			}
		}
		return false;
	};

	return categories.filter(reachesRoot);
}

/** Same filtering IncrementalMarvinCache.getCategories() applies — kept
 * here so a cross-process reader sees exactly the same projected view the
 * plugin itself would. */
export function categoriesFromState(
	state: IncrementalCacheState,
): CachedMarvinContainer[] {
	return projectableCategories(state.categories).map((item) => ({ ...item }));
}

/** Same filtering IncrementalMarvinCache.getChildren() applies. */
export function childrenFromState(
	state: IncrementalCacheState,
	parentId: string,
): CachedMarvinItem[] | undefined {
	const children = state.children[parentId];
	if (!children) {
		return undefined;
	}
	const projectableIds = new Set(
		projectableCategories(state.categories).map((item) => item._id),
	);
	return children
		.filter((item) => (
			item.type !== "category"
			&& item.type !== "project"
			|| projectableIds.has(item._id)
		))
		.map((item) => ({ ...item }));
}
