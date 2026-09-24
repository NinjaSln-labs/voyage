// 内测入口启动脚本（oracle-arm-1 部署形态）——配合 DEPLOY-oracle-arm-1.md
// 环境变量（systemd EnvironmentFile 注入，600 权限）：
//   AGNES_API_KEY / JWT_SECRET        必填，凭据经注入不落代码
//   VOYAGE_AUDIT_FILE                 审计 JSONL 路径（默认 /opt/voyage/data/audit.jsonl）
//   VOYAGE_KEYVAULT_JSON              可选；{target: {user,host,port,keyPath}} 连接信息镜像（手抄口径同 e2e-real）
//   VOYAGE_INTENT_ONLY=1              影子运行模式：高危审批单只建不批（冒烟/观察期用）
//   VOYAGE_MTLS=1                     启动 mTLS 终结层（端口 8443，需 /opt/voyage/data/mtls/ 下证书齐全）
//   VOYAGE_MTLS_PORT                  mTLS 监听端口（默认 8443）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { compose } = require('../src/compose.js');
const { createAuthAdapter } = require('../src/auth/auth-adapter.js');
const { createCrlMirror } = require('../src/auth/crl-mirror.js');
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
    // 2026-09-24 模型集更换（用户指定）：Laguna S 2.1 / Ling 3.0 Flash Sante / Space Bunny Alpha。
    // 入口单模型取 Space Bunny Alpha（实测快、JSON 干净、推理 0 token）；CommandCode 不支持 reasoning_effort=none（400），最低 low。
    list.push(openaiCompat('commandcode', 'https://api.commandcode.ai/provider/v1', process.env.VOYAGO_COMANDCODE, 'stealth/space-bunny-alpha', timeoutMs, 1500, { reasoning_effort: 'low' }));
  }
  if (process.env.VOYAGO_TEAMOROUTER) {
    list.push(openaiCompat('teamorouter', 'https://api.teamorouter.com/v1', process.env.VOYAGO_TEAMOROUTER, 'deepseek-flash', timeoutMs, 1500, { reasoning_effort: 'none' }));
  }
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
  if (process.env.VOYAGO_OPENCODE) {
    // zen 免费档其余模型被 FreeTierError 门控（仅允许官方 OpenCode 客户端会话，见 .handoff）；space-bunny-free 不受门控，实测 200
    list.push(openaiCompat('opencode', 'https://opencode.ai/zen/v1', process.env.VOYAGO_OPENCODE, 'space-bunny-free', timeoutMs, 1500));
  }
  if (process.env.VOYAGO_APINEX) {
    // 免费档（免费池 ~200 次/日）
    list.push(openaiCompat('apinex', 'https://api.apinex.bond/v1', process.env.VOYAGO_APINEX, 'free/deepseek-v4.1-flash', timeoutMs, 1500, { reasoning_effort: 'none' }));
  }
  if (process.env.VOYAGO_MODELSCOPE) {
    list.push(openaiCompat('modelscope', 'https://api-inference.modelscope.cn/v1', process.env.VOYAGO_MODELSCOPE, 'deepseek-ai/DeepSeek-V4.1-Flash', timeoutMs, 1500, { reasoning_effort: 'none' }));
  }
  if (process.env.VOYAGO_OPENROUTER) {
    // 免费档（:free 后缀）
    list.push(openaiCompat('openrouter', 'https://openrouter.ai/api/v1', process.env.VOYAGO_OPENROUTER, 'nex-agi/nex-n2.5-mini:free', timeoutMs, 1500, { reasoning_effort: 'none' }));
  }
  if (!list.length) throw new Error('run-ingress: 未配置任何模型供应商 Key');
  return list;
}

/** 故障转移模型：按序尝试，全部失败才抛错（上层 model-api 降级 confidence=0 走审核 INV-M2） */
function createFailoverModel(providers) {
  return {
    id: 'failover',
    async interpret(text, ctx) {
      let lastErr;
      for (const p of providers) {
        try {
          const r = await p.interpret(text, ctx);
          return r;
        } catch (e) {
          lastErr = e;
          console.error(`[voyage-ingress] 模型 ${p.id} 失败，切换下一家: ${e.message}`);
        }
      }
      throw lastErr || new Error('no_provider_available');
    },
    search() { return Promise.resolve([]); }, // C5 RAG 未立项——声明式桩
  };
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

  const auth = createAuthAdapter({
    identityRepo: app.adapters.identity,
    mtlsTrustedFingerprints,
    mtlsRevoked: revoked,
    jwtSecret: process.env.JWT_SECRET,
  });

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

main();
