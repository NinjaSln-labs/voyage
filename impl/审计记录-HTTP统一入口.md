# 审计记录 — HTTP 统一入口（http-ingress）

## 元信息

- **日期**：2026-08-25 · **审计方**：接收 session（ox-alpha）+ 独立子代理（安全对抗视角）
- **对象**：impl/m5/src/server/http-ingress.js（JWT 门禁→意图→审批解析→自动执行→作业投影）+ H1~H9 契约测试
- **流程**：先审后提交

## 发现清单

| # | 级别 | 轴 | 发现 | 处置 | 锚定 |
|---|------|----|------|------|------|
| N1 | **P1** | 安全 | 审批解析零授权面——任意已认证身份可解析他人审批单（approvalId 可预测），rejectBy 直信客户端可伪造拒绝归因 | ✅ fixed：仅属主（意图发起人）可解析（403 not_approval_owner）；rejectBy 一律取认证身份、丢弃客户端值 | H7 |
| N2 | P2 | 安全 | pending Map 无上限无 TTL——认证用户刷 NEED_REVIEW 内存放大 | ✅ fixed：MAX_PENDING_APPROVALS=1000 淘汰最旧 + 30min TTL 懒清扫（与领域审批超时同窗） | （实现+H9 条目保留语义回归） |
| N3 | P2 | 安全 | 作业投影无属主校验——dev 可查任意作业 | ✅ fixed：仅 creator 可查（403 not_job_owner） | H4d |
| N4 | P2 | 正确性 | 413 后立即 destroy 截断响应——客户端见 ECONNRESET 而非 413 | ✅ fixed：pause+等 res finish 再断连 | H8 |
| N5 | P2 | 一致性 | Outbox deferred 形态下立即 runJob 会撞异步启动语义误报 ERROR | ✅ fixed：deferred=true 跳过执行（compose 当前无 Outbox，防御性） | — |
| N6 | P2 | 测试 | H5 名不副实：413 路径零覆盖；缺空票/重复票/跨身份负路径 | ✅ fixed：H7/H8/H9 | H7-H9 |
| N7 | P3 | 正确性 | 重复票在领域层抛错被兜底成 500；ERROR 状态条目残留 | ✅/📝：重复票去重归一（H9a）；ERROR 残留为可重试语义由 TTL 兜底（声明） | H9 |
| N8 | P3 | 安全 | reason 枚举透传构成轻量令牌神谕（expired vs malformed 区分） | 📝 recorded：对合法调用方排障价值 > 神谕风险；token 本体不泄漏 | — |

## 四轴结论

- **安全轴**：N1/N2/N3 修复后——actorId 服务端单源、审批单属主绑定、内存有界、作业最小暴露
- **正确性轴**：413 竞态消除；外层 catch + headersSent 防护完备；终态删除语义明确
- **一致性轴**：G2 同参透传/runJob 直通 jobId 推导/resolveApproval 对接全部保持 ✓；Outbox 形态已加防误报守卫
- **测试充分性轴**：负路径补齐（跨身份 403 / 413 / 重复票 / 空票可重试 / 属主校验）

## 回归证据

```
入口契约测试：6 → 9 例全通过
全量基线：431 → 440 tests（439 pass + 1 条件跳过，0 fail）
```

## recorded 声明（沿用）

- votes 清单信任请求体投票人身份——生产须逐票验签（WebAuthn），部署硬化待办
- 审批单存内存，进程重启丢失——持久化归后续迭代
