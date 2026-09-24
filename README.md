# Bug Hunter RSI

在 GitHub 仓库里找 Bug 和改进机会、动手修，并从 PR 结果里改写自己打法的自进化机器人。完整框架需求见 [`docs/requirements.md`](docs/requirements.md)。

- **自动化**：Cron 每天跑一轮：挑仓库 → 侦察 → AI 诊断 → 证据核对 → 执行器修复并测试 → 待审核补丁 / PR → 记录。
- **自进化**：PR 合并/关闭、团队投票、测试结果被折算成奖励；系统据此生成候选 Playbook（挑仓库权重、项目类型×机会类型偏好、找 Bug 与写 PR 经验），在保留集上回放比较，更好的晋级，分不出高下的做线上 A/B。每一版都是进化树上的一个节点。

## 结构

| 路径 | 作用 |
|---|---|
| `src/index.js` | Worker 路由与 Cron 入口 |
| `src/pipeline.js` | 每次 tick 推进一步：规划 / 侦察一个仓库 / 收尾（排队、轮询 PR、结算奖励、进化） |
| `src/scout.js` | 仓库特征、画像、AI 诊断 + 规则回退、证据核对 |
| `src/reward.js` | 按目标（contributor / craft / internal）折算奖励 |
| `src/evolution.js` | 候选打法生成、离线回放、晋级 / 挑战者 / 淘汰 |
| `src/config.js` | 初始 Playbook 与上限 |
| `executor/hunt-fix.mjs` | 执行器：领任务、克隆、测试、修改、回传；`--submit <id>` 人工审核后提 PR |
| `index.html` | 项目设计页 + 进展看板（进化树、标本馆、覆盖、历史） |

## API

| 路由 | 鉴权 | 用途 |
|---|---|---|
| `GET /api/state` | 无 | 页面数据 |
| `POST /api/tick` | 同源，每分钟一次 | 手动推进一步 |
| `POST /api/feedback` | 同源，限频 | 团队投票 `{id, verdict: useful \| not-useful}` |
| `GET /api/queue?limit=n` | `HUNTER_TOKEN` | 执行器领取任务 |
| `POST /api/attempts` | `HUNTER_TOKEN` | 回传 `{id, status, reason, patch, testLog, prUrl}` |
| `POST /api/targets` | `HUNTER_TOKEN` | 增加仓库 `{id, track, writePolicy}` |

## 部署

```bash
npx wrangler secret put CMD_API_KEY
npx wrangler secret put HUNTER_TOKEN
npx wrangler secret put GITHUB_TOKEN   # 可选，只读
# 在 wrangler.toml 里填 INTERNAL_REPOS / OSS_REPOS
npx wrangler d1 migrations apply bug-hunter-rsi --remote
npx wrangler deploy
```

旧版合成实验的表（`evolution_*`、`live_hunt_*`、`specimens`、`runs` 等）不再读写，确认没用后可以手动删除。

## 执行器

执行器会运行目标仓库的测试，也就是会执行别人的代码，请放在隔离环境里跑（容器或 CI runner）。

```bash
HUNTER_URL=https://bug-hunter-rsi.rachel-lu.workers.dev HUNTER_TOKEN=… CMD_API_KEY=… node executor/hunt-fix.mjs
# 审核 executor/out/<id>/ 之后，仅限 write_policy=pr 的仓库：
node executor/hunt-fix.mjs --submit <id>
```

## 本地验证

`npm test`：用 `node:sqlite` 模拟 D1，端到端跑真实的 SQL 迁移和流水线。
