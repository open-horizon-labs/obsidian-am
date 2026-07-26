import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	MarvinError,
	MarvinRouteError,
	type MarvinReadResult,
	type Task,
	type TaskOrProject,
} from "@open-horizon/marvin-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createMarvinMcpServer,
	type MarvinMcpServerOptions,
	type MarvinOperations,
} from "./tools.js";

const todayResult: MarvinReadResult<TaskOrProject[]> = {
	data: [{ _id: "task-1", title: "Decide", done: false }],
	freshness: "fresh",
	origin: "public",
	fetchedAt: 1_721_753_600_000,
	ageMs: 0,
	warnings: [],
};

function operations(overrides: Partial<MarvinOperations> = {}): MarvinOperations {
	return {
		getTodayItems: async () => todayResult,
		getDueItems: async () => ({ ...todayResult, data: [] }),
		getCategories: async () => ({
			...todayResult,
			data: [{
				_id: "project-1",
				title: "Knowledge work",
				type: "project",
				parentId: "root",
			}],
		}),
		getChildren: async () => ({
			...todayResult,
			data: [{ _id: "child-1", title: "Draft", done: false }],
		}),
		getLabels: async () => ({
			...todayResult,
			data: [{ _id: "label-1", title: "Knowledge work" }],
		}),
		addTask: async (input): Promise<Task> => ({
			_id: "created-1",
			title: input.title,
			done: false,
		}),
		markDone: async () => ({ success: true }),
		...overrides,
	};
}

describe("Amazing Marvin MCP", () => {
	const close: Array<() => Promise<void>> = [];

	afterEach(async () => {
		await Promise.all(close.splice(0).map((callback) => callback()));
	});

	async function connect(
		ops: MarvinOperations,
		options?: MarvinMcpServerOptions,
	) {
		const server = createMarvinMcpServer(ops, options);
		const client = new Client({ name: "test-client", version: "0.1.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		close.push(() => client.close(), () => server.close());
		return client;
	}

	it("exposes the bounded tool set and stable task IDs", async () => {
		const client = await connect(operations());

		const tools = await client.listTools();
		const result = await client.callTool({
			name: "marvin_today",
			arguments: { date: "2026-07-23" },
		});
		const labels = await client.callTool({
			name: "marvin_labels",
			arguments: {},
		});
		const categories = await client.callTool({
			name: "marvin_categories",
			arguments: {},
		});
		const children = await client.callTool({
			name: "marvin_children",
			arguments: { parentId: "project-1" },
		});

		expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
			"marvin_categories",
			"marvin_children",
			"marvin_create_task",
			"marvin_due",
			"marvin_labels",
			"marvin_mark_done",
			"marvin_today",
		]);
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toMatchObject({
			freshness: "fresh",
			origin: "public",
			items: [{
				id: "task-1",
				title: "Decide",
				deepLink: "https://app.amazingmarvin.com/#t=task-1",
			}],
		});
		expect(labels.structuredContent).toMatchObject({
			labels: [{
				id: "label-1",
				title: "Knowledge work",
			}],
		});
		expect(categories.structuredContent).toMatchObject({
			items: [{
				id: "project-1",
				parentId: "root",
				deepLink: "https://app.amazingmarvin.com/#p=project-1",
			}],
		});
		expect(children.structuredContent).toMatchObject({
			items: [{ id: "child-1", title: "Draft" }],
		});
	});

	it("returns actionable attempted-origin errors through MCP", async () => {
		const routeError = new MarvinRouteError("today items", [
			new MarvinError({
				kind: "transport",
				message: "ECONNREFUSED",
				operation: "today items",
				origin: "local",
			}),
			new MarvinError({
				kind: "throttle",
				message: "Rate limited",
				operation: "today items",
				origin: "public",
				status: 429,
				retryAfterMs: 30_000,
			}),
		]);
		const client = await connect(operations({
			getTodayItems: async () => {
				throw routeError;
			},
		}));

		const result = await client.callTool({
			name: "marvin_today",
			arguments: {},
		});

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			error: {
				attempts: [
					{ origin: "local", kind: "transport", message: "ECONNREFUSED" },
					{
						origin: "public",
						kind: "throttle",
						status: 429,
						retryAfterMs: 30_000,
					},
				],
			},
		});
	});

	it("returns malformed dates in the structured error envelope", async () => {
		const client = await connect(operations());

		const result = await client.callTool({
			name: "marvin_today",
			arguments: { date: "not-a-date" },
		});

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({
			error: {
				kind: "input",
				field: "date",
				message: "Use YYYY-MM-DD",
			},
		});
	});

	it("routes create and completion tools through the shared operations", async () => {
		const calls: unknown[] = [];
		const client = await connect(operations({
			addTask: async (input) => {
				calls.push(["addTask", input]);
				return { _id: "created-1", title: input.title, done: false };
			},
			markDone: async (itemId, timeZoneOffset) => {
				calls.push(["markDone", itemId, timeZoneOffset]);
				return { success: true };
			},
		}));

		const created = await client.callTool({
			name: "marvin_create_task",
			arguments: {
				title: "Prepare application",
				day: "2026-07-23",
				parentId: "project-1",
				labelIds: ["label-1"],
			},
		});
		const completed = await client.callTool({
			name: "marvin_mark_done",
			arguments: {
				itemId: "created-1",
				timeZoneOffset: -240,
			},
		});

		expect(created.structuredContent).toMatchObject({
			task: {
				id: "created-1",
				title: "Prepare application",
				deepLink: "https://app.amazingmarvin.com/#t=created-1",
			},
		});
		expect(completed.structuredContent).toMatchObject({
			itemId: "created-1",
			result: { success: true },
		});
		expect(calls).toMatchObject([
			[
				"addTask",
				{
					title: "Prepare application",
					day: "2026-07-23",
					parentId: "project-1",
					labelIds: ["label-1"],
				},
			],
			["markDone", "created-1", -240],
		]);
	});

	it("requests a cache refresh only when the refresh parameter is true", async () => {
		const requestCacheRefresh = vi.fn(async () => ({
			requested: true as const,
			outcome: "synced" as const,
			waitedMs: 820,
		}));
		const client = await connect(operations(), { requestCacheRefresh });

		// Default (omitted) must not trigger a refresh — the passive,
		// zero-latency read stays the norm — and must not report on one.
		const passive = await client.callTool({
			name: "marvin_categories",
			arguments: {},
		});
		expect(requestCacheRefresh).not.toHaveBeenCalled();
		expect(passive.structuredContent).not.toHaveProperty("refresh");

		await client.callTool({
			name: "marvin_categories",
			arguments: { refresh: true },
		});
		expect(requestCacheRefresh).toHaveBeenCalledTimes(1);

		await client.callTool({
			name: "marvin_children",
			arguments: { parentId: "project-1", refresh: true },
		});
		expect(requestCacheRefresh).toHaveBeenCalledTimes(2);
	});

	it("reports what a requested refresh actually did", async () => {
		// freshness/origin say where the answer came from; this says whether
		// the refresh the caller asked for actually ran, so they can tell a
		// newly-synced cache hit from a silent timeout that fell back.
		for (const outcome of ["synced", "timed_out", "skipped"] as const) {
			const client = await connect(operations(), {
				requestCacheRefresh: async () => ({
					requested: true as const,
					outcome,
					waitedMs: 820,
				}),
			});

			for (const call of [
				{ name: "marvin_categories", arguments: { refresh: true } },
				{ name: "marvin_children", arguments: { parentId: "project-1", refresh: true } },
			]) {
				const result = await client.callTool(call);
				expect(result.structuredContent).toMatchObject({
					refresh: { requested: true, outcome, waitedMs: 820 },
				});
			}
		}
	});

	it("reports skipped with a reason when no cache is configured", async () => {
		// Without a configured cache path there is nothing to ask, but the
		// parameter must still be accepted and honestly reported rather than
		// silently ignored.
		const client = await connect(operations());
		const result = await client.callTool({
			name: "marvin_categories",
			arguments: { refresh: true },
		});

		expect(result.isError ?? false).toBe(false);
		expect(result.structuredContent).toMatchObject({
			refresh: { requested: true, outcome: "skipped", waitedMs: 0 },
		});
		expect(
			(result.structuredContent as { refresh: { reason?: string } }).refresh.reason,
		).toContain("no incremental cache");
	});

});
