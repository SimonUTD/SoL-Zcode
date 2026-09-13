/*
 * OCC adapter state machine unit tests: boundary detection from TodoWrite
 * payloads (Zcode todos carry no id), CORRECTION reset, Stop economics via a
 * fabricated transcript, compaction detection + delayed reminder, block
 * budgets, and the G21 cumulative estimator (hooks-side byte accumulation,
 * threshold reachability under the real 1M window, honest detector downgrade).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	CHARS_PER_TOKEN,
	PERSISTED_PREVIEW_CHARS,
	SYSTEM_BASELINE_TOKENS,
	accumulateOccUsage,
	initialOccState,
	loadOccState,
	occToolResponseBytes,
	observeTranscript,
	resolveContextWindowTokens,
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

test("duplicate-content todos get unique synthesized ids instead of dropping the plan (m5)", () => {
	// Same-content todos used to collide on the content-hash id →
	// parsePlanSteps rejected the whole array → the plan update was silently
	// discarded. Occurrence suffixes keep ids unique; the first occurrence
	// keeps the bare hash id.
	const plan = todosToPlan([
		{ content: "fix the bug", status: "in_progress" },
		{ content: "fix the bug", status: "pending" },
		{ content: "fix the bug", status: "pending" },
		{ content: "ship it", status: "pending" },
	]);
	assert.notEqual(plan, undefined, "plan must not be dropped for duplicate content");
	assert.deepEqual(
		plan.map((step) => step.id),
		[todoId("fix the bug"), `${todoId("fix the bug")}-2`, `${todoId("fix the bug")}-3`, todoId("ship it")],
	);
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
		// A full-conversation transcript re-arms the detector (availability rule).
		assert.equal(state.compactionDetection, "available");

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

test("reminder is cleared when the session block budget is permanently exhausted (m14)", async () => {
	await withRoot(async (root) => {
		const transcriptPath = join(root, "transcript.jsonl");
		await writeFile(transcriptPath, transcript(200, 1000), "utf8");
		const observation = await observeTranscript(transcriptPath);
		// Reminder pending + consecutive budget exhausted (2) but session
		// budget not yet exhausted (2 < 3): delivery can still happen after a
		// natural Stop resets the consecutive counter → stays pending.
		await setOccStateForTests(root, SESSION, {
			pendingCompactionReminder: true,
			consecutiveBlocks: 2,
			totalBlocks: 2,
			transcriptSnapshot: { entries: 400, bytes: 999999 },
		});
		const first = await runOccStopRound(root, SESSION, { observation, stopHookActive: true });
		assert.equal(first.block, null);
		let state = await loadOccState(root, SESSION);
		assert.equal(state.pendingCompactionReminder, true, "not permanently exhausted → stays pending");

		// Session budget exhausted (3/3): the reminder can never be delivered
		// again → cleared instead of lingering forever.
		await setOccStateForTests(root, SESSION, { totalBlocks: 3 });
		const second = await runOccStopRound(root, SESSION, { observation, stopHookActive: false });
		assert.equal(second.block, null);
		state = await loadOccState(root, SESSION);
		assert.equal(state.pendingCompactionReminder, false, "permanent exhaustion clears the reminder");
	});
});

// ---------------------------------------------------------------- G21 cumulative estimator

/** A 30-step plan: step 1 completed, 29 pending (e2e s5 shape). */
const PLAN_30 = Array.from({ length: 30 }, (_v, i) => ({
	id: `t${String(i + 1).padStart(2, "0")}`,
	goal: `Step ${String(i + 1).padStart(2, "0")}`,
	status: i === 0 ? "completed" : "pending",
}));

test("cumulative estimator accumulates prompt/tool/assistant bytes across hook events (G21)", async () => {
	await withRoot(async (root) => {
		await accumulateOccUsage(root, SESSION, 700, "prompt");
		let state = await loadOccState(root, SESSION);
		assert.equal(state.cumulativeBytes, 700);
		assert.equal(state.estimatedTokens, Math.ceil(700 / CHARS_PER_TOKEN));

		await accumulateOccUsage(root, SESSION, 108_894, "tool:Bash");
		await accumulateOccUsage(root, SESSION, 11, "assistant");
		state = await loadOccState(root, SESSION);
		assert.equal(state.cumulativeBytes, 109_605);
		assert.equal(state.estimatedTokens, 27_402);

		// Stop round with a G21-shaped transcript (single entry, ~25 tokens):
		// the estimator still sees the conversation-scale cumulative.
		const tiny = join(root, "tiny.jsonl");
		await writeFile(tiny, transcript(1, 100), "utf8");
		const observation = await observeTranscript(tiny);
		const result = await runOccStopRound(root, SESSION, { observation, stopHookActive: false });
		assert.equal(result.block, null);
		state = await loadOccState(root, SESSION);
		assert.equal(state.requestCount, 1);
		assert.equal(state.estimatedTokens, 27_402);
		// max(cumulative + system baseline, transcript estimate): cumulative wins.
		assert.equal(state.lastContextTokens, 27_402 + SYSTEM_BASELINE_TOKENS);
		assert.deepEqual(state.increments, [27_402 + SYSTEM_BASELINE_TOKENS]);
		assert.equal(state.transcriptSnapshot.entries, 1);
	});
});

test("threshold reachability: accumulated tool volume reaches the economic block under the REAL 1M window (G21)", async () => {
	await withRoot(async (root) => {
		const tiny = join(root, "tiny.jsonl");
		await writeFile(tiny, transcript(1, 100), "utf8");
		const observation = await observeTranscript(tiny);

		await setOccStateForTests(root, SESSION, { plan: PLAN_30, pendingBoundary: true, completedBoundaryRequestCounts: [1] });

		// Round A (one prompt + one ~106KB native Bash output + short reply):
		// single-increment economics can never fire (notes.math — negative
		// discriminant), so Stop #1 must stay silent.
		await accumulateOccUsage(root, SESSION, 700, "prompt");
		await accumulateOccUsage(root, SESSION, 108_894, "tool:Bash");
		const stop1 = await runOccStopRound(root, SESSION, { observation, stopHookActive: false, assistantBytes: 11 });
		assert.equal(stop1.block, null, "no premature block on a single increment");
		assert.equal(stop1.decision.compact, false);
		assert.equal(stop1.state.contextWindowTokens, 1_000_000);
		assert.equal(stop1.state.increments.length, 1);

		// Round B (second ~106KB output): two increments collapse the average,
		// the window request bound opens, breakeven fits the horizon → compact.
		await accumulateOccUsage(root, SESSION, 108_894 + 400, "tool:Bash");
		const stop2 = await runOccStopRound(root, SESSION, { observation, stopHookActive: false, assistantBytes: 5 });
		assert.notEqual(stop2.block, null);
		assert.equal(stop2.block.kind, "economic");
		assert.ok(stop2.block.reason.startsWith("[sol-occ]"));
		assert.equal(stop2.decision.compact, true);
		assert.equal(stop2.decision.reason, "economic");
		const state = await loadOccState(root, SESSION);
		assert.equal(state.pendingBoundary, false);
		assert.equal(state.consecutiveBlocks, 1);
		assert.equal(state.totalBlocks, 1);
		assert.equal(state.increments.length, 2);
		assert.ok(state.lastContextTokens >= 60_000, `context estimate reached conversation scale, got ${state.lastContextTokens}`);
		assert.equal(state.contextWindowTokens, 1_000_000, "real window — no threshold lowering");

		// Continuation Stop (stop_hook_active): a re-armed boundary still
		// decides economically → second block; a third is refused by the
		// consecutive self-limit.
		await setOccStateForTests(root, SESSION, { pendingBoundary: true });
		const stop3 = await runOccStopRound(root, SESSION, { observation, stopHookActive: true });
		assert.notEqual(stop3.block, null);
		assert.equal(stop3.block.kind, "economic");
		await setOccStateForTests(root, SESSION, { pendingBoundary: true });
		const stop4 = await runOccStopRound(root, SESSION, { observation, stopHookActive: true });
		assert.equal(stop4.block, null, "consecutive budget (2) exhausted");

		// Decision-path ledger evidence in the chained history.
		const history = (await verifyChainFile(occHistoryPath(root, SESSION)), await readFileLines(root));
		const reasons = history.map((entry) => entry.reason);
		assert.ok(reasons.includes("stop-block-economic"));
	});
});

async function readFileLines(root) {
	const { readFile } = await import("node:fs/promises");
	const raw = await readFile(occHistoryPath(root, SESSION), "utf8");
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

test("compaction detector is honestly recorded as unavailable under a last-message-only transcript (G21)", async () => {
	await withRoot(async (root) => {
		const tiny = join(root, "tiny.jsonl");
		await writeFile(tiny, transcript(1, 100), "utf8");
		const observation = await observeTranscript(tiny);
		// Large accumulated conversation + pinned-at-1 entries → detector
		// structurally blind; it must be recorded as such, never fake a drop.
		await accumulateOccUsage(root, SESSION, 200_000, "tool:Bash");
		await setOccStateForTests(root, SESSION, { transcriptSnapshot: { entries: 1, bytes: 110 } });
		const result = await runOccStopRound(root, SESSION, { observation, stopHookActive: false, assistantBytes: 11 });
		assert.equal(result.block, null);
		const state = await loadOccState(root, SESSION);
		assert.equal(state.compactionDetection, "unavailable");
		assert.equal(state.priorCompactionCount, 0);
		assert.equal(state.pendingCompactionReminder, false);
	});
});

test("resolveContextWindowTokens: payload field wins, env knob overrides the default (reduced-window simulation)", async () => {
	assert.equal(resolveContextWindowTokens({ payloadWindow: 200_000, env: { SOL_ZCODE_OCC_WINDOW_TOKENS: "50000" } }), 200_000);
	assert.equal(resolveContextWindowTokens({ payloadWindow: undefined, env: { SOL_ZCODE_OCC_WINDOW_TOKENS: "50000" } }), 50_000);
	assert.equal(resolveContextWindowTokens({ payloadWindow: undefined, env: {} }), undefined);
	assert.equal(resolveContextWindowTokens({ payloadWindow: -5, env: { SOL_ZCODE_OCC_WINDOW_TOKENS: "junk" } }), undefined);

	// The injected reduced window makes a modest accumulated context trigger
	// via window_protection (the sanctioned simulation path — constants stay
	// untouched in production).
	await withRoot(async (root) => {
		const tiny = join(root, "tiny.jsonl");
		await writeFile(tiny, transcript(1, 100), "utf8");
		const observation = await observeTranscript(tiny);
		await setOccStateForTests(root, SESSION, { plan: PLAN_30, pendingBoundary: true });
		await accumulateOccUsage(root, SESSION, 88_000, "tool:Bash");
		const result = await runOccStopRound(root, SESSION, {
			observation,
			stopHookActive: false,
			assistantBytes: 11,
			contextWindowTokens: resolveContextWindowTokens({ env: { SOL_ZCODE_OCC_WINDOW_TOKENS: "50000" } }),
		});
		assert.notEqual(result.block, null);
		assert.equal(result.block.kind, "economic");
		assert.equal(result.decision.reason, "window_protection");
		const state = await loadOccState(root, SESSION);
		assert.equal(state.contextWindowTokens, 50_000);
	});
});

// ------------------------------------------- m1: occ-state cross-process locking

test("concurrent accumulateOccUsage from three processes loses no update (m1 lock regression)", async () => {
	await withRoot(async (root) => {
		const script = join(root, "worker.mjs");
		await writeFile(
			script,
			`import { accumulateOccUsage } from ${JSON.stringify(new URL("../../plugin/hooks/lib/occ.mjs", import.meta.url).href)};\n` +
				`const root = process.argv[2];\n` +
				`for (let i = 0; i < 10; i += 1) await accumulateOccUsage(root, "sess_occ-conc-1", 1000, "tool:Bash");\n`,
			"utf8",
		);
		const { spawn } = await import("node:child_process");
		const workers = [1, 2, 3].map(
			(n) =>
				new Promise((resolve, reject) => {
					const child = spawn(process.execPath, [script, root], { stdio: "ignore" });
					child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${n} exit ${code}`))));
				}),
		);
		await Promise.all(workers);

		// Without the per-session state lock, parallel PostToolUse hook
		// processes (the host runs same-step tool calls concurrently) each
		// load→add→persist and the last rename wins: lost accumulates and
		// non-monotonic history states.
		const state = await loadOccState(root, "sess_occ-conc-1");
		assert.equal(state.cumulativeBytes, 30_000, "every concurrent accumulate must be reflected exactly once");
		assert.equal(state.estimatedTokens, Math.ceil(30_000 / CHARS_PER_TOKEN));

		const history = await verifyChainFile(occHistoryPath(root, "sess_occ-conc-1"));
		assert.equal(history.ok, true, "chained history stays intact under concurrency");
		assert.equal(history.lines, 30, "one state line per accumulate");

		const { readFile } = await import("node:fs/promises");
		const raw = await readFile(occHistoryPath(root, "sess_occ-conc-1"), "utf8");
		const cumulatives = raw
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line).state.cumulativeBytes);
		assert.deepEqual(cumulatives, Array.from({ length: 30 }, (_v, i) => (i + 1) * 1000), "cumulativeBytes is strictly monotonic in +1000 steps");
	});
});

test("concurrent accumulateOccUsage interleaved with a Stop round keeps block counters monotonic (m1)", async () => {
	await withRoot(async (root) => {
		const session = "sess_occ-conc-2";
		const script = join(root, "worker.mjs");
		await writeFile(
			script,
			`import { accumulateOccUsage } from ${JSON.stringify(new URL("../../plugin/hooks/lib/occ.mjs", import.meta.url).href)};\n` +
				`const root = process.argv[2];\n` +
				`for (let i = 0; i < 8; i += 1) await accumulateOccUsage(root, ${JSON.stringify(session)}, 500, "tool:Bash");\n`,
			"utf8",
		);
		const { spawn } = await import("node:child_process");
		const worker = new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [script, root], { stdio: "ignore" });
			child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))));
		});
		// The parent simultaneously runs Stop rounds (the narrow m1 window: a
		// late unlocked accumulate used to be able to overwrite Stop-round
		// persistence and roll consecutiveBlocks/totalBlocks back).
		await setOccStateForTests(root, session, { consecutiveBlocks: 1, totalBlocks: 1 });
		const stopRound = (async () => {
			for (let i = 0; i < 8; i += 1) {
				await runOccStopRound(root, session, { observation: null, stopHookActive: true, assistantBytes: 0 });
			}
		})();
		await Promise.all([worker, stopRound]);

		const state = await loadOccState(root, session);
		assert.equal(state.cumulativeBytes, 4000, "no lost accumulate");
		assert.ok(state.consecutiveBlocks >= 1 && state.totalBlocks >= 1, "block counters were never rolled back");
		assert.ok((await verifyChainFile(occHistoryPath(root, session))).ok, "history chain intact");
	});
});

// ------------------------------------------- m2: estimator calibration (both branches)

test("occToolResponseBytes: truncated native output counts the model-visible preview envelope, not stdoutBytes (m2)", () => {
	const stdout = Array.from({ length: 4000 }, (_v, i) => `line-${String(i).padStart(5, "0")} padded x\n`).join("");
	const path = "/home/u/.zcode/cli/exec/sess_abc/call_42-stdout.log";
	const response = {
		stdout: stdout.slice(0, 30_000), // host truncates the payload stdout (G6)
		stderr: "",
		exitCode: 0,
		stdoutTruncated: true,
		stdoutBytes: 148_000,
		persistedOutputPath: path,
		persistedOutputSize: 148_000,
	};
	const counted = occToolResponseBytes(response);
	// The expected envelope is spelled out independently from the host format
	// (REr/xne, zcode 0.16.5): preview is the first 2000 chars of the output.
	const expected = Buffer.byteLength(
		[
			"<persisted-output>",
			`Output too large (${Math.round(148_000 / 1000)} KB). Full output saved to: ${path}`,
			"",
			"Preview (first 2 KB):",
			stdout.slice(0, PERSISTED_PREVIEW_CHARS),
			"...",
			"</persisted-output>",
		].join("\n"),
		"utf8",
	);
	assert.equal(counted, expected);
	assert.ok(counted < 4096, `a 148 KB truncated output must count as the ~2 KB preview envelope, got ${counted}`);
	assert.ok(counted < 148_000 / 10, "nowhere near the old full stdoutBytes accounting");

	// The envelope size follows the persisted path length (it is part of the
	// model-visible notice) — and nothing else in the payload moves it.
	const longer = occToolResponseBytes({ ...response, persistedOutputPath: `${path}-with-a-much-longer-name.log` });
	assert.equal(longer - counted, "-with-a-much-longer-name.log".length);

	// No persisted path at all: the notice still forms, with an empty path.
	const noPath = occToolResponseBytes({ ...response, persistedOutputPath: undefined });
	assert.ok(noPath > PERSISTED_PREVIEW_CHARS && noPath < counted + 1);
});

test("occToolResponseBytes: untruncated native output and MCP text count what the model actually sees (m2)", () => {
	// Untruncated: the full byte fields count (the stream was delivered intact).
	assert.equal(
		occToolResponseBytes({ stdout: "x".repeat(28_893), stderr: "e", stdoutBytes: 28_893, stderrBytes: 1, stdoutTruncated: false }),
		28_894,
	);
	// No byte fields: delivered stdout string length.
	assert.equal(occToolResponseBytes({ stdout: "abc", stderr: "" }), 3);
	// stderr truncated on its own: stdout full + stderr envelope.
	const mixed = occToolResponseBytes({ stdout: "ok\n", stdoutBytes: 3, stderr: "e".repeat(30_100).slice(0, 30_000), stderrBytes: 30_100, stderrTruncated: true, stderrPersistedOutputPath: "/p/err.log" });
	assert.ok(mixed > 3 && mixed < 3 + PERSISTED_PREVIEW_CHARS + 512, `stderr envelope dominates, got ${mixed}`);

	// MCP tool response (sol_* placeholder): the text parts are the model-visible bytes.
	const placeholder = "[obs obs_abc] large tool result replaced …".repeat(3);
	assert.equal(occToolResponseBytes({ content: [{ type: "text", text: placeholder }] }), Buffer.byteLength(placeholder, "utf8"));
	assert.equal(occToolResponseBytes(placeholder), Buffer.byteLength(placeholder, "utf8"));

	// Structured non-Bash fallback: stringified size (unchanged behavior).
	assert.equal(occToolResponseBytes({ a: 1 }), 3 + 4); // '{"a":1}'
	assert.equal(occToolResponseBytes(undefined), 0);
});
