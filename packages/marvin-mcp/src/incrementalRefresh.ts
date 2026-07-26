import {
	parseIncrementalCacheState,
	parseIncrementalSyncRequest,
} from "@open-horizon/marvin-client";

// Asks the running Obsidian plugin to sync, then waits a bounded window for
// it to happen — by dropping a request file beside the cache file the MCP
// server already reads, and watching for the cache's own
// lastSuccessfulSyncAt to advance.
//
// A file rather than a socket, deliberately: the plugin keeps sole custody
// of the CouchDB credentials either way, but this adds no inbound network
// listener to the user's note-taking app and needs no shared secret between
// the two processes. The cost is the plugin polling for the request, which
// is one stat() per tick.
//
// Every failure mode ends the same way — return and let the caller fall
// back to whatever it already had (a fresh-enough cache, or REST). This
// never surfaces an error of its own: an agent asked for fresher data as a
// nicety, not as a precondition.

/** What a requested refresh actually did, so a caller can tell a
 * newly-synchronized cache hit from a silent timeout that fell back. */
export type CacheRefreshOutcome = "synced" | "timed_out" | "skipped";

export interface CacheRefreshResult {
	requested: true;
	outcome: CacheRefreshOutcome;
	waitedMs: number;
	/** Present on `skipped` to say why nothing was attempted. */
	reason?: string;
}

export interface CacheRefreshRequesterOptions {
	cachePath: string;
	syncRequestPath: string;
	readFile: (path: string) => Promise<string>;
	writeFile: (path: string, data: string) => Promise<void>;
	now?: () => number;
	/** How long to wait for the plugin to sync before giving up. */
	timeoutMs?: number;
	/** How often to re-read the cache while waiting. */
	pollIntervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

async function lastSyncedAt(
	options: CacheRefreshRequesterOptions,
): Promise<number | undefined> {
	try {
		const state = parseIncrementalCacheState(
			JSON.parse(await options.readFile(options.cachePath)) as unknown,
		);
		return state?.lastSuccessfulSyncAt;
	} catch {
		return undefined;
	}
}

/** True when a request file is already sitting there unconsumed, which means
 * nothing is picking requests up — Obsidian closed, the plugin disabled, or
 * incremental sync switched off. Waiting the full timeout on every call in
 * that state would make every refresh-requesting tool call slow, so detect
 * it and skip the wait. Self-correcting: the moment the plugin runs again it
 * clears the file, and the next call waits normally. */
async function requestsAreGoingUnanswered(
	options: CacheRefreshRequesterOptions,
	staleAfterMs: number,
): Promise<boolean> {
	let raw: string;
	try {
		raw = await options.readFile(options.syncRequestPath);
	} catch {
		return false; // No pending request: nothing to conclude.
	}
	let pending: unknown;
	try {
		pending = JSON.parse(raw);
	} catch {
		return true; // Unparseable and never cleaned up.
	}
	const request = parseIncrementalSyncRequest(pending);
	if (!request) {
		return true;
	}
	const now = options.now?.() ?? Date.now();
	return now - request.requestedAt > staleAfterMs;
}

/** Returns a function that requests one sync and waits for it, bounded,
 * reporting what happened. */
export function createCacheRefreshRequester(
	options: CacheRefreshRequesterOptions,
): () => Promise<CacheRefreshResult> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const pollIntervalMs = options.pollIntervalMs ?? 250;
	const sleep = options.sleep
		?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	return async (): Promise<CacheRefreshResult> => {
		const startedAt = options.now?.() ?? Date.now();
		const waited = () => (options.now?.() ?? Date.now()) - startedAt;

		if (await requestsAreGoingUnanswered(options, timeoutMs)) {
			return {
				requested: true,
				outcome: "skipped",
				waitedMs: waited(),
				reason: "an earlier request is still unclaimed, so nothing is listening",
			};
		}

		const before = await lastSyncedAt(options);
		try {
			await options.writeFile(
				options.syncRequestPath,
				JSON.stringify({ requestedAt: startedAt }),
			);
		} catch (error) {
			return {
				requested: true,
				outcome: "skipped",
				waitedMs: waited(),
				reason: `could not write the sync request: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		const deadline = startedAt + timeoutMs;
		for (;;) {
			await sleep(pollIntervalMs);
			const after = await lastSyncedAt(options);
			// A cache that didn't exist before and does now also counts.
			if (after !== undefined && (before === undefined || after > before)) {
				return { requested: true, outcome: "synced", waitedMs: waited() };
			}
			if ((options.now?.() ?? Date.now()) >= deadline) {
				return { requested: true, outcome: "timed_out", waitedMs: waited() };
			}
		}
	};
}
