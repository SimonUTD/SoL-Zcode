/*
 * S7 — fail-open proof under an archive-store failure: the observation-pack
 * objects directory is chmod 000 before the session, so every attempt to
 * archive a >10 KiB sol_bash result fails. The tool must still return the
 * FULL text to the model (no data loss, no crash), and the observation
 * ledger must record the fallback (`event: "full"` with an archive-error
 * reason) instead of a placeholder.
 */
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	cleanupScenario,
	ledgerPath,
	makeAssertions,
	makeScenario,
	readJsonl,
	readTranscriptCopies,
	recordResult,
	runPrompt,
} from "../lib/harness.mjs";

export const id = "s7-failopen";
export const title = "fail-open: archive dir chmod 000 -> sol_bash returns full text, ledger records fallback, no crash";

const PROMPT = [
	"Use the sol_bash tool to run exactly: seq 1 3000",
	"Do not use any other tool. After it returns, reply with exactly three lines:",
	"FIRST=<the first line of the result>",
	"LAST=<the last line of the result>",
	"MIDDLE=<line number 1500 of the result>",
].join("\n");

export async function run({ deadline } = {}) {
	const assertions = makeAssertions();
	const sessionIds = [];
	const usages = [];
	const notes = {};
	const sc = await makeScenario(id, { options: { observationPack: true } });
	let broke = false;
	try {
		// Break the archive store BEFORE the session (scenario-level fault injection).
		const objectsDir = join(sc.dataRoot, "store", "observation-pack", "objects");
		await mkdir(objectsDir, { recursive: true, mode: 0o700 });
		await chmod(objectsDir, 0o000);
		broke = true;

		const run1 = await runPrompt(sc, PROMPT, { label: "failopen-chmod000", timeoutMs: 300_000 });
		sessionIds.push(run1.sessionId);
		if (run1.usage) usages.push(run1.usage);
		assertions.check("session completed normally despite the broken archive store (exit 0)", run1.code === 0, `code=${run1.code} signal=${run1.signal}`);
		notes.response = (run1.response ?? "").slice(0, 300);

		// The FULL text reached the model: middle lines exist only in the full
		// text. Evidence source is the rollout request messages (the Stop-time
		// transcript holds only the last assistant message — S3/S4 P2 finding).
		const { findRollout, rolloutFindString } = await import("../lib/harness.mjs");
		const rollout = await findRollout(sc, run1.sessionId);
		const toolResultText = rollout === null ? null : await rolloutFindString(rollout, "1499\n1500\n1501");
		const fullTextSeen = toolResultText !== null && toolResultText.includes("2999\n3000\n") && toolResultText.includes("1\n2\n3\n");
		const placeholderSeen = rollout !== null && (await rolloutFindString(rollout, "large tool result replaced")) !== null;
		notes.rollout = rollout;
		notes.fullTextSeen = fullTextSeen;
		notes.placeholderSeen = placeholderSeen;
		assertions.check("model received the FULL 12.9 KiB output (middle lines present in a request message)", fullTextSeen, `rollout=${rollout ?? "missing"} resultLen=${toolResultText?.length ?? 0}`);
		assertions.check("no placeholder was produced", placeholderSeen === false);

		// Ledger records the fallback path.
		const ledger = await readJsonl(ledgerPath(sc, run1.sessionId, "observation.jsonl"));
		const events = (ledger ?? []).map((entry) => entry.event);
		notes.ledgerEvents = ledger ?? [];
		const fallback = (ledger ?? []).filter((entry) => entry.event === "full" && typeof entry.fallback === "string" && entry.fallback.includes("archive-error"));
		assertions.check(
			'observation ledger recorded the fallback (event "full" + archive-error reason)',
			fallback.length >= 1,
			`events=${JSON.stringify(events)}`,
		);
		if (fallback.length >= 1) {
			notes.fallbackReason = fallback.at(-1).fallback;
			assertions.check("fallback reason identifies EACCES from the chmod-000 store", /EACCES|permission/i.test(fallback.at(-1).fallback), fallback.at(-1).fallback);
			notes.fallbackBytes = fallback.at(-1).bytes;
		}
		assertions.check("no placeholder event in the ledger", events.includes("placeholder") === false, `events=${JSON.stringify(events)}`);

		// The model could only answer MIDDLE correctly from the full text.
		const answer = run1.response ?? "";
		assertions.check("model answered LAST=3000 from the full output", /LAST=3000/i.test(answer), answer.split("\n")[2] ?? "");

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
		if (broke) {
			await chmod(join(sc.dataRoot, "store", "observation-pack", "objects"), 0o755).catch(() => undefined);
		}
		await cleanupScenario(sc);
	}
}
