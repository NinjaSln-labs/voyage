#!/bin/bash
# Voyage 部署同步脚本 —— 始终以目录树为单位同步，杜绝单文件 rsync 导致的 MODULE_NOT_FOUND
#
# 用法：
#   ./deploy.sh                    # 同步整个 impl/ + docs/ + CHANGELOG.md 到服务器
#   ./deploy.sh impl/m5/src/       # 同步 m5 源代码子目录
#   ./deploy.sh --dry-run          # 预览不同步
#
# 环境变量：
#   VOYAGE_SSH_DEST   部署目标（默认 ubuntu@161.33.159.216:/opt/voyage/）
#   VOYAGE_SSH_PORT   SSH 端口（默认 22022）
#   VOYAGE_SSH_KEY    SSH 私钥路径（默认 ~/.ssh/oracle_tokyo）
#
# 原则：
#   1. 始终同步目录树（--relative -R），单文件也保留相对路径结构
#   2. 不排除 node_modules —— 服务器侧 npm ci 自行处理
#   3. --delete 删除目标端不存在的文件（保持精确镜像）
#   4. 幂等：重复执行安全

set -euo pipefail

VOYAGE_SSH_DEST="${VOYAGE_SSH_DEST:-ubuntu@161.33.159.216:/opt/voyage/}"
VOYAGE_SSH_PORT="${VOYAGE_SSH_PORT:-22022}"
VOYAGE_SSH_KEY="${VOYAGE_SSH_KEY:-$HOME/.ssh/oracle_tokyo}"

RSYNC_OPTS=(
  -avz
  --relative
  --delete
  -e "ssh -i '$VOYAGE_SSH_KEY' -p $VOYAGE_SSH_PORT"
)

DRY_RUN=""
if [ "${1:-}" = "--dry-run" ]; then
  RSYNC_OPTS+=(--dry-run)
  DRY_RUN=" (dry-run)"
  shift
fi

# 默认同步整个工程目录树
if [ $# -eq 0 ]; then
  # 从项目根目录运行，同步 impl/ 全套 + docs/ + CHANGELOG
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
  cd "$PROJECT_ROOT"
  echo "[deploy] 从 $PROJECT_ROOT 同步到 $VOYAGE_SSH_DEST${DRY_RUN}"
  rsync "${RSYNC_OPTS[@]}" \
    impl/ "$VOYAGE_SSH_DEST"impl/
  rsync "${RSYNC_OPTS[@]}" \
    docs/ "$VOYAGE_SSH_DEST"docs/
  rsync "${RSYNC_OPTS[@]}" \
    CHANGELOG.md "$VOYAGE_SSH_DEST"
else
  # 用户指定路径：直接同步，保留相对路径结构（--relative 自动创建子目录）
  echo "[deploy] 同步指定路径到 $VOYAGE_SSH_DEST${DRY_RUN}: $*"
  rsync "${RSYNC_OPTS[@]}" "$@" "$VOYAGE_SSH_DEST"
fi

echo "[deploy] 完成${DRY_RUN}"