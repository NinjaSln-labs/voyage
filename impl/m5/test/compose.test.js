// 组合根装配契约测试（mock 模式：内存仓储 + 假 SSH + 假模型——整链可测不连网络）
// 验证：装配自检（服务/适配器齐全）、mock 模式整链（口语意图 → 模型 → trust → exec → 审计）、
//      real 模式配置校验（缺文件/Key 必填 fail-fast）

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { compose } = require('../src/compose.js');

test('D1 mock 模式装配自检：全部服务与适配器注入', () => {
  const app = compose({ mode: 'mock' });
  assert.strictEqual(app.mode, 'mock');
  // 服务
  assert.ok(app.services.trust, 'trust 服务');
  assert.ok(app.services.exec, 'exec 服务');
  assert.ok(app.services.integration, 'integration 服务');
  // 适配器
  assert.ok(app.adapters.audit, '审计仓储');
  assert.ok(app.adapters.identity, '身份仓储');
  assert.ok(app.adapters.asset, '资产仓储');
  assert.ok(app.adapters.exec, '执行适配器');
  assert.ok(app.adapters.model, '模型适配器');
});

test('D2 mock 整链：查询意图 → 模型 → 审计（不触执行）', async () => {
  const app = compose({ mode: 'mock' });
  const r = app.services.integration.handle({ actorId: 'u1', from: 'cli', intent: '看看 svc-1 的状态' });
  assert.strictEqual(r.status, 'OK');
  assert.strictEqual(r.kind, 'query');
  // 审计留痕（查询类也审计）
  assert.ok(app.adapters.audit.chain.length >= 1, '审计链有记录');
  assert.strictEqual(app.adapters.audit.verify().ok, true, '审计链校验通过');
});

test('D3 mock 整链：执行意图（高危 restart）→ trust 审批（NEED_REVIEW，不直接执行）', async () => {
  // 预置资产 svc-1 active
  const app = compose({ mode: 'mock', repo: { assetSeed: [{ id: 'svc-1' }] } });
  const r = app.services.integration.handle({ actorId: 'u1', from: 'cli', intent: '重启 svc-1' });
  // restart 是 M3 HIGH_RISK_CAPABILITIES（高危）→ 走审批，不自动 Grant
  assert.strictEqual(r.status, 'NEED_REVIEW', JSON.stringify(r));
  assert.strictEqual(r.needApproval, true);
  assert.ok(r.approval, '审批单创建');
});

test('D4 mock 整链：执行意图 + 资产退役 → 审批路径仍走通（资产状态在 exec.start 判定）', async () => {
  const app = compose({ mode: 'mock', repo: { assetSeed: [{ id: 'svc-1' }] } });
  app.adapters.asset.retire('svc-1', new Date());
  const r = app.services.integration.handle({ actorId: 'u1', from: 'cli', intent: '重启 svc-1' });
  // 高危 restart → 审批（资产退役在 exec.start 判定，审批通过后触发；不在审批前拦截）
  assert.strictEqual(r.status, 'NEED_REVIEW', JSON.stringify(r));
});

test('D5 real 模式配置校验：缺审计文件/仓储文件/Key → fail-fast', () => {
  assert.throws(() => compose({ mode: 'real' }), /audit.file 必填/);
  assert.throws(() => compose({ mode: 'real', audit: { file: '/tmp/a.jsonl' } }), /repo.identityFile/);
  assert.throws(() => compose({ mode: 'real', audit: { file: '/tmp/a.jsonl' }, repo: { identityFile: '/tmp/i.json', assetFile: '/tmp/a.json' } }), /exec.keyVaultPort 必填/);
  assert.throws(() => compose({
    mode: 'real', audit: { file: '/tmp/a.jsonl' },
    repo: { identityFile: '/tmp/i.json', assetFile: '/tmp/a.json' },
    exec: { keyVaultPort: { resolve: () => null } },
  }), /model.apiKey 必填/);
});

test('D6 非法 mode → fail-fast', () => {
  assert.throws(() => compose({ mode: 'prod' }), /mode 非法/);
});

test('D7 mock 整链：SSH 执行适配器可接（内存假执行注入）', async () => {
  const app = compose({ mode: 'mock', repo: { assetSeed: [{ id: 'svc-1' }] } });
  // 内存假 SSH：注册目标 svc-1 执行成功
  app.adapters.exec.registerResult('svc-1', 'restart_service', { stdout: 'Restarted', stderr: '', exitCode: 0, nodeEffects: [] });
  // 经 trust 服务签发真实 Grant（checkGrant 依赖 grantRepo 存在）
  const intentId = 'int-smoke-1';
  const grantRes = app.services.trust.handleExecIntent({ intentId, actorId: 'u1', target: 'svc-1', capability: 'restart', params: { command: 'restart_service' }, now: new Date() });
  // restart 高危 → 审批；审批通过签发 Grant
  assert.strictEqual(grantRes.status, 'pending_approval', JSON.stringify(grantRes));
  const grant = grantRes.approval
    ? app.services.trust.resolveApproval({ approval: grantRes.approval, votes: ['sre-1', 'sre-2'], rejectBy: null, now: new Date() })
    : null;
  assert.ok(grant && grant.status === 'approved' && grant.grant, '审批通过签发 Grant');

  // 经 exec 服务创建作业 + 绑定真实 Grant + 启动（资产 active 校验通过）
  const job = app.services.exec.createJob({ id: 'job-smoke-1', creator: 'u1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant(grant.grant.id);
  const started = app.services.exec.start({ jobId: job.id, now: new Date() });
  assert.strictEqual(started.status, 'OK', JSON.stringify(started));

  // 执行结果经适配器回调完成
  const res = await app.adapters.exec.execute('svc-1', 'restart_service', { service: 'svc-1' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.result.exitCode, 0);
  const done = app.services.exec.completeJob({ jobId: job.id, result: res.result });
  assert.strictEqual(done.status, 'OK');
});
