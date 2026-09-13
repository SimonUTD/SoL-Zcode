/*
 * Ported from sol-opencode/packages/core/test/compact-plan.test.ts
 * (vitest → node:test, assertions equivalent).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { analyzePlanTransition, formatPlanSnapshot, parsePlanSteps } from "../../plugin/core/compact/plan.mjs";

const OPEN = [{ id: "build", goal: "build it", status: "in_progress" }];
const DONE = [{ id: "build", goal: "build it", status: "completed" }];

test("accepts stored empty plans and rejects malformed plans", () => {
	assert.deepEqual(parsePlanSteps([]), []);
	assert.equal(parsePlanSteps([{ goal: "missing id", status: "pending" }]), undefined);
	assert.equal(parsePlanSteps([{ id: "x", goal: "x", status: "unknown" }]), undefined);
	assert.equal(
		parsePlanSteps([
			{ id: "x", goal: "a", status: "pending" },
			{ id: "x", goal: "b", status: "pending" },
		]),
		undefined,
	);
	assert.deepEqual(parsePlanSteps(OPEN), OPEN);
});

test("detects only new transitions into completed", () => {
	assert.deepEqual(analyzePlanTransition(OPEN, DONE).completedSteps, DONE);
	assert.deepEqual(analyzePlanTransition(DONE, DONE).completedSteps, []);
});

test("flags ambiguous active work and reused ids with changed goals", () => {
	const transition = analyzePlanTransition(
		[{ id: "a", goal: "old", status: "in_progress" }],
		[
			{ id: "a", goal: "new", status: "in_progress" },
			{ id: "b", goal: "second", status: "in_progress" },
		],
	);
	assert.ok(transition.advice.join("\n").includes("changed goal"));
	assert.ok(transition.advice.join("\n").includes("at most one"));
});

test("formats a compact progress-only snapshot", () => {
	const snapshot = formatPlanSnapshot(OPEN);
	assert.ok(snapshot.includes('<sol-pi-plan task_status="active">'));
	assert.ok(snapshot.includes(JSON.stringify({ steps: OPEN })));
});
