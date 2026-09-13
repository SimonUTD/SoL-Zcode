/*
 * S5 — Online Context Compact, real long session (real model). v5.
 *
 * v5 redesign after the P2.5 OCC fix (GOTCHAS G21/G22): pressure detection is
 * a CUMULATIVE estimator fed by everything the hooks can see
 * (UserPromptSubmit prompt bytes, PostToolUse tool_response byte fields —
 * stdoutBytes carries the FULL output even though the payload stdout is
 * truncated, G6 — and Stop last_assistant_message bytes). The v4 approach
 * (estimate from the Stop transcript) is structurally blind: 0.16.5 headless
 * Stop transcripts carry ONLY the last assistant message (94-114 B observed),
 * so tool-call volume can never grow the estimate.
 *
 * Real-window trigger math (notes.math below, no threshold lowering — the
 * plugin default 1M window is used as-is):
 *   R1: TodoWrite boundary (Step 01 completed, 29 pending) + one native
 *       `seq 1 20000` (~108.9 KB stdout, the G6-measured size) -> Stop #1:
 *       single increment -> no block (asserted; negative-discriminant math).
 *   R2 (--resume, same sessionId): second `seq 1 20000` -> Stop #2: two
 *       increments collapse the average, the window request bound opens and
 *       breakeven (~16.8 requests at T2 ~= 66.7k tokens) fits the horizon
 *       (~27) -> {"decision":"block"} fires (the only model-reachable Stop
 *       channel, G17). Continuations follow the standing rule (TodoWrite next
 *       step + short reply); the second Stop is still economical -> a second
 *       block; the consecutive self-limit (2) then ends the loop.
 *
 * Compaction detection (5b): honestly recorded as "unavailable" under the G21
 * data source — the entries-drop detector cannot see native compaction
 * because the cumulative total never decreases when history we cannot observe
 * is compacted away. Nothing is faked; the detector path stays armed for
 * hosts that provide full-conversation transcripts.
 *
 * Options: onlineCompact + trajectory only (observationPack/evidenceReducer
 * stay OFF on purpose: sol_bash would placeholder-replace the large outputs
 * and the pressure construction needs the native Bash byte fields).
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
export const title = "OCC cumulative-estimator economic Stop-block trigger (real 1M window) + honest G21 detector downgrade";

const NOTES_MATH = [
	"Estimator (G21 fix): T = ceil(cumulativeBytes/4) + 12_000 system baseline; cumulativeBytes sums UserPromptSubmit prompt bytes + PostToolUse tool_response bytes (stdoutBytes/stderrBytes fields preferred — full output size, G6) + Stop last_assistant_message bytes. Increments are per-Stop deltas of T (sliding window 20).",
	"Stop #1 (single increment, window 1e6): need 11.5*T/(T-21000) <= min(2*min(1+29, floor((1e6-T)/T)), floor((1e6-T)/T)) — with one increment the average IS T, so effectiveHorizon <= floor((1e6-T)/T) < 11.5 for all T < 87k, and 11.5*T/(T-21000) >= 11.5 always — mathematically unreachable; asserted as the no-premature-block check.",
	"Stop #2 (increments [T1, T2-T1], T2 ~= 66_700 after two seq 1 20000 runs ~= 108_894 B each + prompts): avg = T2/2 ~= 33_350, windowRequestUpperBound = floor((1e6-T2)/avg) ~= 27, expectedRemaining = min(30, 27) = 27, effectiveHorizon (first compaction, scale 2, capped by wu) = 27, breakeven = 11.5*66_700/(66_700-21_000) ~= 16.8 <= 27 -> economic block. Real thresholds, real window.",
	"Compaction detection (5b): G21 makes the entries-drop detector structurally blind (Stop transcript entries pinned at 1; the cumulative total cannot decrease when unobservable history is compacted) -> occ-state records compactionDetection=unavailable; priorCompactionCount stays 0; nothing is simulated.",
];

const STANDING_RULE =
	'Standing rule for this session: if you receive a continuation message that begins with "[sol-occ]", first call TodoWrite with the same 30 items but with the next pending step changed to "completed" (Step 02 first, then Step 03, ...), then reply with exactly: DONE';

const STAGE1_PROMPT = [
	"This is a controlled context-pressure experiment. Perform EXACTLY these actions, in order:",
	"",
	'1. Call TodoWrite with EXACTLY 30 items. Content strings are exactly "Step 01", "Step 02", ..., "Step 30". Step 01 has status "completed"; every other item has status "pending".',
	"",
	"2. Run the Bash tool with the command exactly: seq 1 20000",
	"",
	"3. Then reply with exactly: STAGE1-DONE",
	"",
	STANDING_RULE,
].join("\n");

const STAGE2_PROMPT = [
	"Continue the context-pressure experiment. Perform EXACTLY these actions, in order:",
	"",
	"1. Run the Bash tool with the command exactly: seq 1 20000",
	"",
	"2. Then reply with exactly: DONE2",
	"",
	STANDING_RULE,
].join("\n");

function occHistoryBlocks(history) {
	return (history ?? []).filter((entry) => typeof entry.reason === "string" && entry.reason.startsWith("stop-block"));
}

export async function run({ deadline } = {}) {
	const assertions = makeAssertions();
	const sessionIds = [];
	const usages = [];
	const notes = { math: NOTES_MATH, rounds: [] };
	const sc = await makeScenario(id, { options: { onlineCompact: true, trajectory: true } });
	try {
		// R1 — boundary + first big tool output (cheap first increment).
		const stage1 = await runPrompt(sc, STAGE1_PROMPT, { label: "occ-stage1", timeoutMs: 300_000 });
		sessionIds.push(stage1.sessionId);
		if (stage1.usage) usages.push(stage1.usage);
		assertions.check("stage1 session completed (exit 0)", stage1.code === 0, `code=${stage1.code} signal=${stage1.signal} ms=${stage1.ms}`);

		const session = stage1.sessionId;
		let state = await readOccState(sc, session);
		const T1 = state?.lastContextTokens ?? null;
		notes.rounds.push({
			label: stage1.label,
			requestCount: state?.requestCount ?? null,
			cumulativeBytes: state?.cumulativeBytes ?? null,
			estimatedTokens: state?.estimatedTokens ?? null,
			T: T1,
			increments: state?.increments ?? [],
			pendingBoundary: state?.pendingBoundary ?? null,
			totalBlocks: state?.totalBlocks ?? null,
			compactionDetection: state?.compactionDetection ?? null,
		});
		assertions.check("occ state exists after stage1 (onlineCompact active)", state !== null, "occ-state.json missing");
		assertions.check(
			"stage1 recorded the TodoWrite boundary (pendingBoundary=true)",
			state?.pendingBoundary === true,
			`pendingBoundary=${state?.pendingBoundary}`,
		);
		assertions.check(
			"cumulative estimator saw the tool volume (>=100KB accumulated, G21 regression)",
			(state?.cumulativeBytes ?? 0) >= 100_000,
			`cumulativeBytes=${state?.cumulativeBytes}`,
		);
		const history1 = await readJsonl(ledgerPath(sc, session, "occ-history.jsonl"));
		const noPrematureBlock = occHistoryBlocks(history1).length === 0;
		assertions.check("no block at Stop#1 (single-increment economics cannot fire — see notes.math)", noPrematureBlock, `blocks=${occHistoryBlocks(history1).length}`);

		// R2 — second big tool output (the pressure round).
		const resume1 = await runPrompt(sc, STAGE2_PROMPT, { resume: session, label: "occ-resume-pressure", timeoutMs: 420_000 });
		notes.resumeStderrTail = resume1.stderr.slice(-400);
		sessionIds.push(resume1.sessionId);
		if (resume1.usage) usages.push(resume1.usage);
		assertions.check("pressure resume session completed (exit 0)", resume1.code === 0, `code=${resume1.code} signal=${resume1.signal} ms=${resume1.ms}`);

		state = await readOccState(sc, session);
		const T2 = state?.lastContextTokens ?? null;
		notes.rounds.push({
			label: resume1.label,
			sameSessionId: resume1.sessionId === session,
			requestCount: state?.requestCount ?? null,
			cumulativeBytes: state?.cumulativeBytes ?? null,
			estimatedTokens: state?.estimatedTokens ?? null,
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
			"two positive increments accumulated (boundary stop + pressure stop)",
			(state?.increments ?? []).length >= 2,
			`increments=${JSON.stringify(state?.increments ?? [])}`,
		);
		assertions.check(
			"cumulative estimate reached the economic zone (T2 >= 55k tokens)",
			typeof T2 === "number" && T2 >= 55_000,
			`T2=${T2}`,
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
		notes.ledgerReasons = (history ?? []).map((entry) => entry.reason);

		assertions.check("occ-history exists (hash-chained ledger)", history !== null, `${ledgerPath(sc, session, "occ-history.jsonl")}`);
		const economicBlocks = blocks.filter((entry) => entry.reason === "stop-block-economic");
		assertions.check(
			"economic Stop-block fired in the real session (ledger stop-block-economic)",
			economicBlocks.length >= 1,
			`blocks=${JSON.stringify(notes.blockEvents)} T1=${T1} T2=${T2}`,
		);
		assertions.check("consecutive blocks never exceeded 2 (plugin self-limit)", maxConsecutive <= 2, `max=${maxConsecutive}`);
		assertions.check("session block budget never exceeded 3", maxTotal <= 3, `max=${maxTotal}`);
		assertions.check(
			"decision used the real 1M window (no threshold lowering)",
			state?.contextWindowTokens === 1_000_000,
			`contextWindowTokens=${state?.contextWindowTokens}`,
		);

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
			const bashCalls = (trajectory ?? []).filter((record) => record.event === "pre_tool" && record.tool === "Bash").length;
			notes.todoWriteCalls = todoWrites;
			notes.bashCalls = bashCalls;
			assertions.check(
				"model reacted to the [sol-occ] block reason (extra TodoWrite beyond stage1's single call)",
				todoWrites >= 2,
				`todoWrites=${todoWrites}`,
			);
			assertions.check(
				"pressure came from real native Bash outputs (>=2 Bash calls)",
				bashCalls >= 2,
				`bashCalls=${bashCalls}`,
			);
			const rollout = await findRollout(sc, session);
			notes.blockReasonInRequest = rollout !== null && (await rolloutFindString(rollout, "[sol-occ] boundary reached")) !== null;
			assertions.check(
				"block reason '[sol-occ] boundary reached' appears in a subsequent model request body (G17 channel)",
				notes.blockReasonInRequest === true,
				`rollout=${rollout ?? "missing"}`,
			);
		}

		// 5b — compaction detection: honest G21 downgrade, nothing simulated.
		notes.snapshotSeries = (history ?? [])
			.map((entry) => entry.state?.transcriptSnapshot ?? null)
			.filter((snapshot) => snapshot !== null);
		assertions.check(
			"compaction detection honestly recorded unavailable under the G21 data source",
			state?.compactionDetection === "unavailable",
			`compactionDetection=${state?.compactionDetection}`,
		);
		assertions.check(
			"no fabricated compaction (priorCompactionCount=0, no reminder)",
			state?.priorCompactionCount === 0 && state?.pendingCompactionReminder === false,
			`priorCompactionCount=${state?.priorCompactionCount} pendingCompactionReminder=${state?.pendingCompactionReminder}`,
		);
		notes.compactionDetectionVerdict =
			"detector unavailable under G21 (Stop transcript = last assistant message only; cumulative total cannot observe native compaction) — recorded as unavailable, code path retained for full-transcript hosts; fixture-level detection covered by occ unit tests";

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
