/*
 * S6 — All-off zero behavior with a REAL headless session (C2 at the e2e
 * level): plugin installed but plugins.options = '{}' .
 *
 * Asserted:
 *   - zero files appear under the plugin data root (before/after snapshot);
 *   - no sol tool is registered: rollout request tools list carries no
 *     mcp__plugin_sol* / sol_* entry, and the model's own introspection
 *     reports NO-SOL-TOOLS;
 *   - the session itself completes normally (exit 0) with usage captured.
 */
import { join } from "node:path";
import {
	cleanupScenario,
	findRollout,
	listFilesRecursive,
	makeAssertions,
	makeScenario,
	recordResult,
	rolloutToolNames,
	runPrompt,
} from "../lib/harness.mjs";

export const id = "s6-alloff-zero";
export const title = "all-off ({}): real headless session with zero plugin files and no sol tools";

const PROMPT = [
	"Inspect the tools currently available to you in this session.",
	'List every tool whose name contains the case-insensitive substring "sol" OR whose name starts with "mcp__plugin".',
	"If there are no such tools, reply with exactly: NO-SOL-TOOLS",
	"Otherwise reply with one tool name per line and nothing else.",
].join("\n");

export async function run({ deadline } = {}) {
	const assertions = makeAssertions();
	const sessionIds = [];
	const usages = [];
	const notes = {};
	// probe deliberately NOT installed here: the scenario asserts sol-zcode's
	// own zero behavior in the cleanest possible environment.
	const sc = await makeScenario(id, { options: {}, probeMarker: false });
	try {
		const dataParent = join(sc.home, ".zcode", "cli", "plugins", "data");
		const before = await listFilesRecursive(dataParent);

		const run1 = await runPrompt(sc, PROMPT, { label: "alloff-zero", timeoutMs: 240_000 });
		sessionIds.push(run1.sessionId);
		if (run1.usage) usages.push(run1.usage);
		assertions.check("session completed (exit 0)", run1.code === 0, `code=${run1.code} signal=${run1.signal}`);
		assertions.check("usage captured", run1.usage !== null, JSON.stringify(run1.usage));

		const after = await listFilesRecursive(dataParent);
		notes.dataRootFilesBefore = before;
		notes.dataRootFilesAfter = after;
		assertions.check(
			"zero new files under the plugin data root (strict zero behavior)",
			before.length === 0 && after.length === 0,
			`before=${before.length} after=${after.length}${after.length > 0 ? ` files=${after.join(",")}` : ""}`,
		);

		// No sol tools in the request tool list (rollout evidence).
		const rollout = await findRollout(sc, run1.sessionId);
		const toolNames = await rolloutToolNames(rollout);
		notes.rolloutAvailable = toolNames !== null;
		notes.rolloutToolCount = toolNames?.length ?? null;
		if (toolNames !== null) {
			const solTools = toolNames.filter((name) => name.startsWith("mcp__plugin_sol") || /(^|_)sol_(bash|write|edit|recall|trajectory)$/.test(name) || name.includes("__sol_"));
			notes.solToolsInRollout = solTools;
			assertions.check("rollout tools list contains no sol_zcode tool", solTools.length === 0, `found=${solTools.join(",")}`);
		} else {
			assertions.check("rollout tools list contains no sol_zcode tool", false, "rollout unavailable (retention) — introspection evidence only");
		}

		// Model introspection evidence.
		const answer = (run1.response ?? "").trim();
		notes.response = answer.slice(0, 300);
		assertions.check("model introspection reports NO-SOL-TOOLS", /NO-SOL-TOOLS/i.test(answer), answer.slice(0, 120));

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
