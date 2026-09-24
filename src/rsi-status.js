// GET /rsi-status.json — the team RSI dashboard reads this to verify the evolution loop.
// Derived from records the pipeline already writes (rounds, evolution_steps, playbooks); no new table.
// One run = one daily round: cron ticks every 20 minutes advance it step by step until it is finalized.

const MAX_RUNS = 60;

// Which part of the playbook a promoted / challenger candidate rewrote, in the dashboard's vocabulary.
function changedKinds(decision, diff) {
  if (decision === "challenger-promoted" || decision === "challenger-retired") return ["strategy"];
  if (!["promoted", "challenger", "rejected"].includes(decision)) return ["data"];
  const kinds = new Set();
  // describeDiff areas: 挑仓库 = repo-selection weights, 挑方向 = opportunity priors, 写 PR / 找和修 = lessons
  for (const item of Array.isArray(diff) ? diff : []) {
    if (item?.area === "挑仓库") kinds.add("weight");
    else if (item?.area === "挑方向") kinds.add("param");
    else if (item?.area === "写 PR" || item?.area === "找和修") kinds.add("rule");
    else kinds.add("strategy");
  }
  return kinds.size ? [...kinds] : ["strategy"];
}

const parseJson = (value, fallback) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

export async function buildRsiStatus(db, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const [rounds, champion] = await Promise.all([
    db.prepare(`SELECT r.id, r.day, r.status, r.created_at, r.finished_at, r.champion_version, r.summary,
        e.decision, e.reason, e.candidate_version, e.metrics_json, p.diff_json
      FROM rounds r
      LEFT JOIN evolution_steps e ON e.round_id = r.id
      LEFT JOIN playbooks p ON p.version = e.candidate_version
      ORDER BY r.day DESC LIMIT ?`).bind(MAX_RUNS).all(),
    db.prepare("SELECT version, created_at FROM playbooks WHERE status = 'champion' ORDER BY version DESC LIMIT 1").first(),
  ]);

  const runs = [];
  for (const round of rounds.results || []) {
    const finished = round.status === "finalized";
    // Today's round is still being advanced by ticks; it becomes a run once finalized.
    if (!finished && round.day === today) continue;
    const metrics = parseJson(round.metrics_json, {});
    const run = {
      startedAt: round.created_at,
      finishedAt: round.finished_at || `${round.day}T23:59:59.000Z`,
      ok: finished,
      trigger: "cron",
      version: `playbook v${round.candidate_version || round.champion_version}`,
      changed: finished ? changedKinds(round.decision, parseJson(round.diff_json, [])) : [],
      summary: finished ? (round.reason || round.summary || "").slice(0, 200) : "",
    };
    if (typeof metrics.championScore === "number" && typeof metrics.candidateScore === "number") {
      run.score = { before: metrics.championScore, after: metrics.candidateScore };
    }
    if (!finished) run.error = "当天的轮次没有完成";
    runs.push(run);
  }

  return {
    schemaVersion: 1,
    project: "Bug Hunter",
    generatedAt: now.toISOString(),
    schedule: { cron: "0 0 * * *", timezone: "UTC", runner: "cloudflare-cron（每 20 分钟推进一步，每天完成一轮）" },
    current: {
      version: champion ? `playbook v${champion.version}` : "",
      promptVersion: champion ? `playbook v${champion.version}` : "",
      updatedAt: champion?.created_at || null,
    },
    runs,
  };
}
