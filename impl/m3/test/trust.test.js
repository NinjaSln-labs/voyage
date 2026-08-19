// trust 审批信任域 契约测试（happy/error/edge/adversarial）
// 依据：M0-D INV-A1~A5（审批）、INV-G1~G4（Grant）、INV-C4（聚合）、INV-T1（准入）、INV-E5（吊销）
// 运行：node --test impl/m3/test/trust.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Approval, Grant, AggregationWindow, AccessEvidence, ApprovalFlowService, ApprovalVote,
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
  const flow = new ApprovalFlowService({ approvalRepo: {}, grantRepo: {}, aggregationRepo: {}, approvalPool: {} });
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
  win.record('restart', new Date(base.getTime() + 2000)); // 窗口过期 → 重置只计此条
  assert.equal(win.countSameKind('restart'), 1, '过期窗口重置后只计新事件');
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
  assert.equal(win.totalCount, 10);
  assert.equal(win.totalCount >= AGG_CROSS_BUCKET_THRESHOLD, true, '跨桶累计升级');
});

test('A2 操作者不可自批 + 补位（INV-A4 组合）', () => {
  const flow = new ApprovalFlowService({ approvalRepo: {}, grantRepo: {}, aggregationRepo: {}, approvalPool: {} });
  const s = flow.grantSubstitution({ grantedBy: 'mgr-1', grantee: 'sre-x', confirmators: ['mgr-1', 'mgr-2'] });
  assert.equal(s.grantee, 'sre-x');
  assert.equal(s.autoRevokeWhen, 'sre_pool_restored', 'SRE 恢复自动回收');
  assert.ok(s.validUntil > s.validFrom);
});

test('A3 Grant 绑定校验防复用（INV-G2：参数哈希不匹配不可用）', () => {
  const g = new Grant({ id: 'gr-1', jobRef: 'job-1', target: 'svc-1', commandTemplate: 'restart', paramsHash: 'h1' });
  assert.equal(g.matches('job-1', 'svc-1', 'restart', 'h2'), false, '参数哈希不同拒绝（防参数篡改复用）');
});
