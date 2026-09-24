import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFiles, detectTestCommand } from "../executor/hunt-fix.mjs";
import { diffGate, inspectRepoPolicy, prBody } from "../executor/policy.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "exec-"));

test("executor picks the repo's own test command and a matching sandbox image", () => {
  const dir = scratch();
  assert.equal(detectTestCommand(dir), null);
  writeFileSync(join(dir, "go.mod"), "module x");
  assert.equal(detectTestCommand(dir).test, "go test ./...");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  assert.equal(detectTestCommand(dir).image, "node:22");
});

test("model patches cannot write outside the checkout", () => {
  const dir = scratch();
  applyFiles(dir, [{ path: "src/a.js", content: "ok" }]);
  assert.equal(readFileSync(join(dir, "src/a.js"), "utf8"), "ok");
  assert.throws(() => applyFiles(dir, [{ path: "../escape.js", content: "x" }]), /仓库外/);
  assert.throws(() => applyFiles(dir, [{ path: ".git/hooks/pre-commit", content: "x" }]), /仓库外/);
});

test("repository rules are read before any work", () => {
  const dir = scratch();
  writeFileSync(join(dir, "CONTRIBUTING.md"), "We do not accept AI-generated pull requests.\nAll commits need a Signed-off-by line (DCO).");
  assert.deepEqual((({ aiBan, cla, dco }) => ({ aiBan, cla, dco }))(inspectRepoPolicy(dir)), { aiBan: true, cla: false, dco: true });
  const other = scratch();
  writeFileSync(join(other, "CONTRIBUTING.md"), "Please sign our Contributor License Agreement before we can merge.");
  const policy = inspectRepoPolicy(other);
  assert.equal(policy.aiBan, false);
  assert.equal(policy.cla, true);
});

test("diff gate blocks oversized, destructive or sensitive changes", () => {
  assert.equal(diffGate("3\t1\tsrc/a.go\n4\t0\tsrc/a_test.go", []).ok, true);
  assert.match(diffGate("0\t13744\trun_agent.py", ["run_agent.py"]).reason, /删除了整个文件/);
  assert.match(diffGate("200\t0\tsrc/a.go", []).reason, /超过上限/);
  assert.match(diffGate("1\t1\t.github/workflows/ci.yml", []).reason, /不自动修改/);
});

test("PR body links the issue safely and discloses AI assistance", () => {
  const task = { summary: "s", evidence: [{ kind: "issue", ref: "42" }] };
  assert.match(prBody({ body: "Problem", task, testCommand: "go test ./...", issueLabels: ["help wanted"] }), /Fixes #42[\s\S]*AI assistant[\s\S]*go test/);
  assert.match(prBody({ body: "Problem", task, testCommand: "npm test", issueLabels: [] }), /Refs #42/);
});
