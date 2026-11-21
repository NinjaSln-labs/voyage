# 运维判读 SOP（2026-11-22 立项）

> 目的：把散在交接台账里的坑，收敛成**一页可执行口径**＋**固定入口脚本**，让同一类错误不再复发第二次。
> 判据来源：`impl/m5/src/model/model-api.js`（parseStructured／classifyProviderError）、`impl/m5/scripts/chat-response.js`（失败分桶）、生产 `sim.log`／`access.jsonl`／`provider-health.jsonl`。
> 相关：`impl/m5/DEPLOY-oracle-arm-1.md`（部署与供应商链实况）、`.handoff/`（坑 p0000xx 的原始取证）。

## 0. 工具入口（先用工具，别手搓）

| 场景 | 唯一入口 | 治哪条坑 |
|------|----------|----------|
| 判某模型/某供应商能不能用 | `impl/m5/scripts/probe-model.js`（三模式必测） | p000056 / p000062 / p000065 / p000067 / p000073 / p000075 |
| 跑三集门禁并取汇总 | `impl/m5/scripts/run-gate.sh` | p000049 / p000050 |
| 生产健康巡检 | `impl/m5/scripts/health-check.sh` | p000070 / p000071 |
| 轮换供应商 Key | `impl/m5/scripts/rotate-provider-key.sh` | p000060 / p000065 |
| 模型健康度（死模型） | `impl/m5/scripts/collect-metrics.js` 的 `modelHealth` | p000061 / p000056 |

探针用法（凭据必须经 jinteng 注入，脚本不打印明文）：

```bash
jinteng run -e NKP_OPENDESIGN=NKP_OPENDESIGN -- \
  node impl/m5/scripts/probe-model.js \
    --base https://amr-link.open-design.ai/v1 \
    --model deepseek-v4.1-flash-eco \
    --key-env NKP_OPENDESIGN \
    --modes prompt_only,json_object,json_schema --n 6
```

## 1. 模型可用性判读（最常误判的一类）

**禁止的判据**（三条老坑都栽在这）：

- ❌「`/models` 目录里有这个 id」 ⇒ 不代表可调用（p000056 / p000073）。
- ❌「探针失败 2 次」 ⇒ 不代表模型死，可能只是撞上限流窗口（p000067）。
- ❌「探针只带提示词失败」 ⇒ 不代表模型不可用，可能只是该端点不支持 `json_object`（p000062）。

**正确判据（三条同时成立才算死）**：

1. **原样实调**：用生产同款适配器、**生产池子里的原样 ID 全串**（前缀写错会得到 400/404 而误判下架）、带入口系统提示词。
2. **三模式都测**：`prompt_only` / `json_object` / `json_schema` 分开记——某模式全 400 而另两模式通过 = 该模式不支持，**不是模型死**。
3. **看产出而非失败计数**：`sim.log` 里该模型的 `gen` 段**是否归零**。恒失败模型不进「N 轮 M 次成功」的分母，那种口径结构性看不见它（p000056 / p000061）。

**供应商错误的分诊顺序**：

| 现象 | 先查 | 再查 |
|------|------|------|
| 400 | 参数（推理档／max_tokens／json 模式） | 模型 id 是否写对全串 |
| 401/403 | **账号与权益**（是否需登录/激活，p000055） | key 是否轮换过（走 jinteng 取，p000065） |
| 402 | 账号余额/权益门槛（不是代码缺陷） | — |
| 429 | 限流窗口（**不是模型慢**，p000067） | 配额策略 |
| 200 但内容坏 | 内容层解析（`parseStructured` fail-closed 走审核） | 是否该换家（failover 已按内容换家，p000063） |
| 200 但 `choices` 为空 | 一次性则**不判死**（p000077） | 连续多轮零产出再按 p000056 复核 |

**推理档是供应商×模型级硬约束**（p000075）：「某家支持 `reasoning_effort=none`」不能推广到「该家所有模型都支持」。每换一个模型都单独实测档位；推理 token 吃 `max_tokens` ⇒ 推理型 `max_tokens ≥ 900`（用 1500）。

## 2. 召回与门禁判读

- **口径不可互证**：生成器 `classify` 是模型裸判，红队集的**生产判读必须走 compose 全链**（p000039）。
- **产物周不按触发日推**：产物文件名标的是生成时刻所在 ISO 周，与 timer 触发日可能不同周（p000038）——取数用文件名 ISO 周 + `meta.firstGeneratedAt` 双校验。
- **门禁结论只看 `=== 汇总` 块**：判定「总样本/通过/召回率/判定」，三集 AND 100% 才算过；`run-gate.sh` 已把取数封好，别再手拼 `journalctl | tail`（p000049 / p000050）。
- **ssh 前台超时 ≠ 失败**：长任务走 `manual-run.sh`，服务端 transient unit 仍在跑（p000049）。

## 3. 运维操作红线

| 禁止 | 原因 | 替代 |
|------|------|------|
| `source voyage.env` | env 文件含非 export 行，变量被静默丢弃（p000005） | `grep '^KEY=' file` 取值 |
| 裸 `systemd-run` | 漏 `--property=User=ubuntu` ⇒ 产物属主错位、后续写入 EACCES（p000006） | `manual-run.sh` |
- 探针读本机 shell 旧环境变量 | 把「key 已轮换」误判成「轮换失败」（p000065） | `jinteng run -e ...` 注入 |
- 把脚本与值同走一条 ssh stdin | 脚本被吞、替换静默不生效（p000060） | `rotate-provider-key.sh`（两通道分离 + 指纹对拍） |
- 从运维机直探供应商 URL | 被 CF 1010 拦 / 口径与生产不同（p000070） | 在生产机上跑脚本；日志时间按 UTC 读（文件时间 CST 差 8h） |
- 用裸 curl 探 8443 判服务挂 | 8443 是 mTLS，要客户端证书，裸探必 000（p000071） | `health-check.sh`；HTTP 端口是 127.0.0.1:8787 |

## 4. 收口口径（避免「修了但没人知道修没修」）

- 判断某缺陷是否修复成立，用**该缺陷形态是否绝迹**，不用「失败总数是否为 0」——后者会被无关噪音否掉。
- 每次改动都要落三样：**机器可判的断言**（`impl/m5/test/*.test.js`）、**生产实测读数**、**交接条目**（`handoff add` + `handoff close` + `handoff check` rc=0）。
- 凭据值与本机绝对路径不进仓、不进文档；jinteng 硬删 ≠ provider 侧吊销（p000076）。

## 5. 本 SOP 的边界

- 只覆盖**运维与判读**层；领域层（意图分类、能力白名单、审计）口径见 `docs/产品说明书-终版.md` 与 ADR。
- 注入类安全事件（工具输出混入伪系统提示）按 AGENTS 规则 4 走私密渠道反馈，**不在本文档展开**（p000057）。
