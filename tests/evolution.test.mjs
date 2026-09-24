import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PLAYBOOK, LIMITS, clonePlaybook } from "../src/config.js";
import { applyReflection, evolve, fitPriors, fitWeights, splitSamples } from "../src/evolution.js";

function sample(index, overrides = {}) {
  const merge = index % 2 === 0;
  return {
    id: `opp-${index}`,
    reward: merge ? 1 : -0.5,
    profile: "internal-app",
    type: merge ? "accuracy" : "ux-ui",
    playbookVersion: 1,
    features: { externalMergeRate: merge ? 0.9 : 0.1, responsiveness: 0.5, activity: 0.5, helpWanted: 0.2, openIssueLoad: 0.3, popularity: merge ? 0.2 : 0.9, testsPresent: 1, contributingGuide: 0 },
    ...overrides,
  };
}

test("no evidence, no evolution", () => {
  const result = evolve({ champion: clonePlaybook(), samples: [sample(0), sample(1)], nextVersion: 2 });
  assert.equal(result.decision, "insufficient-evidence");
  assert.equal(result.candidate, undefined);
});

test("train and holdout never overlap", () => {
  const { train, holdout } = splitSamples(Array.from({ length: 30 }, (_, index) => sample(index)));
  assert.equal(train.length + holdout.length, 30);
  assert.ok(holdout.length > 0 && train.length > 0);
  assert.equal(train.filter((item) => holdout.includes(item)).length, 0);
});

test("weights move toward features that predict good outcomes", () => {
  const samples = Array.from({ length: 20 }, (_, index) => sample(index));
  const weights = fitWeights(samples);
  assert.ok(weights.externalMergeRate > DEFAULT_PLAYBOOK.repoSelection.weights.externalMergeRate);
  assert.ok(weights.popularity < DEFAULT_PLAYBOOK.repoSelection.weights.popularity);
});

test("type priors follow what actually worked for that profile", () => {
  const priors = fitPriors(Array.from({ length: 20 }, (_, index) => sample(index)));
  assert.ok(priors["internal-app"].accuracy > DEFAULT_PLAYBOOK.opportunityPriors["internal-app"].accuracy);
  assert.ok(priors["internal-app"]["ux-ui"] < DEFAULT_PLAYBOOK.opportunityPriors["internal-app"]["ux-ui"]);
});

test("a candidate that ranks past winners higher is promoted with a readable diff", () => {
  const champion = clonePlaybook();
  champion.repoSelection.weights = { ...champion.repoSelection.weights, externalMergeRate: -1, popularity: 1 };
  champion.opportunityPriors["internal-app"] = { ...champion.opportunityPriors["internal-app"], accuracy: 0.01, "ux-ui": 0.6 };
  const result = evolve({ champion, samples: Array.from({ length: 30 }, (_, index) => sample(index)), nextVersion: 2 });
  assert.equal(result.decision, "promoted");
  assert.ok(result.metrics.candidateScore > result.metrics.championScore);
  assert.ok(result.diff.some((change) => change.area === "挑仓库"));
  assert.ok(result.diff.some((change) => change.area === "挑方向"));
});

test("lessons without real evidence are discarded", () => {
  const lessons = applyReflection(clonePlaybook(), {
    add: [
      { kind: "pr", text: "有据可查", evidence: ["opp-1"] },
      { kind: "pr", text: "凭空想象", evidence: ["opp-999"] },
    ],
    retire: ["seed-small-pr"],
  }, [sample(1)], 2);
  assert.ok(lessons.some((lesson) => lesson.text === "有据可查"));
  assert.ok(!lessons.some((lesson) => lesson.text === "凭空想象"));
  assert.ok(!lessons.some((lesson) => lesson.id === "seed-small-pr"));
});

test("challenger that wins online replaces the champion", () => {
  const champion = { ...clonePlaybook(), version: 1 };
  const challenger = { ...clonePlaybook(), version: 2 };
  const samples = [
    ...Array.from({ length: LIMITS.challengerMinSamples }, (_, index) => sample(index, { id: `c-${index}`, playbookVersion: 1, reward: 0 })),
    ...Array.from({ length: LIMITS.challengerMinSamples }, (_, index) => sample(index, { id: `n-${index}`, playbookVersion: 2, reward: 1 })),
  ];
  assert.equal(evolve({ champion, challenger, samples, nextVersion: 3 }).decision, "challenger-promoted");
  const early = evolve({ champion, challenger, samples: samples.slice(1), nextVersion: 3 });
  assert.equal(early.decision, "challenger-testing");
  assert.equal(early.candidate, undefined, "no new branches while an A/B test is running");
});
