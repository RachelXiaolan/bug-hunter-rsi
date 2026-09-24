import test from "node:test";
import assert from "node:assert/strict";
import { createLlm } from "../src/llm.js";

const reply = (message, finish = "stop") => async () => new Response(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage: { total_tokens: 42 } }));

test("empty answers report why, e.g. the reasoning budget ran out", async () => {
  const llm = createLlm({ apiKey: "k", fetcher: reply({ content: "" }, "length") });
  const answer = await llm.json("s", "u");
  assert.equal(answer.status, "provider-empty-content-length");
  assert.equal(answer.tokens, 42);
});

test("JSON is recovered from content or, failing that, reasoning", async () => {
  assert.deepEqual((await createLlm({ apiKey: "k", fetcher: reply({ content: "```json\n{\"a\":1}\n```" }) }).json("s", "u")).data, { a: 1 });
  assert.deepEqual((await createLlm({ apiKey: "k", fetcher: reply({ content: "", reasoning_content: "thinking... {\"b\":2}" }) }).json("s", "u")).data, { b: 2 });
});

test("the default budget leaves room for reasoning", async () => {
  let sent;
  const llm = createLlm({ apiKey: "k", fetcher: async (_url, init) => { sent = JSON.parse(init.body); return reply({ content: "{}" })(); } });
  await llm.json("s", "u");
  assert.ok(sent.max_tokens >= 16000);
});
