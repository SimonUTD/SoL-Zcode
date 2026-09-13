/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Vendored from @alicekk/sol-opencode-core (sol-opencode/packages/core/src/observation-pack/ledger.ts)
 * into sol-zcode as ESM JavaScript with type erasure only; algorithm and
 * constants are unchanged. Adapter-visible deviation: none.
 *
 * The sol-zcode adapter layers a hash-chained JSONL writer (hooks/lib/chain.mjs)
 * on top of this module for C3 tamper evidence; the plain createLedger remains
 * available and semantics-identical to upstream.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only JSONL record of what the mechanism did on each provider request.
 *
 * The caller derives the ledger path from the active session.
 */
export function createLedger(path) {
	return async (entry) => {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf8");
	};
}
