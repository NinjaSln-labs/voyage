# HANDOFF — 行舟 · Voyage

## 1. 交接元信息

- **日期**：2026-08-19 · **交接方**：本 session（agent）· **接收方**：后续 session / 开发者
- **原因**：M5 整合 + 审计落地完成（34 测试，audit 15 + integration 19）→ 交接到 **M6 内测上线**
- **项目一句话**：把运维能力民主化的 AI 运维平台——口语化低门槛 × 零信任审批（AIOps democratized）
- **文档入口链**：README（双语索引）→ `docs/产品说明书-终版.md`（权威口径）→ `docs/产品0-1计划.md`（执行计划）→ `docs/需求说明书-终版.md`（RQ）→ `AI红蓝对抗报告.md`（安全完备性）→ `PRODUCT-DOC-AUDIT.md`（文档审计）→ `impl/审计记录-DDD综合.md`（DDD 架构审计 7 维度全通过）
- **接收方建议动作**：
  1. 先读本文件 §2–§4，再按需进文档入口链
  2. 验证环境：`node --version`（≥20，node:test 内置，零依赖）
  3. 运行 §4 测试命令确认基线（180/180，经 157 波 + DDD 综合审计）
  4. 交接方为 **M5** 阅读：`impl/m0-d/DDD设计.md` §7（Outbox 事务边界）+ §6（五步判定点）+ §3（事件目录）；M4 参考 `impl/m4/README.md`（不变量↔测试映射）
  5. 了解审计经验沉淀：`impl/完美收官-质量基调.md` §7-18（防御矩阵 + 基调更新）
  6. **无外部凭据需要**（纯领域模型 + 零依赖；模型 API 接入属 M0-T/M2 适配器阶段，届时向用户索取）

## 2. 当前状态快照

| 域 | 状态 |
|----|------|
| 基础文档集 `docs/`（9 份） | ✅ 终版 · 审计 100/100 |
| 红蓝对抗 | ✅ 十轮收敛（96 处修复固化）· 报告 `AI红蓝对抗报告.md` |
| M0 基线/选型/DDD 设计 | ✅ `impl/m0-baseline|m0-t|m0-d`（42 不变量，严格审计 12 轮收敛） |
| M1 观测（obs） | ✅ `impl/m1` · 43 测试 |
| M2 对话（conv） | ✅ `impl/m2` · 56 测试 |
| M3 信任（trust） | ✅ `impl/m3` · 54 测试 |
| M1/M2/M3 严格审计 | ✅ 157 波 + DDD 综合审计全通过 · 483 项确认/修复 · 110 份审计记录 · 连续 51 波零缺陷 |
| M4 执行闭环 | ✅ `impl/m4` · 27 测试（H/E/G/A/S 五类）· 全量基线 180/180 全绿（`a11ffad`） |
| M5 整合 / M6 上线 | ⬜ 未开始 |

**版本控制**：git `main` 分支 · 工作区干净（0 未提交）· 远端 `github.com/NinjaSln-labs/voyage`（public，MIT）· 提交规范 Conventional Commits

**构建环境**：零依赖（纯 JS + node:test），无 node_modules/构建产物；Node ≥20 即跑

**最近完成**（详情在 commit message，`git log` 为详情权威；摘要一行式）：
- M4 执行闭环落地：`impl/m4` 27 测试全绿，全量基线 180/180（`a11ffad`）
- `41f9463` docs(m4): M4 执行闭环设计方案评审（INV-E1~E5 + exec.start 契约 + 附录C 参数schema + 事件订阅）
- `c54a878` docs(audit): 严格 DDD 综合审计（7 维度全通过——聚合边界/贫血/依赖/语言/战术/一致性/上下文映射）
- 第 7~157 波审计（`8fb79c6`→`58a3765`，73 个提交）：从 78/78 到 153/153，累计 483 项确认/修复，连续 51 波零缺陷
- 标志性修复：Unicode 零宽/疑问词缀/否定词面/白名单强制/Grant 签发链/跨资产聚合/Date 引用共享/封装性（Approval.votes 防伪造）/值对象不可变/聚合窗口 O(log n) 性能
- 防御矩阵：`impl/完美收官-质量基调.md` §7-18（16 节，20+ 行防御规则）
- DDD 综合审计：`impl/审计记录-DDD综合.md`（富聚合/单向依赖/统一语言/战术模式/建模一致性/上下文映射 全通过）
- `384ebdc` docs: 脱敏——模糊化 P2 画像运营规模细节（public 发布）

**占位/未完成边界（防误判）**：
- M1/M2 的 `intentModel`（模型 API）端口是**适配点**，未接真实模型——测试用 stub
- M3 `ApprovalFlowService` 的审批-执行同事务（Outbox）在领域层声明、**编排层未实现**（归 M5）；领域层已闭环：批准即签发 Grant、吊销广播 GrantRevoked、显式拒绝 reject、跨资产聚合、白名单强制
- 聚合阈值（30 分钟/≥3 次/≥10 台等）为目标值，**未实测校准**（按 `docs/指标口径.md` 双态原则）
- 无真实被管机/监控源/IM/IdP 集成——全部为领域模型契约
- 事件重放去重（at-least-once）在领域层无状态记录——归编排层 Outbox 消费端（M0-D §7）
- 所有领域对象全只读化（Date getter 拷贝、值对象不可变、读接口不暴露内部引用）——M5 及后续新增聚合须遵循同标准

## 3. 下一步与验证点

**立即待办（M5 整合 + 审计，C8/C9/C2 收口）**：
- **M5 整合入口 + Outbox 事务边界**：审批-执行-审计同事务用 Outbox（M0-D §7.1），消费端消息 ID 幂等去重、失败指数退避、超限死信并告警（INV-N2）
- **五步权限判定点串联**（M0-D §6）：意图层→拆解前→执行前→审批链→审计，服务端强制
- **真实被管机执行适配器 / SSH 凭据保险库**：接真实执行归一化适配器（凭据经 vault 端口引用）
- **资产/矩阵/白名单/角色真实仓储**：替换 M4 契约 stub 为真实适配器
- M4 交付已归档 `HANDOFF-ARCHIVE/done.md`（验收标准见 `impl/m4-方案评审.md` §7，上线前逐条核对）
- 随后：M6 内测上线（DoD-A+B 全过、反指标 0、评测门禁）

> M5 消费的 M3 事件链路（GrantIssued/Revoked/Expired/AggregationEscalated/ApprovalRejected/TimedOut/CapabilityDenied）在 M4 已实现幂等去重订阅（`impl/m4/src/exec/domain.js`），M5 编排层接线即可。

**外部依赖来源**：无（M0-T 真实选型/POC 时向用户索取模型 API 偏好与环境）

**风险提醒**：
- M3 审批超时「同事务」目前是领域层传 `now` 保证判定一致，**跨服务原子性未实现**——M5 必须用 Outbox/Saga 落
- 评测集（`impl/m0-baseline`）只建了清单未建样本——M0-T 后按三集制初建
- 基础文档改动需保持审计 100/100（改后跑 `PRODUCT-DOC-AUDIT.md` 的交叉验证项）

## 4. 即时操作

```bash
# 测试（零依赖，全量 180/180：M1 43 + M2 56 + M3 54 + M4 27）
find impl -name "*.test.js" | xargs -I{} sh -c 'cd $(dirname {}); node --test $(basename {})'
cd impl/m4 && node --test test/exec.test.js   # M4 执行闭环

# git
git log --oneline          # 详情权威（约 90+ commits）
git status                 # 应为干净

# 推送（main 已 track origin）
git push
```

**已知坑（未修，仍会踩）**：
- M1 快照 metrics 结构是 `{count, samples}`（非纯数组）——消费方适配器按此解析
- M2 `recognize` 输入限 4096 字符、否定/疑问句强制 query——语义判定规则集中，改动需回归 S17~S41
- 领域 getter 不能带参数（JS 语法）——M3 曾踩，后续写 `isExpired(now)` 用方法不用 getter
- 语义判定（疑问/否定/动词）必须在**归一化视图**统一判定（原始串/归一化串双视图不一致=绕过面）——新增语义判定一律先归一化
- 事件协议跨 BC 统一（schemaVersion+eventId+深冻结载荷）；新增 BC 事件必须对齐，不得私有协议
- 领域构造参数（时间/数值/ID）一律「正有限+显式类型+长度上限」校验；字符串隐式转 Date 是静默错误源
- M4 exec：参数 schema 在 **Job 构造即校验**（不允许先建后查）；clean 需同时 `command` + `path`（路径走 LOG_DIR_WHITELIST）——改规则须回归 M4 E3/A4
- M4 exec 端口为 stub（trust/asset/matrix/audit）——repo 方法是**同步**（服务同步调用 findById），接真实适配器时保持同契

## 5. 引用索引（主题 → 权威文档）

| 主题 | 权威路径 |
|------|---------|
| 架构/能力/矩阵/规则 | `docs/产品说明书-终版.md` |
| 需求 RQ / 验收锚点 / 追溯 | `docs/需求说明书-终版.md`（§2/§6/§9） |
| 执行计划 / 里程碑 / DAG | `docs/产品0-1计划.md` |
| 指标口径 / 反指标 | `docs/指标口径.md` |
| 评测门禁 / 三集制 | `docs/AI评测策略.md` |
| 完成定义 | `docs/DoD 门禁.md` |
| 白名单能力清单 | `需求说明书-终版.md` 附录 C |
| 安全完备性（红蓝 96 修复） | `AI红蓝对抗报告.md` |
| 文档审计 | `PRODUCT-DOC-AUDIT.md` |
| DDD 设计（42 不变量） | `impl/m0-d/DDD设计.md` |
| M4 方案评审（7 节设计决策 + 验收标准） | `impl/m4-方案评审.md`（`41f9463`） |
| 质量基调（审计标准 + 防御矩阵 18 节） | `impl/完美收官-质量基调.md` |
| 各里程碑代码 | `impl/m1|m2|m3|m4/`（README 含不变量↔测试映射） |
| 严格审计记录（157 波） | `impl/审计记录-第{7..157}波.md` + `impl/审计记录-全维度.md` |
| DDD 架构审计（7 维度全通过） | `impl/审计记录-DDD综合.md` |

## 6. 维护规则

- **更新时机**：每个里程碑完成、重大决策、新 session 开始交接时
- **防双源**：本文件只记 delta；架构/需求/设计一律引用 §5 路径，禁止复制
- **滚动归档**：跨周期的旧 delta 移入 `HANDOFF-ARCHIVE/cycles.md`；**确认修复的坑 → `pits.md`，完成的待办 → `done.md`**（§4 的「未修坑」一旦确认修复立即归档）
- **回填约定**：里程碑完成 → 更新 §2 快照 + §3 下一步 + 回填 git hash；确认完成项迁 `HANDOFF-ARCHIVE/`（坑→`pits.md`，待办→`done.md`）
- **脱敏**：无 Key/密码/PII；凭据路径引用不写值
- **决策日志**：阶段裁定（如需）→ `docs/decisions/` ADR，只引用编号不复制
