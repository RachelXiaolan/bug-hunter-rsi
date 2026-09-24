import { DEFAULT_PLAYBOOK, LIMITS, REPO_FEATURES } from "./config.js";
import { evolve, reflectionPrompt } from "./evolution.js";
import { parsePullUrl } from "./github.js";
import { rewardFor } from "./reward.js";
import { scoreRepo, scoutRepo } from "./scout.js";

const rows = (result) => result?.results || [];
const safeJson = (value, fallback) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};
const DAY = 86_400_000;
const NEUTRAL_FEATURES = Object.fromEntries(Object.keys(REPO_FEATURES).map((key) => [key, 0.5]));

function hashRank(text) {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash;
}

export function parseTargetList(value, track) {
  return String(value || "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean).map((item) => {
    const [id, policy] = item.split(":");
    const fallback = track === "internal" ? "readonly" : "pr";
    return /^[\w.-]+\/[\w.-]+$/.test(id)
      ? { id, track, writePolicy: ["readonly", "review", "pr"].includes(policy) ? policy : fallback }
      : null;
  }).filter(Boolean);
}

export async function ensureGenesis(db, now) {
  const existing = await db.prepare("SELECT version FROM playbooks WHERE version = 1").first();
  if (existing) return;
  await db.prepare(`INSERT INTO playbooks(version, parent, status, created_at, playbook_json, diff_json, metrics_json, reason)
    VALUES (1, NULL, 'champion', ?, ?, '[]', '{}', ?)`)
    .bind(now.toISOString(), JSON.stringify(DEFAULT_PLAYBOOK), "初始打法：来自需求假设与 Tony 的 skill 经验，尚无真实结果支撑。").run();
}

export async function loadPlaybooks(db) {
  const found = rows(await db.prepare("SELECT version, playbook_json, status FROM playbooks WHERE status IN ('champion', 'challenger')").all());
  const pick = (status) => {
    const row = found.find((item) => item.status === status);
    return row ? { ...safeJson(row.playbook_json, DEFAULT_PLAYBOOK), version: row.version } : null;
  };
  return { champion: pick("champion") || { ...DEFAULT_PLAYBOOK }, challenger: pick("challenger") };
}

function repoFeaturesFromMeta(meta, now) {
  const features = { ...NEUTRAL_FEATURES };
  if (meta.stars != null) features.popularity = Math.min(1, Math.log10(Number(meta.stars) + 1) / 5);
  if (meta.pushedAt) features.activity = Math.exp(-Math.max(0, (now - Date.parse(meta.pushedAt)) / DAY) / 30);
  if (meta.openIssues != null) features.openIssueLoad = Math.min(1, Number(meta.openIssues) / 200);
  return features;
}

// Split the day's slots between the champion, the challenger (online A/B) and pure exploration.
export function selectRepos({ candidates, champion, challenger, day, slots }) {
  const pool = [...candidates];
  const picked = [];
  const take = (count, arm, playbook) => {
    const ranked = pool
      .map((item) => ({ item, score: playbook ? scoreRepo(item.features, playbook.repoSelection.weights) : hashRank(`${day}:${item.id}`) / 2 ** 32 }))
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
    for (const { item, score } of ranked.slice(0, count)) {
      pool.splice(pool.indexOf(item), 1);
      picked.push({ ...item, arm, playbookVersion: (arm === "challenger" ? challenger : champion).version, preScore: Math.round(score * 1000) / 1000 });
    }
  };
  const challengerSlots = challenger ? Math.round(slots * LIMITS.challengerShare) : 0;
  const exploreSlots = Math.round((slots - challengerSlots) * Number(champion.repoSelection.exploration || 0));
  take(challengerSlots, "challenger", challenger);
  take(slots - challengerSlots - exploreSlots, "champion", champion);
  take(exploreSlots, "explore", null);
  return picked;
}

async function syncTargets(db, env, gh, champion, now) {
  const configured = [
    ...parseTargetList(env.INTERNAL_REPOS, "internal"),
    ...parseTargetList(env.OSS_REPOS, "open-source"),
  ];
  const writes = configured.map((target) => db.prepare(`INSERT INTO targets(id, track, write_policy, source, added_at)
    VALUES (?, ?, ?, 'config', ?) ON CONFLICT(id) DO UPDATE SET track = excluded.track,
    write_policy = excluded.write_policy, active = 1`).bind(target.id, target.track, target.writePolicy, now.toISOString()));
  let discovered = 0;
  if (env.DISCOVERY !== "off") {
    for (const query of champion.discoveryQueries.slice(0, 3)) {
      try {
        const pushed = new Date(now.getTime() - 60 * DAY).toISOString().slice(0, 10);
        const found = await gh.searchRepos(`${query} pushed:>${pushed}`, 7);
        for (const item of found) {
          discovered += 1;
          writes.push(db.prepare(`INSERT INTO targets(id, track, write_policy, source, added_at, meta_json)
            VALUES (?, 'open-source', 'pr', 'discovered', ?, ?)
            ON CONFLICT(id) DO UPDATE SET meta_json = excluded.meta_json`)
            .bind(item.id, now.toISOString(), JSON.stringify({ stars: item.stars, pushedAt: item.pushedAt, openIssues: item.openIssues, query })));
        }
      } catch (error) {
        console.warn("discovery failed", query, error.message);
      }
    }
  }
  if (writes.length) await db.batch(writes);
  return { configured: configured.length, discovered };
}

async function planRound(db, env, gh, day, now) {
  const { champion, challenger } = await loadPlaybooks(db);
  const synced = await syncTargets(db, env, gh, champion, now);
  const recent = new Date(now.getTime() - 7 * DAY).toISOString();
  const targets = rows(await db.prepare(`SELECT * FROM targets WHERE active = 1
    AND (blocked_until IS NULL OR blocked_until < ?)
    AND (track = 'internal' OR last_scanned_at IS NULL OR last_scanned_at < ?)`).bind(now.toISOString(), recent).all());
  const internal = targets.filter((target) => target.track === "internal").slice(0, LIMITS.reposPerRound);
  const candidates = targets.filter((target) => target.track === "open-source").map((target) => ({
    id: target.id,
    track: target.track,
    features: { ...repoFeaturesFromMeta(safeJson(target.meta_json, {}), now.getTime()), ...safeJson(target.last_features_json, {}) },
  }));
  const selected = [
    ...internal.map((target) => ({ id: target.id, track: "internal", arm: "internal", playbookVersion: champion.version, preScore: 0 })),
    ...selectRepos({ candidates, champion, challenger, day, slots: Math.max(0, LIMITS.reposPerRound - internal.length) }),
  ];
  const roundId = `round-${day}`;
  const writes = [db.prepare(`INSERT INTO rounds(id, day, status, champion_version, challenger_version, created_at)
    VALUES (?, ?, 'scouting', ?, ?, ?)`).bind(roundId, day, champion.version, challenger?.version ?? null, now.toISOString())];
  for (const item of selected) {
    writes.push(db.prepare(`INSERT INTO repo_scans(id, round_id, repo, track, arm, playbook_version, pre_score, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`).bind(`${roundId}:${item.id}`, roundId, item.id, item.track, item.arm, item.playbookVersion, item.preScore));
  }
  writes.push(db.prepare("INSERT INTO events(id, opportunity_id, at, kind, detail) VALUES (?, NULL, ?, 'round-planned', ?)")
    .bind(`${roundId}:planned`, now.toISOString(), `选出 ${selected.length} 个仓库（配置 ${synced.configured}，新发现 ${synced.discovered}）；冠军 v${champion.version}${challenger ? `，挑战者 v${challenger.version}` : ""}。`));
  await db.batch(writes);
  return { step: "planned", round: roundId, selected: selected.map(({ id, arm }) => ({ id, arm })) };
}

async function scoutNext(db, gh, llm, round, now) {
  const scan = await db.prepare("SELECT * FROM repo_scans WHERE round_id = ? AND status = 'pending' ORDER BY rowid LIMIT 1").bind(round.id).first();
  if (!scan) return null;
  const target = await db.prepare("SELECT * FROM targets WHERE id = ?").bind(scan.repo).first()
    || { id: scan.repo, track: scan.track, write_policy: "readonly" };
  const playbookRow = await db.prepare("SELECT playbook_json FROM playbooks WHERE version = ?").bind(scan.playbook_version).first();
  const playbook = { ...safeJson(playbookRow?.playbook_json, DEFAULT_PLAYBOOK), version: scan.playbook_version };
  const at = now.toISOString();
  let result;
  try {
    result = await scoutRepo({ gh, llm, target, playbook, now: now.getTime() });
  } catch (error) {
    await db.batch([
      db.prepare("UPDATE repo_scans SET status = 'failed', error = ?, scanned_at = ? WHERE id = ?").bind(error.message, at, scan.id),
      db.prepare("UPDATE targets SET last_scanned_at = ? WHERE id = ?").bind(at, scan.repo),
    ]);
    return { step: "scout-failed", repo: scan.repo, error: error.message };
  }
  const writes = [
    db.prepare(`UPDATE repo_scans SET status = 'done', profile = ?, features_json = ?, facts_json = ?, pain_points_json = ?,
      llm_status = ?, scanned_at = ? WHERE id = ?`).bind(result.profile, JSON.stringify(result.features), JSON.stringify(result.facts),
      JSON.stringify(result.painPoints), result.llmStatus, at, scan.id),
    db.prepare("UPDATE targets SET last_scanned_at = ?, last_features_json = ? WHERE id = ?").bind(at, JSON.stringify(result.features), scan.repo),
  ];
  result.opportunities.forEach((opp, index) => {
    const id = `${scan.id}#${index + 1}`;
    const status = opp.verification.verified ? "verified" : "discarded";
    writes.push(db.prepare(`INSERT INTO opportunities(id, round_id, scan_id, repo, track, write_policy, profile, type, title, summary,
      evidence_json, verification_json, effort, confidence, priority, fix_plan, source, arm, playbook_version, features_json,
      status, status_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, round.id, scan.id, scan.repo, scan.track, target.write_policy, result.profile, opp.type, opp.title, opp.summary,
        JSON.stringify(opp.evidence), JSON.stringify(opp.verification.checks), opp.effort, opp.confidence, opp.priority,
        opp.fixPlan || "", opp.source, scan.arm, scan.playbook_version, JSON.stringify(result.features), status,
        opp.verification.reason, at, at));
    writes.push(db.prepare("INSERT INTO events(id, opportunity_id, at, kind, detail) VALUES (?, ?, ?, ?, ?)")
      .bind(`${id}:${status}`, id, at, status, `${opp.title} — ${opp.verification.reason}`));
  });
  await db.batch(writes);
  return { step: "scouted", repo: scan.repo, profile: result.profile, found: result.opportunities.length,
    verified: result.opportunities.filter((opp) => opp.verification.verified).length, llm: result.llmStatus };
}

async function pollPullRequests(db, gh, now) {
  const open = rows(await db.prepare(`SELECT id, repo, pr_url, updated_at, maintainer_responded FROM opportunities
    WHERE status = 'submitted' AND outcome IS NULL AND pr_url IS NOT NULL ORDER BY updated_at ASC LIMIT 15`).all());
  const writes = [];
  for (const opp of open) {
    const ref = parsePullUrl(opp.pr_url);
    if (!ref) continue;
    try {
      const pull = await gh.pull(ref.repo, ref.number);
      if (!pull) continue;
      const responded = Number(pull.comments || 0) + Number(pull.review_comments || 0) > 0 ? 1 : opp.maintainer_responded;
      let outcome = null;
      if (pull.merged_at) outcome = "merged";
      else if (pull.state === "closed") outcome = "closed";
      else if (!responded && now.getTime() - Date.parse(pull.created_at) > LIMITS.staleDays * DAY) outcome = "stale";
      writes.push(db.prepare("UPDATE opportunities SET outcome = ?, maintainer_responded = ?, updated_at = ? WHERE id = ?")
        .bind(outcome, responded, now.toISOString(), opp.id));
      if (outcome) {
        const comments = await gh.issueComments(ref.repo, ref.number).catch(() => []);
        const note = comments.filter((comment) => comment.author !== pull.user?.login).map((comment) => `${comment.author}: ${comment.body}`).slice(-3).join(" ｜ ").slice(0, 800);
        if (note) writes.push(db.prepare("UPDATE opportunities SET maintainer_note = ? WHERE id = ?").bind(note, opp.id));
        if (outcome !== "merged") {
          writes.push(db.prepare("UPDATE targets SET blocked_until = ?, blocked_reason = ? WHERE id = ?")
            .bind(new Date(now.getTime() + LIMITS.repoCooldownDays * DAY).toISOString(), `PR ${outcome}: ${opp.pr_url}`, opp.repo));
        }
        writes.push(db.prepare("INSERT OR IGNORE INTO events(id, opportunity_id, at, kind, detail) VALUES (?, ?, ?, ?, ?)")
          .bind(`${opp.id}:pr-${outcome}`, opp.id, now.toISOString(), `pr-${outcome}`, `${opp.pr_url} → ${outcome}`));
        writes.push(db.prepare("INSERT OR IGNORE INTO feedback(id, opportunity_id, at, source, verdict, note) VALUES (?, ?, ?, 'maintainer', ?, ?)")
          .bind(`${opp.id}:maintainer-${outcome}`, opp.id, now.toISOString(), outcome, opp.pr_url));
      }
    } catch (error) {
      console.warn("PR poll failed", opp.pr_url, error.message);
    }
  }
  if (writes.length) await db.batch(writes);
  return writes.length;
}

async function settleRewards(db, goalMix, now) {
  const all = rows(await db.prepare(`SELECT id, track, status, outcome, team_verdict, reward, settled_at FROM opportunities
    WHERE status NOT IN ('verified', 'queued', 'claimed') OR team_verdict IS NOT NULL`).all());
  const writes = [];
  for (const opp of all) {
    const { reward } = rewardFor(opp, goalMix);
    if (reward === opp.reward || (reward == null && opp.reward == null)) continue;
    writes.push(db.prepare("UPDATE opportunities SET reward = ?, settled_at = COALESCE(settled_at, ?) WHERE id = ?")
      .bind(reward, reward == null ? null : now.toISOString(), opp.id));
  }
  for (let index = 0; index < writes.length; index += 50) await db.batch(writes.slice(index, index + 50));
  return writes.length;
}

async function runEvolution(db, llm, round, now) {
  const { champion, challenger } = await loadPlaybooks(db);
  const samples = rows(await db.prepare(`SELECT * FROM opportunities WHERE reward IS NOT NULL ORDER BY settled_at DESC LIMIT 500`).all())
    .map((row) => ({
      id: row.id, repo: row.repo, title: row.title, profile: row.profile, type: row.type, status: row.status,
      outcome: row.outcome, teamVerdict: row.team_verdict, note: row.maintainer_note || row.status_reason, reward: row.reward,
      playbookVersion: row.playbook_version, features: safeJson(row.features_json, {}),
    }));
  const latest = await db.prepare("SELECT MAX(version) AS version FROM playbooks").first();
  const nextVersion = Number(latest?.version || 1) + 1;
  let reflection = null;
  let llmStatus = "not-used";
  if (llm?.enabled && samples.length >= LIMITS.minEvidenceToEvolve) {
    const prompt = reflectionPrompt(samples, champion);
    const answer = await llm.json(prompt.system, prompt.user);
    llmStatus = answer.status;
    reflection = answer.data;
  }
  const result = evolve({ champion, challenger, samples, reflection, nextVersion });
  const at = now.toISOString();
  const writes = [];
  const insertCandidate = (status) => writes.push(db.prepare(`INSERT INTO playbooks(version, parent, status, created_at, playbook_json, diff_json, metrics_json, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(nextVersion, champion.version, status, at, JSON.stringify(result.candidate),
    JSON.stringify(result.diff), JSON.stringify(result.metrics), result.reason));
  const setStatus = (version, status, reason) => writes.push(db.prepare("UPDATE playbooks SET status = ?, reason = reason || ? WHERE version = ?")
    .bind(status, reason ? ` ｜ ${reason}` : "", version));

  if (result.decision === "promoted") {
    setStatus(champion.version, "retired", `被 v${nextVersion} 取代`);
    if (challenger) setStatus(challenger.version, "retired", `冠军已更替为 v${nextVersion}`);
    insertCandidate("champion");
  } else if (result.decision === "challenger") {
    insertCandidate("challenger");
  } else if (result.decision === "rejected") {
    insertCandidate("rejected");
  } else if (result.decision === "challenger-promoted") {
    setStatus(champion.version, "retired", `被挑战者 v${challenger.version} 取代`);
    setStatus(challenger.version, "champion", result.reason);
  } else if (result.decision === "challenger-retired") {
    setStatus(challenger.version, "retired", result.reason);
  }
  writes.push(db.prepare(`INSERT INTO evolution_steps(id, round_id, at, decision, reason, candidate_version, metrics_json, llm_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(`${round.id}:evolve`, round.id, at, result.decision, result.reason,
    result.candidate ? nextVersion : null, JSON.stringify(result.metrics), llmStatus));
  await db.batch(writes);
  return result;
}

async function finalizeRound(db, gh, llm, round, now) {
  const at = now.toISOString();
  const { champion } = await loadPlaybooks(db);
  await db.prepare(`UPDATE opportunities SET status = 'queued', updated_at = ? WHERE status = 'claimed' AND updated_at < ?`)
    .bind(at, new Date(now.getTime() - DAY).toISOString()).run();
  const queue = rows(await db.prepare(`SELECT id, title FROM opportunities WHERE round_id = ? AND status = 'verified'
    ORDER BY priority DESC LIMIT ?`).bind(round.id, LIMITS.queuePerRound).all());
  if (queue.length) {
    await db.batch(queue.flatMap((opp) => [
      db.prepare("UPDATE opportunities SET status = 'queued', updated_at = ? WHERE id = ?").bind(at, opp.id),
      db.prepare("INSERT OR IGNORE INTO events(id, opportunity_id, at, kind, detail) VALUES (?, ?, ?, 'queued', ?)")
        .bind(`${opp.id}:queued`, opp.id, at, `${opp.title} 进入修复队列`),
    ]));
  }
  const polled = await pollPullRequests(db, gh, now);
  const settled = await settleRewards(db, champion.goalMix, now);
  const evolution = await runEvolution(db, llm, round, now);
  const counts = await db.prepare(`SELECT COUNT(*) AS found, SUM(status != 'discarded') AS verified FROM opportunities WHERE round_id = ?`).bind(round.id).first();
  const scans = await db.prepare(`SELECT COUNT(*) AS total, SUM(status = 'done') AS done, GROUP_CONCAT(DISTINCT llm_status) AS llm FROM repo_scans WHERE round_id = ?`).bind(round.id).first();
  const summary = `侦察 ${scans.done || 0}/${scans.total || 0} 个仓库，发现 ${counts.found || 0} 个机会，证据核对通过 ${counts.verified || 0} 个，排入修复 ${queue.length} 个；PR 状态更新 ${polled} 条，奖励结算 ${settled} 条。进化：${evolution.reason}`;
  await db.prepare("UPDATE rounds SET status = 'finalized', finished_at = ?, summary = ?, llm_status = ? WHERE id = ?")
    .bind(at, summary, scans.llm || null, round.id).run();
  return { step: "finalized", round: round.id, decision: evolution.decision, summary };
}

// One cron tick advances the day's round by one bounded step.
export async function tick({ db, gh, llm, env = {}, now = new Date() }) {
  await ensureGenesis(db, now);
  const day = now.toISOString().slice(0, 10);
  const round = await db.prepare("SELECT * FROM rounds WHERE day = ?").bind(day).first();
  if (!round) return planRound(db, env, gh, day, now);
  if (round.status === "finalized") return { step: "idle", round: round.id };
  return await scoutNext(db, gh, llm, round, now) || finalizeRound(db, gh, llm, round, now);
}
