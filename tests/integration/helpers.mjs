/*
 * Shared fixtures for sol-zcode integration tests: isolated HOME with an
 * opt-in config, isolated ZCODE_PLUGIN_DATA, and a fake headless zcode binary
 * that returns a receipt the pipeline can verify (no real model needed).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

export const PLUGIN_ID = "sol-zcode@sol-zcode-dev";

export async function makeEnv({ options = {}, home = null } = {}) {
	const root = home ?? (await mkdtemp(join(tmpdir(), "sol-it-")));
	const dataDir = join(root, "data");
	await mkdir(join(root, ".zcode", "cli"), { recursive: true });
	await mkdir(dataDir, { recursive: true });
	await writeFile(
		join(root, ".zcode", "cli", "config.json"),
		JSON.stringify({
			provider: { "builtin:bigmodel-coding-plan": { models: { "GLM-5.3-Flash": {}, "GLM-5.3": {} } } },
			model: "builtin:bigmodel-coding-plan/GLM-5.3-Flash",
			plugins: { enabledPlugins: { [PLUGIN_ID]: true }, options: { [PLUGIN_ID]: options } },
		}),
		"utf8",
	);
	return {
		env: {
			HOME: root,
			ZCODE_PLUGIN_DATA: dataDir,
			ZCODE_PLUGIN_ID: PLUGIN_ID,
			ZCODE_PROJECT_DIR: join(root, "project"),
			SOL_ZCODE_CONFIG_PATH: join(root, ".zcode", "cli", "config.json"),
		},
		root,
		dataDir,
	};
}

export async function cleanup(envFixture) {
	await rm(envFixture.root, { recursive: true, force: true });
}

/**
 * A fake zcode headless binary. Parses --prompt (extracts source_sha256 and
 * is_error), reads the --attach file, and emits a --json result whose response
 * is a receipt quoting the first line of the log. Records the exact argv/env
 * it observed into <diagnosticsPath> so tests can assert the three tool-face
 * defenses (isolated HOME, --disallowed-tools, SOL_ZCODE_AUX).
 */
export async function writeFakeZcodeBin(path, diagnosticsPath) {
	await mkdir(dirname(path), { recursive: true });
	const source = `#!/usr/bin/env node
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const argv = process.argv.slice(2);
const promptIndex = argv.indexOf("--prompt");
const attachIndex = argv.indexOf("--attach");
const disallowedIndex = argv.indexOf("--disallowed-tools");
const prompt = promptIndex >= 0 ? argv[promptIndex + 1] : "";
const attachPath = attachIndex >= 0 ? argv[attachIndex + 1] : null;
const log = attachPath !== null && existsSync(attachPath) ? readFileSync(attachPath, "utf8") : "";
const sourceSha = (prompt.match(/source_sha256=([0-9a-f]{64})/) || [])[1];
const isError = /is_error=true/.test(prompt);
const firstLine = log.split("\\n").find((line) => line.length > 0) ?? "";
const receipt = JSON.stringify({
  schema: "sol-zcode-evidence-receipt/1",
  source_sha256: sourceSha,
  status: isError ? "failure" : "success",
  uncertain: false,
  evidence: firstLine.length > 0 ? [{ kind: isError ? "failure" : "summary", quote: firstLine.slice(0, 600) }] : [],
});
writeFileSync(${JSON.stringify(diagnosticsPath)}, JSON.stringify({
  argv: argv.map((token) => token === prompt ? "<prompt>" : token),
  promptLength: prompt.length,
  attachBytes: Buffer.byteLength(log, "utf8"),
  disallowedTools: disallowedIndex >= 0 ? argv[disallowedIndex + 1] : null,
  home: process.env.HOME,
  aux: process.env.SOL_ZCODE_AUX,
  homeCliConfigExists: existsSync(process.env.HOME + "/.zcode/cli/config.json"),
}, null, 2));
process.stdout.write(JSON.stringify({ response: receipt, usage: { inputTokens: 111, outputTokens: 22, cacheRead: 0, cacheWrite: 0 } }));
`;
	await writeFile(path, source, { encoding: "utf8", mode: 0o755 });
}

export function sha256(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

import { fileURLToPath } from "node:url";

export function pluginRoot() {
	return join(dirname(dirname(fileURLToPath(import.meta.url))), "..", "plugin");
}
