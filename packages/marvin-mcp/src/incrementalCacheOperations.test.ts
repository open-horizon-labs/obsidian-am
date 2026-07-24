import { describe, expect, it, vi } from "vitest";
import type { MarvinReadResult, TaskOrProject } from "@open-horizon/marvin-client";

import { createCachePreferringOperations } from "./incrementalCacheOperations.js";
import type { MarvinOperations } from "./tools.js";

const restResult: MarvinReadResult<TaskOrProject[]> = {
	data: [{ _id: "rest-item", title: "From REST", done: false }],
	freshness: "fresh",
	origin: "public",
	fetchedAt: 1_000,
	ageMs: 0,
	warnings: [],
};

function fallbackOperations(overrides: Partial<MarvinOperations> = {}): MarvinOperations {
	return {
		getTodayItems: async () => restResult,
		getDueItems: async () => restResult,
		getCategories: vi.fn(async () => ({ ...restResult, data: [] })),
		getChildren: vi.fn(async () => restResult),
		getLabels: async () => ({ ...restResult, data: [] }),
		addTask: async () => { throw new Error("not used in these tests"); },
		markDone: async () => { throw new Error("not used in these tests"); },
		...overrides,
	};
}

function cacheFile(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		version: 1,
		sourceKey: "irrelevant-to-a-cross-process-reader",
		lastSeq: "42",
		categories: [
			{ _id: "work", title: "Work", type: "category", parentId: "root" },
		],
		children: {
			work: [
				{ _id: "task-1", title: "From cache", type: "task", done: false, parentId: "work" },
				{ _id: "sub-cat", title: "Sub category", type: "category", parentId: "work" },
			],
		},
		lastSuccessfulSyncAt: 1_000,
		projectionPending: false,
		...overrides,
	});
}

describe("createCachePreferringOperations", () => {
	it("serves getCategories from the cache file when it's fresh", async () => {
		const fallback = fallbackOperations();
		const operations = createCachePreferringOperations(fallback, {
			cachePath: "/fake/path.json",
			readFile: async () => cacheFile(),
			now: () => 1_500,
		});

		const result = await operations.getCategories();

		expect(result.data).toEqual([expect.objectContaining({ _id: "work" })]);
		expect(result.freshness).toBe("cached");
		expect(result.origin).toBe("local");
		expect(fallback.getCategories).not.toHaveBeenCalled();
	});

	it("falls back to REST when the cache file doesn't exist", async () => {
		const fallback = fallbackOperations();
		const operations = createCachePreferringOperations(fallback, {
			cachePath: "/fake/path.json",
			readFile: async () => { throw new Error("ENOENT"); },
		});

		const result = await operations.getCategories();

		expect(result.origin).toBe("public");
		expect(result.data).toEqual([]);
		expect(fallback.getCategories).toHaveBeenCalledTimes(1);
	});

	it("falls back to REST when the cache file is unparseable", async () => {
		const fallback = fallbackOperations();
		const operations = createCachePreferringOperations(fallback, {
			cachePath: "/fake/path.json",
			readFile: async () => "{ not valid json",
		});

		await operations.getCategories();
		expect(fallback.getCategories).toHaveBeenCalledTimes(1);
	});

	it("falls back to REST when the cache is older than maxAgeMs", async () => {
		const fallback = fallbackOperations();
		const operations = createCachePreferringOperations(fallback, {
			cachePath: "/fake/path.json",
			readFile: async () => cacheFile({ lastSuccessfulSyncAt: 1_000 }),
			now: () => 1_000 + 11 * 60_000, // 11 minutes later, default threshold is 10
		});

		await operations.getCategories();
		expect(fallback.getCategories).toHaveBeenCalledTimes(1);
	});

	it("respects a configured maxAgeMs instead of the default", async () => {
		const fallback = fallbackOperations();
		const operations = createCachePreferringOperations(fallback, {
			cachePath: "/fake/path.json",
			readFile: async () => cacheFile({ lastSuccessfulSyncAt: 1_000 }),
			now: () => 1_000 + 30_000,
			maxAgeMs: 20_000,
		});

		await operations.getCategories();
		expect(fallback.getCategories).toHaveBeenCalledTimes(1);
	});

	it("strips plain sub-categories from getChildren to match REST's contract exactly", async () => {
		const fallback = fallbackOperations();
		const operations = createCachePreferringOperations(fallback, {
			cachePath: "/fake/path.json",
			readFile: async () => cacheFile(),
			now: () => 1_500,
		});

		const result = await operations.getChildren("work");

		expect(result.data.map((item) => item._id)).toEqual(["task-1"]);
		expect(fallback.getChildren).not.toHaveBeenCalled();
	});

	it("falls back to REST for a parentId the cache never tracked", async () => {
		const fallback = fallbackOperations();
		const operations = createCachePreferringOperations(fallback, {
			cachePath: "/fake/path.json",
			readFile: async () => cacheFile(),
			now: () => 1_500,
		});

		const result = await operations.getChildren("never-hydrated");

		expect(result).toBe(restResult);
		expect(fallback.getChildren).toHaveBeenCalledWith("never-hydrated");
	});

	it("leaves every other operation delegated to the fallback untouched", async () => {
		const fallback = fallbackOperations();
		const operations = createCachePreferringOperations(fallback, {
			cachePath: "/fake/path.json",
			readFile: async () => cacheFile(),
		});

		expect(await operations.getTodayItems()).toBe(restResult);
		expect(await operations.getLabels()).not.toBe(undefined);
	});
});
