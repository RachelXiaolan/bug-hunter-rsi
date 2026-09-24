// Automatic gates that replace a human reviewer before a PR is opened.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const read = (dir, name) => {
  try { return readFileSync(join(dir, name), "utf8"); } catch { return ""; }
};

function findFile(dir, pattern) {
  for (const base of ["", ".github", "docs"]) {
    const folder = join(dir, base);
    if (!existsSync(folder)) continue;
    const hit = readdirSync(folder).find((name) => pattern.test(name));
    if (hit) return read(folder, hit);
  }
  return "";
}

// What the repository's own rules say about contributions like ours.
export function inspectRepoPolicy(dir) {
  const contributing = findFile(dir, /^contributing(\.md|\.rst|\.txt)?$/i);
  const template = findFile(dir, /^pull_request_template(\.md)?$/i);
  const text = `${contributing}\n${read(dir, "README.md").slice(0, 20000)}`;
  const aiBan = /(do not|don't|will not|won't|not)\s+(accept|allow|welcome)[^.\n]{0,60}\b(ai|llm|machine)[- ]?(generated|assisted|written)?/i.test(text)
    || /\b(ai|llm)[- ]generated (contributions|pull requests|prs|code)[^.\n]{0,40}\b(prohibited|banned|not (accepted|allowed|welcome))/i.test(text)
    || /no (ai|llm)[- ](generated )?(contributions|prs|pull requests)/i.test(text);
  const cla = /\bCLA\b|contributor license agreement|cla-assistant/i.test(text) || existsSync(join(dir, ".clabot"));
  const dco = /\bDCO\b|developer certificate of origin|signed-off-by/i.test(text);
  return { aiBan, cla, dco, contributing: contributing.slice(0, 4000), template: template.slice(0, 2000) };
}

// Mirrors Tony's pre-push check: the diff must be exactly the small change we meant to make.
export function diffGate(numstat, deletedFiles, { maxChangedLines = 60, maxFiles = 5 } = {}) {
  const files = numstat.split("\n").filter(Boolean).map((line) => {
    const [added, removed, path] = line.split("\t");
    return { path, changed: (Number(added) || 0) + (Number(removed) || 0) };
  });
  const changed = files.reduce((sum, file) => sum + file.changed, 0);
  if (!files.length) return { ok: false, reason: "补丁为空" };
  if (deletedFiles.length) return { ok: false, reason: `补丁删除了整个文件：${deletedFiles.join(", ")}` };
  if (files.length > maxFiles) return { ok: false, reason: `改动了 ${files.length} 个文件，超过上限 ${maxFiles}` };
  if (changed > maxChangedLines * 1.5) return { ok: false, reason: `改动 ${changed} 行，超过上限 ${Math.round(maxChangedLines * 1.5)}` };
  const sensitive = files.find((file) => /^\.github\/workflows\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock)$/.test(file.path));
  if (sensitive) return { ok: false, reason: `不自动修改 ${sensitive.path}` };
  return { ok: true, files: files.length, changed };
}

export function prBody({ body, task, testCommand, issueLabels = [] }) {
  const issue = task.evidence.find((item) => item.kind === "issue");
  const invited = issueLabels.some((label) => /help wanted|good first issue/i.test(label));
  const reference = issue ? `\n\n${invited ? "Fixes" : "Refs"} #${issue.ref}` : "";
  const disclosure = `\n\n---\n_This change was prepared with the help of an AI assistant and verified locally by running \`${testCommand}\`. Happy to adjust anything._`;
  return `${String(body || task.summary).trim()}${reference}${disclosure}`;
}

export function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "fix";
}
