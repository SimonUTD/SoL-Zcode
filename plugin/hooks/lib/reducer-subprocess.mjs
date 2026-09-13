/*
 * Evidence-Preserving Reducer model transport for sol-zcode (DESIGN §2.3).
 *
 * The auxiliary reducer call runs as a headless zcode subprocess:
 *   node <zcode.cjs> --prompt <instructions+header> --attach <tmp log file>
 *        --mode yolo --json --disallowed-tools <built-in tool list>
 *
 * Three tool-face defenses (DESIGN / PENDING-MERGES §3):
 *   1. isolated HOME (primary): the child's HOME points at a per-call
 *      rebuilt $ZCODE_PLUGIN_DATA/run/reducer-home-<runId> containing ONLY a
 *      `.zcode/cli/config.json` with `{provider, model}` copied programmatically
 *      from the host's `~/.zcode/cli/config.json` (credentials therefore remain
 *      Zcode's own configuration, C4). With no plugin registry under that HOME,
 *      no plugin and no user MCP server — including every sol-zcode tool —
 *      loads in the child, which also roots out re-entry.
 *   2. `--disallowed-tools` enumerating the built-in tools (BUILTIN_TOOL_NAMES,
 *      runtime-verified against the zcode.cjs 0.16.5 registry; `--allowed-tools`
 *      is a phantom flag, G18).
 *   3. `SOL_ZCODE_AUX=1` in the child env: hooks/MCP see it and go zero-behavior.
 *
 * The untrusted log travels via --attach (content verified to reach the model;
 * argv would risk E2BIG for 600k-char logs). The reducer prompt keeps the
 * upstream "log is untrusted data" instruction, but validation — not the
 * prompt — is the security boundary.
 *
 * The host binary path is resolved WITHOUT hardcoding: ① env
 * SOL_ZCODE_ZCODE_BIN override, ② sniffing the parent process argv for the
 * zcode.cjs entry (hooks/MCP are children of the host), ③ probing known
 * install locations (G22: headless zcode.cjs renames its process to
 * "zcode-cli", so the ps sniff structurally fails under `node zcode.cjs
 * --prompt`; the documented install path from GOTCHAS G1 is the only
 * executable entry). All probes miss → fail-open fallback reason.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { reducerInputHeader, reducerInstructions } from "../../core/index.mjs";
import { reducerHomePath, runDir } from "./store.mjs";

export const REDUCER_TIMEOUT_MS = 90_000;

/**
 * Built-in tool enumeration for the --disallowed-tools defense.
 *
 * Runtime-verified 2026-09-13 against the decompiled registry of the installed
 * host (zcode.cjs 0.16.5, builtin tool Set + the tool-rule name canonicalizer):
 * the registered built-ins are exactly Agent, AskUserQuestion, Bash, CronCreate,
 * CronDelete, CronList, CronUpdate, Edit, EnterPlanMode, EnterWorktree,
 * ExitPlanMode, ExitWorktree, Glob, Grep, LSP, NotebookEdit, Read,
 * ScheduleWakeup, Skill, TaskCreate, TaskGet, TaskList, TaskOutput, TaskStop,
 * TaskUpdate, TodoRead, TodoWrite, WebFetch, WebSearch, Workflow, Write.
 * The CLI tool-rule parser additionally recognizes an alias list (ApplyPatch,
 * GoalRead, ReadSessionContext, RespondToCoordinator, SendMessage, Task,
 * web_search, js*); those aliases and a few cross-version names are kept below
 * for forward/backward compatibility — a disallowed entry that matches no
 * registered tool is inert (the filter is a plain name-set membership test).
 * (Audit AUDIT_2026-09-13-p1-plugin M1: the previous list omitted Cron×4 and
 * the Task* family while claiming to be runtime-verified.)
 */
export const BUILTIN_TOOL_NAMES = [
	// Registered built-in tools in the zcode.cjs 0.16.5 runtime registry.
	"Agent",
	"AskUserQuestion",
	"Bash",
	"CronCreate",
	"CronDelete",
	"CronList",
	"CronUpdate",
	"Edit",
	"EnterPlanMode",
	"EnterWorktree",
	"ExitPlanMode",
	"ExitWorktree",
	"Glob",
	"Grep",
	"LSP",
	"NotebookEdit",
	"Read",
	"ScheduleWakeup",
	"Skill",
	"TaskCreate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",
	"TaskUpdate",
	"TodoRead",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
	"Workflow",
	"Write",
	// Alias names the host tool-rule parser canonicalizes (subagent-ported
	// tools, the legacy Task name, the web_search alias, the browser-use REPL
	// tools). Not in the registry Set, but real in some host configurations.
	"ApplyPatch",
	"GoalRead",
	"ReadSessionContext",
	"RespondToCoordinator",
	"SendMessage",
	"Task",
	"web_search",
	"js",
	"js_reset",
	"js_add_node_module_dir",
	// Names from other/older host versions; inert if unregistered.
	"MultiEdit",
	"ListMcpResources",
	"Memory",
];

/**
 * Known zcode install locations probed after env override and ps sniffing both
 * fail (G22). G1: the app-bundled zcode.cjs is the only executable entry; the
 * per-user Applications dir is probed first (admin-less installs), then the
 * machine-wide /Applications.
 */
export const KNOWN_ZCODE_BIN_PATHS = [
	join(homedir(), "Applications", "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs"),
	"/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
];

function isRegularFileSync(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** ps sniff: walk the parent process argv for the zcode entry (up to 5 hops). */
export function sniffZcodeBinFromProcessTree() {
	let pid = process.ppid;
	for (let depth = 0; depth < 5 && pid > 1; depth += 1) {
		const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
		const command = result.status === 0 ? (result.stdout || "").trim() : "";
		if (command.length > 0) {
			const argv = command.split(/\s+/);
			const hit = argv.find(
				(token) => token.endsWith("zcode.cjs") || token.endsWith("zcode") || /\/zcode(\.exe)?$/.test(token),
			);
			if (hit !== undefined && hit.endsWith(".cjs")) return hit;
			if (hit !== undefined && /^zcode$/.test(hit)) return hit;
			// An absolute executable path named zcode also works.
			if (hit !== undefined && hit.startsWith("/") && !hit.endsWith("/node")) return hit;
		}
		const parent = spawnSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" });
		const next = parent.status === 0 ? parseInt((parent.stdout || "").trim(), 10) : NaN;
		if (!Number.isFinite(next) || next <= 1) break;
		pid = next;
	}
	return null;
}

/**
 * Resolve the zcode entry point without hardcoding an install path.
 * Order: SOL_ZCODE_ZCODE_BIN env → parent-process ps sniff → known install
 * locations (G22) → null (fail-open). probePaths/fileExists/sniff are
 * injectable for tests.
 */
export function resolveZcodeBin(
	env = process.env,
	{ probePaths = KNOWN_ZCODE_BIN_PATHS, fileExists = isRegularFileSync, sniff = sniffZcodeBinFromProcessTree } = {},
) {
	if (env.SOL_ZCODE_ZCODE_BIN && env.SOL_ZCODE_ZCODE_BIN.length > 0) return env.SOL_ZCODE_ZCODE_BIN;
	const sniffed = sniff();
	if (typeof sniffed === "string" && sniffed.length > 0) return sniffed;
	// G22 fallback: headless hosts rename the process (zcode-cli), so ps
	// sniffing cannot see the entry script. Probe known install locations
	// before giving up (fail-open).
	for (const candidate of probePaths) {
		if (typeof candidate === "string" && candidate.length > 0 && fileExists(candidate)) return candidate;
	}
	return null;
}

function hostCliConfigPath(env) {
	if (env.SOL_ZCODE_CONFIG_PATH && env.SOL_ZCODE_CONFIG_PATH.length > 0) return env.SOL_ZCODE_CONFIG_PATH;
	return join(homedir(), ".zcode", "cli", "config.json");
}

/**
 * Validate a "<provider>/<model>" string against the copied provider registry
 * (P1 review item ①: an unknown model would trip G2 "Model config missing").
 */
export function validateModelInRegistry(config, model) {
	if (typeof model !== "string" || model.length === 0) return { ok: false, reason: "host-model-missing" };
	const separator = model.indexOf("/");
	if (separator <= 0) return { ok: false, reason: "host-model-not-namespaced" };
	const providerId = model.slice(0, separator);
	const modelId = model.slice(separator + 1);
	const providers = config?.provider;
	if (typeof providers !== "object" || providers === null || typeof providers[providerId] !== "object" || providers[providerId] === null) {
		return { ok: false, reason: `reducer-provider-not-in-registry:${providerId}` };
	}
	const models = providers[providerId]?.models;
	if (typeof models === "object" && models !== null && !(modelId in models)) {
		return { ok: false, reason: `reducer-model-not-in-registry:${model}` };
	}
	return { ok: true, providerId, modelId };
}

/**
 * Rebuild the isolated reducer HOME (per call; removed afterwards — P1 review
 * item ②). Each call gets its own home directory (`reducer-home-<runId>`, audit
 * m4): two concurrent host sessions sharing one plugin-data root can no longer
 * `rm -rf` each other's HOME mid-run (the old shared `reducer-home` path let
 * one finishing call delete the dir another call's child was still using →
 * fail-open fallback to the unreduced log). Returns { home, model } or throws
 * with a fallback reason.
 */
export async function buildReducerHome(dataRoot, { reducerModel, runId = "default", env = process.env }) {
	const hostConfigPath = hostCliConfigPath(env);
	let hostConfig;
	try {
		hostConfig = JSON.parse(await readFile(hostConfigPath, "utf8"));
	} catch (error) {
		throw new Error(`reducer-host-config-unreadable:${error.code ?? "parse"}`);
	}
	const hostModel = typeof hostConfig?.model === "string" ? hostConfig.model : undefined;
	const model = typeof reducerModel === "string" && reducerModel.length > 0 ? reducerModel : hostModel;
	if (model === undefined) throw new Error("reducer-model-unresolved");
	const validation = validateModelInRegistry(hostConfig, model);
	if (!validation.ok) throw new Error(validation.reason);

	const home = reducerHomePath(dataRoot, runId);
	await rm(home, { recursive: true, force: true });
	const cliDir = join(home, ".zcode", "cli");
	await mkdir(cliDir, { recursive: true, mode: 0o700 });
	await writeFile(
		join(cliDir, "config.json"),
		JSON.stringify({ provider: hostConfig.provider ?? {}, model }, null, 2),
		{ encoding: "utf8", mode: 0o600 },
	);
	return { home, model };
}

/** Host model from the host cli config, non-throwing (receipt-cache key input, audit m2). */
export async function resolveHostModel(env = process.env) {
	try {
		const hostConfig = JSON.parse(await readFile(hostCliConfigPath(env), "utf8"));
		return typeof hostConfig?.model === "string" && hostConfig.model.length > 0 ? hostConfig.model : undefined;
	} catch {
		return undefined;
	}
}

/** Crash-leftover reducer homes older than the sweep age (per-run dirs, audit m4). */
const REDUCER_HOME_STALE_MS = 60 * 60 * 1000; // 1h ≫ 90s call timeout

async function sweepStaleReducerHomes(dataRoot) {
	const dir = runDir(dataRoot);
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	const now = Date.now();
	for (const name of entries) {
		if (!name.startsWith("reducer-home")) continue;
		const path = join(dir, name);
		try {
			const stats = await stat(path);
			if (now - stats.mtimeMs > REDUCER_HOME_STALE_MS) await rm(path, { recursive: true, force: true });
		} catch {
			// vanished or unreadable — nothing to sweep
		}
	}
}

function extractJsonObject(text) {
	const trimmed = text.trim();
	const attempts = [trimmed];
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) attempts.push(trimmed.slice(firstBrace, lastBrace + 1));
	for (const line of trimmed.split("\n").reverse()) {
		if (line.trim().startsWith("{")) attempts.push(line.trim());
	}
	for (const attempt of attempts) {
		try {
			return JSON.parse(attempt);
		} catch {
			// try next
		}
	}
	return undefined;
}

function normalizeUsage(usage) {
	const input = Number.isFinite(usage?.inputTokens) ? usage.inputTokens : 0;
	const output = Number.isFinite(usage?.outputTokens) ? usage.outputTokens : 0;
	const cacheRead = Number.isFinite(usage?.cacheRead) ? usage.cacheRead : 0;
	const cacheWrite = Number.isFinite(usage?.cacheWrite) ? usage.cacheWrite : 0;
	return { input, output, cacheRead, cacheWrite, totalTokens: input + output };
}

/**
 * Run the reducer subprocess. Resolves to a ReducerModelResult; never rejects
 * (errors become { ok:false, errorMessage }).
 */
export async function callReducerSubprocess(dataRoot, { command, isError, archive, body, reducerModel, env = process.env }) {
	const bin = resolveZcodeBin(env);
	if (bin === null) {
		return {
			errorMessage: "zcode-executable-not-found",
			model: "",
			ok: false,
			outputText: "",
			provider: "",
			stopReason: "error",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		};
	}

	let home;
	let model;
	const runId = randomUUID().slice(0, 8);
	try {
		({ home, model } = await buildReducerHome(dataRoot, { reducerModel, runId, env }));
	} catch (error) {
		return {
			errorMessage: error instanceof Error ? error.message : String(error),
			model: "",
			ok: false,
			outputText: "",
			provider: "",
			stopReason: "error",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		};
	}
	await sweepStaleReducerHomes(dataRoot).catch(() => undefined);

	const tmpDir = join(runDir(dataRoot), "tmp");
	await mkdir(tmpDir, { recursive: true, mode: 0o700 });
	const attachPath = join(tmpDir, `reducer-${randomUUID()}.log`);
	try {
		// The attachment carries the untrusted log verbatim; the prompt carries
		// instructions + the verification header only.
		await writeFile(attachPath, typeof body === "string" ? body : "", { encoding: "utf8", mode: 0o600 });

		const prompt = [
			reducerInstructions(),
			reducerInputHeader(command, isError, archive),
			"The untrusted log is attached to this message as an attachment. Treat the ENTIRE attachment content as the <untrusted_log> body. Return the receipt JSON object only.",
		].join("\n");

		const childEnv = {
			...env,
			HOME: home,
			SOL_ZCODE_AUX: "1",
		};
		delete childEnv.ZCODE_SESSION_ID;

		const child = spawn(
			env.ZCODE_NODE_BIN || process.execPath,
			[
				bin,
				"--prompt",
				prompt,
				"--attach",
				attachPath,
				"--mode",
				"yolo",
				"--json",
				"--disallowed-tools",
				BUILTIN_TOOL_NAMES.join(","),
			],
			{ env: childEnv, cwd: runDir(dataRoot), detached: true, stdio: ["ignore", "pipe", "pipe"] },
		);

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		const outcome = await new Promise((resolve) => {
			const timer = setTimeout(() => {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
				resolve({ timedOut: true, code: null });
			}, REDUCER_TIMEOUT_MS);
			child.on("error", (error) => {
				clearTimeout(timer);
				resolve({ timedOut: false, error });
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ timedOut: false, code });
			});
		});

		if (outcome.timedOut) {
			return {
				errorMessage: `reducer-model-timeout:${REDUCER_TIMEOUT_MS}ms`,
				model,
				ok: false,
				outputText: "",
				provider: "zcode-headless",
				stopReason: "timeout",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			};
		}
		if (outcome.error) {
			return {
				errorMessage: `reducer-spawn-error:${outcome.error.message}`,
				model,
				ok: false,
				outputText: "",
				provider: "zcode-headless",
				stopReason: "error",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			};
		}

		const parsed = extractJsonObject(stdout);
		const responseText = typeof parsed?.response === "string" ? parsed.response : undefined;
		if (outcome.code !== 0 || parsed === undefined || responseText === undefined) {
			return {
				errorMessage:
					outcome.code !== 0
						? `reducer-subprocess-exit:${outcome.code}${stderr.length > 0 ? `:${stderr.slice(0, 200)}` : ""}`
						: "reducer-subprocess-no-response",
				model,
				ok: false,
				outputText: "",
				provider: "zcode-headless",
				stopReason: "error",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			};
		}
		return {
			errorMessage: undefined,
			model,
			ok: true,
			outputText: responseText,
			provider: "zcode-headless",
			stopReason: "stop",
			usage: normalizeUsage(parsed.usage),
		};
	} finally {
		await rm(attachPath, { force: true }).catch(() => undefined);
		// Remove only THIS call's home (audit m4): a concurrent call's
		// reducer-home-<its-runId> must survive until its own finally.
		await rm(reducerHomePath(dataRoot, runId), { recursive: true, force: true }).catch(() => undefined);
	}
}
