const API = "https://api.github.com";
const MAINTAINER_ROLES = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export class GitHubError extends Error {
  constructor(status, path) {
    super(`GitHub ${status} for ${path}`);
    this.status = status;
  }
}

export function createGitHub({ token, fetcher = fetch } = {}) {
  let requests = 0;
  async function call(path, { accept = "application/vnd.github+json", allow404 = false } = {}) {
    requests += 1;
    const headers = { accept, "user-agent": "bug-hunter-rsi", "x-github-api-version": "2022-11-28" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetcher(`${API}${path}`, { headers });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new GitHubError(response.status, path);
    return accept.includes("raw") ? response.text() : response.json();
  }

  return {
    get requests() { return requests; },
    repo: (full) => call(`/repos/${full}`),
    rootEntries: async (full) => {
      const rows = await call(`/repos/${full}/contents/`, { allow404: true });
      return Array.isArray(rows) ? rows.map((row) => ({ name: row.name, type: row.type })) : [];
    },
    readme: async (full) => {
      const text = await call(`/repos/${full}/readme`, { accept: "application/vnd.github.raw+json", allow404: true });
      return typeof text === "string" ? text.slice(0, 6000) : "";
    },
    openIssues: async (full, perPage = 30) => {
      const rows = await call(`/repos/${full}/issues?state=open&sort=updated&per_page=${perPage}`);
      return rows.filter((row) => !row.pull_request).map((row) => ({
        number: row.number,
        title: row.title,
        labels: (row.labels || []).map((label) => typeof label === "string" ? label : label.name),
        comments: row.comments,
        assigned: Boolean(row.assignee),
        createdAt: row.created_at,
        body: String(row.body || "").slice(0, 500),
      }));
    },
    closedPulls: async (full, perPage = 30) => {
      const rows = await call(`/repos/${full}/pulls?state=closed&sort=updated&direction=desc&per_page=${perPage}`);
      return rows.map((row) => ({
        number: row.number,
        merged: Boolean(row.merged_at),
        external: !MAINTAINER_ROLES.has(row.author_association),
        createdAt: row.created_at,
        closedAt: row.closed_at,
      }));
    },
    searchRepos: async (query, perPage = 10) => {
      const body = await call(`/search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=${perPage}`);
      return (body.items || []).map((item) => ({
        id: item.full_name,
        stars: item.stargazers_count,
        pushedAt: item.pushed_at,
        openIssues: item.open_issues_count,
      }));
    },
    openLinkedPulls: async (full, issueNumber) => {
      const events = await call(`/repos/${full}/issues/${issueNumber}/timeline?per_page=100`);
      return events.filter((event) => event.event === "cross-referenced"
        && event.source?.issue?.pull_request && event.source.issue.state === "open").length;
    },
    issue: (full, number) => call(`/repos/${full}/issues/${number}`, { allow404: true }),
    pathExists: async (full, path) => Boolean(await call(`/repos/${full}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, { allow404: true })),
    pull: (full, number) => call(`/repos/${full}/pulls/${number}`, { allow404: true }),
    issueComments: async (full, number) => {
      const rows = await call(`/repos/${full}/issues/${number}/comments?per_page=30`);
      return rows.map((row) => ({ author: row.user?.login, association: row.author_association, body: String(row.body || "").slice(0, 400), at: row.created_at }));
    },
  };
}

export function parsePullUrl(url) {
  const match = String(url || "").match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}
