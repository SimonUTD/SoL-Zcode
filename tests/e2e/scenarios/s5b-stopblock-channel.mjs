/*
 * S5B — Stop-block delivery channel proof (G17), real host + real model.
 *
 * History: S5 v4 established (honest negative, see the recorded v4 result)
 * that the transcript-based OCC estimator could not fire in real zcode 0.16.5
 * headless sessions. The P2.5 fix (G21 cumulative estimator) closed that gap —
 * S5 v5 now triggers the economic block end-to-end in a real session — so this
 * scenario's role is deliberately narrower and orthogonal to the estimator: it
 * proves the CHANNEL itself in isolation, with the probe plugin (fixture, not
 * sol-zcode) emitting the block, so channel failures can never be conflated
 * with estimator behavior.
 *
 * What it proves: a Stop hook returning {"decision":"block","reason":...}
 * must (a) make the host CONTINUE the turn, (b) re-run Stop with
 * stop_hook_active=true, and (c) deliver the reason text into the model's
 * request context (the model can only complete its instructed reaction if it
 * received the reason).
 *
 * Method: the e2e probe plugin (fixture, not sol-zcode) emits a one-shot
 * decision:block on the FIRST Stop of a fresh session; the prompt instructs
 * the model to answer DONE initially and, if a continuation message containing
 * the probe reason arrives, answer CHANNEL-OK. Asserted via probe events,
 * rollout request bodies and the final response.
 */
import {
	cleanupScenario,
	findRollout,
	makeAssertions,
	makeScenario,
	probeEvents,
	recordResult,
	rolloutFindString,
	runPrompt,
} from "../lib/harness.mjs";

export const id = "s5b-stopblock-channel";
export const title = "Stop decision:block channel: host continuation + stop_hook_active + reason reaches the model";

const REASON = "[e2e-probe] stop-block channel test: reply with the single word CHANNEL-OK now";

const PROMPT = [
	"Reply with exactly: DONE",
	"",
	"Exception: if at any point you receive a continuation message containing \"[e2e-probe] stop-block channel test\", reply with exactly: CHANNEL-OK",
].join("\n");

export async function run({ deadline } = {}) {
	const assertions = makeAssertions();
	const sessionIds = [];
	const usages = [];
	const notes = {};
	const sc = await makeScenario(id, { options: {}, probeStopBlock: REASON });
	try {
		const run1 = await runPrompt(sc, PROMPT, { label: "stopblock-channel", timeoutMs: 240_000 });
		sessionIds.push(run1.sessionId);
		if (run1.usage) usages.push(run1.usage);
		assertions.check("session completed (exit 0)", run1.code === 0, `code=${run1.code} signal=${run1.signal}`);
		assertions.check("turn was continued (>=2 model requests)", (run1.usage?.modelRequestCount ?? 0) >= 2, `requests=${run1.usage?.modelRequestCount ?? 0}`);

		const events = await probeEvents(sc);
		const stops = events.filter((entry) => entry.event === "Stop");
		const activeStops = stops.filter((entry) => entry.payload?.stop_hook_active === true || entry.payload?.stopHookActive === true);
		notes.stopEvents = stops.length;
		notes.stopHookActiveEvents = activeStops.length;
		assertions.check("Stop hook ran more than once (block -> continuation -> re-run)", stops.length >= 2, `stops=${stops.length}`);
		assertions.check("re-run Stop carried stop_hook_active=true (G17 continuation loop)", activeStops.length >= 1, `active=${activeStops.length}`);

		const rollout = await findRollout(sc, run1.sessionId);
		const reasonInRequest = rollout !== null && (await rolloutFindString(rollout, "[e2e-probe] stop-block channel test")) !== null;
		notes.blockReasonInRequest = reasonInRequest;
		assertions.check("block reason text appears in a subsequent model request body", reasonInRequest === true, `rollout=${rollout ?? "missing"}`);

		const answer = (run1.response ?? "").trim();
		notes.response = answer.slice(0, 200);
		assertions.check("model saw the reason and replied CHANNEL-OK", /CHANNEL-OK/i.test(answer), answer.slice(0, 120));

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
