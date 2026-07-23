import { describe, expect, it } from "vitest";

import { marvinParentIdFromFrontmatter } from "./noteContext";

describe("Marvin note context", () => {
	it("uses an imported category or project as the task parent", () => {
		expect(marvinParentIdFromFrontmatter({
			_id: "project-1",
			type: "project",
			deepLink: "https://app.amazingmarvin.com/#p=project-1",
		})).toBe("project-1");
	});

	it("does not treat unrelated frontmatter or tasks as a parent", () => {
		expect(marvinParentIdFromFrontmatter({
			_id: "task-1",
			type: "task",
			deepLink: "https://app.amazingmarvin.com/#t=task-1",
		})).toBeUndefined();
		expect(marvinParentIdFromFrontmatter({ _id: "project-1" })).toBeUndefined();
		expect(marvinParentIdFromFrontmatter({
			_id: "project-1",
			type: "project",
			deepLink: "https://app.amazingmarvin.com/#p=project-10",
		})).toBeUndefined();
	});
});
