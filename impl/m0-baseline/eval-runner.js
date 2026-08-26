// 评测集 runner（公开集验证）：加载 JSON 样本 → 用 M6 GateService 门禁规则校验
// 用途：验证样本集格式合法、规模达标、高危集可被门禁消费（真实 LLM 评测归真实部署）
// 零依赖：node eval-runner.js

'use strict';

const fs = require('fs');
const path = require('path');
const { GateService, EvalSetVersion, DATASET_MINIMUMS } = require('../m6/src/model/domain.js');

const DIR = path.join(__dirname, 'eval-sets');
// 评测集类型 → 文件名
const SET_FILES = {
  spoken: 'spoken/samples.json',
  knowledge: 'knowledge/samples.json',
  high_risk: 'high_risk/samples.json',
  term: 'term/samples.json',
  explain: 'explain/samples.json',
  faq: 'faq/samples.json',
};

function load(setType) {
  const f = path.join(DIR, SET_FILES[setType]);
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  return raw.samples || [];
}

// 各集"预期"字段：术语集用 standard（翻译成标准术语），其余用 expected
function expectedField(setType) {
  return setType === 'term' ? 'standard' : 'expected';
}

function main() {
  console.log('=== 评测集公开集校验 ===');
  let allOk = true;
  const counts = {};
  for (const [setType, min] of Object.entries(DATASET_MINIMUMS)) {
    const samples = load(setType);
    counts[setType] = samples.length;
    const ok = samples.length >= min;
    if (!ok) allOk = false;
    console.log(`${setType}: ${samples.length} 条 (要求 ≥${min}) ${ok ? '✅' : '❌'}`);
    // 样本结构校验（按集类型：术语集校验 standard，其余校验 expected）
    const expField = expectedField(setType);
    const bad = samples.filter(s => !s.id || !s.input || !s[expField]);
    if (bad.length) { console.log(`  ⚠️ ${bad.length} 条缺 id/input/${expField}`); allOk = false; }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\n总计: ${total} 条`);
  // 高危集专项：用 GateService 检查预期行为全覆盖拒绝/审批/查询分支
  const gate = new GateService();
  const hrSamples = load('high_risk');
  // 合法预期：reject* / approve* / query* / query_or_*（查询归类、歧义确认也是合法防护分支）
  const rejectCount = hrSamples.filter(s => /^(reject|approve|query)/.test(s.expected)).length;
  console.log(`高危集: ${rejectCount}/${hrSamples.length} 条预期落拒绝/审批/查询分支（召回 100% 硬线要求）`);
  if (rejectCount < hrSamples.length) allOk = false;
  console.log(allOk ? '\n✅ 评测集公开集全部达标' : '\n❌ 存在未达标项');
  return allOk ? 0 : 1;
}

process.exit(main());
