import type {
	AddTaskRequest,
	EnsureSourceActionResult,
	MarvinReadResult,
	ResolvePendingSourceActionRequest,
	TaskOrProject,
} from "@open-horizon/marvin-client";

export interface EnsureTaskForSourceInput {
	sourcePath: string;
	actionKey: string;
	title: string;
	parentId?: string;
	day?: string;
	dueDate?: string;
	labelIds?: string[];
	note?: string;
}

export interface RefreshTodayTasksInput {
	date: string;
	filePath?: string;
}

export interface RefreshTodayTasksResult {
	date: string;
	filePath: string;
	changed: boolean;
	createdRegion: boolean;
	morningIds: string[];
	lateIds: string[];
	freshness: MarvinReadResult<unknown>["freshness"];
	origin: MarvinReadResult<unknown>["origin"];
	warnings: MarvinReadResult<unknown>["warnings"];
}

/**
 * Stable automation surface for Templater and other in-Obsidian callers.
 *
 * Access it as:
 * `app.plugins.plugins["cloudatlas-o-am"].api`
 */
export interface AmazingMarvinApi {
	getToday(date: string): Promise<MarvinReadResult<TaskOrProject[]>>;
	getDue(date: string): Promise<MarvinReadResult<TaskOrProject[]>>;
	getTodayAndDue(date: string): Promise<MarvinReadResult<TaskOrProject[]>>;
	createTask(task: AddTaskRequest): Promise<TaskOrProject>;
	ensureTaskForSource(
		input: EnsureTaskForSourceInput,
	): Promise<EnsureSourceActionResult>;
	resolvePendingSourceAction(
		input: Omit<ResolvePendingSourceActionRequest, "sourceKey"> & {
			sourcePath: string;
		},
	): Promise<EnsureSourceActionResult>;
	clearPendingSourceAction(input: {
		sourcePath: string;
		actionKey: string;
	}): Promise<void>;
	refreshTodayTasks(
		input: RefreshTodayTasksInput,
	): Promise<RefreshTodayTasksResult>;
}
