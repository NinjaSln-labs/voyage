// 影子运行指标聚合器：访问日志 + 审计链 → 日/窗口聚合快照（v1.0.0-rc 校准数据源）
// 用法：node collect-metrics.js <access.jsonl> [audit.jsonl] [--days N]
// 输出：JSON（stdout 可重定向）；口径对齐 docs/指标口径.md + AI评测策略 §3

'use strict';

const fs = require('node:fs');

function main() {
  const accessFile = process.argv[2];
  const auditFile = process.argv[3] || null;
  if (!accessFile || !fs.existsSync(accessFile)) {
    console.error('用法: node collect-metrics.js <access.jsonl> [audit.jsonl]');
    process.exit(1);
  }
  const rows = fs.readFileSync(accessFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

  const byDay = new Map();
  for (const r of rows) {
    const day = (r.at || '').slice(0, 10);
    if (!day) continue;
    const d = byDay.get(day) || {
      requests: 0, intents: 0, queries: 0, needReview: 0, degraded: 0,
      authFailures: 0, errors: 0,
      latencyMs: [], actors: new Set(),
      approvalsCreated: 0,
    };
    d.requests += 1;
    if (r.path === '/v1/intent') d.intents += 1;
    if (r.kind === 'query') d.queries += 1;
    if (r.approvalId || r.hasApproval) d.approvalsCreated += 1;
    if (r.degraded === true) d.degraded += 1;
    if (r.status === 401) d.authFailures += 1;
    if (r.status >= 500) d.errors += 1;
    if (typeof r.latencyMs === 'number') d.latencyMs.push(r.latencyMs);
    if (r.actorId) d.actors.add(r.actorId);
    byDay.set(day, d);
  }

  const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  };

  const out = { generatedAt: new Date().toISOString(), days: {} };
  for (const [day, d] of [...byDay.entries()].sort()) {
    out.days[day] = {
      requests: d.requests,
      intents: d.intents,
      queries: d.queries,
      approvalsCreated: d.approvalsCreated,
      degradedIntents: d.degraded,
      degradeRate: d.intents ? +(d.degraded / d.intents).toFixed(4) : null,
      authFailures: d.authFailures,
      serverErrors: d.errors,
      activeActors: d.actors.size,
      latencyMs: {
        p50: pct(d.latencyMs, 0.5),
        p95: pct(d.latencyMs, 0.95),
        p99: pct(d.latencyMs, 0.99),
        max: d.latencyMs.length ? Math.max(...d.latencyMs) : null,
      },
    };
  }

  // 审计链补充：审批决定/执行终态计数（2026-08-27：执行终态审计已落地——exec.complete/success、
  // exec.fail/failed 由 M4 completeJob/failJob 写入，此处按 intent=execute+result 计数）
  if (auditFile && fs.existsSync(auditFile)) {
    const auditRows = fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const decisions = { approved: 0, rejected: 0 };
    let jobCompleted = 0, jobFailed = 0;
    for (const l of auditRows) {
      const e = l.entry || {};
      if (e.from === 'ui' && e.action && e.action.intent === 'approve') {
        if (e.result === 'approved') decisions.approved += 1;
        if (e.result === 'rejected') decisions.rejected += 1;
      }
      if (e.action && e.action.intent === 'execute' && e.result === 'success') jobCompleted += 1;
      if (e.action && e.action.intent === 'execute' && e.result === 'failed') jobFailed += 1;
    }
    out.audit = { approvalDecisions: decisions, executionsCompleted: jobCompleted, executionsFailed: jobFailed };
  }

  console.log(JSON.stringify(out, null, 1));
}

main();
