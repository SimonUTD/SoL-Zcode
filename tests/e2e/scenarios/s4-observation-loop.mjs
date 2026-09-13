/*
 * S4 — Observation pack full loop (real model):
 *   sol_bash produces >10 KiB output -> model receives a placeholder
 *   (obs_id + head/tail excerpts) -> model pages the original back with
 *   obs_recall (>=2 pages, following next_offset until eof) -> the harness
 *   reads the archived object itself and checks the model-assembled pages,
 *   concatenated in order, are byte-for-byte equal to the original.
 *
 * Payload design: 70 lines x exactly 256 bytes each (17920 B total) so the
 * 16 KiB recall cap splits the object at a clean line boundary (64 + 6 lines)
 * and every page boundary is unambiguous for byte comparison.
 */
import {
	cleanupScenario,
	fileBytes,
	findRollout,
	ledgerPath,
	makeAssertions,
	makeScenario,
	readJsonl,
	readTranscriptCopies,
	recordResult,
	rolloutText,
	runPrompt,
} from "../lib/harness.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const id = "s4-observation-loop";
export const title = "observation pack: placeholder -> obs_recall paging -> byte-exact reassembly";

const AWK_COMMAND = `awk 'BEGIN{for(i=1;i<=70;i++){line="";for(j=0;j<250;j++)line=line "x";printf "L%03d:%s\\n", i, line}}'`;

const PROMPT = [
	"Use the sol_bash tool to run EXACTLY this command (copy it verbatim, including the quotes):",
	AWK_COMMAND,
	"",
	"The result will exceed 10 KiB, so it will be replaced by a compact placeholder containing an observation id (obs_...) and head/tail excerpts.",
	"",
	"Then page through the ENTIRE original output with the obs_recall tool: first call {\"id\":\"<the id>\",\"offset\":0}, then keep calling obs_recall with the next_offset value from each page footer until a page reports eof=true. There will be at least 2 pages.",
	"",
	"For EACH page, write its content — everything BEFORE the final footer line that starts with \"[next_offset=\" — VERBATIM (byte for byte: keep partial content exactly as returned, do not add, remove, trim or fix anything, do not append a newline unless the page itself ends with one) into a separate file in the current directory using the Write tool: page1.txt for the first page, page2.txt for the second, page3.txt for a third if it exists.",
	"",
	"Finally reply with exactly: PAGES=<number of pages> LASTID=<the observation id>",
].join("\n");

export async function run({ deadline } = {}) {
	const assertions = makeAssertions();
	const sessionIds = [];
	const usages = [];
	const notes = { attempts: [] };
	let sc = null;
	let run1 = null;
	let okReassembly = false;

	for (let attemptNo = 1; attemptNo <= 2 && !okReassembly; attemptNo += 1) {
		if (attemptNo === 2) {
			notes.retryReason = "first attempt did not produce a byte-exact reassembly; retrying with the same deterministic prompt";
		}
		const attemptSc = await makeScenario(`${id}-try${attemptNo}`, { options: { observationPack: true } });
		if (sc !== null) await cleanupScenario(sc);
		sc = attemptSc;
		run1 = await runPrompt(sc, PROMPT, { label: `obs-loop-${attemptNo}`, timeoutMs: 360_000 });
		sessionIds.push(run1.sessionId);
		if (run1.usage) usages.push(run1.usage);
		const attemptNotes = { code: run1.code, response: (run1.response ?? "").slice(0, 300) };

		assertions.check(`attempt ${attemptNo}: session completed (exit 0)`, run1.code === 0, `code=${run1.code}`);
		const ledger = run1.sessionId ? await readJsonl(ledgerPath(sc, run1.sessionId, "observation.jsonl")) : null;
		const placeholderEvents = (ledger ?? []).filter((entry) => entry.event === "placeholder");
		const recallEvents = (ledger ?? []).filter((entry) => entry.event === "recall");
		attemptNotes.ledgerEvents = (ledger ?? []).map((entry) => entry.event);

		if (placeholderEvents.length < 1) {
			attemptNotes.error = "no placeholder event in observation ledger";
			notes.attempts.push(attemptNotes);
			continue;
		}
		const obsId = placeholderEvents[0].id;
		const objectPath = join(sc.dataRoot, "store", "observation-pack", "objects", `${obsId}.txt`);
		const objectBytes = await fileBytes(objectPath);
		assertions.check(`attempt ${attemptNo}: archived object exists (id=${obsId})`, objectBytes !== null, objectPath);
		attemptNotes.obsId = obsId;
		attemptNotes.objectBytes = objectBytes?.length ?? null;
		assertions.check(
			`attempt ${attemptNo}: object is >10 KiB (17920 B expected)`,
			objectBytes !== null && objectBytes.length === 17920,
			`bytes=${objectBytes?.length ?? "missing"}`,
		);

		// Placeholder reached the model (transcript evidence).
		const transcripts = await readTranscriptCopies(sc);
		const lastTranscript = transcripts.at(-1)?.text ?? "";
		const transcriptHit = lastTranscript.includes(`id: ${obsId}`) && lastTranscript.includes("[middle omitted");
		const rolloutHit = (await rolloutText(await findRollout(sc, run1.sessionId)))?.includes(`id: ${obsId}`) ?? false;
		const modelQuotedId = (run1.response ?? "").includes(obsId);
		attemptNotes.transcriptDiagnostics = {
			transcriptCopies: transcripts.length,
			transcriptBytes: lastTranscript.length,
			transcriptHasObsId: lastTranscript.includes(obsId),
			transcriptHasMiddleOmitted: lastTranscript.includes("[middle omitted"),
			transcriptHasSolBash: lastTranscript.includes("sol_bash"),
			transcriptHasLargeToolResult: lastTranscript.includes("large tool result replaced"),
			rolloutHit,
			modelQuotedId,
			transcriptHead: lastTranscript.slice(0, 400),
		};
		const placeholderSeen = transcriptHit || rolloutHit;
		attemptNotes.placeholderSeenByModel = placeholderSeen;
		assertions.check(
			`attempt ${attemptNo}: placeholder with id + head/tail excerpt reached the model`,
			placeholderSeen,
			JSON.stringify(attemptNotes.transcriptDiagnostics).slice(0, 500),
		);

		// Recall paging ledger: >=2 pages, offsets strictly increasing, final eof=true.
		const offsets = recallEvents.map((entry) => entry.offset);
		const eofLast = recallEvents.at(-1)?.eof === true;
		attemptNotes.recallOffsets = offsets;
		assertions.check(
			`attempt ${attemptNo}: >=2 obs_recall pages with increasing offsets and final eof=true`,
			recallEvents.length >= 2 && offsets.every((v, i) => i === 0 || v > offsets[i - 1]) && eofLast,
			`offsets=${JSON.stringify(offsets)} eofLast=${recallEvents.at(-1)?.eof}`,
		);

		// Byte-exact reassembly against the archived original.
		const pages = [];
		for (let p = 1; p <= recallEvents.length; p += 1) {
			const bytes = await fileBytes(join(sc.work, `page${p}.txt`));
			pages.push(bytes);
		}
		attemptNotes.pageFileBytes = pages.map((buffer) => (buffer === null ? null : buffer.length));
		if (pages.some((buffer) => buffer === null)) {
			attemptNotes.error = "one or more pageN.txt files missing";
			notes.attempts.push(attemptNotes);
			continue;
		}
		const reassembled = Buffer.concat(pages);
		okReassembly = reassembled.equals(objectBytes);
		attemptNotes.reassembledBytes = reassembled.length;
		attemptNotes.byteEqual = okReassembly;
		if (!okReassembly) {
			let firstDiff = -1;
			for (let i = 0; i < Math.min(reassembled.length, objectBytes.length); i += 1) {
				if (reassembled[i] !== objectBytes[i]) {
					firstDiff = i;
					break;
				}
			}
			attemptNotes.firstDiffByte = firstDiff;
		}
		assertions.check(
			`attempt ${attemptNo}: concatenated model pages are byte-for-byte equal to the archived original`,
			okReassembly,
			okReassembly ? `${reassembled.length}B` : `reassembled=${reassembled.length}B vs object=${objectBytes.length}B firstDiff=${attemptNotes.firstDiffByte}`,
		);

		const answer = run1.response ?? "";
		const pagesMatch = answer.includes(`PAGES=${recallEvents.length}`) && answer.includes(obsId);
		assertions.check(`attempt ${attemptNo}: model reply reports the page count and obs id`, pagesMatch, (answer.split("\n")[0] ?? "").slice(0, 120));
		notes.attempts.push(attemptNotes);
	}

	try {
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
		if (sc !== null) await cleanupScenario(sc);
	}
}
