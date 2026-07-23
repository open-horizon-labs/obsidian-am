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
