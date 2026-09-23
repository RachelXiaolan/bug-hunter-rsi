const SAMPLE_CASES = [
  {
    id: "coupon-negative-value",
    title: "负数优惠券扩大订单金额",
    severity: "high",
    category: "数值边界",
    description: "优惠券金额为负时，结算逻辑会把负折扣加到订单总额。",
    reproduction: "subtotal=100, coupon=-25 → actual total=125; expected total ≤ 100",
    recommendation: "在折扣计算前拒绝负数金额，并为负数、零值和超额折扣补齐边界测试。",
    run: () => {
      const subtotal = 100;
      const coupon = -25;
      const actual = subtotal - coupon;
      return { passed: actual <= subtotal, actual, expected: "total <= subtotal" };
    },
  },
  {
    id: "zero-width-recipient",
    title: "零宽字符绕过收件人校验",
    severity: "medium",
    category: "Unicode 边界",
    description: "仅由零宽字符组成的姓名通过了普通 trim 非空校验。",
    reproduction: 'recipient="\\u200B\\u200D" → actual accepted; expected rejected',
    recommendation: "校验前规范化 Unicode，并按可见字符检查非空；保存该输入为回归样例。",
    run: () => {
      const recipient = "\u200B\u200D";
      const accepted = Boolean(recipient.trim());
      return { passed: !accepted, actual: accepted ? "accepted" : "rejected", expected: "rejected" };
    },
  },
  {
    id: "negative-item-quantity",
    title: "负数量生成负订单行",
    severity: "high",
    category: "数量边界",
    description: "订单行没有拒绝负数量，导致商品行金额减少总价。",
    reproduction: "unitPrice=40, quantity=-2 → actual line total=-80; expected quantity >= 0",
    recommendation: "构造订单行时拒绝负数量，并覆盖负数、零数量和最大数量边界。",
    run: () => {
      const unitPrice = 40;
      const quantity = -2;
      const lineTotal = unitPrice * quantity;
      return { passed: quantity >= 0 && lineTotal >= 0, actual: lineTotal, expected: "quantity >= 0" };
    },
  },
];

export function runSampleArena() {
  const startedAt = Date.now();
  const results = SAMPLE_CASES.map((sample) => {
    let result;
    let completed = true;
    try {
      result = sample.run();
    } catch (error) {
      completed = false;
      result = { passed: false, actual: error instanceof Error ? error.message : "unknown error", expected: "sample completes" };
    }
    return {
      specimen: {
        id: sample.id,
        title: sample.title,
        severity: sample.severity,
        category: sample.category,
        description: sample.description,
        reproduction: sample.reproduction,
        recommendation: sample.recommendation,
        source: "sample",
      },
      harnessPassed: completed && result.actual !== undefined,
      detected: completed && !result.passed,
      actual: result.actual,
      expected: result.expected,
    };
  });

  return {
    durationMs: Date.now() - startedAt,
    checksTotal: results.length,
    harnessPassed: results.filter((result) => result.harnessPassed).length,
    fixturesDetected: results.filter((result) => result.detected).length,
    findings: results.filter((result) => result.detected),
  };
}

export function sampleCatalog() {
  return SAMPLE_CASES.map(({ run: _run, ...sample }) => sample);
}
