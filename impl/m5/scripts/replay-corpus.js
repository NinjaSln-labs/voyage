// replay-corpus.js —— 离线回放：多语言公开语料过 compose，产出分布/时延/降级统计
// 用法：sudo manual-run.sh replay-corpus.js --corpus <corpus.jsonl> [--per-lang 20] [--seed 20261028] [--out <json>]
// 隔离：审计写 audit-replay-<ts>.jsonl，不污染影子链；不解析审批、不执行作业。
// 依赖：voyage.env 注入的 VOYAGE_* 与 VOYAGE_KEYVAULT_JSON（经 manual-run.sh）。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA = process.env.VOYAGE_DATA_DIR || '/opt/voyage/data';

function rank(id, seed) {
  return crypto.createHash('sha256').update(`${seed}|${id}`).digest('hex');
}

/** 分层抽样：每语言最多 perLang 条，ops 优先（≤60% 配额），其余由 general 补足 */
function sampleCorpus(records, perLang, seed = '20261028') {
  const byLang = new Map();
  for (const r of records) {
    if (!byLang.has(r.lang)) byLang.set(r.lang, []);
    byLang.get(r.lang).push(r);
  }
  const out = [];
  for (const lang of [...byLang.keys()].sort()) {
    const arr = byLang.get(lang);
    const byRank = (a, b) => rank(a.id, seed).localeCompare(rank(b.id, seed));
    const ops = arr.filter((r) => r.domain === 'ops').sort(byRank);
    const gen = arr.filter((r) => r.domain !== 'ops').sort(byRank);
    const picked = [];
    const opsQuota = Math.min(ops.length, Math.ceil(perLang * 0.6));
    picked.push(...ops.slice(0, opsQuota));
    picked.push(...gen.slice(0, perLang - picked.length));
    if (picked.length < perLang) picked.push(...ops.slice(opsQuota, opsQuota + (perLang - picked.length)));
    out.push(...picked.slice(0, perLang));
  }
  return out;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

function aggregate(results) {
  const status = {};
  const kind = {};
  const capability = {};
  const lat = [];
  let degraded = 0;
  let errors = 0;
  let needApproval = 0;
  for (const r of results) {
    const k = r.error ? 'ERROR' : (r.status || 'UNKNOWN');
    status[k] = (status[k] || 0) + 1;
    if (r.kind) kind[r.kind] = (kind[r.kind] || 0) + 1;
    if (r.capability) capability[r.capability] = (capability[r.capability] || 0) + 1;
    if (typeof r.latencyMs === 'number') lat.push(r.latencyMs);
    if (r.degraded === true) degraded += 1;
    if (r.error) errors += 1;
    if (r.needApproval === true) needApproval += 1;
  }
  const processed = results.length - errors;
  return {
    total: results.length,
    processed,
    errors,
    degraded,
    degradedRate: processed ? +(degraded / processed).toFixed(4) : null,
    needApproval,
    p50: percentile(lat, 0.5),
    p95: percentile(lat, 0.95),
    status,
    kind,
    capability,
  };
}

function groupAggregate(results, key) {
  const groups = {};
  for (const r of results) {
    const g = r[key] || 'unknown';
    if (!groups[g]) groups[g] = [];
    groups[g].push(r);
  }
  const out = {};
  for (const [g, arr] of Object.entries(groups).sort()) out[g] = aggregate(arr);
  return out;
}

function openaiCompat(id, baseURL, apiKey, model, timeoutMs, maxTokens, extraParams) {
  const { createAgensAdapter } = require('../src/model/agens-adapter.js');
  const inner = createAgensAdapter({
    apiKey, model,
    endpoint: `${baseURL.replace(/\/$/, '')}/chat/completions`,
    timeoutMs: timeoutMs || 30000,
    ...(maxTokens ? { maxTokens } : {}),
    ...(extraParams ? { extraParams } : {}),
  });
  return { id, interpret: (t, ctx) => inner.interpret(t, ctx), search: () => Promise.resolve([]) };
}

function buildProviderList() {
  const t = 30000;
  const list = [];
  // 与 eval-high-risk-score.js 同源（脚本层沿用各自的链定义；抽公共模块另行处理）
  if (process.env.VOYAGO_COMANDCODE) list.push(openaiCompat('commandcode', 'https://api.commandcode.ai/provider/v1', process.env.VOYAGO_COMANDCODE, 'poolside/laguna-s-2.1-free', t, 2000, { reasoning_effort: 'low' }));
  if (process.env.VOYAGO_CLOUDFLARE) list.push(openaiCompat('cloudflare', process.env.CLOUDFLARE_AI_BASEURL || 'https://api.cloudflare.com/client/v4/accounts/ce0cc3d301381e42f02b81fd101e8f87/ai/v1', process.env.VOYAGO_CLOUDFLARE, '@cf/meta/llama-3.1-8b-instruct-fp8-fast', t));
  if (process.env.VOYAGO_SENSENOVA) list.push(openaiCompat('sensenova', 'https://token.sensenova.cn/v1', process.env.VOYAGO_SENSENOVA, 'deepseek-flash', t, 900, { reasoning_effort: 'none' }));
  if (process.env.VOYAGO_AGNES) list.push(openaiCompat('agnes', 'https://apihub.agnes-ai.com/v1', process.env.VOYAGO_AGNES, 'agnes-3.0-flash', t, 1500, { reasoning_effort: 'none' }));
  if (process.env.VOYAGO_APINEX) list.push(openaiCompat('apinex', 'https://api.apinex.bond/v1', process.env.VOYAGO_APINEX, 'free/deepseek-v4.1-flash', t, 1500, { reasoning_effort: 'none' }));
  if (process.env.VOYAGO_MODELSCOPE) list.push(openaiCompat('modelscope', 'https://api-inference.modelscope.cn/v1', process.env.VOYAGO_MODELSCOPE, 'deepseek-ai/DeepSeek-V4.1-Flash-1017', t, 1500, { reasoning_effort: 'none' }));
  if (process.env.VOYAGO_OPENROUTER) list.push(openaiCompat('openrouter', 'https://openrouter.ai/api/v1', process.env.VOYAGO_OPENROUTER, 'dots-studio/dots-3-note-preview:free', t, 1500, { reasoning_effort: 'none' }));
  return list;
}

function createFailoverModel(providers) {
  const state = { last: null };
  return {
    id: 'failover',
    state,
    async interpret(text, ctx) {
      for (const p of providers) {
        try {
          const r = await p.interpret(text, ctx);
          state.last = p.id;
          return r;
        } catch (e) { /* 试下一家 */ }
      }
      state.last = null;
      throw new Error('all providers failed');
    },
  };
}

function buildApp(providers, auditFile) {
  const { compose } = require('../src/compose.js');
  const keyvaultMap = process.env.VOYAGE_KEYVAULT_JSON ? JSON.parse(process.env.VOYAGE_KEYVAULT_JSON) : {};
  const model = createFailoverModel(providers);
  const app = compose({
    mode: 'real',
    audit: { file: auditFile },
    repo: {
      identityFile: `${DATA}/identity.json`,
      assetFile: `${DATA}/asset.json`,
      identitySeed: [
        { id: 'sre-alice', role: 'sre' }, { id: 'sre-b', role: 'sre' },
        { id: 'sre-c', role: 'sre' }, { id: 'dev-bob', role: 'dev' },
      ],
      assetSeed: [{ id: 'jd-light' }, { id: 'ali-ecs-99' }, { id: 'ctyun-x' },
                  { id: 'tencent-lh' }, { id: 'oracle-arm-1' },
                  { id: 'sim-web-1' }, { id: 'sim-db-1' }, { id: 'sim-cache-1' }, { id: 'sim-queue-1' }],
      ownershipFile: `${DATA}/ownership.json`,
      ownershipSeed: [
        { assetId: 'jd-light', owners: ['sre-alice'] },
        { assetId: 'ali-ecs-99', owners: ['sre-b'] },
        { assetId: 'ctyun-x', owners: ['dev-bob'] },
        { assetId: 'tencent-lh', owners: ['sre-c'] },
        { assetId: 'oracle-arm-1', owners: ['sre-b'] },
        { assetId: 'sim-web-1', owners: ['dev-bob'] },
        { assetId: 'sim-db-1', owners: ['sre-b'] },
        { assetId: 'sim-cache-1', owners: ['sre-alice'] },
        { assetId: 'sim-queue-1', owners: ['sre-c'] },
      ],
    },
    exec: { keyVaultPort: { resolve: (t) => keyvaultMap[t] || null } },
    model: { provider: 'failover', registry: { failover: model } },
  });
  return { app, model };
}

function parseArgs(argv) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  return {
    corpus: arg('--corpus', `${DATA}/offline-replay/corpus.jsonl`),
    perLang: Number(arg('--per-lang', 20)),
    seed: arg('--seed', '20261028'),
    out: arg('--out', `${DATA}/replay-${Date.now()}.json`),
  };
}

async function main() {
  const { corpus, perLang, seed, out } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(corpus)) { console.error(`错误：找不到语料 ${corpus}`); process.exit(1); }
  const records = fs.readFileSync(corpus, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const sample = sampleCorpus(records, perLang, seed);
  console.log(`语料 ${records.length} 条；抽样 ${sample.length} 条（每语言 ≤${perLang}，ops 优先）`);

  const providers = buildProviderList();
  if (!providers.length) { console.error('错误：未配置任何模型供应商 Key'); process.exit(1); }
  const auditFile = `${DATA}/audit-replay-${Date.now()}.jsonl`;
  const { app, model } = buildApp(providers, auditFile);
  console.log(`模型链: ${providers.map((p) => p.id).join(' → ')}`);
  console.log(`审计隔离: ${auditFile}`);

  const results = [];
  for (let i = 0; i < sample.length; i++) {
    const rec = sample[i];
    const t0 = Date.now();
    try {
      const r = await app.handleAsync({ actorId: 'sre-alice', from: 'cli', intent: rec.input, now: new Date() });
      results.push({
        id: rec.id, lang: rec.lang, domain: rec.domain, source: rec.source,
        status: r.status, kind: r.kind || null, capability: r.capability || null,
        needApproval: !!r.needApproval, degraded: !!r.degraded, reason: r.reason || null,
        confidence: typeof r.confidence === 'number' ? r.confidence : null,
        provider: model.state.last, latencyMs: Date.now() - t0,
      });
    } catch (e) {
      results.push({ id: rec.id, lang: rec.lang, domain: rec.domain, source: rec.source, error: e.message, latencyMs: Date.now() - t0 });
    }
    if ((i + 1) % 10 === 0 || i + 1 === sample.length) {
      console.log(`  [${i + 1}/${sample.length}] ${rec.lang} ${rec.id} → ${results[results.length - 1].status || 'ERROR'}`);
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    corpus, seed, perLang,
    corpusTotal: records.length,
    sampled: sample.length,
    modelChain: providers.map((p) => p.id),
    aggregate: aggregate(results),
    byLang: groupAggregate(results, 'lang'),
    byDomain: groupAggregate(results, 'domain'),
    results,
  };
  fs.writeFileSync(out, JSON.stringify(payload, null, 1));
  console.log(`\n=== 汇总 ===`);
  console.log(JSON.stringify(payload.aggregate, null, 1));
  console.log(`\n=== 按语言 ===`);
  for (const [lang, a] of Object.entries(payload.byLang)) {
    console.log(`  ${lang}: n=${a.total} 降级=${a.degradedRate} p50=${a.p50}ms p95=${a.p95}ms`);
  }
  console.log(`\n输出: ${out}`);
}

module.exports = { sampleCorpus, aggregate, groupAggregate, percentile };

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
