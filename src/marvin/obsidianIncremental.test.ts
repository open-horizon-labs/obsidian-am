import { describe, expect, it } from "vitest";

import {
	ObsidianIncrementalCacheStore,
	type IncrementalFileAdapter,
} from "./obsidianIncremental";
import type { IncrementalCacheState } from "./incrementalCache";

class MemoryAdapter implements IncrementalFileAdapter {
	readonly files = new Map<string, string>();

	async exists(path: string) {
		return this.files.has(path);
	}

	async read(path: string) {
		const value = this.files.get(path);
		if (value === undefined) {
			throw new Error("missing");
		}
		return value;
	}

	async write(path: string, data: string) {
		this.files.set(path, data);
	}

	async process(path: string, update: (data: string) => string) {
		const value = update(await this.read(path));
		this.files.set(path, value);
		return value;
	}

	async remove(path: string) {
		this.files.delete(path);
	}
}

const state: IncrementalCacheState = {
	version: 1,
	sourceKey: "source",
	lastSeq: { opaque: true },
	categories: [],
	children: {},
	lastSuccessfulSyncAt: 1_000,
	projectionPending: false,
};

describe("Obsidian incremental cache store", () => {
	it("persists opaque checkpoints without database credentials", async () => {
		const adapter = new MemoryAdapter();
		const store = new ObsidianIncrementalCacheStore(
			adapter,
			".obsidian/plugins/cloudatlas-o-am",
		);

		await store.save(state);
		const serialized = adapter.files.get(store.path) ?? "";

		expect(await store.load()).toEqual(state);
		expect(serialized).not.toContain("password");
		await store.clear();
		expect(await store.load()).toBeUndefined();
	});

	it("surfaces a recoverable corrupt-cache error", async () => {
		const adapter = new MemoryAdapter();
		const store = new ObsidianIncrementalCacheStore(adapter, "plugin");
		adapter.files.set(store.path, "{");

		await expect(store.load()).rejects.toThrow("reset it");
	});
});
