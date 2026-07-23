import type { MarvinReadResult } from "@open-horizon/marvin-client";

import {
	refreshTodayRegion,
	type TodayProjectionItem,
} from "./todayProjection";

export interface RunTodayProjectionOptions<T> {
	date: string;
	read: () => Promise<MarvinReadResult<T[]>>;
	project: (items: T[]) => TodayProjectionItem[];
	process: (update: (content: string) => string) => Promise<void>;
}

export interface TodayProjectionWorkflowResult<T> {
	read: MarvinReadResult<T[]>;
	projection: ReturnType<typeof refreshTodayRegion>;
}

/**
 * Keeps the network read before the atomic note mutation. A failed read never
 * invokes the note processor and therefore cannot be mistaken for an empty
 * successful projection.
 */
export async function runTodayProjection<T>(
	options: RunTodayProjectionOptions<T>,
): Promise<TodayProjectionWorkflowResult<T>> {
	const read = await options.read();
	const items = options.project(read.data);
	let projection: ReturnType<typeof refreshTodayRegion> | undefined;
	await options.process((content) => {
		projection = refreshTodayRegion(content, {
			date: options.date,
			items,
		});
		return projection.content;
	});
	if (!projection) {
		throw new Error("The Today note processor did not run");
	}
	return { read, projection };
}
