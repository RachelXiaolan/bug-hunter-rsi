import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("design page tells the Bug Hunter self-evolution story", async () => {
  const html = await readFile(resolve(project, "index.html"), "utf8");
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<html[^>]+lang="zh-CN"/i);
  assert.match(html, /name="viewport"/i);
  for (const section of ["overview", "inbox", "pipeline", "evolution-loop", "tree", "metrics", "playbook", "specimens", "coverage", "history", "architecture"]) {
    assert.match(html, new RegExp(`id="${section}"`), section);
  }
  for (const term of ["自动化让它每天都跑", "Playbook 进化树", "Bug 标本馆", "测试覆盖图", "修复历史", "团队内部工具", "Cron Trigger", "scheduled()", "D1", "Workers Static Assets", "执行器"]) {
    assert.ok(html.includes(term), term);
  }
  assert.match(html, /<img[^>]+bug-hunter-lab\.svg[^>]+alt=/i);
  assert.match(html, /<table/i);
  for (const heading of ["维度", "要回答的问题", "仓库", "机会", "状态", "奖励", "进化决策"]) {
    assert.match(html, new RegExp(`<th>${heading}</th>`), heading);
  }
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /@media \(max-width:/);
  assert.match(html, /setInterval\(\(\) => loadState\(\)/);
  assert.doesNotMatch(html, /innerHTML/, "remote text must never be injected as HTML");
  assert.doesNotMatch(html, /合成基准|模拟成绩/);
});

test("project illustration is a valid labelled SVG", async () => {
  const svg = await readFile(resolve(project, "assets/bug-hunter-lab.svg"), "utf8");
  assert.match(svg, /<svg[^>]+viewBox=/);
  assert.match(svg, /<title(?:\s[^>]*)?>/);
  assert.match(svg, /<desc(?:\s[^>]*)?>/);
});
