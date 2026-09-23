# Bug Hunter RSI

Cloudflare Worker + D1 + 静态 HTML 页面。每天 01:00 UTC 执行两条分开的循环：合成基准策略实验，以及当前 Worker 公开 API 的真实契约探测。

## 真实捉虫循环

`POST /api/hunt` 或 Cron 启动只读目标探测。Worker 调用自己的 API 处理逻辑，保存请求、预期、实际响应与复测结果。相同根因去重；已知问题继续作为回归探针。修复后只有复测通过才将标本标记为 `resolved` 并写入修复事件。测试焦点和游标保存在 D1，下一轮从上轮状态继续。

当前真实目标是本项目的 `/api/health`、`/api/catalog` 和 `/api/state`，尚未接入用户的业务仓库或业务 API。合成基准的覆盖和得分与真实探测结果分开展示。

## AI 测试生成

可选的 CommandCode Chat Completions 接口只生成最多 4 个只读查询探针。Worker 对模型输出做固定路径、方法和长度白名单校验，再实际执行并复测；模型文本不算 Bug 证据。模型调用失败时，内置探针仍照常运行。

密钥只保存在 Cloudflare Worker Secret `CMD_API_KEY`，不要放进 `wrangler.toml`、页面、D1 或聊天记录。在此目录运行 `npx wrangler secret put CMD_API_KEY` 后，于隐藏输入提示中粘贴密钥。或在 Cloudflare 控制台的 Worker 设置中新增同名 Secret。完成后手动运行一轮，`/api/state` 的 `liveHunt.latest.ai_status` 应为 `ready`。

## 本地验证

`node --test tests/*.test.mjs`

## 数据

迁移文件位于 `migrations/`。`live_hunt_runs`、`live_hunt_evidence`、`live_hunt_findings`、`live_hunt_fix_events` 和 `system_state` 保存真实闭环；原有 `evolution_*` 表保存合成策略实验。
