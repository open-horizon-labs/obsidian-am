import {
	categoriesFromState,
	childrenFromState,
	parseIncrementalCacheState,
	type IncrementalCacheState,
	type MarvinReadResult,
	type Project,
	type Task,
} from "@open-horizon/marvin-client";
import type { MarvinOperations } from "./tools.js";

// The Obsidian plugin and this MCP server are separate processes — there is
// no in-memory cache to share. This reads the SAME persisted JSON file the
// plugin's IncrementalMarvinCache already maintains, purely as a read-only,
// best-effort consumer: no CouchDB credentials, no write access, no
// awareness of the exact source key that produced the file (that's the
// plugin's job to enforce on its own writes, not this reader's).
//
// REST remains the fallback on any failure: file missing, unparseable,
// stale beyond maxAgeMs, or the requested parentId simply isn't tracked in
// the cache. This never removes the REST path's role as the source of
// truth default — it only skips a redundant network round trip when a
// fresher-than-threshold answer is already sitting on disk.

export interface IncrementalCacheReaderOptions {
	cachePath: string;
	readFile: (path: string) => Promise<string>;
	now?: () => number;
	/** How old the cache's last successful sync may be before it's treated
	 * as too stale to trust over a live REST read. Default 10 minutes. */
	maxAgeMs?: number;
}

async function loadFreshState(
	options: IncrementalCacheReaderOptions,
): Promise<IncrementalCacheState | undefined> {
	let raw: string;
	try {
		raw = await options.readFile(options.cachePath);
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const state = parseIncrementalCacheState(parsed);
	if (!state) {
		return undefined;
	}
	const now = options.now?.() ?? Date.now();
	const maxAgeMs = options.maxAgeMs ?? 10 * 60_000;
	if (now - state.lastSuccessfulSyncAt > maxAgeMs) {
		return undefined;
	}
	return state;
}

function cacheResult<T>(
	data: T,
	state: IncrementalCacheState,
	now: number,
): MarvinReadResult<T> {
	return {
		data,
		freshness: "cached",
		origin: "local",
		fetchedAt: now,
		ageMs: Math.max(0, now - state.lastSuccessfulSyncAt),
		warnings: [],
	};
}

/** Wraps an existing MarvinOperations so getCategories/getChildren prefer a
 * fresh-enough incremental cache file over a REST round trip, falling back
 * to the wrapped operations for everything else (including when the cache
 * is missing, invalid, stale, or simply doesn't track the requested id). */
export function createCachePreferringOperations(
	fallback: MarvinOperations,
	options: IncrementalCacheReaderOptions,
): MarvinOperations {
	return {
		// Explicit delegation, not a `...fallback` spread: fallback is
		// typically a MarvinRouter class instance, whose methods live on
		// the prototype. Object spread only copies own enumerable
		// properties, so `{...fallback}` silently drops every method
		// (getTodayItems, getDueItems, getLabels, addTask, markDone) —
		// confirmed as a real regression (issue #81): every MCP tool
		// except marvin_categories/marvin_children broke the moment a
		// cache path was configured, not just an edge case.
		getTodayItems: (date) => fallback.getTodayItems(date),
		getDueItems: (by) => fallback.getDueItems(by),
		getLabels: () => fallback.getLabels(),
		addTask: (task) => fallback.addTask(task),
		addProject: (project) => fallback.addProject(project),
		markDone: (itemId, timeZoneOffset) => fallback.markDone(itemId, timeZoneOffset),
		async getCategories() {
			const state = await loadFreshState(options);
			if (state) {
				return cacheResult(categoriesFromState(state), state, options.now?.() ?? Date.now());
			}
			return fallback.getCategories();
		},
		async getChildren(parentId) {
			const state = await loadFreshState(options);
			if (state) {
				const children = childrenFromState(state, parentId);
				if (children) {
					// Real Marvin's REST /children endpoint never returns a
					// plain sub-category (only tasks/projects — categories
					// nested under a category are discovered separately, by
					// filtering the full category list). The plugin's
					// cache tracks sub-categories in the same bucket for its
					// own note-projection purposes; strip them here so this
					// tool's contract matches REST exactly regardless of
					// which source answered it.
					const withoutPlainCategories = children.filter(
						(item): item is Task | Project => item.type !== "category",
					);
					return cacheResult(withoutPlainCategories, state, options.now?.() ?? Date.now());
				}
			}
			return fallback.getChildren(parentId);
		},
	};
}
