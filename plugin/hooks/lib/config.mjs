/*
 * sol-zcode opt-in gate (DESIGN §3, C2).
 *
 * Single source of truth: `~/.zcode/cli/config.json` → `plugins.options`
 * (runtime schema: `{ "<plugin-id>": { "<key>": string|number|boolean } }`,
 * plugin-id key domain `<name>@<marketplace>` — GOTCHAS G19). The plugin.json
 * `userConfig` block is a UI declaration layer only.
 *
 * Resolution rules (fail-safe, never fail-crash):
 *   - `SOL_ZCODE_AUX=1` → zero behavior (reducer-subprocess re-entry guard).
 *   - missing file / unparsable JSON / no options for this plugin → all off.
 *   - boolean key missing → false; wrong type → false + recorded in
 *     `rejectedKeys` (callers journal a `config_rejected` trajectory entry).
 *   - `reducerModel` wrong type → "" (inherit host model).
 * mtime-cached per process.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const FEATURE_KEYS = ["actionFusion", "observationPack", "evidenceReducer", "onlineCompact", "trajectory"];
export const BOOLEAN_KEYS = [...FEATURE_KEYS, "actionFusionGate"];
export const STRING_KEYS = ["reducerModel"];

const ALL_OFF = {
	actionFusion: false,
	observationPack: false,
	evidenceReducer: false,
	onlineCompact: false,
	trajectory: false,
	actionFusionGate: false,
	reducerModel: "",
};

let cache = { path: null, mtimeMs: null, value: null };

export function configFilePath(env = process.env) {
	// No ZCODE_HOME variable exists (G18/n2): home resolves from $HOME on unix.
	// Honor the env object we were handed (tests redirect HOME without
	// mutating process.env).
	if (env.SOL_ZCODE_CONFIG_PATH) return env.SOL_ZCODE_CONFIG_PATH;
	const home = typeof env.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
	return join(home, ".zcode", "cli", "config.json");
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionsKeyFor(env = process.env) {
	if (typeof env.ZCODE_PLUGIN_ID === "string" && env.ZCODE_PLUGIN_ID.length > 0) return env.ZCODE_PLUGIN_ID;
	// MCP server children do not receive ZCODE_PLUGIN_ID (verified against the
	// 0.16.5 runtime: the stdio MCP env carries PROJECT_DIR/PLUGIN_DATA/
	// PLUGIN_ROOT only). Fall back to scanning the options key domain.
	return null;
}

/**
 * Pick our own options record. The id carries the @marketplace suffix
 * (enabledPlugins key domain); callers verify this live in smoke tests.
 */
export function findOwnOptions(options, env = process.env) {
	if (!isRecord(options)) return undefined;
	const direct = optionsKeyFor(env);
	if (direct !== null && isRecord(options[direct])) return { key: direct, value: options[direct] };
	for (const key of Object.keys(options)) {
		if (key === "sol-zcode" || key.startsWith("sol-zcode@")) {
			if (isRecord(options[key])) return { key, value: options[key] };
		}
	}
	return undefined;
}

export async function resolveConfig(env = process.env, { stat = null } = {}) {
	if (env.SOL_ZCODE_AUX === "1") {
		return { ...ALL_OFF, status: "aux", rejectedKeys: [], key: null, zeroBehavior: true };
	}
	const path = configFilePath(env);
	let mtimeMs = null;
	try {
		const stats = stat ? await stat(path) : await (await import("node:fs/promises")).stat(path);
		mtimeMs = stats.mtimeMs;
	} catch {
		// Missing config file → all off (C2 safe side, no journal writes).
		return { ...ALL_OFF, status: "config-missing", rejectedKeys: [], key: null, zeroBehavior: true };
	}
	if (cache.path === path && cache.mtimeMs === mtimeMs && cache.value !== null) {
		return cache.value;
	}

	let value;
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw);
		const own = findOwnOptions(parsed?.plugins?.options, env);
		if (own === undefined) {
			value = { ...ALL_OFF, status: "no-options", rejectedKeys: [], key: null, zeroBehavior: true };
		} else {
			const flags = { ...ALL_OFF };
			const rejectedKeys = [];
			for (const key of BOOLEAN_KEYS) {
				const rawValue = own.value[key];
				if (rawValue === undefined) continue;
				if (typeof rawValue === "boolean") flags[key] = rawValue;
				else rejectedKeys.push(key);
			}
			for (const key of STRING_KEYS) {
				const rawValue = own.value[key];
				if (rawValue === undefined) continue;
				if (typeof rawValue === "string" && rawValue.length <= 512) flags[key] = rawValue;
				else rejectedKeys.push(key);
			}
			const zeroBehavior =
				!flags.actionFusion && !flags.observationPack && !flags.evidenceReducer && !flags.onlineCompact && !flags.trajectory && !flags.actionFusionGate;
			value = { ...flags, status: "ok", rejectedKeys, key: own.key, zeroBehavior };
		}
	} catch {
		// Corrupt JSON → all off.
		value = { ...ALL_OFF, status: "config-corrupt", rejectedKeys: [], key: null, zeroBehavior: true };
	}
	cache = { path, mtimeMs, value };
	return value;
}

/** Test/CLI helper: drop the per-process mtime cache. */
export function resetConfigCache() {
	cache = { path: null, mtimeMs: null, value: null };
}
