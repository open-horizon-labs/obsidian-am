import { describe, expect, it } from "vitest";

import {
	buildTargetedPlan,
	categoryProjectionItems,
	planCategorySync,
	targetedContainerIds,
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

describe("targeted incremental reconciliation", () => {
	it("includes structural ancestors of a selected root, excludes unselected siblings", () => {
		const plan = planCategorySync(categories, "selected", ["project"]);

		// "work"/"knowledge" are structural ancestors of the selected root
		// ("project") — they get a navigation-only note, so an incremental
		// change to them is legitimately in scope. "garden" is an unselected
		// sibling and must stay excluded, same as the REST importer already
		// enforces (see categoryProjectionItems's own ancestor test above).
		const targeted = targetedContainerIds(
			["chapter", "work", "knowledge", "garden", "does-not-exist"],
			plan,
		);

		expect(targeted).toEqual(new Set(["chapter", "work", "knowledge"]));
	});

	it("targets everything affected when the user has selected all categories", () => {
		const plan = planCategorySync(categories, "all", []);
		const targeted = targetedContainerIds(["work", "chapter", "garden"], plan);
		expect(targeted).toEqual(new Set(["work", "chapter", "garden"]));
	});

	it("excludes an unselected sibling even when it's the only thing that changed", () => {
		const plan = planCategorySync(categories, "selected", ["project"]);
		expect(targetedContainerIds(["garden"], plan)).toEqual(new Set());
	});
});

describe("buildTargetedPlan", () => {
	it("keeps a targeted structural ancestor structure-only, not full content", () => {
		const fullPlan = planCategorySync(categories, "selected", ["project"]);
		// "work" is a structural ancestor of the selected root ("project"),
		// not a real content id — a targeted refresh must preserve that.
		const targeted = buildTargetedPlan(new Set(["work", "chapter"]), fullPlan);

		expect(targeted.contentIds.has("work")).toBe(false);
		expect(targeted.contentIds.has("chapter")).toBe(true);
		expect(targeted.structuralIds.has("work")).toBe(true);
		expect(targeted.includedIds).toEqual(new Set(["work", "chapter"]));
	});

	it("matches the full plan's content/structural split for a full refresh", () => {
		const fullPlan = planCategorySync(categories, "selected", ["project"]);
		const targeted = buildTargetedPlan(fullPlan.includedIds, fullPlan);

		expect(targeted.contentIds).toEqual(fullPlan.contentIds);
		expect(targeted.structuralIds).toEqual(fullPlan.structuralIds);
	});
});
