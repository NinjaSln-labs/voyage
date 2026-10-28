#!/bin/sh
# 验证链：单进程并行跑 impl 下全部测件，只输出汇总；失败时打印全量详情
set -u
log=$(mktemp)
trap 'rm -f "$log"' EXIT
node --test $(find impl -name '*.test.js' | sort) >"$log" 2>&1
rc=$?
grep -E '^ℹ (tests|pass|fail|cancelled|skipped|duration_ms)' "$log" || true
if [ "$rc" -ne 0 ]; then
  echo '--- 失败详情 ---'
  cat "$log"
fi
exit "$rc"
