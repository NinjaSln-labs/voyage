# 内测部署清单 — oracle-arm-1

> 目标：影子运行载体（v1.0.0-rc 的阈值校准数据源）· 2026-08-25
> 宿主机：oracle-arm-1（161.33.159.216，SSH 22022，2C12G，Ubuntu 24.04 hardened）
> 凭据来源：SSH 私钥 `~/.ssh/oracle_tokyo`；模型 Key 在 DSH 凭据（经注入不落盘）；**本清单不写任何密钥值**

## 1. 前置（宿主机）

- [ ] Node ≥20（`apt` 或 nvm；入口服务与评测 runner 均需）
- [ ] 部署账号（非 root 运行；systemd `User=` 指定）
- [ ] 出网策略确认：模型供应商 API（apihub.agnes-ai.com）可达性
- [ ] 时间同步（chrony——JWT exp/nbf 与审计时序依赖）

## 2. 代码与依赖

```bash
cd /home/shadow/ninjasin-labs/Voyage
bash impl/m5/scripts/deploy.sh          # 全量同步（impl/ + docs/ + CHANGELOG.md）
bash impl/m5/scripts/deploy.sh --dry-run  # 预览

# 宿主机上：
cd /opt/voyage/impl/m5 && npm ci --omit=dev   # 仅 @simplewebauthn/server
```

## 3. 配置注入（不落盘原则）

| 项 | 来源 | 注入方式 |
|----|------|---------|
| VOYAGO_*（9 家） | vault 单一真源 `~/.vault/keys/services/llm-providers/env` | systemd `EnvironmentFile=/opt/voyage/data/voyage.env`（root-only 600）；2026-09-24 起统一用 `VOYAGO_` 前缀，缺失的供应商自动跳过 |
| JWT_SECRET | 部署时生成 | 同上（`openssl rand -hex 32`） |
| 身份种子 | 运维台账 | `/opt/voyage/data/identity.json`（600） |
| 资产种子 | 云台账投影 | compose real 模式 repo 文件 |

**模型供应商链（2026-09-24 扩至 9 家）**：CommandCode→TeamoRouter→Cloudflare→SenseNova→Agens→opencode→APInex→ModelScope→OpenRouter（入口 `run-ingress.js` 单模型/家；模拟流量/红队为多模型，见各脚本 `models` 数组）。要点：commandcode 用 `deepseek/deepseek-v4.1-flash`（+`tencent/hy3-paid`、`poolside/laguna-s-2.1-free`）；sensenova 用 `deepseek-flash`（=V4.1 Flash，平台 `deepseek-v4.1-flash` 不在 token plan）+`kimi-k3`；agens 用 `agnes-3.0-flash`；opencode 走 zen `space-bunny-free`（zen 免费档其余被服务端 `FreeTierError` 门控，见 `.handoff`）；APInex/OpenRouter 走免费池；ModelScope 3 模型。推理型 `max_tokens≥900` 由 `openaiCompat` 第 6 参传入。

## 4. 服务装配（ingress 入口）

- [ ] 启动脚本：compose(real) + createAuthAdapter(JWT) + createHttpIngress(127.0.0.1:8787)
- [ ] 反向代理（Caddy 推荐，自动 TLS）：公网 443 → 127.0.0.1:8787；
      **mTLS 设备证书启用后**在代理层终结并传指纹断言（当前先 JWT 形态上线）
- [ ] systemd unit：`voyage-ingress.service`（Restart=always、非 User=root、EnvironmentFile）
- [ ] 审计 JSONL 落盘目录（独立数据盘分区更佳）

## 5. 冒烟清单（按序全绿才算部署完成）

1. `GET /healthz` → 200
2. 无 token `POST /v1/intent` → 401
3. 合法 JWT 查询意图 → OK(kind=query)；审计 JSONL 有记录且从盘 verify 通过
4. 高危意图 → NEED_REVIEW；双人批准 → Grant → 自动执行 → 作业 completed
5. CRL 镜像 refresh 留痕；keyVault resolve 留痕无凭据值

## 6. 影子运行约定（rc 数据源）

- 真实用户意图进入，执行面仅限白名单模板 + 双人审批（平台固有）
- 每周导出：意图量/审批率/时延分布/降级率 → 对比基线（成功率≥99%、时延≤1.2×、成本≤1.1×）
- 聚合阈值（30 分钟/≥3 次/≥10 台）采集实测分布 → 校准后替换目标值

## 7. 启动脚本雏形（ingress 装配参考）

```js
// /opt/voyage/impl/m5/scripts/run-ingress.js（部署侧落地时提交）
const { compose } = require('../src/compose.js');
const { createAuthAdapter } = require('../src/auth/auth-adapter.js');
const { createCrlMirror } = require('../src/auth/crl-mirror.js');
const { createHttpIngress } = require('../src/server/http-ingress.js');
const { createIdentityRepoMemory } = require('../src/repo/repo-identity.js');

// Key 经环境注入（EnvironmentFile 600 权限），不落代码
const app = compose({
  mode: 'real',
  audit: { file: process.env.VOYAGE_AUDIT_FILE },
  repo: {
    identityFile: process.env.VOYAGE_IDENTITY_FILE,
    assetFile: process.env.VOYAGE_ASSET_FILE,
    assetSeed: require('/opt/voyage/data/cloud-asset-seed.json').assets,
  },
  exec: { keyVaultPort: { resolve: require('/opt/voyage/data/keyvault-adapter.js') } }, // 部署侧适配
  model: { vendor: '模型供应商', apiKey: process.env.VOYAGO_AGNES, modelName: 'agnes-3.0-flash' },
});
const revoked = new Set();
const auth = createAuthAdapter({
  identityRepo: /* 部署侧身份仓储 */,
  mtlsTrustedFingerprints: [],      // mTLS 形态接入后填充
  mtlsRevoked: revoked,
  jwtSecret: process.env.JWT_SECRET,
});
createCrlMirror({ revokedSet: revoked, source: require('/opt/voyage/data/crl-source.js'), intervalMs: 300000 }).start();
createHttpIngress({ app, auth, port: 8787 }).listen().then((p) => console.log('ingress on', p));
```

## 8. Caddy TLS 反代

### 安装

```bash
sudo snap install caddy --classic
```

注意：oracle-arm-1 的 snap 源为 `Yuzukosho (aoilinux)`（第三方非官方包），Caddy 二进制为官方版本 v2.11.4。服务名 `snap.caddy.server`，需手动 `caddy adapt` 将 Caddyfile 转为 JSON 配置。

### 配置

`/var/snap/caddy/common/Caddyfile`：

```
voyage.ninja-sin.tech {
    reverse_proxy 127.0.0.1:8787
    log { output file /var/snap/caddy/common/logs/voyage-access.log { roll_size 10mb roll_keep 5 } format json }
    header { X-Content-Type-Options "nosniff" X-Frame-Options "DENY" Referrer-Policy "strict-origin-when-cross-origin" }
}
```

写入后需 `caddy adapt` 到 JSON 配置：

```bash
sudo caddy adapt --config /var/snap/caddy/common/Caddyfile | sudo tee /var/snap/caddy/common/caddy.json
```

### 运维

- 日志：`/var/snap/caddy/common/logs/voyage-access.log`
- 重启：`sudo systemctl restart snap.caddy.server`
- 状态：`systemctl status snap.caddy.server`
- 验证：`curl -sk -H "Host: voyage.ninja-sin.tech" https://127.0.0.1/healthz`
- 外部验证：`curl https://voyage.ninja-sin.tech/healthz` → `{"ok":true}`（已通过）
- ACME 自动 TLS：Caddy 内置，HTTP-01 需要 80 端口公网可达
- **已解决**：2026-09-02 Oracle Cloud 安全组开放 80/443 入站，Let's Encrypt 证书已自动获取（`voyage.ninja-sin.tech`，有效期至 2026-12-01）
- 证书自动续期（Caddy 内置，30 天窗口自动重试）

## 9. 评测季度轮换定时器（voyage-rotate）

- **隔离隐藏集**：`/opt/voyage/data/eval-hidden/`（600，仅门禁执行者可读；样本非凭据，隔离目的是防污染）——由门禁执行者从隔离区投放。
- **unit**：`voyage-rotate.service`（Type=oneshot）
  ```
  ExecStart=/usr/bin/node /opt/voyage/impl/m0-baseline/eval-rotate.js \
    --quarter auto \
    --public /opt/voyage/impl/m0-baseline/eval-sets \
    --hidden /opt/voyage/data/eval-hidden \
    --redteam /opt/voyage/data/redteam-weekly \
    --archive /opt/voyage/data/eval-archive \
    --reports /opt/voyage/data/reports \
    --snapshot /opt/voyage/data/eval-snapshot.jsonl
  ```
- **timer**：`voyage-rotate.timer`（`OnCalendar=*-01,04,07,10-01 08:00`，季首 08:00）。
- **安装**：`sudo cp voyage-rotate.{service,timer} /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now voyage-rotate.timer`
- **timer 清单**：voyage-sim（每 2h）/ voyage-daily（00:15）/ voyage-redteam（周日 20:00）/ voyage-weekly（周一 08:00）/ **voyage-rotate（季首 08:00）**。
- **预期**：季初若隐藏集未刷新（独立评测岗职责），服务以退出码 1 报「未轮换 FAIL」（诚实信号），刷新后转绿；归档 `eval-archive/<quarter>/rotation.json` 仅元数据，不含隐藏样本。
