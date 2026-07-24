import { describe, expect, it } from "vitest";

import {
	CouchChangesClient,
	CouchChangesError,
	type CouchChangesRequest,
	type CouchChangesTransport,
} from "./couchChanges";

class FakeTransport implements CouchChangesTransport {
	readonly requests: CouchChangesRequest[] = [];

	constructor(private readonly response: { status: number; text: string }) {}

	async request(request: CouchChangesRequest) {
		this.requests.push(request);
		return this.response;
	}
}

describe("CouchChangesClient", () => {
	it("keeps credentials out of the URL and round-trips opaque checkpoints", async () => {
		const transport = new FakeTransport({
			status: 200,
			text: JSON.stringify({
				results: [{
					id: "task-1",
					seq: { shard: 4 },
					doc: { _id: "task-1", db: "Tasks", title: "Draft" },
				}],
				last_seq: { shard: 5 },
				pending: 0,
			}),
		});
		const client = new CouchChangesClient({
			databaseUri: "https://sync.example.test/account-db",
			databaseUser: "private-user",
			databasePassword: "secret",
		}, transport);

		const page = await client.changes({
			since: { shard: 4 },
			feed: "longpoll",
		});

		const request = transport.requests[0]!;
		expect(request.url).not.toContain("private-user");
		expect(request.url).not.toContain("secret");
		expect(new URL(request.url).searchParams.get("since")).toBe(
			JSON.stringify({ shard: 4 }),
		);
		expect(request.headers.Authorization).toMatch(/^Basic /);
		expect(page.lastSeq).toEqual({ shard: 5 });
		expect(page.results[0]?.doc).toMatchObject({ db: "Tasks" });
	});

	it("rejects insecure, credential-bearing, and database-less URLs", () => {
		const transport = new FakeTransport({ status: 200, text: "{}" });
		expect(() => new CouchChangesClient({
			databaseUri: "http://sync.example.test/db",
			databaseUser: "user",
			databasePassword: "secret",
		}, transport)).toThrow("HTTPS");
		expect(() => new CouchChangesClient({
			databaseUri: "https://user:secret@sync.example.test/db",
			databaseUser: "user",
			databasePassword: "secret",
		}, transport)).toThrow("separate fields");
		expect(() => new CouchChangesClient({
			databaseUri: "https://sync.example.test/",
			databaseUser: "user",
			databasePassword: "secret",
		}, transport)).toThrow("database name");
	});

	it("surfaces HTTP and invalid-success responses without response bodies", async () => {
		const unauthorized = new CouchChangesClient({
			databaseUri: "https://sync.example.test/db",
			databaseUser: "user",
			databasePassword: "wrong",
		}, new FakeTransport({ status: 401, text: "credential details" }));
		await expect(unauthorized.changes({ since: "now" })).rejects.toMatchObject({
			status: 401,
			message: "Amazing Marvin changes feed failed with HTTP 401",
		});

		const malformed = new CouchChangesClient({
			databaseUri: "https://sync.example.test/db",
			databaseUser: "user",
			databasePassword: "secret",
		}, new FakeTransport({ status: 200, text: "{}" }));
		await expect(malformed.changes({ since: "now" })).rejects.toBeInstanceOf(
			CouchChangesError,
		);

		const invalidJson = new CouchChangesClient({
			databaseUri: "https://sync.example.test/db",
			databaseUser: "user",
			databasePassword: "secret",
		}, new FakeTransport({
			status: 200,
			text: "sensitive response contents",
		}));
		await expect(invalidJson.changes({ since: "now" })).rejects.toMatchObject({
			message: "Amazing Marvin changes feed returned invalid JSON",
		});
		try {
			await invalidJson.changes({ since: "now" });
		} catch (error) {
			expect(String(error)).not.toContain("sensitive response contents");
			expect(error).not.toHaveProperty("cause");
		}
	});

	it("does not retain transport errors that could contain authorization details", async () => {
		const client = new CouchChangesClient({
			databaseUri: "https://sync.example.test/db",
			databaseUser: "user",
			databasePassword: "secret",
		}, {
			async request() {
				throw new Error("Authorization: Basic sensitive-value");
			},
		});

		try {
			await client.changes({ since: "now" });
		} catch (error) {
			expect(String(error)).toBe(
				"CouchChangesError: Could not reach the Amazing Marvin changes feed",
			);
			expect(error).not.toHaveProperty("cause");
		}
	});
});
