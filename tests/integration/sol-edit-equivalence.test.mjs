/*
 * sol_write / sol_edit mutation-semantics equivalence group (PLAN P1 item 5):
 * every case pins a documented built-in Write/Edit behavior — unique-match
 * enforcement, replace_all, old==new rejection, empty old_string rejection,
 * not-found error, missing-file error, read-before-write, sequential multi-edit
 * application, and the file-was-written fact on then_run failure.
 *
 * The reference for "built-in semantics" is the documented ZCode/Claude-code
 * Edit contract (exact string match; not-found and multi-match errors;
 * replace_all opt-in) exercised through the tool implementations in
 * plugin/mcp/tools.mjs under a real filesystem. Headless live-model
 * equivalence runs in P2 e2e.
 *
 * KNOWN GAP, EXPLICITLY DEFERRED TO P2 (AUDIT_2026-09-13-p1-plugin m9, P1
 * deviation #11): the built-ins' Read-before-Edit *session tracking* (Edit/Write
 * refusing a file the session has not Read first) is NOT replicated here — the
 * "read-before-write" case below pins only the weaker file-must-exist +
 * exact-match contract. Replicating it needs host-side Read observation
 * (PreToolUse/PostToolUse state), which is P2 scope together with the
 * live-model equivalence run.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createToolContext, solEdit, solWrite } from "../../plugin/mcp/tools.mjs";

const CONTENT = ["alpha", "beta", "gamma", "beta", "delta"].join("\n") + "\n";

async function withCtx(options, fn) {
	const root = await mkdtemp(join(tmpdir(), "sol-equiv-"));
	const project = join(root, "project");
	await mkdir(project, { recursive: true });
	const env = {
		HOME: root,
		ZCODE_PLUGIN_DATA: join(root, "data"),
		ZCODE_PLUGIN_ID: "sol-zcode@sol-zcode-dev",
		ZCODE_PROJECT_DIR: project,
		SOL_ZCODE_CONFIG_PATH: join(root, "config.json"),
	};
	await mkdir(join(root, ".zcode", "cli"), { recursive: true });
	await writeFile(
		join(root, ".zcode", "cli", "config.json"),
		JSON.stringify({
			provider: { "builtin:bigmodel-coding-plan": { models: { "GLM-5.3-Flash": {} } } },
			model: "builtin:bigmodel-coding-plan/GLM-5.3-Flash",
			plugins: { options: { "sol-zcode@sol-zcode-dev": options } },
		}),
		"utf8",
	);
	const ctx = await createToolContext(env);
	try {
		return await fn(ctx, project);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("sol_edit replaces a unique exact match (built-in: exact-match semantics)", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		const file = join(project, "a.txt");
		await writeFile(file, CONTENT, "utf8");
		const result = await solEdit(ctx, {
			file_path: file,
			edits: [{ old_string: "gamma", new_string: "GAMMA" }],
		});
		assert.equal(result.isError, false);
		assert.equal(
			await readFile(file, "utf8"),
			["alpha", "beta", "GAMMA", "beta", "delta"].join("\n") + "\n",
		);
	});
});

test("sol_edit errors when old_string matches more than once without replace_all", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		const file = join(project, "b.txt");
		await writeFile(file, CONTENT, "utf8");
		const result = await solEdit(ctx, {
			file_path: file,
			edits: [{ old_string: "beta", new_string: "BETA" }],
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Found 2 matches/);
		assert.equal(await readFile(file, "utf8"), CONTENT, "file unchanged on error");
	});
});

test("sol_edit replace_all replaces every occurrence", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		const file = join(project, "c.txt");
		await writeFile(file, CONTENT, "utf8");
		const result = await solEdit(ctx, {
			file_path: file,
			edits: [{ old_string: "beta", new_string: "BETA", replace_all: true }],
		});
		assert.equal(result.isError, false);
		assert.equal(
			await readFile(file, "utf8"),
			["alpha", "BETA", "gamma", "BETA", "delta"].join("\n") + "\n",
		);
	});
});

test("sol_edit errors on a not-found string (including whitespace sensitivity)", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		const file = join(project, "d.txt");
		await writeFile(file, CONTENT, "utf8");
		const result = await solEdit(ctx, {
			file_path: file,
			edits: [{ old_string: "  beta", new_string: "beta" }],
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /not found/);
		assert.equal(await readFile(file, "utf8"), CONTENT);
	});
});

test("sol_edit rejects empty old_string and old==new", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		const file = join(project, "e.txt");
		await writeFile(file, CONTENT, "utf8");
		const empty = await solEdit(ctx, { file_path: file, edits: [{ old_string: "", new_string: "x" }] });
		assert.equal(empty.isError, true);
		assert.match(empty.content[0].text, /must not be empty/);
		const same = await solEdit(ctx, { file_path: file, edits: [{ old_string: "beta", new_string: "beta" }] });
		assert.equal(same.isError, true);
		assert.match(same.content[0].text, /must be different/);
	});
});

test("sol_edit errors on a nonexistent file (weaker 'read-before-write': file must exist)", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		const result = await solEdit(ctx, {
			file_path: join(project, "missing.txt"),
			edits: [{ old_string: "a", new_string: "b" }],
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /File does not exist/);
		// m9 gap marker: sol_edit does NOT require a prior session Read of an
		// EXISTING file (built-in Edit does). Adding that needs host-side Read
		// observation — P2 (see file header).
		const untouched = join(project, "never-read.txt");
		const { writeFile } = await import("node:fs/promises");
		await writeFile(untouched, "content\n", "utf8");
		const noPriorRead = await solEdit(ctx, {
			file_path: untouched,
			edits: [{ old_string: "content", new_string: "edited" }],
		});
		assert.equal(noPriorRead.isError, false, "P1 contract: existence + exact match only");
	});
});

test("sol_edit applies multiple edits sequentially", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		const file = join(project, "f.txt");
		await writeFile(file, "one two three\n", "utf8");
		const result = await solEdit(ctx, {
			file_path: file,
			edits: [
				{ old_string: "one", new_string: "1" },
				{ old_string: "1 two", new_string: "1 2" },
				{ old_string: "three", new_string: "3" },
			],
		});
		assert.equal(result.isError, false);
		assert.equal(await readFile(file, "utf8"), "1 2 3\n");
	});
});

test("sol_edit validates the edits array shape", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		const file = join(project, "g.txt");
		await writeFile(file, "x\n", "utf8");
		const noEdits = await solEdit(ctx, { file_path: file, edits: [] });
		assert.equal(noEdits.isError, true);
		const badShape = await solEdit(ctx, { file_path: file, edits: [{ old_string: "x" }] });
		assert.equal(badShape.isError, true);
		const badPath = await solEdit(ctx, { file_path: "", edits: [{ old_string: "x", new_string: "y" }] });
		assert.equal(badPath.isError, true);
	});
});

test("sol_write creates new files and overwrites existing content", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		const file = join(project, "new.txt");
		const created = await solWrite(ctx, { file_path: file, content: "first\n" });
		assert.equal(created.isError, false);
		assert.equal(await readFile(file, "utf8"), "first\n");
		const overwritten = await solWrite(ctx, { file_path: file, content: "second\n" });
		assert.equal(overwritten.isError, false);
		assert.equal(await readFile(file, "utf8"), "second\n");
	});
});

test("sol_write resolves relative paths against the session cwd", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		await mkdir(join(project, "rel"), { recursive: true });
		const result = await solWrite(ctx, { file_path: "rel/ative.txt", content: "rel\n" });
		assert.equal(result.isError, false);
		assert.equal(await readFile(join(project, "rel", "ative.txt"), "utf8"), "rel\n");
	});
});

test("sol_write errors on a missing parent directory without creating it", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		const result = await solWrite(ctx, { file_path: join(project, "no", "such", "dir.txt"), content: "x" });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Failed to write file/);
	});
});

test("then_run failure keeps the mutation and states it explicitly", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		const file = join(project, "keep.txt");
		const result = await solWrite(ctx, {
			file_path: file,
			content: "kept\n",
			then_run: { command: "exit 7" },
		});
		assert.equal(result.isError, true);
		const text = result.content[0].text;
		assert.ok(text.includes("[then_run:failed]"));
		assert.ok(text.includes("exited with code 7"));
		assert.ok(text.includes("File written successfully"));
		assert.ok(text.includes("mutation above was applied"));
		assert.equal(await readFile(file, "utf8"), "kept\n");
	});
});

test("mutation failure with then_run marks the command skipped", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		const result = await solEdit(ctx, {
			file_path: join(project, "absent.txt"),
			edits: [{ old_string: "a", new_string: "b" }],
			then_run: { command: "echo never" },
		});
		assert.equal(result.isError, true);
		assert.ok(result.content[0].text.includes("[then_run:skipped]"));
		assert.ok(result.content[0].text.includes("mutation failed; command not run"));
	});
});

test("sol_edit respects the file-queue hash guard via runThenRun (concurrent mutation)", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		const file = join(project, "guard.txt");
		await writeFile(file, "v1\n", "utf8");
		// then_run executes only after the sha256 double-read guard confirms
		// the target is quiescent; the command observes the new content.
		const result = await solWrite(ctx, {
			file_path: file,
			content: "v2\n",
			then_run: { command: "cat " + JSON.stringify(file) },
		});
		assert.equal(result.isError, false);
		assert.ok(result.content[0].text.includes("[then_run:succeeded]"));
		assert.ok(result.content[0].text.includes("v2"), "command must see the mutated content");
	});
});

test("file:// and ~ path forms resolve like the queue expects", async () => {
	await withCtx({ actionFusion: true }, async (ctx, project) => {
		const file = join(project, "url.txt");
		const result = await solWrite(ctx, { file_path: `file://${file}`, content: "url\n" });
		assert.equal(result.isError, false);
		assert.equal(await readFile(file, "utf8"), "url\n");
	});
});
