/*
 * S5 — Online Context Compact, real long session (real model). v6.
 *
 * v6 redesign after the m2 estimator calibration: the cumulative estimator
 * now counts tool-result bytes AS DELIVERED TO THE MODEL — a truncated native
 * Bash output contributes only the host's ~2 KB persisted-output preview
 * envelope (G7), not its full stdoutBytes. v5 built its pressure from two
 * `seq 1 20000` outputs (108894 B each) whose bulk the model never saw, so
 * under the calibrated accounting that construction cannot reach the economic
 * zone. v6 builds pressure from UNTRUNCATED outputs instead: `seq 1 6000`
 * emits 28893 B (< the host's 30000-char/byte inline cutover, G6), so the
 * model sees — and the estimator counts — every byte. Real pressure and
 * estimated pressure now coincide by construction.
 *
 * Estimator (G21 fix): T = ceil(cumulativeBytes/4) + 12_000 system baseline;
 * cumulativeBytes sums UserPromptSubmit prompt bytes + PostToolUse
 * tool_response bytes (model-visible calibration) + Stop
 * last_assistant_message bytes. Increments are per-Stop deltas of T.
 *
 * Real-window trigger math (notes.math below, no threshold lowering — the
 * plugin default 1M window is used as-is):
 *   R1: TodoWrite boundary (Step 01 completed, 29 pending) + ONE untruncated
 *       `seq 1 6000` (28893 B) -> Stop #1: T1 ~= 19.4k tokens < 21000
 *       (memo+keepRecent floor) -> savingTokens <= 0 -> compact is
 *       STRUCTURALLY unreachable (stronger than v5's marginal-discriminant
 *       argument); asserted as the no-premature-block check.
 *   R2 (--resume, same sessionId): THREE more untruncated `seq 1 6000` calls
 *       -> Stop #2: T2 ~= 41k, increments [T1, T2-T1] collapse the average,
 *       breakeven (~23 requests) fits the horizon (~46) -> {"decision":"block"}
 *       fires (the only model-reachable Stop channel, G17). Continuations
 *       follow the standing rule (TodoWrite next step + short reply); the
 *       next Stop is still economical -> a second block; the consecutive
 *       self-limit (2) then ends the loop.
 *
 * Compaction detection (5b): honestly recorded as "unavailable" under the G21
 * data source — the entries-drop detector cannot see native compaction
 * because the cumulative total never decreases when history we cannot observe
 * is compacted away. Nothing is faked; the detector path stays armed for
 * hosts that provide full-conversation transcripts.
 *
 * Options: onlineCompact + trajectory only (observationPack/evidenceReducer
 * stay OFF on purpose: sol_bash would placeholder-replace outputs >10 KiB and
 * change the model-visible volume the estimator must track).
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
export const title = "OCC cumulative-estimator economic Stop-block trigger (real 1M window, model-visible-byte calibrated) + honest G21 detector downgrade";

const SEQ_BYTES = 28_893; // `seq 1 6000`: 9*2 + 90*3 + 900*4 + 5001*5 bytes (ASCII)

const NOTES_MATH = [
	"Estimator (G21 fix, m2-calibrated): T = ceil(cumulativeBytes/4) + 12_000 system baseline; cumulativeBytes sums UserPromptSubmit prompt bytes + PostToolUse tool_response bytes counted AS DELIVERED TO THE MODEL (untruncated streams: full byte fields; truncated streams: the host's ~2 KB persisted-output preview envelope, G7) + Stop last_assistant_message bytes. Increments are per-Stop deltas of T (sliding window 20).",
	`Stop #1 (single untruncated seq output, ${SEQ_BYTES} B): cumulative ~= 29.7k B -> T1 ~= 19.4k tokens < 21_000 (keepRecent 20k + memo 1k) -> savingTokens <= 0 -> compressible=false, compact STRUCTURALLY unreachable regardless of horizon; asserted as the no-premature-block check.`,
	`Stop #2 (three more untruncated seq outputs): cumulative ~= 117k B -> T2 ~= 41k tokens; increments [T1, T2-T1] -> avg ~= T2/2 ~= 20.6k; windowRequestUpperBound = floor((1e6-41k)/20.6k) ~= 46, expectedRemaining = min(30, 46) = 30, effectiveHorizon = min(2*30, 46) = 46, breakeven = 11.5*41k/(41k-21k) ~= 23.4 <= 46 -> economic block. Real thresholds, real window, and every counted byte was actually in the model context.`,
	"Compaction detection (5b): G21 makes the entries-drop detector structurally blind (Stop transcript entries pinned at 1; the cumulative total cannot decrease when unobservable history is compacted) -> occ-state records compactionDetection=unavailable; priorCompactionCount stays 0; nothing is simulated.",
];

const STANDING_RULE =
	'Standing rule for this session: if you receive a continuation message that begins with "[sol-occ]", first call TodoWrite with the same 30 items but with the next pending step changed to "completed" (Step 02 first, then Step 03, ...), then reply with exactly: DONE';

const STAGE1_PROMPT = [
	"This is a controlled context-pressure experiment. Perform EXACTLY these actions, in order:",
	"",
	'1. Call TodoWrite with EXACTLY 30 items. Content strings are exactly "Step 01", "Step 02", ..., "Step 30". Step 01 has status "completed"; every other item has status "pending".',
	"",
	"2. Run the Bash tool with the command exactly: seq 1 6000",
	"",
	"3. Then reply with exactly: STAGE1-DONE",
	"",
	STANDING_RULE,
].join("\n");

const STAGE2_PROMPT = [
	"Continue the context-pressure experiment. Perform EXACTLY these actions, in order:",
	"",
	"1. Run the Bash tool THREE TIMES, as THREE SEPARATE Bash tool calls (do not combine them into one command), each with the command exactly: seq 1 6000",
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
		// R1 — boundary + first untruncated big tool output.
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
		assertions.check(
			"occ state exists after stage1 (onlineCompact active)",
			state !== null,
			state === null ? "occ-state.json missing" : `cumulativeBytes=${state.cumulativeBytes} T1=${state.lastContextTokens}`,
		);
		assertions.check(
			"stage1 recorded the TodoWrite boundary (pendingBoundary=true)",
			state?.pendingBoundary === true,
			`pendingBoundary=${state?.pendingBoundary}`,
		);
		assertions.check(
			`calibrated estimator saw the untruncated tool volume in full (>=${SEQ_BYTES}B accumulated — model-visible accounting, m2)`,
			(state?.cumulativeBytes ?? 0) >= SEQ_BYTES,
			`cumulativeBytes=${state?.cumulativeBytes}`,
		);
		const history1 = await readJsonl(ledgerPath(sc, session, "occ-history.jsonl"));
		const noPrematureBlock = occHistoryBlocks(history1).length === 0;
		assertions.check(
			"no block at Stop#1 (T1 below the 21k compressibility floor — structurally unreachable, see notes.math)",
			noPrematureBlock,
			`blocks=${occHistoryBlocks(history1).length} T1=${T1}`,
		);

		// R2 — three more untruncated outputs (the pressure round).
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
			"cumulative estimate reached the economic zone from model-visible bytes alone (T2 >= 30k tokens; m2-calibrated)",
			typeof T2 === "number" && T2 >= 30_000,
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
				"pressure came from real untruncated native Bash outputs (>=3 Bash calls)",
				bashCalls >= 3,
				`bashCalls=${bashCalls}`,
			);
			const rollout = await findRollout(sc, session);
			// requestOnly (m4): the reason must be in a model REQUEST message.
			notes.blockReasonInRequest = rollout !== null && (await rolloutFindString(rollout, "[sol-occ] boundary reached", { requestOnly: true })) !== null;
			assertions.check(
				"block reason '[sol-occ] boundary reached' appears in a subsequent model request message (G17 channel)",
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
