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

function main() {
  if (!process.env.AGNES_API_KEY || !process.env.JWT_SECRET) {
    throw new Error('run-ingress: AGNES_API_KEY / JWT_SECRET 未注入（EnvironmentFile）');
  }
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
      assetSeed: [{ id: 'jd-light' }, { id: 'ali-ecs-99' }, { id: 'ctyun-x' }, { id: 'tencent-lh' }, { id: 'oracle-arm-1' }],
    },
    exec: {
      keyVaultPort: {
        resolve: (target) => keyvaultMap[target] || null, // 手抄镜像口径（同 e2e-real 声明）；未配置目标 → 拒绝
      },
    },
    model: { vendor: 'agens', apiKey: process.env.AGNES_API_KEY, modelName: 'agnes-2.0-flash', ...(process.env.VOYAGE_MODEL_TIMEOUT_MS ? { timeoutMs: Number(process.env.VOYAGE_MODEL_TIMEOUT_MS) } : {}) },
  });

  const auth = createAuthAdapter({
    identityRepo: app.adapters.identity,
    mtlsTrustedFingerprints: [], // mTLS 形态接入后填充（当前 JWT 上线形态）
    mtlsRevoked: revoked,
    jwtSecret: process.env.JWT_SECRET,
  });
  // CRL 镜像待真实 CRL 源接入后启动（mtlsRevoked 共享 Set 已就位）

  const ingress = createHttpIngress({ app, auth, port: Number(process.env.PORT || 8787), host: '127.0.0.1', shadowMode: process.env.VOYAGE_INTENT_ONLY === '1' });
  ingress.listen().then((p) => {
    console.log(`[voyage-ingress] listening 127.0.0.1:${p} | shadow=${process.env.VOYAGE_INTENT_ONLY === '1' ? 'on' : 'off'}`);
  }).catch((e) => {
    console.error('[voyage-ingress] listen failed:', e.message);
    process.exit(1);
  });
}

main();
