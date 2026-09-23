const BASE_PROBES = [
  { id: "health-get", method: "GET", path: "/api/health", expected: "200 JSON ok=true", check: (status, body) => status === 200 && body?.ok === true },
  { id: "catalog-get", method: "GET", path: "/api/catalog", expected: "200 JSON samples[]", check: (status, body) => status === 200 && Array.isArray(body?.samples) },
  { id: "state-get", method: "GET", path: "/api/state", expected: "200 JSON framework+metrics", check: (status, body) => status === 200 && Boolean(body?.framework && body?.metrics) },
  { id: "unknown-get", method: "GET", path: "/api/hunter-missing-route", expected: "404 JSON error", check: (status, body) => status === 404 && typeof body?.error === "string" },
];

const METHOD_PROBES = ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"].map((method) => ({
  id: `health-${method.toLowerCase()}`,
  method,
  path: "/api/health",
  expected: "405 unsupported method",
  check: (status) => status === 405,
  findingId: "health-method-guard",
  title: "健康接口接受不支持的请求方法",
  recommendation: "为 /api/health 显式限制允许的方法，并用其他方法的请求作为回归测试。",
}));

async function execute(probe, origin, invoke) {
  const request = `${probe.method} ${probe.path}`;
  try {
    const response = await invoke(new Request(new URL(probe.path, origin), { method: probe.method }));
    const fullText = await response.text();
    const text = fullText.slice(0, 600);
    let body = null;
    try { body = JSON.parse(fullText); } catch { /* Non-JSON responses are captured below. */ }
    return {
      id: probe.id, request, expected: probe.expected,
      actual: `HTTP ${response.status}; ${text || "(empty body)"}`,
      status: response.status,
      passed: probe.check(response.status, body),
      inconclusive: response.status >= 500,
    };
  } catch (error) {
    return { id: probe.id, request, expected: probe.expected,
      actual: `request error: ${error instanceof Error ? error.message : String(error)}`,
      status: 0, passed: false, inconclusive: true };
  }
}

export async function runApiHunt({ origin, invoke, policy, knownFindings = [], openFindings = knownFindings, suggestedProbes = [] }) {
  const cursor = Number(policy?.cursor || 0);
  const aiProbes = suggestedProbes.map((suggestion, index) => {
    const path = new URL(suggestion.path, origin).pathname;
    const base = BASE_PROBES.find((probe) => probe.path === path);
    return base && suggestion.method === "GET" ? {
      ...base,
      id: `ai-${index}-${base.id}`,
      path: suggestion.path,
      findingId: `${base.id}-query-response-shape`,
      title: `${path} 在特殊查询参数下响应结构异常`,
      recommendation: "保留失败的查询参数作为回归用例，并检查解析或路由逻辑。",
    } : null;
  }).filter(Boolean).slice(0, 4);
  const selected = [
    ...BASE_PROBES,
    METHOD_PROBES[cursor % METHOD_PROBES.length],
    METHOD_PROBES[(cursor + 1) % METHOD_PROBES.length],
    ...(knownFindings.includes("health-method-guard") ? [METHOD_PROBES[0]] : []),
    ...aiProbes,
  ].filter((probe, index, probes) => probes.findIndex((item) => item.id === probe.id) === index);
  const probes = [];
  const findings = [];
  for (const probe of selected) {
    const evidence = await execute(probe, origin, invoke);
    probes.push(evidence);
    if (evidence.passed || evidence.inconclusive || !probe.findingId) continue;
    const confirmation = await execute(probe, origin, invoke);
    if (confirmation.status !== evidence.status || confirmation.passed || confirmation.inconclusive) continue;
    if (!findings.some((finding) => finding.id === probe.findingId)) {
      findings.push({
        id: probe.findingId,
        title: probe.title,
        severity: "low",
        category: "API 方法契约",
        description: `真实 API 在 ${probe.path} 接受了未声明的方法；两次请求返回相同状态。`,
        reproduction: `${evidence.request} → ${evidence.actual}`,
        recommendation: probe.recommendation,
        expected: probe.expected,
        actual: evidence.actual,
      });
    }
  }
  const known = new Set(knownFindings);
  const newFindings = findings.filter((finding) => !known.has(finding.id));
  const resolvedFindings = openFindings.filter((id) => id === "health-method-guard"
    && !findings.some((finding) => finding.id === id)
    && probes.some((probe) => probe.id === "health-post" && probe.passed));
  const nextPolicy = {
    version: Number(policy?.version || 1) + (newFindings.length || resolvedFindings.length ? 1 : 0),
    cursor: cursor + 2,
    focus: findings.length ? "methods" : "balanced",
  };
  return {
    target: origin,
    probes,
    findings,
    newFindings,
    resolvedFindings,
    nextPolicy,
    decision: findings.length ? "focus-method-contracts" : "continue-exploration",
  };
}
