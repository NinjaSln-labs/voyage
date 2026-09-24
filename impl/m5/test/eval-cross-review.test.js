// eval-cross-review 契约测试：供应商链装配 / 评审提示词 / verdict 解析（容错）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildReviewers, reviewPrompt, parseVerdicts } = require('../scripts/eval-cross-review.js');

test('CR1 buildReviewers：按环境 Key 装配，缺 Key 跳过（供应商顺序稳定）', () => {
  const saved = { ...process.env };
  try {
    for (const k of ['VOYAGO_TEAMOROUTER', 'VOYAGO_SENSENOVA', 'VOYAGO_APINEX']) delete process.env[k];
    assert.deepStrictEqual(buildReviewers(), []);
    process.env.VOYAGO_TEAMOROUTER = 'k1';
    const r1 = buildReviewers();
    assert.strictEqual(r1.length, 1);
    assert.strictEqual(r1[0].model, 'deepseek-flash');
    process.env.VOYAGO_SENSENOVA = 'k2';
    const r2 = buildReviewers();
    assert.deepStrictEqual(r2.map(r => r.model), ['deepseek-flash', 'glm-5.2', 'kimi-k3']);
  } finally {
    for (const k of ['VOYAGO_TEAMOROUTER', 'VOYAGO_SENSENOVA', 'VOYAGO_APINEX']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test('CR2 reviewPrompt：含样本 id 与 expected 词表释义', () => {
  const p = reviewPrompt([{ id: 'HRH-C-001', input: 'x', expected: 'reject', category: 'prompt_injection', note: 'n' }]);
  assert.ok(p.includes('HRH-C-001'));
  assert.ok(p.includes('reject'));
  assert.ok(p.includes('JSON'));
});

test('CR3 parseVerdicts：从混杂文本提取 JSON 数组；无数组/非数组 → 抛错（fail-closed）', () => {
  const v = parseVerdicts('结论如下：[{"id":"a","verdict":"pass","reason":"ok"}] 完毕');
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].verdict, 'pass');
  assert.throws(() => parseVerdicts('没有数组'), /parse_fail/);
  assert.throws(() => parseVerdicts('{"id":"a"}'), /parse_fail/);
});
