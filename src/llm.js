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

// Returns { status, data }. Never throws: callers fall back to rule-based behaviour.
export function createLlm({ apiKey, endpoint = DEFAULT_ENDPOINT, model = DEFAULT_MODEL, fetcher = fetch } = {}) {
  return {
    enabled: Boolean(apiKey),
    model,
    async json(system, user, { maxTokens = 4096, timeoutMs = 45000 } = {}) {
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
        const content = payload?.choices?.[0]?.message?.content;
        if (!content) return { status: "provider-empty-content", data: null };
        try { return { status: "ready", data: parseJsonContent(content) }; }
        catch { return { status: "provider-content-not-json", data: null }; }
      } catch (error) {
        return { status: error?.name === "TimeoutError" ? "provider-timeout" : "provider-network-error", data: null };
      }
    },
  };
}
