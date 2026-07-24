import { describe, expect, it } from "vitest";

import { createAsyncLock } from "./asyncLock";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("createAsyncLock", () => {
	it("never runs two locked operations concurrently", async () => {
		const lock = createAsyncLock();
		const order: string[] = [];
		const first = deferred<void>();

		const a = lock.run(async () => {
			order.push("a:start");
			await first.promise;
			order.push("a:end");
		});
		const b = lock.run(async () => {
			order.push("b:start");
			order.push("b:end");
		});

		// b must not start until a's gate is released, even though b was
		// queued immediately and has nothing async blocking it itself.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(order).toEqual(["a:start"]);

		first.resolve();
		await Promise.all([a, b]);
		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
	});

	it("gives each caller its own result, not another call's", async () => {
		const lock = createAsyncLock();
		const [a, b, c] = await Promise.all([
			lock.run(async () => "a"),
			lock.run(async () => "b"),
			lock.run(async () => "c"),
		]);
		expect([a, b, c]).toEqual(["a", "b", "c"]);
	});

	it("a failed operation does not break the chain for the next one", async () => {
		const lock = createAsyncLock();
		const order: string[] = [];

		const failing = lock.run(async () => {
			order.push("failing");
			throw new Error("boom");
		});
		const next = lock.run(async () => {
			order.push("next");
			return "ok";
		});

		await expect(failing).rejects.toThrow("boom");
		await expect(next).resolves.toBe("ok");
		expect(order).toEqual(["failing", "next"]);
	});

	it("propagates each caller's own error without leaking into a sibling", async () => {
		const lock = createAsyncLock();
		const a = lock.run(async () => {
			throw new Error("a failed");
		});
		const b = lock.run(async () => "b succeeded");

		await expect(a).rejects.toThrow("a failed");
		await expect(b).resolves.toBe("b succeeded");
	});
});
