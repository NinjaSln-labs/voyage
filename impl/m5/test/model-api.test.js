// 供应商无关模型适配器层契约测试（modelApiPort 落地 + Cohere Command Code 厂商）
// 验证：结构化输出解析（fail-closed）、失败语义（降级 confidence=0 走审核，INV-M2）、注册表挂载、
//      Cohere 适配器（HTTP 请求形状/认证头/超时/错误分类）——用 fetch mock 不连真实网络

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createModelApi, INTENT_TYPES, CAPABILITIES, DEFAULT_CONFIDENCE_FLOOR } = require('../src/model/model-api.js');
const { createCohereAdapter, SYSTEM_PROMPT } = require('../src/model/cohere-adapter.js');

// ---------- 结构化输出解析（fail-closed） ----------

test('M1 结构化解析：合法 JSON → 意图/能力/置信度/主体', async () => {
  const fake = { interpret: async () => JSON.stringify({ intentType: 'execute', capability: 'restart', confidence: 0.92, subject: 'svc-api' }) };
  const api = createModelApi({ provider: 'fake', registry: { fake } });
  const r = await api.interpret('重启订单服务');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.intentType, 'execute');
  assert.strictEqual(r.capability, 'restart');
  assert.strictEqual(r.confidence, 0.92);
  assert.strictEqual(r.subject, 'svc-api');
});

test('M2 模型输出非 JSON → 降级（confidence=0 走审核，INV-M2）', async () => {
  const fake = { interpret: async () => '这不是JSON，模型胡言乱语' };
  const api = createModelApi({ provider: 'fake', registry: { fake } });
  const r = await api.interpret('重启服务');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.degraded, true);
  assert.strictEqual(r.confidence, DEFAULT_CONFIDENCE_FLOOR);
  assert.strictEqual(r.reason, 'invalid_json');
});

test('M3 结构非法 fail-closed：intentType 非法/能力不在白名单 → 降级', async () => {
  const api = createModelApi({ provider: 'fake', registry: { fake: { interpret: async () => JSON.stringify({ intentType: 'hack', capability: 'rm-rf', confidence: 0.9 }) } } });
  const r = await api.interpret('x');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_action_class');
  const api2 = createModelApi({ provider: 'fake', registry: { fake: { interpret: async () => JSON.stringify({ intentType: 'execute', capability: 'rm -rf /', confidence: 0.9 }) } } });
  const r2 = await api2.interpret('x');
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'invalid_capability');
});

test('M4 代码块包裹 JSON 兼容 + 置信度非法归一为 0', async () => {
  const fake = { interpret: async () => '```json\n{"intentType":"query","capability":"query_status","confidence":0.8,"subject":null}\n```' };
  const api = createModelApi({ provider: 'fake', registry: { fake } });
  const r = await api.interpret('看看状态');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.intentType, 'query');
  const fake2 = { interpret: async () => JSON.stringify({ intentType: 'query', confidence: '高' }) };
  const api2 = createModelApi({ provider: 'fake2', registry: { fake2 } });
  const r2 = await api2.interpret('x');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.confidence, 0, '置信度非数字 → 0');
});

// ---------- 失败语义 / 降级 ----------

test('M5 厂商抛错（网络/超时）→ 降级 confidence=0（INV-M2），不抛错不静默成功', async () => {
  const fake = { interpret: async () => { throw new Error('network down'); } };
  const api = createModelApi({ provider: 'fake', registry: { fake } });
  const r = await api.interpret('重启服务');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.degraded, true);
  assert.strictEqual(r.reason, 'provider_error');
  assert.strictEqual(r.confidence, 0);
});

test('M6 本地兜底 fallback：厂商断连时用规则引擎兜底', async () => {
  const fake = { interpret: async () => { throw new Error('down'); } };
  const fallback = { interpret: async (t) => ({ intentType: 'query', capability: 'query_status', confidence: 0.5, subject: null }) };
  const api = createModelApi({ provider: 'fake', registry: { fake }, fallback });
  const r = await api.interpret('看看状态');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.intentType, 'query');
  assert.strictEqual(r.confidence, 0.5);
});

test('M7 注册表：供应商未注册 → 构造 fail-fast；provider 必填', () => {
  assert.throws(() => createModelApi({}), /provider 必填/);
  assert.throws(() => createModelApi({ provider: 'nonexistent', registry: {} }), /未注册/);
});

test('M8 输入防护：空/超长输入拒绝（对齐 M2 MAX_INPUT_LENGTH）', async () => {
  const fake = { interpret: async (t) => 'x' };
  const api = createModelApi({ provider: 'fake', registry: { fake } });
  assert.strictEqual((await api.interpret('')).ok, false);
  assert.strictEqual((await api.interpret('x'.repeat(4097))).ok, false);
  assert.strictEqual((await api.interpret(123)).ok, false);
});

// ---------- search 端口 ----------

test('M9 search：厂商实现 → 返回结果；未实现 → 降级空结果', async () => {
  const withSearch = { interpret: async () => '{}', search: async () => [{ text: '片段1' }] };
  const api = createModelApi({ provider: 'a', registry: { a: withSearch } });
  const r = await api.search('如何查日志');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.results, [{ text: '片段1' }]);
  const noSearch = { interpret: async () => '{}' };
  const api2 = createModelApi({ provider: 'b', registry: { b: noSearch } });
  const r2 = await api2.search('x');
  assert.strictEqual(r2.ok, true);
  assert.deepStrictEqual(r2.results, []);
  assert.strictEqual(r2.degraded, true);
});

// ---------- Cohere Command Code 适配器（fetch mock，不连网络） ----------

function cohereFetchMock({ respond = null, failWith = null, status = 200, capture = null } = {}) {
  return async (url, opts) => {
    if (capture) capture(url, opts);
    if (failWith) { const e = new Error(failWith); e.code = failWith; throw e; }
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return '{}'; },
      async json() { return respond || { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ intentType: 'query', confidence: 0.9 }) }] } }; },
    };
  };
}

test('C1 Cohere 适配器：请求形状正确（Bearer 认证 / JSON body / 模型可配置）', async () => {
  let captured = null;
  const adapter = createCohereAdapter({ apiKey: 'test-key-123', model: 'command-code', fetchImpl: cohereFetchMock({ capture: (u, o) => { captured = { u, o }; } }) });
  const text = await adapter.interpret('看看状态');
  assert.ok(text.includes('intentType'), '返回模型文本');
  assert.strictEqual(captured.u, 'https://api.cohere.com/v1/chat');
  assert.strictEqual(captured.o.method, 'POST');
  assert.strictEqual(captured.o.headers.Authorization, 'Bearer test-key-123');
  assert.strictEqual(captured.o.headers['Content-Type'], 'application/json');
  const body = JSON.parse(captured.o.body);
  assert.strictEqual(body.model, 'command-code');
  assert.ok(Array.isArray(body.messages));
  assert.strictEqual(body.messages[0].role, 'system');
  assert.ok(body.messages[0].content.includes('actionClass'), '系统提示引导 JSON');
});

test('C2 Cohere 适配器：401/403 → auth 错误（fail-closed，不静默）', async () => {
  const adapter = createCohereAdapter({ apiKey: 'bad', fetchImpl: cohereFetchMock({ status: 401 }) });
  await assert.rejects(() => adapter.interpret('x'), (e) => e.code === 'cohere_auth');
});

test('C3 Cohere 适配器：网络错误 → 抛错（上层降级）', async () => {
  const adapter = createCohereAdapter({ apiKey: 'k', fetchImpl: cohereFetchMock({ failWith: 'network_down' }) });
  await assert.rejects(() => adapter.interpret('x'));
});

test('C4 Cohere 适配器：apiKey 必填（fail-fast，不落盘）', () => {
  assert.throws(() => createCohereAdapter({}), /apiKey 必填/);
});

test('C5 端到端：Cohere 适配器挂到 model-api 注册表 → 结构化意图（mock）', async () => {
  const cohere = createCohereAdapter({ apiKey: 'k', model: 'command-code', fetchImpl: cohereFetchMock() });
  const api = createModelApi({ provider: 'command-code', registry: { 'command-code': cohere } });
  const r = await api.interpret('看看订单服务状态');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.intentType, 'query');
  assert.strictEqual(r.confidence, 0.9);
});
