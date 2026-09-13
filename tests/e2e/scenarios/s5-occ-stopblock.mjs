/*
 * S5 — Online Context Compact, real long session (real model). v4.
 *
 * Host-behavior findings that shape this scenario (P2, from S3/S4 probes):
 *   - the Stop-time transcript_path in zcode 0.16.5 headless carries ONLY the
 *     last assistant message (114 B observed for a multi-request session), so
 *     the OCC estimator (observeTranscript) measures the FINAL MESSAGE, not
 *     the conversation — tool-call volume cannot grow the estimate;
 *   - the Stop payload carries no contextWindow field → plugin default 1M.
 *
 * Consequences (notes.math): a single-increment Stop can never satisfy the
 * economics (no real roots), so the real-session trigger requires TWO Stop
 * rounds where the second one's final message is giant:
 *
 *   R1: TodoWrite boundary (Step 01 completed, 29 pending) + SHORT final
 *       reply -> Stop #1: increments=[~30], no block (asserted).
 *   R2 (--resume, same sessionId): final message = ~24k integers (~146 KB,
 *       ~36k estimated tokens) -> Stop #2: increments=[~30, ~36k],
 *       averageContextTokenIncrement ~= 18k, windowRequestUpperBound ~= 53,
 *       effectiveHorizon = 30 (cap 2*eR) and breakeven = 11.5*T2/(T2-21k) ~= 23
 *       -> {"decision":"block"} fires (the only model-reachable Stop channel,
 *       G17). Continuation rule: TodoWrite next step + short reply -> Stop #3
 *       with stop_hook_active=true (host re-ran Stop), no second block (tiny
 *       final message is non-compressible), self-limits hold.
 *
 * 5b Compaction detection: honest observation over the occ-history snapshot
 * series; "not observed" is recorded as such — nothing is faked.
 *
 * Options: onlineCompact + trajectory + evidenceReducer (ER registers
 * sol_bash; observationPack stays OFF).
 */
import {
	cleanupScenario,
	findRollout,
	ledgerPath,
	makeAssertions,
	makeScenario,
	probeEvents,
	readJsonl,
	readOccState,
	readTrajectory,
	recordResult,
	rolloutFindString,
	runPrompt,
} from "../lib/harness.mjs";

export const id = "s5-occ-stopblock";
export const title = "OCC real-session economic Stop-block trigger (consecutive<=2) + compaction detection observation";

const NOTES_MATH = [
	"contextWindow=1e6 (Stop payload has no contextWindow field — S3 probe).",
	"Single-increment Stop (Stop#1): need floor(1e6/T)-1 >= 11.5*T/(T-21000) i.e. 12.5*T^2 - 1_021_000*T + 21e9 <= 0, whose discriminant is negative — mathematically impossible; asserted as the no-premature-block check.",
	"Two-increment Stop (Stop#2 with a giant second final message T2>=~34.1k tokens): increments=[tiny, huge] collapse the average increment, windowRequestUpperBound = floor((1e6-T2)/avg) opens wide, effectiveHorizon = min(2*min(1+floor(0.5*29),wu), wu) = 30 for wu>=30, and breakeven = 11.5*T2/(T2-21000) <= 30 once T2 >= 34_055 — economic block becomes reachable.",
	"T2 is delivered by instructing the model to output ~24k integers (~146KB, ~36k tokens) as its entire final message.",
];

const STAGE1_PROMPT = [
	"This is a controlled context-pressure experiment. Perform EXACTLY these actions, in order:",
	"",
	'1. Call TodoWrite with EXACTLY 30 items. Content strings are exactly "Step 01", "Step 02", ..., "Step 30". Step 01 has status "completed"; every other item has status "pending".',
	"",
	"2. Then reply with exactly: STAGE1-DONE",
].join("\n");

function giantPrompt(lines) {
	return [
		`This is a long-output performance test. Your ENTIRE reply must be the integers from 1 to ${lines}, one per line, and absolutely nothing else.`,
		`It is EXPECTED and REQUIRED that this reply is very long (about ${Math.round((lines * 6) / 1024)} KB). Do not summarize, do not truncate, do not use "...", do not use any tool, do not add commentary. Start at 1 and end at ${lines}.`,
		"",
		'Standing rule for this session: if you receive a continuation message that begins with "[sol-occ]", first call TodoWrite with the same 30 items but with the next pending step changed to "completed" (Step 02 first, then Step 03, ...), then reply with exactly: DONE',
	].join("\n");
}

function occHistoryBlocks(history) {
	return (history ?? []).filter((entry) => typeof entry.reason === "string" && entry.reason.startsWith("stop-block"));
}

export async function run({ deadline } = {}) {
	const assertions = makeAssertions();
	const sessionIds = [];
	const usages = [];
	const notes = { math: NOTES_MATH, rounds: [] };
	const sc = await makeScenario(id, { options: { onlineCompact: true, trajectory: true, evidenceReducer: true } });
	try {
		const lines = 22_500;
		notes.lines = lines;

		// R1 — tiny first stop (cheap first increment).
		const stage1 = await runPrompt(sc, STAGE1_PROMPT, { label: "occ-stage1", timeoutMs: 240_000 });
		sessionIds.push(stage1.sessionId);
		if (stage1.usage) usages.push(stage1.usage);
		assertions.check("stage1 session completed (exit 0)", stage1.code === 0, `code=${stage1.code} signal=${stage1.signal}`);

		const session = stage1.sessionId;
		let state = await readOccState(sc, session);
		const T1 = state?.lastContextTokens ?? null;
		notes.rounds.push({
			label: stage1.label,
			requestCount: state?.requestCount ?? null,
			T: T1,
			increments: state?.increments ?? [],
			pendingBoundary: state?.pendingBoundary ?? null,
			totalBlocks: state?.totalBlocks ?? null,
		});
		assertions.check("occ state exists after stage1 (onlineCompact active)", state !== null, "occ-state.json missing");
		assertions.check(
			"stage1 recorded the TodoWrite boundary (pendingBoundary=true)",
			state?.pendingBoundary === true,
			`pendingBoundary=${state?.pendingBoundary}`,
		);
		const history1 = await readJsonl(ledgerPath(sc, session, "occ-history.jsonl"));
		const noPrematureBlock = occHistoryBlocks(history1).length === 0;
		assertions.check("no block at Stop#1 (single-increment economics cannot fire — see notes.math)", noPrematureBlock, `blocks=${occHistoryBlocks(history1).length}`);

		// R2 — giant final message (the pressure round).
		const resume1 = await runPrompt(sc, giantPrompt(lines), { resume: session, label: "occ-resume-giant", timeoutMs: 690_000 });
		notes.resumeStderrTail = resume1.stderr.slice(-400);
		sessionIds.push(resume1.sessionId);
		if (resume1.usage) usages.push(resume1.usage);
		assertions.check("giant resume session completed (exit 0)", resume1.code === 0, `code=${resume1.code} signal=${resume1.signal} ms=${resume1.ms}`);

		state = await readOccState(sc, session);
		const T2 = state?.lastContextTokens ?? null;
		notes.rounds.push({
			label: resume1.label,
			sameSessionId: resume1.sessionId === session,
			requestCount: state?.requestCount ?? null,
			T: T2,
			increments: state?.increments ?? [],
			pendingBoundary: state?.pendingBoundary ?? null,
			totalBlocks: state?.totalBlocks ?? null,
			consecutiveBlocks: state?.consecutiveBlocks ?? null,
			requests: resume1.usage?.modelRequestCount ?? null,
			outputTokens: resume1.usage?.outputTokens ?? null,
			responseBytes: (resume1.response ?? "").length,
		});
		assertions.check("--resume preserved the sessionId (OCC state continuity)", resume1.sessionId === session, `${resume1.sessionId} vs ${session}`);
		assertions.check(
			"two positive increments accumulated (tiny first stop + giant second stop)",
			(state?.increments ?? []).length >= 2,
			`increments=${JSON.stringify(state?.increments ?? [])}`,
		);
		assertions.check(
			"giant final message pushed the estimate past the 34.1k-token economic threshold",
			typeof T2 === "number" && T2 >= 34_055,
			`T2=${T2} (response bytes=${(resume1.response ?? "").length})`,
		);

		// Final assertions over occ-history.
		const history = await readJsonl(ledgerPath(sc, session, "occ-history.jsonl"));
		const blocks = occHistoryBlocks(history);
		const maxConsecutive = Math.max(0, ...(history ?? []).map((entry) => entry.state?.consecutiveBlocks ?? 0));
		const maxTotal = Math.max(0, ...(history ?? []).map((entry) => entry.state?.totalBlocks ?? 0));
		notes.blockEvents = blocks.map((entry) => ({ reason: entry.reason, consecutive: entry.state?.consecutiveBlocks, total: entry.state?.totalBlocks }));
		notes.maxConsecutiveBlocks = maxConsecutive;
		notes.maxTotalBlocks = maxTotal;
		notes.finalState = state;

		assertions.check("occ-history exists (hash-chained ledger)", history !== null, `${ledgerPath(sc, session, "occ-history.jsonl")}`);
		const economicBlocks = blocks.filter((entry) => entry.reason === "stop-block-economic");
		assertions.check(
			"economic Stop-block fired in the real session (ledger stop-block-economic)",
			economicBlocks.length >= 1,
			`blocks=${JSON.stringify(notes.blockEvents)} T1=${T1} T2=${T2}`,
		);
		assertions.check("consecutive blocks never exceeded 2 (plugin self-limit)", maxConsecutive <= 2, `max=${maxConsecutive}`);
		assertions.check("session block budget never exceeded 3", maxTotal <= 3, `max=${maxTotal}`);

		// Continuation evidence: host re-ran Stop (stop_hook_active) and the model
		// reacted to the [sol-occ] reason by TodoWrite-ing the next step.
		const events = await probeEvents(sc);
		const stops = events.filter((entry) => entry.event === "Stop");
		const activeStops = stops.filter((entry) => entry.payload?.stop_hook_active === true || entry.payload?.stopHookActive === true);
		notes.stopEvents = stops.length;
		notes.stopHookActiveEvents = activeStops.length;
		if (economicBlocks.length >= 1) {
			assertions.check(
				"host continued the turn after the block (>=1 Stop with stop_hook_active=true)",
				activeStops.length >= 1,
				`stops=${stops.length} active=${activeStops.length}`,
			);
			const trajectory = await readTrajectory(sc, session);
			const todoWrites = (trajectory ?? []).filter((record) => record.event === "pre_tool" && record.tool === "TodoWrite").length;
			notes.todoWriteCalls = todoWrites;
			assertions.check(
				"model reacted to the [sol-occ] block reason (extra TodoWrite beyond stage1's single call)",
				todoWrites >= 2,
				`todoWrites=${todoWrites}`,
			);
			const rollout = await findRollout(sc, session);
			notes.blockReasonInRequest = rollout !== null && (await rolloutFindString(rollout, "[sol-occ] boundary reached")) !== null;
			assertions.check(
				"block reason '[sol-occ] boundary reached' appears in a subsequent model request body (G17 channel)",
				notes.blockReasonInRequest === true,
				`rollout=${rollout ?? "missing"}`,
			);
		}

		// 5b — compaction detection: honest observation over the snapshot series.
		const snapshots = (history ?? [])
			.map((entry) => entry.state?.transcriptSnapshot ?? null)
			.filter((snapshot) => snapshot !== null);
		const drops = [];
		for (let i = 1; i < snapshots.length; i += 1) {
			const prev = snapshots[i - 1].entries ?? 0;
			const cur = snapshots[i].entries ?? 0;
			if (prev > 0 && cur <= Math.floor(prev * 0.7)) drops.push({ from: prev, to: cur });
		}
		notes.snapshotSeries = snapshots;
		notes.entryDrops = drops;
		notes.autoCompactObserved = drops.length > 0;
		notes.compactionDetectionVerdict =
			drops.length > 0
				? `autoCompact observed (entries drop >=30%: ${JSON.stringify(drops)}); detector priorCompactionCount=${state?.priorCompactionCount ?? 0}, pendingCompactionReminder=${state?.pendingCompactionReminder ?? false}`
				: "autoCompact NOT observed in this real session (snapshot entries never dropped >=30%); detector stayed silent as designed — recorded as not-observed, nothing simulated (fixture-level detection is covered by P1 occ unit/integration tests)";

		await recordResult(id, {
			status: assertions.ok ? "pass" : "fail",
			title,
			sessionIds,
			usages,
			reducerCalls: 0,
			assertions: assertions.list,
			notes,
		});
		return { status: assertions.ok ? "pass" : "fail", assertions: assertions.list, notes };
	} finally {
		await cleanupScenario(sc);
	}
}
