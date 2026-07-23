import { describe, expect, it } from "vitest";

import {
	categoryNotePath,
	normalizeManagedFolder,
	safePathSegment,
} from "./categoryPaths";

const categories = [
	{ _id: "work", title: "Work", type: "category", parentId: "root" },
	{ _id: "project", title: "Agent / Work", type: "project", parentId: "work" },
	{ _id: "child", title: "Research", type: "project", parentId: "project" },
];

describe("category/project paths", () => {
	it("uses the configured folder and full Marvin hierarchy", () => {
		expect(categoryNotePath(categories[1]!, categories, "Areas/Tasks")).toBe(
			"Areas/Tasks/Work/Agent Work/Agent Work.md",
		);
		expect(categoryNotePath(categories[2]!, categories, "Areas/Tasks")).toBe(
			"Areas/Tasks/Work/Agent Work/Research.md",
		);
	});

	it("rejects unsafe roots and hierarchy cycles instead of writing elsewhere", () => {
		expect(() => normalizeManagedFolder("../")).toThrow("Invalid");
		expect(() => normalizeManagedFolder(".obsidian/Plugins")).toThrow("Invalid");
		expect(() => categoryNotePath(
			{ _id: "a", title: "A", type: "category", parentId: "b" },
			[
				{ _id: "a", title: "A", type: "category", parentId: "b" },
				{ _id: "b", title: "B", type: "category", parentId: "a" },
			],
			"AmazingMarvin",
		)).toThrow("cycle");
	});

	it("uses an ID when a title cannot form a safe path", () => {
		expect(safePathSegment("///", "fallback-id")).toBe("fallback-id");
	});
});
