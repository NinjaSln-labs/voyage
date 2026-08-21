# M1~M6 严格 DDD 全维度审计（第 23~32 波 + D1~D5 维度）

- 日期：2026-08-19
- 方法：类级扫描 + 动态穿透 + 跨 BC 真实接线验证（非 grep 关键词）
- 基线：287/287 全绿

## 各波发现与修复

| 波 | 维度 | 发现 | 修复 |
|----|------|------|------|
| 23 | audit 不变量 | INV-U4/U2/U5 部分缺失、AuditWritten 事件缺失 | 补 countPolar/断裂告警/幂等投递/事件 |
| 24 | DDD 建模 | gate→model 漂移、metric BC 缺失、integration 命名 | 归位 model BC、补 metric、注册应用编排层 |
| 25 | 事件/接口 | 3 反向孤儿事件、SubstitutionRevoked 缺失 | 回写 DDD §3、补事件 |
| 26 | 时序铁律 | 审批审计缺失、Outbox 未接线、creator/params 硬编码 | 补审计先行、接线 consumer、参数化 |
| 27 | 跨 BC 契约 | checkGrant 缺失、Grant 参数未绑定、仓储 async | 补方法、绑真实哈希、同步化 |
| 28 | 真实接线 | 跨 BC 全链走通验证 | E2E 测试固化 |
| 29 | 审批参数链 | handle 审批分支不返回 params（26 波残余） | 返回 params |
| 30 | 性能/内存 | 降级缓冲无上限、幂等 Set 无上限 | 加容量上限 |
| 31 | 时钟一致性 | Outbox consumer 用 new Date（误判 expired） | 用 timeSource |
| 32 | 聚合封装+事件一致性 | Approval/Grant 身份字段公有可写（重定向/伪造）、GrantRevoked 缺顶层 revokedReason | 全私有化+getter、补字段 |

## D 维度总览

| 维度 | 结果 |
|------|------|
| D1 贫血模型 | ✅ 零贫血（全部聚合有行为方法） |
| D2 值对象不可变 | ✅ Date 拷贝 + 数组深冻结 |
| D3 聚合根封装 | ✅ 6 字段私有化（Approval: terminalSeq/rejectedBy/target/operatorId/highRiskType；Grant: source） |
| D4 事件跨 BC 一致性 | ✅ GrantRevoked 顶层 revokedReason 补齐 |
| D5 统一语言 | ✅ 术语 10/11 对齐（1 属未实现 BC）；无命名漂移；Grant.jobRef 语义自洽 |

## 关键结论

- **每波都有真实发现**：桩间全绿掩盖了大量接线/封装/字段问题——动态验证（真实 M3/M4 接线 + 类级扫描）是发现它们的关键。
- **测试桩掩盖模式**：M4 checkGrant stub、GrantRevoked 手工构造、E2E 包装 exec——三次都是"测试过但真实接线断"。
- **JS 语义坑**：getter-only 属性非严格模式赋值静默忽略（值不变），严格模式抛 TypeError——封装验证须用值对比/严格模式。
## 补充维度（第 33 波）

| 维度 | 结果 |
|------|------|
| 并发/竞态 | ✅ Outbox 单写者串行；退避指数 1→2→4→8s→dead；无模块级共享可变状态 |
| 数值边界 | 🔴 OutboxMessage.attemptCount 无校验 → **已修**（非负有限整数） |
| 降级路径 | ✅ 存储不可用→缓冲→恢复→补链→verify 通过；降级时 append fail-closed |
| 幂等/重放 | ✅ M3 审批重放不重复签发/投票；M4 事件重放 duplicate；M5 metric eventId 去重 |
| 依赖方向 | ✅ M1~M6 无跨 BC require、无循环；M5 内部 require 同目录 |
| 错误语义 | ✅ ERROR(14)/REJECTED(8) 分类正确；重复 reason 码同 status 复用合理 |
| M1 obs | ✅ 只读口径 R8；事件协议 schemaVersion+eventId+冻结；防注入拷贝 |
| 事件名唯一性 | ✅ 无真实冲突（GrantIssued 类 1 处，余为引用） |
| 测试质量 | ✅ 287 测试/768 断言（2.7/测试）；无零断言测试；M6 走查断言密度 1.6 可接受 |

## 全量审计结论

- 23 波 + 6 个 D 维度 + 9 个补充维度 = **38 轮审计全闭环**
- 累计修复 15+ 项（3 个 P0）
- 全量 287/287 全绿
