import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
	MarvinError,
	MarvinRouteError,
	type Label,
	type MarvinRouter,
	type TaskOrProject,
	marvinDeepLink,
} from "@open-horizon/marvin-client";

export type MarvinOperations = Pick<
	MarvinRouter,
	"getTodayItems" | "getDueItems" | "getLabels" | "addTask" | "markDone"
>;

const dateSchema = z.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
	.optional();

function itemForTool(item: TaskOrProject) {
	return {
		id: item._id,
		title: item.title,
		type: item.type ?? "task",
		done: item.done ?? false,
		deepLink: marvinDeepLink(item),
		...(item.parentId === undefined ? {} : { parentId: item.parentId }),
		...(item.day === undefined ? {} : { day: item.day }),
		...(item.dueDate === undefined ? {} : { dueDate: item.dueDate }),
		...(item.startDate === undefined ? {} : { startDate: item.startDate }),
		...(item.note === undefined ? {} : { note: item.note }),
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

function readSuccess(result: Awaited<ReturnType<MarvinOperations["getTodayItems"]>>) {
	const { data, ...metadata } = result;
	return success({
		...metadata,
		items: data.map(itemForTool),
	});
}

function failure(error: unknown) {
	const details = error instanceof MarvinRouteError
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

export function createMarvinMcpServer(
	operations: MarvinOperations,
): McpServer {
	const server = new McpServer({
		name: "amazing-marvin",
		version: "0.1.0",
	});

	server.registerTool("marvin_today", {
		title: "Amazing Marvin Today",
		description: "Read tasks and projects scheduled for a date in Amazing Marvin.",
		inputSchema: {
			date: dateSchema.describe("Optional date; defaults to Marvin's server date"),
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: true,
		},
	}, async ({ date }) => {
		try {
			return readSuccess(await operations.getTodayItems(date));
		} catch (error) {
			return failure(error);
		}
	});

	server.registerTool("marvin_due", {
		title: "Amazing Marvin Due",
		description: "Read open tasks and projects due on or before a date.",
		inputSchema: {
			date: dateSchema.describe("Optional inclusive due date; defaults to Marvin's server date"),
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: true,
		},
	}, async ({ date }) => {
		try {
			return readSuccess(await operations.getDueItems(date));
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
			const task = await operations.addTask({
				title: input.title,
				timeZoneOffset: new Date().getTimezoneOffset() * -1,
				...(input.parentId === undefined ? {} : { parentId: input.parentId }),
				...(input.labelIds === undefined ? {} : { labelIds: input.labelIds }),
				...(input.day === undefined ? {} : { day: input.day }),
				...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
				...(input.note === undefined ? {} : { note: input.note }),
				...(input.timeEstimate === undefined ? {} : { timeEstimate: input.timeEstimate }),
			});
			return success({ task: itemForTool(task) });
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
