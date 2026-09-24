import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import { buildRsiStatus } from "../src/rsi-status.js";
import { createD1 } from "./helpers/d1.mjs";

const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
const ORIGIN = "https://bug-hunter-rsi.test";

async function seeded() {
  const db = await createD1(migrations);
  const insertPlaybook = (version, status, diff) => db.raw.prepare(`INSERT INTO playbooks(version, parent, status, created_at, playbook_json, diff_json, metrics_json, reason)
    VALUES (?, ?, ?, ?, '{}', ?, '{}', 'test')`).run(version, version > 1 ? version - 1 : null, status, `2026-09-2${version}T00:00:00.000Z`, JSON.stringify(diff));
  insertPlaybook(1, "retired", []);
  insertPlaybook(2, "champion", [{ area: "挑仓库", key: "activity", from: 0.2, to: 0.4 }, { area: "找和修", key: "新增经验", to: "x" }]);
  const insertRound = (day, status, finished) => db.raw.prepare(`INSERT INTO rounds(id, day, status, champion_version, created_at, finished_at, summary)
    VALUES (?, ?, ?, 1, ?, ?, 'summary')`).run(`round-${day}`, day, status, `${day}T00:00:00.000Z`, finished);
  insertRound("2026-09-22", "finalized", "2026-09-22T20:00:00.000Z");
  insertRound("2026-09-23", "scouting", null);
  insertRound("2026-09-24", "finalized", "2026-09-24T19:00:00.000Z");
  insertRound("2026-09-25", "scouting", null);
  const insertStep = (day, decision, candidate) => db.raw.prepare(`INSERT INTO evolution_steps(id, round_id, at, decision, reason, candidate_version, metrics_json, llm_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'not-used')`).run(`round-${day}:evolve`, `round-${day}`, `${day}T19:00:00.000Z`, decision, `reason ${day}`, candidate,
    JSON.stringify(candidate ? { championScore: 0.5, candidateScore: 0.6 } : { settled: 1 }));
  insertStep("2026-09-22", "insufficient-evidence", null);
  insertStep("2026-09-24", "promoted", 2);
  return db;
}

test("rsi-status turns finished rounds into runs and skips today's round in progress", async () => {
  const status = await buildRsiStatus(await seeded(), new Date("2026-09-25T08:00:00Z"));
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.schedule.cron, "0 0 * * *");
  assert.equal(status.current.version, "playbook v2");
  assert.deepEqual(status.runs.map((run) => [run.finishedAt.slice(0, 10), run.ok]), [["2026-09-24", true], ["2026-09-23", false], ["2026-09-22", true]]);
  const [promoted, unfinished, quiet] = status.runs;
  assert.deepEqual(promoted.changed.sort(), ["rule", "weight"]);
  assert.deepEqual(promoted.score, { before: 0.5, after: 0.6 });
  assert.equal(promoted.version, "playbook v2");
  assert.equal(unfinished.error, "当天的轮次没有完成");
  assert.deepEqual(quiet.changed, ["data"]);
});

test("rsi-status is served by the worker with CORS and short caching", async () => {
  const env = { DB: await seeded(), ASSETS: { fetch: async () => new Response("static fallback") } };
  const response = await worker.fetch(new Request(`${ORIGIN}/rsi-status.json`), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cache-control"), "public, max-age=60");
  assert.ok(Array.isArray((await response.json()).runs));
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/rsi-status.json`, { method: "POST" }), env)).status, 405);
});
