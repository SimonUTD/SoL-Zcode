/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Vendored from @alicekk/sol-opencode-core (sol-opencode/packages/core/src/reducer/config.ts)
 * into sol-zcode as ESM JavaScript with type erasure only; algorithm and
 * constants are unchanged.
 *
 * Adapter-visible deviations (both recorded in the P1 report):
 * 1. `REDUCER_RECEIPT_PREFIX` renamed to `sol_zcode_evidence_receipt_v1`
 *    (DESIGN §2.3); the observation-pack skip literal is renamed in lockstep so
 *    the cross-mechanism invariant is preserved.
 * 2. `loadReducerConfig` accepts an optional `options.storeRoot` override so
 *    the sol-zcode adapter can place the store at
 *    `$ZCODE_PLUGIN_DATA/store/reducer` per DESIGN §1 (upstream derived it as
 *    `<runtimeDirectory>/evidence-preserving-reducer`). Default behavior is
 *    unchanged when the override is absent.
 * 3. `REDUCER_RECEIPT_SCHEMA` renamed to `sol-zcode-evidence-receipt/1`
 *    (cosmetic equality token; validation semantics unchanged).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

export const REDUCER_EVENT_TYPE = "sol-zcode-evidence-preserving-reducer-v1";
export const REDUCER_EVENT_SCHEMA = "sol-zcode-evidence-preserving-reducer/1";
export const REDUCER_RECEIPT_SCHEMA = "sol-zcode-evidence-receipt/1";
export const REDUCER_RECEIPT_PREFIX = "sol_zcode_evidence_receipt_v1";

export const MAX_EVIDENCE_ITEMS = 12;
export const MAX_QUOTE_CHARS = 600;

const DEFAULT_MIN_BYTES = 4_096;
const DEFAULT_MAX_CHARS = 600_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
const DEFAULT_TIMEOUT_MS = 90_000;

export const DEFAULT_REDUCER_PROVIDER = ["openai", "codex"].join("-");
export const DEFAULT_REDUCER_MODEL = ["gpt-5.6", "luna"].join("-");

export const DIAGNOSTIC_COMMAND =
	/(?:^|[;&|()\s])(?:lake\s+build|lake\s+env\s+lean|lean|coq|cargo(?:\s+(?:build|test|check))?|zig\s+build|pytest|python(?:3)?\s+-m\s+(?:pytest|unittest|py_compile)|ctest|cmake\s+--build|ninja|make|npm\s+test|pnpm\s+test|yarn\s+test|go\s+test|bazel\s+test)(?:\s|$)/i;

export const FAILURE_SIGNAL = /error|failed|failure|fatal|exception|panic|timeout|unsolved|type mismatch|assert/i;
export const LIKELY_SECRET = /(?:api[_-]?key|authorization|bearer|access[_-]?token|secret)[^\n]{0,32}[=:][^\n]+/i;

export function sha256(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordValue(value, key) {
	return isRecord(value) ? value[key] : undefined;
}

export function loadReducerConfig(runtimeDirectory, options = {}) {
	return Object.freeze({
		maxChars: DEFAULT_MAX_CHARS,
		maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
		minBytes: DEFAULT_MIN_BYTES,
		reducerModel: options.reducerModel ?? DEFAULT_REDUCER_MODEL,
		reducerProvider: options.reducerProvider ?? DEFAULT_REDUCER_PROVIDER,
		runId: sha256(runtimeDirectory).slice(0, 16),
		storeRoot: options.storeRoot ?? join(runtimeDirectory, "evidence-preserving-reducer"),
		timeoutMs: DEFAULT_TIMEOUT_MS,
	});
}
