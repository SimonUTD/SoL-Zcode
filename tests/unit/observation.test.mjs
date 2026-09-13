/*
 * Ported from sol-opencode/packages/core/test/observation.test.ts (vitest →
 * node:test, assertions equivalent). Receipt-prefix literal updated to the
 * sol-zcode rename (sol_zcode_evidence_receipt_v1).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	THRESHOLD_BYTES,
	createObservation,
	ensureStored,
	isObservationId,
	placeholderFor,
	readRecallChunk,
	searchObservation,
} from "../../plugin/core/observation-pack/observation.mjs";

function multilineText(lines = 400) {
	return Array.from({ length: lines }, (_value, index) => `line ${index} ${"x".repeat(30)}\n`).join("");
}

async function withRoot(fn) {
	const root = await mkdtemp(join(tmpdir(), "sol-observation-"));
	try {
		return await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("createObservation ignores results at or below the threshold", () => {
	const text = "x".repeat(THRESHOLD_BYTES);
	assert.equal(createObservation({ toolName: "bash", toolCallId: "c1", text }, "/tmp/root"), undefined);
});

test("createObservation derives a stable, well-formed id above the threshold", () => {
	const text = "x".repeat(THRESHOLD_BYTES + 1);
	const first = createObservation({ toolName: "bash", toolCallId: "c1", text }, "/tmp/root");
	const second = createObservation({ toolName: "bash", toolCallId: "c1", text }, "/tmp/root");
	assert.equal(first?.id, second?.id);
	assert.equal(first !== undefined && isObservationId(first.id), true);
	assert.equal(first?.bytes, THRESHOLD_BYTES + 1);
});

test("createObservation excludes evidence-reducer receipts from packing", () => {
	const text = `sol_zcode_evidence_receipt_v1\n${"x".repeat(THRESHOLD_BYTES)}`;
	assert.equal(createObservation({ toolName: "bash", toolCallId: "c1", text }, "/tmp/root"), undefined);
});

test("placeholderFor is deterministic and embeds head and tail excerpts", () => {
	const observation = createObservation({ toolName: "bash", toolCallId: "c1", text: multilineText() }, "/tmp/root");
	if (!observation) throw new Error("expected an observation");
	const first = placeholderFor(observation);
	const second = placeholderFor(observation);
	assert.equal(first, second);
	assert.ok(first.includes(`id: ${observation.id}`));
	assert.ok(first.includes(`original_bytes: ${observation.bytes}`));
	assert.ok(first.includes("line 0 "));
	assert.ok(first.includes("line 399 "));
});

test("ensureStored writes the object and is idempotent for identical bytes", async () => {
	await withRoot(async (root) => {
		const text = multilineText();
		const observation = createObservation({ toolName: "bash", toolCallId: "c1", text }, root);
		if (!observation) throw new Error("expected an observation");
		await ensureStored(observation);
		assert.equal(await readFile(observation.filePath, "utf8"), text);
		await ensureStored(observation);
	});
});

test("ensureStored rejects a conflicting object at the same path", async () => {
	await withRoot(async (root) => {
		const observation = createObservation({ toolName: "bash", toolCallId: "c1", text: multilineText() }, root);
		if (!observation) throw new Error("expected an observation");
		await ensureStored(observation);
		await writeFile(observation.filePath, "tampered", "utf8");
		await assert.rejects(() => ensureStored(observation));
	});
});

test("readRecallChunk pages by bytes and lines with an accurate eof", async () => {
	await withRoot(async (root) => {
		const text = "aaaa\nbbbb\ncccc\ndddd\n";
		const observation = createObservation(
			{ toolName: "bash", toolCallId: "c1", text: `${text}${"z".repeat(THRESHOLD_BYTES)}` },
			root,
		);
		if (!observation) throw new Error("expected an observation");
		// The archive stores the full text; page over the whole file.
		await ensureStored(observation);
		const first = await readRecallChunk(observation.filePath, 0, { maxBytes: 10, maxLines: 2 });
		assert.equal(first.text, "aaaa\nbbbb\n");
		assert.equal(first.lines, 2);
		assert.equal(first.eof, false);
		const second = await readRecallChunk(observation.filePath, first.nextOffset, { maxBytes: 10, maxLines: 2 });
		assert.equal(second.text, "cccc\ndddd\n");
	});
});

test("searchObservation finds literal matches with LF-based line numbers and bounded context", async () => {
	await withRoot(async (root) => {
		const observation = createObservation({ toolName: "bash", toolCallId: "c1", text: multilineText(600) }, root);
		if (!observation) throw new Error("expected an observation");
		await ensureStored(observation);
		const result = await searchObservation(
			observation.filePath,
			Buffer.from("line 500 ", "utf8"),
			0,
			16 * 1024,
			undefined,
		);
		assert.equal(result.matches.length, 1);
		assert.equal(result.matches[0]?.line, 501);
		assert.ok(result.matches[0]?.context.includes("line 500 "));
		assert.equal(result.eof, true);
	});
});
