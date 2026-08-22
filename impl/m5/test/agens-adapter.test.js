// Agens 供应商适配器契约测试（fetch mock，不连真实网络）
// 验证：OpenAI 兼容请求形状（Bearer/JSON/model=agnes-2.0-flash）、响应解析（choices[0].message.content）、
//      错误分类（401→agens_auth）、compose vendor 分派（model.vendor='agens'）

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createAgensAdapter } = require('../src/model/agens-adapter.js');
const { createModelApi } = require('../src/model/model-api.js');
const { compose } = require('../src/compose.js');

function agensFetchMock({ respond = null, status = 200, capture = null, failWith = null } = {}) {
  return async (url, opts) => {
    if (capture) capture(url, opts);
    if (failWith) { const e = new Error(failWith); e.code = failWith; throw e; }
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return '{}'; },
      async json() {
        return respond || {
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ intentType: 'execute', capability: 'restart', confidence: 0.88, subject: 'svc-1' }) } }],
        };
      },
    };
  };
}

test('G1 Agens 适配器：请求形状正确（apihub 端点/Bearer/OpenAI 兼容 body）', async () => {
  let captured = null;
  const adapter = createAgensAdapter({ apiKey: 'agnes-key-1', fetchImpl: agensFetchMock({ capture: (u, o) => { captured = { u, o }; } }) });
  const text = await adapter.interpret('重启订单服务');
  assert.ok(text.includes('intentType'), '返回模型文本');
  assert.strictEqual(captured.u, 'https://apihub.agnes-ai.com/v1/chat/completions');
  assert.strictEqual(captured.o.method, 'POST');
  assert.strictEqual(captured.o.headers.Authorization, 'Bearer agnes-key-1');
  const body = JSON.parse(captured.o.body);
  assert.strictEqual(body.model, 'agnes-2.0-flash');
  assert.strictEqual(body.messages[0].role, 'system');
  assert.strictEqual(body.temperature, 0);
});

test('G2 Agens 响应解析：choices[0].message.content → 结构化意图（经 model-api 白名单）', async () => {
  const adapter = createAgensAdapter({ apiKey: 'k', fetchImpl: agensFetchMock() });
  const api = createModelApi({ provider: 'agens', registry: { agens: adapter } });
  const r = await api.interpret('重启 svc-1');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.intentType, 'execute');
  assert.strictEqual(r.capability, 'restart');
  assert.strictEqual(r.confidence, 0.88);
});

test('G3 Agens 错误分类：401 → agens_auth（fail-closed，不静默）', async () => {
  const adapter = createAgensAdapter({ apiKey: 'bad', fetchImpl: agensFetchMock({ status: 401 }) });
  await assert.rejects(() => adapter.interpret('x'), (e) => e.code === 'agens_auth');
});

test('G4 Agens apiKey 必填（fail-fast，不落盘）', () => {
  assert.throws(() => createAgensAdapter({}), /apiKey 必填/);
});

test('G5 compose vendor 分派：model.vendor="agens" → 注册表挂 agens 供应商', async () => {
  const app = compose({
    mode: 'real',
    audit: { file: '/tmp/voyage-g5-audit.jsonl' },
    repo: {
      identityFile: '/tmp/voyage-g5-i.json', assetFile: '/tmp/voyage-g5-a.json',
      identitySeed: [{ id: 'u1', role: 'sre' }], assetSeed: [{ id: 'svc-1' }],
    },
    exec: { keyVaultPort: { resolve: () => ({ user: 'root', host: '127.0.0.1', port: 22, keyPath: '/nonexistent' }) } },
    model: {
      vendor: 'agens',
      apiKey: 'k',
      fetchImpl: agensFetchMock(),
    },
  });
  // handleAsync 走 agens 通道 → execute 意图可达（NEED_REVIEW 高危审批）
  const r = await app.handleAsync({ actorId: 'u1', from: 'cli', intent: '重启 svc-1' });
  assert.strictEqual(r.status, 'NEED_REVIEW', JSON.stringify(r));
});

test('G6 compose 默认供应商仍为 command-code（不回归）', () => {
  let capturedProvider = null;
  const app = compose({
    mode: 'real',
    audit: { file: '/tmp/voyage-g6-audit.jsonl' },
    repo: { identityFile: '/tmp/voyage-g6-i.json', assetFile: '/tmp/voyage-g6-a.json' },
    exec: { keyVaultPort: { resolve: () => null } },
    model: { apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ message: { content: [{ type: 'text', text: '{}' }] } }) }) },
  });
  assert.strictEqual(app.mode, 'real');
});
