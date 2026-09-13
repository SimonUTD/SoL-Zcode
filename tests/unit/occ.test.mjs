/*
 * OCC adapter state machine unit tests: boundary detection from TodoWrite
 * payloads (Zcode todos carry no id), CORRECTION reset, Stop economics via a
 * fabricated transcript, compaction detection + delayed reminder, block
 * budgets.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	initialOccState,
	loadOccState,
	observeTranscript,
	runOccCorrection,
	runOccStopRound,
	runOccTodoBoundary,
	setOccStateForTests,
	todosToPlan,
} from "../../plugin/hooks/lib/occ.mjs";
import { occHistoryPath } from "../../plugin/hooks/lib/store.mjs";
import { verifyChainFile } from "../../plugin/hooks/lib/chain.mjs";

async function withRoot(fn) {
	const root = await mkdtemp(join(tmpdir(), "sol-occ-"));
	try {
		return await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const SESSION = "sess_occ-test-1";

function transcript(entries, fillerBytes = 200) {
	const lines = [];
	for (let i = 0; i < entries; i += 1) {
		lines.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "x".repeat(fillerBytes) }] } }));
	}
	return `${lines.join("\n")}\n`;
}

function todoId(goal) {
	return `todo-${createHash("sha256").update(goal, "utf8").digest("hex").slice(0, 10)}`;
}

test("todosToPlan synthesizes content-hash ids for Zcode TodoWrite payloads", () => {
	const plan = todosToPlan([
		{ content: "step one", status: "completed", priority: "high" },
		{ content: "step two", status: "in_progress", priority: "high" },
		{ content: "dropped", status: "cancelled" },
		{ content: "step three", status: "pending" },
	]);
	assert.deepEqual(plan, [
		{ id: todoId("step one"), goal: "step one", status: "completed" },
		{ id: todoId("step two"), goal: "step two", status: "in_progress" },
		{ id: todoId("step three"), goal: "step three", status: "pending" },
	]);
	assert.equal(todosToPlan("junk"), undefined);
	assert.equal(todosToPlan([{ status: "pending" }]), undefined);
});

test("todo boundary sets pendingBoundary and records request counts", async () => {
	await withRoot(async (root) => {
		await setOccStateForTests(root, SESSION, { requestCount: 5 });
		const first = await runOccTodoBoundary(root, SESSION, [
			{ content: "a", status: "in_progress" },
			{ content: "b", status: "pending" },
		]);
		assert.equal(first.state.pendingBoundary, false);
		const second = await runOccTodoBoundary(root, SESSION, [
			{ content: "a", status: "completed" },
			{ content: "b", status: "pending" },
		]);
		assert.equal(second.state.pendingBoundary, true);
		assert.equal(second.state.plan.filter((s) => s.status !== "completed").length, 1);
		const chained = await verifyChainFile(occHistoryPath(root, SESSION));
		assert.equal(chained.ok, true);
	});
});

test("CORRECTION prompt bumps epoch and clears debt", async () => {
	await withRoot(async (root) => {
		await setOccStateForTests(root, SESSION, { carriedDebtTokens: 12345, epoch: 2 });
		const state = await runOccCorrection(root, SESSION);
		assert.equal(state.epoch, 3);
		assert.equal(state.carriedDebtTokens, 0);
	});
});

test("Stop round with economic decision returns a block and consumes the boundary", async () => {
	await withRoot(async (root) => {
		const transcriptPath = join(root, "transcript.jsonl");
		// Large enough that archiveTokens - memoTokens is a big positive saving.
		await writeFile(transcriptPath, transcript(200, 4000), "utf8");
		const observation = await observeTranscript(transcriptPath);
		assert.notEqual(observation, null);

		await setOccStateForTests(root, SESSION, {
			plan: [
				{ id: "t1", goal: "a", status: "completed" },
				{ id: "t2", goal: "b", status: "pending" },
				{ id: "t3", goal: "c", status: "pending" },
			],
			pendingBoundary: true,
			completedBoundaryRequestCounts: [4, 6, 5],
			requestCount: 3,
			lastBoundaryRequestCount: 0,
			// Prior context close to the current one keeps the sliding-window
			// average increment small so the window request bound stays open.
			lastContextTokens: Math.max(0, observation.tokens - 2000),
		});
		const result = await runOccStopRound(root, SESSION, { observation, stopHookActive: false });
		assert.notEqual(result.block, null);
		assert.equal(result.block.kind, "economic");
		assert.ok(result.block.reason.startsWith("[sol-occ]"));
		assert.ok(result.block.reason.includes("economical"));
		const state = await loadOccState(root, SESSION);
		assert.equal(state.pendingBoundary, false);
		assert.equal(state.totalBlocks, 1);
		assert.equal(state.consecutiveBlocks, 1);
	});
});

test("Stop round without transcript skips OCC entirely (fail-open)", async () => {
	await withRoot(async (root) => {
		await setOccStateForTests(root, SESSION, { pendingBoundary: true });
		const result = await runOccStopRound(root, SESSION, { observation: null, stopHookActive: false });
		assert.equal(result.block, null);
	});
});

test("compaction detection sets the reminder; delivered on the NEXT stop", async () => {
	await withRoot(async (root) => {
		const transcriptPath = join(root, "transcript.jsonl");
		await writeFile(transcriptPath, transcript(200, 1000), "utf8");
		const observation1 = await observeTranscript(transcriptPath);
		await setOccStateForTests(root, SESSION, { transcriptSnapshot: { entries: 400, bytes: 999999 } });
		const first = await runOccStopRound(root, SESSION, { observation: observation1, stopHookActive: false });
		// Detection round: 400 → 200 entries = 50% drop. Reminder scheduled,
		// not delivered on the same round.
		assert.equal(first.block, null);
		let state = await loadOccState(root, SESSION);
		assert.equal(state.pendingCompactionReminder, true);
		assert.equal(state.priorCompactionCount, 1);

		const second = await runOccStopRound(root, SESSION, { observation: observation1, stopHookActive: false });
		assert.notEqual(second.block, null);
		assert.equal(second.block.kind, "compaction-reminder");
		assert.ok(second.block.reason.includes("Online context compaction finished"));
		state = await loadOccState(root, SESSION);
		assert.equal(state.pendingCompactionReminder, false);
	});
});

test("block budgets: max 2 consecutive, max 3 per session", async () => {
	await withRoot(async (root) => {
		const transcriptPath = join(root, "transcript.jsonl");
		await writeFile(transcriptPath, transcript(200, 4000), "utf8");
		const observation = await observeTranscript(transcriptPath);
		const seed = {
			plan: [
				{ id: "t1", goal: "a", status: "pending" },
				{ id: "t2", goal: "b", status: "pending" },
				{ id: "t3", goal: "c", status: "pending" },
			],
			pendingBoundary: true,
			completedBoundaryRequestCounts: [4, 6, 5],
			lastContextTokens: Math.max(0, observation.tokens - 2000),
		};
		await setOccStateForTests(root, SESSION, seed);
		const one = await runOccStopRound(root, SESSION, { observation, stopHookActive: false });
		assert.notEqual(one.block, null);
		// Re-arm a boundary (a new TodoWrite completion) then stop as a
		// continuation: consecutive budget hits 2.
		await setOccStateForTests(root, SESSION, { pendingBoundary: true });
		const two = await runOccStopRound(root, SESSION, { observation, stopHookActive: true });
		assert.notEqual(two.block, null);
		await setOccStateForTests(root, SESSION, { pendingBoundary: true });
		const three = await runOccStopRound(root, SESSION, { observation, stopHookActive: true });
		assert.equal(three.block, null, "consecutive budget (2) exhausted");
		// A non-continuation stop resets the consecutive counter; the session
		// budget (3) still admits exactly one more block.
		await setOccStateForTests(root, SESSION, { pendingBoundary: true });
		const four = await runOccStopRound(root, SESSION, { observation, stopHookActive: false });
		assert.notEqual(four.block, null, "session budget not yet exhausted");
		await setOccStateForTests(root, SESSION, { pendingBoundary: true });
		const five = await runOccStopRound(root, SESSION, { observation, stopHookActive: false });
		assert.equal(five.block, null, "session budget (3) exhausted");
	});
});

test("initialOccState defaults match DESIGN constants", () => {
	const state = initialOccState();
	assert.equal(state.contextWindowTokens, 1_000_000);
	assert.equal(state.consecutiveBlocks, 0);
	assert.equal(state.totalBlocks, 0);
	assert.equal(state.increments.length, 0);
});
