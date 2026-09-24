# ADR-004：§4.2 矩阵行粒度与能力码粒度的对齐（矩阵行↔能力码映射单源）

**状态**：已接受 · **日期**：2026-09-24 · **关联**：ADR-003（矩阵强制点提前至编排层）、ADR-002 / INV-E7（能力定义决定安全决策）、RQ-415 / RQ-631 / RQ-632、p000044

## 背景

`docs/产品说明书-终版.md` §4.2「能力 × 角色权限矩阵（唯一口径）」的**行**是产品功能粒度，而系统实际执行粒度是**能力码**（`impl/m5/src/shared-capabilities.js`：查询 4 + 执行 5 + egress 3 = 12 个码）+ 角色扩展码（`approve` / `audit_query` / `audit_summary` / `schedule`，见 `impl/m5/src/repo/repo-identity.js`）。两类粒度非 1:1，产生 p000044。

唯一会触发**产品级可感知错误**的单元格是管理者（manager）：

| §4.2 行 | 管理者 | 对应能力码 | 问题 |
|---|---|---|---|
| 监控指标 / 服务状态查询 | ✅ 大盘 | `query_metric` / `query_status`（行内捆绑两码） | 一行捆绑两码，粗细不一 |
| 日志查看 | ❌ | `query_log` | 一致 |
| 告警 / 健康报告查看 | ✅ | `query_health` | 一致 |
| 部署状态查看 | ❌ | 无 | 无对应能力码 |

现状：`ROLE_CAPABILITIES.manager = ['query_health','query_metric','audit_summary']`（`repo-identity.js:21`），不含 `query_status` / `query_log`。

ADR-003 已裁决矩阵强制点提前至编排层（覆盖全 actionClass），其**行为变更**之一即「manager 查 `query_status` → `REJECTED`」。若 §4.2 行1 的「服务状态查询 ✅大盘」按字面映射到 `query_status`，则 ADR-003 落地后会拒绝 manager 的合法大盘查询——**可感知的产品错误**。本 ADR 裁决粒度对齐口径，消除该歧义，使 ADR-003 可直接落地。

### 关键证据

- t000033（ADR-003 实现）验收锚点明确要求：manager 查 `query_status` / `query_log` 变 **REJECTED**——即 manager **不应**持有 `query_status`。
- `impl/m6/test/e2e-journey.test.js:64`（J7）已用 `query_metric` 建模「管理员大盘」。
- `impl/m5/test/repo.test.js:33`（I1）锚定 manager 持 `query_metric` / `query_health`、无 `query_status` / `query_log`。
- `docs/产品说明书-终版.md` §2 / §4.1、`docs/用户画像.md` P4：管理者 = 只读（大盘视图）= 健康 / 资源 / 成本大盘。

## 问题

矩阵行粒度（产品功能）与能力码粒度（模型可匹配意图 + 服务端判定单位）不匹配，且无显式映射：

| 项 | 状态 |
|---|---|
| 矩阵作为唯一口径（RQ-415 / RQ-631） | 已定义 |
| 行 ↔ 能力码映射 | **未定义**（无法机检一致性） |
| `query_status` 语义（服务状态 vs 部署状态） | **未澄清** |

## 决策

**以能力码为唯一可执行粒度；新增「矩阵行 ↔ 能力码」显式映射为版本化单源；不改能力码词表。**

### 具体设计

1. **`query_status` 语义定义**：资产 / 服务 / 部署**状态明细**（per-asset 明细查询）。管理者 ❌，与 ADR-003 及 t000033 一致。
2. **管理者「大盘」的口径**：由**已有** `query_metric` + `query_health` 承载（§2 / §4.1 / 画像 P4 一致）。§4.2 行1 管理者单元格「✅ 大盘」据此释义——**大盘 = `query_metric` + `query_health` 聚合视图**，不含 `query_status` 明细。
3. **§4.2 行1 拆分语义**：行1「监控指标 / 服务状态查询」捆绑 `query_metric`（监控指标）与 `query_status`（服务 / 部署状态明细）两码；矩阵行粒度比能力码粗，由显式映射表承载。
4. **新增映射单源**：`impl/m5/src/shared-capabilities.js` 导出 `MATRIX_ROW_CAPABILITIES`（§4.2 行标签 → 能力码数组），作为「行↔码」的唯一权威映射，供一致性测试机检。
5. **不新增能力码**：`CAPABILITIES` / `RISK_LEVEL` / `ROLE_CAPABILITIES` 保持不动，无行为变更。
6. **范围维度（scope）显式登记**：`大盘` / `自己负责的服务` / `相关服务只读` / `仅本人记录` 等范围限定词构成矩阵的**第三维（范围）**，当前**无服务端强制实现锚点**（附录 C 所述范围强制属阶段 2+ 桩）。本 ADR **只登记不实现**，记入 `.handoff/`，防「假安全」。

### 备选与否决

| 方案 | 内容 | 否决理由 |
|---|---|---|
| **A 新增能力码** | 新增 `query_overview`（大盘）/ `query_deploy`（部署状态）等 | `query_metric` + `query_health` 已构成大盘，再加码造出语义重复词汇；且须同步四处硬编码提示词（`cohere-adapter.js` / `agens-adapter.js` / `gen-redteam-weekly.js` / `model-api.js` 白名单）+ 三方同值测试 + 评测集，维护面扩大而收益为零。仅当产品确需 manager 独有的大盘码时才值得——与 t000033 验收锚点冲突。 |
| **B 角色内能力范围（scope 修饰）** | 能力码不变，判定加 scope 维度（如 manager `query_status` scope=`aggregate`） | 理论最优（矩阵本就含四个范围限定词），但**执行侧无任何「聚合 vs 明细 / 目标归属」强制实现**，现引入 scope 维度只会在判定契约上制造假安全，爆炸半径大。降级为路线图机制。 |

采纳 **C′**：零能力码变更，靠显式映射 + 文档口径对齐闭合。

## 影响

- **行为变更**：无（纯口径 + 一个声明式常量与测试）。`CAPABILITIES` / `RISK_LEVEL` / `ROLE_CAPABILITIES` 不变。
- **ADR-003 前置**：本 ADR 消除「manager 合法大盘被误拒」的语义歧义，ADR-003 可直接落地，t000033 的 `blockedBy` 前置解除。
- **需求基线修订**：`产品说明书-终版.md` §4.2 补映射说明与 `query_status` 语义；`需求说明书-终版.md` 附录 C 补指针、RQ-631 补「映射表为版本化单源」。
- **门禁**：映射表变更视同矩阵变更，走评测门禁 + 审计留痕（RQ-631 口径）。

### 现有测试

- `impl/m5/test/shared-capabilities.test.js`：新增映射锚定（映射值 ⊆ 能力码 ∪ 扩展码；管理者投影一致性；行1 双码捆绑）。
- 既有锚定保持：J7（管理员大盘 → OK）、I1（manager 无 `query_status` / `query_log`）不变。

## 未覆盖

| 项 | 处理 |
|---|---|
| 模型提示词引导（`大盘/整体/汇总/概况` → `query_metric`/`query_health`） | 属模型行为变更，须过评测门禁（`AGENTS.md`「AI 相关变更过评测门禁」）。本轮未做，记入 `.handoff/`；现行靠文档口径承担。 |
| 范围维度（scope）服务端强制 | 阶段 2+；本 ADR 仅登记，记入 `.handoff/`。 |
| RQ-415「命令权限」措辞与 RQ-631 口径统一（p000040） | 独立缺口，另立项，不在本 ADR 范围。 |
| 附录 C 查询侧无副作用铁律实现锚点（p000041） | 独立缺口，另立项。 |
| 角色扩展能力 `audit_summary` 在模型入口不可达（p000042） | 独立缺口，另立项。 |
| `EXEC_CAPABILITIES` 增能力须同步 `RISK_LEVEL`（p000043） | 能力定义变更流程风险，另记。 |

## 需求追溯

| 需求 | 本 ADR 的落点 |
|---|---|
| RQ-415（M）细粒度权限 / 不同角色不同菜单 | 矩阵行↔能力码映射单一来源 |
| RQ-631（M）矩阵唯一口径 / 版本化 | 映射表单源 + 版本化门禁 |
| RQ-632（M）全角色×能力对 100% 拦截 | 闭环前提：manager 合法大盘不被误拒、越权面清晰 |
| 附录 C（`需求说明书-终版.md:277`）查询类按矩阵执行 | `query_status` 语义定稿，读路径判定有据 |
| ADR-003 / INV-E7 / p000044 | 前者落地无产品错误；后者闭合 |
