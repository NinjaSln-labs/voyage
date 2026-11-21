// Coarena 免费档边界：免费账号只开放 3 个模型，误加付费模型会在运行期 402 并抬高降级。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  COARENA_BASE_URL,
  COARENA_FREE_MODELS,
} = require('../scripts/coarena-free-models.js');

test('CO1 Coarena 免费模型恰好三个且 ID 与实测一致', () => {
  assert.strictEqual(COARENA_BASE_URL, 'https://coarena.ai/api/v1');
  assert.deepStrictEqual(Object.keys(COARENA_FREE_MODELS), [
    'coarena-luna',
    'coarena-deepseek',
    'coarena-gemini',
  ]);
  assert.deepStrictEqual(
    Object.values(COARENA_FREE_MODELS).map((m) => m.model),
    ['gpt-6-luna', 'deepseek-v4-1-flash-1017', 'gemini-3-8-flash'],
  );
});

test('CO2 推理档：gemini 不支持 none，必须 low；其余 none', () => {
  assert.strictEqual(COARENA_FREE_MODELS['coarena-gemini'].reasoningEffort, 'low');
  assert.strictEqual(COARENA_FREE_MODELS['coarena-luna'].reasoningEffort, 'none');
  assert.strictEqual(COARENA_FREE_MODELS['coarena-deepseek'].reasoningEffort, 'none');
});
