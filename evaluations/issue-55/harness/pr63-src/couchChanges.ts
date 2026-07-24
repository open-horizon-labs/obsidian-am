export type CouchSequence = unknown;

export interface MarvinDatabaseDocument extends Record<string, unknown> {
	_id: string;
	_rev?: string;
	_deleted?: boolean;
	db?: string;
	title?: string;
	type?: string;
	parentId?: string;
	done?: boolean;
	deletedAt?: number;
}

export interface CouchChange {
	seq: CouchSequence;
	id: string;
	deleted?: boolean;
	doc?: MarvinDatabaseDocument;
}

export interface CouchChangesPage {
	results: CouchChange[];
	lastSeq: CouchSequence;
	pending?: number;
}

export interface CouchChangesRequest {
	url: string;
	headers: Record<string, string>;
}

export interface CouchChangesResponse {
	status: number;
	text: string;
}

export interface CouchChangesTransport {
	request(request: CouchChangesRequest): Promise<CouchChangesResponse>;
}

export interface CouchChangesCredentials {
	databaseUri: string;
	databaseUser: string;
	databasePassword: string;
}

export class CouchChangesError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "CouchChangesError";
	}
}

export class CouchChangesClient {
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

	async changes(options: {
		since: CouchSequence | "now";
		feed?: "normal" | "longpoll";
		limit?: number;
		timeoutMs?: number;
		includeDocs?: boolean;
	}): Promise<CouchChangesPage> {
		const url = new URL(
			`${this.databaseUrl.pathname.replace(/\/+$/, "")}/_changes`,
			this.databaseUrl,
		);
		url.searchParams.set("since", serializeSequence(options.since));
		url.searchParams.set("feed", options.feed ?? "normal");
		url.searchParams.set("include_docs", String(options.includeDocs ?? true));
		url.searchParams.set("limit", String(options.limit ?? 500));
		if (options.feed === "longpoll") {
			url.searchParams.set("timeout", String(options.timeoutMs ?? 25_000));
		}

		let response: CouchChangesResponse;
		try {
			response = await this.transport.request({
				url: url.toString(),
				headers: {
					Accept: "application/json",
					Authorization: this.authorization,
				},
			});
		} catch {
			throw new CouchChangesError(
				"Could not reach the Amazing Marvin changes feed",
			);
		}
		if (response.status < 200 || response.status >= 300) {
			throw new CouchChangesError(
				`Amazing Marvin changes feed failed with HTTP ${response.status}`,
				response.status,
			);
		}

		let value: unknown;
		try {
			value = JSON.parse(response.text) as unknown;
		} catch {
			throw new CouchChangesError(
				"Amazing Marvin changes feed returned invalid JSON",
				response.status,
			);
		}
		return parseChangesPage(value);
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

function serializeSequence(sequence: CouchSequence | "now"): string {
	if (sequence === "now" || typeof sequence === "string") {
		return sequence;
	}
	return JSON.stringify(sequence);
}

function parseChangesPage(value: unknown): CouchChangesPage {
	if (
		typeof value !== "object"
		|| value === null
		|| !Array.isArray((value as { results?: unknown }).results)
		|| !("last_seq" in value)
	) {
		throw new CouchChangesError(
			"Amazing Marvin changes feed returned an invalid page",
		);
	}
	const raw = value as {
		results: unknown[];
		last_seq: unknown;
		pending?: unknown;
	};
	const results = raw.results.map((entry): CouchChange => {
		if (
			typeof entry !== "object"
			|| entry === null
			|| typeof (entry as { id?: unknown }).id !== "string"
			|| !("seq" in entry)
		) {
			throw new CouchChangesError(
				"Amazing Marvin changes feed returned an invalid change",
			);
		}
		const change = entry as {
			id: string;
			seq: unknown;
			deleted?: unknown;
			doc?: unknown;
		};
		if (
			change.doc !== undefined
			&& (
				typeof change.doc !== "object"
				|| change.doc === null
				|| typeof (change.doc as { _id?: unknown })._id !== "string"
			)
		) {
			throw new CouchChangesError(
				"Amazing Marvin changes feed returned an invalid document",
			);
		}
		return {
			id: change.id,
			seq: change.seq,
			...(change.deleted === true ? { deleted: true } : {}),
			...(change.doc === undefined
				? {}
				: { doc: change.doc as MarvinDatabaseDocument }),
		};
	});
	return {
		results,
		lastSeq: raw.last_seq,
		...(typeof raw.pending === "number" ? { pending: raw.pending } : {}),
	};
}

function base64Utf8(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}
