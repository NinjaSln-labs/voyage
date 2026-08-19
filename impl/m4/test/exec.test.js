// exec 执行闭环 契约测试（happy/error/edge/adversarial/fault-tolerance 五类）
// 依据：M0-D INV-E1~E5（作业/吊销/聚合升级）+ 附录 C（白名单参数 schema）+ M4 方案评审 §4 测试规划
//      INV-U1（审计先行 fail-closed）+ 事件协议（schemaVersion+eventId+深冻结）
// 运行：node --test impl/m4/test/exec.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Job, ExecutionService, NodeEffect, validateParams,
  paramsHash, normalizeUnicode, scanParamValue,
  WHITELIST_CAPABILITIES, COMMAND_TEMPLATES, LOG_DIR_WHITELIST,
  JobStarted, JobCompleted, JobFailed,
} = require('../src/exec/domain');
const { InMemoryJobRepo, InMemoryEventBus } = require('../src/exec/repo-memory');

// ---------- 测试专用端口桩 ----------

/** 构造一个装配齐全的 ExecutionService（可覆写端口） */
function makeService(overrides = {}) {
  const repo = overrides.jobRepo || new InMemoryJobRepo();
  const bus = overrides.eventBus || new InMemoryEventBus();
  const svc = new ExecutionService({
    jobRepo: repo,
    trustPort: overrides.trustPort || { checkGrant: () => ({ ok: true }) },
    assetPort: overrides.assetPort || { isActive: () => true },
    matrixPort: overrides.matrixPort || { isAllowed: () => true },
    auditPort: overrides.auditPort || { write: () => ({ ok: true }) },
    eventBus: bus,
  });
  return { svc, repo, bus };
}

// ---------- happy path ----------

test('H1 白名单能力+Grant 有效+未升级 → running（INV-E1/H3）', () => {
  const { svc, repo, bus } = makeService();
  const job = new Job({ id: 'j1', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-1');
  repo.save(job);
  const r = svc.start({ jobId: 'j1', now: new Date() });
  assert.equal(r.status, 'OK');
  assert.equal(job.status, 'running');
  assert.equal(bus.byType('JobStarted').length, 1, '发布 JobStarted');
});

test('H2 定时任务（standing Grant 触发）：Grant 有效 → queued→running', () => {
  const { svc, repo } = makeService();
  const job = new Job({ id: 'j2', creator: 'dev1', target: 'svc-1', template: 'scale', params: { command: 'scale_replicas' } });
  job.bindGrant('gr-2');
  repo.save(job);
  const r = svc.start({ jobId: 'j2', now: new Date() });
  assert.equal(r.status, 'OK');
  assert.equal(job.status, 'running');
});

test('H3 参数 schema 合法通过（命令限模板 + 路径白名单）', () => {
  // 命令模板：restart 用白名单命令可行
  assert.equal(validateParams('restart', { command: 'restart_service' }).ok, true);
  // 路径白名单：clean 用白名单目录前缀可行
  assert.equal(validateParams('clean', { command: 'clean_logs', path: '/var/log/app.log' }).ok, true);
});

test('H4 审批后 GrantIssued → 绑定 Grant → 启动（INV-G2 关联）', () => {
  const { svc, repo } = makeService();
  // 先建排队作业（未绑定 grant）
  const job = new Job({ id: 'j4', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  repo.save(job);
  // 审批后 trust 发布 GrantIssued（grant.jobRef = 该作业 id）
  const r = svc.onTrustEvent({ eventId: 'ev-g-1', type: 'GrantIssued', grant: { id: 'gr-4', jobRef: 'j4' } });
  assert.equal(r.handled, true);
  assert.equal(job.grantRef, 'gr-4', '作业绑定 Grant');
  const s = svc.start({ jobId: 'j4', now: new Date() });
  assert.equal(s.status, 'OK');
  assert.equal(job.status, 'running');
});

test('H5 事件闭环：run→complete 发布 JobCompleted（含 nodeEffects 快照）', () => {
  const { svc, repo, bus } = makeService();
  const job = new Job({ id: 'j5', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-5'); repo.save(job);
  svc.start({ jobId: 'j5', now: new Date() });
  const c = svc.completeJob({ jobId: 'j5', result: { ok: true }, now: new Date() });
  assert.equal(c.status, 'OK');
  const completed = bus.byType('JobCompleted');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].nodeEffects.length, 1);
  assert.equal(completed[0].nodeEffects[0].status, 'completed');
  assert.ok(completed[0].eventId, '幂等键存在');
  assert.equal(completed[0].schemaVersion, 1);
});

// ---------- error path ----------

test('E1 非白名单能力拒绝（rm_rf_root 任意命令）——INV-E3', () => {
  assert.throws(() => new Job({ id: 'x', creator: 'd', target: 's', template: 'rm_rf_root', params: {} }), /不在白名单/);
  const { svc, repo } = makeService();
  // 绕道非白名单能力直接构造 → 构造即拒绝
});

test('E2 Grant 无效/过期/吊销拒绝——INV-E1', () => {
  const { svc, repo } = makeService({ trustPort: { checkGrant: () => ({ ok: false, reason: 'grant_expired' }) } });
  const job = new Job({ id: 'jE2', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-exp'); repo.save(job);
  const r = svc.start({ jobId: 'jE2', now: new Date() });
  assert.equal(r.status, 'REJECTED');
  assert.equal(r.reason, 'grant_expired');
  assert.notEqual(job.status, 'running', 'Grant 无效不得启动');
});

test('E3 参数含 shell 元字符 / Base64 / 路径越界拒绝——附录 C', () => {
  // shell 元字符
  assert.throws(() => new Job({ id: 'x', creator: 'd', target: 's', template: 'restart', params: { command: 'restart_service; rm -rf /' } }), /shell_metachar/);
  // Base64 特征
  assert.throws(() => new Job({ id: 'x', creator: 'd', target: 's', template: 'restart', params: { command: 'cmVzdGFydA==' } }), /base64_encoded|命令不在模板/);
  // 路径越界：clean 不在日志目录白名单
  assert.throws(() => new Job({ id: 'x', creator: 'd', target: 's', template: 'clean', params: { command: 'clean_logs', path: '/etc/passwd' } }), /路径不在日志目录白名单/);
});

test('E4 资产退役拒绝——INV-AS2', () => {
  const { svc, repo } = makeService({ assetPort: { isActive: () => false } });
  const job = new Job({ id: 'jE4', creator: 'dev1', target: 'svc-retired', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-ok'); repo.save(job);
  const r = svc.start({ jobId: 'jE4', now: new Date() });
  assert.equal(r.status, 'REJECTED');
  assert.equal(r.reason, 'asset_retired');
});

test('E5 凭据键构造拒绝——INV-E4', () => {
  assert.throws(() => new Job({ id: 'x', creator: 'd', target: 's', template: 'restart', params: { command: 'restart_service', password: 'abc' } }), /凭据键/);
  assert.throws(() => new Job({ id: 'x', creator: 'd', target: 's', template: 'restart', params: { command: 'restart_service', credential_ref: 'x' } }), /凭据键/);
});

// ---------- edge path ----------

test('G1 聚合升级置位 → suspended 挂起不启动（INV-E2）', () => {
  const { svc, repo } = makeService();
  const job = new Job({ id: 'jG1', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-1'); repo.save(job);
  // 聚合升级事件挂起
  const r = svc.onTrustEvent({ eventId: 'ev-agg-1', type: 'AggregationEscalated', target: 'svc-1', capability: 'restart', count: 10 });
  assert.equal(r.action, 'suspended');
  assert.equal(job.status, 'suspended');
  // suspended 不得启动
  const s = svc.start({ jobId: 'jG1', now: new Date() });
  assert.equal(s.status, 'REJECTED');
  assert.equal(s.reason, 'aggregation_escalated');
});

test('G2 审批拒绝/超时 → rejected（审批终态）', () => {
  const { svc, repo, bus } = makeService();
  const job = new Job({ id: 'jG2', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-2'); repo.save(job);
  const r = svc.onTrustEvent({ eventId: 'ev-rej-1', type: 'ApprovalRejected', grant: { id: 'gr-2' } });
  assert.equal(r.action, 'rejected');
  assert.equal(job.status, 'rejected');
  assert.equal(bus.byType('JobFailed').length, 1);
});

test('G3 已启动节点吊销 → 完成留痕（INV-E5），未启动节点吊销 → rejected', () => {
  // 已启动（running）节点吊销 → completed + 补偿留痕
  const { svc, repo, bus } = makeService();
  const runningJob = new Job({ id: 'jG3a', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  runningJob.bindGrant('gr-a'); repo.save(runningJob);
  svc.start({ jobId: 'jG3a', now: new Date() });
  const r = svc.onTrustEvent({ eventId: 'ev-rev-a', type: 'GrantRevoked', grant: { id: 'gr-a' }, revokedReason: '安全事件' });
  assert.equal(r.action, 'completed_compensated');
  assert.equal(runningJob.status, 'completed');
  assert.equal(bus.byType('JobCompleted').length, 1, '已启动节点完成留痕');
  assert.equal(runningJob.nodeEffects[0].status, 'completed');

  // 未启动（queued）节点吊销 → rejected
  const { svc: svc2, repo: repo2 } = makeService();
  const queuedJob = new Job({ id: 'jG3b', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  queuedJob.bindGrant('gr-b'); repo2.save(queuedJob);
  const r2 = svc2.onTrustEvent({ eventId: 'ev-rev-b', type: 'GrantRevoked', grant: { id: 'gr-b' }, revokedReason: '吊销' });
  assert.equal(r2.action, 'rejected');
  assert.equal(queuedJob.status, 'rejected');
});

test('G4 Grant 过期（GrantExpired）未启动作业 → rejected（INV-G3）', () => {
  const { svc, repo } = makeService();
  const job = new Job({ id: 'jG4', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-exp'); repo.save(job);
  const r = svc.onTrustEvent({ eventId: 'ev-exp-1', type: 'GrantExpired', grant: { id: 'gr-exp' } });
  assert.equal(r.action, 'rejected');
  assert.equal(job.status, 'rejected');
});

test('G5 挂起后审批通过（GrantIssued）→ resume → running', () => {
  const { svc, repo } = makeService();
  const job = new Job({ id: 'jG5', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-5'); repo.save(job);
  svc.onTrustEvent({ eventId: 'ev-agg-5', type: 'AggregationEscalated', target: 'svc-1', capability: 'restart', count: 10 });
  assert.equal(job.status, 'suspended');
  // 审批通过 → 恢复 queued 再 start
  job.resume(new Date());
  assert.equal(job.status, 'queued');
  const s = svc.start({ jobId: 'jG5', now: new Date() });
  assert.equal(s.status, 'OK');
  assert.equal(job.status, 'running');
});

// ---------- adversarial path ----------

test('A1 事件重放幂等：同 eventId 不重复副作用（INV-N1/RQ-822）', () => {
  const { svc, repo, bus } = makeService();
  const job = new Job({ id: 'jA1', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-1'); repo.save(job);
  svc.onTrustEvent({ eventId: 'ev-rev-1', type: 'GrantRevoked', grant: { id: 'gr-1' } });
  assert.equal(job.status, 'rejected');
  const before = bus.byType('JobFailed').length;
  // 重放同一 eventId → 幂等拒绝，不重复副作用
  const r = svc.onTrustEvent({ eventId: 'ev-rev-1', type: 'GrantRevoked', grant: { id: 'gr-1' } });
  assert.equal(r.handled, false);
  assert.equal(r.reason, 'duplicate');
  assert.equal(bus.byType('JobFailed').length, before, '重放不重复发布事件');
});

test('A2 原型链保留键参数拒绝（__proto__ 拦截）——第 12 波', () => {
  const poisoned = JSON.parse('{"__proto__": {"polluted": 1}, "command": "restart_service"}');
  assert.throws(() => new Job({ id: 'x', creator: 'd', target: 's', template: 'restart', params: poisoned }), /原型链保留/);
});

test('A3 状态机终态全入口拒绝（completed 后 start/complete 幂等不抛且不变）', () => {
  const { svc, repo } = makeService();
  const job = new Job({ id: 'jA3', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-3'); repo.save(job);
  svc.start({ jobId: 'jA3', now: new Date() });
  svc.completeJob({ jobId: 'jA3', now: new Date() });
  assert.equal(job.status, 'completed');
  // 终态重复处理幂等
  assert.equal(job.complete(null, new Date()), false, 'completed 再 complete 幂等返回 false');
  assert.equal(svc.start({ jobId: 'jA3', now: new Date() }).status, 'REJECTED', '已终态作业不可重启');
});

test('A4 全角/零宽变体绕参数校验 → 拒绝（附录 C Unicode 同形）', () => {
  // 零宽字符混入参数 → normalizeUnicode 移除失效（含元字符仍命中）
  assert.equal(scanParamValue('\u200Brestart; touch /tmp/x').rejected, true, '零宽+元字符仍拒绝');
  // 全角分号 → normalized → 半角分号命中元字符
  assert.equal(scanParamValue('restart\uFF1B rm').rejected, true, '全角分号归一化后命中');
  // 正常参数不误报
  assert.equal(scanParamValue('/var/log/app.log').rejected, false);
});

test('A5 已启动节点吊销补偿留痕 + 未启动节点拒绝 同时满足（INV-E5 批量单节点语义）', () => {
  // 单节点作业：running → complete(compensated)；多节点结构可扩展，本里程碑单节点聚焦
  const { svc, repo, bus } = makeService();
  const job = new Job({ id: 'jA5', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-5'); repo.save(job);
  svc.start({ jobId: 'jA5', now: new Date() });
  const r = svc.onTrustEvent({ eventId: 'ev-rev-5', type: 'GrantRevoked', grant: { id: 'gr-5' }, revokedReason: '吊销' });
  assert.equal(r.action, 'completed_compensated');
  assert.equal(job.status, 'completed');
  assert.equal(bus.byType('JobCompleted').length, 1);
  // 未启动队例
  const queued = new Job({ id: 'jA5b', creator: 'dev1', target: 'svc-9', template: 'restart', params: { command: 'restart_service' } });
  queued.bindGrant('gr-9'); repo.save(queued);
  svc.onTrustEvent({ eventId: 'ev-rev-9', type: 'GrantRevoked', grant: { id: 'gr-9' }, revokedReason: 'x' });
  assert.equal(queued.status, 'rejected');
});

// ---------- fault-tolerance path ----------

test('F1 审计端口失败 → ERROR fail-closed，不执行（INV-U1)）', () => {
  const { svc, repo } = makeService({ auditPort: { write: () => ({ ok: false }) } });
  const job = new Job({ id: 'jF1', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-1'); repo.save(job);
  const r = svc.start({ jobId: 'jF1', now: new Date() });
  assert.equal(r.status, 'ERROR');
  assert.equal(r.reason, 'audit_failed');
  assert.notEqual(job.status, 'running', '审计失败不得下发执行');
});

test('F2 事件总线未接线 → 不崩溃（eventBus null 兼容）', () => {
  const svc = new ExecutionService({
    jobRepo: new InMemoryJobRepo(), eventBus: null,
    trustPort: { checkGrant: () => ({ ok: true }) },
    assetPort: { isActive: () => true },
    matrixPort: { isAllowed: () => true },
    auditPort: { write: () => ({ ok: true }) },
  });
  const job = new Job({ id: 'jF2', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  svc.jobRepo.save(job); job.bindGrant('gr-2');
  const r = svc.start({ jobId: 'jF2', now: new Date() });
  assert.equal(r.status, 'OK', '未接线总线仍可启动');
});

test('F3 端口返回畸形 → 结构校验 fail-fast（ERROR 而非 blob 渗漏）', () => {
  // trustPort 返回 undefined / 畸形 → ERROR grant_port_malformed
  const { svc, repo } = makeService({ trustPort: { checkGrant: () => undefined } });
  const job = new Job({ id: 'jF3', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-3'); repo.save(job);
  const r = svc.start({ jobId: 'jF3', now: new Date() });
  assert.equal(r.status, 'ERROR');
  assert.equal(r.reason, 'grant_port_malformed');
});

test('F4 时间倒退（now 异常/非法）拒绝——ERROR invalid_time', () => {
  const { svc, repo } = makeService();
  const job = new Job({ id: 'jF4', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-4'); repo.save(job);
  const r = svc.start({ jobId: 'jF4', now: 'not-a-date' });
  assert.equal(r.status, 'ERROR');
  assert.equal(r.reason, 'invalid_time');
});

// ---------- schema/工具语义（S 系列：协议/参数细节） ----------

test('S1 参数哈希确定性（同参同哈希）', () => {
  assert.equal(paramsHash({ a: 1, b: 2 }), paramsHash({ b: 2, a: 1 }), '键序无关');
  assert.notEqual(paramsHash({ a: 1 }), paramsHash({ a: 2 }), '值不同哈希不同');
});

test('S2 事件快照含 schemaVersion+eventId+深冻结（不可变）', () => {
  const { svc, repo, bus } = makeService();
  const job = new Job({ id: 'jS2', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-2'); repo.save(job);
  svc.start({ jobId: 'jS2', now: new Date() });
  const jobStarted = bus.byType('JobStarted')[0];
  assert.equal(jobStarted.schemaVersion, 1);
  assert.ok(jobStarted.eventId);
  assert.ok(Object.isFrozen(jobStarted), '事件载荷冻结');
});

test('S3 矩阵不允许 → REJECTED capability_not_allowed_by_matrix（INV-P1）', () => {
  const { svc, repo } = makeService({ matrixPort: { isAllowed: () => false } });
  const job = new Job({ id: 'jS3', creator: 'dev1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-3'); repo.save(job);
  const r = svc.start({ jobId: 'jS3', now: new Date() });
  assert.equal(r.status, 'REJECTED');
  assert.equal(r.reason, 'capability_not_allowed_by_matrix');
});