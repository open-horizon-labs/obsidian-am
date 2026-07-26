import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
	MarvinError,
	MarvinRouteError,
	type Label,
	type MarvinItem,
	type MarvinReadResult,
	type MarvinRouter,
	marvinDeepLink,
} from "@open-horizon/marvin-client";
import type { CacheRefreshResult } from "./incrementalRefresh.js";

export type MarvinOperations = Pick<
	MarvinRouter,
	| "getTodayItems"
	| "getDueItems"
	| "getCategories"
	| "getChildren"
	| "getLabels"
	| "addTask"
	| "addProject"
	| "markDone"
>;

// Validate dates in the handler rather than the SDK schema path. MCP schema
// failures are emitted as text-only protocol errors before a tool handler can
// return the structured error envelope LLM callers rely on.
const dateSchema = z.string()
	.describe("Date in YYYY-MM-DD format")
	.optional();

class MarvinMcpInputError extends Error {
	constructor(
		readonly field: string,
		message: string,
	) {
		super(message);
		this.name = "MarvinMcpInputError";
	}

	toSummary() {
		return {
			kind: "input",
			field: this.field,
			message: this.message,
		};
	}
}

function requireOptionalDate(
	value: string | undefined,
	field: string,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new MarvinMcpInputError(field, "Use YYYY-MM-DD");
	}
	return value;
}

function itemForTool(item: MarvinItem) {
	return {
		id: item._id,
		title: item.title,
		type: item.type ?? "task",
		done: item.done ?? false,
		deepLink: marvinDeepLink(item),
		...(item.parentId === undefined ? {} : { parentId: item.parentId }),
		...(!("day" in item) || item.day === undefined ? {} : { day: item.day }),
		...(item.dueDate === undefined ? {} : { dueDate: item.dueDate }),
		...(item.startDate === undefined ? {} : { startDate: item.startDate }),
		...(item.note === undefined ? {} : { note: item.note }),
		...(item.labelIds === undefined ? {} : { labelIds: item.labelIds }),
	};
}

function labelForTool(label: Label) {
	return {
		id: label._id,
		title: label.title,
		...(label.groupId === undefined ? {} : { groupId: label.groupId }),
		...(label.color === undefined ? {} : { color: label.color }),
		...(label.icon === undefined ? {} : { icon: label.icon }),
		...(label.isAction === undefined ? {} : { isAction: label.isAction }),
		...(label.isHidden === undefined ? {} : { isHidden: label.isHidden }),
	};
}

function success(structuredContent: Record<string, unknown>) {
	return {
		content: [{
			type: "text" as const,
			text: JSON.stringify(structuredContent, null, 2),
		}],
		structuredContent,
	};
}

function readSuccess(
	result: MarvinReadResult<MarvinItem[]>,
	refresh?: CacheRefreshResult,
) {
	const { data, ...metadata } = result;
	return success({
		...metadata,
		// Only present when the caller asked for a refresh. freshness/origin
		// say where the answer came from; this says whether the refresh they
		// requested actually ran, which is what tells them a cache hit is
		// newly synchronized rather than a silent timeout that fell back.
		...(refresh ? { refresh } : {}),
		items: data.map(itemForTool),
	});
}

function failure(error: unknown) {
	const details = error instanceof MarvinMcpInputError
		? error.toSummary()
		: error instanceof MarvinRouteError
		? {
			message: error.message,
			attempts: error.attempts.map((attempt) => attempt.toSummary()),
		}
		: error instanceof MarvinError
			? error.toSummary()
			: {
				message: error instanceof Error ? error.message : String(error),
			};

	return {
		isError: true,
		content: [{
			type: "text" as const,
			text: JSON.stringify({ error: details }, null, 2),
		}],
		structuredContent: { error: details },
	};
}

export interface MarvinMcpServerOptions {
	/** Asks the running Obsidian plugin to sync its incremental cache and
	 * waits, bounded, before the read proceeds. Only wired when a cache path
	 * is configured; the `refresh` tool parameter reports `skipped` without
	 * it. */
	requestCacheRefresh?: () => Promise<CacheRefreshResult>;
}

export function createMarvinMcpServer(
	operations: MarvinOperations,
	options: MarvinMcpServerOptions = {},
): McpServer {
	// Exposed as a per-call parameter rather than a server-wide setting: the
	// caller knows whether this particular question needs current data
	// ("did my task land?") or tolerates a cached answer ("what's in Work?").
	// Defaults to false so the passive, zero-latency read stays the norm.
	const refreshSchema = z.boolean().optional().describe(
		"Ask Obsidian to sync its Marvin cache first and wait briefly. Only "
		+ "affects setups using the plugin's incremental cache; falls through "
		+ "to the normal read if Obsidian isn't running. Default false.",
	);

	const maybeRefresh = async (
		refresh: boolean | undefined,
	): Promise<CacheRefreshResult | undefined> => {
		if (!refresh) {
			return undefined;
		}
		if (!options.requestCacheRefresh) {
			return {
				requested: true,
				outcome: "skipped",
				waitedMs: 0,
				reason: "no incremental cache is configured for this server",
			};
		}
		return options.requestCacheRefresh();
	};
	const server = new McpServer({
		name: "amazing-marvin",
		version: "0.1.0",
	});

	server.registerTool("marvin_today", {
		title: "Amazing Marvin Today",
		description: "Read tasks and projects scheduled for a date in Amazing Marvin.",
		inputSchema: {
			date: dateSchema.describe(
				"Optional YYYY-MM-DD date; defaults to Marvin's server date",
			),
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: true,
		},
	}, async ({ date }) => {
		try {
			return readSuccess(await operations.getTodayItems(
				requireOptionalDate(date, "date"),
			));
		} catch (error) {
			return failure(error);
		}
	});

	server.registerTool("marvin_due", {
		title: "Amazing Marvin Due",
		description: "Read open tasks and projects due on or before a date.",
		inputSchema: {
			date: dateSchema.describe(
				"Optional inclusive YYYY-MM-DD date; defaults to Marvin's server date",
			),
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: true,
		},
	}, async ({ date }) => {
		try {
			return readSuccess(await operations.getDueItems(
				requireOptionalDate(date, "date"),
			));
		} catch (error) {
			return failure(error);
		}
	});

	server.registerTool("marvin_categories", {
		title: "Amazing Marvin Categories and Projects",
		description: "Read stable category/project IDs and their parent hierarchy.",
		inputSchema: {
			refresh: refreshSchema,
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: true,
		},
	}, async ({ refresh }) => {
		try {
			const refreshResult = await maybeRefresh(refresh);
			return readSuccess(await operations.getCategories(), refreshResult);
		} catch (error) {
			return failure(error);
		}
	});

	server.registerTool("marvin_children", {
		title: "Amazing Marvin Children",
		description: "Read direct tasks and projects below one stable parent ID.",
		inputSchema: {
			parentId: z.string().trim().min(1)
				.describe("Category/project ID, or unassigned for Inbox"),
			refresh: refreshSchema,
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: true,
		},
	}, async ({ parentId, refresh }) => {
		try {
			const refreshResult = await maybeRefresh(refresh);
			return readSuccess(await operations.getChildren(parentId), refreshResult);
		} catch (error) {
			return failure(error);
		}
	});

	server.registerTool("marvin_labels", {
		title: "Amazing Marvin Labels",
		description: "Read stable label IDs and titles for task creation and filtering.",
		inputSchema: {},
		annotations: {
			readOnlyHint: true,
			openWorldHint: true,
		},
	}, async () => {
		try {
			const { data, ...metadata } = await operations.getLabels();
			return success({
				...metadata,
				labels: data.map(labelForTool),
			});
		} catch (error) {
			return failure(error);
		}
	});

	server.registerTool("marvin_create_task", {
		title: "Create Amazing Marvin Task",
		description: "Create one task in Amazing Marvin with the limited API token.",
		inputSchema: {
			title: z.string().trim().min(1).describe("Task title; Marvin shortcuts are supported"),
			parentId: z.string().trim().min(1).optional(),
			labelIds: z.array(z.string().trim().min(1)).optional()
				.describe("Stable IDs returned by marvin_labels"),
			day: dateSchema,
			dueDate: dateSchema,
			note: z.string().optional(),
			timeEstimate: z.number().int().nonnegative().optional()
				.describe("Estimated duration in milliseconds"),
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
	}, async (input) => {
		try {
			const day = requireOptionalDate(input.day, "day");
			const dueDate = requireOptionalDate(input.dueDate, "dueDate");
			const task = await operations.addTask({
				title: input.title,
				timeZoneOffset: new Date().getTimezoneOffset() * -1,
				...(input.parentId === undefined ? {} : { parentId: input.parentId }),
				...(input.labelIds === undefined ? {} : { labelIds: input.labelIds }),
				...(day === undefined ? {} : { day }),
				...(dueDate === undefined ? {} : { dueDate }),
				...(input.note === undefined ? {} : { note: input.note }),
				...(input.timeEstimate === undefined ? {} : { timeEstimate: input.timeEstimate }),
			});
			return success({ task: itemForTool(task) });
		} catch (error) {
			return failure(error);
		}
	});

	server.registerTool("marvin_create_project", {
		title: "Create Amazing Marvin Project",
		description:
			"Create one project in Amazing Marvin with the limited API token. "
			+ "Use this to make a container before creating tasks inside it.",
		inputSchema: {
			title: z.string().trim().min(1).describe("Project title"),
			parentId: z.string().trim().min(1).optional()
				.describe("Parent category/project ID from marvin_categories"),
			labelIds: z.array(z.string().trim().min(1)).optional()
				.describe("Stable IDs returned by marvin_labels"),
			day: dateSchema,
			dueDate: dateSchema,
			note: z.string().optional(),
			priority: z.enum(["high", "mid", "low"]).optional()
				.describe("Projects support priority; tasks do not"),
			timeEstimate: z.number().int().nonnegative().optional()
				.describe("Estimated duration in milliseconds"),
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
	}, async (input) => {
		try {
			const day = requireOptionalDate(input.day, "day");
			const dueDate = requireOptionalDate(input.dueDate, "dueDate");
			const result = await operations.addProject({
				title: input.title,
				timeZoneOffset: new Date().getTimezoneOffset() * -1,
				...(input.parentId === undefined ? {} : { parentId: input.parentId }),
				...(input.labelIds === undefined ? {} : { labelIds: input.labelIds }),
				...(day === undefined ? {} : { day }),
				...(dueDate === undefined ? {} : { dueDate }),
				...(input.note === undefined ? {} : { note: input.note }),
				...(input.priority === undefined ? {} : { priority: input.priority }),
				...(input.timeEstimate === undefined ? {} : { timeEstimate: input.timeEstimate }),
			});
			// Marvin documents that addProject will return the new _id/_rev
			// "in the future", so today a success can come back without one.
			// Reported as created-but-unidentified rather than as an error:
			// the project exists, and a caller that treats this as a failure
			// would retry and create a duplicate.
			if (result.project) {
				return success({
					created: true,
					project: itemForTool(result.project),
				});
			}
			return success({
				created: true,
				idUnavailable: true,
				note:
					"Amazing Marvin did not return the new project's ID. The project "
					+ "was created; call marvin_categories to find it rather than "
					+ "retrying this call, which would create a duplicate.",
			});
		} catch (error) {
			return failure(error);
		}
	});

	server.registerTool("marvin_mark_done", {
		title: "Complete Amazing Marvin Task",
		description: "Mark one Amazing Marvin task or project complete by stable ID.",
		inputSchema: {
			itemId: z.string().trim().min(1).describe("Stable Amazing Marvin item ID"),
			timeZoneOffset: z.number().int().optional()
				.describe("Minutes from UTC; defaults to the MCP process timezone"),
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
	}, async ({ itemId, timeZoneOffset }) => {
		try {
			const result = await operations.markDone(
				itemId,
				timeZoneOffset ?? new Date().getTimezoneOffset() * -1,
			);
			return success({
				itemId,
				result,
			});
		} catch (error) {
			return failure(error);
		}
	});

	return server;
}
