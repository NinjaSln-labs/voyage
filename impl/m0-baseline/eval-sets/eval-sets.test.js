// 评测集契约测试（真实部署前置）：评测集样本与 M6 GateService 对接
// 验证：样本集可加载、规模达标、高危集预期全覆盖防护分支
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DATASET_MINIMUMS } = require('../../m6/src/model/domain.js');

const DIR = path.join(__dirname, '..', 'eval-sets');
const SET_FILES = {
  spoken: 'spoken-public.json', knowledge: 'knowledge-public.json', high_risk: 'high-risk-public.json',
  term: 'term-public.json', explain: 'explain-public.json', faq: 'faq-public.json',
};

function load(setType) {
  return JSON.parse(fs.readFileSync(path.join(DIR, SET_FILES[setType]), 'utf8')).samples || [];
}
function expField(setType) { return setType === 'term' ? 'standard' : 'expected'; }

test('E1 六类评测集公开集规模达标（≥基线）', () => {
  for (const [setType, min] of Object.entries(DATASET_MINIMUMS)) {
    const n = load(setType).length;
    assert.ok(n >= min, `${setType}: ${n} < ${min}`);
  }
});

test('E2 全部样本结构合法（id/input/预期字段）', () => {
  for (const setType of Object.keys(SET_FILES)) {
    const f = expField(setType);
    const bad = load(setType).filter(s => !s.id || !s.input || !s[f]);
    assert.strictEqual(bad.length, 0, `${setType}: ${bad.length} 条缺字段`);
  }
});

test('E3 高危集预期全覆盖防护分支（拒绝/审批/查询，召回 100% 硬线）', () => {
  const hr = load('high_risk');
  const uncovered = hr.filter(s => !/^(reject|approve|query)/.test(s.expected));
  assert.strictEqual(uncovered.length, 0, `高危集 ${uncovered.length} 条未落防护分支: ${uncovered.map(u => u.id).join(',')}`);
});

test('E4 高危集含对抗样本（注入/伪装/编码变体/聚合）', () => {
  const hr = load('high_risk');
  const adversarial = hr.filter(s => /injection|disguise|obfuscation|aggregation|escalation|unicode|base64/.test(s.category));
  assert.ok(adversarial.length >= 10, `对抗样本 ${adversarial.length} < 10`);
  const cats = [...new Set(hr.map(s => s.category))];
  assert.ok(cats.length >= 10, `分类多样性不足: ${cats.length} 类`);
});

test('E5 样本 id 唯一性', () => {
  for (const setType of Object.keys(SET_FILES)) {
    const ids = load(setType).map(s => s.id);
    assert.strictEqual(new Set(ids).size, ids.length, `${setType} id 重复`);
  }
});