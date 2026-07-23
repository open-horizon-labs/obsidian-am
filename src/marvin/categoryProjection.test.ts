import { describe, expect, it } from "vitest";

import {
	CATEGORY_REGION_END,
	MANAGED_PROPERTIES_KEY,
	CategoryProjectionError,
	managedImportItemId,
	marvinFrontmatter,
	refreshCategoryRegion,
	repairLegacyMarvinFrontmatter,
	updateMarvinFrontmatter,
} from "./categoryProjection";

const rendered = [
	"# [⚓](https://app.amazingmarvin.com/#p=project-1) Project One",
	"",
	"## Tasks",
	"- [ ] [⚓](https://app.amazingmarvin.com/#t=task-2) Current task",
].join("\n");

describe("category/project managed regions", () => {
	it("adopts legacy generated content without overwriting surrounding prose", () => {
		const original = [
			"---",
			"_id: project-1",
			"type: project",
			"custom: keep me",
			"---",
			"Context before.",
			"",
			"# [⚓](https://app.amazingmarvin.com/#p=project-1) Old title",
			"",
			"Back to [[Parent]]",
			"",
			"## Tasks",
			"- [ ] [⚓](https://app.amazingmarvin.com/#t=old) Old task",
			"  - [ ] Old subtask",
			"",
			"Why and how notes remain here.",
		].join("\n");

		const result = refreshCategoryRegion(original, {
			itemId: "project-1",
			rendered,
			legacyKind: "category",
		});

		expect(result.content).toContain("Context before.");
		expect(result.content).toContain("Why and how notes remain here.");
		expect(result.content).not.toContain("Old task");
		expect(result.content).toContain("Current task");
		expect(result.content).toContain(CATEGORY_REGION_END);
	});

	it("does not adopt a user checklist separated from generated tasks", () => {
		const original = [
			"# [⚓](https://app.amazingmarvin.com/#p=project-1) Project",
			"## Tasks",
			"- [ ] [⚓](https://app.amazingmarvin.com/#t=old) Old task",
			"",
			"  - [ ] User-authored nested checklist",
		].join("\n");
		const result = refreshCategoryRegion(original, {
			itemId: "project-1",
			rendered,
			legacyKind: "category",
		});

		expect(result.content).toContain("User-authored nested checklist");
	});

	it("is idempotent and preserves CRLF outside an existing region", () => {
		const initial = refreshCategoryRegion("Before\r\nAfter\r\n", {
			itemId: "project-1",
			rendered,
			legacyKind: "category",
		});
		const repeated = refreshCategoryRegion(initial.content, {
			itemId: "project-1",
			rendered,
			legacyKind: "category",
		});

		expect(repeated.changed).toBe(false);
		expect(repeated.content).toBe(initial.content);
		expect(repeated.content).toContain("\r\n");
		expect(repeated.content).toContain("Before\r\nAfter\r\n");
	});

	it("adopts a legacy Inbox task section", () => {
		const result = refreshCategoryRegion([
			"## Tasks",
			"- [ ] [⚓](https://app.amazingmarvin.com/#t=old) Old inbox task",
			"",
			"Inbox notes.",
		].join("\n"), {
			itemId: "unassigned",
			rendered: [
				"## Tasks",
				"- [ ] [⚓](https://app.amazingmarvin.com/#t=new) New inbox task",
			].join("\n"),
			legacyKind: "inbox",
		});

		expect(result.content).toContain("New inbox task");
		expect(result.content).toContain("Inbox notes.");
		expect(result.content).not.toContain("Old inbox task");
	});

	it("does not mistake a user-owned task section for legacy import content", () => {
		const result = refreshCategoryRegion([
			"## Tasks",
			"- [ ] Write the project brief",
			"",
			"A helpful Marvin link follows in prose: https://app.amazingmarvin.com/#t=reference",
		].join("\n"), {
			itemId: "unassigned",
			rendered: "## Tasks\n- [ ] [⚓](https://app.amazingmarvin.com/#t=new) New inbox task",
			legacyKind: "inbox",
		});

		expect(result.content).toContain("Write the project brief");
		expect(result.content).toContain("#t=reference");
		expect(result.content).toContain("New inbox task");
	});

	it("refuses malformed or cross-item managed regions", () => {
		expect(() => refreshCategoryRegion(
			"<!-- obsidian-am:category no-json -->\nGenerated",
			{ itemId: "project-1", rendered, legacyKind: "category" },
		)).toThrow(CategoryProjectionError);

		const other = refreshCategoryRegion("", {
			itemId: "other",
			rendered: "Other",
			legacyKind: "category",
		});
		expect(() => refreshCategoryRegion(other.content, {
			itemId: "project-1",
			rendered,
			legacyKind: "category",
		})).toThrow("another item");
	});
});

describe("Marvin frontmatter migration", () => {
	it("repairs the legacy invalid list syntax without touching the note body", () => {
		const original = [
			"---",
			"_id: project-1",
			"",
			"labelIds: - label-a",
			"- label-b",
			"",
			"title: Project",
			"---",
			"Body remains byte-for-byte.",
		].join("\n");

		const repaired = repairLegacyMarvinFrontmatter(original);

		expect(repaired).toContain("labelIds:\n  - label-a\n  - label-b");
		expect(repaired).toContain("Body remains byte-for-byte.");
		expect(repairLegacyMarvinFrontmatter(repaired)).toBe(repaired);
	});

	it("updates owned fields as native values while preserving custom properties", () => {
		const frontmatter: Record<string, unknown> = {
			_id: "old",
			dueDate: "yesterday",
			custom: "keep",
			removedApiField: true,
			[MANAGED_PROPERTIES_KEY]: ["_id", "dueDate", "removedApiField"],
		};
		updateMarvinFrontmatter(frontmatter, {
			_id: "project-1",
			title: "Project",
			type: "project",
			labelIds: ["label-a", "label-b"],
		});

		expect(frontmatter).toMatchObject({
			_id: "project-1",
			title: "Project",
			type: "project",
			labelIds: ["label-a", "label-b"],
			custom: "keep",
		});
		expect(frontmatter).not.toHaveProperty("dueDate");
		expect(frontmatter).not.toHaveProperty("removedApiField");
		expect(frontmatter[MANAGED_PROPERTIES_KEY]).toContain("labelIds");
		expect(marvinFrontmatter({
			_id: "project-1",
			labelIds: ["label-a", "label-b"],
		})).toMatchObject({
			_id: "project-1",
			labelIds: ["label-a", "label-b"],
		});
	});

	it("finds owned IDs without claiming unrelated Marvin-linked notes", () => {
		expect(managedImportItemId("", {
			_id: "cached",
			deepLink: "https://app.amazingmarvin.com/#p=cached",
			[MANAGED_PROPERTIES_KEY]: ["_id", "deepLink"],
		}, "Elsewhere.md")).toBe("cached");
		expect(managedImportItemId("", {
			_id: "personal",
			deepLink: "https://app.amazingmarvin.com/#p=personal",
		}, "Elsewhere.md")).toBeUndefined();
		expect(managedImportItemId([
			"---",
			"_id: personal",
			"deepLink: https://app.amazingmarvin.com/#p=personal",
			"---",
			"Personal notes without an imported heading.",
		].join("\n"), {
			_id: "personal",
			deepLink: "https://app.amazingmarvin.com/#p=personal",
		}, "AmazingMarvin/Personal.md", true)).toBeUndefined();
		expect(managedImportItemId("", {
			_id: "project-1",
			deepLink: "https://app.amazingmarvin.com/#p=project-10",
			[MANAGED_PROPERTIES_KEY]: ["_id", "deepLink"],
		}, "Elsewhere.md")).toBeUndefined();

		const marked = refreshCategoryRegion("", {
			itemId: "marked",
			rendered,
			legacyKind: "category",
		});
		expect(managedImportItemId(marked.content, undefined, "Moved.md")).toBe("marked");

		expect(managedImportItemId([
			"---",
			"_id: legacy",
			"labelIds: - broken",
			"deepLink: https://app.amazingmarvin.com/#p=legacy",
			"---",
			"# [⚓](https://app.amazingmarvin.com/#p=legacy) Legacy project",
		].join("\n"), undefined, "Legacy.md", true)).toBe("legacy");

		expect(managedImportItemId([
			"## Tasks",
			"- [ ] [⚓](https://app.amazingmarvin.com/#t=task) Task",
		].join("\n"), undefined, "AmazingMarvin/Inbox.md", true)).toBe("unassigned");
	});
});
