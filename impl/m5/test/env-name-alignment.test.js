// CommandCode key 名对齐（t000053）：jinteng 10-29 起规范名为 VOYAGE_COMMANDCODE，旧名已判废。
// 脚本若再读旧名，下次轮换会静默沿用旧 key 到 401（只丢流量、不报错）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('CommandCode 调用点只读规范名 VOYAGE_COMMANDCODE', () => {
  const dir = path.join(__dirname, '../scripts');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const offenders = files.filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('process.env.VOYAGO_COMANDCODE'));
  assert.deepStrictEqual(offenders, [], '旧名 VOYAGO_COMANDCODE 已作废，六处调用点须改读 VOYAGE_COMMANDCODE');
  assert.ok(fs.readFileSync(path.join(dir, 'run-ingress.js'), 'utf8').includes('VOYAGE_COMMANDCODE'), '入口链须读规范名');
});
