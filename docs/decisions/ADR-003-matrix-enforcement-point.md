# ADR-003：矩阵服务端强制点提前至编排层（全 actionClass 覆盖）

**状态**：已接受 · **日期**：2026-09-24 · **关联**：ADR-002（能力定义决定安全决策）、INV-E7

## 背景

ADR-002 确立了「安全决策由能力定义的风险等级决定」（INV-E7）。但矩阵（能力×角色）的**强制点位置**从未被裁决：

- 需求侧义务是明确的——`docs/需求说明书-终版.md:277`（附录 C）：「查询类能力（C1–C7 只读面）不属执行白名单范围，**按 §4.2 矩阵角色权限执行**」；RQ-631（M）：「服务端强制校验」；RQ-632（M）：「对全部角色×能力对执行越权样本集，拦截率 100%」。
- 实现侧强制点只有一个：`compose.js:186` `matrixPort.isAllowed`，注入 M4 `ExecutionService`，仅在 `execStart` 生效。
- 结果：`integration/domain.js:104`（read 分支）与 `:133`（execute-low 分支）两处放行路径**完全不查矩阵**。manager（能力 `['query_health','query_metric','audit_summary']`，无 query_status/query_log）实测查询一律 `OK`，违反 §4.2 管理者栏 ❌ 单元格。
- `AI红蓝对抗报告.md:207` 早已把「矩阵校验时点未定义」记为 B-03 未闭合项。

本 ADR 裁决强制点位置，闭合该缺口。

## 问题

矩阵校验义务已定义、强制点未定义、实现缺失。三处分散，其中一处是本 ADR 的落点：

| 项 | 状态 |
|---|---|
| 校验义务（RQ-631 服务端强制 / RQ-632 全角色×能力对） | 明确定义 |
| 强制点位置 | **未定义**（DDD §6 五步判定点无读路径步骤） |
| 实现 | 缺失（仅 m4 execStart 一处） |

manager 排除 query_status/query_log **是有意边界**，不是遗漏——§4.2 管理者栏明确 ❌，`repo.test.js:35` 已锚定 `!mgr.hasCapability('query_log')`。缺陷只落在「读路径不做分级校验」这一实现行为上。

## 决策

**矩阵校验的唯一权威点在编排层 `IntegrationService.handle/handleAsync`，位置在 `conv.interpret` 出口之后、所有分支决策之前，覆盖全部 actionClass。**

### 核心变化

| 维度 | 现状 | ADR-003 |
|---|---|---|
| 强制点 | m4 `execStart`（仅执行路径） | 编排层 `conv.interpret` 出口后（全路径） |
| 覆盖范围 | write/egress（经 exec） | read/write/egress/authorize 全部 |
| 编排层依赖 | conv/trust/exec/audit/notify | **新增 identityPort** |
| 低/高风险读 | 直接放行 | 先过矩阵，再按风险等级分流 |
| 审计 reason | exec 路径 `capability_not_allowed_by_matrix` | 同码（跨层一致） |

### 强制点备选与取舍

| 方案 | 强制点 | 否决理由 |
|---|---|---|
| **A（采纳）** | 编排层 `conv.interpret` 出口后 | —— |
| B | M3 信任层 `handleExecIntent` | 信任层零身份引用（grep 证实），需引入 identityPort，BC 耦合从编排层下移到信任 BC，违反「矩阵是应用级关注点」 |
| C | 读/执行分支各补一处 | 分散补检：当前两处，未来新增分支仍会漏。补丁式修复，不可扩展 |

采纳 A 的关键理由：矩阵校验是**应用级关注点**（横切 conv↔trust↔exec↔audit），归编排层职责——`integration/domain.js:2` 已声明该层「横切职责，不承载领域状态」，加 identityPort 符合其定位。

### 具体设计

1. **新增端口**：`identityPort{findById(id) → Identity|null}`，`Identity.hasCapability(cap)` 为判定入口。
2. **判定位置**：`integration/domain.js` `conv.interpret` 成功返回且解构出 `actionClass/capability` 之后，立即校验：
   - `!capability`（能力缺失/模型未输出）→ **跳过**矩阵校验，走既有风险等级分流（无能力定义时矩阵无从裁决，不新增 fail-closed 行为）。
   - 身份不存在或 `active=false` → `REJECTED, reason: 'capability_not_allowed_by_matrix'`（fail-closed，与 m4 同码）。
   - `!ident.hasCapability(capability)` → 同上。
   - 通过 → 继续既有风险等级分流（low 放行 / high 审批 / critical 拒绝），ADR-002 不变。
3. **m4 校验保留**：`execStart` 的矩阵判定不删——它是执行前的最后一道门，防绕过编排层直调 `exec.start`（`compose.test.js` F4 已锚定该路径）。两层同码，语义一致。
4. **与 ADR-002 的关系**：不冲突。ADR-002 定「风险等级决定放行/审批/拒绝」，ADR-003 定「矩阵是风险等级分流的前置闸门」。矩阵 ❌ 优先于风险等级裁决（拒绝 > critical > high > low），对齐附录 C 裁决优先级。

### 关键不变量（INV-P2）

> 矩阵校验在编排层入口单次执行（`conv.interpret` 出口后、任何分支决策前），覆盖全部 actionClass，不随分支数量变化而漏检。矩阵 ❌ 拒绝优先于风险等级裁决。执行层保留矩阵判定作为最后一道门。身份不存在/停用一律拒绝（fail-closed）。新增/修改 actionClass 分流分支不得绕过本判定点——该约束由位置（分支之前）保证，不依赖各分支自觉。

## 影响

### 行为变更（产品级语义变化）

| 场景 | 现状 | 变更后 |
|---|---|---|
| manager 查 query_status | `OK` | `REJECTED, capability_not_allowed_by_matrix` |
| manager 查 query_log | `OK` | `REJECTED` |
| sre/dev/test 查询 | `OK` | `OK`（不变——三者含全部 QUERY_CAPABILITIES） |
| 任何角色 execute | 经审批 → m4 矩阵 | 前置矩阵校验 + m4 再校验（双层） |

⚠️ 受影响面比预期窄：`sre`/`dev`/`test` 都含全部 `QUERY_CAPABILITIES`，只有 `manager`（`['query_health','query_metric','audit_summary']`）会新增 REJECTED 路径。行为变更的实际触发者是 manager 一个角色。

⚠️ 附带发现：manager 的 `audit_summary` 不在 `CAPABILITIES`（模型能力单源）内，模型永不可能输出该能力——即 `audit_summary` 属角色扩展能力（同 `approve`/`audit_query`/`schedule`），与 `CAPABILITIES` 是两个正交集合。这不是 ADR-003 范围，但矩阵判定 `hasCapability('audit_summary')` 对模型路径永远是「能力不存在→跳过矩阵校验」，记入 `.handoff/`。

⚠️ 这是**行为变更，不是纯修 bug**：`OK` → `REJECTED`。需同步评估 UI 菜单（「不同角色不同菜单」——manager 菜单本就不该出现 query_status 入口，见 RQ-415 后半句）与前端交互文案。

### 现有测试需更新

- `compose.test.js:266`（u9 manager）——需确认其用例是否依赖 manager 查询放行。
- `integration.test.js` 读路径用例——manager 身份用例预期需从 OK 改为 REJECTED。
- 新增：`integration.test.js` 矩阵前置校验用例（有/无身份、有/无能力、active=false 四象限）。

### 实现依赖

- `compose.js` 需向 `IntegrationService` 注入 identityPort（identityRepo 已在 compose 构造，接线即可）。
- 各测试的 `IntegrationService` 直构需补 identityPort 桩。

## 未覆盖

| 项 | 处理 |
|---|---|
| `integration/domain.js:133` execute-low 分支 | 本 ADR 的位置裁决自动覆盖（前置校验在其之前），无需单独补检 |
| 「查询侧无副作用铁律」实现锚点 | 未定义（附录 C 只写原则），另立缺口 |
| RQ-415「命令权限」是否含读 | 本 ADR 按「矩阵覆盖全能力」执行（RQ-631/632 已明确）；RQ-415 原文表述需在下一版需求修订中统一，记入 `.handoff/` |
| `domain.js:137` execute-low 分支未加 degraded 门禁 | 当前不可达（degraded 恒归一化为 read/query_status），但属对称缺口。若未来 degraded 归一化逻辑变更需一并补，记入 `.handoff/` |

### RISK_LEVEL 与 EXEC_CAPABILITIES 的隐含耦合

`RISK_LEVEL` 中执行能力（restart/clean/scale/config_change/env_switch）全为 `high`，`EXEC_CAPABILITIES ∩ {low}` 为空，故 `:133` low 放行分支当前不可能被执行能力命中。

这是**结构耦合而非文档约定**：若未来向 `EXEC_CAPABILITIES` 新增能力而遗漏同步 `RISK_LEVEL`，该分支将对执行能力自动放行，产生审批绕过。本 ADR 未强制此同步（属能力定义变更流程，同 INV-K4/INV-E7 口径），但记录为已知风险。

## 需求追溯

| 需求 | 本 ADR 的落点 |
|---|---|
| RQ-631（M）服务端强制 | INV-P2 位置裁决 |
| RQ-632（M）全角色×能力对 100% 拦截 | 覆盖全部 actionClass |
| RQ-415（M）细粒度权限（§4.2 唯一口径） | 矩阵作为唯一口径前置闸门 |
| 附录 C（`docs/需求说明书-终版.md:277`）查询类按矩阵执行 | 读路径纳入强制范围 |
| B-03 矩阵校验时点未定义（`AI红蓝对抗报告.md:207`） | 本 ADR 闭合 |
| ADR-002 / INV-E7 | 不冲突，矩阵为前置闸门 |
