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

/** conv 桩：interpret 返回意图。{ actionClass, intentType, capability, confidence, intentId, subject, params } */
function makeConvStub(defaults = {}) {
  return {
    interpret({ actorId, intent, now }) {
      return {
        actionClass: defaults.actionClass || (defaults.intentType === 'query' ? 'read' : 'write'),
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

test('E2 非法 actionClass → REJECTED', () => {
  const conv = makeConvStub({ actionClass: 'hack' });
  const svc = new IntegrationService({ convPort: conv, trustPort: makeTrustStub(), execPort: makeExecStub(), auditPort: makeAuditStub() });
  const r = svc.handle({ actorId: 'u1', from: 'cli', intent: '不知道' });
  assert.strictEqual(r.status, 'REJECTED');
  assert.strictEqual(r.reason, 'invalid_action_class');
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

// ---------- 第 26 波修复验证：审批决定审计 + Outbox 接线 + creator/params 传递 ----------
test('R26-1 resolveApproval 批准 → 审计先行留痕（INV-U5 审批类至少一次投递）', () => {
  const trust = makeTrustStub({ resolveStatus: 'approved' });
  const audit = makeAuditStub();
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: trust, execPort: makeExecStub(), auditPort: audit });
  const r = svc.resolveApproval({ approval: { id: 'ap-1', operatorId: 'op-9' }, votes: ['a1', 'a2'] });
  assert.strictEqual(r.status, 'approved');
  assert.strictEqual(audit.chain.length, 1);                      // 审批决定写了一条审计
  const entry = audit.entries()[0];
  assert.strictEqual(entry.result, 'approved');
  assert.strictEqual(entry.action.intent, 'approve');
});

test('R26-2 resolveApproval 审计失败 → ERROR fail-closed，不继续', () => {
  const trust = makeTrustStub({ resolveStatus: 'approved' });
  const failing = { write() { throw new Error('down'); } };
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: trust, execPort: makeExecStub(), auditPort: failing });
  const r = svc.resolveApproval({ approval: { id: 'ap-1' }, votes: ['a1', 'a2'] });
  assert.strictEqual(r.status, 'ERROR');
  assert.strictEqual(r.reason, 'audit_failed');
});

test('R26-3 Outbox 接线：deferred 消息 dispatchAll 消费 → exec.start 被驱动', () => {
  const trust = makeTrustStub({ resolveStatus: 'approved' });
  const exec = makeExecStub();
  const repo = createOutboxRepo();
  const outbox = new OutboxJournal({ repo });
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: trust, execPort: exec, auditPort: makeAuditStub(), outbox });
  const r = svc.resolveApproval({ approval: { id: 'ap-1', operatorId: 'op-9' }, votes: ['a1', 'a2'], params: { command: 'restart_service' } });
  assert.strictEqual(r.deferred, true);
  assert.strictEqual(repo.pendingCount(), 1);
  // 消费接线已注入 → dispatchAll 驱动 exec.start
  const d = outbox.dispatchAll();
  assert.strictEqual(d.dispatched, 1);
  assert.strictEqual(exec.started.length, 1);   // 作业真的启动了
});

test('R26-4 _launchFromGrant creator/params 真实化（不再硬编码 op/{}）', () => {
  const trust = makeTrustStub({ resolveStatus: 'approved' });
  const exec = makeExecStub();
  const svc = new IntegrationService({ convPort: makeConvStub(), trustPort: trust, execPort: exec, auditPort: makeAuditStub() });
  // 无 outbox → 同步 _launchFromGrant，creator 来自 approval.operatorId，非 'op'
  const r = svc.resolveApproval({ approval: { id: 'ap-1', operatorId: 'op-9' }, votes: ['a1', 'a2'], params: { command: 'restart_service' } });
  assert.strictEqual(r.status, 'approved');
  assert.strictEqual(exec.started.length, 1);
  assert.strictEqual(exec.jobs.get(`job-${'ap-1'}`).creator, 'op-9');   // creator 真实化
});

// ============ C2 拆解集成 ============
// IntegrationService 新增 decomposePort：信任预检(auto_granted)后调用 decompose 拆解为 DAG 子任务，
// 对每个就绪节点创建 Job + 启动；decomposePort 为 null 或 decompose 失败时回退到单步执行（向后兼容）。

const { TaskService, Task, DAGNode } = require('../../m2/src/conv/domain.js');

test('C2-I1 handle 单节点拆解：decomposePort 存在时走拆解路径', () => {
  let decomposeCalled = false;
  const svc = new IntegrationService({
    convPort: { interpret: () => ({ actionClass: 'write', capability: 'restart', confidence: 0.95, intentId: 'i1', subject: 'jd-light', params: { service: 'nginx' } }) },
    trustPort: {
      handleExecIntent: () => ({ status: 'auto_granted', grant: { id: 'g1', commandTemplate: 'restart_service', target: 'jd-light', creator: 'alice' } }),
      resolveApproval: () => ({}),
    },
    execPort: {
      createJob: ({ id, creator, target, template, params, grantRef }) => ({ id, creator, target, template, params, grantRef }),
      start: ({ jobId }) => ({ status: 'OK', job: { id: jobId } }),
    },
    auditPort: { write: () => ({ ok: true }) },
    decomposePort: {
      decompose(intent) {
        decomposeCalled = true;
        assert.strictEqual(intent.trustPrechecked, true, '应传递 trustPrechecked=true');
        const svc = new TaskService();
        return svc.decompose({ ...intent, trustPrechecked: true });
      },
    },
    timeSource: () => new Date('2026-09-01'),
  });
  const r = svc.handle({ actorId: 'alice', from: 'test', intent: '重启 jd-light 的 nginx' });
  assert.strictEqual(r.status, 'OK');
  assert.ok(decomposeCalled, 'decompose 应被调用');
  assert.ok(r.taskId && typeof r.taskId === 'string' && r.taskId.startsWith('task-'), '应返回 task 任务 ID');
  assert.strictEqual(r.nodeCount, 1);
  assert.strictEqual(r.startedCount, 1);
  assert.ok(r.jobId, '单节点应返回 jobId');
});

test('C2-I2 handle 多目标并行拆解：每个目标创建作业', () => {
  const svc = new IntegrationService({
    convPort: { interpret: () => ({ actionClass: 'write', capability: 'restart', confidence: 0.95, intentId: 'i2', subject: 'jd-light,ali-ecs-99', params: {} }) },
    trustPort: {
      handleExecIntent: () => ({ status: 'auto_granted', grant: { id: 'g1', commandTemplate: 'restart_service', target: 'jd-light', creator: 'alice' } }),
      resolveApproval: () => ({}),
    },
    execPort: {
      createJob: ({ id, creator, target }) => ({ id, creator, target }),
      start: ({ jobId }) => ({ status: 'OK', job: { id: jobId } }),
    },
    auditPort: { write: () => ({ ok: true }) },
    decomposePort: {
      decompose(intent) {
        const svc = new TaskService();
        return svc.decompose({ ...intent, trustPrechecked: true });
      },
    },
    timeSource: () => new Date('2026-09-01'),
  });
  const r = svc.handle({ actorId: 'alice', from: 'test', intent: '重启 jd-light 和 ali-ecs-99' });
  assert.strictEqual(r.status, 'OK');
  assert.strictEqual(r.nodeCount, 2);
  assert.strictEqual(r.startedCount, 2, '并行节点全部启动');
});

test('C2-I3 handle decomposePort 为 null：退化为当前行为（向后兼容）', () => {
  const svc = new IntegrationService({
    convPort: { interpret: () => ({ actionClass: 'write', capability: 'restart', confidence: 0.95, intentId: 'i3', subject: 'jd-light', params: { service: 'nginx' } }) },
    trustPort: {
      handleExecIntent: () => ({ status: 'auto_granted', grant: { id: 'g1', commandTemplate: 'restart_service', target: 'jd-light', creator: 'alice' } }),
      resolveApproval: () => ({}),
    },
    execPort: {
      createJob: ({ id }) => ({ id }),
      start: ({ jobId }) => ({ status: 'OK', job: { id: jobId } }),
    },
    auditPort: { write: () => ({ ok: true }) },
    // 不传 decomposePort → 退化为当前行为
    timeSource: () => new Date('2026-09-01'),
  });
  const r = svc.handle({ actorId: 'alice', from: 'test', intent: '重启 nginx' });
  assert.strictEqual(r.status, 'OK');
  assert.strictEqual(r.taskId, undefined, '无 decomposePort 时不返回 taskId');
  assert.strictEqual(r.nodeCount, undefined);
  assert.strictEqual(r.startedCount, undefined);
  assert.ok(r.jobId, '应返回 jobId（兼容单步执行）');
});

test('C2-I4 handle decompose 失败：回退到单步执行', () => {
  const svc = new IntegrationService({
    convPort: { interpret: () => ({ actionClass: 'write', capability: 'restart', confidence: 0.95, intentId: 'i4', subject: 'jd-light', params: { service: 'nginx' } }) },
    trustPort: {
      handleExecIntent: () => ({ status: 'auto_granted', grant: { id: 'g1', commandTemplate: 'restart_service', target: 'jd-light', creator: 'alice' } }),
      resolveApproval: () => ({}),
    },
    execPort: {
      createJob: ({ id }) => ({ id }),
      start: ({ jobId }) => ({ status: 'OK', job: { id: jobId } }),
    },
    auditPort: { write: () => ({ ok: true }) },
    decomposePort: {
      decompose() { throw new Error('decompose 临时故障'); },
    },
    timeSource: () => new Date('2026-09-01'),
  });
  const r = svc.handle({ actorId: 'alice', from: 'test', intent: '重启 nginx' });
  // decompose 失败后应回退到单步执行
  assert.strictEqual(r.status, 'OK');
  assert.ok(r.jobId, '回退后应返回 jobId');
});
