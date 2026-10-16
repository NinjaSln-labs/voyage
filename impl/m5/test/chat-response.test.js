// chat-response.js 归因分桶测试——三类失败必须落进三个可数的标签，且供应商原文不丢
// 样本形态取自 618 轮 sim 日志的真实观测（坑 p000056）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { readChatResponse, readContentArray } = require('../scripts/chat-response.js');

// ── 封套层：200 但没有可用 choices ──────────────────────────
test('CR1 200 + choices:null（modelscope/ZhipuAI/GLM-5.2 实测形态）→ body_no_choice(null)，不再抛 TypeError', () => {
  const raw = JSON.stringify({ id: 'chatcmpl-1', model: 'ZhipuAI/GLM-5.2', choices: null, usage: null });
  assert.equal(readChatResponse(raw, true, 200).error, 'body_no_choice(null): ' + raw.replace(/\s+/g, ' ').trim().slice(0, 120));
});

test('CR2 200 + 无 choices 键（openrouter dots 实测形态）→ body_no_choice(missing)', () => {
  const r = readChatResponse(JSON.stringify({ error: { message: 'upstream returned no completion' } }), true, 200);
  assert.equal(r.error, 'body_no_choice(missing): upstream returned no completion');
});

test('CR3 200 + choices:[] → body_no_choice(empty)', () => {
  assert.match(readChatResponse(JSON.stringify({ choices: [] }), true, 200).error, /^body_no_choice\(empty\)/);
});

test('CR4 choices[0] 缺 message → 同归封套层，不落 content 桶', () => {
  assert.match(readChatResponse(JSON.stringify({ choices: [{ index: 0 }] }), true, 200).error, /^body_no_choice/);
});

// ── HTTP 层：状态码 + 供应商自述原因 ──────────────────────────
test('CR5 非 2xx 保留 error.message 原文（apodex 无效 ID 当初就是这样被丢掉的）', () => {
  const raw = JSON.stringify({ error: { message: 'No endpoints found for apodex/apodex-1.1-mini:free.' } });
  assert.equal(readChatResponse(raw, false, 404).error, 'HTTP 404: No endpoints found for apodex/apodex-1.1-mini:free.');
});

test('CR6 非 2xx 且 body 非 JSON → 只记状态码，不崩', () => {
  assert.equal(readChatResponse('<html>502</html>', false, 502).error, 'HTTP 502');
});

// ── 响应体本身不是 JSON ──────────────────────────────────
test('CR7 200 但 body 截断 → body_not_json，与内容层区分开', () => {
  assert.match(readChatResponse('{"choices":[{"message":{"con', true, 200).error, /^body_not_json\(/);
});

// ── 正常路径 ──────────────────────────────────────────────
test('CR8 正常封套取到 content', () => {
  const raw = JSON.stringify({ choices: [{ message: { role: 'assistant', content: '["看下磁盘"]' } }] });
  assert.equal(readChatResponse(raw, true, 200).content, '["看下磁盘"]');
});

test('CR9 content 为 null → 封套可用但内容为空，归 empty_content', () => {
  const r = readChatResponse(JSON.stringify({ choices: [{ message: { content: null } }] }), true, 200);
  assert.equal(r.content, '');
  assert.equal(readContentArray(r.content).error, 'empty_content');
});

// ── 内容层：模型输出不是合法 JSON 数组（618 轮里的多数失败）──
test('CR10 content 被 max_tokens 截断（有开括号无闭括号）→ content_truncated（旧写法记成 exception，看着像网络错）', () => {
  const r = readContentArray('["查下 api-gw 状态","重启 jd-light 的 ngi');
  assert.match(r.error, /^content_truncated: \["查下/);
});

test('CR11 content 吐了两个数组（切片跨到第二个）→ content_bad_json 带原文', () => {
  const r = readContentArray('["a"]\n["b"]');
  assert.match(r.error, /^content_bad_json\(Unexpected non-whitespace character after JSON/);
});

test('CR12 content 用弯引号 → content_bad_json，原文可见便于选型复盘', () => {
  const r = readContentArray('[“ctyun-x 那边好了吗”]');
  assert.match(r.error, /^content_bad_json\(/);
  assert.ok(r.error.includes('ctyun-x'), '应保留原文片段');
});

test('CR13 content 无方括号 → content_no_array', () => {
  assert.match(readContentArray('抱歉，我无法生成').error, /^content_no_array/);
  assert.match(readContentArray('{"input":"重启"}').error, /^content_no_array/);
});

test('CR14 content 是空数组 → content_empty_array', () => {
  assert.equal(readContentArray('[]').error, 'content_empty_array');
});

test('CR15 ```json 围栏照常解析', () => {
  const r = readContentArray('```json\n["看磁盘","清日志"]\n```');
  assert.deepEqual(r.items, ['看磁盘', '清日志']);
});

// ── 分桶互斥性：三类失败不得共用标签 ──────────────────────────
test('CR16 封套层/HTTP 层/内容层三桶标签互不相同，且都不含 exception:', () => {
  const labels = [
    readChatResponse(JSON.stringify({ choices: null }), true, 200).error,
    readChatResponse('{}', false, 429).error,
    readContentArray('["截断').error,
  ];
  assert.equal(new Set(labels).size, 3, labels.join(' | '));
  for (const l of labels) assert.ok(!l.includes('exception:'), l);
});
