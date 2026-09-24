import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "gitbase-"));
process.env.BUG_HUNTER_GIT_BASE = base;
process.env.SANDBOX = "none";
const { handleTask } = await import("../executor/hunt-fix.mjs");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const BUGGY = "export const add = (a, b) => a - b;\n";
const FIXED = "export const add = (a, b) => a + b;\n";

function makeRepo(contributing = "") {
  const work = mkdtempSync(join(tmpdir(), "work-"));
  writeFileSync(join(work, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(work, "math.js"), BUGGY);
  writeFileSync(join(work, "math.test.js"), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from './math.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  if (contributing) writeFileSync(join(work, "CONTRIBUTING.md"), contributing);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  mkdirSync(join(base, "up"), { recursive: true });
  mkdirSync(join(base, "me"), { recursive: true });
  const name = `calc${Math.random().toString(36).slice(2, 7)}`;
  git(base, "clone", "-q", "--bare", work, `up/${name}.git`);
  git(base, "clone", "-q", "--bare", work, `me/${name}.git`);
  return `up/${name}`;
}

function harness(repo, { permit = true, review = true } = {}) {
  const calls = [];
  const api = async (path, init = {}) => {
    calls.push({ path, body: init.body });
    if (path === "/api/permit") return { allowed: permit, reason: permit ? undefined : "cap" };
    return { ok: true };
  };
  const llm = { enabled: true, json: async (system) => /strict open-source maintainer/.test(system)
    ? { status: "ready", data: { approve: review, concerns: review ? [] : ["unrelated edits"] } }
    : { status: "ready", data: { files: [{ path: "math.js", content: FIXED }], prTitle: "fix: add returns the sum", prBody: "Problem: add subtracted." } } };
  const pulls = [];
  const gw = {
    issue: async () => null,
    repo: async () => ({ default_branch: "main" }),
    fork: async (full) => `me/${full.split("/")[1]}`,
    createPull: async (full, body) => { pulls.push({ full, body }); return { html_url: `https://github.com/${full}/pull/7` }; },
  };
  const task = { id: `${repo}#1`, repo, track: "open-source", writePolicy: "pr", profile: "library", type: "bug", title: "add subtracts", summary: "add() returns a-b", evidence: [{ kind: "file", ref: "math.js" }] };
  const ctx = { lessons: [], prStyle: { maxChangedLines: 60 }, autopilot: { autoSubmit: true, claPolicy: "skip" }, maxFollowups: 3 };
  return { run: () => handleTask({ task, llm, gw, me: { login: "me", id: 1 }, api, ctx }), calls, pulls };
}

test("a real bug is fixed, tested, gated and opened as a PR from the fork", async () => {
  const repo = makeRepo();
  const h = harness(repo);
  await h.run();
  const attempt = h.calls.find((call) => call.path === "/api/attempts");
  assert.equal(attempt.body.status, "submitted", attempt.body.reason);
  assert.equal(attempt.body.prUrl, `https://github.com/${repo}/pull/7`);
  assert.match(attempt.body.testLog, /基线：失败[\s\S]*修改后：通过/);
  assert.equal(h.pulls[0].body.base, "main");
  assert.match(h.pulls[0].body.head, /^me:bug-hunter\/bug-/);
  assert.match(h.pulls[0].body.body, /AI assistant/);
  const pushed = git(join(base, `me/${repo.split("/")[1]}.git`), "show", `${h.pulls[0].body.head.split(":")[1]}:math.js`);
  assert.equal(pushed, FIXED);
});

test("no permit means a ready patch but no PR", async () => {
  const h = harness(makeRepo(), { permit: false });
  await h.run();
  assert.equal(h.calls.find((call) => call.path === "/api/attempts").body.status, "ready-for-review");
  assert.equal(h.pulls.length, 0);
});

test("AI self-review can veto the PR", async () => {
  const h = harness(makeRepo(), { review: false });
  await h.run();
  const attempt = h.calls.find((call) => call.path === "/api/attempts").body;
  assert.equal(attempt.status, "abandoned");
  assert.match(attempt.reason, /AI 审查未通过/);
});

test("repos that refuse AI contributions are blocked before spending tokens", async () => {
  const h = harness(makeRepo("We do not accept AI-generated contributions."));
  await h.run();
  const attempt = h.calls.find((call) => call.path === "/api/attempts").body;
  assert.equal(attempt.blockRepo, true);
  assert.equal(h.pulls.length, 0);
});
