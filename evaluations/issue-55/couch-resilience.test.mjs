import assert from "node:assert/strict";
import test from "node:test";

/**
 * A focused decision prototype for issue #55, not production code.
 *
 * Ground truth this simulates (confirmed via Amazing Marvin support
 * correspondence, observed 429/Retry-After responses, and reproduced even
 * after routing through the local desktop API): throttling on Marvin's
 * public REST API is broad and shared across multiple endpoints, not
 * limited to the categories -> children N+1 pattern. Any REST call spends
 * from the same budget.
 *
 * The prototype compares two hydration strategies against that shared
 * throttle, then exercises a CouchDB `_changes` resilience wrapper against
 * transient failures, an invalidated checkpoint, and mid-page crashes.
 */

function failure(status, message, extra = {}) {
	return Object.assign(new Error(message), { status, ...extra });
}

/** Shared budget across every REST endpoint, matching confirmed behavior. */
class PublicApiThrottle {
	constructor(budget) {
		this.budget = budget;
		this.spent = 0;
		this.calls = [];
	}

	call(endpoint) {
		this.calls.push(endpoint);
		if (this.spent >= this.budget) {
			throw failure(429, `Amazing Marvin throttled ${endpoint}`, {
				retryAfterMs: 30_000,
			});
		}
		this.spent += 1;
	}
}

/** Bulk CouchDB reads spend from a separate resource, not the REST budget. */
class FakeCouchDb {
	constructor(docs) {
		this.docs = docs;
		this.allDocsCalls = 0;
	}

	async allDocs({ limit = 500, startkey } = {}) {
		this.allDocsCalls += 1;
		const sorted = [...this.docs].sort((a, b) => (
			a._id > b._id ? 1 : a._id < b._id ? -1 : 0
		));
		if (startkey === undefined) {
			const page = sorted.slice(0, limit);
			return {
				rows: page,
				nextStartkey: page.length === limit ? page.at(-1)._id : undefined,
			};
		}
		const start = sorted.findIndex((doc) => doc._id > startkey);
		if (start === -1) {
			return { rows: [], nextStartkey: undefined };
		}
		const page = sorted.slice(start, start + limit);
		return {
			rows: page,
			nextStartkey: page.length === limit ? page.at(-1)._id : undefined,
		};
	}
}

async function hydrateViaRestWalk({ categoryIds, throttle }) {
	throttle.call("categories");
	const children = {};
	for (const categoryId of categoryIds) {
		throttle.call(`children:${categoryId}`);
		children[categoryId] = [];
	}
	return { categoryIds, children };
}

async function hydrateViaCouchBulk({ couch }) {
	const docs = [];
	let startkey;
	for (;;) {
		const page = await couch.allDocs({ limit: 500, startkey });
		docs.push(...page.rows);
		if (!page.nextStartkey) {
			break;
		}
		startkey = page.nextStartkey;
	}
	return { docs };
}

/** Deterministic backoff: no real sleeping, matches the existing IncrementalRetryBackoff shape. */
function createBackoff({ baseDelayMs = 5_000, maxDelayMs = 5 * 60_000 } = {}) {
	let failures = 0;
	return {
		delayForFailure() {
			const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** failures);
			failures += 1;
			return delay;
		},
		recordSuccess() {
			failures = 0;
		},
		failureCount() {
			return failures;
		},
	};
}

const TRANSIENT = new Set([500, 502, 503, 504, 0]);
const INVALID_SINCE = 400;

/**
 * Steady-state changes-feed sync. Never touches the public REST throttle:
 * changes arrive with `include_docs` already populated.
 */
async function resilientChangesSync({
	since,
	changesSource,
	backoff,
	persistSince,
	applyPage,
	onInvalidSince,
	maxAttempts = 5,
	sleep = async () => {},
}) {
	let cursor = since;
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		try {
			const page = await changesSource.changes({ since: cursor });
			applyPage(page);
			await persistSince(page.lastSeq);
			cursor = page.lastSeq;
			backoff.recordSuccess();
			return { ok: true, since: cursor, attempts: attempt + 1 };
		} catch (error) {
			if (error.status === INVALID_SINCE) {
				const rehydrated = await onInvalidSince();
				return { ok: true, since: rehydrated.since, rehydrated: true };
			}
			if (!TRANSIENT.has(error.status ?? 0)) {
				throw error;
			}
			await sleep(backoff.delayForFailure());
		}
	}
	throw failure(0, "Amazing Marvin changes feed exhausted retry attempts");
}

test("REST-walk hydration trips the shared public throttle for a modest category tree", async () => {
	const throttle = new PublicApiThrottle(20);
	const categoryIds = Array.from({ length: 25 }, (_, i) => `cat-${i}`);

	await assert.rejects(
		hydrateViaRestWalk({ categoryIds, throttle }),
		(error) => {
			assert.equal(error.status, 429);
			return true;
		},
	);
	assert.ok(throttle.calls.length <= 21, "should fail at the throttle boundary, not run past it");
});

test("CouchDB bulk hydration never spends from the REST throttle, regardless of tree size", async () => {
	const throttle = new PublicApiThrottle(20);
	const docs = Array.from({ length: 2_500 }, (_, i) => ({ _id: `doc-${i}`, title: `Item ${i}` }));
	const couch = new FakeCouchDb(docs);

	const result = await hydrateViaCouchBulk({ couch });

	assert.equal(result.docs.length, 2_500);
	assert.equal(throttle.spent, 0, "bulk hydration must not touch the REST throttle");
	assert.ok(couch.allDocsCalls > 1, "large trees should page, not fetch unbounded");
});

test("changes-feed sync recovers from a transient 5xx burst via backoff, without touching REST", async () => {
	const throttle = new PublicApiThrottle(20);
	let calls = 0;
	const changesSource = {
		async changes() {
			calls += 1;
			if (calls <= 2) {
				throw failure(503, "Amazing Marvin changes feed unavailable");
			}
			return { results: [{ id: "task-1" }], lastSeq: "42" };
		},
	};
	const backoff = createBackoff({ baseDelayMs: 1 });
	const delays = [];
	const applied = [];

	const result = await resilientChangesSync({
		since: "0",
		changesSource,
		backoff,
		persistSince: async () => {},
		applyPage: (page) => applied.push(page),
		onInvalidSince: async () => {
			throw new Error("should not rehydrate on a transient failure");
		},
		sleep: async (ms) => delays.push(ms),
	});

	assert.equal(result.ok, true);
	assert.equal(result.since, "42");
	assert.equal(applied.length, 1);
	assert.deepEqual(delays, [1, 2]);
	assert.equal(throttle.spent, 0, "transient CouchDB failures must never fall back to REST");
});

test("changes-feed sync treats an invalidated checkpoint as a rehydration signal, not a crash", async () => {
	const changesSource = {
		async changes({ since }) {
			if (since === "stale-checkpoint") {
				throw failure(INVALID_SINCE, "since is not valid for this database");
			}
			return { results: [], lastSeq: "1" };
		},
	};
	let rehydrateCalls = 0;

	const result = await resilientChangesSync({
		since: "stale-checkpoint",
		changesSource,
		backoff: createBackoff({ baseDelayMs: 1 }),
		persistSince: async () => {},
		applyPage: () => {},
		onInvalidSince: async () => {
			rehydrateCalls += 1;
			return { since: "rehydrated-since" };
		},
	});

	assert.equal(rehydrateCalls, 1);
	assert.equal(result.rehydrated, true);
	assert.equal(result.since, "rehydrated-since");
});

test("checkpoint only advances after a page is successfully applied", async () => {
	const changesSource = {
		calls: 0,
		async changes() {
			this.calls += 1;
			if (this.calls === 1) {
				throw failure(502, "Amazing Marvin changes feed timed out");
			}
			return { results: [{ id: "task-1" }], lastSeq: "99" };
		},
	};
	const persisted = [];

	const result = await resilientChangesSync({
		since: "50",
		changesSource,
		backoff: createBackoff({ baseDelayMs: 1 }),
		persistSince: async (seq) => persisted.push(seq),
		applyPage: () => {},
		onInvalidSince: async () => {
			throw new Error("not expected");
		},
		sleep: async () => {},
	});

	assert.equal(result.since, "99");
	assert.deepEqual(persisted, ["99"], "the failed attempt must never persist a checkpoint");
});
