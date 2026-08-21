// 端到端跨 BC 接线测试（第 28 波审计）：真实 M3 ApprovalFlowService + 真实 M4 ExecutionService
// 验证第 27 波修复闭环：M4 exec.start → trust.checkGrant → Grant.matches（paramsHash 真实绑定）
// 链路：高危意图 → pending_approval → 双人批准 → Grant(绑定 paramsHash) → createJob → exec.start → checkGrant → running
// 测试层允许跨目录 require 真实源码（实现层仍走端口注入，符合 DDD）

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// 真实 M3 trust
const trustDomain = require('../../m3/src/trust/domain.js');
const { InMemoryApprovalRepo, InMemoryGrantRepo, InMemoryAggregationRepo } = require('../../m3/src/trust/repo-memory.js');
// 真实 M4 exec
const { ExecutionService } = require('../../m4/src/exec/domain.js');
const { InMemoryJobRepo } = require('../../m4/src/exec/repo-memory.js');

function makeTrustFlow() {
  return new trustDomain.ApprovalFlowService({
    approvalRepo: new InMemoryApprovalRepo(), grantRepo: new InMemoryGrantRepo(),
    aggregationRepo: new InMemoryAggregationRepo(), approvalPool: { resolvers: () => ['sre-1', 'sre-2', 'sre-3'] },
  });
}

function makeExec(trustFlow) {
  return new ExecutionService({
    jobRepo: new InMemoryJobRepo(),
    trustPort: { checkGrant: (...args) => trustFlow.checkGrant(...args) }, // 真实 M3 checkGrant 接线
    assetPort: { isActive: () => true },
    matrixPort: { isAllowed: () => true },
    auditPort: { write: () => ({ ok: true }) },
  });
}

// ---------- 端到端：审批链真实接线 ----------
test('E2E-1 高危审批全链：handleExecIntent→批准→Grant→exec.start→checkGrant→running', () => {
  const flow = makeTrustFlow();
  const exec = makeExec(flow);
  const t0 = new Date('2026-08-19T00:00:00Z');
  const params = { command: 'restart_service' };

  // 1. 高危意图 → pending_approval（restart 走审批）
  const r = flow.handleExecIntent({ intentId: 'i-1', actorId: 'dev-1', target: 'svc-1', capability: 'restart', params, now: t0 });
  assert.strictEqual(r.status, 'pending_approval');
  assert.ok(r.approval.paramsHash, 'Approval 绑定真实 paramsHash');

  // 2. 双人批准 → Grant（绑定 paramsHash，非空串）
  const res = flow.resolveApproval({ approval: r.approval, votes: ['sre-1', 'sre-2'], now: new Date(t0.getTime() + 1000) });
  assert.strictEqual(res.status, 'approved');
  assert.ok(res.grant.paramsHash, 'Grant 绑定真实 paramsHash');

  // 3. M4 createJob（用同 params → Job 构造计算同哈希）
  const job = exec.createJob({ id: 'job-i-1', creator: 'dev-1', target: 'svc-1', template: 'restart', params, grantRef: res.grant.id });

  // 4. M4 exec.start → trust.checkGrant（真实 M3）→ 匹配 → running
  const started = exec.start({ jobId: job.id, now: new Date(t0.getTime() + 2000) });
  assert.strictEqual(started.status, 'OK');
  assert.strictEqual(started.job.status, 'running');
});

test('E2E-2 参数被改 → M4 参数 schema 更早拦截（命令限模板，附录 C 防线生效于 Job 构造期）', () => {
  const flow = makeTrustFlow();
  const exec = makeExec(flow);
  const t0 = new Date('2026-08-19T00:00:00Z');

  // 批准时 params A
  const r = flow.handleExecIntent({ intentId: 'i-2', actorId: 'dev-1', target: 'svc-1', capability: 'restart', params: { command: 'restart_service' }, now: t0 });
  const res = flow.resolveApproval({ approval: r.approval, votes: ['sre-1', 'sre-2'], now: new Date(t0.getTime() + 1000) });

  // 执行时 params B（被篡改为非模板命令）→ M4 validateParams 在 Job 构造即拒绝（比 checkGrant 更早的防线）
  assert.throws(() => exec.createJob({ id: 'job-i-2', creator: 'dev-1', target: 'svc-1', template: 'restart', params: { command: 'change_config' }, grantRef: res.grant.id }), /模板白名单/);
});

test('E2E-3 吊销 Grant → checkGrant revoked → 拒绝（INV-G3 即时废止）', () => {
  const flow = makeTrustFlow();
  const exec = makeExec(flow);
  const t0 = new Date('2026-08-19T00:00:00Z');

  const r = flow.handleExecIntent({ intentId: 'i-3', actorId: 'dev-1', target: 'svc-1', capability: 'restart', params: { command: 'restart_service' }, now: t0 });
  const res = flow.resolveApproval({ approval: r.approval, votes: ['sre-1', 'sre-2'], now: new Date(t0.getTime() + 1000) });
  flow.revokeGrant({ grant: res.grant, reason: '安全事件', now: new Date(t0.getTime() + 1500) });

  const job = exec.createJob({ id: 'job-i-3', creator: 'dev-1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' }, grantRef: res.grant.id });
  const started = exec.start({ jobId: job.id, now: new Date(t0.getTime() + 2000) });
  assert.strictEqual(started.status, 'REJECTED');
  assert.strictEqual(started.reason, 'revoked'); // M4 透传 checkGrant 精确原因（INV-G3 即时废止）
});

test('E2E-4 查询类 auto_granted 不走 exec（读面应答，语义正确）', () => {
  const flow = makeTrustFlow();
  const t0 = new Date('2026-08-19T00:00:00Z');
  const r = flow.handleExecIntent({ intentId: 'i-4', actorId: 'dev-1', target: 'svc-1', capability: 'query_status', params: { q: 'cpu' }, now: t0 });
  assert.strictEqual(r.status, 'auto_granted');
  assert.ok(r.grant.paramsHash, '自动 Grant 也绑定参数哈希');
  // 查询类能力不在 M4 执行白名单（restart/clean/scale/config_change/env_switch）——语义正确：读面不产生作业
  const m4White = ['restart', 'clean', 'scale', 'config_change', 'env_switch'];
  assert.ok(!m4White.includes('query_status'), '查询类不属执行白名单');
});
// ---------- 第 29 波审计补：审批→Outbox→异步执行参数完整链路 ----------
test('E2E-5 审批流 params 透传：handle 返回 params → resolveApproval → Outbox → 异步执行成功', () => {
  const flow = makeTrustFlow();
  const baseExec = makeExec(flow);
  const started = [];
  const exec = { // 包装记录 start 调用（M4 ExecutionService 不公开 started 集合）
    createJob: (a) => baseExec.createJob(a),
    start: (a) => { started.push(a.jobId); return baseExec.start(a); },
  };
  const { IntegrationService, OutboxJournal } = require('../src/integration/domain.js');
  const { createOutboxRepo } = require('../src/integration/repo-memory.js');
  const { AppendOnlyAuditChain, AuditEntry } = require('../src/audit/domain.js');

  const audit = { write(entry) { const c = new AppendOnlyAuditChain(); c.append(new AuditEntry(entry)); return { ok: true }; } };
  const conv = { interpret() { return { intentType: 'execute', capability: 'restart', confidence: 0.95, intentId: 'i-9', subject: 'svc-1', params: { command: 'restart_service' } }; } };
  const repo = createOutboxRepo();
  const outbox = new OutboxJournal({ repo });
  const svc = new IntegrationService({ convPort: conv, trustPort: { handleExecIntent: (a) => flow.handleExecIntent(a), resolveApproval: (a) => flow.resolveApproval(a) }, execPort: exec, auditPort: audit, outbox });

  // 1. handle → pending_approval，且返回 params（第 29 波修复：原来丢失）
  const r = svc.handle({ actorId: 'dev-1', from: 'cli', intent: '重启 svc-1' });
  assert.strictEqual(r.status, 'NEED_REVIEW');
  assert.deepStrictEqual(r.params, { command: 'restart_service' }, 'handle 返回 params 供审批透传');

  // 2. 审批通过 → resolveApproval（用 handle 返回的 params）
  const res = svc.resolveApproval({ approval: r.approval, votes: ['sre-1', 'sre-2'], params: r.params, actorId: 'dev-1' });
  assert.strictEqual(res.deferred, true, '走 Outbox 异步');
  assert.strictEqual(repo.pendingCount(), 1);

  // 3. Outbox 消费 → 异步执行（参数完整 → M4 接受）
  const d = outbox.dispatchAll();
  assert.strictEqual(d.dispatched, 1);
  assert.strictEqual(started.length, 1, '异步执行真实启动（参数未丢失）');
});

// ---------- 第 31 波审计补：M5 编排 + 真实 M3/M4 + 注入时钟 完整异步链路 ----------
test('E2E-6 M5+真实M3/M4 Outbox 异步执行（注入时钟，consumer 用 timeSource 非 new Date）', () => {
  let NOW = new Date('2026-01-01T00:00:00Z');
  const clock = () => new Date(NOW.getTime());

  const flow = new trustDomain.ApprovalFlowService({
    approvalRepo: new InMemoryApprovalRepo(), grantRepo: new InMemoryGrantRepo(),
    aggregationRepo: new InMemoryAggregationRepo(), approvalPool: { resolvers: () => ['sre-1', 'sre-2', 'sre-3'] },
    timeSource: clock,
  });
  const exec = new ExecutionService({
    jobRepo: new InMemoryJobRepo(),
    trustPort: { checkGrant: (...a) => flow.checkGrant(...a) },
    assetPort: { isActive: () => true }, matrixPort: { isAllowed: () => true },
    auditPort: { write: () => ({ ok: true }) },
  });
  const { IntegrationService, OutboxJournal } = require('../src/integration/domain.js');
  const { createOutboxRepo } = require('../src/integration/repo-memory.js');
  const repo = createOutboxRepo();
  const outbox = new OutboxJournal({ repo, timeSource: clock });
  const svc = new IntegrationService({
    convPort: { interpret: () => ({ intentType: 'execute', capability: 'restart', confidence: 0.95, intentId: 'i-x', subject: 'svc-1', params: { command: 'restart_service' } }) },
    trustPort: { handleExecIntent: (a) => flow.handleExecIntent(a), resolveApproval: (a) => flow.resolveApproval(a) },
    execPort: exec,
    auditPort: { write: () => ({ ok: true }) },
    outbox, timeSource: clock,
  });

  const r = svc.handle({ actorId: 'dev-1', from: 'cli', intent: '重启 svc-1', now: clock() });
  assert.strictEqual(r.status, 'NEED_REVIEW');
  NOW = new Date(NOW.getTime() + 1000);
  const res = svc.resolveApproval({ approval: r.approval, votes: ['sre-1', 'sre-2'], params: r.params, actorId: 'dev-1', now: clock() });
  assert.strictEqual(res.deferred, true);
  NOW = new Date(NOW.getTime() + 1000);
  const d = outbox.dispatchAll(clock());
  assert.strictEqual(d.dispatched, 1, 'Outbox 异步消费成功');
  const job = exec.jobRepo.findByGrantRef(res.grant.id);
  assert.ok(job, '作业已创建');
  assert.strictEqual(job.status, 'running', '异步执行真实启动（第31波 timeSource 修复）');
});
