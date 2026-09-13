#!/usr/bin/env node
/*
 * Pin and fetch the Node.js Linux tarballs the benchmark ships into task
 * containers (deterministic, offline install — no nvm/GitHub at trial time).
 *
 *   node benchmark/bin/fetch-node.mjs            # fetch if absent
 *   node benchmark/bin/fetch-node.mjs --check    # verify sha256 of present files
 *
 * Files land in benchmark/assets/node/ (gitignored; freeze manifest pins their
 * sha256 so a run is reproducible when the tarballs are present).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_DIR = join(HERE, "..", "assets", "node");
const DIST = "https://nodejs.org/dist";
// x64 kept for amd64 task images (OrbStack runs them via Rosetta).
const TARGETS = ["arm64", "x64"];

async function fetchWithProgress(url, dest) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
	await pipeline(res.body, createWriteStream(dest));
}

async function sha256(path) {
	const { readFile } = await import("node:fs/promises");
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

const checkOnly = process.argv.includes("--check");
mkdirSync(NODE_DIR, { recursive: true });
const manifest = {};
for (const arch of TARGETS) {
	const file = `node-v${process.env.SOL_BENCH_NODE_VERSION ?? "22.23.2"}-linux-${arch}.tar.xz`;
	const dest = join(NODE_DIR, file);
	if (!existsSync(dest)) {
		if (checkOnly) throw new Error(`missing ${file} — run fetch-node.mjs without --check`);
		process.stdout.write(`downloading ${file} ... `);
		await fetchWithProgress(`${DIST}/v22.23.2/${file}`, dest);
		process.stdout.write("done\n");
	}
	const digest = await sha256(dest);
	manifest[file] = digest;
	console.log(`${file}  ${digest}`);
}
if (!checkOnly) {
	writeFileSync(join(NODE_DIR, "sha256.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
