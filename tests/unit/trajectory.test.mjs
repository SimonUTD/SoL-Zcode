/*
 * Ported from sol-opencode/packages/core/test/trajectory.test.ts
 * (vitest → node:test, assertions equivalent).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { TRAJECTORY_EVENT_SCHEMA, TrajectoryRecorder } from "../../plugin/core/trajectory/jsonl.mjs";
import { TrajectoryStore, formatTrajectoryBytes, renderTrajectoryLines } from "../../plugin/core/trajectory/store.mjs";

test("TrajectoryStore keeps a bounded ring buffer with monotonic sequence numbers", () => {
	const store = new TrajectoryStore(3);
	store.record({ kind: "tool", label: "a" });
	store.record({ kind: "tool", label: "b" });
	store.record({ kind: "tool", label: "c" });
	const last = store.record({ kind: "tool", label: "d" });
	assert.equal(store.totalRecords, 4);
	assert.equal(last.sequence, 4);
	assert.deepEqual(store.snapshot().map((record) => record.label), ["b", "c", "d"]);
});

test("TrajectoryStore rejects invalid capacities", () => {
	assert.throws(() => new TrajectoryStore(0));
	assert.throws(() => new TrajectoryStore(-1));
});

test("TrajectoryStore updates a record in place and strips control sequences from labels", () => {
	const store = new TrajectoryStore();
	const record = store.record({ kind: "tool", label: "run\u001b[31m x\u0007" });
	assert.ok(!record.label.includes("\u001b"));
	assert.ok(!record.label.includes("\u0007"));
	assert.equal(store.update(record.sequence, { status: "ok", durationMs: 12 })?.status, "ok");
	assert.equal(store.update(999, { status: "ok" }), undefined);
});

test("TrajectoryStore formats byte sizes and renders plain lines", () => {
	assert.equal(formatTrajectoryBytes(512), "512 B");
	assert.equal(formatTrajectoryBytes(2048), "2.0 KiB");
	const store = new TrajectoryStore();
	assert.equal(renderTrajectoryLines(store).length, 2);
	const record = store.record({ kind: "tool", label: "tool bash", status: "ok" });
	store.update(record.sequence, { durationMs: 1500 });
	assert.equal(renderTrajectoryLines(store).length, 2);
});

test("TrajectoryRecorder appends schema-tagged JSONL records and flushes", async () => {
	const root = await mkdtemp(join(tmpdir(), "sol-trajectory-"));
	try {
		const recorder = new TrajectoryRecorder(root, 5);
		const record = recorder.record({ kind: "session", label: "session start" });
		recorder.update(record.sequence, { status: "ok" });
		await recorder.flush();

		const text = await readFile(join(root, "trajectory-inspector", "events.jsonl"), "utf8");
		const lines = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		assert.equal(lines.length, 2);
		assert.equal(lines[0]?.["schema"], TRAJECTORY_EVENT_SCHEMA);
		assert.equal(lines[0]?.["event"], "record");
		assert.equal(lines[1]?.["event"], "update");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
