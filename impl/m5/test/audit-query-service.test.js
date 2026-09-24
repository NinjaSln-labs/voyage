// 审计数据层查询服务契约测试（ADR-006 / t000037）：范围收敛 + 聚合无明细 + 元审计
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createAuditRepo } = require('../src/audit/repo-memory.js');
const { AuditEntry } = require('../src/audit/domain.js');
const { createIdentityRepoMemory } = require('../src/repo/repo-identity.js');
const { createAuditQueryService, DEFAULT_LIMIT } = require('../src/audit/query-service.js');

const T0 = new Date('2026-09-24T10:00:00Z');

function build() {
  const auditRepo = createAuditRepo();
  const ids = createIdentityRepoMemory([
    { id: 'sre-alice', role: 'sre' }, { id: 'dev-bob', role: 'dev' },
    { id: 'mgr-1', role: 'manager' }, { id: 'qa-zhang', role: 'test' },
  ]);
  const svc = createAuditQueryService({
    identityPort: { findById: (id) => ids.findById(id) },
    auditRepo,
    timeSource: () => T0,
  });
  return { auditRepo, ids, svc };
}

/** 写入 n 条审计（who 交替；when 递增天） */
function seed(auditRepo, spec) {
  let seq = 0;
  for (const { who, result = 'success', day = 0 } of spec) {
    seq += 1;
    auditRepo.write(new AuditEntry({
      who, when: new Date(T0.getTime() - day * 24 * 3600 * 1000), from: 'cli',
      action: { intent: 'execute', capability: 'restart', target: 'svc-1', paramsSchemaOk: true },
      result,
    }));
  }
  return seq;
}

test('AQ1 SRE 范围 full → 全量明细（含他人条目）', () => {
  const { auditRepo, svc } = build();
  seed(auditRepo, [{ who: 'dev-bob' }, { who: 'sre-alice' }, { who: 'qa-zhang' }]);
  const r = svc.query({ actorId: 'sre-alice' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.scope, 'full');
  assert.strictEqual(r.entries.length, 3);
  assert.deepStrictEqual(r.entries.map(e => e.who).sort(), ['dev-bob', 'qa-zhang', 'sre-alice']);
});

test('AQ2 研发范围 self → 仅本人记录（不泄露他人）', () => {
  const { auditRepo, svc } = build();
  seed(auditRepo, [{ who: 'dev-bob' }, { who: 'sre-alice' }, { who: 'dev-bob' }]);
  const r = svc.query({ actorId: 'dev-bob' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.scope, 'self');
  assert.strictEqual(r.entries.length, 2);
  assert.ok(r.entries.every(e => e.who === 'dev-bob'), '只应返回本人条目');
});

test('AQ3 test 角色无 audit_query → forbidden（且不返回条目）', () => {
  const { auditRepo, svc } = build();
  seed(auditRepo, [{ who: 'dev-bob' }]);
  const r = svc.query({ actorId: 'qa-zhang' });
  assert.deepStrictEqual(r, { ok: false, reason: 'forbidden' });
});

test('AQ4 scope 不匹配 → forbidden：manager 无 audit_query；SRE 的 audit_summary 非 aggregate', () => {
  const { auditRepo, svc } = build();
  seed(auditRepo, [{ who: 'dev-bob' }]);
  assert.deepStrictEqual(svc.query({ actorId: 'mgr-1' }), { ok: false, reason: 'forbidden' });
  assert.deepStrictEqual(svc.summary({ actorId: 'sre-alice' }), { ok: false, reason: 'forbidden' });
});

test('AQ5 manager 聚合：仅统计，绝不含明细行', () => {
  const { auditRepo, svc } = build();
  seed(auditRepo, [
    { who: 'dev-bob', day: 0 }, { who: 'dev-bob', day: 1, result: 'rejected' },
    { who: 'sre-alice', day: 2 }, { who: 'sre-alice', day: 40 },
  ]);
  const r = svc.summary({ actorId: 'mgr-1', days: 7 });
  assert.strictEqual(r.ok, true);
  assert.ok(!('entries' in r), '聚合响应不得含 entries');
  assert.strictEqual(r.summary.windowDays, 7);
  assert.strictEqual(r.summary.total, 3, '窗口内 3 条（第 40 天剔除）');
  assert.strictEqual(r.summary.byResult.success, 2);
  assert.strictEqual(r.summary.byResult.rejected, 1);
  assert.strictEqual(r.summary.byActor['dev-bob'], 2);
  assert.ok(Object.keys(r.summary.byDay).length >= 1);
});

test('AQ6 分页：newest-first + seq 游标 + limit 夹取 + 非法参数', () => {
  const { auditRepo, svc } = build();
  seed(auditRepo, Array.from({ length: 5 }, (_, i) => ({ who: 'sre-alice', day: i })));
  const p1 = svc.query({ actorId: 'sre-alice', limit: 2 });
  assert.deepStrictEqual(p1.entries.map(e => e.seq), [5, 4], 'newest-first');
  assert.strictEqual(p1.nextBefore, 4);
  const p2 = svc.query({ actorId: 'sre-alice', limit: 2, before: p1.nextBefore });
  assert.deepStrictEqual(p2.entries.map(e => e.seq), [3, 2]);
  assert.strictEqual(p2.nextBefore, 2);
  const p3 = svc.query({ actorId: 'sre-alice', limit: 2, before: p2.nextBefore });
  assert.deepStrictEqual(p3.entries.map(e => e.seq), [1]);
  assert.strictEqual(p3.nextBefore, null);
  // limit 上限夹取（>200 → 200，非非法）
  const big = svc.query({ actorId: 'sre-alice', limit: 10 ** 6 });
  assert.strictEqual(big.ok, true);
  assert.strictEqual(big.entries.length, 5);
  // 非法参数
  assert.deepStrictEqual(svc.query({ actorId: 'sre-alice', limit: 'abc' }), { ok: false, reason: 'invalid_param' });
  assert.deepStrictEqual(svc.query({ actorId: 'sre-alice', before: -3 }), { ok: false, reason: 'invalid_param' });
  assert.deepStrictEqual(svc.summary({ actorId: 'mgr-1', days: 'x' }), { ok: false, reason: 'invalid_param' });
  assert.strictEqual(typeof DEFAULT_LIMIT, 'number');
});

test('AQ7 元审计：成功查询与越权尝试均经 INV-U4 缓冲留痕', () => {
  const { auditRepo, svc } = build();
  seed(auditRepo, [{ who: 'dev-bob' }]);
  const before = auditRepo.queryBufferLength();
  svc.query({ actorId: 'sre-alice' });          // 成功
  svc.query({ actorId: 'qa-zhang' });           // 越权
  svc.summary({ actorId: 'mgr-1' });            // 聚合成功
  assert.strictEqual(auditRepo.queryBufferLength(), before + 3, '每次查询均留痕（含越权）');
  const chainLen = auditRepo.length();
  assert.strictEqual(chainLen, 1, '查询类留痕不入详情主链（INV-U4）');
});

test('AQ8 停用身份（active=false）→ forbidden', () => {
  const { auditRepo, svc } = build();
  const disabled = { findById: () => ({ active: false, hasCapability: () => true, scopeOf: () => 'full' }) };
  const svc2 = createAuditQueryService({ identityPort: disabled, auditRepo, timeSource: () => T0 });
  seed(auditRepo, [{ who: 'dev-bob' }]);
  assert.deepStrictEqual(svc2.query({ actorId: 'sre-alice' }), { ok: false, reason: 'forbidden' });
});
