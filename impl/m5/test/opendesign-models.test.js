// OpenDesign 供应商单一真源锚定（2026-11-22 新增，接替 CommandCode）。
// 背景：CommandCode 订阅 2026-11-20 到期且不续费 ⇒ 改接 opendesign 三个模型
//       （deepseek-v4.1-flash-eco / glm-5.3-flash / minimax-m3.1-flash），凭据取 jinteng 的 NKP_OPENDESIGN。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { OPENDESIGN_BASE_URL, OPENDESIGN_MODELS, OPENDESIGN_PRIMARY } = require('../scripts/opendesign-models.js');

const SCRIPT_DIR = path.join(__dirname, '../scripts');
const scriptFiles = fs.readdirSync(SCRIPT_DIR).filter((f) => f.endsWith('.js'));
const sources = Object.fromEntries(scriptFiles.map((f) => [f, fs.readFileSync(path.join(SCRIPT_DIR, f), 'utf8')]));

test('OD-1 模型单一真源形状正确', () => {
  assert.match(OPENDESIGN_BASE_URL, /^https:\/\/amr-link\.open-design\.ai\/v1$/);
  assert.ok(OPENDESIGN_MODELS.length >= 3, '三个模型须全部登记');
  const ids = new Set();
  for (const m of OPENDESIGN_MODELS) {
    assert.ok(m.id && !ids.has(m.id), `provider id 须唯一：${m.id}`);
    ids.add(m.id);
    assert.match(m.model, /^[a-z0-9.\-]+$/, '模型名须是端点目录里的原样 id');
    // minimax-m3.1-flash 下发 reasoning_effort=none 即 400 upstream_error ⇒ 三家统一不下发。
    assert.strictEqual(m.reasoningEffort, null, 'opendesign 端点不下发 reasoning_effort');
    assert.ok(m.maxTokens >= 900, '推理 token 会吃 max_tokens，须 ≥900');
  }
  assert.strictEqual(OPENDESIGN_PRIMARY.model, OPENDESIGN_MODELS[0].model, '单槽链用的主模型须是列表首个');
});

test('OD-2 三个指定模型均在册且不被改写', () => {
  const models = OPENDESIGN_MODELS.map((m) => m.model);
  for (const want of ['deepseek-v4.1-flash-eco', 'glm-5.3-flash', 'minimax-m3.1-flash']) {
    assert.ok(models.includes(want), `缺模型：${want}`);
  }
});

test('OD-3 调用点统一读单一真源与 jinteng 规范名 NKP_OPENDESIGN', () => {
  const consumers = scriptFiles.filter((f) => f !== 'opendesign-models.js'
    && (sources[f].includes('OPENDESIGN_BASE_URL') || sources[f].includes('OPENDESIGN_MODELS')
      || sources[f].includes('OPENDESIGN_PRIMARY')));
  assert.ok(consumers.length >= 6, '入口/团队集/红队/评测/回放链均应接入 opendesign');
  const hardcoded = consumers.filter((f) => sources[f].includes('amr-link.open-design.ai')
    && !sources[f].includes('OPENDESIGN_BASE_URL'));
  assert.deepStrictEqual(hardcoded, [], '端点常量应来自单一真源');
  const nonCanonical = consumers.filter((f) => !sources[f].includes('process.env.NKP_OPENDESIGN'));
  assert.deepStrictEqual(nonCanonical, [], 'opendesign 调用点须读 jinteng 规范名 NKP_OPENDESIGN');
});

test('OD-4 不得下发 reasoning_effort（minimax 会 400）', () => {
  const consumers = scriptFiles.filter((f) => f !== 'opendesign-models.js'
    && sources[f].includes('OPENDESIGN_'));
  const offenders = consumers.filter((f) => {
    const lines = sources[f].split('\n').filter((l) => l.includes('OPENDESIGN') && !/^\s*(\/\/|\*)/.test(l));
    return lines.some((l) => /reasoning_effort/.test(l));
  });
  assert.deepStrictEqual(offenders, [], 'opendesign 调用点不得下发 reasoning_effort');
});
