#!/usr/bin/env node
/*
 * sol-zcode MCP server (stdio).
 *
 * Handshake per GOTCHAS G11 (verified against zcode 0.16.5):
 *   server/discover → {supportedVersions, capabilities:{tools:{}}}
 *   initialize      → {protocolVersion, capabilities, serverInfo}
 *   notifications/initialized → (no reply — never send unsolicited messages)
 *   tools/list      → {tools:[...]}   (empty when all mechanisms are off)
 *   tools/call      → {content:[{type:"text",text}], isError?}
 * One JSON-RPC message per line (NOT LSP Content-Length framing). This server
 * only ever responds to requests; it never writes a message the host did not
 * ask for (the spike-proven failure mode that drops tool registration).
 *
 * Zero behavior guarantees:
 *   - SOL_ZCODE_AUX=1 → tools/list is empty and tools/call refuses everything.
 *   - config missing/corrupt/no options → same. One stderr line is logged.
 */

import { createInterface } from "node:readline";
import { callTool, createToolContext, toolDefinitions } from "./tools.mjs";

const SERVER_INFO = { name: "sol", version: "0.1.0" };
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"];

function writeMessage(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) {
	writeMessage({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
	writeMessage({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

// Serialize tool calls: fused mutations rely on the per-file queue for
// cross-process safety, but in-server serialization also keeps ledger ordering
// deterministic.
let callChain = Promise.resolve();

function enqueueToolCall(handler) {
	const next = callChain.then(handler, handler);
	callChain = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

async function handleRequest(ctxPromise, msg) {
	const { id, method, params } = msg;
	switch (method) {
		case "server/discover":
			return { supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} } };
		case "initialize":
			return {
				protocolVersion: params?.protocolVersion ?? "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: SERVER_INFO,
			};
		case "ping":
			return {};
		case "tools/list": {
			const ctx = await ctxPromise;
			if (ctx.cfg.zeroBehavior) {
				process.stderr.write("[sol-zcode] all mechanisms off (or SOL_ZCODE_AUX set): no tools registered\n");
				return { tools: [] };
			}
			return { tools: toolDefinitions(ctx) };
		}
		case "tools/call": {
			const ctx = await ctxPromise;
			const name = params?.name;
			const args = params?.arguments ?? {};
			if (ctx.cfg.zeroBehavior) {
				return {
					content: [{ type: "text", text: "[sol-zcode] all mechanisms are off; no sol tools are available." }],
					isError: true,
				};
			}
			const allowed = toolDefinitions(ctx).some((tool) => tool.name === name);
			if (!allowed) {
				return { content: [{ type: "text", text: `Tool not available under the current configuration: ${name}` }], isError: true };
			}
			return enqueueToolCall(() => callTool(ctx, name, args));
		}
		default:
			return undefined;
	}
}

async function main() {
	// Context resolves config (mtime-cached) and the session pointer lazily but
	// once per process start; tools/list and tools/call share it.
	const ctxPromise = createToolContext(process.env);
	const rl = createInterface({ input: process.stdin });
	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		let msg;
		try {
			msg = JSON.parse(trimmed);
		} catch (error) {
			process.stderr.write(`[sol-zcode] bad JSON line: ${error instanceof Error ? error.message : String(error)}\n`);
			return;
		}
		if (Array.isArray(msg)) {
			for (const item of msg) {
				void dispatch(ctxPromise, item);
			}
			return;
		}
		void dispatch(ctxPromise, msg);
	});
	rl.on("close", () => {
		process.exitCode = 0;
	});
	process.stderr.write("[sol-zcode] stdio MCP server ready\n");
}

async function dispatch(ctxPromise, msg) {
	if (msg === null || typeof msg !== "object") return;
	const { id, method } = msg;
	if (id === undefined || id === null) return; // notifications get no reply
	if (typeof method !== "string") return;
	try {
		const result = await handleRequest(ctxPromise, msg);
		if (result === undefined) {
			fail(id, -32601, `Method not found: ${method}`);
			return;
		}
		ok(id, result);
	} catch (error) {
		fail(id, -32603, `Internal error: ${error instanceof Error ? error.message : String(error)}`);
	}
}

main().catch((error) => {
	process.stderr.write(`[sol-zcode] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exitCode = 1;
});
