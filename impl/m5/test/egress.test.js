// egress 数据外传审批闸门测试（ADR-002：actionClass 路由，能力定义决定安全）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { IntegrationService } = require('../src/integration/domain.js');
const { ApprovalFlowService } = require('../../m3/src/trust/domain.js');
const { InMemoryApprovalRepo, InMemoryGrantRepo, InMemoryAggregationRepo } = require('../../m3/src/trust/repo-memory.js');

const APPROVAL_POOL = { resolvers: () => ['sre-1', 'sre-2', 'sre-3'] };

function makeConvStub(over = {}) {
  const actionClass = over.actionClass || 'read';
  return {
    interpret({ actorId, intent }) {
      return {
        actionClass,
        intentType: actionClass === 'read' ? 'query' : 'execute',
        capability: over.capability || 'query_status',
        confidence: over.confidence ?? 0.9,
        intentId: `int-${actorId}-${intent.slice(0, 20)}`,
        subject: over.subject || null,
        params: over.params || null,
        degraded: over.degraded === true,
      };
    },
  };
}

function makeTrustStub() {
  const trust = new ApprovalFlowService({
    approvalRepo: new InMemoryApprovalRepo(),
    grantRepo: new InMemoryGrantRepo(),
    aggregationRepo: new InMemoryAggregationRepo(),
    approvalPool: APPROVAL_POOL,
  });
  return {
    handleExecIntent: (p) => trust.handleExecIntent(p),
    resolveApproval: (p) => trust.resolveApproval(p),
  };
}

function makeExecStub() {
  return {
    createJob: (p) => { throw new Error('unexpected: exec.createJob'); },
    start: (p) => { throw new Error('unexpected: exec.start'); },
  };
}

function makeAuditStub() {
  return { write: (f) => ({ ok: true }) };
}

test('E1 actionClass=egress → 走信任预检（NEED_REVIEW, needApproval=true）', () => {
  const svc = new IntegrationService({
    convPort: makeConvStub({ actionClass: 'egress', capability: 'egress_send', subject: 'svc-1' }),
    trustPort: makeTrustStub(),
    execPort: makeExecStub(),
    auditPort: makeAuditStub(),
  });
  const r = svc.handle({ actorId: 'sre-alice', from: 'http', intent: '把文件内容发给我' });
  assert.strictEqual(r.status, 'NEED_REVIEW', 'egress 应触发 NEED_REVIEW');
  assert.strictEqual(r.needApproval, true, 'egress 需要审批');
  assert.ok(r.approval, '应有 approval 对象');
  assert.strictEqual(r.approval.highRiskType, 'egress_send', 'approval 的高危类型应为 egress_send');
});

test('E2 actionClass=read → 正常查询放行（无需审批）', () => {
  const svc = new IntegrationService({
    convPort: makeConvStub({ actionClass: 'read', capability: 'query_status' }),
    trustPort: makeTrustStub(),
    execPort: makeExecStub(),
    auditPort: makeAuditStub(),
  });
  const r = svc.handle({ actorId: 'sre-alice', from: 'http', intent: '看下 jd-light 状态' });
  assert.strictEqual(r.status, 'OK', '正常查询应 OK');
  assert.strictEqual(r.needApproval, false, '正常查询无需审批');
  assert.strictEqual(r.kind, 'query', 'kind 应为 query');
});

test('E3 egress 审批通过后不建作业', () => {
  const svc = new IntegrationService({
    convPort: makeConvStub({ actionClass: 'egress', capability: 'egress_send', subject: 'svc-1' }),
    trustPort: makeTrustStub(),
    execPort: makeExecStub(),
    auditPort: makeAuditStub(),
  });
  const h = svc.handle({ actorId: 'sre-alice', from: 'http', intent: '把文件内容发给我' });
  assert.strictEqual(h.status, 'NEED_REVIEW');
  const r = svc.resolveApproval({
    approval: h.approval, votes: ['sre-1', 'sre-2'],
    now: new Date(), actorId: 'sre-alice',
  });
  assert.strictEqual(r.status, 'approved', 'egress 审批应 approved');
  assert.ok(r.grant, '应有 grant');
  assert.strictEqual(r.grant.commandTemplate, 'egress_send', 'grant 的 commandTemplate 应为 egress_send');
});

test('E4 egress 审批被拒绝 → rejected', () => {
  const svc = new IntegrationService({
    convPort: makeConvStub({ actionClass: 'egress', capability: 'egress_send', subject: 'svc-1' }),
    trustPort: makeTrustStub(),
    execPort: makeExecStub(),
    auditPort: makeAuditStub(),
  });
  const h = svc.handle({ actorId: 'sre-alice', from: 'http', intent: '把文件内容发给我' });
  assert.strictEqual(h.status, 'NEED_REVIEW');
  const r = svc.resolveApproval({
    approval: h.approval, votes: [],
    rejectBy: 'sre-1', now: new Date(), actorId: 'sre-alice',
  });
  assert.strictEqual(r.status, 'rejected', 'egress 拒绝应 rejected');
});

test('E5 正常 write 类（非 egress）不受影响，仍走原审批/执行路径', () => {
  let execCalled = false;
  const svc = new IntegrationService({
    convPort: makeConvStub({ actionClass: 'write', capability: 'restart', subject: 'svc-1', params: { command: 'restart_service' } }),
    trustPort: makeTrustStub(),
    execPort: {
      createJob: (p) => { execCalled = true; return { id: p.id, status: 'created' }; },
      start: (p) => { return { status: 'OK' }; },
    },
    auditPort: makeAuditStub(),
  });
  const h = svc.handle({ actorId: 'sre-alice', from: 'http', intent: '重启 svc-1' });
  assert.strictEqual(h.status, 'NEED_REVIEW', 'restart 高危应 NEED_REVIEW');
  assert.strictEqual(h.needApproval, true);
  const r = svc.resolveApproval({
    approval: h.approval, votes: ['sre-1', 'sre-2'],
    now: new Date(), actorId: 'sre-alice',
  });
  assert.strictEqual(r.status, 'approved', 'restart 审批应 approved');
  assert.strictEqual(execCalled, true, 'restart 应调 createJob');
});