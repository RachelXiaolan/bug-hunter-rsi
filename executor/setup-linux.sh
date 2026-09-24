#!/usr/bin/env bash
# One-time setup of the Bug Hunter executor on a Debian/Ubuntu cloud machine (e.g. a Grok Bot computer).
#   curl -fsSL https://raw.githubusercontent.com/RachelXiaolan/bug-hunter-rsi/main/executor/setup-linux.sh | bash
# or, from a checkout:  bash executor/setup-linux.sh
# Re-run it after the machine is replaced ("Update Computer"); it is idempotent.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/RachelXiaolan/bug-hunter-rsi.git}"
BRANCH="${BRANCH:-main}"
HOME_DIR="$HOME/.bug-hunter"
APP_DIR="$HOME_DIR/app"
ENV_FILE="$HOME_DIR/env"
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

echo "==> 安装工具（git、Node、Python、Go、Docker）"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq git curl ca-certificates cron build-essential python3 python3-venv golang-go nodejs npm >/dev/null
$SUDO apt-get install -y -qq docker.io >/dev/null 2>&1 || echo "   Docker 安装失败，将退回到“清空环境变量”的弱隔离模式"
$SUDO systemctl enable --now docker >/dev/null 2>&1 || $SUDO service docker start >/dev/null 2>&1 || true
$SUDO systemctl enable --now cron >/dev/null 2>&1 || $SUDO service cron start >/dev/null 2>&1 || true
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "需要 Node.js 20+"; exit 1; }

echo "==> 获取 Bug Hunter 代码"
mkdir -p "$HOME_DIR"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" fetch -q origin "$BRANCH" && git -C "$APP_DIR" checkout -q "$BRANCH" && git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else git clone -q --branch "$BRANCH" "$REPO_URL" "$APP_DIR"; fi

if docker version >/dev/null 2>&1; then
  echo "==> 预拉测试容器镜像（Docker 隔离模式）"
  for image in node:22 golang:1.24 python:3.12; do docker pull -q "$image" >/dev/null || true; done
fi

if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<'EOF'
# Bug Hunter 执行器配置。此文件只有你自己可读（权限 600），不要提交到任何仓库。
HUNTER_URL=https://bug-hunter-rsi.rachel-lu.workers.dev
HUNTER_TOKEN=
CMD_API_KEY=
GH_PR_TOKEN=
# 每次运行最多处理几个新任务（PR 总数上限在 Cloudflare 的 MAX_PRS_PER_DAY 里管）
HUNT_LIMIT=2
EOF
  echo "==> 已创建 $ENV_FILE，请填入四个值：HUNTER_TOKEN、CMD_API_KEY、GH_PR_TOKEN（HUNTER_URL 已预填）"
fi

cat > "$HOME_DIR/run.sh" <<EOF
#!/usr/bin/env bash
set -a; . "$ENV_FILE"; set +a
cd "$APP_DIR" && git fetch -q origin "$BRANCH" && git reset -q --hard "origin/$BRANCH"
exec flock -n "$HOME_DIR/run.lock" node executor/hunt-fix.mjs
EOF
chmod 700 "$HOME_DIR/run.sh"

echo "==> 安装定时任务：每 2 小时运行一次"
( crontab -l 2>/dev/null | grep -v 'bug-hunter/run.sh' ; echo "15 */2 * * * $HOME_DIR/run.sh >> $HOME_DIR/executor.log 2>&1" ) | crontab -

echo
echo "完成。填好 $ENV_FILE 后，可以先手动跑一次："
echo "  $HOME_DIR/run.sh"
echo "日志：$HOME_DIR/executor.log"
