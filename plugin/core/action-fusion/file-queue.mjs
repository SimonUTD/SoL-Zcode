/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Vendored from @alicekk/sol-opencode-core (sol-opencode/packages/core/src/action-fusion/file-queue.ts)
 * into sol-zcode as ESM JavaScript with type erasure only; algorithm and
 * constants are unchanged. Adapter-visible deviation: none.
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const queueTails = new Map();
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

function normalizeToolPath(filePath) {
	const normalized = filePath.replace(UNICODE_SPACES, " ");
	return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}

export function resolveToolPath(cwd, filePath) {
	const stripped = normalizeToolPath(filePath);
	// Pi accepts file URLs; the queue and hash guard must use the same target.
	const expanded = stripped.startsWith("file://") ? fileURLToPath(stripped) : stripped;
	if (expanded === "~") return homedir();
	if (expanded.startsWith("~/")) return resolve(homedir(), expanded.slice(2));
	return resolve(cwd, expanded);
}

function isMissingPathError(error) {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function canonicalQueueKey(filePath) {
	const resolvedPath = resolve(filePath);
	let current = resolvedPath;
	const missingSegments = [];

	while (true) {
		try {
			return resolve(await realpath(current), ...missingSegments);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			const parent = dirname(current);
			if (parent === current) return resolvedPath;
			missingSegments.unshift(basename(current));
			current = parent;
		}
	}
}

/**
 * Serialize fused operations for one canonical file path. This queue belongs
 * to SoL and intentionally does not nest the host's built-in mutation queue.
 */
export async function withFusedFileQueue(filePath, work) {
	const key = await canonicalQueueKey(filePath);
	const previous = queueTails.get(key) ?? Promise.resolve();
	let release;
	const owned = new Promise((resolveOwned) => {
		release = resolveOwned;
	});
	const tail = previous.then(() => owned);
	queueTails.set(key, tail);

	await previous;
	try {
		return await work();
	} finally {
		release();
		if (queueTails.get(key) === tail) queueTails.delete(key);
	}
}
