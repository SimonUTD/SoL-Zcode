/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Vendored from @alicekk/sol-opencode-core (sol-opencode/packages/core/src/trajectory/jsonl.ts)
 * into sol-zcode as ESM JavaScript with type erasure only; algorithm and
 * constants are unchanged.
 *
 * Adapter-visible deviation (recorded): the sol-zcode adapter writes its
 * trajectory stream through a hash-chained writer with a stricter field
 * whitelist (hooks/lib/chain.mjs + store.mjs, schema `sol_zcode_trajectory_v1`,
 * DESIGN §2.5) because the durable file is shared across processes; this
 * vendored recorder remains semantics-identical and covered by the ported
 * unit tests, and is used by the MCP server for in-process spans.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TrajectoryStore } from "./store.mjs";

export const TRAJECTORY_EVENT_SCHEMA = "sol_opencode_trajectory_v1";

/**
 * Trajectory store plus a non-blocking, batched JSONL writer.
 *
 * Writes are metadata-only (kinds, labels, statuses, durations, byte counts and
 * correlation ids) and never block or fail the agent: write errors are logged
 * once and swallowed.
 */
export class TrajectoryRecorder {
	constructor(root, maxRecords) {
		this.runId = randomUUID();
		this.store = new TrajectoryStore(maxRecords);
		this.directory = join(root, "trajectory-inspector");
		this.pending = [];
		this.writes = Promise.resolve();
	}

	record(input, timestamp = Date.now()) {
		const record = this.store.record(input, timestamp);
		this.enqueue({ event: "record", ...record });
		return record;
	}

	update(sequence, update) {
		const record = this.store.update(sequence, update);
		// Keep completion metadata in the durable stream even after a record has
		// fallen out of the bounded UI tail.
		this.enqueue({ event: "update", sequence, ...update, timestamp: Date.now() });
		return record;
	}

	async flush() {
		await this.writes;
	}

	enqueue(entry) {
		this.pending.push(`${JSON.stringify({ schema: TRAJECTORY_EVENT_SCHEMA, runId: this.runId, ...entry })}\n`);
		this.writes = this.writes
			.then(async () => {
				if (this.pending.length === 0) return;
				await mkdir(this.directory, { recursive: true });
				while (this.pending.length > 0) {
					const batch = this.pending.join("");
					this.pending = [];
					await appendFile(join(this.directory, "events.jsonl"), batch, "utf8");
				}
			})
			.catch((error) => {
				this.pending = [];
				// Observability must never change the agent's behavior.
				console.error(
					`[trajectory-inspector] ledger write failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
	}
}
