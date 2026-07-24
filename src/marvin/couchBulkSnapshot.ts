import type {
	CouchChangesCredentials,
	CouchChangesTransport,
	MarvinDatabaseDocument,
} from "./couchChanges";
import {
	type CachedMarvinContainer,
	type CachedMarvinItem,
	type IncrementalSnapshotSource,
	categoryFromDocument,
	isPresentDocument,
	taskFromDocument,
} from "./incrementalCache";

// Hydration via one-category-at-a-time REST calls inherits whatever
// throttling budget the REST API is under — confirmed (Amazing Marvin
// support correspondence, observed 429/Retry-After) to be shared across
// endpoints, not limited to this N+1 pattern. Once the separate database
// credentials are already in use for the steady-state _changes feed, bulk
// _all_docs hydration removes REST from this path entirely: one paginated
// read instead of one call per category.
//
// _all_docs returns every document type in the database (Tasks, Categories,
// Events, Goals, PlannerItems, SmartLists, SavedItems, RecurringTasks,
// ProfileItems, DayItems — confirmed against a real export), including an
// account `email` field and calendar URLs on non-Task/Category docs. This
// filters to the relevant db types before anything is mapped or persisted,
// not just before display.

export class CouchBulkError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "CouchBulkError";
	}
}

export class CouchBulkClient {
	private readonly databaseUrl: URL;
	private readonly authorization: string;

	constructor(
		credentials: CouchChangesCredentials,
		private readonly transport: CouchChangesTransport,
	) {
		this.databaseUrl = validatedDatabaseUrl(credentials.databaseUri);
		if (!credentials.databaseUser.trim() || !credentials.databasePassword) {
			throw new Error("Amazing Marvin database user and password are required");
		}
		this.authorization = `Basic ${base64Utf8(
			`${credentials.databaseUser}:${credentials.databasePassword}`,
		)}`;
	}

	/** Pages through the whole database once. CouchDB's own pagination
	 * recipe: re-request the boundary row and skip exactly one, rather than
	 * deep-skip pagination (documented as an unnecessarily expensive full
	 * scan for large `skip` values). */
	async *allDocs(pageSize = 500): AsyncGenerator<MarvinDatabaseDocument[]> {
		let startkey: string | undefined;
		for (;;) {
			const url = new URL(
				`${this.databaseUrl.pathname.replace(/\/+$/, "")}/_all_docs`,
				this.databaseUrl,
			);
			url.searchParams.set("include_docs", "true");
			url.searchParams.set("limit", String(pageSize));
			if (startkey !== undefined) {
				url.searchParams.set("startkey", JSON.stringify(startkey));
				url.searchParams.set("skip", "1");
			}

			let response: { status: number; text: string };
			try {
				response = await this.transport.request({
					url: url.toString(),
					headers: { Accept: "application/json", Authorization: this.authorization },
				});
			} catch {
				throw new CouchBulkError("Could not reach the Amazing Marvin database");
			}
			if (response.status < 200 || response.status >= 300) {
				throw new CouchBulkError(
					`Amazing Marvin _all_docs failed with HTTP ${response.status}`,
					response.status,
				);
			}

			const page = parseAllDocsPage(response.text, response.status);
			const rows = page.rows.filter((row) => !row.id.startsWith("_design/") && row.doc);
			yield rows.map((row) => row.doc as MarvinDatabaseDocument);

			if (rows.length < pageSize) {
				return;
			}
			startkey = rows.at(-1)!.id;
		}
	}
}

/** IncrementalSnapshotSource backed by one bulk _all_docs read instead of a
 * REST call per category. Loaded once and cached for the lifetime of this
 * instance — callers construct a fresh one per hydration. */
export class CouchBulkSnapshotSource implements IncrementalSnapshotSource {
	private loaded: Promise<{
		categories: CachedMarvinContainer[];
		byParentId: Map<string, CachedMarvinItem[]>;
	}> | undefined;

	constructor(private readonly client: CouchBulkClient) {}

	async getCategories(): Promise<CachedMarvinContainer[]> {
		return (await this.load()).categories;
	}

	async getChildren(parentId: string): Promise<CachedMarvinItem[]> {
		return (await this.load()).byParentId.get(parentId) ?? [];
	}

	private load() {
		this.loaded ??= this.loadOnce();
		return this.loaded;
	}

	private async loadOnce() {
		const categories: CachedMarvinContainer[] = [];
		const byParentId = new Map<string, CachedMarvinItem[]>();

		for await (const page of this.client.allDocs()) {
			for (const doc of page) {
				if (!isPresentDocument(doc)) {
					continue;
				}
				if (doc.db === "Categories") {
					const category = categoryFromDocument(doc);
					if (category) {
						categories.push(category);
						if (category.parentId) {
							addChild(byParentId, category.parentId, category);
						}
					}
					continue;
				}
				if (doc.db === "Tasks" && doc.done !== true) {
					const task = taskFromDocument(doc);
					if (task && task.parentId) {
						addChild(byParentId, task.parentId, task);
					}
				}
			}
		}

		return { categories, byParentId };
	}
}

function addChild(
	byParentId: Map<string, CachedMarvinItem[]>,
	parentId: string,
	item: CachedMarvinItem,
): void {
	const existing = byParentId.get(parentId);
	if (existing) {
		existing.push(item);
	} else {
		byParentId.set(parentId, [item]);
	}
}

function validatedDatabaseUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("Amazing Marvin database URI is invalid");
	}
	if (url.username || url.password) {
		throw new Error(
			"Keep Amazing Marvin database credentials in their separate fields",
		);
	}
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
		throw new Error("Amazing Marvin database URI must use HTTPS");
	}
	if (!url.pathname || url.pathname === "/") {
		throw new Error("Amazing Marvin database URI must include the database name");
	}
	url.search = "";
	url.hash = "";
	return url;
}

function parseAllDocsPage(
	text: string,
	status: number,
): { rows: Array<{ id: string; doc?: unknown }> } {
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		throw new CouchBulkError("Amazing Marvin _all_docs returned invalid JSON", status);
	}
	if (
		typeof value !== "object"
		|| value === null
		|| !Array.isArray((value as { rows?: unknown }).rows)
	) {
		throw new CouchBulkError("Amazing Marvin _all_docs returned an invalid page", status);
	}
	const rows = (value as { rows: unknown[] }).rows.map((entry) => {
		if (
			typeof entry !== "object"
			|| entry === null
			|| typeof (entry as { id?: unknown }).id !== "string"
		) {
			throw new CouchBulkError("Amazing Marvin _all_docs returned an invalid row", status);
		}
		const row = entry as { id: string; doc?: unknown };
		return { id: row.id, ...(row.doc === undefined ? {} : { doc: row.doc }) };
	});
	return { rows };
}

function base64Utf8(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}
