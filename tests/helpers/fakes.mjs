// Deterministic GitHub and LLM doubles with the same surface as src/github.js and src/llm.js.
const DAY = 86_400_000;

export function fakeRepo(id, { mergeRate = 0.5, stars = 3000, now = Date.parse("2026-09-24T00:00:00Z") } = {}) {
  const pulls = Array.from({ length: 10 }, (_, index) => ({
    number: 100 + index,
    merged: index < Math.round(mergeRate * 10),
    external: true,
    createdAt: new Date(now - 10 * DAY).toISOString(),
    closedAt: new Date(now - 9 * DAY).toISOString(),
  }));
  return {
    repo: { full_name: id, stargazers_count: stars, pushed_at: new Date(now - 2 * DAY).toISOString(), open_issues_count: 12, size: 900, language: "Go", topics: ["cli"], description: "A command-line tool" },
    root: [{ name: "cmd", type: "dir" }, { name: "main.go", type: "file" }, { name: "CONTRIBUTING.md", type: "file" }, { name: "tests", type: "dir" }],
    readme: `# ${id}\nA CLI tool.`,
    issues: [
      { number: 1, title: "Crash when config is empty", labels: ["bug", "help wanted"], comments: 1, assigned: false, createdAt: "2026-09-01T00:00:00Z", body: "" },
      { number: 2, title: "Add --json output", labels: ["enhancement"], comments: 3, assigned: false, createdAt: "2026-09-01T00:00:00Z", body: "" },
      { number: 3, title: "Claimed bug", labels: ["bug"], comments: 0, assigned: true, createdAt: "2026-09-01T00:00:00Z", body: "" },
    ],
    pulls,
    issueDetails: { 1: { state: "open", assignee: null }, 2: { state: "open", assignee: null } },
    linked: { 2: 1 },
    files: new Set(["main.go", "cmd/root.go"]),
  };
}

export function fakeGitHub(repos, { search = [], pullsById = {} } = {}) {
  const get = (full) => {
    const repo = repos[full];
    if (!repo) throw Object.assign(new Error(`GitHub 404 for ${full}`), { status: 404 });
    return repo;
  };
  return {
    repo: async (full) => get(full).repo,
    rootEntries: async (full) => get(full).root,
    readme: async (full) => get(full).readme,
    openIssues: async (full) => get(full).issues,
    closedPulls: async (full) => get(full).pulls,
    searchRepos: async () => search,
    openLinkedPulls: async (full, number) => Number(get(full).linked[number] || 0),
    issue: async (full, number) => get(full).issueDetails[number] || null,
    pathExists: async (full, path) => get(full).files.has(path),
    pull: async (full, number) => pullsById[`${full}#${number}`] || null,
    issueComments: async () => [{ author: "maintainer", association: "OWNER", body: "Thanks, looks good.", at: "2026-10-02T00:00:00Z" }],
  };
}

export function fakeLlm(handler) {
  return { enabled: true, model: "fake", json: async (system, user) => ({ status: "ready", data: handler(system, user) }) };
}
