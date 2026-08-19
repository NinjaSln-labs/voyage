// 四角色 × 五旅程端到端走查（DoD-B）
// 经 M5 IntegrationService 串联全链路——契约桩模拟 M3/M4 行为
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { IntegrationService, OutboxJournal } = require('../../m5/src/integration/domain.js');
const { createOutboxRepo } = require('../../m5/src/integration/repo-memory.js');
const { AuditEntry, AppendOnlyAuditChain } = require('../../m5/src/audit/domain.js');

function makeConv(intentType, capability, confidence, intentId) {
  return { interpret() { return { intentType, capability: capability || 'restart', confidence: confidence ?? 0.9, intentId, subject: 'srv1', params: { command: 'restart_service' } }; } };
}
function makeTrust(status, grant, escalated, reason) {
  return {
    handleExecIntent({ intentId, target }) {
      const base = { status, escalated: escalated || false, reason: reason || null };
      if (status === 'auto_granted') base.grant = { id: `gr-${intentId}`, jobRef: intentId, target: target || 'srv1', commandTemplate: 'restart' };
      if (status === 'pending_approval') base.approval = { id: `ap-${intentId}` };
      return base;
    },
    resolveApproval({ approval, rejectBy }) {
      return { status: rejectBy ? 'rejected' : 'approved', grant: { id: `gr-${approval.id}`, jobRef: approval.id, target: 'srv1', commandTemplate: 'restart' }, approval };
    },
  };
}
function makeExec() {
  const jobs = new Map(), started = [];
  return { started, createJob({ id, creator, target, template, grantRef }) { const j = { id, creator, target, template, grantRef, status: 'queued' }; jobs.set(id, j); return j; }, start({ jobId }) { const j = jobs.get(jobId); if (!j) return { status: 'ERROR' }; j.status = 'running'; started.push(jobId); return { status: 'OK', job: j }; } };
}
function makeAudit() { const c = new AppendOnlyAuditChain(); return { chain: c, write(e) { return c.append(new AuditEntry(e)); }, verify() { return c.verify(); }, entries() { return c.entries(); } }; }

test('J1 游客查询 → OK + 审计留痕', () => {
  const a = makeAudit();
  const svc = new IntegrationService({ convPort: makeConv('query', 'query_status'), trustPort: makeTrust(), execPort: makeExec(), auditPort: a });
  const r = svc.handle({ actorId: 'v1', from: 'app', intent: '状态' });
  assert.strictEqual(r.status, 'OK'); assert.strictEqual(a.chain.length, 1);
});
test('J2 游客尝试重启 → 拒绝', () => {
  const svc = new IntegrationService({ convPort: makeConv('execute', 'restart'), trustPort: makeTrust('rejected', null, false, 'capability_not_in_whitelist'), execPort: makeExec(), auditPort: makeAudit() });
  assert.strictEqual(svc.handle({ actorId: 'v1', from: 'app', intent: '重启' }).status, 'REJECTED');
});
test('J3 开发者重启（白名单）→ 自动Grant + exec启动', () => {
  const e = makeExec();
  const svc = new IntegrationService({ convPort: makeConv('execute', 'restart'), trustPort: makeTrust('auto_granted'), execPort: e, auditPort: makeAudit() });
  const r = svc.handle({ actorId: 'dev1', from: 'cli', intent: '重启 srv1' });
  assert.strictEqual(r.status, 'OK'); assert.ok(e.started.length >= 1);
});
test('J4 开发者高危操作 → 需审批', () => {
  const svc = new IntegrationService({ convPort: makeConv('execute', 'clean'), trustPort: makeTrust('pending_approval'), execPort: makeExec(), auditPort: makeAudit() });
  const r = svc.handle({ actorId: 'dev1', from: 'cli', intent: '清理日志' });
  assert.strictEqual(r.status, 'NEED_REVIEW'); assert.strictEqual(r.needApproval, true);
});
test('J5 SRE 审批批准 → Outbox入队', () => {
  const repo = createOutboxRepo();
  const svc = new IntegrationService({ convPort: makeConv(), trustPort: makeTrust(), execPort: makeExec(), auditPort: makeAudit(), outbox: new OutboxJournal({ repo }) });
  const r = svc.resolveApproval({ approval: { id: 'ap-1', status: 'pending' }, votes: ['sre1', 'sre2'] });
  assert.strictEqual(r.status, 'approved'); assert.strictEqual(repo.pendingCount(), 1);
});
test('J6 SRE 否决 → REJECTED', () => {
  const t = makeTrust(); t.resolveApproval = () => ({ status: 'rejected', rejected: true });
  const svc = new IntegrationService({ convPort: makeConv(), trustPort: t, execPort: makeExec(), auditPort: makeAudit() });
  assert.strictEqual(svc.resolveApproval({ approval: { id: 'ap-2' }, rejectBy: 'sre1' }).status, 'REJECTED');
});
test('J7 管理员大盘查询 → OK', () => {
  const svc = new IntegrationService({ convPort: makeConv('query', 'query_metric'), trustPort: makeTrust(), execPort: makeExec(), auditPort: makeAudit() });
  assert.strictEqual(svc.handle({ actorId: 'admin1', from: 'dash', intent: '大盘' }).status, 'OK');
});
test('J8 管理员双人授权 → approved', () => {
  const svc = new IntegrationService({ convPort: makeConv(), trustPort: makeTrust(), execPort: makeExec(), auditPort: makeAudit() });
  assert.strictEqual(svc.resolveApproval({ approval: { id: 'ap-sub', status: 'pending' }, votes: ['admin1', 'sre2'] }).status, 'approved');
});
test('J9 幂等防重放', () => {
  const a = makeAudit();
  const svc = new IntegrationService({ convPort: makeConv('query', 'query_status', null, 'idem-j9'), trustPort: makeTrust(), execPort: makeExec(), auditPort: a });
  svc.handle({ actorId: 'u1', from: 'app', intent: 'x' });
  const r = svc.handle({ actorId: 'u1', from: 'app', intent: 'x' });
  assert.strictEqual(r.reason, 'duplicate_intent_idempotent'); assert.strictEqual(a.chain.length, 1);
});
