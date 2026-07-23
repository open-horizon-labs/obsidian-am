export const TODAY_TASKS_HEADING = "## Today's tasks";
export const TODAY_REGION_END = "<!-- /obsidian-am:today -->";

const TODAY_REGION_PREFIX = "<!-- obsidian-am:today ";
const MARVIN_ITEM_LINK = /https:\/\/app\.amazingmarvin\.com\/#(?:t|p)=([^)\s]+)/;

export interface TodayProjectionItem {
	id: string;
	title: string;
	done: boolean;
	deepLink: string;
	details?: string;
	sourcePath?: string;
	sourceTitle?: string;
}

export interface TodayRegionMetadata {
	version: 1;
	date: string;
	morningIds: string[];
}

export interface RefreshTodayRegionOptions {
	date: string;
	items: TodayProjectionItem[];
	heading?: string;
}

export interface RefreshTodayRegionResult {
	content: string;
	changed: boolean;
	createdRegion: boolean;
	morningIds: string[];
	lateIds: string[];
}

export class TodayProjectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TodayProjectionError";
	}
}

export function refreshTodayRegion(
	original: string,
	options: RefreshTodayRegionOptions,
): RefreshTodayRegionResult {
	const heading = options.heading ?? TODAY_TASKS_HEADING;
	const newline = original.includes("\r\n") ? "\r\n" : "\n";
	const hadTrailingNewline = original.endsWith("\n");
	const lines = original === ""
		? []
		: original.replace(/\r\n/g, "\n").split("\n");
	if (hadTrailingNewline) {
		lines.pop();
	}

	const existingRegion = findManagedRegion(lines, options.date);
	if (
		!existingRegion
		&& lines.some((line) => parseStartMarker(line) !== undefined)
	) {
		throw new TodayProjectionError(
			`This note already contains a managed Amazing Marvin region for another date`,
		);
	}
	const uniqueItems = dedupeItems(options.items);
	let morningIds: string[];
	let replaceFrom: number;
	let replaceTo: number;
	let createdRegion = false;

	if (existingRegion) {
		morningIds = existingRegion.metadata.morningIds;
		replaceFrom = existingRegion.start;
		replaceTo = existingRegion.end + 1;
	} else {
		const adoption = findLegacyMarvinItems(lines, heading);
		morningIds = adoption.ids.length > 0
			? adoption.ids
			: uniqueItems.map((item) => item.id);
		replaceFrom = adoption.start;
		replaceTo = adoption.end;
		createdRegion = true;
	}

	const currentIds = new Set(uniqueItems.map((item) => item.id));
	morningIds = dedupeStrings(morningIds).filter((id) => currentIds.has(id));
	const morningIdSet = new Set(morningIds);
	const morning = uniqueItems.filter((item) => morningIdSet.has(item.id));
	const late = uniqueItems.filter((item) => !morningIdSet.has(item.id));
	const block = renderManagedBlock(options.date, morningIds, morning, late);

	lines.splice(replaceFrom, replaceTo - replaceFrom, ...block);
	const next = lines.join("\n") + (hadTrailingNewline ? "\n" : "");
	const content = newline === "\n" ? next : next.replace(/\n/g, "\r\n");

	return {
		content,
		changed: content !== original,
		createdRegion,
		morningIds,
		lateIds: late.map((item) => item.id),
	};
}

export function hasTodayRegion(content: string, date?: string): boolean {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	return date === undefined
		? lines.some((line) => parseStartMarker(line) !== undefined)
		: findManagedRegion(lines, date) !== undefined;
}

export function marvinIdsInMarkdown(content: string): string[] {
	const ids: string[] = [];
	for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
		const match = line.match(MARVIN_ITEM_LINK);
		if (match?.[1]) {
			ids.push(match[1]);
		}
	}
	return dedupeStrings(ids);
}

function findManagedRegion(
	lines: string[],
	date: string,
): { start: number; end: number; metadata: TodayRegionMetadata } | undefined {
	for (let index = 0; index < lines.length; index += 1) {
		const metadata = parseStartMarker(lines[index] ?? "");
		if (!metadata || metadata.date !== date) {
			continue;
		}
		const end = lines.indexOf(TODAY_REGION_END, index + 1);
		if (end === -1) {
			throw new TodayProjectionError(
				`The managed Amazing Marvin region for ${date} has no closing marker`,
			);
		}
		return { start: index, end, metadata };
	}
	return undefined;
}

function parseStartMarker(line: string): TodayRegionMetadata | undefined {
	if (!line.startsWith(TODAY_REGION_PREFIX) || !line.endsWith(" -->")) {
		return undefined;
	}
	const serialized = line.slice(TODAY_REGION_PREFIX.length, -4);
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new TodayProjectionError("A managed Amazing Marvin region has invalid metadata");
	}
	if (
		typeof value !== "object"
		|| value === null
		|| (value as Partial<TodayRegionMetadata>).version !== 1
		|| typeof (value as Partial<TodayRegionMetadata>).date !== "string"
		|| !Array.isArray((value as Partial<TodayRegionMetadata>).morningIds)
		|| !(value as TodayRegionMetadata).morningIds.every((id) => typeof id === "string")
	) {
		throw new TodayProjectionError("A managed Amazing Marvin region has unsupported metadata");
	}
	return value as TodayRegionMetadata;
}

function findLegacyMarvinItems(
	lines: string[],
	heading: string,
): { start: number; end: number; ids: string[] } {
	const headingIndex = lines.findIndex((line) => line.trim() === heading);
	if (headingIndex === -1) {
		const prefix: string[] = [];
		if (lines.length > 0 && lines[lines.length - 1] !== "") {
			prefix.push("");
		}
		prefix.push(heading);
		lines.push(...prefix);
		return {
			start: lines.length,
			end: lines.length,
			ids: [],
		};
	}

	let first = -1;
	let last = -1;
	const ids: string[] = [];
	for (let index = headingIndex + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (/^#{1,2}\s/.test(line)) {
			break;
		}
		const match = line.match(MARVIN_ITEM_LINK);
		if (match?.[1]) {
			first = first === -1 ? index : first;
			last = index;
			ids.push(match[1]);
			continue;
		}
		if (
			first !== -1
			&& line.trim() !== ""
			&& !/^\s+[-*+]\s+\[[ xX]\]\s+/.test(line)
		) {
			break;
		}
		if (first !== -1 && /^\s*$/.test(line)) {
			break;
		}
		if (first !== -1) {
			last = index;
		}
	}

	if (first !== -1) {
		return {
			start: first,
			end: last + 1,
			ids: dedupeStrings(ids),
		};
	}
	return {
		start: headingIndex + 1,
		end: headingIndex + 1,
		ids: [],
	};
}

function renderManagedBlock(
	date: string,
	morningIds: string[],
	morning: TodayProjectionItem[],
	late: TodayProjectionItem[],
): string[] {
	const metadata: TodayRegionMetadata = {
		version: 1,
		date,
		morningIds,
	};
	const lines = [
		`${TODAY_REGION_PREFIX}${JSON.stringify(metadata)} -->`,
		...morning.map(renderItem),
	];
	if (late.length > 0) {
		if (morning.length > 0) {
			lines.push("");
		}
		lines.push("### Added since morning", ...late.map(renderItem));
	}
	if (morning.length === 0 && late.length === 0) {
		lines.push("<!-- No Amazing Marvin tasks for this date. -->");
	}
	lines.push(TODAY_REGION_END);
	return lines;
}

function renderItem(item: TodayProjectionItem): string {
	const status = item.done ? "x" : " ";
	const title = item.sourcePath
		? `[[${escapeWikiTarget(item.sourcePath)}|${escapeWikiAlias(item.sourceTitle ?? item.title)}]]`
		: inlineText(item.title);
	const details = inlineText(item.details ?? "");
	return `- [${status}] ${title} [⚓](${item.deepLink})${details ? ` ${details}` : ""}`;
}

function escapeWikiTarget(value: string): string {
	return inlineText(value).replace(/\|/g, "\\|").replace(/\]/g, "\\]");
}

function escapeWikiAlias(value: string): string {
	return inlineText(value).replace(/\|/g, "\\|").replace(/\]/g, "\\]");
}

function inlineText(value: string): string {
	return value
		.replace(/[\r\n]+/g, " ")
		.replace(/<!--/g, "&lt;!--")
		.replace(/-->/g, "--&gt;")
		.trim();
}

function dedupeItems(items: TodayProjectionItem[]): TodayProjectionItem[] {
	const byId = new Map<string, TodayProjectionItem>();
	for (const item of items) {
		if (!byId.has(item.id)) {
			byId.set(item.id, item);
		}
	}
	return [...byId.values()];
}

function dedupeStrings(values: string[]): string[] {
	return [...new Set(values)];
}
