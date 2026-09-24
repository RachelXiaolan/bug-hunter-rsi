#!/usr/bin/env node
// Bug Hunter executor: the "hands" that the Cloudflare "brain" cannot be.
//
//   node executor/hunt-fix.mjs            claim queued opportunities, reproduce, patch, test, report back
//   node executor/hunt-fix.mjs --submit <opportunity-id>
//                                         after a human reviewed executor/out/<id>/, open the PR with gh
//
// Env: HUNTER_URL, HUNTER_TOKEN, CMD_API_KEY [, CMD_API_URL, CMD_MODEL, GITHUB_TOKEN, HUNT_LIMIT]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLlm } from "../src/llm.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "out");
const { HUNTER_URL, HUNTER_TOKEN } = process.env;
const MAX_FILE = 40_000;

function sh(command, args, cwd, timeout = 600_000) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout, maxBuffer: 20 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout || ""}${result.stderr || ""}`.slice(-6000) };
}

async function api(path, init = {}) {
  const response = await fetch(`${HUNTER_URL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${HUNTER_TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} → ${response.status} ${body.error || ""}`);
  return body;
}

const report = (id, status, extra = {}) => api("/api/attempts", { method: "POST", body: JSON.stringify({ id, status, ...extra }) });

export function detectTestCommand(dir) {
  const has = (name) => existsSync(join(dir, name));
  if (has("package.json")) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) {
      return { setup: has("package-lock.json") ? ["npm", ["ci", "--ignore-scripts"]] : ["npm", ["install", "--ignore-scripts"]], test: ["npm", ["test"]] };
    }
  }
  if (has("go.mod")) return { test: ["go", ["test", "./..."]] };
  if (has("Cargo.toml")) return { test: ["cargo", ["test", "--quiet"]] };
  if (has("pyproject.toml") || has("setup.py") || has("pytest.ini")) return { test: ["python3", ["-m", "pytest", "-q", "-x"]] };
  return null;
}

function runTests(dir, plan) {
  if (!plan) return { ok: true, output: "未识别到测试命令；只能人工审核。", skipped: true };
  if (plan.setup) {
    const setup = sh(plan.setup[0], plan.setup[1], dir);
    if (!setup.ok) return { ok: false, output: `安装依赖失败：\n${setup.output}` };
  }
  return sh(plan.test[0], plan.test[1], dir);
}

function readContext(dir, task) {
  const files = sh("git", ["ls-files"], dir).output.split("\n").filter(Boolean);
  const wanted = task.evidence.filter((item) => item.kind === "file").map((item) => item.ref).filter((path) => files.includes(path));
  return {
    tree: files.slice(0, 300).join("\n"),
    files: wanted.slice(0, 4).map((path) => ({ path, content: readFileSync(join(dir, path), "utf8").slice(0, MAX_FILE) })),
  };
}

async function askForPatch(llm, task, context, lessons, prStyle, previousFailure) {
  const system = [
    "You are Bug Hunter's fixing agent. Make the smallest correct change that resolves the opportunity, and add or update a test when the repo has tests.",
    `Keep the change under ${prStyle?.maxChangedLines || 60} changed lines. Do not reformat unrelated code.`,
    "Return JSON only: {\"files\":[{\"path\":\"relative/path\",\"content\":\"full new file content\"}],\"prTitle\":\"...\",\"prBody\":\"Problem / Root cause / Fix / Test plan\",\"abandon\":\"reason if the opportunity is not real\"}",
    `Lessons learned from past attempts:\n${lessons.map((lesson) => `- ${lesson.text}`).join("\n") || "- (none)"}`,
  ].join("\n");
  const user = [
    `Repository ${task.repo} (${task.profile}); opportunity type ${task.type}.`,
    `Title: ${task.title}\nSummary: ${task.summary}\nPlan: ${task.fixPlan || "(none)"}`,
    `Evidence: ${JSON.stringify(task.evidence)}`,
    previousFailure ? `Your previous patch failed the tests:\n${previousFailure}` : "",
    `Files:\n${context.files.map((file) => `--- ${file.path}\n${file.content}`).join("\n\n") || "(no evidence files; choose files from the tree)"}`,
    `Tree (first 300 files):\n${context.tree}`,
  ].join("\n\n");
  return llm.json(system, user, { maxTokens: 12000, timeoutMs: 120000 });
}

export function applyFiles(dir, files) {
  const root = resolve(dir);
  for (const file of files.slice(0, 5)) {
    const target = resolve(dir, file.path);
    if (!target.startsWith(`${root}/`) || target.includes("/.git/")) throw new Error(`拒绝写入仓库外路径：${file.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, String(file.content));
  }
}

async function handle(task, llm, lessons, prStyle) {
  const dir = mkdtempSync(join(tmpdir(), "bug-hunter-"));
  try {
    const clone = sh("git", ["clone", "--depth", "1", `https://github.com/${task.repo}.git`, dir], undefined, 300_000);
    if (!clone.ok) return report(task.id, "abandoned", { reason: `克隆失败：${clone.output.slice(-300)}` });
    const plan = detectTestCommand(dir);
    const baseline = runTests(dir, plan);
    const context = readContext(dir, task);
    let failure = null;
    for (let round = 1; round <= 2; round += 1) {
      const answer = await askForPatch(llm, task, context, lessons, prStyle, failure);
      if (!answer.data) return report(task.id, "abandoned", { reason: `模型未返回补丁：${answer.status}` });
      if (answer.data.abandon) return report(task.id, "abandoned", { reason: `模型判断机会不成立：${String(answer.data.abandon).slice(0, 400)}` });
      if (!Array.isArray(answer.data.files) || !answer.data.files.length) return report(task.id, "abandoned", { reason: "模型没有给出文件修改" });
      sh("git", ["checkout", "--", "."], dir);
      sh("git", ["clean", "-fdq"], dir);
      applyFiles(dir, answer.data.files);
      const tests = runTests(dir, plan);
      const patch = sh("git", ["diff"], dir).output;
      const testLog = `基线：${baseline.ok ? "通过" : "失败"}\n${baseline.output.slice(-1500)}\n\n修改后（第 ${round} 次）：${tests.ok ? "通过" : "失败"}\n${tests.output}`;
      if (tests.ok) {
        const out = join(OUT, task.id.replace(/[^\w.-]+/g, "_"));
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "change.patch"), patch);
        writeFileSync(join(out, "pr.md"), `# ${answer.data.prTitle || task.title}\n\n${answer.data.prBody || task.summary}\n`);
        writeFileSync(join(out, "task.json"), JSON.stringify(task, null, 2));
        const reason = tests.skipped ? "补丁已生成，仓库无可识别测试，需人工审核" : `测试通过（第 ${round} 次尝试），待人工审核`;
        console.log(`✔ ${task.id}: ${reason} → ${out}`);
        return report(task.id, "ready-for-review", { reason, patch, testLog });
      }
      failure = tests.output;
      if (round === 2) return report(task.id, "tests-failed", { reason: "两次修改都未通过测试", patch, testLog });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function submit(id) {
  const out = join(OUT, id.replace(/[^\w.-]+/g, "_"));
  const task = JSON.parse(readFileSync(join(out, "task.json"), "utf8"));
  if (task.writePolicy !== "pr") throw new Error(`${task.repo} 的写权限是 ${task.writePolicy}，不允许提交 PR`);
  const [titleLine, ...bodyLines] = readFileSync(join(out, "pr.md"), "utf8").split("\n");
  const dir = mkdtempSync(join(tmpdir(), "bug-hunter-submit-"));
  try {
    const steps = [
      ["gh", ["repo", "clone", task.repo, dir, "--", "--depth", "1"]],
      ["git", ["checkout", "-b", `bug-hunter/${id.replace(/[^\w-]+/g, "-").slice(-40)}`]],
      ["git", ["apply", join(out, "change.patch")]],
      ["git", ["commit", "-am", titleLine.replace(/^#\s*/, "")]],
      ["gh", ["repo", "fork", "--remote", "--remote-name", "fork"]],
      ["git", ["push", "-u", "fork", "HEAD"]],
    ];
    for (const [command, args] of steps) {
      const result = sh(command, args, command === "gh" && args[1] === "clone" ? undefined : dir);
      if (!result.ok) throw new Error(`${command} ${args.join(" ")} 失败：\n${result.output}`);
    }
    const pr = sh("gh", ["pr", "create", "--repo", task.repo, "--title", titleLine.replace(/^#\s*/, ""), "--body", bodyLines.join("\n").trim()], dir);
    const url = pr.output.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
    if (!url) throw new Error(`创建 PR 失败：\n${pr.output}`);
    await report(id, "submitted", { reason: "人工审核后提交", prUrl: url });
    console.log(`✔ PR 已提交：${url}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (!HUNTER_URL || !HUNTER_TOKEN) throw new Error("需要 HUNTER_URL 和 HUNTER_TOKEN 环境变量");
  const submitIndex = process.argv.indexOf("--submit");
  if (submitIndex > -1) return submit(process.argv[submitIndex + 1]);
  const llm = createLlm({ apiKey: process.env.CMD_API_KEY, endpoint: process.env.CMD_API_URL || undefined, model: process.env.CMD_MODEL || undefined });
  if (!llm.enabled) throw new Error("需要 CMD_API_KEY 才能生成补丁");
  const { tasks, lessons, prStyle } = await api(`/api/queue?limit=${Number(process.env.HUNT_LIMIT) || 1}`);
  if (!tasks.length) return console.log("队列为空。");
  for (const task of tasks) {
    try { await handle(task, llm, lessons, prStyle); }
    catch (error) {
      console.error(`✘ ${task.id}: ${error.message}`);
      await report(task.id, "abandoned", { reason: `执行器错误：${error.message.slice(0, 300)}` }).catch(() => {});
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
