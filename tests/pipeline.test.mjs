import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import worker from "../src/index.js";
import { parseTargetList, selectRepos, tick } from "../src/pipeline.js";
import { DEFAULT_PLAYBOOK } from "../src/config.js";
import { createD1 } from "./helpers/d1.mjs";
import { fakeGitHub, fakeRepo } from "./helpers/fakes.mjs";

const migrations = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const ORIGIN = "https://hunter.test";
const env = (db) => ({ DB: db, HUNTER_TOKEN: "secret-token", INTERNAL_REPOS: "team/dashboard", OSS_REPOS: "oss/cli:pr", DISCOVERY: "off" });

async function runDay(db, gh, day, llm = null) {
  const now = new Date(`${day}T01:00:00Z`);
  const steps = [];
  for (let index = 0; index < 20; index += 1) {
    const result = await tick({ db, gh, llm, env: env(db), now });
    steps.push(result);
    if (result.step === "finalized" || result.step === "idle") break;
  }
  return steps;
}

test("target lists default to safe write policies", () => {
  assert.deepEqual(parseTargetList("me/tool, bad-entry, org/lib:pr", "internal"), [
    { id: "me/tool", track: "internal", writePolicy: "readonly" },
    { id: "org/lib", track: "internal", writePolicy: "pr" },
  ]);
});

test("slots are split between champion, challenger and exploration", () => {
  const candidates = Array.from({ length: 10 }, (_, index) => ({ id: `o/r${index}`, track: "open-source", features: { externalMergeRate: index / 10 } }));
  const picked = selectRepos({ candidates, champion: { ...DEFAULT_PLAYBOOK, version: 1 }, challenger: { ...DEFAULT_PLAYBOOK, version: 2 }, day: "2026-09-24", slots: 10 });
  const arms = picked.reduce((count, item) => ({ ...count, [item.arm]: (count[item.arm] || 0) + 1 }), {});
  assert.deepEqual(arms, { challenger: 3, champion: 6, explore: 1 });
  assert.equal(new Set(picked.map((item) => item.id)).size, 10);
});

test("a daily round scouts real targets, verifies evidence and queues fixes", async () => {
  const db = await createD1(migrations);
  const gh = fakeGitHub({ "team/dashboard": fakeRepo("team/dashboard"), "oss/cli": fakeRepo("oss/cli") });
  const steps = await runDay(db, gh, "2026-09-24");
  assert.deepEqual(steps.map((step) => step.step), ["planned", "scouted", "scouted", "finalized"]);
  assert.equal(steps.at(-1).decision, "insufficient-evidence");
  const opps = (await db.prepare("SELECT repo, status, write_policy FROM opportunities ORDER BY id").all()).results;
  assert.equal(opps.length, 4);
  assert.equal(opps.filter((opp) => opp.status === "discarded").length, 2, "issue #2 already has a linked PR");
  assert.equal(opps.filter((opp) => opp.status === "queued").length, 2);
  assert.equal(opps.find((opp) => opp.repo === "team/dashboard").write_policy, "readonly");
  assert.equal((await runDay(db, gh, "2026-09-24")).at(-1).step, "idle");
});

test("executor, PR tracking and team feedback close the loop into evolution", async () => {
  const db = await createD1(migrations);
  const repos = {};
  for (const id of ["team/dashboard", "oss/cli"]) repos[id] = fakeRepo(id);
  const pullsById = {};
  const gh = fakeGitHub(repos, { pullsById });
  const call = (path, init = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env(db));
  const authed = { authorization: "Bearer secret-token", "content-type": "application/json" };

  assert.equal((await call("/api/queue")).status, 401);
  let prNumber = 1;
  for (let day = 1; day <= 12; day += 1) {
    const date = `2026-10-${String(day).padStart(2, "0")}`;
    await runDay(db, gh, date);
    const queue = await (await call("/api/queue?limit=5", { headers: authed })).json();
    for (const task of queue.tasks) {
      if (task.writePolicy === "readonly") {
        const refused = await call("/api/attempts", { method: "POST", headers: authed, body: JSON.stringify({ id: task.id, status: "submitted", prUrl: "https://github.com/team/dashboard/pull/1" }) });
        assert.equal(refused.status, 409, "read-only repos never get PRs");
        await call("/api/attempts", { method: "POST", headers: authed, body: JSON.stringify({ id: task.id, status: "ready-for-review", patch: "diff", testLog: "ok" }) });
        const vote = await call("/api/feedback", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ id: task.id, verdict: "useful" }) });
        assert.equal(vote.status, 200);
      } else {
        const url = `https://github.com/${task.repo}/pull/${prNumber}`;
        pullsById[`${task.repo}#${prNumber}`] = { merged_at: "2026-10-20T00:00:00Z", state: "closed", comments: 2, created_at: "2026-10-01T00:00:00Z" };
        prNumber += 1;
        const early = await call("/api/attempts", { method: "POST", headers: authed, body: JSON.stringify({ id: task.id, status: "submitted", prUrl: url }) });
        assert.equal(early.status, 409, "no PR without a permit");
        const permit = await (await call("/api/permit", { method: "POST", headers: authed, body: JSON.stringify({ id: task.id }) })).json();
        if (!permit.allowed) continue;
        const response = await call("/api/attempts", { method: "POST", headers: authed, body: JSON.stringify({ id: task.id, status: "submitted", prUrl: url }) });
        assert.equal(response.status, 200);
      }
    }
  }
  const state = await (await call("/api/state")).json();
  assert.ok(state.totals.settled >= 5, "outcomes were settled into rewards");
  assert.ok(state.totals.merged > 0);
  assert.ok(state.evolution.some((step) => step.decision !== "insufficient-evidence"), "evolution acted once evidence existed");
  assert.ok(state.playbooks.length >= 1);
  assert.equal(state.playbooks[0].version, 1);
  assert.ok(state.coverage.length > 0);
  assert.ok(state.autopilot.maxPrsPerDay >= 1);
  assert.ok(state.opportunities.some((opp) => opp.outcome === "merged"));
});

test("permits enforce the kill switch, write policy and daily cap", async () => {
  const db = await createD1(migrations);
  const gh = fakeGitHub({ "team/dashboard": fakeRepo("team/dashboard"), "oss/cli": fakeRepo("oss/cli") });
  await runDay(db, gh, "2026-09-24");
  const base = env(db);
  const call = (path, init, extra = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), { ...base, ...extra });
  const authed = { authorization: "Bearer secret-token", "content-type": "application/json" };
  const { tasks } = await (await call("/api/queue?limit=5", { headers: authed })).json();
  const internal = tasks.find((task) => task.repo === "team/dashboard");
  const oss = tasks.find((task) => task.repo === "oss/cli");
  const ask = async (id, extra) => (await call("/api/permit", { method: "POST", headers: authed, body: JSON.stringify({ id }) }, extra)).json();
  assert.equal((await ask(internal.id)).allowed, false, "readonly repos never get PRs");
  assert.equal((await ask(oss.id, { AUTO_SUBMIT: "off" })).allowed, false);
  assert.equal((await ask(oss.id, { MAX_PRS_PER_DAY: "0" })).allowed, false);
  assert.equal((await ask(oss.id)).allowed, true);
  const usage = await (await call("/api/usage", { method: "POST", headers: authed, body: JSON.stringify({ calls: 3, tokens: 1200 }) })).json();
  assert.deepEqual({ ...usage.today }, { calls: 3, tokens: 1200 });
});

test("state endpoint works on an empty database", async () => {
  const db = await createD1(migrations);
  const response = await worker.fetch(new Request(`${ORIGIN}/api/state`), { DB: db });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.champion.version, 1);
  assert.equal(body.capabilities.llm, false);
  assert.deepEqual(body.opportunities, []);
});
