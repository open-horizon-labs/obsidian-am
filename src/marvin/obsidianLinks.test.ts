import { describe, expect, it } from "vitest";

import {
	buildObsidianUri,
	buildSourceActionTaskNote,
} from "./obsidianLinks";

describe("Obsidian source links", () => {
	it("builds the Advanced URI format requested by existing workflows", () => {
		expect(buildObsidianUri({
			vaultName: "My Vault",
			filePath: "Opportunities/Titan AI.md",
			format: "advanced-uri",
		})).toBe(
			"obsidian://adv-uri?vault=My%20Vault&filepath=Opportunities%2FTitan%20AI.md",
		);
	});

	it("retains an official Obsidian URI option", () => {
		expect(buildObsidianUri({
			vaultName: "My Vault",
			filePath: "Notes/Source.md",
			format: "standard",
		})).toBe(
			"obsidian://open?vault=My%20Vault&file=Notes%2FSource.md",
		);
	});

	it("embeds a stable source/action marker without replacing caller notes", () => {
		const note = buildSourceActionTaskNote({
			vaultName: "My Vault",
			sourcePath: "Opportunities/Titan AI.md",
			actionKey: "decide whether/to pursue",
			linkText: "Open source note",
			format: "advanced-uri",
			note: "Evidence captured by the automation.",
		});

		expect(note).toContain("Evidence captured by the automation.");
		expect(note).toContain("[Open source note](obsidian://adv-uri?");
		expect(note).toContain(
			"source=Opportunities%2FTitan%20AI.md action=decide%20whether%2Fto%20pursue",
		);
	});
});
