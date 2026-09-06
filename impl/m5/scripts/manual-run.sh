#!/bin/bash
# 手动触发长任务（sim/redteam 等）的统一入口——根治属主污染
#
# 背景：五个 timer/service 全部 User=ubuntu，手动运维若以 root 跑（sudo bash -c /
# 裸 sudo systemd-run），产物为 root:root 644，后续 timer 以 ubuntu 写入即
# EACCES: permission denied（09-06 voyage-redteam 首次自动触发即因此失败：CPU 550ms
# 早期崩溃，产物未落盘）。此前只靠 HANDOFF 文档纪律约束，本 session 实机验证仍复现一次。
#
# 根治两层：
#   1. 强制以 timer 同用户（VOYAGE_RUN_AS，默认 ubuntu）运行——产物属主恒为
#      ubuntu:ubuntu，timer 永不会因属主不一致 EACCES
#   2. 运行前后扫描 /opt/voyage/data 修正非 ubuntu 属主条目（文件+目录）——
#      即使有人绕过本脚本以 root 跑，下一次任意 timer 或本脚本运行即自动修复
#
# 另固化两条 env 注入纪律（HANDOFF §4 已记录）：
#   - 一律 --property=EnvironmentFile=，不用 shell source（voyage.env 含含空格 JSON
#     值 KEYVAULT_JSON，source 会被 shell 误解析成命令，stderr 现 "line N: {user:: command not found"）
#   - 不用 --setenv 逐变量注入（易错易漏），也不存在 --environment-file 这个选项
#
# 用法（须 sudo：transient unit 与 chown 均需 root）：
#   sudo impl/m5/scripts/manual-run.sh simulate-traffic.js 6
#   sudo impl/m5/scripts/manual-run.sh gen-redteam-weekly.js --week 2026-W37 --count 5
#
# 环境变量：
#   VOYAGE_RUN_AS   运行用户，须与各 timer/service 的 User= 一致（默认 ubuntu）
#   VOYAGE_BASE     部署根目录（默认 /opt/voyage）
set -euo pipefail

RUN_AS="${VOYAGE_RUN_AS:-ubuntu}"
BASE="${VOYAGE_BASE:-/opt/voyage}"
SCRIPTS="$BASE/impl/m5/scripts"
DATA="$BASE/data"
ENV_FILE="$DATA/voyage.env"

usage() {
  cat >&2 <<EOF
用法: sudo $(basename "$0") <script.js> [args...]

示例:
  sudo $(basename "$0") simulate-traffic.js 6
  sudo $(basename "$0") gen-redteam-weekly.js --week 2026-W37 --count 5

强制以 ${RUN_AS} 运行（与 timer User= 一致），产物属主恒为 ${RUN_AS}:${RUN_AS}；
运行前后自动修正 ${DATA} 下非 ${RUN_AS} 属主条目，避免后续 timer EACCES。
EOF
  exit 2
}

[ $# -ge 1 ] || usage
[ "$(id -u)" -eq 0 ] || { echo "错误: 须 sudo 调用（transient unit 与 chown 均需 root）" >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "错误: 找不到 $ENV_FILE" >&2; exit 2; }
SCRIPT="$1"; shift
[ -f "$SCRIPTS/$SCRIPT" ] || { echo "错误: 找不到 $SCRIPTS/$SCRIPT" >&2; exit 2; }

# 修正非 RUN_AS 属主的文件与目录——否则 timer 写入即 EACCES
fix_ownership() {
  local bad
  bad="$(find "$DATA" ! -user "$RUN_AS" 2>/dev/null || true)"
  [ -z "$bad" ] && return 0
  echo "⚠️  发现非 ${RUN_AS} 属主条目（会令 timer EACCES），自动修正：" >&2
  while IFS= read -r f; do
    echo "   chown ${RUN_AS}:${RUN_AS} $f" >&2
    chown "$RUN_AS:$RUN_AS" "$f"
  done <<< "$bad"
}

UNIT="voyage-manual-$(basename "$SCRIPT" .js)-$(date +%s)"
echo "▶ 以 ${RUN_AS} 运行 ${SCRIPT}（unit: ${UNIT}），完成后校验产物属主..." >&2

fix_ownership   # 跑前：避免本次因既有 root 产物直接 EACCES

rc=0
systemd-run --wait --unit="$UNIT" \
  --property=User="$RUN_AS" \
  --property=EnvironmentFile="$ENV_FILE" \
  --property=WorkingDirectory="$SCRIPTS" \
  /usr/bin/node "$SCRIPTS/$SCRIPT" "$@" || rc=$?

# transient unit 失败会保留 failed 状态，清理以免同名重建失败
[ "$rc" -eq 0 ] || systemctl reset-failed "${UNIT}.service" 2>/dev/null || true
fix_ownership   # 跑后：防御本次或他人以 root 跑出的残留

# systemd-run --wait 不透传 service stdout，输出尾部日志便于核对
journalctl -u "${UNIT}.service" -o cat --no-pager 2>/dev/null | tail -25 || true

exit "$rc"
