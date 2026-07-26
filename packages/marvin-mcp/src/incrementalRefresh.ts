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

/** Returns a function that requests one sync and waits for it, bounded. */
export function createCacheRefreshRequester(
	options: CacheRefreshRequesterOptions,
): () => Promise<void> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const pollIntervalMs = options.pollIntervalMs ?? 250;
	const sleep = options.sleep
		?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	return async () => {
		if (await requestsAreGoingUnanswered(options, timeoutMs)) {
			return;
		}

		const before = await lastSyncedAt(options);
		const now = options.now?.() ?? Date.now();
		try {
			await options.writeFile(
				options.syncRequestPath,
				JSON.stringify({ requestedAt: now }),
			);
		} catch {
			return; // Can't ask; caller falls back.
		}

		const deadline = now + timeoutMs;
		for (;;) {
			await sleep(pollIntervalMs);
			const after = await lastSyncedAt(options);
			// A cache that didn't exist before and does now also counts.
			if (after !== undefined && (before === undefined || after > before)) {
				return;
			}
			if ((options.now?.() ?? Date.now()) >= deadline) {
				return;
			}
		}
	};
}
