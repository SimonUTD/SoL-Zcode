/*
 * Opt-in gate unit tests (DESIGN §3): all-off default, per-key fallbacks,
 * aux marker, corrupt/missing config, mtime cache, key discovery.
 */
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, resetConfigCache } from "../../plugin/hooks/lib/config.mjs";

async function withHome(fn) {
	const home = await mkdtemp(join(tmpdir(), "sol-config-"));
	resetConfigCache();
	try {
		return await fn(home, `${home}/.zcode/cli/config.json`);
	} finally {
		resetConfigCache();
		await rm(home, { recursive: true, force: true });
	}
}

async function writeConfig(path, config) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(config), "utf8");
	// Ensure a distinct mtime for every write so the cache re-reads.
	const now = new Date();
	await utimes(path, now, new Date(now.getTime() + Math.floor(Math.random() * 1000) + 1));
}

const BASE = (options) => ({
	provider: { "builtin:bigmodel-coding-plan": { models: { "GLM-5.3-Flash": {} } } },
	model: "builtin:bigmodel-coding-plan/GLM-5.3-Flash",
	plugins: { enabledPlugins: { "sol-zcode@sol-zcode-dev": true }, options },
});

test("missing config file resolves to all-off zero behavior", async () => {
	await withHome(async (home) => {
		const cfg = await resolveConfig({ HOME: home, ZCODE_PLUGIN_ID: "sol-zcode@sol-zcode-dev" });
		assert.equal(cfg.zeroBehavior, true);
		assert.equal(cfg.actionFusion, false);
		assert.equal(cfg.status, "config-missing");
	});
});

test("corrupt config resolves to all-off zero behavior", async () => {
	await withHome(async (home, path) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "{not json", "utf8");
		const cfg = await resolveConfig({ HOME: home, ZCODE_PLUGIN_ID: "sol-zcode@sol-zcode-dev" });
		assert.equal(cfg.zeroBehavior, true);
		assert.equal(cfg.status, "config-corrupt");
	});
});

test("empty options resolve to all-off zero behavior", async () => {
	await withHome(async (home, path) => {
		await writeConfig(path, BASE({}));
		const cfg = await resolveConfig({ HOME: home, ZCODE_PLUGIN_ID: "sol-zcode@sol-zcode-dev" });
		assert.equal(cfg.zeroBehavior, true);
		assert.equal(cfg.status, "no-options");
	});
});

test("SOL_ZCODE_AUX=1 wins over everything (zero behavior)", async () => {
	await withHome(async (home, path) => {
		await writeConfig(path, BASE({ "sol-zcode@sol-zcode-dev": { actionFusion: true, trajectory: true } }));
		const cfg = await resolveConfig({ HOME: home, ZCODE_PLUGIN_ID: "sol-zcode@sol-zcode-dev", SOL_ZCODE_AUX: "1" });
		assert.equal(cfg.status, "aux");
		assert.equal(cfg.zeroBehavior, true);
		assert.equal(cfg.actionFusion, false);
	});
});

test("boolean keys read under the <name>@<marketplace> key", async () => {
	await withHome(async (home, path) => {
		await writeConfig(path, BASE({ "sol-zcode@sol-zcode-dev": { actionFusion: true, observationPack: true } }));
		const cfg = await resolveConfig({ HOME: home, ZCODE_PLUGIN_ID: "sol-zcode@sol-zcode-dev" });
		assert.equal(cfg.actionFusion, true);
		assert.equal(cfg.observationPack, true);
		assert.equal(cfg.evidenceReducer, false);
		assert.equal(cfg.onlineCompact, false);
		assert.equal(cfg.trajectory, false);
		assert.equal(cfg.zeroBehavior, false);
		assert.equal(cfg.key, "sol-zcode@sol-zcode-dev");
	});
});

test("wrong-typed keys fall back to false and are reported", async () => {
	await withHome(async (home, path) => {
		await writeConfig(
			path,
			BASE({ "sol-zcode@sol-zcode-dev": { actionFusion: "yes", trajectory: 1, reducerModel: 42 } }),
		);
		const cfg = await resolveConfig({ HOME: home, ZCODE_PLUGIN_ID: "sol-zcode@sol-zcode-dev" });
		assert.equal(cfg.actionFusion, false);
		assert.equal(cfg.trajectory, false);
		assert.equal(cfg.reducerModel, "");
		assert.deepEqual(cfg.rejectedKeys, ["actionFusion", "trajectory", "reducerModel"]);
		assert.equal(cfg.zeroBehavior, true); // everything fell back to off
	});
});

test("MCP-side key discovery scans the options key domain without ZCODE_PLUGIN_ID", async () => {
	await withHome(async (home, path) => {
		await writeConfig(path, BASE({ "sol-zcode@some-marketplace": { trajectory: true } }));
		const cfg = await resolveConfig({ HOME: home });
		assert.equal(cfg.trajectory, true);
		assert.equal(cfg.key, "sol-zcode@some-marketplace");
	});
});

test("reducerModel string passes through", async () => {
	await withHome(async (home, path) => {
		await writeConfig(
			path,
			BASE({ "sol-zcode@sol-zcode-dev": { evidenceReducer: true, reducerModel: "builtin:bigmodel-coding-plan/GLM-5.3-Flash" } }),
		);
		const cfg = await resolveConfig({ HOME: home, ZCODE_PLUGIN_ID: "sol-zcode@sol-zcode-dev" });
		assert.equal(cfg.reducerModel, "builtin:bigmodel-coding-plan/GLM-5.3-Flash");
	});
});
