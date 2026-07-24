#!/usr/bin/env node
// Builds a labeled corpus of REAL `_changes` records — real seq/rev formats,
// real deleted-doc semantics — by performing known operations against a
// real local CouchDB and capturing exactly what each one produces.
//
// Unlike the fixture snapshot, nothing here needs scrubbing: we author the
// document content ourselves, so there's no personal data in it. Only the
// *shape* comes from real CouchDB, which is the part worth not inventing.
//
// Prerequisite: a running local CouchDB with the restored fixture, per
// restore-fixture.mjs's instructions.
//
// Usage:
//   COUCH_TEST_URL=http://admin:test@localhost:5984 \
//     node evaluations/issue-55/synthesize-changes.mjs

import fs from "node:fs/promises";
import path from "node:path";

const rawBase = process.env.COUCH_TEST_URL ?? "http://admin:test@localhost:5984";
const dbName = process.env.COUCH_TEST_DB ?? "marvin-fixture";

const parsed = new URL(rawBase);
const authHeader = parsed.username
	? { Authorization: `Basic ${Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64")}` }
	: {};
parsed.username = "";
parsed.password = "";
const base = parsed.toString().replace(/\/$/, "");

async function couch(pathAndQuery, options = {}) {
	const response = await fetch(`${base}${pathAndQuery}`, {
		...options,
		headers: { "Content-Type": "application/json", ...authHeader, ...options.headers },
	});
	const body = await response.json();
	if (!response.ok && response.status !== 404) {
		throw new Error(`${pathAndQuery} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
	}
	return { status: response.status, body };
}

async function currentLastSeq() {
	const { body } = await couch(`/${dbName}/_changes?since=0`);
	return body.last_seq;
}

/** Runs one operation, then captures exactly the _changes entry it produced. */
async function capture(label, operation) {
	const before = await currentLastSeq();
	await operation();
	const { body } = await couch(
		`/${dbName}/_changes?since=${encodeURIComponent(before)}&include_docs=true`,
	);
	if (body.results.length !== 1) {
		throw new Error(`${label}: expected exactly 1 change, got ${body.results.length}`);
	}
	return { label, record: body.results[0] };
}

async function main() {
	const examples = [];

	examples.push(await capture("create-task", async () => {
		await couch(`/${dbName}/synth-task-1`, {
			method: "PUT",
			body: JSON.stringify({ db: "Tasks", title: "Synthetic task", parentId: "root", done: false }),
		});
	}));

	examples.push(await capture("rename-task", async () => {
		const { body: doc } = await couch(`/${dbName}/synth-task-1`);
		await couch(`/${dbName}/synth-task-1`, {
			method: "PUT",
			body: JSON.stringify({ ...doc, title: "Synthetic task (renamed)" }),
		});
	}));

	examples.push(await capture("complete-task", async () => {
		const { body: doc } = await couch(`/${dbName}/synth-task-1`);
		await couch(`/${dbName}/synth-task-1`, {
			method: "PUT",
			body: JSON.stringify({ ...doc, done: true, doneAt: 1 }),
		});
	}));

	examples.push(await capture("create-category", async () => {
		await couch(`/${dbName}/synth-category-1`, {
			method: "PUT",
			body: JSON.stringify({ db: "Categories", type: "category", title: "Synthetic category", parentId: "root" }),
		});
	}));

	examples.push(await capture("move-task", async () => {
		const { body: doc } = await couch(`/${dbName}/synth-task-1`);
		await couch(`/${dbName}/synth-task-1`, {
			method: "PUT",
			body: JSON.stringify({ ...doc, parentId: "synth-category-1" }),
		});
	}));

	examples.push(await capture("delete-task", async () => {
		const { body: doc } = await couch(`/${dbName}/synth-task-1`);
		await couch(`/${dbName}/synth-task-1?rev=${doc._rev}`, { method: "DELETE" });
	}));

	examples.push(await capture("delete-category", async () => {
		const { body: doc } = await couch(`/${dbName}/synth-category-1`);
		await couch(`/${dbName}/synth-category-1?rev=${doc._rev}`, { method: "DELETE" });
	}));

	const outPath = path.join(import.meta.dirname, "fixtures", "changes-examples.json");
	await fs.writeFile(outPath, JSON.stringify(examples, null, 2));
	console.log(`Wrote ${examples.length} labeled, real _changes records -> ${outPath}`);
	for (const { label, record } of examples) {
		console.log(`  ${label}: deleted=${Boolean(record.deleted)} doc.done=${record.doc?.done} doc.parentId=${record.doc?.parentId}`);
	}
}

main().catch((error) => {
	console.error("ERROR", error.message);
	process.exit(1);
});
