# ADR-005：矩阵强制点的 egress 边界——外传由 ADR-001 审批轴治理，不纳入角色矩阵

**状态**：已接受 · **日期**：2026-09-24 · **关联**：ADR-003（部分修订其 egress 覆盖条款）、ADR-001（数据外传审批）、ADR-002 / INV-E7、RQ-415 / RQ-631 / RQ-632、p000046

## 背景

ADR-003 裁决「矩阵强制点提前至编排层 `conv.interpret` 出口后」，其**覆盖范围**表述为「read/write/egress/authorize **全部** actionClass」。

实现该 ADR 时（t000033，`7e6727e`）暴露其 egress 条款与现状冲突：

| 事实 | 证据 |
|---|---|
| §4.2 矩阵**无**「数据外传」行 | `docs/产品说明书-终版.md` §4.2 行清单 |
| 四个角色**均无** egress 能力 | `ROLE_CAPABILITIES`：sre/dev/test/manager 皆无 `egress_*`（`impl/m5/src/repo/repo-identity.js:17-22`） |
| egress 由 ADR-001 双人审批治理 | ADR-001；编排层 egress → 信任预检 → `pending_approval` |
| egress 审批流已被测试锚定 | `compose.test.js` F15/F17：egress → `NEED_REVIEW`（`_highRiskType=egress_send`） |

按 ADR-003 字面（角色能力判定）实现 → `hasCapability('egress_send')` 对**任何**角色恒假 → **全部外传被 `REJECTED`**，直接破坏 ADR-001 的审批流。这是一个产品级回归，而非安全加固。

## 问题

**矩阵（能力 × 角色）是否应覆盖 egress 类能力？**

## 决策

**不覆盖。** egress 类能力**豁免**角色矩阵前置判定；`read` / `write` / `authorize` 全覆盖。

### 具体设计

1. 编排层矩阵前置校验（`impl/m5/src/integration/domain.js`）：`if (capability && !EGRESS_CAPABILITIES.includes(capability)) { …角色能力判定… }`。
2. egress 类能力跳过角色判定，**仍**继续走下方信任预检 → 高风险（`RISK_LEVEL=high`）→ **ADR-001 双人审批**；审批即闸门（叠加外传目标域白名单，附录 C）。
3. **位置约束不变**：校验点仍在所有分支之前，egress 无法「逃逸强制点」——它只是不受角色**能力**约束，审批义务不受影响。

### 理由

- 矩阵是 `capability × role` 二维；egress 在 §4.2 中**不是角色能力**（无行），把它塞进角色维度无依据。
- 外传风险由**审批 + 目标域白名单**承载（ADR-001），与「谁能用某能力」是两个正交关注点——同 ADR-002 的「能力定义决定安全」与 ADR-001 的「外传审批」分工。
- 「哪些角色可发起外传」需要产品定义，§4.2 未给；擅自授予即为发明产品规则。

### 关键不变量（INV-P3）

> egress 类能力不参与角色矩阵判定；外传仅经 ADR-001 审批轴（双人审批 + 目标域白名单）。矩阵强制点位于所有分支之前，egress 不得绕过审批义务。若未来产品明确「指定角色可外传」，则对 egress 改用角色能力判定——届时本 ADR 的豁免条款被修订，但「分支前强制点」不变。

### 备选与否决

| 方案 | 内容 | 否决理由 |
|---|---|---|
| A（字面覆盖） | egress 也走角色能力判定 | 无人持有 egress 能力 → 全部外传 `REJECTED` → 破坏 ADR-001 审批流与 F15/F17 锚定行为。 |
| B（给角色授 egress） | 在 `ROLE_CAPABILITIES` 给若干角色加 `egress_send` 等 | §4.2 无依据；属发明产品规则，须产品裁定，不能由实现层自决。 |
| **C（采纳）** | egress 豁免角色矩阵，走 ADR-001 审批轴 | —— |

## 影响

- **代码变更**：无（实现 `7e6727e` 已按 C 落地；本 ADR 将既有取舍形式化）。
- **ADR-003 修订**：其「覆盖全 actionClass（含 egress）」表述由本 ADR **部分修订**——egress 除外。ADR-003 正文保留，加修订指针。
- **需求侧**：`需求说明书-终版.md` 附录 C 明确「外传不纳入角色矩阵判定，由 ADR-001 审批轴独立治理」。
- **测试锚定**：`integration.test.js` MX7（egress 例外）；`compose.test.js` F15/F17（egress → NEED_REVIEW）。

## 未覆盖

| 项 | 处理 |
|---|---|
| 角色级 egress 控制（哪些角色可发起外传） | 待产品定义；届时另立 ADR 给指定角色授 egress，本 ADR 豁免条款随之修订。记 `.handoff/`。 |
| 外传目标域白名单的强制执行点 | 附录 C 已述（`egress_send` 目标域须预配置），实现归后续。 |

## 需求追溯

| 需求 | 本 ADR 的落点 |
|---|---|
| RQ-631（M）矩阵唯一口径 | 矩阵覆盖 read/write/authorize；egress 不属矩阵（无行） |
| RQ-632（M）全角色×能力对 100% 拦截 | egress 非角色能力对；外传由审批拦截 |
| 附录 C（`需求说明书-终版.md:277`）数据外传独立于查询 | egress 走 ADR-001 审批轴，不入矩阵判定 |
| ADR-001 数据外传审批 / ADR-003 强制点 | 修订 ADR-003 的 egress 覆盖条款 |
| p000046 | 本 ADR 闭合 |
