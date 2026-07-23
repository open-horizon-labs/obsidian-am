import { describe, expect, it, vi } from "vitest";

import { runTodayProjection } from "./todayWorkflow";

describe("runTodayProjection", () => {
	it("never mutates the note when the Marvin read fails", async () => {
		const process = vi.fn(async (_update: (content: string) => string) => undefined);

		await expect(runTodayProjection({
			date: "2026-07-23",
			read: async () => {
				throw new Error("Marvin unavailable");
			},
			project: () => [],
			process,
		})).rejects.toThrow("Marvin unavailable");
		expect(process).not.toHaveBeenCalled();
	});

	it("projects a successful empty result and retains read metadata", async () => {
		let content = "Journal prose";
		const result = await runTodayProjection({
			date: "2026-07-23",
			read: async () => ({
				data: [],
				freshness: "fresh" as const,
				origin: "public" as const,
				fetchedAt: 100,
				ageMs: 0,
				warnings: [],
			}),
			project: () => [],
			process: async (update) => {
				content = update(content);
			},
		});

		expect(content).toContain("No Amazing Marvin tasks for this date.");
		expect(content).toContain("Journal prose");
		expect(result.read.freshness).toBe("fresh");
	});
});
