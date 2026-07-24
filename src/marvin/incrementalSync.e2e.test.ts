/// <reference types="node" />
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CouchChangesClient } from "./couchChanges";
import { CouchBulkClient, CouchBulkSnapshotSource } from "./couchBulkSnapshot";
import { IncrementalMarvinCache } from "./incrementalCache";
import { type IncrementalFileAdapter, ObsidianIncrementalCacheStore } from "./obsidianIncremental";

// Exercises the actual shipped modules together against real, local CouchDB
// — not a hand-rolled fake. Gated behind COUCH_TEST_URL so it never runs in
// normal CI (no Docker there); matches this repo's existing pattern of a
// token-gated live smoke test that isn't required by default.
//
// Setup:
//   docker run -d --name marvin-e2e-couch -p 5984:5984 \
//     -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test couchdb:3
//   COUCH_TEST_URL=http://admin:test@localhost:5984 npm test -- incrementalSync.e2e

const COUCH_TEST_URL = process.env.COUCH_TEST_URL;
const DB_NAME = process.env.COUCH_TEST_DB ?? "marvin-e2e";

describe.skipIf(!COUCH_TEST_URL)("incremental sync against real CouchDB", () => {
	let scratchDir: string;
	const parsed = COUCH_TEST_URL ? new URL(COUCH_TEST_URL) : undefined;
	const auth = parsed?.username
		? `Basic ${Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64")}`
		: undefined;
	const couchOrigin = parsed ? `${parsed.protocol}//${parsed.host}` : "";

	async function couch(pathAndQuery: string, init: RequestInit = {}) {
		const response = await fetch(`${couchOrigin}${pathAndQuery}`, {
			...init,
			headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}), ...init.headers },
		});
		const body = await response.json();
		if (!response.ok && response.status !== 404) {
			throw new Error(`CouchDB ${pathAndQuery} -> HTTP ${response.status}: ${JSON.stringify(body)}`);
		}
		return { status: response.status, body };
	}

	function realFileAdapter(root: string): IncrementalFileAdapter {
		const resolve = (p: string) => path.join(root, p.replace(/^\/+/, ""));
		return {
			async exists(p) {
				return fs.access(resolve(p)).then(() => true, () => false);
			},
			async read(p) {
				return fs.readFile(resolve(p), "utf8");
			},
			async write(p, data) {
				await fs.mkdir(path.dirname(resolve(p)), { recursive: true });
				await fs.writeFile(resolve(p), data, "utf8");
			},
			async process(p, update) {
				const next = update(await fs.readFile(resolve(p), "utf8"));
				await fs.writeFile(resolve(p), next, "utf8");
				return next;
			},
			async remove(p) {
				await fs.rm(resolve(p), { force: true });
			},
		};
	}

	function realCouchTransport() {
		return {
			async request({ url, headers }: { url: string; headers: Record<string, string> }) {
				const response = await fetch(url, { headers });
				return { status: response.status, text: await response.text() };
			},
		};
	}

	function newCache(pluginDir: string) {
		const credentials = { databaseUri: `${couchOrigin}/${DB_NAME}`, databaseUser: parsed!.username, databasePassword: parsed!.password };
		return new IncrementalMarvinCache({
			sourceKey: DB_NAME,
			changes: new CouchChangesClient(credentials, realCouchTransport()),
			snapshot: new CouchBulkSnapshotSource(new CouchBulkClient(credentials, realCouchTransport())),
			store: new ObsidianIncrementalCacheStore(realFileAdapter(scratchDir), pluginDir),
		});
	}

	beforeAll(async () => {
		scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "marvin-e2e-"));
		await couch(`/${DB_NAME}`, { method: "PUT" }).catch(() => {});
	});

	afterAll(async () => {
		await fs.rm(scratchDir, { recursive: true, force: true });
	});

	it("hydrates via bulk _all_docs, then reconciles a live create/complete/delete sequence", async () => {
		await couch(`/${DB_NAME}/e2e-category`, {
			method: "PUT",
			body: JSON.stringify({ db: "Categories", type: "category", title: "E2E category", parentId: "root" }),
		});

		const cache = newCache("plugin-e2e");
		const hydrated = await cache.sync();
		expect(hydrated.fullRefresh).toBe(true);
		expect(cache.getCategories()?.some((c) => c._id === "e2e-category")).toBe(true);

		await couch(`/${DB_NAME}/e2e-task`, {
			method: "PUT",
			body: JSON.stringify({ db: "Tasks", title: "E2E task", parentId: "e2e-category", done: false }),
		});
		const afterCreate = await cache.sync();
		expect(afterCreate.changed).toBe(true);
		expect(cache.getChildren("e2e-category")?.map((i) => i._id)).toContain("e2e-task");

		const { body: doc } = await couch(`/${DB_NAME}/e2e-task`);
		await couch(`/${DB_NAME}/e2e-task`, { method: "PUT", body: JSON.stringify({ ...doc, done: true }) });
		await cache.sync();
		expect(cache.getChildren("e2e-category")?.map((i) => i._id)).not.toContain("e2e-task");

		// fullRefresh tracks projectionPending, not "did hydration run" — it
		// stays true until acknowledged, regardless of resume vs. fresh
		// hydration. Acknowledge before checking a genuine resume-without-
		// rehydration round trip.
		await cache.acknowledgeProjection();

		// Fresh instance, same on-disk store: round trip must reproduce the
		// same observable state without re-hydrating from CouchDB.
		const fresh = newCache("plugin-e2e");
		const freshResult = await fresh.sync();
		expect(freshResult.fullRefresh).toBe(false);
		expect(fresh.getCategories()?.some((c) => c._id === "e2e-category")).toBe(true);
	});

	it("does not rewrite the persisted cache file on a no-op sync", async () => {
		const cache = newCache("plugin-e2e-idle");
		await cache.sync();

		const store = new ObsidianIncrementalCacheStore(realFileAdapter(scratchDir), "plugin-e2e-idle");
		const before = await fs.stat(path.join(scratchDir, store.path)).then((s: { mtimeMs: number }) => s.mtimeMs);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await cache.sync();
		const after = await fs.stat(path.join(scratchDir, store.path)).then((s: { mtimeMs: number }) => s.mtimeMs);

		expect(after).toBe(before);
	});
});
