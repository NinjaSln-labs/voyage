// 组合根装配契约测试（mock 模式：内存仓储 + 假 SSH + 假模型——整链可测不连网络）
// 验证：装配自检（服务/适配器齐全）、mock 模式整链（口语意图 → 模型 → trust → exec → 审计）、
//      real 模式配置校验（缺文件/Key 必填 fail-fast）

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  // 自定义 registry 分支：Key 非必需（real 冒烟走本地引擎）
  const appLocal = compose({
    mode: 'real', audit: { file: '/tmp/a2.jsonl' },
    repo: { identityFile: '/tmp/i2.json', assetFile: '/tmp/a2.json' },
    exec: { keyVaultPort: { resolve: () => null } },
    model: { provider: 'local', syncCapable: true, registry: { local: { interpretSync: () => '{"actionClass":"read","confidence":0.5}', async interpret() { return this.interpretSync(); } } } },
  });
  assert.strictEqual(appLocal.mode, 'real');
});

test('D6 非法 mode → fail-fast', () => {
  assert.throws(() => compose({ mode: 'prod' }), /mode 非法/);
});

test('D7 mock 整链：SSH 执行适配器可接（内存假执行注入）', async () => {
  // 预置身份 u1(sre)——matrixPort 现按角色投影判定（RQ-415），creator 无身份/无能力 → 拒绝
  const app = compose({ mode: 'mock', repo: { assetSeed: [{ id: 'svc-1' }], identitySeed: [{ id: 'u1', role: 'sre' }] } });
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
  const started = app.execStart({ jobId: job.id, now: new Date() });
  assert.strictEqual(started.status, 'OK', JSON.stringify(started));

  // 执行结果经适配器回调完成
  const res = await app.adapters.exec.execute('svc-1', 'restart_service', { service: 'svc-1' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.result.exitCode, 0);
  const done = app.services.exec.completeJob({ jobId: job.id, result: res.result });
  assert.strictEqual(done.status, 'OK');
});


/** 测试辅助：走 trust 审批签发真实 Grant（checkGrant 依赖 grantRepo） */
function issueGrant(app, { intentId, actorId, target, capability, params }) {
  const r = app.services.trust.handleExecIntent({ intentId, actorId, target, capability, params, now: new Date() });
  assert.strictEqual(r.status, 'pending_approval');
  const resolved = app.services.trust.resolveApproval({ approval: r.approval, votes: ['sre-1', 'sre-2'], rejectBy: null, now: new Date() });
  assert.ok(resolved.status === 'approved' && resolved.grant);
  return resolved.grant;
}

// ============ 审计修复回归（P0/P1） ============

test('F1 real 模式 sync 守卫：Cohere（无 interpretSync）→ handle 显式报错，handleAsync 可用', async () => {
  const app = compose({
    mode: 'real',
    audit: { file: '/tmp/voyage-f1-audit.jsonl' },
    repo: { identityFile: '/tmp/voyage-f1-i.json', assetFile: '/tmp/voyage-f1-a.json' },
    exec: { keyVaultPort: { resolve: () => null } },
    model: { apiKey: 'test-key', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ message: { content: [{ type: 'text', text: '{"actionClass":"write","capability":"restart","confidence":0.9,"subject":"svc-1"}' }] } }) }) },
  });
  // handle：无同步通道 → 显式报错（不静默降级为 query）
  assert.throws(() => app.handle({ actorId: 'u1', from: 'cli', intent: '重启 svc-1' }), /同步通道/);
  // handleAsync：真实模型通道 → execute 分支可达（NEED_REVIEW 高危审批）
  const r = await app.handleAsync({ actorId: 'u1', from: 'cli', intent: '重启 svc-1' });
  assert.strictEqual(r.status, 'NEED_REVIEW', JSON.stringify(r));
});

test('F2 runJob 运行时链：execute→completeJob 驱动（ADAPTER-CONTRACTS §2 替换条件落地）', async () => {
  const app = compose({ mode: 'mock', repo: { assetSeed: [{ id: 'svc-1' }], identitySeed: [{ id: 'u1', role: 'sre' }] } });
  app.adapters.exec.registerResult('svc-1', 'restart_service', { stdout: 'Restarted', stderr: '', exitCode: 0, nodeEffects: [] });
  const grant = issueGrant(app, { intentId: 'int-f2', actorId: 'u1', target: 'svc-1', capability: 'restart', params: { command: 'restart_service' } });
  const job = app.services.exec.createJob({ id: 'job-run-1', creator: 'u1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant(grant.id);
  app.execStart({ jobId: job.id, now: new Date() });
  const r = await app.runJob({ jobId: job.id });
  assert.strictEqual(r.status, 'OK', JSON.stringify(r));
  assert.strictEqual(app.services.exec.jobRepo.findById(job.id).status, 'completed');
});

test('F3 runJob 失败驱动：适配器失败 → failJob', async () => {
  const app = compose({ mode: 'mock', repo: { assetSeed: [{ id: 'svc-1' }], identitySeed: [{ id: 'u1', role: 'sre' }] } });
  app.adapters.exec.registerFailure('svc-1', 'restart_service', 'connection_failed');
  const grant = issueGrant(app, { intentId: 'int-f3', actorId: 'u1', target: 'svc-1', capability: 'restart', params: { command: 'restart_service' } });
  const job = app.services.exec.createJob({ id: 'job-run-2', creator: 'u1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant(grant.id);
  app.execStart({ jobId: job.id, now: new Date() });
  const r = await app.runJob({ jobId: job.id });
  assert.strictEqual(r.status, 'ERROR');
  assert.strictEqual(r.reason, 'connection_failed');
  assert.strictEqual(app.services.exec.jobRepo.findById(job.id).status, 'failed');
});

test('F4 matrixPort 身份投影判定：creator 无身份/停用/无能力 → 拒绝（RQ-415 服务端强制）', async () => {
  // creator u2 是 manager——manager 无 restart 能力
  const app = compose({ mode: 'mock', repo: { assetSeed: [{ id: 'svc-1' }], identitySeed: [{ id: 'u2', role: 'manager' }] } });
  const job = app.services.exec.createJob({ id: 'job-mx-1', creator: 'u2', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-mx');
  const started = app.execStart({ jobId: job.id, now: new Date() });
  assert.strictEqual(started.status, 'REJECTED');
  assert.strictEqual(started.reason, 'capability_not_allowed_by_matrix');
  // 无身份的 creator 也拒绝
  const app2 = compose({ mode: 'mock', repo: { assetSeed: [{ id: 'svc-1' }] } });
  const job2 = app2.services.exec.createJob({ id: 'job-mx-2', creator: 'ghost', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job2.bindGrant('gr-mx-2');
  const started2 = app2.execStart({ jobId: job2.id, now: new Date() });
  assert.strictEqual(started2.reason, 'capability_not_allowed_by_matrix');
});

test('F5 keyVault 使用审计：resolve 真实留痕（审计修复 R4 假修复返工——验证审计写入）', async () => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-f5-'));
  const auditFile = path.join(dir, 'audit.jsonl');
  const app = compose({
    mode: 'real',
    audit: { file: auditFile },
    repo: { identityFile: path.join(dir, 'i.json'), assetFile: path.join(dir, 'a.json'), identitySeed: [{ id: 'u1', role: 'sre' }], assetSeed: [{ id: 'svc-1' }] },
    exec: { keyVaultPort: { resolve: (t) => ({ user: 'root', host: '10.0.0.9', port: 22, keyPath: path.join(dir, 'k') }) } },
    model: { apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ message: { content: [{ type: 'text', text: '{}' }] } }) }) },
  });
  // 触发凭据解析：经 runJob（running 作业 → execAdapter.execute → keyVault.resolve → 审计留痕）
  const grant = issueGrant(app, { intentId: 'int-f5', actorId: 'u1', target: 'svc-1', capability: 'restart', params: { command: 'restart_service' } });
  const job = app.services.exec.createJob({ id: 'job-f5', creator: 'u1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant(grant.id);
  app.execStart({ jobId: job.id, now: new Date() });
  // 真实 SSH 会失败（10.0.0.9 不可达）——但 resolve 已发生，审计已留痕；等 runJob 完成
  await app.runJob({ jobId: job.id });
  // 验证审计文件含 credential_resolve 留痕
  const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const kvEntries = lines.filter(l => l.entry && l.entry.from === 'keyVault.resolve');
  assert.ok(kvEntries.length >= 1, `keyVault.resolve 审计留痕（实际 ${kvEntries.length} 条）`);
  assert.strictEqual(kvEntries[0].entry.action.capability, 'credential_resolve');
  assert.strictEqual(kvEntries[0].entry.action.target, 'svc-1');
  // 不记 Key 值（脱敏：载荷无 keyPath/host 明文）
  const raw = JSON.stringify(kvEntries[0]);
  assert.ok(!raw.includes('10.0.0.9'), '不泄漏 host');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('F6 handleAsync 并发安全：并发两请求不串包（审计修复 R2）', async () => {
  // real 模式 + 可控 fetch：两次请求返回不同意图
  const calls = [];
  const app = compose({
    mode: 'real',
    audit: { file: '/tmp/voyage-f6-audit.jsonl' },
    repo: {
      identityFile: '/tmp/voyage-f6-i.json', assetFile: '/tmp/voyage-f6-a.json',
      identitySeed: [{ id: 'uA', role: 'sre' }, { id: 'uB', role: 'sre' }],
      assetSeed: [{ id: 'svc-1' }],
    },
    exec: { keyVaultPort: { resolve: () => ({ user: 'root', host: '10.0.0.9', port: 22, keyPath: '/tmp/k' }) } },
    model: {
      apiKey: 'k',
      fetchImpl: async (url, opts) => {
        const body = JSON.parse(opts.body);
        const intentText = body.messages[1].content;
        calls.push(intentText);
        // uA 的「重启 svc-1」→ execute；uB 的「看看 svc-1 状态」→ query
        const text = intentText.includes('重启') ? '{"actionClass":"write","capability":"restart","confidence":0.9,"subject":"svc-1"}' : '{"actionClass":"read","capability":"query_status","confidence":0.9,"subject":null}';
        return { ok: true, status: 200, json: async () => ({ message: { content: [{ type: 'text', text }] } }) };
      },
    },
  });
  // 并发发起（uA 执行意图 / uB 查询意图）
  const [ra, rb] = await Promise.all([
    app.handleAsync({ actorId: 'uA', from: 'cli', intent: '重启 svc-1' }),
    app.handleAsync({ actorId: 'uB', from: 'cli', intent: '看看 svc-1 状态' }),
  ]);
  // 不串包：uA 拿到 execute 路径（高危审批），uB 拿到 query
  assert.strictEqual(ra.status, 'NEED_REVIEW', `uA 应走执行审批（实际 ${JSON.stringify(ra)}）`);
  assert.strictEqual(rb.status, 'OK');
  assert.strictEqual(rb.kind, 'query');
});

test('F7 runJob 缺参 failJob：scale 无 replicas → missing_param（不裸跑命令前缀，审计修复 R4）', async () => {
  const app = compose({ mode: 'mock', repo: { assetSeed: [{ id: 'svc-1' }], identitySeed: [{ id: 'u1', role: 'sre' }] } });
  const grant = issueGrant(app, { intentId: 'int-f7', actorId: 'u1', target: 'svc-1', capability: 'scale', params: { command: 'scale_replicas' } });
  const job = app.services.exec.createJob({ id: 'job-f7', creator: 'u1', target: 'svc-1', template: 'scale', params: { command: 'scale_replicas' } });
  job.bindGrant(grant.id);
  app.execStart({ jobId: job.id, now: new Date() });
  const r = await app.runJob({ jobId: job.id });
  assert.strictEqual(r.status, 'ERROR');
  assert.strictEqual(r.reason, 'missing_param:replicas');
  assert.strictEqual(app.services.exec.jobRepo.findById(job.id).status, 'failed');
});

test('F8 无启动上下文拒绝（窄验证 N2）：裸 start 不经 execStart → matrix fail-closed', () => {
  const app = compose({ mode: 'mock', repo: { assetSeed: [{ id: 'svc-1' }], identitySeed: [{ id: 'u1', role: 'sre' }] } });
  const job = app.services.exec.createJob({ id: 'job-f8', creator: 'u1', target: 'svc-1', template: 'restart', params: { command: 'restart_service' } });
  job.bindGrant('gr-f8');
  // 裸调 services.exec.start（无上下文注入）→ matrix 拿不到 creator → 拒绝
  const r = app.services.exec.start({ jobId: job.id, now: new Date() });
  assert.strictEqual(r.status, 'REJECTED');
  assert.strictEqual(r.reason, 'capability_not_allowed_by_matrix');
});

test('F9 启动早退不残留上下文（窄验证 N1）：先裸 start 失败 → 再 execStart 正常判定', () => {
  const app = compose({ mode: 'mock', repo: { assetSeed: [{ id: 'svc-1' }, { id: 'svc-2' }], identitySeed: [{ id: 'u1', role: 'sre' }, { id: 'u9', role: 'manager' }] } });
  // u9(manager) 的作业先走 execStart——manager 无 restart 能力被拒（上下文已消费/清除）
  const grant9 = issueGrant(app, { intentId: 'int-f9a', actorId: 'u9', target: 'svc-2', capability: 'restart', params: { command: 'restart_service' } });
  const job9 = app.services.exec.createJob({ id: 'job-f9a', creator: 'u9', target: 'svc-2', template: 'restart', params: { command: 'restart_service' } });
  job9.bindGrant(grant9.id);
  const r9 = app.execStart({ jobId: job9.id, now: new Date() });
  assert.strictEqual(r9.reason, 'capability_not_allowed_by_matrix');
  // 随后 u1(sre) 对同 target|template 走 execStart——不得受前面残留影响
  const grant1 = issueGrant(app, { intentId: 'int-f9b', actorId: 'u1', target: 'svc-2', capability: 'restart', params: { command: 'restart_service' } });
  const job1 = app.services.exec.createJob({ id: 'job-f9b', creator: 'u1', target: 'svc-2', template: 'restart', params: { command: 'restart_service' } });
  job1.bindGrant(grant1.id);
  const r1 = app.execStart({ jobId: job1.id, now: new Date() });
  assert.strictEqual(r1.status, 'OK', JSON.stringify(r1));
});

test('F10 缺参纵深：clean 缺 path 被 M4 构造拦截（领域防线）；change_config 缺 file/expr 由 runJob 兜底', async () => {
  const app = compose({ mode: 'mock', repo: { assetSeed: [{ id: 'svc-1' }], identitySeed: [{ id: 'u1', role: 'sre' }] } });
  // clean 缺 path → M4 Job 构造即拒绝（领域层防线，runJob 兜底不可达——这是正确行为）
  assert.throws(() => app.services.exec.createJob({ id: 'j-f10a', creator: 'u1', target: 'svc-1', template: 'clean', params: { command: 'clean_logs' } }), /须提供 path/);
  // change_config 缺 file/expr（M4 不强制）→ runJob 兜底 failJob
  const g2 = issueGrant(app, { intentId: 'int-f10b', actorId: 'u1', target: 'svc-1', capability: 'config_change', params: { command: 'change_config' } });
  const j2 = app.services.exec.createJob({ id: 'job-f10b', creator: 'u1', target: 'svc-1', template: 'config_change', params: { command: 'change_config' } });
  j2.bindGrant(g2.id);
  app.execStart({ jobId: j2.id, now: new Date() });
  const r2 = await app.runJob({ jobId: j2.id });
  assert.ok(r2.reason === 'missing_param:file' || r2.reason === 'missing_param:expr', JSON.stringify(r2));
  assert.strictEqual(app.services.exec.jobRepo.findById(j2.id).status, 'failed');
});

// ---------- Agens 完整真实链复验回归锚定（138e7ae 三处修复） ----------

/** real 模式 + 本地假模型（模拟 Agens 结构化产出）——不连网络，走 toConvResult 补全路径 */
function buildRealWithFakeModel(dir, stamp, assetSeed, modelOutput) {
  return compose({
    mode: 'real',
    audit: { file: path.join(dir, `audit-${stamp}.jsonl`) },
    repo: {
      identityFile: path.join(dir, `identity-${stamp}.json`),
      assetFile: path.join(dir, `asset-${stamp}.json`),
      identitySeed: [{ id: 'u1', role: 'sre' }],
      assetSeed,
    },
    exec: { keyVaultPort: { resolve: () => null } },
    model: {
      provider: 'fake-agens',
      syncCapable: true,
      registry: { 'fake-agens': { interpretSync: () => JSON.stringify(modelOutput), async interpret(t) { return this.interpretSync(t); } } },
    },
  });
}

test('F11 subject 缺失投影（Agens 复验回归）：params.service 命中活跃资产才补全，未知资产 fail-closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-f11-'));
  try {
    const output = (svc) => ({ actionClass: 'write', capability: 'clean', confidence: 0.95, subject: null, params: { service: svc, path: '/var/log/' } });
    // a) svc-x 活跃 → subject 投影 → 高危审批可达（原缺陷：subject null → trust invalid_params 全拒）
    const app1 = buildRealWithFakeModel(dir, 'a', [{ id: 'svc-x' }], output('svc-x'));
    const r1 = app1.handle({ actorId: 'u1', from: 'cli', intent: '清理日志' });
    assert.strictEqual(r1.status, 'NEED_REVIEW', JSON.stringify(r1));
    // b) 资产不存在/退役 → 不投影（fail-closed）→ trust invalid_params 拒绝
    const app2 = buildRealWithFakeModel(dir, 'b', [], output('svc-x'));
    const r2 = app2.handle({ actorId: 'u1', from: 'cli', intent: '清理日志' });
    assert.strictEqual(r2.status, 'REJECTED');
    assert.strictEqual(r2.reason, 'invalid_params');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F12 clean 命令模板补全（Agens 复验回归）：command 安全补全，path 破坏性目标仍不补', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-f12-'));
  try {
    // a) 模型只回 {path} → command='clean_logs' 被补全（否则 M4 模板白名单拒绝）
    const app1 = buildRealWithFakeModel(dir, 'a', [{ id: 'svc-x' }],
      { actionClass: 'write', capability: 'clean', confidence: 0.95, subject: 'svc-x', params: { path: '/var/log/' } });
    const r1 = app1.handle({ actorId: 'u1', from: 'cli', intent: '清理日志' });
    assert.strictEqual(r1.status, 'NEED_REVIEW', JSON.stringify(r1));
    assert.strictEqual(r1.params.command, 'clean_logs', '固定命令模板安全补全');
    assert.strictEqual(r1.params.path, '/var/log/', '模型产出不被覆盖');
    // b) 模型连 path 都没回 → command 可补但 path 保持缺省（不静默默认 /var/log/，破坏性目标走确认）
    const app2 = buildRealWithFakeModel(dir, 'b', [{ id: 'svc-x' }],
      { actionClass: 'write', capability: 'clean', confidence: 0.95, subject: 'svc-x', params: {} });
    const r2 = app2.handle({ actorId: 'u1', from: 'cli', intent: '清理日志' });
    assert.strictEqual(r2.status, 'NEED_REVIEW');
    assert.strictEqual(r2.params.command, 'clean_logs');
    assert.strictEqual(r2.params.path, undefined, 'path 不静默补全——M4 构造拦截转确认（fail-closed）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
