// 入口协议级 JSON 约束（json_object）：请求形状与逐家启用的边界
// 依据：2026-10-29 生产端点实测——json_object 6/6 家支持；json_schema 仅 4 家支持
//       （commandcode 报 400 要求 additionalProperties 必填、modelscope 报 400 type unavailable）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildProviderList } = require('../scripts/run-ingress.js');

/** 造一份各供应商 Key 齐备的环境（只给 key 名与占位值，不含真实凭据） */
function envWithKeys() {
  const e = {};
  for (const k of ['VOYAGO_COMANDCODE', 'VOYAGO_SENSENOVA', 'VOYAGO_AGNES', 'VOYAGO_CLOUDFLARE', 'VOYAGO_APINEX', 'VOYAGO_MODELSCOPE', 'VOYAGO_OPENROUTER']) {
    e[k] = 'placeholder-key';
  }
  return e;
}

test('JM-I1 入口链：已实测支持且已开启 json_object 的家', () => {
  const saved = { ...process.env };
  Object.assign(process.env, envWithKeys());
  try {
    const list = buildProviderList();
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));
    // 开启的（实测 json_object 200）
    for (const id of ['cloudflare', 'cloudflare-70b', 'openrouter', 'apinex', 'commandcode', 'sensenova', 'modelscope']) {
      assert.ok(byId[id], `${id} 应在入口链`);
    }
    // 未开启的（agens 两种模式都超时——本身慢/不稳，不在链首）
    assert.ok(byId.agens, 'agens 应在入口链（后位兜底）');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('JM-I1b 逐家开关：开了 json_object 的家请求体确实带约束，没开的确实不带', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, envWithKeys());
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    bodies.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({ choices: [{ message: { content: '{"actionClass":"read","capability":"query_status","confidence":0.9}' } }] }) };
  };
  try {
    const list = buildProviderList();
    for (const p of list) await p.interpret('看磁盘');
    const HOST = {
      cloudflare: 'cloudflare.com', 'cloudflare-70b': 'cloudflare.com',
      openrouter: 'openrouter.ai', apinex: 'apinex.bond',
      commandcode: 'commandcode.ai', sensenova: 'sensenova.cn',
      modelscope: 'modelscope.cn', agens: 'agnes-ai.com',
    };
    const bodyOf = (id) => {
      const hit = bodies.find((b) => b.url.includes(HOST[id]));
      return hit ? hit.body : null;
    };
    const EXPECT_ENABLED = ['cloudflare', 'cloudflare-70b', 'openrouter', 'apinex', 'commandcode', 'sensenova', 'modelscope'];
    const EXPECT_DISABLED = ['agens'];
    for (const id of EXPECT_ENABLED) {
      const b = bodyOf(id);
      assert.ok(b, `${id} 应发出过请求`);
      assert.deepStrictEqual(b.response_format, { type: 'json_object' }, `${id} 应带 json_object 约束`);
    }
    for (const id of EXPECT_DISABLED) {
      const b = bodyOf(id);
      assert.ok(b, `${id} 应发出过请求`);
      assert.strictEqual(b.response_format, undefined, `${id} 不应带 json_object 约束`);
    }
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('JM-I2 缺 Key 的家不入选（不因 json_object 改变入链规则）', () => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('VOYAGO_')) delete process.env[k];
  process.env.VOYAGO_CLOUDFLARE = 'placeholder-key';
  try {
    const list = buildProviderList();
    assert.strictEqual(list.length, 2, '只应有 cloudflare 的两个模型（3.1-8b 与 70b）');
    assert.deepStrictEqual(list.map((p) => p.id), ['cloudflare', 'cloudflare-70b']);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('JM-I3 请求体确实带 response_format（经真实适配器 fetch mock 验证）', async () => {
  // 直接验证 openaiCompat 的参数拼装：response_format 必须进 request body 顶层
  const { createAgensAdapter } = require('../src/model/agens-adapter.js');
  let captured = null;
  const adapter = createAgensAdapter({
    apiKey: 'k', model: 'm', endpoint: 'https://x/v1/chat/completions',
    extraParams: { reasoning_effort: 'none', response_format: { type: 'json_object' } },
    fetchImpl: async (u, o) => {
      captured = JSON.parse(o.body);
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({ choices: [{ message: { content: '{"actionClass":"read"}' } }] }) };
    },
  });
  await adapter.interpret('x');
  assert.deepStrictEqual(captured.response_format, { type: 'json_object' }, 'response_format 须在请求体顶层');
  assert.strictEqual(captured.reasoning_effort, 'none', '既有 extraParams 不受影响');
});
