import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("@open-horizon/marvin-client package", () => {
	it("loads through native ESM and CommonJS entry points", () => {
		const cwd = process.cwd();
		const esm = execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				"import { MarvinRouter } from '@open-horizon/marvin-client'; process.stdout.write(typeof MarvinRouter)",
			],
			{ cwd, encoding: "utf8" },
		);
		const commonJs = execFileSync(
			process.execPath,
			[
				"--eval",
				"const { MarvinRouter } = require('@open-horizon/marvin-client'); process.stdout.write(typeof MarvinRouter)",
			],
			{ cwd, encoding: "utf8" },
		);

		expect(esm).toBe("function");
		expect(commonJs).toBe("function");
	});
});
