/*
 * verify-evidence.mjs integration tests (DESIGN §6.2): build a real store
 * through the production helpers, then tamper (ledger rewrite / object edit /
 * tail truncation vs anchor) and assert the CLI reports it with exit 1.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { pluginRoot } from "./helpers.mjs";
import { appendChained, readChainHead } from "../../plugin/hooks/lib/chain.mjs";
import { appendTrajectory, observationLedgerPath, trajectoryPath } from "../../plugin/hooks/lib/store.mjs";
import { createObservation, ensureStored } from "../../plugin/core/index.mjs";

const SESSION = "sess_verify-1";

async function runVerify(dataRoot, envOverrides = undefined) {
	const result = await new Promise((resolve) => {
		const child = spawn(process.execPath, [join(pluginRoot(), "scripts", "verify-evidence.mjs"), ...(dataRoot === null ? [] : [dataRoot])], {
			stdio: ["ignore", "pipe", "pipe"],
			env: envOverrides ?? process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
	return result;
}

async function buildCleanStore() {
	const root = await mkdtemp(join(tmpdir(), "sol-verify-"));
	const dataRoot = join(root, "data");
	// One observation object + ledger lines.
	const text = Array.from({ length: 300 }, (_v, i) => `verify line ${i} ${"v".repeat(30)}\n`).join("");
	const observation = createObservation({ toolName: "sol_bash", toolCallId: "c1", text }, join(dataRoot, "store"));
	assert.notEqual(observation, undefined);
	await ensureStored(observation);
	await appendChained(dataRoot, observationLedgerPath(dataRoot, SESSION), {
		ts: new Date().toISOString(),
		event: "placeholder",
		id: observation.id,
		contentHash: observation.contentHash,
		bytes: observation.bytes,
		tokens: observation.tokens,
	});
	// One reducer object + ledger line.
	const body = "error: boom\n" + "detail\n".repeat(600);
	const { archiveBody, sha256 } = await import("../../plugin/core/index.mjs");
	const archive = await archiveBody(join(dataRoot, "store", "reducer"), body);
	await appendChained(dataRoot, join(dataRoot, "store", "ledger", SESSION, "reducer.jsonl"), {
		ts: new Date().toISOString(),
		event: "applied",
		sourceSha256: archive.hash,
	});
	// Trajectory chain.
	await appendTrajectory(dataRoot, SESSION, { event: "session_start", status: "ok" });
	await appendTrajectory(dataRoot, SESSION, { event: "stop", status: "ok" });
	// Session-summary anchor.
	const obsHead = await readChainHead(observationLedgerPath(dataRoot, SESSION));
	const trajHead = await readChainHead(trajectoryPath(dataRoot, SESSION));
	await mkdir(join(dataRoot, "store", "ledger", SESSION), { recursive: true });
	await writeFile(
		join(dataRoot, "store", "ledger", SESSION, "session-summary.json"),
		JSON.stringify({
			schema: "sol_zcode_session_summary_v1",
			session: SESSION,
			ts: new Date().toISOString(),
			files: {
				observation: { lines: 1, lastHash: obsHead.hash, ok: true },
				trajectory: { lines: 2, lastHash: trajHead.hash, ok: true },
			},
		}, null, 2),
		"utf8",
	);
	return { root, dataRoot, observation, archive };
}

test("clean store verifies with exit 0", async () => {
	const store = await buildCleanStore();
	try {
		const result = await runVerify(store.dataRoot);
		assert.equal(result.code, 0, result.stdout + result.stderr);
		assert.ok(result.stdout.includes("OK: all chains verified"));
	} finally {
		await rm(store.root, { recursive: true, force: true });
	}
});

test("tampered observation ledger line reports hash mismatch and exits 1", async () => {
	const store = await buildCleanStore();
	try {
		const path = observationLedgerPath(store.dataRoot, SESSION);
		const raw = await readFile(path, "utf8");
		const line = JSON.parse(raw.trim());
		line.bytes = 999999; // in-line rewrite without rehashing
		await writeFile(path, `${JSON.stringify(line)}\n`, "utf8");
		const result = await runVerify(store.dataRoot);
		assert.equal(result.code, 1);
		assert.ok(result.stdout.includes("hash-mismatch"));
	} finally {
		await rm(store.root, { recursive: true, force: true });
	}
});

test("tampered observation object (content edited) reports object hash mismatch", async () => {
	const store = await buildCleanStore();
	try {
		await writeFile(store.observation.filePath, store.observation.text.replace("verify line 0", "verify line X"), "utf8");
		const result = await runVerify(store.dataRoot);
		assert.equal(result.code, 1);
		assert.ok(result.stdout.includes("observation-object-hash-mismatch"));
	} finally {
		await rm(store.root, { recursive: true, force: true });
	}
});

test("tampered reducer object reports reducer-object-hash-mismatch", async () => {
	const store = await buildCleanStore();
	try {
		await writeFile(store.archive.path, "tampered content", "utf8");
		const result = await runVerify(store.dataRoot);
		assert.equal(result.code, 1);
		assert.ok(result.stdout.includes("reducer-object-hash-mismatch"));
	} finally {
		await rm(store.root, { recursive: true, force: true });
	}
});

test("deleted referenced object reports missing object", async () => {
	const store = await buildCleanStore();
	try {
		await rm(store.archive.path, { force: true });
		const result = await runVerify(store.dataRoot);
		assert.equal(result.code, 1);
		assert.ok(result.stdout.includes("referenced-reducer-object-missing"));
	} finally {
		await rm(store.root, { recursive: true, force: true });
	}
});

test("truncated trajectory vs session-summary anchor reports anchor truncation", async () => {
	const store = await buildCleanStore();
	try {
		const path = trajectoryPath(store.dataRoot, SESSION);
		const raw = await readFile(path, "utf8");
		const lines = raw.trim().split("\n");
		await writeFile(path, `${lines[0]}\n`, "utf8"); // drop the last line
		const result = await runVerify(store.dataRoot);
		assert.equal(result.code, 1);
		assert.ok(result.stdout.includes("anchor-truncation") || result.stdout.includes("chain-break"));
	} finally {
		await rm(store.root, { recursive: true, force: true });
	}
});

test("rewritten chain prefix vs anchor reports anchor-hash-mismatch", async () => {
	const store = await buildCleanStore();
	try {
		// Append a legitimate line after the anchor, then rewrite the anchored
		// line in place (keep length identical so it is a prefix rewrite, not
		// a truncation).
		const path = observationLedgerPath(store.dataRoot, SESSION);
		const raw = await readFile(path, "utf8");
		const line = JSON.parse(raw.trim());
		line.event = "recall"; // rewritten without rehashing
		await appendChained(store.dataRoot, path, { ts: new Date().toISOString(), event: "recall", id: store.observation.id });
		await writeFile(path, `${JSON.stringify(line)}\n`, "utf8"); // replaces everything — anchor line no longer matches
		const result = await runVerify(store.dataRoot);
		assert.equal(result.code, 1);
		assert.ok(result.stdout.includes("anchor-hash-mismatch") || result.stdout.includes("hash-mismatch"));
	} finally {
		await rm(store.root, { recursive: true, force: true });
	}
});

test("usage error exits 2 for a nonexistent data root", async () => {
	const result = await runVerify("/nonexistent/data-root-xyz");
	assert.equal(result.code, 2);
});

test("argument-less default root matches the runtime store layout (m8)", async () => {
	const store = await buildCleanStore();
	// Simulate the real HOME layout: plugin data at
	// ~/.zcode/cli/plugins/data/sol-zcode@sol-zcode-dev (store.mjs dataRoot).
	const home = await mkdtemp(join(tmpdir(), "sol-home-"));
	const defaultRoot = join(home, ".zcode", "cli", "plugins", "data", "sol-zcode@sol-zcode-dev");
	await mkdir(dirname(defaultRoot), { recursive: true });
	await (await import("node:fs/promises")).cp(store.dataRoot, defaultRoot, { recursive: true });
	try {
		const result = await runVerify(null, {
			HOME: home,
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			TMPDIR: tmpdir(),
		});
		assert.equal(result.code, 0, result.stdout + result.stderr);
		assert.ok(result.stdout.includes(defaultRoot), "must resolve the sol-zcode@sol-zcode-dev default root");
		assert.ok(result.stdout.includes("OK: all chains verified"));
	} finally {
		await rm(store.root, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	}
});
