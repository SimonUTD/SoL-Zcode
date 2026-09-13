/*
 * Ported from sol-opencode/packages/core/test/compact-economics.test.ts
 * (vitest → node:test, assertions equivalent; toMatchObject → explicit
 * property assertions).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_COMPACTION_ECONOMICS, decideCompaction, estimateRemainingRequests } from "../../plugin/core/compact/economics.mjs";

function decision(overrides = {}) {
	return decideCompaction({
		writeTokens: 80_000,
		archiveTokens: 60_000,
		memoTokens: 1_000,
		contextTokens: 80_000,
		completedBoundaryRequestCounts: [4, 6, 5],
		remainingBoundaries: 4,
		averageContextTokenIncrement: 2_000,
		contextWindowTokens: 200_000,
		priorCompactionCount: 0,
		carriedDebtTokens: 0,
		cacheDebtRepaymentTokens: 0,
		cacheWriteReadRatio: 1,
		economics: DEFAULT_COMPACTION_ECONOMICS,
		...overrides,
	});
}

test("estimates the remaining request horizon from completed boundaries", () => {
	const result = estimateRemainingRequests({
		completedBoundaryRequestCounts: [4, 6, 5],
		remainingBoundaries: 3,
		scale: 1,
		standardDeviationK: 0,
		contextTokens: 100_000,
		contextWindowTokens: 200_000,
		averageContextTokenIncrement: 5_000,
	});
	assert.equal(result.requestsPerBoundaryMean, 5);
	assert.equal(result.expectedRemainingRequests, 16);
	assert.equal(result.windowRequestUpperBound, 20);
});

test("rejects a compaction that cannot remove more than its summary", () => {
	const result = decision({ archiveTokens: 500, memoTokens: 1_000 });
	assert.equal(result.compact, false);
	assert.equal(result.reason, "non_positive_saving");
});

test("compacts when the economic breakeven fits the remaining horizon", () => {
	const result = decision();
	assert.equal(result.compact, true);
	assert.equal(result.reason, "economic");
});

test("uses window protection even when the ordinary economic gate defers", () => {
	const result = decision({
		contextTokens: 195_000,
		cacheWriteReadRatio: 100,
		economics: { ...DEFAULT_COMPACTION_ECONOMICS, windowReserveTokens: 10_000 },
	});
	assert.equal(result.compact, true);
	assert.equal(result.reason, "window_protection");
});

test("defers economic compaction when no cache ratio is available", () => {
	const result = decision({ cacheWriteReadRatio: null });
	assert.equal(result.compact, false);
	assert.equal(result.reason, "cache_ratio_unavailable");
});

test("charges carried debt only after the first compaction", () => {
	const result = decision({
		priorCompactionCount: 1,
		cacheWriteReadRatio: 2,
		carriedDebtTokens: 2_000_000,
	});
	assert.equal(result.compact, false);
	assert.equal(result.reason, "deferred_carried_debt");
	assert.ok(result.combinedBreakevenRequests > (result.breakevenRequests ?? 0));
});
