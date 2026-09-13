#!/usr/bin/env node
/*
 * P2 e2e orchestrator: runs the headless real-model scenarios in sequence,
 * enforces a hard per-scenario wall-clock cap (15 min), aborts on model
 * budget exhaustion, and prints an evidence summary. Every scenario appends
 * its own record to tests/e2e/results/e2e-results.jsonl regardless.
 *
 * Usage:
 *   node tests/e2e/run-e2e.mjs                 # all scenarios, probe order
 *   node tests/e2e/run-e2e.mjs --only s3,s1    # subset
 *   node tests/e2e/run-e2e.mjs --keep          # keep tests/e2e/tmp homes
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertEnvReady, budgetState, E2E_ROOT, MODEL_BUDGET_MAX, recordResult } from "./lib/harness.mjs";

const SCENARIO_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_ORDER = [
	"s3-g9-userprompt", // probe/G9 first: payload intel for the rest
	"s1-edit-equivalence",
	"s8-then-run-fusion", // then_run fused verification loop (audit m5)
	"s4-observation-loop",
	"s2-reducer-adversarial",
	"s7-failopen",
	"s6-alloff-zero",
	"s5-occ-stopblock", // economic trigger verified reachable after P2.5 cumulative estimator — see recorded result
	"s5b-stopblock-channel", // Stop decision:block channel proof (complements s5)
];

const argv = process.argv.slice(2);
const onlyArg = argv.find((arg) => arg.startsWith("--only=")) ?? (argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null);
const onlyFlag = onlyArg === null ? null : onlyArg.replace(/^--only=/, "");
const keep = argv.includes("--keep");
if (keep) process.env.SOL_E2E_KEEP = "1";
const requested = onlyFlag ? onlyFlag.split(",").map((name) => name.trim()).filter(Boolean) : DEFAULT_ORDER;

const modules = {};
for (const id of requested) {
	modules[id] = await import(`./scenarios/${id}.mjs`);
}

assertEnvReady();
console.log(`[e2e] zcode headless real-model suite — model budget cap ${MODEL_BUDGET_MAX} requests`);
console.log(`[e2e] order: ${requested.join(" -> ")}\n`);

const summary = [];
for (const id of requested) {
	const scenario = modules[id];
	const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
	console.log(`=== ${id}: ${scenario.title}`);
	let result;
	let raceTimer = null;
	try {
		result = await Promise.race([
			scenario.run({ deadline }),
			new Promise((_, reject) => {
				raceTimer = setTimeout(() => reject(new Error(`scenario timeout after ${SCENARIO_TIMEOUT_MS / 60000} min`)), SCENARIO_TIMEOUT_MS + 30_000);
			}),
		]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[e2e] ${id} THREW: ${message}`);
		await recordResult(id, { status: "error", title: scenario.title, sessionIds: [], usages: [], reducerCalls: 0, assertions: [{ name: "scenario completed without throwing", pass: false, detail: message }], notes: { error: message } });
		result = { status: "error", assertions: [{ name: "scenario completed without throwing", pass: false, detail: message }], notes: {} };
	} finally {
		clearTimeout(raceTimer);
	}
	const failed = (result.assertions ?? []).filter((entry) => !entry.pass);
	summary.push({ id, status: result.status, failed: failed.length, total: (result.assertions ?? []).length });
	console.log(`--- ${id}: ${result.status.toUpperCase()} (${(result.assertions ?? []).length - failed.length}/${(result.assertions ?? []).length} assertions)`);
	for (const entry of failed) console.log(`    FAIL ${entry.name} :: ${entry.detail}`);
	console.log(`    budget: ${JSON.stringify(budgetState())}\n`);
	if (budgetState().modelRequests + budgetState().reducerCalls > MODEL_BUDGET_MAX) {
		console.error(`[e2e] model budget exceeded — stopping before further scenarios`);
		break;
	}
}

if (!keep) {
	await rm(join(E2E_ROOT, "tmp"), { recursive: true, force: true }).catch(() => undefined);
} else {
	console.log(`[e2e] --keep: scenario homes retained under ${join(E2E_ROOT, "tmp")}`);
}

const totals = budgetState();
console.log("\n================ E2E SUMMARY ================");
for (const row of summary) console.log(`${row.status.toUpperCase().padEnd(5)} ${row.id} (${row.total - row.failed}/${row.total} assertions)`);
console.log(`model requests: ${totals.modelRequests}  reducer calls: ${totals.reducerCalls}  runs: ${totals.runs}`);
console.log(`tokens: input=${totals.inputTokens} output=${totals.outputTokens} cacheRead=${totals.cacheRead} cacheWrite=${totals.cacheWrite}`);
const anyFail = summary.some((row) => row.status !== "pass");
console.log(anyFail ? "RESULT: FAIL" : "RESULT: ALL PASS");
process.exitCode = anyFail ? 1 : 0;
