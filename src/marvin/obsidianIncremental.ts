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

	constructor(
		private readonly adapter: IncrementalFileAdapter,
		pluginDirectory: string,
	) {
		this.path = normalizeAdapterPath(
			`${pluginDirectory}/marvin-incremental-cache-v1.json`,
		);
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
