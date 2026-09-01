#!/bin/bash
# Voyage 部署同步脚本 —— 始终以目录树为单位同步，杜绝单文件 rsync 导致的 MODULE_NOT_FOUND
#
# 用法：
#   ./deploy.sh                    # 同步整个 impl/ + docs/ + CHANGELOG.md 到服务器
#   ./deploy.sh impl/m5/src/       # 同步 m5 源代码子目录（--relative 保留路径结构）
#   ./deploy.sh --dry-run          # 预览不同步
#
# 环境变量：
#   VOYAGE_SSH_DEST   部署目标（默认 ubuntu@161.33.159.216:/opt/voyage/）
#   VOYAGE_SSH_PORT   SSH 端口（默认 22022）
#   VOYAGE_SSH_KEY    SSH 私钥路径（默认 ~/.ssh/oracle_tokyo）
#
# 原则：
#   1. 默认模式不传 --relative，源路径不带尾斜杠会创建同名目录
#   2. 指定路径模式用 --relative 保留子目录结构（如 impl/m5/src/ → /opt/voyage/impl/m5/src/）
#   3. --delete 删除目标端不存在的文件（保持精确镜像）
#   4. 幂等：重复执行安全

set -euo pipefail

VOYAGE_SSH_DEST="${VOYAGE_SSH_DEST:-ubuntu@161.33.159.216:/opt/voyage/}"
VOYAGE_SSH_PORT="${VOYAGE_SSH_PORT:-22022}"
VOYAGE_SSH_KEY="${VOYAGE_SSH_KEY:-$HOME/.ssh/oracle_tokyo}"

SSH_CMD="ssh -i '$VOYAGE_SSH_KEY' -p $VOYAGE_SSH_PORT"

DRY_RUN=""
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN="--dry-run"
  shift
fi

# 默认同步：从项目根目录同步 impl/ + docs/ + CHANGELOG.md
# 不使用 --relative，源路径 impl/ 的内容直接进入目标 impl/
if [ $# -eq 0 ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
  cd "$PROJECT_ROOT"
  echo "[deploy] 从 $PROJECT_ROOT 同步到 $VOYAGE_SSH_DEST${DRY_RUN:+ (dry-run)}"
  rsync -avz --delete $DRY_RUN -e "$SSH_CMD" \
    impl/ "$VOYAGE_SSH_DEST"impl/
  rsync -avz --delete $DRY_RUN -e "$SSH_CMD" \
    docs/ "$VOYAGE_SSH_DEST"docs/
  rsync -avz --delete $DRY_RUN -e "$SSH_CMD" \
    CHANGELOG.md "$VOYAGE_SSH_DEST"
else
  # 指定路径：用 --relative 保留相对路径结构（自动创建子目录，杜绝 MODULE_NOT_FOUND）
  echo "[deploy] 同步指定路径到 $VOYAGE_SSH_DEST${DRY_RUN:+ (dry-run)}: $*"
  rsync -avzR --delete $DRY_RUN -e "$SSH_CMD" "$@" "$VOYAGE_SSH_DEST"
fi

echo "[deploy] 完成${DRY_RUN:+ (dry-run)}"