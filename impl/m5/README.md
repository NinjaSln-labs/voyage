# M5 整合入口 + 审计（DoD-B）交付说明

- 依据：`产品0-1计划.md` §4 M5（统一入口 + 全量审计五元组）+ `DoD 门禁.md` §2 Next（L5 统一入口 + 全量审计 ≥180 天）+ `impl/m0-d/DDD设计.md` §6（五步判定点）/§7（Outbox 事务边界 6 机制）+ `impl/m5-方案评审.md`
- 交付：编排层 + 审计聚合（零依赖领域模型 + 契约端口 + 内存仓储）；真实适配器（mTLS/WebAuthn/SSH/审计 ≥180 天介质/角色-资产仓储）归属 M6/真实选型

## 交付物

| 文件 | 内容 |
|------|------|
| `src/audit/domain.js` | 审计聚合：AppendOnlyAuditChain（append-only 哈希链 + 五元组 + 降级缓冲 + 北极星计数 + 查询缓冲 + 断裂告警/重建）+ AuditEntry + 3 事件 |
| `src/audit/repo-memory.js` | auditRepo 内存仓储 + createMemoryPersist（含 eventBus 透传） |
| `src/metric/domain.js` | metric BC：MetricService（订阅 AuditWritten → 北极星/反指标月读数，DDD §4 metric.count） |
| `src/integration/domain.js` | 应用编排层：IntegrationService（五步判定串联，align M3 handleExecIntent/resolveApproval + M4 createJob/start） |
| `src/integration/outbox.js` | Outbox 事务边界：OutboxMessage（幂等/退避/死信）+ OutboxJournal（单写者串行消费 + consumer 注入） |
| `src/integration/repo-memory.js` | Outbox 内存仓储（幂等入队 + findConsumable 排序） |
| `test/audit.test.js` | 审计契约测试 H/E/G/A/F 五类（15 例） |
| `test/audit-invariants.test.js` | INV-U2/U4/U5 + AuditWritten 事件专项测试（13 例） |
| `test/metric.test.js` | metric BC 月读数契约测试（8 例） |
| `test/integration.test.js` | 集成契约测试 H/E/G/A/F 五类（19 例） |

## DoD-B 勾选

- [x] 统一入口编排（IntegrationService）：handle + resolveApproval 五步串联
- [x] 全量审计五元组 append-only 哈希链：RQ-831 + INV-U3
- [x] Outbox 事务边界（最终一致性）：RQ-623 + INV-N2（死信告警不静默）
- [x] 五步判定点服务端强制（DDD §6）：不信任前端标志（A2 测试）
- [x] 审计先行 fail-closed：INV-U1（F1 测试）
- [ ] 设备/账号认证 mTLS + WebAuthn：契约端口声明（M6 接真实）

## 不变量 → 实现 → 测试映射表（质量基调 §三.1）

| 不变量 | 实现 | 测试 |
|--------|------|------|
| RQ-831 审计五元组 append-only | AuditEntry + AppendOnlyAuditChain.append | H1/H2/H3/E1~E5 |
| INV-U1 审计先行 fail-closed | auditPort.write 失败 → handle ERROR | F1 |
| INV-U2 哈希链篡改检测 + 断裂告警 + 分段重建 + 断裂登记 | verify() → ChainIntegrityBreach + breaches + rebuildFrom | H1/A1/U2-1/2/3 |
| INV-U3 降级态缓冲 | appendBuffered/flushBuffer | G2 |
| INV-U4 北极星计数分离 | countPolar（{intent,job}）与明细链分离 | U4-1/2/3 |
| INV-U4 查询缓冲背压 | bufferQuery/flushQueryBuffer + QueryBufferOverflow | U4-4/5/6 |
| INV-U5 至少一次投递 + DDD §3 AuditWritten 事件 | AuditWritten（eventId=auditw-<seq> 幂等键） | U5-1/2/3 |
| INV-N2 关键告警不静默 | ChainIntegrityBreach（severity=critical） + Outbox 死信 | U2-1 |
| DDD §4 metric.count(月) 北极星/反指标 | MetricService.onAuditWritten → count(month) | H1~H3/G1/A1 |
| RQ-623 跨 BC 事务边界 | OutboxJournal 单写者串行 + 幂等去重 + 退避/死信 | A1/H3 |
| DDD §6 判定点1 | convPort.interpret → intentType query/execute | H1/H2 |
| DDD §6 判定点2+4 单一来源 | trustPort.handleExecIntent（不复制 HIGH_RISK）| H2/E1/G1/G2 |
| DDD §6 判定点3+5 执行前+审计先行 | execPort.createJob + start | H2/G5 |
| DDD §7 机制5 更保守者胜 | escalated → suspended → NEED_REVIEW | G2 |
| RQ-822 幂等去重 | _handledIntentIds idempotent | G3 |

## 说明

- **HIGH_RISK 防双源**：集成层不复制 M3 HIGH_RISK_CAPABILITIES；高危/白名单/自动审批判定单一来源 = `trustPort.handleExecIntent`；保留在评论声明但不编码双源清单。
- **端口方法名对齐**：integration 端口契约对齐 M3 ApprovalFlowService（handleExecIntent/resolveApproval）和 M4 ExecutionService（createJob/start）真实方法名。
- **Outbox consumer**：OutboxJournal 注入 consumer 回调（由 IntegrationService 提供 _launchFromGrant）；未注入则 resolveApproval 降级同步启动。

## 下一步（按计划）

- **M6 内测上线**：mTLS/WebAuthn 硬件认证、SSH 被管机执行、审计 ≥180 天真实介质、角色-资产真实仓储、评测集达标。