// trust 审批信任域 契约测试（happy/error/edge/adversarial）
// 依据：M0-D INV-A1~A5（审批）、INV-G1~G4（Grant）、INV-C4（聚合）、INV-T1（准入）、INV-E5（吊销）
// 运行：node --test impl/m3/test/trust.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Approval, Grant, AggregationWindow, AccessEvidence, ApprovalFlowService, ApprovalVote, AggregationEscalated, ApprovalRequested, ApprovalRejected, GrantRevoked,
  APPROVAL_TIMEOUT_MS, AGG_SAME_KIND_THRESHOLD, AGG_CROSS_BUCKET_THRESHOLD,
} = require('../src/trust/domain');
const { InMemoryApprovalRepo, InMemoryGrantRepo, InMemoryAggregationRepo } = require('../src/trust/repo-memory');

// ---------- happy path ----------

test('H1 双人批准：两自然人 → approved（INV-A1）', () => {
  const ap = new Approval({ id: 'ap-1', operatorId: 'dev-1', target: 'svc-1', highRiskType: 'restart', createdAt: new Date() });
  ap.addVote('sre-1');
  ap.addVote('sre-2');
  assert.equal(ap.resolve(), 'approved');
  assert.equal(ap.votes.length, 2);
});

test('H2 Grant 有效期与绑定（INV-G2）', () => {
  const g = new Grant({ id: 'gr-1', jobRef: 'job-1', target: 'svc-1', commandTemplate: 'restart', paramsHash: 'h1' });
  assert.equal(g.isValid(new Date()), true);
  assert.equal(g.matches('job-1', 'svc-1', 'restart', 'h1'), true);
  assert.equal(g.matches('job-2', 'svc-1', 'restart', 'h1'), false, '作业不匹配不可用（防复用）');
});

test('H3 聚合窗口：同类 ≥3 次升级审批（INV-C4）', () => {
  const win = new AggregationWindow({ actorId: 'dev-1', assetId: 'svc-1' });
  for (let i = 0; i < 3; i++) win.record('restart');
  assert.equal(win.countSameKind('restart'), 3);
  assert.equal(win.countSameKind('restart') >= AGG_SAME_KIND_THRESHOLD, true, '达阈值升级');
});

test('H4 四层准入齐备 → allow（INV-T1）', () => {
  const ev = new AccessEvidence({ deviceOk: true, accountOk: true, behaviorOk: true, operationOk: true });
  assert.equal(ev.evaluate(), 'allow');
});

test('H5 审批流：高危 → pending_approval；非高危 → auto_granted（INV-G4）', async () => {
  const flow = new ApprovalFlowService({
    approvalRepo: new InMemoryApprovalRepo(), grantRepo: new InMemoryGrantRepo(),
    aggregationRepo: new InMemoryAggregationRepo(), approvalPool: { resolvers: () => ['sre-1', 'sre-2', 'sre-3'] },
  });
  const r1 = flow.handleExecIntent({ intentId: 'i-1', actorId: 'dev-1', target: 'svc-1', capability: 'restart', now: new Date() });
  assert.equal(r1.status, 'pending_approval', '高危 restart 需审批');
  const r2 = flow.handleExecIntent({ intentId: 'i-2', actorId: 'dev-1', target: 'svc-1', capability: 'query_status', now: new Date() });
  assert.equal(r2.status, 'auto_granted', '查询类自动 Grant');
});

// ---------- error path ----------

test('E1 操作者不可自批（R1/INV-A1）', () => {
  const ap = new Approval({ id: 'ap-1', operatorId: 'dev-1', target: 'svc-1', highRiskType: 'restart' });
  assert.throws(() => ap.addVote('dev-1'), /不可自批/);
});

test('E2 同一自然人不可重复投票', () => {
  const ap = new Approval({ id: 'ap-1', operatorId: 'dev-1', target: 'svc-1', highRiskType: 'restart' });
  ap.addVote('sre-1');
  assert.throws(() => ap.addVote('sre-1'), /重复投票/);
});

test('E3 终态不可翻转（INV-A3 幂等）', () => {
  const ap = new Approval({ id: 'ap-1', operatorId: 'dev-1', target: 'svc-1', highRiskType: 'restart' });
  ap.addVote('sre-1'); ap.addVote('sre-2'); ap.resolve();
  assert.throws(() => ap.addVote('sre-3'), /已approved/);
  assert.equal(ap.resolve(), 'approved', '幂等：终态返回自身不抛（A3）');
});

test('E4 Grant 吊销后不可用（INV-G3）', () => {
  const g = new Grant({ id: 'gr-1', jobRef: 'j', target: 's', commandTemplate: 'c' });
  g.revoke('安全事件');
  assert.equal(g.isValid(new Date()), false);
  assert.throws(() => g.revoke('again'), /不可重复/);
});

test('E5 补位授权：单人或含被授权人确认 → 拒绝（INV-A4）', () => {
  const flow = new ApprovalFlowService({ approvalRepo: {}, grantRepo: {}, aggregationRepo: {}, approvalPool: { resolvers: () => ['sre-1', 'sre-2', 'sre-3'] } });
  assert.throws(() => flow.grantSubstitution({ grantedBy: 'mgr-1', grantee: 'sre-x', confirmators: ['mgr-1'] }), /双人确认/);
  assert.throws(() => flow.grantSubstitution({ grantedBy: 'mgr-1', grantee: 'sre-x', confirmators: ['mgr-1', 'sre-x'] }), /被授权人不可参与确认/);
});

// ---------- edge path ----------

test('G1 审批超时：过期后默认拒绝（INV-A2）', () => {
  const now = new Date('2026-08-18T00:00:00Z');
  const ap = new Approval({ id: 'ap-1', operatorId: 'dev-1', target: 'svc-1', highRiskType: 'restart', createdAt: now, timeoutMs: APPROVAL_TIMEOUT_MS });
  ap.addVote('sre-1', { now }); ap.addVote('sre-2', { now });
  const later = new Date(now.getTime() + APPROVAL_TIMEOUT_MS + 1000);
  assert.equal(ap.resolve(later), 'timed_out', '超时默认拒绝');
  assert.equal(ap.isExpired(later), true);
});

test('G2 超时后投票被拒（A2 超时-执行同事务语义）', () => {
  const now = new Date('2026-08-18T00:00:00Z');
  const ap = new Approval({ id: 'ap-1', operatorId: 'dev-1', target: 'svc-1', highRiskType: 'restart', createdAt: now });
  const later = new Date(now.getTime() + APPROVAL_TIMEOUT_MS + 5000);
  assert.throws(() => ap.addVote('sre-1', { now: later }), /已超时/);
});

test('G3 聚合窗口滑动：过期后重置', () => {
  const base = new Date('2026-08-18T00:00:00Z');
  const win = new AggregationWindow({ actorId: 'dev-1', assetId: 'svc-1', durationMs: 1000, createdAt: base });
  win.record('restart', base);               // t0 窗口内
  win.record('restart', new Date(base.getTime() + 2000)); // t0+2s：窗口 1s → t0 事件出窗，只留本条
  const now = new Date(base.getTime() + 2000);
  assert.equal(win.countSameKind('restart', now), 1, '过期窗口剔除后只计新事件');
});

test('G4 四层缺层 → layered（R11 分层动作）或 reject', () => {
  const layered = new AccessEvidence({ deviceOk: true, accountOk: true, behaviorOk: false, operationOk: true, allowLayered: true });
  assert.equal(layered.evaluate(), 'layered');
  const strict = new AccessEvidence({ deviceOk: true, accountOk: true, behaviorOk: false, operationOk: true, allowLayered: false });
  assert.equal(strict.evaluate(), 'reject');
});

// ---------- adversarial / fault ----------

test('A1 跨桶累计：窗口内总次数达阈值升级（INV-C4 跨桶）', () => {
  const win = new AggregationWindow({ actorId: 'dev-1', assetId: 'svc-1' });
  for (let i = 0; i < AGG_CROSS_BUCKET_THRESHOLD; i++) win.record(`cap${i}`); // 10 种不同能力
  assert.equal(win.totalCount(), 10);
  assert.equal(win.totalCount() >= AGG_CROSS_BUCKET_THRESHOLD, true, '跨桶累计升级');
});

test('A2 操作者不可自批 + 补位（INV-A4 组合）', () => {
  const flow = new ApprovalFlowService({ approvalRepo: {}, grantRepo: {}, aggregationRepo: {}, approvalPool: { resolvers: () => ['sre-1', 'sre-2', 'sre-3'] } });
  const s = flow.grantSubstitution({ grantedBy: 'mgr-1', grantee: 'sre-x', confirmators: ['mgr-2', 'mgr-3'] });
  assert.equal(s.grantee, 'sre-x');
  assert.equal(s.autoRevokeWhen, 'sre_pool_restored', 'SRE 恢复自动回收');
  assert.ok(s.validUntil > s.validFrom);
});

test('A3 Grant 绑定校验防复用（INV-G2：参数哈希不匹配不可用）', () => {
  const g = new Grant({ id: 'gr-1', jobRef: 'job-1', target: 'svc-1', commandTemplate: 'restart', paramsHash: 'h1' });
  assert.equal(g.matches('job-1', 'svc-1', 'restart', 'h2'), false, '参数哈希不同拒绝（防参数篡改复用）');
});

// ---------- 严格审计第 7 波回归（聚合升级崩溃 / Grant 签发链 / 事件总线 / 滑动窗口 / 容量 / deadline 边界） ----------

function makeFlow(eventBus = null) {
  return new ApprovalFlowService({
    approvalRepo: new InMemoryApprovalRepo(), grantRepo: new InMemoryGrantRepo(),
    aggregationRepo: new InMemoryAggregationRepo(), approvalPool: { resolvers: () => ['sre-1', 'sre-2', 'sre-3'] },
    eventBus,
  });
}

test('S18 非高危能力聚合升级不崩溃：query_status 达阈值 → pending_approval（严格审计修复）', () => {
  const flow = makeFlow();
  const t0 = new Date('2026-08-19T00:00:00Z');
  for (let i = 1; i <= 3; i++) {
    const r = flow.handleExecIntent({ intentId: `i-${i}`, actorId: 'dev-1', target: 'svc-1', capability: 'query_status', now: new Date(t0.getTime() + i * 1000) });
    if (i < 3) assert.equal(r.status, 'auto_granted', `第${i}次未达阈值自动 Grant`);
  }
  // 第 3 次同类达阈值 → 升级审批（原实现抛 HIGH_RISK_CAPABILITIES 异常崩溃）
  const r3 = flow.handleExecIntent({ intentId: 'i-4', actorId: 'dev-1', target: 'svc-1', capability: 'query_status', now: new Date(t0.getTime() + 4000) });
  assert.equal(r3.status, 'pending_approval', '升级后转审批而非崩溃');
  assert.equal(r3.approval.highRiskType, 'escalated', '升级审批用通用 escalated 类型');
  assert.equal(r3.escalated, true);
});

test('S19 高危审批批准后签发 Grant（INV-G2 签发-启动同事务领域语义，严格审计修复）', async () => {
  const flow = makeFlow();
  const t0 = new Date('2026-08-19T00:00:00Z');
  const r = flow.handleExecIntent({ intentId: 'i-1', actorId: 'dev-1', target: 'svc-1', capability: 'restart', now: t0 });
  assert.equal(r.status, 'pending_approval');
  const resolved = flow.resolveApproval({ approval: r.approval, votes: ['sre-1', 'sre-2'], now: new Date(t0.getTime() + 60000) });
  assert.equal(resolved.status, 'approved');
  assert.ok(resolved.grant, '批准后必须签发 Grant');
  assert.equal(resolved.grant.source, 'approval');
  assert.equal(resolved.grant.jobRef, r.approval.id, 'Grant 绑定作业');
  assert.equal(resolved.grant.target, 'svc-1', 'Grant 绑定目标');
  const stored = await flow.grantRepo.findById(resolved.grant.id);
  assert.ok(stored, 'Grant 已持久化');
});

test('S20 事件总线接线：高危→ApprovalRequested，批准→ApprovalApproved+GrantIssued，吊销→GrantRevoked（严格审计修复）', () => {
  const published = [];
  const flow = makeFlow({ publish: (e) => published.push(e) });
  const t0 = new Date('2026-08-19T00:00:00Z');
  flow.handleExecIntent({ intentId: 'i-1', actorId: 'dev-1', target: 'svc-1', capability: 'restart', now: t0 });
  assert.equal(published.length, 1, '高危意图发布 ApprovalRequested');
  assert.equal(published[0].type, 'ApprovalRequested');
  // 批准路径：重新发起一个高危意图取真实 approval，再解析
  const r = flow.handleExecIntent({ intentId: 'i-2', actorId: 'dev-1', target: 'svc-1', capability: 'restart', now: new Date(t0.getTime() + 1000) });
  const res = flow.resolveApproval({ approval: r.approval, votes: ['sre-1', 'sre-2'], now: new Date(t0.getTime() + 2000) });
  const types = published.map(e => e.type);
  assert.ok(types.includes('ApprovalApproved'), '批准发布 ApprovalApproved');
  assert.ok(types.includes('GrantIssued'), '签发发布 GrantIssued');
  flow.revokeGrant({ grant: res.grant, reason: '安全事件', now: new Date(t0.getTime() + 3000) });
  assert.ok(published.some(e => e.type === 'GrantRevoked'), '吊销发布 GrantRevoked');
  // 事件协议：schemaVersion + eventId + 载荷冻结
  const issued = published.find(e => e.type === 'GrantIssued');
  assert.equal(issued.schemaVersion, 1);
  assert.ok(issued.eventId && issued.eventId.length > 10, '事件带幂等键');
  assert.equal(Object.isFrozen(issued.grant), true, '载荷深冻结');
});

test('S21 自动 Grant 也发布 GrantIssued（INV-G4 矩阵通道，严格审计修复）', () => {
  const published = [];
  const flow = makeFlow({ publish: (e) => published.push(e) });
  flow.handleExecIntent({ intentId: 'i-1', actorId: 'dev-1', target: 'svc-1', capability: 'query_status', now: new Date() });
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'GrantIssued');
});

test('S22 真滑动窗口：活跃窗口内不过早清、出窗事件及时剔除（严格审计修复）', () => {
  const base = new Date('2026-08-19T00:00:00Z');
  const win = new AggregationWindow({ actorId: 'dev-1', assetId: 'svc-1', durationMs: 30 * 60 * 1000, createdAt: base });
  win.record('restart', new Date(base.getTime() + 5 * 60 * 1000));   // t+5min
  win.record('clean', new Date(base.getTime() + 20 * 60 * 1000));    // t+20min
  // t+36min：restart@5min 出窗（31min > 30min），clean@20min 仍在窗（16min）——原实现整体重置会把 clean 也误清
  const now = new Date(base.getTime() + 36 * 60 * 1000);
  assert.equal(win.countSameKind('restart', now), 0, 'restart 已出窗');
  assert.equal(win.countSameKind('clean', now), 1, 'clean 仍在窗（滑动不误清）');
});

test('S23 聚合窗口容量上限：超限拒绝记录（严格审计修复：防窗口无界 DoS）', () => {
  const now = new Date('2026-08-19T00:00:00Z');
  const win = new AggregationWindow({ actorId: 'dev-1', assetId: 'svc-1', createdAt: now });
  // 真实 record 填满 10000 条窗口内事件（时间递增且在 60s 窗口内）
  for (let i = 0; i < 10000; i++) win.record(`c${i}`, new Date(now.getTime() - 10000 + i));
  assert.throws(() => win.record('restart', now), (e) => e.code === 'AGG_WINDOW_LIMIT');
});

test('S24 Approval deadline 边界：恰在 deadline 视为过期（严格审计修复：闭区间防边界竞态宽松）', () => {
  const now = new Date('2026-08-19T00:00:00Z');
  const ap = new Approval({ id: 'ap-1', operatorId: 'dev-1', target: 'svc-1', highRiskType: 'restart', createdAt: now, timeoutMs: 60000 });
  assert.equal(ap.isExpired(new Date(now.getTime() + 60000)), true, 'deadline 边界时刻视为过期');
  assert.equal(ap.isExpired(new Date(now.getTime() + 59999)), false, '边界前 1ms 未过期');
});

test('S25 已终态单重复解析幂等：timed_out/approved 不抛异常不重复签发（严格审计第8波）', async () => {
  const published = [];
  const flow = makeFlow({ publish: (e) => published.push(e) });
  const t0 = new Date('2026-08-19T00:00:00Z');
  // 超时终态重复解析
  const r = flow.handleExecIntent({ intentId: 'i-1', actorId: 'dev-1', target: 'svc-1', capability: 'restart', now: t0 });
  const late = new Date(t0.getTime() + 31 * 60 * 1000);
  const first = flow.resolveApproval({ approval: r.approval, votes: ['sre-1'], now: late });
  assert.equal(first.status, 'timed_out');
  assert.doesNotThrow(() => flow.resolveApproval({ approval: r.approval, votes: ['sre-2'], now: late }), '终态重复解析不抛异常（A3 幂等）');
  assert.equal(published.filter(e => e.type === 'GrantIssued').length, 0, '超时无 Grant');
  // 已批准单重复解析：不重复签发 Grant
  const r2 = flow.handleExecIntent({ intentId: 'i-2', actorId: 'dev-1', target: 'svc-1', capability: 'restart', now: new Date(t0.getTime() + 1000) });
  const res = flow.resolveApproval({ approval: r2.approval, votes: ['sre-1', 'sre-2'], now: new Date(t0.getTime() + 2000) });
  assert.equal(res.status, 'approved');
  assert.ok(res.grant);
  const again = flow.resolveApproval({ approval: r2.approval, votes: [], now: new Date(t0.getTime() + 3000) });
  assert.equal(again.status, 'approved', '重复解析返回终态');
  assert.equal(published.filter(e => e.type === 'GrantIssued').length, 1, '同单批准只签发一次 Grant（幂等）');
  const stored = await flow.grantRepo.findById(res.grant.id);
  assert.ok(stored, 'Grant 持久化');
});

test('S26 Grant 有效期构造校验：负/0 TTL、倒挂 validUntil 拒绝（严格审计第8波）', () => {
  assert.throws(() => new Grant({ id: 'g', jobRef: 'j', target: 't', commandTemplate: 'c', ttlMs: -100 }), /ttlMs 必须为正/);
  assert.throws(() => new Grant({ id: 'g', jobRef: 'j', target: 't', commandTemplate: 'c', ttlMs: 0 }), /ttlMs 必须为正/);
  assert.throws(() => new Grant({ id: 'g', jobRef: 'j', target: 't', commandTemplate: 'c', ttlMs: NaN }), /ttlMs 必须为正/);
  assert.throws(() => new Grant({ id: 'g', jobRef: 'j', target: 't', commandTemplate: 'c', validUntil: new Date(2020) }), /validUntil 必须晚于/);
  assert.doesNotThrow(() => new Grant({ id: 'g', jobRef: 'j', target: 't', commandTemplate: 'c' }));
});

test('S27 白名单外能力拒绝：rm_rf_root/shell_exec_any 不得自动 Grant（严格审计第9波：INV-E3 附录C）', () => {
  const published = [];
  const flow = makeFlow({ publish: (e) => published.push(e) });
  const r = flow.handleExecIntent({ intentId: 'i-1', actorId: 'dev', target: 'svc', capability: 'rm_rf_root', now: new Date() });
  assert.equal(r.status, 'rejected', '非白名单能力拒绝');
  assert.equal(r.reason, 'capability_not_in_whitelist');
  const r2 = flow.handleExecIntent({ intentId: 'i-2', actorId: 'dev', target: 'svc', capability: 'shell_exec_any', now: new Date() });
  assert.equal(r2.status, 'rejected');
  assert.equal(published.some(e => e.type === 'CapabilityDenied'), true, '拒绝发布 CapabilityDenied 事件');
  // 白名单内正常
  const r3 = flow.handleExecIntent({ intentId: 'i-3', actorId: 'dev', target: 'svc', capability: 'restart', now: new Date() });
  assert.equal(r3.status, 'pending_approval', '白名单高危正常审批');
});

test('S28 审批人池 <3 或空池 fail-fast（严格审计第9波：INV-A4 硬约束）', () => {
  assert.throws(() => new ApprovalFlowService({ approvalRepo: {}, grantRepo: {}, aggregationRepo: {}, approvalPool: { resolvers: () => ['sre-1', 'sre-2'] } }), /≥3/);
  assert.throws(() => new ApprovalFlowService({ approvalRepo: {}, grantRepo: {}, aggregationRepo: {}, approvalPool: { resolvers: () => [] } }), /≥3/);
  assert.throws(() => new ApprovalFlowService({ approvalRepo: {}, grantRepo: {}, aggregationRepo: {}, approvalPool: {} }), /≥3/);
});

test('S29 Grant TTL 上限：超 7 天拒绝（严格审计第9波：防永久授权）', () => {
  const { GRANT_MAX_TTL_MS } = require('../src/trust/domain');
  assert.throws(() => new Grant({ id: 'g', jobRef: 'j', target: 't', commandTemplate: 'c', ttlMs: GRANT_MAX_TTL_MS + 1 }), /超上限/);
  assert.doesNotThrow(() => new Grant({ id: 'g', jobRef: 'j', target: 't', commandTemplate: 'c', ttlMs: GRANT_MAX_TTL_MS }));
});

test('S30 Approval/AggregationWindow 数值边界：timeoutMs/durationMs 正有限、createdAt 有效 Date（严格审计第11波）', () => {
  const now = new Date('2026-08-19T00:00:00Z');
  assert.throws(() => new Approval({ id: 'a', operatorId: 'o', target: 't', highRiskType: 'restart', timeoutMs: 0 }), /timeoutMs 必须为正/);
  assert.throws(() => new Approval({ id: 'a', operatorId: 'o', target: 't', highRiskType: 'restart', timeoutMs: -100 }), /timeoutMs 必须为正/);
  assert.throws(() => new Approval({ id: 'a', operatorId: 'o', target: 't', highRiskType: 'restart', timeoutMs: NaN }), /timeoutMs 必须为正/);
  assert.throws(() => new Approval({ id: 'a', operatorId: 'o', target: 't', highRiskType: 'restart', createdAt: 'not-a-date' }), /Date 实例/);
  assert.throws(() => new AggregationWindow({ actorId: 'a', assetId: 's', durationMs: 0 }), /durationMs 必须为正/);
  assert.throws(() => new AggregationWindow({ actorId: 'a', assetId: 's', durationMs: -1 }), /durationMs 必须为正/);
  assert.doesNotThrow(() => new Approval({ id: 'a', operatorId: 'o', target: 't', highRiskType: 'restart', createdAt: now }));
});

test('S31 聚合窗口时间倒退拒绝（严格审计第11波：防伪造历史事件混入窗口）', () => {
  const base = new Date('2026-08-19T00:00:00Z');
  const win = new AggregationWindow({ actorId: 'a', assetId: 's', durationMs: 60000, createdAt: base });
  win.record('restart', new Date(base.getTime() + 5000));
  assert.throws(() => win.record('restart', new Date(base.getTime() + 3000)), /时间倒退/);
  assert.equal(win.countSameKind('restart', new Date(base.getTime() + 6000)), 1, '倒退条未混入');
});

test('S32 Grant issuedAt 校验：字符串/Invalid Date 拒绝（严格审计第11波）', () => {
  assert.throws(() => new Grant({ id: 'g', jobRef: 'j', target: 't', commandTemplate: 'c', issuedAt: 'bad' }), /issuedAt/);
  assert.throws(() => new Grant({ id: 'g', jobRef: 'j', target: 't', commandTemplate: 'c', issuedAt: new Date('invalid') }), /issuedAt/);
});

test('S33 补位授权自证拒绝：授权人不可参与确认（严格审计第11波：与被授权人对称）', () => {
  const flow = new ApprovalFlowService({ approvalRepo: {}, grantRepo: {}, aggregationRepo: {}, approvalPool: { resolvers: () => ['sre-1', 'sre-2', 'sre-3'] } });
  assert.throws(() => flow.grantSubstitution({ grantedBy: 'mgr-1', grantee: 'sre-x', confirmators: ['mgr-1', 'mgr-2'] }), /授权人不可参与确认/);
  assert.doesNotThrow(() => flow.grantSubstitution({ grantedBy: 'mgr-1', grantee: 'sre-x', confirmators: ['mgr-2', 'mgr-3'] }));
});

test('S34 审批显式拒绝：SRE 可立即否决（R3/RQ-622，第14波：领域层此前无 reject 入口）', () => {
  const published = [];
  const flow = makeFlow({ publish: (e) => published.push(e) });
  const t0 = new Date('2026-08-19T00:00:00Z');
  const r = flow.handleExecIntent({ intentId: 'i-1', actorId: 'dev-1', target: 'svc-1', capability: 'restart', now: t0 });
  const res = flow.resolveApproval({ approval: r.approval, rejectBy: 'sre-1', now: new Date(t0.getTime() + 60000) });
  assert.equal(res.status, 'rejected', '显式拒绝立即生效（无需等超时）');
  assert.equal(r.approval.status, 'rejected');
  assert.equal(r.approval.rejectedBy, 'sre-1');
  assert.ok(published.some(e => e.type === 'ApprovalRejected'), '发布 ApprovalRejected');
  // 拒绝后不可再批准（A3 幂等）
  const again = flow.resolveApproval({ approval: r.approval, votes: ['sre-2', 'sre-3'], now: new Date(t0.getTime() + 120000) });
  assert.equal(again.status, 'rejected', '终态不可翻转');
  assert.equal(published.filter(e => e.type === 'GrantIssued').length, 0, '拒绝后无 Grant');
  // 重复拒绝幂等
  assert.equal(r.approval.reject('sre-2', { now: new Date(t0.getTime() + 180000) }), null, '终态重复拒绝幂等返回 null');
});

test('S35 跨资产聚合：同类 ≥10 台升级审批（INV-C4 跨资产维度，第17波：防分资产规避）', () => {
  const published = [];
  const flow = makeFlow({ publish: (e) => published.push(e) });
  const base = new Date('2026-08-19T00:00:00Z');
  for (let i = 0; i < 10; i++) {
    const r = flow.handleExecIntent({ intentId: 'i-' + i, actorId: 'dev-1', target: 'svc-' + i, capability: 'query_status', now: new Date(base.getTime() + i * 1000) });
    if (i < 9) assert.equal(r.status, 'auto_granted', `第${i + 1}台未达 10 台阈值`);
    else assert.equal(r.status, 'pending_approval', '第10台跨资产达阈值升级审批');
  }
  const esc = published.find(e => e.type === 'AggregationEscalated');
  assert.ok(esc, '发布 AggregationEscalated');
  assert.equal(esc.count, 10, '跨资产计数 10');
});

test('S36 AggregationWindow windowType 枚举校验（严格审计第22波）', () => {
  assert.throws(() => new AggregationWindow({ actorId: 'a', assetId: 's', windowType: 'weird' }), /windowType 非法/);
  assert.doesNotThrow(() => new AggregationWindow({ actorId: 'a', assetId: 's', windowType: 'asset' }));
});

test('S37 事件构造 null 防护：各 BC 事件 null 输入 fail-fast 明确错误（第22波：防原生 TypeError 泄露）', () => {
  const { GrantIssued, ApprovalRequested } = require('../src/trust/domain');
  assert.throws(() => new GrantIssued(null), /grant 必须为 Grant 实例/);
  assert.throws(() => new ApprovalRequested(null), /approval 必须为 Approval 实例/);
  const { MetricRecorded } = require('../../m1/src/obs/domain');
  assert.throws(() => new MetricRecorded(null, 1), /sample 必填/);
  const { IntentRecognized } = require('../../m2/src/conv/domain');
  assert.throws(() => new IntentRecognized(null), /intent 必填/);
});

test('S38 审批/Grant 封装修复：votes/status/revokedAt/validUntil 只读防外部伪造（第27波 Critical）', () => {
  const t0 = new Date('2026-08-19T00:00:00Z');
  const ap = new Approval({ id: 'a', operatorId: 'dev', target: 'svc', highRiskType: 'restart', createdAt: t0 });
  ap.addVote('sre-1', { now: t0 });
  // votes 防伪造（外部 push 第二票不应达成双人）
  assert.throws(() => { ap.votes.push({ personId: 'evil', webAuthnConfirmed: true, seq: 99 }); }, TypeError, 'votes 冻结拷贝');
  assert.equal(ap.resolve(t0), 'pending', '外部无法伪造第二票');
  // status 防篡改
  assert.throws(() => { ap.status = 'approved'; }, TypeError, 'status 只读');
  // Grant 吊销防撤销
  const g = new Grant({ id: 'g', jobRef: 'j', target: 't', commandTemplate: 'c' });
  g.revoke('r', t0);
  assert.throws(() => { g.revokedAt = null; }, TypeError, 'revokedAt 只读');
  assert.equal(g.isValid(t0), false, '吊销不可撤销');
  // validUntil 防延长
  const g2 = new Grant({ id: 'g2', jobRef: 'j', target: 't', commandTemplate: 'c', ttlMs: 3600000 });
  assert.throws(() => { g2.validUntil = new Date('2030-01-01T00:00:00Z'); }, TypeError, 'validUntil 只读');
  assert.equal(g2.isValid(new Date('2029-01-01T00:00:00Z')), false, '1h TTL 未延长');
});

test('S39 剩余暴露面封闭：events 拷贝隔离、votes 元素深冻结（第28波：第27波修复补全）', () => {
  const t0 = new Date('2026-08-19T00:00:00Z');
  // events 拷贝隔离（外部 push 不污染内部计数——数组冻结直接拒绝）
  const win = new AggregationWindow({ actorId: 'a', assetId: 's', durationMs: 60000, createdAt: t0 });
  assert.throws(() => win.events.push({ capability: 'restart', at: t0 }), TypeError, 'events 数组冻结');
  assert.equal(win.countSameKind('restart', t0), 0, '外部 push 不污染内部计数');
  // votes 元素深冻结（第 27 波只冻数组——元素 personId 仍可篡改的残留）
  const ap = new Approval({ id: 'a', operatorId: 'dev', target: 'svc', highRiskType: 'restart', createdAt: t0 });
  ap.addVote('sre-1', { now: t0 });
  assert.throws(() => { ap.votes[0].personId = 'evil'; }, TypeError, '票元素深冻结');
  assert.equal(ap.votes[0].personId, 'sre-1', '票保持原值');
});

test('S40 Grant 绑定只读 + 窗口字段只读（第29波：防重定向攻击/窗口篡改）', () => {
  const t0 = new Date('2026-08-19T00:00:00Z');
  // Grant 绑定字段只读（C2 Critical 残留：防重绑定到任意作业）
  const g = new Grant({ id: 'g', jobRef: 'j', target: 't', commandTemplate: 'c', paramsHash: 'h' });
  for (const f of ['jobRef', 'target', 'commandTemplate', 'paramsHash']) {
    assert.throws(() => { g[f] = 'hacked'; }, TypeError, `${f} 只读`);
  }
  assert.equal(g.matches('j', 't', 'c', 'h'), true, '绑定保持');
  assert.equal(g.matches('j', 't', 'c', 'x'), false, '参数校验不受篡改影响');
  // AggregationWindow 字段只读（C1：防延长窗口/改归属）
  const win = new AggregationWindow({ actorId: 'a', assetId: 's', durationMs: 60000, createdAt: t0 });
  for (const f of ['actorId', 'assetId', 'windowType', 'durationMs', 'createdAt']) {
    assert.throws(() => { win[f] = 'hacked'; }, TypeError, `${f} 只读`);
  }
});

test('S41 二分 prune 语义保持 + 性能（第34波：O(n²)→O(log n)，出窗剔除/窗内保留/闭区间边界）', () => {
  const base = new Date('2026-08-19T00:00:00Z');
  const win = new AggregationWindow({ actorId: 'a', assetId: 's', durationMs: 30 * 60 * 1000, createdAt: base });
  win.record('restart', new Date(base.getTime() + 5 * 60 * 1000));
  win.record('clean', new Date(base.getTime() + 20 * 60 * 1000));
  // 出窗剔除 + 窗内保留
  assert.equal(win.countSameKind('restart', new Date(base.getTime() + 36 * 60 * 1000)), 0, 'restart 出窗剔除');
  assert.equal(win.countSameKind('clean', new Date(base.getTime() + 36 * 60 * 1000)), 1, 'clean 窗内保留');
  // 闭区间边界
  const win2 = new AggregationWindow({ actorId: 'a', assetId: 's', durationMs: 30 * 60 * 1000, createdAt: base });
  win2.record('restart', new Date(base.getTime() + 5 * 60 * 1000));
  assert.equal(win2.countSameKind('restart', new Date(base.getTime() + 35 * 60 * 1000)), 1, '恰 30min 边界保留');
  assert.equal(win2.countSameKind('restart', new Date(base.getTime() + 35 * 60 * 1000 + 1)), 0, '30min+1ms 出窗');
});

test('S42 handleExecIntent 入口参数校验：空主体/目标/意图/能力 → REJECTED 非异常（第36波）', () => {
  const flow = makeFlow();
  const r1 = flow.handleExecIntent({ intentId: 'i1', actorId: '', target: 'svc', capability: 'query_status', now: new Date() });
  assert.equal(r1.status, 'rejected');
  assert.equal(r1.reason, 'invalid_params');
  const r2 = flow.handleExecIntent({ intentId: '', actorId: 'dev', target: 'svc', capability: 'restart', now: new Date() });
  assert.equal(r2.reason, 'invalid_params');
  const r3 = flow.handleExecIntent({ intentId: 'i3', actorId: 'dev', target: '', capability: 'restart', now: new Date() });
  assert.equal(r3.reason, 'invalid_params');
  const r4 = flow.handleExecIntent({ intentId: 'i4', actorId: 'dev', target: 'svc', capability: '', now: new Date() });
  assert.equal(r4.reason, 'invalid_params');
});

test('S43 值对象/事件校验：ApprovalVote 只读、AggregationEscalated 载荷校验（第39波）', () => {
  const t0 = new Date('2026-08-19T00:00:00Z');
  const v = new ApprovalVote({ personId: 'sre-1', webAuthnConfirmed: true, seq: 1 });
  assert.throws(() => { v.personId = 'evil'; }, TypeError, '票主体不可篡改');
  assert.equal(v.personId, 'sre-1');
  assert.throws(() => new AggregationEscalated(null), /载荷必填/);
  assert.throws(() => new AggregationEscalated({ actorId: 'a', target: 't', capability: 'c' }), /count 必填/);
  assert.doesNotThrow(() => new AggregationEscalated({ actorId: 'a', target: 't', capability: 'c', count: 3 }));
});

test('S44 聚合窗口 capability 校验：字符串+长度上限（第40波：防内存放大）', () => {
  const t0 = new Date('2026-08-19T00:00:00Z');
  const win = new AggregationWindow({ actorId: 'a', assetId: 's', durationMs: 60000, createdAt: t0 });
  assert.throws(() => win.record(123, t0), /capability 非法/);
  assert.throws(() => win.record('x'.repeat(100000), t0), /capability 非法/);
  assert.doesNotThrow(() => win.record('restart', t0));
});

test('S45 Grant.revoke 时间校验：Invalid Date 拒绝（第42波）', () => {
  const g = new Grant({ id: 'g', jobRef: 'j', target: 't', commandTemplate: 'c' });
  assert.throws(() => g.revoke('r', new Date('invalid')), /有效 Date/);
  assert.throws(() => g.revoke('r', 'not-a-date'), /有效 Date/);
  assert.doesNotThrow(() => g.revoke('r', new Date()), '有效时间吊销');
  assert.equal(g.isValid(new Date()), false);
});

test('S46 AGG_ASSET_THRESHOLD 导出（第47波：聚合阈值常量完整导出）', () => {
  const m = require('../src/trust/domain');
  assert.equal(m.AGG_ASSET_THRESHOLD, 10);
  assert.ok(m.AGG_SAME_KIND_THRESHOLD && m.AGG_CROSS_BUCKET_THRESHOLD && m.AGG_WINDOW_MAX_EVENTS);
});

test('S47 CapabilityDenied 载荷校验+冻结（第48波：对齐事件协议）', () => {
  const published = [];
  const flow = makeFlow({ publish: (e) => published.push(e) });
  flow.handleExecIntent({ intentId: 'i', actorId: 'dev', target: 'svc', capability: 'rm_rf', now: new Date() });
  const ev = published[0];
  assert.equal(ev.type, 'CapabilityDenied');
  assert.equal(ev.reason, 'not_in_whitelist');
  assert.equal(Object.isFrozen(ev), true, '事件冻结');
  assert.throws(() => new (require('../src/trust/domain').CapabilityDenied)(null), /载荷必填/);
  assert.throws(() => new (require('../src/trust/domain').CapabilityDenied)({ intentId: 'i', actorId: '', target: 't', capability: 'c', reason: 'r', at: new Date() }), /必填/);
});

test('S48 关键导出存在性：白名单/查询能力/事件类（第52波：覆盖缺口补全）', () => {
  const m = require('../src/trust/domain');
  // 白名单/查询能力（安全关键）
  assert.ok(m.WHITELIST_CAPABILITIES.includes('restart'));
  assert.ok(m.QUERY_CAPABILITIES.includes('query_status'));
  assert.equal(m.GRANT_DEFAULT_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(m.SUBSTITUTION_TTL_MS, 90 * 24 * 60 * 60 * 1000);
  assert.equal(m.AGG_WINDOW_SESSION_MS, 30 * 60 * 1000);
  assert.equal(m.AGG_WINDOW_ACCOUNT_MS, 60 * 60 * 1000);
  // 事件类（协议对齐）
  assert.equal(typeof m.ApprovalTimedOut, 'function');
  assert.equal(typeof m.GrantExpired, 'function');
  assert.equal(typeof m.SubstitutionGranted, 'function');
  assert.equal(typeof m.SubstitutionRevoked, 'function');
});

test('S48b 补位授权回收：revokeSubstitution → 广播 SubstitutionRevoked（INV-A4 SRE 恢复自动回收，第25波补）', () => {
  const events = [];
  const bus = { publish(e) { events.push(e); } };
  const flow = new ApprovalFlowService({ approvalRepo: {}, grantRepo: {}, aggregationRepo: {}, approvalPool: { resolvers: () => ['sre-1', 'sre-2', 'sre-3'] }, eventBus: bus });
  const s = flow.revokeSubstitution({ grantedBy: 'mgr-1', grantee: 'sre-x', reason: 'sre_pool_restored' });
  assert.equal(s.grantee, 'sre-x');
  assert.equal(s.revokedBy, 'mgr-1');
  assert.equal(s.reason, 'sre_pool_restored');
  assert.ok(s.revokedAt instanceof Date);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'SubstitutionRevoked');
  assert.equal(events[0].substitution.grantee, 'sre-x');
  assert.equal(events[0].schemaVersion, 1);
});

test('S49 事件快照 votes 含 webAuthnConfirmed（第74波：INV-A5 审计证据完整）', () => {
  const ap = new Approval({ id: 'a', operatorId: 'o', target: 't', highRiskType: 'restart', createdAt: new Date() });
  ap.addVote('sre-1', { now: new Date() });
  const ev = new ApprovalRequested(ap);
  assert.equal(ev.approval.votes[0].personId, 'sre-1');
  assert.equal(ev.approval.votes[0].webAuthnConfirmed, true, '审计证据含 WebAuthn 确认');
  assert.equal(ev.approval.votes[0].seq, 1);
});

test('S50 events getter 数组冻结（第78波：对齐 votes getter）', () => {
  const t0 = new Date('2026-08-19T00:00:00Z');
  const win = new AggregationWindow({ actorId: 'a', assetId: 's', durationMs: 60000, createdAt: t0 });
  win.record('restart', t0);
  assert.equal(Object.isFrozen(win.events), true, '数组冻结');
  assert.equal(Object.isFrozen(win.events[0]), true, '元素冻结');
});

test('S51 事件快照 terminalSeq（第83波：A3 幂等锚点/审计时序）', () => {
  const t0 = new Date('2026-08-19T00:00:00Z');
  const ap = new Approval({ id: 'a', operatorId: 'o', target: 't', highRiskType: 'restart', createdAt: t0 });
  ap.addVote('sre-1', { now: t0 }); ap.addVote('sre-2', { now: t0 }); ap.resolve(t0);
  const ev = new ApprovalRequested(ap);
  assert.equal(typeof ev.approval.terminalSeq, 'number', '终态时序在快照');
  assert.equal(ev.approval.status, 'approved');
  // pending 单 terminalSeq null
  const ap2 = new Approval({ id: 'b', operatorId: 'o', target: 't', highRiskType: 'restart', createdAt: t0 });
  const ev2 = new ApprovalRequested(ap2);
  assert.equal(ev2.approval.terminalSeq, null, 'pending 无终态时序');
});

test('S52 events getter at 拷贝隔离（第89波 Critical：Date 引用共享防篡改污染内部）', () => {
  const t0 = new Date('2026-08-19T00:00:00Z');
  const win = new AggregationWindow({ actorId: 'a', assetId: 's', durationMs: 60000, createdAt: t0 });
  win.record('restart', new Date(t0.getTime() + 1000));
  const e = win.events[0];
  e.at.setTime(t0.getTime() - 99999999); // 篡改 getter 拷贝
  assert.equal(win.countSameKind('restart', new Date(t0.getTime() + 2000)), 1, '内部计数不受篡改影响');
  assert.equal(win.events[0].at.toISOString(), new Date(t0.getTime() + 1000).toISOString(), '内部 at 原样');
});

test('S53 领域对象 Date getter 拷贝隔离（第90波 Critical：createdAt/validUntil/issuedAt/窗口createdAt 防 setTime 污染内部）', () => {
  const t0 = new Date('2026-08-19T00:00:00Z');
  // Grant
  const g = new Grant({ id: 'g', jobRef: 'j', target: 't', commandTemplate: 'c', issuedAt: new Date(t0.getTime()) });
  g.validUntil.setTime(0); g.issuedAt.setTime(0);
  assert.equal(g.validUntil.toISOString(), new Date(t0.getTime() + 24 * 3600 * 1000).toISOString(), 'validUntil 拷贝隔离');
  assert.equal(g.issuedAt.toISOString(), t0.toISOString(), 'issuedAt 拷贝隔离');
  // Approval
  const ap = new Approval({ id: 'a', operatorId: 'o', target: 't', highRiskType: 'restart', createdAt: new Date(t0.getTime()) });
  ap.createdAt.setTime(0);
  assert.equal(ap.createdAt.toISOString(), t0.toISOString(), 'createdAt 拷贝隔离');
  assert.equal(ap.deadline.toISOString(), new Date(t0.getTime() + 30 * 60 * 1000).toISOString(), 'deadline 未污染');
  // 窗口
  const win = new AggregationWindow({ actorId: 'a', assetId: 's', durationMs: 60000, createdAt: new Date(t0.getTime()) });
  win.createdAt.setTime(0);
  assert.equal(win.createdAt.toISOString(), t0.toISOString(), '窗口 createdAt 拷贝隔离');
  assert.equal(win.isExpired(new Date(t0.getTime() + 1000)), false, '窗口过期判定未污染');
});

test('S54 事件快照 rejectedBy（第95波：拒绝者审计证据）', () => {
  const ap = new Approval({ id: 'a', operatorId: 'o', target: 't', highRiskType: 'restart', createdAt: new Date() });
  ap.reject('sre-1', { now: new Date() });
  const ev = new ApprovalRejected(ap, new Date());
  assert.equal(ev.approval.rejectedBy, 'sre-1', '拒绝者在快照');
  assert.equal(ev.approval.status, 'rejected');
  // pending 单 null
  const ap2 = new Approval({ id: 'b', operatorId: 'o', target: 't', highRiskType: 'restart', createdAt: new Date() });
  const ev2 = new ApprovalRequested(ap2);
  assert.equal(ev2.approval.rejectedBy, null, 'pending 无拒绝者');
});

// ---------- 第 27 波修复验证：checkGrant + paramsHash 跨 BC 绑定 ----------
test('C1 checkGrant 有效 Grant 全匹配 → ok:true（DDD §4 exec→trust 契约，第27波补）', () => {
  const flow = makeFlow();
  const r = flow.handleExecIntent({ intentId: 'i-1', actorId: 'dev-1', target: 'svc-1', capability: 'query_status', params: { q: 'cpu' }, now: new Date() });
  assert.equal(r.status, 'auto_granted');
  const grant = r.grant;
  const check = flow.checkGrant(grant.id, grant.target, grant.commandTemplate, grant.paramsHash, new Date());
  assert.equal(check.ok, true);
});

test('C2 checkGrant paramsHash 不匹配 → not_matching（Grant 绑定参数生效，非空串）', () => {
  const flow = makeFlow();
  const r = flow.handleExecIntent({ intentId: 'i-1', actorId: 'dev-1', target: 'svc-1', capability: 'query_status', params: { q: 'cpu' }, now: new Date() });
  const grant = r.grant;
  assert.notEqual(grant.paramsHash, '', 'Grant 绑定真实 paramsHash，非空串');
  const bad = flow.checkGrant(grant.id, grant.target, grant.commandTemplate, 'wrong-hash', new Date());
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'not_matching');
});

test('C3 checkGrant 吊销 Grant → revoked', () => {
  const flow = makeFlow();
  const r = flow.handleExecIntent({ intentId: 'i-1', actorId: 'dev-1', target: 'svc-1', capability: 'query_status', params: {}, now: new Date() });
  flow.revokeGrant({ grant: r.grant, reason: 'test' });
  const check = flow.checkGrant(r.grant.id, r.grant.target, r.grant.commandTemplate, r.grant.paramsHash, new Date());
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'revoked');
});

test('C4 审批批准 Grant 绑定 Approval.paramsHash（非空串）', () => {
  const flow = makeFlow();
  const r = flow.handleExecIntent({ intentId: 'i-1', actorId: 'dev-1', target: 'svc-1', capability: 'restart', params: { command: 'restart_service' }, now: new Date() });
  assert.equal(r.status, 'pending_approval');
  assert.notEqual(r.approval.paramsHash, '', 'Approval 绑定真实 paramsHash（非空串）');
  const ok = flow.resolveApproval({ approval: r.approval, votes: ['sre-1', 'sre-2'], now: new Date() });
  assert.equal(ok.status, 'approved');
  assert.notEqual(ok.grant.paramsHash, '', '批准签发的 Grant 绑定真实 paramsHash');
  const check = flow.checkGrant(ok.grant.id, ok.grant.target, ok.grant.commandTemplate, ok.grant.paramsHash, new Date());
  assert.equal(check.ok, true);
});

// ---------- 第 32 波审计补：Approval 审计证据封装（terminalSeq/rejectedBy 只读）----------
test('W4 terminalSeq/rejectedBy 只读——外部篡改拒绝（第32波：防伪造A3幂等锚点/拒绝者证据）', () => {
  const ap = new Approval({ id: 'ap-w4', operatorId: 'dev-1', target: 'svc-1', highRiskType: 'restart', createdAt: new Date() });
  ap.addVote('sre-1'); ap.addVote('sre-2'); ap.resolve(new Date());
  // 正常读（getter）
  assert.ok(typeof ap.terminalSeq === 'number', '终态时序可读');
  // 严格模式写 → TypeError（只有 getter 无 setter）
  assert.throws(() => { 'use strict'; ap.terminalSeq = 999; }, TypeError, 'terminalSeq 不可写');
  assert.throws(() => { 'use strict'; ap.rejectedBy = 'hacker'; }, TypeError, 'rejectedBy 不可写');
  // 拒绝路径同样封装
  const ap2 = new Approval({ id: 'ap-w4b', operatorId: 'dev-1', target: 'svc-1', highRiskType: 'restart', createdAt: new Date() });
  ap2.reject('sre-9', { now: new Date() });
  assert.equal(ap2.rejectedBy, 'sre-9', '拒绝者通过领域方法正确记录');
  assert.throws(() => { 'use strict'; ap2.rejectedBy = 'forged'; }, TypeError);
});

// ---------- 第 32 波审计补：Approval 重定向防护（target/operatorId/source 只读）----------
test('W5 Approval/Grant 身份字段只读——防审批重定向/归属伪造（第32波：与Grant同防重定向面）', () => {
  const ap = new Approval({ id: 'ap-w5', operatorId: 'dev-1', target: 'svc-1', highRiskType: 'restart', createdAt: new Date() });
  // 测试文件为严格模式：getter-only 赋值直接抛 TypeError（非严格模式则静默忽略=值不变）
  assert.throws(() => { ap.target = 'svc-EVIL'; }, TypeError, 'target 只读：写拒绝');
  assert.equal(ap.target, 'svc-1', 'target 值未变');
  assert.throws(() => { ap.operatorId = 'evil'; }, TypeError);
  assert.equal(ap.operatorId, 'dev-1');
  assert.throws(() => { ap.highRiskType = 'delete'; }, TypeError);
  assert.equal(ap.highRiskType, 'restart');
  // Grant.source 只读（来源标记不可伪造）
  const g = new Grant({ id: 'g-w5', jobRef: 'j', target: 's', commandTemplate: 'restart', source: 'approval', issuedAt: new Date() });
  assert.throws(() => { g.source = 'matrix'; }, TypeError);
  assert.equal(g.source, 'approval', 'Grant.source 只读');
});

// ---------- 第 32 波审计补：GrantRevoked 顶层 revokedReason（跨 BC 一致性对齐 M4 订阅端）----------
test('W6 GrantRevoked 事件顶层携带 revokedReason（第32波：吊销原因不丢失，对齐 M4 订阅）', () => {
  const flow = new ApprovalFlowService({
    approvalRepo: new InMemoryApprovalRepo(), grantRepo: new InMemoryGrantRepo(),
    aggregationRepo: new InMemoryAggregationRepo(), approvalPool: { resolvers: () => ['sre-1', 'sre-2', 'sre-3'] },
  });
  const t0 = new Date('2026-01-01T00:00:00Z');
  const r = flow.handleExecIntent({ intentId: 'i-w6', actorId: 'dev-1', target: 'svc-1', capability: 'restart', params: { command: 'restart_service' }, now: t0 });
  const res = flow.resolveApproval({ approval: r.approval, votes: ['sre-1', 'sre-2'], now: new Date(t0.getTime() + 1000) });
  flow.revokeGrant({ grant: res.grant, reason: '安全事件', now: new Date(t0.getTime() + 2000) });
  const ev = new GrantRevoked(res.grant);
  assert.equal(ev.revokedReason, '安全事件', '顶层携带吊销原因');
  assert.equal(ev.grant.revokedReason, '安全事件', '快照内也携带');
  assert.equal(ev.grant.revokedAt, new Date(t0.getTime() + 2000).toISOString(), '吊销时间在快照');
});
