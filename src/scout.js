import { LIMITS, OPPORTUNITY_TYPES, PROFILES, REPO_FEATURES } from "./config.js";

const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const round3 = (value) => Math.round(value * 1000) / 1000;
const DAY = 86_400_000;

export function computeFeatures({ repo, root = [], issues = [], pulls = [], now = Date.now() }) {
  const external = pulls.filter((pull) => pull.external);
  const externalMergeRate = external.length ? external.filter((pull) => pull.merged).length / external.length : 0.3;
  const hours = pulls.map((pull) => (Date.parse(pull.closedAt) - Date.parse(pull.createdAt)) / 3_600_000)
    .filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const medianHours = hours.length ? hours[Math.floor(hours.length / 2)] : null;
  const names = root.map((entry) => entry.name.toLowerCase());
  const daysSincePush = repo?.pushed_at ? (now - Date.parse(repo.pushed_at)) / DAY : 365;
  const helpWanted = issues.filter((issue) => !issue.assigned
    && issue.labels.some((label) => /help wanted|good first issue|good-first-issue/i.test(label))).length;
  const features = {
    externalMergeRate: clamp01(externalMergeRate),
    responsiveness: medianHours == null ? 0.3 : clamp01(1 / (1 + medianHours / 72)),
    activity: clamp01(Math.exp(-Math.max(0, daysSincePush) / 30)),
    helpWanted: clamp01(helpWanted / 5),
    openIssueLoad: clamp01(Number(repo?.open_issues_count || issues.length) / 200),
    popularity: clamp01(Math.log10(Number(repo?.stargazers_count || 0) + 1) / 5),
    testsPresent: names.some((name) => /^(tests?|__tests__|spec|e2e)$/.test(name) || /\.test\.|_test\./.test(name)) ? 1 : 0,
    contributingGuide: names.some((name) => name.startsWith("contributing")) ? 1 : 0,
  };
  for (const key of Object.keys(features)) features[key] = round3(features[key]);
  return {
    features,
    facts: {
      stars: Number(repo?.stargazers_count || 0),
      language: repo?.language || null,
      sizeKb: Number(repo?.size || 0),
      daysSincePush: Math.round(daysSincePush),
      externalPulls: external.length,
      medianHoursToClose: medianHours == null ? null : Math.round(medianHours),
      helpWanted,
    },
  };
}

export function classifyProfile({ track, repo, root = [] }) {
  const names = root.map((entry) => entry.name.toLowerCase());
  const topics = (repo?.topics || []).join(" ").toLowerCase();
  const text = `${topics} ${String(repo?.description || "").toLowerCase()}`;
  const web = names.some((name) => ["index.html", "vite.config.ts", "vite.config.js", "next.config.js", "app", "pages", "public"].includes(name));
  if (track === "internal" && web) return "internal-app";
  if (/\b(etl|pipeline|dbt|airflow|notebook)\b/.test(text) || names.some((name) => name.endsWith(".ipynb"))) return "data-pipeline";
  if (/\b(cli|command[- ]line|terminal|devtool|linter|formatter)\b/.test(text) || names.includes("cmd")) return "dev-tool";
  if (/\b(library|sdk|framework|client|parser)\b/.test(text) || names.some((name) => ["setup.py", "pyproject.toml", "cargo.toml", "go.mod"].includes(name))) return "library";
  if (web) return track === "internal" ? "internal-app" : "web-app";
  return track === "internal" ? "internal-app" : "general";
}

export function scoreRepo(features, weights) {
  return round3(Object.keys(REPO_FEATURES).reduce((sum, key) => sum + Number(weights?.[key] || 0) * Number(features?.[key] || 0), 0));
}

export function opportunityPrior(playbook, profile, type) {
  const table = playbook.opportunityPriors?.[profile] || playbook.opportunityPriors?.general || {};
  return Number(table[type] ?? 0.1);
}

const EFFORT_FIT = { S: 1, M: 0.6, L: 0.25 };
const GOAL_FIT = {
  contributor: { bug: 1, accuracy: 0.9, performance: 0.8, "small-feature": 0.8, "ux-ui": 0.6, "competitor-gap": 0.6, slimming: 0.5 },
  craft: { bug: 1, accuracy: 0.8, performance: 0.7, slimming: 0.4, "small-feature": 0.3, "ux-ui": 0.3, "competitor-gap": 0.3 },
  internal: { accuracy: 1, slimming: 1, "ux-ui": 0.9, performance: 0.9, bug: 0.8, "small-feature": 0.5, "competitor-gap": 0.5 },
};

export function goalFit(goalMix, { type, effort = "M", track }) {
  let total = 0;
  let weight = 0;
  for (const [goal, share] of Object.entries(goalMix || {})) {
    if (goal === "internal" && track !== "internal") continue;
    if (goal === "contributor" && track === "internal") continue;
    const fit = (GOAL_FIT[goal]?.[type] ?? 0.5) * (goal === "contributor" ? EFFORT_FIT[effort] ?? 0.6 : 1);
    total += share * fit;
    weight += share;
  }
  return weight ? total / weight : 0.5;
}

export function priorityOf(playbook, opportunity, { profile, track }) {
  return round3(opportunityPrior(playbook, profile, opportunity.type)
    * clamp01(opportunity.confidence)
    * goalFit(playbook.goalMix, { type: opportunity.type, effort: opportunity.effort, track }));
}

const LABEL_TYPES = [
  [/perf|slow|latency|memory/i, "performance"],
  [/\bui\b|\bux\b|design|style|accessibility|a11y/i, "ux-ui"],
  [/enhancement|feature|request/i, "small-feature"],
  [/bug|defect|crash|regression|incorrect/i, "bug"],
];

export function ruleBasedOpportunities({ issues, playbook, profile, track }) {
  const found = [];
  for (const issue of issues) {
    if (issue.assigned) continue;
    const type = LABEL_TYPES.find(([pattern]) => issue.labels.some((label) => pattern.test(label)))?.[1];
    if (!type) continue;
    const invited = issue.labels.some((label) => /help wanted|good first issue/i.test(label));
    found.push({
      type,
      title: issue.title.slice(0, 140),
      summary: `Issue #${issue.number}（标签：${issue.labels.join(", ")}）`,
      evidence: [{ kind: "issue", ref: String(issue.number) }],
      effort: "M",
      confidence: invited ? 0.5 : 0.35,
      fixPlan: "",
      source: "rules",
    });
  }
  return found
    .map((item) => ({ ...item, priority: priorityOf(playbook, item, { profile, track }) }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, LIMITS.opportunitiesPerRepo);
}

export function diagnosisPrompt({ target, profile, facts, features, readme, root, issues, playbook }) {
  const priors = playbook.opportunityPriors?.[profile] || playbook.opportunityPriors?.general;
  const lessons = (playbook.lessons || []).filter((lesson) => lesson.kind !== "pr").map((lesson) => `- ${lesson.text}`).join("\n");
  const system = [
    "You are Bug Hunter, an engineer who finds concrete, verifiable improvement opportunities in a GitHub repository.",
    `Opportunity types: ${Object.keys(OPPORTUNITY_TYPES).join(", ")}. Profiles: ${Object.keys(PROFILES).join(", ")}.`,
    "Every opportunity must cite evidence that a program can check: {\"kind\":\"file\",\"ref\":\"path/in/repo\"} or {\"kind\":\"issue\",\"ref\":\"123\"}.",
    "Prefer small, reviewable changes. Never propose work already claimed by an open PR. Do not invent files.",
    "Return JSON only: {\"profile\":\"...\",\"painPoints\":[\"...\"],\"opportunities\":[{\"type\":\"bug\",\"title\":\"...\",\"summary\":\"...\",\"evidence\":[{\"kind\":\"file\",\"ref\":\"...\",\"detail\":\"...\"}],\"effort\":\"S|M|L\",\"confidence\":0.0,\"fixPlan\":\"...\"}]}",
    `At most ${LIMITS.opportunitiesPerRepo} opportunities. Write title/summary/fixPlan in Chinese.`,
  ].join("\n");
  const user = [
    `Repository: ${target.id} (track: ${target.track}, guessed profile: ${profile})`,
    `Facts: ${JSON.stringify(facts)}`,
    `Features (0-1): ${JSON.stringify(features)}`,
    `Current preference for opportunity types in this profile (learned, adjust if the repo clearly needs otherwise): ${JSON.stringify(priors)}`,
    `Hunting lessons learned so far:\n${lessons || "- (none yet)"}`,
    `Root entries: ${root.map((entry) => entry.name + (entry.type === "dir" ? "/" : "")).join(", ")}`,
    `Open issues:\n${issues.slice(0, 20).map((issue) => `#${issue.number} [${issue.labels.join(",")}]${issue.assigned ? " (assigned)" : ""} ${issue.title}`).join("\n") || "(none)"}`,
    `README excerpt:\n${readme.slice(0, 3500)}`,
  ].join("\n\n");
  return { system, user };
}

export function normalizeDiagnosis(data) {
  const profile = PROFILES[data?.profile] ? data.profile : null;
  const opportunities = (Array.isArray(data?.opportunities) ? data.opportunities : [])
    .filter((item) => OPPORTUNITY_TYPES[item?.type] && typeof item.title === "string")
    .slice(0, LIMITS.opportunitiesPerRepo)
    .map((item) => ({
      type: item.type,
      title: item.title.slice(0, 140),
      summary: String(item.summary || "").slice(0, 600),
      evidence: (Array.isArray(item.evidence) ? item.evidence : [])
        .filter((evidence) => ["file", "issue"].includes(evidence?.kind) && evidence.ref)
        .slice(0, 4)
        .map((evidence) => ({ kind: evidence.kind, ref: String(evidence.ref).replace(/^#/, "").replace(/^\/+/, "").slice(0, 200), detail: String(evidence.detail || "").slice(0, 200) })),
      effort: ["S", "M", "L"].includes(item.effort) ? item.effort : "M",
      confidence: clamp01(Number(item.confidence ?? 0.5)),
      fixPlan: String(item.fixPlan || "").slice(0, 600),
      source: "ai",
    }));
  return {
    profile,
    painPoints: (Array.isArray(data?.painPoints) ? data.painPoints : []).map(String).slice(0, 5),
    opportunities,
  };
}

export async function verifyOpportunity({ gh, full, opportunity, rootNames }) {
  const checks = [];
  for (const evidence of opportunity.evidence.slice(0, 2)) {
    try {
      if (evidence.kind === "file") {
        const top = evidence.ref.split("/")[0];
        const exists = evidence.ref.includes("/") ? rootNames.has(top) && await gh.pathExists(full, evidence.ref) : rootNames.has(top);
        checks.push({ ...evidence, ok: exists, note: exists ? "文件存在" : "仓库中找不到该文件" });
      } else if (evidence.kind === "issue") {
        const issue = await gh.issue(full, evidence.ref);
        if (!issue || issue.pull_request) checks.push({ ...evidence, ok: false, note: "Issue 不存在" });
        else if (issue.state !== "open") checks.push({ ...evidence, ok: false, note: "Issue 已关闭" });
        else if (issue.assignee) checks.push({ ...evidence, ok: false, note: "Issue 已被认领" });
        else {
          const linked = await gh.openLinkedPulls(full, evidence.ref);
          checks.push({ ...evidence, ok: linked === 0, note: linked ? `已有 ${linked} 个关联 PR` : "Issue 开放且无人认领" });
        }
      }
    } catch (error) {
      checks.push({ ...evidence, ok: false, note: `核对失败：${error.message}` });
    }
  }
  const verified = checks.length > 0 && checks.every((check) => check.ok);
  return {
    verified,
    checks,
    reason: verified ? "证据核对通过" : checks.length ? checks.find((check) => !check.ok).note : "没有可核对的证据",
  };
}

export async function scoutRepo({ gh, llm, target, playbook, now = Date.now() }) {
  const repo = await gh.repo(target.id);
  const [root, readme, issues, pulls] = await Promise.all([
    gh.rootEntries(target.id),
    gh.readme(target.id),
    gh.openIssues(target.id),
    gh.closedPulls(target.id),
  ]);
  const { features, facts } = computeFeatures({ repo, root, issues, pulls, now });
  let profile = classifyProfile({ track: target.track, repo, root });
  let opportunities = [];
  let painPoints = [];
  let llmStatus = "not-used";
  if (llm?.enabled) {
    const prompt = diagnosisPrompt({ target, profile, facts, features, readme, root, issues, playbook });
    const answer = await llm.json(prompt.system, prompt.user);
    llmStatus = answer.status;
    if (answer.data) {
      const diagnosis = normalizeDiagnosis(answer.data);
      profile = diagnosis.profile || profile;
      painPoints = diagnosis.painPoints;
      opportunities = diagnosis.opportunities.map((item) => ({ ...item, priority: priorityOf(playbook, item, { profile, track: target.track }) }));
    }
  }
  if (!opportunities.length) {
    opportunities = ruleBasedOpportunities({ issues, playbook, profile, track: target.track });
  }
  const rootNames = new Set(root.map((entry) => entry.name));
  for (const opportunity of opportunities) {
    opportunity.verification = await verifyOpportunity({ gh, full: target.id, opportunity, rootNames });
  }
  return { features, facts, profile, painPoints, opportunities, llmStatus };
}
