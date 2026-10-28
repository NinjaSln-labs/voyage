// replay-corpus.js 纯函数测试：分层抽样、聚合口径（不联网、不依赖 compose）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { sampleCorpus, aggregate, groupAggregate } = require('../scripts/replay-corpus.js');

function rec(id, lang, domain) {
  return { id, lang, domain, source: 'test', license: 'CC-BY-SA-4.0', input: `q-${id}` };
}

test('抽样：每语言上限、确定性、ops 优先', () => {
  const corpus = [];
  for (let i = 0; i < 10; i++) corpus.push(rec(`en-ops-${i}`, 'en', 'ops'));
  for (let i = 0; i < 10; i++) corpus.push(rec(`en-gen-${i}`, 'en', 'general'));
  for (let i = 0; i < 5; i++) corpus.push(rec(`ko-gen-${i}`, 'ko', 'general'));

  const a = sampleCorpus(corpus, 6, 'seed-1');
  const b = sampleCorpus(corpus, 6, 'seed-1');
  assert.deepStrictEqual(a.map((x) => x.id), b.map((x) => x.id), '同 seed 结果稳定');
  const en = a.filter((x) => x.lang === 'en');
  const ko = a.filter((x) => x.lang === 'ko');
  assert.strictEqual(en.length, 6);
  assert.strictEqual(ko.length, 5);
  assert.strictEqual(en.filter((x) => x.domain === 'ops').length, 4, 'ops 配额 = ceil(6*0.6)');
  assert.strictEqual(en.filter((x) => x.domain === 'general').length, 2);
});

test('聚合：状态/降级/时延/错误', () => {
  const results = [
    { status: 'OK', degraded: false, latencyMs: 100 },
    { status: 'OK', degraded: true, latencyMs: 200 },
    { status: 'NEED_REVIEW', needApproval: true, degraded: false, latencyMs: 300 },
    { status: 'REJECTED', degraded: false, latencyMs: 400 },
    { error: 'all providers failed', latencyMs: 500 },
  ];
  const a = aggregate(results);
  assert.strictEqual(a.total, 5);
  assert.strictEqual(a.processed, 4);
  assert.strictEqual(a.errors, 1);
  assert.strictEqual(a.degraded, 1);
  assert.strictEqual(a.degradedRate, 0.25, '1/4 已处理请求降级');
  assert.strictEqual(a.needApproval, 1);
  assert.strictEqual(a.p50, 300);
  assert.strictEqual(a.p95, 500);
  assert.deepStrictEqual(a.status, { OK: 2, NEED_REVIEW: 1, REJECTED: 1, ERROR: 1 });
});

test('按语言分组', () => {
  const results = [
    { lang: 'en', status: 'OK', latencyMs: 10 },
    { lang: 'en', status: 'OK', latencyMs: 20 },
    { lang: 'zh', status: 'REJECTED', latencyMs: 30 },
  ];
  const g = groupAggregate(results, 'lang');
  assert.strictEqual(g.en.total, 2);
  assert.strictEqual(g.zh.total, 1);
  assert.strictEqual(g.zh.status.REJECTED, 1);
});
