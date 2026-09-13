#!/usr/bin/env node
/**
 * Test runner for the sol-zcode P1 acceptance gate.
 *
 * Node v25 changed `--test` argument handling: bare directory names are
 * treated as module entry points (`node --test tests/unit tests/integration`
 * fails with "Cannot find module"). This wrapper expands the test trees to
 * explicit glob arguments, which is the supported form:
 *
 *   node scripts/run-tests.mjs           # unit + integration
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = [
	"--test",
	join(root, "tests", "unit", "**", "*.test.mjs"),
	join(root, "tests", "integration", "**", "*.test.mjs"),
];
const child = spawn(process.execPath, args, { stdio: "inherit", cwd: root });
child.on("close", (code) => {
	process.exitCode = code ?? 1;
});
