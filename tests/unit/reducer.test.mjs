/*
 * Ported from sol-opencode/packages/core/test/reducer.test.ts (vitest →
 * node:test, assertions equivalent). Schema/prefix constants reflect the
 * sol-zcode rename (sol-zcode-evidence-receipt/1, sol_zcode_evidence_receipt_v1).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { archiveBody } from "../../plugin/core/reducer/archive.mjs";
import { ReceiptCache } from "../../plugin/core/reducer/cache.mjs";
import { REDUCER_RECEIPT_PREFIX, REDUCER_RECEIPT_SCHEMA, loadReducerConfig } from "../../plugin/core/reducer/config.mjs";
import { evaluateReducerGates, reducerCacheKey } from "../../plugin/core/reducer/policy.mjs";
import { receiptText, validateReceipt } from "../../plugin/core/reducer/receipt.mjs";

async function withRoot(fn) {
	const root = await mkdtemp(join(tmpdir(), "sol-reducer-"));
	try {
		return await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const PROVIDER = {
	errorMessage: undefined,
	model: "m",
	ok: true,
	outputText: "",
	provider: "p",
	stopReason: "stop",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
};

test("archiveBody stores content-addressed objects and reuses identical bytes", async () => {
	await withRoot(async (root) => {
		const body = "line one\nline two\n";
		const first = await archiveBody(root, body);
		const second = await archiveBody(root, body);
		assert.equal(second.hash, first.hash);
		assert.equal(second.path, first.path);
		assert.equal(await readFile(first.path, "utf8"), body);
	});
});

test("archiveBody rejects a conflicting object at the same hash path", async () => {
	await withRoot(async (root) => {
		const body = "aaa";
		const archive = await archiveBody(root, body);
		await writeFile(archive.path, "tampered", "utf8");
		await assert.rejects(() => archiveBody(root, body));
	});
});

const BODY = "error: boom\nnote: ok\n";

test("validateReceipt accepts a fully verifiable failure receipt with line numbers", async () => {
	await withRoot(async (root) => {
		const archive = await archiveBody(root, BODY);
		const receipt = JSON.stringify({
			schema: REDUCER_RECEIPT_SCHEMA,
			source_sha256: archive.hash,
			status: "failure",
			uncertain: false,
			evidence: [{ kind: "failure", quote: "error: boom" }],
		});
		const result = validateReceipt(receipt, archive, BODY, true);
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.value.evidence[0]?.line, 1);
	});
});

test("validateReceipt rejects quotes that are not in the archive", async () => {
	await withRoot(async (root) => {
		const archive = await archiveBody(root, BODY);
		const receipt = JSON.stringify({
			schema: REDUCER_RECEIPT_SCHEMA,
			source_sha256: archive.hash,
			status: "failure",
			uncertain: false,
			evidence: [{ kind: "failure", quote: "not in body" }],
		});
		assert.deepEqual(validateReceipt(receipt, archive, BODY, true), { ok: false, reason: "unverifiable-quote" });
	});
});

test("validateReceipt rejects a schema or source-hash mismatch", async () => {
	await withRoot(async (root) => {
		const archive = await archiveBody(root, BODY);
		const receipt = JSON.stringify({
			schema: "wrong",
			source_sha256: archive.hash,
			status: "failure",
			uncertain: false,
			evidence: [],
		});
		assert.equal(validateReceipt(receipt, archive, BODY, true).ok, false);
	});
});

test("validateReceipt requires failure evidence for a failing log that signals failure", async () => {
	await withRoot(async (root) => {
		const archive = await archiveBody(root, BODY);
		const receipt = JSON.stringify({
			schema: REDUCER_RECEIPT_SCHEMA,
			source_sha256: archive.hash,
			status: "failure",
			uncertain: true,
			evidence: [],
		});
		assert.deepEqual(validateReceipt(receipt, archive, BODY, true), {
			ok: false,
			reason: "missing-failure-evidence",
		});
	});
});

test("receiptText starts with the prefix the observation pack uses to exclude receipts", async () => {
	await withRoot(async (root) => {
		const body = "error: x\n";
		const archive = await archiveBody(root, body);
		const result = validateReceipt(
			JSON.stringify({
				schema: REDUCER_RECEIPT_SCHEMA,
				source_sha256: archive.hash,
				status: "failure",
				uncertain: false,
				evidence: [{ kind: "failure", quote: "error: x" }],
			}),
			archive,
			body,
			true,
		);
		if (!result.ok) throw new Error("expected a valid receipt");
		const text = receiptText("cargo build", archive, result.value, PROVIDER);
		assert.equal(text.split("\n")[0], REDUCER_RECEIPT_PREFIX);
		assert.ok(text.includes(`source_artifact=${archive.path}`));
	});
});

const CONFIG = loadReducerConfig("/tmp/sol-reducer-root");

test("reducer policy gates on diagnostic commands, size and secrets", () => {
	const big = "x".repeat(CONFIG.minBytes + 1);
	assert.deepEqual(evaluateReducerGates("cargo build", big, CONFIG), { eligible: true });
	assert.deepEqual(evaluateReducerGates("echo hi", big, CONFIG), { eligible: false, reason: "not-diagnostic" });
	assert.deepEqual(evaluateReducerGates("cargo build", "x", CONFIG), { eligible: false, reason: "below-min-bytes" });
	assert.deepEqual(evaluateReducerGates("cargo build", `${big}\napi_key=abcdef123456`, CONFIG), {
		eligible: false,
		reason: "likely-secret",
	});
});

test("reducer policy builds a stable cache key that changes with the command", () => {
	const a = reducerCacheKey(CONFIG, "hash", "cargo build", false);
	assert.equal(reducerCacheKey(CONFIG, "hash", "cargo build", false), a);
	assert.notEqual(reducerCacheKey(CONFIG, "hash", "cargo test", false), a);
});

test("ReceiptCache zeroes usage on a hit and evicts beyond capacity", () => {
	const cache = new ReceiptCache(2);
	const value = {
		...PROVIDER,
		usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
	};
	cache.set("a", value);
	assert.equal(cache.get("a")?.usage.totalTokens, 0);
	cache.set("b", value);
	cache.set("c", value);
	assert.equal(cache.get("a"), undefined);
});
