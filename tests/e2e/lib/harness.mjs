/*
 * Headless real-model e2e harness for sol-zcode (P2, PLAN/DESIGN §6.3).
 *
 * Every scenario runs against a throwaway HOME (G2 headless formula: provider
 * registry copied read-only from the real host v2 config + model string) with
 * the plugin installed via scripts/install-plugin.mjs, then drives
 *   node <zcode.cjs> --prompt ... --mode yolo --json
 * and asserts on the artifacts the plugin is contractually required to produce
 * (ledgers, occ state, trajectory, archives) plus host-side evidence
 * (rollout request bodies, probe-plugin transcript copies).
 *
 * Budget guard: total model requests (usage.modelRequestCount) + reducer
 * subprocess calls are counted globally; runs abort past MODEL_BUDGET_MAX.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

export const E2E_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // tests/e2e
export const REPO = dirname(dirname(E2E_ROOT));
export const ZCODE_BIN = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
export const PLUGIN_ID = "sol-zcode@sol-zcode-dev";
export const MODEL = "builtin:bigmodel-coding-plan/GLM-5.3-Flash";
const PROVIDER_ID = "builtin:bigmodel-coding-plan";
export const RESULTS_DIR = join(E2E_ROOT, "results");
const TMP_BASE = join(E2E_ROOT, "tmp");

export const MODEL_BUDGET_MAX = 85;

const budget = { modelRequests: 0, reducerCalls: 0, runs: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
export function budgetState() {
	return { ...budget };
}
export function addReducerCalls(n) {
	budget.reducerCalls += n;
}

function baseConfig() {
	const v2 = JSON.parse(readFileSync(join(process.env.HOME, ".zcode", "v2", "config.json"), "utf8"));
	const entry = v2?.provider?.[PROVIDER_ID];
	if (!entry || typeof entry !== "object" || !entry?.options?.apiKey) {
		throw new Error("host provider entry missing from ~/.zcode/v2/config.json");
	}
	return { provider: { [PROVIDER_ID]: entry }, model: MODEL };
}

/** Strip this agent's own ZCODE_ and SOL_ZCODE_ env so child sessions stay isolated. */
function sanitizedEnv(home) {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("ZCODE_") || key.startsWith("SOL_ZCODE_")) continue;
		env[key] = value;
	}
	env.HOME = home;
	// Documented plugin override (reducer-subprocess.mjs): resolveZcodeBin's
	// ps-sniffing cannot find the host binary when the CLI renames its process
	// title to "zcode-cli" (P2 e2e finding — headless --prompt included), so the
	// e2e/benchmark environment pins the binary via the official env override.
	env.SOL_ZCODE_ZCODE_BIN = ZCODE_BIN;
	return env;
}

export function installPlugin(home, pluginDir, marketplace, options) {
	// --home targets the zcode home dir itself (<home>/.zcode), not $HOME.
	const args = [join(REPO, "scripts", "install-plugin.mjs"), pluginDir, marketplace, "--home", join(home, ".zcode")];
	if (options !== undefined) args.push("--options", JSON.stringify(options));
	const result = spawnSync(process.execPath, args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`install-plugin failed: ${result.stderr}`);
	return result.stdout.trim();
}

/**
 * Create an isolated scenario environment.
 *   workdirFiles: { "<relpath>": "<content>" }     seeded into the work dir
 *   execFiles:    { "<relpath>": "<content>" }     seeded executable (0755)
 *   options:      plugins.options for sol-zcode ({} = all off)
 *   probeMarker:  null | string — also install the e2e probe plugin (passive
 *                 payload/transcript logger; injects additionalContext with
 *                 this marker on UserPromptSubmit when non-null)
 */
export async function makeScenario(name, { options = {}, workdirFiles = {}, execFiles = {}, probeMarker = null, probeStopBlock = null } = {}) {
	await mkdir(TMP_BASE, { recursive: true });
	const root = await mkdtemp(join(TMP_BASE, `${name}-`));
	const home = join(root, "home");
	const work = join(root, "work");
	await mkdir(join(home, ".zcode", "cli"), { recursive: true });
	await mkdir(work, { recursive: true });
	await writeFile(join(home, ".zcode", "cli", "config.json"), JSON.stringify(baseConfig(), null, 2));
	installPlugin(home, join(REPO, "plugin"), "sol-zcode-dev", options);
	let probe = null;
	if (probeMarker !== false) {
		const { generateProbePlugin } = await import("./probe.mjs");
		const probeDir = join(root, "probe-plugin");
		await generateProbePlugin(probeDir, {
			marker: typeof probeMarker === "string" ? probeMarker : null,
			stopBlockReason: typeof probeStopBlock === "string" ? probeStopBlock : null,
		});
		installPlugin(home, probeDir, "e2e-probe-dev", undefined);
		probe = {
			dir: probeDir,
			installDir: join(home, ".zcode", "cli", "plugins", "cache", "e2e-probe-dev", "e2e-probe", "0.0.1"),
		};
	}
	for (const [rel, content] of Object.entries(workdirFiles)) {
		const path = join(work, rel);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
	}
	for (const [rel, content] of Object.entries(execFiles)) {
		const path = join(work, rel);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8", { mode: 0o755 });
		// Explicit chmod: creation modes are not reliably honored on all local
		// volume mounts (observed: 0644 despite mode 0755 on this APFS volume).
		const { chmod } = await import("node:fs/promises");
		await chmod(path, 0o755);
	}
	return { name, root, home, work, options, probe, dataRoot: join(home, ".zcode", "cli", "plugins", "data", PLUGIN_ID) };
}

export async function cleanupScenario(sc) {
	if (process.env.SOL_E2E_KEEP === "1") return; // --keep: retain homes for diagnosis
	await rm(sc.root, { recursive: true, force: true }).catch(() => undefined);
}

export function parseHeadlessJson(stdout) {
	const text = stdout.trim();
	if (text.length === 0) return null;
	try {
		return JSON.parse(text);
	} catch {
		/* fall through to brace scan */
	}
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first >= 0 && last > first) {
		try {
			return JSON.parse(text.slice(first, last + 1));
		} catch {
			return null;
		}
	}
	return null;
}

/** Run one headless prompt. Returns { code, signal, stdout, stderr, json, usage, sessionId, response }. */
export async function runPrompt(sc, prompt, { resume = null, timeoutMs = 300_000, label = "" } = {}) {
	if (budget.modelRequests + budget.reducerCalls > MODEL_BUDGET_MAX) {
		throw new Error(`model budget exceeded (${budget.modelRequests}+${budget.reducerCalls} > ${MODEL_BUDGET_MAX})`);
	}
	const args = [ZCODE_BIN, "--prompt", prompt, "--mode", "yolo", "--json"];
	if (resume) args.push("--resume", resume);
	const started = Date.now();
	return await new Promise((resolve) => {
		const child = spawn(process.execPath, args, { cwd: sc.work, env: sanitizedEnv(sc.home) });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (payload) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			budget.runs += 1;
			const json = parseHeadlessJson(stdout);
			const usage = normalizeUsage(json?.usage);
			if (usage) {
				budget.modelRequests += usage.modelRequestCount;
				budget.inputTokens += usage.inputTokens;
				budget.outputTokens += usage.outputTokens;
				budget.cacheRead += usage.cacheRead;
				budget.cacheWrite += usage.cacheWrite;
			}
			resolve({
				stdout,
				stderr,
				json,
				usage,
				sessionId: json?.sessionId ?? json?.session_id ?? null,
				response: typeof json?.response === "string" ? json.response : null,
				projection: json?.projection ?? null,
				label,
				ms: Date.now() - started,
				...payload,
			});
		};
		const timer = setTimeout(() => {
			// Resolve immediately on timeout: grandchildren (MCP servers) may
			// hold the stdio pipes open even after the direct child is killed.
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
			finish({ code: null, signal: "SIGKILL-timeout" });
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			finish({ code: -1, signal: null, stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}` });
		});
		child.on("close", (code, signal) => {
			finish({ code, signal });
		});
	});
}

function normalizeUsage(usage) {
	if (!usage || typeof usage !== "object") return null;
	return {
		inputTokens: usage.inputTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0,
		cacheRead: usage.cacheRead ?? usage.cacheReadTokens ?? 0,
		cacheWrite: usage.cacheWrite ?? usage.cacheWriteTokens ?? 0,
		modelRequestCount: usage.modelRequestCount ?? 1,
	};
}

// ---------------------------------------------------------------- artifacts

export async function readJsonl(path) {
	try {
		const raw = await readFile(path, "utf8");
		return raw
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line));
	} catch {
		return null;
	}
}

export function ledgerPath(sc, sessionId, file) {
	return join(sc.dataRoot, "store", "ledger", sessionId, file);
}
export function trajectoryPath(sc, sessionId) {
	return join(sc.dataRoot, "store", "trajectory", `${sessionId}.jsonl`);
}
export async function readOccState(sc, sessionId) {
	try {
		return JSON.parse(await readFile(ledgerPath(sc, sessionId, "occ-state.json"), "utf8"));
	} catch {
		return null;
	}
}
export async function readTrajectory(sc, sessionId) {
	return readJsonl(trajectoryPath(sc, sessionId));
}

export async function findRollout(sc, sessionId) {
	const dir = join(sc.home, ".zcode", "cli", "rollout");
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		return null;
	}
	const id = (sessionId ?? "").replace(/^sess_/, "");
	const hit = entries.find((name) => name.includes(id));
	return hit ? join(dir, hit) : null;
}

export async function rolloutText(path) {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Walk the parsed rollout JSONL and return the first string value containing
 * `substring` (request messages / system / responses), or null when absent.
 * (Raw-text search would miss JSON-escaped newlines.)
 */
export async function rolloutFindString(path, substring) {
	const text = await rolloutText(path);
	if (text === null) return null;
	const walk = (value) => {
		if (typeof value === "string") return value.includes(substring) ? value : null;
		if (Array.isArray(value)) {
			for (const item of value) {
				const hit = walk(item);
				if (hit !== null) return hit;
			}
			return null;
		}
		if (value !== null && typeof value === "object") {
			for (const child of Object.values(value)) {
				const hit = walk(child);
				if (hit !== null) return hit;
			}
		}
		return null;
	};
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const hit = walk(JSON.parse(line));
			if (hit !== null) return hit;
		} catch {
			/* skip unparsable */
		}
	}
	return null;
}

/** Tool names present in the LAST rollout request's tools array (empty when rollout missing). */
export async function rolloutToolNames(rolloutPath) {
	const text = await rolloutText(rolloutPath);
	if (text === null) return null;
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	let last = null;
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed?.request?.body?.tools) last = parsed.request.body.tools;
		} catch {
			/* skip */
		}
	}
	return last === null ? null : last.map((tool) => tool.name);
}

// ------------------------------------------------------------ probe plugin

export async function probeEvents(sc) {
	if (!sc.probe) return [];
	return (await readJsonl(join(sc.probe.installDir, "hooks", "events.jsonl"))) ?? [];
}

export async function probeTranscripts(sc) {
	if (!sc.probe) return [];
	const dir = join(sc.probe.installDir, "hooks");
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	return entries
		.filter((name) => name.startsWith("transcript-") && name.endsWith(".jsonl"))
		.sort()
		.map((name) => join(dir, name));
}

export async function readTranscriptCopies(sc) {
	const copies = [];
	for (const path of await probeTranscripts(sc)) {
		const text = await readFile(path, "utf8").catch(() => null);
		if (text !== null) copies.push({ path, text });
	}
	return copies;
}

// ---------------------------------------------------------------- utilities

export async function listFilesRecursive(root) {
	const out = [];
	async function walk(dir) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) out.push(relative(root, path));
		}
	}
	await walk(root);
	return out.sort();
}

export async function fileBytes(path) {
	try {
		return await readFile(path);
	} catch {
		return null;
	}
}

export function sha256Text(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
export function sha256Buffer(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

export function makeAssertions() {
	const list = [];
	return {
		check(name, pass, detail = "") {
			list.push({ name, pass: pass === true, detail: String(detail).slice(0, 600) });
			return pass === true;
		},
		list,
		get ok() {
			return list.every((entry) => entry.pass);
		},
		failed() {
			return list.filter((entry) => !entry.pass);
		},
	};
}

export async function recordResult(scenario, entry) {
	await mkdir(RESULTS_DIR, { recursive: true });
	const record = { ts: new Date().toISOString(), scenario, ...entry, budget: budgetState() };
	const { appendFile } = await import("node:fs/promises");
	await appendFile(join(RESULTS_DIR, "e2e-results.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
	await writeFile(join(RESULTS_DIR, `${scenario}.json`), JSON.stringify(record, null, 2), "utf8");
	return record;
}

export function assertEnvReady() {
	if (!existsSync(ZCODE_BIN)) throw new Error(`zcode.cjs not found at ${ZCODE_BIN}`);
	const v2 = join(process.env.HOME, ".zcode", "v2", "config.json");
	if (!existsSync(v2)) throw new Error(`host v2 config missing at ${v2}`);
	return true;
}
