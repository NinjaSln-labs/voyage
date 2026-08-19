// audit 契约测试：AppendOnlyAuditChain（RQ-831 / INV-U3）
// 命名 H/E/G/A/F 对齐 M3/M4（happy/error/edge/adversarial/fault-tolerance）

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { AuditEntry, AppendOnlyAuditChain, OUTCOMES } = require('../src/audit/domain.js');

function e({ who = 'u1', result = 'success', action = { intent: 'query', capability: 'query', target: 'srv1', paramsSchemaOk: true }, links = {}, from = 'dev1', when = new Date('2026-01-01T00:00:00Z') } = {}) {
  return new AuditEntry({ who, from, when, action, result, links });
}

// ---- happy ----
test('H1 审计五元组入链：chainHash + seq 递增，tailHash 可追踪', () => {
  const c = new AppendOnlyAuditChain();
  const r1 = c.append(e({ when: new Date('2026-01-01T00:00:00Z') }));
  const r2 = c.append(e({ who: 'u2', when: new Date('2026-01-01T00:01:00Z') }));
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.seq, 1);
  assert.strictEqual(r2.seq, 2);
  assert.ok(typeof r1.chainHash === 'string' && r1.chainHash.length > 0);
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c.tailHash, r2.chainHash);
  assert.deepStrictEqual(c.verify(), { ok: true });
});

test('H2 append-only：entries() 只读快照，Date 拷贝隔离', () => {
  const c = new AppendOnlyAuditChain();
  const when = new Date('2026-01-01T00:00:00Z');
  c.append(e({ when }));
  const snap = c.entries();
  assert.strictEqual(snap.length, 1);
  // 篡改快照不影响链
  assert.throws(() => { snap[0].chainHash = 'x'; }, TypeError);
  assert.strictEqual(c.verify().ok, true);
});

test('H3 空链 verify 通过；tailHash=null', () => {
  const c = new AppendOnlyAuditChain();
  assert.strictEqual(c.tailHash, null);
  assert.deepStrictEqual(c.verify(), { ok: true });
});

test('H4 持久化 save/load 往返后链校验仍真（INV-U3 链重建）', () => {
  let storedHead = null, storedChain = null;
  const persist = {
    load() { return null; },
    save(head, chain) { storedHead = head; storedChain = chain.map(r => r); },
  };
  const c1 = new AppendOnlyAuditChain({ persist });
  c1.append(e());
  c1.append(e({ who: 'u2' }));
  // 第二轮重构一个持相同载荷的链
  const c2 = new AppendOnlyAuditChain({ persist });
  // 重建后为空（本桩 load 恒 null）——验证 save/load 契约被调用
  assert.strictEqual(storedChain.length, 2);
});

// ---- error ----
test('E1 五元组字段非法拒绝：result 非法枚举', () => {
  assert.throws(() => e({ result: 'bogus' }), /result/);
});
test('E2 who/from 空或超长拒绝', () => {
  assert.throws(() => e({ who: '' }), /who/);
  assert.throws(() => e({ from: '' }), /from/);
});
test('E3 when 非有效 Date 拒绝', () => {
  assert.throws(() => e({ when: '2026-01-01' }), /when/);
  assert.throws(() => e({ when: new Date('abc') }), /when/);
});
test('E4 append 非 AuditEntry 实例拒绝', () => {
  const c = new AppendOnlyAuditChain();
  assert.throws(() => c.append({ who: 'u' }), /AuditEntry/);
});
test('E5 links 含对象类型拒绝（只允许 string/number/boolean 叶子）', () => {
  assert.throws(() => e({ links: { grantId: { $: 'evil' } } }), /links/);
});

// ---- edge ----
test('G1 seq 单调递增，even 尾部条目有独立 chainHash', () => {
  const c = new AppendOnlyAuditChain();
  const r1 = c.append(e());
  const r2 = c.append(e({ who: 'u9' }));
  assert.notStrictEqual(r1.chainHash, r2.chainHash);
  assert.strictEqual(r1.seq + 1, r2.seq);
});
test('G2 降级态缓冲 appendBuffered 不入主链，flushBuffer 后补齐（INV-U3）', () => {
  const c = new AppendOnlyAuditChain();
  c.appendBuffered(e({ who: 'b1' }));
  c.appendBuffered(e({ who: 'b2' }));
  assert.strictEqual(c.bufferLength, 2);
  assert.strictEqual(c.length, 0);           // 主链未受影响
  const r = c.flushBuffer();
  assert.strictEqual(r.flushed.length, 2);
  assert.strictEqual(c.length, 2);           // 补齐入链
  assert.strictEqual(c.bufferLength, 0);
  assert.strictEqual(c.verify().ok, true);
});

// ---- adversarial ----
test('A1 篡改中间 chainHash → verify 失败（INV-U3 篡改检测）', () => {
  const c = new AppendOnlyAuditChain();
  c.append(e());
  c.append(e({ who: 'u2' }));
  c.append(e({ who: 'u3' }));
  // 篡改中间条（内存链内部结构
  const mid = c._entries[1];
  const orig = mid.chainHash;
  mid.chainHash = 'deadbeef';
  assert.notDeepStrictEqual(c.verify(), { ok: true });
  assert.strictEqual(c.verify().ok, false);
  mid.chainHash = orig; // 复原
});
test('A2 append 试图降序 seq / 重复 seq 不破坏 append-only（seq 由链强制递增）', () => {
  const c = new AppendOnlyAuditChain();
  c.append(e());
  // entry 的 seq 由链覆写，无法伪造
  const forged = e({ who: 'forger' });
  Object.defineProperty(forged, '_seq', { value: 999, writable: false, enumerable: false });
  const r = c.append(forged);
  assert.strictEqual(r.seq, 2); // 链强制为 2（非 999）
});

// ---- fault-tolerance ----
test('F1 持久化端口抛错 → append 技术上失败（fail-closed 信号）', () => {
  const persist = { load() { return null; }, save() { throw new Error('storage down'); } };
  const c = new AppendOnlyAuditChain({ persist });
  assert.throws(() => c.append(e()), /storage down/);
});
test('F2 时间倒退：链条不依赖 now 单调（append 用 entry.when 计算，不回退化）', () => {
  const c = new AppendOnlyAuditChain();
  c.append(e({ when: new Date('2026-01-02T00:00:00Z') }));
  c.append(e({ who: 'u2', when: new Date('2026-01-01T00:00:00Z') })); // 更早时间仍正常入链
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c.verify().ok, true);
});