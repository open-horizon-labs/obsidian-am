import { describe, expect, it, vi } from "vitest";
import type { AddProjectResult, MarkDoneResult, MarvinReadResult, Task, TaskOrProject } from "@open-horizon/marvin-client";

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

// A real class, not an object literal: MarvinRouter (the real fallback
// passed in production) defines its methods on the prototype, not as own
// properties. A fixture built from an object literal can't catch a
// `{...fallback}` bug — spreading an object literal copies its methods
// fine, since object-literal methods ARE own properties. This is exactly
// why that regression (issue #81) shipped untested: getCategories/
// getChildren were the only methods asserted directly; the rest were
// "spread through" a fixture shape that could never expose the bug.
class FakeMarvinRouter implements MarvinOperations {
	getCategoriesMock = vi.fn(async () => ({ ...restResult, data: [] }));
	getChildrenMock = vi.fn(async (_parentId: string) => restResult);

	async getTodayItems() { return restResult; }
	async getDueItems() { return restResult; }
	async getCategories() { return this.getCategoriesMock(); }
	async getChildren(parentId: string) { return this.getChildrenMock(parentId); }
	async getLabels() { return { ...restResult, data: [] }; }
	async addTask(): Promise<Task> { throw new Error("not used in these tests"); }
	async addProject(): Promise<AddProjectResult> { throw new Error("not used in these tests"); }
	async markDone(): Promise<MarkDoneResult> { throw new Error("not used in these tests"); }
}

function fallbackOperations(): FakeMarvinRouter {
	return new FakeMarvinRouter();
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
		expect(fallback.getCategoriesMock).not.toHaveBeenCalled();
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
		expect(fallback.getCategoriesMock).toHaveBeenCalledTimes(1);
	});

	it("falls back to REST when the cache file is unparseable", async () => {
		const fallback = fallbackOperations();
		const operations = createCachePreferringOperations(fallback, {
			cachePath: "/fake/path.json",
			readFile: async () => "{ not valid json",
		});

		await operations.getCategories();
		expect(fallback.getCategoriesMock).toHaveBeenCalledTimes(1);
	});

	it("falls back to REST when the cache is older than maxAgeMs", async () => {
		const fallback = fallbackOperations();
		const operations = createCachePreferringOperations(fallback, {
			cachePath: "/fake/path.json",
			readFile: async () => cacheFile({ lastSuccessfulSyncAt: 1_000 }),
			now: () => 1_000 + 11 * 60_000, // 11 minutes later, default threshold is 10
		});

		await operations.getCategories();
		expect(fallback.getCategoriesMock).toHaveBeenCalledTimes(1);
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
		expect(fallback.getCategoriesMock).toHaveBeenCalledTimes(1);
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
		expect(fallback.getChildrenMock).not.toHaveBeenCalled();
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
		expect(fallback.getChildrenMock).toHaveBeenCalledWith("never-hydrated");
	});

	it("preserves EVERY operation, including prototype methods a spread would drop", async () => {
		// Regression guard for issue #81: a `{...fallback}` spread silently
		// dropped every prototype method, so with a cache path configured,
		// marvin_today / marvin_due / marvin_labels / marvin_create_task /
		// marvin_mark_done all failed with "... is not a function" while
		// only categories/children worked.
		const fallback = fallbackOperations();
		const operations = createCachePreferringOperations(fallback, {
			cachePath: "/fake/path.json",
			readFile: async () => cacheFile(),
		});

		const required: Array<keyof MarvinOperations> = [
			"getTodayItems",
			"getDueItems",
			"getCategories",
			"getChildren",
			"getLabels",
			"addTask",
			"markDone",
		];
		for (const method of required) {
			expect(typeof operations[method], `${method} must be callable`).toBe("function");
		}
	});

	it("actually routes the non-cached reads through to the fallback", async () => {
		const fallback = fallbackOperations();
		const operations = createCachePreferringOperations(fallback, {
			cachePath: "/fake/path.json",
			readFile: async () => cacheFile(),
			now: () => 1_500,
		});

		// A valid, fresh cache is present — these must still hit REST,
		// because only categories/children are ever served from cache.
		expect(await operations.getTodayItems()).toBe(restResult);
		expect(await operations.getDueItems()).toBe(restResult);
		expect((await operations.getLabels()).data).toEqual([]);
	});
});
