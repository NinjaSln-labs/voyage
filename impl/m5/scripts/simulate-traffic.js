// 影子流量模拟器 v2：人格化虚拟角色 × LLM 定向生成 → 覆盖度最大化
// 用法：node simulate-traffic.js [每人条数=6]
// 覆盖维度：①角色人格（节奏/措辞/操作偏好差异）②意图类型全覆盖（查询+五类执行能力）
//          ③措辞多样性（LLM 温度 1 + 滚动去重防换皮重复）
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

/** 生成某角色意图；返回 { intents, source } 或 null（全部供应商失败）。
 * 长提示词（带 avoidHint）易触发推理模型空 content → 失败后自动用短提示词重试一轮。 */
async function llmPersonaIntents(p, providerList, n, avoidHint) {
  const buildPrompt = (withHint) => `你是运维行为模拟器。扮演：${p.profile}。
生成 ${n} 条该角色的中文运维口语意图。
要求：
- 目标资产从这些里选：jd-light、ali-ecs-99、ctyun-x、tencent-lh、oracle-arm-1
- 平台白名单能力：restart/clean(仅限/var/log 日志路径)/scale/config_change/env_switch；查询类随意
- 措辞符合人设且彼此不重复${withHint ? `；避免这些已有表述的换皮重复：${withHint}` : ''}
只输出 JSON 字符串数组。`;
  const attempts = [
    { prompt: buildPrompt(avoidHint ? avoidHint.slice(0, 400) : null), tag: 'full' },
    { prompt: buildPrompt(null), tag: 'short' }, // 推理模型空 content → 短提示词重试
  ];
  for (const attempt of attempts) {
    for (const prov of providerList) {
      try {
        const res = await fetch(`${prov.ep}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${prov.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: prov.model,
            messages: [{ role: 'user', content: attempt.prompt }],
            temperature: 1,
            max_tokens: 1500,
          }),
        });
        if (!res.ok) continue; // 401/限流 → 下一家
        const data = await res.json();
        const text = (data.choices[0].message.content || '').replace(/```json|```/g, '').trim();
        if (!text) continue; // 推理模型空 content → 下一家/下一轮重试
        const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
        if (Array.isArray(arr) && arr.length) return { intents: arr.map(x => String(x)).slice(0, n), source: prov.id };
      } catch (e) { /* 下一家/下一轮重试 */ }
    }
  }
  return null;
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

/** 审批解析（假服务舰队下执行安全——合成后果） */
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

/** AI 用户反馈：执行完成后按上下文生成操作者后续反应（追问/满意确认/新请求），失败回退固定话术 */
const FOLLOWUPS = ['重启完了，帮我看下现在的状态', '好的，再看下日志有没有清干净', '扩容生效了吗？确认一下实例数'];
async function aiFollowup(providers, contextText) {
  if (!providers.length) return null;
  const prompt = `你是运维平台上的一个真实用户。刚才你请求了：${contextText}。平台已执行完成。请用一句自然中文口语给出你的后续反应（可能是确认结果、追问细节、或提出下一个相关请求）。只输出这一句话。`;
  for (const p of providers) {
    try {
      const res = await fetch(`${p.ep}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${p.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: prompt }], temperature: 1, max_tokens: 80 }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const text = (data.choices[0].message.content || '').trim();
      if (text) return text.slice(0, 120);
    } catch (e) { /* 下一家 */ }
  }
  return null;
}

async function main() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('simulate-traffic: JWT_SECRET 未注入');
  const port = Number(process.env.PORT || 8787);
  const perPersona = Number(process.argv[2] || 6);

  // 可用 LLM 供应商（生成源；与入口故障转移链同源对齐：CommandCode→OpenCode→TeamoRouter→Agens 兜底）
  // 注意：OpenCode Key 失效时 401 快速跳过不阻塞兜底（HANDOFF §4 记录待换）
  const providers = [];
  if (process.env.COMMANDCODE_API_KEY) providers.push({ id: 'commandcode', ep: 'https://api.commandcode.ai/provider/v1', key: process.env.COMMANDCODE_API_KEY, model: 'deepseek/deepseek-v4-flash' });
  if (process.env.OPENCODE_GO_API_KEY) providers.push({ id: 'opencode', ep: 'https://opencode.ai/zen/go/v1', key: process.env.OPENCODE_GO_API_KEY, model: 'deepseek-v4-flash' });
  if (process.env.TEAMOROUTER_API_KEY) providers.push({ id: 'teamorouter', ep: 'https://api.teamorouter.com/v1', key: process.env.TEAMOROUTER_API_KEY, model: 'deepseek-v4-flash' });
  if (process.env.AGNES_API_KEY) providers.push({ id: 'agens', ep: 'https://apihub.agnes-ai.com/v1', key: process.env.AGNES_API_KEY, model: 'agnes-2.0-flash' });

  const seen = loadSeen();
  let ok = 0, needReview = 0, resolvedExecuted = 0, execFailed = 0, degraded = 0, other = 0, dupSkipped = 0, feedbacks = 0;

  const gen = {};   // 本轮各生成源（provider id / corpus）实际产出条数——可观测
  let deadlock = 0; // CORPUS 已耗尽且生成失败的角色数（全量停摆告警）
  for (const persona of PERSONAS) {
    let intents = null;
    let genSource = 'corpus';
    if (providers.length) {
      const recent = [...seen].slice(-12);
      const r = await llmPersonaIntents(persona, providers, perPersona, recent.length ? recent.join(' / ') : null);
      if (r) { intents = r.intents; genSource = r.source; }
    }
    if (!intents) {
      // CORPUS 兜底：只取未入 seen 的语料；全部耗尽则大声告警（防静默停摆死锁）
      const unseen = (CORPUS[persona.id] || CORPUS['sre-alice']).filter((x) => !seen.has(x));
      if (!unseen.length) {
        deadlock += 1;
        console.error(`[sim] WARN: 角色 ${persona.id} 生成失败且 CORPUS 已耗尽——本轮零流量（检查模型供应商/Key）`);
        continue;
      }
      intents = unseen.sort(() => Math.random() - 0.5);
    }
    gen[genSource] = (gen[genSource] || 0) + intents.length;

    const token = mintToken(persona.id, secret);
    for (const intent of intents) {
      if (seen.has(intent)) { dupSkipped += 1; continue; }
      seen.add(intent);
      const r = await postIntent(port, token, intent);
      if (r.status === 'NEED_REVIEW' && r.approvalId && !process.env.SIM_NO_RESOLVE) {
        needReview += 1;
        await sleep(1000 + Math.floor(Math.random() * 2000)); // 模拟双人审批间隔
        const votes = ACTORS.filter(a => a !== persona.id).sort(() => Math.random() - 0.5).slice(0, 2);
        const rr = await resolveApproval(port, token, r.approvalId, votes);
        if (rr.status === 'approved') {
          resolvedExecuted += 1;
          if (rr.execution && rr.execution.status !== 'OK') execFailed += 1;
          // AI 用户反馈闭环：30% 概率生成后续反应并注入为新意图
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
    gen, deadlock,
    sent: ok + needReview + other, ok, needReview, resolvedExecuted, execFailed,
    degraded, feedbacks, other, dupSkipped,
  };
  console.log('[sim]', JSON.stringify(summary));
  fs.appendFileSync(process.env.SIM_LOG || '/opt/voyage/data/sim.log', JSON.stringify(summary) + '\n');
}

main().catch((e) => { console.error('[sim] failed:', e.message); process.exit(1); });
