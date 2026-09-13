#!/usr/bin/env node
/*
 * Container-side headless cli-config writer (G2 three-part formula).
 *
 *   node write-cli-config.mjs <provider-template.json> [--home <dir>]
 *
 * - template = benchmark/assets/provider-template.json (host v2 provider entry,
 *   apiKey stripped; committed, secret-free).
 * - apiKey comes ONLY from the ZCODE_BIGMODEL_KEY env var — never an argv
 *   (argv leaks into `ps`), never echoed.
 * - writes <home>/.zcode/cli/config.json (default $HOME/.zcode).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , templatePath, ...rest] = process.argv;
if (!templatePath) {
	console.error("usage: write-cli-config.mjs <provider-template.json> [--home <dir>]");
	process.exit(1);
}
let home = null;
let model = null;
for (let i = 0; i < rest.length; i += 1) {
	if (rest[i] === "--home") {
		home = rest[i + 1];
		i += 1;
	} else if (rest[i] === "--model") {
		model = rest[i + 1];
		i += 1;
	}
}
const key = process.env.ZCODE_BIGMODEL_KEY;
if (!key) {
	console.error("ZCODE_BIGMODEL_KEY is not set — refusing to write a keyless config");
	process.exit(1);
}
const template = JSON.parse(readFileSync(templatePath, "utf8"));
delete template._note;
const providerId = Object.keys(template.provider)[0];
const provider = JSON.parse(JSON.stringify(template.provider[providerId]));
provider.options ??= {};
provider.options.apiKey = key;
const config = { provider: { [providerId]: provider }, model: model ?? template.model };
const target = join(home ?? join(process.env.HOME ?? "/root", ".zcode"), "cli", "config.json");
mkdirSync(join(home ?? join(process.env.HOME ?? "/root", ".zcode"), "cli"), { recursive: true });
writeFileSync(target, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log(`cli config written: ${target} (provider=${providerId}, model=${template.model}, apiKey=<env>)`);
