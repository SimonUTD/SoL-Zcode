/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Vendored from @alicekk/sol-opencode-core (sol-opencode/packages/core/src/reducer/cache.ts)
 * into sol-zcode as ESM JavaScript with type erasure only; algorithm and
 * constants are unchanged. Adapter-visible deviation: none.
 */

/** Only accepted receipts enter this bounded, session-local LRU cache. */
export class ReceiptCache {
	constructor(capacity = 64) {
		this.entries = new Map();
		this.capacity = capacity;
	}

	get(key) {
		const value = this.entries.get(key);
		if (!value) return undefined;
		this.entries.delete(key);
		this.entries.set(key, value);
		// Reuse the evidence, not the usage charged for the original request.
		return {
			...value,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		};
	}

	set(key, value) {
		this.entries.delete(key);
		this.entries.set(key, value);
		if (this.entries.size > this.capacity) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
	}

	delete(key) {
		this.entries.delete(key);
	}
}
