/*
 * Ported from sol-opencode/packages/core/test/then-run.test.ts (vitest →
 * node:test, assertions equivalent).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runThenRun } from "../../plugin/core/action-fusion/then-run.mjs";

async function withRoot(fn) {
	const root = await mkdtemp(join(tmpdir(), "sol-then-run-"));
	try {
		return await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("runThenRun runs the command after the target is confirmed unchanged", async () => {
	await withRoot(async (root) => {
		const file = join(root, "a.ts");
		await writeFile(file, "one\n", "utf8");
		const outcome = await runThenRun({
			absolutePath: file,
			thenRun: { command: "npm test" },
			runCommand: async () => "all green",
		});
		assert.deepEqual(outcome, { status: "succeeded", output: "all green" });
	});
});

test("runThenRun returns a failed outcome when the command throws", async () => {
	await withRoot(async (root) => {
		const file = join(root, "b.ts");
		await writeFile(file, "x\n", "utf8");
		const outcome = await runThenRun({
			absolutePath: file,
			thenRun: { command: "false" },
			runCommand: async () => {
				throw new Error("exit 1");
			},
		});
		assert.deepEqual(outcome, { status: "failed", error: "exit 1" });
	});
});

test("runThenRun skips when the target cannot be hashed", async () => {
	await withRoot(async (root) => {
		const outcome = await runThenRun({
			absolutePath: join(root, "missing.ts"),
			thenRun: { command: "true" },
			runCommand: async () => "should not run",
		});
		assert.equal(outcome.status, "skipped");
	});
});
