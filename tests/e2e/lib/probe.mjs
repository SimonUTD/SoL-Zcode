/*
 * e2e probe plugin generator (tests/e2e fixture, NOT part of sol-zcode).
 *
 * Two purposes:
 *  1. Passive host-behavior telemetry: logs every hooked-event payload
 *     (SessionStart/UserPromptSubmit/Stop) to events.jsonl inside its install
 *     dir, and copies the transcript_path file (host temp file, G5) on every
 *     Stop so the e2e layer can inspect the exact message history the model
 *     saw (rollout request bodies carry no `messages` under the default
 *     modelIoFullRetentionEnabled=false — P2 finding).
 *  2. G9 recheck: when `marker` is a string, the UserPromptSubmit hook returns
 *     additionalContext containing that marker — the P2 recheck of the
 *     unresolved GOTCHAS G9 counter-example.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function generateProbePlugin(dest, { marker = null, stopBlockReason = null } = {}) {
	await mkdir(join(dest, ".zcode-plugin"), { recursive: true });
	await mkdir(join(dest, "hooks"), { recursive: true });
	await writeFile(join(dest, ".zcode-plugin", "plugin.json"), JSON.stringify({
		name: "e2e-probe",
		version: "0.0.1",
		description: "sol-zcode P2 e2e probe: passive hook payload/transcript logger + optional UserPromptSubmit additionalContext injection (G9 recheck).",
		author: { name: "sol-zcode-p2-e2e" },
		license: "MIT",
	}, null, 2));
	await writeFile(join(dest, "hooks", "hooks.json"), JSON.stringify({
		hooks: {
			SessionStart: [
				{
					matcher: "startup|clear|compact|resume",
					hooks: [{ type: "process", command: "node", args: ["${ZCODE_PLUGIN_ROOT}/hooks/probe-hook.mjs"], timeoutMs: 10000 }],
				},
			],
			UserPromptSubmit: [
				{
					hooks: [{ type: "process", command: "node", args: ["${ZCODE_PLUGIN_ROOT}/hooks/probe-hook.mjs"], timeoutMs: 10000 }],
				},
			],
			Stop: [
				{
					hooks: [{ type: "process", command: "node", args: ["${ZCODE_PLUGIN_ROOT}/hooks/probe-hook.mjs"], timeoutMs: 10000 }],
				},
			],
		},
	}, null, 2));
		const hook = `#!/usr/bin/env node
import { appendFile, copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const MARKER = ${JSON.stringify(marker)};
const STOP_BLOCK_REASON = ${JSON.stringify(stopBlockReason)};

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let payload = {};
try { payload = JSON.parse(raw); } catch { /* tolerate */ }
const event = payload.hook_event_name ?? payload.hookEventName ?? "";

await appendFile(join(here, "events.jsonl"), JSON.stringify({ ts: new Date().toISOString(), event, payload }) + "\\n").catch(() => {});

if (event === "Stop") {
	// Preserve the (host-temporary, G5) transcript for the e2e layer.
	const transcript = payload.transcript_path ?? payload.transcriptPath;
	if (typeof transcript === "string" && transcript.length > 0) {
		try {
			const existing = (await readdir(here)).filter((n) => n.startsWith("transcript-"));
			await copyFile(transcript, join(here, "transcript-" + String(existing.length + 1).padStart(3, "0") + ".jsonl"));
		} catch { /* best effort */ }
	}
	// Optional one-shot Stop-block channel test (G17): the FIRST Stop returns
	// {"decision":"block"}; the host must continue the turn and re-run Stop
	// with stop_hook_active=true — the only model-reachable Stop channel.
	if (STOP_BLOCK_REASON !== null && !existsSync(join(here, "blocked-once"))) {
		await writeFile(join(here, "blocked-once"), "1", "utf8").catch(() => {});
		process.stdout.write(JSON.stringify({ decision: "block", reason: STOP_BLOCK_REASON }));
	}
}

if (event === "UserPromptSubmit" && MARKER !== null) {
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "UserPromptSubmit",
			additionalContext: "[e2e-g9-probe] Injected context marker " + MARKER + " — passive probe payload; ignore unless explicitly asked about markers.",
		},
	}));
}
`;
	await writeFile(join(dest, "hooks", "probe-hook.mjs"), hook);
}
