#!/usr/bin/env node
// Fails when manifest.json and manifest-beta.json disagree on anything other
// than the version they're releasing.
//
// This exists because they already drifted once and shipped: a commit updating
// the author to Open Horizon Labs touched manifest.json only, and since the
// beta release workflow copies manifest-beta.json over dist/manifest.json,
// every beta went out crediting the previous org while stable was correct. The
// two files duplicate identity by hand, so nothing but a check keeps them
// honest.
//
// `id` is compared like any other field, but it is not a field to "fix" if it
// ever looks stale: it is the plugin's folder name under .obsidian/plugins/,
// so changing it orphans existing installs along with their settings and
// cache, and it is the documented handle other plugins use to reach this one
// (app.plugins.plugins["<id>"].api).

import { readFile } from "node:fs/promises";

const SHARED_FIELDS = [
	"id",
	"name",
	"description",
	"author",
	"authorUrl",
	"isDesktopOnly",
	"fundingUrl",
];

// Only these may differ, since a beta is by definition a different version and
// may require a newer Obsidian than the current stable does.
const RELEASE_SPECIFIC_FIELDS = ["version", "minAppVersion"];

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

const stable = await readJson("manifest.json");
const beta = await readJson("manifest-beta.json");

const problems = [];

for (const field of SHARED_FIELDS) {
	const a = stable[field];
	const b = beta[field];
	if (JSON.stringify(a) !== JSON.stringify(b)) {
		problems.push(
			`${field}: manifest.json has ${JSON.stringify(a)}, `
			+ `manifest-beta.json has ${JSON.stringify(b)}`,
		);
	}
}

// A field present in one file and absent from the other is drift too, and
// would otherwise slip through the loop above whenever both read undefined.
const unexpected = [...new Set([...Object.keys(stable), ...Object.keys(beta)])]
	.filter((key) => !SHARED_FIELDS.includes(key) && !RELEASE_SPECIFIC_FIELDS.includes(key));
for (const field of unexpected) {
	problems.push(
		`${field}: not covered by this check — add it to SHARED_FIELDS or `
		+ "RELEASE_SPECIFIC_FIELDS in scripts/check-manifests.mjs",
	);
}

if (problems.length > 0) {
	console.error("manifest.json and manifest-beta.json disagree:\n");
	for (const problem of problems) {
		console.error(`  - ${problem}`);
	}
	console.error(
		"\nEverything except version and minAppVersion must match, or betas "
		+ "ship different metadata than stable.",
	);
	process.exit(1);
}

console.log(
	`Manifests agree on ${SHARED_FIELDS.length} shared fields `
	+ `(stable ${stable.version}, beta ${beta.version}).`,
);
