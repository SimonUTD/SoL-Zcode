/*
 * MCP server integration tests (DESIGN §6.2): full G11 handshake driven over
 * stdin lines, tool listing under opt-in, tool calls, zero-behavior when all
 * mechanisms are off or SOL_ZCODE_AUX=1, and the never-send-unsolicited rule.
 */
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeEnv, pluginRoot } from "./helpers.mjs";

class McpClient {
	constructor(child) {
		this.child = child;
		this.pending = new Map();
		this.unsolicited = [];
		this.nextId = 0;
		let buffer = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			let index;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (line.trim().length === 0) continue;
				const message = JSON.parse(line);
				if (message.id !== undefined && this.pending.has(message.id)) {
					const { resolve } = this.pending.get(message.id);
					this.pending.delete(message.id);
					resolve(message);
				} else {
					this.unsolicited.push(message);
				}
			}
		});
	}

	request(method, params) {
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}

	notify(method, params) {
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	async end() {
		this.child.stdin.end();
		await new Promise((resolve) => this.child.on("close", resolve));
	}
}

async function withServer(fixture, fn) {
	const child = spawn(process.execPath, [join(pluginRoot(), "mcp", "server.mjs")], {
		env: { ...fixture.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const client = new McpClient(child);
	try {
		await fn(client, fixture);
	} finally {
		await client.end();
		await cleanup(fixture);
	}
}

async function handshake(client) {
	const discover = await client.request("server/discover", { protocol: "2026-07-28" });
	assert.equal(discover.error, undefined);
	assert.ok(Array.isArray(discover.result.supportedVersions));
	assert.ok(discover.result.capabilities.tools !== undefined);
	const init = await client.request("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "test", version: "0" },
	});
	assert.equal(init.error, undefined);
	assert.equal(init.result.serverInfo.name, "sol");
	client.notify("notifications/initialized");
}

test("full handshake: discover → initialize → tools/list returns 5 tools under full opt-in", async () => {
	const fixture = await makeEnv({
		options: { actionFusion: true, observationPack: true, evidenceReducer: true, onlineCompact: true, trajectory: true },
	});
	await withServer(fixture, async (client) => {
		await handshake(client);
		const list = await client.request("tools/list", {});
		assert.equal(list.error, undefined);
		assert.deepEqual(
			list.result.tools.map((tool) => tool.name).sort(),
			["obs_recall", "sol_bash", "sol_edit", "sol_trajectory", "sol_write"],
		);
	});
});

test("mechanism-specific gating: only the enabled mechanisms' tools appear", async () => {
	const fixture = await makeEnv({ options: { trajectory: true } });
	await withServer(fixture, async (client) => {
		await handshake(client);
		const list = await client.request("tools/list", {});
		assert.deepEqual(list.result.tools.map((tool) => tool.name), ["sol_trajectory"]);
	});
});

test("all-off config yields an empty tools/list and refused tools/call (zero behavior)", async () => {
	const fixture = await makeEnv({ options: {} });
	await withServer(fixture, async (client) => {
		await handshake(client);
		const list = await client.request("tools/list", {});
		assert.deepEqual(list.result.tools, []);
		const call = await client.request("tools/call", { name: "sol_write", arguments: {} });
		assert.equal(call.result.isError, true);
	});
});

test("SOL_ZCODE_AUX=1 yields an empty tools/list even with full opt-in", async () => {
	const fixture = await makeEnv({
		options: { actionFusion: true, observationPack: true, evidenceReducer: true, trajectory: true },
	});
	fixture.env.SOL_ZCODE_AUX = "1";
	await withServer(fixture, async (client) => {
		await handshake(client);
		const list = await client.request("tools/list", {});
		assert.deepEqual(list.result.tools, []);
	});
});

test("no unsolicited messages are ever sent (G11)", async () => {
	const fixture = await makeEnv({ options: { trajectory: true } });
	await withServer(fixture, async (client) => {
		await handshake(client);
		await client.request("ping", {});
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.deepEqual(client.unsolicited, []);
	});
});

test("sol_write writes the file and sol_bash big output is packed + recallable byte-for-byte", async () => {
	const fixture = await makeEnv({ options: { actionFusion: true, observationPack: true } });
	await mkdir(join(fixture.env.ZCODE_PROJECT_DIR), { recursive: true });
	await withServer(fixture, async (client, fx) => {
		await handshake(client);

		const write = await client.request("tools/call", {
			name: "sol_write",
			arguments: { file_path: "hello.txt", content: "line1\nline2\n" },
		});
		assert.equal(write.result.isError, false);
		assert.ok(write.result.content[0].text.includes("File written successfully"));
		assert.equal(await readFile(join(fx.env.ZCODE_PROJECT_DIR, "hello.txt"), "utf8"), "line1\nline2\n");

		// 40 KiB of output → placeholder, archive, recall roundtrip.
		const bigBody = Array.from({ length: 900 }, (_v, i) => `out line ${i} ${"y".repeat(30)}\n`).join("");
		const bash = await client.request("tools/call", {
			name: "sol_bash",
			arguments: { command: `cat <<'SOL_EOF'\n${bigBody}SOL_EOF` },
		});
		assert.equal(bash.result.isError, false);
		const text = bash.result.content[0].text;
		assert.ok(text.includes("[large tool result replaced"), "placeholder expected");
		const idMatch = text.match(/id: (obs_[a-f0-9]{24})/);
		assert.notEqual(idMatch, null);
		const id = idMatch[1];

		// Full byte-for-byte restore via paging.
		let offset = 0;
		const parts = [];
		for (;;) {
			const recall = await client.request("tools/call", { name: "obs_recall", arguments: { id, offset } });
			const body = recall.result.content[0].text;
			assert.ok(recall.result.isError === false);
			const header = body.slice(body.lastIndexOf("\n[next_offset="));
		 const chunk = body.slice(0, body.lastIndexOf("\n[next_offset="));
			parts.push(chunk);
			const next = Number(header.match(/next_offset=(\d+)/)[1]);
			const eof = header.includes("eof=true");
			if (eof) break;
			offset = next;
		}
		assert.equal(parts.join(""), bigBody, "recall roundtrip must be byte-for-byte");

		// Literal search.
		const search = await client.request("tools/call", { name: "obs_recall", arguments: { id, query: "out line 500" } });
		assert.ok(search.result.content[0].text.includes("#501"));

		// Ledger side effects exist.
		const ledgerDir = join(fx.dataDir, "store", "ledger");
		const files = await readdir(ledgerDir).catch(() => []);
		assert.ok(files.length > 0);
	});
});

test("sol_write with then_run returns the combined marker contract", async () => {
	const fixture = await makeEnv({ options: { actionFusion: true } });
	await mkdir(join(fixture.env.ZCODE_PROJECT_DIR), { recursive: true });
	await withServer(fixture, async (client) => {
		await handshake(client);
		const success = await client.request("tools/call", {
			name: "sol_write",
			arguments: { file_path: "a.txt", content: "abc\n", then_run: { command: "echo verified" } },
		});
		assert.equal(success.result.isError, false);
		assert.ok(success.result.content[0].text.includes("File written successfully"));
		assert.ok(success.result.content[0].text.includes("[then_run:succeeded]"));
		assert.ok(success.result.content[0].text.includes("verified"));

		const failure = await client.request("tools/call", {
			name: "sol_write",
			arguments: { file_path: "b.txt", content: "def\n", then_run: { command: "sh -c 'exit 3'" } },
		});
		assert.equal(failure.result.isError, true);
		const text = failure.result.content[0].text;
		assert.ok(text.includes("[then_run:failed]"));
		assert.ok(text.includes("exited with code 3"));
		assert.ok(text.includes("File written successfully"), "file-was-applied fact must be stated");
		assert.equal(await readFile(join(fixture.env.ZCODE_PROJECT_DIR, "b.txt"), "utf8"), "def\n");
	});
});

test("sol_trajectory stats/recent answer over the chained trajectory file", async () => {
	const fixture = await makeEnv({ options: { trajectory: true } });
	await mkdir(join(fixture.env.ZCODE_PROJECT_DIR), { recursive: true });
	// Seed a trajectory line the way the hook would.
	const { appendTrajectory } = await import("../../plugin/hooks/lib/store.mjs");
	await appendTrajectory(fixture.dataDir, "sess_mcp-test-1", { event: "session_start", status: "ok" });
	await appendTrajectory(fixture.dataDir, "sess_mcp-test-1", { event: "pre_tool", tool: "Bash", status: "running" });
	// Point the MCP session at this session id.
	const { writeFile: wf } = await import("node:fs/promises");
	const { sessionsDir } = await import("../../plugin/hooks/lib/store.mjs");
	await mkdir(sessionsDir(fixture.dataDir), { recursive: true });
	await wf(
		join(sessionsDir(fixture.dataDir), "sess_mcp-test-1.json"),
		JSON.stringify({ sessionId: "sess_mcp-test-1", cwd: fixture.env.ZCODE_PROJECT_DIR, ts: new Date().toISOString() }),
		"utf8",
	);
	await withServer(fixture, async (client) => {
		await handshake(client);
		const stats = await client.request("tools/call", { name: "sol_trajectory", arguments: { action: "stats" } });
		assert.equal(stats.result.isError, false);
		assert.ok(stats.result.content[0].text.includes("session_start: 1"));
		const recent = await client.request("tools/call", { name: "sol_trajectory", arguments: { action: "recent", n: 1 } });
		assert.ok(recent.result.content[0].text.includes("pre_tool"));
	});
});

test("session attribution refreshes when a pointer appears after server start (m1)", async () => {
	const fixture = await makeEnv({ options: { trajectory: true } });
	await mkdir(join(fixture.env.ZCODE_PROJECT_DIR), { recursive: true });
	// NO pointer file yet when the server spawns — the start-time resolution
	// would stick to the mcp-direct fallback for the whole session.
	await withServer(fixture, async (client, fx) => {
		await handshake(client);
		const direct = await client.request("tools/call", { name: "sol_trajectory", arguments: { action: "stats" } });
		assert.ok(direct.result.content[0].text.includes("No trajectory records"), "mcp-direct: no records yet");

		// The first hook event publishes the pointer (cwd matches the project).
		const { appendTrajectory, sessionsDir } = await import("../../plugin/hooks/lib/store.mjs");
		await appendTrajectory(fx.dataDir, "sess_late-pointer-1", { event: "session_start", status: "ok" });
		await mkdir(sessionsDir(fx.dataDir), { recursive: true });
		await writeFile(
			join(sessionsDir(fx.dataDir), "sess_late-pointer-1.json"),
			JSON.stringify({ sessionId: "sess_late-pointer-1", cwd: fx.env.ZCODE_PROJECT_DIR, ts: new Date().toISOString() }),
			"utf8",
		);

		const attributed = await client.request("tools/call", { name: "sol_trajectory", arguments: { action: "stats" } });
		assert.ok(
			attributed.result.content[0].text.includes("session_start: 1"),
			`later call must attribute to the pointer session, got: ${attributed.result.content[0].text}`,
		);
	});
});

test("unknown method returns JSON-RPC method-not-found", async () => {
	const fixture = await makeEnv({ options: { trajectory: true } });
	await withServer(fixture, async (client) => {
		await handshake(client);
		const response = await client.request("resources/list", {});
		assert.equal(response.error.code, -32601);
	});
});
