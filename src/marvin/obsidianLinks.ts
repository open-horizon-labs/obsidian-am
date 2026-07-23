export type ObsidianLinkFormat = "advanced-uri" | "standard";

export interface ObsidianSourceLink {
	vaultName: string;
	filePath: string;
	format: ObsidianLinkFormat;
}

export function buildObsidianUri(options: ObsidianSourceLink): string {
	const vault = encodeURIComponent(options.vaultName);
	const filePath = encodeURIComponent(options.filePath);
	return options.format === "advanced-uri"
		? `obsidian://adv-uri?vault=${vault}&filepath=${filePath}`
		: `obsidian://open?vault=${vault}&file=${filePath}`;
}

export function buildSourceActionTaskNote(options: {
	vaultName: string;
	sourcePath: string;
	actionKey: string;
	linkText: string;
	format: ObsidianLinkFormat;
	note?: string;
}): string {
	const uri = buildObsidianUri({
		vaultName: options.vaultName,
		filePath: options.sourcePath,
		format: options.format,
	});
	const link = options.linkText
		? `[${escapeMarkdownLabel(options.linkText)}](${uri})`
		: uri;
	const marker = [
		"<!-- obsidian-am:source-action",
		"version=1",
		`source=${encodeURIComponent(options.sourcePath)}`,
		`action=${encodeURIComponent(options.actionKey)}`,
		"-->",
	].join(" ");
	return [options.note?.trim(), link, marker].filter(Boolean).join("\n\n");
}

function escapeMarkdownLabel(value: string): string {
	return value
		.replace(/[\r\n]+/g, " ")
		.replace(/\\/g, "\\\\")
		.replace(/\]/g, "\\]")
		.trim();
}
