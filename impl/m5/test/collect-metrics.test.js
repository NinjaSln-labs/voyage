// collect-metrics.js 聚合口径拆分测试（方案 A：missing_param/target_not_resolved 与真执行失败解耦）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildSnapshot } = require('../scripts/collect-metrics.js');

function aexec(opts = {}) {
  return { at: opts.at || '2026-08-30T00:00:00.000Z', path: '/v1/intent', kind: opts.kind, actorId: opts.actorId, status: 200, degraded: opts.degraded ?? false, latencyMs: opts.latencyMs ?? 100 };
}

function auditEntry(over) {
  return { seq: over.seq || 1, entry: over.entry };
}

test('执行失败口径拆分：missing_param / target_not_resolved / execution_failed', () => {
  const audit = [
    auditEntry({ entry: { who: 'sys', when: new Date().toISOString(), from: 'ui', action: { intent: 'approve' }, result: 'approved' } }),
    // 真实执行成功
    auditEntry({ entry: { who: 'sys', when: new Date().toISOString(), from: 'ui', action: { intent: 'execute' }, result: 'success' } }),
    // missing_param:file
    auditEntry({ entry: { who: 'sys', when: new Date().toISOString(), from: 'ui', action: { intent: 'execute' }, result: 'failed', links: { reason: 'missing_param:file' } } }),
    // missing_param:compose_file
    auditEntry({ entry: { who: 'sys', when: new Date().toISOString(), from: 'ui', action: { intent: 'execute' }, result: 'failed', links: { reason: 'missing_param:compose_file' } } }),
    // target_not_resolved
    auditEntry({ entry: { who: 'sys', when: new Date().toISOString(), from: 'ui', action: { intent: 'execute' }, result: 'failed', links: { reason: 'target_not_resolved' } } }),
    // 真实执行失败
    auditEntry({ entry: { who: 'sys', when: new Date().toISOString(), from: 'ui', action: { intent: 'execute' }, result: 'failed', links: { reason: 'execution_failed' } } }),
  ];
  const out = buildSnapshot([], audit);
  assert.strictEqual(out.audit.executionsCompleted, 1, '成功 1 次');
  assert.strictEqual(out.audit.paramsIncomplete, 2, 'missing_param 2 次');
  assert.strictEqual(out.audit.targetUnresolved, 1, 'target_not_resolved 1 次');
  assert.strictEqual(out.audit.executionsFailed, 1, '真实执行失败 1 次');
  assert.strictEqual(out.audit.executionSuccessRate, 1 / 5, '全量成功率 = 1/5');
  assert.strictEqual(out.audit.effectiveSuccessRate, 1 / 2, '有效成功率 = 1/(1+1)=1/2');
});

test('审批决定计数 approved / rejected', () => {
  const audit = [
    auditEntry({ entry: { from: 'ui', action: { intent: 'approve' }, result: 'approved' } }),
    auditEntry({ entry: { from: 'ui', action: { intent: 'approve' }, result: 'approved' } }),
    auditEntry({ entry: { from: 'ui', action: { intent: 'approve' }, result: 'rejected' } }),
  ];
  const out = buildSnapshot([], audit);
  assert.strictEqual(out.audit.approvalDecisions.approved, 2);
  assert.strictEqual(out.audit.approvalDecisions.rejected, 1);
});

test('days 聚合：intents / queries / degraded / latency 分位', () => {
  const access = [
    aexec({ at: '2026-08-30T00:00:00.000Z', kind: 'query', actorId: 'a1', latencyMs: 10 }),
    aexec({ at: '2026-08-30T00:00:01.000Z', kind: 'config_change', actorId: 'a1', degraded: true, latencyMs: 20 }),
    aexec({ at: '2026-08-30T00:00:02.000Z', kind: 'query', actorId: 'a2', latencyMs: 30 }),
    aexec({ at: '2026-08-31T00:00:00.000Z', kind: 'query', actorId: 'a2', latencyMs: 40 }),
  ];
  const out = buildSnapshot(access, null);
  assert.strictEqual(out.days['2026-08-30'].requests, 3);
  assert.strictEqual(out.days['2026-08-30'].intents, 3);
  assert.strictEqual(out.days['2026-08-30'].queries, 2);
  assert.strictEqual(out.days['2026-08-30'].degradedIntents, 1);
  assert.strictEqual(out.days['2026-08-30'].activeActors, 2);
  assert.strictEqual(out.days['2026-08-30'].latencyMs.p50, 20, '分位排序 10,20,30 → p50=20');
  assert.strictEqual(out.days['2026-08-31'].requests, 1);
  assert.strictEqual(out.audit, undefined, '无审计文件时不应有 audit 字段');
});

test('无审计行时 audit 字段不存在', () => {
  const out = buildSnapshot([], null);
  assert.strictEqual(out.audit, undefined);
});
