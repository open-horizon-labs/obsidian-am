#!/usr/bin/env node
// Turns a raw capture-real-couch.mjs dump into a fixture that's safe to
// commit: structure, field presence, and doc relationships are preserved;
// free-text content (titles, notes) is replaced with synthetic placeholders.
//
// Usage:
//   node evaluations/issue-55/scrub-fixture.mjs <raw-dump.json> [out-fixture.json]
//
// Always spot-check the output before committing it. This is a best-effort
// scrub, not a guarantee — read a sample of the result yourself.

import fs from "node:fs/promises";
import path from "node:path";

const inPath = process.argv[2];
const outPath = process.argv[3]
	?? path.join(import.meta.dirname, "fixtures", "marvin-db-snapshot.json");

if (!inPath) {
	console.error("Usage: node scrub-fixture.mjs <raw-dump.json> [out-fixture.json]");
	process.exit(1);
}

// Structural fields worth keeping for realistic integration tests. No free
// text (title, note, and anything not explicitly listed) survives.
const KEEP_FIELDS = new Set([
	"_id", "_rev", "db", "type", "parentId", "done", "doneDate", "doneAt",
	"completedAt", "createdAt", "updatedAt", "day", "firstScheduled",
	"startDate", "dueDate", "endDate", "deletedAt", "restoredAt", "labelIds",
	"timeEstimate", "priority", "rank", "recurring", "isRecurring",
	"subtasks", "fieldUpdates",
]);

function scrubDoc(doc, index) {
	const scrubbed = {};
	for (const key of Object.keys(doc)) {
		if (KEEP_FIELDS.has(key)) {
			scrubbed[key] = doc[key];
		}
	}
	if (typeof doc.title === "string") {
		scrubbed.title = `Fixture item ${index}`;
	}
	if (typeof doc.note === "string" && doc.note.length > 0) {
		scrubbed.note = "fixture note";
	}
	return scrubbed;
}

const raw = JSON.parse(await fs.readFile(inPath, "utf8"));
const scrubbed = raw.map((doc, index) => scrubDoc(doc, index));

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(scrubbed, null, 2));

console.log(`Scrubbed ${scrubbed.length} documents -> ${outPath}`);
console.log("Read a sample of this file yourself before it goes anywhere near git.");
console.log("Kept fields:", [...KEEP_FIELDS].join(", "));
