import { runSampleArena, sampleCatalog } from "./arena.js";
import { runApiHunt } from "./live-hunt.js";
import { generateAiProbes } from "./ai-probes.js";
import {
  BENCHMARK_BRANCHES_TOTAL,
  DEFAULT_POLICY,
  MAX_PROBES_PER_CANDIDATE,
  OPERATOR_IDS,
  runEvolutionCycle,
} from "./evolution.js";

const OPERATOR_LABELS = Object.freeze({
  boundary: "边界值",
  sequence: "状态序列",
  concurrency: "并发交错",
  reduction: "失败缩减",
});

const RULE_TEXT = Object.freeze({
  boundary: "在业务运算前验证负数、零值、上限与精度边界，并将新边界加入回归集。",
  sequence: "把订单与支付操作建模为显式状态机；重试、撤销和重复提交必须幂等。",
  concurrency: "库存和支付写入使用原子条件更新及幂等键，并覆盖并发交错顺序。",
  reduction: "将失败事件序列缩减为最短可重放用例，保留原始失败签名作为回归。",
});

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const safeJson = (value, fallback = null) => {
  if (value == null) return fallback;
  try { return typeof value === "string" ? JSON.parse(value) : value; }
  catch { return fallback; }
};

const resultRows = (result) => result?.results || [];

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function appendRowStatements(statements, db, sql, rows, size = 20) {
  for (const group of chunks(rows, size)) {
    statements.push(...group.map((row) => db.prepare(sql).bind(...row)));
  }
}

async function readPolicy(db) {
  const row = await db.prepare("SELECT value FROM system_state WHERE key = ?")
    .bind("test_policy").first();
  const saved = safeJson(row?.value);
  return {
    ...DEFAULT_POLICY,
    ...saved,
    weights: { ...DEFAULT_POLICY.weights, ...(saved?.weights || {}) },
  };
}

async function claimManualRun(db, kind = "evolution") {
  const bucket = `${kind}:${Math.floor(Date.now() / 60_000)}`;
  const result = await db.prepare("INSERT OR IGNORE INTO manual_run_limits(bucket, created_at) VALUES (?, ?)")
    .bind(bucket, new Date().toISOString()).run();
  return Number(result?.meta?.changes || 0) > 0;
}

async function runLiveHunt(db, kind, origin, env) {
  const startedAt = new Date().toISOString();
  const scheduledFor = kind === "scheduled" ? startedAt.slice(0, 10) : null;
  if (scheduledFor) {
    const previous = await db.prepare("SELECT id FROM live_hunt_runs WHERE scheduled_for = ?")
      .bind(scheduledFor).first();
    if (previous) return { skipped: true, reason: "already-ran-today", id: previous.id };
  }
  const [savedPolicy, knownResult] = await Promise.all([
    db.prepare("SELECT value FROM system_state WHERE key = 'live_hunt_policy'").first(),
    db.prepare("SELECT id, status FROM live_hunt_findings").all(),
  ]);
  const policy = safeJson(savedPolicy?.value, { version: 1, cursor: 0, focus: "balanced" });
  const ai = await generateAiProbes({
    apiKey: env.CMD_API_KEY,
    knownFindings: resultRows(knownResult).map((row) => row.id),
  });
  const result = await runApiHunt({
    origin,
    invoke: (request) => worker.fetch(request, env),
    policy,
    knownFindings: resultRows(knownResult).map((row) => row.id),
    openFindings: resultRows(knownResult).filter((row) => row.status === "open").map((row) => row.id),
    suggestedProbes: ai.probes,
  });
  const finishedAt = new Date().toISOString();
  const id = `live-${crypto.randomUUID()}`;
  const summary = `${result.probes.length} 项真实 API 探测（AI 建议 ${ai.probes.length} 项，状态 ${ai.status}）；确认 ${result.findings.length} 类失败，新发现 ${result.newFindings.length} 类，回归确认修复 ${result.resolvedFindings.length} 类；下一轮焦点：${result.nextPolicy.focus}。`;
  const writes = [db.prepare(`
    INSERT INTO live_hunt_runs(id, run_kind, scheduled_for, created_at, finished_at, target,
      probe_count, confirmed_count, new_count, policy_before_json, policy_after_json, decision,
      ai_status, ai_probe_count, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, kind, scheduledFor, startedAt, finishedAt, origin,
    result.probes.length, result.findings.length, result.newFindings.length,
    JSON.stringify(policy), JSON.stringify(result.nextPolicy), result.decision,
    ai.status, ai.probes.length, summary)];
  for (const probe of result.probes) {
    writes.push(db.prepare(`
      INSERT INTO live_hunt_evidence(run_id, probe_id, request, expected, actual, status, passed, inconclusive)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, probe.id, probe.request, probe.expected, probe.actual, probe.status,
      Number(probe.passed), Number(probe.inconclusive)));
  }
  for (const finding of result.findings) {
    writes.push(db.prepare(`
      INSERT INTO live_hunt_findings(id, title, severity, category, description, reproduction,
        recommendation, expected, actual, first_seen_at, last_seen_at, times_seen, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open')
      ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
        actual = excluded.actual, reproduction = excluded.reproduction,
        times_seen = live_hunt_findings.times_seen + 1, status = 'open'
    `).bind(finding.id, finding.title, finding.severity, finding.category, finding.description,
      finding.reproduction, finding.recommendation, finding.expected, finding.actual,
      startedAt, finishedAt));
  }
  for (const findingId of result.resolvedFindings) {
    const regression = result.probes.find((probe) => probe.id === "health-post");
    writes.push(db.prepare("UPDATE live_hunt_findings SET status = 'resolved', last_seen_at = ? WHERE id = ?")
      .bind(finishedAt, findingId));
    writes.push(db.prepare(`
      INSERT INTO live_hunt_fix_events(id, run_id, finding_id, resolved_at, evidence)
      VALUES (?, ?, ?, ?, ?)
    `).bind(`fix-${id}-${findingId}`, id, findingId, finishedAt,
      `${regression.request} → ${regression.actual}; expected ${regression.expected}`));
  }
  writes.push(db.prepare(`INSERT OR REPLACE INTO system_state(key, value, updated_at)
    VALUES ('live_hunt_policy', ?, ?)`).bind(JSON.stringify(result.nextPolicy), finishedAt));
  writes.push(db.prepare(`INSERT INTO design_revisions(id, created_at, run_id, title, body, source)
    VALUES (?, ?, NULL, ?, ?, 'live-api')`)
    .bind(`revision-${id}`, finishedAt, "真实 API 捉虫闭环", summary));
  await db.batch(writes);
  return { id, kind, startedAt, finishedAt, summary, ai: { status: ai.status, probeCount: ai.probes.length }, ...result };
}

async function recordSampleRun(db) {
  const startedAt = new Date();
  const arena = runSampleArena();
  const finishedAt = new Date();
  const runId = `sample-${startedAt.getTime()}-${crypto.randomUUID()}`;
  const summary = `${arena.fixturesDetected} 个内置样例在 ${arena.checksTotal} 项自检中复现；这是固定样例演示，不是 RSI 进化。`;
  const statements = [db.prepare(`
    INSERT INTO runs(id, run_kind, started_at, finished_at, duration_ms, checks_total, harness_passed, fixtures_detected, summary)
    VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?)
  `).bind(runId, startedAt.toISOString(), finishedAt.toISOString(), arena.durationMs, arena.checksTotal, arena.harnessPassed, arena.fixturesDetected, summary)];

  for (const item of arena.findings) {
    const specimen = item.specimen;
    statements.push(db.prepare(`
      INSERT OR IGNORE INTO specimens(id, title, severity, category, description, reproduction, recommendation, first_seen_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(specimen.id, specimen.title, specimen.severity, specimen.category, specimen.description,
      specimen.reproduction, specimen.recommendation, startedAt.toISOString(), "sample"));
    statements.push(db.prepare("INSERT OR IGNORE INTO run_findings(run_id, specimen_id) VALUES (?, ?)").bind(runId, specimen.id));
  }
  statements.push(db.prepare(`
    INSERT INTO design_revisions(id, created_at, run_id, title, body, source)
    VALUES (?, ?, ?, ?, ?, 'sample')
  `).bind(`revision-${runId}`, finishedAt.toISOString(), runId, "样本场运行记录",
    `${arena.fixturesDetected} 个教学样例复现；测试策略与 RSI 版本未改变。`));
  await db.batch(statements);

  return {
    id: runId,
    kind: "manual",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: arena.durationMs,
    ...arena,
    summary,
  };
}

function specimenFromFinding(finding, createdAt) {
  const titlePrefix = {
    boundary: "边界输入",
    sequence: "状态序列",
    concurrency: "并发交错",
    reduction: "缩减回放",
  }[finding.operator] || "合成样例";
  return {
    id: finding.specimenId,
    title: `${titlePrefix}：${finding.specimenId.replaceAll("-", " ")}`,
    severity: finding.severity,
    category: OPERATOR_LABELS[finding.operator] || "合成基准",
    description: `合成基准中的可复现缺陷模型（分支 ${finding.branch}），仅用于验证 Bug Hunter 的策略搜索流程，不代表真实生产代码缺陷。`,
    reproduction: finding.reproduction,
    recommendation: RULE_TEXT[finding.operator] || "将该缺陷模型转成稳定、可重复的回归测试。",
    firstSeenAt: createdAt,
  };
}

async function runEvolution(db, kind) {
  const now = new Date();
  const createdAt = now.toISOString();
  const scheduledFor = kind === "scheduled" ? createdAt.slice(0, 10) : null;

  if (scheduledFor) {
    const existing = await db.prepare("SELECT generation FROM evolution_generations WHERE scheduled_for = ?")
      .bind(scheduledFor).first();
    if (existing) return { skipped: true, reason: "already-ran-today", generation: existing.generation };
  }

  const [policy, specimenRows, caseRows, latest, historyRows] = await Promise.all([
    readPolicy(db),
    db.prepare("SELECT id FROM specimens ORDER BY first_seen_at ASC LIMIT 5000").all(),
    db.prepare("SELECT signature FROM test_case_library ORDER BY last_seen_at DESC LIMIT 5000").all(),
    db.prepare("SELECT MAX(generation) AS generation FROM evolution_generations").first(),
    db.prepare(`SELECT decision, operator_stats_json FROM evolution_generations ORDER BY generation DESC LIMIT 7`).all(),
  ]);
  const generation = Number(latest?.generation || 0) + 1;
  const recentHistory = resultRows(historyRows).map((row) => ({
    decision: row.decision,
    operatorStats: safeJson(row.operator_stats_json, {}),
  }));
  const cycle = runEvolutionCycle({
    policy,
    generation,
    seed: `${scheduledFor || createdAt.slice(0, 10)}:g${generation}`,
    knownSpecimens: resultRows(specimenRows).map((row) => row.id),
    knownCaseSignatures: resultRows(caseRows).map((row) => row.signature),
    recentHistory,
  });

  const runId = `evolution-g${generation}-${crypto.randomUUID()}`;
  const finishedAt = new Date().toISOString();
  const checksTotal = cycle.candidates.reduce((sum, candidate) => sum + candidate.probes, 0);
  const regressionTotal = cycle.candidates.reduce((sum, candidate) => sum + candidate.regressionTotal, 0);
  const regressionPassed = cycle.candidates.reduce((sum, candidate) => sum + candidate.regressionPassed, 0);
  const summary = `第 ${generation} 代：${cycle.decision === "promoted" ? "策略晋级" : "保留当前策略"}；${cycle.newFindings.length} 个新合成缺陷，${cycle.testCasesAdded} 条新测试输入；回归 ${regressionPassed}/${regressionTotal} 全通过。`;

  const writes = [db.prepare(`
    INSERT INTO runs(id, run_kind, started_at, finished_at, duration_ms, checks_total, harness_passed, fixtures_detected, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(runId, kind, createdAt, finishedAt, cycle.durationMs, checksTotal, regressionPassed, cycle.newFindings.length, summary)];

  writes.push(db.prepare(`
    INSERT INTO evolution_generations(
      generation, run_id, run_kind, scheduled_for, seed, created_at, decision, decision_reason,
      baseline_score, baseline_holdout_score, champion_policy_json, champion_score, champion_holdout_score,
      candidate_count, probes_total, branches_covered, regression_total, regression_passed, new_findings,
      test_cases_added, recommendation_updates, operator_stats_json, summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(generation, runId, kind, scheduledFor, cycle.seed, createdAt, cycle.decision, cycle.decisionReason,
    cycle.baseline.score, cycle.baseline.holdoutScore, JSON.stringify(cycle.champion.policy), cycle.champion.score,
    cycle.champion.holdoutScore, cycle.candidates.length, checksTotal, cycle.branchesCovered,
    regressionTotal, regressionPassed, cycle.newFindings.length, cycle.testCasesAdded,
    cycle.recommendationUpdates, JSON.stringify(cycle.operatorStats), summary));

  const rejectionReasons = new Map(cycle.rejections.map(({ id, reason }) => [id, reason]));
  writes.push(...cycle.candidates.map((candidate) => db.prepare(`
    INSERT INTO evolution_candidates(
      id, generation, weights_json, training_score, holdout_score, branches_covered, probes,
      regression_total, regression_passed, disposition, rejection_reason, findings_json, operator_stats_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(candidate.id, generation, JSON.stringify(candidate.weights), candidate.score, candidate.holdoutScore,
    candidate.branchesCovered, candidate.probes, candidate.regressionTotal, candidate.regressionPassed,
    cycle.promoted && candidate.id === cycle.champion.id ? "promoted" : "rejected",
    cycle.promoted && candidate.id === cycle.champion.id ? null : rejectionReasons.get(candidate.id) || "not-selected",
    JSON.stringify(candidate.findings.map(({ specimenId, operator, branch }) => ({ specimenId, operator, branch }))),
    JSON.stringify(candidate.operatorStats))));

  const allSpecimens = cycle.findings.map((finding) => specimenFromFinding(finding, createdAt));
  appendRowStatements(writes, db, `
    INSERT OR IGNORE INTO specimens(id, title, severity, category, description, reproduction, recommendation, first_seen_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synthetic')
  `, allSpecimens.map((item) => [item.id, item.title, item.severity, item.category, item.description,
    item.reproduction, item.recommendation, item.firstSeenAt]), 10);

  const findingIds = [...new Set(cycle.findings.map(({ specimenId }) => specimenId))];
  appendRowStatements(writes, db, "INSERT OR IGNORE INTO run_findings(run_id, specimen_id) VALUES (?, ?)",
    findingIds.map((id) => [runId, id]), 40);

  appendRowStatements(writes, db, `
    INSERT INTO test_case_library(signature, case_id, operator, specimen_id, reproduction, first_generation, first_seen_at, last_seen_at, times_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(signature) DO UPDATE SET last_seen_at = excluded.last_seen_at, times_seen = times_seen + 1
  `, cycle.testedCases.map((item) => [item.signature, item.caseId, item.operator, item.specimenId,
    item.reproduction, generation, createdAt, createdAt]), 10);

  appendRowStatements(writes, db, `
    INSERT INTO recommendation_rules(id, operator, text, version, evidence_count, last_generation, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET text = excluded.text, version = excluded.version,
      evidence_count = recommendation_rules.evidence_count + excluded.evidence_count,
      last_generation = excluded.last_generation, updated_at = excluded.updated_at
  `, cycle.recommendationRules.map((rule) => [rule.id, rule.operator, RULE_TEXT[rule.operator],
    cycle.champion.policy.recommendationRulesVersion, rule.evidenceDelta, generation, createdAt]), 10);

  const revisionTitle = `第 ${generation} 代 · ${cycle.promoted ? "策略晋级" : "候选未晋级"}`;
  const revisionBody = `${summary} ${cycle.decisionReason} 测试库版本 v${cycle.champion.policy.boundaryLibraryVersion}，修复建议规则 v${cycle.champion.policy.recommendationRulesVersion}。`;
  writes.push(
    db.prepare(`INSERT OR REPLACE INTO system_state(key, value, updated_at) VALUES ('test_policy', ?, ?)`)
      .bind(JSON.stringify(cycle.champion.policy), finishedAt),
    db.prepare(`INSERT INTO design_revisions(id, created_at, run_id, title, body, source) VALUES (?, ?, ?, ?, ?, 'rsi')`)
      .bind(`revision-${runId}`, finishedAt, runId, revisionTitle, revisionBody),
  );
  await db.batch(writes);

  return {
    id: runId,
    kind,
    startedAt: createdAt,
    finishedAt,
    generation,
    decision: cycle.decision,
    promoted: cycle.promoted,
    decisionReason: cycle.decisionReason,
    baseline: cycle.baseline,
    champion: cycle.champion,
    candidates: cycle.candidates.map(({ id, weights, score, holdoutScore, probes, regressionTotal: candidateRegressionTotal, regressionPassed: candidateRegressionPassed }) => ({
      id, weights, score, holdoutScore, probes,
      regressionTotal: candidateRegressionTotal,
      regressionPassed: candidateRegressionPassed,
    })),
    branchesCovered: cycle.branchesCovered,
    newFindings: cycle.newFindings.map(({ specimenId, operator }) => ({ specimenId, operator })),
    testCasesAdded: cycle.testCasesAdded,
    recommendationUpdates: cycle.recommendationUpdates,
    checksTotal,
    regressionPassed,
    regressionTotal,
    summary,
  };
}

function parseGeneration(row) {
  if (!row) return null;
  return {
    ...row,
    champion_policy: safeJson(row.champion_policy_json, {}),
    operator_stats: safeJson(row.operator_stats_json, {}),
  };
}

async function loadState(db) {
  const [latestRun, runsResult, specimensResult, revision, runCount, latestGenRow, generationsResult,
    policy, testCases, rulesResult, liveRun, liveRuns, liveFindings, livePolicy, liveFixes] = await Promise.all([
    db.prepare("SELECT * FROM runs ORDER BY finished_at DESC LIMIT 1").first(),
    db.prepare(`
      SELECT r.*, g.generation, g.regression_total, g.regression_passed
      FROM runs r LEFT JOIN evolution_generations g ON g.run_id = r.id
      ORDER BY r.finished_at DESC LIMIT 20
    `).all(),
    db.prepare("SELECT * FROM specimens ORDER BY first_seen_at DESC LIMIT 100").all(),
    db.prepare("SELECT * FROM design_revisions ORDER BY created_at DESC LIMIT 1").first(),
    db.prepare("SELECT COUNT(*) AS total FROM runs").first(),
    db.prepare("SELECT * FROM evolution_generations ORDER BY generation DESC LIMIT 1").first(),
    db.prepare("SELECT * FROM evolution_generations ORDER BY generation DESC LIMIT 20").all(),
    readPolicy(db),
    db.prepare("SELECT COUNT(*) AS total FROM test_case_library").first(),
    db.prepare("SELECT * FROM recommendation_rules ORDER BY operator ASC").all(),
    db.prepare("SELECT * FROM live_hunt_runs ORDER BY finished_at DESC LIMIT 1").first(),
    db.prepare("SELECT * FROM live_hunt_runs ORDER BY finished_at DESC LIMIT 10").all(),
    db.prepare("SELECT * FROM live_hunt_findings ORDER BY first_seen_at DESC LIMIT 50").all(),
    db.prepare("SELECT value FROM system_state WHERE key = 'live_hunt_policy'").first(),
    db.prepare("SELECT * FROM live_hunt_fix_events ORDER BY resolved_at DESC LIMIT 20").all(),
  ]);
  const latestGeneration = parseGeneration(latestGenRow);
  const generationIds = resultRows(generationsResult).map((row) => row.generation);
  let candidates = [];
  if (generationIds.length) {
    const latestCandidates = await db.prepare(`
      SELECT * FROM evolution_candidates WHERE generation = ? ORDER BY training_score DESC, id ASC
    `).bind(generationIds[0]).all();
    candidates = resultRows(latestCandidates).map((row) => ({
      ...row,
      weights: safeJson(row.weights_json, {}),
      findings: safeJson(row.findings_json, []),
      operator_stats: safeJson(row.operator_stats_json, {}),
    }));
  }
  const generations = resultRows(generationsResult).map(parseGeneration);
  const specimens = resultRows(specimensResult);
  const runRows = resultRows(runsResult);
  const currentRun = latestRun || null;
  const totalChecks = Number(currentRun?.checks_total || 0);
  const branchesCovered = Number(latestGeneration?.branches_covered || 0);
  return {
    status: currentRun ? "ready" : "idle",
    framework: { name: "Bug Hunter", version: "0.2.0", phase: "evolving-strategy", rsiEnabled: true, benchmark: "synthetic" },
    totals: { runs: Number(runCount?.total || 0) },
    latestRun: currentRun,
    runs: runRows,
    specimens,
    designRevision: revision || null,
    metrics: {
      checks: totalChecks,
      harnessPassRate: totalChecks ? Math.round(Number(currentRun.harness_passed || 0) / totalChecks * 100) : 100,
      fixturesDetected: Number(currentRun?.fixtures_detected || 0),
      knownSpecimens: Number((await db.prepare("SELECT COUNT(*) AS total FROM specimens").first())?.total || 0),
      generation: Number(latestGeneration?.generation || 0),
      branchCoverage: BENCHMARK_BRANCHES_TOTAL ? Math.round(branchesCovered / BENCHMARK_BRANCHES_TOTAL * 100) : 0,
      branchesCovered,
      branchesTotal: BENCHMARK_BRANCHES_TOTAL,
      evolutionScore: Number(latestGeneration?.champion_score || 0),
      holdoutScore: Number(latestGeneration?.champion_holdout_score || 0),
      syntheticBenchmark: true,
    },
    evolution: {
      policy,
      latest: latestGeneration ? { ...latestGeneration, candidates } : null,
      generations,
      testCaseCount: Number(testCases?.total || 0),
      recommendationRules: resultRows(rulesResult),
      operatorLabels: OPERATOR_LABELS,
    },
    liveHunt: {
      target: "本项目真实 API",
      latest: liveRun || null,
      runs: resultRows(liveRuns),
      findings: resultRows(liveFindings),
      fixes: resultRows(liveFixes),
      policy: safeJson(livePolicy?.value, { version: 1, cursor: 0, focus: "balanced" }),
      evidence: liveRun ? resultRows(await db.prepare(
        "SELECT * FROM live_hunt_evidence WHERE run_id = ? ORDER BY probe_id"
      ).bind(liveRun.id).all()) : [],
    },
    schedule: { cron: "0 1 * * *", utc: "01:00", local: "10:00 Asia/Seoul" },
  };
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") {
        const response = json({ error: "Method not allowed" }, 405);
        response.headers.set("allow", "GET");
        return response;
      }
      return json({ ok: true, service: "bug-hunter-rsi", phase: "evolving-strategy" });
    }
    if (url.pathname === "/api/catalog" && request.method === "GET") {
      return json({ samples: sampleCatalog() });
    }
    if (url.pathname === "/api/state" && request.method === "GET") {
      if (!env.DB) return json({ error: "D1 database binding unavailable" }, 503);
      try { return json(await loadState(env.DB)); }
      catch (error) { return json({ error: error instanceof Error ? error.message : "state unavailable" }, 500); }
    }
    if (url.pathname === "/api/hunt" && request.method === "POST") {
      if (!sameOrigin(request)) return json({ error: "Same-origin requests only" }, 403);
      if (!env.DB) return json({ error: "D1 database binding unavailable" }, 503);
      try {
        if (!await claimManualRun(env.DB, "hunt")) return json({ error: "每分钟只允许一次手动捉虫。" }, 429);
        return json(await runLiveHunt(env.DB, "manual", url.origin, env), 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "hunt failed" }, 500);
      }
    }
    if ((url.pathname === "/api/run" || url.pathname === "/api/evolve") && request.method === "POST") {
      if (!sameOrigin(request)) return json({ error: "Same-origin requests only" }, 403);
      if (!env.DB) return json({ error: "D1 database binding unavailable" }, 503);
      try {
        if (!await claimManualRun(env.DB)) return json({ error: "每分钟只允许一次手动运行，请稍后再试。" }, 429);
        const result = url.pathname === "/api/evolve"
          ? await runEvolution(env.DB, "manual")
          : await recordSampleRun(env.DB);
        return json(result, 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "run failed" }, 500);
      }
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Assets binding unavailable", { status: 503 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      try { await runLiveHunt(env.DB, "scheduled", env.HUNT_TARGET_ORIGIN, env); }
      catch (error) { console.error("Bug Hunter scheduled API hunt failed", error); }
      try { await runEvolution(env.DB, "scheduled"); }
      catch (error) { console.error("Bug Hunter scheduled evolution failed", error); }
    })());
  },
};

export default worker;
