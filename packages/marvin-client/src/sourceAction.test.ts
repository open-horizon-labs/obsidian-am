import { describe, expect, it, vi } from "vitest";

import {
	SourceActionError,
	SourceActionService,
	type SourceActionKey,
	type SourceActionRecord,
	type SourceActionStore,
} from "./sourceAction.js";
import { MarvinError } from "./errors.js";
import type { AddTaskRequest, Task } from "./types.js";

class MemorySourceActionStore implements SourceActionStore {
	readonly records = new Map<string, SourceActionRecord>();
	failLinkedWrite = false;

	async get(key: SourceActionKey): Promise<SourceActionRecord | undefined> {
		return this.records.get(this.key(key));
	}

	async set(record: SourceActionRecord): Promise<void> {
		if (record.state === "linked" && this.failLinkedWrite) {
			throw new Error("disk full");
		}
		this.records.set(this.key(record), record);
	}

	async delete(key: SourceActionKey): Promise<void> {
		this.records.delete(this.key(key));
	}

	private key(key: SourceActionKey): string {
		return `${key.sourceKey}\u0000${key.actionKey}`;
	}
}

const createdTask: Task = {
	_id: "task-1",
	title: "Decide whether to pursue Titan AI",
	done: false,
	day: "2026-07-23",
};

function createService(
	store = new MemorySourceActionStore(),
	addTask: (task: AddTaskRequest) => Promise<Task> = vi.fn(async () => createdTask),
) {
	return {
		store,
		addTask,
		service: new SourceActionService({
			router: { addTask },
			store,
			now: () => 1_000,
			requestId: () => "request-1",
		}),
	};
}

describe("SourceActionService", () => {
	it("creates once and reuses the persisted stable association", async () => {
		const { service, addTask } = createService();
		const request = {
			sourceKey: "Opportunities/Titan AI.md",
			actionKey: "decide-whether-to-pursue",
			task: {
				title: createdTask.title,
				day: "2026-07-23",
			},
		};

		const first = await service.ensure(request);
		const second = await service.ensure(request);

		expect(first).toMatchObject({
			created: true,
			taskId: "task-1",
			deepLink: "https://app.amazingmarvin.com/#t=task-1",
		});
		expect(second).toMatchObject({
			created: false,
			taskId: "task-1",
		});
		expect(addTask).toHaveBeenCalledTimes(1);
	});

	it("coalesces concurrent calls for the same source and action", async () => {
		let release: ((task: Task) => void) | undefined;
		const addTask = vi.fn(() => new Promise<Task>((resolve) => {
			release = resolve;
		}));
		const { service } = createService(new MemorySourceActionStore(), addTask);
		const request = {
			sourceKey: "note.md",
			actionKey: "follow-up",
			task: { title: "Follow up" },
		};

		const first = service.ensure(request);
		const second = service.ensure(request);
		await vi.waitFor(() => {
			expect(release).toBeTypeOf("function");
		});
		release?.(createdTask);

		expect(await first).toEqual(await second);
		expect(addTask).toHaveBeenCalledTimes(1);
	});

	it("retains a pending record after an ambiguous creation failure", async () => {
		const { service, store, addTask } = createService(
			new MemorySourceActionStore(),
			vi.fn(async () => {
				throw new Error("connection reset after write");
			}),
		);
		const request = {
			sourceKey: "note.md",
			actionKey: "follow-up",
			task: { title: "Follow up" },
		};

		await expect(service.ensure(request)).rejects.toMatchObject({
			code: "creation-uncertain",
		});
		await expect(service.ensure(request)).rejects.toMatchObject({
			code: "pending",
		});
		expect(store.records.values().next().value).toMatchObject({
			state: "pending",
			requestId: "request-1",
		});
		expect(addTask).toHaveBeenCalledTimes(1);
	});

	it("clears pending state after a definite API rejection so a later retry is possible", async () => {
		const store = new MemorySourceActionStore();
		const rejected = new MarvinError({
			kind: "throttle",
			message: "throttled",
			operation: "add task",
			origin: "public",
			status: 429,
		});
		const addTask = vi.fn(async () => {
			if (addTask.mock.calls.length === 1) {
				throw rejected;
			}
			return createdTask;
		});
		const { service } = createService(store, addTask);
		const request = {
			sourceKey: "note.md",
			actionKey: "follow-up",
			task: { title: "Follow up" },
		};

		await expect(service.ensure(request)).rejects.toBe(rejected);
		expect(await store.get(request)).toBeUndefined();
		await expect(service.ensure(request)).resolves.toMatchObject({
			created: true,
			taskId: "task-1",
		});
		expect(addTask).toHaveBeenCalledTimes(2);
	});

	it("retains the created task ID when association persistence fails", async () => {
		const store = new MemorySourceActionStore();
		store.failLinkedWrite = true;
		const { service } = createService(store);

		const failure = await service.ensure({
			sourceKey: "note.md",
			actionKey: "follow-up",
			task: { title: "Follow up" },
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(SourceActionError);
		expect(failure).toMatchObject({
			code: "association-write-failed",
			task: { _id: "task-1" },
		});
		expect(store.records.values().next().value).toMatchObject({
			state: "pending",
		});
	});

	it("can resolve or explicitly clear a pending record", async () => {
		const { service, store } = createService(
			new MemorySourceActionStore(),
			vi.fn(async () => {
				throw new Error("timeout");
			}),
		);
		const key = { sourceKey: "note.md", actionKey: "follow-up" };

		await service.ensure({ ...key, task: { title: "Follow up" } }).catch(() => undefined);
		const resolved = await service.resolvePending({
			...key,
			taskId: "recovered-task",
		});
		expect(resolved).toMatchObject({
			created: false,
			taskId: "recovered-task",
		});

		await expect(service.clearPending(key)).rejects.toThrow(
			"Refusing to clear linked Marvin task",
		);
		await store.set({
			version: 1,
			state: "pending",
			...key,
			title: "Follow up",
			requestId: "request-2",
			requestedAt: 2_000,
		});
		await service.clearPending(key);
		expect(await store.get(key)).toBeUndefined();
	});
});
