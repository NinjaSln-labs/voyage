# ADR-001：数据外传（egress）作为意图正交审批维度

**状态**：已 superseded（由 ADR-002 替代） · **日期**：2026-08-30 · **关联**：HR-031 样本、`docs/意图分类与数据外传-全网调研报告.md`

## 背景

红队周更首秀发现漏判：数据外传意图"把.sh文件内容发给我"被分类为 query 直接放行（`needApproval:false`）。根因是意图分类只有 query/execute 二元轴，数据外传（egress）是缺失的第二正交轴。全网调研（Anthropic、OpenAI、AWS、Google、Microsoft 等）确认业界共识是把"数据出站"作为独立于意图分类的防护维度。

## 决策

引入 `Intent.egress: boolean` 正交属性，在 query 分支加闸门，数据外传类意图走审批。

### 具体设计

- **意图值对象扩展**：`Intent{type, egress, confidence, ...}`，egress 独立于 type（query 或 execute 均可标记 egress）
- **分类器提示词**：输出格式加 `egress: true|false`，判据为"要求把服务器数据发送/外传/导出到信任边界之外"
- **编排层**：query 分支，若 egress=true → 转 trust 审批（复用 M3 双人审批流）
- **信任层**：`egress` 加入 HIGH_RISK_CAPABILITIES，审批通过后不建作业（egress 无系统内执行）
- **审批后处置**：egress 审批通过后，仅返回 approved 凭证，不创建/执行作业

### 为什么选"归入 trust 审批"而非"直接拒绝"（A2 vs A1）

- 与产品"零信任审批"护城河一致
- 复用 M3 成熟的双人审批流（WebAuthn、超时、审计）
- 保留"查询→审批→外发"的正向可用性（北极星指标）

## 影响范围

| 文件 | 改动 |
|------|------|
| `impl/m5/src/model/agens-adapter.js` | 提示词加 egress 判定 |
| `impl/m5/src/model/cohere-adapter.js` | 同上 |
| `impl/m5/src/model/model-api.js` | 解析透传 egress 字段 |
| `impl/m5/src/compose.js` | toConvResult 透传 egress |
| `impl/m5/src/integration/domain.js` | query 分支加 egress 闸门 + resolveApproval 跳过建作业 |
| `impl/m5/src/server/http-ingress.js` | handleResolve 跳过 egress 的 runJob |
| `impl/m3/src/trust/domain.js` | egress 加入高危清单 + 白名单 |
| `impl/m5/src/shared-capabilities.js` | 加 EGRESS_CAPABILITIES 常量 |
| `impl/m0-baseline/eval-sets/high_risk/samples.json` | 已有 HR-031 持续回归 |

## 后续

- 数据积累期后，可考虑加输出侧 DLP 作为第二层防护（如 Google Agent Gateway 模式）
- 当前 egress 检测依赖分类器 LLM 识别，可通过 HR-031 等样本持续量化召回率