import type {
	MarvinErrorSummary,
	MarvinOrigin,
} from "./types.js";

export interface MarvinCachePolicy {
	freshTtlMs: number;
	staleIfErrorMs: number;
}

export interface MarvinCacheEntry<T> {
	data: T;
	origin: Exclude<MarvinOrigin, "mixed">;
	fetchedAt: number;
	expiresAt: number;
	staleUntil: number;
	warnings: MarvinErrorSummary[];
}

export class MarvinReadCache {
	private readonly entries = new Map<string, MarvinCacheEntry<unknown>>();

	constructor(private readonly maximumEntries = 128) {
		if (maximumEntries <= 0) {
			throw new Error("Cache maximum entries must be greater than zero");
		}
	}

	get<T>(key: string, now: number): MarvinCacheEntry<T> | undefined {
		const entry = this.entries.get(key) as MarvinCacheEntry<T> | undefined;
		if (!entry) {
			return undefined;
		}
		if (entry.staleUntil <= now) {
			this.entries.delete(key);
			return undefined;
		}

		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry;
	}

	set<T>(
		key: string,
		value: {
			data: T;
			origin: Exclude<MarvinOrigin, "mixed">;
			fetchedAt: number;
			warnings: MarvinErrorSummary[];
		},
		policy: MarvinCachePolicy,
	): void {
		const entry: MarvinCacheEntry<T> = {
			...value,
			expiresAt: value.fetchedAt + policy.freshTtlMs,
			staleUntil: value.fetchedAt + policy.freshTtlMs + policy.staleIfErrorMs,
		};
		this.entries.delete(key);
		this.entries.set(key, entry);

		while (this.entries.size > this.maximumEntries) {
			const oldest = this.entries.keys().next().value as string | undefined;
			if (oldest === undefined) {
				break;
			}
			this.entries.delete(oldest);
		}
	}

	invalidatePrefixes(prefixes: string[]): void {
		for (const key of this.entries.keys()) {
			if (prefixes.some((prefix) => key.startsWith(prefix))) {
				this.entries.delete(key);
			}
		}
	}

	clear(): void {
		this.entries.clear();
	}
}
