import type { CategoryPathItem } from "./categoryPaths";

export type SyncSelectionMode = "all" | "selected";

export interface SyncRootSelection {
	id: string;
	title: string;
}

export interface CategorySyncPlan {
	includedIds: ReadonlySet<string>;
	contentIds: ReadonlySet<string>;
	structuralIds: ReadonlySet<string>;
}

export interface SyncProjectionItem extends CategoryPathItem {
	type?: string;
}

export function planCategorySync(
	categories: CategoryPathItem[],
	mode: SyncSelectionMode,
	rootIds: readonly string[],
): CategorySyncPlan {
	const byId = new Map(categories.map((item) => [item._id, item]));
	if (mode === "all") {
		const all = new Set(byId.keys());
		return {
			includedIds: all,
			contentIds: all,
			structuralIds: new Set(),
		};
	}

	const contentIds = new Set<string>();
	const queue: string[] = [];
	for (const rootId of new Set(rootIds)) {
		if (!byId.has(rootId)) {
			throw new Error(
				`Selected Amazing Marvin item ${rootId} was not returned by the API`,
			);
		}
		contentIds.add(rootId);
		queue.push(rootId);
	}

	for (let index = 0; index < queue.length; index += 1) {
		const parentId = queue[index]!;
		for (const item of categories) {
			if (item.parentId === parentId && !contentIds.has(item._id)) {
				contentIds.add(item._id);
				queue.push(item._id);
			}
		}
	}

	const includedIds = new Set(contentIds);
	for (const contentId of contentIds) {
		let current = byId.get(contentId);
		const visited = new Set<string>();
		while (current?.parentId && current.parentId !== "root") {
			if (visited.has(current._id)) {
				throw new Error(
					`Amazing Marvin category hierarchy contains a cycle at ${current._id}`,
				);
			}
			visited.add(current._id);
			const parent = byId.get(current.parentId);
			if (!parent) {
				throw new Error(
					`Amazing Marvin parent ${current.parentId} for ${current._id} was not returned by the API`,
				);
			}
			includedIds.add(parent._id);
			current = parent;
		}
	}

	return {
		includedIds,
		contentIds,
		structuralIds: new Set(
			[...includedIds].filter((id) => !contentIds.has(id)),
		),
	};
}

export function categoryProjectionItems<T extends SyncProjectionItem>(
	parentId: string,
	plan: CategorySyncPlan,
	categories: readonly T[],
	fetchedChildren?: readonly T[],
): T[] {
	if (!plan.contentIds.has(parentId)) {
		return categories.filter((item) => (
			item.parentId === parentId
			&& plan.includedIds.has(item._id)
		));
	}
	if (!fetchedChildren) {
		throw new Error(
			`Amazing Marvin children were not fetched for selected item ${parentId}`,
		);
	}
	return fetchedChildren.filter((item) => (
		item.type !== "category"
		&& item.type !== "project"
		|| plan.includedIds.has(item._id)
	));
}

/** Which of an incremental sync's affected containers should actually be
 * re-rendered — the intersection with the user's selective-import plan.
 * A category the user excluded from import must not start appearing just
 * because it changed in Marvin; incremental sync must respect the same
 * selection boundary the REST importer already does. */
export function targetedContainerIds(
	affectedContainerIds: readonly string[],
	plan: CategorySyncPlan,
): Set<string> {
	return new Set(
		affectedContainerIds.filter((id) => plan.includedIds.has(id)),
	);
}

/** Narrows a full plan down to just the targeted ids, preserving the real
 * content-vs-structural distinction — a targeted ancestor that's
 * structure-only in the full plan must stay structure-only here too.
 * Collapsing everything targeted into contentIds would render full content
 * for a note that's meant to show navigation-only links. */
export function buildTargetedPlan(
	targetedIds: ReadonlySet<string>,
	fullPlan: CategorySyncPlan,
): CategorySyncPlan {
	const contentIds = new Set(
		[...targetedIds].filter((id) => fullPlan.contentIds.has(id)),
	);
	return {
		includedIds: targetedIds,
		contentIds,
		structuralIds: new Set(
			[...targetedIds].filter((id) => !contentIds.has(id)),
		),
	};
}
