export const DEFAULT_ENDPOINT = "https://api.commandcode.ai/provider/v1/chat/completions";
export const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

export function parseJsonContent(content) {
  const source = Array.isArray(content)
    ? content.map((part) => typeof part === "string" ? part : part?.text || "").join("\n")
    : String(content || "");
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

// Returns { status, data, tokens }. Never throws: callers fall back to rule-based behaviour.
export function createLlm({ apiKey, endpoint = DEFAULT_ENDPOINT, model = DEFAULT_MODEL, fetcher = fetch } = {}) {
  return {
    enabled: Boolean(apiKey),
    model,
    // Reasoning models spend part of max_tokens thinking before they answer, so budgets are generous.
    async json(system, user, { maxTokens = 16000, timeoutMs = 120000 } = {}) {
      if (!apiKey) return { status: "secret-not-configured", data: null };
      try {
        const response = await fetcher(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return { status: `provider-http-${response.status}`, data: null };
        const payload = await response.json().catch(() => null);
        const choice = payload?.choices?.[0];
        const tokens = Number(payload?.usage?.total_tokens || 0);
        const content = choice?.message?.content;
        const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning;
        if (!content && !reasoning) return { status: `provider-empty-content-${choice?.finish_reason || "unknown"}`, data: null, tokens };
        for (const candidate of [content, reasoning]) {
          if (!candidate) continue;
          try { return { status: "ready", data: parseJsonContent(candidate), tokens }; } catch { /* try the next field */ }
        }
        return { status: content ? "provider-content-not-json" : `provider-empty-content-${choice?.finish_reason || "unknown"}`, data: null, tokens };
      } catch (error) {
        return { status: error?.name === "TimeoutError" ? "provider-timeout" : "provider-network-error", data: null };
      }
    },
  };
}

// Wraps an LLM client with a daily call budget recorded in D1 (table usage).
export function budgeted(llm, { db, source, dailyCalls, today = () => new Date().toISOString().slice(0, 10) }) {
  return {
    enabled: llm.enabled,
    model: llm.model,
    async json(system, user, options) {
      const day = today();
      const row = await db.prepare("SELECT calls FROM usage WHERE day = ? AND source = ?").bind(day, source).first();
      if (Number(row?.calls || 0) >= dailyCalls) return { status: "budget-exceeded", data: null, tokens: 0 };
      const answer = await llm.json(system, user, options);
      await db.prepare(`INSERT INTO usage(day, source, calls, tokens) VALUES (?, ?, 1, ?)
        ON CONFLICT(day, source) DO UPDATE SET calls = usage.calls + 1, tokens = usage.tokens + excluded.tokens`)
        .bind(day, source, Number(answer.tokens || 0)).run();
      return answer;
    },
  };
}
