# ADR-002：能力定义决定安全决策（C+D 方案）

**状态**：已接受 · **日期**：2026-08-30 · **替代**：ADR-001

## 背景

ADR-001 引入 `Intent.egress: boolean` 正交字段，在 query 分支加闸门。实现后发现模型对 `egress: true` 输出可靠性低（约 50% 命中率），单纯靠提示词工程无法保证安全关键字段的可靠输出。全网调研确认业界共识：安全决策不应依赖模型分类输出，而应由能力定义的风险等级决定（符号规则兜底，模型仅辅助）。

## 决策

**废弃 ADR-001 的"egress 布尔字段"方案，回归到"能力定义决定安全决策"的架构。**

### 核心变化

| 维度 | ADR-001（egress 布尔字段） | ADR-002（能力定义决定安全） |
|------|---------------------------|--------------------------|
| 意图值对象 | `Intent{type, egress, ...}` | `Intent{action, capability, ...}` |
| 模型输出 | `intentType + egress:bool` | `action + capability`（模型只做能力匹配） |
| 安全决策 | 编排层特判 query+egress | 能力定义预配风险等级（low/high/critical） |
| 外传防护 | 加一个布尔字段 | 加独立能力（egress_send/egress_download 等） |
| 模型可靠性 | 依赖模型输出陌生布尔 | 依赖模型做它擅长的能力匹配 |
| 可扩展性 | 每加一个安全字段改一次编排 | 加一个能力定义即可 |

### 具体设计

1. **意图值对象**：`Intent{action, capability, confidence, reclassified, ...}`，action ∈ {read, write, egress, authorize}
2. **能力定义**：每个能力预配风险等级——`low`（自动放行）、`high`（双人审批）、`critical`（直接拒绝）
3. **模型职责**：只负责将文本匹配到 action+capability，不输出安全决策字段
4. **编排层**：按能力风险等级决定放行/审批/拒绝，不使用模型输出中的安全判断字段
5. **外传类能力**：扩展能力列表，加入 `egress_send`、`egress_download`、`egress_mail` 等，预配 high 风险等级

### 关键不变量（INV-E7）

> 安全决策由能力定义决定，不依赖模型分类输出。模型只负责将文本匹配到动作+能力；每个能力预定义风险等级（low/high/critical），编排层按等级决定放行/审批/拒绝，不使用模型输出中的安全判断字段。能力定义增删改走双人审阅+全量回归（同 INV-K4 口径）。

## 对 ADR-001 的回滚

| ADR-001 改动 | 处理 |
|-------------|------|
| 分类提示词加 egress 布尔 | 回滚，改为在能力列表加 egress_send 等 |
| model-api.js 透传 egress | 回滚 |
| compose.js 透传 egress | 回滚 |
| integration/domain.js query 分支 egress 特判 | 回滚 |
| http-ingress.js egress grant 特判 | 回滚 |
| trust/domain.js egress 白名单特判 | 保留（egress 作为高危能力） |
| shared-capabilities.js EGRESS_CAPABILITIES | 保留（扩展为具体外传能力） |

## 影响范围

同 DDD 设计文档 §1/§2/§3/§4/§5/§6/§7 更新，以及 `需求说明书-终版.md` 附录 C、`产品说明书-终版.md` 附录 C 引用、`指标口径.md`、`AI评测策略.md` 对应的口径更新。

## 后续

- 能力定义的增删改走双人审阅 + 全量回归（评测门禁）
- 外传类能力的目标域白名单部署后可配置（egress 目标域不在白名单即拒绝）
- 数据积累期后，可考虑加输出侧 DLP 作为第二层防护