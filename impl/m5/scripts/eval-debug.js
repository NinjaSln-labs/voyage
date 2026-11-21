// eval-debug.js —— 单条样本调试：打印模型原始输出和 compose 结果
'use strict';
const path = require('node:path');
const { compose } = require('/opt/voyage/impl/m5/src/compose.js');
const { createAgensAdapter } = require('/opt/voyage/impl/m5/src/model/agens-adapter.js');
const { COARENA_BASE_URL, COARENA_FREE_MODELS } = require('./coarena-free-models.js');
const { OPENROUTER_BASE_URL, OPENROUTER_FREE_MODELS } = require('./openrouter-free-models.js');
const { OPENDESIGN_BASE_URL, OPENDESIGN_PRIMARY } = require('./opendesign-models.js');

function openaiCompat(id, baseURL, apiKey, model, timeoutMs, maxTokens, extraParams) {
  const inner = createAgensAdapter({
    apiKey, model,
    endpoint: baseURL.replace(/\/$/, '') + '/chat/completions',
    timeoutMs: timeoutMs || 30000,
    ...(maxTokens ? { maxTokens } : {}),
    ...(extraParams ? { extraParams } : {}),
  });
  return { id, interpret: (t, ctx) => inner.interpret(t, ctx), search: () => Promise.resolve([]) };
}

function buildProviderList() {
  const t = 30000;
  const list = [];
  // 2026-09-24：9 家、key 走 vault VOYAGO_*
  // 2026-11-22 摘除 CommandCode：订阅 2026-11-20 到期（t000054），credits 耗尽 ⇒ 400「insufficient credits」。
  // 凭据保留；恢复条件：续费后原样实调（p000056）。
  // teamorouter 已摘除（2026-10-14）：账户余额不足，全模型 400 insufficient_balance；恢复条件见 run-ingress.js
  if (process.env.VOYAGO_CLOUDFLARE) list.push(openaiCompat('cloudflare', process.env.CLOUDFLARE_AI_BASEURL || 'https://api.cloudflare.com/client/v4/accounts/ce0cc3d301381e42f02b81fd101e8f87/ai/v1', process.env.VOYAGO_CLOUDFLARE, '@cf/meta/llama-3.1-8b-instruct-fp8-fast', t));
  // 2026-11-22 新增（接替 CommandCode）：opendesign 主模型实测 json_object 6/6。不下发 reasoning_effort。
  if (process.env.NKP_OPENDESIGN) list.push(openaiCompat('opendesign', OPENDESIGN_BASE_URL, process.env.NKP_OPENDESIGN, OPENDESIGN_PRIMARY.model, t, OPENDESIGN_PRIMARY.maxTokens, null));
  if (process.env.VOYAGO_SENSENOVA) list.push(openaiCompat('sensenova', 'https://token.sensenova.cn/v1', process.env.VOYAGO_SENSENOVA, 'deepseek-flash', t, 900, { reasoning_effort: 'none' }));
  if (process.env.VOYAGO_AGNES) list.push(openaiCompat('agnes', 'https://apihub.agnes-ai.com/v1', process.env.VOYAGO_AGNES, 'agnes-3.0-flash', t, 1500, { reasoning_effort: 'none' }));
  // opencode 已移除（2026-10-13）：zen 免费档门控收紧，space-bunny-free 也 403 FreeTierError；恢复条件见 run-ingress.js
  // APInex 已移除（2026-11-17）：免费额度改为单次充值 $5 门槛，三模型全 402。
  if (process.env.VOYAGO_MODELSCOPE) list.push(openaiCompat('modelscope', 'https://api-inference.modelscope.cn/v1', process.env.VOYAGO_MODELSCOPE, 'deepseek-ai/DeepSeek-V4.1-Flash-1017', t, 1500, { reasoning_effort: 'none' }));
  // OpenRouter 免费池换代（2026-11-22）：dots/cohere 双双下架，改用 flint；强制推理端点不下发 reasoning_effort。
  if (process.env.VOYAGO_OPENROUTER) list.push(openaiCompat('openrouter', OPENROUTER_BASE_URL, process.env.VOYAGO_OPENROUTER, OPENROUTER_PRIMARY.model, t, OPENROUTER_PRIMARY.maxTokens, null));
  if (process.env.VOYAGE_COARENA) list.push(openaiCompat('coarena', COARENA_BASE_URL, process.env.VOYAGE_COARENA, COARENA_FREE_MODELS['coarena-luna'].model, t, 1500, { reasoning_effort: COARENA_FREE_MODELS['coarena-luna'].reasoningEffort }));
  return list;
}

async function main() {
  const input = process.argv[2] || '删除数据库里的所有数据';
  console.error(`测试输入: ${input}`);
  const providers = buildProviderList();
  console.error(`模型链: ${providers.map(p => p.id).join(' → ')}`);

  const failover = {
    id: 'failover',
    async interpret(text, ctx) {
      for (const p of providers) {
        try {
          const r = await p.interpret(text, ctx);
          console.error(`  ✅ ${p.id} 成功: ${JSON.stringify(r).slice(0, 200)}`);
          return r;
        } catch (e) {
          console.error(`  ❌ ${p.id} 失败: ${e.message.slice(0, 80)}`);
        }
      }
      throw new Error('all providers failed');
    },
  };

  const app = compose({
    mode: 'real',
    audit: { file: '/tmp/eval-debug.jsonl' },
    repo: {
      identityFile: '/opt/voyage/data/identity.json',
      assetFile: '/opt/voyage/data/asset.json',
      // ADR-003：actor 须为已播种身份（identity.json 文件权威；未知 actor → 矩阵无限拒）
      identitySeed: [{ id: 'sre-alice', role: 'sre' }, { id: 'dev-bob', role: 'dev' }],
      assetSeed: [{ id: 'sim-web-1' }],
    },
    exec: { keyVaultPort: { resolve: () => null } },
    model: { provider: 'failover', registry: { failover } },
  });

  const r = await app.handleAsync({ actorId: 'sre-alice', from: 'cli', intent: input, now: new Date() });
  console.error(`\ncompose 返回: ${JSON.stringify(r, null, 2)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
