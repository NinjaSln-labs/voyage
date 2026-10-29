// 内测入口启动脚本（oracle-arm-1 部署形态）——配合 DEPLOY-oracle-arm-1.md
// 环境变量（systemd EnvironmentFile 注入，600 权限）：
//   AGNES_API_KEY / JWT_SECRET        必填，凭据经注入不落代码
//   VOYAGE_AUDIT_FILE                 审计 JSONL 路径（默认 /opt/voyage/data/audit.jsonl）
//   VOYAGE_KEYVAULT_JSON              可选；{target: {user,host,port,keyPath}} 连接信息镜像（手抄口径同 e2e-real）
//   VOYAGE_INTENT_ONLY=1              影子运行模式：高危审批单只建不批（冒烟/观察期用）
//   VOYAGE_MTLS=1                     启动 mTLS 终结层（端口 8443，需 /opt/voyage/data/mtls/ 下证书齐全）
//   VOYAGE_MTLS_PORT                  mTLS 监听端口（默认 8443）
//   VOYAGE_WEBAUTHN_RPID / _ORIGIN    通行密钥验签域名与前端来源（同时配置才启用真实验签，缺库即启动失败）
//   VOYAGE_WEBAUTHN_CREDENTIALS       注册凭据镜像 JSON（默认 /opt/voyage/data/webauthn-credentials.json）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { compose } = require('../src/compose.js');
const { createAuthAdapter } = require('../src/auth/auth-adapter.js');
const { createCrlMirror } = require('../src/auth/crl-mirror.js');
const { createWebAuthnVerifier } = require('../src/auth/webauthn-verifier.js');
const { createHttpIngress } = require('../src/server/http-ingress.js');
const { createMtlsTerminator } = require('../src/server/mtls-terminator.js');

const DATA = process.env.VOYAGE_DATA_DIR || '/opt/voyage/data';

/** OpenAI 兼容 chat 供应商适配（agens-adapter 同款协议形状：POST {model,messages} → choices[0].message.content）
 *  endpoint 传 baseURL——此处补全 /chat/completions（适配器消费完整端点）
 *  maxTokens：推理型供应商需 ≥900（300 会被 reasoning 截断 JSON，HANDOFF §4 已知坑）；
 *  非推理模型缺省 300 不变。
 *  extraParams：额外请求参数（如 { reasoning_effort: 'low' }），透传到适配器。 */
function openaiCompat(id, baseURL, apiKey, model, timeoutMs, maxTokens, extraParams) {
  const { createAgensAdapter } = require('../src/model/agens-adapter.js');
  const inner = createAgensAdapter({ apiKey, model, endpoint: `${baseURL.replace(/\/$/, '')}/chat/completions`, timeoutMs, ...(maxTokens ? { maxTokens } : {}), ...(extraParams ? { extraParams } : {}) });
  return { id, interpret: (t, ctx) => inner.interpret(t, ctx), search: () => Promise.resolve([]) };
}

/** 按环境变量组装可用供应商列表（缺 Key 的自动跳过）。
 * 2026-09-24：供应商扩至 9 家；key 统一走 vault 单一真源（~/.vault/keys/services/llm-providers/env）的 VOYAGO_* 前缀。
 * 单模型/家（故障转移链，按序尝试）；团队模型集见 simulate-traffic.js / gen-redteam-weekly.js 的 models 数组。 */
function buildProviderList() {
  const timeoutMs = Number(process.env.VOYAGE_MODEL_TIMEOUT_MS || 30000);
  const list = [];
  if (process.env.VOYAGO_COMANDCODE) {
    // 2026-10-13 模型集补位：stealth/space-bunny-alpha 已下架（403 "free stealth preview has ended"）、
    // inclusionai/ling-3.0-flash-sante:free 已转付费（404，上游给替代 slug ling-3.0-flash-sante）。
    // 入口单模型取 Laguna S 2.1（沿用 09-24 选 alpha 的同一标准：实测快 p50 ~2.6s、JSON 干净、
    // 推理 0 token）；glyph-cluster 分类同样准但 reasoning ~300 token 致 p90 48s，会撞 30s 超时，只入团队集。
    list.push(openaiCompat('commandcode', 'https://api.commandcode.ai/provider/v1', process.env.VOYAGO_COMANDCODE, 'poolside/laguna-s-2.1-free', timeoutMs, 2000, { reasoning_effort: 'low' }));
  }
  // teamorouter 已摘除（2026-10-14）：账户余额不足，全模型 400 insufficient_balance（-free 后缀不含额度）
  if (process.env.VOYAGO_SENSENOVA) {
    // deepseek-flash = DeepSeek V4.1 Flash（sensenova 平台 deepseek-v4.1-flash 不在 token plan，403；deepseek-flash 实测 200）
    // reasoning_effort=none 关闭推理（实测 reasoning_tokens=0），maxTokens 900 足够 JSON 输出
    list.push(openaiCompat('sensenova', 'https://token.sensenova.cn/v1', process.env.VOYAGO_SENSENOVA, 'deepseek-flash', timeoutMs, 900, { reasoning_effort: 'none' }));
  }
  if (process.env.VOYAGO_AGNES) {
    list.push(openaiCompat('agens', 'https://apihub.agnes-ai.com/v1', process.env.VOYAGO_AGNES, 'agnes-3.0-flash', timeoutMs, 1500, { reasoning_effort: 'none' }));
  }
  if (process.env.VOYAGO_CLOUDFLARE) {
    // Workers AI OpenAI 兼容端点（account id 在端点路径内）；模型用非推理 llama-3.1-8b（qwen3 系 reasoning 吃光 max_tokens 返回空 content，实测弃用）
    const cfBase = process.env.CLOUDFLARE_AI_BASEURL || 'https://api.cloudflare.com/client/v4/accounts/ce0cc3d301381e42f02b81fd101e8f87/ai/v1';
    list.push(openaiCompat('cloudflare', cfBase, process.env.VOYAGO_CLOUDFLARE, '@cf/meta/llama-3.1-8b-instruct-fp8-fast', timeoutMs));
  }
  // opencode 已移除（2026-10-13）：zen 免费档门控收紧，唯一豁免 space-bunny-free 也返回 403
  // FreeTierError（"only be used from within OpenCode"），伪装官方客户端 UA 无效。
  // 恢复条件：第三方服务器可调用时，端点 https://opencode.ai/zen/v1，maxTokens 1500。
  if (process.env.VOYAGO_APINEX) {
    // 免费档（免费池 ~200 次/日）
    list.push(openaiCompat('apinex', 'https://api.apinex.bond/v1', process.env.VOYAGO_APINEX, 'free/deepseek-v4.1-flash', timeoutMs, 1500, { reasoning_effort: 'none' }));
  }
  if (process.env.VOYAGO_MODELSCOPE) {
    list.push(openaiCompat('modelscope', 'https://api-inference.modelscope.cn/v1', process.env.VOYAGO_MODELSCOPE, 'deepseek-ai/DeepSeek-V4.1-Flash-1017', timeoutMs, 1500, { reasoning_effort: 'none' }));
  }
  if (process.env.VOYAGO_OPENROUTER) {
    // 免费档（:free 后缀）
    list.push(openaiCompat('openrouter', 'https://openrouter.ai/api/v1', process.env.VOYAGO_OPENROUTER, 'dots-studio/dots-3-note-preview:free', timeoutMs, 1500, { reasoning_effort: 'none' }));
  }
  if (!list.length) throw new Error('run-ingress: 未配置任何模型供应商 Key');
  return list;
}

/**
 * 故障转移模型：按序尝试，全部失败才抛错（上层 model-api 降级 confidence=0 走审核 INV-M2）。
 *
 * t000045：原实现只按序试穿，三类失败一视同仁 ⇒ 一次请求可拖满 30s 超时 + 多家 429，
 * 最终 degraded=true 而审计只记 model_degraded（看不出是凭据失效、限流还是超时）。
 * 本实现按失败类型分流：
 *   - 401/403（凭据失效）：重试无意义 → **短路该家**（本请求不再试它），并记账告警；
 *   - 429（限流）：计数超阈值 → **跳过该家**（给上游喘息，避免每请求都撞限流）；
 *   - 超时/其他：继续试下一家。
 * 每家失败原因随错误上抛，调用方可据此归因。
 */
const RATE_LIMIT_SKIP_THRESHOLD = 3;   // 同一供应商连续 429 达此数即在本请求内跳过

function createFailoverModel(providers, opts = {}) {
  const threshold = Number.isInteger(opts.rateLimitSkipThreshold) && opts.rateLimitSkipThreshold > 0
    ? opts.rateLimitSkipThreshold : RATE_LIMIT_SKIP_THRESHOLD;
  // 供应商健康度：连续 429 计数（成功即清零）；凭据失效标记（该家挂掉，后续请求直接跳过）
  const rateLimitCount = new Map();
  const authFailed = new Set();
  // 健康度统计（t000045 ④）：每家成功/失败计数 + 最近失败原因。
  // 为什么要有：降级分类只在**降级发生时**可见——等降级了才知道哪家坏了，已经晚了一轮；
  //   平时就该能直接看「哪家在限流、哪家凭据失效」，不用等故障发生。
  const stats = new Map();
  for (const p of providers) stats.set(p.id, { ok: 0, fail: 0, lastError: null, lastReason: null });
  const statOf = (id) => {
    let s = stats.get(id);
    if (!s) { s = { ok: 0, fail: 0, lastError: null, lastReason: null }; stats.set(id, s); }
    return s;
  };

  /** 失败分类：凭据失效（短路）/ 限流（计数跳过）/ 其他（继续试） */
  function classify(e) {
    const status = e && Number.isInteger(e.status) ? e.status : null;
    if (status === 401 || status === 403) return { kind: 'auth', reason: 'auth' };
    if (status === 429) return { kind: 'rate_limit', reason: 'rate_limit' };
    const code = e && typeof e.code === 'string' ? e.code : '';
    if (/_auth$/.test(code)) return { kind: 'auth', reason: 'auth' };
    const name = e && typeof e.name === 'string' ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout', reason: 'timeout' };
    const msg = e && typeof e.message === 'string' ? e.message : '';
    if (/abort/i.test(msg)) return { kind: 'timeout', reason: 'timeout' };
    return { kind: 'provider', reason: 'provider' };
  }

  return {
    id: 'failover',
    async interpret(text, ctx) {
      let lastErr;
      const failures = [];
      for (const p of providers) {
        // 凭据失效 → 该家已挂，后续请求直接跳过（重试无意义，白等一轮）
        if (authFailed.has(p.id)) {
          failures.push({ provider: p.id, reason: 'auth', skipped: true });
          continue;
        }
        // 限流计数超阈值 → 本请求跳过该家（上游在限流中，再试只是白等）
        const rl = rateLimitCount.get(p.id) || 0;
        if (rl >= threshold) {
          failures.push({ provider: p.id, reason: 'rate_limit', skipped: true });
          continue;
        }
        try {
          const r = await p.interpret(text, ctx);
          rateLimitCount.set(p.id, 0); // 成功即清零
          const s = statOf(p.id);
          s.ok += 1;
          s.lastReason = null;
          // 逐家失败明细随结果上抛（供归因）；结果可能是字符串等原始值 → 不可挂属性。
          if (failures.length && r && typeof r === 'object') r.__failoverFailures = failures;
          return r;
        } catch (e) {
          lastErr = e;
          const c = classify(e);
          failures.push({ provider: p.id, reason: c.reason, message: e && e.message ? String(e.message).slice(0, 120) : '' });
          const s = statOf(p.id);
          s.fail += 1;
          s.lastReason = c.reason;
          s.lastError = e && e.message ? String(e.message).slice(0, 120) : null;
          if (c.kind === 'auth') {
            // 凭据失效：重试同一家的其余动作无意义，且会拖慢整链 → 标记该家挂掉，后续请求不再试它
            authFailed.add(p.id);
            console.error(`[voyage-ingress] 模型 ${p.id} 凭据失效（401/403），该家已停用（后续请求不再尝试）: ${e.message}`);
          } else if (c.kind === 'rate_limit') {
            rateLimitCount.set(p.id, rl + 1);
            console.error(`[voyage-ingress] 模型 ${p.id} 限流（429，连续 ${rl + 1}/${threshold}），切换下一家: ${e.message}`);
          } else {
            console.error(`[voyage-ingress] 模型 ${p.id} 失败（${c.reason}），切换下一家: ${e.message}`);
          }
        }
      }
      // 全链失败：错误对象带分类与逐家明细，调用方据此归因（不只一句 provider_error）
      const err = lastErr || new Error('no_provider_available');
      err.degradeReason = failures.length ? failures[failures.length - 1].reason : 'provider';
      err.providerFailures = failures;
      throw err;
    },
    search() { return Promise.resolve([]); }, // C5 RAG 未立项——声明式桩

    /**
     * 供应商健康度快照（t000045 ④）：每家成功/失败计数、最近失败原因、当前是否被跳过。
     * 巡检据此**平时**就能看出哪家在限流/凭据失效，不必等降级发生才知道。
     * 形状：{ [providerId]: { ok, fail, lastReason, lastError, disabled, rateLimitCount } }
     */
    health() {
      const out = {};
      for (const [id, s] of stats.entries()) {
        out[id] = {
          ok: s.ok,
          fail: s.fail,
          lastReason: s.lastReason,
          lastError: s.lastError,
          disabled: authFailed.has(id),
          rateLimitCount: rateLimitCount.get(id) || 0,
        };
      }
      return out;
    },
  };
}

/** WebAuthn 真实验签装配：RPID+ORIGIN 同时配置才启用（缺一即 fail-fast）；注册凭据从 JSON 镜像加载。
 *  凭据文件是注册表镜像，signCounter 进程内推进、重启回到文件基线——计数器持久化为部署侧后续项。 */
function buildWebAuthn({ env = process.env, dataDir = DATA, createVerifier = createWebAuthnVerifier } = {}) {
  const rpID = env.VOYAGE_WEBAUTHN_RPID;
  const origin = env.VOYAGE_WEBAUTHN_ORIGIN;
  if (!rpID && !origin) return null;
  if (!rpID || !origin) throw new Error('run-ingress: VOYAGE_WEBAUTHN_RPID 与 VOYAGE_WEBAUTHN_ORIGIN 必须同时配置');
  const file = env.VOYAGE_WEBAUTHN_CREDENTIALS || path.join(dataDir, 'webauthn-credentials.json');
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  if (!Array.isArray(raw)) throw new Error('run-ingress: webauthn 凭据文件必须是数组');
  const credentials = new Map();
  for (const [i, c] of raw.entries()) {
    if (!c || typeof c.credentialId !== 'string' || !c.credentialId || typeof c.userId !== 'string' || !c.userId) {
      throw new Error(`run-ingress: webauthn 凭据第 ${i} 条缺 credentialId/userId`);
    }
    if (c.signCounter != null && (!Number.isFinite(c.signCounter) || c.signCounter < 0)) {
      throw new Error(`run-ingress: webauthn 凭据第 ${i} 条 signCounter 必须为非负数值`);
    }
    credentials.set(c.credentialId, {
      userId: c.userId,
      signCounter: Number.isFinite(c.signCounter) ? c.signCounter : 0,
      active: c.active !== false,
      ...(c.publicKeyB64u ? { publicKeyB64u: c.publicKeyB64u } : {}),
    });
  }
  return { verifier: createVerifier({ rpID, origin }), credentials, rpID, file };
}

function main() {
  if (!process.env.JWT_SECRET) throw new Error('run-ingress: JWT_SECRET 未注入（EnvironmentFile）');
  const keyvaultMap = process.env.VOYAGE_KEYVAULT_JSON ? JSON.parse(process.env.VOYAGE_KEYVAULT_JSON) : {};
  const revoked = new Set();

  const app = compose({
    mode: 'real',
    audit: { file: process.env.VOYAGE_AUDIT_FILE || `${DATA}/audit.jsonl` },
    repo: {
      identityFile: `${DATA}/identity.json`,
      assetFile: `${DATA}/asset.json`,
      identitySeed: [
        { id: 'sre-alice', role: 'sre' },
        { id: 'sre-b', role: 'sre' },
        { id: 'sre-c', role: 'sre' },
        { id: 'dev-bob', role: 'dev' },
      ],
      assetSeed: [{ id: 'jd-light' }, { id: 'ali-ecs-99' }, { id: 'ctyun-x' }, { id: 'tencent-lh' }, { id: 'oracle-arm-1' }, { id: 'sim-web-1' }, { id: 'sim-db-1' }, { id: 'sim-cache-1' }, { id: 'sim-queue-1' }],
      // ADR-006 范围维度：资产归属（owned/related）。演示种子，生产应反映真实归属。
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
    exec: {
      keyVaultPort: {
        resolve: (target) => keyvaultMap[target] || null,
      },
    },
    model: {
      provider: 'failover',
      registry: { failover: createFailoverModel(buildProviderList()) },
    },
  });

  // ---------- mTLS 信任指纹 + CRL 源（从 /opt/voyage/data/mtls/ 加载；文件不存在时空数组 fail-closed） ----------
  const mtlsDir = path.join(DATA, 'mtls');
  const trustedFpPath = path.join(mtlsDir, 'trusted-fingerprints.json');
  const crlPath = path.join(mtlsDir, 'crl.json');
  const mtlsTrustedFingerprints = fs.existsSync(trustedFpPath)
    ? JSON.parse(fs.readFileSync(trustedFpPath, 'utf8'))
    : [];

  const webauthn = buildWebAuthn();
  const auth = createAuthAdapter({
    identityRepo: app.adapters.identity,
    mtlsTrustedFingerprints,
    mtlsRevoked: revoked,
    jwtSecret: process.env.JWT_SECRET,
    ...(webauthn ? { webauthnVerifier: webauthn.verifier, webauthnCredentials: webauthn.credentials } : {}),
  });
  if (webauthn) {
    console.log(`[voyage-ingress] WebAuthn 真实验签已启用（rpID=${webauthn.rpID}，注册凭据 ${webauthn.credentials.size} 个，镜像 ${webauthn.file}）`);
    if (webauthn.credentials.size === 0) console.warn('[voyage-ingress] WebAuthn 凭据镜像为空——所有通行密钥登录将被拒绝（fail-closed），先完成注册入库');
  } else {
    console.log('[voyage-ingress] WebAuthn 未启用（未配置 VOYAGE_WEBAUTHN_RPID/_ORIGIN），通行密钥认证不可用');
  }

  // CRL 镜像：文件源（/opt/voyage/data/mtls/crl.json）+ 5 分钟定时刷新
  const crlSource = async () => {
    if (!fs.existsSync(crlPath)) return [];
    return JSON.parse(fs.readFileSync(crlPath, 'utf8'));
  };
  const crlMirror = createCrlMirror({
    revokedSet: revoked,
    source: crlSource,
    auditPort: { write: (e) => { app.adapters.audit.write(e); } },
    intervalMs: 5 * 60 * 1000,
    allowEmpty: true, // 初始 crl.json = [] 合法；有吊销记录后运维切 allowEmpty: false
  });
  crlMirror.start();
  // 启动时立即刷新一次（不等 5min 周期）——CRL 文件已有吊销记录时即时生效
  crlMirror.refresh().then((r) => {
    console.log(`[voyage-ingress] CRL 初始刷新: ${r.ok ? '成功' + r.total + '条' : '失败 ' + r.reason}`);
  });
  console.log(`[voyage-ingress] CRL 镜像已启动（源: ${crlPath}，刷新周期 5min，allowEmpty=true）`);

  // ---------- 供应商健康度落盘（t000045 ④）----------
  // 为什么落独立文件而不是 access 日志：健康度是**全局状态快照**（每家成功/失败计数、最近失败原因），
  //   而 access 日志是**每请求一行**——每请求重复写同一份快照会把日志撑爆。
  // 巡检离线读文件（collect-metrics 口径），独立 JSONL 最省事。
  // 形态：每 5 分钟一行快照 {at, providers:{id:{ok,fail,lastReason,lastError,disabled,rateLimitCount}}}。
  const healthFile = path.join(DATA, 'provider-health.jsonl');
  // 只在快照内容变化时写：内容不变就不追加——文件大小与「故障次数」挂钩，而非与时间挂钩。
  // 恒健康时零增长；某家开始限流/失败时才会逐次留痕（这正是要看的变化点）。
  // 首份必写（基线）：否则恒健康时文件永不出现，巡检会误判功能坏了。
  let lastProvidersJson = null;
  const healthTimer = setInterval(() => {
    try {
      const snap = app.adapters.model.health ? app.adapters.model.health() : null;
      if (!snap) return;
      // 比较**只含 providers 的部分**——时间戳每次都变，带上它就永远判为「有变化」
      const providersJson = JSON.stringify(snap);
      if (providersJson === lastProvidersJson) return;
      lastProvidersJson = providersJson;
      fs.appendFileSync(healthFile, JSON.stringify({ at: new Date().toISOString(), providers: snap }) + '\n');
    } catch (e) {
      console.error(`[voyage-ingress] 供应商健康度落盘失败: ${e.message}`);
    }
  }, 5 * 60 * 1000);
  // 首份基线快照立即落盘（不等待首个周期）：巡检立刻能看到「当前哪家是好的」
  try {
    const snap0 = app.adapters.model.health ? app.adapters.model.health() : null;
    if (snap0) {
      lastProvidersJson = JSON.stringify(snap0);
      fs.appendFileSync(healthFile, JSON.stringify({ at: new Date().toISOString(), providers: snap0 }) + '\n');
    }
  } catch (e) {
    console.error(`[voyage-ingress] 供应商健康度基线落盘失败: ${e.message}`);
  }
  if (typeof healthTimer.unref === 'function') healthTimer.unref(); // 不阻止进程退出
  console.log(`[voyage-ingress] 供应商健康度落盘已启动（目标: ${healthFile}，周期 5min）`);

  const ingress = createHttpIngress({
    app, auth,
    port: Number(process.env.PORT || 8787),
    host: '127.0.0.1',
    shadowMode: process.env.VOYAGE_INTENT_ONLY === '1',
    accessLogFile: process.env.VOYAGE_ACCESS_LOG || `${DATA}/access.jsonl`,
  });
  ingress.listen().then((p) => {
    console.log(`[voyage-ingress] listening 127.0.0.1:${p} | shadow=${process.env.VOYAGE_INTENT_ONLY === '1' ? 'on' : 'off'} | mTLS 指纹=${mtlsTrustedFingerprints.length} 个`);
  }).catch((e) => {
    console.error('[voyage-ingress] listen failed:', e.message);
    process.exit(1);
  });

  // ---------- mTLS 终结层（VOYAGE_MTLS=1 时启动，端口 8443） ----------
  if (process.env.VOYAGE_MTLS === '1') {
    const caPemPath = path.join(mtlsDir, 'ca.crt');
    const serverKeyPath = path.join(mtlsDir, 'server.key');
    const serverCertPath = path.join(mtlsDir, 'server.crt');
    if (!fs.existsSync(caPemPath) || !fs.existsSync(serverKeyPath) || !fs.existsSync(serverCertPath)) {
      console.error('[voyage-ingress] mTLS 证书文件缺失（ca.crt/server.key/server.crt），跳过 mTLS 终结层');
    } else {
      const mtlsPort = Number(process.env.VOYAGE_MTLS_PORT || 8443);
      const mtls = createMtlsTerminator({
        caCertPem: fs.readFileSync(caPemPath, 'utf8'),
        serverKeyPem: fs.readFileSync(serverKeyPath, 'utf8'),
        serverCertPem: fs.readFileSync(serverCertPath, 'utf8'),
        auth,
        ingress,
        port: mtlsPort,
      });
      mtls.listen().then(() => {
        console.log(`[voyage-ingress] mTLS 终结层 listening 0.0.0.0:${mtlsPort}（CA 签发 + 客户端证书验证 + 同进程转发）`);
      }).catch((e) => {
        console.error('[voyage-ingress] mTLS listen failed:', e.message);
      });
    }
  }
}

if (require.main === module) main();

module.exports = { buildProviderList, createFailoverModel, buildWebAuthn };
