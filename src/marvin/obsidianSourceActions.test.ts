import { describe, expect, it } from "vitest";
import type { App } from "obsidian";

import {
	ObsidianSourceActionStore,
	SOURCE_ACTIONS_FRONTMATTER_KEY,
	readSourceActionRecords,
} from "./obsidianSourceActions";

describe("source action frontmatter", () => {
	it("reads pending and linked associations using the note path as source identity", () => {
		const records = readSourceActionRecords({
			[SOURCE_ACTIONS_FRONTMATTER_KEY]: [
				{
					version: 1,
					state: "pending",
					actionKey: "decide",
					title: "Decide",
					requestId: "request-1",
					requestedAt: 100,
				},
				{
					version: 1,
					state: "linked",
					actionKey: "apply",
					title: "Apply",
					requestId: "request-2",
					requestedAt: 200,
					taskId: "task-2",
					deepLink: "https://app.amazingmarvin.com/#t=task-2",
					linkedAt: 300,
				},
			],
		}, "Opportunities/Titan.md");

		expect(records).toEqual([
			expect.objectContaining({
				state: "pending",
				sourceKey: "Opportunities/Titan.md",
				actionKey: "decide",
			}),
			expect.objectContaining({
				state: "linked",
				sourceKey: "Opportunities/Titan.md",
				taskId: "task-2",
			}),
		]);
	});

	it("distinguishes no associations from malformed owned metadata", () => {
		expect(readSourceActionRecords({}, "note.md")).toEqual([]);
		expect(() => readSourceActionRecords({
			[SOURCE_ACTIONS_FRONTMATTER_KEY]: "task-1",
		}, "note.md")).toThrow("must be a list");
	});

	it("persists a linked association and discovers its source note by task ID", async () => {
		const file = {
			path: "Opportunities/Titan.md",
			basename: "Titan",
			extension: "md",
		};
		const frontmatter: Record<string, unknown> = {};
		const app = {
			vault: {
				getAbstractFileByPath: (path: string) => path === file.path ? file : null,
				getMarkdownFiles: () => [file],
			},
			metadataCache: {
				getFileCache: () => ({ frontmatter }),
			},
			fileManager: {
				processFrontMatter: async (
					_file: unknown,
					mutate: (value: Record<string, unknown>) => void,
				) => mutate(frontmatter),
			},
		} as unknown as App;
		const store = new ObsidianSourceActionStore(app);

		await store.set({
			version: 1,
			state: "linked",
			sourceKey: file.path,
			actionKey: "decide",
			title: "Decide whether to pursue",
			requestId: "request-1",
			requestedAt: 100,
			taskId: "task-1",
			deepLink: "https://app.amazingmarvin.com/#t=task-1",
			linkedAt: 200,
		});

		expect(frontmatter[SOURCE_ACTIONS_FRONTMATTER_KEY]).toEqual([
			expect.objectContaining({
				actionKey: "decide",
				taskId: "task-1",
			}),
		]);
		expect(await store.get({
			sourceKey: file.path,
			actionKey: "decide",
		})).toMatchObject({ state: "linked", taskId: "task-1" });
		expect(store.findLinkedTasks(["task-1"]).get("task-1")).toEqual({
			taskId: "task-1",
			sourcePath: file.path,
			sourceTitle: "Titan",
			actionKey: "decide",
			deepLink: "https://app.amazingmarvin.com/#t=task-1",
		});
		expect(store.shouldInvalidateFor(file.path, undefined)).toBe(true);
		expect(store.shouldInvalidateFor("Daily/2026-07-23.md", {})).toBe(false);
	});
});
