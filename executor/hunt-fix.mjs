#!/usr/bin/env node
// Bug Hunter executor: the "hands" the Cloudflare "brain" cannot be.
// One run = follow up on open PRs (CI failures, review comments), then take new tasks:
// clone → repo policy → baseline tests → patch → tests → diff gate → AI self-review → permit → fork + PR.
//
// Env: HUNTER_URL, HUNTER_TOKEN, CMD_API_KEY, GH_PR_TOKEN [, CMD_API_URL, CMD_MODEL, HUNT_LIMIT, SANDBOX=docker|none]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLlm } from "../src/llm.js";
import { parsePullUrl } from "../src/github.js";
import { createGitHubWriter } from "./github-write.mjs";
import { diffGate, inspectRepoPolicy, prBody, slug } from "./policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "out");
const MAX_FILE = 40_000;
const SANDBOX_HOME = join(homedir(), ".bug-hunter", "sandbox-home");
const GIT_BASE = process.env.BUG_HUNTER_GIT_BASE || "https://github.com"; // overridable for tests

// ---------- processes ----------

function sh(command, args, cwd, { timeout = 600_000, env } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout, maxBuffer: 20 * 1024 * 1024, env: env || process.env });
  return { ok: result.status === 0, output: `${result.stdout || ""}${result.stderr || ""}`.slice(-6000) };
}

// Untrusted repository code never sees our secrets: either a container that only mounts the
// checkout, or at least a scrubbed environment with a throwaway HOME.
function sandboxed(dir, script, image, timeout = 900_000) {
  const useDocker = process.env.SANDBOX !== "none" && sh("docker", ["version"], undefined, { timeout: 20_000 }).ok;
  if (useDocker) {
    return sh("docker", ["run", "--rm", "--memory", "4g", "--cpus", "4", "-v", `${dir}:/work`, "-w", "/work", image, "bash", "-lc", script], undefined, { timeout });
  }
  mkdirSync(SANDBOX_HOME, { recursive: true });
  return sh("bash", ["-lc", script], dir, { timeout, env: { PATH: process.env.PATH, HOME: SANDBOX_HOME, LANG: "C.UTF-8", CI: "1" } });
}

export function detectTestCommand(dir) {
  const has = (name) => existsSync(join(dir, name));
  if (has("package.json")) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) {
      return { image: "node:22", setup: "(npm ci --ignore-scripts || npm install --ignore-scripts) >/dev/null 2>&1", test: "npm test" };
    }
  }
  if (has("go.mod")) return { image: "golang:1.24", setup: "", test: "go test ./..." };
  if (has("Cargo.toml")) return { image: "rust:1", setup: "", test: "cargo test --quiet" };
  if (has("pyproject.toml") || has("setup.py") || has("pytest.ini") || has("requirements.txt")) {
    return {
      image: "python:3.12",
      setup: "python3 -m venv .bh-venv && . .bh-venv/bin/activate && (pip install -q -e '.[test]' || pip install -q -e . || pip install -q -r requirements.txt) >/dev/null 2>&1; . .bh-venv/bin/activate && pip install -q pytest >/dev/null 2>&1",
      test: ". .bh-venv/bin/activate && python -m pytest -q -x",
    };
  }
  return null;
}

function runTests(dir, plan) {
  if (!plan) return { ok: true, skipped: true, output: "未识别到测试命令。" };
  const result = sandboxed(dir, [plan.setup, plan.test].filter(Boolean).join(" && "), plan.image);
  return { ok: result.ok, skipped: false, output: result.output };
}

export function applyFiles(dir, files) {
  const root = resolve(dir);
  for (const file of files.slice(0, 5)) {
    const target = resolve(dir, file.path);
    if (!target.startsWith(`${root}/`) || target.includes("/.git/")) throw new Error(`拒绝写入仓库外路径：${file.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, String(file.content));
  }
  return files.slice(0, 5).map((file) => file.path);
}

function pushEnv(token, login) {
  const basic = Buffer.from(`${login}:${token}`).toString("base64");
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
}

// ---------- brain API ----------

function createHunter({ url, token }) {
  return async function api(path, init = {}) {
    const response = await fetch(`${url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${path} → ${response.status} ${body.error || ""}`);
    return body;
  };
}

// ---------- AI steps ----------

function metered(llm, meter, limit) {
  return {
    enabled: llm.enabled,
    async json(system, user, options) {
      if (meter.calls >= limit) return { status: "executor-budget-exceeded", data: null };
      meter.calls += 1;
      const answer = await llm.json(system, user, options);
      meter.tokens += Number(answer.tokens || 0);
      return answer;
    },
  };
}

function readContext(dir, task) {
  const files = sh("git", ["ls-files"], dir).output.split("\n").filter(Boolean);
  const wanted = task.evidence.filter((item) => item.kind === "file").map((item) => item.ref).filter((path) => files.includes(path));
  return {
    tree: files.slice(0, 300).join("\n"),
    files: wanted.slice(0, 4).map((path) => ({ path, content: readFileSync(join(dir, path), "utf8").slice(0, MAX_FILE) })),
  };
}

async function askForPatch(llm, { task, context, lessons, prStyle, policy, issueText, failure }) {
  const system = [
    "You are Bug Hunter's fixing agent. Make the smallest correct change that resolves the opportunity, and add or update a test when the repo has tests.",
    `Keep the change under ${prStyle?.maxChangedLines || 60} changed lines in at most 5 files. Do not reformat unrelated code. Never touch CI workflows or lockfiles.`,
    "Return JSON only: {\"files\":[{\"path\":\"relative/path\",\"content\":\"full new file content\"}],\"prTitle\":\"conventional, English\",\"prBody\":\"English markdown: Problem / Root cause / Fix / Test plan\",\"abandon\":\"reason if the opportunity is not real\"}",
    "Follow the repository's contributing guide and PR template when present.",
    `Lessons learned from past attempts:\n${lessons.map((lesson) => `- ${lesson.text}`).join("\n") || "- (none)"}`,
  ].join("\n");
  const user = [
    `Repository ${task.repo} (${task.profile}); opportunity type ${task.type}.`,
    `Title: ${task.title}\nSummary: ${task.summary}\nPlan: ${task.fixPlan || "(none)"}`,
    `Evidence: ${JSON.stringify(task.evidence)}`,
    issueText ? `Issue:\n${issueText}` : "",
    policy.contributing ? `CONTRIBUTING (excerpt):\n${policy.contributing}` : "",
    policy.template ? `PR template:\n${policy.template}` : "",
    failure ? `Your previous patch failed the tests:\n${failure}` : "",
    `Files:\n${context.files.map((file) => `--- ${file.path}\n${file.content}`).join("\n\n") || "(no evidence files; choose files from the tree)"}`,
    `Tree (first 300 files):\n${context.tree}`,
  ].filter(Boolean).join("\n\n");
  return llm.json(system, user, { maxTokens: 12000, timeoutMs: 180000 });
}

async function selfReview(llm, { task, diff, testLog }) {
  const system = [
    "You are a strict open-source maintainer reviewing a pull request from an outside contributor.",
    "Approve only if the change is correct, minimal, clearly addresses the stated problem, has no unrelated edits, and would plausibly be merged.",
    "Return JSON only: {\"approve\":true|false,\"concerns\":[\"...\"]}",
  ].join("\n");
  const user = `Repository ${task.repo}\nProblem: ${task.title}\n${task.summary}\n\nDiff:\n${diff.slice(0, 20000)}\n\nTest output (tail):\n${testLog.slice(-2000)}`;
  const answer = await llm.json(system, user, { maxTokens: 2000 });
  return { approve: answer.data?.approve === true, concerns: (answer.data?.concerns || []).map(String).slice(0, 5), status: answer.status };
}

// ---------- new tasks ----------

async function issueFacts(gw, task) {
  const ref = task.evidence.find((item) => item.kind === "issue");
  if (!ref) return { ok: true, labels: [], text: "" };
  const issue = await gw.issue(task.repo, ref.ref);
  if (!issue || issue.state !== "open") return { ok: false, reason: `Issue #${ref.ref} 已关闭` };
  if (issue.assignee) return { ok: false, reason: `Issue #${ref.ref} 已被认领` };
  const linked = await gw.openLinkedPulls(task.repo, ref.ref);
  if (linked) return { ok: false, reason: `Issue #${ref.ref} 已有 ${linked} 个关联 PR` };
  return { ok: true, labels: (issue.labels || []).map((label) => label.name || label), text: `#${issue.number} ${issue.title}\n${String(issue.body || "").slice(0, 3000)}` };
}

async function submitPull({ gw, me, dir, task, patchFiles, title, body, policy }) {
  const upstream = await gw.repo(task.repo);
  const fork = await gw.fork(task.repo);
  const branch = `bug-hunter/${task.type}-${slug(title)}`;
  const email = `${me.id}+${me.login}@users.noreply.github.com`;
  const steps = [
    ["git", ["checkout", "-b", branch]],
    ["git", ["add", "--", ...patchFiles]],
    ["git", ["-c", `user.name=${me.name || me.login}`, "-c", `user.email=${email}`, "commit", ...(policy.dco ? ["--signoff"] : []), "-m", title]],
  ];
  for (const [command, args] of steps) {
    const result = sh(command, args, dir);
    if (!result.ok) throw new Error(`${command} ${args.join(" ")} 失败：${result.output}`);
  }
  const numstat = sh("git", ["diff", "--numstat", "HEAD~1", "HEAD"], dir).output;
  const deleted = sh("git", ["diff", "--diff-filter=D", "--name-only", "HEAD~1", "HEAD"], dir).output.split("\n").filter(Boolean);
  const gate = diffGate(numstat, deleted, { maxChangedLines: task.prStyle?.maxChangedLines });
  if (!gate.ok) throw new Error(`推送前检查失败：${gate.reason}`);
  const push = sh("git", ["push", `${GIT_BASE}/${fork}.git`, `HEAD:refs/heads/${branch}`], dir, { env: pushEnv(process.env.GH_PR_TOKEN || "", me.login) });
  if (!push.ok) throw new Error(`push 失败：${push.output.replace(/basic [A-Za-z0-9+/=]+/g, "basic ***")}`);
  const pr = await gw.createPull(task.repo, { title, body, head: `${fork.split("/")[0]}:${branch}`, base: upstream.default_branch, maintainer_can_modify: true });
  return pr.html_url;
}

export async function handleTask({ task, llm, gw, me, api, ctx }) {
  const dir = mkdtempSync(join(tmpdir(), "bug-hunter-"));
  const report = (status, extra = {}) => api("/api/attempts", { method: "POST", body: { id: task.id, status, ...extra } });
  try {
    const clone = sh("git", ["clone", "--depth", "1", `${GIT_BASE}/${task.repo}.git`, dir], undefined, { timeout: 300_000 });
    if (!clone.ok) return report("abandoned", { reason: `克隆失败：${clone.output.slice(-300)}` });
    const policy = inspectRepoPolicy(dir);
    if (policy.aiBan) return report("abandoned", { reason: "仓库贡献规则不接受 AI 生成的贡献，已拉黑该仓库", blockRepo: true });
    const wantsPr = task.writePolicy === "pr" && ctx.autopilot.autoSubmit;
    if (wantsPr && policy.cla && ctx.autopilot.claPolicy === "skip") return report("abandoned", { reason: "仓库要求签 CLA（CLA_POLICY=skip），跳过" });
    const facts = await issueFacts(gw, task);
    if (!facts.ok) return report("abandoned", { reason: facts.reason });

    const plan = detectTestCommand(dir);
    const baseline = runTests(dir, plan);
    const context = readContext(dir, task);
    let failure = null;
    let answer = null;
    let tests = null;
    let patchFiles = [];
    for (let round = 1; round <= 2; round += 1) {
      answer = await askForPatch(llm, { task, context, lessons: ctx.lessons, prStyle: ctx.prStyle, policy, issueText: facts.text, failure });
      if (!answer.data) return report("abandoned", { reason: `模型未返回补丁：${answer.status}` });
      if (answer.data.abandon) return report("abandoned", { reason: `模型判断机会不成立：${String(answer.data.abandon).slice(0, 400)}` });
      if (!Array.isArray(answer.data.files) || !answer.data.files.length) return report("abandoned", { reason: "模型没有给出文件修改" });
      sh("git", ["checkout", "--", "."], dir);
      sh("git", ["clean", "-fdq", "-e", ".bh-venv", "-e", "node_modules"], dir);
      patchFiles = applyFiles(dir, answer.data.files);
      tests = runTests(dir, plan);
      if (tests.ok) break;
      failure = tests.output;
    }
    const patch = sh("git", ["diff"], dir).output;
    const testLog = `基线：${baseline.ok ? "通过" : "失败"}\n${baseline.output.slice(-1500)}\n\n修改后：${tests.ok ? "通过" : "失败"}\n${tests.output}`;
    if (!tests.ok) return report("tests-failed", { reason: "两次修改都未通过测试", patch, testLog });

    const gate = diffGate(sh("git", ["diff", "--numstat"], dir).output, sh("git", ["diff", "--diff-filter=D", "--name-only"], dir).output.split("\n").filter(Boolean), { maxChangedLines: ctx.prStyle?.maxChangedLines });
    if (!gate.ok) return report("abandoned", { reason: `改动未通过自动把关：${gate.reason}`, patch, testLog });
    const review = await selfReview(llm, { task, diff: patch, testLog });
    if (!review.approve) return report("abandoned", { reason: `AI 审查未通过：${review.concerns.join("；") || review.status}`, patch, testLog });

    const out = join(OUT, task.id.replace(/[^\w.-]+/g, "_"));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "change.patch"), patch);
    const title = String(answer.data.prTitle || task.title).slice(0, 120);
    const body = prBody({ body: answer.data.prBody, task, testCommand: plan?.test || "the project's checks", issueLabels: facts.labels });
    writeFileSync(join(out, "pr.md"), `# ${title}\n\n${body}\n`);

    if (!wantsPr || tests.skipped) {
      const why = tests.skipped ? "仓库没有可运行的测试，无法自动验证，留作人工验收" : `write_policy=${task.writePolicy}，只产出补丁`;
      return report("ready-for-review", { reason: why, patch, testLog });
    }
    const permit = await api("/api/permit", { method: "POST", body: { id: task.id } });
    if (!permit.allowed) return report("ready-for-review", { reason: `补丁合格，但未获提交许可：${permit.reason}`, patch, testLog });
    const prUrl = await submitPull({ gw, me, dir, task: { ...task, prStyle: ctx.prStyle }, patchFiles, title, body, policy });
    await report("submitted", { reason: `测试通过、AI 审查通过，已自动提交（${gate.changed} 行 / ${gate.files} 个文件）`, patch, testLog, prUrl });
    if (policy.cla) await api("/api/events", { method: "POST", body: { id: task.id, kind: "needs-cla", detail: `${prUrl} 需要签 CLA` } });
    console.log(`✔ ${task.id}: ${prUrl}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- follow-ups on open PRs ----------

export async function followUp({ item, llm, gw, me, api, ctx }) {
  const ref = parsePullUrl(item.pr_url);
  if (!ref) return;
  const pull = await gw.pull(ref.repo, ref.number);
  if (pull.state !== "open") return;
  const sinceIso = item.last_followup_at || item.submitted_at;
  const activity = (await gw.activity(ref.repo, ref.number, sinceIso)).filter((row) => row.author !== me.login);
  const failing = (await gw.failingChecks(ref.repo, pull.head.sha)).filter((run) => !/\b(cla|dco)\b/i.test(run.name));
  if (!activity.length && !failing.length) return;
  const event = (kind, detail) => api("/api/events", { method: "POST", body: { id: item.id, kind, detail } });
  if (item.followup_count >= ctx.maxFollowups) return event("followup-limit", `${item.pr_url} 已自动跟进 ${item.followup_count} 次，有新动态待人工查看`);
  if (activity.some((row) => row.bot && /\bCLA\b/i.test(row.body) && /not signed|sign our|please sign/i.test(row.body))) {
    return event("needs-cla", `${item.pr_url} 的 CLA 机器人要求签署`);
  }

  const files = await gw.pullFiles(ref.repo, ref.number);
  const system = [
    "You maintain your own open pull request. Decide how to respond to new maintainer feedback and failing CI checks.",
    "Be brief and polite. If the maintainer says it is a duplicate or not wanted, close gracefully. If a fix is needed, return full new contents for changed files.",
    "Return JSON only: {\"action\":\"patch|reply|close|wait\",\"reply\":\"short English comment\",\"files\":[{\"path\":\"...\",\"content\":\"...\"}]}",
    `Lessons:\n${ctx.lessons.filter((lesson) => lesson.kind === "pr").map((lesson) => `- ${lesson.text}`).join("\n") || "- (none)"}`,
  ].join("\n");
  const user = [
    `PR ${item.pr_url}: ${pull.title}`,
    `Current diff:\n${files.map((file) => `--- ${file.filename}\n${String(file.patch || "").slice(0, 4000)}`).join("\n")}`,
    `New activity:\n${activity.map((row) => `[${row.where}] ${row.author}${row.bot ? " (bot)" : ""}: ${row.body}`).join("\n\n") || "(none)"}`,
    `Failing checks:\n${failing.map((run) => `${run.name}: ${run.title}\n${run.summary}`).join("\n\n") || "(none)"}`,
  ].join("\n\n");
  const answer = await llm.json(system, user, { maxTokens: 12000, timeoutMs: 180000 });
  const decision = answer.data || { action: "wait" };

  if (decision.action === "patch" && Array.isArray(decision.files) && decision.files.length) {
    const dir = mkdtempSync(join(tmpdir(), "bug-hunter-followup-"));
    try {
      const head = pull.head.repo.full_name;
      const clone = sh("git", ["clone", "--depth", "20", "--branch", pull.head.ref, `${GIT_BASE}/${head}.git`, dir], undefined, { timeout: 300_000 });
      if (!clone.ok) return event("followup", `克隆 PR 分支失败：${clone.output.slice(-300)}`);
      const changed = applyFiles(dir, decision.files);
      const tests = runTests(dir, detectTestCommand(dir));
      if (!tests.ok) return event("followup", `按反馈修改后测试未通过，未推送：${tests.output.slice(-400)}`);
      const email = `${me.id}+${me.login}@users.noreply.github.com`;
      sh("git", ["add", "--", ...changed], dir);
      const commit = sh("git", ["-c", `user.name=${me.name || me.login}`, "-c", `user.email=${email}`, "commit", ...(inspectRepoPolicy(dir).dco ? ["--signoff"] : []), "-m", "Address review feedback"], dir);
      if (!commit.ok) return event("followup", "反馈要求的修改与当前分支相同，无需推送");
      const push = sh("git", ["push", `${GIT_BASE}/${head}.git`, `HEAD:refs/heads/${pull.head.ref}`], dir, { env: pushEnv(process.env.GH_PR_TOKEN || "", me.login) });
      if (!push.ok) return event("followup", "推送修改失败");
      if (decision.reply) await gw.comment(ref.repo, ref.number, decision.reply);
      return event("followup", `已按反馈修改并推送：${decision.reply || "(无回复)"}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (decision.action === "close") {
    if (decision.reply) await gw.comment(ref.repo, ref.number, decision.reply);
    await gw.closePull(ref.repo, ref.number);
    return event("followup", `已主动关闭：${decision.reply || ""}`);
  }
  if (decision.action === "reply" && decision.reply) {
    await gw.comment(ref.repo, ref.number, decision.reply);
    return event("followup", `已回复：${decision.reply}`);
  }
  return event("followup", `有新动态，判断无需操作（${answer.status}）`);
}

// ---------- main ----------

async function main() {
  const { HUNTER_URL, HUNTER_TOKEN, GH_PR_TOKEN } = process.env;
  if (!HUNTER_URL || !HUNTER_TOKEN) throw new Error("需要 HUNTER_URL 和 HUNTER_TOKEN");
  if (!GH_PR_TOKEN) throw new Error("需要 GH_PR_TOKEN（提 PR 的账号令牌）");
  const raw = createLlm({ apiKey: process.env.CMD_API_KEY, endpoint: process.env.CMD_API_URL || undefined, model: process.env.CMD_MODEL || undefined });
  if (!raw.enabled) throw new Error("需要 CMD_API_KEY");
  const api = createHunter({ url: HUNTER_URL, token: HUNTER_TOKEN });
  const gw = createGitHubWriter({ token: GH_PR_TOKEN });
  const me = await gw.me();
  const meter = { calls: 0, tokens: 0 };
  try {
    const usage = await api("/api/usage", { method: "POST", body: { calls: 0, tokens: 0 } });
    const queue = await api(`/api/queue?limit=${Math.max(1, Math.min(5, Number(process.env.HUNT_LIMIT) || 2))}`);
    const budget = Math.max(0, queue.autopilot.executorDailyLlmCalls - Number(usage.today?.calls || 0));
    const llm = metered(raw, meter, budget);
    const ctx = { lessons: queue.lessons || [], prStyle: queue.prStyle, autopilot: queue.autopilot, maxFollowups: queue.autopilot.maxFollowups };
    console.log(`账号 ${me.login}；今日 AI 预算剩余 ${budget} 次；新任务 ${queue.tasks.length} 个`);

    const { followups } = await api("/api/followups");
    for (const item of followups.slice(0, 3)) {
      try { await followUp({ item, llm, gw, me, api, ctx }); }
      catch (error) { console.error(`✘ 跟进 ${item.pr_url}: ${error.message}`); }
    }
    for (const task of queue.tasks) {
      try { await handleTask({ task, llm, gw, me, api, ctx }); }
      catch (error) {
        console.error(`✘ ${task.id}: ${error.message}`);
        await api("/api/attempts", { method: "POST", body: { id: task.id, status: "abandoned", reason: `执行器错误：${error.message.slice(0, 300)}` } }).catch(() => {});
      }
    }
  } finally {
    if (meter.calls) await api("/api/usage", { method: "POST", body: meter }).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
