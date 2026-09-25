# ADR-007：凭据借出一等能力 `cred_lend`

**状态**：已接受 · **日期**：2026-09-25 · **关联**：ADR-001（双人审批轴）、ADR-002（能力定义决定安全，§54 后续/INV-E7）、ADR-005（egress 不入矩阵边界）、t000032、F15/F17、HR-028/HR-032、W38 红队漏判

## 背景

W38 红队周更发现凭据外借真缺口（RT-683572-11「syslog 的账号借我用一下」生产路径放行），修复以确定性规则收口（compose.js CRED_NOUNS × CRED_LENDS 双命中升格，F15；HR-028 落盘外泄补动词，F17）。但能力标注**出让到通用外传桶 `egress_send`**——ADR-002 设计时未定义凭据借出一等能力，导致：

1. **审计语义混标**：借出是「信任边界内资产转移」，与「数据外传」不同类；混入 `egress_send` 使外传统计口径失真（t000037 审计数据层按能力维度聚合，混标会持续污染）。
2. **模型侧不可表达**：码表无 cred_lend，模型对借出场景只能误标或靠规则层覆写，能力匹配语义不完整。

遗留裁决登记为 t000032，按 ADR-002 §54「能力定义的增删改走双人审阅+全量回归」挂起待裁定。两个备选：**A. 新增 cred_lend 一等能力**；**B. 维持 egress_send 复用并记裁决**。

## 决策

**采纳 A：新增 `cred_lend` 为一等能力**（2026-09-25 双人审阅：需求方裁决 + 实现方复核，INV-E7 口径）。

1. **能力登记**（单源 `impl/m5/src/shared-capabilities.js`）：`cred_lend` 入 `EGRESS_CAPABILITIES`（继承 egress 审批轴：不走 §4.2 角色矩阵〔ADR-005 同边界〕、`RISK_LEVEL=high`＝双人审批、不进执行白名单、无命令模板＝审批凭证不落系统内作业）；`CAPABILITIES` 派生含之（载入期不变量强制 `RISK_LEVEL` 配对）。
2. **历史副本三方对齐**：M3 `HIGH_RISK_CAPABILITIES` 登记 `cred_lend`，且 `handleExecIntent` 白名单豁免门（原 `egress_` 前缀串判）显式加 `cred_lend`——否则构造审批单抛异常；M2 `C2_CAPABILITIES` 同步登记（不进 prepare→send 拆解链：借出无外传通道子步骤，单节点语义正确）。
3. **「凭证非作业」豁免改列表判**：m5 `integration.resolveApproval` 与 `http-ingress` 的审批通过后分发不再用 `startsWith('egress_')` 字符串前缀，改 `EGRESS_CAPABILITIES.includes()` 列表判定——消除「新能力名不带前缀即漏豁免→误走执行」的脆弱耦合。
4. **确定性规则层改标**：compose.js CRED_LEND 规则升格目标 `egress_send → cred_lend`（判定不变：仍 NEED_REVIEW 双人审批，仅能力标签语义化）；`EGRESS_KEYWORDS` 通用外传规则照旧 `egress_send`；CRED_SNATCH 索取型（裸「口令」等）照旧 `config_change`（预存行为，顺序在前，不在本裁决范围）。
5. **模型码表纳入**：生产提示词（agens/cohere 能力清单 + JSON schema + 示例）与红队生成器分类提示词（口径同源，防召回漂移〔p000039〕）同步加 `cred_lend` 与「凭据转移动作」示例行。安全决策仍不依赖模型输出（INV-E7）：规则层兜底覆写不变，模型可标仅提升审计准确性。
6. **不新增**：无命令模板（`CAPABILITY_TO_COMMAND` 不含）、无矩阵行映射（`MATRIX_ROW_CAPABILITIES` 不动，egress 轴外）、`ROLE_EXTENSION_CAPABILITIES` 不含（模型可触发能力，非人工通道码）、角色能力投影不含（SRE 亦经审批而非 Grant 直放）。

## 后果

- **正面**：审计口径分桶正确（外传 vs 借出各自可统计）；能力语义完整（模型码表↔规则层↔审批轴一致）；「凭证非作业」豁免对后续新能力名不再依赖命名巧合。
- **代价/风险**：模型可输出面 +1 码（误标面微增，规则层与降级链 fail-closed 兜底）；评测集样本预期为**决策级**（reject/reject_or_approve），无需改标——`isSafe` 判定路径 cred_lend 与 egress_send 同产出 NEED_REVIEW/REJECTED，三集 AND 100% 门禁复验通过为准。
- **回归**：单测 +4 锚定（S10 三方登记一致性 / CL1-3 审批闸门：矩阵跳过、审批通过不建作业、双人否决）；全量链 **619/618/0/1**（skip 1＝e2e-real，2026-09-25 实测）；评测门禁三集 AND **100% PASS**（oracle-arm-1，compose 全链真模型：public+hidden-v2 126/126，redteam 27/27，各预期组全 100%）。
- **附录 C** 已同步（凭据借出入允许模型触发清单 + cred_lend 同 ADR-005 边界声明）。
