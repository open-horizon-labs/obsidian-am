import { describe, expect, it } from "vitest";

import {
	isNewlyCompletedMarvinTask,
	marvinTaskIdFromCompletedLine,
} from "./taskLine";

describe("Amazing Marvin completion line matching", () => {
	it("recognizes both legacy and contextual task rendering", () => {
		expect(marvinTaskIdFromCompletedLine(
			"- [x] [⚓](https://app.amazingmarvin.com/#t=legacy) Legacy task",
		)).toBe("legacy");
		expect(marvinTaskIdFromCompletedLine(
			"- [X] [[Source note|Contextual action]] [⚓](https://app.amazingmarvin.com/#t=contextual) Due Date:: [[2026-07-23]]",
		)).toBe("contextual");
	});

	it("ignores unchecked tasks and Marvin projects", () => {
		expect(marvinTaskIdFromCompletedLine(
			"- [ ] Task [⚓](https://app.amazingmarvin.com/#t=open)",
		)).toBeUndefined();
		expect(marvinTaskIdFromCompletedLine(
			"- [x] Project [⚓](https://app.amazingmarvin.com/#p=project)",
		)).toBeUndefined();
	});

	it("only emits a completion for the same task changing from unchecked to checked", () => {
		const open = "- [ ] Action [⚓](https://app.amazingmarvin.com/#t=task-1)";
		const done = "- [x] Action [⚓](https://app.amazingmarvin.com/#t=task-1)";

		expect(isNewlyCompletedMarvinTask(open, done)).toBe("task-1");
		expect(isNewlyCompletedMarvinTask(done, done)).toBeUndefined();
		expect(isNewlyCompletedMarvinTask("", done)).toBeUndefined();
		expect(isNewlyCompletedMarvinTask(
			"- [ ] Other [⚓](https://app.amazingmarvin.com/#t=task-2)",
			done,
		)).toBeUndefined();
	});
});
