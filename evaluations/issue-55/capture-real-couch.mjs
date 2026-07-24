#!/usr/bin/env node
// One-time, manual capture of a real Marvin CouchDB database for local fixture
// generation.
//
// Fill in evaluations/issue-55/.env.marvin-db (gitignored, never commit it)
// with MARVIN_DB_URI / MARVIN_DB_USER / MARVIN_DB_PASSWORD, then run:
//
//   node evaluations/issue-55/capture-real-couch.mjs [output-path]
//
// This script reads that file directly; the values in it are never printed,
// logged, or written anywhere except into the raw dump this produces.
//
// Output is a raw, UNSCRUBBED dump containing real personal task data and
// real CouchDB revision metadata. It is written outside the repo by default.
// Do not commit it. Run scrub-fixture.mjs on it before it goes anywhere near
// version control.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function loadEnvFile(envPath) {
	const values = {};
	let contents;
	try {
		contents = await fs.readFile(envPath, "utf8");
	} catch {
		return values;
	}
	for (const line of contents.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}
		const separatorIndex = trimmed.indexOf("=");
		if (separatorIndex === -1) {
			continue;
		}
		const key = trimmed.slice(0, separatorIndex).trim();
		const value = trimmed.slice(separatorIndex + 1).trim();
		values[key] = value;
	}
	return values;
}

const envPath = path.join(import.meta.dirname, ".env.marvin-db");
const fileValues = await loadEnvFile(envPath);

const uri = process.env.MARVIN_DB_URI || fileValues.MARVIN_DB_URI;
const user = process.env.MARVIN_DB_USER || fileValues.MARVIN_DB_USER;
const password = process.env.MARVIN_DB_PASSWORD || fileValues.MARVIN_DB_PASSWORD;

if (!uri || !user || !password) {
	console.error(
		`Fill in ${envPath} with MARVIN_DB_URI, MARVIN_DB_USER, and `
		+ "MARVIN_DB_PASSWORD (one per line, KEY=value), then run this again. "
		+ "That file is gitignored — do not paste its values anywhere else.",
	);
	process.exit(1);
}

const outPath = process.argv[2]
	?? path.join(os.tmpdir(), "marvin-real-dump.raw.json");

const base = new URL(uri.trim());
const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

async function fetchAllDocsPage(startkey) {
	const url = new URL(
		`${base.pathname.replace(/\/+$/, "")}/_all_docs`,
		base,
	);
	url.searchParams.set("include_docs", "true");
	url.searchParams.set("limit", "500");
	if (startkey !== undefined) {
		// CouchDB's own pagination recipe: re-request the boundary row and
		// skip exactly one, rather than deep-skip pagination (which the
		// CouchDB docs describe as an unnecessarily expensive full scan).
		url.searchParams.set("startkey", JSON.stringify(startkey));
		url.searchParams.set("skip", "1");
	}
	const response = await fetch(url, {
		headers: { Accept: "application/json", Authorization: auth },
	});
	if (!response.ok) {
		throw new Error(
			`_all_docs failed with HTTP ${response.status}: ${await response.text()}`,
		);
	}
	return response.json();
}

async function fetchAllDocs() {
	const docs = [];
	let startkey;
	for (;;) {
		const page = await fetchAllDocsPage(startkey);
		const rows = page.rows.filter((row) => !row.id.startsWith("_design/"));
		docs.push(...rows.map((row) => row.doc).filter(Boolean));
		if (rows.length < 500) {
			break;
		}
		startkey = rows.at(-1).id;
	}
	return docs;
}

const docs = await fetchAllDocs();
await fs.writeFile(outPath, JSON.stringify(docs, null, 2));
console.log(`Wrote ${docs.length} real documents to ${outPath}`);
console.log("This file contains REAL personal task data and REAL CouchDB revision metadata.");
console.log("Next step: node evaluations/issue-55/scrub-fixture.mjs " + outPath);
