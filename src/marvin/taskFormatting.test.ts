import { describe, expect, it } from "vitest";

import {
	formatTaskMetadata,
	formatMarvinLabelTags,
	orderTaskBody,
	taskTitleComesFirst,
	type TaskFormattingOptions,
} from "./taskFormatting";

const defaults: TaskFormattingOptions = {
	format: "dataview",
	titleFirst: false,
	showDueDate: true,
	showStartDate: true,
	showScheduledDate: true,
	taskTag: "",
	showMarvinLabelsAsTags: false,
	labelTagPrefix: "marvin",
};

const task = {
	dueDate: "2026-07-25",
	startDate: "2026-07-22",
	day: "2026-07-23",
	labelIds: ["knowledge", "numeric", "missing"],
};

describe("task formatting", () => {
	it("preserves the current Dataview format by default", () => {
		const metadata = formatTaskMetadata(task, defaults);

		expect(metadata).toBe(
			"Due Date:: [[2026-07-25]] "
			+ "Start Date:: [[2026-07-22]] "
			+ "Scheduled Date:: [[2026-07-23]]",
		);
		expect(orderTaskBody(
			"Write brief",
			"https://app.amazingmarvin.com/#t=task-1",
			metadata,
			taskTitleComesFirst(defaults),
		)).toBe(
			"[⚓](https://app.amazingmarvin.com/#t=task-1) "
			+ `${metadata} Write brief`,
		);
	});

	it("links Dataview dates to weekly notes with the date as alias", () => {
		expect(formatTaskMetadata(task, {
			...defaults,
			dateLinkTarget: () => "2026-W30",
		})).toContain("Due Date:: [[2026-W30|2026-07-25]]");
	});

	it("renders Tasks emoji and Dataview presets after the title", () => {
		const emoji = {
			...defaults,
			format: "tasks-emoji" as const,
		};
		expect(formatTaskMetadata(task, emoji)).toBe(
			"📅 2026-07-25 🛫 2026-07-22 ⏳ 2026-07-23",
		);
		expect(taskTitleComesFirst(emoji)).toBe(true);

		expect(formatTaskMetadata(task, {
			...defaults,
			format: "tasks-dataview",
		})).toBe(
			"[due:: 2026-07-25] "
			+ "[start:: 2026-07-22] "
			+ "[scheduled:: 2026-07-23]",
		);
	});

	it("adds a query tag and stable namespaced tags for known Marvin labels", () => {
		const labels = new Map([
			["knowledge", { _id: "knowledge", title: "Knowledge work" }],
			["numeric", { _id: "numeric", title: "2026" }],
			["empty", { _id: "empty", title: "!!!" }],
		]);

		const metadata = formatTaskMetadata({
			...task,
			labelIds: [...task.labelIds, "empty"],
		}, {
			...defaults,
			taskTag: "#task",
			showMarvinLabelsAsTags: true,
			labelTagPrefix: "marvin/labels",
		}, labels);
		expect(metadata).toContain(
			"#task #marvin/labels/Knowledge-work #marvin/labels/2026",
		);
		expect(metadata.endsWith("#marvin/labels")).toBe(false);
		expect(formatMarvinLabelTags(
			["knowledge"],
			"marvin",
			labels,
		)).toEqual(["#marvin/Knowledge-work"]);
	});

	it("keeps untrusted configured values and labels on one line", () => {
		const labels = new Map([
			["unsafe", { _id: "unsafe", title: "A #tag\n<!-- injected -->" }],
		]);

		const metadata = formatTaskMetadata({
			day: "2026-07-23",
			labelIds: ["unsafe"],
		}, {
			...defaults,
			dateLinkTarget: () => "Week|bad]\n<!-- boundary -->",
			showMarvinLabelsAsTags: true,
			labelTagPrefix: "marvin",
		}, labels);

		expect(metadata).not.toContain("\n");
		expect(metadata).toContain("[[Week\\|bad\\] &lt;!-- boundary --&gt;|2026-07-23]]");
		expect(metadata).toContain("#marvin/A-tag-injected");
	});
});
