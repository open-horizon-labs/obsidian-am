import assert from "node:assert/strict";
import test from "node:test";

const FALLBACK_STATUSES = new Set([0, 404, 405, 500, 501, 502, 503, 504]);

class RouteError extends AggregateError {
	constructor(operation, attempts) {
		super(
			attempts.map(({ error }) => error),
			`Amazing Marvin ${operation} failed via ${attempts
				.map(({ origin }) => origin)
				.join(" then ")}`,
		);
		this.name = "RouteError";
		this.operation = operation;
		this.attempts = attempts;
	}
}

function asAttempt(origin, error) {
	return {
		origin,
		error:
			error instanceof Error
				? error
				: Object.assign(new Error(String(error.message ?? error)), error),
	};
}

function mayTryPublic(error) {
	return FALLBACK_STATUSES.has(error.status ?? 0);
}

/**
 * A focused decision prototype, not production code.
 *
 * The result metadata proves that an empty success remains distinguishable from
 * failure and that callers can observe which origin supplied the data.
 */
async function readLocalFirst({
	operation,
	localEnabled,
	local,
	publicApi,
}) {
	const attempts = [];

	if (localEnabled) {
		try {
			return {
				data: await local(operation),
				freshness: "fresh",
				origin: "local",
				fallbackFrom: null,
			};
		} catch (error) {
			const attempt = asAttempt("local", error);
			attempts.push(attempt);
			if (!mayTryPublic(attempt.error)) {
				throw new RouteError(operation, attempts);
			}
		}
	}

	try {
		return {
			data: await publicApi(operation),
			freshness: "fresh",
			origin: "public",
			fallbackFrom: attempts[0] ?? null,
		};
	} catch (error) {
		attempts.push(asAttempt("public", error));
		throw new RouteError(operation, attempts);
	}
}

function failure(status, message, extra = {}) {
	return Object.assign(new Error(message), { status, ...extra });
}

test("does not contact the local API when it is disabled", async () => {
	let localCalls = 0;
	const result = await readLocalFirst({
		operation: "todayItems:2026-07-23",
		localEnabled: false,
		local: async () => {
			localCalls += 1;
			return ["unexpected"];
		},
		publicApi: async () => [],
	});

	assert.equal(localCalls, 0);
	assert.deepEqual(result, {
		data: [],
		freshness: "fresh",
		origin: "public",
		fallbackFrom: null,
	});
});

test("accepts a successful empty local result without calling public", async () => {
	let publicCalls = 0;
	const result = await readLocalFirst({
		operation: "todayItems:2026-07-23",
		localEnabled: true,
		local: async () => [],
		publicApi: async () => {
			publicCalls += 1;
			return ["unexpected"];
		},
	});

	assert.equal(publicCalls, 0);
	assert.equal(result.origin, "local");
	assert.deepEqual(result.data, []);
});

test("falls back when the local API lacks an endpoint", async () => {
	const result = await readLocalFirst({
		operation: "children:unassigned",
		localEnabled: true,
		local: async () => {
			throw failure(404, "Local /children is unsupported");
		},
		publicApi: async () => [{ _id: "task-1" }],
	});

	assert.equal(result.origin, "public");
	assert.equal(result.fallbackFrom.origin, "local");
	assert.equal(result.fallbackFrom.error.status, 404);
	assert.deepEqual(result.data, [{ _id: "task-1" }]);
});

test("falls back when the local server is unavailable", async () => {
	const result = await readLocalFirst({
		operation: "categories",
		localEnabled: true,
		local: async () => {
			throw failure(0, "ECONNREFUSED");
		},
		publicApi: async () => [{ _id: "category-1" }],
	});

	assert.equal(result.origin, "public");
	assert.equal(result.fallbackFrom.error.message, "ECONNREFUSED");
});

test("does not turn a local throttle into a second-origin request", async () => {
	let publicCalls = 0;

	await assert.rejects(
		readLocalFirst({
			operation: "todayItems:2026-07-23",
			localEnabled: true,
			local: async () => {
				throw failure(429, "Rate limited", { retryAfterMs: 30_000 });
			},
			publicApi: async () => {
				publicCalls += 1;
				return [];
			},
		}),
		(error) => {
			assert.equal(error.attempts.length, 1);
			assert.equal(error.attempts[0].error.retryAfterMs, 30_000);
			return true;
		},
	);

	assert.equal(publicCalls, 0);
});

test("preserves both failures when local fallback and public fail", async () => {
	await assert.rejects(
		readLocalFirst({
			operation: "children:unassigned",
			localEnabled: true,
			local: async () => {
				throw failure(404, "Local endpoint unsupported");
			},
			publicApi: async () => {
				throw failure(503, "Public API unavailable");
			},
		}),
		(error) => {
			assert.equal(error.name, "RouteError");
			assert.deepEqual(
				error.attempts.map(({ origin, error: attemptError }) => [
					origin,
					attemptError.status,
					attemptError.message,
				]),
				[
					["local", 404, "Local endpoint unsupported"],
					["public", 503, "Public API unavailable"],
				],
			);
			return true;
		},
	);
});
