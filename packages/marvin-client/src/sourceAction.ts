import type { MarvinRouter } from "./router.js";
import { marvinDeepLink } from "./router.js";
import { MarvinError } from "./errors.js";
import type { AddTaskRequest, Task } from "./types.js";

export interface SourceActionKey {
	sourceKey: string;
	actionKey: string;
}

export interface PendingSourceActionRecord extends SourceActionKey {
	version: 1;
	state: "pending";
	title: string;
	requestId: string;
	requestedAt: number;
}

export interface LinkedSourceActionRecord extends SourceActionKey {
	version: 1;
	state: "linked";
	title: string;
	requestId: string;
	requestedAt: number;
	taskId: string;
	deepLink: string;
	linkedAt: number;
}

export type SourceActionRecord =
	| PendingSourceActionRecord
	| LinkedSourceActionRecord;

export interface SourceActionStore {
	get(key: SourceActionKey): Promise<SourceActionRecord | undefined>;
	set(record: SourceActionRecord): Promise<void>;
	delete(key: SourceActionKey): Promise<void>;
}

export interface EnsureSourceActionRequest extends SourceActionKey {
	task: AddTaskRequest;
}

export interface EnsureSourceActionResult {
	created: boolean;
	taskId: string;
	deepLink: string;
	title: string;
	record: LinkedSourceActionRecord;
	task?: Task;
}

export interface ResolvePendingSourceActionRequest extends SourceActionKey {
	taskId: string;
	title?: string;
}

export type SourceActionErrorCode =
	| "pending"
	| "creation-uncertain"
	| "association-write-failed";

export class SourceActionError extends Error {
	readonly code: SourceActionErrorCode;
	readonly record: SourceActionRecord;
	readonly task: Task | undefined;
	override readonly cause: unknown;

	constructor(options: {
		code: SourceActionErrorCode;
		message: string;
		record: SourceActionRecord;
		task?: Task;
		cause?: unknown;
	}) {
		super(options.message);
		this.name = "SourceActionError";
		this.code = options.code;
		this.record = options.record;
		this.task = options.task;
		this.cause = options.cause;
	}
}

export interface SourceActionServiceOptions {
	router: Pick<MarvinRouter, "addTask">;
	store: SourceActionStore;
	now?: () => number;
	requestId?: () => string;
}

/**
 * Coordinates one Marvin task with one stable external source/action key.
 *
 * The pending record is persisted before the network write. If the request or
 * association write has an ambiguous outcome, subsequent calls stop at that
 * record instead of creating a duplicate. A caller can resolve or explicitly
 * clear the pending record after inspecting Marvin.
 */
export class SourceActionService {
	private readonly router: Pick<MarvinRouter, "addTask">;
	private readonly store: SourceActionStore;
	private readonly now: () => number;
	private readonly requestId: () => string;
	private readonly inFlight = new Map<string, Promise<EnsureSourceActionResult>>();

	constructor(options: SourceActionServiceOptions) {
		this.router = options.router;
		this.store = options.store;
		this.now = options.now ?? Date.now;
		this.requestId = options.requestId ?? defaultRequestId;
	}

	ensure(request: EnsureSourceActionRequest): Promise<EnsureSourceActionResult> {
		const key = normalizeKey(request);
		if (!request.task.title?.trim()) {
			throw new Error("A source action task title is required");
		}

		const serializedKey = JSON.stringify([key.sourceKey, key.actionKey]);
		const existing = this.inFlight.get(serializedKey);
		if (existing) {
			return existing;
		}

		const pending = this.ensureOnce({
			...request,
			...key,
			task: {
				...request.task,
				title: request.task.title.trim(),
			},
		}).finally(() => {
			this.inFlight.delete(serializedKey);
		});
		this.inFlight.set(serializedKey, pending);
		return pending;
	}

	async resolvePending(
		request: ResolvePendingSourceActionRequest,
	): Promise<EnsureSourceActionResult> {
		const key = normalizeKey(request);
		const taskId = request.taskId.trim();
		if (!taskId) {
			throw new Error("A Marvin task ID is required to resolve a source action");
		}
		const existing = await this.store.get(key);
		if (existing?.state === "linked") {
			if (existing.taskId !== taskId) {
				throw new Error(
					`Source action is already linked to Marvin task ${existing.taskId}`,
				);
			}
			return resultFromRecord(existing, false);
		}
		if (!existing) {
			throw new Error("No pending source action exists to resolve");
		}

		const linked = this.linkedRecord(
			existing,
			taskId,
			request.title?.trim() || existing.title,
		);
		await this.store.set(linked);
		return resultFromRecord(linked, false);
	}

	async clearPending(keyInput: SourceActionKey): Promise<void> {
		const key = normalizeKey(keyInput);
		const existing = await this.store.get(key);
		if (existing?.state === "linked") {
			throw new Error(
				`Refusing to clear linked Marvin task ${existing.taskId}; only pending source actions can be cleared`,
			);
		}
		if (existing) {
			await this.store.delete(key);
		}
	}

	private async ensureOnce(
		request: EnsureSourceActionRequest,
	): Promise<EnsureSourceActionResult> {
		const key = normalizeKey(request);
		const existing = await this.store.get(key);
		if (existing?.state === "linked") {
			return resultFromRecord(existing, false);
		}
		if (existing) {
			throw new SourceActionError({
				code: "pending",
				message:
					`Source action ${existing.actionKey} has an unresolved Marvin creation attempt. `
					+ "Inspect Marvin, then resolve or clear the pending association before retrying.",
				record: existing,
			});
		}

		const pending: PendingSourceActionRecord = {
			version: 1,
			state: "pending",
			...key,
			title: request.task.title,
			requestId: this.requestId(),
			requestedAt: this.now(),
		};
		await this.store.set(pending);

		let task: Task;
		try {
			task = await this.router.addTask(request.task);
		} catch (cause) {
			if (isDefiniteRejection(cause)) {
				try {
					await this.store.delete(key);
				} catch (deleteCause) {
					throw new SourceActionError({
						code: "creation-uncertain",
						message:
							"Marvin rejected task creation, but the pending association could not be cleared. Clear it before retrying.",
						record: pending,
						cause: deleteCause,
					});
				}
				throw cause;
			}
			throw new SourceActionError({
				code: "creation-uncertain",
				message:
					"Marvin task creation did not complete cleanly. The pending association was retained to prevent a duplicate.",
				record: pending,
				cause,
			});
		}

		const linked = this.linkedRecord(pending, task._id, task.title);
		try {
			await this.store.set(linked);
		} catch (cause) {
			throw new SourceActionError({
				code: "association-write-failed",
				message:
					`Marvin task ${task._id} was created, but its source association could not be persisted. `
					+ "Resolve the pending association with this task ID before retrying.",
				record: pending,
				task,
				cause,
			});
		}

		return {
			...resultFromRecord(linked, true),
			task,
		};
	}

	private linkedRecord(
		pending: PendingSourceActionRecord,
		taskId: string,
		title: string,
	): LinkedSourceActionRecord {
		if (!taskId) {
			throw new Error("A Marvin task ID is required to resolve a source action");
		}
		return {
			...pending,
			state: "linked",
			title,
			taskId,
			deepLink: marvinDeepLink({ _id: taskId, type: "task" }),
			linkedAt: this.now(),
		};
	}
}

function normalizeKey(key: SourceActionKey): SourceActionKey {
	const sourceKey = key.sourceKey.trim();
	const actionKey = key.actionKey.trim();
	if (!sourceKey) {
		throw new Error("A stable source key is required");
	}
	if (!actionKey) {
		throw new Error("A stable action key is required");
	}
	return { sourceKey, actionKey };
}

function resultFromRecord(
	record: LinkedSourceActionRecord,
	created: boolean,
): EnsureSourceActionResult {
	return {
		created,
		taskId: record.taskId,
		deepLink: record.deepLink,
		title: record.title,
		record,
	};
}

function defaultRequestId(): string {
	return globalThis.crypto?.randomUUID?.()
		?? `source-action-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isDefiniteRejection(error: unknown): boolean {
	return error instanceof MarvinError
		&& error.status !== undefined
		&& error.status >= 400
		&& error.status < 500
		&& error.status !== 408;
}
