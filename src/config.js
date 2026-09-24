export const GOALS = Object.freeze({
  contributor: "拿到更多被合并的开源贡献",
  craft: "提高找 Bug、修 Bug 的能力",
  internal: "让团队内部工具更准、更快、更轻、更好用",
});

export const OPPORTUNITY_TYPES = Object.freeze({
  bug: "真实 Bug",
  accuracy: "准确性",
  performance: "速度",
  slimming: "代码瘦身",
  "ux-ui": "体验 / 界面",
  "small-feature": "有需求的小功能",
  "competitor-gap": "竞品缺口",
});

export const PROFILES = Object.freeze({
  "dev-tool": "开发工具",
  library: "代码库 / SDK",
  "internal-app": "内部应用",
  "web-app": "网页应用",
  "data-pipeline": "数据流程",
  general: "通用",
});

export const REPO_FEATURES = Object.freeze({
  externalMergeRate: "外部 PR 合并率",
  responsiveness: "PR 处理速度",
  activity: "近期活跃度",
  helpWanted: "help wanted / good first issue",
  openIssueLoad: "开放 Issue 数量",
  popularity: "热门程度（竞争）",
  testsPresent: "有测试",
  contributingGuide: "有贡献指南",
});

export const LIMITS = Object.freeze({
  reposPerRound: 10,
  opportunitiesPerRepo: 3,
  queuePerRound: 5,
  minEvidenceToEvolve: 5,
  minHoldout: 3,
  promotionMargin: 0.02,
  challengerShare: 0.3,
  challengerMinSamples: 8,
  maxLessons: 12,
  staleDays: 21,
});

// Initial guesses only. Every number here is overwritten by evidence as rounds settle.
export const DEFAULT_PLAYBOOK = Object.freeze({
  version: 1,
  goalMix: { contributor: 0.4, craft: 0.3, internal: 0.3 },
  repoSelection: {
    weights: {
      externalMergeRate: 1,
      responsiveness: 0.8,
      activity: 0.6,
      helpWanted: 0.5,
      openIssueLoad: 0.3,
      popularity: -0.3,
      testsPresent: 0.4,
      contributingGuide: 0.2,
    },
    exploration: 0.2,
  },
  discoveryQueries: [
    "language:go stars:1000..20000 good-first-issues:>2 archived:false",
    "language:python stars:1000..15000 help-wanted-issues:>2 archived:false",
    "language:typescript stars:800..15000 good-first-issues:>2 archived:false",
  ],
  opportunityPriors: {
    "dev-tool": { bug: 0.35, "small-feature": 0.2, performance: 0.15, accuracy: 0.1, "competitor-gap": 0.1, slimming: 0.05, "ux-ui": 0.05 },
    library: { bug: 0.4, accuracy: 0.15, performance: 0.15, "small-feature": 0.15, slimming: 0.05, "competitor-gap": 0.05, "ux-ui": 0.05 },
    "internal-app": { accuracy: 0.25, slimming: 0.2, "ux-ui": 0.2, performance: 0.15, bug: 0.15, "small-feature": 0.05, "competitor-gap": 0 },
    "web-app": { "ux-ui": 0.25, bug: 0.25, performance: 0.15, accuracy: 0.1, "small-feature": 0.1, "competitor-gap": 0.1, slimming: 0.05 },
    "data-pipeline": { accuracy: 0.35, bug: 0.25, performance: 0.2, slimming: 0.1, "small-feature": 0.05, "ux-ui": 0, "competitor-gap": 0.05 },
    general: { bug: 0.25, accuracy: 0.15, performance: 0.15, "small-feature": 0.15, slimming: 0.1, "ux-ui": 0.1, "competitor-gap": 0.1 },
  },
  lessons: [
    { id: "seed-linked-pr", kind: "hunting", text: "动手前先搜索是否已有关联 PR 或有人认领，重复劳动无法合并。", evidence: [], source: "tony-skill" },
    { id: "seed-small-pr", kind: "pr", text: "首个 PR 控制在 20 行左右，描述按“问题 → 根因 → 修复 → 测试”写。", evidence: [], source: "tony-skill" },
    { id: "seed-contributing", kind: "pr", text: "提交前读 CONTRIBUTING 和最近合并的 PR，遵守格式、CLA 与标签要求。", evidence: [], source: "tony-skill" },
  ],
  prStyle: { maxChangedLines: 60, openIssueFirstForFeatures: true },
});

export function clonePlaybook(playbook = DEFAULT_PLAYBOOK) {
  return JSON.parse(JSON.stringify(playbook));
}
