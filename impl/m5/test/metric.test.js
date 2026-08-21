// metric BC 契约测试：MetricService 订阅 AuditWritten 做北极星/反指标月读数（DDD §4 metric.count）

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { MetricService } = require('../src/metric/domain.js');
const { AuditWritten } = require('../src/audit/domain.js');

function aw(seq, { when = '2026-01-15T10:00:00Z', result = 'success', intent = 'query' } = {}) {
  return new AuditWritten({ seq, who: 'u1', when: new Date(when), action: { intent, capability: 'query', target: 'srv1', paramsSchemaOk: true }, result });
}
const svc = new MetricService();

test('H1 订阅 AuditWritten 意图完成 → northStar.intent +1', () => {
  const s = new MetricService();
  s.onAuditWritten(aw(1, { result: 'success', intent: 'query' }));
  assert.strictEqual(s.count('2026-01').northStar.intent, 1);
  assert.strictEqual(s.count('2026-01').northStar.job, 0);
});
test('H2 执行成功 → northStar.job +1', () => {
  const s = new MetricService();
  s.onAuditWritten(aw(1, { result: 'success', intent: 'execute' }));
  assert.strictEqual(s.count('2026-01').northStar.job, 1);
});
test('H3 拒绝/回滚 → counters', () => {
  const s = new MetricService();
  s.onAuditWritten(aw(1, { result: 'rejected' }));
  s.onAuditWritten(aw(2, { result: 'rolled_back' }));
  assert.strictEqual(s.count('2026-01').counters.rejected, 1);
  assert.strictEqual(s.count('2026-01').counters.rolledBack, 1);
});
test('G1 按自然月归桶', () => {
  const s = new MetricService();
  s.onAuditWritten(aw(1, { when: '2026-01-15T10:00:00Z' }));
  s.onAuditWritten(aw(2, { when: '2026-02-15T10:00:00Z' }));
  assert.strictEqual(s.count('2026-01').northStar.intent, 1);
  assert.strictEqual(s.count('2026-02').northStar.intent, 1);
});
test('A1 eventId 幂等：同事件重放只计一次', () => {
  const s = new MetricService();
  const e = aw(1);
  s.onAuditWritten(e);
  s.onAuditWritten(e); // 重放
  assert.strictEqual(s.count('2026-01').northStar.intent, 1);
});
test('E1 非 AuditWritten 事件 → handled false', () => {
  assert.strictEqual(svc.onAuditWritten({ eventId: 'x', type: 'Other' }).reason, 'invalid');
});
test('F1 count 非法 month 格式 → 抛错', () => {
  assert.throws(() => svc.count('2026'), /YYYY-MM/);
  assert.throws(() => svc.count('invalid'), /YYYY-MM/);
});
test('F2 count 返回不可变快照', () => {
  const r = svc.count('2026-01');
  assert.throws(() => { r.northStar.intent = 999; }, TypeError);
});
// ---------- 第 29 波审计补：audit→metric 真实接线（DDD §3 事件流）----------
test('W1 audit eventBus 发布 AuditWritten → metric.onAuditWritten 真实订阅（audit→metric 全链）', () => {
  const { AppendOnlyAuditChain, AuditEntry } = require('../src/audit/domain.js');
  const m = new MetricService();
  const bus = { publish(ev) { if (ev.type === 'AuditWritten') m.onAuditWritten(ev); } }; // 真实接线：audit 发布 → metric 订阅
  const chain = new AppendOnlyAuditChain({ eventBus: bus });
  chain.append(new AuditEntry({ who: 'u1', from: 'cli', when: new Date('2026-01-15T10:00:00Z'), action: { intent: 'execute', capability: 'restart', target: 'svc1', paramsSchemaOk: true }, result: 'success' }));
  chain.append(new AuditEntry({ who: 'u2', from: 'cli', when: new Date('2026-01-16T10:00:00Z'), action: { intent: 'query', capability: 'query', target: 'svc1', paramsSchemaOk: true }, result: 'success' }));
  const jan = m.count('2026-01');
  assert.strictEqual(jan.northStar.job, 1, '执行成功计入北极星 job');
  assert.strictEqual(jan.northStar.intent, 1, '意图完成计入北极星 intent');
});
