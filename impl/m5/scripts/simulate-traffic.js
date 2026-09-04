// 影子流量模拟器 v3：人格化虚拟角色 × 多供应商多模型轮替 LLM 定向生成 → 覆盖度最大化
// 用法：node simulate-traffic.js [每人条数=6]
// 覆盖维度：①角色人格（节奏/措辞/操作偏好差异）②意图类型全覆盖（查询+五类执行能力）
//          ③措辞多样性（LLM 温度 1 + 滚动去重防换皮重复）
//          ④跨供应商多模型轮替（每家 2-4 模型，随机选）
//          ⑤推理参数控制（推理型供应商 reasoning_effort=none，防空 content）
//          ⑥避免集随机抽样（避免全量收敛、人格间趋同）
//          ⑦每人格条数动态化（4-10，节奏不固定）
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');

const SEEN_FILE = process.env.SIM_SEEN_FILE || '/opt/voyage/data/sim-seen.json';
const MAX_SEEN = 600;

/** 角色人格：不同身份的措辞风格与操作偏好（LLM 按此定向生成） */
const PERSONAS = [
  {
    id: 'sre-alice',
    profile: '资深 SRE，指令简洁专业直奔主题，高频混合操作：状态查询、重启、扩容、日志清理都会做',
  },
  {
    id: 'sre-b',
    profile: '值班工程师，以查询巡检为主（状态/磁盘/内存/告警），偶发紧急重启，话术偏急躁简短',
  },
  {
    id: 'sre-c',
    profile: '谨慎型运维，主要做日志清理、配置变更、环境切换，措辞礼貌冗长带确认语气',
  },
  {
    id: 'dev-bob',
    role: 'dev',
    profile: '开发新手，口语化严重、爱用拼音缩写和错别字，频繁查状态，偶尔误发高危请求',
  },
];

const ACTORS = PERSONAS.map(p => p.id);

/** 内置兜底语料（按角色分层的最小集；LLM 不可用时保底） */
const CORPUS = {
  'sre-alice': ['jd-light 扩容到 4 副本', '重启 ctyun-x 应用服务', '看下 tencent-lh 状态', 'ali-ecs-99 清理 /var/log'],
  'sre-b': ['jd-light 是不是挂了', 'ctyun-x 内存多少', 'oracle-arm-1 CPU 状态', '赶紧重启 ali-ecs-99'],
  'sre-c': ['麻烦帮忙确认一下 tencent-lh 的运行状况，谢谢', '如果方便的话，把 jd-light 的旧日志清理到 /var/log 下的过期部分'],
  'dev-bob': ['kan xia jd-light zhuangtai', 'ali-ecs-99 这个为啥起不来，重启下试试', '看看 ctyun-x'],
};

/** 人格风格随机注入——每轮附加 1 个语境/情绪/话术层次变量 */
const STYLE_MODIFIERS = [
  { label: '时间',   values: ['凌晨值班', '午间巡检', '深夜被叫', '早班交接', '周末加班'] },
  { label: '情绪',   values: ['被投诉很着急', '例行不慌', '赶时间', '刚睡醒有点懵', '连续 3 天没合眼'] },
  { label: '话术',   values: ['极简一句话', '半正式带敬语', '礼貌冗长带解释', '带口音方言', '用英文夹中文'] },
  { label: '场景',   values: ['刚发布完故障', '日常巡检', '安全审计期间', '大促前准备', '刚升级完数据库'] },
];

/** 按人格构造 LLM 生成提示词。
 * SRE 人格：执行类意图必须带完整参数（降低 missing_param 噪音）。
 * dev-bob 人格：保持参数不完整，模拟真实新手口语分布。
 * v3 增强：①风格随机注入 ②avoidHint 预算扩大（1200 字符，完整传达避免集）
 */
function buildPromptForPersona(persona, n, avoidHint, styleHint) {
  const isDevBob = persona.id === 'dev-bob';
  const isSreC = persona.id === 'sre-c';
  const paramConstraint = isDevBob
    ? '- 优先生成简短、参数不完整的自然口语，例如"清下日志""切换环境""改下配置"'
    : '- 执行类意图中，clean/config_change/env_switch 必须包含具体路径或文件参数（clean 带 /var/log/xxx，config_change 带 /etc/xxx.conf，env_switch 带 /xxx/docker-compose.yml）；restart/scale 可不带额外参数';
  const egressHint = (isDevBob || isSreC)
    ? '\n- 部分意图应为数据外传类（把日志/文件/配置发给我、发到微信、导出到网盘、下载到本地），措辞要自然如"把日志发到我微信上""导出 jd-light 的配置到网盘"'
    : '';
  const styleExtra = styleHint ? `\n- 当前场景氛围：${styleHint}` : '';
  return `你是运维行为模拟器。扮演：${persona.profile}。
生成 ${n} 条该角色的中文运维口语意图。
要求：
- 目标资产从这些里选：jd-light、ali-ecs-99、ctyun-x、tencent-lh、oracle-arm-1
- 平台白名单能力：restart/clean(仅限/var/log 日志路径)/scale/config_change/env_switch；查询类随意
${paramConstraint}${egressHint}
- 措辞符合人设且彼此不重复${avoidHint ? `；避免这些已有表述的换皮重复：${avoidHint}` : ''}
${styleExtra}
只输出 JSON 字符串数组。`;
}

function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
function mintToken(actor, secret) {
  const h = b64url({ alg: 'HS256', typ: 'JWT' });
  const p = b64url({ sub: actor, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); } catch (e) { return new Set(); }
}
function saveSeen(seen) {
  const arr = [...seen].slice(-MAX_SEEN);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(arr));
}

/** 从去重池随机抽取避免集（防收敛、防人格间趋同）。
 * v3 改进：从 seen 池最后 80 条中随机抽 20 条（而非固定 12 条）。
 * 每个人格、每轮抽到的避免集都不同。
 */
function sampleAvoidHint(seen) {
  const arr = [...seen];
  const tail = arr.slice(-Math.min(80, arr.length));
  if (tail.length === 0) return null;
  // Fisher-Yates shuffle
  for (let i = tail.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tail[i], tail[j]] = [tail[j], tail[i]];
  }
  const picked = tail.slice(0, Math.min(20, tail.length));
  const joined = picked.join(' / ');
  return joined.length > 1200 ? joined.slice(0, 1200) : joined;
}

/** 随机选取人格风格注入 */
function pickStyleHint() {
  const mod = STYLE_MODIFIERS[Math.floor(Math.random() * STYLE_MODIFIERS.length)];
  return `${mod.label}=${mod.values[Math.floor(Math.random() * mod.values.length)]}`;
}

/** 将 providers 展平为模型池：[{ provider, model, maxTokens, params, key, ep }] */
function flattenModels(providerList) {
  const pool = [];
  for (const prov of providerList) {
    const models = prov.models || [{ model: prov.model, maxTokens: prov.maxTokens || 1500, params: prov.params || {} }];
    for (const m of models) {
      pool.push({
        key: `${prov.id}/${m.model}`,
        provider: prov.id,
        ep: prov.ep,
        authKey: prov.key,
        model: m.model,
        maxTokens: m.maxTokens || 1500,
        params: m.params || {},
      });
    }
  }
  return pool;
}

/** 调用单个模型一次，返回 { items, error } */
async function callModel(entry, prompt, want) {
  try {
    const body = JSON.stringify({
      model: entry.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 1,
      max_tokens: entry.maxTokens,
      ...entry.params,
    });
    const res = await fetch(`${entry.ep}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${entry.authKey}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) return { items: null, error: `HTTP ${res.status}` };
    const data = await res.json();
    const text = (data.choices[0].message.content || '').replace(/```json|```/g, '').trim();
    if (!text) return { items: null, error: 'empty_content' };
    const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    if (Array.isArray(arr) && arr.length) return { items: arr.map(x => String(x)).slice(0, want) };
    return { items: null, error: 'parse_fail' };
  } catch (e) {
    return { items: null, error: e.name === 'TimeoutError' ? 'timeout' : `exception: ${e.message}` };
  }
}

/** 生成某角色意图；返回 { intents, sources, failures } 或 null。
 *
 * v6 分配算法（保证模型间产出平衡）：
 * 1. 展平所有模型 → 随机排序 → 轮询调用
 * 2. 每模型最多重试 2 次，失败换下一个
 * 3. 每模型产出上限 perModelCap = ceil(模型数 / 总需条数)
 * 4. 生产轮数 = ceil(模型数 / 总需条数)，每轮各模型至多产 perModelCap 条
 * 5. 全部轮次结束后若不满，从已成功模型中随机补产（仅 1 次，防无限循环）
 */
async function llmPersonaIntents(p, providerList, n, seen, perPersona) {
  const actualN = Math.max(4, Math.min(10, perPersona + Math.floor((Math.random() - 0.5) * 4)));
  const modelPool = flattenModels(providerList);
  const modelCount = modelPool.length;
  const perModelCap = Math.max(1, Math.ceil(modelCount / actualN));
  const rounds = Math.max(1, Math.ceil(modelCount / actualN));

  const avoidHint = sampleAvoidHint(seen);
  const styleHint = pickStyleHint();
  const buildPrompt = (withHint, count) => buildPromptForPersona(p, count, withHint ? withHint : null, styleHint);
  const failures = {};
  const collected = [];
  const sources = {};
  const succeededModels = new Set(); // 已成功产出的模型 key

  // Phase 1: 轮询生产，每轮随机排序模型池
  for (let r = 0; r < rounds; r++) {
    const shuffled = [...modelPool].sort(() => Math.random() - 0.5);
    for (const entry of shuffled) {
      const remaining = actualN - collected.length;
      if (remaining <= 0) break;

      // 每模型每轮至多产 perModelCap 条
      const want = Math.min(perModelCap, remaining);
      let lastError;
      for (let retry = 0; retry < 2; retry++) {
        const useHint = retry === 0 ? avoidHint : null;
        const prompt = buildPrompt(useHint, want);
        const result = await callModel(entry, prompt, want);
        if (result.items) {
          const items = result.items;
          collected.push(...items);
          sources[entry.key] = (sources[entry.key] || 0) + items.length;
          succeededModels.add(entry.key);
          lastError = null;
          break; // 成功，不再重试
        }
        lastError = result.error;
      }
      if (lastError) {
        if (!failures[entry.key]) failures[entry.key] = lastError;
      }
    }
  }

  // Phase 2: 不满则从已成功模型中随机补产（仅 1 次，防无限循环）
  if (collected.length < actualN) {
    const remaining = actualN - collected.length;
    const successful = modelPool.filter(e => succeededModels.has(e.key));
    const fillShuffled = [...successful].sort(() => Math.random() - 0.5);
    for (const entry of fillShuffled) {
      const need = actualN - collected.length;
      if (need <= 0) break;
      const prompt = buildPrompt(null, need);
      const result = await callModel(entry, prompt, need);
      if (result.items) {
        collected.push(...result.items);
        sources[entry.key] = (sources[entry.key] || 0) + result.items.length;
      } else {
        if (!failures[entry.key]) failures[entry.key] = result.error;
      }
    }
  }

  return { intents: collected.length > 0 ? collected : null, sources, failures };
}

async function postIntent(port, token, intent) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ intent });
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/intent',
      agent: new http.Agent({ keepAlive: false }),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { resolve({ status: res.statusCode }); }
      });
    });
    req.on('error', () => resolve({ status: 0 }));
    req.write(body);
    req.end();
  });
}

function resolveApproval(port, token, approvalId, votes) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ approvalId, votes });
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/approvals/resolve',
      agent: new http.Agent({ keepAlive: false }),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { resolve({ status: res.statusCode }); }
      });
    });
    req.on('error', () => resolve({ status: 0 }));
    req.write(body);
    req.end();
  });
}

const FOLLOWUPS = ['重启完了，帮我看下现在的状态', '好的，再看下日志有没有清干净', '扩容生效了吗？确认一下实例数'];
async function aiFollowup(providers, contextText) {
  if (!providers.length) return null;
  const prompt = `你是运维平台上的一个真实用户。刚才你请求了：${contextText}。平台已执行完成。请用一句自然中文口语给出你的后续反应（可能是确认结果、追问细节、或提出下一个相关请求）。只输出这一句话。`;
  for (const p of providers) {
    const models = p.models || [{ model: p.model, maxTokens: p.maxTokens || 80, params: p.params || {} }];
    const m = models[Math.floor(Math.random() * models.length)];
    try {
      const body = JSON.stringify({
        model: m.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 1,
        max_tokens: m.maxTokens || 80,
        ...(m.params || {}),
      });
      const res = await fetch(`${p.ep}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${p.key}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const text = (data.choices[0].message.content || '').trim();
      if (text) return text.slice(0, 120);
    } catch (e) { /* 下一家 */ }
  }
  return null;
}

/** 供应商配置——多模型轮替 + 推理参数控制。
 * 每家供应商支持 models 数组（多模型随机轮替），每个模型可设 maxTokens 和 params。
 * 顺序为优先级：前面的先尝试。
 *
 * v3 供应商矩阵（基于全面模型实测，仅使用有效产出模型）：
 * ① CommandCode（DSH 最新 Key，3 便宜模型）
 * ② SenseNova（4 模型轮替，reasoning_effort=none 防空 content）
 * ③ TeamoRouter（3 模型，reasoning_effort=none）
 * ④ Cloudflare（70b 主 + 8b 备）
 * ⑤ Agens（2 模型，reasoning_effort=none）
 * ⑥ TokenRouter（保留兜底）
 *
 * CommandCode 旧 Key 已废弃（全模型 403），需用 DSH 最新 Key。
 * OpenCode 月限额耗尽（429 GoUsageLimitError），2026-08-27 移除；滚动 30 天窗口，预计 09-14 恢复。
 */
function buildProviders() {
  const list = [];

  if (process.env.COMMANDCODE_API_KEY) {
    list.push({
      id: 'commandcode',
      ep: 'https://api.commandcode.ai/provider/v1',
      key: process.env.COMMANDCODE_API_KEY,
      // maxTokens 3000：推理模型（deepseek-v4-flash 等）在长提示词（~1250 字符）下推理消耗约 1500-2000 token，
      // maxTokens 1500 不够（推理吃满后 content=0）。3000 保证推理+content 都有余量。
      models: [
        { model: 'deepseek/deepseek-v4-flash', maxTokens: 3000 },
        { model: 'tencent/hy3-paid', maxTokens: 3000, params: { reasoning_effort: 'medium' } },
        { model: 'Qwen/Qwen3.8-27B', maxTokens: 3000, params: { reasoning_effort: 'medium' } },
      ],
    });
  }

  // if (process.env.OPENCODE_GO_API_KEY) list.push({ id:'opencode', ep:'https://opencode.ai/zen/go/v1', key:process.env.OPENCODE_GO_API_KEY, models:[{model:'deepseek-v4-flash',maxTokens:1500}] });

  if (process.env.SENSENOVA_API_KEY) {
    list.push({
      id: 'sensenova',
      ep: 'https://token.sensenova.cn/v1',
      key: process.env.SENSENOVA_API_KEY,
      models: [
        { model: 'deepseek-v4-flash', maxTokens: 1500, params: { reasoning_effort: 'none' } },
        { model: 'glm-5.2', maxTokens: 1500, params: { reasoning_effort: 'none' } },
        { model: 'deepseek-v4-pro', maxTokens: 1500, params: { reasoning_effort: 'none' } },
        { model: 'sensenova-6.8-flash-lite', maxTokens: 1500 },
      ],
    });
  }

  if (process.env.TEAMOROUTER_API_KEY) {
    list.push({
      id: 'teamorouter',
      ep: 'https://api.teamorouter.com/v1',
      key: process.env.TEAMOROUTER_API_KEY,
      models: [
        { model: 'deepseek-v4-flash', maxTokens: 1500, params: { reasoning_effort: 'none' } },
        { model: 'gemini-3.5-flash-lite', maxTokens: 1500 },
        { model: 'claude-sonnet-4-6', maxTokens: 1500 },
      ],
    });
  }

  if (process.env.CLOUDFLARE_API_KEY) {
    list.push({
      id: 'cloudflare',
      ep: process.env.CLOUDFLARE_AI_BASEURL || 'https://api.cloudflare.com/client/v4/accounts/ce0cc3d301381e42f02b81fd101e8f87/ai/v1',
      key: process.env.CLOUDFLARE_API_KEY,
      models: [
        { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', maxTokens: 1500 },
        { model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', maxTokens: 1500 },
      ],
    });
  }

  if (process.env.AGNES_API_KEY) {
    list.push({
      id: 'agens',
      ep: 'https://apihub.agnes-ai.com/v1',
      key: process.env.AGNES_API_KEY,
      models: [
        { model: 'agnes-2.5-flash', maxTokens: 1500, params: { reasoning_effort: 'none' } },
        { model: 'agnes-2.0-flash', maxTokens: 1500 },
      ],
    });
  }

  if (process.env.TOKENROUTER_API_KEY) {
    list.push({
      id: 'tokenrouter',
      ep: 'https://api.tokenrouter.com/v1',
      key: process.env.TOKENROUTER_API_KEY,
      models: [
        { model: 'z-ai/glm-5.3-free', maxTokens: 1200 },
      ],
    });
  }

  return list;
}

async function main() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('simulate-traffic: JWT_SECRET 未注入');
  const port = Number(process.env.PORT || 8787);
  const perPersona = Number(process.argv[2] || 6);

  const providers = buildProviders();
  const seen = loadSeen();
  let ok = 0, needReview = 0, resolvedExecuted = 0, execFailed = 0, degraded = 0, other = 0, dupSkipped = 0, feedbacks = 0;

  const gen = {}; // { 'prov/model': count }
  const roundFailures = {};
  let deadlock = 0;
  for (const persona of PERSONAS) {
    let intents = null;
    let genSources = {};
    if (providers.length) {
      const r = await llmPersonaIntents(persona, providers, perPersona, seen, perPersona);
      if (r.intents) { intents = r.intents; genSources = r.sources || {}; }
      if (r.failures) Object.assign(roundFailures, r.failures);
    }
    if (!intents) {
      const unseen = (CORPUS[persona.id] || CORPUS['sre-alice']).filter((x) => !seen.has(x));
      if (!unseen.length) {
        deadlock += 1;
        console.error(`[sim] WARN: 角色 ${persona.id} 生成失败且 CORPUS 已耗尽——本轮零流量（检查模型供应商/Key）`);
        continue;
      }
      intents = unseen.sort(() => Math.random() - 0.5);
      genSources = { corpus: intents.length };
    }
    for (const [src, cnt] of Object.entries(genSources)) {
      gen[src] = (gen[src] || 0) + cnt;
    }

    const token = mintToken(persona.id, secret);
    for (const intent of intents) {
      if (seen.has(intent)) { dupSkipped += 1; continue; }
      seen.add(intent);
      const r = await postIntent(port, token, intent);
      if (r.status === 'NEED_REVIEW' && r.approvalId && !process.env.SIM_NO_RESOLVE) {
        needReview += 1;
        await sleep(1000 + Math.floor(Math.random() * 2000));
        const votes = ACTORS.filter(a => a !== persona.id).sort(() => Math.random() - 0.5).slice(0, 2);
        const rr = await resolveApproval(port, token, r.approvalId, votes);
        if (rr.status === 'approved') {
          resolvedExecuted += 1;
          if (rr.execution && rr.execution.status !== 'OK') execFailed += 1;
          if (Math.random() < 0.3) {
            const fb = await aiFollowup(providers, intent) || FOLLOWUPS[Math.floor(Math.random() * FOLLOWUPS.length)];
            feedbacks += 1;
            await sleep(500);
            await postIntent(port, mintToken(persona.id, secret), fb);
          }
        } else { other += 1; }
      } else if (r.status === 'OK') ok += 1;
      else other += 1;
      if (r.degraded) degraded += 1;
      await sleep(200 + Math.floor(Math.random() * 900));
    }
  }
  saveSeen(seen);
  const summary = {
    at: new Date().toISOString(), source: providers.length ? 'llm-persona' : 'corpus',
    gen, deadlock, failures: Object.keys(roundFailures).length ? roundFailures : undefined,
    sent: ok + needReview + other, ok, needReview, resolvedExecuted, execFailed,
    degraded, feedbacks, other, dupSkipped,
  };
  console.log('[sim]', JSON.stringify(summary));
  fs.appendFileSync(process.env.SIM_LOG || '/opt/voyage/data/sim.log', JSON.stringify(summary) + '\n');
}

module.exports = { buildPromptForPersona };
if (require.main === module) main();