/*
 * Hash-chained ledger unit tests: append/verify roundtrip, tamper detection
 * (rewrite, delete, insert), concurrent append from separate processes.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { appendChained, GENESIS_HASH, verifyChainFile } from "../../plugin/hooks/lib/chain.mjs";

async function withRoot(fn) {
	const root = await mkdtemp(join(tmpdir(), "sol-chain-"));
	try {
		return await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("appends chain correctly and verifies clean", async () => {
	await withRoot(async (root) => {
		const path = join(root, "ledger", "observation.jsonl");
		await appendChained(root, path, { event: "full", bytes: 1 });
		await appendChained(root, path, { event: "placeholder", bytes: 2 });
		const result = await verifyChainFile(path);
		assert.equal(result.ok, true);
		assert.equal(result.lines, 2);
		const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(lines[0].prevHash, GENESIS_HASH);
		assert.equal(lines[1].prevHash, lines[0].hash);
		assert.equal(typeof lines[1].hash, "string");
	});
});

test("detects an in-line rewrite (hash mismatch)", async () => {
	await withRoot(async (root) => {
		const path = join(root, "l.jsonl");
		await appendChained(root, path, { event: "a", bytes: 1 });
		await appendChained(root, path, { event: "b", bytes: 2 });
		const raw = await readFile(path, "utf8");
		const lines = raw.trim().split("\n");
		const tampered = JSON.parse(lines[0]);
		tampered.event = "tampered";
		lines[0] = JSON.stringify(tampered);
		await writeFile(path, `${lines.join("\n")}\n`);
		const result = await verifyChainFile(path);
		assert.equal(result.ok, false);
		assert.ok(result.findings.some((f) => f.kind === "hash-mismatch" && f.line === 1));
	});
});

test("detects a mid-stream deletion (chain break)", async () => {
	await withRoot(async (root) => {
		const path = join(root, "l.jsonl");
		for (let i = 0; i < 4; i += 1) await appendChained(root, path, { event: `e${i}`, n: i });
		const lines = (await readFile(path, "utf8")).trim().split("\n");
		lines.splice(1, 1); // delete line 2
		await writeFile(path, `${lines.join("\n")}\n`);
		const result = await verifyChainFile(path);
		assert.equal(result.ok, false);
		assert.ok(result.findings.some((f) => f.kind === "chain-break"));
	});
});

test("detects an insertion (chain break)", async () => {
	await withRoot(async (root) => {
		const path = join(root, "l.jsonl");
		await appendChained(root, path, { event: "a" });
		await appendChained(root, path, { event: "b" });
		const lines = (await readFile(path, "utf8")).trim().split("\n");
		lines.splice(1, 0, JSON.stringify({ event: "forged", prevHash: GENESIS_HASH, hash: "f".repeat(64) }));
		await writeFile(path, `${lines.join("\n")}\n`);
		const result = await verifyChainFile(path);
		assert.equal(result.ok, false);
	});
});

test("verifying a missing file is clean (no ledger yet)", async () => {
	await withRoot(async (root) => {
		const result = await verifyChainFile(join(root, "absent.jsonl"));
		assert.equal(result.ok, true);
		assert.equal(result.lines, 0);
	});
});

test("concurrent appends from two processes keep one chain", async () => {
	await withRoot(async (root) => {
		const path = join(root, "l.jsonl");
		const script = join(root, "worker.mjs");
		await writeFile(
			script,
			`import { appendChained } from ${JSON.stringify(new URL("../../plugin/hooks/lib/chain.mjs", import.meta.url).href)};\n` +
				`const root = process.argv[2];\n` +
				`const n = Number(process.argv[3]);\n` +
				`for (let i = 0; i < 10; i += 1) await appendChained(root, root + "/l.jsonl", { event: "w" + n, i });\n`,
			"utf8",
		);
		const { spawn } = await import("node:child_process");
		const workers = [1, 2, 3].map(
			(n) =>
				new Promise((resolve, reject) => {
					const child = spawn(process.execPath, [script, root, String(n)], { stdio: "ignore" });
					child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${n} exit ${code}`))));
				}),
		);
		await Promise.all(workers);
		const result = await verifyChainFile(path);
		assert.equal(result.ok, true);
		assert.equal(result.lines, 30);
	});
});
