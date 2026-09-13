#!/usr/bin/env node
/*
 * sol-zcode hook dispatcher — single entry for all seven events (hooks.json).
 * Reads one JSON payload on stdin (dual snake_case/camelCase field names, G5),
 * dispatches on hook_event_name, and prints the response envelope on stdout.
 *
 * Zero-behavior contract (C2, tested):
 *   - SOL_ZCODE_AUX=1, missing/corrupt config, or all mechanisms off →
 *     empty stdout, exit 0, and NOT A SINGLE file is written.
 *   - A mistyped option key falls back to false and journals a
 *     `config_rejected` trajectory entry (fail-safe, not fail-crash).
 *
 * Exit codes: 0 normal; 2 = hard block with the stderr reason delivered to the
 * model (the only reliable PreToolUse block channel, G8). Output writes are
 * never followed by process.exit() (G13).
 */

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveConfig } from "./lib/config.mjs";
import { observeTranscript, runOccCorrection, runOccStopRound, runOccTodoBoundary } from "./lib/occ.mjs";
import {
	appendTrajectory,
	dataRoot,
	observationLedgerPath,
	observationRuntimeRoot,
	occHistoryPath,
	reducerLedgerPath,
	safeSessionId,
	sessionSummaryPath,
	trajectoryPath,
	writeSessionPointer,
} from "./lib/store.mjs";
import { appendChained, readChainHead, verifyChainFile } from "./lib/chain.mjs";
import { createObservation, ensureStored, placeholderFor } from "../core/index.mjs";

const GATE_REASON =
	"SoL action fusion: use sol_write / sol_edit (they accept then_run) instead of Write/Edit.";

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

function pick(payload, snake, camel) {
	if (payload[snake] !== undefined) return payload[snake];
	if (payload[camel] !== undefined) return payload[camel];
	return undefined;
}

function str(value) {
	return typeof value === "string" ? value : undefined;
}

function buildGuidance(cfg) {
	const lines = ["[sol-zcode] Token-efficiency mechanisms are enabled for this session."];
	if (cfg.actionFusion) {
		lines.push(
			"- Prefer sol_edit / sol_write over Edit / Write: they accept an optional then_run {command, timeout?} that runs a verification command in the same call and returns one combined result.",
		);
	}
	if (cfg.observationPack || cfg.evidenceReducer) {
		lines.push(
			"- Prefer sol_bash over Bash for commands with large output: results over 10 KiB are archived and returned as a compact placeholder with head/tail excerpts.",
		);
	}
	if (cfg.observationPack) {
		lines.push(
			"- Recall archived output with obs_recall {id, offset} to page through the original bytes, or {id, query} for a case-sensitive literal search.",
		);
	}
	if (cfg.evidenceReducer) {
		lines.push(
			"- Long failing build/test logs are reduced to a verified evidence receipt quoting exact lines; the full original stays archived (see source_artifact in the receipt).",
		);
	}
	if (cfg.trajectory) {
		lines.push('- sol_trajectory {action:"recent"|"stats", n?} shows this session\'s metadata-only trajectory.');
	}
	return lines.join("\n");
}

async function nativeToolText(toolResponse) {
	if (toolResponse === undefined || toolResponse === null) return undefined;
	if (typeof toolResponse === "string") return toolResponse;
	if (typeof toolResponse !== "object" || Array.isArray(toolResponse)) return undefined;
	// Prefer the persisted full output (G6): stdout in the payload is truncated
	// to 30000 chars for large results.
	const persisted = str(toolResponse.persistedOutputPath);
	if (persisted !== undefined) {
		try {
			return await readFile(persisted, "utf8");
		} catch {
			// fall through to stdout
		}
	}
	const stdout = str(toolResponse.stdout);
	const stderr = str(toolResponse.stderr);
	if (stdout !== undefined || stderr !== undefined) {
		return [stdout ?? "", stderr ?? ""].filter((part) => part.length > 0).join("\n");
	}
	try {
		return JSON.stringify(toolResponse);
	} catch {
		return undefined;
	}
}

// Live-verified tool namespace (zcode 0.16.5): plugin MCP tools are exposed as
// mcp__plugin_<plugin>_<server>__<tool>; the short mcp__<server>__<tool> form
// from the research doc does not occur. Both are matched defensively.
const OWN_MCP_TOOL_PATTERN = /^mcp__(plugin_)?sol(-zcode)?_sol(_sol)?__/;

async function archiveNativeObservation(root, sessionId, toolName, text, cfg) {
	if (!cfg.observationPack) return;
	if (typeof toolName === "string" && OWN_MCP_TOOL_PATTERN.test(toolName)) return;
	const observation = createObservation(
		{ toolName: toolName ?? "native", toolCallId: "", text },
		observationRuntimeRoot(root),
	);
	if (observation === undefined) return;
	try {
		await ensureStored(observation);
		await appendChained(root, observationLedgerPath(root, sessionId), {
			ts: new Date().toISOString(),
			event: "native",
			id: observation.id,
			tool: observation.toolName,
			contentHash: observation.contentHash,
			bytes: observation.bytes,
			tokens: observation.tokens,
			placeholderBytes: Buffer.byteLength(placeholderFor(observation), "utf8"),
		});
	} catch (error) {
		// fail-open: native archiving is best-effort telemetry (C3 archive, no rewrite).
		await appendChained(root, observationLedgerPath(root, sessionId), {
			ts: new Date().toISOString(),
			event: "native-fallback",
			tool: toolName ?? "native",
			reason: `archive-error:${error instanceof Error ? error.message : String(error)}`,
		}).catch(() => null);
	}
}

async function refreshSessionSummary(root, sessionId) {
	const files = {
		observation: await chainSummary(observationLedgerPath(root, sessionId)),
		reducer: await chainSummary(reducerLedgerPath(root, sessionId)),
		occHistory: await chainSummary(occHistoryPath(root, sessionId)),
		trajectory: await chainSummary(trajectoryPath(root, sessionId)),
	};
	const summary = {
		schema: "sol_zcode_session_summary_v1",
		session: sessionId,
		ts: new Date().toISOString(),
		files,
	};
	const { writeFile, rename, mkdir } = await import("node:fs/promises");
	const path = sessionSummaryPath(root, sessionId);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.tmp-${process.pid}`;
	await writeFile(tmp, JSON.stringify(summary, null, 2), { encoding: "utf8", mode: 0o600 });
	await rename(tmp, path);
}

async function chainSummary(path) {
	const head = await readChainHead(path);
	if (head === null) return null;
	const verification = await verifyChainFile(path);
	return { lines: verification.lines, lastHash: head.hash, ok: verification.ok };
}

async function handleEvent(payload, cfg) {
	const root = dataRoot(process.env);
	const sessionId = safeSessionId(str(pick(payload, "session_id", "sessionId")) ?? "nosession");
	const event = str(pick(payload, "hook_event_name", "hookEventName")) ?? "";
	const cwd = str(payload.cwd);
	const model = str(payload.model);
	const toolName = str(pick(payload, "tool_name", "toolName"));
	const toolCallId = str(pick(payload, "tool_use_id", "toolCallId"));
	const toolInput = pick(payload, "tool_input", "toolInput");

	// Session pointer keeps the MCP server's ledger attribution current.
	await writeSessionPointer(root, { sessionId: str(pick(payload, "session_id", "sessionId")), cwd, model, source: event }).catch(
		() => undefined,
	);

	if (cfg.trajectory) {
		switch (event) {
			case "SessionStart":
				await appendTrajectory(root, sessionId, { event: "session_start", status: "ok", detail: `source=${str(payload.source) ?? "?"}` });
				break;
			case "UserPromptSubmit": {
				const prompt = str(payload.prompt) ?? "";
				const { createHash } = await import("node:crypto");
				await appendTrajectory(root, sessionId, {
					event: "user_prompt",
					status: "ok",
					bytes: Buffer.byteLength(prompt, "utf8"),
					detail: `sha256=${createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 12)}`,
				});
				break;
			}
			case "PreToolUse":
				await appendTrajectory(root, sessionId, { event: "pre_tool", tool: toolName, toolCallId, status: "running" });
				break;
			case "PostToolUse":
				await appendTrajectory(root, sessionId, { event: "post_tool", tool: toolName, toolCallId, status: "ok", bytes: nativeBytes(payload) });
				break;
			case "PostToolUseFailure":
				await appendTrajectory(root, sessionId, { event: "tool_failure", tool: toolName, toolCallId, status: "error" });
				break;
			case "PermissionRequest":
				await appendTrajectory(root, sessionId, { event: "permission", tool: toolName, toolCallId, status: "info" });
				break;
			case "Stop":
				await appendTrajectory(root, sessionId, { event: "stop", status: "ok" });
				break;
			default:
				break;
		}
	}

	switch (event) {
		case "SessionStart": {
			if (cfg.actionFusion || cfg.observationPack || cfg.evidenceReducer) {
				return {
					hookSpecificOutput: {
						hookEventName: "SessionStart",
						additionalContext: buildGuidance(cfg),
					},
				};
			}
			return null;
		}
		case "UserPromptSubmit": {
			if (cfg.onlineCompact) {
				const prompt = str(payload.prompt) ?? "";
				if (prompt.startsWith("CORRECTION:")) {
					await runOccCorrection(root, sessionId);
				}
			}
			return null;
		}
		case "PreToolUse": {
			if (cfg.actionFusionGate && (toolName === "Write" || toolName === "Edit")) {
				// exit-2 + stderr reason (G8): the only reliable hard block, and
				// the stderr text reaches the model as the block reason.
				process.stderr.write(GATE_REASON);
				process.exitCode = 2;
				return null;
			}
			return null;
		}
		case "PostToolUse": {
			const toolResponse = pick(payload, "tool_response", "toolResponse");
			const text = await nativeToolText(toolResponse);
			if (text !== undefined) {
				await archiveNativeObservation(root, sessionId, toolName, text, cfg);
			}
			if (cfg.onlineCompact && toolName === "TodoWrite") {
				const todos = toolInput && typeof toolInput === "object" ? toolInput.todos : undefined;
				if (Array.isArray(todos)) {
					await runOccTodoBoundary(root, sessionId, todos);
				}
			}
			return null;
		}
		case "PostToolUseFailure":
			return null;
		case "PermissionRequest":
			return null;
		case "Stop": {
			if (cfg.onlineCompact) {
				const observation = await observeTranscript(str(pick(payload, "transcript_path", "transcriptPath")));
				const stopHookActive = pick(payload, "stop_hook_active", "stopHookActive") === true;
				const result = await runOccStopRound(root, sessionId, {
					observation,
					stopHookActive,
					model,
					contextWindowTokens: numericContextWindow(payload),
				});
				await refreshSessionSummary(root, sessionId).catch(() => undefined);
				if (result.block !== null) {
					return { decision: "block", reason: result.block.reason };
				}
				return null;
			}
			await refreshSessionSummary(root, sessionId).catch(() => undefined);
			return null;
		}
		default:
			return null;
	}
}

function numericContextWindow(payload) {
	const value = payload?.contextWindow ?? payload?.context_window;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	return undefined;
}

function nativeBytes(payload) {
	const tr = pick(payload, "tool_response", "toolResponse");
	if (tr && typeof tr === "object" && !Array.isArray(tr)) {
		if (Number.isFinite(tr.stdoutBytes)) return tr.stdoutBytes + (Number.isFinite(tr.stderrBytes) ? tr.stderrBytes : 0);
		if (typeof tr.stdout === "string") return Buffer.byteLength(tr.stdout, "utf8");
	}
	if (typeof tr === "string") return Buffer.byteLength(tr, "utf8");
	return undefined;
}

async function main() {
	const raw = await readStdin();
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		// Unparsable payload: fail-open, no output, no writes.
		process.exitCode = 0;
		return;
	}
	const cfg = await resolveConfig(process.env);
	if (cfg.status === "ok" && cfg.rejectedKeys.length > 0) {
		// Fail-safe diagnostics: a mistyped key is an attempted opt-in that
		// fell back to false (DESIGN §3) — journal it even if the net state
		// ends up all-off.
		const root = dataRoot(process.env);
		const sessionId = safeSessionId(str(pick(payload, "session_id", "sessionId")) ?? "config");
		await appendTrajectory(root, sessionId, {
			event: "config_rejected",
			status: "error",
			detail: `keys=${cfg.rejectedKeys.join(",")}`,
		}).catch(() => undefined);
	}
	if (cfg.zeroBehavior) {
		// Strict zero behavior: not a single side-effect file.
		process.exitCode = 0;
		return;
	}
	const envelope = await handleEvent(payload, cfg);
	if (process.exitCode === 2) {
		// Hard block: stderr already carries the reason; no stdout envelope.
		return;
	}
	if (envelope !== null) {
		process.stdout.write(JSON.stringify(envelope));
	}
	process.exitCode = 0;
}

main().catch((error) => {
	// Mechanism failures never break the host session (fail-open).
	process.stderr.write(`[sol-zcode] hook error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exitCode = 0;
});
