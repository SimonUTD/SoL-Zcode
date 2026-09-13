/*
 * Hash-chained append-only JSONL ledgers (DESIGN §4.3, C3).
 *
 * Every line is `{...entry, prevHash, hash}` where
 * `hash = sha256(JSON.stringify({...entry, prevHash}))` (insertion-order
 * JSON.stringify; entries are built with stable key order at call sites and
 * never contain a `hash` key of their own). The first line's prevHash is the
 * genesis constant. This makes in-line rewrites and mid-stream deletions or
 * insertions detectable (verify-evidence.mjs reports line numbers and
 * expected/actual hashes). Pure tail truncation and a full-chain rewrite
 * remain undetectable without an external anchor; session-summary.json
 * (refreshed on Stop) is the added anchor.
 *
 * Appends from independent processes (hooks per event + the MCP server) are
 * serialized with an O_EXCL lock file under $ZCODE_PLUGIN_DATA/run/locks,
 * with stale-lock breaking after 30s.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const GENESIS_HASH = "0".repeat(64);
export const CHAIN_SCHEMA = "sol_zcode_chain_v1";

const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 200;
const LOCK_DELAY_MS = 15;

function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function lockDir(dataRoot) {
	return join(dataRoot, "run", "locks");
}

function lockPathFor(dataRoot, ledgerPath) {
	return join(lockDir(dataRoot), `${basename(ledgerPath)}.lock`);
}

async function sleep(ms) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(path) {
	for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
		try {
			const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
			await handle.write(`${process.pid}\n`);
			await handle.close();
			return true;
		} catch (error) {
			if (typeof error === "object" && error !== null && error.code === "EEXIST") {
				try {
					const stats = await stat(path);
					if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
						// Stale holder (crashed process) — break the lock.
						await rm(path, { force: true });
						continue;
					}
				} catch {
					// Lock vanished between EEXIST and stat — retry immediately.
				}
				await sleep(LOCK_DELAY_MS);
				continue;
			}
			throw error;
		}
	}
	return false;
}

async function releaseLock(path) {
	await rm(path, { force: true });
}

/**
 * Read the last complete JSONL line of a file.
 *
 * The initial read window is maxBytes from EOF. When that window does not
 * contain the start of the last non-empty line — e.g. a single ledger line
 * larger than the window; occ-history embeds the full OCC state including the
 * plan, and parsePlanSteps allows 128 steps × 16 KiB goals, so real lines can
 * exceed 64 KiB (audit M2) — the window grows 4× until it covers the line
 * start or the whole file. The returned line is therefore always the complete
 * last line, never a mid-line fragment (a fragment would fail JSON.parse in
 * readChainHead and silently restart the chain from GENESIS).
 */
export async function readLastLine(path, maxBytes = 64 * 1024) {
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY);
		const stats = await handle.stat();
		let length = Math.min(stats.size, maxBytes);
		for (;;) {
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, stats.size - length);
			const text = buffer.toString("utf8");
			const candidate = lastNonEmptySegment(text);
			if (candidate === null) {
				if (length >= stats.size) return null;
				length = Math.min(stats.size, length * 4);
				continue;
			}
			// The candidate is complete when its line start lies inside the
			// window (a newline precedes it here) or the window covers the file.
			if (candidate.startIndex > 0 || length >= stats.size) return candidate.value;
			length = Math.min(stats.size, length * 4);
		}
	} catch (error) {
		if (typeof error === "object" && error !== null && error.code === "ENOENT") return null;
		throw error;
	} finally {
		await handle?.close();
	}
}

/** Last non-empty "\n"-separated segment of text, with its start offset; null when none. */
function lastNonEmptySegment(text) {
	let start = 0;
	let best = null;
	for (const segment of text.split("\n")) {
		if (segment.trim().length > 0) best = { value: segment, startIndex: start };
		start += segment.length + 1;
	}
	return best;
}

/** Parse the tail of a chained ledger; returns {hash, obj} of the last line or null. */
export async function readChainHead(path) {
	const line = await readLastLine(path);
	if (line === null) return null;
	try {
		const obj = JSON.parse(line);
		if (typeof obj?.hash !== "string") return null;
		return { hash: obj.hash, obj };
	} catch {
		return null;
	}
}

/**
 * Append one chained entry. Returns the new head hash, or null when the lock
 * could not be acquired (callers treat this as fail-open: skip the ledger line,
 * never fail the mechanism).
 */
export async function appendChained(dataRoot, path, entry) {
	if (Object.prototype.hasOwnProperty.call(entry, "hash")) {
		throw new Error("chained ledger entries must not carry a hash key");
	}
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const lock = lockPathFor(dataRoot, path);
	await mkdir(lockDir(dataRoot), { recursive: true, mode: 0o700 });
	if (!(await acquireLock(lock))) return null;
	try {
		const head = await readChainHead(path);
		const prevHash = head === null ? GENESIS_HASH : head.hash;
		const body = { ...entry, prevHash };
		const hash = sha256(JSON.stringify(body));
		await appendFile(path, `${JSON.stringify({ ...body, hash })}\n`, { encoding: "utf8", mode: 0o600 });
		return hash;
	} finally {
		await releaseLock(lock);
	}
}

/**
 * Verify one ledger file end to end. Returns
 * { ok, lines, findings: [{line, kind, expected?, actual?}] }.
 */
export async function verifyChainFile(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && error.code === "ENOENT") {
			return { ok: true, lines: 0, findings: [], missing: true };
		}
		throw error;
	}
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	const findings = [];
	let prevHash = GENESIS_HASH;
	for (let index = 0; index < lines.length; index += 1) {
		const lineNumber = index + 1;
		let obj;
		try {
			obj = JSON.parse(lines[index]);
		} catch {
			findings.push({ line: lineNumber, kind: "unparsable-line" });
			continue;
		}
		const { hash, ...body } = obj;
		if (typeof hash !== "string") {
			findings.push({ line: lineNumber, kind: "missing-hash" });
			continue;
		}
		const recomputed = sha256(JSON.stringify(body));
		if (recomputed !== hash) {
			findings.push({ line: lineNumber, kind: "hash-mismatch", expected: hash, actual: recomputed });
		}
		if (body.prevHash !== prevHash) {
			findings.push({ line: lineNumber, kind: "chain-break", expected: prevHash, actual: body.prevHash });
		}
		prevHash = hash;
	}
	return { ok: findings.length === 0, lines: lines.length, findings, lastHash: lines.length > 0 ? prevHash : null };
}
