// Turns what actually happened to an opportunity into a learning signal per goal.
// null means "not settled yet" and keeps the sample out of learning.

function contributor(opp) {
  if (opp.outcome === "merged") return 1;
  if (opp.outcome === "closed") return -0.5;
  if (opp.outcome === "stale") return -0.2;
  if (opp.team_verdict === "useful") return 0.3;
  if (opp.team_verdict === "not-useful") return -0.2;
  if (opp.status === "abandoned" || opp.status === "tests-failed") return 0;
  return null;
}

function craft(opp) {
  if (opp.outcome === "merged") return 1;
  if (opp.outcome === "closed") return -0.2;
  const base = {
    discarded: -0.2,
    abandoned: -0.1,
    "tests-failed": -0.3,
    "ready-for-review": 0.6,
    submitted: 0.6,
  }[opp.status];
  if (base == null) return opp.team_verdict === "not-useful" ? -0.1 : null;
  if (opp.team_verdict === "useful") return Math.min(1, base + 0.2);
  if (opp.team_verdict === "not-useful") return base - 0.1;
  return base;
}

function internal(opp) {
  if (opp.track !== "internal") return null;
  if (opp.outcome === "merged") return 1;
  if (opp.outcome === "closed") return -0.5;
  if (opp.team_verdict === "useful") return 1;
  if (opp.team_verdict === "not-useful") return -0.5;
  if (opp.status === "discarded" || opp.status === "tests-failed") return -0.2;
  if (opp.status === "abandoned") return 0;
  return null;
}

export const REWARD_BY_GOAL = Object.freeze({ contributor, craft, internal });

export function rewardFor(opp, goalMix) {
  let total = 0;
  let weight = 0;
  const parts = {};
  for (const [goal, share] of Object.entries(goalMix || {})) {
    const value = REWARD_BY_GOAL[goal]?.(opp);
    if (value == null || !share) continue;
    parts[goal] = value;
    total += share * value;
    weight += share;
  }
  return weight ? { reward: Math.round(total / weight * 1000) / 1000, parts } : { reward: null, parts };
}
