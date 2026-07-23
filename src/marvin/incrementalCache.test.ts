import { describe, expect, it, vi } from "vitest";

import type {
	CouchChangesPage,
	CouchSequence,
} from "./couchChanges";
import {
	IncrementalMarvinCache,
	IncrementalRetryBackoff,
	applyCouchChanges,
	type IncrementalCacheState,
	type IncrementalCacheStore,
} from "./incrementalCache";

class MemoryStore implements IncrementalCacheStore {
	value: unknown;
	readonly saves: IncrementalCacheState[] = [];

	async load(): Promise<unknown> {
		return this.value;
	}

	async save(state: IncrementalCacheState): Promise<void> {
		this.value = structuredClone(state);
		this.saves.push(structuredClone(state));
	}

	async clear(): Promise<void> {
		this.value = undefined;
	}
}

class QueuedChanges {
	readonly since: CouchSequence[] = [];

	constructor(private readonly pages: CouchChangesPage[]) {}

	async changes(options: { since: CouchSequence | "now" }) {
		this.since.push(options.since);
		const page = this.pages.shift();
		if (!page) {
			throw new Error("No changes page queued");
		}
		return page;
	}
}

function state(): IncrementalCacheState {
	return {
		version: 1,
		sourceKey: "source",
		lastSeq: { seq: 1 },
		categories: [
			{ _id: "work", title: "Work", type: "category", parentId: "root" },
			{ _id: "project", title: "Project", type: "project", parentId: "work" },
			{ _id: "child", title: "Child", type: "project", parentId: "project" },
		],
		children: {
			work: [{ _id: "project", title: "Project", type: "project", parentId: "work" }],
			project: [
				{ _id: "child", title: "Child", type: "project", parentId: "project" },
				{ _id: "task", title: "Draft", type: "task", done: false, parentId: "project" },
			],
			child: [],
			unassigned: [],
		},
		lastSuccessfulSyncAt: 1_000,
		projectionPending: false,
	};
}

describe("incremental Marvin cache", () => {
	it("checkpoints before REST hydration and catches up without a gap", async () => {
		const store = new MemoryStore();
		const changes = new QueuedChanges([
			{ results: [], lastSeq: { seq: 10 }, pending: 0 },
			{
				results: [{
					id: "task-new",
					seq: { seq: 11 },
					doc: {
						_id: "task-new",
						db: "Tasks",
						title: "Arrived during hydration",
						parentId: "project",
						done: false,
					},
				}],
				lastSeq: { seq: 11 },
				pending: 0,
			},
		]);
		const snapshot = {
			getCategories: vi.fn(async () => state().categories),
			getChildren: vi.fn(async (parentId: string) => (
				state().children[parentId] ?? []
			)),
		};
		const cache = new IncrementalMarvinCache({
			sourceKey: "source",
			changes,
			snapshot,
			store,
			now: () => 2_000,
		});

		const update = await cache.sync();

		expect(changes.since).toEqual(["now", { seq: 10 }]);
		expect(update).toMatchObject({
			fullRefresh: true,
			changed: true,
			affectedContainerIds: ["project"],
		});
		expect(cache.getChildren("project")?.map((item) => item._id)).toContain(
			"task-new",
		);
		expect(store.saves.at(-1)?.lastSeq).toEqual({ seq: 11 });
		expect(store.saves.at(-1)?.projectionPending).toBe(true);
		await cache.acknowledgeProjection();
		expect(store.saves.at(-1)?.projectionPending).toBe(false);
	});

	it("resumes an opaque checkpoint, coalesces concurrent polls, and persists it", async () => {
		const store = new MemoryStore();
		store.value = state();
		let release: ((page: CouchChangesPage) => void) | undefined;
		const changes = {
			changes: vi.fn(() => new Promise<CouchChangesPage>((resolve) => {
				release = resolve;
			})),
		};
		const cache = new IncrementalMarvinCache({
			sourceKey: "source",
			changes,
			snapshot: {
				getCategories: async () => [],
				getChildren: async () => [],
			},
			store,
			now: () => 2_000,
		});

		const first = cache.sync("longpoll");
		const second = cache.sync("longpoll");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		release?.({ results: [], lastSeq: { seq: 2 }, pending: 0 });

		expect(await first).toEqual(await second);
		expect(changes.changes).toHaveBeenCalledTimes(1);
		expect(changes.changes).toHaveBeenCalledWith(expect.objectContaining({
			since: { seq: 1 },
			feed: "longpoll",
		}));
		expect(store.saves.at(-1)?.lastSeq).toEqual({ seq: 2 });
	});

	it("waits for an active poll before clearing persistent state", async () => {
		const store = new MemoryStore();
		store.value = state();
		let release: ((page: CouchChangesPage) => void) | undefined;
		const cache = new IncrementalMarvinCache({
			sourceKey: "source",
			changes: {
				changes: () => new Promise<CouchChangesPage>((resolve) => {
					release = resolve;
				}),
			},
			snapshot: {
				getCategories: async () => [],
				getChildren: async () => [],
			},
			store,
		});

		const sync = cache.sync("longpoll");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		const clearing = cache.clear();
		await expect(cache.sync()).rejects.toThrow("being reset");
		expect(store.value).toBeDefined();
		release?.({ results: [], lastSeq: 2, pending: 0 });
		await sync;
		await clearing;

		expect(store.value).toBeUndefined();
		expect(cache.getCategories()).toBeUndefined();
	});

	it("replays a pending projection after restart even with no new changes", async () => {
		const store = new MemoryStore();
		store.value = { ...state(), projectionPending: true };
		const changes = new QueuedChanges([
			{ results: [], lastSeq: { seq: 2 }, pending: 0 },
		]);
		const cache = new IncrementalMarvinCache({
			sourceKey: "source",
			changes,
			snapshot: {
				getCategories: async () => [],
				getChildren: async () => [],
			},
			store,
		});

		await expect(cache.sync()).resolves.toMatchObject({
			fullRefresh: true,
			changed: false,
		});
	});

	it("rehydrates instead of trusting malformed persisted items", async () => {
		const store = new MemoryStore();
		store.value = {
			...state(),
			categories: [{ _id: "broken", title: 42, type: "category" }],
		};
		const changes = new QueuedChanges([
			{ results: [], lastSeq: 10, pending: 0 },
			{ results: [], lastSeq: 10, pending: 0 },
		]);
		const snapshot = {
			getCategories: vi.fn(async () => state().categories),
			getChildren: vi.fn(async (parentId: string) => (
				state().children[parentId] ?? []
			)),
		};
		const cache = new IncrementalMarvinCache({
			sourceKey: "source",
			changes,
			snapshot,
			store,
		});

		await expect(cache.sync()).resolves.toMatchObject({
			fullRefresh: true,
		});
		expect(changes.since).toEqual(["now", 10]);
		expect(snapshot.getCategories).toHaveBeenCalledOnce();
	});

	it("restarts checkpoint-first hydration after a recoverable snapshot failure", async () => {
		const store = new MemoryStore();
		const events: string[] = [];
		const pages: CouchChangesPage[] = [
			{ results: [], lastSeq: 10, pending: 0 },
			{ results: [], lastSeq: 20, pending: 0 },
			{ results: [], lastSeq: 20, pending: 0 },
		];
		const changes = {
			async changes(options: { since: CouchSequence | "now" }) {
				events.push(`changes:${JSON.stringify(options.since)}`);
				return pages.shift()!;
			},
		};
		let snapshotAttempts = 0;
		const cache = new IncrementalMarvinCache({
			sourceKey: "source",
			changes,
			snapshot: {
				async getCategories() {
					events.push("snapshot:categories");
					return [];
				},
				async getChildren(parentId) {
					events.push(`snapshot:children:${parentId}`);
					snapshotAttempts += 1;
					if (snapshotAttempts === 1) {
						throw new Error("offline");
					}
					return [];
				},
			},
			store,
		});

		await expect(cache.sync()).rejects.toThrow("offline");
		await expect(cache.sync()).resolves.toMatchObject({
			fullRefresh: true,
		});
		expect(events).toEqual([
			'changes:"now"',
			"snapshot:categories",
			"snapshot:children:unassigned",
			'changes:"now"',
			"snapshot:categories",
			"snapshot:children:unassigned",
			"changes:20",
		]);
	});

	it("applies replayed task moves/completion idempotently and targets parents", () => {
		const cacheState = state();
		const moved = {
			id: "task",
			seq: 2,
			doc: {
				_id: "task",
				_rev: "2-moved",
				db: "Tasks",
				title: "Draft",
				parentId: "unassigned",
				done: false,
			},
		};

		const first = applyCouchChanges(cacheState, [moved]);
		const replay = applyCouchChanges(cacheState, [moved]);

		expect(first.affectedContainerIds).toEqual(new Set(["project"]));
		expect(first.inboxChanged).toBe(true);
		expect(cacheState.children.project).toHaveLength(1);
		expect(cacheState.children.unassigned.map((item) => item._id)).toEqual([
			"task",
		]);
		expect(replay.changed).toBe(false);
		expect(replay.inboxChanged).toBe(false);
		expect(cacheState.children.unassigned).toHaveLength(1);

		applyCouchChanges(cacheState, [{
			...moved,
			seq: 3,
			doc: { ...moved.doc, _rev: "3-done", done: true },
		}]);
		expect(cacheState.children.unassigned).toEqual([]);
	});

	it("targets descendants and old/new parents after a category move", () => {
		const cacheState = state();
		const update = applyCouchChanges(cacheState, [{
			id: "project",
			seq: 2,
			doc: {
				_id: "project",
				db: "Categories",
				type: "project",
				title: "Renamed",
				parentId: "other",
				done: false,
			},
		}]);

		expect(update.affectedContainerIds).toEqual(new Set([
			"work",
			"other",
			"project",
			"child",
		]));
		expect(cacheState.categories.find(
			(item) => item._id === "project",
		)).toMatchObject({ title: "Renamed", parentId: "other" });
	});

	it("repairs inconsistent category copies even when one already has the revision", () => {
		const cacheState = state();
		cacheState.children.work[0] = {
			...cacheState.children.work[0]!,
			_rev: "2-current",
			title: "Current",
		};
		cacheState.categories[1] = {
			...cacheState.categories[1]!,
			_rev: "1-stale",
			title: "Stale",
		};

		const update = applyCouchChanges(cacheState, [{
			id: "project",
			seq: 2,
			doc: {
				_id: "project",
				_rev: "2-current",
				db: "Categories",
				type: "project",
				title: "Current",
				parentId: "work",
				done: false,
			},
		}]);

		expect(update.changed).toBe(true);
		expect(cacheState.categories[1]).toMatchObject({
			_rev: "2-current",
			title: "Current",
		});
		expect(cacheState.children.work[0]).toMatchObject({
			_rev: "2-current",
			title: "Current",
		});
	});

	it("retains completed projects for hierarchy but removes their open-child link", () => {
		const cacheState = state();
		applyCouchChanges(cacheState, [{
			id: "project",
			seq: 2,
			doc: {
				_id: "project",
				_rev: "2-done",
				db: "Categories",
				type: "project",
				title: "Project",
				parentId: "work",
				done: true,
			},
		}]);

		expect(cacheState.categories.map((item) => item._id)).toContain("project");
		expect(cacheState.children.work).toEqual([]);
	});

	it("removes deleted cache items but leaves their note disposition to the projection", () => {
		const cacheState = state();
		const update = applyCouchChanges(cacheState, [{
			id: "task",
			seq: 2,
			deleted: true,
		}]);

		expect(cacheState.children.project.map((item) => item._id)).not.toContain(
			"task",
		);
		expect(update.affectedContainerIds).toEqual(new Set(["project"]));
	});

	it("hides orphaned descendants after container deletion and restores them safely", async () => {
		const store = new MemoryStore();
		const cacheState = state();
		applyCouchChanges(cacheState, [{
			id: "project",
			seq: 2,
			deleted: true,
		}]);
		store.value = cacheState;
		const changes = new QueuedChanges([
			{ results: [], lastSeq: 2, pending: 0 },
			{
				results: [{
					id: "project",
					seq: 3,
					doc: {
						_id: "project",
						_rev: "3-restored",
						db: "Categories",
						type: "project",
						title: "Project",
						parentId: "work",
						done: false,
					},
				}],
				lastSeq: 3,
				pending: 0,
			},
		]);
		const cache = new IncrementalMarvinCache({
			sourceKey: "source",
			changes,
			snapshot: {
				getCategories: async () => [],
				getChildren: async () => [],
			},
			store,
		});

		await cache.sync();
		expect(cache.getCategories()?.map((item) => item._id)).toEqual(["work"]);
		await cache.sync();
		expect(new Set(cache.getCategories()?.map((item) => item._id))).toEqual(new Set([
			"work",
			"project",
			"child",
		]));
	});

	it("backs off without retry amplification and resets after recovery", () => {
		let now = 1_000;
		const backoff = new IncrementalRetryBackoff(() => now, 5_000, 20_000);

		expect(backoff.recordFailure()).toBe(5_000);
		expect(backoff.canRun()).toBe(false);
		now += 5_000;
		expect(backoff.canRun()).toBe(true);
		expect(backoff.recordFailure()).toBe(10_000);
		now += 10_000;
		backoff.recordSuccess();
		expect(backoff.canRun()).toBe(true);
		expect(backoff.recordFailure()).toBe(5_000);
	});

	it("rejects malformed relevant documents before changing cache state", () => {
		const cacheState = state();
		const before = structuredClone(cacheState);

		expect(() => applyCouchChanges(cacheState, [{
			id: "task",
			seq: 2,
			doc: {
				_id: "different",
				db: "Tasks",
				title: "Bad",
				parentId: "project",
			},
		}])).toThrow("contained document");
		expect(cacheState).toEqual(before);
	});
});
