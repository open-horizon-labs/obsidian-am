import { describe, expect, it } from "vitest";

import {
	categoriesFromState,
	childrenFromState,
	parseIncrementalCacheState,
	type IncrementalCacheState,
} from "./incrementalCacheState";

function baseState(): IncrementalCacheState {
	return {
		version: 1,
		sourceKey: "source",
		lastSeq: { seq: 1 },
		categories: [
			{ _id: "work", title: "Work", type: "category", parentId: "root" },
			{ _id: "orphan", title: "Orphan", type: "category", parentId: "missing-parent" },
		],
		children: {
			work: [{ _id: "task", title: "Draft", type: "task", done: false, parentId: "work" }],
			orphan: [],
			unassigned: [],
		},
		lastSuccessfulSyncAt: 1_000,
		projectionPending: false,
	};
}

describe("parseIncrementalCacheState", () => {
	it("accepts a valid state when the source key matches", () => {
		const state = baseState();
		expect(parseIncrementalCacheState(state, "source")).toEqual(state);
	});

	it("rejects a mismatched source key when one is required", () => {
		expect(parseIncrementalCacheState(baseState(), "different-source")).toBeUndefined();
	});

	it("accepts any source key for a best-effort cross-process reader that omits one", () => {
		// packages/marvin-mcp reads this file without knowing the exact
		// credentials-derived key that produced it — it's a read-only
		// consumer of an already-trusted file, not the thing enforcing
		// that trust.
		expect(parseIncrementalCacheState(baseState())).toEqual(baseState());
	});

	it("rejects malformed shapes instead of returning partial data", () => {
		expect(parseIncrementalCacheState(null)).toBeUndefined();
		expect(parseIncrementalCacheState({ version: 2 })).toBeUndefined();
		expect(parseIncrementalCacheState({ ...baseState(), children: [] })).toBeUndefined();
		expect(parseIncrementalCacheState({
			...baseState(),
			categories: [{ _id: "bad", title: "Bad", type: "task" }], // task, not a container
		})).toBeUndefined();
	});

	it("defaults projectionPending to true when absent, false only when explicitly false", () => {
		const { projectionPending, ...withoutFlag } = baseState();
		expect(parseIncrementalCacheState(withoutFlag)?.projectionPending).toBe(true);
		expect(parseIncrementalCacheState({ ...baseState(), projectionPending: false })?.projectionPending).toBe(false);
	});
});

describe("categoriesFromState / childrenFromState", () => {
	it("excludes a category whose parent chain is broken", () => {
		const state = baseState();
		expect(categoriesFromState(state).map((c) => c._id)).toEqual(["work"]);
	});

	it("returns a category's children, filtered to projectable containers only", () => {
		const state = baseState();
		expect(childrenFromState(state, "work")?.map((c) => c._id)).toEqual(["task"]);
	});

	it("returns undefined for a parentId with no tracked children bucket at all", () => {
		expect(childrenFromState(baseState(), "never-hydrated")).toBeUndefined();
	});
});
