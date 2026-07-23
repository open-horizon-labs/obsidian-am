export type MarvinOrigin = "local" | "public" | "mixed";
export type MarvinFreshness = "fresh" | "cached" | "stale";

export interface BaseMarvinItem {
	_id: string;
	_rev?: string;
	createdAt?: number;
	updatedAt?: number;
}

export interface Subtask {
	_id: string;
	title: string;
	done: boolean;
	rank?: number;
	timeEstimate?: number;
}

export interface Task extends BaseMarvinItem {
	title: string;
	done: boolean;
	type?: "task";
	parentId?: string;
	day?: string;
	firstScheduled?: string;
	startDate?: string;
	dueDate?: string;
	endDate?: string;
	doneAt?: number;
	completedAt?: number;
	note?: string;
	labelIds?: string[];
	timeEstimate?: number;
	priority?: string;
	recurring?: boolean;
	isRecurring?: boolean;
	subtasks?: Record<string, Subtask> | Subtask[];
}

export interface Project extends BaseMarvinItem {
	title: string;
	type: "project";
	parentId?: string;
	day?: string;
	firstScheduled?: string;
	startDate?: string;
	dueDate?: string;
	endDate?: string;
	done?: boolean;
	doneDate?: string;
	note?: string;
	labelIds?: string[];
	timeEstimate?: number;
	priority?: "low" | "mid" | "high";
	recurring?: boolean;
}

export interface Category extends BaseMarvinItem {
	title: string;
	type: "category";
	parentId?: string;
	labelIds?: string[];
	startDate?: string;
	dueDate?: string;
	endDate?: string;
	done?: boolean;
	note?: string;
	priority?: string;
	rank?: number;
	recurring?: boolean;
	isRecurring?: boolean;
}

export interface Label extends BaseMarvinItem {
	title: string;
	groupId?: string;
	color?: string;
	icon?: string;
	showAs?: "text" | "icon" | "both";
	isAction?: boolean;
	isHidden?: boolean;
}

export type TaskOrProject = Task | Project;
export type MarvinItem = Task | Project | Category;

export interface AddTaskRequest {
	title: string;
	done?: boolean;
	day?: string;
	parentId?: string;
	labelIds?: string[];
	firstScheduled?: string;
	rank?: number;
	dailySection?: string;
	bonusSection?: string;
	customSection?: string;
	timeBlockSection?: string;
	note?: string;
	dueDate?: string;
	timeEstimate?: number;
	isReward?: boolean;
	isStarred?: boolean | number;
	isFrogged?: boolean | number;
	plannedWeek?: string;
	plannedMonth?: string;
	rewardPoints?: number;
	rewardId?: string;
	backburner?: boolean;
	reviewDate?: string;
	itemSnoozeTime?: number;
	permaSnoozeTime?: string;
	timeZoneOffset?: number;
}

export type MarkDoneResult = Record<string, unknown> | null;

export interface MarvinErrorSummary {
	kind: "http" | "throttle" | "transport" | "parse" | "validation" | "route";
	message: string;
	operation: string;
	origin: Exclude<MarvinOrigin, "mixed">;
	endpoint?: string;
	method?: string;
	status?: number;
	statusText?: string;
	responseBody?: string;
	retryAfterMs?: number;
}

export interface MarvinReadResult<T> {
	data: T;
	freshness: MarvinFreshness;
	origin: MarvinOrigin;
	fetchedAt: number;
	ageMs: number;
	warnings: MarvinErrorSummary[];
}

export interface MarvinTransportRequest {
	url: string;
	method: "GET" | "POST";
	headers: Record<string, string>;
	body?: string;
	timeoutMs: number;
}

export interface MarvinTransportResponse {
	status: number;
	statusText?: string;
	headers: Record<string, string>;
	text: string;
}

export interface MarvinTransport {
	request(request: MarvinTransportRequest): Promise<MarvinTransportResponse>;
}
