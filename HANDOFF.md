# HANDOFF — 行舟 · Voyage

## 1. 交接元信息

- **日期**：2026-08-19 · **交接方**：本 session（agent）· **接收方**：后续 session / 开发者
- **原因**：M0-T 选型记录 + M5 整合审计 + M6 内测上线走查全部完成（全量 274/274 绿）→ 交接到 **真实部署阶段**
- **项目一句话**：把运维能力民主化的 AI 运维平台——口语化低门槛 × 零信任审批（AIOps democratized）
- **文档入口链**：README（双语索引）→ `docs/产品说明书-终版.md`（权威口径）→ `docs/产品0-1计划.md`（执行计划）→ `docs/需求说明书-终版.md`（RQ）→ `AI红蓝对抗报告.md`（安全完备性）→ `PRODUCT-DOC-AUDIT.md`（文档审计）→ `impl/审计记录-DDD综合.md`（DDD 架构审计 7 维度全通过）
- **接收方建议动作**：
  1. 先读本文件 §2–§4，再按需进文档入口链
  2. 验证环境：`node --version`（≥20，node:test 内置，零依赖）
  3. 运行 §4 测试命令确认基线（274/274 全绿）
  4. 阅读 M0-T 选型决策：`impl/m0-t/选型决策记录.md`（8 层选型 + 替换条件）
  5. M5 编排层参考：`impl/m5/README.md`（Outbox + 五步串联 + 审计链）
  6. M6 走查参考：`impl/m6/README.md`（评测门禁 + 四角色走查 + 适配器契约）
  7. **无外部凭据需要**（纯领域模型 + 零依赖；真实部署需模型 API Key + SSH 目标机 + 证书，届时向用户索取）

## 2. 当前状态快照

| 域 | 状态 |
|----|------|
| 基础文档集 `docs/`（9 份） | ✅ 终版 · 审计 100/100 |
| 红蓝对抗 | ✅ 十轮收敛（96 处修复固化）· 报告 `AI红蓝对抗报告.md` |
| M0 基线/选型/DDD 设计 | ✅ `impl/m0-baseline|m0-t|m0-d`（42 不变量，选型决策 8 层已记录，DDD 审计 12 轮收敛） |
| M1 观测（obs） | ✅ `impl/m1` · 43 测试 |
| M2 对话（conv） | ✅ `impl/m2` · 56 测试 |
| M3 信任（trust） | ✅ `impl/m3` · 59 测试 |
| M1/M2/M3 严格审计 | ✅ 157 波 + DDD 综合审计全通过 · 483 项确认/修复 · 连续 51 波零缺陷 |
| M4 执行闭环 | ✅ `impl/m4` · 27 测试 |
| M5 整合 + 审计 | ✅ `impl/m5` · 59 测试（Outbox + 五步串联 + 审计链 + INV-U2/U4/U5 + 审批审计 + metric BC） |
| M6 内测上线走查 | ✅ `impl/m6` · 30 测试（model BC 门禁 + 四角色走查 + 适配器契约定型） |
| 真实部署 | ⬜ 未开始 |

**版本控制**：git `main` 分支 · 远端 `github.com/NinjaSln-labs/voyage`（public，MIT）· 提交规范 Conventional Commits

**构建环境**：零依赖（纯 JS + node:test），无 node_modules/构建产物；Node ≥20 即跑

**最近完成**（`git log` 为详情权威）：
- `975bb9c` feat(m5,m6): 整合+审计+内测上线（M5 34 测试 + M6 21 测试，全量 235/235）
- M0-T 选型决策记录：8 层选型（感知/决策/知识/执行/入口/模型/审计/认证），全部 MIT/Apache-2.0
- M5 Outbox 事务边界落地 + 五步判定点串联 + AppendOnlyAuditChain 哈希链（13 维度审计通过）
- M6 评测门禁 GateService + 四角色×五旅程端到端走查 + 六类真实适配器契约定型（ADAPTER-CONTRACTS.md）
- M4 执行闭环落地（`a11ffad`，27 测试）

**占位/未完成边界（防误判）**：
- M1/M2 的 `intentModel`（模型 API）端口是**适配点**，未接真实模型——M0-T 选型已锁定（DeepSeek→SiliconFlow→Ollama）
- M3 审批-执行同事务（Outbox）**M5 编排层已落地**（OutboxJournal + resolveApproval → exec 异步启动）
- M5/M6 真实适配器（mTLS/WebAuthn/SSH/审计持久/角色-资产仓储）以契约端口+stub 声明——归真实部署阶段
- 评测集样本（口语/知识/高危/术语/解释/FAQ 各 ≥30~50 条）清单已有，样本未建——归 M0-T 后续
- 聚合阈值（30 分钟/≥3 次/≥10 台等）为目标值，**未实测校准**（按 `docs/指标口径.md` 双态原则）
- 所有领域对象全只读化（Date getter 拷贝、值对象不可变）——M5/M6 新增聚合已遵循同标准

## 3. 下一步与验证点

**立即待办（真实部署阶段）**：
- **六类真实适配器实现**：按 `impl/m6/ADAPTER-CONTRACTS.md` 逐一替换契约 stub——mTLS/WebAuthn 认证、SSH 被管机执行（ssh2）、审计持久化（SQLite）、角色-资产仓储、模型 API 接入
- **评测集样本初建**：按三集制（口语≥50/知识≥50/高危≥30/术语≥30/解释≥30/FAQ≥30）建 JSON 样本集
- **模型 API 接入**：按 M0-T 选型（DeepSeek 主 → SiliconFlow 降级 → Ollama 兜底），接 M5 convPort
- **梯度放量**（Later）：1% → 10% → 50% → 100%，每档对比基线（成功率/时延/成本）

**外部依赖来源**：真实部署阶段需用户提供——模型 API Key（DeepSeek/SiliconFlow）、SSH 目标机（测试用）、mTLS 证书、WebAuthn 依赖（浏览器端）

## 4. 即时操作

```bash
# 测试（零依赖，全量 274/274：M1~M6）
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
- M5 `_handledIntentIds` Set 上限 10000——长会话超量返回 ERROR（防内存无限增长）

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
| 质量基调（防御矩阵 18 节） | `impl/完美收官-质量基调.md` |
| 严格审计记录（157 波） | `impl/审计记录-第{7..157}波.md` |

## 6. 维护规则

- **更新时机**：每个里程碑完成、重大决策、新 session 开始交接时
- **防双源**：本文件只记 delta；架构/需求/设计一律引用 §5 路径，禁止复制
- **滚动归档**：跨周期的旧 delta 移入 `HANDOFF-ARCHIVE/cycles.md`；确认修复的坑 → `pits.md`，完成的待办 → `done.md`
- **回填约定**：里程碑完成 → 更新 §2 快照 + §3 下一步 + 回填 git hash；确认完成项迁 `HANDOFF-ARCHIVE/`
- **脱敏**：无 Key/密码/PII；凭据路径引用不写值
