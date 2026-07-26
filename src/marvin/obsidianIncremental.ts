import {
	INCREMENTAL_CACHE_FILENAME,
	INCREMENTAL_SYNC_REQUEST_FILENAME,
} from "@open-horizon/marvin-client";

import type {
	CouchChangesTransport,
} from "./couchChanges";
import type {
	IncrementalCacheState,
	IncrementalCacheStore,
} from "./incrementalCache";
import type { ObsidianRequestUrl } from "./obsidianTransport";

export interface IncrementalFileAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	process(path: string, update: (data: string) => string): Promise<string>;
	remove(path: string): Promise<void>;
}

export function createObsidianCouchTransport(
	request: ObsidianRequestUrl,
): CouchChangesTransport {
	return {
		async request(input) {
			const response = await request({
				url: input.url,
				method: "GET",
				headers: input.headers,
				throw: false,
			});
			return {
				status: response.status,
				text: response.text,
			};
		},
	};
}

export class ObsidianIncrementalCacheStore implements IncrementalCacheStore {
	readonly path: string;
	/** Where the MCP server drops a sync request for this plugin to pick up. */
	readonly syncRequestPath: string;

	constructor(
		private readonly adapter: IncrementalFileAdapter,
		pluginDirectory: string,
	) {
		this.path = normalizeAdapterPath(
			`${pluginDirectory}/${INCREMENTAL_CACHE_FILENAME}`,
		);
		this.syncRequestPath = normalizeAdapterPath(
			`${pluginDirectory}/${INCREMENTAL_SYNC_REQUEST_FILENAME}`,
		);
	}

	/** Consumes a pending MCP sync request, returning whether one was there.
	 * Deleted before syncing, not after: if the sync fails, the requester's
	 * bounded wait should time out and fall back to REST rather than have
	 * the plugin retry the same request on its next tick forever. */
	async consumeSyncRequest(): Promise<boolean> {
		if (!await this.adapter.exists(this.syncRequestPath)) {
			return false;
		}
		await this.adapter.remove(this.syncRequestPath);
		return true;
	}

	async load(): Promise<unknown> {
		if (!await this.adapter.exists(this.path)) {
			return undefined;
		}
		const serialized = await this.adapter.read(this.path);
		try {
			return JSON.parse(serialized) as unknown;
		} catch {
			throw new Error(
				"Persistent Amazing Marvin cache is invalid; reset it in plugin settings",
			);
		}
	}

	async save(state: IncrementalCacheState): Promise<void> {
		const serialized = JSON.stringify(state);
		if (await this.adapter.exists(this.path)) {
			await this.adapter.process(this.path, () => serialized);
		} else {
			await this.adapter.write(this.path, serialized);
		}
	}

	async clear(): Promise<void> {
		if (await this.adapter.exists(this.path)) {
			await this.adapter.remove(this.path);
		}
	}
}

function normalizeAdapterPath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\/|\/$/g, "");
}
