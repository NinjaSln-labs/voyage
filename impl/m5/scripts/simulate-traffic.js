// 影子流量模拟器：AI 生成多样运维意图 → 虚拟角色池注入入口（影子数据积累）
// 用法（服务器）：node simulate-traffic.js [条数]
// 环境变量：JWT_SECRET / INGRESS_URL(默认 http://127.0.0.1:8787)
//          COMMANDCODE_API_KEY 等（LLM 生成源；失败自动回退内置语料）
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');

const ACTORS = ['sre-alice', 'sre-b', 'sre-c', 'dev-bob'];
const INTENT_COUNT = Number(process.argv[2] || 12);

/** 内置兜底语料（LLM 不可用时保证节奏不断） */
const CORPUS = [
  '看看 jd-light 的状态', 'ali-ecs-99 的磁盘还剩多少', '查一下 ctyun-x 的内存占用',
  '重启 jd-light 的应用服务', '帮我把 tencent-lh 重启一下',
  '清理 jd-light 的 /var/log 旧日志', '把 ali-ecs-99 的 /var/log 清一清',
  'jd-light 扩容到 4 个副本', 'ctyun-x 的服务扩容两个实例',
  '改一下 jd-light 的配置文件', 'tencent-lh 切换到灰度环境',
  '看看所有服务器的健康度', 'oracle-arm-1 的 CPU 是不是爆了',
  '帮我确认 dev 环境的状态', '查看最近的服务告警',
];

function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
function mintToken(actor, secret) {
  const h = b64url({ alg: 'HS256', typ: 'JWT' });
  const p = b64url({ sub: actor, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** LLM 生成多样意图（OpenAI 兼容；按序尝试可用 Key） */
async function llmGenerate(n) {
  const providers = [];
  if (process.env.COMMANDCODE_API_KEY) providers.push({ ep: 'https://api.commandcode.ai/provider/v1', key: process.env.COMMANDCODE_API_KEY, model: 'deepseek/deepseek-v4-flash' });
  if (process.env.OPENCODE_GO_API_KEY) providers.push({ ep: 'https://opencode.ai/zen/go/v1', key: process.env.OPENCODE_GO_API_KEY, model: 'deepseek-v4-flash' });
  if (!providers.length) return null;
  const prompt = `你是运维行为模拟器。生成 ${n} 条中文运维口语意图，要求：
- 混合查询类与执行类（执行类含高危：重启/清理日志/扩容/改配置/切环境）
- 措辞自然多样：有礼貌的、急躁的、新手式的、省略主语的
- 目标资产从这些名字里选：jd-light、ali-ecs-99、ctyun-x、tencent-lh、oracle-arm-1
只输出 JSON 字符串数组，不要其他文字。`;
  for (const p of providers) {
    try {
      const res = await fetch(`${p.ep}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${p.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: p.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 1,
          max_tokens: 1200,
        }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const text = data.choices[0].message.content.replace(/```json|```/g, '').trim();
      const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
      if (Array.isArray(arr) && arr.length) return arr.map(x => String(x)).slice(0, n);
    } catch (e) { /* 尝试下一家 */ }
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

  let intents = await llmGenerate(INTENT_COUNT);
  const source = intents ? 'llm' : 'corpus';
  if (!intents) {
    // 兜底语料洗牌取样
    intents = [...CORPUS].sort(() => Math.random() - 0.5).slice(0, INTENT_COUNT);
  }
  console.log(`[sim] source=${source} count=${intents.length}`);

  let ok = 0, needReview = 0, degraded = 0, other = 0;
  for (const intent of intents) {
    const actor = ACTORS[Math.floor(Math.random() * ACTORS.length)];
    const r = await postIntent(port, mintToken(actor, secret), intent);
    if (r.status === 'OK') ok += 1;
    else if (r.status === 'NEED_REVIEW') needReview += 1;
    else other += 1;
    if (r.degraded) degraded += 1;
    await sleep(300 + Math.floor(Math.random() * 1200)); // 随机间隔模拟真人节奏
  }
  const summary = { at: new Date().toISOString(), source, generated: intents.length, ok, needReview, degraded, other };
  console.log('[sim]', JSON.stringify(summary));
  fs.appendFileSync(process.env.SIM_LOG || '/opt/voyage/data/sim.log', JSON.stringify(summary) + '\n');
}

main().catch((e) => { console.error('[sim] failed:', e.message); process.exit(1); });
