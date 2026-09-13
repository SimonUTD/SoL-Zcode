/*
 * S3 — G9 recheck: does UserPromptSubmit additionalContext reach the model?
 *
 * GOTCHAS G9 records an unresolved contradiction: one live test had the model
 * say it did NOT see the injected context, while decompilation found
 * injectHookAdditionalContextIntoMessageHistory(on.UserPromptSubmit, …) as a
 * real injection point. P2 must recheck and report a corrected conclusion.
 *
 * Method (dual evidence):
 *   - a fixture probe plugin (tests/e2e, not sol-zcode) returns
 *     additionalContext containing a unique marker on UserPromptSubmit;
 *   - evidence A: the marker's VALUE appears in the session transcript (the
 *     exact message history the model saw; captured by the probe's Stop hook,
 *     since rollout request bodies carry no `messages` under the default
 *     modelIoFullRetentionEnabled=false — P2 finding);
 *   - evidence B: the model echoes the exact marker value in its reply (the
 *     prompt only describes the marker's FORMAT, never the value, so a correct
 *     echo is only possible if the value actually reached the context).
 * Also records the real Stop/UserPromptSubmit payload field inventory for the
 * other scenarios (contextWindow presence etc.).
 */
import { randomBytes } from "node:crypto";
import {
	cleanupScenario,
	findRollout,
	makeAssertions,
	makeScenario,
	probeEvents,
	readTranscriptCopies,
	recordResult,
	rolloutText,
	runPrompt,
} from "../lib/harness.mjs";

export const id = "s3-g9-userprompt";
export const title = "G9 recheck: UserPromptSubmit additionalContext reachability";

export async function run({ deadline } = {}) {
	const marker = `G9MARK-${randomBytes(4).toString("hex")}`;
	const assertions = makeAssertions();
	const sessionIds = [];
	const usages = [];
	const notes = { marker, promptContainsValue: false };

	const sc = await makeScenario(id, { options: {}, probeMarker: marker });
	try {
		const prompt = [
			"A secret marker may or may not have been injected into your context by a hook before this message.",
			"Its format is: the literal string \"G9MARK-\" followed by 8 lowercase hex characters.",
			"",
			"Scan your entire visible context — including any bracketed notices, system-like injections, or appended context blocks — and reply on the FIRST line with exactly one of:",
			"MARKER: <the full marker string you can see>",
			"or",
			"MARKER: NOT-FOUND",
			"Nothing else on the first line.",
		].join("\n");
		notes.promptContainsValue = prompt.includes(marker); // must stay false
		assertions.check("prompt never spells the marker value (no false positive)", notes.promptContainsValue === false);

		const run1 = await runPrompt(sc, prompt, { label: "g9-probe", timeoutMs: 240_000 });
		sessionIds.push(run1.sessionId);
		if (run1.usage) usages.push(run1.usage);
		assertions.check("headless session completed (exit 0)", run1.code === 0, `code=${run1.code} signal=${run1.signal}`);
		assertions.check("usage captured", run1.usage !== null, JSON.stringify(run1.usage));

		// Probe-side: the hook fired and returned the additionalContext envelope.
		const events = await probeEvents(sc);
		const ups = events.filter((entry) => entry.event === "UserPromptSubmit");
		assertions.check("UserPromptSubmit hook fired in headless", ups.length >= 1, `events=${ups.length}`);

		// Evidence A: marker value in the model REQUEST (rollout request body).
		// NOTE (P2 finding): under modelIoFullRetentionEnabled=false the rollout
		// records request.system + request.tools but not request.messages, and the
		// Stop-time transcript_path carries ONLY the last assistant message — so
		// the transcript can only ever prove the marker via the model's own echo.
		// The rollout location of the marker is therefore the independent
		// request-side evidence and is located field-by-field below.
		const copies = await readTranscriptCopies(sc);
		const lastTranscript = copies.at(-1)?.text ?? "";
		const transcriptEchoOnly = lastTranscript.includes(marker);
		notes.transcriptStructure = { copies: copies.length, bytes: lastTranscript.length, head: lastTranscript.slice(0, 200) };

		const rollout = await findRollout(sc, run1.sessionId);
		const rText = await rolloutText(rollout);
		const rolloutHit = rText !== null && rText.includes(marker);
		notes.rolloutAvailable = rText !== null;
		notes.rolloutHit = rolloutHit;
		let rolloutLocations = [];
		if (rolloutHit) {
			for (const line of rText.split("\n")) {
				if (!line.includes(marker)) continue;
				try {
					const parsed = JSON.parse(line);
					const walk = (value, path) => {
						if (typeof value === "string" && value.includes(marker)) rolloutLocations.push(path);
						else if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`));
						else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
					};
					walk(parsed, "$");
				} catch {
					rolloutLocations.push("(unparsable-line)");
				}
			}
		}
		notes.rolloutLocations = [...new Set(rolloutLocations)].slice(0, 10);
		const rolloutRequestSide = notes.rolloutLocations.some((loc) => loc.startsWith("$.request"));

		// Evidence B: the model echoes the exact value.
		const answer = run1.response ?? "";
		const match = answer.match(/MARKER:\s*(G9MARK-[0-9a-f]{8}|NOT-FOUND)/i);
		assertions.check("model answered in the requested format", match !== null, `first-line=${answer.split("\n")[0] ?? ""}`);
		const echoed = match !== null && match[1].toLowerCase() === marker.toLowerCase();
		const notFound = match !== null && match[1].toUpperCase() === "NOT-FOUND";
		notes.modelEcho = echoed;
		notes.modelNotFound = notFound;

		let verdict;
		if (rolloutRequestSide && echoed) verdict = "REACHES-MODEL (marker located in rollout request body + exact value echoed)";
		else if (rolloutHit && echoed) verdict = "REACHES-MODEL (rollout contains marker + exact value echoed)";
		else if (echoed) verdict = "REACHES-MODEL (echo only — request-side record unavailable)";
		else if (transcriptEchoOnly && !echoed) verdict = "INJECTED-BUT-UNREPORTED";
		else verdict = "DOES-NOT-REACH-MODEL (no request-side trace + NOT-FOUND)";
		notes.verdict = verdict;
		notes.transcriptEchoOnly = transcriptEchoOnly;
		assertions.check("G9 verdict determined (request-side + echo evidence recorded)", typeof verdict === "string", verdict);

		// Payload field inventory for the other scenarios (S5 especially).
		const stopEvents = events.filter((entry) => entry.event === "Stop");
		const stopPayload = stopEvents.at(-1)?.payload ?? null;
		notes.stopPayloadKeys = stopPayload ? Object.keys(stopPayload).sort() : [];
		notes.stopPayloadHasContextWindow = stopPayload ? "contextWindow" in stopPayload || "context_window" in stopPayload : false;
		notes.stopPayloadStopHookActive = stopPayload ? stopPayload.stop_hook_active ?? stopPayload.stopHookActive ?? null : null;
		notes.sessionStartSources = events
			.filter((entry) => entry.event === "SessionStart")
			.map((entry) => entry.payload?.source ?? null);
		notes.stopCountPerHeadlessRun = stopEvents.length;
		assertions.check(
			"Stop payload inventory captured",
			notes.stopPayloadKeys.length > 0,
			`keys=${notes.stopPayloadKeys.join(",")}`,
		);
		notes.answerHead = (run1.response ?? "").split("\n").slice(0, 3).join(" | ");
		notes.projection = run1.projection;

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
