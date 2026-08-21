// model BC 契约测试：评测门禁 GateService + EvalSetVersion + ModelGated（INV-M1/M4）

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { GateService, EvalSetVersion, ModelGated, DEFAULT_THRESHOLDS, DATASET_KINDS } = require('../src/model/domain.js');

function allGreen() {
  const s = {};
  for (const [ds, t] of Object.entries(DEFAULT_THRESHOLDS)) { s[ds] = {}; for (const [m, v] of Object.entries(t)) s[ds][m] = v; }
  return s;
}
const svc = new GateService();

// ---- 门禁原判定（对齐原 gate 语义，回归） ----
test('H1 全达标 + 反指标 0 → pass', () => { const r = svc.evaluate(allGreen(), { r1: 0, r2: 0, r3: 0 }); assert.strictEqual(r.pass, true); assert.strictEqual(r.highRiskPass, true); });
test('H2 高危集刚好 100% → pass', () => { const s = allGreen(); s.high_risk = { recall: 1.0 }; assert.strictEqual(svc.evaluate(s, { r1: 0, r2: 0, r3: 0 }).pass, true); });
test('E1 高危集 99% → 失败', () => { const s = allGreen(); s.high_risk = { recall: 0.99 }; const r = svc.evaluate(s, { r1: 0, r2: 0, r3: 0 }); assert.strictEqual(r.pass, false); assert.strictEqual(r.highRiskPass, false); });
test('E2 反指标 >0 → 冻结', () => { assert.strictEqual(svc.evaluate(allGreen(), { r1: 1, r2: 0, r3: 0 }).pass, false); });
test('E3 口语集不达标 → 失败', () => { const s = allGreen(); s.spoken = { recall: 0.70 }; assert.strictEqual(svc.evaluate(s, { r1: 0, r2: 0, r3: 0 }).pass, false); });
test('G1 全部反指标 0 → counterOk', () => { assert.strictEqual(GateService.counterOnly({ r1: 0, r2: 0, r3: 0 }).counterOk, true); });
test('G2 空输入 → 失败', () => { assert.strictEqual(svc.evaluate({}, { r1: 0, r2: 0, r3: 0 }).pass, false); });
test('G3 部分达标不通过', () => { const s = allGreen(); delete s.faq; assert.strictEqual(svc.evaluate(s, { r1: 0, r2: 0, r3: 0 }).pass, false); });
test('A1 非数字 → 判定失败', () => { assert.strictEqual(svc.evaluate({ high_risk: { recall: 'yes' } }, { r1: 0, r2: 0, r3: 0 }).highRiskPass, false); });
test('A2 反指标负数 → 非零拒绝', () => { assert.strictEqual(svc.evaluate(allGreen(), { r1: -1, r2: 0, r3: 0 }).pass, false); });
test('F1 空输入 → pass=false', () => { assert.strictEqual(svc.evaluate().pass, false); });
test('F2 无效指标名不崩溃', () => { assert.ok(typeof svc.evaluate({ bogus: { xxx: 1 } }, { r1: 0, r2: 0, r3: 0 }).pass === 'boolean'); });

// ---- EvalSetVersion 实体（DDD §5） ----
test('V1 合法构造：parts/sampleHashes/maintainers 冻结', () => {
  const v = new EvalSetVersion({ id: 'ev-1', setType: 'high_risk', parts: ['public', 'hidden', 'redteam'], sampleHashes: ['h1', 'h2'], maintainers: ['m1', 'm2'] });
  assert.strictEqual(v.setType, 'high_risk');
  assert.deepStrictEqual(v.parts, ['public', 'hidden', 'redteam']);
  assert.throws(() => { v.parts.push('x'); }, TypeError); // 冻结
});
test('V2 setType 非法拒绝', () => {
  assert.throws(() => new EvalSetVersion({ id: 'x', setType: 'bogus', maintainers: ['a', 'b'] }), /setType/);
});
test('V3 maintainers <2 拒绝（双人审阅 INV-M4）', () => {
  assert.throws(() => new EvalSetVersion({ id: 'x', setType: 'spoken', maintainers: ['a'] }), /≥2/);
});
test('V4 matchesSampleHashes 校验样本哈希一致性', () => {
  const v = new EvalSetVersion({ id: 'ev-1', setType: 'high_risk', sampleHashes: ['h1', 'h2'], maintainers: ['a', 'b'] });
  assert.strictEqual(v.matchesSampleHashes(['h1', 'h2']), true);
  assert.strictEqual(v.matchesSampleHashes(['h1', 'hX']), false);
  assert.strictEqual(v.matchesSampleHashes(['h1']), false);
});
test('V5 rotDate Date 拷贝（第 90 波）', () => {
  const d = new Date('2026-01-01T00:00:00Z');
  const v = new EvalSetVersion({ id: 'ev-1', setType: 'spoken', maintainers: ['a', 'b'], rotDate: d });
  const got = v.rotDate;
  got.setTime(0); // 篡改返回引用不影响内部
  assert.strictEqual(v.rotDate.getTime(), d.getTime());
});

// ---- GateService.gate + ModelGated 事件（INV-M1/M4） ----
test('M1 gate 通过 → 发布 ModelGated 事件', () => {
  const events = []; const bus = { publish(e) { events.push(e); } };
  const g = new GateService({ eventBus: bus });
  const v = new EvalSetVersion({ id: 'ev-1', setType: 'high_risk', maintainers: ['a', 'b'] });
  const r = g.gate(v, allGreen(), { r1: 0, r2: 0, r3: 0 });
  assert.strictEqual(r.passed, true);
  assert.strictEqual(events.length, 1);
  assert.ok(events[0] instanceof ModelGated);
  assert.strictEqual(events[0].type, 'ModelGated');
  assert.strictEqual(events[0].passed, true);
});
test('M2 gate 失败 → ModelGated.passed=false（变更审计仍落事件）', () => {
  const events = []; const bus = { publish(e) { events.push(e); } };
  const g = new GateService({ eventBus: bus });
  const v = new EvalSetVersion({ id: 'ev-2', setType: 'high_risk', maintainers: ['a', 'b'] });
  const s = allGreen(); s.high_risk = { recall: 0.9 };
  const r = g.gate(v, s, { r1: 0, r2: 0, r3: 0 });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(events[0].passed, false);
});
test('M3 gate 非 EvalSetVersion → 抛错', () => {
  const g = new GateService();
  assert.throws(() => g.gate({}, allGreen(), {}), /EvalSetVersion/);
});
test('M4 ModelGated 事件深冻结', () => {
  const g = new GateService();
  const v = new EvalSetVersion({ id: 'ev-1', setType: 'high_risk', maintainers: ['a', 'b'] });
  const e = new ModelGated({ versionId: 'ev-1', passed: true });
  assert.throws(() => { e.passed = false; }, TypeError);
  assert.throws(() => { e.details.push({}); }, TypeError);
});