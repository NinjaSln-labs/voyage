// CRL 吊销镜像契约测试：差量同步 / fail-closed / 审计留痕 / 定时启停
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createCrlMirror } = require('../src/auth/crl-mirror.js');

const FP1 = 'a'.repeat(64);
const FP2 = 'b'.repeat(64);
const FP3 = 'c'.repeat(64);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function mkAudit() { const entries = []; return { entries, write(f) { entries.push(f); return { ok: true }; } }; }

test('C1 差量同步：首拉全量入集 + 二拉增删差量正确', async () => {
  const set = new Set();
  const audit = mkAudit();
  const m = createCrlMirror({ revokedSet: set, source: async () => [FP1, FP2], auditPort: audit });
  const r1 = await m.refresh();
  assert.deepStrictEqual(r1, { ok: true, added: 2, removed: 0, total: 2, invalid: 0 });
  assert.ok(set.has(FP1) && set.has(FP2));
  // 换源：FP2 解除吊销、FP3 新吊销
  const m2 = createCrlMirror({ revokedSet: set, source: async () => [FP1, FP3], auditPort: audit });
  const r2 = await m2.refresh();
  assert.strictEqual(r2.added, 1);
  assert.strictEqual(r2.removed, 1);
  assert.ok(set.has(FP3) && !set.has(FP2));
});

test('C2 fail-closed：source 抛错/返回非数组 → 保留原集不放行', async () => {
  const set = new Set([FP1]);
  let shouldThrow = true;
  const m = createCrlMirror({
    revokedSet: set,
    source: async () => { if (shouldThrow) throw new Error('endpoint down'); return [FP2]; },
  });
  const r1 = await m.refresh();
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.reason, 'source_error');
  assert.ok(set.has(FP1) && !set.has(FP2), '失败保留原吊销集（宁可多拒）');
  // 恢复后可同步
  shouldThrow = false;
  const r2 = await m.refresh();
  assert.strictEqual(r2.ok, true);
  assert.ok(set.has(FP2) && !set.has(FP1), '恢复后以源为准（含解除吊销）');
  // 非数组返回
  const bad = createCrlMirror({ revokedSet: set, source: async () => ({ fp: FP3 }) });
  const r3 = await bad.refresh();
  assert.strictEqual(r3.reason, 'source_not_array');
});

test('C3 输入卫生：非法指纹过滤计数 + 大小写归一 + 去重', async () => {
  const set = new Set();
  const m = createCrlMirror({
    revokedSet: set,
    source: async () => [FP1.toUpperCase(), FP2, 'not-a-fp', FP2, 'z'.repeat(63)],
  });
  const r = await m.refresh();
  assert.strictEqual(r.total, 2, '去重+过滤后 2 条');
  assert.strictEqual(r.invalid, 3, '非法条目计数');
  assert.ok(set.has(FP1) && [...set].every(f => /^[a-f0-9]{64}$/.test(f)), '全部小写归一');
});

test('C4 审计留痕：成功记差量、失败记 rejected，不写指纹值（防泄漏）', async () => {
  const set = new Set();
  const audit = mkAudit();
  let fail = false;
  const m = createCrlMirror({
    revokedSet: set, auditPort: audit,
    source: async () => { if (fail) throw new Error('endpoint down'); return [FP1]; },
  });
  await m.refresh(); // 成功
  fail = true;
  const r = await m.refresh(); // 失败
  assert.strictEqual(r.ok, false);
  assert.ok(audit.entries.some(e => e.result === 'success'), '成功留痕存在');
  assert.ok(audit.entries.some(e => e.result === 'rejected'), '失败留痕存在');
  assert.strictEqual(audit.entries[0].from, 'crl.mirror');
  assert.strictEqual(typeof audit.entries[0].links.added, 'number', '只记差量计数');
  assert.ok(!JSON.stringify(audit.entries).includes(FP1), '审计不含指纹值');
});

test('C5 定时刷新：start 后自动拉取，stop 幂等停止', async () => {
  const set = new Set();
  let calls = 0;
  const m = createCrlMirror({
    revokedSet: set, intervalMs: 10,
    source: async () => { calls += 1; return calls === 1 ? [FP1] : []; },
  });
  m.start();
  assert.strictEqual(m.start().alreadyRunning, true, 'start 幂等');
  await sleep(45);
  assert.ok(calls >= 2, `定时拉取生效（calls=${calls}）`);
  m.stop();
  const after = m.stats().refreshCount;
  await sleep(30);
  assert.strictEqual(m.stats().refreshCount, after, 'stop 后不再刷新');
  assert.strictEqual(m.stop().ok, true, 'stop 幂等');
});

test('C7 空源防御（初审 P0 锚定）：默认拒绝空集（防全量解除吊销），allowEmpty 显式开启才清空', async () => {
  // a) 默认：source 返回 [] → fail-closed 保留原集
  const set = new Set([FP1]);
  const m = createCrlMirror({ revokedSet: set, source: async () => [] });
  const r = await m.refresh();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'empty_source');
  assert.ok(set.has(FP1), '吊销集不被空源擦除');
  assert.ok(m.stats().lastError === 'empty_source');
  // b) 显式 allowEmpty → 清空（确有全量过期场景）
  const m2 = createCrlMirror({ revokedSet: set, source: async () => [], allowEmpty: true });
  const r2 = await m2.refresh();
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.removed, 1);
  assert.strictEqual(set.size, 0);
});

test('C8 stop 后手动 refresh 仍可用（定时与手动正交）', async () => {
  const set = new Set();
  const m = createCrlMirror({ revokedSet: set, intervalMs: 10, source: async () => [FP1] });
  m.start();
  await sleep(25);
  m.stop();
  const r = await m.refresh();
  assert.strictEqual(r.ok, true, '手动刷新不受 stop 影响');
});

test('C6 构造校验与观测口径：缺参 fail-fast；stats 不含指纹', async () => {
  assert.throws(() => createCrlMirror({ source: async () => [] }), /revokedSet/);
  assert.throws(() => createCrlMirror({ revokedSet: new Set() }), /source/);
  assert.throws(() => createCrlMirror({ revokedSet: new Set(), source: async () => [], intervalMs: -1 }), /intervalMs/);
  const m = createCrlMirror({ revokedSet: new Set([FP1]), intervalMs: null, source: async () => [] });
  assert.throws(() => m.start(), /intervalMs/, '未配周期 start 显式报错');
  assert.deepStrictEqual(m.stats(), { size: 1, refreshCount: 0, lastError: null, running: false });
});
