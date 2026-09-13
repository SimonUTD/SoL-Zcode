#!/usr/bin/env node
/**
 * Scripted local plugin installer for Zcode (dev/benchmark use).
 * Uses only the public plugin cache/registry formats:
 *   - copies the plugin into ~/.zcode/cli/plugins/cache/<marketplace>/<name>/<version>/
 *   - writes .zcode-plugin-seed.json
 *   - registers it in installed_plugins.json
 *   - enables it in config.json plugins.enabledPlugins
 * Usage: node install-plugin.mjs <pluginDir> <marketplaceName> [--home <zcodeHome>]
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

const [, , pluginDir, marketplaceName = "sol-zcode-dev", ...rest] = process.argv;
if (!pluginDir || !existsSync(join(pluginDir, ".zcode-plugin", "plugin.json"))) {
  console.error("usage: install-plugin.mjs <pluginDir> [marketplaceName] [--home <zcodeHome>]");
  process.exit(1);
}
let home = null;
for (let i = 0; i < rest.length; i++) if (rest[i] === "--home") home = rest[i + 1];
const zcodeHome = home ?? join(process.env.HOME, ".zcode");
const cliDir = join(zcodeHome, "cli");

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
const ip = JSON.parse(readFileSync(ipPath, "utf8"));
const id = `${name}@${marketplaceName}`;
ip.plugins = ip.plugins.filter((p) => p.id !== id);
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
writeFileSync(ipPath, JSON.stringify(ip, null, 2));

const cfgPath = join(cliDir, "config.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
cfg.plugins ??= {};
cfg.plugins.enabledPlugins ??= {};
cfg.plugins.enabledPlugins[id] = true;
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log(`installed ${id} v${version} -> ${installPath}`);
