import type {
	Category,
	Project,
	Task,
} from "@open-horizon/marvin-client";

import type {
	CouchChange,
	CouchChangesPage,
	CouchSequence,
	MarvinDatabaseDocument,
} from "./couchChanges";

export type CachedMarvinItem = Category | Project | Task;
export type CachedMarvinContainer = Category | Project;

export interface IncrementalCacheState {
	version: 1;
	sourceKey: string;
	lastSeq: CouchSequence;
	categories: CachedMarvinContainer[];
	children: Record<string, CachedMarvinItem[]>;
	lastSuccessfulSyncAt: number;
	projectionPending: boolean;
}

export interface IncrementalCacheStore {
	load(): Promise<unknown>;
	save(state: IncrementalCacheState): Promise<void>;
	clear(): Promise<void>;
}

export interface IncrementalSnapshotSource {
	getCategories(): Promise<CachedMarvinContainer[]>;
	getChildren(parentId: string): Promise<CachedMarvinItem[]>;
}

export interface IncrementalChangesSource {
	changes(options: {
		since: CouchSequence | "now";
		feed?: "normal" | "longpoll";
		limit?: number;
		timeoutMs?: number;
		includeDocs?: boolean;
	}): Promise<CouchChangesPage>;
}

export interface IncrementalUpdate {
	fullRefresh: boolean;
	changed: boolean;
	affectedContainerIds: string[];
	inboxChanged: boolean;
	lastSuccessfulSyncAt: number;
}

interface AppliedChanges {
	changed: boolean;
	affectedContainerIds: Set<string>;
	inboxChanged: boolean;
}

export class IncrementalMarvinCache {
	private state: IncrementalCacheState | undefined;
	private inFlight: Promise<IncrementalUpdate> | undefined;
	private resetting = false;

	constructor(private readonly options: {
		sourceKey: string;
		changes: IncrementalChangesSource;
		snapshot: IncrementalSnapshotSource;
		store: IncrementalCacheStore;
		now?: () => number;
		maxPagesPerSync?: number;
	}) {}

	sync(feed: "normal" | "longpoll" = "normal"): Promise<IncrementalUpdate> {
		if (this.resetting) {
			return Promise.reject(
				new Error("Incremental Amazing Marvin cache is being reset"),
			);
		}
		if (this.inFlight) {
			return this.inFlight;
		}
		const pending = this.syncOnce(feed).finally(() => {
			this.inFlight = undefined;
		});
		this.inFlight = pending;
		return pending;
	}

	getCategories(): CachedMarvinContainer[] | undefined {
		return this.state
			? projectableCategories(this.state.categories).map((item) => ({ ...item }))
			: undefined;
	}

	getChildren(parentId: string): CachedMarvinItem[] | undefined {
		const children = this.state?.children[parentId];
		if (!children || !this.state) {
			return undefined;
		}
		const projectableIds = new Set(
			projectableCategories(this.state.categories).map((item) => item._id),
		);
		return children
			.filter((item) => (
				item.type !== "category"
				&& item.type !== "project"
				|| projectableIds.has(item._id)
			))
			.map((item) => ({ ...item }));
	}

	getStatus(): {
		hydrated: boolean;
		lastSuccessfulSyncAt?: number;
	} {
		return {
			hydrated: this.state !== undefined,
			...(this.state === undefined
				? {}
				: { lastSuccessfulSyncAt: this.state.lastSuccessfulSyncAt }),
		};
	}

	async clear(): Promise<void> {
		this.resetting = true;
		try {
			await this.inFlight?.catch(() => undefined);
			this.state = undefined;
			await this.options.store.clear();
		} finally {
			this.resetting = false;
		}
	}

	async acknowledgeProjection(): Promise<void> {
		if (!this.state || !this.state.projectionPending) {
			return;
		}
		this.state.projectionPending = false;
		await this.options.store.save(this.state);
	}

	private async syncOnce(
		feed: "normal" | "longpoll",
	): Promise<IncrementalUpdate> {
		const hydrated = await this.ensureHydrated();
		if (hydrated) {
			return hydrated;
		}
		return this.pullChanges(feed);
	}

	private async ensureHydrated(): Promise<IncrementalUpdate | undefined> {
		if (this.state) {
			return undefined;
		}
		const stored = parseStoredState(
			await this.options.store.load(),
			this.options.sourceKey,
		);
		if (stored) {
			this.state = stored;
			return undefined;
		}

		const checkpoint = await this.options.changes.changes({
			since: "now",
			feed: "normal",
			limit: 1,
			includeDocs: false,
		});
		const categories = await this.options.snapshot.getCategories();
		const children: Record<string, CachedMarvinItem[]> = {};
		for (const category of categories) {
			children[category._id] = await this.options.snapshot.getChildren(
				category._id,
			);
		}
		children.unassigned = await this.options.snapshot.getChildren("unassigned");

		const now = this.options.now?.() ?? Date.now();
		this.state = {
			version: 1,
			sourceKey: this.options.sourceKey,
			lastSeq: checkpoint.lastSeq,
			categories: dedupeItems(categories),
			children: Object.fromEntries(
				Object.entries(children).map(([parentId, items]) => [
					parentId,
					dedupeItems(items),
				]),
			),
			lastSuccessfulSyncAt: now,
			projectionPending: true,
		};
		await this.options.store.save(this.state);
		const caughtUp = await this.pullChanges("normal");
		return {
			...caughtUp,
			fullRefresh: true,
			changed: true,
		};
	}

	private async pullChanges(
		initialFeed: "normal" | "longpoll",
	): Promise<IncrementalUpdate> {
		if (!this.state) {
			throw new Error("Incremental Marvin cache is not hydrated");
		}
		const combined: AppliedChanges = {
			changed: false,
			affectedContainerIds: new Set(),
			inboxChanged: false,
		};
		const projectionWasPending = this.state.projectionPending;
		const maxPages = this.options.maxPagesPerSync ?? 100;
		for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
			const page = await this.options.changes.changes({
				since: this.state.lastSeq,
				feed: pageNumber === 0 ? initialFeed : "normal",
				limit: 500,
				timeoutMs: 25_000,
				includeDocs: true,
			});
			const applied = applyCouchChanges(this.state, page.results);
			this.state.projectionPending ||= applied.changed;
			this.state.lastSeq = page.lastSeq;
			this.state.lastSuccessfulSyncAt = this.options.now?.() ?? Date.now();
			mergeApplied(combined, applied);
			await this.options.store.save(this.state);

			if ((page.pending ?? 0) <= 0 && page.results.length < 500) {
				break;
			}
			if (pageNumber === maxPages - 1) {
				throw new Error(
					"Incremental Marvin sync exceeded its bounded page limit",
				);
			}
		}
		return {
			fullRefresh: projectionWasPending,
			changed: combined.changed,
			affectedContainerIds: [...combined.affectedContainerIds],
			inboxChanged: combined.inboxChanged,
			lastSuccessfulSyncAt: this.state.lastSuccessfulSyncAt,
		};
	}
}

export class IncrementalRetryBackoff {
	private failures = 0;
	private retryAt = 0;

	constructor(
		private readonly now: () => number = Date.now,
		private readonly baseDelayMs = 5_000,
		private readonly maximumDelayMs = 5 * 60_000,
	) {}

	canRun(): boolean {
		return this.now() >= this.retryAt;
	}

	recordFailure(): number {
		const delay = Math.min(
			this.maximumDelayMs,
			this.baseDelayMs * (2 ** this.failures),
		);
		this.failures += 1;
		this.retryAt = this.now() + delay;
		return delay;
	}

	recordSuccess(): void {
		this.failures = 0;
		this.retryAt = 0;
	}
}

export function applyCouchChanges(
	state: IncrementalCacheState,
	changes: readonly CouchChange[],
): AppliedChanges {
	validateRelevantChanges(changes);
	const affectedContainerIds = new Set<string>();
	let inboxChanged = false;
	let changed = false;
	const oldCategories = state.categories.map((item) => ({ ...item }));
	const changedCategoryIds = new Set<string>();

	for (const change of changes) {
		const previousCategory = state.categories.find(
			(item) => item._id === change.id,
		);
		const previousLocations = childLocations(state.children, change.id);
		const previousChildren = previousLocations
			.flatMap((parentId) => state.children[parentId] ?? [])
			.filter((item) => item._id === change.id);
		const previousCopies = [
			...(previousCategory ? [previousCategory] : []),
			...previousChildren,
		];
		if (
			change.doc?._rev
			&& previousCopies.length > 0
			&& previousCopies.every((item) => item._rev === change.doc?._rev)
		) {
			continue;
		}
		const previousCategoryIndex = state.categories.findIndex(
			(item) => item._id === change.id,
		);
		state.categories = state.categories.filter(
			(item) => item._id !== change.id,
		);
		for (const parentId of previousLocations) {
			state.children[parentId] = (state.children[parentId] ?? []).filter(
				(item) => item._id !== change.id,
			);
			markParent(parentId, affectedContainerIds, () => {
				inboxChanged = true;
			});
		}

		const doc = change.doc;
		const physicallyDeleted = change.deleted || doc?._deleted;
		if (
			!physicallyDeleted
			&& doc
			&& doc.db === "Categories"
		) {
			changedCategoryIds.add(change.id);
			const category = categoryFromDocument(doc);
			if (category && isPresentDocument(doc)) {
				const insertion = previousCategoryIndex >= 0
					? previousCategoryIndex
					: state.categories.length;
				state.categories.splice(insertion, 0, category);
				state.children[category._id] ??= [];
				if (doc.done !== true) {
					addChild(state.children, category.parentId, category);
					markParent(category.parentId, affectedContainerIds, () => {
						inboxChanged = true;
					});
				}
				affectedContainerIds.add(category._id);
			}
			changed = true;
			continue;
		}

		if (!physicallyDeleted && doc?.db === "Tasks") {
			const task = taskFromDocument(doc);
			if (task && isPresentDocument(doc) && doc.done !== true) {
				addChild(state.children, task.parentId, task);
				markParent(task.parentId, affectedContainerIds, () => {
					inboxChanged = true;
				});
			}
			changed = true;
			continue;
		}

		if (previousCategory) {
			changedCategoryIds.add(change.id);
			affectedContainerIds.add(change.id);
			changed = true;
		} else if (previousLocations.length > 0) {
			changed = true;
		}
	}

	for (const categoryId of changedCategoryIds) {
		for (const item of [
			...descendantsOf(categoryId, oldCategories),
			...descendantsOf(categoryId, state.categories),
		]) {
			affectedContainerIds.add(item);
		}
		const oldParent = oldCategories.find(
			(item) => item._id === categoryId,
		)?.parentId;
		const newParent = state.categories.find(
			(item) => item._id === categoryId,
		)?.parentId;
		markParent(oldParent, affectedContainerIds, () => {
			inboxChanged = true;
		});
		markParent(newParent, affectedContainerIds, () => {
			inboxChanged = true;
		});
	}

	return { changed, affectedContainerIds, inboxChanged };
}

function parseStoredState(
	value: unknown,
	sourceKey: string,
): IncrementalCacheState | undefined {
	if (
		typeof value !== "object"
		|| value === null
		|| (value as Partial<IncrementalCacheState>).version !== 1
		|| (value as Partial<IncrementalCacheState>).sourceKey !== sourceKey
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

function isCachedContainer(value: unknown): value is CachedMarvinContainer {
	return (
		isCachedItem(value)
		&& (value.type === "category" || value.type === "project")
	);
}

function isCachedItem(value: unknown): value is CachedMarvinItem {
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

function projectableCategories(
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

function categoryFromDocument(
	doc: MarvinDatabaseDocument,
): CachedMarvinContainer | undefined {
	if (typeof doc.title !== "string") {
		return undefined;
	}
	const common = commonFields(doc);
	if (doc.type === "project") {
		return {
			...common,
			title: doc.title,
			type: "project",
			...(typeof doc.parentId === "string" ? { parentId: doc.parentId } : {}),
			...categoryOptionalFields(doc),
		};
	}
	return {
		...common,
		title: doc.title,
		type: "category",
		...(typeof doc.parentId === "string" ? { parentId: doc.parentId } : {}),
		...categoryOptionalFields(doc),
	};
}

function taskFromDocument(
	doc: MarvinDatabaseDocument,
): Task | undefined {
	if (typeof doc.title !== "string") {
		return undefined;
	}
	return {
		...commonFields(doc),
		title: doc.title,
		type: "task",
		done: doc.done === true,
		...(typeof doc.parentId === "string" ? { parentId: doc.parentId } : {}),
		...taskOptionalFields(doc),
	};
}

function commonFields(doc: MarvinDatabaseDocument) {
	return {
		_id: doc._id,
		...(typeof doc._rev === "string" ? { _rev: doc._rev } : {}),
		...(typeof doc.createdAt === "number" ? { createdAt: doc.createdAt } : {}),
		...(typeof doc.updatedAt === "number" ? { updatedAt: doc.updatedAt } : {}),
	};
}

function categoryOptionalFields(doc: MarvinDatabaseDocument) {
	return copyDefined(doc, [
		"day",
		"firstScheduled",
		"startDate",
		"dueDate",
		"endDate",
		"done",
		"doneDate",
		"note",
		"labelIds",
		"timeEstimate",
		"priority",
		"rank",
		"recurring",
	] as const);
}

function taskOptionalFields(doc: MarvinDatabaseDocument) {
	return copyDefined(doc, [
		"day",
		"firstScheduled",
		"startDate",
		"dueDate",
		"endDate",
		"doneAt",
		"completedAt",
		"note",
		"labelIds",
		"timeEstimate",
		"priority",
		"rank",
		"recurring",
		"isRecurring",
		"subtasks",
	] as const);
}

function copyDefined(
	source: MarvinDatabaseDocument,
	keys: readonly string[],
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		if (source[key] !== undefined && source[key] !== null) {
			result[key] = source[key];
		}
	}
	return result;
}

function isPresentDocument(doc: MarvinDatabaseDocument): boolean {
	const restoredAt = typeof doc.restoredAt === "number" ? doc.restoredAt : 0;
	const deletedAt = typeof doc.deletedAt === "number" ? doc.deletedAt : 0;
	return !(deletedAt > restoredAt);
}

function validateRelevantChanges(changes: readonly CouchChange[]): void {
	for (const change of changes) {
		const doc = change.doc;
		if (!doc || change.deleted || doc._deleted) {
			continue;
		}
		if (doc._id !== change.id) {
			throw new Error(
				`Amazing Marvin change ${change.id} contained document ${doc._id}`,
			);
		}
		if (
			(doc.db === "Tasks" || doc.db === "Categories")
			&& (
				typeof doc.title !== "string"
				|| typeof doc.parentId !== "string"
			)
		) {
			throw new Error(
				`Amazing Marvin ${doc.db} document ${doc._id} is malformed`,
			);
		}
	}
}

function childLocations(
	children: Record<string, CachedMarvinItem[]>,
	itemId: string,
): string[] {
	return Object.entries(children)
		.filter(([, items]) => items.some((item) => item._id === itemId))
		.map(([parentId]) => parentId);
}

function addChild(
	children: Record<string, CachedMarvinItem[]>,
	parentId: string | undefined,
	item: CachedMarvinItem,
): void {
	if (!parentId || parentId === "root") {
		return;
	}
	const existing = children[parentId] ?? [];
	const index = existing.findIndex((candidate) => candidate._id === item._id);
	if (index === -1) {
		children[parentId] = [...existing, item];
	} else {
		const next = [...existing];
		next[index] = item;
		children[parentId] = next;
	}
}

function markParent(
	parentId: string | undefined,
	affected: Set<string>,
	inbox: () => void,
): void {
	if (!parentId || parentId === "root") {
		return;
	}
	if (parentId === "unassigned") {
		inbox();
		return;
	}
	affected.add(parentId);
}

function descendantsOf(
	rootId: string,
	categories: readonly CachedMarvinContainer[],
): string[] {
	const descendants: string[] = [];
	const queue = [rootId];
	const visited = new Set(queue);
	for (let index = 0; index < queue.length; index += 1) {
		const parentId = queue[index]!;
		for (const item of categories) {
			if (item.parentId === parentId && !visited.has(item._id)) {
				visited.add(item._id);
				descendants.push(item._id);
				queue.push(item._id);
			}
		}
	}
	return descendants;
}

function dedupeItems<T extends { _id: string }>(items: readonly T[]): T[] {
	const byId = new Map<string, T>();
	for (const item of items) {
		if (!byId.has(item._id)) {
			byId.set(item._id, item);
		}
	}
	return [...byId.values()];
}

function mergeApplied(target: AppliedChanges, source: AppliedChanges): void {
	target.changed ||= source.changed;
	target.inboxChanged ||= source.inboxChanged;
	for (const id of source.affectedContainerIds) {
		target.affectedContainerIds.add(id);
	}
}
