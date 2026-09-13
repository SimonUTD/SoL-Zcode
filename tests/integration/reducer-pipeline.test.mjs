/*
 * Reducer pipeline integration tests (DESIGN §2.3) with a fake headless zcode
 * binary (no real model): receipt application through sol_bash, then_run log
 * reduction keeping the mutation confirmation, LRU cache hit, fail-open when
 * the binary is missing, and the three tool-face defenses observed in the
 * subprocess (isolated HOME + no plugin config leak, --disallowed-tools
 * enumeration, SOL_ZCODE_AUX=1). Also: reducerModel registry validation and
 * reducer-home rebuild/cleanup.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeEnv, pluginRoot, writeFakeZcodeBin } from "./helpers.mjs";
import {
	BUILTIN_TOOL_NAMES,
	buildReducerHome,
	callReducerSubprocess,
	validateModelInRegistry,
} from "../../plugin/hooks/lib/reducer-subprocess.mjs";
import { archiveBody } from "../../plugin/core/index.mjs";
import { reducerHomePath } from "../../plugin/hooks/lib/store.mjs";

const BIG_LOG = [
	"error: compilation failed",
	...Array.from({ length: 200 }, (_v, i) => `warning detail ${i} ${"d".repeat(40)}`),
	"error: boom at main.c:42",
].join("\n");

async function withFixture(options, fn) {
	const fixture = await makeEnv(options);
	await mkdir(join(fixture.env.ZCODE_PROJECT_DIR), { recursive: true });
	const binPath = join(fixture.root, "fake-zcode.cjs");
	const diagnosticsPath = join(fixture.root, "fake-zcode-diagnostics.json");
	await writeFakeZcodeBin(binPath, diagnosticsPath);
	fixture.env.SOL_ZCODE_ZCODE_BIN = binPath;
	fixture.binPath = binPath;
	fixture.diagnosticsPath = diagnosticsPath;
	try {
		await fn(fixture);
	} finally {
		await cleanup(fixture);
	}
}

async function mcpCall(fixture, name, arguments_) {
	const child = spawn(process.execPath, [join(pluginRoot(), "mcp", "server.mjs")], {
		env: { ...fixture.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const lines = [];
	let buffer = "";
	const received = new Promise((resolve, reject) => {
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			let index;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (line.trim().length === 0) continue;
				lines.push(JSON.parse(line));
			}
			const response = lines.find((message) => message.id === 3 && message.result);
			if (response !== undefined) {
				child.stdin.end();
				resolve(response);
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", () => undefined);
		setTimeout(() => reject(new Error("timeout waiting for MCP response")), 30_000);
	});
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} })}\n`,
	);
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
	);
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: arguments_ } })}\n`,
	);
	return received;
}

test("diagnostic gate + receipt pipeline through sol_bash (cargo build, exit 1)", async () => {
	await withFixture({ options: { evidenceReducer: true, observationPack: true } }, async (fixture) => {
		const logFile = join(fixture.env.ZCODE_PROJECT_DIR, "log.txt");
		await writeFile(logFile, `${BIG_LOG}\n`, "utf8");
		const command = `cargo build 2>&1; sh -c 'cat "${logFile}"; exit 1'`;
		const response = await mcpCall(fixture, "sol_bash", { command });
		const text = response.result.content[0].text;
		assert.equal(response.result.isError, true); // exit code 1 propagates
		assert.ok(text.startsWith("sol_zcode_evidence_receipt_v1"), `receipt expected, got: ${text.slice(0, 200)}`);
		assert.ok(text.includes("status=failure"));
		assert.ok(text.includes("verified_evidence:"));
		assert.ok(text.includes("kind=failure"));
		assert.ok(text.includes("quote="));
		assert.ok(text.includes("readback="));
		assert.ok(text.includes("source_artifact="));

		// Original archived under the reducer store.
		const objectsDir = join(fixture.dataDir, "store", "reducer", "objects");
		const buckets = await readdir(objectsDir);
		assert.equal(buckets.length, 1);
		const files = await readdir(join(objectsDir, buckets[0]));
		assert.equal(files.length, 1);
		const archived = await readFile(join(objectsDir, buckets[0], files[0]), "utf8");
		assert.ok(archived.includes("error: boom at main.c:42"));

		// Reducer ledger recorded candidate + applied.
		const ledger = await readFile(join(fixture.dataDir, "store", "ledger", "mcp-direct", "reducer.jsonl"), "utf8");
		assert.ok(ledger.includes('"event":"candidate"'));
		assert.ok(ledger.includes('"event":"applied"'));

		// The subprocess defenses were in force.
		const diagnostics = JSON.parse(await readFile(fixture.diagnosticsPath, "utf8"));
		assert.equal(diagnostics.aux, "1", "SOL_ZCODE_AUX defense");
		assert.equal(
			diagnostics.disallowedTools.split(",").sort().join(","),
			[...BUILTIN_TOOL_NAMES].sort().join(","),
			"--disallowed-tools enumeration",
		);
		assert.notEqual(diagnostics.home, fixture.env.HOME, "isolated HOME");
		assert.ok(diagnostics.home.includes("reducer-home"));
		assert.equal(diagnostics.homeCliConfigExists, true, "isolated home has its own cli config");
		assert.ok(diagnostics.attachBytes > 4096, "log traveled via --attach");
		assert.ok(diagnostics.promptLength < 8192, "prompt stays small (no log inline)");

		// reducer-home cleaned up after the call.
		assert.equal(existsSync(reducerHomePath(fixture.dataDir)), false);
	});
});

test("non-diagnostic or small outputs pass through untouched", async () => {
	await withFixture({ options: { evidenceReducer: true } }, async (fixture) => {
		const response = await mcpCall(fixture, "sol_bash", { command: "printf small-output" });
		assert.equal(response.result.isError, false);
		assert.equal(response.result.content[0].text, "small-output");
		// No reducer ledger written for a non-candidate.
		const ledgerFile = join(fixture.dataDir, "store", "ledger", "mcp-direct", "reducer.jsonl");
		assert.equal(await readFile(ledgerFile, "utf8").then(() => "exists").catch(() => "missing"), "missing");
	});
});

test("fail-open: missing zcode binary returns the original log", async () => {
	await withFixture({ options: { evidenceReducer: true } }, async (fixture) => {
		fixture.env.SOL_ZCODE_ZCODE_BIN = "/nonexistent/zcode-bin";
		const logFile = join(fixture.env.ZCODE_PROJECT_DIR, "log2.txt");
		await writeFile(logFile, `${BIG_LOG}\n`, "utf8");
		const response = await mcpCall(fixture, "sol_bash", { command: `sh -c 'cat "${logFile}"; exit 1'` });
		const text = response.result.content[0].text;
		assert.equal(response.result.isError, true);
		assert.ok(text.includes("error: compilation failed"), "original log returned");
		assert.ok(!text.includes("sol_zcode_evidence_receipt_v1"));
	});
});

test("then_run output reduction keeps the mutation confirmation and replaces only the log body", async () => {
	await withFixture({ options: { actionFusion: true, evidenceReducer: true } }, async (fixture) => {
		const logFile = join(fixture.env.ZCODE_PROJECT_DIR, "log3.txt");
		await writeFile(logFile, `${BIG_LOG}\n`, "utf8");
		const response = await mcpCall(fixture, "sol_write", {
			file_path: "src.c",
			content: "int main(){}\n",
			then_run: { command: `cargo build 2>&1; sh -c 'cat "${logFile}"; exit 1'` },
		});
		assert.equal(response.result.isError, true);
		const text = response.result.content[0].text;
		assert.ok(text.includes("File written successfully"), "mutation confirmation retained");
		const markerIndex = text.indexOf("[then_run:failed]");
		assert.ok(markerIndex > 0);
		assert.ok(text.slice(markerIndex).includes("sol_zcode_evidence_receipt_v1"), "log body replaced by receipt");
		assert.ok(!text.slice(markerIndex).includes("error: boom at main.c:42"), "raw log not echoed after marker");
	});
});

test("validateModelInRegistry rejects unknown provider/model pairs", async () => {
	const config = {
		provider: { "builtin:bigmodel-coding-plan": { models: { "GLM-5.3-Flash": {} } } },
		model: "builtin:bigmodel-coding-plan/GLM-5.3-Flash",
	};
	assert.equal(validateModelInRegistry(config, "builtin:bigmodel-coding-plan/GLM-5.3-Flash").ok, true);
	assert.equal(validateModelInRegistry(config, "builtin:bigmodel-coding-plan/GLM-9.9").ok, false);
	assert.equal(validateModelInRegistry(config, "other-provider/GLM-5.3-Flash").ok, false);
	assert.equal(validateModelInRegistry(config, "not-namespaced").ok, false);
});

test("buildReducerHome copies the provider registry, validates the model, and can be cleaned per call", async () => {
	await withFixture({ options: { evidenceReducer: true } }, async (fixture) => {
		const { home, model } = await buildReducerHome(fixture.dataDir, { reducerModel: "builtin:bigmodel-coding-plan/GLM-5.3", env: fixture.env });
		assert.equal(model, "builtin:bigmodel-coding-plan/GLM-5.3");
		const copied = JSON.parse(await readFile(join(home, ".zcode", "cli", "config.json"), "utf8"));
		assert.ok(copied.provider["builtin:bigmodel-coding-plan"]);
		assert.equal(copied.model, "builtin:bigmodel-coding-plan/GLM-5.3");
		// Unknown reducerModel → explicit fallback reason.
		await assert.rejects(
			buildReducerHome(fixture.dataDir, { reducerModel: "builtin:bigmodel-coding-plan/GLM-NOPE", env: fixture.env }),
			/reducer-model-not-in-registry/,
		);
		await rm(home, { recursive: true, force: true });
	});
});

test("callReducerSubprocess error paths resolve (never reject) with reasons", async () => {
	await withFixture({ options: { evidenceReducer: true } }, async (fixture) => {
		// Spawn of a nonexistent binary resolves ok:false with a spawn error.
		const result = await callReducerSubprocess(fixture.dataDir, {
			command: "cargo build",
			isError: true,
			archive: { hash: "a".repeat(64), bytes: 100, chars: 100, lines: 2, path: "/tmp/x" },
			body: "error: x\n",
			reducerModel: "",
			env: { ...fixture.env, SOL_ZCODE_ZCODE_BIN: "/nonexistent/zcode" },
		});
		assert.equal(result.ok, false);
		assert.ok(result.errorMessage.startsWith("reducer-"), result.errorMessage);

		// Garbage stdout (no JSON) resolves ok:false with a no-response reason.
		const garbageBin = join(fixture.root, "garbage-zcode.cjs");
		await writeFile(garbageBin, "process.stdout.write('not json at all');\n", { encoding: "utf8", mode: 0o755 });
		const result2 = await callReducerSubprocess(fixture.dataDir, {
			command: "cargo build",
			isError: true,
			archive: await archiveBody(join(fixture.dataDir, "store", "reducer"), "error: x\n"),
			body: "error: x\n",
			reducerModel: "",
			env: { ...fixture.env, SOL_ZCODE_ZCODE_BIN: garbageBin },
		});
		assert.equal(result2.ok, false);
		assert.ok(result2.errorMessage.startsWith("reducer-subprocess"), result2.errorMessage);
	});
});
