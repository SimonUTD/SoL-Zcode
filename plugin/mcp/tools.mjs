/*
 * sol-zcode MCP tool implementations (DESIGN §2).
 *
 * Split from server.mjs so tests can drive the tools in-process. Zero runtime
 * dependencies: node:* only.
 *
 * Tools (gated by plugins.options, DESIGN §3):
 *   sol_write / sol_edit — actionFusion; schema mirrors the built-in
 *     Write/Edit plus an optional then_run {command, timeout?} (seconds).
 *     Mutation semantics replicate the built-ins: unique-match enforcement,
 *     replace_all, read-before-write, path resolution (§2.1).
 *   sol_bash — observationPack || evidenceReducer; executes via /bin/sh -c in
 *     the session cwd, then reducer pipeline, then observation packing.
 *   obs_recall — observationPack; byte paging + literal search.
 *   sol_trajectory — trajectory; metadata-only recent/stats view.
 *
 * Everything is fail-open: a mechanism error never destroys the original
 * output; integrity failures surface as tool error text (C3) while the
 * archived original remains readable.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
	THEN_RUN_FAILED,
	THEN_RUN_SKIPPED,
	THEN_RUN_SUCCEEDED,
	ReceiptCache,
	archiveBody,
	countLines,
	createObservation,
	ensureStored,
	isObservationId,
	loadReducerConfig,
	observationPath,
	placeholderFor,
	receiptText,
	readRecallChunk,
	reducerCacheKey,
	resolveToolPath,
	runThenRun,
	searchObservation,
	validateReceipt,
} from "../core/index.mjs";
import { evaluateReducerGates } from "../core/reducer/policy.mjs";
import { appendChained } from "../hooks/lib/chain.mjs";
import { resolveConfig } from "../hooks/lib/config.mjs";
import { callReducerSubprocess } from "../hooks/lib/reducer-subprocess.mjs";
import {
	dataRoot,
	observationLedgerPath,
	observationRuntimeRoot,
	reducerLedgerPath,
	reducerStoreRoot,
	resolveMcpSession,
} from "../hooks/lib/store.mjs";

export const DEFAULT_COMMAND_VALVE_MS = 600_000; // n3 safety valve (host deadline is set to the same 600s in .mcp.json)
export const RECALL_MAX_BYTES = 16 * 1024;
export const RECALL_MAX_LINES = 400;
export const MAX_QUERY_BYTES = 256;

const receiptCache = new ReceiptCache(64);
let callCounter = 0;

function nextCallId() {
	callCounter += 1;
	return `sol_${callCounter}`;
}

export async function createToolContext(env = process.env) {
	const cfg = await resolveConfig(env);
	const root = dataRoot(env);
	const session = await resolveMcpSession(root, env);
	return { env, cfg, dataRoot: root, session };
}

function ok(text) {
	return { content: [{ type: "text", text }], isError: false };
}

function fail(text) {
	return { content: [{ type: "text", text }], isError: true };
}

export function toolDefinitions(ctx) {
	const tools = [];
	if (ctx.cfg.actionFusion) {
		tools.push({
			name: "sol_write",
			description:
				"Write a file, optionally fused with a follow-up verification command (then_run {command, timeout? in seconds}) executed in the same call once the write lands; returns one combined result. Prefer this over Write when a command should verify the mutation.",
			inputSchema: {
				type: "object",
				properties: {
					file_path: { type: "string", description: "Path of the file to write (absolute, or relative to the session directory)" },
					content: { type: "string", description: "Content to write to the file" },
					then_run: thenRunSchema(),
				},
				required: ["file_path", "content"],
				additionalProperties: false,
			},
		});
		tools.push({
			name: "sol_edit",
			description:
				"Apply exact string replacements to a file, optionally fused with a follow-up verification command (then_run) executed in the same call. Each old_string must match exactly once unless replace_all is true.",
			inputSchema: {
				type: "object",
				properties: {
					file_path: { type: "string", description: "Path of the file to modify" },
					edits: {
						type: "array",
						description: "Ordered list of exact string replacements",
						items: {
							type: "object",
							properties: {
								old_string: { type: "string", description: "Text to replace" },
								new_string: { type: "string", description: "Replacement text (must differ from old_string)" },
								replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
							},
							required: ["old_string", "new_string"],
							additionalProperties: false,
						},
					},
					then_run: thenRunSchema(),
				},
				required: ["file_path", "edits"],
				additionalProperties: false,
			},
		});
	}
	if (ctx.cfg.observationPack || ctx.cfg.evidenceReducer) {
		tools.push({
			name: "sol_bash",
			description:
				"Execute a shell command (/bin/sh -c) in the session directory. Large outputs (>10 KiB) are archived and returned as a compact placeholder with head/tail excerpts — page or literal-search the original with obs_recall. Long failing build/test logs are reduced to a verified evidence receipt (original stays archived).",
			inputSchema: {
				type: "object",
				properties: {
					command: { type: "string", description: "The shell command to execute" },
					timeout: { type: "number", description: "Optional timeout in seconds (hard cap 600s)" },
				},
				required: ["command"],
				additionalProperties: false,
			},
		});
	}
	if (ctx.cfg.observationPack) {
		tools.push({
			name: "obs_recall",
			description:
				"Recall an archived large tool result: {id, offset} pages through the original bytes; {id, query} runs a case-sensitive literal byte search with line numbers.",
			inputSchema: {
				type: "object",
				properties: {
					id: { type: "string", description: "Observation id (obs_<24 hex>)" },
					offset: { type: "number", description: "Byte offset to resume from (default 0)" },
					query: { type: "string", description: "Literal search query (max 256 UTF-8 bytes)" },
				},
				required: ["id"],
				additionalProperties: false,
			},
		});
	}
	if (ctx.cfg.trajectory) {
		tools.push({
			name: "sol_trajectory",
			description: "Show this session's metadata-only trajectory: action=recent returns the last records, action=stats returns aggregate counts. Never contains prompts, arguments or outputs.",
			inputSchema: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["recent", "stats"], description: "recent (default) or stats" },
					n: { type: "number", description: "Number of recent records (default 12)" },
				},
				additionalProperties: false,
			},
		});
	}
	return tools;
}

function thenRunSchema() {
	return {
		type: "object",
		description: "Optional follow-up command run in the same call after the mutation succeeds",
		properties: {
			command: { type: "string", description: "Shell command to run after a successful mutation" },
			timeout: { type: "number", description: "Timeout in seconds (optional; hard cap 600s)" },
		},
		required: ["command"],
		additionalProperties: false,
	};
}

/** Execute a shell command in its own process group; kill the group on timeout. */
export function runShellCommand({ command, timeoutMs = DEFAULT_COMMAND_VALVE_MS, cwd, env = process.env }) {
	return new Promise((resolve, reject) => {
		const child = spawn("/bin/sh", ["-c", command], {
			cwd,
			env: { ...env },
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			reject(new Error(`command timed out after ${Math.round(timeoutMs / 1000)}s`));
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const combined = [stdout, stderr].filter((part) => part.length > 0).join("\n");
			if (code !== 0) {
				reject(new Error(`command exited with code ${code}${combined.length > 0 ? `\n${combined}` : ""}`));
				return;
			}
			resolve(combined);
		});
	});
}

function normalizeThenRun(value) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) return undefined;
	const command = value.command;
	if (typeof command !== "string" || command.length === 0) return undefined;
	const timeout =
		typeof value.timeout === "number" && Number.isFinite(value.timeout) && value.timeout > 0
			? Math.min(value.timeout, DEFAULT_COMMAND_VALVE_MS / 1000)
			: undefined;
	return timeout === undefined ? { command } : { command, timeout };
}

async function runFusedFollowUp(ctx, absolutePath, thenRun) {
	return runThenRun({
		absolutePath,
		thenRun,
		runCommand: (input) =>
			runShellCommand({
				command: input.command,
				timeoutMs: input.timeout === undefined ? DEFAULT_COMMAND_VALVE_MS : Math.min(input.timeout * 1000, DEFAULT_COMMAND_VALVE_MS),
				cwd: ctx.session.cwd,
				env: ctx.env,
			}),
	});
}

/** Evidence reducer pipeline; returns the receipt text or null (fail-open). */
export async function runReducerPipeline(ctx, { command, body, isError, toolCallId }) {
	if (!ctx.cfg.evidenceReducer) return null;
	try {
		const config = loadReducerConfig(ctx.dataRoot, {
			reducerProvider: "zcode-headless",
			reducerModel:
				typeof ctx.cfg.reducerModel === "string" && ctx.cfg.reducerModel.length > 0
					? ctx.cfg.reducerModel
					: "zcode-host-default",
			storeRoot: reducerStoreRoot(ctx.dataRoot),
		});
		const ledger = async (entry) => {
			await appendChained(ctx.dataRoot, reducerLedgerPath(ctx.dataRoot, ctx.session.sessionId), {
				ts: new Date().toISOString(),
				toolCallId,
				...entry,
			}).catch(() => null);
		};

		const gate = evaluateReducerGates(command, body, config);
		if (!gate.eligible) {
			if (gate.reason === "source-over-max-chars" || gate.reason === "likely-secret") {
				await ledger({ event: "fallback", reason: gate.reason, commandSha256: hashOf(command) });
			}
			return null;
		}

		const archive = await archiveBody(config.storeRoot, body);
		await ledger({
			event: "candidate",
			commandSha256: hashOf(command),
			isError,
			sourceSha256: archive.hash,
			sourceBytes: archive.bytes,
			sourceLines: archive.lines,
			sourcePath: archive.path,
		});

		const cacheKey = reducerCacheKey(config, archive.hash, command, isError);
		const cached = receiptCache.get(cacheKey);
		let result = cached;
		if (result === undefined) {
			result = await callReducerSubprocess(ctx.dataRoot, {
				command,
				isError,
				archive,
				body,
				reducerModel: ctx.cfg.reducerModel,
				env: ctx.env,
			});
		}
		if (!result.ok) {
			await ledger({ event: "fallback", sourceSha256: archive.hash, reason: result.errorMessage ?? "model-call-exception" });
			return null;
		}

		const checked = validateReceipt(result.outputText, archive, body, isError);
		if (!checked.ok) {
			receiptCache.delete(cacheKey);
			await ledger({ event: "fallback", sourceSha256: archive.hash, reason: checked.reason });
			return null;
		}

		const receipt = receiptText(command, archive, checked.value, result);
		if (Buffer.byteLength(receipt, "utf8") >= archive.bytes) {
			receiptCache.delete(cacheKey);
			await ledger({ event: "fallback", sourceSha256: archive.hash, reason: "receipt-not-smaller" });
			return null;
		}
		if (cached === undefined) receiptCache.set(cacheKey, result);
		await ledger({
			event: "applied",
			commandSha256: hashOf(command),
			sourceSha256: archive.hash,
			sourceBytes: archive.bytes,
			receiptBytes: Buffer.byteLength(receipt, "utf8"),
			evidenceCount: checked.value.evidence.length,
			uncertain: checked.value.uncertain,
			cacheHit: cached !== undefined,
		});
		return receipt;
	} catch (error) {
		await appendChained(ctx.dataRoot, reducerLedgerPath(ctx.dataRoot, ctx.session.sessionId), {
			ts: new Date().toISOString(),
			toolCallId,
			event: "fallback",
			reason: `pipeline-exception:${error instanceof Error ? error.message : String(error)}`,
		}).catch(() => null);
		return null;
	}
}

function hashOf(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Observation pack stage; returns the (possibly replaced) text. Fail-open. */
export async function applyObservationPack(ctx, { toolName, toolCallId, text }) {
	if (!ctx.cfg.observationPack) return { text, packed: false };
	const ledger = async (entry) => {
		await appendChained(ctx.dataRoot, observationLedgerPath(ctx.dataRoot, ctx.session.sessionId), {
			ts: new Date().toISOString(),
			...entry,
		}).catch(() => null);
	};
	try {
		const observation = createObservation(
			{ toolName, toolCallId, text },
			observationRuntimeRoot(ctx.dataRoot),
		);
		if (observation === undefined) {
			await ledger({ event: "full", tool: toolName, bytes: Buffer.byteLength(text, "utf8"), contentHash: hashOf(text) });
			return { text, packed: false };
		}
		await ensureStored(observation);
		await ledger({
			event: "placeholder",
			id: observation.id,
			tool: toolName,
			contentHash: observation.contentHash,
			bytes: observation.bytes,
			tokens: observation.tokens,
		});
		return { text: placeholderFor(observation), packed: true };
	} catch (error) {
		// fail-open: any archive error returns the full text untouched.
		await ledger({
			event: "full",
			tool: toolName,
			bytes: Buffer.byteLength(text, "utf8"),
			contentHash: hashOf(text),
			fallback: `archive-error:${error instanceof Error ? error.message : String(error)}`,
		});
		return { text, packed: false };
	}
}

/** Compose the fused result text per the §2.1 marker contract. */
function fusedText(mutationResult, outcome) {
	if (outcome.status === "succeeded") {
		return { text: `${mutationResult}\n\n${THEN_RUN_SUCCEEDED}\n${outcome.output}`, isError: false };
	}
	if (outcome.status === "failed") {
		return {
			text: `${mutationResult}\n\n${THEN_RUN_FAILED}\n${outcome.error}\n\nNote: the file mutation above was applied; only the follow-up command failed.`,
			isError: true,
		};
	}
	return { text: `${mutationResult}\n\n${THEN_RUN_SKIPPED} ${outcome.reason}`, isError: false };
}

/**
 * Post-process a fused output for the reducer: the log body is the text after
 * the marker line; the receipt replaces only that section (mutation
 * confirmation retained — upstream candidate semantics).
 */
async function reduceFusedSection(ctx, { command, text, isError, toolCallId }) {
	if (!ctx.cfg.evidenceReducer) return text;
	const marker = isError || text.includes(THEN_RUN_FAILED) ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED;
	const index = text.indexOf(marker);
	if (index < 0) return text;
	const afterMarker = text.indexOf("\n", index + marker.length);
	const splitAt = afterMarker < 0 ? text.length : afterMarker + 1;
	const prefix = text.slice(0, splitAt);
	const body = text.slice(splitAt);
	if (body.length === 0) return text;
	const receipt = await runReducerPipeline(ctx, { command, body, isError, toolCallId });
	return receipt === null ? text : `${prefix}${receipt}`;
}

export async function solWrite(ctx, args) {
	const file_path = args?.file_path;
	const content = args?.content;
	if (typeof file_path !== "string" || file_path.length === 0) return fail("file_path must be a non-empty string");
	if (typeof content !== "string") return fail("content must be a string");
	const thenRun = normalizeThenRun(args?.then_run);
	const absolutePath = resolveToolPath(ctx.session.cwd, file_path);
	const toolCallId = nextCallId();

	let mutationResult;
	try {
		await writeFile(absolutePath, content, { encoding: "utf8" });
		mutationResult = `File written successfully: ${absolutePath} (${Buffer.byteLength(content, "utf8")} bytes, ${countLines(content)} lines)`;
	} catch (error) {
		const message = `Failed to write file: ${error instanceof Error ? error.message : String(error)}`;
		if (thenRun === undefined) return fail(message);
		return fail(`${message}\n\n${THEN_RUN_SKIPPED} mutation failed; command not run`);
	}

	if (thenRun === undefined) return ok(mutationResult);

	const outcome = await runFusedFollowUp(ctx, absolutePath, thenRun);
	const composed = fusedText(mutationResult, outcome);
	let text = composed.text;
	text = await reduceFusedSection(ctx, {
		command: thenRun.command,
		text,
		isError: outcome.status === "failed",
		toolCallId,
	});
	const packed = await applyObservationPack(ctx, { toolName: "sol_write", toolCallId, text });
	return composed.isError ? fail(packed.text) : ok(packed.text);
}

export async function solEdit(ctx, args) {
	const file_path = args?.file_path;
	const edits = args?.edits;
	if (typeof file_path !== "string" || file_path.length === 0) return fail("file_path must be a non-empty string");
	if (!Array.isArray(edits) || edits.length === 0) {
		return fail("edits must be a non-empty array of {old_string, new_string, replace_all?}");
	}
	for (const edit of edits) {
		if (typeof edit !== "object" || edit === null || Array.isArray(edit)) {
			return fail("each edit must be an object {old_string, new_string, replace_all?}");
		}
		if (typeof edit.old_string !== "string" || typeof edit.new_string !== "string") {
			return fail("old_string and new_string must be strings");
		}
		if (edit.replace_all !== undefined && typeof edit.replace_all !== "boolean") {
			return fail("replace_all must be a boolean when provided");
		}
	}
	const thenRun = normalizeThenRun(args?.then_run);
	const absolutePath = resolveToolPath(ctx.session.cwd, file_path);
	const toolCallId = nextCallId();

	let original;
	try {
		original = await readFile(absolutePath, "utf8");
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		const message =
			code === "ENOENT"
				? `File does not exist: ${absolutePath}`
				: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`;
		if (thenRun === undefined) return fail(message);
		return fail(`${message}\n\n${THEN_RUN_SKIPPED} mutation failed; command not run`);
	}

	let content = original;
	for (const edit of edits) {
		const { old_string, new_string, replace_all = false } = edit;
		if (old_string.length === 0) return fail("old_string must not be empty");
		if (old_string === new_string) return fail("old_string and new_string must be different");
		const count = countOccurrences(content, old_string);
		if (count === 0) {
			return fail(
				`String to replace not found in ${absolutePath}. Ensure the string matches exactly, including whitespace and indentation.`,
			);
		}
		if (count > 1 && !replace_all) {
			return fail(`Found ${count} matches of old_string in ${absolutePath}. Provide a unique string or set replace_all=true.`);
		}
		content = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
	}
	if (content === original) return fail("Edit produced no changes");

	let mutationResult;
	try {
		await writeFile(absolutePath, content, { encoding: "utf8" });
		mutationResult = `Applied ${edits.length} edit(s) to ${absolutePath} successfully.`;
	} catch (error) {
		const message = `Failed to write file: ${error instanceof Error ? error.message : String(error)}`;
		if (thenRun === undefined) return fail(message);
		return fail(`${message}\n\n${THEN_RUN_SKIPPED} mutation failed; command not run`);
	}

	if (thenRun === undefined) return ok(mutationResult);

	const outcome = await runFusedFollowUp(ctx, absolutePath, thenRun);
	const composed = fusedText(mutationResult, outcome);
	let text = composed.text;
	text = await reduceFusedSection(ctx, {
		command: thenRun.command,
		text,
		isError: outcome.status === "failed",
		toolCallId,
	});
	const packed = await applyObservationPack(ctx, { toolName: "sol_edit", toolCallId, text });
	return composed.isError ? fail(packed.text) : ok(packed.text);
}

function countOccurrences(haystack, needle) {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index >= 0) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

export async function solBash(ctx, args) {
	const command = args?.command;
	if (typeof command !== "string" || command.length === 0) return fail("command must be a non-empty string");
	const timeoutSeconds =
		typeof args?.timeout === "number" && Number.isFinite(args.timeout) && args.timeout > 0
			? Math.min(args.timeout, DEFAULT_COMMAND_VALVE_MS / 1000)
			: undefined;
	const toolCallId = nextCallId();

	let combined;
	let isError = false;
	try {
		combined = await runShellCommand({
			command,
			timeoutMs: timeoutSeconds === undefined ? DEFAULT_COMMAND_VALVE_MS : timeoutSeconds * 1000,
			cwd: ctx.session.cwd,
			env: ctx.env,
		});
	} catch (error) {
		isError = true;
		combined = error instanceof Error ? error.message : String(error);
	}

	let text = combined;
	const receipt = await runReducerPipeline(ctx, { command, body: text, isError, toolCallId });
	if (receipt !== null) text = receipt;

	const packed = await applyObservationPack(ctx, { toolName: "sol_bash", toolCallId, text });
	return isError ? fail(packed.text) : ok(packed.text);
}

function formatSearch(result) {
	if (result.matches.length === 0) {
		return `No matches (eof=${result.eof}, next_offset=${result.nextOffset}).`;
	}
	const body = result.matches.map((match) => `#${match.line} @${match.byteOffset}: ${match.context}`).join("\n---\n");
	return `${body}\n[next_offset=${result.nextOffset} eof=${result.eof}]`;
}

export async function obsRecall(ctx, args) {
	const id = args?.id;
	if (typeof id !== "string" || !isObservationId(id)) return ok("Invalid observation id.");
	const offset =
		typeof args?.offset === "number" && Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
	const query = typeof args?.query === "string" && args.query.length > 0 ? args.query : undefined;
	const path = observationPath(observationRuntimeRoot(ctx.dataRoot), id);
	const ledger = async (entry) => {
		await appendChained(ctx.dataRoot, observationLedgerPath(ctx.dataRoot, ctx.session.sessionId), {
			ts: new Date().toISOString(),
			...entry,
		}).catch(() => null);
	};
	try {
		if (query !== undefined) {
			const bytes = Buffer.from(query, "utf8");
			if (bytes.length > MAX_QUERY_BYTES) return ok(`Query must be at most ${MAX_QUERY_BYTES} UTF-8 bytes.`);
			const result = await searchObservation(path, bytes, offset, RECALL_MAX_BYTES, undefined);
			await ledger({ event: "search", id, offset, matches: result.matches.length, eof: result.eof });
			return ok(formatSearch(result));
		}
		const chunk = await readRecallChunk(path, offset, { maxBytes: RECALL_MAX_BYTES, maxLines: RECALL_MAX_LINES });
		await ledger({ event: "recall", id, offset, nextOffset: chunk.nextOffset, eof: chunk.eof });
		return ok(`${chunk.text}\n[next_offset=${chunk.nextOffset} eof=${chunk.eof}]`);
	} catch (error) {
		return ok(`obs_recall failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function solTrajectory(ctx, args) {
	const action = args?.action === "stats" ? "stats" : "recent";
	const { readTrajectoryTail, trajectoryPath } = await import("../hooks/lib/store.mjs");
	if (action === "recent") {
		const limit = typeof args?.n === "number" && args.n > 0 ? Math.floor(args.n) : 12;
		const records = await readTrajectoryTail(ctx.dataRoot, ctx.session.sessionId, limit);
		if (records.length === 0) return ok("No trajectory records for this session.");
		return ok(
			records
				.map((record) => {
					const detail = record.detail === undefined ? "" : ` ${record.detail}`;
					const bytes = record.bytes === undefined ? "" : ` bytes=${record.bytes}`;
					return `${record.seq ?? "-"} ${record.ts ?? ""} ${record.status ?? "info"} ${record.event ?? "event"}${record.tool ? ` tool=${record.tool}` : ""}${detail}${bytes} hash=${String(record.hash ?? "").slice(0, 12)}`;
				})
				.join("\n"),
		);
	}
	try {
		const raw = await readFile(trajectoryPath(ctx.dataRoot, ctx.session.sessionId), "utf8");
		const lines = raw.split("\n").filter((line) => line.trim().length > 0);
		const counts = new Map();
		let first = null;
		let last = null;
		for (const line of lines) {
			try {
				const obj = JSON.parse(line);
				const event = typeof obj.event === "string" ? obj.event : "unknown";
				counts.set(event, (counts.get(event) ?? 0) + 1);
				if (first === null && typeof obj.ts === "string") first = obj.ts;
				if (typeof obj.ts === "string") last = obj.ts;
			} catch {
				// skip unparsable
			}
		}
		if (lines.length === 0) return ok("No trajectory records for this session.");
		const body = [...counts.entries()].map(([event, count]) => `${event}: ${count}`).join("\n");
		return ok(`records: ${lines.length}\nfirst_ts: ${first ?? "-"}\nlast_ts: ${last ?? "-"}\n${body}`);
	} catch {
		return ok("No trajectory records for this session.");
	}
}

export async function callTool(ctx, name, args) {
	switch (name) {
		case "sol_write":
			return solWrite(ctx, args);
		case "sol_edit":
			return solEdit(ctx, args);
		case "sol_bash":
			return solBash(ctx, args);
		case "obs_recall":
			return obsRecall(ctx, args);
		case "sol_trajectory":
			return solTrajectory(ctx, args);
		default:
			return fail(`Unknown tool: ${name}`);
	}
}

export function resetCallCounterForTests() {
	callCounter = 0;
}
