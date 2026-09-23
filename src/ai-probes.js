const ENDPOINT = "https://api.commandcode.ai/provider/v1/chat/completions";
const MODEL = "deepseek/deepseek-v4-flash";
const ALLOWED_PATHS = new Set(["/api/health", "/api/catalog", "/api/state"]);

function parseContent(content) {
  const source = Array.isArray(content)
    ? content.map((part) => typeof part === "string" ? part : part?.text || "").join("\n")
    : String(content || "");
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

export async function generateAiProbes({ apiKey, fetcher = fetch, knownFindings = [] }) {
  if (!apiKey) return { status: "secret-not-configured", probes: [] };
  try {
    const response = await fetcher(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [
          { role: "system", content: "Return JSON only: {\"probes\":[{\"method\":\"GET\",\"path\":\"/api/health?x=1\"}]}. Propose up to 4 unusual read-only query-string cases for GET /api/health, /api/catalog, /api/state. No other paths, no secrets, no prose." },
          { role: "user", content: `Known verified findings: ${knownFindings.join(", ") || "none"}. Find varied input encodings or boundary query strings. All three GET routes should keep their normal JSON response shape.` },
        ],
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) return { status: `provider-http-${response.status}`, probes: [] };
    let payload;
    try { payload = await response.json(); }
    catch { return { status: "provider-response-not-json", probes: [] }; }
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) return { status: `provider-empty-content-${payload?.choices?.[0]?.finish_reason || "unknown"}`, probes: [] };
    let suggestions;
    try { suggestions = parseContent(content)?.probes; }
    catch { return { status: "provider-content-not-json", probes: [] }; }
    if (!Array.isArray(suggestions)) return { status: "invalid-provider-output", probes: [] };
    const probes = [];
    const seen = new Set();
    for (const suggestion of suggestions) {
      if (suggestion?.method !== "GET" || typeof suggestion.path !== "string") continue;
      if (suggestion.path.length > 180 || !suggestion.path.startsWith("/api/")) continue;
      const parsed = new URL(suggestion.path, "https://local.invalid");
      if (!ALLOWED_PATHS.has(parsed.pathname) || !suggestion.path.startsWith(`${parsed.pathname}?`)) continue;
      if (seen.has(suggestion.path)) continue;
      seen.add(suggestion.path);
      probes.push({ method: "GET", path: suggestion.path });
      if (probes.length === 4) break;
    }
    return { status: "ready", model: MODEL, probes };
  } catch (error) {
    return { status: error?.name === "TimeoutError" ? "provider-timeout" : "provider-network-error", probes: [] };
  }
}
