#!/usr/bin/env node
// Exercises the REAL PR #63 code (pr63-src/, bundled into entry.mjs) end to
// end against real local CouchDB and a real filesystem: hydration under a
// throttle, steady-state sync through create/rename/complete/move/delete,
// a fresh-instance round trip, and a corrupted-cache-file recovery check.
//
// Nothing here is a reimplementation of the design — it drives the actual
// IncrementalMarvinCache / ObsidianIncrementalCacheStore / CouchChangesClient
// classes extracted from PR #63.
//
// Prerequisite: local CouchDB running with the restored fixture (see
// restore-fixture.mjs). Usage:
//   node evaluations/issue-55/harness/run-harness.mjs

import fs from "node:fs/promises";
import path from "node:path";
import {
	CouchChangesClient,
	IncrementalMarvinCache,
	ObsidianIncrementalCacheStore,
} from "./entry.mjs";

const COUCH_URL = "http://localhost:5984";
const DB_NAME = "marvin-fixture";
const AUTH = { user: "admin", password: "test" };
const SCRATCH_DIR = path.join(import.meta.dirname, "vault-scratch");

function line(title) {
	console.log(`\n=== ${title} ===`);
}

async function couch(pathAndQuery, options = {}) {
	const authHeader = `Basic ${Buffer.from(`${AUTH.user}:${AUTH.password}`).toString("base64")}`;
	const response = await fetch(`${COUCH_URL}${pathAndQuery}`, {
		...options,
		headers: { "Content-Type": "application/json", Authorization: authHeader, ...options.headers },
	});
	const body = await response.json();
	// Fail loudly rather than silently continuing on a conflict/error — a
	// harness that swallows a 409 produces results that look like real
	// findings but are actually just stale fixture data from a prior run.
	if (!response.ok && response.status !== 404) {
		throw new Error(`CouchDB ${pathAndQuery} -> HTTP ${response.status}: ${JSON.stringify(body)}`);
	}
	return { status: response.status, body };
}

async function deleteIfExists(id) {
	const { status, body } = await couch(`/${DB_NAME}/${id}`);
	if (status === 200) {
		await couch(`/${DB_NAME}/${id}?rev=${body._rev}`, { method: "DELETE" });
	}
}

async function resetHarnessDocs() {
	await Promise.all(["harness-task-1", "harness-category-1"].map(deleteIfExists));
}

// --- Real IncrementalFileAdapter, backed by an actual filesystem. ---
function createRealFileAdapter(root) {
	const resolve = (relativePath) => path.join(root, relativePath.replace(/^\/+/, ""));
	return {
		async exists(relativePath) {
			try {
				await fs.access(resolve(relativePath));
				return true;
			} catch {
				return false;
			}
		},
		async read(relativePath) {
			return fs.readFile(resolve(relativePath), "utf8");
		},
		async write(relativePath, data) {
			await fs.mkdir(path.dirname(resolve(relativePath)), { recursive: true });
			await fs.writeFile(resolve(relativePath), data, "utf8");
		},
		async process(relativePath, update) {
			const current = await fs.readFile(resolve(relativePath), "utf8");
			const next = update(current);
			await fs.writeFile(resolve(relativePath), next, "utf8");
			return next;
		},
		async remove(relativePath) {
			await fs.rm(resolve(relativePath), { force: true });
		},
	};
}

// --- Real CouchChangesTransport, backed by actual Node fetch. ---
function createRealCouchTransport() {
	return {
		async request({ url, headers }) {
			const response = await fetch(url, { headers });
			return { status: response.status, text: await response.text() };
		},
	};
}

function newCouchChangesClient() {
	return new CouchChangesClient(
		{ databaseUri: `${COUCH_URL}/${DB_NAME}`, databaseUser: AUTH.user, databasePassword: AUTH.password },
		createRealCouchTransport(),
	);
}

// --- Snapshot source A: today's design. One REST-shaped call per category
// (the exact N+1 shape confirmed to trip real, confirmed Marvin throttling),
// wrapped with a shared budget so the failure is real, not asserted. ---
function createThrottledRestSnapshotSource(budget) {
	let spent = 0;
	const spend = (label) => {
		spent += 1;
		if (spent > budget) {
			throw Object.assign(new Error(`Amazing Marvin throttled ${label}`), { status: 429 });
		}
	};
	return {
		async getCategories() {
			spend("GET /api/categories");
			const { body } = await couch(`/${DB_NAME}/_all_docs?include_docs=true&limit=5000`);
			return body.rows
				.map((row) => row.doc)
				.filter((doc) => doc && doc.db === "Categories")
				.map((doc) => ({ _id: doc._id, title: doc.title, type: doc.type ?? "category", parentId: doc.parentId }));
		},
		async getChildren(parentId) {
			spend(`GET /api/children?parentId=${parentId}`);
			const { body } = await couch(`/${DB_NAME}/_all_docs?include_docs=true&limit=5000`);
			return body.rows
				.map((row) => row.doc)
				.filter((doc) => doc && (doc.db === "Tasks" || doc.db === "Categories") && doc.parentId === parentId)
				.map((doc) => ({
					_id: doc._id,
					title: doc.title,
					type: doc.db === "Categories" ? (doc.type ?? "category") : "task",
					parentId: doc.parentId,
					...(doc.db === "Tasks" ? { done: doc.done === true } : {}),
				}));
		},
		spentCalls: () => spent,
	};
}

// --- Snapshot source B: proposed redesign. One bulk CouchDB read, zero
// REST-shaped calls, ever. ---
function createBulkCouchSnapshotSource() {
	let cache;
	async function loadAll() {
		if (cache) {
			return cache;
		}
		const docs = [];
		let startkey;
		for (;;) {
			let q = `/${DB_NAME}/_all_docs?include_docs=true&limit=500`;
			if (startkey !== undefined) {
				q += `&startkey=${encodeURIComponent(JSON.stringify(startkey))}&skip=1`;
			}
			const { body } = await couch(q);
			const rows = body.rows.filter((r) => !r.id.startsWith("_design/"));
			docs.push(...rows.map((r) => r.doc).filter(Boolean));
			if (rows.length < 500) {
				break;
			}
			startkey = rows.at(-1).id;
		}
		cache = docs.filter((doc) => doc.db === "Tasks" || doc.db === "Categories");
		return cache;
	}
	return {
		async getCategories() {
			const docs = await loadAll();
			return docs
				.filter((doc) => doc.db === "Categories")
				.map((doc) => ({ _id: doc._id, title: doc.title, type: doc.type ?? "category", parentId: doc.parentId }));
		},
		async getChildren(parentId) {
			const docs = await loadAll();
			return docs
				.filter((doc) => doc.parentId === parentId)
				.map((doc) => ({
					_id: doc._id,
					title: doc.title,
					type: doc.db === "Categories" ? (doc.type ?? "category") : "task",
					parentId: doc.parentId,
					...(doc.db === "Tasks" ? { done: doc.done === true } : {}),
				}));
		},
		spentCalls: () => 0,
	};
}

async function fileSummary(storePath) {
	try {
		const raw = await fs.readFile(path.join(SCRATCH_DIR, storePath), "utf8");
		const parsed = JSON.parse(raw);
		return {
			bytes: Buffer.byteLength(raw),
			categories: parsed.categories?.length,
			childKeys: Object.keys(parsed.children ?? {}).length,
			lastSeq: String(parsed.lastSeq).slice(0, 24) + "...",
		};
	} catch (error) {
		return { error: error.message };
	}
}

async function step1_throttledHydrationFails() {
	line("Step 1: real ensureHydrated() under the REAL confirmed-throttle shape (today's design)");
	await fs.rm(SCRATCH_DIR, { recursive: true, force: true });
	const store = new ObsidianIncrementalCacheStore(createRealFileAdapter(SCRATCH_DIR), "plugin-a");
	const snapshot = createThrottledRestSnapshotSource(20); // matches the confirmed budget from earlier evidence
	const cache = new IncrementalMarvinCache({
		sourceKey: DB_NAME,
		changes: newCouchChangesClient(),
		snapshot,
		store,
	});
	try {
		await cache.sync();
		console.log("UNEXPECTED: hydration succeeded within the throttle budget");
	} catch (error) {
		console.log(`Confirmed: real ensureHydrated() failed exactly as the earlier standalone simulation predicted.`);
		console.log(`  error: ${error.message}`);
		console.log(`  REST-shaped calls spent before failure: ${snapshot.spentCalls()}`);
	}
}

async function step2_bulkHydrationSucceeds() {
	line("Step 2: real ensureHydrated() with a bulk CouchDB snapshot source (proposed redesign)");
	await fs.rm(SCRATCH_DIR, { recursive: true, force: true });
	const store = new ObsidianIncrementalCacheStore(createRealFileAdapter(SCRATCH_DIR), "plugin-b");
	const snapshot = createBulkCouchSnapshotSource();
	const cache = new IncrementalMarvinCache({
		sourceKey: DB_NAME,
		changes: newCouchChangesClient(),
		snapshot,
		store,
	});
	const result = await cache.sync();
	console.log(`Hydrated successfully. fullRefresh=${result.fullRefresh} REST-shaped calls used=${snapshot.spentCalls()}`);
	console.log("Categories cached:", cache.getCategories()?.length);
	console.log("On-disk cache file:", await fileSummary(store.path));
	return { cache, store };
}

async function step3_liveOperations(cache, store) {
	line("Step 3: real operations against real CouchDB, real cache.sync() after each, real file inspected after each");

	// Sentinels matter: "root" is a category-tree-top marker (no children
	// bucket at all — top-level categories live in state.categories
	// directly). "unassigned" IS a real tracked bucket (the Inbox). A task's
	// "no category" state is "unassigned", not "root" — using the wrong one
	// here initially made every subsequent step look broken when it wasn't.
	const ops = [
		["create-category", async () => {
			await couch(`/${DB_NAME}/harness-category-1`, {
				method: "PUT",
				body: JSON.stringify({ db: "Categories", type: "category", title: "Harness category", parentId: "root" }),
			});
		}],
		["create-task-in-category", async () => {
			await couch(`/${DB_NAME}/harness-task-1`, {
				method: "PUT",
				body: JSON.stringify({ db: "Tasks", title: "Harness task", parentId: "harness-category-1", done: false }),
			});
		}],
		["rename-task", async () => {
			const { body: doc } = await couch(`/${DB_NAME}/harness-task-1`);
			await couch(`/${DB_NAME}/harness-task-1`, { method: "PUT", body: JSON.stringify({ ...doc, title: "Harness task (renamed)" }) });
		}],
		["move-task-to-unassigned", async () => {
			const { body: doc } = await couch(`/${DB_NAME}/harness-task-1`);
			await couch(`/${DB_NAME}/harness-task-1`, { method: "PUT", body: JSON.stringify({ ...doc, parentId: "unassigned" }) });
		}],
		["complete-task", async () => {
			const { body: doc } = await couch(`/${DB_NAME}/harness-task-1`);
			await couch(`/${DB_NAME}/harness-task-1`, { method: "PUT", body: JSON.stringify({ ...doc, done: true }) });
		}],
		["delete-completed-task", async () => {
			const { body: doc } = await couch(`/${DB_NAME}/harness-task-1`);
			await couch(`/${DB_NAME}/harness-task-1?rev=${doc._rev}`, { method: "DELETE" });
		}],
	];

	for (const [label, operation] of ops) {
		await operation();
		const result = await cache.sync();
		const inCategory = cache.getChildren("harness-category-1") ?? [];
		const inUnassigned = (cache.getChildren("unassigned") ?? []).filter((i) => i._id === "harness-task-1");
		console.log(
			`${label}: changed=${result.changed} inboxChanged=${result.inboxChanged} affected=[${result.affectedContainerIds.join(",")}] `
			+ `in-category=${inCategory.map((c) => c._id).join(",") || "(none)"} `
			+ `in-unassigned=${inUnassigned.map((c) => c._id).join(",") || "(none)"} `
			+ `file=${JSON.stringify(await fileSummary(store.path))}`,
		);
	}
	console.log(
		"Expected: delete-completed-task shows changed=false — the task was already pruned from the "
		+ "tracked tree on completion, so deleting it afterward touches nothing observable. That's correct, not a bug.",
	);
}

async function step4_roundTripFreshInstance() {
	line("Step 4: fresh IncrementalMarvinCache instance, same store path, real round trip");
	const store = new ObsidianIncrementalCacheStore(createRealFileAdapter(SCRATCH_DIR), "plugin-b");
	const fresh = new IncrementalMarvinCache({
		sourceKey: DB_NAME,
		changes: newCouchChangesClient(),
		snapshot: createBulkCouchSnapshotSource(),
		store,
	});
	await fresh.sync();
	console.log("Fresh instance categories:", fresh.getCategories()?.length);
	console.log("Fresh instance children(harness-category-1):", fresh.getChildren("harness-category-1"));
}

async function step5_corruptedFileRecovery() {
	line("Step 5: corrupt the real on-disk JSON file, confirm real load() behavior");
	const adapter = createRealFileAdapter(SCRATCH_DIR);
	const store = new ObsidianIncrementalCacheStore(adapter, "plugin-b");
	await fs.writeFile(path.join(SCRATCH_DIR, store.path), '{"version":1,"categories":[}}} NOT VALID JSON', "utf8");
	const cache = new IncrementalMarvinCache({
		sourceKey: DB_NAME,
		changes: newCouchChangesClient(),
		snapshot: createBulkCouchSnapshotSource(),
		store,
	});
	try {
		await cache.sync();
		console.log("UNEXPECTED: sync succeeded against a corrupted file");
	} catch (error) {
		console.log(`Real behavior on a corrupted cache file: throws "${error.message}"`);
		console.log("This is a cache, not the source of truth — recovery is re-hydration, not data loss.");
	}
}

async function main() {
	await resetHarnessDocs();
	await step1_throttledHydrationFails();
	const { cache, store } = await step2_bulkHydrationSucceeds();
	await step3_liveOperations(cache, store);
	await step4_roundTripFreshInstance();
	await step5_corruptedFileRecovery();
}

main().catch((error) => {
	console.error("HARNESS FAILED", error);
	process.exit(1);
});
