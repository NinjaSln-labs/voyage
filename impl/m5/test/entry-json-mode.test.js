// 入口协议级 JSON 约束（json_object）：请求形状与逐家启用的边界
// 依据：2026-10-29 生产端点实测——json_object 6/6 家支持；json_schema 仅 4 家支持
//       （commandcode 报 400 要求 additionalProperties 必填、modelscope 报 400 type unavailable）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildProviderList } = require('../scripts/run-ingress.js');
const { COARENA_FREE_MODELS } = require('../scripts/coarena-free-models.js');
const { OPENROUTER_FREE_MODELS } = require('../scripts/openrouter-free-models.js');
const { OPENDESIGN_MODELS } = require('../scripts/opendesign-models.js');

/** 造一份各供应商 Key 齐备的环境（只给 key 名与占位值，不含真实凭据） */
function envWithKeys() {
  const e = {};
  for (const k of ['VOYAGE_COMMANDCODE', 'VOYAGE_COARENA', 'NKP_OPENDESIGN', 'VOYAGO_SENSENOVA', 'VOYAGO_AGNES', 'VOYAGO_CLOUDFLARE', 'VOYAGO_MODELSCOPE', 'VOYAGO_OPENROUTER']) {
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
    for (const id of ['cloudflare', 'cloudflare-70b', 'sensenova', 'modelscope']) {
      assert.ok(byId[id], `${id} 应在入口链`);
    }
    for (const m of OPENROUTER_FREE_MODELS) {
      assert.ok(byId[m.id], `${m.id} 应在入口链（OpenRouter 免费池）`);
    }
    for (const id of Object.keys(COARENA_FREE_MODELS)) {
      assert.ok(byId[id], `${id} 应在入口链（仅免费档 3 模型）`);
    }
    for (const m of OPENDESIGN_MODELS) {
      assert.ok(byId[m.id], `${m.id} 应在入口链（opendesign 三模型）`);
    }
    // 2026-11-11 摘除：commandcode 唯一免费模型 beam 免费层结束，glyph 不支持 json_object 且慢
    assert.ok(!byId.commandcode, '入口不应再含 commandcode（beam 免费层已结束）');
    // 2026-11-17 摘除：APInex 免费额度改为单次充值 $5 门槛，三模型全 402
    assert.ok(!byId.apinex, '入口不应再含 apinex（免费额度已改为充值门槛）');
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
      sensenova: 'sensenova.cn',
      modelscope: 'modelscope.cn', agens: 'agnes-ai.com',
    };
    // 三个 Coarena 模型共用同一 host，按请求体 model 区分，不能只按 URL 找。
    const COARENA_MODEL_OF = Object.fromEntries(
      Object.entries(COARENA_FREE_MODELS).map(([id, m]) => [id, m.model]),
    );
    // OpenRouter 两个免费模型共用同一 host，按请求体 model 区分，不能只按 URL 找。
    const MODEL_OF = {
      ...COARENA_MODEL_OF,
      ...Object.fromEntries(OPENROUTER_FREE_MODELS.map((m) => [m.id, m.model])),
      ...Object.fromEntries(OPENDESIGN_MODELS.map((m) => [m.id, m.model])),
    };
    const bodyOf = (id) => {
      if (MODEL_OF[id]) {
        const hit = bodies.find((b) => b.body.model === MODEL_OF[id]);
        return hit ? hit.body : null;
      }
      const hit = bodies.find((b) => b.url.includes(HOST[id]));
      return hit ? hit.body : null;
    };
    const EXPECT_ENABLED = ['cloudflare', 'cloudflare-70b', 'sensenova', 'modelscope',
      ...OPENROUTER_FREE_MODELS.map((m) => m.id),
      ...Object.keys(COARENA_FREE_MODELS)];
    const EXPECT_ENABLED_OD = OPENDESIGN_MODELS.map((m) => m.id);
    const EXPECT_DISABLED = ['agens'];
    for (const id of EXPECT_ENABLED.concat(EXPECT_ENABLED_OD)) {
      const b = bodyOf(id);
      assert.ok(b, `${id} 应发出过请求`);
      assert.deepStrictEqual(b.response_format, { type: 'json_object' }, `${id} 应带 json_object 约束`);
    }
    for (const id of EXPECT_DISABLED) {
      const b = bodyOf(id);
      assert.ok(b, `${id} 应发出过请求`);
      assert.strictEqual(b.response_format, undefined, `${id} 不应带 json_object 约束`);
    }
    for (const [id, m] of Object.entries(COARENA_FREE_MODELS)) {
      assert.strictEqual(bodyOf(id).reasoning_effort, m.reasoningEffort, `${id} 应使用实测可用的 reasoning_effort`);
    }
    for (const m of OPENROUTER_FREE_MODELS) {
      // 2026-11-22：OpenRouter 现役免费端点强制推理，下发 reasoning_effort=none 会被 400 拒。
      assert.strictEqual(bodyOf(m.id).reasoning_effort, undefined, `${m.id} 不应下发 reasoning_effort（强制推理端点）`);
    }
    for (const m of OPENDESIGN_MODELS) {
      // 2026-11-22 实测：minimax-m3.1-flash 下发 reasoning_effort=none 即 400 upstream_error
      // ⇒ opendesign 三家统一不下发 reasoning_effort。
      assert.strictEqual(bodyOf(m.id).reasoning_effort, undefined, `${m.id} 不应下发 reasoning_effort`);
    }
    assert.ok(!bodies.some((b) => b.url.includes('commandcode.ai')), '入口不应再向 commandcode 发请求');
    assert.ok(!bodies.some((b) => b.url.includes('apinex.bond')), '入口不应再向 apinex 发请求');
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('JM-I2 缺 Key 的家不入选（不因 json_object 改变入链规则）', () => {
  const saved = { ...process.env };
  // CommandCode 规范名不属 VOYAGO_ 前缀（t000053），须显式清掉，否则外部环境会漏进本用例
  for (const k of Object.keys(process.env)) if (k.startsWith('VOYAGO_') || k === 'VOYAGE_COMMANDCODE' || k === 'VOYAGE_COARENA' || k === 'NKP_OPENDESIGN') delete process.env[k];
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
