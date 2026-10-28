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
| VOYAGO_*（7 家） | vault 单一真源 `~/.vault/keys/services/llm-providers/env` | systemd `EnvironmentFile=/opt/voyage/data/voyage.env`（root-only 600）；2026-09-24 起统一用 `VOYAGO_` 前缀，缺失的供应商自动跳过 |
| JWT_SECRET | 部署时生成 | 同上（`openssl rand -hex 32`） |
| VOYAGE_WEBAUTHN_RPID / _ORIGIN | 通行密钥域名与前端来源（可选） | 同上；两者同时配置才启用真实验签，缺一启动失败 |
| VOYAGE_WEBAUTHN_CREDENTIALS | 注册凭据镜像 JSON（可选） | 默认 `/opt/voyage/data/webauthn-credentials.json`（600）；空表时所有通行密钥登录 fail-closed |
| 身份种子 | 运维台账 | `/opt/voyage/data/identity.json`（600） |
| 资产种子 | 云台账投影 | compose real 模式 repo 文件 |

**模型供应商链（2026-10-14 摘除 teamorouter 后 7 家；2026-10-13 免费模型巡检后 8 家；原 2026-09-24 扩至 9 家）**：CommandCode→Cloudflare→SenseNova→Agens→APInex→ModelScope→OpenRouter（入口 `run-ingress.js` 单模型/家；模拟流量/红队为多模型，见各脚本 `models` 数组）。要点：commandcode 入口用 `poolside/laguna-s-2.1-free`（团队集 + `stealth/glyph-cluster:free`、`reflection/beam:free`；CommandCode 不支持 `reasoning_effort=none`，最低 `low`）；sensenova 用 `deepseek-flash`（=V4.1 Flash，平台 `deepseek-v4.1-flash` 不在 token plan）+`kimi-k3`（**服务端硬约束 `temperature=1`**，其他值一律 400 `field Temperature invalid, only 1 is allowed for this model`——脚本池子须显式传 `temperature: 1`）；agens 用 `agnes-3.0-flash`；APInex/OpenRouter 走免费池（OpenRouter 账户当前可用 `:free`：`dots-3-note-preview` + `cohere/north-mini-code`，均须传 `reasoning_effort: 'none'`，否则推理吃光配额返回空 content）；ModelScope 3 模型。推理型 `max_tokens≥900` 由 `openaiCompat` 第 6 参传入。

**2026-10-13 变更原因（实测，免费模型巡检）**：
- **opencode 退出链**：zen 免费档门控收紧，服务端 `FreeTierError`，连唯一豁免 `space-bunny-free` 也 403；伪装官方客户端 UA 无效，`api.opencode.ai` 是 CDN 泛化响应（任何路径返回 200/Not Found）。恢复条件：第三方服务器可调用时，端点 `https://opencode.ai/zen/v1`，`maxTokens` 1500。
- **CommandCode 两个模型失效**：`stealth/space-bunny-alpha` → 403（"free stealth preview has ended"）；`inclusionai/ling-3.0-flash-sante:free` → 404（转付费，上游替代 slug 去掉 `:free`）。
- **OpenRouter 两个模型失效**：`coherelabs/north-mini-code:free` → 400（not a valid model ID，在清单但不可调用）；`inclusionai/ling-3.0-flash-sante:free` → 404（转付费）。
- **teamorouter 已摘除（2026-10-14）**：全模型 400 `insufficient_balance`（"需先充值后调用"），`-free` 后缀只是名称不含额度——账户余额问题非模型问题。代码已删除（6 处脚本 + `eval-cross-review.js` reviewer 链 + 头注释），留「已摘除」注释与恢复条件。恢复条件：账户充值后确认 `deepseek-flash` 等模型返回 200，再按注释恢复调用块；评审链恢复为 teamorouter 首位。
- **选型实测**（生产提示词 13 样本）：`laguna-s-2.1-free` p50 ~2.6s、推理 0 token、JSON 干净 → 入口单模型；`glyph-cluster:free` 零 429 但 p90 48s（推理 100–691 token），仅入团队集，`maxTokens` 1500 实测足够（total 最大 485）；`ling-3.1-flash:free` 响应时分类全对但 429 率高；`apodex-1.1-mini:free` 加 `reasoning_effort: none` 后 p50 ~1.7s、10/12 分类正确（2 例 `capability` 缺失，经 `model-api.js` 白名单校验 fail-closed 降级走审核，不自动执行）。

**2026-10-16 变更原因（复检，纠正上一班巡检的两处误判）**：
- **`apodex/apodex-1.1-mini:free` 是无效 ID，非「补位成功」**：探针返回 404 `No endpoints found for apodex/apodex-1.1-mini:free`，OpenRouter 公开目录 465 个模型无任何 apodex 条目，618 轮 sim 日志**零产出**。上一班「25 轮 217 次成功口径下无死模型」漏掉了它——该口径只统计有成功记录的模型，恒失败的模型不进分母。
- **`cohere/north-mini-code:free` 从未下架**（§上「OpenRouter 两个模型失效」那条系误判）：0c7ec87 起在用的 ID 是 `cohere/north-mini-code:free`（实测 ~0.8s 可用），f5b8844 测的是**错前缀** `coherelabs/north-mini-code:free` → 400 `not a valid model ID`，据此判死并补了上面那个不存在的 ID。现恢复正确 ID（探针 2/2 OK，0.9–2.2s）。**教训：测模型可用性必须用生产实际的全串 ID，前缀写错会得到 400/404 而误判「下架」。**
- **`inclusionai/ling-3.1-flash:free` 退役**：403 `The free Ling 3.1 Flash tier has been retired... now a paid model`（最后一次出量 2026-10-15 02:48）。CommandCode 目录 free 档实测只剩 `laguna-s-2.1-free`/`glyph-cluster:free`/`cat-jam:free` → 团队集补位 `stealth/cat-jam:free`（探针 2/2 OK，p50 ~1.1s，全池最快）。
- **OpenRouter 其余 `:free` 不可用是账户设置而非模型死亡**：`liquid/lfm-2.5-2.6b` `nvidia/nemotron-3.5-lightning` `poolside/laguna-s-2.1` 均 404 `Free model training violation (account settings): endpoint excluded`——需在 openrouter.ai 账户数据策略放行才能用（与 APInex 每日登录同类，见 c000006）。`thinkingmachines/inkling:free` 403 限 agentic harness；`google/gemma-4-26b-a4b-it:free` 429。
- 改动范围：`simulate-traffic.js` + `gen-redteam-weekly.js` 各 2 处池子（openrouter/commandcode 各一）。入口单模型、eval/ingress 的 openrouter 单模型槽（`dots-3-note-preview`）未动 → 分类链与高危召回不受影响，无需重跑评测门禁。`dots` 探针出现过一次 `empty_content`（生产仍正常出量，偶发），保持观察。

**2026-10-21 免费池复检（换 CommandCode Key 顺带）**：
- **`stealth/cat-jam:free` 退役**：400 `Model "stealth/cat-jam:free" is not supported on this endpoint.`（`unsupported_model`），新旧 CommandCode Key 一致，且已从 `/models` 目录移除；sim 自 10-20 02:43 CST 起每轮必现。团队集补位 `reflection/beam:free`（探针 JSON 有效，~2.2s）。
- **`deepseek-ai/DeepSeek-V4.1-Flash` 失去 provider**：400 `Model id : ... has no provider supported`，sim 自 10-19 10:44 CST 起每轮必现；ModelScope 目录仍有该别名但不可调用。改用新快照 `deepseek-ai/DeepSeek-V4.1-Flash-1017`（探针 JSON 有效，~1.2s），同步 5 处调用点（入口 + sim/redteam + 两个 eval）。

**2026-10-17 sim failures 归因分桶（脚本侧响应解析收口）**：
- 旧写法只有 `if (!res.ok)` 一道闸，拿到 200 就直奔 `data.choices[0].message.content`——「200 但封套无可用 choices」坍缩成一条 `exception: Cannot read properties of ...`，供应商写明的原因当场丢失；模型 content 不是合法 JSON 数组（618 轮里 322 次，是 failures 的大头）也混在同一个 `exception:` 标签下，长期被当成网络噪音。
- 现统一走 `impl/m5/scripts/chat-response.js`（`readChatResponse` + `readContentArray`，守卫写法对齐 `src/model/agens-adapter.js:106`）。标签集：`HTTP <status>:<供应商原因>` / `body_not_json` / `body_no_choice(null|missing|empty)` / `empty_content` / `content_no_array` / `content_truncated` / `content_bad_json` / `content_empty_array`。原文截 120 字进 summary，下次同类异常自动留证，不必再手工探针。
- 形态依据：`choices=null` 42/44 次集中于 `modelscope/ZhipuAI/GLM-5.2`（09-24→10-08 每日 2–5 次，之后转纯 429）；65 次探针实测其非正常封套一律带 HTTP 429 + `limit_burst_rate`，故**「200 + choices=null」的确切触发条件未复现、成因未查明**，待本标签自动取证。`choices` 缺失 12 次 = openrouter dots 8 + 已摘除的 space-bunny-alpha 4。
- 关联判据：GLM-5.2 在 1.2s 串行间隔下仍约 40% 被 `limit_burst_rate` 限流——「entry 单模型是否换 GLM-5.2」的待决据此减分。
- 覆盖面：仅两个生成脚本的自拼 fetch 路径；分类链走 `agens-adapter` 本就有守卫；`gen-redteam-weekly.js` 的 classify 内联 fetch 只计数不记原因，本次未动。

## 4. 服务装配（ingress 入口）

- [ ] 启动脚本：compose(real) + createAuthAdapter(JWT；配置 WEBAUTHN_RPID/ORIGIN 时注入真实验签器) + createHttpIngress(127.0.0.1:8787)
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

## 10. 资产归属（ADR-006 范围维度）

- `run-ingress` 于 `${DATA}/ownership.json` 维护**资产 → 负责主体**投影（首次以种子初始化，之后以文件为准）。
- 种子为**演示口径**（sre-alice→jd-light/sim-cache-1 等）；生产须以运维台账为准并定期同步（未覆盖项见 ADR-006）。
- 行为影响：`dev` 角色的 `restart` / `query_log` / `schedule` 为 `owned` 范围——非自己负责的目标会被 `REJECTED scope_violation`；`sre` 为 `full`。**旧部署若缺 `ownership.json`，dev 侧相关操作会 fail-closed 拒绝**，上线前须确认归属种子到位。
- `dev.audit_query` 为 `self`（**数据层已落地**）——审计查询端点按主体收敛：`dev` 只见本人记录。

## 11. 审计查询端点（ADR-006 数据层 / t000037）

- `GET /v1/audit?limit=&before=`（`audit_query`）：`sre` 全量明细；`dev` 仅本人（`who === actorId`）。`limit ≤ 200`（默认 50），`before` 为 `seq` 游标（newest-first）。
- `GET /v1/audit/summary?days=`（`audit_summary`）：`manager` 聚合视图（`total`/`byResult`/`byActor`/`byDay`，`days ≤ 90`，默认 7），**不含明细行**。
- 鉴权同其余端点（mTLS/JWT）；限速 60 次/分/身份；越权/范围不符 → `403 forbidden`（不区分原因），非法参数 → `400`。
- 冒烟：无 token `401` / `sre` 全量 / `dev` 仅本人 / `manager` summary 无 `entries` / `test` 角色 `403`。
- 部署注意：端点服务由 `compose` 装配（`services.auditQuery`）——未装配时返回 `503 audit_query_unavailable`（不静默）。
