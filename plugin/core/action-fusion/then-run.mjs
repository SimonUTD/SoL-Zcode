/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Vendored from @alicekk/sol-opencode-core (sol-opencode/packages/core/src/action-fusion/then-run.ts)
 * into sol-zcode as ESM JavaScript with type erasure only; algorithm and
 * constants are unchanged. Adapter-visible deviation: none.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { withFusedFileQueue } from "./file-queue.mjs";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

async function fileSha256(path) {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * Guard the fused command against a mutation that changed the target between
 * the edit landing and the command starting. Two reads with a yield in between
 * catch a concurrent writer on the same file.
 */
export async function assertUnchangedBeforeCommand(
	path,
	yieldForInterference = () => new Promise((resolve) => setImmediate(resolve)),
) {
	const mutationHash = await fileSha256(path);
	await yieldForInterference();
	const commandHash = await fileSha256(path);
	if (mutationHash !== commandHash) {
		throw new Error("target content changed after the fused mutation");
	}
}

/**
 * Run a fused follow-up command under the per-canonical-path queue.
 *
 * The mutation itself is owned by the host tool, so this covers the
 * hash-check + command only. A same-file write landing between the mutation and
 * the check yields a conservative `skipped` outcome rather than a wrong command.
 */
export async function runThenRun(input) {
	return withFusedFileQueue(input.absolutePath, async () => {
		try {
			await assertUnchangedBeforeCommand(input.absolutePath);
		} catch (error) {
			return { status: "skipped", reason: errorText(error) };
		}
		try {
			return { status: "succeeded", output: await input.runCommand(input.thenRun) };
		} catch (error) {
			return { status: "failed", error: errorText(error) };
		}
	});
}
