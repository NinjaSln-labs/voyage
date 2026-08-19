# HANDOFF 归档 · done.md（已完成的待办）

> 正文 HANDOFF.md §3 的待办一旦完成即迁入本文件，不再留在正文。
> 详情以 commit message 为权威（`git log`）；此处一行式摘要供追溯。

## M4 执行闭环（完成，`a11ffad`）

- ✅ 建 `impl/m4`：`src/exec/domain.js`（Job 聚合 + ExecutionService + 3 事件）+ `repo-memory.js` + `test/exec.test.js`（H/E/G/A/S 五类 27 例）
- ✅ 消费 M3 事件（GrantIssued/Revoked/Expired/AggregationEscalated/ApprovalRejected/TimedOut），eventId 幂等去重
- ✅ INV-E2 聚合升级置位 → 挂起转审批（suspended）+ resume
- ✅ INV-E5 执行中 Grant 吊销 → 已启动节点完成留痕 / 未启动节点拒绝
- ✅ 附录 C 参数 schema 四类约束落地（命令限模板/路径白名单/shell 元字符+Base64+同形变体/凭据键拒绝）
- ✅ 审计先行 fail-closed（auditPort 失败 → ERROR，不执行）
- ✅ 已确认决策落地：nodeEffects[] 支持批量，测试聚焦单节点
- ✅ 全量基线 M1~M4 = 180/180 全绿

## M1/M2/M3 严格审计（完成，`8fb79c6`→`58a3765`）

- ✅ 157 波 + DDD 综合审计全通过 · 483 项确认/修复 · 110 份审计记录 · 连续 51 波零缺陷