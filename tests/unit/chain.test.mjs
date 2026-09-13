/*
 * Hash-chained ledger unit tests: append/verify roundtrip, tamper detection
 * (rewrite, delete, insert), concurrent append from separate processes, and
 * the >64KiB single-line regression (audit M2).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { appendChained, GENESIS_HASH, readChainHead, readLastLine, verifyChainFile } from "../../plugin/hooks/lib/chain.mjs";

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

// Audit M2 regression: a single ledger line larger than the default 64KiB
// read window (occ-history embeds the full state incl. plan; parsePlanSteps
// allows 128 steps × 16KiB goals). The old fixed window returned a mid-line
// fragment, JSON.parse failed in readChainHead, and the NEXT append silently
// restarted the chain from GENESIS → verifyChainFile reported chain-break.
test("readLastLine returns the complete last line when it exceeds 64KiB", async () => {
	await withRoot(async (root) => {
		const path = join(root, "big.jsonl");
		// Chained-line shape (hash field) so readChainHead accepts it as a head.
		const bigLine = JSON.stringify({ event: "state", blob: "x".repeat(73_000), hash: "a".repeat(64) });
		await writeFile(path, `${bigLine}\n`, "utf8");
		const line = await readLastLine(path);
		assert.equal(line, bigLine, "the full line must come back, not a tail fragment");
		const head = await readChainHead(path);
		assert.notEqual(head, null);
		assert.equal(head.hash, "a".repeat(64));
	});
});

test("append after a >64KiB chained line extends the chain instead of restarting from genesis", async () => {
	await withRoot(async (root) => {
		const path = join(root, "occ-history.jsonl");
		// >64KiB of embedded state (goal 16,384 + filler 55,000 + envelope),
		// matching the audit repro (73953-byte line) shape.
		await appendChained(root, path, {
			event: "state",
			reason: "stop-noop",
			state: { plan: [{ id: "p1", goal: "g".repeat(16_384), status: "completed" }], filler: "f".repeat(55_000) },
		});
		const rawFirst = (await readFile(path, "utf8")).trim();
		assert.ok(Buffer.byteLength(rawFirst, "utf8") > 64 * 1024, "precondition: first line exceeds the default window");
		const headBefore = await readChainHead(path);
		assert.notEqual(headBefore, null, "head must parse despite the oversized line");

		await appendChained(root, path, { event: "state", reason: "stop-noop", state: { plan: [] } });

		const result = await verifyChainFile(path);
		assert.deepEqual(
			result.findings.map((f) => f.kind),
			[],
			`no chain-break expected, got: ${JSON.stringify(result.findings)}`,
		);
		assert.equal(result.ok, true);
		assert.equal(result.lines, 2);
		const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(lines[0].prevHash, GENESIS_HASH);
		assert.equal(lines[1].prevHash, lines[0].hash, "second line must chain onto the oversized first line");
	});
});

test("readLastLine keeps returning the small last line when an earlier line was oversized", async () => {
	await withRoot(async (root) => {
		const path = join(root, "mixed.jsonl");
		const big = JSON.stringify({ event: "big", blob: "y".repeat(80_000) });
		const small = JSON.stringify({ event: "small", n: 1 });
		await writeFile(path, `${big}\n${small}\n`, "utf8");
		assert.equal(await readLastLine(path), small);
	});
});
