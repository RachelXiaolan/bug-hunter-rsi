import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const ORIGIN = "https://bug-hunter-rsi.test";

test("health identifies the service version", async () => {
  const response = await worker.fetch(new Request(`${ORIGIN}/api/health`), {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).version, "2.0.0");
});

test("health rejects unsupported write methods", async () => {
  const response = await worker.fetch(new Request(`${ORIGIN}/api/health`, { method: "POST" }), {});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("API routes never fall through to static assets", async () => {
  const env = { DB: {}, ASSETS: { fetch: async () => new Response("static fallback") } };
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/unknown`), env)).status, 404);
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/tick`, { method: "POST" }), env)).status, 403);
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/queue`), env)).status, 401);
});

test("executor routes are closed when no token is configured", async () => {
  const request = new Request(`${ORIGIN}/api/queue`, { headers: { authorization: "Bearer " } });
  assert.equal((await worker.fetch(request, { DB: {} })).status, 401);
});
