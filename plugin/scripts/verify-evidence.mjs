#!/usr/bin/env node
/*
 * sol-zcode evidence integrity CLI (DESIGN §2.5, §4).
 *
 *   node verify-evidence.mjs [<dataRoot>]   (default: $ZCODE_PLUGIN_DATA)
 *
 * Checks:
 *   1. Hash-chain integrity of every ledger (observation.jsonl, reducer.jsonl,
 *      occ-history.jsonl under store/ledger, plus store/trajectory .jsonl):
 *      per-line hash recomputation + prevHash linkage (reports line numbers
 *      with expected and actual hashes).
 *   2. Object re-verification: reducer objects must hash to their own name;
 *      observation objects must hash to a contentHash recorded for their id.
 *   3. Cross-reconciliation: every ledger-referenced object must exist.
 *   4. Unreferenced objects are reported (warning; not counted as tampering —
 *      fail-open archiving can legitimately leave an unledgered object).
 *   5. session-summary.json anchors: the recorded (lines, lastHash) must match
 *      the file at that position; a shorter file than the anchor records is
 *      tail-truncation evidence.
 *
 * Exit codes: 0 = clean; 1 = tampering/corruption findings; 2 = usage error.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const GENESIS_HASH = "0".repeat(64);

function sha256(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function usageAndExit(message) {
	process.stderr.write(`${message}\nusage: node verify-evidence.mjs [<dataRoot>]\n`);
	process.exit(2);
}

async function listFiles(dir, predicate, acc = []) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return acc;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await listFiles(path, predicate, acc);
		} else if (predicate(entry.name)) {
			acc.push(path);
		}
	}
	return acc;
}

async function verifyChainFile(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return { lines: 0, findings: [{ kind: "unreadable-file", path }], lastHash: null, referenced: [] };
	}
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	const findings = [];
	const referenced = [];
	let prevHash = GENESIS_HASH;
	for (let index = 0; index < lines.length; index += 1) {
		const lineNumber = index + 1;
		let obj;
		try {
			obj = JSON.parse(lines[index]);
		} catch {
			findings.push({ kind: "unparsable-line", path, line: lineNumber });
			continue;
		}
		if (obj && typeof obj.id === "string" && typeof obj.contentHash === "string") {
			referenced.push({ id: obj.id, contentHash: obj.contentHash });
		}
		if (obj && typeof obj.sourceSha256 === "string") {
			referenced.push({ sha: obj.sourceSha256 });
		}
		const { hash, ...body } = obj ?? {};
		if (typeof hash !== "string") {
			findings.push({ kind: "missing-hash", path, line: lineNumber });
			continue;
		}
		const recomputed = sha256(JSON.stringify(body));
		if (recomputed !== hash) {
			findings.push({ kind: "hash-mismatch", path, line: lineNumber, expected: hash, actual: recomputed });
		}
		if (body.prevHash !== prevHash) {
			findings.push({ kind: "chain-break", path, line: lineNumber, expected: prevHash, actual: body.prevHash });
		}
		prevHash = hash;
	}
	return { lines: lines.length, findings, lastHash: lines.length > 0 ? prevHash : null, referenced };
}

async function main() {
	const argRoot = process.argv[2];
	const root =
		argRoot ??
		(process.env.ZCODE_PLUGIN_DATA && process.env.ZCODE_PLUGIN_DATA.length > 0
			? process.env.ZCODE_PLUGIN_DATA
			: join(homedir(), ".zcode", "cli", "plugins", "data", "sol-zcode"));
	let rootStat;
	try {
		rootStat = await stat(root);
	} catch {
		usageAndExit(`data root not found: ${root}`);
	}
	if (!rootStat.isDirectory()) usageAndExit(`not a directory: ${root}`);

	const findings = [];
	const warnings = [];
	const referencedObservations = new Map(); // id -> Set(contentHash)
	const referencedReducerObjects = new Set();

	// 1. Chains.
	const ledgerFiles = await listFiles(join(root, "store", "ledger"), (name) =>
		["observation.jsonl", "reducer.jsonl", "occ-history.jsonl"].includes(name),
	);
	const trajectoryFiles = await listFiles(join(root, "store", "trajectory"), (name) => name.endsWith(".jsonl"));
	const chainResults = new Map();
	for (const path of [...ledgerFiles, ...trajectoryFiles]) {
		const result = await verifyChainFile(path);
		chainResults.set(path, result);
		findings.push(...result.findings);
		for (const ref of result.referenced) {
			if (ref.id !== undefined) {
				if (!referencedObservations.has(ref.id)) referencedObservations.set(ref.id, new Set());
				referencedObservations.get(ref.id).add(ref.contentHash);
			}
			if (ref.sha !== undefined) referencedReducerObjects.add(ref.sha);
		}
	}

	// 2. Reducer objects are self-verifying (name == sha256(content)).
	const reducerObjectFiles = await listFiles(join(root, "store", "reducer", "objects"), (name) => name.endsWith(".txt"));
	const reducerObjectHashes = new Set();
	for (const path of reducerObjectFiles) {
		const name = path.split("/").pop().replace(/\.txt$/, "");
		let content;
		try {
			content = await readFile(path, "utf8");
		} catch {
			findings.push({ kind: "unreadable-object", path });
			continue;
		}
		const actual = sha256(content);
		reducerObjectHashes.add(name);
		if (actual !== name) {
			findings.push({ kind: "reducer-object-hash-mismatch", path, expected: name, actual });
		}
	}
	for (const sha of referencedReducerObjects) {
		if (!reducerObjectHashes.has(sha)) {
			findings.push({ kind: "referenced-reducer-object-missing", sha });
		}
	}

	// 3. Observation objects hash to a ledger-recorded contentHash for the id.
	const observationObjectFiles = await listFiles(join(root, "store", "observation-pack", "objects"), (name) =>
		/^obs_[a-f0-9]{24}\.txt$/.test(name),
	);
	const observationIdsOnDisk = new Set();
	for (const path of observationObjectFiles) {
		const id = path.split("/").pop().replace(/\.txt$/, "");
		observationIdsOnDisk.add(id);
		let content;
		try {
			content = await readFile(path, "utf8");
		} catch {
			findings.push({ kind: "unreadable-object", path });
			continue;
		}
		const actual = sha256(content);
		const recorded = referencedObservations.get(id);
		if (recorded === undefined) {
			warnings.push({ kind: "unreferenced-observation-object", id });
			continue;
		}
		if (!recorded.has(actual)) {
			findings.push({ kind: "observation-object-hash-mismatch", id, expected: [...recorded], actual });
		}
	}
	for (const id of referencedObservations.keys()) {
		if (!observationIdsOnDisk.has(id)) {
			findings.push({ kind: "referenced-observation-object-missing", id });
		}
	}

	// 4. Unreferenced reducer objects.
	for (const sha of reducerObjectHashes) {
		if (!referencedReducerObjects.has(sha)) {
			warnings.push({ kind: "unreferenced-reducer-object", sha });
		}
	}

	// 5. session-summary.json anchors.
	const ledgerDirs = await listFiles(join(root, "store", "ledger"), (name) => name === "session-summary.json");
	for (const summaryPath of ledgerDirs) {
		let summary;
		try {
			summary = JSON.parse(await readFile(summaryPath, "utf8"));
		} catch {
			findings.push({ kind: "unparsable-summary", path: summaryPath });
			continue;
		}
		if (summary?.schema !== "sol_zcode_session_summary_v1") continue;
		for (const [name, anchor] of Object.entries(summary.files ?? {})) {
			if (anchor === null || typeof anchor !== "object") continue;
			const targetMap = {
				observation: join(root, "store", "ledger", summary.session, "observation.jsonl"),
				reducer: join(root, "store", "ledger", summary.session, "reducer.jsonl"),
				occHistory: join(root, "store", "ledger", summary.session, "occ-history.jsonl"),
				trajectory: join(root, "store", "trajectory", `${summary.session}.jsonl`),
			};
			const target = targetMap[name];
			if (target === undefined) continue;
			const chain = chainResults.get(target);
			if (chain === undefined || chain.lines === 0) {
				if (anchor.lines > 0) {
					findings.push({ kind: "anchor-target-missing", path: target, summary: summaryPath });
				}
				continue;
			}
			if (chain.lines < anchor.lines) {
				findings.push({
					kind: "anchor-truncation",
					path: target,
					summary: summaryPath,
					expected_lines: anchor.lines,
					actual_lines: chain.lines,
				});
				continue;
			}
			if (chain.lastHash === null || anchor.lastHash === null) continue;
			// The anchored line must still carry the anchored hash: a file that
			// grew after the summary is fine; a rewritten prefix is not.
			const anchored = await hashAtLine(target, anchor.lines);
			if (anchored === undefined || anchored !== anchor.lastHash) {
				findings.push({
					kind: "anchor-hash-mismatch",
					path: target,
					summary: summaryPath,
					line: anchor.lines,
					expected: anchor.lastHash,
					actual: anchored,
				});
			}
		}
	}

	// Report.
	const totalChains = ledgerFiles.length + trajectoryFiles.length;
	process.stdout.write(
		`sol-zcode evidence verification\n  data root: ${root}\n  chains checked: ${totalChains}\n  reducer objects: ${reducerObjectFiles.length}\n  observation objects: ${observationObjectFiles.length}\n`,
	);
	if (findings.length > 0) {
		process.stdout.write(`\nFINDINGS (${findings.length}) — tampering or corruption evidence:\n`);
		for (const finding of findings) {
			process.stdout.write(`  - ${JSON.stringify(finding)}\n`);
		}
	}
	if (warnings.length > 0) {
		process.stdout.write(`\nwarnings (${warnings.length}, not counted as tampering):\n`);
		for (const warning of warnings) {
			process.stdout.write(`  - ${JSON.stringify(warning)}\n`);
		}
	}
	if (findings.length === 0) {
		process.stdout.write("\nOK: all chains verified, all objects reconcile.\n");
		process.exitCode = 0;
	} else {
		process.exitCode = 1;
	}
}

async function hashAtLine(path, lineNumber) {
	try {
		const text = await readFile(path, "utf8");
		const lines = text.split("\n").filter((line) => line.trim().length > 0);
		const obj = JSON.parse(lines[lineNumber - 1]);
		return typeof obj?.hash === "string" ? obj.hash : undefined;
	} catch {
		return undefined;
	}
}

main().catch((error) => {
	process.stderr.write(`verify-evidence failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(2);
});
