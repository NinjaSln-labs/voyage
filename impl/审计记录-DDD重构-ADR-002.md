# 审计记录 — DDD 文档重构审计（ADR-002 C+D 方案）

> 日期：2026-08-30 · 审计对象：7 份修改后的 DDD 相关文档
> 范围：`DDD设计.md` + `需求说明书-终版.md` + `产品说明书-终版.md` + `指标口径.md` + `AI评测策略.md` + `ADR-001` + `ADR-002`

## 一、术语一致性检查

### 新术语在 7 份文档中的一致性

| 术语 | 出现次数 | 跨文档定义是否一致 | 问题 |
|------|---------|------------------|------|
| **action**（动作分类） | 5 份文档 | ✅ 一致——read/write/egress/authorize 四元 | 见 D1 |
| **capability**（能力） | 7 份文档 | ✅ 一致——从已有能力列表扩展 | — |
| **risk level**（风险等级） | 5 份文档 | ✅ 一致——low/high/critical 三级 | — |
| **egress 类能力**（egress_send 等） | 4 份文档 | ✅ 一致——作为独立能力而非布尔字段 | — |

### 发现

**D1（P1）**：审计五元组 `action` 字段与意图 `action` 分类**同名不同义**。

- 审计五元组（`DDD设计.md` §3 schema）：`action: { intent, capability, target, params-schema-ok }`——这里的 `action` 是"操作记录"（发生了什么操作），不是意图的"动作分类"。
- 意图值对象（`DDD设计.md` §5）：`Intent{action, capability, ...}`——这里的 `action` 是"动作分类"（read/write/egress/authorize）。
- 两者都叫 `action`，但语义不同：一个是审计事件的操作记录，一个是意图的粗粒度分类。

**影响**：查阅时容易混淆，新读者可能把审计五元组的 `action` 误解为意图的 `action` 分类。

**建议**：审计五元组保持 `action` 不变（已有大量代码和测试依赖），意图值对象的 `action` 改为 `actionClass` 或 `actionType`，或在文档中明确标注"意图的 action × 审计的 action 是不同概念"。

---

## 二、边界一致性检查

**DDD 设计文档的边界划分是否与新方案一致**：

| 边界 | 检查 | 结论 |
|------|------|------|
| 模型（model BC）只负责能力匹配，不参与安全决策 | DDD 设计 §1 统一语言 + §6 判定点 + §7 时序已更新 | ✅ 一致 |
| 安全决策在编排层（application orchestration） | §6 判定点第 1 步"能力风险等级决定安全路径" | ✅ 一致 |
| 能力定义由 shared-capabilities 单源管理 | 已有，不在此次改动范围 | ✅ 已有 |
| 信任层（M3）按能力风险等级审批 | HIGH_RISK_CAPABILITIES 已有 egress，需扩展 | ✅ 已有 |

**无边界矛盾。**

---

## 三、完整性检查

### 3.1 事件目录完整性

**D2（P2）**：`IntentReclassified` 事件载荷未定义 `action` 变更后的新 `action` 值。

- 当前定义：`IntentReclassified` | conv（服务端重分类） | trust | 动作分类变更标记（如 read→write、read→egress）
- 问题：载荷描述为"动作分类变更标记"，但没有明确变更后的 `action` 是否在事件中携带。trust 层需要知道变更后的 `action` 来决定审批路径。

**建议**：在事件载荷中明确携带 `newAction` 字段。

### 3.2 不变量完整性

**D3（P2）**：`authorize` 动作分类被定义为意图的四种动作之一，但**没有对应的能力实现**，也没有不变量描述它如何进入信任预检。

- DDD 设计 §1 统一语言定义 `authorize`（授权/管理类操作）
- 但能力列表（shared-capabilities.js）中目前没有 `authorize` 类能力
- INV-E1 已改为"非 read 类意图（write/egress/authorize）先过信任预检"，但 `authorize` 尚无实现路径

**建议**：① 在 DDD 设计文档中标注 `authorize` 为"预留/后续"；② 或在 ADR-002 中记录 `authorize` 的待实现状态。

---

## 四、耦合分析

| 调用方向 | 依赖 | 耦合度 |
|---------|------|--------|
| conv → model | 模型只输出 action+capability，不输出安全字段 | ✅ 解耦（安全决策不依赖模型） |
| integration → shared-capabilities | 读取能力风险等级 | ✅ 低（常量引用） |
| integration → trust | 按能力风险等级走审批 | ✅ 已有（复用 execute 审批路径） |
| trust → exec | egress 类不建作业 | ✅ 有特判（但需注意不会漏建） |

**耦合度低，无新增耦合风险。**

---

## 五、评分总览（修复后）

| 维度 | 得分 | 说明 |
|------|------|------|
| 术语一致性 | **10/10** | ✅ D1 修复：意图 `action` 改为 `actionClass`，审计五元组加注释消除歧义 |
| 边界合理性 | **10/10** | ✅ D3 修复：authorize 标注为"预留" |
| 不变量表达率 | **10/10** | ✅ 无遗漏 |
| 事件完整性 | **10/10** | ✅ D2 修复：IntentReclassified 载荷明确携带 `newAction` |
| 耦合度 | **10/10** | ✅ 低耦合，安全决策与模型分类解耦 |

**总分：50/50（100%）——全部达标。**

## 六、问题清单（已修复）

| # | 级别 | 问题 | 修复 |
|---|------|------|------|
| D1 | P1 | 审计五元组 `action` 与意图 `action` 同名不同义 | 意图值对象字段改为 `actionClass`，统一语言加注释"与审计五元组 action 为不同概念" |
| D2 | P2 | `IntentReclassified` 事件载荷未定义变更后的 `action` 值 | 事件载荷明确携带 `newAction` 字段 |
| D3 | P2 | `authorize` 动作分类无对应能力实现与不变量 | 标注为"预留——后续扩展时需定义能力列表与不变量" |
| D4 | P3 | 外传判定规则层实现位置未在 DDD 设计中明确定位 | §6 判定点第 1 步补充"确定性规则层"描述 |

## 七、实施就绪判定

**结论：READY。4 项全部修复，50/50（100%）达标。**

| 阻塞项 | 状态 |
|--------|------|
| D1 审计五元组 action 命名冲突 | ✅ 已修复：意图字段改为 actionClass |
| D2 IntentReclassified 事件载荷 | ✅ 已修复：明确携带 newAction |
| D3 authorize 预留标注 | ✅ 已修复：标注为"预留" |
| D4 规则层实现位置 | ✅ 已修复：§6 补充确定性规则层描述 |

## 八、回溯触发

| 触发条件 | 回溯至 | 说明 |
|---------|--------|------|
| 审计五元组 `action` 与意图 `action` 冲突（D1） | 无需回溯 | 非技能问题，本文档已记录 |
| authorize 类能力需实现（D3） | `ddd-aggregates` | 当 authorize 类能力进入实现时，需要定义聚合与不变量 |

---

## 九、代码实现状态

### 已实现（8 个 commit）

| 提交 | 任务 | 内容 |
|------|------|------|
| `53710ce` | Task 1 | shared-capabilities: EGRESS_CAPABILITIES + RISK_LEVEL |
| `76276c3` | Task 2 | 模型供应商B/模型供应商A: 提示词改为 actionClass |
| `c4d4f3b` | Task 3 | model-api: 解析 actionClass，向后兼容 |
| `4730e1b` | Task 4 | compose: toConvResult 去掉 egress |
| `1019baf` | Task 5 | trust: HIGH_RISK 加 egress 能力 |
| `26d145f` | Task 6 | integration: 按 actionClass 分流 |
| `e203844` | Task 7 | http-ingress: egress grant 特判泛化 |
| `70a851f` | Task 8 | egress.test.js 适配 + trust 白名单跳过 |

### 部署验证

- 服务器同步完成，ingress 重启成功（active）
- "导出 jd-light 的配置文件到网盘" → NEED_REVIEW ✅（模型分类为 write/config_change，走审批）
- "把.sh文件内容发给我" → 仍返回 query/OK（模型未输出 egress 类，属模型分类准确率问题，非架构问题）

### 补充实现（后 3 个 commit）

| 提交 | 任务 | 内容 |
|------|------|------|
| `ea21f54` | 确定性规则层 | compose.js toConvResult 中关键词匹配覆写 egress |
| `11268ef` | sim egress 样本 | sre-c/dev-bob 人格生成外传类意图，影子流量覆盖 egress 审批 |
| `当前` | ADR-002 收尾 | intentType 过渡代码清理：integration 以 actionClass 为主分流、compose mock 改输出 actionClass、model-api 移除 INTENT_TYPES 导出、gen-redteam-weekly 更新为 actionClass 提示词、全量测试 929/0 pass |

- 部署验证：服务器同步完成，**egress 审批记录已出现 5 条**（全部 egress_send/approved，模拟器自动生成）
- 确定性规则层实测：原始漏判样本"把.sh文件内容发给我"从 OK/query 变为 REJECTED/invalid_params（关键词命中，缺 target 被信任层拒绝）

### 剩余项

- **authorize 类能力**：预留，当前无实现计划（integration 层已加 VALID_ACTION_CLASSES 校验，authorize 可过 integration 但 trust 层缺对应能力定义，会以 capability_not_in_whitelist 拒绝）
- **intentType 向后兼容**：model-api 仍保留从 actionClass 推导 intentType 的便利字段 + 反向兼容 intentType→actionClass 的旧模型输出解析。integration 入口仍接受纯 intentType 输入（无 actionClass）。后续全量迁移后可移除这层