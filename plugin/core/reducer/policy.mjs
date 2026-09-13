/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Vendored from @alicekk/sol-opencode-core (sol-opencode/packages/core/src/reducer/policy.ts)
 * into sol-zcode as ESM JavaScript with type erasure only; algorithm and
 * constants are unchanged. Adapter-visible deviation: none.
 */

import { DIAGNOSTIC_COMMAND, LIKELY_SECRET, REDUCER_RECEIPT_SCHEMA, sha256 } from "./config.mjs";
import { reducerInstructions } from "./receipt.mjs";

/**
 * Why a diagnostic tool result was or was not eligible for reduction.
 *
 * `not-diagnostic` and `below-min-bytes` are silent skips (SoL-Pi did not
 * journal them); the other reasons are fallback events the adapter records.
 */
export function evaluateReducerGates(command, body, config) {
	if (!DIAGNOSTIC_COMMAND.test(command)) return { eligible: false, reason: "not-diagnostic" };
	if (Buffer.byteLength(body, "utf8") < config.minBytes) return { eligible: false, reason: "below-min-bytes" };
	if (body.length > config.maxChars) return { eligible: false, reason: "source-over-max-chars" };
	if (LIKELY_SECRET.test(body)) return { eligible: false, reason: "likely-secret" };
	return { eligible: true };
}

/**
 * Cache key for an accepted receipt. Every input that could change the receipt
 * (archive identity, command, exit state, reducer model, schema and
 * instructions) participates, so a hit is safe to reuse verbatim.
 */
export function reducerCacheKey(config, archiveHash, command, isError) {
	return sha256(
		JSON.stringify([
			config.storeRoot,
			archiveHash,
			command,
			isError,
			config.reducerProvider,
			config.reducerModel,
			config.maxOutputTokens,
			REDUCER_RECEIPT_SCHEMA,
			reducerInstructions(),
		]),
	);
}
