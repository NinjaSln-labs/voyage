# HANDOFF — 行舟 · Voyage

## 1. 交接元信息

- **日期**：2026-08-19 · **交接方**：本 session（agent）· **接收方**：后续 session / 开发者
- **原因**：到达里程碑（M3 完成 + git 发布 + 脱敏），准备阶段性交接
- **项目一句话**：把运维能力民主化的 AI 运维平台——口语化低门槛 × 零信任审批（AIOps democratized）
- **文档入口链**：README（双语索引）→ `docs/产品说明书-终版.md`（权威口径）→ `docs/产品0-1计划.md`（执行计划）→ `docs/需求说明书-终版.md`（RQ）→ `AI红蓝对抗报告.md`（安全完备性）→ `PRODUCT-DOC-AUDIT.md`（文档审计）
- **接收方建议动作**：
  1. 先读本文件 §2–§4，再按需进文档入口链
  2. 验证环境：`node --version`（≥20，node:test 内置，零依赖）
  3. 运行 §4 测试命令确认基线（78/78）
  4. 继续 M4 前阅读 `impl/m0-d/DDD设计.md` §2.4（作业聚合 INV-E1~E5）+ §4（exec.start 契约）
  5. **无外部凭据需要**（纯领域模型 + 零依赖；模型 API 接入属 M0-T/M2 适配器阶段，届时向用户索取）

## 2. 当前状态快照

| 域 | 状态 |
|----|------|
| 基础文档集 `docs/`（9 份） | ✅ 终版 · 审计 100/100 |
| 红蓝对抗 | ✅ 十轮收敛（96 处修复固化）· 报告 `AI红蓝对抗报告.md` |
| M0 基线/选型/DDD 设计 | ✅ `impl/m0-baseline|m0-t|m0-d`（42 不变量，严格审计 12 轮收敛） |
| M1 观测（obs） | ✅ `impl/m1` · 25 测试 |
| M2 对话（conv） | ✅ `impl/m2` · 36 测试 |
| M3 信任（trust） | ✅ `impl/m3` · 17 测试 |
| M4 执行 / M5 整合 / M6 上线 | ⬜ 未开始 |

**版本控制**：git `main` 分支 · 12 commits · 工作区干净（0 未提交）· 远端 `github.com/NinjaSln-labs/voyage`（public，MIT）· 提交规范 Conventional Commits

**构建环境**：零依赖（纯 JS + node:test），无 node_modules/构建产物；Node ≥20 即跑

**最近完成**（详情在 commit message，`git log` 为详情权威）：
- `384ebdc` docs: 脱敏——模糊化 P2 画像运营规模细节（public 发布）
- `4fd5a22` docs: README 中英双语 + 路线图披露 + 徽章
- `4295f55` chore: 添加 MIT License
- `e9d15e2` feat(trust): M3 信任模型（17/17）
- `1557332` feat(conv): M2 口语对话层（36/36）
- `d34ad0a` feat(obs): M1 观测底座（25/25）

**占位/未完成边界（防误判）**：
- M1/M2 的 `intentModel`（模型 API）端口是**适配点**，未接真实模型——测试用 stub
- M3 `ApprovalFlowService` 的审批-执行同事务（Outbox）在领域层声明、**编排层未实现**（归 M5）
- 聚合阈值（30 分钟/≥3 次/≥10 台等）为目标值，**未实测校准**（按 `docs/指标口径.md` 双态原则）
- 无真实被管机/监控源/IM/IdP 集成——全部为领域模型契约

## 3. 下一步与验证点

**立即待办（M4 执行闭环，C8/C9/C2）**：
- 建 `impl/m4`，按 M0-D §2.4（INV-E1~E5）+ §4（exec.start 契约）落地作业聚合
- 消费 M3 的 `GrantIssued/GrantRevoked` 事件（exec 订阅）
- 关键不变量：聚合升级标志置位 → 挂起转审批（INV-E2）；执行中 Grant 吊销 → 已启动完成+未启动拒绝（INV-E5）；白名单参数 schema（附录 C）
- 完成标准：happy/error/edge/adversarial 测试全绿 + 按 `impl/完美收官-质量基调.md` 审计

**外部依赖来源**：无（M0-T 真实选型/POC 时向用户索取模型 API 偏好与环境）

**随后路线**：M4 → M5 整合入口+审计（Outbox 事务边界、五步权限判定点串联、审计五元组）→ M6 内测上线（DoD-A+B 全过、反指标 0、评测门禁）

**风险提醒**：
- M3 审批超时「同事务」目前是领域层传 `now` 保证判定一致，**跨服务原子性未实现**——M5 必须用 Outbox/Saga 落
- 评测集（`impl/m0-baseline`）只建了清单未建样本——M0-T 后按三集制初建
- 基础文档改动需保持审计 100/100（改后跑 `PRODUCT-DOC-AUDIT.md` 的交叉验证项）

## 4. 即时操作

```bash
# 测试（零依赖）
cd impl/m1 && node --test test/obs.test.js
cd impl/m2 && node --test test/conv.test.js
cd impl/m3 && node --test test/trust.test.js
find impl -name "*.test.js" | xargs -I{} sh -c 'cd $(dirname {}); node --test $(basename {})'

# git
git log --oneline          # 详情权威
git status                 # 应为干净

# 推送（main 已 track origin）
git push
```

**已知坑（未修，仍会踩）**：
- M1 快照 metrics 结构是 `{count, samples}`（非纯数组）——消费方适配器按此解析
- M2 `recognize` 输入限 4096 字符、否定/疑问句强制 query——语义判定规则集中，改动需回归 S17~S22
- 领域 getter 不能带参数（JS 语法）——M3 曾踩，后续写 `isExpired(now)` 用方法不用 getter

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
| 质量基调（审计标准） | `impl/完美收官-质量基调.md` |
| 各里程碑代码 | `impl/m1|m2|m3/`（README 含不变量↔测试映射） |
| 严格审计记录 | `impl/审计记录-*.md` |

## 6. 维护规则

- **更新时机**：每个里程碑完成、重大决策、新 session 开始交接时
- **防双源**：本文件只记 delta；架构/需求/设计一律引用 §5 路径，禁止复制
- **滚动归档**：跨周期的旧 delta 移入 `HANDOFF-ARCHIVE/cycles.md`；**确认修复的坑 → `pits.md`，完成的待办 → `done.md`**（§4 的「未修坑」一旦确认修复立即归档）
- **回填约定**：M4 完成 → 更新 §2 快照 + §3 下一步 + 回填 git hash
- **脱敏**：无 Key/密码/PII；凭据路径引用不写值
- **决策日志**：阶段裁定（如需）→ `docs/decisions/` ADR，只引用编号不复制
