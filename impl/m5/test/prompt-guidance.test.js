// 提示词引导契约测试（t000034 / ADR-004 未覆盖项）：查询粒度「大盘/汇总/概况 → 聚合码」
// 目的：防止后续编辑提示词时丢失粒度引导（模型把管理者口语判成 query_status 明细 → ADR-003 拒）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { SYSTEM_PROMPT: AGENS_PROMPT } = require('../src/model/agens-adapter.js');
const { SYSTEM_PROMPT: COHERE_PROMPT } = require('../src/model/cohere-adapter.js');
const { CLASSIFY_SYSTEM_PROMPT } = require('../scripts/gen-redteam-weekly.js');

const PROMPTS = [
  ['agens-adapter', AGENS_PROMPT],
  ['cohere-adapter', COHERE_PROMPT],
  ['gen-redteam-weekly classify', CLASSIFY_SYSTEM_PROMPT],
];

test('PG1 三处提示词均含查询粒度引导（大盘/汇总/概况 → 聚合码）', () => {
  for (const [name, p] of PROMPTS) {
    assert.match(p, /查询粒度/, `${name} 缺查询粒度引导块`);
    assert.match(p, /大盘/, `${name} 缺「大盘」示例词`);
    assert.match(p, /query_metric/, `${name} 缺 query_metric 指向`);
    assert.match(p, /query_health/, `${name} 缺 query_health 指向`);
    assert.match(p, /(只有|仅当)/, `${name} 缺「仅当明确指向具体服务才用 query_status」的收窄说明`);
  }
});

test('PG2 能力码 JSON 示例自洽：聚合示例不含 subject 明细目标且用 read', () => {
  for (const [name, p] of PROMPTS) {
    const m = p.match(/"看下整体大盘"\s*→\s*(\{[^}]*\})/);
    assert.ok(m, `${name} 缺「看下整体大盘」示例`);
    const j = JSON.parse(m[1]);
    assert.strictEqual(j.actionClass, 'read', `${name}: 大盘应归 read`);
    assert.strictEqual(j.capability, 'query_metric', `${name}: 大盘应归 query_metric`);
  }
});

test('PG3 安全规则未被粒度引导覆盖（五条对抗规则仍在）', () => {
  for (const [name, p] of [PROMPTS[0], PROMPTS[1]]) {
    for (const kw of ['base64', '复合意图', '社会工程', '权限试探']) {
      assert.ok(p.includes(kw), `${name} 丢失安全规则关键词：${kw}`);
    }
    assert.match(p, /高于一切/, `${name} 安全规则优先级声明丢失`);
  }
});

test('PG4 粒度引导位于能力清单之后、安全规则之前（不与安全规则冲突）', () => {
  for (const [name, p] of [PROMPTS[0], PROMPTS[1]]) {
    const iCap = p.indexOf('能力（capability）');
    const iScope = p.indexOf('查询粒度');
    const iSec = p.indexOf('⚠️ 安全判定规则');
    assert.ok(iCap < iScope && iScope < iSec, `${name} 粒度引导位置异常（${iCap}/${iScope}/${iSec}）`);
  }
});
