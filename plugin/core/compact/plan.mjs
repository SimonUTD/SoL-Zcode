/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Vendored from @alicekk/sol-opencode-core (sol-opencode/packages/core/src/compact/plan.ts)
 * into sol-zcode as ESM JavaScript with type erasure only; algorithm and
 * constants are unchanged. Adapter-visible deviation: none.
 */

export const PLAN_STATUSES = ["pending", "in_progress", "completed"];

const MAX_PLAN_STEPS = 128;
const MAX_PLAN_STRING_BYTES = 16_384;

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value) {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_PLAN_STRING_BYTES;
}

function isPlanStatus(value) {
	return PLAN_STATUSES.some((status) => status === value);
}

export function parsePlanSteps(value) {
	if (!Array.isArray(value) || value.length > MAX_PLAN_STEPS) return undefined;
	const steps = [];
	for (const item of value) {
		if (
			!isRecord(item) ||
			Object.keys(item).length !== 3 ||
			!isBoundedString(item.id) ||
			!isBoundedString(item.goal) ||
			!isPlanStatus(item.status)
		) {
			return undefined;
		}
		steps.push({ id: item.id, goal: item.goal, status: item.status });
	}
	if (new Set(steps.map((step) => step.id)).size !== steps.length) return undefined;
	return steps;
}

export function analyzePlanTransition(previous, next) {
	const previousById = new Map(previous.map((step) => [step.id, step]));
	const completedSteps = [];
	const advice = [];

	for (const step of next) {
		const prior = previousById.get(step.id);
		if ((!prior || prior.status !== "completed") && step.status === "completed") completedSteps.push(step);
		if (prior && prior.goal !== step.goal) {
			advice.push(`Plan step ${JSON.stringify(step.id)} changed goal; reuse an id only for the same goal.`);
		}
	}

	const inProgress = next.filter((step) => step.status === "in_progress").length;
	if (inProgress > 1) advice.push("Keep at most one plan step in_progress.");
	if (inProgress === 0 && next.some((step) => step.status === "pending")) {
		advice.push("Mark one pending plan step in_progress before starting it.");
	}

	return { completedSteps, advice };
}

export function formatPlanSnapshot(steps) {
	return `<sol-pi-plan task_status="active">${JSON.stringify({ steps })}</sol-pi-plan>`;
}
