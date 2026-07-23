import type { App, TFile } from "obsidian";
import type {
	LinkedSourceActionRecord,
	SourceActionKey,
	SourceActionRecord,
	SourceActionStore,
} from "@open-horizon/marvin-client";

export const SOURCE_ACTIONS_FRONTMATTER_KEY = "amazing-marvin-actions";

interface StoredSourceActionRecord {
	version: 1;
	state: "pending" | "linked";
	actionKey: string;
	title: string;
	requestId: string;
	requestedAt: number;
	taskId?: string;
	deepLink?: string;
	linkedAt?: number;
}

export interface SourceActionLink {
	taskId: string;
	sourcePath: string;
	sourceTitle: string;
	actionKey: string;
	deepLink: string;
}

const DELETED = Symbol("deleted-source-action");

export class ObsidianSourceActionStore implements SourceActionStore {
	private readonly overlay = new Map<string, SourceActionRecord | typeof DELETED>();
	private linkedIndex?: Map<string, SourceActionLink>;
	private indexedSourcePaths = new Set<string>();

	constructor(private readonly app: App) {}

	async get(key: SourceActionKey): Promise<SourceActionRecord | undefined> {
		const overlay = this.overlay.get(serializedKey(key));
		if (overlay === DELETED) {
			return undefined;
		}
		if (overlay) {
			return overlay;
		}
		const file = this.requireMarkdownFile(key.sourceKey);
		return readSourceActionRecords(
			this.app.metadataCache.getFileCache(file)?.frontmatter,
			file.path,
		).find((record) => record.actionKey === key.actionKey);
	}

	async set(record: SourceActionRecord): Promise<void> {
		const file = this.requireMarkdownFile(record.sourceKey);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const records = readSourceActionRecords(frontmatter, file.path);
			const next = records.filter(
				(candidate) => candidate.actionKey !== record.actionKey,
			);
			next.push(record);
			frontmatter[SOURCE_ACTIONS_FRONTMATTER_KEY] = next.map(toStoredRecord);
		});
		this.overlay.set(serializedKey(record), record);
		this.linkedIndex = undefined;
	}

	async delete(key: SourceActionKey): Promise<void> {
		const file = this.requireMarkdownFile(key.sourceKey);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const records = readSourceActionRecords(frontmatter, file.path);
			const next = records.filter(
				(candidate) => candidate.actionKey !== key.actionKey,
			);
			if (next.length === 0) {
				delete frontmatter[SOURCE_ACTIONS_FRONTMATTER_KEY];
			} else {
				frontmatter[SOURCE_ACTIONS_FRONTMATTER_KEY] = next.map(toStoredRecord);
			}
		});
		this.overlay.set(serializedKey(key), DELETED);
		this.linkedIndex = undefined;
	}

	findLinkedTasks(taskIds: Iterable<string>): Map<string, SourceActionLink> {
		this.linkedIndex ??= this.buildLinkedIndex();
		const links = new Map<string, SourceActionLink>();
		for (const taskId of taskIds) {
			const link = this.linkedIndex.get(taskId);
			if (link) {
				links.set(taskId, link);
			}
		}
		return links;
	}

	invalidateIndex(clearOverlay = false): void {
		this.linkedIndex = undefined;
		if (clearOverlay) {
			this.overlay.clear();
		}
	}

	shouldInvalidateFor(
		sourcePath: string,
		frontmatter: Record<string, unknown> | undefined,
	): boolean {
		if (
			frontmatter
			&& Object.prototype.hasOwnProperty.call(
				frontmatter,
				SOURCE_ACTIONS_FRONTMATTER_KEY,
			)
		) {
			return true;
		}
		if (this.indexedSourcePaths.has(sourcePath)) {
			return true;
		}
		for (const key of this.overlay.keys()) {
			const [overlaySource] = JSON.parse(key) as [string, string];
			if (overlaySource === sourcePath) {
				return true;
			}
		}
		return false;
	}

	private buildLinkedIndex(): Map<string, SourceActionLink> {
		const links = new Map<string, SourceActionLink>();
		this.indexedSourcePaths = new Set<string>();
		const files = [...this.app.vault.getMarkdownFiles()]
			.sort((left, right) => left.path.localeCompare(right.path));
		for (const file of files) {
			const records = this.recordsForFile(file);
			if (records.length > 0) {
				this.indexedSourcePaths.add(file.path);
			}
			for (const record of records) {
				if (
					record.state !== "linked"
					|| links.has(record.taskId)
				) {
					continue;
				}
				links.set(record.taskId, {
					taskId: record.taskId,
					sourcePath: file.path,
					sourceTitle: file.basename,
					actionKey: record.actionKey,
					deepLink: record.deepLink,
				});
			}
		}
		return links;
	}

	private recordsForFile(file: TFile): SourceActionRecord[] {
		const records = new Map(
			readSourceActionRecords(
				this.app.metadataCache.getFileCache(file)?.frontmatter,
				file.path,
			).map((record) => [record.actionKey, record]),
		);
		for (const [key, overlay] of this.overlay) {
			const [sourceKey, actionKey] = JSON.parse(key) as [string, string];
			if (sourceKey !== file.path) {
				continue;
			}
			if (overlay === DELETED) {
				records.delete(actionKey);
			} else {
				records.set(actionKey, overlay);
			}
		}
		return [...records.values()];
	}

	private requireMarkdownFile(path: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file || !("extension" in file) || file.extension !== "md") {
			throw new Error(`Obsidian source note not found: ${path}`);
		}
		return file as TFile;
	}
}

export function readSourceActionRecords(
	frontmatter: Record<string, unknown> | undefined,
	sourceKey: string,
): SourceActionRecord[] {
	const value = frontmatter?.[SOURCE_ACTIONS_FRONTMATTER_KEY];
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error(
			`${SOURCE_ACTIONS_FRONTMATTER_KEY} in ${sourceKey} must be a list`,
		);
	}
	return value.map((entry, index) => fromStoredRecord(entry, sourceKey, index));
}

function fromStoredRecord(
	value: unknown,
	sourceKey: string,
	index: number,
): SourceActionRecord {
	if (
		typeof value !== "object"
		|| value === null
		|| (value as Partial<StoredSourceActionRecord>).version !== 1
		|| !["pending", "linked"].includes(
			(value as Partial<StoredSourceActionRecord>).state ?? "",
		)
		|| typeof (value as Partial<StoredSourceActionRecord>).actionKey !== "string"
		|| typeof (value as Partial<StoredSourceActionRecord>).title !== "string"
		|| typeof (value as Partial<StoredSourceActionRecord>).requestId !== "string"
		|| typeof (value as Partial<StoredSourceActionRecord>).requestedAt !== "number"
	) {
		throw new Error(
			`Invalid ${SOURCE_ACTIONS_FRONTMATTER_KEY} entry ${index + 1} in ${sourceKey}`,
		);
	}
	const stored = value as StoredSourceActionRecord;
	const base = {
		version: 1 as const,
		sourceKey,
		actionKey: stored.actionKey,
		title: stored.title,
		requestId: stored.requestId,
		requestedAt: stored.requestedAt,
	};
	if (stored.state === "pending") {
		return { ...base, state: "pending" };
	}
	if (
		typeof stored.taskId !== "string"
		|| typeof stored.deepLink !== "string"
		|| typeof stored.linkedAt !== "number"
	) {
		throw new Error(
			`Invalid linked ${SOURCE_ACTIONS_FRONTMATTER_KEY} entry ${index + 1} in ${sourceKey}`,
		);
	}
	return {
		...base,
		state: "linked",
		taskId: stored.taskId,
		deepLink: stored.deepLink,
		linkedAt: stored.linkedAt,
	};
}

function toStoredRecord(record: SourceActionRecord): StoredSourceActionRecord {
	const base: StoredSourceActionRecord = {
		version: 1,
		state: record.state,
		actionKey: record.actionKey,
		title: record.title,
		requestId: record.requestId,
		requestedAt: record.requestedAt,
	};
	if (record.state === "linked") {
		base.taskId = record.taskId;
		base.deepLink = record.deepLink;
		base.linkedAt = record.linkedAt;
	}
	return base;
}

function serializedKey(key: SourceActionKey): string {
	return JSON.stringify([key.sourceKey, key.actionKey]);
}

export function isLinkedSourceAction(
	record: SourceActionRecord,
): record is LinkedSourceActionRecord {
	return record.state === "linked";
}
