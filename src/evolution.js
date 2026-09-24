import { DEFAULT_PLAYBOOK, LIMITS, REPO_FEATURES, clonePlaybook } from "./config.js";
import { opportunityPrior, scoreRepo } from "./scout.js";

const round3 = (value) => Math.round(value * 1000) / 1000;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const FEATURE_KEYS = Object.keys(REPO_FEATURES);

export function isHoldout(id) {
  let hash = 2166136261;
  for (const char of String(id)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash % 3 === 0;
}

export function splitSamples(samples) {
  const train = [];
  const holdout = [];
  for (const sample of samples) (isHoldout(sample.id) ? holdout : train).push(sample);
  return { train, holdout };
}

// Ridge regression of reward on repo features, anchored at the seed weights so that
// a handful of samples cannot swing the policy to extremes.
// The anchor is worth `priorSamples` observations, so it fades as evidence accumulates.
export function fitWeights(samples, anchor = DEFAULT_PLAYBOOK.repoSelection.weights, { priorSamples = 5, steps = 400, rate = 0.1 } = {}) {
  const weights = { ...anchor };
  if (!samples.length) return weights;
  const lambda = priorSamples / samples.length;
  let bias = mean(samples.map((sample) => sample.reward));
  for (let step = 0; step < steps; step += 1) {
    const gradient = Object.fromEntries(FEATURE_KEYS.map((key) => [key, lambda * (weights[key] - Number(anchor[key] || 0))]));
    let biasGradient = 0;
    for (const sample of samples) {
      const error = bias + scoreRepo(sample.features, weights) - sample.reward;
      biasGradient += error / samples.length;
      for (const key of FEATURE_KEYS) gradient[key] += 2 * error * Number(sample.features?.[key] || 0) / samples.length;
    }
    bias -= rate * biasGradient;
    for (const key of FEATURE_KEYS) weights[key] = Math.max(-2, Math.min(2, weights[key] - rate * gradient[key]));
  }
  return Object.fromEntries(FEATURE_KEYS.map((key) => [key, round3(weights[key])]));
}

// Seed priors re-weighted by the smoothed success rate of each (profile, type) cell.
export function fitPriors(samples, seed = DEFAULT_PLAYBOOK.opportunityPriors) {
  const priors = JSON.parse(JSON.stringify(seed));
  const cells = new Map();
  for (const sample of samples) {
    const key = `${sample.profile}|${sample.type}`;
    const cell = cells.get(key) || { wins: 0, total: 0 };
    cell.total += 1;
    if (sample.reward > 0) cell.wins += 1;
    cells.set(key, cell);
  }
  for (const [key, cell] of cells) {
    const [profile, type] = key.split("|");
    priors[profile] ||= { ...seed.general };
    const factor = ((cell.wins + 1) / (cell.total + 2)) / 0.5;
    priors[profile][type] = Number(priors[profile][type] ?? 0.1) * factor;
  }
  for (const row of Object.values(priors)) {
    const sum = Object.values(row).reduce((total, value) => total + value, 0) || 1;
    for (const type of Object.keys(row)) row[type] = round3(row[type] / sum);
  }
  return priors;
}

// Offline replay: had we ranked these settled opportunities with this playbook,
// how good would the top half have been?
export function replayScore(playbook, samples) {
  if (!samples.length) return 0;
  const ranked = samples
    .map((sample) => ({
      reward: sample.reward,
      score: scoreRepo(sample.features, playbook.repoSelection.weights) / 4 + opportunityPrior(playbook, sample.profile, sample.type),
    }))
    .sort((a, b) => b.score - a.score);
  return round3(mean(ranked.slice(0, Math.ceil(ranked.length / 2)).map((item) => item.reward)));
}

export function describeDiff(before, after) {
  const changes = [];
  for (const key of FEATURE_KEYS) {
    const from = Number(before.repoSelection.weights[key] || 0);
    const to = Number(after.repoSelection.weights[key] || 0);
    if (Math.abs(to - from) >= 0.05) changes.push({ area: "挑仓库", key, from: round3(from), to: round3(to) });
  }
  for (const [profile, row] of Object.entries(after.opportunityPriors)) {
    for (const [type, to] of Object.entries(row)) {
      const from = Number(before.opportunityPriors?.[profile]?.[type] ?? 0);
      if (Math.abs(to - from) >= 0.03) changes.push({ area: "挑方向", key: `${profile}→${type}`, from: round3(from), to: round3(to) });
    }
  }
  const beforeIds = new Set(before.lessons.map((lesson) => lesson.id));
  const afterIds = new Set(after.lessons.map((lesson) => lesson.id));
  for (const lesson of after.lessons) if (!beforeIds.has(lesson.id)) changes.push({ area: lesson.kind === "pr" ? "写 PR" : "找和修", key: "新增经验", to: lesson.text });
  for (const lesson of before.lessons) if (!afterIds.has(lesson.id)) changes.push({ area: lesson.kind === "pr" ? "写 PR" : "找和修", key: "淘汰经验", from: lesson.text });
  return changes;
}

export function reflectionPrompt(samples, playbook) {
  const system = [
    "You are the self-improvement module of Bug Hunter, a bot that finds and fixes issues in GitHub repositories.",
    "Study settled outcomes and propose lessons that would change how it hunts, fixes, or writes PRs next time.",
    "Every lesson must cite the ids of at least one outcome that supports it. Retire existing lessons contradicted by evidence.",
    "Return JSON only: {\"add\":[{\"kind\":\"hunting|pr|selection\",\"text\":\"...\",\"evidence\":[\"id\"]}],\"retire\":[\"lessonId\"]}. At most 3 additions. Write text in Chinese.",
  ].join("\n");
  const user = [
    `Current lessons: ${JSON.stringify(playbook.lessons.map(({ id, kind, text }) => ({ id, kind, text })))}`,
    "Settled outcomes:",
    ...samples.slice(0, 40).map((sample) => JSON.stringify({
      id: sample.id, repo: sample.repo, profile: sample.profile, type: sample.type, title: sample.title,
      status: sample.status, outcome: sample.outcome, team: sample.teamVerdict, reward: sample.reward, note: sample.note,
    })),
  ].join("\n");
  return { system, user };
}

export function applyReflection(playbook, reflection, samples, nextVersion) {
  const known = new Set(samples.map((sample) => sample.id));
  const retire = new Set((reflection?.retire || []).map(String));
  const lessons = playbook.lessons.filter((lesson) => !retire.has(lesson.id));
  const additions = (Array.isArray(reflection?.add) ? reflection.add : [])
    .filter((item) => ["hunting", "pr", "selection"].includes(item?.kind) && typeof item.text === "string")
    .map((item) => ({ ...item, evidence: (item.evidence || []).map(String).filter((id) => known.has(id)) }))
    .filter((item) => item.evidence.length > 0)
    .slice(0, 3)
    .map((item, index) => ({ id: `v${nextVersion}-l${index + 1}`, kind: item.kind, text: item.text.slice(0, 200), evidence: item.evidence, source: "reflection" }));
  const merged = [...lessons, ...additions];
  while (merged.length > LIMITS.maxLessons) {
    const weakest = merged.reduce((low, lesson, index) => lesson.evidence.length < merged[low].evidence.length ? index : low, 0);
    merged.splice(weakest, 1);
  }
  return merged;
}

export function armStats(samples, version) {
  const rewards = samples.filter((sample) => sample.playbookVersion === version).map((sample) => sample.reward);
  return { n: rewards.length, mean: round3(mean(rewards)) };
}

// One evolution step. Pure: the caller persists the decision and assigns the version.
export function evolve({ champion, challenger = null, samples, reflection = null, nextVersion }) {
  const settled = samples.filter((sample) => typeof sample.reward === "number");
  const metrics = { settled: settled.length };

  if (challenger) {
    const champ = armStats(settled, champion.version);
    const chall = armStats(settled, challenger.version);
    metrics.online = { champion: champ, challenger: chall };
    if (chall.n >= LIMITS.challengerMinSamples && champ.n >= LIMITS.challengerMinSamples) {
      if (chall.mean > champ.mean + LIMITS.promotionMargin) {
        return { decision: "challenger-promoted", reason: `挑战者 v${challenger.version} 线上平均奖励 ${chall.mean} 高于冠军 ${champ.mean}（各 ≥${LIMITS.challengerMinSamples} 个样本）。`, metrics };
      }
      return { decision: "challenger-retired", reason: `挑战者 v${challenger.version} 线上平均奖励 ${chall.mean} 未超过冠军 ${champ.mean}。`, metrics };
    }
    return { decision: "challenger-testing", reason: `挑战者 v${challenger.version} 线上测试中（挑战者 ${chall.n} / 冠军 ${champ.n} 个已结算样本，各需 ${LIMITS.challengerMinSamples} 个），暂不产生新候选。`, metrics };
  }

  if (settled.length < LIMITS.minEvidenceToEvolve) {
    return { decision: "insufficient-evidence", reason: `已结算结果 ${settled.length} 个，少于 ${LIMITS.minEvidenceToEvolve} 个，不改打法，继续积累。`, metrics };
  }

  const { train, holdout } = splitSamples(settled);
  const candidate = clonePlaybook(champion);
  candidate.version = nextVersion;
  candidate.repoSelection.weights = fitWeights(train);
  candidate.opportunityPriors = fitPriors(train);
  candidate.lessons = applyReflection(champion, reflection, settled, nextVersion);
  const diff = describeDiff(champion, candidate);
  metrics.train = train.length;
  metrics.holdout = holdout.length;
  metrics.championScore = replayScore(champion, holdout);
  metrics.candidateScore = replayScore(candidate, holdout);

  if (!diff.length) return { decision: "no-change", reason: "新证据没有带来值得记录的打法变化。", metrics };

  const gain = round3(metrics.candidateScore - metrics.championScore);
  metrics.gain = gain;
  if (holdout.length >= LIMITS.minHoldout && gain > LIMITS.promotionMargin) {
    return { decision: "promoted", reason: `保留集回放得分 ${metrics.candidateScore}，比冠军 ${metrics.championScore} 高 ${gain}，晋级。`, candidate, diff, metrics };
  }
  if (holdout.length >= LIMITS.minHoldout && gain < -LIMITS.promotionMargin) {
    return { decision: "rejected", reason: `保留集回放得分 ${metrics.candidateScore} 低于冠军 ${metrics.championScore}，淘汰。`, candidate, diff, metrics };
  }
  return { decision: "challenger", reason: `回放无法区分优劣（保留集 ${holdout.length} 个，差值 ${gain}），作为挑战者进入线上 A/B。`, candidate, diff, metrics };
}
