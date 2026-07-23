import { describe, expect, it } from "vitest";
import {
	FetchTransport,
	MarvinApiClient,
	type FetchLike,
} from "@open-horizon/marvin-client";
import { createObsidianTransport } from "./obsidianTransport";

describe("shared transport contract", () => {
	it("returns the same client result through Obsidian and fetch adapters", async () => {
		const payload = [{ _id: "task-1", title: "Shared", done: false }];
		const obsidianRequests: unknown[] = [];
		const obsidianTransport = createObsidianTransport(async (request) => {
			obsidianRequests.push(request);
			return {
				status: 200,
				headers: { "Content-Type": "application/json" },
				arrayBuffer: new ArrayBuffer(0),
				json: payload,
				text: JSON.stringify(payload),
			};
		});
		const fetchCalls: unknown[] = [];
		const fetch: FetchLike = async (input, init) => {
			fetchCalls.push([input, init]);
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const obsidianClient = new MarvinApiClient({
			apiToken: "token",
			baseUrl: "https://example.test/api",
			origin: "public",
			transport: obsidianTransport,
		});
		const nodeClient = new MarvinApiClient({
			apiToken: "token",
			baseUrl: "https://example.test/api",
			origin: "public",
			transport: new FetchTransport(fetch),
		});

		await expect(obsidianClient.getTodayItems("2026-07-23")).resolves.toEqual(
			payload,
		);
		await expect(nodeClient.getTodayItems("2026-07-23")).resolves.toEqual(payload);
		expect(obsidianRequests).toMatchObject([
			{
				url: "https://example.test/api/todayItems?date=2026-07-23",
				throw: false,
			},
		]);
		expect(fetchCalls).toHaveLength(1);
	});
});
