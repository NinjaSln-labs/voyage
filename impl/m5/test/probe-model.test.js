// 统一探针 probe-model.js 的口径锚定（2026-11-22）。
// 要点是「不许退化成只带提示词的探针」（p000062）——三模式必须在同一脚本里默认全测，
// 且凭据只能从环境变量读、不得进输出（p000065）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PROBE_CASES, MODES, parseArgs, modeParams } = require('../scripts/probe-model.js');

const SCRIPT_DIR = path.join(__dirname, '../scripts');
const source = fs.readFileSync(path.join(SCRIPT_DIR, 'probe-model.js'), 'utf8');

test('PR-1 意图集覆盖三类动作（查询/变更/外传，含凭据外借）', () => {
  const classes = new Set(PROBE_CASES.map((c) => c.actionClass));
  assert.ok(classes.has('read') && classes.has('write') && classes.has('egress'), '三类动作都要有样本');
  assert.ok(PROBE_CASES.some((c) => c.capability === 'cred_lend'), '须含凭据外借样本（安全敏感类）');
  for (const c of PROBE_CASES) {
    assert.ok(c.text && c.actionClass && c.capability, '每条都要有期望标签');
  }
});

test('PR-2 三模式齐备，缺一不可（p000062）', () => {
  assert.deepStrictEqual([...MODES].sort(), ['json_object', 'json_schema', 'prompt_only']);
  assert.deepStrictEqual(modeParams('prompt_only'), {}, 'prompt_only 不带协议约束');
  assert.deepStrictEqual(modeParams('json_object'), { response_format: { type: 'json_object' } });
  const schema = modeParams('json_schema');
  assert.strictEqual(schema.response_format.type, 'json_schema');
  assert.ok(schema.response_format.json_schema.schema.required.length > 0, 'json_schema 必带 required（否则部分端点报 400）');
});

test('PR-3 参数校验：缺 base/model/key-env 即报错', () => {
  assert.throws(() => parseArgs(['--model', 'm', '--key-env', 'K']), /--base/);
  assert.throws(() => parseArgs(['--base', 'b', '--key-env', 'K']), /--model/);
  assert.throws(() => parseArgs(['--base', 'b', '--model', 'm']), /--key-env/);
  assert.throws(() => parseArgs(['--base', 'b', '--model', 'm', '--key-env', 'K', '--modes', 'nope']), /未知模式/);
  const a = parseArgs(['--base', 'b', '--model', 'm', '--key-env', 'K']);
  assert.deepStrictEqual(a.modeList, [...MODES], '默认三模式全测');
});

test('PR-4 探针不得打印凭据明文', () => {
  assert.ok(!/console\.log\([^)]*apiKey/.test(source), '不得把 key 打进输出');
  assert.ok(!/process\.stdout\.write\([^)]*apiKey/.test(source), '不得把 key 打进输出');
  assert.match(source, /process\.env\[args\.keyEnv\]/, 'key 只能从环境变量读');
  assert.match(source, /apiKey 未注入|未注入/, '缺 key 要明确报错而不是静默跳过');
});

test('PR-5 失败必须留响应体原文（p000058：状态码不够用）', () => {
  assert.match(source, /body:/, '失败结果要带响应体');
  assert.match(source, /\.slice\(0, 300\)/, '响应体截断，避免日志爆量');
});
