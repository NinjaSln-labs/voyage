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

async function llmPersonaIntents(p, providerList, n, avoidHint) {
  const prompt = `你是运维行为模拟器。扮演：${p.profile}。
生成 ${n} 条该角色的中文运维口语意图。
要求：
- 目标资产从这些里选：jd-light、ali-ecs-99、ctyun-x、tencent-lh、oracle-arm-1
- 平台白名单能力：restart/clean(仅限/var/log 日志路径)/scale/config_change/env_switch；查询类随意
- 措辞符合人设且彼此不重复${avoidHint ? `；避免这些已有表述的换皮重复：${avoidHint}` : ''}
只输出 JSON 字符串数组。`;
  for (const prov of providerList) {
    try {
      const res = await fetch(`${prov.ep}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${prov.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: prov.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 1,
          max_tokens: 1500,
        }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const text = data.choices[0].message.content.replace(/```json|```/g, '').trim();
      const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
      if (Array.isArray(arr) && arr.length) return arr.map(x => String(x)).slice(0, n);
    } catch (e) { /* 下一家 */ }
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

async function main() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('simulate-traffic: JWT_SECRET 未注入');
  const port = Number(process.env.PORT || 8787);
  const perPersona = Number(process.argv[2] || 6);

  // 可用 LLM 供应商（生成源；与入口故障转移链同源但独立调用）
  const providers = [];
  if (process.env.COMMANDCODE_API_KEY) providers.push({ ep: 'https://api.commandcode.ai/provider/v1', key: process.env.COMMANDCODE_API_KEY, model: 'deepseek/deepseek-v4-flash' });
  if (process.env.OPENCODE_GO_API_KEY) providers.push({ ep: 'https://opencode.ai/zen/go/v1', key: process.env.OPENCODE_GO_API_KEY, model: 'deepseek-v4-flash' });

  const seen = loadSeen();
  let ok = 0, needReview = 0, degraded = 0, other = 0, dupSkipped = 0;

  for (const persona of PERSONAS) {
    let intents = null;
    if (providers.length) {
      const recent = [...seen].slice(-12);
      intents = await llmPersonaIntents(persona, providers, perPersona, recent.length ? recent.join(' / ').slice(0, 400) : null);
    }
    if (!intents) intents = [...(CORPUS[persona.id] || CORPUS['sre-alice'])].sort(() => Math.random() - 0.5);

    const token = mintToken(persona.id, secret);
    for (const intent of intents) {
      if (seen.has(intent)) { dupSkipped += 1; continue; }
      seen.add(intent);
      const r = await postIntent(port, token, intent);
      if (r.status === 'OK') ok += 1;
      else if (r.status === 'NEED_REVIEW') needReview += 1;
      else other += 1;
      if (r.degraded) degraded += 1;
      await sleep(200 + Math.floor(Math.random() * 900));
    }
  }
  saveSeen(seen);
  const summary = {
    at: new Date().toISOString(), source: providers.length ? 'llm-persona' : 'corpus',
    sent: ok + needReview + other, ok, needReview, degraded, other, dupSkipped,
  };
  console.log('[sim]', JSON.stringify(summary));
  fs.appendFileSync(process.env.SIM_LOG || '/opt/voyage/data/sim.log', JSON.stringify(summary) + '\n');
}

main().catch((e) => { console.error('[sim] failed:', e.message); process.exit(1); });
