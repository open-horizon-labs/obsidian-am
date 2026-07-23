import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	FetchTransport,
	MarvinApiClient,
	MarvinRouter,
	type FetchLike,
} from "@open-horizon/marvin-client";
import { describe, expect, it } from "vitest";
import { createMarvinMcpServer } from "../../packages/marvin-mcp/src/tools";
import { createObsidianTransport } from "./obsidianTransport";

describe("plugin and MCP shared contract fixture", () => {
	it("projects the same Marvin response through both runtime adapters", async () => {
		const payload = [{ _id: "shared-1", title: "One contract", done: false }];
		const pluginRouter = new MarvinRouter({
			publicClient: new MarvinApiClient({
				apiToken: "token",
				baseUrl: "https://example.test/api",
				origin: "public",
				transport: createObsidianTransport(async () => ({
					status: 200,
					headers: { "Content-Type": "application/json" },
					arrayBuffer: new ArrayBuffer(0),
					json: payload,
					text: JSON.stringify(payload),
				})),
			}),
		});
		const fetch: FetchLike = async () => new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
		const mcpRouter = new MarvinRouter({
			publicClient: new MarvinApiClient({
				apiToken: "token",
				baseUrl: "https://example.test/api",
				origin: "public",
				transport: new FetchTransport(fetch),
			}),
		});

		const mcpServer = createMarvinMcpServer(mcpRouter);
		const mcpClient = new Client({ name: "fixture-client", version: "0.1.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await mcpServer.connect(serverTransport);
		await mcpClient.connect(clientTransport);

		try {
			const pluginResult = await pluginRouter.getTodayItems("2026-07-23");
			const mcpResult = await mcpClient.callTool({
				name: "marvin_today",
				arguments: { date: "2026-07-23" },
			});

			expect(pluginResult).toMatchObject({
				data: payload,
				freshness: "fresh",
				origin: "public",
			});
			expect(mcpResult.structuredContent).toMatchObject({
				items: [{
					id: "shared-1",
					title: "One contract",
				}],
				freshness: pluginResult.freshness,
				origin: pluginResult.origin,
			});
		} finally {
			await mcpClient.close();
			await mcpServer.close();
		}
	});
});
