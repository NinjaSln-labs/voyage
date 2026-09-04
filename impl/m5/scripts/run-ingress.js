// 内测入口启动脚本（oracle-arm-1 部署形态）——配合 DEPLOY-oracle-arm-1.md
// 环境变量（systemd EnvironmentFile 注入，600 权限）：
//   AGNES_API_KEY / JWT_SECRET        必填，凭据经注入不落代码
//   VOYAGE_AUDIT_FILE                 审计 JSONL 路径（默认 /opt/voyage/data/audit.jsonl）
//   VOYAGE_KEYVAULT_JSON              可选；{target: {user,host,port,keyPath}} 连接信息镜像（手抄口径同 e2e-real）
//   VOYAGE_INTENT_ONLY=1              影子运行模式：高危审批单只建不批（冒烟/观察期用）
'use strict';

const { compose } = require('../src/compose.js');
const { createAuthAdapter } = require('../src/auth/auth-adapter.js');
const { createHttpIngress } = require('../src/server/http-ingress.js');

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

/** 按环境变量组装可用供应商列表（缺 Key 的自动跳过） */
function buildProviderList() {
  const timeoutMs = Number(process.env.VOYAGE_MODEL_TIMEOUT_MS || 30000);
  const list = [];
  if (process.env.COMMANDCODE_API_KEY) {
    // deepseek-v4-flash 是推理模型：maxTokens 3000 + reasoning_effort=low（推理仅 5 token，实测）
    list.push(openaiCompat('commandcode', 'https://api.commandcode.ai/provider/v1', process.env.COMMANDCODE_API_KEY, 'deepseek/deepseek-v4-flash', timeoutMs, 3000, { reasoning_effort: 'low' }));
  }
  // OPENCODE 月限额耗尽（429 GoUsageLimitError），2026-08-27 移除；滚动 30 天窗口，实测 09-01 回复「13天后重置」→ 预计 09-14 恢复
  // 恢复时取消下行注释，同时恢复 simulate-traffic.js 中对应行
  // if (process.env.OPENCODE_GO_API_KEY) {
  //   list.push(openaiCompat('opencode', 'https://opencode.ai/zen/go/v1', process.env.OPENCODE_GO_API_KEY, 'deepseek-v4-flash', timeoutMs));
  // }
  if (process.env.TEAMOROUTER_API_KEY) {
    list.push(openaiCompat('teamorouter', 'https://api.teamorouter.com/v1', process.env.TEAMOROUTER_API_KEY, 'deepseek-v4-flash', timeoutMs));
  }
  // 2026-09-03 新增三家（本地实测连通后接入；均 OpenAI 兼容，经 openaiCompat 包装）：
  // - cloudflare：Workers AI OpenAI 兼容端点（account id 在端点路径内，Key 经注入不落盘）；
  //   模型用非推理 llama-3.1-fast（qwen3 系 reasoning 吃光 max_tokens 返回空 content，实测弃用）
  if (process.env.CLOUDFLARE_API_KEY) {
    const cfBase = process.env.CLOUDFLARE_AI_BASEURL || 'https://api.cloudflare.com/client/v4/accounts/ce0cc3d301381e42f02b81fd101e8f87/ai/v1';
    list.push(openaiCompat('cloudflare', cfBase, process.env.CLOUDFLARE_API_KEY, '@cf/meta/llama-3.1-8b-instruct-fp8-fast', timeoutMs));
  }
  if (process.env.SENSENOVA_API_KEY) {
    // deepseek-v4-flash（非 sensenova-6.8-flash-lite——后者推理失控，实测 4327 字符思考吃光 1200 token 预算）
    // reasoning_effort=none 关闭推理（实测 reasoning_tokens=0），maxTokens 900 足够 JSON 输出
    list.push(openaiCompat('sensenova', 'https://token.sensenova.cn/v1', process.env.SENSENOVA_API_KEY, 'deepseek-v4-flash', timeoutMs, 900, { reasoning_effort: 'none' }));
  }
  // tokenrouter：免费聚合网关；glm-5.3-free 思考在独立 reasoning_content 字段不占 content（17s 级延迟偏慢，排 agens 前）
  if (process.env.TOKENROUTER_API_KEY) {
    list.push(openaiCompat('tokenrouter', 'https://api.tokenrouter.com/v1', process.env.TOKENROUTER_API_KEY, 'z-ai/glm-5.3-free', timeoutMs, 900));
  }
  if (process.env.AGNES_API_KEY) {
    list.push(openaiCompat('agnes', 'https://apihub.agnes-ai.com/v1', process.env.AGNES_API_KEY, 'agnes-2.0-flash', timeoutMs)); // free 兜底
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
      // 执行面资产：仅 hardened:true 服务器（与云台账投影口径一致）
      // 执行面资产：真实 hardened 服务器 + 假服务舰队（sim-*，keyVault simulated:true 合成后果）
      assetSeed: [{ id: 'jd-light' }, { id: 'ali-ecs-99' }, { id: 'ctyun-x' }, { id: 'tencent-lh' }, { id: 'oracle-arm-1' }, { id: 'sim-web-1' }, { id: 'sim-db-1' }, { id: 'sim-cache-1' }, { id: 'sim-queue-1' }],
    },
    exec: {
      keyVaultPort: {
        resolve: (target) => keyvaultMap[target] || null, // 手抄镜像口径（同 e2e-real 声明）；未配置目标 → 拒绝
      },
    },
    // 多供应商故障转移链（2026-08-26 部署实测：Agens free 档延迟 10-30s 波动）——
    // registry 按实测延迟/稳定性排序：CommandCode(付费3.4s) → OpenCode(5.2s，限额暂停) → TeamoRouter(4.6s)
    //   → Cloudflare(2.2s) → SenseNova(2.3s) → TokenRouter(16s) → Agens(free兜底)
    // 2026-09-03 新增三家：cloudflare / sensenova / tokenrouter（本地实测连通后接入，缺 Key 自动跳过）
    model: {
      provider: 'failover',
      registry: { failover: createFailoverModel(buildProviderList()) },
    },
  });

  const auth = createAuthAdapter({
    identityRepo: app.adapters.identity,
    mtlsTrustedFingerprints: [], // mTLS 形态接入后填充（当前 JWT 上线形态）
    mtlsRevoked: revoked,
    jwtSecret: process.env.JWT_SECRET,
  });
  // CRL 镜像待真实 CRL 源接入后启动（mtlsRevoked 共享 Set 已就位）

  const ingress = createHttpIngress({
    app, auth,
    port: Number(process.env.PORT || 8787),
    host: '127.0.0.1',
    shadowMode: process.env.VOYAGE_INTENT_ONLY === '1',
    accessLogFile: process.env.VOYAGE_ACCESS_LOG || `${DATA}/access.jsonl`,
  });
  ingress.listen().then((p) => {
    console.log(`[voyage-ingress] listening 127.0.0.1:${p} | shadow=${process.env.VOYAGE_INTENT_ONLY === '1' ? 'on' : 'off'}`);
  }).catch((e) => {
    console.error('[voyage-ingress] listen failed:', e.message);
    process.exit(1);
  });
}

main();
