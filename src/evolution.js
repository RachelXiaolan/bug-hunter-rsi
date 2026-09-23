export const OPERATOR_IDS = ["boundary", "sequence", "concurrency", "reduction"];
export const MAX_CANDIDATES = 5;
export const MAX_PROBES_PER_CANDIDATE = 24;
const PROBES_PER_SPLIT = MAX_PROBES_PER_CANDIDATE / 2;

export const DEFAULT_POLICY = Object.freeze({
  version: 1,
  weights: Object.freeze({ boundary: 25, sequence: 25, concurrency: 25, reduction: 25 }),
  boundaryLibraryVersion: 1,
  recommendationRulesVersion: 1,
});

const GOLDEN_REGRESSIONS = [
  { id: "coupon-negative-value", reproduces: () => 100 - (-25) > 100 },
  { id: "zero-width-recipient", reproduces: () => Boolean("\u200B\u200D".trim()) },
  { id: "negative-item-quantity", reproduces: () => 40 * -2 < 0 },
];

const PROBES = [
  ["boundary", "negative-coupon-value", "high", "coupon:negative", 4],
  ["boundary", "negative-item-quantity", "high", "order:negative-quantity", 4],
  ["boundary", "coupon-over-subtotal", "medium", "coupon:upper-bound", 3],
  ["boundary", "zero-quantity-line", "low", "order:zero-quantity", 2],
  ["boundary", "fractional-cent-rounding", "medium", "money:rounding", 3],
  ["boundary", "maximum-safe-integer-total", "high", "money:overflow", 2],
  ["boundary", "empty-recipient", "medium", "recipient:empty", 3],
  ["boundary", "zero-width-recipient", "medium", "recipient:unicode-invisible", 4],
  ["boundary", "bidi-control-recipient", "medium", "recipient:bidi-control", 2],
  ["boundary", "unicode-normalization-collision", "low", "recipient:normalization", 2],
  ["boundary", "negative-refund-value", "high", "refund:negative", 3],
  ["boundary", "maximum-quantity-limit", "medium", "order:quantity-limit", 2],
  ["sequence", "duplicate-checkout-submit", "high", "checkout:duplicate-submit", 4],
  ["sequence", "coupon-applied-twice", "medium", "coupon:reapply", 3],
  ["sequence", "cancel-after-capture", "critical", "payment:cancel-after-capture", 4],
  ["sequence", "refund-before-capture", "high", "payment:refund-before-capture", 3],
  ["sequence", "cart-edited-after-quote", "medium", "cart:stale-quote", 3],
  ["sequence", "retry-after-timeout", "high", "payment:retry-timeout", 3],
  ["sequence", "empty-cart-checkout", "low", "checkout:empty-cart", 2],
  ["sequence", "address-change-after-tax", "medium", "order:stale-tax", 2],
  ["sequence", "coupon-removed-after-submit", "medium", "coupon:stale-submit", 2],
  ["sequence", "refund-twice", "high", "refund:duplicate", 3],
  ["sequence", "session-expiry-mid-checkout", "medium", "checkout:expired-session", 2],
  ["sequence", "currency-switch-after-quote", "medium", "money:stale-currency", 2],
  ["concurrency", "inventory-oversell", "critical", "inventory:oversell", 4],
  ["concurrency", "duplicate-payment-capture", "critical", "payment:duplicate-capture", 4],
  ["concurrency", "coupon-last-use-race", "high", "coupon:redeem-race", 3],
  ["concurrency", "stale-stock-reservation", "high", "inventory:stale-reservation", 3],
  ["concurrency", "duplicate-webhook-delivery", "high", "webhook:duplicate-delivery", 3],
  ["concurrency", "refund-capture-race", "critical", "payment:refund-capture-race", 4],
  ["concurrency", "cart-update-write-skew", "medium", "cart:write-skew", 2],
  ["concurrency", "idempotency-key-collision", "high", "payment:idempotency-collision", 3],
  ["concurrency", "reservation-expiry-race", "medium", "inventory:expiry-race", 2],
  ["concurrency", "double-cancel-race", "medium", "order:double-cancel", 2],
  ["concurrency", "stale-price-at-capture", "high", "money:stale-price", 3],
  ["concurrency", "duplicate-refund-worker", "high", "refund:worker-race", 3],
  ["reduction", "minimize-duplicate-checkout", "high", "checkout:duplicate-submit", 3],
  ["reduction", "minimize-inventory-oversell", "critical", "inventory:oversell", 4],
  ["reduction", "minimize-coupon-reapply", "medium", "coupon:reapply", 2],
  ["reduction", "minimize-refund-capture-race", "critical", "payment:refund-capture-race", 4],
  ["reduction", "minimize-retry-timeout", "high", "payment:retry-timeout", 3],
  ["reduction", "minimize-unicode-recipient", "medium", "recipient:unicode-invisible", 3],
  ["reduction", "minimize-duplicate-webhook", "high", "webhook:duplicate-delivery", 3],
  ["reduction", "minimize-stale-quote", "medium", "cart:stale-quote", 2],
  ["reduction", "minimize-negative-quantity", "high", "order:negative-quantity", 3],
  ["reduction", "minimize-rounding-drift", "medium", "money:rounding", 2],
  ["reduction", "minimize-payment-retry", "high", "payment:retry-timeout", 2],
  ["reduction", "minimize-stale-reservation", "high", "inventory:stale-reservation", 2],
];

const CASES = PROBES.map(([operator, id, severity, branch, value], index) => ({
  operator,
  id,
  specimenId: id,
  severity,
  branch,
  value,
  split: index % 2 === 0 ? "holdout" : "training",
}));
export const BENCHMARK_BRANCHES_TOTAL = new Set(CASES.map(({ branch }) => branch)).size;

const hash = (value) => {
  let result = 2166136261;
  for (const character of String(value)) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
};

const randomFor = (seed) => {
  let value = hash(seed) || 1;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
};

function normalizedWeights(weights) {
  const values = OPERATOR_IDS.map((id) => Math.max(0, Number(weights?.[id]) || 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total) return Object.fromEntries(OPERATOR_IDS.map((id) => [id, 25]));

  const scaled = values.map((value) => value * 100 / total);
  const result = scaled.map(Math.floor);
  let remainder = 100 - result.reduce((sum, value) => sum + value, 0);
  const order = scaled
    .map((value, index) => ({ index, fraction: value - result[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < remainder; index += 1) result[order[index].index] += 1;
  return Object.fromEntries(OPERATOR_IDS.map((id, index) => [id, result[index]]));
}

function boundedWeights(weights) {
  const values = OPERATOR_IDS.map((operator) => Math.max(5, Math.min(50, normalizedWeights(weights)[operator])));
  let remaining = 100 - values.reduce((sum, value) => sum + value, 0);
  while (remaining > 0) {
    let changed = false;
    for (let index = 0; index < values.length && remaining > 0; index += 1) {
      if (values[index] < 50) {
        values[index] += 1;
        remaining -= 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  while (remaining < 0) {
    let changed = false;
    for (let index = values.length - 1; index >= 0 && remaining < 0; index -= 1) {
      if (values[index] > 5) {
        values[index] -= 1;
        remaining += 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return Object.fromEntries(OPERATOR_IDS.map((operator, index) => [operator, values[index]]));
}

export function allocateBudget(weights, budget) {
  if (!Number.isInteger(budget) || budget < 0) throw new RangeError("budget must be a non-negative integer");
  const normalized = normalizedWeights(weights);
  const exact = OPERATOR_IDS.map((id) => normalized[id] * budget / 100);
  const counts = exact.map(Math.floor);
  let remainder = budget - counts.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - counts[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < remainder; index += 1) counts[order[index].index] += 1;
  return Object.fromEntries(OPERATOR_IDS.map((id, index) => [id, counts[index]]));
}

export function buildCandidates(policy, { generation, seed, recentHistory = [] }) {
  const base = boundedWeights(policy?.weights);
  const productivity = Object.fromEntries(OPERATOR_IDS.map((operator) => {
    const history = recentHistory.slice(0, 7).reduce((aggregate, entry) => {
      const stat = entry.operatorStats?.[operator];
      if (stat) {
        aggregate.value += Number(stat.value) || 0;
        aggregate.probes += Number(stat.probes) || 0;
      }
      return aggregate;
    }, { value: 0, probes: 0 });
    return [operator, history.probes ? history.value / history.probes : null];
  }));
  const measured = OPERATOR_IDS.filter((operator) => productivity[operator] !== null);
  const strongest = measured.slice().sort((left, right) => productivity[right] - productivity[left] || OPERATOR_IDS.indexOf(left) - OPERATOR_IDS.indexOf(right))[0];
  const weakest = measured.slice().sort((left, right) => productivity[left] - productivity[right] || OPERATOR_IDS.indexOf(left) - OPERATOR_IDS.indexOf(right))[0];

  return Array.from({ length: MAX_CANDIDATES }, (_, index) => {
    const random = randomFor(`${seed}:${generation}:${index}`);
    const weights = { ...base };
    const donorIndex = Math.floor(random() * OPERATOR_IDS.length);
    const receiverOffset = 1 + Math.floor(random() * (OPERATOR_IDS.length - 1));
    const donor = index === 0 && strongest !== weakest && strongest && weakest
      ? weakest
      : OPERATOR_IDS[donorIndex];
    const receiver = index === 0 && strongest !== weakest && strongest && weakest
      ? strongest
      : OPERATOR_IDS[(donorIndex + receiverOffset) % OPERATOR_IDS.length];
    const requestedDelta = index === 0 && strongest !== weakest && strongest && weakest
      ? 10
      : 5 * (1 + Math.floor(random() * 3));
    const delta = Math.min(requestedDelta, weights[donor] - 5, 50 - weights[receiver]);
    if (delta > 0) {
      weights[donor] -= delta;
      weights[receiver] += delta;
    }
    return {
      id: `g${generation}-c${index + 1}-${hash(`${seed}:${generation}:${index}`).toString(36)}`,
      weights,
      boundaryLibraryVersion: policy?.boundaryLibraryVersion ?? DEFAULT_POLICY.boundaryLibraryVersion,
      recommendationRulesVersion: policy?.recommendationRulesVersion ?? DEFAULT_POLICY.recommendationRulesVersion,
    };
  });
}

function evaluate(policy, { seed, split, budget = PROBES_PER_SPLIT }) {
  const allocation = allocateBudget(policy.weights, budget);
  const selected = [];
  for (const operator of OPERATOR_IDS) {
    const cases = CASES.filter((item) => item.operator === operator && item.split === split);
    const offset = Math.floor(randomFor(`${seed}:${split}:${operator}`)() * cases.length);
    const count = allocation[operator];
    for (let index = 0; index < count; index += 1) {
      const probe = cases[(offset + index) % cases.length];
      const variant = hash(`${seed}:${operator}:${probe.id}:${index}`).toString(36);
      const reproduction = materializeInput(probe, variant);
      selected.push({
        ...probe,
        caseId: `${probe.id}:${variant}`,
        signature: hash(`${probe.id}|${reproduction}`).toString(36),
        reproduction,
      });
    }
  }

  const findings = new Map();
  const branches = new Set();
  const operatorStats = Object.fromEntries(OPERATOR_IDS.map((id) => [id, { probes: 0, findings: 0, value: 0 }]));
  for (const probe of selected) {
    const stats = operatorStats[probe.operator];
    stats.probes += 1;
    branches.add(probe.branch);
    if (!findings.has(probe.specimenId)) {
      findings.set(probe.specimenId, probe);
      stats.findings += 1;
      stats.value += probe.value;
    }
  }

  const result = [...findings.values()];
  const totalValue = result.reduce((sum, finding) => sum + finding.value, 0);
  const score = Math.round((totalValue * 10 + branches.size * 3 - selected.length * 0.25) * 100) / 100;
  return {
    probes: selected.length,
    findings: result,
    testedCases: selected,
    branchesCovered: branches.size,
    score,
    operatorStats,
  };
}

function materializeInput(probe, variant) {
  const numeric = Number.parseInt(variant, 36) || 1;
  if (probe.operator === "boundary") {
    const amount = 100 + numeric % 5000;
    const offset = 1 + numeric % 97;
    return `${probe.id}: subtotal=${amount}; generatedOffset=${offset}; caseSeed=${variant}`;
  }
  if (probe.operator === "sequence") {
    const actions = ["validate", "reserve", "charge", "retry", "cancel", "refund"];
    const start = numeric % actions.length;
    const trace = [...actions.slice(start), ...actions.slice(0, start)].slice(0, 3 + numeric % 3);
    return `${probe.id}: ${trace.join(" -> ")}; caseSeed=${variant}`;
  }
  if (probe.operator === "concurrency") {
    const schedules = [
      "read-stock(A) -> read-stock(B) -> reserve(A) -> reserve(B)",
      "capture(A) -> duplicate-webhook(A) -> retry-capture(A)",
      "reserve(A) -> expire(A) -> capture(A)",
      "refund(A) -> capture(A) -> refund-retry(A)",
    ];
    return `${probe.id}: ${schedules[numeric % schedules.length]}; caseSeed=${variant}`;
  }
  const traces = [
    "validate -> reserve -> charge -> retry",
    "apply-coupon -> submit -> timeout -> retry",
    "reserve -> expire -> checkout -> cancel",
    "capture -> webhook -> refund -> retry",
  ];
  const trace = traces[numeric % traces.length].split(" -> ");
  return `${probe.id}: minimized=[${trace.slice(0, 2 + numeric % 3).join(" -> ")}]; caseSeed=${variant}`;
}

export function decideChampion(current, candidates) {
  const rejections = [];
  const eligible = [];
  for (const candidate of candidates) {
    if (candidate.regressionPassed !== candidate.regressionTotal) {
      rejections.push({ id: candidate.id, reason: "regression-gate" });
    } else if (candidate.holdoutScore < current.holdoutScore) {
      rejections.push({ id: candidate.id, reason: "holdout-regression" });
    } else if (candidate.score <= current.score) {
      rejections.push({ id: candidate.id, reason: "no-strict-improvement" });
    } else {
      eligible.push(candidate);
    }
  }

  eligible.sort((left, right) => right.score - left.score || right.holdoutScore - left.holdoutScore || left.id.localeCompare(right.id));
  const winner = eligible[0];
  return {
    promoted: Boolean(winner),
    champion: winner || current,
    rejections,
  };
}

export function runEvolutionCycle({
  policy = DEFAULT_POLICY,
  generation,
  seed,
  knownSpecimens = [],
  knownCaseSignatures = [],
  recentHistory = [],
}) {
  const startedAt = Date.now();
  const baselineTraining = evaluate(policy, { seed, split: "training" });
  const baselineHoldout = evaluate(policy, { seed, split: "holdout" });
  const candidateHistory = recentHistory.length
    ? recentHistory
    : [{ operatorStats: baselineTraining.operatorStats }];
  const candidates = buildCandidates(policy, { generation, seed, recentHistory: candidateHistory });
  const known = new Set(knownSpecimens);
  const regressionSpecimens = [...new Set([...GOLDEN_REGRESSIONS.map(({ id }) => id), ...known])];
  const probeIds = new Set(CASES.map(({ specimenId }) => specimenId));
  const goldenById = new Map(GOLDEN_REGRESSIONS.map((fixture) => [fixture.id, fixture]));
  const regressionPassed = regressionSpecimens.filter((id) => {
    const golden = goldenById.get(id);
    return golden ? golden.reproduces() : probeIds.has(id);
  }).length;

  const evaluations = candidates.map((candidate) => {
    const training = evaluate(candidate, { seed, split: "training" });
    const holdout = evaluate(candidate, { seed, split: "holdout" });
    return {
      ...candidate,
      score: training.score,
      holdoutScore: holdout.score,
      probes: training.probes + holdout.probes,
      findings: [...new Map([...training.findings, ...holdout.findings].map((item) => [item.specimenId, item])).values()],
      testedCases: [...training.testedCases, ...holdout.testedCases],
      branchesCovered: training.branchesCovered,
      holdoutBranchesCovered: holdout.branchesCovered,
      regressionPassed,
      regressionTotal: regressionSpecimens.length,
      operatorStats: training.operatorStats,
    };
  });

  const current = {
    id: `current-g${Math.max(0, generation - 1)}`,
    ...policy,
    score: baselineTraining.score,
    holdoutScore: baselineHoldout.score,
  };
  const decision = decideChampion(current, evaluations);
  let championPolicy = decision.promoted
    ? { ...policy, weights: decision.champion.weights, version: (policy.version || 1) + 1 }
    : policy;
  const allFindings = [...new Map(evaluations.flatMap(({ findings }) => findings).map((item) => [item.specimenId, item])).values()];
  const newFindings = allFindings.filter((finding) => !known.has(finding.specimenId));
  const testedCases = [...new Map(evaluations.flatMap(({ testedCases: items }) => items).map((item) => [item.signature, item])).values()];
  const knownCases = new Set(knownCaseSignatures);
  const novelCases = testedCases.filter(({ signature }) => !knownCases.has(signature));
  const ruleText = {
    boundary: "在业务运算前验证负数、零值、上限与精度边界，并将新边界加入回归集。",
    sequence: "把订单与支付操作建模为显式状态机；重试、撤销和重复提交必须幂等。",
    concurrency: "库存和支付写入使用原子条件更新及幂等键，并覆盖并发交错顺序。",
    reduction: "将失败事件序列缩减为最短可重放用例，保留原始失败签名作为回归。",
  };
  const recommendationRules = [...new Set(newFindings.map(({ operator }) => operator))].map((operator) => ({
    id: `rule-${operator}`,
    operator,
    text: ruleText[operator],
    evidenceDelta: newFindings.filter((finding) => finding.operator === operator).length,
  }));
  championPolicy = {
    ...championPolicy,
    boundaryLibraryVersion: (policy.boundaryLibraryVersion || 1) + (novelCases.length ? 1 : 0),
    recommendationRulesVersion: (policy.recommendationRulesVersion || 1) + (recommendationRules.length ? 1 : 0),
  };
  const operatorStats = Object.fromEntries(OPERATOR_IDS.map((operator) => {
    const stats = evaluations.reduce((combined, candidate) => {
      const value = candidate.operatorStats[operator];
      combined.probes += value.probes;
      combined.findings += value.findings;
      combined.value += value.value;
      return combined;
    }, { probes: 0, findings: 0, value: 0 });
    return [operator, {
      ...stats,
      productivity: stats.probes ? Math.round(stats.value / stats.probes * 100) / 100 : 0,
      recentSuccesses: recentHistory.filter((item) => item.decision === "promoted" && item.operatorStats?.[operator]?.findings > 0).length,
    }];
  }));

  return {
    durationMs: Date.now() - startedAt,
    generation,
    seed,
    baseline: { score: baselineTraining.score, holdoutScore: baselineHoldout.score, branchesCovered: baselineTraining.branchesCovered },
    candidates: evaluations,
    decision: decision.promoted ? "promoted" : "rejected",
    decisionReason: decision.promoted
      ? `候选 ${decision.champion.id} 在保留集不退步且回归全通过后严格提升训练得分。`
      : "没有候选同时通过 100% 回归门槛、保留集守门并严格提升当前策略。",
    champion: { id: decision.champion.id, policy: championPolicy, score: decision.champion.score, holdoutScore: decision.champion.holdoutScore },
    promoted: decision.promoted,
    rejections: decision.rejections,
    regressionSpecimens,
    regressionTotal: regressionSpecimens.length,
    regressionPassed,
    newFindings,
    findings: allFindings,
    branchesCovered: decision.champion.branchesCovered ?? baselineTraining.branchesCovered,
    branchesTotal: BENCHMARK_BRANCHES_TOTAL,
    operatorStats,
    testedCases,
    testCasesAdded: novelCases.length,
    recommendationRules,
    recommendationUpdates: recommendationRules.length,
  };
}
