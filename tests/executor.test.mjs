import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFiles, detectTestCommand } from "../executor/hunt-fix.mjs";

test("executor picks the repo's own test command", () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  assert.equal(detectTestCommand(dir), null);
  writeFileSync(join(dir, "go.mod"), "module x");
  assert.deepEqual(detectTestCommand(dir).test, ["go", ["test", "./..."]]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  assert.deepEqual(detectTestCommand(dir).test, ["npm", ["test"]]);
});

test("model patches cannot write outside the checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-"));
  applyFiles(dir, [{ path: "src/a.js", content: "ok" }]);
  assert.equal(readFileSync(join(dir, "src/a.js"), "utf8"), "ok");
  assert.throws(() => applyFiles(dir, [{ path: "../escape.js", content: "x" }]), /仓库外/);
  assert.throws(() => applyFiles(dir, [{ path: ".git/hooks/pre-commit", content: "x" }]), /仓库外/);
});
