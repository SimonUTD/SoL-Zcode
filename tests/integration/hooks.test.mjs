/*
 * Hook dispatcher integration tests (DESIGN §6.2): fixture JSON payloads on
 * stdin → envelope / exit code / side-effect assertions, including the strict
 * zero-behavior contract and the exit-2 gate.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeEnv, pluginRoot } from "./helpers.mjs";

async function runHook(fixture, payload, extraEnv = {}) {
	const child = spawn(process.execPath, [join(pluginRoot(), "hooks", "sol-hook.mjs")], {
		env: { ...fixture.env, ...extraEnv },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	child.stdin.write(JSON.stringify(payload));
	child.stdin.end();
	const code = await new Promise((resolve) => child.on("close", resolve));
	return { code, stdout, stderr };
}

async function assertDirEmpty(path) {
	const entries = await readdir(path).catch(() => []);
	assert.deepEqual(entries, [], `expected no side-effect files under ${path}`);
}

const SESSION = "sess_hook-test-1";

function basePayload(event, extra = {}) {
	return {
		hook_event_name: event,
		hookEventName: event,
		session_id: SESSION,
		sessionId: SESSION,
		cwd: "/tmp",
		permission_mode: "yolo",
		...extra,
	};
}

test("all-off config: every event exits 0 with empty stdout and zero files", async () => {
	const fixture = await makeEnv({ options: {} });
	try {
		for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "PermissionRequest"]) {
			const result = await runHook(fixture, basePayload(event));
			assert.equal(result.code, 0, event);
			assert.equal(result.stdout, "", event);
		}
		await assertDirEmpty(fixture.dataDir);
	} finally {
		await cleanup(fixture);
	}
});

test("SOL_ZCODE_AUX=1: zero behavior even with full opt-in", async () => {
	const fixture = await makeEnv({
		options: { actionFusion: true, observationPack: true, evidenceReducer: true, onlineCompact: true, trajectory: true },
	});
	try {
		const result = await runHook(fixture, basePayload("SessionStart", { source: "startup" }), { SOL_ZCODE_AUX: "1" });
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "");
		await assertDirEmpty(fixture.dataDir);
	} finally {
		await cleanup(fixture);
	}
});

test("SessionStart(startup) injects the guidance additionalContext", async () => {
	const fixture = await makeEnv({ options: { actionFusion: true, observationPack: true } });
	try {
		const result = await runHook(fixture, basePayload("SessionStart", { source: "startup" }));
		assert.equal(result.code, 0);
		const envelope = JSON.parse(result.stdout);
		assert.equal(envelope.hookSpecificOutput.hookEventName, "SessionStart");
		const context = envelope.hookSpecificOutput.additionalContext;
		assert.ok(context.includes("[sol-zcode]"));
		assert.ok(context.includes("sol_edit / sol_write"));
		assert.ok(context.includes("obs_recall"));
		// Reducer guidance absent when reducer off.
		assert.ok(!context.includes("evidence receipt"));
	} finally {
		await cleanup(fixture);
	}
});

test("SessionStart with only trajectory on: no additionalContext, but trajectory recorded", async () => {
	const fixture = await makeEnv({ options: { trajectory: true } });
	try {
		const result = await runHook(fixture, basePayload("SessionStart", { source: "startup" }));
		assert.equal(result.stdout, "");
		const trajectory = await readFile(join(fixture.dataDir, "store", "trajectory", `${SESSION}.jsonl`), "utf8");
		const lines = trajectory.trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(lines[0].schema, "sol_zcode_trajectory_v1");
		assert.equal(lines[0].event, "session_start");
		// Field whitelist: no prompt/args/output keys ever.
		for (const line of lines) {
			for (const key of Object.keys(line)) {
				assert.ok(
					["schema", "runId", "ts", "event", "tool", "toolCallId", "status", "bytes", "tokens", "detail", "prevHash", "hash"].includes(key),
					`whitelisted keys only, saw ${key}`,
				);
			}
		}
	} finally {
		await cleanup(fixture);
	}
});

test("PreToolUse gate: Write/Edit exit 2 with stderr reason; other tools pass", async () => {
	const fixture = await makeEnv({ options: { actionFusionGate: true } });
	try {
		const blocked = await runHook(fixture, basePayload("PreToolUse", { tool_name: "Write", tool_input: {} }));
		assert.equal(blocked.code, 2);
		assert.equal(blocked.stdout, "");
		assert.ok(blocked.stderr.includes("use sol_write / sol_edit"));

		const blockedEdit = await runHook(fixture, basePayload("PreToolUse", { tool_name: "Edit", tool_input: {} }));
		assert.equal(blockedEdit.code, 2);

		const allowed = await runHook(fixture, basePayload("PreToolUse", { tool_name: "Bash", tool_input: {} }));
		assert.equal(allowed.code, 0);
		assert.equal(allowed.stdout, "");
	} finally {
		await cleanup(fixture);
	}
});

test("PostToolUse archives a large native Bash output and ledgers a native event", async () => {
	const fixture = await makeEnv({ options: { observationPack: true } });
	try {
		const big = Array.from({ length: 500 }, (_v, i) => `native line ${i} ${"z".repeat(30)}\n`).join("");
		const result = await runHook(fixture, basePayload("PostToolUse", {
			tool_name: "Bash",
			toolName: "Bash",
			tool_response: {
				stdout: big.slice(0, 30000),
				stderr: "",
				exitCode: 0,
				stdoutBytes: Buffer.byteLength(big),
				stdoutTruncated: false,
			},
		}));
		assert.equal(result.code, 0);
		const objectsDir = join(fixture.dataDir, "store", "observation-pack", "objects");
		const objects = await readdir(objectsDir);
		assert.equal(objects.length, 1);
		assert.match(objects[0], /^obs_[a-f0-9]{24}\.txt$/);
		assert.equal(await readFile(join(objectsDir, objects[0]), "utf8"), big.slice(0, 30000));
		const ledger = await readFile(join(fixture.dataDir, "store", "ledger", SESSION, "observation.jsonl"), "utf8");
		const entry = JSON.parse(ledger.trim());
		assert.equal(entry.event, "native");
		assert.equal(entry.tool, "Bash");
	} finally {
		await cleanup(fixture);
	}
});

test("PostToolUse prefers the persisted full output over truncated stdout (G6)", async () => {
	const fixture = await makeEnv({ options: { observationPack: true } });
	try {
		const full = Array.from({ length: 600 }, (_v, i) => `persisted line ${i} ${"q".repeat(30)}\n`).join("");
		const persistedPath = join(fixture.root, "persisted.log");
		await writeFile(persistedPath, full, "utf8");
		await runHook(fixture, basePayload("PostToolUse", {
			tool_name: "Bash",
			tool_response: {
				stdout: full.slice(0, 30000),
				persistedOutputPath: persistedPath,
				persistedOutputSize: Buffer.byteLength(full),
				exitCode: 0,
			},
		}));
		const objectsDir = join(fixture.dataDir, "store", "observation-pack", "objects");
		const objects = await readdir(objectsDir);
		assert.equal(await readFile(join(objectsDir, objects[0]), "utf8"), full);
	} finally {
		await cleanup(fixture);
	}
});

test("PostToolUse skips archiving for the plugin's own MCP tools", async () => {
	const fixture = await makeEnv({ options: { observationPack: true } });
	try {
		// Live namespace: mcp__plugin_<plugin>_<server>__<tool>.
		await runHook(fixture, basePayload("PostToolUse", {
			tool_name: "mcp__plugin_sol-zcode_sol__sol_bash",
			tool_response: { stdout: "x".repeat(20 * 1024), exitCode: 0 },
		}));
		await assertDirEmpty(join(fixture.dataDir, "store"));
	} finally {
		await cleanup(fixture);
	}
});

test("PostToolUse(TodoWrite) opens an OCC boundary; Stop with transcript decides and blocks", async () => {
	const fixture = await makeEnv({ options: { onlineCompact: true } });
	try {
		await runHook(fixture, basePayload("PostToolUse", {
			tool_name: "TodoWrite",
			tool_input: {
				todos: [
					{ content: "first", status: "completed", priority: "high" },
					{ content: "second", status: "in_progress", priority: "high" },
					{ content: "third", status: "pending", priority: "low" },
				],
			},
			tool_response: {},
		}));
		const occState = JSON.parse(await readFile(join(fixture.dataDir, "store", "ledger", SESSION, "occ-state.json"), "utf8"));
		assert.equal(occState.pendingBoundary, true);
		assert.equal(occState.plan.length, 3);

		// Grow context beyond the first boundary → economical → Stop block.
		const transcriptPath = join(fixture.root, "transcript.jsonl");
		const lines = Array.from({ length: 150 }, () =>
			JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "w".repeat(4000) }] } }),
		);
		// Seed prior context via a first Stop with a small transcript.
		const smallPath = join(fixture.root, "small.jsonl");
		await writeFile(smallPath, lines.slice(0, 3).join("\n") + "\n", "utf8");
		await runHook(fixture, basePayload("Stop", { transcript_path: smallPath, stop_hook_active: false }));
		// Shape the state history a long session would have accumulated:
		// several completed boundaries averaging 5 requests each, steady
		// ~2000-token increments (keeps the window request bound open).
		const { setOccStateForTests } = await import("../../plugin/hooks/lib/occ.mjs");
		await setOccStateForTests(fixture.dataDir, SESSION, {
			completedBoundaryRequestCounts: [4, 6, 5],
			increments: [2000, 2000, 2000],
			lastContextTokens: 150_000 - 2000,
		});
		await writeFile(transcriptPath, lines.join("\n") + "\n", "utf8");
		const stop = await runHook(fixture, basePayload("Stop", { transcript_path: transcriptPath, stop_hook_active: false }));
		assert.equal(stop.code, 0);
		const envelope = JSON.parse(stop.stdout);
		assert.equal(envelope.decision, "block");
		assert.ok(envelope.reason.startsWith("[sol-occ]"));
		// session-summary anchor written.
		const summary = JSON.parse(await readFile(join(fixture.dataDir, "store", "ledger", SESSION, "session-summary.json"), "utf8"));
		assert.equal(summary.schema, "sol_zcode_session_summary_v1");
	} finally {
		await cleanup(fixture);
	}
});

test("UserPromptSubmit with CORRECTION: clears OCC debt and records trajectory hash-only", async () => {
	const fixture = await makeEnv({ options: { onlineCompact: true, trajectory: true } });
	try {
		const { setOccStateForTests } = await import("../../plugin/hooks/lib/occ.mjs");
		await setOccStateForTests(fixture.dataDir, SESSION, { carriedDebtTokens: 5000, epoch: 1 });
		const result = await runHook(fixture, basePayload("UserPromptSubmit", { prompt: "CORRECTION: do it differently" }));
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "");
		const state = JSON.parse(await readFile(join(fixture.dataDir, "store", "ledger", SESSION, "occ-state.json"), "utf8"));
		assert.equal(state.carriedDebtTokens, 0);
		assert.equal(state.epoch, 2);
		const trajectory = await readFile(join(fixture.dataDir, "store", "trajectory", `${SESSION}.jsonl`), "utf8");
		const entry = JSON.parse(trajectory.trim());
		assert.equal(entry.event, "user_prompt");
		assert.ok(entry.detail.startsWith("sha256="));
		assert.ok(!JSON.stringify(entry).includes("do it differently"), "prompt text must never be stored");
	} finally {
		await cleanup(fixture);
	}
});

test("Stop with unreadable transcript is a no-op (fail-open) but still writes the summary", async () => {
	const fixture = await makeEnv({ options: { onlineCompact: true } });
	try {
		const result = await runHook(fixture, basePayload("Stop", { transcript_path: "/nonexistent/x.jsonl", stop_hook_active: false }));
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "");
		await readFile(join(fixture.dataDir, "store", "ledger", SESSION, "session-summary.json"), "utf8");
	} finally {
		await cleanup(fixture);
	}
});

test("unparsable stdin fails open: exit 0, empty stdout, no files", async () => {
	const fixture = await makeEnv({ options: { trajectory: true } });
	try {
		const child = spawn(process.execPath, [join(pluginRoot(), "hooks", "sol-hook.mjs")], {
			env: { ...fixture.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdin.write("this is not json");
		child.stdin.end();
		const code = await new Promise((resolve) => child.on("close", resolve));
		assert.equal(code, 0);
		await assertDirEmpty(fixture.dataDir);
	} finally {
		await cleanup(fixture);
	}
});

test("mistyped option keys journal config_rejected into the trajectory", async () => {
	const fixture = await makeEnv({ options: { trajectory: "yes" } });
	try {
		const result = await runHook(fixture, basePayload("UserPromptSubmit", { prompt: "hi" }));
		assert.equal(result.code, 0);
		const trajectory = await readFile(join(fixture.dataDir, "store", "trajectory", `${SESSION}.jsonl`), "utf8");
		const entry = JSON.parse(trajectory.trim());
		assert.equal(entry.event, "config_rejected");
		assert.ok(entry.detail.includes("trajectory"));
	} finally {
		await cleanup(fixture);
	}
});
