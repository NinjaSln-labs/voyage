// 供应商模型统一探针（2026-11-22 立项，根治 p000062／p000058／p000065／p000067）。
//
// 为什么要有它：此前选型探针是一次性临时脚本，四条坑反复复发——
//   p000062 只带提示词测 ⇒ 把「不支持 json_object」的模型误判成「不可用」；
//   p000058 只打 /models ⇒ 该端点免鉴权时 200 不代表 Key 有效；
//   p000065 从 shell 旧环境变量取值 ⇒ 把「key 已轮换」误判成「轮换失败」；
//   p000067 5~7 次小样本撞限流窗口 ⇒ 把「限流」误判成「模型慢/不可用」。
// 本脚本把四条口径固化：**凭据只从环境变量读**（由 jinteng 注入，脚本不落盘、不打印）、
// **三模式必测**（prompt_only／json_object／json_schema）、**每模式跑满一组真实意图**、
// **失败一律打印响应体原文**（不只记状态码）。
//
// 用法（凭据经 jinteng 注入，禁止把 key 写进命令行或脚本）：
//   jinteng run -e NKP_OPENDESIGN=<name> -- node impl/m5/scripts/probe-model.js \
//     --base https://amr-link.open-design.ai/v1 --model deepseek-v4.1-flash-eco \
//     --key-env NKP_OPENDESIGN --modes prompt_only,json_object --n 6
//
// 判读口径（照此读输出，勿自行加戏）：
//   1. 目录在册 ≠ 可调用（p000056／p000073）：必须看本脚本的真实调用结果。
//   2. 单次失败不判死（p000067）：看 sim.log 该模型 gen 段是否归零 + 多轮长周期分布。
//   3. 三模式差异要分开记：某模式全 400 而另两模式通过 = 该模式不支持，不是模型死。
//   4. 400/402/403 先分「参数错」与「账号/权益」两路（p000055／p000058），别混着猜。
'use strict';

const path = require('node:path');
const { createAgensAdapter } = require(path.join(__dirname, '../src/model/agens-adapter.js'));
const { parseStructured } = require(path.join(__dirname, '../src/model/model-api.js'));

// 入口真实运维意图集（含高危/外传/凭据外借三类，见入口系统提示词）。
const PROBE_CASES = Object.freeze([
  Object.freeze({ text: '看下整体大盘', actionClass: 'read', capability: 'query_metric' }),
  Object.freeze({ text: '重启服务器', actionClass: 'write', capability: 'restart' }),
  Object.freeze({ text: '把日志发到我微信上', actionClass: 'egress', capability: 'egress_send' }),
  Object.freeze({ text: '看下 jd-light 状态', actionClass: 'read', capability: 'query_status' }),
  Object.freeze({ text: '账号借我用一下', actionClass: 'egress', capability: 'cred_lend' }),
  Object.freeze({ text: '把服务器上的日志清空', actionClass: 'write', capability: 'clean' }),
]);

const MODES = Object.freeze(['prompt_only', 'json_object', 'json_schema']);

function parseArgs(argv) {
  const args = { base: '', model: '', keyEnv: '', modes: 'prompt_only,json_object,json_schema', n: PROBE_CASES.length, timeoutMs: 30000, maxTokens: 1500, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i] || '';
    else if (a === '--model') args.model = argv[++i] || '';
    else if (a === '--key-env') args.keyEnv = argv[++i] || '';
    else if (a === '--modes') args.modes = argv[++i] || '';
    else if (a === '--n') args.n = Number(argv[++i]);
    else if (a === '--timeout') args.timeoutMs = Number(argv[++i]);
    else if (a === '--max-tokens') args.maxTokens = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else throw new Error(`probe-model: 未知参数 ${a}`);
  }
  if (!args.base) throw new Error('probe-model: 缺 --base');
  if (!args.model) throw new Error('probe-model: 缺 --model');
  if (!args.keyEnv) throw new Error('probe-model: 缺 --key-env（凭据只从环境变量读）');
  args.modeList = String(args.modes).split(',').map((s) => s.trim()).filter(Boolean);
  for (const m of args.modeList) {
    if (!MODES.includes(m)) throw new Error(`probe-model: 未知模式 ${m}（可选 ${MODES.join('/')}）`);
  }
  if (!Number.isInteger(args.n) || args.n < 1) throw new Error('probe-model: --n 须为正整数');
  return args;
}

/** 模式 → 请求体附加参数（json_schema 用最小 schema，只验「端点认不认」）。 */
function modeParams(mode) {
  if (mode === 'json_object') return { response_format: { type: 'json_object' } };
  if (mode === 'json_schema') {
    return {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'intent',
          schema: {
            type: 'object',
            properties: {
              actionClass: { type: 'string' },
              capability: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['actionClass', 'capability', 'confidence'],
            additionalProperties: false,
          },
        },
      },
    };
  }
  return {};
}

async function probeOne(adapter, text) {
  const t0 = Date.now();
  try {
    const raw = await adapter.interpret(text, {});
    return { ok: true, raw, ms: Date.now() - t0 };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: String((e && e.message) || e).slice(0, 160),
      body: String((e && e.body) || '').slice(0, 300),
      status: (e && typeof e.status === 'number') ? e.status : null,
    };
  }
}

async function probeMode({ apiKey, base, model, mode, cases, timeoutMs, maxTokens }) {
  const adapter = createAgensAdapter({
    apiKey,
    model,
    endpoint: `${base.replace(/\/$/, '')}/chat/completions`,
    timeoutMs,
    maxTokens,
    extraParams: modeParams(mode),
  });
  const times = [];
  let parsed = 0;
  let correct = 0;
  const details = [];
  for (const c of cases) {
    const r = await probeOne(adapter, c.text);
    times.push(r.ms);
    if (!r.ok) {
      details.push({ text: c.text, ok: false, error: r.error, body: r.body, status: r.status, ms: r.ms });
      continue;
    }
    const p = parseStructured(r.raw);
    if (p.ok) parsed += 1;
    const hit = p.ok && p.value.actionClass === c.actionClass && p.value.capability === c.capability;
    if (hit) correct += 1;
    details.push({
      text: c.text,
      ok: true,
      parsed: p.ok,
      got: p.ok ? `${p.value.actionClass}/${p.value.capability}` : `PARSE_FAIL:${p.reason}`,
      hit,
      ms: r.ms,
    });
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    mode,
    total: cases.length,
    parsed,
    correct,
    p50: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    max: sorted.length ? sorted[sorted.length - 1] : null,
    details,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env[args.keyEnv];
  if (!apiKey) {
    throw new Error(`probe-model: 环境变量 ${args.keyEnv} 未注入（凭据经 jinteng run 注入，勿写进命令行）`);
  }
  const cases = PROBE_CASES.slice(0, Math.min(args.n, PROBE_CASES.length));
  const results = [];
  for (const mode of args.modeList) {
    results.push(await probeMode({
      apiKey, base: args.base, model: args.model, mode, cases,
      timeoutMs: args.timeoutMs, maxTokens: args.maxTokens,
    }));
  }
  const summary = {
    base: args.base,
    model: args.model,
    keyEnv: args.keyEnv,
    at: new Date().toISOString(),
    results,
    verdict: results.map((r) => `${r.mode}:${r.correct}/${r.total}`).join(' '),
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    for (const r of results) {
      process.stdout.write(`\n${args.model} [${r.mode}] 解析 ${r.parsed}/${r.total} 分类正确 ${r.correct}/${r.total} p50 ${r.p50}ms max ${r.max}ms\n`);
      for (const d of r.details) {
        process.stdout.write(`   ${d.ok ? `${d.got}${d.hit ? ' ✓' : ' ✗'}` : `ERR ${d.error}${d.body ? ` | ${d.body}` : ''}`} ${d.ms}ms\n`);
      }
    }
  }
}

module.exports = { PROBE_CASES, MODES, parseArgs, modeParams, probeMode };

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`${(e && e.message) || e}\n`);
    process.exit(1);
  });
}
