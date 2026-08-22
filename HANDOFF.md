# HANDOFF — 行舟 · Voyage

## 1. 交接元信息

- **日期**：2026-08-19 · **交接方**：本 session（agent）· **接收方**：后续 session / 开发者
- **原因**：M0-T 选型 + M5/M6 闭环 + 全维度审计（38 轮闭环）+ 评测集公开集初建 + 审计持久化落地（全量 298/298 绿）→ 交接到 **真实部署阶段（适配器接入）**
- **项目一句话**：把运维能力民主化的 AI 运维平台——口语化低门槛 × 零信任审批（AIOps democratized）
- **文档入口链**：README（双语索引）→ `docs/产品说明书-终版.md`（权威口径）→ `docs/产品0-1计划.md`（执行计划）→ `docs/需求说明书-终版.md`（RQ）→ `AI红蓝对抗报告.md`（安全完备性）→ `PRODUCT-DOC-AUDIT.md`（文档审计）→ `impl/审计记录-DDD综合.md`（DDD 架构审计 7 维度全通过）
- **接收方建议动作**：
  1. 先读本文件 §2–§4，再按需进文档入口链
  2. 验证环境：`node --version`（≥20，node:test 内置，零依赖）
  3. 运行 §4 测试命令确认基线（298/298 全绿）
  4. 阅读 M0-T 选型决策：`impl/m0-t/选型决策记录.md`（8 层选型 + 替换条件）
  5. M5 编排层参考：`impl/m5/README.md`（Outbox + 五步串联 + 审计链）
  6. M6 走查参考：`impl/m6/README.md`（评测门禁 + 四角色走查 + 适配器契约）
  7. **无外部凭据需要**（纯领域模型 + 零依赖；真实部署需模型 API Key + SSH 目标机 + 证书，届时向用户索取）

## 2. 当前状态快照

| 域 | 状态 |
|----|------|
| 基础文档集 `docs/`（9 份） | ✅ 终版 · 审计 100/100 |
| 红蓝对抗 | ✅ 十轮收敛（96 处修复固化）· 报告 `AI红蓝对抗报告.md` |
| M0 基线/选型/DDD 设计 | ✅ `impl/m0-baseline|m0-t|m0-d`（42 不变量，选型决策 8 层，评测集公开集 220 条，DDD 审计 12 轮收敛） |
| M1 观测（obs） | ✅ `impl/m1` · 43 测试 |
| M2 对话（conv） | ✅ `impl/m2` · 56 测试 |
| M3 信任（trust） | ✅ `impl/m3` · 62 测试 |
| M1/M2/M3 严格审计 | ✅ 157 波 + DDD 综合审计全通过 · 483 项确认/修复 · 连续 51 波零缺陷 |
| M4 执行闭环 | ✅ `impl/m4` · 27 测试 |
| M5 整合 + 审计 | ✅ `impl/m5` · 74 测试（Outbox + 五步串联 + 审计链 + 审批审计 + metric BC + 跨BC接线E2E + 文件持久化） |
| M6 内测上线走查 | ✅ `impl/m6` · 30 测试（model BC 门禁 + 四角色走查 + 适配器契约定型） |
| 全维度审计 | ✅ 38+ 轮闭环（`impl/审计记录-DDD全维度.md`）· 修复 15+ 项（3 个 P0） |
| 真实部署 | 🔄 进行中：审计持久化 ✅ · 评测集公开集 ✅ · 身份/资产真实仓储 ✅ · SSH 被管机执行 ✅ · 模型接入 ✅（供应商无关 + Cohere）· **组合根装配 ✅** · 认证待接 |

**版本控制**：git `main` 分支 · 远端 `github.com/NinjaSln-labs/voyage`（public，MIT）· 提交规范 Conventional Commits

**构建环境**：零依赖（纯 JS + node:test），无 node_modules/构建产物；Node ≥20 即跑

**最近完成**（`git log` 为详情权威）：
- `90f1ee9` fix(audit-r2): 复审修正（keyVault 审计真接线 + handleAsync 并发归属队列 + matrixPort 启动上下文绑定 + runJob 缺参 failJob + RESERVED_PROTO_KEYS 单源 + 三方能力锚定测试 + intentId 唯一化），全量 361
- `8653264` fix(audit): 初审修正（real 模式桥接 handleAsync/sync 守卫 + 第 12 波保留键拒绝 + 兜底白名单 + runJob 运行时链 + matrixPort 投影 + shared-capabilities 单源 + smell 清理），全量 357
- **双轴审计闭环**：`impl/审计记录-真实部署适配器.md`（初审 10 项 → 修复 → 复审 8 项 → 修复；recorded 残余 5 项声明）
- `b233d21` feat(compose): 组合根装配（真实适配器注入 M3/M4/M5 服务，mock/real 双模式 + 配置注入 + audit 五元组→AuditEntry 桥接）+ model-api 同步通道 interpretSync，装配契约测试 7 例，全量 349
- `cf59dfd` feat(model): 供应商无关模型适配器层（modelApiPort：统一契约 interpret/search + 厂商注册表 + 结构化 JSON 解析 fail-closed + 断连降级 confidence=0 走审核 INV-M2）+ Cohere Command Code 厂商（HTTP 直调 /v1/chat，模型名可配置不绑定），契约测试 14 例，全量 342
- `80fe31b` feat(exec): SSH 被管机执行适配器（execAdapterPort：系统 ssh 二进制 + keyVaultPort 凭据注入 + 远端白名单模板 base64 载荷不拼接 + 失败语义对齐契约，契约测试 11 例含真实 SSH 冒烟，全量 328）
- `edb4983` feat(repo): 云服务器台账→资产仓储投影转换（`repo-cloud-services.js`，仅 hardened 服务器进执行面，域名/在途排除 fail-closed，契约测试 6 例，全量 317）
- `e8e0b8d` feat(repo): 身份/资产真实仓储适配器（identityRepoPort/assetRepoPort JSON 文件持久化 + 角色能力投影 + 资产生命周期 + 命名 schema，契约测试 13 例，全量 311）
- `a710f88` feat(audit-persist): 审计文件JSONL持久化适配器（append-only/重建/fail-closed）+ 修五元组 from getter 缺失
- `12ba7fd`/`08e95db` feat(eval): 评测集公开集 220 条（口语/知识/高危/术语/解释/FAQ）+ runner + 契约测试 5 例
- 全维度审计 38+ 轮闭环：`impl/审计记录-DDD全维度.md`（建模/事件/时序/契约/接线/参数/内存/时钟/封装/一致性/统一语言/并发/数值/降级/幂等/依赖/错误语义/常量/测试质量/对抗穿透）
- `975bb9c` feat(m5,m6): 整合+审计+内测上线（全量 235/235）
- M0-T 选型决策记录：8 层选型（感知/决策/知识/执行/入口/模型/审计/认证），全部 MIT/Apache-2.0
- M6 评测门禁 GateService + 四角色×五旅程端到端走查 + 六类真实适配器契约定型（ADAPTER-CONTRACTS.md）
- M4 执行闭环落地（`a11ffad`，27 测试）

**占位/未完成边界（防误判）**：
- M1/M2 的 `intentModel`（模型 API）端口是**适配点**，已接**供应商无关模型层**（`impl/m5/src/model/`，首个厂商 Cohere Command Code）——M2 接模型时经 model-api 注册表注入
- 真实适配器：**审计持久化已落地**（文件 JSONL）；**身份/资产仓储已落地**（`impl/m5/src/repo/` JSON 文件版，对齐 §4/§5 契约）；**SSH 被管机执行已落地**（`impl/m5/src/exec/exec-adapter.js`，对齐 §2 契约 + RQ-411/511）；**模型接入已落地**（`impl/m5/src/model/`，供应商无关 + Cohere 厂商）；**组合根已装配**（`impl/m5/src/compose.js`，mock/real 双模式）；mTLS/WebAuthn 认证仍为契约 stub——需证书链
- 评测集：**公开集 220 条已建**；隐藏集（独立评测岗双人）+ 红队周更对抗集未建——需独立岗
- 聚合阈值（30 分钟/≥3 次/≥10 台等）为目标值，**未实测校准**（按 `docs/指标口径.md` 双态原则）
- 所有领域对象全只读化（Date getter 拷贝、值对象不可变）——M5/M6 新增聚合已遵循同标准

## 3. 下一步与验证点

**立即待办（真实部署阶段·剩余适配器）**：
- **身份/资产真实仓储**：✅ 已落地（`impl/m5/src/repo/`，契约测试 13 例）——真实部署时从 LDAP/IdP/CMDB 导入种子替换初始化
- **SSH 被管机执行**：✅ 已落地（`impl/m5/src/exec/exec-adapter.js`，契约测试 11 例含真实 SSH 冒烟——JD 云 `117.72.186.97` 实测通过）——接 M4 时经 keyVaultPort 注入 `~/.ssh/oracle_tokyo` + 台账连接信息
- **模型 API 接入**：✅ 已落地（`impl/m5/src/model/`，供应商无关层 + Cohere Command Code 厂商，契约测试 14 例）——真实调用需 Cohere API Key（经注入不落盘）；新增厂商：实现 `{id, interpret, search}` 挂注册表
- **组合根装配**：✅ 已落地（`impl/m5/src/compose.js`，契约测试 7 例）——`compose({mode: 'mock'|'real'})` 注入 M3/M4/M5 服务；real 需 audit.file/repo 文件/keyVaultPort/Cohere Key；**M5 handle 为同步契约**——真实模型 async 不直插，同步通道经 `modelApi.interpretSync`（规则引擎），async 走 `adapters.model.interpret`
- **mTLS/WebAuthn 认证**：需证书链 + 浏览器端依赖
- **评测集隐藏集 + 红队周更集**：需独立评测岗（双人）/红队岗
- **梯度放量**（Later）：1% → 10% → 50% → 100%，每档对比基线（成功率/时延/成本）

**外部依赖来源**：真实部署阶段需用户提供——模型 API Key（Cohere Command Code，经注入不落盘）、mTLS 证书、WebAuthn 浏览器依赖。**无凭据已入仓库**（脱敏）。

## 4. 即时操作

```bash
# 测试（零依赖，全量 361/361：M1~M6 + 评测集 + 文件审计持久化 + 身份/资产仓储 + 云台账投影 + SSH 执行 + 模型适配器 + 组合根装配 + 单源锚定）
find impl -name "*.test.js" | xargs -I{} sh -c 'cd $(dirname {}); node --test $(basename {})'

# git
git log --oneline
git status
git push
```

**已知坑（未修，仍会踩）**：
- M1 快照 metrics 结构是 `{count, samples}`（非纯数组）——消费方适配器按此解析
- M2 `recognize` 输入限 4096 字符、否定/疑问句强制 query——改动需回归 S17~S41
- 领域 getter 不能带参数（JS 语法）——`isExpired(now)` 用方法不用 getter
- 语义判定必须在**归一化视图**统一判定——新增语义判定一律先归一化
- 事件协议跨 BC 统一（schemaVersion+eventId+深冻结载荷）——新增 BC 必须对齐
- 领域构造参数一律「正有限+显式类型+长度上限」校验——字符串隐式转 Date 是静默错误源
- M4 exec 端口为 stub——接真实适配器时保持同步调用契约
- **SSH 执行适配器**：`impl/m5/src/exec/exec-adapter.js`——凭据经 `keyVaultPort.resolve(target)` 注入（私钥路径）；远端脚本 base64 传递（多行经 shell 会被 bash 拆坏）；参数经 stdin JSON 载荷（不经 argv 防泄漏）；失败语义对齐契约（connection_failed/timeout/permission_denied）
- **模型适配器**：`impl/m5/src/model/`——供应商无关层（统一契约 interpret/search + 注册表）+ Cohere 厂商；模型输出必须为结构化 JSON（本地严格解析，失败降级 confidence=0 走审核 INV-M2）；API Key 经注入不落盘；新增厂商实现 `{id, interpret, search}` 挂注册表即可
- **组合根**：`impl/m5/src/compose.js`——audit 桥接须把五元组包装为 AuditEntry（chain.append 须实例，否则静默丢审计）；M5 handle 同步契约 → real+Cohere 用 `handleAsync`（handle 无 sync 通道显式报错），并发经 intent+actorId 归属队列防串包；矩阵判定走 `execStart` 包装层（启动上下文绑定 creator，裸 `services.exec.start` 无上下文会被 matrix fail-closed 拒绝）；keyVault 审计在 real 装配内自动接线（每次 resolve 留痕，不记 Key 值）
- **身份/资产仓储**：`impl/m5/src/repo/`——角色→能力投影单源在 `ROLE_CAPABILITIES`（§4.2 矩阵）；`active=false` 身份不参与判定（fail-closed）；资产退役单向不可回退；文件版原子覆写（tmp+rename）
- **云台账投影**：`repo-cloud-services.js` 只投影 `hardened:true` 服务器进执行面；域名/在途 Oracle 排除（fail-closed 可追溯）——台账 `cloud-services.json` 单源，改台账不落盘投影
- **审计持久化**：`entries()` 快照五元组在顶层（无 entry 字段）——自定义 persist 的 save 须从顶层重构 entry（见 `persist-file.js` 参考）
- JS 语义：getter-only 属性非严格模式赋值**静默忽略**（值不变不报错）——封装验证须用严格模式/值对比

> 已确认修复的坑已归档 `HANDOFF-ARCHIVE/pits.md`（第 23~34 波，9 项）。

## 5. 引用索引（主题 → 权威文档）

| 主题 | 权威路径 |
|------|---------|
| 架构/能力/矩阵/规则 | `docs/产品说明书-终版.md` |
| 需求 RQ / 验收锚点 / 追溯 | `docs/需求说明书-终版.md`（§2/§6/§9） |
| 执行计划 / 里程碑 | `docs/产品0-1计划.md` |
| 指标口径 / 反指标 | `docs/指标口径.md` |
| 评测门禁 / 三集制 | `docs/AI评测策略.md` |
| 完成定义 | `docs/DoD 门禁.md` |
| 安全完备性 | `AI红蓝对抗报告.md` |
| DDD 设计（42 不变量） | `impl/m0-d/DDD设计.md` |
| M0-T 技术选型决策 | `impl/m0-t/选型决策记录.md` |
| M4 方案评审 + 实现 | `impl/m4-方案评审.md` + `impl/m4/` |
| M5 方案评审 + 实现 | `impl/m5-方案评审.md` + `impl/m5/` |
| M6 方案评审 + 实现 | `impl/m6-方案评审.md` + `impl/m6/` |
| 真实适配器契约 | `impl/m6/ADAPTER-CONTRACTS.md` |
| 评测集公开集 + runner | `impl/m0-baseline/eval-sets/` + `eval-runner.js` |
| 审计持久化适配器 | `impl/m5/src/audit/persist-file.js` |
| 身份/资产仓储适配器 | `impl/m5/src/repo/repo-identity.js` + `repo-asset.js`（契约测试 `impl/m5/test/repo.test.js`） |
| 云台账→资产投影 | `impl/m5/src/repo/repo-cloud-services.js`（对接 `~/Documents/cloud-services/cloud-services.json`，契约测试 `repo-cloud-services.test.js`） |
| SSH 被管机执行适配器 | `impl/m5/src/exec/exec-adapter.js`（契约测试 `impl/m5/test/exec-adapter.test.js`，含真实 SSH 冒烟） |
| 模型适配器层（供应商无关） | `impl/m5/src/model/model-api.js` + `cohere-adapter.js`（契约测试 `impl/m5/test/model-api.test.js`） |
| 组合根装配 | `impl/m5/src/compose.js`（mock/real 双模式；契约测试 `impl/m5/test/compose.test.js`） |
| 能力/模板单源 | `impl/m5/src/shared-capabilities.js`（三方同值锚定 `impl/m5/test/shared-capabilities.test.js`） |
| 真实部署适配器审计（双轴） | `impl/审计记录-真实部署适配器.md`（初审→修复→复审→修复闭环，recorded 残余声明） |
| 全维度审计记录 | `impl/审计记录-DDD全维度.md` |
| 质量基调（防御矩阵 18 节） | `impl/完美收官-质量基调.md` |
| 严格审计记录（157 波） | `impl/审计记录-第{7..157}波.md` |

## 6. 维护规则

- **更新时机**：每个里程碑完成、重大决策、新 session 开始交接时
- **防双源**：本文件只记 delta；架构/需求/设计一律引用 §5 路径，禁止复制
- **滚动归档**：跨周期的旧 delta 移入 `HANDOFF-ARCHIVE/cycles.md`；确认修复的坑 → `pits.md`，完成的待办 → `done.md`
- **回填约定**：里程碑完成 → 更新 §2 快照 + §3 下一步 + 回填 git hash；确认完成项迁 `HANDOFF-ARCHIVE/`
- **脱敏**：无 Key/密码/PII；凭据路径引用不写值
