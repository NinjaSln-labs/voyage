#!/bin/bash
# 三集门禁一键跑 + 汇总取数（2026-11-22 立项，根治 p000049／p000050）。
#
# 两条老坑的根因是「取数路径没有唯一入口」：
#   p000049 评测门禁要跑 4~6 分钟，走 ssh 前台调用时客户端报 Timeout，
#           但服务端 systemd transient unit 仍在跑——不是失败，误判过一次；
#   p000050 manual-run.sh 只回显 journalctl tail -25，「=== 汇总」块会被样本明细挤出截断，
#           取数的人只能靠猜。
# 本脚本把「跑 + 等 + 取汇总 + 判 PASS/FAIL」封成唯一入口，退出码即结论。
#
# 用法（在生产机上以 root 跑）：
#   sudo /opt/voyage/impl/m5/scripts/run-gate.sh              # 三集全跑
#   sudo /opt/voyage/impl/m5/scripts/run-gate.sh --only hidden
#
# 退出码：0 = 全过；1 = 有集未达 100%；2 = 取数/执行异常（重跑或查 journal）。
set -uo pipefail

IMPL_ROOT="${VOYAGE_IMPL_ROOT:-/opt/voyage/impl}"
DATA="${VOYAGE_DATA_DIR:-/opt/voyage/data}"
MANUAL="${IMPL_ROOT}/m5/scripts/manual-run.sh"
PUBLIC_SET="${VOYAGE_PUBLIC_SET:-${IMPL_ROOT}/m0-baseline/eval-sets/high_risk}"
HIDDEN_SET="${VOYAGE_HIDDEN_SET:-${DATA}/eval-hidden/high_risk_hidden}"
REDTEAM_SET="${VOYAGE_REDTEAM_SET:-${DATA}/eval-hidden/redteam/redteam_v1}"

ONLY="all"
[ "${1:-}" = "--only" ] && ONLY="${2:-all}"

run_set() {
  local label="$1"; shift
  echo "=== 门禁集：${label} ==="
  local out
  out="$(sudo "${MANUAL}" eval-high-risk-score.js "$@" 2>&1)"
  # manual-run.sh 只回显 tail-25，汇总块常被截断 ⇒ 按 unit 名回查 journal（p000050）。
  local unit
  unit="$(printf '%s\n' "${out}" | grep -o 'voyage-manual-eval-high-risk-score-[0-9]*' | tail -1)"
  local sum=""
  if [ -n "${unit}" ]; then
    sum="$(sudo journalctl -u "${unit}" -o cat --no-pager 2>/dev/null | grep -A16 '=== 汇总')"
  fi
  if [ -z "${sum}" ]; then
    echo "取数失败：未拿到「=== 汇总」块（unit=${unit:-未识别}）——重跑或人工查 journal"
    printf '%s\n' "${out}" | tail -10
    return 2
  fi
  printf '%s\n' "${sum}"
  if printf '%s\n' "${sum}" | grep -q '判定: ✅ PASS'; then
    echo "→ ${label}: PASS"
    return 0
  fi
  echo "→ ${label}: FAIL"
  return 1
}

rc=0
case "${ONLY}" in
  all)
    run_set "public+hidden" "${PUBLIC_SET}" "${HIDDEN_SET}" || rc=$?
    run_set "redteam" "${REDTEAM_SET}" || rc=$?
    ;;
  hidden)
    run_set "hidden" "${HIDDEN_SET}" || rc=$?
    ;;
  redteam)
    run_set "redteam" "${REDTEAM_SET}" || rc=$?
    ;;
  *)
    echo "用法：run-gate.sh [--only all|hidden|redteam]" >&2
    exit 2
    ;;
esac

echo
[ "${rc}" -eq 0 ] && echo "三集门禁：全过" || echo "三集门禁：未全过（rc=${rc}）"
exit "${rc}"
