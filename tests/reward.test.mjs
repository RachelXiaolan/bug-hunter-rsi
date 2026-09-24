import test from "node:test";
import assert from "node:assert/strict";
import { rewardFor } from "../src/reward.js";

test("unsettled work does not produce a learning signal", () => {
  assert.equal(rewardFor({ status: "queued", track: "open-source" }, { contributor: 1 }).reward, null);
  assert.equal(rewardFor({ status: "submitted", track: "open-source" }, { contributor: 1 }).reward, null);
});

test("each goal scores the same event differently", () => {
  const opp = { status: "ready-for-review", track: "internal", team_verdict: "useful" };
  assert.equal(rewardFor(opp, { internal: 1 }).reward, 1);
  assert.equal(rewardFor(opp, { craft: 1 }).reward, 0.8);
  assert.equal(rewardFor({ status: "submitted", outcome: "merged", track: "open-source" }, { contributor: 1 }).reward, 1);
  assert.equal(rewardFor({ status: "submitted", outcome: "closed", track: "open-source" }, { contributor: 1 }).reward, -0.5);
});

test("goal mix averages only goals that have an opinion", () => {
  const { reward, parts } = rewardFor({ status: "tests-failed", track: "open-source" }, { contributor: 0.5, craft: 0.5, internal: 1 });
  assert.deepEqual(parts, { contributor: 0, craft: -0.3 });
  assert.equal(reward, -0.15);
});
