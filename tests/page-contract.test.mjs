import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, "..");

test("design page contains the complete Bug Hunter project story", async () => {
  const html = await readFile(resolve(project, "index.html"), "utf8");

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<html[^>]+lang="zh-CN"/i);
  assert.match(html, /name="viewport"/i);
  assert.match(html, /Bug Hunter/);
  assert.match(html, /递归自我改进/);
  assert.match(html, /每天不是重复运行，而是改变下一次如何寻找缺陷/);

  for (const section of [
    "overview",
    "evolution-loop",
    "metrics",
    "specimens",
    "history",
    "architecture",
    "roadmap",
  ]) {
    assert.match(html, new RegExp(`id="${section}"`));
  }

  assert.match(html, /<img[^>]+bug-hunter-lab\.svg[^>]+alt=/i);
  assert.match(html, /<table/i);
  for (const heading of ["运行时间", "触发方式", "检查数", "新标本", "回归通过", "记录摘要"]) {
    assert.match(html, new RegExp(`<th[^>]*>\\s*${heading}\\s*</th>`));
  }

  for (const term of [
    "Bug 标本馆",
    "测试覆盖图",
    "修复历史",
    "Cloudflare Worker",
    "Cron Trigger",
    "scheduled()",
    "D1",
    "Workers Static Assets",
  ]) {
    assert.match(html, new RegExp(term.replace(/[()]/g, "\\$&")));
  }

  assert.match(html, /aria-live="polite"/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /@media\s*\(max-width:/);
  assert.match(html, /<script>/);
  assert.match(html, /data-metric="generation"/);
  assert.match(html, /id="operator-weights"/);
  assert.match(html, /id="generation-history"/);
  assert.match(html, /id="candidate-history"/);
  assert.match(html, /setInterval\(\(\)\s*=>\s*loadState\(\)/);
  assert.match(html, /合成基准/);
  assert.match(html, /100% 回归/);
});

test("project illustration is a valid labelled SVG", async () => {
  const svg = await readFile(resolve(project, "assets/bug-hunter-lab.svg"), "utf8");
  assert.match(svg, /<svg[^>]+viewBox=/);
  assert.match(svg, /<title(?:\s[^>]*)?>/);
  assert.match(svg, /<desc(?:\s[^>]*)?>/);
});
