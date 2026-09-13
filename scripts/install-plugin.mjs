#!/usr/bin/env node
/**
 * Scripted local plugin installer for Zcode (dev/benchmark use), migrated from
 * spike/install-plugin.mjs with two enhancements:
 *   --home <zcodeHome>   target zcode home (default ~/.zcode)
 *   --options <json>     plugin userConfig options written programmatically to
 *                        config.json plugins.options["<name>@<marketplace>"]
 *                        (the same file the settings UI writes — GOTCHAS G19).
 *
 * Uses only the public plugin cache/registry formats:
 *   - copies the plugin into <home>/cli/plugins/cache/<marketplace>/<name>/<version>/
 *   - writes .zcode-plugin-seed.json
 *   - registers it in installed_plugins.json
 *   - enables it in config.json plugins.enabledPlugins
 *
 * Usage:
 *   node install-plugin.mjs <pluginDir> [marketplaceName] [--home <zcodeHome>]
 *        [--options '{"actionFusion":true,"observationPack":true,...}']
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const [, , pluginDir, marketplaceName = "sol-zcode-dev", ...rest] = process.argv;
if (!pluginDir || !existsSync(join(pluginDir, ".zcode-plugin", "plugin.json"))) {
	console.error(
		"usage: install-plugin.mjs <pluginDir> [marketplaceName] [--home <zcodeHome>] [--options <json>]",
	);
	process.exit(1);
}
let home = null;
let optionsRaw = null;
for (let i = 0; i < rest.length; i += 1) {
	if (rest[i] === "--home") {
		home = rest[i + 1];
		i += 1;
	} else if (rest[i] === "--options") {
		optionsRaw = rest[i + 1];
		i += 1;
	}
}
const zcodeHome = home ?? join(process.env.HOME, ".zcode");
const cliDir = join(zcodeHome, "cli");

let parsedOptions;
if (optionsRaw !== null) {
	try {
		parsedOptions = JSON.parse(optionsRaw);
	} catch (error) {
		console.error(`--options is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	if (typeof parsedOptions !== "object" || parsedOptions === null || Array.isArray(parsedOptions)) {
		console.error("--options must be a JSON object of {userConfigKey: boolean|string|number}");
		process.exit(1);
	}
}

const manifest = JSON.parse(readFileSync(join(pluginDir, ".zcode-plugin", "plugin.json"), "utf8"));
const name = manifest.name;
const version = manifest.version ?? "0.0.0";
const installPath = join(cliDir, "plugins", "cache", marketplaceName, name, version);
rmSync(installPath, { recursive: true, force: true });
mkdirSync(installPath, { recursive: true });
cpSync(pluginDir, installPath, { recursive: true, dot: true });
const seed = {
	hash: randomUUID().replace(/-/g, ""),
	marketplace: marketplaceName,
	plugin: name,
	pluginVersion: version,
	source: "filesystem",
	version: 1,
};
writeFileSync(join(installPath, ".zcode-plugin-seed.json"), JSON.stringify(seed, null, 2));

const ipPath = join(cliDir, "plugins", "installed_plugins.json");
const ip = existsSync(ipPath)
	? JSON.parse(readFileSync(ipPath, "utf8"))
	: { version: 1, plugins: [] };
const id = `${name}@${marketplaceName}`;
ip.plugins = (ip.plugins ?? []).filter((p) => p.id !== id);
ip.plugins.push({
	id,
	name,
	marketplace: marketplaceName,
	version,
	installPath,
	installedAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	scope: "user",
	source: installPath,
	cacheTransactionId: randomUUID(),
});
mkdirSync(join(cliDir, "plugins"), { recursive: true });
writeFileSync(ipPath, JSON.stringify(ip, null, 2));

const cfgPath = join(cliDir, "config.json");
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
cfg.plugins ??= {};
cfg.plugins.enabledPlugins ??= {};
cfg.plugins.enabledPlugins[id] = true;
if (parsedOptions !== undefined) {
	cfg.plugins.options ??= {};
	// REPLACE (not merge) the plugin's options so switching benchmark arms is
	// deterministic: --options '{}' reliably turns everything off.
	cfg.plugins.options[id] = { ...parsedOptions };
}
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log(`installed ${id} v${version} -> ${installPath}`);
if (parsedOptions !== undefined) {
	console.log(`plugins.options[${id}] = ${JSON.stringify(cfg.plugins.options[id])}`);
}
