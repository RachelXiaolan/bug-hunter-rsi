import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { runApiHunt } from "../src/live-hunt.js";

test("real API hunt records reproducible evidence and learns from an observed contract failure", async () => {
  const origin = "https://bug-hunter-rsi.test";
  const result = await runApiHunt({
    origin,
    invoke: (request) => request.url.endsWith("/api/health") && request.method !== "GET"
      ? new Response(JSON.stringify({ ok: true }), { status: 200 })
      : worker.fetch(request, {}),
    policy: { version: 1, cursor: 0, focus: "balanced" },
    knownFindings: [],
  });

  assert.ok(result.probes.length >= 5);
  assert.ok(result.probes.every((probe) => probe.request && probe.expected && probe.actual));
  assert.equal(result.probes.find((probe) => probe.id === "catalog-get")?.passed, true);
  assert.ok(result.findings.some((finding) => finding.id === "health-method-guard"));
  assert.equal(result.nextPolicy.focus, "methods");
  assert.ok(result.nextPolicy.version > 1);
});

test("a repeated API failure is regression evidence rather than a new bug", async () => {
  const origin = "https://bug-hunter-rsi.test";
  const result = await runApiHunt({
    origin,
    invoke: (request) => request.url.endsWith("/api/health") && request.method !== "GET"
      ? new Response(JSON.stringify({ ok: true }), { status: 200 })
      : worker.fetch(request, {}),
    policy: { version: 2, cursor: 2, focus: "methods" },
    knownFindings: ["health-method-guard"],
  });

  assert.equal(result.newFindings.length, 0);
  assert.ok(result.findings.some((finding) => finding.id === "health-method-guard"));
});

test("a confirmed old bug becomes resolved only after its reproduction passes", async () => {
  const result = await runApiHunt({
    origin: "https://bug-hunter-rsi.test",
    invoke: (request) => worker.fetch(request, {}),
    policy: { version: 2, cursor: 2, focus: "methods" },
    knownFindings: ["health-method-guard"],
  });
  assert.ok(result.probes.some((probe) => probe.id === "health-post" && probe.passed));
  assert.deepEqual(result.resolvedFindings, ["health-method-guard"]);
});
