#!/bin/bash
# 生产健康巡检（2026-11-22 立项，根治 p000071／p000070 的一部分）。
#
# p000071：探错端口导致「服务已挂」的假象——ingress 只听 127.0.0.1:8787（HTTP）与
#           8443（mTLS，需客户端证书握手，裸 curl 必 000）。本脚本用对的口径探。
# p000070：服务端取证三处方法错（真 env 在 data/voyage.env、文件时间 CST 而日志 UTC 差 8h、
#           urllib 直探供应商被 CF 1010 拦）——本脚本只在服务器本地读文件，不出网探供应商。
#
# 用法：sudo /opt/voyage/impl/m5/scripts/health-check.sh
# 退出码：0 = 全绿；1 = 有异常项。
set -uo pipefail

DATA="${VOYAGE_DATA_DIR:-/opt/voyage/data}"
ACCESS="${DATA}/access.jsonl"
WINDOW_H="${VOYAGE_HEALTH_WINDOW_H:-24}"

bad=0
say() { printf '%-46s %s\n' "$1" "$2"; }

# 1) ingress 活性与端点
if systemctl is-active --quiet voyage-ingress.service; then
  say "voyage-ingress.service" "active"
else
  say "voyage-ingress.service" "NOT ACTIVE"; bad=1
fi
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8787/healthz || true)"
say "http://127.0.0.1:8787/healthz" "${code:-000}"
[ "${code}" = "200" ] || bad=1
# mTLS 层只验「端口在听」，不裸探（8443 要客户端证书，裸 curl 必 000 = 正常，p000071）
if ss -ltn 2>/dev/null | grep -q ':8443'; then
  say "0.0.0.0:8443 (mTLS)" "LISTEN"
else
  say "0.0.0.0:8443 (mTLS)" "NOT LISTEN"; bad=1
fi

# 2) 五个 timer 是否活跃
for t in voyage-sim voyage-daily voyage-redteam voyage-weekly voyage-rotate; do
  if systemctl is-active --quiet "${t}.timer"; then
    last="$(systemctl show "${t}.service" -p ExecMainStatus --value 2>/dev/null)"
    say "${t}.timer" "active（上次 ${t}.service rc=${last:-?}）"
    [ "${last}" = "0" ] || bad=1
  else
    say "${t}.timer" "NOT ACTIVE"; bad=1
  fi
done

# 3) 失败单元
failed="$(systemctl --failed --no-legend 2>/dev/null | wc -l | tr -d ' ')"
say "systemctl --failed" "${failed} 个"
[ "${failed}" = "0" ] || bad=1

# 4) 访问日志近窗口健康度（带凭证口径：5xx / 401 / degraded）
if [ -r "${ACCESS}" ]; then
  stats="$(node -e '
    const fs=require("fs");
    const file=process.argv[1], winH=Number(process.argv[2]);
    const since=Date.now()-winH*3600*1000;
    let n=0,s5xx=0,a401=0,deg=0;
    for(const line of fs.readFileSync(file,"utf8").split("\n")){
      if(!line) continue;
      let e; try{e=JSON.parse(line);}catch{continue;}
      const t=Date.parse(e.at||0); if(!(t>=since)) continue;
      n++;
      if(Number(e.status)>=500) s5xx++;
      if(Number(e.status)===401 && e.cred!=="none") a401++;
      if(e.degraded===true) deg++;
    }
    process.stdout.write(JSON.stringify({n,s5xx,a401,deg}));
  ' "${ACCESS}" "${WINDOW_H}")"
  say "access.jsonl 近 ${WINDOW_H}h" "${stats}"
  s5xx="$(printf '%s' "${stats}" | sed 's/.*"s5xx":\([0-9]*\).*/\1/')"
  a401="$(printf '%s' "${stats}" | sed 's/.*"a401":\([0-9]*\).*/\1/')"
  deg="$(printf '%s' "${stats}" | sed 's/.*"deg":\([0-9]*\).*/\1/')"
  [ "${s5xx:-0}" = "0" ] || bad=1
  [ "${a401:-0}" = "0" ] || bad=1
  [ "${deg:-0}" = "0" ] || bad=1
else
  say "access.jsonl" "不可读（${ACCESS}）"; bad=1
fi

echo
[ "${bad}" -eq 0 ] && echo "巡检：全绿" || echo "巡检：有异常项（见上）"
exit "${bad}"
