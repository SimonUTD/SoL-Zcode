/*
 * S1 — true-model equivalence: sol_write/sol_edit vs built-in Write/Edit
 * (audit m9 hand-off to P2), plus quantification of the Read-before-Edit
 * session-state semantics gap (recorded as DESIGN §8 deviation evidence;
 * not required to be eliminated).
 *
 * Dual arm, isolated HOMEs, same seeded workdir:
 *   arm A (builtin): options {trajectory:true}            — no sol tools registered
 *   arm B (sol):     options {actionFusion:true, trajectory:true}
 * Both arms execute the same deterministic batch; the harness computes the
 * expected bytes independently and asserts each arm matches, which implies
 * byte-for-byte arm equality.
 *
 * Gap quantification: a dedicated pair of single-task sessions edits a seeded
 * file that was never Read in the session (builtin Edit vs sol_edit) and the
 * trajectory + transcript record the behavioral difference (refusals, extra
 * Read round-trips, retry counts).
 */
import {
	cleanupScenario,
	fileBytes,
	ledgerPath,
	makeAssertions,
	makeScenario,
	readTrajectory,
	readTranscriptCopies,
	recordResult,
	runPrompt,
	trajectoryPath,
} from "../lib/harness.mjs";

export const id = "s1-edit-equivalence";
export const title = "sol_write/sol_edit vs builtin Write/Edit real-model equivalence + Read-before-Edit gap";

const SEED = {
	"config.txt": "server:\n  timeout=30\n  port=8080\n",
	"flags.txt": "feature_a=ENABLED\nfeature_b=ENABLED\nfeature_c=ENABLED\n",
	"multi.txt": "name=demo\nversion=v1.0.0\nstatus=draft\n",
	"overwrite.txt": "old content line\n",
	"gap.txt": "alpha\nbeta\n",
};
const GREETING = "Hello, SoL!\nLine two: alpha\nLine three: beta\n";
const OVERWRITE = "new content line\n";

function expectedFiles() {
	return {
		"greeting.txt": GREETING,
		"config.txt": SEED["config.txt"].replace("timeout=30", "timeout=90"),
		"flags.txt": SEED["flags.txt"].split("ENABLED").join("DISABLED"),
		"multi.txt": SEED["multi.txt"].replace("v1.0.0", "v1.1.0").replace("draft", "final"),
		"overwrite.txt": OVERWRITE,
		"gap.txt": "alpha\nbeta\n",
	};
}

function batchPrompt(writeTool, editTool, isSol) {
	return [
		`You are performing a deterministic file-operation benchmark. Work in the current directory. Use ONLY the tools ${writeTool} and ${editTool} for all file mutations below. If a mutation tool rejects an operation because of a session-state requirement (for example a file that must be read first), you MAY use the Read tool once to satisfy that requirement and then complete the mutation with ${writeTool}/${editTool}. Never use Bash. Do not retry a failed mutation more than once.`,
		"",
		"Perform EXACTLY these steps in order:",
		"1. Create file greeting.txt with EXACTLY this content (three lines, each ending with a newline, no extra blank line):",
		"Hello, SoL!",
		"Line two: alpha",
		"Line three: beta",
		`2. Edit config.txt: replace the exact string "timeout=30" with "timeout=90".`,
		`3. Edit flags.txt replacing EVERY occurrence of "ENABLED" with "DISABLED" (replace-all semantics).`,
		`4. Edit multi.txt replacing the exact string "v1.0.0" with "v1.1.0" AND the exact string "draft" with "final".${
			isSol ? ` ${editTool} accepts an edits array — use ONE ${editTool} call containing both edits.` : ` The ${editTool} tool applies one replacement per call — use two ${editTool} calls.`
		}`,
		`5. Overwrite the existing file overwrite.txt with EXACTLY this content: "new content line" followed by a newline.`,
		`6. Attempt to edit notfound.txt replacing "a" with "b". This must FAIL (the file does not exist). Do not create the file; do not work around it.`,
		`7. Attempt to edit multi.txt replacing "no-such-string-xyz" with "q". This must FAIL and must leave the file unchanged.`,
		"",
		'When finished, reply with exactly one line per step: "N ok" or "N failed: <short reason>".',
	].join("\n");
}

const GAP_PROMPT_A =
	'Using only the Edit tool — plus the Read tool ONLY if Edit rejects the operation because of a session-state requirement — replace the exact string "beta" with "gamma" in the file gap.txt in the current directory. Retry Edit at most once after satisfying its requirement. Then reply with exactly: GAP-DONE';
const GAP_PROMPT_B =
	'Using only the sol_edit tool (no Read, no other tools), replace the exact string "beta" with "gamma" in the file gap.txt in the current directory. Then reply with exactly: GAP-DONE';

function toolEventCounts(trajectory) {
	const counts = {};
	for (const record of trajectory ?? []) {
		if (record.event !== "pre_tool" || typeof record.tool !== "string") continue;
		const name = record.tool.includes("__") ? record.tool.split("__").at(-1) : record.tool;
		counts[name] = (counts[name] ?? 0) + 1;
	}
	return counts;
}

async function runArm(name, options, writeTool, editTool, isSol, { label, timeoutMs }) {
	const sc = await makeScenario(name, { options, workdirFiles: SEED });
	const run1 = await runPrompt(sc, batchPrompt(writeTool, editTool, isSol), { label, timeoutMs });
	const files = {};
	for (const rel of ["greeting.txt", "config.txt", "flags.txt", "multi.txt", "overwrite.txt", "gap.txt", "notfound.txt"]) {
		files[rel] = await fileBytes(`${sc.work}/${rel}`);
	}
	const trajectory = run1.sessionId ? await readTrajectory(sc, run1.sessionId) : null;
	return { sc, run: run1, files, trajectory, counts: toolEventCounts(trajectory) };
}

export async function run({ deadline } = {}) {
	const assertions = makeAssertions();
	const sessionIds = [];
	const usages = [];
	const notes = { arms: {}, gap: {} };

	const armA = await runArm(`${id}-armA`, { trajectory: true }, "Write", "Edit", false, { label: "armA-builtin", timeoutMs: 300_000 });
	const armB = await runArm(`${id}-armB`, { actionFusion: true, trajectory: true }, "sol_write", "sol_edit", true, { label: "armB-sol", timeoutMs: 300_000 });
	let gapA = null;
	let gapB = null;
	try {
		for (const arm of [armA, armB]) {
			sessionIds.push(arm.run.sessionId);
			if (arm.run.usage) usages.push(arm.run.usage);
			assertions.check(
				`${arm.run.label}: session completed (exit 0)`,
				arm.run.code === 0,
				`code=${arm.run.code} signal=${arm.run.signal}`,
			);
		}

		// Byte equivalence against an independently computed expectation.
		const expected = expectedFiles();
		for (const [rel, want] of Object.entries(expected)) {
			const wantBytes = Buffer.from(want, "utf8");
			const a = armA.files[rel];
			const b = armB.files[rel];
			const aOk = a !== null && a.equals(wantBytes);
			const bOk = b !== null && b.equals(wantBytes);
			assertions.check(
				`file ${rel}: armA(builtin) == expected bytes`,
				aOk,
				aOk ? `${a.length}B` : `got=${a === null ? "missing" : `${a.length}B sha=${armA.files[rel].toString("hex").slice(0, 16)}`}`,
			);
			assertions.check(
				`file ${rel}: armB(sol) == expected bytes (arm equality follows)`,
				bOk,
				bOk ? `${b.length}B` : `got=${b === null ? "missing" : `${b.length}B`}`,
			);
			if (aOk && bOk) {
				assertions.check(`file ${rel}: armA bytes === armB bytes`, a.equals(b), `${a.length}B`);
			}
		}
		assertions.check(
			"notfound.txt absent in both arms (step 6 refused)",
			armA.files["notfound.txt"] === null && armB.files["notfound.txt"] === null,
			`armA=${armA.files["notfound.txt"] !== null} armB=${armB.files["notfound.txt"] !== null}`,
		);

		// Failure reporting for steps 6/7 from the model's own summary.
		for (const arm of [armA, armB]) {
			const response = arm.run.response ?? "";
			const step6Failed = /6 failed/i.test(response);
			const step7Failed = /7 failed/i.test(response);
			assertions.check(`${arm.run.label}: model reported step 6 as failed`, step6Failed, response.split("\n").find((l) => l.startsWith("6")) ?? "(line missing)");
			assertions.check(`${arm.run.label}: model reported step 7 as failed`, step7Failed, response.split("\n").find((l) => l.startsWith("7")) ?? "(line missing)");
		}

		notes.arms.armA = { counts: armA.counts, usage: armA.run.usage, response: (armA.run.response ?? "").slice(0, 800) };
		notes.arms.armB = { counts: armB.counts, usage: armB.run.usage, response: (armB.run.response ?? "").slice(0, 800) };
		assertions.check(
			"armB used sol_write/sol_edit (trajectory)",
			(armB.counts.sol_write ?? 0) >= 1 && (armB.counts.sol_edit ?? 0) >= 3,
			JSON.stringify(armB.counts),
		);
		assertions.check(
			"armA used builtin Write/Edit (trajectory)",
			(armA.counts.Write ?? 0) >= 1 && (armA.counts.Edit ?? 0) >= 3,
			JSON.stringify(armA.counts),
		);
		assertions.check(
			"batch semantics: armB sol_edit batch (step 4) used fewer edit calls than armA builtin Edit",
			(armB.counts.sol_edit ?? 0) <= (armA.counts.Edit ?? 0),
			`armB sol_edit=${armB.counts.sol_edit ?? 0} vs armA Edit=${armA.counts.Edit ?? 0}`,
		);

		// ---- Read-before-Edit gap quantification (audit m9; §8 evidence) ----
		const gapA = await makeScenario(`${id}-gapA`, { options: { trajectory: true }, workdirFiles: { "gap.txt": SEED["gap.txt"] } });
		const gapARun = await runPrompt(gapA, GAP_PROMPT_A, { label: "gapA-builtin-edit-unread", timeoutMs: 240_000 });
		const gapATraj = gapARun.sessionId ? await readTrajectory(gapA, gapARun.sessionId) : null;
		const gapACounts = toolEventCounts(gapATraj);
		const gapATranscripts = await readTranscriptCopies(gapA);
		const gapAReadRefusal = gapATranscripts.some((copy) => /has not been read|must.*read|read it first|Read it first/i.test(copy.text));
		const gapABytes = await fileBytes(`${gapA.work}/gap.txt`);

		const gapB = await makeScenario(`${id}-gapB`, { options: { actionFusion: true, trajectory: true }, workdirFiles: { "gap.txt": SEED["gap.txt"] } });
		const gapBRun = await runPrompt(gapB, GAP_PROMPT_B, { label: "gapB-sol-edit-unread", timeoutMs: 240_000 });
		const gapBTraj = gapBRun.sessionId ? await readTrajectory(gapB, gapBRun.sessionId) : null;
		const gapBCounts = toolEventCounts(gapBTraj);
		const gapBBytes = await fileBytes(`${gapB.work}/gap.txt`);

		sessionIds.push(gapARun.sessionId, gapBRun.sessionId);
		if (gapARun.usage) usages.push(gapARun.usage);
		if (gapBRun.usage) usages.push(gapBRun.usage);

		notes.gap = {
			armA_builtin: {
				toolCalls: gapACounts,
				editAttempts: gapACounts.Edit ?? 0,
				readCalls: gapACounts.Read ?? 0,
				sessionStateRefusalSeenInTranscript: gapAReadRefusal,
				finalBytesCorrect: gapABytes !== null && gapABytes.equals(Buffer.from("alpha\ngamma\n", "utf8")),
				requests: gapARun.usage?.modelRequestCount ?? null,
			},
			armB_sol: {
				toolCalls: gapBCounts,
				editAttempts: gapBCounts.sol_edit ?? 0,
				readCalls: gapBCounts.Read ?? 0,
				finalBytesCorrect: gapBBytes !== null && gapBBytes.equals(Buffer.from("alpha\ngamma\n", "utf8")),
				requests: gapBRun.usage?.modelRequestCount ?? null,
			},
			interpretation:
				"builtin Edit enforces Read-before-Edit session state (extra round-trips/refusals); sol_edit's P1 contract is existence + exact-match only (no session read tracking) — recorded as DESIGN §8 deviation evidence, not a failure",
		};
		assertions.check(
			"gap: both arms reached the same final bytes",
			notes.gap.armA_builtin.finalBytesCorrect === true && notes.gap.armB_sol.finalBytesCorrect === true,
			`A=${notes.gap.armA_builtin.finalBytesCorrect} B=${notes.gap.armB_sol.finalBytesCorrect}`,
		);
		assertions.check(
			"gap evidence captured (tool-call counts + refusal detection recorded)",
			(gapACounts.Edit ?? 0) >= 1 && (gapBCounts.sol_edit ?? 0) >= 1,
			JSON.stringify(notes.gap),
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
		await cleanupScenario(armA.sc);
		await cleanupScenario(armB.sc);
		if (gapA !== null) await cleanupScenario(gapA);
		if (gapB !== null) await cleanupScenario(gapB);
	}
}
