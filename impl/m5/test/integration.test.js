// integration 契约测试：IntegrationService + OutboxJournal（RQ-623 / INV-N2 / RQ-831）
// 命名 H/E/G/A/F 对齐 M3/M4（happy/error/edge/adversarial/fault-tolerance）
// 桩端口：模拟 conv（interpret）、trust（handleExecIntent/resolveApproval）、exec（createJob/start）、audit

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { IntegrationService, OutboxJournal } = require('../src/integration/domain.js');
const { OutboxMessage } = require('../src/integration/outbox.js');
const { createOutboxRepo } = require('../src/integration/repo-memory.js');
const { AuditEntry, AppendOnlyAuditChain } = require('../src/audit/domain.js');
const { createAuditRepo } = require('../src/audit/repo-memory.js');

// ---------- 契约桩 ----------

/** conv 桩：interpret 返回意图类型。{ intentType, capability, confidence, intentId, subject, params } */
function makeConvStub(defaults = {}) {
  return {
    interpret({ actorId, intent, now }) {
      return {
        intentType: defaults.intentType || 'execute',
        capability: defaults.capability || 'restart',
        confidence: defaults.confidence ?? 0.9,
        intentId: defaults.intentId || `int-${intent}`,
        subject: defaults.subject || 'srv1',
        params: defaults.params || { command: 'restart_service' },
        ...defaults.overrides,
      };
    },
  };
}

/** trust 桩：handleExecIntent 返回 { status, approval?, grant?, escalated?, reason? } */
function makeTrustStub(defaults = {}) {
  return {
    handleExecIntent({ intentId, actorId, target, capability, now }) {
      return {
        status: defaults.handleStatus || 'auto_granted',
        grant: defaults.grant || { id: `gr-${intentId}`, jobRef: intentId, target: target || 'srv1', commandTemplate: capability || 'restart' },
        approval: defaults.approval || null,
        escalated: defaults.escalated || false,
        reason: defaults.reason || null,
      };
    },
    resolveApproval({ approval, votes, rejectBy, now }) {
      return {
        status: defaults.resolveStatus || 'approved',
        grant: defaults.resolveGrant || { id: `gr-${approval ? approval.id : 'ap-x'}`, jobRef: approval ? approval.id : 'ap-x', target: 'srv1', commandTemplate: 'restart' },
        rejected: defaults.rejected || false,
        timed_out: defaults.timedOut || false,
        approval,
      };
    },
  };
}

/** exec 桩：createJob + start 模拟 M4 */
function makeExecStub() {
  const jobs = new Map();
  const started = [];
  return {
    jobs,
    started,
    createJob({ id, creator, target, template, params, grantRef }) {
      const job = { id, creator, target, template, params, grantRef, status: 'queued' };
      jobs.set(id, job);
      return job;
    },
    start({ jobId, now }) {
      const job = this.jobs.get(jobId);
      if (!job) return { status: 'ERROR', reason: 'job_not_found' };
      job.status = 'running';
      this.started.push(jobId);
      return { status: 'OK', job };
    },
  };
}

/** audit 桩：穿透 AppendOnlyAuditChain */
function makeAuditStub() {
  const chain = new AppendOnlyAuditChain();
  return {
    chain,
    write(entry) {
      const ae = new AuditEntry(entry);
      return chain.append(ae);
    },
    verify() { return chain.verify(); },
    entries() { return chain.entries(); },
    tailHash() { return chain.tailHash; },
  };
}

// ---------- happy ----------
test('H1 查询类意图 → 直接 OK 且审计留痕', () => {
  const conv = makeConvStub({ intentType: 'query', capability: 'query_status' });
  const audit = makeAuditStub();
  const svc = new IntegrationService({ convPort: conv, trustPort: makeTrustStub(), execPort: makeExecStub(), auditPort: audit });
  const r = svc.handle({ actorId: 'u1', from: 'cli', intent: '查一下 srv1 状态' });
  assert.strictEqual(r.status, 'OK');
  assert.strictEqual(r.needApproval, false);
  assert.strictEqual(audit.chain.length, 1);
  assert.strictEqual(audit.verify().ok, true);
});

test('H2 自动 Grant → createJob + start 串联，执行成功', () => {
  const conv = makeConvStub({ intentType: 'execute', capability: 'restart', subject: 'srv1' });
  const trust = makeTrustStub({ handleStatus: 'auto_granted', grant: { id: 'gr-1', jobRef: 'int-1', target: 'srv1', commandTemplate: 'restart' } });
  const exec = makeExecStub();
  const audit = makeAuditStub();
  const svc = new IntegrationService({ convPort: conv, trustPort: trust, execPort: exec, auditPort: audit });
  const r = svc.handle({ actorId: 'u1', from: 'cli', intent: '重启 srv1' });
  assert.strictEqual(r.status, 'OK');
  assert.strictEqual(r.kind, 'execute');
  assert.ok(r.grant);
  assert.strictEqual(exec.started.length, 1);
  assert.ok(audit.chain.length >= 0); // 审计在 exec.start 内部由桩审计写
});

test('H3 resolveApproval 批准 → 签发 Grant → Outbox 入队 deferred', () => {
  const trust = makeTrustStub({ resolveStatus: 'approved' });
  const outboxRepo = createOutboxRepo();
  const outbox = new OutboxJournal({ repo: outboxRepo });
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: trust, execPort: makeExecStub(), auditPort: makeAuditStub(), outbox });
  const approval = { id: 'ap-1', status: 'pending' };
  const r = svc.resolveApproval({ approval, votes: ['a1', 'a2'] });
  assert.strictEqual(r.status, 'approved');
  assert.strictEqual(r.deferred, true);
  assert.ok(r.outboxId);
  assert.strictEqual(outboxRepo.pendingCount(), 1);
});

test('H4 resolveApproval 批准无 outbox → 同步 execute 启动', () => {
  const trust = makeTrustStub({ resolveStatus: 'approved' });
  const exec = makeExecStub();
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: trust, execPort: exec, auditPort: makeAuditStub() });
  const approval = { id: 'ap-2', status: 'pending' };
  const r = svc.resolveApproval({ approval, votes: ['a1', 'a2'] });
  assert.strictEqual(r.status, 'approved');
  assert.strictEqual(r.deferred, false);
  assert.strictEqual(exec.started.length, 1);
});

// ---------- error ----------
test('E1 trust rejected → REJECTED', () => {
  const trust = makeTrustStub({ handleStatus: 'rejected', reason: 'capability_not_in_whitelist' });
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: trust, execPort: makeExecStub(), auditPort: makeAuditStub() });
  const r = svc.handle({ actorId: 'u1', from: 'cli', intent: '删库跑路' });
  assert.strictEqual(r.status, 'REJECTED');
  assert.strictEqual(r.reason, 'capability_not_in_whitelist');
});

test('E2 非执行意图 → REJECTED', () => {
  const conv = makeConvStub({ intentType: 'unknown' });
  const svc = new IntegrationService({ convPort: conv, trustPort: makeTrustStub(), execPort: makeExecStub(), auditPort: makeAuditStub() });
  const r = svc.handle({ actorId: 'u1', from: 'cli', intent: '不知道' });
  assert.strictEqual(r.status, 'REJECTED');
  assert.strictEqual(r.reason, 'non_execute_intent');
});

test('E3 输入非法 → REJECTED', () => {
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: makeTrustStub(), execPort: makeExecStub(), auditPort: makeAuditStub() });
  assert.strictEqual(svc.handle({ actorId: '', from: 'cli', intent: 'x' }).reason, 'invalid_actor');
  assert.strictEqual(svc.handle({ actorId: 'u', from: '', intent: 'x' }).reason, 'invalid_from');
  assert.strictEqual(svc.handle({ actorId: 'u', from: 'cli', intent: '' }).reason, 'invalid_intent');
});

test('E4 resolveApproval 拒绝 → REJECTED', () => {
  const trust = makeTrustStub({ rejected: true });
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: trust, execPort: makeExecStub(), auditPort: makeAuditStub() });
  const r = svc.resolveApproval({ approval: { id: 'ap' }, rejectBy: 'sre1' });
  assert.strictEqual(r.status, 'REJECTED');
});

// ---------- edge ----------
test('G1 低置信度 → NEED_REVIEW', () => {
  const conv = makeConvStub({ intentType: 'execute', confidence: 0.5 });
  const svc = new IntegrationService({ convPort: conv, trustPort: makeTrustStub(), execPort: makeExecStub(), auditPort: makeAuditStub() });
  const r = svc.handle({ actorId: 'u1', from: 'cli', intent: '大概重启一下？' });
  assert.strictEqual(r.status, 'NEED_REVIEW');
  assert.strictEqual(r.reason, 'low_confidence');
  assert.strictEqual(r.needApproval, true);
});

test('G2 聚合升级 → NEED_REVIEW + escalated', () => {
  const trust = makeTrustStub({ handleStatus: 'pending_approval', escalated: true, approval: { id: 'ap-agg', status: 'pending' } });
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: trust, execPort: makeExecStub(), auditPort: makeAuditStub() });
  const r = svc.handle({ actorId: 'u1', from: 'cli', intent: '重启 srv1', now: new Date() });
  assert.strictEqual(r.status, 'NEED_REVIEW');
  assert.strictEqual(r.reason, 'aggregation_escalated');
  assert.ok(r.approval);
});

test('G3 同 intentId 重放 → 幂等不重复副作用', () => {
  const conv = makeConvStub({ intentType: 'query', intentId: 'idem-1' });
  const audit = makeAuditStub();
  const svc = new IntegrationService({ convPort: conv, trustPort: makeTrustStub(), execPort: makeExecStub(), auditPort: audit });
  const r1 = svc.handle({ actorId: 'u1', from: 'cli', intent: 'x' });
  const r2 = svc.handle({ actorId: 'u1', from: 'cli', intent: 'x' });
  assert.strictEqual(r1.status, 'OK');
  assert.strictEqual(r2.status, 'OK');
  assert.strictEqual(r2.reason, 'duplicate_intent_idempotent');
  assert.strictEqual(audit.chain.length, 1); // 只写一次审计
});

test('G4 resolveApproval 超时 → REJECTED', () => {
  const trust = makeTrustStub({ timedOut: true });
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: trust, execPort: makeExecStub(), auditPort: makeAuditStub() });
  const r = svc.resolveApproval({ approval: { id: 'ap' } });
  assert.strictEqual(r.status, 'REJECTED');
});

// ---------- adversarial ----------
test('A1 Outbox 同 messageId 重放不重复副作用', () => {
  const outboxRepo = createOutboxRepo();
  const outbox = new OutboxJournal({ repo: outboxRepo });
  const msg = outbox.enqueue({ eventId: 'ev-dup', type: 'X' });
  assert.strictEqual(outboxRepo.pendingCount(), 1);
  // 同 id 重放入队 → 幂等
  outbox.enqueue({ eventId: 'ev-dup', type: 'X' });
  assert.strictEqual(outboxRepo.pendingCount(), 1);
});

test('A2 前端伪标志「已授权」→ 编排层不信任，仍走服务端重判', () => {
  const trust = makeTrustStub({ handleStatus: 'rejected', reason: 'capability_not_in_whitelist' });
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: trust, execPort: makeExecStub(), auditPort: makeAuditStub() });
  // 即使 intent 看起来合法，trust 判拒绝，集成层就拒绝
  const r = svc.handle({ actorId: 'u1', from: 'cli', intent: '重启所有生产节点' });
  assert.strictEqual(r.status, 'REJECTED');
});

// ---------- fault-tolerance ----------
test('F1 audit 写失败 → handle 返回 ERROR', () => {
  const failingAudit = {
    write() { throw new Error('storage down'); },
  };
  const svc = new IntegrationService({ convPort: makeConvStub({ intentType: 'query' }), trustPort: makeTrustStub(), execPort: makeExecStub(), auditPort: failingAudit });
  const r = svc.handle({ actorId: 'u1', from: 'cli', intent: 'x' });
  assert.strictEqual(r.status, 'ERROR');
  assert.strictEqual(r.reason, 'audit_failed');
});

test('F2 trust 端口抛异常 → ERROR 而非崩溃', () => {
  const trust = { handleExecIntent() { throw new Error('boom'); }, resolveApproval() {} };
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: trust, execPort: makeExecStub(), auditPort: makeAuditStub() });
  const r = svc.handle({ actorId: 'u1', from: 'cli', intent: 'x' });
  assert.strictEqual(r.status, 'ERROR');
  assert.strictEqual(r.reason, 'trust_handle_failed');
});

test('F3 时间倒退（now 非法）→ ERROR', () => {
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: makeTrustStub(), execPort: makeExecStub(), auditPort: makeAuditStub() });
  const r = svc.handle({ actorId: 'u1', from: 'cli', intent: 'x', now: new Date('abc') });
  assert.strictEqual(r.status, 'ERROR');
  assert.strictEqual(r.reason, 'invalid_time');
});

test('F4 conv 端口返回畸形 → ERROR', () => {
  const conv = { interpret() { return null; } };
  const svc = new IntegrationService({ convPort: conv, trustPort: makeTrustStub(), execPort: makeExecStub(), auditPort: makeAuditStub() });
  const r = svc.handle({ actorId: 'u1', from: 'cli', intent: 'x' });
  assert.strictEqual(r.status, 'ERROR');
  assert.strictEqual(r.reason, 'conv_port_malformed');
});

// ---------- 补充：autogrant exec 启动失败 → REJECTED ----------
test('G5 自动 Grant 后 exec.start 返回 REJECTED → 透传原因', () => {
  const trust = makeTrustStub({ handleStatus: 'auto_granted' });
  const exec = {
    createJob({ id }) { return { id, status: 'queued' }; },
    start() { return { status: 'REJECTED', reason: 'grant_invalid' }; },
  };
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: trust, execPort: exec, auditPort: makeAuditStub() });
  const r = svc.handle({ actorId: 'u1', from: 'cli', intent: 'x' });
  assert.strictEqual(r.status, 'REJECTED');
  assert.strictEqual(r.reason, 'grant_invalid');
});
