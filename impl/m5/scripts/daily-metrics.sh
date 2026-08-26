#!/bin/bash
# 日聚合：collect-metrics 输出追加到 metrics-history.jsonl（systemd daily timer 消费）
set -e
DATA=/opt/voyage/data
SCRIPTS=/opt/voyage/impl/m5/scripts
node "$SCRIPTS/collect-metrics.js" "$DATA/access.jsonl" "$DATA/audit.jsonl" > /tmp/voyage-day.json
node -e "
const fs=require('fs');
const day=JSON.parse(fs.readFileSync('/tmp/voyage-day.json','utf8'));
day.capturedAt=new Date().toISOString();
fs.appendFileSync('$DATA/metrics-history.jsonl', JSON.stringify(day)+'\n');
console.log('[daily-metrics] appended', day.generatedAt);
"
rm -f /tmp/voyage-day.json
