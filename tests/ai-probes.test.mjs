import test from "node:test";
import assert from "node:assert/strict";
import { generateAiProbes } from "../src/ai-probes.js";

test("AI suggestions are bounded to documented, read-only API targets", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ probes: [
      { method: "GET", path: "/api/health?check=%E2%9C%93" },
      { method: "GET", path: "/api/catalog?limit=0" },
      { method: "POST", path: "/api/evolve" },
      { method: "GET", path: "https://other.example/secret" },
    ] }) } }] }), { status: 200 });
  };
  const result = await generateAiProbes({ apiKey: "test-secret", fetcher, knownFindings: [] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-secret");
  assert.equal(result.probes.length, 2);
  assert.ok(result.probes.every(({ method, path }) => method === "GET" && path.startsWith("/api/")));
  assert.ok(!JSON.stringify(result).includes("test-secret"));
});

test("AI suggestions inside a short markdown explanation still parse", async () => {
  const fetcher = async () => new Response(JSON.stringify({ choices: [{ message: {
    content: "Here are the probes:\n```json\n{\"probes\":[{\"method\":\"GET\",\"path\":\"/api/state?q=%00\"}]}\n```",
  } }] }), { status: 200 });
  const result = await generateAiProbes({ apiKey: "test-secret", fetcher });
  assert.equal(result.status, "ready");
  assert.equal(result.probes.length, 1);
});
