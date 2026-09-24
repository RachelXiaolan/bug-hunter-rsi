import { GOALS, LIMITS, OPPORTUNITY_TYPES, PROFILES, REPO_FEATURES } from "./config.js";
import { createGitHub, parsePullUrl } from "./github.js";
import { budgeted, createLlm } from "./llm.js";
import { ensureGenesis, loadPlaybooks, tick } from "./pipeline.js";
import { buildRsiStatus } from "./rsi-status.js";

const VERSION = "2.1.0";
const ATTEMPT_STATUSES = new Set(["abandoned", "tests-failed", "ready-for-review", "submitted"]);
const today = () => new Date().toISOString().slice(0, 10);

// Everything the owner manages lives in Cloudflare vars; the executor reads it from here.
export function autopilot(env) {
  const number = (value, fallback) => Number.isFinite(Number(value)) && value !== "" && value != null ? Number(value) : fallback;
  return {
    autoSubmit: env.AUTO_SUBMIT !== "off",
    maxPrsPerDay: number(env.MAX_PRS_PER_DAY, 3),
    maxOpenPrsPerRepo: number(env.MAX_OPEN_PRS_PER_REPO, 1),
    claPolicy: env.CLA_POLICY === "flag" ? "flag" : "skip",
    workerDailyLlmCalls: number(env.DAILY_LLM_CALLS, 40),
    executorDailyLlmCalls: number(env.EXECUTOR_DAILY_LLM_CALLS, 60),
    maxFollowups: LIMITS.maxFollowups,
  };
}

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const rows = (result) => result?.results || [];
const safeJson = (value, fallback) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

function authorized(request, env) {
  const expected = env.HUNTER_TOKEN;
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ given.charCodeAt(index);
  return diff === 0;
}

async function claimBucket(db, key) {
  const result = await db.prepare("INSERT OR IGNORE INTO manual_run_limits(bucket, created_at) VALUES (?, ?)")
    .bind(`${key}:${Math.floor(Date.now() / 60_000)}`, new Date().toISOString()).run();
  return Number(result?.meta?.changes || 0) > 0;
}

function deps(env) {
  const llm = createLlm({ apiKey: env.CMD_API_KEY, endpoint: env.CMD_API_URL || undefined, model: env.CMD_MODEL || undefined });
  return {
    gh: createGitHub({ token: env.GITHUB_TOKEN }),
    llm: budgeted(llm, { db: env.DB, source: "worker", dailyCalls: autopilot(env).workerDailyLlmCalls }),
  };
}

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

async function loadState(db, env) {
  await ensureGenesis(db, new Date());
  const [playbooks, rounds, scans, opportunities, events, steps, coverage, totals, trend] = await Promise.all([
    db.prepare("SELECT version, parent, status, created_at, diff_json, metrics_json, reason FROM playbooks ORDER BY version").all(),
    db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM repo_scans s WHERE s.round_id = r.id) AS repos,
      (SELECT COUNT(*) FROM opportunities o WHERE o.round_id = r.id) AS found,
      (SELECT COUNT(*) FROM opportunities o WHERE o.round_id = r.id AND o.status != 'discarded') AS verified,
      (SELECT decision FROM evolution_steps e WHERE e.round_id = r.id) AS decision
      FROM rounds r ORDER BY day DESC LIMIT 30`).all(),
    db.prepare(`SELECT id, round_id, repo, track, arm, playbook_version, pre_score, status, profile, facts_json,
      pain_points_json, llm_status, error, scanned_at FROM repo_scans ORDER BY rowid DESC LIMIT 20`).all(),
    db.prepare(`SELECT id, round_id, repo, track, write_policy, profile, type, title, summary, evidence_json, verification_json,
      effort, confidence, priority, source, arm, playbook_version, status, status_reason, pr_url, outcome, team_verdict, reward,
      created_at, updated_at FROM opportunities ORDER BY created_at DESC, priority DESC LIMIT 80`).all(),
    db.prepare("SELECT * FROM events ORDER BY at DESC LIMIT 40").all(),
    db.prepare("SELECT * FROM evolution_steps ORDER BY at DESC LIMIT 20").all(),
    db.prepare(`SELECT repo, type, COUNT(*) AS found, SUM(status != 'discarded') AS verified,
      SUM(status IN ('ready-for-review', 'submitted')) AS fixed, SUM(outcome = 'merged') AS merged
      FROM opportunities GROUP BY repo, type`).all(),
    db.prepare(`SELECT (SELECT COUNT(DISTINCT repo) FROM repo_scans WHERE status = 'done') AS repos,
      (SELECT COUNT(*) FROM opportunities) AS found,
      (SELECT COUNT(*) FROM opportunities WHERE status != 'discarded') AS verified,
      (SELECT COUNT(*) FROM opportunities WHERE status IN ('ready-for-review', 'submitted')) AS fixed,
      (SELECT COUNT(*) FROM opportunities WHERE status = 'submitted') AS submitted,
      (SELECT COUNT(*) FROM opportunities WHERE outcome = 'merged') AS merged,
      (SELECT COUNT(*) FROM opportunities WHERE reward IS NOT NULL) AS settled,
      (SELECT ROUND(AVG(reward), 3) FROM opportunities WHERE reward IS NOT NULL) AS avg_reward,
      (SELECT COUNT(*) FROM targets WHERE active = 1) AS targets`).first(),
    db.prepare(`SELECT round_id, ROUND(AVG(reward), 3) AS avg_reward, COUNT(*) AS n FROM opportunities
      WHERE reward IS NOT NULL GROUP BY round_id ORDER BY round_id DESC LIMIT 30`).all(),
  ]);
  const { champion, challenger } = await loadPlaybooks(db);
  const [usage, openPrs, attention, blocked] = await Promise.all([
    db.prepare("SELECT * FROM usage ORDER BY day DESC LIMIT 28").all(),
    db.prepare(`SELECT id, repo, title, pr_url, submitted_at, maintainer_responded, followup_count FROM opportunities
      WHERE status = 'submitted' AND outcome IS NULL ORDER BY submitted_at DESC LIMIT 30`).all(),
    db.prepare(`SELECT * FROM events WHERE kind IN ('needs-cla', 'followup-limit', 'needs-human') ORDER BY at DESC LIMIT 20`).all(),
    db.prepare("SELECT id, blocked_until, blocked_reason FROM targets WHERE blocked_until > ? ORDER BY blocked_until DESC LIMIT 20").bind(new Date().toISOString()).all(),
  ]);
  const prsToday = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'submit-permit' AND substr(at, 1, 10) = ?").bind(today()).first();
  const parse = (row, fields) => ({ ...row, ...Object.fromEntries(fields.map((field) => [field.replace(/_json$/, ""), safeJson(row[field], null)])) });
  return {
    framework: { name: "Bug Hunter", version: VERSION },
    capabilities: {
      llm: Boolean(env.CMD_API_KEY),
      githubToken: Boolean(env.GITHUB_TOKEN),
      executor: Boolean(env.HUNTER_TOKEN),
      internalRepos: Boolean(env.INTERNAL_REPOS),
      ossRepos: Boolean(env.OSS_REPOS),
      discovery: env.DISCOVERY !== "off",
    },
    vocab: { goals: GOALS, types: OPPORTUNITY_TYPES, profiles: PROFILES, features: REPO_FEATURES, limits: LIMITS },
    champion,
    challenger,
    playbooks: rows(playbooks).map((row) => parse(row, ["diff_json", "metrics_json"])),
    rounds: rows(rounds),
    scans: rows(scans).map((row) => parse(row, ["facts_json", "pain_points_json"])),
    opportunities: rows(opportunities).map((row) => parse(row, ["evidence_json", "verification_json"])),
    events: rows(events),
    evolution: rows(steps).map((row) => parse(row, ["metrics_json"])),
    coverage: rows(coverage),
    totals: totals || {},
    trend: rows(trend).reverse(),
    schedule: { cron: "*/20 * * * *", note: "每 20 分钟推进一步，每天一轮（UTC 日期）" },
    autopilot: { ...autopilot(env), prsToday: Number(prsToday?.n || 0) },
    usage: rows(usage),
    inbox: { openPrs: rows(openPrs), attention: rows(attention), blocked: rows(blocked) },
  };
}

async function claimQueue(db, limit, env) {
  const { champion } = await loadPlaybooks(db);
  const policy = autopilot(env);
  const used = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'submit-permit' AND substr(at, 1, 10) = ?").bind(today()).first();
  const prsRemaining = Math.max(0, policy.maxPrsPerDay - Number(used?.n || 0));
  // With no PR quota left today, only take work that will not need a PR anyway.
  const onlyPatches = policy.autoSubmit && prsRemaining === 0 ? "AND write_policy != 'pr'" : "";
  const queued = rows(await db.prepare(`SELECT * FROM opportunities WHERE status = 'queued' ${onlyPatches} ORDER BY priority DESC LIMIT ?`).bind(limit).all());
  const at = new Date().toISOString();
  if (queued.length) {
    await db.batch(queued.map((opp) => db.prepare("UPDATE opportunities SET status = 'claimed', updated_at = ? WHERE id = ? AND status = 'queued'").bind(at, opp.id)));
  }
  return {
    lessons: champion.lessons,
    prStyle: champion.prStyle,
    playbookVersion: champion.version,
    autopilot: { ...policy, prsRemaining },
    tasks: queued.map((opp) => ({
      id: opp.id, repo: opp.repo, track: opp.track, writePolicy: opp.write_policy, profile: opp.profile, type: opp.type,
      title: opp.title, summary: opp.summary, fixPlan: opp.fix_plan, evidence: safeJson(opp.evidence_json, []), effort: opp.effort,
    })),
  };
}

async function recordAttempt(db, body) {
  if (!body?.id || !ATTEMPT_STATUSES.has(body.status)) return json({ error: "id and a valid status are required" }, 400);
  const opp = await db.prepare("SELECT id, write_policy, status FROM opportunities WHERE id = ?").bind(body.id).first();
  if (!opp) return json({ error: "Unknown opportunity" }, 404);
  if (!["queued", "claimed", "ready-for-review", "tests-failed"].includes(opp.status)) {
    return json({ error: `Opportunity is ${opp.status}; no attempt expected` }, 409);
  }
  let prUrl = null;
  if (body.status === "submitted") {
    if (opp.write_policy !== "pr") return json({ error: `write_policy is ${opp.write_policy}; PR submission not allowed` }, 409);
    if (!parsePullUrl(body.prUrl)) return json({ error: "submitted requires a GitHub pull request URL" }, 400);
    const permit = await db.prepare("SELECT id FROM events WHERE opportunity_id = ? AND kind = 'submit-permit' LIMIT 1").bind(body.id).first();
    if (!permit) return json({ error: "submitted requires a permit from /api/permit" }, 409);
    prUrl = body.prUrl;
  }
  const at = new Date().toISOString();
  const reason = String(body.reason || "").slice(0, 600);
  const extra = [];
  if (body.status === "submitted") extra.push(db.prepare("UPDATE opportunities SET submitted_at = ? WHERE id = ?").bind(at, body.id));
  if (body.blockRepo) {
    extra.push(db.prepare("UPDATE targets SET blocked_until = ?, blocked_reason = ? WHERE id = (SELECT repo FROM opportunities WHERE id = ?)")
      .bind(new Date(Date.now() + 365 * 86_400_000).toISOString(), reason || "仓库政策不接受此类贡献", body.id));
  }
  await db.batch([
    ...extra,
    db.prepare(`UPDATE opportunities SET status = ?, status_reason = ?, patch = COALESCE(?, patch), test_log = COALESCE(?, test_log),
      pr_url = COALESCE(?, pr_url), updated_at = ? WHERE id = ?`).bind(body.status, reason,
      body.patch ? String(body.patch).slice(0, 60000) : null, body.testLog ? String(body.testLog).slice(-8000) : null, prUrl, at, body.id),
    db.prepare("INSERT INTO events(id, opportunity_id, at, kind, detail) VALUES (?, ?, ?, ?, ?)")
      .bind(`${body.id}:${body.status}:${at}`, body.id, at, body.status, reason || prUrl || body.status),
    db.prepare("INSERT INTO feedback(id, opportunity_id, at, source, verdict, note) VALUES (?, ?, ?, 'executor', ?, ?)")
      .bind(`${body.id}:executor:${at}`, body.id, at, body.status, reason),
  ]);
  return json({ ok: true, id: body.id, status: body.status });
}

// The executor asks before opening a PR, so caps and the kill switch are enforced server-side.
async function grantPermit(db, env, body) {
  const policy = autopilot(env);
  const opp = await db.prepare("SELECT id, repo, write_policy, status FROM opportunities WHERE id = ?").bind(body?.id || "").first();
  const deny = (reason) => json({ allowed: false, reason });
  if (!opp) return json({ error: "Unknown opportunity" }, 404);
  if (!policy.autoSubmit) return deny("AUTO_SUBMIT=off");
  if (opp.write_policy !== "pr") return deny(`write_policy=${opp.write_policy}`);
  if (!["claimed", "ready-for-review"].includes(opp.status)) return deny(`status=${opp.status}`);
  const day = today();
  const used = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'submit-permit' AND substr(at, 1, 10) = ?").bind(day).first();
  if (Number(used?.n || 0) >= policy.maxPrsPerDay) return deny(`今日 PR 上限 ${policy.maxPrsPerDay} 已用完`);
  const open = await db.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE repo = ? AND status = 'submitted' AND outcome IS NULL").bind(opp.repo).first();
  if (Number(open?.n || 0) >= policy.maxOpenPrsPerRepo) return deny(`${opp.repo} 已有 ${open.n} 个未结 PR`);
  const at = new Date().toISOString();
  await db.prepare("INSERT INTO events(id, opportunity_id, at, kind, detail) VALUES (?, ?, ?, 'submit-permit', ?)")
    .bind(`${opp.id}:permit:${at}`, opp.id, at, "允许自动提交 PR").run();
  return json({ allowed: true });
}

async function listFollowups(db) {
  const found = rows(await db.prepare(`SELECT id, repo, title, summary, type, pr_url, followup_count, last_followup_at, submitted_at
    FROM opportunities WHERE status = 'submitted' AND outcome IS NULL AND pr_url IS NOT NULL
    ORDER BY COALESCE(last_followup_at, submitted_at) ASC LIMIT 10`).all());
  return { followups: found, maxFollowups: LIMITS.maxFollowups };
}

const EVENT_KINDS = new Set(["followup", "followup-limit", "needs-cla", "needs-human", "pr-closed-by-bot"]);
async function recordEvent(db, body) {
  if (!body?.id || !EVENT_KINDS.has(body.kind)) return json({ error: "id and a valid kind are required" }, 400);
  const opp = await db.prepare("SELECT id FROM opportunities WHERE id = ?").bind(body.id).first();
  if (!opp) return json({ error: "Unknown opportunity" }, 404);
  const at = new Date().toISOString();
  const writes = [db.prepare("INSERT INTO events(id, opportunity_id, at, kind, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(`${body.id}:${body.kind}:${at}`, body.id, at, body.kind, String(body.detail || "").slice(0, 800))];
  if (body.kind === "followup") {
    writes.push(db.prepare("UPDATE opportunities SET followup_count = followup_count + 1, last_followup_at = ?, updated_at = ? WHERE id = ?").bind(at, at, body.id));
  }
  if (body.kind === "followup-limit") writes.push(db.prepare("UPDATE opportunities SET last_followup_at = ? WHERE id = ?").bind(at, body.id));
  await db.batch(writes);
  return json({ ok: true });
}

async function recordUsage(db, body) {
  const calls = Math.max(0, Math.min(1000, Number(body?.calls) || 0));
  const tokens = Math.max(0, Math.min(50_000_000, Number(body?.tokens) || 0));
  await db.prepare(`INSERT INTO usage(day, source, calls, tokens) VALUES (?, 'executor', ?, ?)
    ON CONFLICT(day, source) DO UPDATE SET calls = usage.calls + excluded.calls, tokens = usage.tokens + excluded.tokens`)
    .bind(today(), calls, tokens).run();
  const row = await db.prepare("SELECT calls, tokens FROM usage WHERE day = ? AND source = 'executor'").bind(today()).first();
  return json({ ok: true, today: row });
}

async function recordTeamFeedback(db, body) {
  if (!body?.id || !["useful", "not-useful"].includes(body.verdict)) return json({ error: "id and verdict are required" }, 400);
  const opp = await db.prepare("SELECT id FROM opportunities WHERE id = ?").bind(body.id).first();
  if (!opp) return json({ error: "Unknown opportunity" }, 404);
  const at = new Date().toISOString();
  const note = String(body.note || "").slice(0, 300);
  await db.batch([
    db.prepare("UPDATE opportunities SET team_verdict = ?, updated_at = ? WHERE id = ?").bind(body.verdict, at, body.id),
    db.prepare("INSERT INTO feedback(id, opportunity_id, at, source, verdict, note) VALUES (?, ?, ?, 'team', ?, ?)")
      .bind(`${body.id}:team:${at}`, body.id, at, body.verdict, note),
    db.prepare("INSERT INTO events(id, opportunity_id, at, kind, detail) VALUES (?, ?, ?, 'team-feedback', ?)")
      .bind(`${body.id}:team:${at}`, body.id, at, `团队反馈：${body.verdict === "useful" ? "有用" : "没用"}${note ? ` — ${note}` : ""}`),
  ]);
  return json({ ok: true });
}

async function addTarget(db, body) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(body?.id || "") || !["open-source", "internal"].includes(body.track)) {
    return json({ error: "id (owner/repo) and track are required" }, 400);
  }
  const policy = ["readonly", "review", "pr"].includes(body.writePolicy) ? body.writePolicy : "readonly";
  await db.prepare(`INSERT INTO targets(id, track, write_policy, source, added_at) VALUES (?, ?, ?, 'config', ?)
    ON CONFLICT(id) DO UPDATE SET track = excluded.track, write_policy = excluded.write_policy, active = 1`)
    .bind(body.id, body.track, policy, new Date().toISOString()).run();
  return json({ ok: true, id: body.id, track: body.track, writePolicy: policy }, 201);
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === "/api/health") {
      if (request.method !== "GET") {
        const response = json({ error: "Method not allowed" }, 405);
        response.headers.set("allow", "GET");
        return response;
      }
      return json({ ok: true, service: "bug-hunter-rsi", version: VERSION });
    }
    if (pathname === "/rsi-status.json") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      if (!env.DB) return json({ error: "D1 database binding unavailable" }, 503);
      const response = json(await buildRsiStatus(env.DB));
      response.headers.set("access-control-allow-origin", "*");
      response.headers.set("cache-control", "public, max-age=60");
      return response;
    }
    if (!pathname.startsWith("/api/")) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Assets binding unavailable", { status: 503 });
    }
    const route = `${request.method} ${pathname}`;
    const known = ["GET /api/state", "POST /api/tick", "POST /api/feedback", "GET /api/queue", "POST /api/attempts", "POST /api/targets",
      "POST /api/permit", "GET /api/followups", "POST /api/events", "POST /api/usage"];
    if (!known.includes(route)) return json({ error: "Not found" }, 404);
    if (!env.DB) return json({ error: "D1 database binding unavailable" }, 503);
    const db = env.DB;
    try {
      if (route === "GET /api/state") return json(await loadState(db, env));
      if (route === "POST /api/tick" || route === "POST /api/feedback") {
        if (!sameOrigin(request)) return json({ error: "Same-origin requests only" }, 403);
        if (route === "POST /api/tick") {
          if (!await claimBucket(db, "tick")) return json({ error: "每分钟只允许手动推进一次。" }, 429);
          return json(await tick({ db, env, ...deps(env) }), 201);
        }
        const body = await readBody(request);
        if (!await claimBucket(db, `feedback:${body?.id}`)) return json({ error: "同一条机会每分钟只能反馈一次。" }, 429);
        return recordTeamFeedback(db, body);
      }
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
      if (route === "GET /api/queue") return json(await claimQueue(db, Math.max(1, Math.min(5, Number(url.searchParams.get("limit")) || 1)), env));
      if (route === "POST /api/attempts") return recordAttempt(db, await readBody(request));
      if (route === "POST /api/permit") return grantPermit(db, env, await readBody(request));
      if (route === "GET /api/followups") return json(await listFollowups(db));
      if (route === "POST /api/events") return recordEvent(db, await readBody(request));
      if (route === "POST /api/usage") return recordUsage(db, await readBody(request));
      return addTarget(db, await readBody(request));
    } catch (error) {
      console.error(route, error);
      return json({ error: error instanceof Error ? error.message : "request failed" }, 500);
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(tick({ db: env.DB, env, ...deps(env) })
      .then((result) => console.log("Bug Hunter tick", JSON.stringify(result)))
      .catch((error) => console.error("Bug Hunter tick failed", error)));
  },
};

export default worker;
