# M3 信任模型（C10/C11/C12）交付说明

- 依据：`产品0-1计划.md` §4 M3（四层准入/矩阵服务端强制/高危双人审批 R1–R3）+ `DoD 门禁.md` Next + M0-D trust 限界上下文
- 交付：领域模型 + 契约测试，全部通过（29/29）

## 交付物

| 文件 | 内容 |
|------|------|
| `src/trust/domain.js` | trust 领域模型：ApprovalVote/Approval/Grant/AggregationWindow/AccessEvidence 聚合 + ApprovalFlowService + 6 事件 |
| `src/trust/repo-memory.js` | 审批/Grant/聚合窗口仓储内存适配器 |
| `test/trust.test.js` | 契约测试 29 例（happy×5/error×5/edge×4/adversarial×3 + 第7~9波回归 S18~S29×12） |

## DoD-B（Next）勾选

- [x] 四层准入（INV-T1）：设备/身份/行为/操作证据判定，缺层→layered/reject（H4/G4）
- [x] 高危双人审批（R1–R3）：双人两自然人/不可自批/超时默认拒绝/幂等（H1/E1/E2/E3/G1/G2）
- [x] Grant 语义（INV-G1~G4）：绑定作业/目标/命令/参数哈希、吊销即时、矩阵 ✅ 自动签发（H2/E4/A3/H5）
- [x] 聚合判定（INV-C4）：同类 ≥3/跨桶 ≥10/滑动窗口（H3/A1/G3）
- [x] 补位授权（INV-A4）：双人确认/被授权人不参与/90 天/SRE 恢复回收（E5/A2）
- [x] 消费 conv 意图：ApprovalFlowService.handleExecIntent 承接 IntentRecognized（H5）

## 与 M0-D 设计对齐（不变量 → 测试）

| 不变量 | 实现/测试 |
|--------|----------|
| INV-A1 双人两自然人+不可自批+WebAuthn | H1/E1/E2/ApprovalVote 构造 |
| INV-A2 超时默认拒绝+同事务 | G1/G2（addVote/resolve 传 now） |
| INV-A3 幂等不可翻转 | E3 |
| INV-A4 补位双人+时效+回收 | E5/A2 |
| INV-G1~G4 Grant 来源/绑定/吊销/矩阵签发 | H2/E4/A3/H5 |
| INV-C4 聚合滑动/同类/跨桶 | H3/A1/G3 |
| INV-T1 四层准入 | H4/G4 |
| INV-E5 执行中吊销 | E4（revoke 即时 + 语义注释） |

## 说明

- 审批超时「与执行启动同事务」：领域层以 addVote/resolve 显式传 now 保证时间判定一致；事务边界（Outbox）属编排层（M5 整合），与 M0-D §7 契约一致。
- 矩阵服务端强制（INV-P1）判定点在 M5 网关层（M2/M3 已分别实现意图重分类与审批判定；M5 串联五步判定点）。

## 下一步（按计划）

- **M4 执行闭环**（C8/C9/C2）：作业聚合消费 GrantIssued 事件、聚合升级标志挂起 standing Grant、定时任务触发校验——trust 的 Grant 是执行前置。
