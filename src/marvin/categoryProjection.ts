export const CATEGORY_REGION_END = "<!-- /obsidian-am:category -->";
export const MANAGED_PROPERTIES_KEY = "amazing-marvin-managed-properties";

const CATEGORY_REGION_PREFIX = "<!-- obsidian-am:category ";
const MARVIN_LINK = /https:\/\/app\.amazingmarvin\.com\/#(?:t|p)=([^)\s]+)/;
const OWNED_FRONTMATTER_KEYS = [
	"_id",
	"_rev",
	"createdAt",
	"updatedAt",
	"title",
	"type",
	"parentId",
	"day",
	"firstScheduled",
	"startDate",
	"dueDate",
	"endDate",
	"done",
	"doneDate",
	"doneAt",
	"completedAt",
	"note",
	"labelIds",
	"timeEstimate",
	"priority",
	"rank",
	"recurring",
	"isRecurring",
	"deepLink",
] as const;

interface CategoryRegionMetadata {
	version: 1;
	itemId: string;
}

export interface RefreshCategoryRegionOptions {
	itemId: string;
	rendered: string;
	legacyKind: "category" | "inbox";
}

export interface RefreshCategoryRegionResult {
	content: string;
	changed: boolean;
	createdRegion: boolean;
}

export class CategoryProjectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CategoryProjectionError";
	}
}

export function refreshCategoryRegion(
	original: string,
	options: RefreshCategoryRegionOptions,
): RefreshCategoryRegionResult {
	const newline = original.includes("\r\n") ? "\r\n" : "\n";
	const hadTrailingNewline = original.endsWith("\n");
	const lines = original === ""
		? []
		: original.replace(/\r\n/g, "\n").split("\n");
	if (hadTrailingNewline) {
		lines.pop();
	}

	const existing = findManagedRegion(lines, options.itemId);
	if (!existing && lines.some((line) => parseStartMarker(line) !== undefined)) {
		throw new CategoryProjectionError(
			"This note already contains a managed Amazing Marvin region for another item",
		);
	}
	const legacy = existing
		? undefined
		: findLegacyRegion(lines, options.itemId, options.legacyKind);
	const replaceFrom = existing?.start ?? legacy?.start ?? lines.length;
	const replaceTo = existing
		? existing.end + 1
		: legacy?.end ?? lines.length;
	const block = renderBlock(options.itemId, options.rendered);

	if (!existing && !legacy && lines.length > 0 && lines[lines.length - 1] !== "") {
		lines.push("");
	}
	const insertion = !existing && !legacy ? lines.length : replaceFrom;
	lines.splice(insertion, replaceTo - replaceFrom, ...block);
	const next = lines.join("\n") + (hadTrailingNewline ? "\n" : "");
	const content = newline === "\n" ? next : next.replace(/\n/g, "\r\n");
	return {
		content,
		changed: content !== original,
		createdRegion: !existing,
	};
}

export function updateMarvinFrontmatter(
	frontmatter: Record<string, unknown>,
	item: Record<string, unknown>,
): void {
	const owned = new Set<string>(OWNED_FRONTMATTER_KEYS);
	const previous = frontmatter[MANAGED_PROPERTIES_KEY];
	if (Array.isArray(previous)) {
		for (const key of previous) {
			if (typeof key === "string") {
				owned.add(key);
			}
		}
	}
	for (const key of owned) {
		delete frontmatter[key];
	}

	const next = Object.fromEntries(
		Object.entries(item).filter(([, value]) => (
			value !== undefined && value !== null
		)),
	);
	for (const [key, value] of Object.entries(next)) {
		frontmatter[key] = value;
	}
	frontmatter[MANAGED_PROPERTIES_KEY] = Object.keys(next).sort();
}

export function marvinFrontmatter(
	item: Record<string, unknown>,
): Record<string, unknown> {
	const frontmatter: Record<string, unknown> = {};
	updateMarvinFrontmatter(frontmatter, item);
	return frontmatter;
}

/**
 * Repairs the invalid list shape emitted by older versions:
 * `labelIds: - first` followed by top-level `- next`.
 */
export function repairLegacyMarvinFrontmatter(content: string): string {
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	if (lines[0]?.trim() !== "---") {
		return content;
	}
	let closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (closing === -1) {
		return content;
	}

	let repairingList = false;
	let changed = false;
	for (let index = 1; index < closing; index += 1) {
		const line = lines[index] ?? "";
		const brokenStart = line.match(/^([^ \t#][^:]*):\s+-\s+(.+)$/);
		if (brokenStart?.[1] && brokenStart[2]) {
			lines.splice(
				index,
				1,
				`${brokenStart[1]}:`,
				`  - ${brokenStart[2]}`,
			);
			closing += 1;
			index += 1;
			repairingList = true;
			changed = true;
			continue;
		}
		if (repairingList && /^-\s+/.test(line)) {
			lines[index] = `  ${line}`;
			changed = true;
			continue;
		}
		if (line.trim() && !/^\s/.test(line)) {
			repairingList = false;
		}
	}
	if (!changed) {
		return content;
	}
	return lines.join(newline);
}

export function managedImportItemId(
	content: string,
	frontmatter: Record<string, unknown> | undefined,
	path: string,
): string | undefined {
	const cachedId = frontmatter?._id;
	const cachedLink = frontmatter?.deepLink;
	if (
		typeof cachedId === "string"
		&& typeof cachedLink === "string"
		&& cachedLink.includes(`/#p=${cachedId}`)
	) {
		return cachedId;
	}
	if (cachedId === "unassigned" && frontmatter?.type === "inbox") {
		return "unassigned";
	}

	for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
		const metadata = parseStartMarker(line);
		if (metadata) {
			return metadata.itemId;
		}
	}

	const frontmatterLines = frontmatterSlice(content);
	const id = frontmatterLines.match(/^_id:\s*([^\s#]+)\s*$/m)?.[1];
	const deepLink = frontmatterLines.match(
		/^deepLink:\s*https:\/\/app\.amazingmarvin\.com\/#p=([^\s]+)\s*$/m,
	)?.[1];
	if (id && deepLink === id) {
		return id;
	}

	if (
		/(^|\/)AmazingMarvin\/Inbox\.md$/.test(path)
		&& /^## Tasks$/m.test(content)
		&& MARVIN_LINK.test(content)
	) {
		return "unassigned";
	}
	return undefined;
}

function findManagedRegion(
	lines: string[],
	itemId: string,
): { start: number; end: number } | undefined {
	for (let index = 0; index < lines.length; index += 1) {
		const metadata = parseStartMarker(lines[index] ?? "");
		if (!metadata || metadata.itemId !== itemId) {
			continue;
		}
		const end = lines.indexOf(CATEGORY_REGION_END, index + 1);
		if (end === -1) {
			throw new CategoryProjectionError(
				`The managed Amazing Marvin region for ${itemId} has no closing marker`,
			);
		}
		return { start: index, end };
	}
	return undefined;
}

function parseStartMarker(line: string): CategoryRegionMetadata | undefined {
	if (!line.startsWith(CATEGORY_REGION_PREFIX) || !line.endsWith(" -->")) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(line.slice(CATEGORY_REGION_PREFIX.length, -4));
	} catch {
		throw new CategoryProjectionError(
			"A managed Amazing Marvin category region has invalid metadata",
		);
	}
	if (
		typeof value !== "object"
		|| value === null
		|| (value as Partial<CategoryRegionMetadata>).version !== 1
		|| typeof (value as Partial<CategoryRegionMetadata>).itemId !== "string"
	) {
		throw new CategoryProjectionError(
			"A managed Amazing Marvin category region has unsupported metadata",
		);
	}
	return value as CategoryRegionMetadata;
}

function findLegacyRegion(
	lines: string[],
	itemId: string,
	kind: RefreshCategoryRegionOptions["legacyKind"],
): { start: number; end: number } | undefined {
	const bodyStart = frontmatterEnd(lines);
	let start = -1;
	if (kind === "category") {
		start = lines.findIndex((line, index) => (
			index >= bodyStart
			&& line.startsWith("# ")
			&& line.includes(`https://app.amazingmarvin.com/#p=${itemId}`)
		));
	} else {
		start = lines.findIndex((line, index) => (
			index >= bodyStart
			&& line.trim() === "## Tasks"
			&& firstNonBlankLine(lines, index + 1) !== undefined
			&& MARVIN_LINK.test(firstNonBlankLine(lines, index + 1) ?? "")
		));
	}
	if (start === -1) {
		return undefined;
	}

	let end = start + 1;
	let pendingBlank = -1;
	let allowSubtask = false;
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!line.trim()) {
			pendingBlank = pendingBlank === -1 ? index : pendingBlank;
			continue;
		}
		const isSubtask = /^\s+[-*+]\s+\[[ xX]\]\s+/.test(line);
		if (isSubtask && allowSubtask && pendingBlank === -1) {
			end = index + 1;
			continue;
		}
		if (!isLegacyGeneratedLine(line, false)) {
			break;
		}
		end = index + 1;
		pendingBlank = -1;
		allowSubtask = /https:\/\/app\.amazingmarvin\.com\/#t=/.test(line);
	}
	if (pendingBlank !== -1) {
		end = Math.min(end, pendingBlank);
	}
	return { start, end };
}

function firstNonBlankLine(lines: string[], start: number): string | undefined {
	for (let index = start; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim()) {
			return line;
		}
	}
	return undefined;
}

function isLegacyGeneratedLine(line: string, includeSubtasks = true): boolean {
	return line.startsWith("Back to [[")
		|| line === "## Categories and Projects"
		|| line === "## Tasks"
		|| MARVIN_LINK.test(line)
		|| (includeSubtasks && /^\s+[-*+]\s+\[[ xX]\]\s+/.test(line));
}

function frontmatterEnd(lines: string[]): number {
	if (lines[0]?.trim() !== "---") {
		return 0;
	}
	const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	return closing === -1 ? 0 : closing + 1;
}

function frontmatterSlice(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return "";
	}
	const end = normalized.indexOf("\n---", 4);
	return end === -1 ? "" : normalized.slice(4, end);
}

function renderBlock(itemId: string, rendered: string): string[] {
	const metadata: CategoryRegionMetadata = {
		version: 1,
		itemId,
	};
	return [
		`${CATEGORY_REGION_PREFIX}${JSON.stringify(metadata)} -->`,
		...rendered.trim().split(/\r?\n/),
		CATEGORY_REGION_END,
	];
}
