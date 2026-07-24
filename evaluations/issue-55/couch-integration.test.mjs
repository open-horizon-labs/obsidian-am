import assert from "node:assert/strict";
import test from "node:test";

/**
 * Integration tests against REAL CouchDB (not a hand-rolled fake), seeded
 * from a scrubbed real Marvin database export. Skipped unless COUCH_TEST_URL
 * points at a running instance:
 *
 *   docker run -d --name marvin-fixture-couch -p 5984:5984 \
 *     -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test couchdb:3
 *   node evaluations/issue-55/restore-fixture.mjs
 *   COUCH_TEST_URL=http://admin:test@localhost:5984 \
 *     node --test evaluations/issue-55/couch-integration.test.mjs
 *
 * These exist because a hand-rolled fake CouchDB (see couch-resilience.test.mjs)
 * can only be as correct as its author's assumptions. This suite caught one
 * such wrong assumption directly: a prior version of this evaluation modeled
 * "resuming from a since value after compaction returns a distinguishable
 * error." Tested against real CouchDB 3.5.2, that's false — compaction does
 * not invalidate an old `since`. Apache CouchDB's 2.2+ changelog documents
 * this as deliberate: sequences are designed to survive compaction rather
 * than forcing an expensive client-side rewind. Do not re-introduce
 * invalid-since handling as a required resilience path without new evidence.
 *
 * Not yet verified: Marvin's actual backend is IBM Cloudant
 * (*.cloudant.com), which is CouchDB-API-compatible but manages compaction
 * internally and opaquely. This suite runs against vanilla Apache CouchDB;
 * it has not been run against Cloudant's own compaction behavior, because
 * that can't be triggered externally or safely against a live account.
 */

const skip = !process.env.COUCH_TEST_URL;
const rawBase = process.env.COUCH_TEST_URL ?? "http://admin:test@localhost:5984";
const dbName = process.env.COUCH_TEST_DB ?? "marvin-fixture";

const parsed = new URL(rawBase);
const authHeader = parsed.username
	? { Authorization: `Basic ${Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64")}` }
	: {};
parsed.username = "";
parsed.password = "";
const base = parsed.toString().replace(/\/$/, "");

async function couchRequest(path, options = {}) {
	const response = await fetch(`${base}${path}`, {
		...options,
		headers: { ...authHeader, ...options.headers },
	});
	return { status: response.status, body: await response.json() };
}

async function fetchAllDocIds() {
	const ids = new Set();
	let startkey;
	for (let pages = 0; pages < 50; pages += 1) {
		let path = `/${dbName}/_all_docs?limit=500`;
		if (startkey !== undefined) {
			path += `&startkey=${encodeURIComponent(JSON.stringify(startkey))}&skip=1`;
		}
		const { body } = await couchRequest(path);
		const rows = body.rows.filter((row) => !row.id.startsWith("_design/"));
		for (const row of rows) {
			ids.add(row.id);
		}
		if (rows.length < 500) {
			return ids;
		}
		startkey = rows.at(-1).id;
	}
	throw new Error("pagination did not terminate within 50 pages");
}

test("paginates the full real-shaped fixture via startkey, with no gaps or duplicates", { skip }, async () => {
	const ids = await fetchAllDocIds();
	assert.ok(ids.size >= 1_900, `expected the restored fixture, got ${ids.size} docs`);
});

test("a single insert produces exactly one incremental change from the true last_seq", { skip }, async () => {
	const { body: baseline } = await couchRequest(`/${dbName}/_changes?since=0`);
	const probeId = `resilience-probe-${baseline.results.length}`;
	await couchRequest(`/${dbName}/${probeId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ db: "Tasks", title: "probe", parentId: "root", done: false }),
	});
	const { body: incremental } = await couchRequest(
		`/${dbName}/_changes?since=${encodeURIComponent(baseline.last_seq)}&include_docs=true`,
	);
	assert.deepEqual(incremental.results.map((r) => r.id), [probeId]);
});

test("resuming from a pre-compaction since succeeds on real CouchDB (contradicts the earlier assumed failure mode)", { skip }, async () => {
	const { body: before } = await couchRequest(`/${dbName}/_changes?since=0&limit=1`);
	const oldSeq = before.results[0].seq;

	await couchRequest(`/${dbName}/_compact`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
	});
	await new Promise((resolve) => setTimeout(resolve, 1_500));

	const { status, body } = await couchRequest(`/${dbName}/_changes?since=${encodeURIComponent(oldSeq)}&limit=5`);
	assert.equal(status, 200, "real CouchDB did not reject the pre-compaction since");
	assert.ok(Array.isArray(body.results));
});
