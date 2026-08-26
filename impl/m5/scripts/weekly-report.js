// 周报生成器：metrics-history.jsonl 最近 7 天 → Markdown 报告（影子运行周报）
// 用法：node weekly-report.js <metrics-history.jsonl> [outDir]
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function main() {
  const histFile = process.argv[2];
  const outDir = process.argv[3] || path.dirname(histFile || '.') + '/reports';
  if (!histFile || !fs.existsSync(histFile)) { console.error('用法: node weekly-report.js <metrics-history.jsonl> [outDir]'); process.exit(1); }

  // 历史行格式：collect-metrics 输出 {days:{'YYYY-MM-DD':{...}}}（日聚合快照）或平铺日行
  const raw = fs.readFileSync(histFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const now = Date.now();
  const days = [];
  for (const row of raw) {
    if (row.days) {
      for (const [day, v] of Object.entries(row.days)) {
        if (now - new Date(day).getTime() <= 7 * 86400e3) days.push({ day, ...v });
      }
    } else if (row.at && now - new Date(row.at).getTime() <= 7 * 86400e3) {
      days.push({ day: row.at.slice(0, 10), intents: row.intents || 1, degradedIntents: row.degraded ? 1 : 0 });
    }
  }
  const rows = days;
  if (!rows.length) { console.error('最近 7 天无数据'); process.exit(1); }

  const sum = (k) => rows.reduce((a, r) => a + ((r.days ? Object.values(r.days) : [r]).reduce((x, v) => x + (v[k] || 0), 0)), 0);
  // 兼容两种历史形态：聚合快照 {days:{...}} 或日行平铺
  let intents = 0, degraded = 0, approvals = 0, authFailures = 0, errors = 0;
  const latencies = [];
  const actors = new Set();
  for (const row of rows) {
    const days = row.days ? Object.values(row.days) : [row];
    for (const d of days) {
      intents += d.intents || 0;
      degraded += d.degradedIntents || d.degraded || 0;
      approvals += d.approvalsCreated || 0;
      authFailures += d.authFailures || 0;
      errors += d.serverErrors || 0;
      if (d.activeActors) actors.add(`${row.day}-${d.activeActors}`);
      if (d.latencyMs && typeof d.latencyMs.p50 === 'number') latencies.push(d.latencyMs.p50);
    }
  }
  const degradeRate = intents ? (degraded / intents * 100).toFixed(1) : 'N/A';
  const avgP50 = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 'N/A';
  const verdict = intents === 0 ? '无流量' : (degraded / intents < 0.3 ? '✅ 健康' : '⚠️ 降级率偏高——评估供应商档位');

  const md = `# 影子运行周报（${rows.length} 天）\n\n`
    + `- 意图总量：**${intents}**\n`
    + `- 高危审批单：${approvals}\n`
    + `- 降级率：**${degradeRate}%**（degraded ${degraded}/${intents}）\n`
    + `- 平均日 p50 时延：${avgP50}ms\n`
    + `- 认证失败：${authFailures}　服务端错误：${errors}\n`
    + `- 结论：${verdict}\n\n`
    + `> 阈值校准提示：意图量与操作节奏分布持续积累中；执行侧指标（成功率/成本）待 1% 档放开后产生。\n`;

  fs.mkdirSync(outDir, { recursive: true });
  const week = Math.ceil(((Date.now() - new Date('2026-01-01').getTime()) / 86400e3 + new Date('2026-01-01').getDay()) / 7);
  const file = path.join(outDir, `weekly-2026-W${String(week).padStart(2, '0')}.md`);
  fs.writeFileSync(file, md);
  console.log('[report]', file);
  console.log(md);
}

main();
