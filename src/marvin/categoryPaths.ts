export interface CategoryPathItem {
	_id: string;
	title: string;
	type?: string;
	parentId?: string;
}

export function normalizeManagedFolder(configured: string): string {
	const value = configured.trim() || "AmazingMarvin";
	const segments = value
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "")
		.split("/");
	if (
		segments.length === 0
		|| segments.some((segment) => !segment || segment === "." || segment === "..")
		|| segments[0]?.toLowerCase() === ".obsidian"
	) {
		throw new Error(`Invalid Amazing Marvin managed folder: ${configured}`);
	}
	return segments.join("/");
}

export function categoryNotePath(
	category: CategoryPathItem,
	categories: CategoryPathItem[],
	baseFolder: string,
): string {
	const byId = new Map(categories.map((item) => [item._id, item]));
	const pathSegments: string[] = [];
	const visited = new Set<string>();
	let current: CategoryPathItem | undefined = category;
	while (current) {
		if (visited.has(current._id)) {
			throw new Error(
				`Amazing Marvin category hierarchy contains a cycle at ${current._id}`,
			);
		}
		visited.add(current._id);
		pathSegments.unshift(safePathSegment(current.title, current._id));
		if (!current.parentId || current.parentId === "root") {
			break;
		}
		const childId = current._id;
		const parentId = current.parentId;
		current = byId.get(parentId);
		if (!current) {
			throw new Error(
				`Amazing Marvin parent ${parentId} for ${childId} was not returned by the API`,
			);
		}
	}

	const hasContainerChildren = categories.some((item) => (
		item.parentId === category._id
		&& (item.type === "project" || item.type === "category")
	));
	const path = `${normalizeManagedFolder(baseFolder)}/${pathSegments.join("/")}`;
	return hasContainerChildren
		? `${path}/${safePathSegment(category.title, category._id)}.md`
		: `${path}.md`;
}

export function safePathSegment(title: string, fallback: string): string {
	return title
		.replace(/[\\/:*?"<>|#^\[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		|| fallback;
}
