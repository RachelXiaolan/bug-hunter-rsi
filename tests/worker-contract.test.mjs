import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("health identifies the deployed RSI phase", async () => {
  const response = await worker.fetch(new Request("https://bug-hunter-rsi.test/api/health"), {});
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.phase, "evolving-strategy");
});

test("health rejects unsupported write methods", async () => {
  const response = await worker.fetch(new Request("https://bug-hunter-rsi.test/api/health", {
    method: "POST",
  }), {});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("evolution endpoint never falls through to the static asset handler", async () => {
  const response = await worker.fetch(
    new Request("https://bug-hunter-rsi.test/api/evolve", { method: "POST" }),
    { ASSETS: { fetch: async () => new Response("static fallback", { status: 200 }) } },
  );

  assert.equal(response.status, 403);
  assert.match(await response.text(), /Same-origin/);
});
