// 影子运行指标聚合器：访问日志 + 审计链 → 日/窗口聚合快照（v1.0.0-rc 校准数据源）
// 口径：intents/authFailures/serverErrors 均只计**携带凭证**的请求；无凭证请求（公网探测/扫描）
//       单列 unauthenticatedRequests，不进健康基线。历史行无 cred 字段时以 actorId 有无近似。
// 用法：node collect-metrics.js <access.jsonl> [audit.jsonl] [--days N]
// 输出：JSON（stdout 可重定向）；口径对齐 docs/指标口径.md + AI评测策略 §3

'use strict';

const fs = require('node:fs');

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

/** 聚合核心（纯函数，可测试）：访问行 + 审计行 → 快照对象
 *  - accessRows: 访问日志行（已 JSON.parse 的对象数组）
 *  - auditRows:  审计链行（已 JSON.parse 的对象数组）或 null（无审计文件时）
 */
function buildSnapshot(accessRows, auditRows) {
  const byDay = new Map();
  for (const r of accessRows) {
    const day = (r.at || '').slice(0, 10);
    if (!day) continue;
    const d = byDay.get(day) || {
      requests: 0, intents: 0, queries: 0, needReview: 0, degraded: 0,
      authFailures: 0, errors: 0, unauthenticated: 0,
      latencyMs: [], actors: new Set(),
      approvalsCreated: 0,
      // 降级原因分类计数（t000045）：凭据/限流/超时/内容不可解析——巡检据此判该轮换 Key 还是该退避
      degradeReasons: {},
    };
    // cred 缺失的历史行：以 actorId 有无近似——401/扫描行无 actorId，认证后的 4xx/5xx 有
    const hadCred = r.cred ? r.cred !== 'none' : !!r.actorId;
    d.requests += 1;
    if (!hadCred) d.unauthenticated += 1;
    if (hadCred && r.path === '/v1/intent' && r.status === 200) d.intents += 1;
    if (r.kind === 'query') d.queries += 1;
    if (r.approvalId || r.hasApproval) d.approvalsCreated += 1;
    if (r.degraded === true) {
      d.degraded += 1;
      if (typeof r.degradeReason === 'string' && r.degradeReason) {
        d.degradeReasons[r.degradeReason] = (d.degradeReasons[r.degradeReason] || 0) + 1;
      }
    }
    if (r.status === 401 && hadCred) d.authFailures += 1;
    if (r.status >= 500 && hadCred) d.errors += 1;
    if (typeof r.latencyMs === 'number') d.latencyMs.push(r.latencyMs);
    if (r.actorId) d.actors.add(r.actorId);
    byDay.set(day, d);
  }

  const out = { generatedAt: new Date().toISOString(), days: {} };
  for (const [day, d] of [...byDay.entries()].sort()) {
    out.days[day] = {
      requests: d.requests,
      intents: d.intents,
      queries: d.queries,
      approvalsCreated: d.approvalsCreated,
      degradedIntents: d.degraded,
      degradeRate: d.intents ? +(d.degraded / d.intents).toFixed(4) : null,
      // 降级原因分布（t000045）：凭据→轮换 Key；限流→退避；超时→调 timeoutMs；内容→换模型
      degradeReasons: d.degradeReasons,
      authFailures: d.authFailures,
      unauthenticatedRequests: d.unauthenticated,
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
  if (auditRows) {
    const decisions = { approved: 0, rejected: 0 };
    let jobCompleted = 0, jobFailed = 0, paramsIncomplete = 0, targetUnresolved = 0;
    for (const l of auditRows) {
      const e = l.entry || {};
      if (e.from === 'ui' && e.action && e.action.intent === 'approve') {
        if (e.result === 'approved') decisions.approved += 1;
        if (e.result === 'rejected') decisions.rejected += 1;
      }
      if (e.action && e.action.intent === 'execute' && e.result === 'success') jobCompleted += 1;
      if (e.action && e.action.intent === 'execute' && e.result === 'failed') {
        // 口径拆分（2026-08-30）：missing_param:* 属"参数不完整（澄清未完成）"、target_not_resolved 属"目标解析失败"，
        // 均非真实执行失败——单列，避免污染执行成功率（此前 missing_param 占失败 81%，致成功率失真）。
        const reason = (e.links && e.links.reason) || '';
        if (reason.startsWith('missing_param:')) paramsIncomplete += 1;
        else if (reason === 'target_not_resolved') targetUnresolved += 1;
        else jobFailed += 1;
      }
    }
    const execTotal = jobCompleted + jobFailed + paramsIncomplete + targetUnresolved;
    out.audit = {
      approvalDecisions: decisions,
      executionsCompleted: jobCompleted,
      executionsFailed: jobFailed,        // 仅真实执行失败（execution_failed 等）——2026-08-30 起口径变更，此前含 missing_param/target_not_resolved
      paramsIncomplete,                    // missing_param:*（参数不完整，澄清未完成，非执行失败）
      targetUnresolved,                    // target_not_resolved（目标解析失败）
      // 双口径成功率：executionSuccessRate 全量含参数缺失；effectiveSuccessRate 仅真执行失败（阈值校准用后者）
      executionSuccessRate: execTotal ? +(jobCompleted / execTotal).toFixed(4) : null,
      effectiveSuccessRate: (jobCompleted + jobFailed) ? +(jobCompleted / (jobCompleted + jobFailed)).toFixed(4) : null,
    };
  }

  return out;
}

function main() {
  const accessFile = process.argv[2];
  const auditFile = process.argv[3] || null;
  const healthFile = process.argv[4] || null;
  if (!accessFile || !fs.existsSync(accessFile)) {
    console.error('用法: node collect-metrics.js <access.jsonl> [audit.jsonl] [provider-health.jsonl]');
    process.exit(1);
  }
  const accessRows = fs.readFileSync(accessFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const auditRows = (auditFile && fs.existsSync(auditFile))
    ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : null;
  const snap = buildSnapshot(accessRows, auditRows);
  // 供应商健康度（t000045 ④）：取 provider-health.jsonl 最新一条快照——巡检据此直接看
  // 「哪家在限流/凭据失效」，不必等降级发生才发现。
  if (healthFile && fs.existsSync(healthFile)) {
    const lines = fs.readFileSync(healthFile, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) {
      try {
        const last = JSON.parse(lines[lines.length - 1]);
        snap.providerHealth = { at: last.at, providers: last.providers };
      } catch (e) {
        snap.providerHealth = { at: null, providers: null, reason: 'parse_failed' };
      }
    }
  }
  console.log(JSON.stringify(snap, null, 1));
}

module.exports = { buildSnapshot };
if (require.main === module) main();
