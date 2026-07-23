import { describe, expect, it } from "vitest";

import {
	categoryProjectionItems,
	planCategorySync,
} from "./syncSelection";

const categories = [
	{ _id: "work", title: "Work", type: "category", parentId: "root" },
	{ _id: "knowledge", title: "Knowledge", type: "category", parentId: "work" },
	{ _id: "project", title: "Write book", type: "project", parentId: "knowledge" },
	{ _id: "chapter", title: "Chapter one", type: "project", parentId: "project" },
	{ _id: "garden", title: "Garden", type: "project", parentId: "work" },
];

describe("category sync selection", () => {
	it("keeps the existing all-items behavior by default", () => {
		const plan = planCategorySync(categories, "all", []);

		expect([...plan.contentIds]).toEqual(categories.map((item) => item._id));
		expect(plan.structuralIds.size).toBe(0);
	});

	it("includes selected roots and descendants with ancestors as structure only", () => {
		const plan = planCategorySync(categories, "selected", ["project"]);

		expect([...plan.contentIds]).toEqual(["project", "chapter"]);
		expect([...plan.structuralIds]).toEqual(["knowledge", "work"]);
		expect(plan.includedIds.has("garden")).toBe(false);
	});

	it("allows an intentionally empty selection without falling back to all", () => {
		const plan = planCategorySync(categories, "selected", []);

		expect(plan.includedIds.size).toBe(0);
		expect(plan.contentIds.size).toBe(0);
	});

	it("fails closed for stale IDs, missing parents, and cycles", () => {
		expect(() => planCategorySync(
			categories,
			"selected",
			["missing"],
		)).toThrow("was not returned");
		expect(() => planCategorySync(
			[{ _id: "child", title: "Child", parentId: "missing" }],
			"selected",
			["child"],
		)).toThrow("parent missing");
		expect(() => planCategorySync(
			[
				{ _id: "a", title: "A", parentId: "b" },
				{ _id: "b", title: "B", parentId: "a" },
			],
			"selected",
			["a"],
		)).toThrow("cycle");
	});

	it("renders ancestors as structure only and filters unselected sibling links", () => {
		const plan = planCategorySync(categories, "selected", ["project"]);
		const fetchedWorkChildren = [
			{ _id: "knowledge", title: "Knowledge", type: "category", parentId: "work" },
			{ _id: "garden", title: "Garden", type: "project", parentId: "work" },
			{ _id: "task", title: "Repair fence", type: "task", parentId: "work" },
		];

		expect(categoryProjectionItems(
			"work",
			plan,
			fetchedWorkChildren,
			fetchedWorkChildren,
		).map((item) => item._id)).toEqual(["knowledge"]);

		const selectedChildren = [
			{ _id: "chapter", title: "Chapter one", type: "project", parentId: "project" },
			{ _id: "draft", title: "Draft outline", type: "task", parentId: "project" },
			{ _id: "excluded", title: "Excluded", type: "project", parentId: "project" },
		];
		expect(categoryProjectionItems(
			"project",
			plan,
			categories,
			selectedChildren,
		).map((item) => item._id)).toEqual(["chapter", "draft"]);
	});
});
