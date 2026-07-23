import { describe, expect, it } from "vitest";
import { MarvinReadCache } from "./cache";
import { MarvinApiClient } from "./client";
import { MarvinRouteError } from "./errors";
import { MarvinRouter, marvinDeepLink } from "./router";
import { jsonResponse, QueueTransport } from "./test-helpers";
import type { MarvinTransportResponse } from "./types";

function api(
	origin: "local" | "public",
	transport: QueueTransport,
): MarvinApiClient {
	return new MarvinApiClient({
		apiToken: "test-token",
		baseUrl: origin === "local"
			? "http://localhost:12082/api"
			: "https://example.test/api",
		origin,
		transport,
	});
}

describe("MarvinRouter", () => {
	it("never contacts local when no configured local client exists", async () => {
		const local = new QueueTransport(jsonResponse(200, ["unexpected"]));
		const publicApi = new QueueTransport(jsonResponse(200, []));
		const router = new MarvinRouter({
			publicClient: api("public", publicApi),
		});

		await expect(router.getTodayItems("2026-07-23")).resolves.toMatchObject({
			data: [],
			freshness: "fresh",
			origin: "public",
		});
		expect(local.requests).toHaveLength(0);
		expect(publicApi.requests).toHaveLength(1);
	});

	it("accepts a successful empty local result without public fallback", async () => {
		const local = new QueueTransport(jsonResponse(200, []));
		const publicApi = new QueueTransport(jsonResponse(200, ["unexpected"]));
		const router = new MarvinRouter({
			localClient: api("local", local),
			publicClient: api("public", publicApi),
		});

		await expect(router.getTodayItems("2026-07-23")).resolves.toMatchObject({
			data: [],
			origin: "local",
		});
		expect(local.requests).toHaveLength(1);
		expect(publicApi.requests).toHaveLength(0);
	});

	it("falls back for an unsupported local endpoint and exposes why", async () => {
		const local = new QueueTransport({
			status: 404,
			statusText: "Not Found",
			headers: {},
			text: "unsupported",
		});
		const publicApi = new QueueTransport(
			jsonResponse(200, [{ _id: "task-1", title: "Task", done: false }]),
		);
		const router = new MarvinRouter({
			localClient: api("local", local),
			publicClient: api("public", publicApi),
		});

		const result = await router.getChildren("unassigned");

		expect(result.origin).toBe("public");
		expect(result.warnings).toMatchObject([
			{ origin: "local", status: 404, responseBody: "unsupported" },
		]);
	});

	it("preserves both attempted-origin failures", async () => {
		const local = new QueueTransport(new Error("ECONNREFUSED"));
		const publicApi = new QueueTransport({
			status: 503,
			statusText: "Unavailable",
			headers: {},
			text: "maintenance",
		});
		const router = new MarvinRouter({
			localClient: api("local", local),
			publicClient: api("public", publicApi),
		});

		await expect(router.getCategories()).rejects.toSatisfy((error) => {
			expect(error).toBeInstanceOf(MarvinRouteError);
			if (!(error instanceof MarvinRouteError)) {
				return false;
			}
			expect(error.attempts).toMatchObject([
				{ origin: "local", kind: "transport", message: "ECONNREFUSED" },
				{ origin: "public", kind: "http", status: 503 },
			]);
			return true;
		});
	});

	it("does not turn a local throttle into a public request", async () => {
		const local = new QueueTransport({
			status: 429,
			statusText: "Too Many Requests",
			headers: { "retry-after": "30" },
			text: "slow down",
		});
		const publicApi = new QueueTransport(jsonResponse(200, []));
		const router = new MarvinRouter({
			localClient: api("local", local),
			publicClient: api("public", publicApi),
		});

		await expect(router.getTodayItems()).rejects.toMatchObject({
			attempts: [{ origin: "local", status: 429 }],
		});
		expect(publicApi.requests).toHaveLength(0);
	});

	it("does not hide a local authentication failure behind public fallback", async () => {
		const local = new QueueTransport({
			status: 401,
			statusText: "Unauthorized",
			headers: {},
			text: "bad token",
		});
		const publicApi = new QueueTransport(jsonResponse(200, []));
		const router = new MarvinRouter({
			localClient: api("local", local),
			publicClient: api("public", publicApi),
		});

		await expect(router.getCategories()).rejects.toMatchObject({
			attempts: [{ origin: "local", status: 401, responseBody: "bad token" }],
		});
		expect(publicApi.requests).toHaveLength(0);
	});

	it("reuses a fresh cached read", async () => {
		const publicApi = new QueueTransport(jsonResponse(200, []));
		const router = new MarvinRouter({
			publicClient: api("public", publicApi),
		});

		expect((await router.getTodayItems("2026-07-23")).freshness).toBe("fresh");
		expect((await router.getTodayItems("2026-07-23")).freshness).toBe("cached");
		expect(publicApi.requests).toHaveLength(1);
	});

	it("routes and caches the stable label list", async () => {
		const publicApi = new QueueTransport(
			jsonResponse(200, [{ _id: "label-1", title: "Knowledge work" }]),
		);
		const router = new MarvinRouter({
			publicClient: api("public", publicApi),
		});

		expect((await router.getLabels()).data).toEqual([
			{ _id: "label-1", title: "Knowledge work" },
		]);
		expect((await router.getLabels()).freshness).toBe("cached");
		expect(publicApi.requests).toHaveLength(1);
	});

	it("coalesces concurrent reads for the same key", async () => {
		let release: ((value: MarvinTransportResponse) => void) | undefined;
		let calls = 0;
		const response = new Promise<MarvinTransportResponse>((resolve) => {
			release = resolve;
		});
		const transport = {
			request: async () => {
				calls += 1;
				return response;
			},
		};
		const router = new MarvinRouter({
			publicClient: new MarvinApiClient({
				apiToken: "test-token",
				baseUrl: "https://example.test/api",
				origin: "public",
				transport,
			}),
		});

		const first = router.getTodayItems("2026-07-23");
		const second = router.getTodayItems("2026-07-23");
		release?.(jsonResponse(200, []));

		await expect(Promise.all([first, second])).resolves.toMatchObject([
			{ data: [], freshness: "fresh" },
			{ data: [], freshness: "fresh" },
		]);
		expect(calls).toBe(1);
	});

	it("returns explicitly stale data on throttle and opens a public circuit", async () => {
		let now = 1_000;
		const publicApi = new QueueTransport(
			jsonResponse(200, [{ _id: "task-1", title: "Cached", done: false }]),
			{
				status: 429,
				statusText: "Too Many Requests",
				headers: { "retry-after": "30" },
				text: "slow down",
			},
		);
		const router = new MarvinRouter({
			publicClient: api("public", publicApi),
			now: () => now,
		});

		await router.getTodayItems("2026-07-23");
		now += 31_000;
		const firstStale = await router.getTodayItems("2026-07-23");
		const circuitStale = await router.getTodayItems("2026-07-23");

		expect(firstStale).toMatchObject({
			freshness: "stale",
			data: [{ _id: "task-1" }],
			warnings: [{ kind: "throttle", status: 429 }],
		});
		expect(circuitStale.freshness).toBe("stale");
		expect(publicApi.requests).toHaveLength(2);
	});

	it("does not cache failures as empty successes", async () => {
		const publicApi = new QueueTransport(
			{
				status: 503,
				statusText: "Unavailable",
				headers: {},
				text: "maintenance",
			},
			jsonResponse(200, []),
		);
		const router = new MarvinRouter({
			publicClient: api("public", publicApi),
		});

		await expect(router.getDueItems("2026-07-23")).rejects.toBeInstanceOf(
			MarvinRouteError,
		);
		await expect(router.getDueItems("2026-07-23")).resolves.toMatchObject({
			data: [],
			freshness: "fresh",
		});
		expect(publicApi.requests).toHaveLength(2);
	});

	it("invalidates task-list reads after a write", async () => {
		const publicApi = new QueueTransport(
			jsonResponse(200, []),
			jsonResponse(200, { _id: "task-1", title: "New", done: false }),
			jsonResponse(200, [{ _id: "task-1", title: "New", done: false }]),
		);
		const router = new MarvinRouter({
			publicClient: api("public", publicApi),
		});

		await router.getTodayItems("2026-07-23");
		await router.addTask({ title: "New" });
		const refreshed = await router.getTodayItems("2026-07-23");

		expect(refreshed.data).toHaveLength(1);
		expect(publicApi.requests).toHaveLength(3);
	});

	it("deduplicates scheduled and due results by Marvin ID", async () => {
		const publicApi = new QueueTransport(
			jsonResponse(200, [
				{ _id: "same", title: "Scheduled", done: false },
				{ _id: "today-only", title: "Today", done: false },
			]),
			jsonResponse(200, [
				{ _id: "same", title: "Due", done: false },
				{ _id: "due-only", title: "Due", done: false },
			]),
		);
		const router = new MarvinRouter({
			publicClient: api("public", publicApi),
		});

		const result = await router.getTodayAndDue("2026-07-23");

		expect(result.data.map((item) => item._id)).toEqual([
			"same",
			"today-only",
			"due-only",
		]);
		expect(publicApi.requests.map((request) => request.url)).toEqual([
			"https://example.test/api/todayItems?date=2026-07-23",
			"https://example.test/api/dueItems?by=2026-07-23",
		]);
	});

	it("bounds the read cache and uses container deep links", () => {
		const cache = new MarvinReadCache(2);
		const policy = { freshTtlMs: 1_000, staleIfErrorMs: 1_000 };
		cache.set("today:1", {
			data: [],
			origin: "public",
			fetchedAt: 0,
			warnings: [],
		}, policy);
		cache.set("today:2", {
			data: [],
			origin: "public",
			fetchedAt: 0,
			warnings: [],
		}, policy);
		cache.set("today:3", {
			data: [],
			origin: "public",
			fetchedAt: 0,
			warnings: [],
		}, policy);

		expect(cache.get("today:1", 1)).toBeUndefined();
		expect(cache.get("today:2", 1)).toBeDefined();
		expect(marvinDeepLink({ _id: "category-1", type: "category" })).toBe(
			"https://app.amazingmarvin.com/#p=category-1",
		);
	});
});
