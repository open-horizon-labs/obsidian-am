#!/usr/bin/env node
// Loads a scrubbed fixture into a real, local CouchDB so integration tests
// exercise actual CouchDB behavior (pagination, _changes, compaction)
// instead of a hand-rolled fake.
//
// Start a local CouchDB first:
//   docker run -d --name marvin-fixture-couch -p 5984:5984 \
//     -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test couchdb:3
//
// Then:
//   node evaluations/issue-55/restore-fixture.mjs [fixture-path]

import fs from "node:fs/promises";
import path from "node:path";

const rawCouchUrl = process.env.COUCH_TEST_URL ?? "http://admin:test@localhost:5984";
const dbName = process.env.COUCH_TEST_DB ?? "marvin-fixture";
const fixturePath = process.argv[2]
	?? path.join(import.meta.dirname, "fixtures", "marvin-db-snapshot.json");

// Node's fetch (undici) rejects URLs with embedded credentials, so pull them
// out and send Basic auth explicitly instead.
const parsedCouchUrl = new URL(rawCouchUrl);
const authHeader = parsedCouchUrl.username
	? { Authorization: `Basic ${Buffer.from(`${parsedCouchUrl.username}:${parsedCouchUrl.password}`).toString("base64")}` }
	: {};
parsedCouchUrl.username = "";
parsedCouchUrl.password = "";
const couchUrl = parsedCouchUrl.toString().replace(/\/$/, "");

const docs = JSON.parse(await fs.readFile(fixturePath, "utf8"));

await fetch(`${couchUrl}/${dbName}`, { method: "PUT", headers: authHeader }).catch(() => {});

const response = await fetch(`${couchUrl}/${dbName}/_bulk_docs`, {
	method: "POST",
	headers: { "Content-Type": "application/json", ...authHeader },
	// Drop the fixture's original _rev: this is a fresh database, so CouchDB
	// must assign its own revision history rather than being handed one that
	// belongs to a document that was never inserted here.
	body: JSON.stringify({
		docs: docs.map(({ _rev, ...doc }) => doc),
	}),
});

if (!response.ok) {
	throw new Error(`_bulk_docs failed with HTTP ${response.status}: ${await response.text()}`);
}

console.log(`Restored ${docs.length} documents into ${couchUrl}/${dbName}`);
console.log("Now COUCH_TEST_URL=" + couchUrl + " points integration tests at real CouchDB behavior.");
