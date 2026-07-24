/** A simple promise-chain mutex: each call to run() waits for every
 * previously queued call to settle — successfully or not — before its own
 * fn executes, but each caller still gets its own call's result or error,
 * not some other call's. Used to serialize two independent call sites that
 * mutate shared state (e.g. two different sync paths writing the same
 * in-memory category list) without them needing to know about each other
 * beyond sharing one lock instance. */
export function createAsyncLock() {
	let chain: Promise<unknown> = Promise.resolve();
	return {
		run<T>(fn: () => Promise<T>): Promise<T> {
			const run = chain.then(fn, fn);
			chain = run.then(() => undefined, () => undefined);
			return run;
		},
	};
}
