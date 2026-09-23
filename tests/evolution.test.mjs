import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY,
  MAX_PROBES_PER_CANDIDATE,
  allocateBudget,
  buildCandidates,
  decideChampion,
  runEvolutionCycle,
} from "../src/evolution.js";

test("budget allocation is deterministic, integer, bounded, and conserves the full budget", () => {
  const weights = { boundary: 50, sequence: 25, concurrency: 15, reduction: 10 };
  const first = allocateBudget(weights, 37);
  const second = allocateBudget(weights, 37);

  assert.deepEqual(first, second);
  assert.equal(Object.values(first).reduce((sum, value) => sum + value, 0), 37);
  assert.ok(Object.values(first).every(Number.isInteger));
  assert.ok(Object.values(first).every((value) => value >= 0));
});

test("five candidates are reproducible per generation and change across generations", () => {
  const options = { seed: "2026-09-23" };
  const dayOne = buildCandidates(DEFAULT_POLICY, { generation: 1, ...options });
  const repeat = buildCandidates(DEFAULT_POLICY, { generation: 1, ...options });
  const dayTwo = buildCandidates(DEFAULT_POLICY, { generation: 2, ...options });

  assert.equal(dayOne.length, 5);
  assert.deepEqual(dayOne, repeat);
  assert.notDeepEqual(dayOne, dayTwo);
  for (const candidate of dayOne) {
    assert.equal(Object.values(candidate.weights).reduce((sum, value) => sum + value, 0), 100);
    assert.ok(Object.values(candidate.weights).every((value) => value >= 5 && value <= 50));
  }
});

test("candidate weights stay within fifty percent so each split retains operator diversity", () => {
  const candidates = buildCandidates({
    ...DEFAULT_POLICY,
    weights: { boundary: 70, sequence: 10, concurrency: 10, reduction: 10 },
  }, { generation: 2, seed: "bounded-policy" });

  assert.ok(candidates.every((candidate) => Object.values(candidate.weights).every((value) => value >= 5 && value <= 50)));
  assert.ok(candidates.every((candidate) => Object.values(candidate.weights).reduce((sum, value) => sum + value, 0) === 100));
});

test("the exploit candidate reallocates weight from historically weak to productive operators", () => {
  const candidates = buildCandidates(DEFAULT_POLICY, {
    generation: 4,
    seed: "history-feedback",
    recentHistory: [{
      operatorStats: {
        boundary: { probes: 10, value: 50 },
        sequence: { probes: 10, value: 30 },
        concurrency: { probes: 10, value: 0 },
        reduction: { probes: 10, value: 10 },
      },
    }],
  });

  assert.ok(candidates[0].weights.boundary > DEFAULT_POLICY.weights.boundary);
  assert.ok(candidates[0].weights.concurrency < DEFAULT_POLICY.weights.concurrency);
});

test("champion selection rejects regression failures, holdout regressions, and ties", () => {
  const decision = decideChampion(
    { id: "current", score: 50, holdoutScore: 40 },
    [
      { id: "regression-fail", score: 99, holdoutScore: 99, regressionPassed: 9, regressionTotal: 10 },
      { id: "holdout-fail", score: 90, holdoutScore: 39, regressionPassed: 10, regressionTotal: 10 },
      { id: "tie", score: 50, holdoutScore: 40, regressionPassed: 10, regressionTotal: 10 },
      { id: "winner", score: 60, holdoutScore: 41, regressionPassed: 10, regressionTotal: 10 },
    ],
  );

  assert.equal(decision.promoted, true);
  assert.equal(decision.champion.id, "winner");
  assert.deepEqual(decision.rejections.map(({ id }) => id), ["regression-fail", "holdout-fail", "tie"]);
});

test("an evolution cycle retains known specimens and enforces the fixed per-candidate budget", () => {
  const knownSpecimens = ["coupon-negative-value", "zero-width-recipient"];
  const result = runEvolutionCycle({
    policy: DEFAULT_POLICY,
    generation: 1,
    seed: "2026-09-23",
    knownSpecimens,
  });

  assert.equal(result.candidates.length, 5);
  assert.ok(result.branchesTotal > 0);
  assert.ok(result.branchesCovered <= result.branchesTotal);
  assert.ok(result.candidates.every(({ probes }) => probes <= MAX_PROBES_PER_CANDIDATE));
  assert.ok(result.regressionTotal >= knownSpecimens.length);
  assert.ok(result.regressionTotal >= 3, "the golden regression corpus is never empty");
  assert.equal(result.regressionPassed, result.regressionTotal);
  for (const specimenId of knownSpecimens) assert.ok(result.regressionSpecimens.includes(specimenId));
  assert.ok(["promoted", "rejected"].includes(result.decision));
});

test("each generation contributes stable but novel inputs and advances evidence-backed rule versions", () => {
  const first = runEvolutionCycle({ policy: DEFAULT_POLICY, generation: 1, seed: "2026-09-23" });
  const next = runEvolutionCycle({ policy: first.champion.policy, generation: 2, seed: "2026-09-24" });
  const firstSignatures = first.testedCases.map(({ signature }) => signature);
  const nextSignatures = next.testedCases.map(({ signature }) => signature);

  assert.ok(first.testedCases.length > 0);
  assert.equal(new Set(firstSignatures).size, firstSignatures.length);
  assert.notDeepEqual(firstSignatures, nextSignatures);
  assert.ok(first.testCasesAdded > 0);
  assert.ok(first.recommendationRules.length > 0);
  assert.ok(first.champion.policy.boundaryLibraryVersion > DEFAULT_POLICY.boundaryLibraryVersion);
  assert.ok(first.champion.policy.recommendationRulesVersion > DEFAULT_POLICY.recommendationRulesVersion);
});

test("generation-one strategy evaluations are paired and can promote a guarded improvement", () => {
  const options = {
    policy: DEFAULT_POLICY,
    generation: 1,
    seed: "2026-09-23:g1",
  };
  const result = runEvolutionCycle(options);
  const repeat = runEvolutionCycle(options);

  assert.deepEqual(repeat.baseline, result.baseline);
  assert.deepEqual(repeat.candidates.map(({ score, holdoutScore }) => ({ score, holdoutScore })),
    result.candidates.map(({ score, holdoutScore }) => ({ score, holdoutScore })));
  assert.ok(result.candidates.every((candidate) => candidate.probes === MAX_PROBES_PER_CANDIDATE));
  assert.ok(result.candidates.some((candidate) =>
    candidate.score > result.baseline.score && candidate.holdoutScore >= result.baseline.holdoutScore));
  assert.equal(result.decision, "promoted");
});

test("each generation evaluates a deterministic but changing training and holdout window", () => {
  const results = Array.from({ length: 7 }, (_, index) => runEvolutionCycle({
    policy: DEFAULT_POLICY,
    generation: index + 1,
    seed: `2026-09-${String(23 + index).padStart(2, "0")}:g${index + 1}`,
  }));
  const trainingScores = new Set(results.map(({ baseline }) => baseline.score));
  const holdoutScores = new Set(results.map(({ baseline }) => baseline.holdoutScore));

  assert.ok(trainingScores.size > 1, "training should explore changing deterministic windows across generations");
  assert.ok(holdoutScores.size > 1, "the independent holdout window should change across generations too");
});
