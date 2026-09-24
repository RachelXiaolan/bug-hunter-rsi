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
| `executor/hunt-fix.mjs` | 执行器：跟进已提交 PR → 领任务 → 容器内测试 → 修改 → 自动把关 → fork 并提 PR |
| `executor/policy.mjs` | 提交前的自动关卡：仓库规则（AI 禁令 / CLA / DCO）、diff 大小检查、PR 描述 |
| `executor/setup-linux.sh` | 云端 Linux 机器（如 Grok Bot 云电脑）一键安装 + 每 2 小时定时运行 |
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
| `POST /api/permit` | `HUNTER_TOKEN` | 提 PR 前申请许可（总开关、每日上限、每仓库未结 PR） |
| `GET /api/followups` | `HUNTER_TOKEN` | 需要跟进的已提交 PR |
| `POST /api/events` | `HUNTER_TOKEN` | 跟进记录、需要真人的事 |
| `POST /api/usage` | `HUNTER_TOKEN` | 执行器上报 AI 用量 |

## 部署

Cloudflare Worker 已连接本仓库（Settings → Builds），推送到 `main` 会自动执行：

```bash
npx wrangler d1 migrations apply bug-hunter-rsi --remote && npx wrangler deploy
```

在 Cloudflare → Worker → Settings → Variables and Secrets 中以 **Secret** 类型添加 `CMD_API_KEY`、`HUNTER_TOKEN`、`GITHUB_TOKEN`（不要写进 `wrangler.toml`）。开关与成本上限写在 `wrangler.toml` 的 `[vars]`。

旧版合成实验的表（`evolution_*`、`live_hunt_*`、`specimens`、`runs` 等）不再读写，确认没用后可以手动删除。

## 执行器（全自动）

在一台云端 Linux 机器上一次性安装（会装 git、Node、Python、Go、Docker 并加每 2 小时一次的定时任务）：

```bash
bash executor/setup-linux.sh
# 然后编辑 ~/.bug-hunter/env，填 HUNTER_TOKEN、CMD_API_KEY、GH_PR_TOKEN
~/.bug-hunter/run.sh    # 手动先跑一次，日志在 ~/.bug-hunter/executor.log
```

`GH_PR_TOKEN` 与 Cloudflare 的 `GITHUB_TOKEN` 可以是同一个 classic token：只做公开仓库勾 `public_repo`；需要读团队私有仓库时勾 `repo`（组织开启 SSO 时还需在令牌页 Configure SSO 授权）。执行器会运行目标仓库的测试，有 Docker 时在容器里跑，只挂载代码目录。

## 本地验证

`npm test`：用 `node:sqlite` 模拟 D1，端到端跑真实的 SQL 迁移和流水线。
