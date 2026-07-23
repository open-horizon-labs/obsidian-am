import type { Label, Task } from "@open-horizon/marvin-client";

export type TaskMetadataFormat =
	| "dataview"
	| "tasks-dataview"
	| "tasks-emoji";

export interface TaskFormattingOptions {
	format: TaskMetadataFormat;
	titleFirst: boolean;
	showDueDate: boolean;
	showStartDate: boolean;
	showScheduledDate: boolean;
	taskTag: string;
	showMarvinLabelsAsTags: boolean;
	labelTagPrefix: string;
	dateLinkTarget?: (date: string) => string;
}

export function formatTaskMetadata(
	task: Pick<Task, "dueDate" | "startDate" | "day" | "labelIds">,
	options: TaskFormattingOptions,
	labelsById: ReadonlyMap<string, Pick<Label, "_id" | "title">> = new Map(),
): string {
	const tokens: string[] = [];
	if (options.showDueDate && task.dueDate) {
		tokens.push(formatDate("due", task.dueDate, options));
	}
	if (options.showStartDate && task.startDate) {
		tokens.push(formatDate("start", task.startDate, options));
	}
	if (
		options.showScheduledDate
		&& task.day
		&& task.day !== "unassigned"
	) {
		tokens.push(formatDate("scheduled", task.day, options));
	}

	const taskTag = tagFromPath(options.taskTag);
	if (taskTag) {
		tokens.push(taskTag);
	}
	if (options.showMarvinLabelsAsTags) {
		tokens.push(...formatMarvinLabelTags(
			task.labelIds,
			options.labelTagPrefix,
			labelsById,
		));
	}
	return tokens.join(" ");
}

export function formatMarvinLabelTags(
	labelIds: readonly string[] | undefined,
	prefix: string,
	labelsById: ReadonlyMap<string, Pick<Label, "_id" | "title">>,
): string[] {
	const tags: string[] = [];
	const seen = new Set<string>();
	for (const labelId of labelIds ?? []) {
		const label = labelsById.get(labelId);
		if (!label || !tagSegment(label.title)) {
			continue;
		}
		const path = [prefix, label.title]
			.filter((part) => part.trim())
			.join("/");
		const tag = tagFromPath(path);
		if (tag && !seen.has(tag)) {
			seen.add(tag);
			tags.push(tag);
		}
	}
	return tags;
}

export function taskTitleComesFirst(options: TaskFormattingOptions): boolean {
	return options.format !== "dataview" || options.titleFirst;
}

export function orderTaskBody(
	title: string,
	deepLink: string,
	metadata: string,
	titleFirst: boolean,
): string {
	const anchor = `[⚓](${inlineText(deepLink)})`;
	return (
		titleFirst
			? [title, anchor, metadata]
			: [anchor, metadata, title]
	)
		.filter(Boolean)
		.join(" ");
}

function formatDate(
	kind: "due" | "start" | "scheduled",
	date: string,
	options: TaskFormattingOptions,
): string {
	if (options.format === "tasks-emoji") {
		const emoji = {
			due: "📅",
			start: "🛫",
			scheduled: "⏳",
		}[kind];
		return `${emoji} ${inlineText(date)}`;
	}
	if (options.format === "tasks-dataview") {
		return `[${kind}:: ${inlineText(date)}]`;
	}

	const field = {
		due: "Due Date",
		start: "Start Date",
		scheduled: "Scheduled Date",
	}[kind];
	return `${field}:: ${dateLink(date, options.dateLinkTarget)}`;
}

function dateLink(
	date: string,
	targetForDate: TaskFormattingOptions["dateLinkTarget"],
): string {
	const target = inlineText(targetForDate?.(date) || date);
	const escapedTarget = escapeWiki(target);
	const escapedDate = escapeWiki(inlineText(date));
	return target === date
		? `[[${escapedTarget}]]`
		: `[[${escapedTarget}|${escapedDate}]]`;
}

function tagFromPath(value: string): string | undefined {
	const segments = value
		.replace(/^#+/, "")
		.split("/")
		.map(tagSegment)
		.filter(Boolean);
	if (segments.length === 0) {
		return undefined;
	}
	let path = segments.join("/");
	if (/^\d+$/.test(path)) {
		path = `label-${path}`;
	}
	return `#${path}`;
}

function tagSegment(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/[\r\n\t ]+/g, "-")
		.replace(/[\\/#\[\](){}<>|`"'!?.,:;=+*&^%$@~]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function escapeWiki(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\]/g, "\\]");
}

function inlineText(value: string): string {
	return value
		.replace(/[\r\n]+/g, " ")
		.replace(/<!--/g, "&lt;!--")
		.replace(/-->/g, "--&gt;")
		.trim();
}
