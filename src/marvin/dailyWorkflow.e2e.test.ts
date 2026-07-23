import { describe, expect, it, vi } from "vitest";
import {
	SourceActionService,
	type AddTaskRequest,
	type SourceActionKey,
	type SourceActionRecord,
	type SourceActionStore,
	type Task,
} from "@open-horizon/marvin-client";

import { buildSourceActionTaskNote } from "./obsidianLinks";
import {
	marvinIdsInMarkdown,
	refreshTodayRegion,
	type TodayProjectionItem,
} from "./todayProjection";

class FixtureSourceNote implements SourceActionStore {
	readonly associations = new Map<string, SourceActionRecord>();

	async get(key: SourceActionKey): Promise<SourceActionRecord | undefined> {
		return this.associations.get(key.actionKey);
	}

	async set(record: SourceActionRecord): Promise<void> {
		this.associations.set(record.actionKey, record);
	}

	async delete(key: SourceActionKey): Promise<void> {
		this.associations.delete(key.actionKey);
	}
}

describe("contextual daily-note workflow", () => {
	it("links an opportunity note to one Marvin task and one safely refreshable checklist entry", async () => {
		const sourcePath = "Opportunities/Titan AI.md";
		const sourceNote = new FixtureSourceNote();
		const createdTask: Task = {
			_id: "titan-decision",
			title: "Decide whether to pursue Titan AI",
			done: false,
			day: "2026-07-23",
		};
		const addTask = vi.fn(async (_request: AddTaskRequest) => createdTask);
		const sourceActions = new SourceActionService({
			router: { addTask },
			store: sourceNote,
			now: () => 1_000,
			requestId: () => "opportunity-run-1",
		});
		const request: AddTaskRequest = {
			title: createdTask.title,
			day: "2026-07-23",
			note: buildSourceActionTaskNote({
				vaultName: "Work",
				sourcePath,
				actionKey: "decide-whether-to-pursue",
				linkText: "Open opportunity note",
				format: "advanced-uri",
			}),
		};

		const first = await sourceActions.ensure({
			sourceKey: sourcePath,
			actionKey: "decide-whether-to-pursue",
			task: request,
		});
		const repeatedCreation = await sourceActions.ensure({
			sourceKey: sourcePath,
			actionKey: "decide-whether-to-pursue",
			task: request,
		});

		expect(first.created).toBe(true);
		expect(repeatedCreation.created).toBe(false);
		expect(addTask).toHaveBeenCalledTimes(1);
		expect(request.note).toContain("obsidian://adv-uri?");
		expect(sourceNote.associations.get("decide-whether-to-pursue")).toMatchObject({
			state: "linked",
			taskId: "titan-decision",
		});

		const morning: TodayProjectionItem = {
			id: "morning-task",
			title: "Existing morning task",
			done: false,
			deepLink: "https://app.amazingmarvin.com/#t=morning-task",
		};
		const initialDailyNote = [
			"# Thursday",
			"",
			"## Today's tasks",
			"- [ ] [⚓](https://app.amazingmarvin.com/#t=morning-task) Existing morning task",
			"",
			"## Notes",
			"User-authored context survives.",
		].join("\n");
		const linkedTask: TodayProjectionItem = {
			id: createdTask._id,
			title: createdTask.title,
			done: createdTask.done,
			deepLink: first.deepLink,
			sourcePath,
			sourceTitle: createdTask.title,
		};

		// The duplicate models the same task appearing in both due and scheduled reads.
		const firstRefresh = refreshTodayRegion(initialDailyNote, {
			date: "2026-07-23",
			items: [morning, linkedTask, linkedTask],
		});
		const repeatedRefresh = refreshTodayRegion(firstRefresh.content, {
			date: "2026-07-23",
			items: [morning, linkedTask, linkedTask],
		});

		expect(marvinIdsInMarkdown(firstRefresh.content)).toEqual([
			"morning-task",
			"titan-decision",
		]);
		expect(firstRefresh.content).toContain("### Added since morning");
		expect(firstRefresh.content).toContain(
			"[[Opportunities/Titan AI.md|Decide whether to pursue Titan AI]]",
		);
		expect(firstRefresh.content).toContain(
			"[⚓](https://app.amazingmarvin.com/#t=titan-decision)",
		);
		expect(firstRefresh.content).toContain("User-authored context survives.");
		expect(repeatedRefresh.changed).toBe(false);
		expect(repeatedRefresh.content).toBe(firstRefresh.content);
	});
});
