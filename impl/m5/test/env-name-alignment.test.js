// CommandCode key 名对齐（t000053）：jinteng 10-29 起规范名为 VOYAGE_COMMANDCODE，旧名已判废。
// 脚本若再读旧名，下次轮换会静默沿用旧 key 到 401（只丢流量、不报错）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('CommandCode 已摘除：活动脚本不得再引用其端点或环境变量', () => {
  const dir = path.join(__dirname, '../scripts');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const sources = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  const offenders = files.filter((f) => sources[f].includes('process.env.VOYAGO_COMANDCODE'));
  assert.deepStrictEqual(offenders, [], '旧名 VOYAGO_COMANDCODE 已作废，六处调用点须改读 VOYAGE_COMMANDCODE');
  // 2026-11-22：订阅 2026-11-20 到期（t000054），credits 耗尽 ⇒ 两个免费模型一律 400
  // 「insufficient credits」，团队集 11-21 产出归零 ⇒ 全部活动调用点摘除（同 APInex 处置）。
  // 凭据 VOYAGE_COMMANDCODE 保留在 vault；恢复条件：续费后原样实调（p000056）。
  const consumers = files.filter((f) => sources[f].includes('api.commandcode.ai')
    || sources[f].includes('process.env.VOYAGE_COMMANDCODE'));
  assert.deepStrictEqual(consumers, [], 'CommandCode 已摘除，活动脚本不得再引用其端点或环境变量');
});

test('Coarena 调用点只读规范名 VOYAGE_COARENA，且不出现旧名 VOYAGO_COARENA', () => {
  const dir = path.join(__dirname, '../scripts');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const sources = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  // 旧名不在 jinteng 凭据表中，写错只会在运行期 401/缺 Key 静默跳过。
  const legacy = files.filter((f) => sources[f].includes('VOYAGO_COARENA'));
  assert.deepStrictEqual(legacy, [], '旧名 VOYAGO_COARENA 不存在，须改读 VOYAGE_COARENA');
  const consumers = files.filter((f) => f !== 'coarena-free-models.js'
    && (sources[f].includes('COARENA_BASE_URL') || sources[f].includes('COARENA_FREE_MODELS')));
  assert.ok(consumers.length >= 6, '入口/团队集/评测链均应接入 Coarena');
  const nonCanonical = consumers.filter((f) => !sources[f].includes('process.env.VOYAGE_COARENA'));
  assert.deepStrictEqual(nonCanonical, [], 'Coarena 调用点须读规范名 VOYAGE_COARENA');
});

test('APINEX 已移除：活动脚本不得再引用端点或环境变量', () => {
  const dir = path.join(__dirname, '../scripts');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const sources = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  const offenders = files.filter((f) => sources[f].includes('api.apinex.bond') || sources[f].includes('VOYAGO_APINEX'));
  assert.deepStrictEqual(offenders, [], 'APINEX 已移除，活动脚本不得再引用端点或环境变量');
});
