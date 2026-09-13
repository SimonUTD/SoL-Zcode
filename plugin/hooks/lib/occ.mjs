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
 *     block channel (DESIGN §2.4 action 3);
 *   - self-limits: at most 2 consecutive blocks (host cap 3, one spare) and at
 *     most 3 blocks per session (upstream maxAutoContinuations=3 semantics).
 *
 * State: occ-state.json snapshot; every mutation first appends the full new
 * state to occ-history.jsonl (hash-chained).
 */

import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { DEFAULT_COMPACTION_ECONOMICS, analyzePlanTransition, decideCompaction, parsePlanSteps } from "../../core/index.mjs";
import { appendChained } from "./chain.mjs";
import { occHistoryPath, occStatePath } from "./store.mjs";

export const MEMO_TOKENS = 1_000;
export const KEEP_RECENT_TOKENS = 20_000;
export const CACHE_WRITE_READ_RATIO = 12.5;
export const MAX_INCREMENT_HISTORY = 20;
export const MAX_BOUNDARY_HISTORY = 12;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const MAX_CONSECUTIVE_BLOCKS = 2;
export const MAX_SESSION_BLOCKS = 3;
export const COMPACTION_DROP_RATIO = 0.3;

const OCC_STATE_SCHEMA = "sol_zcode_online_context_compact/1";

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

/** Append the new state to the chained history, then overwrite the snapshot. */
export async function persistOccState(dataRoot, sessionId, state, reason) {
	await appendChained(dataRoot, occHistoryPath(dataRoot, sessionId), {
		event: "state",
		reason: typeof reason === "string" ? reason : "update",
		state,
	});
	const tmp = `${occStatePath(dataRoot, sessionId)}.tmp-${process.pid}`;
	await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
	await rename(tmp, occStatePath(dataRoot, sessionId));
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
 * transcript cannot be read (callers skip the OCC round entirely — fail-open).
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
	const tokens = Math.ceil(chars / 4);
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
 */
export async function runOccStopRound(dataRoot, sessionId, { observation, stopHookActive, model, contextWindowTokens }) {
	const state = await loadOccState(dataRoot, sessionId);

	if (typeof model === "string" && model.length > 0) state.model = model;
	if (Number.isFinite(contextWindowTokens) && contextWindowTokens > 0) {
		state.contextWindowTokens = Math.floor(contextWindowTokens);
	}

	// A Stop that was not itself caused by our block resets the consecutive counter.
	if (stopHookActive !== true) state.consecutiveBlocks = 0;

	if (observation === null) {
		// Transcript unreadable → skip this round entirely (fail-open).
		await persistOccState(dataRoot, sessionId, state, "stop-transcript-unavailable");
		return { block: null, decision: null, state };
	}

	// Compaction detection: entries dropped ≥30% within the same session.
	const previousSnapshot = state.transcriptSnapshot;
	let compactionDetected = false;
	if (
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
	state.transcriptSnapshot = { entries: observation.entries, bytes: observation.bytes };

	// Sliding-window increment over positive token growth.
	const increment = observation.tokens - state.lastContextTokens;
	if (increment > 0) state.increments.push(increment);
	if (state.increments.length > MAX_INCREMENT_HISTORY) state.increments.shift();
	state.requestCount += 1;
	state.lastContextTokens = observation.tokens;

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
			writeTokens: observation.tokens,
			archiveTokens: Math.max(0, observation.tokens - KEEP_RECENT_TOKENS),
			memoTokens: MEMO_TOKENS,
			contextTokens: observation.tokens,
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
}

/** UserPromptSubmit "CORRECTION:" → epoch bump, debt cleared (DESIGN §2.4). */
export async function runOccCorrection(dataRoot, sessionId) {
	const state = await loadOccState(dataRoot, sessionId);
	state.epoch += 1;
	state.carriedDebtTokens = 0;
	state.cacheDebtRepaymentTokens = 0;
	await persistOccState(dataRoot, sessionId, state, "correction");
	return state;
}

/** Test hook: write a state snapshot without a Stop round. */
export async function setOccStateForTests(dataRoot, sessionId, patch) {
	const state = { ...initialOccState(), ...(await loadOccState(dataRoot, sessionId)), ...patch };
	await persistOccState(dataRoot, sessionId, state, "test-seed");
	return state;
}
