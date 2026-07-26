import { describe, expect, it, vi } from "vitest";

import { createCacheRefreshRequester } from "./incrementalRefresh.js";

const CACHE = "/fake/marvin-incremental-cache-v1.json";
const REQUEST = "/fake/marvin-sync-request.json";

function cacheJson(lastSuccessfulSyncAt: number) {
	return JSON.stringify({
		version: 1,
		sourceKey: "irrelevant",
		lastSeq: "1",
		categories: [],
		children: {},
		lastSuccessfulSyncAt,
		projectionPending: false,
	});
}

/** A fake filesystem whose cache file can be advanced mid-wait, standing in
 * for the plugin picking up the request and syncing. */
function fakeFs(initial: Record<string, string> = {}) {
	const files = new Map(Object.entries(initial));
	return {
		files,
		readFile: async (p: string) => {
			const v = files.get(p);
			if (v === undefined) {
				throw new Error(`ENOENT: ${p}`);
			}
			return v;
		},
		writeFile: async (p: string, data: string) => {
			files.set(p, data);
		},
	};
}

describe("createCacheRefreshRequester", () => {
	it("writes a request and returns once the cache's sync timestamp advances", async () => {
		const fs = fakeFs({ [CACHE]: cacheJson(1_000) });
		let clock = 5_000;
		let polls = 0;

		const request = createCacheRefreshRequester({
			cachePath: CACHE,
			syncRequestPath: REQUEST,
			readFile: fs.readFile,
			writeFile: fs.writeFile,
			now: () => clock,
			timeoutMs: 5_000,
			pollIntervalMs: 100,
			sleep: async () => {
				clock += 100;
				polls += 1;
				// Simulate the plugin servicing the request on the 2nd poll.
				if (polls === 2) {
					fs.files.set(CACHE, cacheJson(9_999));
					fs.files.delete(REQUEST);
				}
			},
		});

		const result = await request();

		expect(polls).toBe(2);
		expect(JSON.parse(fs.files.get(CACHE)!).lastSuccessfulSyncAt).toBe(9_999);
		expect(result).toMatchObject({ requested: true, outcome: "synced" });
		expect(result.waitedMs).toBeGreaterThan(0);
	});

	it("gives up at the timeout when nothing services the request", async () => {
		const fs = fakeFs({ [CACHE]: cacheJson(1_000) });
		let clock = 5_000;
		let polls = 0;

		const request = createCacheRefreshRequester({
			cachePath: CACHE,
			syncRequestPath: REQUEST,
			readFile: fs.readFile,
			writeFile: fs.writeFile,
			now: () => clock,
			timeoutMs: 500,
			pollIntervalMs: 100,
			sleep: async () => {
				clock += 100;
				polls += 1;
				if (polls > 50) {
					throw new Error("did not respect the timeout");
				}
			},
		});

		const result = await request();

		// Bounded: ~5 polls at 100ms inside a 500ms budget, not an open loop.
		expect(polls).toBeLessThanOrEqual(6);
		expect(result).toMatchObject({ requested: true, outcome: "timed_out" });
	});

	it("returns immediately when a previous request was never picked up", async () => {
		// Obsidian closed or the plugin disabled: a stale request file is
		// still sitting there. Waiting the full timeout on every call in that
		// state would make every refresh-requesting read slow.
		const fs = fakeFs({
			[CACHE]: cacheJson(1_000),
			[REQUEST]: JSON.stringify({ requestedAt: 0 }),
		});
		const sleep = vi.fn(async () => {});

		const request = createCacheRefreshRequester({
			cachePath: CACHE,
			syncRequestPath: REQUEST,
			readFile: fs.readFile,
			writeFile: fs.writeFile,
			now: () => 999_999,
			timeoutMs: 5_000,
			sleep,
		});

		const result = await request();

		expect(sleep).not.toHaveBeenCalled();
		expect(result).toMatchObject({ requested: true, outcome: "skipped" });
		expect(result.reason).toContain("nothing is listening");
	});

	it("still waits when a pending request is recent enough to be in flight", async () => {
		// A concurrent call just asked; that's not evidence of a dead plugin.
		const fs = fakeFs({
			[CACHE]: cacheJson(1_000),
			[REQUEST]: JSON.stringify({ requestedAt: 4_900 }),
		});
		let clock = 5_000;
		const sleep = vi.fn(async () => {
			clock += 100;
			fs.files.set(CACHE, cacheJson(7_777));
		});

		const request = createCacheRefreshRequester({
			cachePath: CACHE,
			syncRequestPath: REQUEST,
			readFile: fs.readFile,
			writeFile: fs.writeFile,
			now: () => clock,
			timeoutMs: 5_000,
			pollIntervalMs: 100,
			sleep,
		});

		await request();

		expect(sleep).toHaveBeenCalled();
	});

	it("treats a cache that appears mid-wait as a successful refresh", async () => {
		const fs = fakeFs({}); // no cache file at all yet
		let clock = 5_000;

		const request = createCacheRefreshRequester({
			cachePath: CACHE,
			syncRequestPath: REQUEST,
			readFile: fs.readFile,
			writeFile: fs.writeFile,
			now: () => clock,
			timeoutMs: 5_000,
			pollIntervalMs: 100,
			sleep: async () => {
				clock += 100;
				fs.files.set(CACHE, cacheJson(6_000));
			},
		});

		const result = await request();

		expect(fs.files.has(CACHE)).toBe(true);
		expect(result).toMatchObject({ requested: true, outcome: "synced" });
	});

	it("never throws when the request file can't be written", async () => {
		const request = createCacheRefreshRequester({
			cachePath: CACHE,
			syncRequestPath: REQUEST,
			readFile: async () => { throw new Error("ENOENT"); },
			writeFile: async () => { throw new Error("EACCES"); },
			now: () => 1_000,
			sleep: async () => {},
		});

		// A refresh is a nicety, not a precondition — the caller falls back,
		// and is told why rather than left guessing.
		const result = await request();
		expect(result).toMatchObject({ requested: true, outcome: "skipped" });
		expect(result.reason).toContain("EACCES");
	});
});
