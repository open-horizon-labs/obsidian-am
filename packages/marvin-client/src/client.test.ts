import { describe, expect, it } from "vitest";
import { MarvinApiClient } from "./client";
import { jsonResponse, QueueTransport } from "./test-helpers";

function client(transport: QueueTransport): MarvinApiClient {
	return new MarvinApiClient({
		apiToken: "test-token",
		baseUrl: "https://example.test/api",
		origin: "public",
		transport,
	});
}

describe("MarvinApiClient", () => {
	it("uses the documented and encoded by parameter for due items", async () => {
		const transport = new QueueTransport(jsonResponse(200, []));

		await client(transport).getDueItems("2026-07-23 & later");

		expect(transport.requests).toHaveLength(1);
		expect(transport.requests[0]?.url).toBe(
			"https://example.test/api/dueItems?by=2026-07-23+%26+later",
		);
	});

	it("defaults task done to false without requiring callers to provide it", async () => {
		const transport = new QueueTransport(
			jsonResponse(200, { _id: "task-1", title: "Decide", done: false }),
		);

		await client(transport).addTask({ title: "Decide" });

		expect(JSON.parse(transport.requests[0]?.body ?? "{}")).toEqual({
			done: false,
			title: "Decide",
		});
	});

	it("keeps a successful empty list distinct from a failure", async () => {
		const transport = new QueueTransport(
			jsonResponse(200, []),
			{
				status: 503,
				statusText: "Unavailable",
				headers: {},
				text: "maintenance",
			},
		);
		const api = client(transport);

		await expect(api.getTodayItems("2026-07-23")).resolves.toEqual([]);
		await expect(api.getTodayItems("2026-07-24")).rejects.toMatchObject({
			kind: "http",
			status: 503,
			responseBody: "maintenance",
		});
	});

	it("reads labels through the limited API without retries", async () => {
		const transport = new QueueTransport(
			jsonResponse(200, [{ _id: "label-1", title: "Knowledge work" }]),
		);

		await expect(client(transport).getLabels()).resolves.toEqual([
			{ _id: "label-1", title: "Knowledge work" },
		]);
		expect(transport.requests).toMatchObject([{
			method: "GET",
			url: "https://example.test/api/labels",
		}]);
	});

	it("normalizes categories without a type discriminator", async () => {
		const transport = new QueueTransport(
			jsonResponse(200, [
				{ _id: "category-1", title: "Work" },
				{ _id: "project-1", title: "Book", type: "project" },
			]),
		);

		await expect(client(transport).getCategories()).resolves.toEqual([
			{ _id: "category-1", title: "Work", type: "category" },
			{ _id: "project-1", title: "Book", type: "project" },
		]);
	});

	it("does not retry a throttled request", async () => {
		const transport = new QueueTransport({
			status: 429,
			statusText: "Too Many Requests",
			headers: { "retry-after": "30" },
			text: "slow down",
		});

		await expect(client(transport).getCategories()).rejects.toMatchObject({
			kind: "throttle",
			status: 429,
			retryAfterMs: 30_000,
			responseBody: "slow down",
		});
		expect(transport.requests).toHaveLength(1);
	});

	it("rejects malformed successful read responses before they can be cached", async () => {
		const transport = new QueueTransport(jsonResponse(200, { not: "an array" }));

		await expect(client(transport).getTodayItems()).rejects.toMatchObject({
			kind: "validation",
		});
	});
});
