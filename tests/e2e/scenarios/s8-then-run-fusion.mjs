/*
 * S8 — then_run action fusion, real model loop (audit m5; DESIGN §6.3 list
 * item that until now had only P1 protocol-level coverage).
 *
 * One real headless circuit drives both then_run outcome paths through
 * sol_write:
 *   - success path: sol_write(file, then_run="wc -c < file") must return ONE
 *     combined result carrying the "[then_run:succeeded]" marker plus the
 *     verification output (byte count) — asserted on the rollout REQUEST
 *     messages (the model actually received the combined result) and on the
 *     model's own report of the byte count;
 *   - failure path: sol_write(file, then_run="grep -q <never-present-token>")
 *     must KEEP THE WRITE FACT (file on disk with the exact intended bytes)
 *     while returning "[then_run:failed]" and the explicit
 *     "the file mutation above was applied" note.
 *
 * Also asserts (report m5 rider): the REAL session trajectory JSONL carries
 * only whitelisted metadata fields — no prompt/argument/output content —
 * closing the DESIGN §6.3 "trajectory has no content fields" claim at the
 * real-session level (previously fixture-level only), and the observation
 * ledger records both fused results as delivered ("full") events.
 *
 * Options: actionFusion + observationPack + trajectory (evidenceReducer off —
 * no reducer call is needed or wanted here; budget: one model circuit).
 */
import {
	cleanupScenario,
	fileBytes,
	findRollout,
	ledgerPath,
	makeAssertions,
	makeScenario,
	readJsonl,
	readTrajectory,
	recordResult,
	rolloutFindString,
	runPrompt,
	trajectoryPath,
} from "../lib/harness.mjs";
import { readFile } from "node:fs/promises";

export const id = "s8-then-run-fusion";
export const title = "then_run real-model loop: sol_write fused verification (success + failure paths, write fact preserved)";

const OK_CONTENT = "alpha\nbeta\ngamma\n"; // 17 bytes
const FAIL_CONTENT = "one\ntwo\n"; // 8 bytes

const PROMPT = [
	"You are testing the fused write+verify behavior of the sol_write tool. Work in the current directory. Use ONLY the sol_write tool for both file operations below — no Write, no Bash, no other tools.",
	"",
	"1. Call sol_write with EXACTLY these arguments:",
	'- file_path: "thenrun-ok.txt"',
	"- content: exactly three lines, each ending with a newline, nothing else:",
	"alpha",
	"beta",
	"gamma",
	'- then_run: { "command": "wc -c < thenrun-ok.txt" }',
	"",
	"2. Call sol_write with EXACTLY these arguments:",
	'- file_path: "thenrun-fail.txt"',
	"- content: exactly two lines, each ending with a newline, nothing else:",
	"one",
	"two",
	'- then_run: { "command": "grep -q NEVER-PRESENT-TOKEN thenrun-fail.txt" }',
	"The second verification command is EXPECTED TO FAIL — that is intended. Do not retry it, do not work around it, do not modify anything afterwards.",
	"",
	"3. Finally reply with EXACTLY three lines:",
	"OK_BYTES=<the byte count printed by the first call's verification output>",
	"FAIL_MARKER=<the exact [then_run:...] marker from the second call's result>",
	"FAIL_NOTE=<yes or no — did the second call's result explicitly state that the file mutation was applied despite the failed command>",
].join("\n");

const TRAJECTORY_WHITELIST = new Set([
	"schema",
	"runId",
	"ts",
	"event",
	"tool",
	"toolCallId",
	"status",
	"bytes",
	"tokens",
	"detail",
	"prevHash",
	"hash",
]);

function toolEventCounts(trajectory) {
	const counts = {};
	for (const record of trajectory ?? []) {
		if (record.event !== "pre_tool" || typeof record.tool !== "string") continue;
		const name = record.tool.includes("__") ? record.tool.split("__").at(-1) : record.tool;
		counts[name] = (counts[name] ?? 0) + 1;
	}
	return counts;
}

export async function run({ deadline } = {}) {
	const assertions = makeAssertions();
	const sessionIds = [];
	const usages = [];
	const notes = {};
	const sc = await makeScenario(id, { options: { actionFusion: true, observationPack: true, trajectory: true } });
	try {
		const run1 = await runPrompt(sc, PROMPT, { label: "then-run-fusion", timeoutMs: 300_000 });
		sessionIds.push(run1.sessionId);
		if (run1.usage) usages.push(run1.usage);
		assertions.check("session completed (exit 0)", run1.code === 0, `code=${run1.code} signal=${run1.signal}`);
		notes.response = (run1.response ?? "").slice(0, 400);

		// Ground truth on disk: both writes landed, failure path included.
		const okBytes = await fileBytes(`${sc.work}/thenrun-ok.txt`);
		const failBytes = await fileBytes(`${sc.work}/thenrun-fail.txt`);
		const okExpected = Buffer.from(OK_CONTENT, "utf8");
		const failExpected = Buffer.from(FAIL_CONTENT, "utf8");
		assertions.check(
			"success path: thenrun-ok.txt has the exact intended bytes",
			okBytes !== null && okBytes.equals(okExpected),
			okBytes === null ? "missing" : `${okBytes.length}B`,
		);
		assertions.check(
			"failure path kept the write fact: thenrun-fail.txt exists with the exact intended bytes despite the failed verification",
			failBytes !== null && failBytes.equals(failExpected),
			failBytes === null ? "missing" : `${failBytes.length}B`,
		);

		// The combined results reached the model (rollout REQUEST messages —
		// requestOnly (m4) so a response-side echo can never satisfy this).
		const rollout = await findRollout(sc, run1.sessionId);
		const successMarkerSeen = rollout !== null && (await rolloutFindString(rollout, "[then_run:succeeded]", { requestOnly: true })) !== null;
		const failureMarkerSeen = rollout !== null && (await rolloutFindString(rollout, "[then_run:failed]", { requestOnly: true })) !== null;
		const failureNoteSeen = rollout !== null && (await rolloutFindString(rollout, "the file mutation above was applied", { requestOnly: true })) !== null;
		notes.rollout = rollout;
		notes.successMarkerSeen = successMarkerSeen;
		notes.failureMarkerSeen = failureMarkerSeen;
		notes.failureNoteSeen = failureNoteSeen;
		assertions.check("success marker [then_run:succeeded] reached the model in the fused sol_write result", successMarkerSeen, `rollout=${rollout ?? "missing"}`);
		assertions.check("failure marker [then_run:failed] reached the model in the fused sol_write result", failureMarkerSeen, `rollout=${rollout ?? "missing"}`);
		assertions.check("failure note (mutation applied; only the command failed) reached the model", failureNoteSeen, `rollout=${rollout ?? "missing"}`);

		// The model read the combined results (its own report).
		const answer = run1.response ?? "";
		const okBytesMatch = answer.match(/OK_BYTES=(\d+)/);
		assertions.check(
			"model reported the verification byte count from the fused result (OK_BYTES=17)",
			okBytesMatch !== null && Number(okBytesMatch[1]) === okExpected.length,
			(answer.split("\n").find((l) => l.startsWith("OK_BYTES")) ?? "(missing)"),
		);
		assertions.check("model reported the exact failure marker (FAIL_MARKER=[then_run:failed])", /FAIL_MARKER=\[then_run:failed\]/.test(answer), (answer.split("\n").find((l) => l.startsWith("FAIL_MARKER")) ?? "(missing)"));
		assertions.check("model acknowledged the preserved write fact (FAIL_NOTE=yes)", /FAIL_NOTE=yes/i.test(answer), (answer.split("\n").find((l) => l.startsWith("FAIL_NOTE")) ?? "(missing)"));

		// Ledger events: both fused results recorded as delivered ("full" — the
		// fused texts are below the 10 KiB packing threshold, so the observation
		// ledger journals exactly what the model received).
		const observationLedger = await readJsonl(ledgerPath(sc, run1.sessionId, "observation.jsonl"));
		const fullEvents = (observationLedger ?? []).filter((entry) => entry.event === "full" && entry.tool === "sol_write");
		notes.observationEvents = (observationLedger ?? []).map((entry) => ({ event: entry.event, tool: entry.tool, bytes: entry.bytes }));
		assertions.check(
			'observation ledger recorded both fused sol_write results (2x event "full")',
			fullEvents.length >= 2,
			`events=${JSON.stringify(notes.observationEvents)}`,
		);

		// Trajectory: sol_write calls present, and the REAL session trajectory
		// is metadata-only (DESIGN §2.5 / §6.3 — whitelist on real data).
		const trajectory = run1.sessionId ? await readTrajectory(sc, run1.sessionId) : null;
		const counts = toolEventCounts(trajectory);
		notes.toolCounts = counts;
		assertions.check("trajectory recorded both sol_write calls", (counts.sol_write ?? 0) >= 2, JSON.stringify(counts));
		const offending = [];
		for (const record of trajectory ?? []) {
			for (const key of Object.keys(record)) {
				if (!TRAJECTORY_WHITELIST.has(key)) offending.push(key);
			}
		}
		assertions.check(
			"real-session trajectory lines carry whitelisted metadata fields only (no prompt/args/output content)",
			(trajectory ?? []).length > 0 && offending.length === 0,
			`lines=${(trajectory ?? []).length} offending=${[...new Set(offending)].join(",")}`,
		);
		// Belt and braces: the seeded contents never appear in the trajectory file.
		const trajectoryRaw = await readFile(trajectoryPath(sc, run1.sessionId), "utf8").catch(() => "");
		assertions.check(
			"trajectory file does not contain the written content or the then_run command text",
			!trajectoryRaw.includes("beta") && !trajectoryRaw.includes("NEVER-PRESENT-TOKEN"),
			`bytes=${trajectoryRaw.length}`,
		);

		await recordResult(id, {
			status: assertions.ok ? "pass" : "fail",
			title,
			sessionIds,
			usages,
			reducerCalls: 0,
			assertions: assertions.list,
			notes,
		});
		return { status: assertions.ok ? "pass" : "fail", assertions: assertions.list, notes };
	} finally {
		await cleanupScenario(sc);
	}
}
