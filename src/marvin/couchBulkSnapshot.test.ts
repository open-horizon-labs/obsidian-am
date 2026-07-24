import { describe, expect, it } from "vitest";

import type { CouchChangesRequest, CouchChangesTransport } from "./couchChanges";
import { CouchBulkClient, CouchBulkError, CouchBulkSnapshotSource } from "./couchBulkSnapshot";

class QueuedTransport implements CouchChangesTransport {
	readonly requests: CouchChangesRequest[] = [];

	constructor(private readonly responses: Array<{ status: number; text: string }>) {}

	async request(request: CouchChangesRequest) {
		this.requests.push(request);
		const response = this.responses.shift();
		if (!response) {
			throw new Error("No response queued");
		}
		return response;
	}
}

function allDocsPage(rows: Array<{ id: string; doc?: unknown }>) {
	return JSON.stringify({ rows });
}

describe("CouchBulkClient", () => {
	it("paginates via startkey+skip=1, never deep-skip, and stops on a short page", async () => {
		const transport = new QueuedTransport([
			{ status: 200, text: allDocsPage([
				{ id: "a", doc: { _id: "a", db: "Tasks", title: "A", parentId: "cat" } },
			]) },
		]);
		const client = new CouchBulkClient(
			{ databaseUri: "http://localhost:5984/db", databaseUser: "u", databasePassword: "p" },
			transport,
		);

		const pages: unknown[][] = [];
		for await (const page of client.allDocs(500)) {
			pages.push(page);
		}

		expect(pages).toHaveLength(1);
		expect(transport.requests[0]!.url).not.toContain("skip=");
		expect(new URL(transport.requests[0]!.url).searchParams.get("limit")).toBe("500");
	});

	it("filters out design docs and tombstones without a doc body", async () => {
		const transport = new QueuedTransport([
			{ status: 200, text: allDocsPage([
				{ id: "_design/views" },
				{ id: "deleted-doc" },
				{ id: "a", doc: { _id: "a", db: "Tasks", title: "A", parentId: "cat" } },
			]) },
		]);
		const client = new CouchBulkClient(
			{ databaseUri: "http://localhost:5984/db", databaseUser: "u", databasePassword: "p" },
			transport,
		);

		const rows = [];
		for await (const page of client.allDocs(500)) {
			rows.push(...page);
		}
		expect(rows).toHaveLength(1);
		expect(rows[0]?._id).toBe("a");
	});

	it("throws a typed error on a non-2xx response instead of returning partial data", async () => {
		const transport = new QueuedTransport([{ status: 500, text: "{}" }]);
		const client = new CouchBulkClient(
			{ databaseUri: "http://localhost:5984/db", databaseUser: "u", databasePassword: "p" },
			transport,
		);
		await expect(async () => {
			for await (const _ of client.allDocs()) {
				// draining is enough to trigger the request
			}
		}).rejects.toThrow(CouchBulkError);
	});
});

describe("CouchBulkSnapshotSource", () => {
	it("builds categories and children from one bulk read, filtered to Tasks/Categories only", async () => {
		const transport = new QueuedTransport([
			{ status: 200, text: allDocsPage([
				{ id: "cat", doc: { _id: "cat", db: "Categories", type: "category", title: "Work", parentId: "root" } },
				{ id: "task-open", doc: { _id: "task-open", db: "Tasks", title: "Open", parentId: "cat", done: false } },
				{ id: "task-done", doc: { _id: "task-done", db: "Tasks", title: "Done", parentId: "cat", done: true } },
				// Non-Task/Category doc types (confirmed present in a real export) must never surface here.
				{ id: "profile", doc: { _id: "profile", db: "ProfileItems", email: "user@example.test" } },
			]) },
		]);
		const client = new CouchBulkClient(
			{ databaseUri: "http://localhost:5984/db", databaseUser: "u", databasePassword: "p" },
			transport,
		);
		const source = new CouchBulkSnapshotSource(client);

		const categories = await source.getCategories();
		const children = await source.getChildren("cat");

		expect(categories).toEqual([
			expect.objectContaining({ _id: "cat", title: "Work" }),
		]);
		// Only the not-done task is tracked — matches how applyCouchChanges
		// treats a completed task: pruned from the tree, not shown done-in-place.
		expect(children).toEqual([
			expect.objectContaining({ _id: "task-open" }),
		]);
		expect(JSON.stringify(categories)).not.toContain("user@example.test");
	});

	it("caches the bulk read across getCategories/getChildren calls on one instance", async () => {
		const transport = new QueuedTransport([
			{ status: 200, text: allDocsPage([
				{ id: "cat", doc: { _id: "cat", db: "Categories", type: "category", title: "Work", parentId: "root" } },
			]) },
		]);
		const client = new CouchBulkClient(
			{ databaseUri: "http://localhost:5984/db", databaseUser: "u", databasePassword: "p" },
			transport,
		);
		const source = new CouchBulkSnapshotSource(client);

		await source.getCategories();
		await source.getChildren("cat");
		await source.getCategories();

		expect(transport.requests).toHaveLength(1);
	});
});
