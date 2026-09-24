// GitHub REST client for the executor. Uses the PR account's token (GH_PR_TOKEN).
const API = "https://api.github.com";

export function createGitHubWriter({ token, fetcher = fetch }) {
  async function call(path, { method = "GET", body, allow404 = false } = {}) {
    const response = await fetcher(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "bug-hunter-executor",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (allow404 && response.status === 404) return null;
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new Error(`GitHub ${method} ${path} → ${response.status} ${payload?.message || ""}`);
    return payload;
  }
  const since = (rows, iso) => rows.filter((row) => !iso || row.at > iso);

  return {
    me: () => call("/user"),
    repo: (full) => call(`/repos/${full}`),
    issue: (full, number) => call(`/repos/${full}/issues/${number}`, { allow404: true }),
    openLinkedPulls: async (full, number) => {
      const events = await call(`/repos/${full}/issues/${number}/timeline?per_page=100`);
      return events.filter((event) => event.event === "cross-referenced" && event.source?.issue?.pull_request && event.source.issue.state === "open").length;
    },
    async fork(full) {
      const created = await call(`/repos/${full}/forks`, { method: "POST", body: { default_branch_only: true } });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (await call(`/repos/${created.full_name}`, { allow404: true })) return created.full_name;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      throw new Error(`fork ${created.full_name} not ready`);
    },
    createPull: (full, body) => call(`/repos/${full}/pulls`, { method: "POST", body }),
    pull: (full, number) => call(`/repos/${full}/pulls/${number}`),
    pullFiles: (full, number) => call(`/repos/${full}/pulls/${number}/files?per_page=30`),
    closePull: (full, number) => call(`/repos/${full}/pulls/${number}`, { method: "PATCH", body: { state: "closed" } }),
    comment: (full, number, body) => call(`/repos/${full}/issues/${number}/comments`, { method: "POST", body: { body } }),
    async activity(full, number, sinceIso) {
      const [comments, reviewComments, reviews] = await Promise.all([
        call(`/repos/${full}/issues/${number}/comments?per_page=50`),
        call(`/repos/${full}/pulls/${number}/comments?per_page=50`),
        call(`/repos/${full}/pulls/${number}/reviews?per_page=50`),
      ]);
      const rows = [
        ...comments.map((row) => ({ author: row.user?.login, bot: row.user?.type === "Bot", at: row.created_at, body: row.body, where: "comment" })),
        ...reviewComments.map((row) => ({ author: row.user?.login, bot: row.user?.type === "Bot", at: row.created_at, body: `${row.path}:${row.line ?? ""} ${row.body}`, where: "review-comment" })),
        ...reviews.filter((row) => row.body).map((row) => ({ author: row.user?.login, bot: row.user?.type === "Bot", at: row.submitted_at, body: `[${row.state}] ${row.body}`, where: "review" })),
      ];
      return since(rows, sinceIso).map((row) => ({ ...row, body: String(row.body || "").slice(0, 1500) }));
    },
    async failingChecks(full, sha) {
      const body = await call(`/repos/${full}/commits/${sha}/check-runs?per_page=50`);
      return (body.check_runs || [])
        .filter((run) => ["failure", "timed_out"].includes(run.conclusion))
        .map((run) => ({ name: run.name, title: run.output?.title || "", summary: String(run.output?.summary || run.output?.text || "").slice(0, 1500) }));
    },
  };
}
