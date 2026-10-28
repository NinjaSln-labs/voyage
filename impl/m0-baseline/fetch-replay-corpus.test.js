// 离线回放语料抓取器：纯映射/去重函数测试（不联网）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { seRecord, cmrcRecords, oasstRecord, massiveRecord, dollyRecord, drcdRecords, glaiveRecord, dedupe, htmlUnescape } = require('./scripts/fetch-replay-corpus.js');

test('SE 映射：保留语言/来源链接/许可证/tags，标题 HTML 实体解码', () => {
  const r = seRecord({ question_id: 42, title: ' nginx 502 after upgrade ', link: 'https://stackoverflow.com/q/42', tags: ['nginx'] }, 'en', 'stackoverflow');
  assert.strictEqual(r.id, 'se-stackoverflow-42');
  assert.strictEqual(r.lang, 'en');
  assert.strictEqual(r.domain, 'ops');
  assert.strictEqual(r.license, 'CC-BY-SA-4.0');
  assert.strictEqual(r.sourceUrl, 'https://stackoverflow.com/q/42');
  assert.deepStrictEqual(r.tags, ['nginx']);
  assert.strictEqual(r.input, 'nginx 502 after upgrade');
  assert.strictEqual(htmlUnescape('&#191;C&#243;mo &amp; &quot;x&quot;?'), '¿Cómo & "x"?');
});

test('CMRC 映射：支持 squad-style 嵌套、空问题过滤、截断上限', () => {
  const recs = cmrcRecords({ data: [
    { paragraphs: [
      { qas: [{ id: 'q1', question: '如何查看磁盘使用率？' }, { id: 'q2', question: '   ' }] },
      { qas: [{ id: 'q3', question: '怎样重启服务？' }] },
    ] },
  ] }, 2);
  assert.strictEqual(recs.length, 2);
  assert.strictEqual(recs[0].lang, 'zh');
  assert.strictEqual(recs[0].domain, 'general');
  assert.strictEqual(recs[0].input, '如何查看磁盘使用率？');
  assert.strictEqual(recs[1].id, 'cmrc-q3', '空问题被过滤后再截断');
});

test('OASST 映射：许可为 Apache-2.0', () => {
  const r = oasstRecord({ message_id: 'm1', lang: 'de', text: 'Wie starte ich nginx neu?' });
  assert.strictEqual(r.id, 'oasst-m1');
  assert.strictEqual(r.lang, 'de');
  assert.strictEqual(r.license, 'Apache-2.0');
});

test('MASSIVE 映射：CC-BY-4.0、带上 scenario/intent', () => {
  const r = massiveRecord({ id: '7', locale: 'ko-KR', scenario: 'alarm', intent: 'alarm_set', utt: ' 내일 아침 7시에 깨워줘 ' }, 'ko');
  assert.strictEqual(r.id, 'massive-ko-KR-7');
  assert.strictEqual(r.lang, 'ko');
  assert.strictEqual(r.license, 'CC-BY-4.0');
  assert.deepStrictEqual(r.tags, ['alarm', 'alarm_set']);
  assert.strictEqual(r.input, '내일 아침 7시에 깨워줘');
});

test('Dolly 映射：CC-BY-SA-3.0', () => {
  const r = dollyRecord({ instruction: ' How do I restart nginx? ', category: 'open_qa' }, 0);
  assert.strictEqual(r.lang, 'en');
  assert.strictEqual(r.license, 'CC-BY-SA-3.0');
  assert.strictEqual(r.input, 'How do I restart nginx?');
  assert.deepStrictEqual(r.tags, ['open_qa']);
});

test('DRCD 映射：展开 paragraphs[].qas[]', () => {
  const recs = drcdRecords({ paragraphs: [
    { qas: [{ id: 'q1', question: '如何查看磁盘？' }] },
    { qas: [{ id: 'q2', question: '怎样重启服务？' }] },
  ] });
  assert.strictEqual(recs.length, 2);
  assert.strictEqual(recs[0].lang, 'zh');
  assert.strictEqual(recs[0].license, 'CC-BY-3.0');
  assert.strictEqual(recs[1].id, 'drcd-q2');
});

test('Glaive 映射：取首条 USER 文本，domain=tools', () => {
  const r = glaiveRecord({ chat: 'USER: 帮我查下上海天气\n\nASSISTANT: 好的 <|endoftext|>' }, 0);
  assert.strictEqual(r.input, '帮我查下上海天气');
  assert.strictEqual(r.domain, 'tools');
  assert.strictEqual(r.license, 'Apache-2.0');
  assert.strictEqual(glaiveRecord({ chat: 'ASSISTANT: no user' }, 1), null);
});

test('去重：同语言同正文只保留首次', () => {
  const a = { lang: 'en', input: 'restart nginx' };
  const b = { lang: 'en', input: 'restart nginx' };
  const c = { lang: 'zh', input: 'restart nginx' };
  assert.deepStrictEqual(dedupe([a, b, c]), [a, c]);
});
