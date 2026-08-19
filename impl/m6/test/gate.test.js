// gate 契约测试：评测门禁 GateService（INV-M5）

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { GateService, DEFAULT_THRESHOLDS } = require('../src/gate/domain.js');

function allGreen() {
  const s = {};
  for (const [ds, t] of Object.entries(DEFAULT_THRESHOLDS)) { s[ds] = {}; for (const [m, v] of Object.entries(t)) s[ds][m] = v; }
  return s;
}
const svc = new GateService();

test('H1 全达标 + 反指标 0 → pass', () => { const r = svc.evaluate(allGreen(), { r1: 0, r2: 0, r3: 0 }); assert.strictEqual(r.pass, true); assert.strictEqual(r.highRiskPass, true); });
test('H2 高危集刚好 100% → pass', () => { const s = allGreen(); s.high_risk = { recall: 1.0 }; assert.strictEqual(svc.evaluate(s, { r1: 0, r2: 0, r3: 0 }).pass, true); });
test('E1 高危集 99% → 失败', () => { const s = allGreen(); s.high_risk = { recall: 0.99 }; const r = svc.evaluate(s, { r1: 0, r2: 0, r3: 0 }); assert.strictEqual(r.pass, false); assert.strictEqual(r.highRiskPass, false); });
test('E2 反指标 >0 → 冻结', () => { assert.strictEqual(svc.evaluate(allGreen(), { r1: 1, r2: 0, r3: 0 }).pass, false); });
test('E3 口语集不达标 → 失败', () => { const s = allGreen(); s.spoken = { recall: 0.70 }; assert.strictEqual(svc.evaluate(s, { r1: 0, r2: 0, r3: 0 }).pass, false); });
test('G1 全部反指标 0 → counterOk', () => { assert.strictEqual(GateService.counterOnly({ r1: 0, r2: 0, r3: 0 }).counterOk, true); });
test('G2 空输入 → 失败', () => { assert.strictEqual(svc.evaluate({}, { r1: 0, r2: 0, r3: 0 }).pass, false); });
test('G3 部分达标不通过', () => { const s = allGreen(); delete s.faq; assert.strictEqual(svc.evaluate(s, { r1: 0, r2: 0, r3: 0 }).pass, false); });
test('A1 非数字 → 判定失败', () => { assert.strictEqual(svc.evaluate({ high_risk: { recall: 'yes' } }, { r1: 0, r2: 0, r3: 0 }).highRiskPass, false); });
test('A2 反指标负数 → 数据异常被拒绝（非零）', () => { assert.strictEqual(svc.evaluate(allGreen(), { r1: -1, r2: 0, r3: 0 }).pass, false); });
test('F1 空输入 → pass=false', () => { assert.strictEqual(svc.evaluate().pass, false); });
test('F2 无效指标名不崩溃', () => { assert.ok(typeof svc.evaluate({ bogus: { xxx: 1 } }, { r1: 0, r2: 0, r3: 0 }).pass === 'boolean'); });
