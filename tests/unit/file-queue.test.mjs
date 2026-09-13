/*
 * Ported from sol-opencode/packages/core/test/file-queue.test.ts (vitest →
 * node:test, assertions equivalent).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveToolPath, withFusedFileQueue } from "../../plugin/core/action-fusion/file-queue.mjs";

test("resolveToolPath strips the @ prefix, normalizes unicode spaces and resolves against cwd", () => {
	assert.equal(resolveToolPath("/work", "@src/a.ts"), "/work/src/a.ts");
	assert.equal(resolveToolPath("/work", "src/\u00A0a.ts"), "/work/src/ a.ts");
});

test("resolveToolPath expands file URLs and home shortcuts", () => {
	assert.equal(resolveToolPath("/work", "file:///tmp/x.ts"), "/tmp/x.ts");
	assert.ok(resolveToolPath("/work", "~/x.ts").startsWith("/"));
});

test("withFusedFileQueue serializes work per canonical path and preserves result order", async () => {
	const root = await mkdtemp(join(tmpdir(), "sol-queue-"));
	try {
		const file = join(root, "a.ts");
		const order = [];

		const slow = withFusedFileQueue(file, async () => {
			order.push("first:start");
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
			order.push("first:end");
			return 1;
		});
		const fast = withFusedFileQueue(file, async () => {
			order.push("second:start");
			order.push("second:end");
			return 2;
		});

		const results = await Promise.all([slow, fast]);
		assert.deepEqual(results, [1, 2]);
		// Acquisition order is not guaranteed (each caller awaits realpath
		// first); what matters is that the two works do not interleave.
		assert.equal(order.length, 4);
		const sequential =
			order.join(",") === "first:start,first:end,second:start,second:end" ||
			order.join(",") === "second:start,second:end,first:start,first:end";
		assert.equal(sequential, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("withFusedFileQueue releases the queue even when work throws", async () => {
	const root = await mkdtemp(join(tmpdir(), "sol-queue-"));
	try {
		const file = join(root, "b.ts");
		await assert.rejects(
			withFusedFileQueue(file, async () => {
				throw new Error("boom");
			}),
			/boom/,
		);
		assert.equal(await withFusedFileQueue(file, async () => "ok"), "ok");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
