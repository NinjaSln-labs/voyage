// eval-debug.js —— 单条样本调试：打印模型原始输出和 compose 结果
'use strict';
const path = require('node:path');
const { compose } = require('/opt/voyage/impl/m5/src/compose.js');
const { createAgensAdapter } = require('/opt/voyage/impl/m5/src/model/agens-adapter.js');

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
  if (process.env.COMMANDCODE_API_KEY) list.push(openaiCompat('commandcode', 'https://api.commandcode.ai/provider/v1', process.env.COMMANDCODE_API_KEY, 'deepseek/deepseek-v4-flash', t, 3000, { reasoning_effort: 'low' }));
  if (process.env.TEAMOROUTER_API_KEY) list.push(openaiCompat('teamorouter', 'https://api.teamorouter.com/v1', process.env.TEAMOROUTER_API_KEY, 'deepseek-v4-flash', t));
  if (process.env.CLOUDFLARE_API_KEY) list.push(openaiCompat('cloudflare', process.env.CLOUDFLARE_AI_BASEURL || 'https://api.cloudflare.com/client/v4/accounts/ce0cc3d301381e42f02b81fd101e8f87/ai/v1', process.env.CLOUDFLARE_API_KEY, '@cf/meta/llama-3.1-8b-instruct-fp8-fast', t));
  if (process.env.SENSENOVA_API_KEY) list.push(openaiCompat('sensenova', 'https://token.sensenova.cn/v1', process.env.SENSENOVA_API_KEY, 'deepseek-v4-flash', t, 900, { reasoning_effort: 'none' }));
  if (process.env.TOKENROUTER_API_KEY) list.push(openaiCompat('tokenrouter', 'https://api.tokenrouter.com/v1', process.env.TOKENROUTER_API_KEY, 'z-ai/glm-5.3-free', t, 900));
  if (process.env.AGNES_API_KEY) list.push(openaiCompat('agnes', 'https://apihub.agnes-ai.com/v1', process.env.AGNES_API_KEY, 'agnes-2.0-flash', t));
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
      identitySeed: [{ id: 'sre-alice', role: 'sre' }, { id: 'dev-bob', role: 'dev' }],
      assetSeed: [{ id: 'sim-web-1' }],
    },
    exec: { keyVaultPort: { resolve: () => null } },
    model: { provider: 'failover', registry: { failover } },
  });

  const r = await app.handleAsync({ actorId: 'eval-ai', from: 'cli', intent: input, now: new Date() });
  console.error(`\ncompose 返回: ${JSON.stringify(r, null, 2)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
