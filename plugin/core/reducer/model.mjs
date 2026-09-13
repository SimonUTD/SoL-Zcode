/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 ImKK666. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Vendored from @alicekk/sol-opencode-core (sol-opencode/packages/core/src/reducer/model.ts)
 * into sol-zcode as ESM JavaScript with type erasure only. This module is
 * types-only upstream; the shapes are documented here as JSDoc for the adapter.
 *
 * Adapter-visible deviation: none.
 */

/**
 * Harness-neutral result of an auxiliary reducer-model call.
 *
 * Adapters produce this from whatever model transport the harness offers; core
 * only needs the fields the receipt pipeline reads.
 *
 * NormalizedUsage:  { input, output, cacheRead, cacheWrite, totalTokens }
 * ReducerModelResult: {
 *   errorMessage: string | undefined,
 *   model: string,
 *   ok: boolean,
 *   outputText: string,
 *   provider: string,
 *   stopReason: string,
 *   usage: NormalizedUsage,
 * }
 *
 * The sol-zcode adapter (hooks/lib/reducer-subprocess.mjs) builds this shape
 * from a headless `node zcode.cjs --prompt ... --json` subprocess.
 */
export {};
