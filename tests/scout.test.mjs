import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PLAYBOOK } from "../src/config.js";
import { classifyProfile, computeFeatures, goalFit, normalizeDiagnosis, ruleBasedOpportunities, scoutRepo, verifyOpportunity } from "../src/scout.js";
import { fakeGitHub, fakeLlm, fakeRepo } from "./helpers/fakes.mjs";

const NOW = Date.parse("2026-09-24T00:00:00Z");

test("features are measured from real repository signals", () => {
  const fixture = fakeRepo("a/b", { mergeRate: 0.8 });
  const { features, facts } = computeFeatures({ ...fixture, now: NOW });
  assert.equal(features.externalMergeRate, 0.8);
  assert.equal(features.testsPresent, 1);
  assert.equal(features.contributingGuide, 1);
  assert.equal(facts.helpWanted, 1);
  for (const value of Object.values(features)) assert.ok(value >= 0 && value <= 1);
});

test("profile guess depends on track and repo shape", () => {
  const fixture = fakeRepo("a/b");
  assert.equal(classifyProfile({ track: "open-source", repo: fixture.repo, root: fixture.root }), "dev-tool");
  assert.equal(classifyProfile({ track: "internal", repo: { description: "招聘看板" }, root: [{ name: "index.html" }] }), "internal-app");
});

test("goal fit only counts goals that apply to the track", () => {
  const mix = { contributor: 0.5, internal: 0.5 };
  assert.equal(goalFit(mix, { type: "slimming", effort: "M", track: "internal" }), 1);
  assert.ok(goalFit(mix, { type: "slimming", effort: "M", track: "open-source" }) < 0.5);
});

test("model output is filtered to known types and checkable evidence", () => {
  const result = normalizeDiagnosis({
    profile: "library",
    opportunities: [
      { type: "bug", title: "空配置崩溃", evidence: [{ kind: "file", ref: "/main.go" }, { kind: "vibes", ref: "x" }], confidence: 3 },
      { type: "rewrite-everything", title: "x" },
    ],
  });
  assert.equal(result.profile, "library");
  assert.equal(result.opportunities.length, 1);
  assert.deepEqual(result.opportunities[0].evidence.map((item) => item.ref), ["main.go"]);
  assert.equal(result.opportunities[0].confidence, 1);
});

test("rule fallback skips assigned issues and ranks by learned priors", () => {
  const fixture = fakeRepo("a/b");
  const found = ruleBasedOpportunities({ issues: fixture.issues, playbook: DEFAULT_PLAYBOOK, profile: "dev-tool", track: "open-source" });
  assert.deepEqual(found.map((item) => item.evidence[0].ref), ["1", "2"]);
});

test("evidence check rejects claimed issues and invented files", async () => {
  const gh = fakeGitHub({ "a/b": fakeRepo("a/b") });
  const rootNames = new Set(["main.go", "cmd"]);
  const ok = await verifyOpportunity({ gh, full: "a/b", rootNames, opportunity: { evidence: [{ kind: "issue", ref: "1" }, { kind: "file", ref: "cmd/root.go" }] } });
  assert.equal(ok.verified, true);
  const linked = await verifyOpportunity({ gh, full: "a/b", rootNames, opportunity: { evidence: [{ kind: "issue", ref: "2" }] } });
  assert.equal(linked.verified, false);
  assert.match(linked.reason, /关联 PR/);
  const invented = await verifyOpportunity({ gh, full: "a/b", rootNames, opportunity: { evidence: [{ kind: "file", ref: "src/ghost.ts" }] } });
  assert.equal(invented.verified, false);
});

test("AI diagnosis is used when available and still verified by code", async () => {
  const gh = fakeGitHub({ "a/b": fakeRepo("a/b") });
  let prompt = "";
  const llm = fakeLlm((system, user) => {
    prompt = user;
    return { profile: "dev-tool", painPoints: ["空配置处理"], opportunities: [
      { type: "bug", title: "空配置崩溃", evidence: [{ kind: "file", ref: "main.go" }], effort: "S", confidence: 0.8 },
      { type: "ux-ui", title: "虚构文件", evidence: [{ kind: "file", ref: "web/app.tsx" }], effort: "S", confidence: 0.9 },
    ] };
  });
  const result = await scoutRepo({ gh, llm, target: { id: "a/b", track: "open-source" }, playbook: DEFAULT_PLAYBOOK, now: NOW });
  assert.match(prompt, /Hunting lessons/);
  assert.equal(result.llmStatus, "ready");
  assert.deepEqual(result.opportunities.map((opp) => opp.verification.verified), [true, false]);
});
