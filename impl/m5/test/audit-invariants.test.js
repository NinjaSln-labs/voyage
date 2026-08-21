// audit 补测：INV-U2（断裂告警/分段重建/事件登记）+ INV-U4（北极星计数/查询缓冲）+ AuditWritten 事件 + INV-U5（至少一次投递）
// 第 23 波 DDD 审计修复验证

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  AuditEntry, AppendOnlyAuditChain, AuditWritten, ChainIntegrityBreach, QueryBufferOverflow,
  POLAR_KINDS, MAX_QUERY_BUFFER,
} = require('../src/audit/domain.js');

function e(over = {}) {
  return new AuditEntry({ who: 'u1', from: 'dev1', when: new Date('2026-01-01T00:00:00Z'), result: 'success', action: { intent: 'query', capability: 'query', target: 'srv1', paramsSchemaOk: true }, ...over });
}
function bus() {
  const events = [];
  return { events, publish(ev) { events.push(ev); } };
}

// ---------- INV-U5: 至少一次投递（AuditWritten 事件 + seq 幂等键） ----------
test('U5-1 append 发布 AuditWritten 事件（audit→metric）', () => {
  const b = bus();
  const c = new AppendOnlyAuditChain({ eventBus: b });
  c.append(e());
  assert.strictEqual(b.events.length, 1);
  assert.ok(b.events[0] instanceof AuditWritten);
  assert.strictEqual(b.events[0].type, 'AuditWritten');
  assert.strictEqual(b.events[0].schemaVersion, 1);
});

test('U5-2 AuditWritten eventId = auditw-<seq> 幂等键（重投同 seq 去重）', () => {
  const b = bus();
  const c = new AppendOnlyAuditChain({ eventBus: b });
  const r1 = c.append(e());
  const r2 = c.append(e({ who: 'u2' }));
  assert.strictEqual(b.events[0].eventId, `auditw-${r1.seq}`);
  assert.strictEqual(b.events[1].eventId, `auditw-${r2.seq}`);
  assert.notStrictEqual(b.events[0].eventId, b.events[1].eventId);
});

test('U5-3 eventId 幂等：同 eventId 消费端可去重（确定性键）', () => {
  const b = bus();
  const c = new AppendOnlyAuditChain({ eventBus: b });
  c.append(e());
  c.append(e());  // 同 who，但 seq 递增 → eventId 仍不同（正确：不同 entry 不同事件）
  const seen = new Set(b.events.map(ev => ev.eventId));
  assert.strictEqual(seen.size, 2); // 无 collision，消费端可安全去重
});

// ---------- INV-U2: 断裂告警 + 分段重建 + 事件登记 ----------
test('U2-1 verify 断裂 → 发布 ChainIntegrityBreach（INV-N2 关键告警）', () => {
  const b = bus();
  const c = new AppendOnlyAuditChain({ eventBus: b });
  c.append(e());
  c.append(e({ who: 'u3' }));
  c._entries[1].chainHash = 'deadbeef'; // 篡改
  const r = c.verify();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.brokenSeq, 2);
  const breach = b.events.find(ev => ev instanceof ChainIntegrityBreach);
  assert.ok(breach, '应发布断裂告警事件');
  assert.strictEqual(breach.severity, 'critical');
  assert.strictEqual(breach.brokenSeq, 2);
});

test('U2-2 断裂事件登记（不依赖 eventBus）', () => {
  const c = new AppendOnlyAuditChain(); // 无 eventBus
  c.append(e());
  c.append(e({ who: 'u3' }));
  c._entries[1].chainHash = 'deadbeef';
  c.verify();
  assert.strictEqual(c.breaches.length, 1);
  assert.strictEqual(c.breaches[0].seq, 2);
});

test('U2-3 rebuildFrom 分段重建后 verify 恢复 ok', () => {
  const c = new AppendOnlyAuditChain();
  c.append(e());
  c.append(e({ who: 'u2' }));
  c.append(e({ who: 'u3' }));
  c._entries[1].chainHash = 'tampered';
  assert.strictEqual(c.verify().ok, false);
  const r = c.rebuildFrom(2);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rebuilt, 2); // 第 2、3 条重建
  assert.strictEqual(c.verify().ok, true);
});

// ---------- INV-U4: 北极星计数分离 ----------
test('U4-1 countPolar 保序计数，与明细链分离', () => {
  const c = new AppendOnlyAuditChain();
  c.append(e()); // 明细链 +1
  c.countPolar('intent');
  c.countPolar('job');
  c.countPolar('intent');
  assert.strictEqual(c.metricCounts().intent, 2);
  assert.strictEqual(c.metricCounts().job, 1);
  assert.strictEqual(c.length, 1); // 计数不入明细链（分离）
});

test('U4-2 countPolar 非法 kind 拒绝', () => {
  const c = new AppendOnlyAuditChain();
  assert.throws(() => c.countPolar('bogus'), /kind 非法/);
});

test('U4-3 metricCounts 返回不可变快照', () => {
  const c = new AppendOnlyAuditChain();
  c.countPolar('intent');
  const snap = c.metricCounts();
  assert.throws(() => { snap.intent = 999; }, TypeError);
});

// ---------- INV-U4: 查询缓冲背压 ----------
test('U4-4 bufferQuery 容量内入缓冲，不入详情链', () => {
  const c = new AppendOnlyAuditChain();
  const r = c.bufferQuery(e());
  assert.strictEqual(r.buffered, true);
  assert.strictEqual(r.dropped, 0);
  assert.strictEqual(c.queryBufferLength, 1);
  assert.strictEqual(c.length, 0); // 未入详情链
});

test('U4-5 flushQueryBuffer 批量落地详情链', () => {
  const c = new AppendOnlyAuditChain();
  c.bufferQuery(e());
  c.bufferQuery(e({ who: 'u2' }));
  const r = c.flushQueryBuffer();
  assert.strictEqual(r.flushed.length, 2);
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c.queryBufferLength, 0);
});

test('U4-6 溢出丢弃 + QueryBufferOverflow 告警', () => {
  const b = bus();
  const c = new AppendOnlyAuditChain({ eventBus: b });
  for (let i = 0; i < MAX_QUERY_BUFFER; i++) c.bufferQuery(e({ who: `u${i}` }));
  assert.strictEqual(c.queryBufferLength, MAX_QUERY_BUFFER);
  const r = c.bufferQuery(e({ who: 'overflow' }));
  assert.strictEqual(r.buffered, false);
  assert.strictEqual(r.dropped, 1);
  assert.strictEqual(r.reason, 'query_buffer_overflow');
  const overflow = b.events.find(ev => ev instanceof QueryBufferOverflow);
  assert.ok(overflow, '应发布溢出告警');
});

// ---------- 事件狂载不变性 ----------
test('E7 事件载荷深冻结不可篡改', () => {
  const b = bus();
  const c = new AppendOnlyAuditChain({ eventBus: b });
  c.append(e());
  const ev = b.events[0];
  assert.throws(() => { ev.entry = {}; }, TypeError);
  assert.throws(() => { ev.eventId = 'hack'; }, TypeError);
});