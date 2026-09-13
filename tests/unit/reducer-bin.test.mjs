/*
 * G22: headless zcode.cjs renames its process to "zcode-cli", so the ps sniff
 * cannot locate the host binary — resolveZcodeBin must fall back to probing
 * known install locations before failing open.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { KNOWN_ZCODE_BIN_PATHS, resolveZcodeBin } from "../../plugin/hooks/lib/reducer-subprocess.mjs";

async function withRoot(fn) {
	const root = await mkdtemp(join(tmpdir(), "sol-bin-"));
	try {
		return await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const NO_SNIFF = () => null; // simulate the G22 ps failure deterministically

test("env override SOL_ZCODE_ZCODE_BIN wins over every other source", () => {
	assert.equal(resolveZcodeBin({ SOL_ZCODE_ZCODE_BIN: "/custom/zcode.cjs" }, { sniff: NO_SNIFF }), "/custom/zcode.cjs");
});

test("ps-sniff failure falls back to probing known install locations (G22)", async () => {
	await withRoot(async (root) => {
		const candidate = join(root, "zcode.cjs");
		await writeFile(candidate, "// stub\n", "utf8");
		assert.equal(resolveZcodeBin({}, { sniff: NO_SNIFF, probePaths: [join(root, "missing.cjs"), candidate] }), candidate);
	});
});

test("probes only accept existing regular files; all-miss returns null (fail-open)", async () => {
	await withRoot(async (root) => {
		const dir = join(root, "dir-zcode.cjs");
		await mkdir(dir, { recursive: true });
		assert.equal(resolveZcodeBin({}, { sniff: NO_SNIFF, probePaths: [dir, join(root, "nope.cjs")] }), null);
		assert.equal(resolveZcodeBin({}, { sniff: NO_SNIFF, probePaths: [] }), null);
		assert.equal(resolveZcodeBin({}, { sniff: NO_SNIFF, probePaths: ["/definitely/not/here/zcode.cjs"] }), null);
	});
});

test("a successful ps sniff still takes precedence over the path probes", () => {
	assert.equal(
		resolveZcodeBin({}, { sniff: () => "/from/ps/zcode.cjs", probePaths: ["/probe/zcode.cjs"] }),
		"/from/ps/zcode.cjs",
	);
});

test("KNOWN_ZCODE_BIN_PATHS covers the documented install locations (G1)", () => {
	assert.ok(KNOWN_ZCODE_BIN_PATHS.includes("/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"));
	assert.ok(KNOWN_ZCODE_BIN_PATHS.some((p) => p.startsWith(join(tmpdir())) === false && p.includes("Applications/ZCode.app")));
});

test("live default probes locate the binary on this host without any env override (G22 receipt)", () => {
	// On a machine with ZCode.app installed, the default probe set must find
	// the real binary with the env override unset and ps sniffing neutralized
	// (the exact G22 condition). On hosts without the app this asserts the
	// honest null instead.
	const resolved = resolveZcodeBin({}, { sniff: NO_SNIFF });
	const machineDefaultExists = KNOWN_ZCODE_BIN_PATHS.some((p) => existsSync(p));
	if (machineDefaultExists) {
		assert.ok(typeof resolved === "string" && existsSync(resolved), `expected a real binary, got ${resolved}`);
		assert.ok(KNOWN_ZCODE_BIN_PATHS.includes(resolved));
	} else {
		assert.equal(resolved, null);
	}
});
