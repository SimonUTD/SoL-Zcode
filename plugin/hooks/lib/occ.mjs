/*
 * Online Context Compact state machine (DESIGN §2.4) for sol-zcode.
 *
 * Upstream (SoL-Pi) could call context.compact() and send a hidden reminder;
 * Zcode has no public API for either. This port keeps the candidate selection,
 * boundary accounting, sliding-window increments and vendor economics 1:1, and
 * maps the action channel onto what the host offers:
 *   - economic suggestion → Stop hook {"decision":"block","reason":"[sol-occ] …"}
 *     (the only Stop output shape that reaches the model, G17);
 *   - compaction detection → transcript observation delta (entries drop ≥30%
 *     in the same session), reminder delivered on the NEXT Stop via the same
 *     block channel (DESIGN §2.4 action 3). Under the cumulative estimator the
 *     Stop transcript in zcode 0.16.5 carries ONLY the last assistant message
 *     (G21), so the drop detector is honestly recorded as "unavailable" until
 *     a host provides a full-conversation transcript again;
 *   - self-limits: at most 2 consecutive blocks (host cap 3, one spare) and at
 *     most 3 blocks per session (upstream maxAutoContinuations=3 semantics).
 *
 * Pressure estimation is a CUMULATIVE estimator (G21 redesign): the Stop-time
 * transcript is structurally last-message-only in 0.16.5 headless, so context
 * pressure is estimated by accumulating every context volume the hooks CAN see
 * — UserPromptSubmit prompt bytes, PostToolUse tool_response bytes (stdout+
 * stderr byte fields, or the structured response size), Stop
 * last_assistant_message bytes — into occ-state (cumulativeBytes /
 * estimatedTokens, tokens = bytes/4). writeTokens = cumulative estimate + a
 * fixed system-prompt baseline. Known blind spot (underestimate, never
 * fabricated): assistant tool-call turns are not hook-visible.
 *
 * State: occ-state.json snapshot; every mutation first appends the full new
 * state to occ-history.jsonl (hash-chained).
 */

import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { DEFAULT_COMPACTION_ECONOMICS, analyzePlanTransition, decideCompaction, parsePlanSteps } from "../../core/index.mjs";
import { appendChained, withPluginLock } from "./chain.mjs";
import { occHistoryPath, occStatePath, safeSessionId } from "./store.mjs";

export const MEMO_TOKENS = 1_000;
export const KEEP_RECENT_TOKENS = 20_000;
export const CACHE_WRITE_READ_RATIO = 12.5;
export const MAX_INCREMENT_HISTORY = 20;
export const MAX_BOUNDARY_HISTORY = 12;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const MAX_CONSECUTIVE_BLOCKS = 2;
export const MAX_SESSION_BLOCKS = 3;
export const COMPACTION_DROP_RATIO = 0.3;

// Cumulative estimator constants (G21 redesign; DESIGN §2.4 "chars/4 估算 +
// system 长度"). CHARS_PER_TOKEN mirrors the vendor observation-pack constant.
export const CHARS_PER_TOKEN = 4;
// Fixed stand-in for the host system prompt + tool-schema overhead that hooks
// cannot read: a minimal headless session already reports ~12.7k contextUsed
// (P2 s3 probe, projection.contextUsed=12762 for a near-empty prompt).
export const SYSTEM_BASELINE_TOKENS = 12_000;

const OCC_STATE_SCHEMA = "sol_zcode_online_context_compact/1";

/**
 * Serialize every occ-state read-modify-write section under a per-session
 * O_EXCL lock (audit m1): the host executes same-step tool calls in parallel,
 * so concurrent PostToolUse/Stop/UserPromptSubmit hook processes race on the
 * occ-state.json snapshot (lost accumulate; narrow interleavings could even
 * roll back the block counters a late writer persisted). persistOccState does
 * NOT take this lock itself — all mutation entry points below wrap their whole
 * load→mutate→persist section in withOccStateLock. Readers (loadOccState)
 * stay lock-free: the snapshot advances via tmp+rename, so a reader sees
 * either the old or the new value, never a torn one (a briefly stale read is
 * fail-safe — the next mutation re-reads under the lock).
 */
function withOccStateLock(dataRoot, sessionId, fn) {
	// safeSessionId keeps the lock name inside run/locks even for a caller
	// that has not sanitized yet (all hook call sites already pass safe ids).
	return withPluginLock(dataRoot, `occ-state-${safeSessionId(sessionId)}`, fn);
}

export function initialOccState() {
	return {
		schema: OCC_STATE_SCHEMA,
		epoch: 0,
		plan: [],
		pendingBoundary: false,
		requestCount: 0,
		lastBoundaryRequestCount: 0,
		completedBoundaryRequestCounts: [],
		increments: [],
		lastContextTokens: 0,
		cumulativeBytes: 0,
		estimatedTokens: 0,
		compactionDetection: "unknown",
		priorCompactionCount: 0,
		carriedDebtTokens: 0,
		cacheDebtRepaymentTokens: 0,
		consecutiveBlocks: 0,
		totalBlocks: 0,
		pendingCompactionReminder: false,
		transcriptSnapshot: null,
		model: null,
		contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
	};
}

export async function loadOccState(dataRoot, sessionId) {
	try {
		const raw = await readFile(occStatePath(dataRoot, sessionId), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed?.schema !== OCC_STATE_SCHEMA) return initialOccState();
		return { ...initialOccState(), ...parsed };
	} catch {
		return initialOccState();
	}
}

/**
 * Append the new state to the chained history, then overwrite the snapshot.
 * Callers must hold the occ-state lock (withOccStateLock); the history append
 * takes its own per-ledger lock, always nested INSIDE the state lock (single
 * nesting order → no deadlock).
 *
 * Nano fix: when appendChained returns null (its own lock timed out) the
 * snapshot is NOT advanced — the hash-chained history line is the durable
 * record, and a snapshot ahead of the history would be an undetectable gap.
 * Skipping the rename drops this update from the snapshot (fail-safe
 * under-count), never fabricating state the history cannot vouch for.
 */
export async function persistOccState(dataRoot, sessionId, state, reason) {
	const appended = await appendChained(dataRoot, occHistoryPath(dataRoot, sessionId), {
		event: "state",
		reason: typeof reason === "string" ? reason : "update",
		state,
	});
	if (appended === null) return null;
	const tmp = `${occStatePath(dataRoot, sessionId)}.tmp-${process.pid}`;
	await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
	await rename(tmp, occStatePath(dataRoot, sessionId));
	return appended;
}

/**
 * Cumulative estimator feed (G21): add one hook-visible context volume —
 * UserPromptSubmit prompt bytes, PostToolUse tool_response bytes, Stop
 * last_assistant_message bytes — to occ-state. Hooks are separate processes;
 * occ-state.json is the shared blackboard, so every event loads→adds→persists
 * under the per-session state lock (audit m1: parallel same-step tool calls
 * make concurrent PostToolUse hook processes a real interleaving).
 * tokens = bytes/4 (CHARS_PER_TOKEN, same convention as the vendor
 * observation pack).
 */
export async function accumulateOccUsage(dataRoot, sessionId, bytes, kind) {
	return withOccStateLock(dataRoot, sessionId, async () => {
		const state = await loadOccState(dataRoot, sessionId);
		const add = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0;
		state.cumulativeBytes += add;
		state.estimatedTokens = Math.ceil(state.cumulativeBytes / CHARS_PER_TOKEN);
		await persistOccState(dataRoot, sessionId, state, `usage:${typeof kind === "string" && kind.length > 0 ? kind : "event"}`);
		return state;
	});
}

/**
 * Effective context window resolution order: host payload field (absent in
 * 0.16.5, S3 probe) → SOL_ZCODE_OCC_WINDOW_TOKENS env → caller keeps the
 * persisted/default value. The env knob is the sanctioned injection point for
 * reduced-window simulations in tests/e2e (thresholds and window constants
 * themselves are never edited).
 */
export function resolveContextWindowTokens({ payloadWindow, env = process.env } = {}) {
	if (Number.isFinite(payloadWindow) && payloadWindow > 0) return Math.floor(payloadWindow);
	const fromEnv = Number(env.SOL_ZCODE_OCC_WINDOW_TOKENS);
	if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
	return undefined;
}

// ---------------------------------------------------------------- m2 calibration

/**
 * Head-preview chars the host keeps in the model-visible persisted-output
 * envelope (zcode 0.16.5 REr: previewChars 2e3; G7 measured ~2 KB). The
 * envelope shape (verified against the decompiled host formatter):
 *
 *   <persisted-output>
 *   Output too large (<KB>). Full output saved to: <path>
 *
 *   Preview (first 2 KB):
 *   <first 2000 chars of the output>
 *   ...
 *   </persisted-output>
 */
export const PERSISTED_PREVIEW_CHARS = 2000;

/** Host byte formatter (N7o): "<n> B" / "<round(n/1e3)> KB" / ... */
function formatKb(bytes) {
	if (bytes < 1000) return `${bytes} B`;
	if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
	if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
	return `${Math.round(bytes / 1_000_000_000)} GB`;
}

function byteLength(text) {
	return Buffer.byteLength(text, "utf8");
}

/** Model-visible size of one native output stream (G7): full bytes when the
 * stream was delivered intact, the persisted-output envelope when truncated. */
function nativeStreamModelBytes(response, stream) {
	const truncated = response[`${stream}Truncated`] === true;
	const bytesField = Number.isFinite(response[`${stream}Bytes`]) ? Math.max(0, Math.floor(response[`${stream}Bytes`])) : null;
	const text = typeof response[stream] === "string" ? response[stream] : "";
	if (!truncated) return bytesField ?? byteLength(text);
	// Truncated: the model keeps only the host envelope — head preview (~2 KB)
	// plus the notice carrying the byte count and the persisted path (audit m2;
	// the full stdoutBytes never entered the context). The payload stream text
	// is itself host-truncated (30000 chars, G6) but always covers the first
	// PERSISTED_PREVIEW_CHARS of the original. Preview is cut at the char cap;
	// the host also trims back to the last newline (±1 line — estimator-grade).
	const total = bytesField ?? byteLength(text);
	const path =
		stream === "stdout"
			? typeof response.persistedOutputPath === "string" && response.persistedOutputPath.length > 0
				? response.persistedOutputPath
				: typeof response.stdoutPersistedOutputPath === "string"
					? response.stdoutPersistedOutputPath
					: ""
			: typeof response.stderrPersistedOutputPath === "string"
				? response.stderrPersistedOutputPath
				: "";
	const envelope = [
		"<persisted-output>",
		`Output too large (${formatKb(total)}). Full output saved to: ${path}`,
		"",
		"Preview (first 2 KB):",
		text.slice(0, PERSISTED_PREVIEW_CHARS),
		"...",
		"</persisted-output>",
	].join("\n");
	return byteLength(envelope);
}

/**
 * G21 cumulative estimator input: the PostToolUse tool_response volume AS
 * DELIVERED TO THE MODEL (audit m2 calibration — the old version counted full
 * stdoutBytes even when the model only ever saw the ~2 KB host preview, a
 * systematic over-estimate in the premature-compaction direction):
 *   - native Bash-shaped responses: stdoutBytes+stderrBytes when neither stream
 *     is truncated (delivered intact); per-stream persisted-output envelope
 *     estimate when truncated (G6/G7);
 *   - MCP tool responses ({content:[{type:"text",text}]} or plain strings):
 *     the text IS what the model sees — sol_* placeholders included, so no
 *     removedTokens adjustment is needed (the archived full output never
 *     enters the context);
 *   - other structured responses: stringified size (envelope-only over-count).
 */
export function occToolResponseBytes(toolResponse) {
	if (toolResponse === undefined || toolResponse === null) return 0;
	if (typeof toolResponse === "string") return byteLength(toolResponse);
	if (typeof toolResponse !== "object" || Array.isArray(toolResponse)) {
		try {
			return byteLength(JSON.stringify(toolResponse));
		} catch {
			return 0;
		}
	}
	if (Array.isArray(toolResponse.content)) {
		let total = 0;
		for (const part of toolResponse.content) {
			if (part !== null && typeof part === "object" && !Array.isArray(part) && typeof part.text === "string") {
				total += byteLength(part.text);
			}
		}
		if (total > 0) return total;
	}
	if (Number.isFinite(toolResponse.stdoutBytes) || Number.isFinite(toolResponse.stderrBytes) || typeof toolResponse.stdout === "string" || typeof toolResponse.stderr === "string") {
		return nativeStreamModelBytes(toolResponse, "stdout") + nativeStreamModelBytes(toolResponse, "stderr");
	}
	try {
		return byteLength(JSON.stringify(toolResponse));
	} catch {
		return 0;
	}
}

/**
 * Extract a plan from a TodoWrite payload. Zcode todos carry
 * {content, status, priority} with NO id (verified from live payloads), so
 * content-hash ids are synthesized (stable across cancelled-step removals);
 * OpenCode-style payloads with explicit ids pass through unchanged. Cancelled
 * steps are dropped.
 *
 * Duplicate-content todos would synthesize identical ids, which parsePlanSteps
 * rejects → the whole plan update was silently dropped (audit m5). Occurrence
 * suffixes (-2, -3, …) keep synthesized ids unique instead; the first
 * occurrence keeps the bare hash id so id stability for the normal
 * all-unique-content case is unchanged.
 */
export function todosToPlan(todos) {
	if (!Array.isArray(todos)) return undefined;
	const steps = [];
	const synthesized = new Map();
	for (const todo of todos) {
		if (typeof todo !== "object" || todo === null || Array.isArray(todo)) return undefined;
		const goal = todo.content;
		if (typeof goal !== "string") return undefined;
		let id;
		if (typeof todo.id === "string" && todo.id.length > 0) {
			id = todo.id;
		} else {
			const base = `todo-${createHash("sha256").update(goal, "utf8").digest("hex").slice(0, 10)}`;
			const seen = synthesized.get(base) ?? 0;
			synthesized.set(base, seen + 1);
			id = seen === 0 ? base : `${base}-${seen + 1}`;
		}
		const status = todo.status;
		if (status === "cancelled") continue;
		steps.push({
			id,
			goal,
			status: status === "completed" || status === "in_progress" ? status : "pending",
		});
	}
	return parsePlanSteps(steps);
}

/**
 * Observe a transcript JSONL: { entries, bytes, tokens } or null when the
 * transcript cannot be read. Secondary signal since the G21 redesign (in
 * 0.16.5 headless the Stop transcript carries only the last assistant
 * message): it feeds the max() context estimate, the compaction-detection
 * availability rule and the transcriptSnapshot diagnostics.
 * Token estimate: chars/4 over text-bearing string fields (sol-opencode
 * adapter approach; an estimate by design, DESIGN §8.10).
 */
export async function observeTranscript(transcriptPath) {
	if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return null;
	let raw;
	try {
		raw = await readFile(transcriptPath, "utf8");
	} catch {
		return null;
	}
	const lines = raw.split("\n").filter((line) => line.trim().length > 0);
	let chars = 0;
	for (const line of lines) {
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		chars += countTextChars(obj, undefined, 0);
	}
	// chars/4 estimate computed without materializing a padding string.
	const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
	return { entries: lines.length, bytes: Buffer.byteLength(raw, "utf8"), tokens };
}

const TEXT_KEYS = new Set(["text", "content", "thinking", "system"]);

function countTextChars(value, key, depth = 0) {
	if (depth > 12) return 0;
	if (typeof value === "string") return TEXT_KEYS.has(key) ? value.length : 0;
	if (Array.isArray(value)) {
		let total = 0;
		for (const item of value) total += countTextChars(item, key, depth + 1);
		return total;
	}
	if (typeof value === "object" && value !== null) {
		let total = 0;
		for (const [childKey, child] of Object.entries(value)) {
			total += countTextChars(child, childKey, depth + 1);
		}
		return total;
	}
	return 0;
}

function average(values) {
	if (values.length === 0) return null;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Stop-round OCC processing. Mutates and persists the state; returns
 * { block: null | { reason } , decision } for the hook envelope.
 *
 * G21 cumulative estimator: `assistantBytes` (the Stop payload's
 * last_assistant_message byte length, falling back to the transcript byte size
 * when that transcript is last-message-only) is accumulated FIRST; the context
 * estimate is then max(cumulative + system baseline, transcript estimate) —
 * the transcript only wins on a host that provides a full-conversation
 * transcript, where it is the strictly better signal.
 */
export async function runOccStopRound(
	dataRoot,
	sessionId,
	{ observation, stopHookActive, model, contextWindowTokens, assistantBytes = 0 },
) {
	return withOccStateLock(dataRoot, sessionId, () =>
		runOccStopRoundLocked(dataRoot, sessionId, { observation, stopHookActive, model, contextWindowTokens, assistantBytes }),
	);
}

async function runOccStopRoundLocked(
	dataRoot,
	sessionId,
	{ observation, stopHookActive, model, contextWindowTokens, assistantBytes = 0 },
) {
	const state = await loadOccState(dataRoot, sessionId);

	if (typeof model === "string" && model.length > 0) state.model = model;
	if (Number.isFinite(contextWindowTokens) && contextWindowTokens > 0) {
		state.contextWindowTokens = Math.floor(contextWindowTokens);
	}

	// A Stop that was not itself caused by our block resets the consecutive counter.
	if (stopHookActive !== true) state.consecutiveBlocks = 0;

	if (observation === null && !(assistantBytes > 0)) {
		// No signal at all (no transcript, no assistant message) → skip this
		// round entirely (fail-open). A readable transcript alone or any
		// accumulated usage is enough to proceed.
		await persistOccState(dataRoot, sessionId, state, "stop-observation-unavailable");
		return { block: null, decision: null, state };
	}

	if (assistantBytes > 0) {
		state.cumulativeBytes += Math.floor(assistantBytes);
		state.estimatedTokens = Math.ceil(state.cumulativeBytes / CHARS_PER_TOKEN);
	}

	// Context estimate: cumulative hook-visible volume + fixed system baseline,
	// never below the transcript estimate when one is readable.
	const cumulativeTotal = state.estimatedTokens + SYSTEM_BASELINE_TOKENS;
	const contextTotal = observation === null ? cumulativeTotal : Math.max(cumulativeTotal, observation.tokens);

	// Compaction detection availability (G21): the entries-drop detector needs a
	// full-conversation transcript. In 0.16.5 headless the Stop transcript is
	// structurally last-message-only (entries pinned at 1, token estimate ≪ the
	// accumulated conversation), so the detector would be silently blind — it is
	// honestly recorded as "unavailable" instead of pretending to watch. A
	// transcript that plausibly covers the whole conversation (≥2 entries and at
	// least as many estimated tokens as the hook-side accumulation) re-arms the
	// detector. DESIGN §2.4 deviation; see GOTCHAS G21.
	const detectionAvailable =
		observation !== null &&
		observation.entries >= 2 &&
		observation.tokens >= state.estimatedTokens;
	state.compactionDetection = detectionAvailable ? "available" : "unavailable";

	// Compaction detection: entries dropped ≥30% within the same session.
	const previousSnapshot = state.transcriptSnapshot;
	let compactionDetected = false;
	if (
		detectionAvailable &&
		previousSnapshot !== null &&
		typeof previousSnapshot.entries === "number" &&
		previousSnapshot.entries > 0 &&
		observation.entries <= Math.floor(previousSnapshot.entries * (1 - COMPACTION_DROP_RATIO))
	) {
		compactionDetected = true;
		state.priorCompactionCount += 1;
		state.pendingCompactionReminder = true;
		state.pendingBoundary = false;
	}
	if (observation !== null) {
		state.transcriptSnapshot = { entries: observation.entries, bytes: observation.bytes };
	}

	// Sliding-window increment over positive growth of the estimated context.
	const increment = contextTotal - state.lastContextTokens;
	if (increment > 0) state.increments.push(increment);
	if (state.increments.length > MAX_INCREMENT_HISTORY) state.increments.shift();
	state.requestCount += 1;
	state.lastContextTokens = contextTotal;

	let block = null;
	const budgetAllows =
		state.consecutiveBlocks < MAX_CONSECUTIVE_BLOCKS && state.totalBlocks < MAX_SESSION_BLOCKS;

	if (state.pendingCompactionReminder && previousSnapshot !== null && compactionDetected === false) {
		// Reminder scheduled by an earlier detection round → deliver now.
		if (budgetAllows) {
			state.pendingCompactionReminder = false;
			state.consecutiveBlocks += 1;
			state.totalBlocks += 1;
			block = {
				kind: "compaction-reminder",
				reason:
					"[sol-occ] Online context compaction finished. The parent task is still active. Before continuing work, call TodoWrite with a fresh plan for the remaining work.",
			};
		} else if (state.totalBlocks >= MAX_SESSION_BLOCKS) {
			// Session budget permanently exhausted — the reminder can never be
			// delivered; clear it instead of carrying it forever (audit m14).
			// Temporary consecutive-budget exhaustion (reset by a natural Stop)
			// keeps the reminder pending.
			state.pendingCompactionReminder = false;
		}
	} else if (state.pendingBoundary && budgetAllows) {
		const decision = decideCompaction({
			writeTokens: contextTotal,
			archiveTokens: Math.max(0, contextTotal - KEEP_RECENT_TOKENS),
			memoTokens: MEMO_TOKENS,
			contextTokens: contextTotal,
			completedBoundaryRequestCounts:
				state.completedBoundaryRequestCounts.length > 0 ? [...state.completedBoundaryRequestCounts] : null,
			remainingBoundaries: state.plan.filter((step) => step.status !== "completed").length,
			averageContextTokenIncrement: average(state.increments),
			contextWindowTokens: state.contextWindowTokens,
			priorCompactionCount: state.priorCompactionCount,
			carriedDebtTokens: state.carriedDebtTokens,
			cacheDebtRepaymentTokens: state.cacheDebtRepaymentTokens,
			cacheWriteReadRatio: CACHE_WRITE_READ_RATIO,
			economics: DEFAULT_COMPACTION_ECONOMICS,
		});
		if (decision.compact) {
			state.pendingBoundary = false;
			state.consecutiveBlocks += 1;
			state.totalBlocks += 1;
			const saving = Math.max(0, decision.archiveTokens - decision.memoTokens);
			block = {
				kind: "economic",
				decision,
				reason: `[sol-occ] boundary reached; compaction is now economical (est. saving ${Math.round(saving)} tokens). Continue the current task lean; avoid re-reading large outputs (use obs_recall).`,
			};
		}
		return (await finish(dataRoot, sessionId, state, decision, block));
	}

	return finish(dataRoot, sessionId, state, null, block);
}

async function finish(dataRoot, sessionId, state, decision, block) {
	await persistOccState(dataRoot, sessionId, state, block === null ? "stop-noop" : `stop-block-${block.kind}`);
	return { block, decision, state };
}

/** PostToolUse(TodoWrite): record plan + new boundary candidate. */
export async function runOccTodoBoundary(dataRoot, sessionId, todos) {
	return withOccStateLock(dataRoot, sessionId, async () => {
		const state = await loadOccState(dataRoot, sessionId);
		const plan = todosToPlan(todos);
		if (plan === undefined) return { state, transition: null };
		const transition = analyzePlanTransition(state.plan, plan);
		state.plan = plan;
		if (transition.completedSteps.length > 0) {
			state.pendingBoundary = true;
			state.completedBoundaryRequestCounts.push(Math.max(1, state.requestCount - state.lastBoundaryRequestCount));
			if (state.completedBoundaryRequestCounts.length > MAX_BOUNDARY_HISTORY) {
				state.completedBoundaryRequestCounts.shift();
			}
			state.lastBoundaryRequestCount = state.requestCount;
		}
		await persistOccState(dataRoot, sessionId, state, "todo-boundary");
		return { state, transition };
	});
}

/** UserPromptSubmit "CORRECTION:" → epoch bump, debt cleared (DESIGN §2.4). */
export async function runOccCorrection(dataRoot, sessionId) {
	return withOccStateLock(dataRoot, sessionId, async () => {
		const state = await loadOccState(dataRoot, sessionId);
		state.epoch += 1;
		state.carriedDebtTokens = 0;
		state.cacheDebtRepaymentTokens = 0;
		await persistOccState(dataRoot, sessionId, state, "correction");
		return state;
	});
}

/** Test hook: write a state snapshot without a Stop round. */
export async function setOccStateForTests(dataRoot, sessionId, patch) {
	return withOccStateLock(dataRoot, sessionId, async () => {
		const state = { ...initialOccState(), ...(await loadOccState(dataRoot, sessionId)), ...patch };
		await persistOccState(dataRoot, sessionId, state, "test-seed");
		return state;
	});
}
