// OpenRouter 免费池单一真源锚定（2026-11-22 免费池换代）。
// 背景：dots-studio/dots-3-note-preview:free 与 cohere/north-mini-code:free 于 2026-11-21 前后
// 上游下架（404「no provider serves this model anymore」），全部调用点须改用新免费模型。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { OPENROUTER_BASE_URL, OPENROUTER_FREE_MODELS, OPENROUTER_PRIMARY } = require('../scripts/openrouter-free-models.js');

const SCRIPT_DIR = path.join(__dirname, '../scripts');
const scriptFiles = fs.readdirSync(SCRIPT_DIR).filter((f) => f.endsWith('.js'));
const sources = Object.fromEntries(scriptFiles.map((f) => [f, fs.readFileSync(path.join(SCRIPT_DIR, f), 'utf8')]));

test('OR-1 免费模型单一真源形状正确', () => {
  assert.match(OPENROUTER_BASE_URL, /^https:\/\/openrouter\.ai\/api\/v1$/);
  assert.ok(OPENROUTER_FREE_MODELS.length >= 1, '至少留一个可调用的免费模型');
  const ids = new Set();
  for (const m of OPENROUTER_FREE_MODELS) {
    assert.ok(m.id && !ids.has(m.id), `provider id 须唯一：${m.id}`);
    ids.add(m.id);
    assert.match(m.model, /:free$/, '只登记免费档模型');
    assert.strictEqual(m.reasoningEffort, null, '现役免费端点强制推理，不下发 reasoning_effort');
    assert.ok(m.maxTokens >= 900, '推理 token 会吃 max_tokens，须 ≥900');
  }
  assert.strictEqual(OPENROUTER_PRIMARY.model, OPENROUTER_FREE_MODELS[0].model, '单槽链用的主模型须是列表首个');
});

test('OR-2 已下架的 OpenRouter 免费模型不得再被引用', () => {
  const dead = ['dots-studio/dots-3-note-preview', 'cohere/north-mini-code', 'apodex-1.1-mini'];
  // 注释里可以记录「哪个模型何时下架」（那是要留证据的地方），但**可执行代码**里不能再出现。
  const codeOf = (f) => sources[f]
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const offenders = scriptFiles.filter((f) => dead.some((d) => codeOf(f).includes(d)));
  assert.deepStrictEqual(offenders, [], '下架模型不得再出现在活动脚本（会整轮白跑）');
});

test('OR-3 OpenRouter 调用点统一读单一真源', () => {
  const consumers = scriptFiles.filter((f) => f !== 'openrouter-free-models.js'
    && (sources[f].includes('OPENROUTER_BASE_URL') || sources[f].includes('OPENROUTER_FREE_MODELS')
      || sources[f].includes('OPENROUTER_PRIMARY')));
  assert.ok(consumers.length >= 6, '入口/团队集/评测链均应接入 OpenRouter 免费真源');
  const hardcoded = consumers.filter((f) => sources[f].includes('openrouter.ai/api/v1')
    && !sources[f].includes('OPENROUTER_BASE_URL'));
  assert.deepStrictEqual(hardcoded, [], '端点常量应来自单一真源');
});
