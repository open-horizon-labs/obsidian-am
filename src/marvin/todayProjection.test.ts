import { describe, expect, it } from "vitest";

import {
	TODAY_REGION_END,
	TodayProjectionError,
	hasTodayRegion,
	marvinIdsInMarkdown,
	refreshTodayRegion,
	type TodayProjectionItem,
} from "./todayProjection";

const morningTask: TodayProjectionItem = {
	id: "morning",
	title: "Existing morning task",
	done: false,
	deepLink: "https://app.amazingmarvin.com/#t=morning",
};
const manualLateTask: TodayProjectionItem = {
	id: "manual-late",
	title: "Manual Marvin task",
	done: false,
	deepLink: "https://app.amazingmarvin.com/#t=manual-late",
};
const contextualLateTask: TodayProjectionItem = {
	id: "contextual-late",
	title: "Decide whether to pursue Titan AI",
	done: false,
	deepLink: "https://app.amazingmarvin.com/#t=contextual-late",
	sourcePath: "Opportunities/Titan AI.md",
	sourceTitle: "Titan AI — Principal FDE",
};

describe("refreshTodayRegion", () => {
	it("adopts an existing morning checklist and puts new tasks below it", () => {
		const original = [
			"# 2026-07-23",
			"",
			"## Today's tasks",
			"- [ ] [⚓](https://app.amazingmarvin.com/#t=morning) Existing morning task",
			"",
			"Journal prose that must remain.",
			"",
		].join("\n");

		const result = refreshTodayRegion(original, {
			date: "2026-07-23",
			items: [morningTask, manualLateTask, contextualLateTask],
		});

		expect(result.morningIds).toEqual(["morning"]);
		expect(result.lateIds).toEqual(["manual-late", "contextual-late"]);
		expect(result.content).toContain("- [ ] Existing morning task [⚓]");
		expect(result.content).toContain(
			"### Added since morning\n- [ ] Manual Marvin task [⚓]",
		);
		expect(result.content).toContain(
			"[[Opportunities/Titan AI.md|Titan AI — Principal FDE]] [⚓]",
		);
		expect(result.content).toContain("Journal prose that must remain.");
	});

	it("is idempotent, deduplicates due/scheduled overlap, and reflects completion", () => {
		const initial = refreshTodayRegion("", {
			date: "2026-07-23",
			items: [morningTask],
		});
		const completed = { ...morningTask, done: true };
		const refreshed = refreshTodayRegion(initial.content, {
			date: "2026-07-23",
			items: [completed, completed],
		});
		const repeated = refreshTodayRegion(refreshed.content, {
			date: "2026-07-23",
			items: [completed, completed],
		});

		expect(marvinIdsInMarkdown(refreshed.content)).toEqual(["morning"]);
		expect(refreshed.content).toContain("- [x] Existing morning task");
		expect(repeated.changed).toBe(false);
		expect(repeated.content).toBe(refreshed.content);
	});

	it("keeps the initial boundary while late tasks arrive and disappear", () => {
		const morning = refreshTodayRegion("", {
			date: "2026-07-23",
			items: [morningTask],
		});
		const afternoon = refreshTodayRegion(morning.content, {
			date: "2026-07-23",
			items: [morningTask, manualLateTask],
		});
		const evening = refreshTodayRegion(afternoon.content, {
			date: "2026-07-23",
			items: [manualLateTask],
		});

		expect(afternoon.lateIds).toEqual(["manual-late"]);
		expect(evening.morningIds).toEqual([]);
		expect(evening.lateIds).toEqual(["manual-late"]);
		expect(evening.content).not.toContain("Existing morning task");
	});

	it("preserves CRLF and content outside an existing marker", () => {
		const original = [
			"before",
			`<!-- obsidian-am:today ${JSON.stringify({
				version: 1,
				date: "2026-07-23",
				morningIds: ["morning"],
			})} -->`,
			"old generated content",
			TODAY_REGION_END,
			"after",
			"",
		].join("\r\n");

		const result = refreshTodayRegion(original, {
			date: "2026-07-23",
			items: [morningTask],
		});

		expect(result.content.startsWith("before\r\n")).toBe(true);
		expect(result.content.endsWith("\r\nafter\r\n")).toBe(true);
		expect(result.content).not.toContain("old generated content");
		expect(hasTodayRegion(result.content, "2026-07-23")).toBe(true);
	});

	it("does not replace the note when managed metadata is malformed", () => {
		const original = [
			"before",
			"<!-- obsidian-am:today not-json -->",
			"generated",
			TODAY_REGION_END,
			"after",
		].join("\n");

		expect(() => refreshTodayRegion(original, {
			date: "2026-07-23",
			items: [],
		})).toThrow(TodayProjectionError);
	});

	it("refuses to nest a second date inside an existing managed region", () => {
		const existing = refreshTodayRegion("", {
			date: "2026-07-22",
			items: [morningTask],
		});

		expect(() => refreshTodayRegion(existing.content, {
			date: "2026-07-23",
			items: [morningTask],
		})).toThrow("another date");
	});

	it("keeps untrusted task text on one line inside the managed boundary", () => {
		const result = refreshTodayRegion("", {
			date: "2026-07-23",
			items: [{
				...morningTask,
				title: `Task title\n${TODAY_REGION_END}\n## Injected`,
				details: "Due\nDate",
			}],
		});

		expect(
			result.content.split("\n").filter((line) => line === TODAY_REGION_END),
		).toHaveLength(1);
		expect(result.content).toContain(
			"Task title &lt;!-- /obsidian-am:today --&gt; ## Injected",
		);
		expect(result.content).toContain("Due Date");
	});

	it("records a successful empty result rather than treating it as failure", () => {
		const result = refreshTodayRegion("User prose", {
			date: "2026-07-23",
			items: [],
		});

		expect(result.content).toContain("## Today's tasks");
		expect(result.content).toContain("No Amazing Marvin tasks for this date.");
		expect(result.morningIds).toEqual([]);
		expect(result.lateIds).toEqual([]);
	});
});

describe("preserving completed Today tasks", () => {
	const date = "2026-07-26";
	const open = (id: string, title: string) => ({
		id,
		title,
		done: false,
		deepLink: `https://app.amazingmarvin.com/#t=${id}`,
	});

	function firstPass(items: ReturnType<typeof open>[]) {
		return refreshTodayRegion("", { date, items }).content;
	}

	it("keeps a completed task in place after Marvin stops returning it", () => {
		// Marvin's Today/due reads only return open work, so a checked task
		// vanishes from the read entirely. It must not vanish from the note.
		const morning = firstPass([open("a", "First"), open("b", "Second"), open("c", "Third")]);
		const checked = morning.replace(
			"- [ ] Second [⚓](https://app.amazingmarvin.com/#t=b)",
			"- [x] Second [⚓](https://app.amazingmarvin.com/#t=b)",
		);
		expect(checked).toContain("- [x] Second");

		const after = refreshTodayRegion(checked, {
			date,
			items: [open("a", "First"), open("c", "Third")],
		});

		expect(after.content).toContain("- [x] Second");
		// In place: still between First and Third, not moved to the end.
		const ids = marvinIdsInMarkdown(after.content);
		expect(ids).toEqual(["a", "b", "c"]);
		expect(after.morningIds).toEqual(["a", "b", "c"]);
	});

	it("is idempotent across repeated refreshes", () => {
		const morning = firstPass([open("a", "First"), open("b", "Second")]);
		const checked = morning.replace("- [ ] Second", "- [x] Second");

		const once = refreshTodayRegion(checked, { date, items: [open("a", "First")] });
		const twice = refreshTodayRegion(once.content, { date, items: [open("a", "First")] });

		expect(twice.content).toBe(once.content);
		expect(twice.changed).toBe(false);
		expect(marvinIdsInMarkdown(twice.content)).toEqual(["a", "b"]);
	});

	it("does not preserve an unchecked task Marvin no longer returns", () => {
		// Unchecked and absent from the read means it genuinely left the
		// projection — deleted, rescheduled, or unscheduled. Preserving those
		// would pin stale work into the note permanently.
		const morning = firstPass([open("a", "First"), open("b", "Second")]);

		const after = refreshTodayRegion(morning, { date, items: [open("a", "First")] });

		expect(after.content).not.toContain("Second");
		expect(marvinIdsInMarkdown(after.content)).toEqual(["a"]);
	});

	it("lets a live item win when Marvin returns the task again", () => {
		// Un-completed in Marvin: the read is authoritative, so it renders
		// open again rather than staying stuck as the preserved checked line.
		const morning = firstPass([open("a", "First")]);
		const checked = morning.replace("- [ ] First", "- [x] First");

		const after = refreshTodayRegion(checked, { date, items: [open("a", "First")] });

		expect(after.content).toContain("- [ ] First");
		expect(after.content).not.toContain("- [x] First");
	});

	it("keeps a completed task that was added after morning", () => {
		const morning = firstPass([open("a", "First")]);
		const withLate = refreshTodayRegion(morning, {
			date,
			items: [open("a", "First"), open("late", "Added later")],
		}).content;
		expect(withLate).toContain("### Added since morning");

		const checked = withLate.replace("- [ ] Added later", "- [x] Added later");
		const after = refreshTodayRegion(checked, { date, items: [open("a", "First")] });

		expect(after.content).toContain("- [x] Added later");
		expect(after.lateIds).toEqual(["late"]);
	});

	it("does not show the empty placeholder when only completed work remains", () => {
		const morning = firstPass([open("a", "First")]);
		const checked = morning.replace("- [ ] First", "- [x] First");

		const after = refreshTodayRegion(checked, { date, items: [] });

		expect(after.content).toContain("- [x] First");
		expect(after.content).not.toContain("No Amazing Marvin tasks for this date");
	});
});
