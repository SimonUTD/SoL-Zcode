/*
 * sol-zcode evidence store layout (DESIGN §1) plus session plumbing.
 *
 * $ZCODE_PLUGIN_DATA/
 * ├── store/
 * │   ├── observation-pack/objects/<obs_id>.txt        (0600, content-verified)
 * │   ├── reducer/objects/<sha2>/<sha256>.txt          (0600, content-addressed)
 * │   ├── ledger/<session>/observation.jsonl           (hash-chained)
 * │   │   ├── reducer.jsonl                            (hash-chained)
 * │   │   ├── occ-history.jsonl                        (hash-chained)
 * │   │   ├── occ-state.json                           (latest snapshot)
 * │   │   └── session-summary.json                     (terminal anchor)
 * │   └── trajectory/<session>.jsonl                   (hash-chained, metadata only)
 * └── run/                                              (locks, temp, session pointers)
 *
 * The MCP server child gets ZCODE_PLUGIN_DATA + ZCODE_PROJECT_DIR but no
 * ZCODE_SESSION_ID (verified against the 0.16.5 runtime), so hooks publish a
 * per-session pointer file the server resolves to the freshest session in its
 * project directory.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function dataRoot(env = process.env) {
	if (env.ZCODE_PLUGIN_DATA && env.ZCODE_PLUGIN_DATA.length > 0) return env.ZCODE_PLUGIN_DATA;
	// Live-verified fallback (zcode 0.16.5): the host keys plugin data by the
	// full plugin id, e.g. ~/.zcode/cli/plugins/data/sol-zcode@<marketplace>.
	const home = typeof env.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
	return join(home, ".zcode", "cli", "plugins", "data", "sol-zcode@sol-zcode-dev");
}

export function safeSessionId(sessionId) {
	if (typeof sessionId !== "string" || sessionId.length === 0) return "nosession";
	if (SESSION_ID_PATTERN.test(sessionId)) return sessionId;
	return `h_${createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 24)}`;
}

export function storeRoot(dataRootDir) {
	return join(dataRootDir, "store");
}

export function observationRuntimeRoot(dataRootDir) {
	// vendor observationPath(runtimeRoot, id) = runtimeRoot/observation-pack/objects/<id>.txt
	return storeRoot(dataRootDir);
}

export function reducerStoreRoot(dataRootDir) {
	return join(storeRoot(dataRootDir), "reducer");
}

export function ledgerDir(dataRootDir, sessionId) {
	return join(storeRoot(dataRootDir), "ledger", safeSessionId(sessionId));
}

export function observationLedgerPath(dataRootDir, sessionId) {
	return join(ledgerDir(dataRootDir, sessionId), "observation.jsonl");
}

export function reducerLedgerPath(dataRootDir, sessionId) {
	return join(ledgerDir(dataRootDir, sessionId), "reducer.jsonl");
}

export function occHistoryPath(dataRootDir, sessionId) {
	return join(ledgerDir(dataRootDir, sessionId), "occ-history.jsonl");
}

export function occStatePath(dataRootDir, sessionId) {
	return join(ledgerDir(dataRootDir, sessionId), "occ-state.json");
}

export function sessionSummaryPath(dataRootDir, sessionId) {
	return join(ledgerDir(dataRootDir, sessionId), "session-summary.json");
}

export function trajectoryPath(dataRootDir, sessionId) {
	return join(storeRoot(dataRootDir), "trajectory", `${safeSessionId(sessionId)}.jsonl`);
}

export function runDir(dataRootDir) {
	return join(dataRootDir, "run");
}

export function reducerHomePath(dataRootDir) {
	return join(runDir(dataRootDir), "reducer-home");
}

export function sessionsDir(dataRootDir) {
	return join(runDir(dataRootDir), "sessions");
}

/**
 * Publish the session pointer consumed by the MCP server.
 * { sessionId, cwd, model?, ts } written atomically per session id.
 */
export async function writeSessionPointer(dataRootDir, { sessionId, cwd, model, source }) {
	const dir = sessionsDir(dataRootDir);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${safeSessionId(sessionId)}.json`);
	const tmp = `${path}.tmp-${process.pid}`;
	const payload = JSON.stringify({
		schema: "sol_zcode_session_pointer_v1",
		sessionId,
		cwd: typeof cwd === "string" ? cwd : null,
		model: typeof model === "string" ? model : null,
		source: typeof source === "string" ? source : null,
		ts: new Date().toISOString(),
	});
	await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
	await rename(tmp, path);
}

/**
 * Resolve the session the MCP server should attribute its writes to:
 * freshest pointer whose cwd matches ZCODE_PROJECT_DIR, else freshest overall.
 */
export async function resolveMcpSession(dataRootDir, env = process.env) {
	if (env.ZCODE_SESSION_ID && env.ZCODE_SESSION_ID.length > 0) {
		return { sessionId: env.ZCODE_SESSION_ID, cwd: env.ZCODE_PROJECT_DIR || process.cwd(), model: null };
	}
	const dir = sessionsDir(dataRootDir);
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		entries = [];
	}
	const projectDir = env.ZCODE_PROJECT_DIR || null;
	let best = null;
	for (const name of entries) {
		if (!name.endsWith(".json")) continue;
		try {
			const raw = await readFile(join(dir, name), "utf8");
			const pointer = JSON.parse(raw);
			const stats = await statQuiet(join(dir, name));
			if (!pointer || typeof pointer.sessionId !== "string") continue;
			const age = stats === null ? 0 : stats.mtimeMs;
			const matchesProject = projectDir !== null && pointer.cwd === projectDir;
			if (best === null || (matchesProject && !best.matchesProject) || (matchesProject === best.matchesProject && age > best.age)) {
				best = { sessionId: pointer.sessionId, cwd: pointer.cwd, model: pointer.model ?? null, age, matchesProject };
			}
		} catch {
			// Unreadable pointer — ignore.
		}
	}
	if (best !== null) return { sessionId: best.sessionId, cwd: best.cwd || projectDir || process.cwd(), model: best.model };
	return { sessionId: "mcp-direct", cwd: projectDir || process.cwd(), model: null };
}

async function statQuiet(path) {
	try {
		return await (await import("node:fs/promises")).stat(path);
	} catch {
		return null;
	}
}

/**
 * Sanitize free-text detail for trajectory records: strip ANSI/control
 * sequences and clip (metadata-only guarantee, DESIGN §2.5).
 */
export function sanitizeDetail(value, maxLength = 64) {
	if (typeof value !== "string") return "";
	const cleaned = value
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "")
		.replace(/[\x00-\x1f\x7f]/gu, " ");
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Append one metadata-only record to the session's hash-chained trajectory
 * JSONL. Field whitelist enforced here; prompts/args/outputs never pass through
 * this function's contract.
 */
export async function appendTrajectory(dataRootDir, sessionId, fields) {
	const entry = { schema: "sol_zcode_trajectory_v1", runId: trajectoryRunId(sessionId), ts: new Date().toISOString() };
	for (const key of ["event", "tool", "toolCallId", "status", "bytes", "tokens", "detail"]) {
		if (fields[key] === undefined) continue;
		if (key === "detail") entry.detail = sanitizeDetail(fields.detail);
		else if (key === "bytes" || key === "tokens") {
			if (Number.isFinite(fields[key])) entry[key] = Math.max(0, Math.floor(fields[key]));
		} else if (typeof fields[key] === "string") {
			entry[key] = fields[key];
		}
	}
	const { appendChained } = await import("./chain.mjs");
	return appendChained(dataRootDir, trajectoryPath(dataRootDir, sessionId), entry);
}

export function trajectoryRunId(sessionId) {
	return createHash("sha256").update(`sol-zcode:${safeSessionId(sessionId)}`, "utf8").digest("hex").slice(0, 16);
}

/** Read the last N chained records of a session trajectory (for sol_trajectory). */
export async function readTrajectoryTail(dataRootDir, sessionId, limit = 12) {
	const path = trajectoryPath(dataRootDir, sessionId);
	let handle;
	try {
		handle = await open(path, fsConstants.O_RDONLY);
		const stats = await handle.stat();
		const length = Math.min(stats.size, 256 * 1024);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, stats.size - length);
		const lines = buffer.toString("utf8").split("\n").filter((line) => line.trim().length > 0);
		const records = [];
		for (const line of lines) {
			try {
				records.push(JSON.parse(line));
			} catch {
				// skip
			}
		}
		return records.slice(-Math.max(1, limit));
	} catch {
		return [];
	} finally {
		await handle?.close();
	}
}
