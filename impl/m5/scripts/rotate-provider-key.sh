#!/bin/bash
# 供应商 Key 轮换（jinteng → 生产 voyage.env，原子替换 + 对拍 + 重启验证）。
#
# 根治 p000060：此前把「脚本」与「值」同时走 ssh stdin，前者被吞致替换静默不生效
#               （以为轮换完成，生产仍用旧 Key，401 持续）。
# 根治 p000065：值必须从 jinteng 取，禁读本机 shell 里的同名旧环境变量。
# 口径同 c000007（原子单行替换 + sha256 对拍 + 重启 ingress）。
#
# 用法（在运维机上跑，不在生产机跑）：
#   rotate-provider-key.sh <ENV_NAME> <JINTENG_NAME> [SSH_DEST]
# 例：rotate-provider-key.sh NKP_OPENDESIGN NKP_OPENDESIGN ubuntu@HOST:/opt/voyage/
#
# 硬约束：明文只经 stdin/临时文件传递，**绝不打印、不进仓、不进日志**。
set -euo pipefail

ENV_NAME="${1:-}"
JT_NAME="${2:-}"
SSH_DEST="${3:-${VOYAGE_SSH_DEST:-ubuntu@161.33.159.216:/opt/voyage/}}"
SSH_PORT="${VOYAGE_SSH_PORT:-22022}"
SSH_KEY="${VOYAGE_SSH_KEY:-$HOME/.ssh/oracle_tokyo}"

if [ -z "${ENV_NAME}" ] || [ -z "${JT_NAME}" ]; then
  echo "用法：rotate-provider-key.sh <ENV_NAME> <JINTENG_NAME> [SSH_DEST]" >&2
  exit 2
fi

export JINTENG_PASSFILE="${JINTENG_PASSFILE:-$HOME/.config/jinteng/pass}"
JT="${JT:-$HOME/.local/bin/jinteng}"
command -v "${JT}" >/dev/null 2>&1 || { echo "找不到 jinteng（${JT}）" >&2; exit 2; }

REMOTE_HOST="$(printf '%s' "${SSH_DEST}" | cut -d: -f1)"
REMOTE_ROOT="$(printf '%s' "${SSH_DEST}" | cut -d: -f2)"
SSH=(ssh -i "${SSH_KEY}" -p "${SSH_PORT}" -o StrictHostKeyChecking=no "${REMOTE_HOST}")

# 值通道：jinteng 取值 → 临时文件（600）→ ssh stdin（与脚本通道分离，p000060）
tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT
chmod 600 "${tmp}"
"${JT}" get "${JT_NAME}" > "${tmp}"
[ -s "${tmp}" ] || { echo "jinteng 取不到 ${JT_NAME}" >&2; exit 2; }
val_sha="$(printf '%s' "$(cat "${tmp}")" | sha256sum | cut -d' ' -f1)"
echo "[rotate] 已从 jinteng 取 ${JT_NAME}（sha256 前 12 位 ${val_sha:0:12}，明文不打印）"

# 替换通道：远端用 grep -v 去旧行 + 追加新行，install 回原路径（root:root 600）
"${SSH[@]}" "sudo sh -c 'set -e; f=${REMOTE_ROOT}/data/voyage.env; grep -v \"^${ENV_NAME}=\" \"\$f\" > /tmp/rotate.env.new; printf \"%s=%s\\n\" \"${ENV_NAME}\" \"\$(cat)\" >> /tmp/rotate.env.new; install -o root -g root -m 600 /tmp/rotate.env.new \"\$f\"; rm -f /tmp/rotate.env.new'" < "${tmp}"

echo "[rotate] 已原子替换 ${ENV_NAME}，重启 voyage-ingress.service"
"${SSH[@]}" "sudo systemctl restart voyage-ingress.service && sleep 3 && systemctl is-active voyage-ingress.service && curl -s -o /dev/null -w 'healthz=%{http_code}\n' http://127.0.0.1:8787/healthz"

# 对拍：远端该变量值的 sha256 应与本地取到的指纹一致（只对指纹，不回显明文）
remote_sha="$("${SSH[@]}" "sudo grep '^${ENV_NAME}=' ${REMOTE_ROOT}/data/voyage.env | cut -d= -f2- | tr -d '\n' | sha256sum | cut -d' ' -f1")"
if [ "${remote_sha}" = "${val_sha}" ]; then
  echo "[rotate] 对拍通过：远端 ${ENV_NAME} 与 jinteng 值指纹一致"
else
  echo "[rotate] 对拍失败：远端指纹 ${remote_sha:0:12} ≠ 本地 ${val_sha:0:12}" >&2
  exit 1
fi
