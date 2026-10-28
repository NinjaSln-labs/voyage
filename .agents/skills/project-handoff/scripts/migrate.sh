#!/usr/bin/env sh
# migrate — v1 旧交接模型 → 新存储
# 新模型下「迁移」= 用户确认源集 → agent 产「迁移清单（export 格式）」→ 本脚本校验并入册 + 归档旧件。
# 依赖：scripts/handoff.py（python3）。契约见 references/migrate.md。
#
# 用法: migrate [--store .handoff] [--archive <path>]... <inventory.jsonl>
#   <inventory.jsonl>  迁移清单（export 格式：首行 meta _format=handoff）
#   --archive <path>   迁移成功后把旧件（HANDOFF.md / HANDOFF-ARCHIVE/ …）**移动**到 .handoff/legacy/<日期>/
#                      可重复给出；内容保留、原位不再留（默认不删内容）
set -eu

SKILL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HANDOFF="$SKILL_DIR/scripts/handoff.py"
STORE=".handoff"
INV=""
ARCHIVES=""
FORCE=""

usage() { printf 'usage: %s [--store .handoff] [--force] [--archive <path>]... <inventory.jsonl>\n' "$0" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --store)   [ $# -ge 2 ] || { usage; exit 2; }; STORE=$2; shift 2 ;;
    --archive) [ $# -ge 2 ] || { usage; exit 2; }; ARCHIVES="$ARCHIVES $2"; shift 2 ;;
    --force)   FORCE="--force"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)        printf 'migrate: 未知参数 %s\n' "$1" >&2; usage; exit 2 ;;
    *)         INV=$1; shift ;;
  esac
done

[ -n "$INV" ] || { usage; exit 2; }
[ -f "$INV" ] || { printf 'migrate: 找不到清单: %s\n' "$INV" >&2; exit 2; }

# 校验清单是 export 格式（首行 meta）
head -n 1 "$INV" | grep -q '"_format"[[:space:]]*:[[:space:]]*"handoff"' || {
  printf 'migrate: 清单非 export 格式（首行缺 _format=handoff）；见 references/migrate.md\n' >&2
  exit 2
}

# 入册（复用单一写路径 + 校验；import 非空拒绝）
python3 "$HANDOFF" --store "$STORE" import $FORCE "$INV"

# 门禁
python3 "$HANDOFF" --store "$STORE" check

# 归档旧件（默认归档不删）
if [ -n "$ARCHIVES" ]; then
  D="$STORE/legacy/$(date +%F)"
  # v5.21.1：存储此刻是**封存**的（上一条 check 跑完自动回封）⇒ 直接 `mkdir` 会 EACCES
  # （实测：迁移走完 import 却卡在归档，rc≠0、旧件留在原地）。归档窗口先解锁、收尾再回封。
  python3 "$HANDOFF" --store "$STORE" unseal >/dev/null
  mkdir -p "$D"
  for p in $ARCHIVES; do
    [ -e "$p" ] || continue
    mv "$p" "$D/"
    printf 'migrate: 已归档 %s → %s/\n' "$p" "$D"
  done
  # scope 是「活体源」登记表：归档后旧源已不在原位 → 剪掉不可解析项（留待补登活体源）
  python3 "$HANDOFF" --store "$STORE" scope prune
  # 显式回封（`unseal` 是**维护态**：该存储此后不再自动回封 ⇒ 收尾必须自己封回去；
  # 若这一步被中断，`check` 的 sealed 维会报「存储未封存」，不会静默留在开着的状态）
  python3 "$HANDOFF" --store "$STORE" seal >/dev/null
fi
printf 'migrate: 完成\n'
