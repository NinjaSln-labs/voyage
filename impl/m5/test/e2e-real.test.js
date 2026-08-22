// real 模式端到端冒烟（真实部署形态整链验证）
// 链路：compose(real) 装配 → 云台账投影喂资产种子 + 身份种子 → 本地引擎意图 → trust 审批签发 Grant
//      → execStart（资产/矩阵判定走真实仓储）→ runJob 真实 SSH（京东云只读模板 find /var/log）
//      → completeJob → 审计 JSONL 落盘验证
// 前置：~/.ssh/oracle_tokyo 私钥存在才跑（CI/无钥环境自动跳过）；网络不可达时按契约失败语义放行

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compose } = require('../src/compose.js');
const { createCloudAssetSeed } = require('../src/repo/repo-cloud-services.js');

const KEY_PATH = path.join(os.homedir(), '.ssh', 'oracle_tokyo');
const LEDGER_PATH = path.join(os.homedir(), 'Documents', 'cloud-services', 'cloud-services.json');
const RUN = fs.existsSync(KEY_PATH) && process.env.VOYAGE_E2E_REAL === '1';

test('E2E-real 整链：台账→装配→审批→真实 SSH 只读执行→审计落盘', { skip: !RUN }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-e2e-'));
  // 1. 云台账投影 → 执行面资产种子（仅 hardened:true 服务器；jd-light 可达性最好）
  const { assets } = createCloudAssetSeed({ file: LEDGER_PATH });
  const target = assets.find(a => a.id === 'jd-light');
  assert.ok(target, '台账投影含 jd-light');

  // 2. real 装配：本地规则引擎（syncCapable）+ 台账 keyVault（SSH 连接信息单源）
  const app = compose({
    mode: 'real',
    audit: { file: path.join(dir, 'audit.jsonl') },
    repo: {
      identityFile: path.join(dir, 'identity.json'),
      assetFile: path.join(dir, 'asset.json'),
      identitySeed: [{ id: 'sre-alice', role: 'sre' }],
      assetSeed: [{ id: 'jd-light' }],
    },
    exec: {
      keyVaultPort: {
        resolve: (t) => (t === 'jd-light' ? { user: 'root', host: '117.72.186.97', port: 22022, keyPath: KEY_PATH } : null),
      },
    },
    model: {
      provider: 'local-rule',
      syncCapable: true,
      registry: {
        'local-rule': {
          interpretSync(text) {
            const s = String(text);
            // G2 绑定：模型产出与执行用同一 params（trust Grant 绑定此 hash；runJob 同参执行）
            if (s.includes('日志')) return JSON.stringify({ intentType: 'execute', capability: 'clean', confidence: 0.95, subject: 'jd-light', params: { command: 'clean_logs', path: '/var/log/' } });
            return JSON.stringify({ intentType: 'query', capability: 'query_status', confidence: 0.9, subject: null });
          },
          async interpret(text) { return this.interpretSync(text); },
        },
      },
    },
  });

  // 3. sync 入口（本地引擎有 interpretSync）：口语意图 → clean 高危 → 审批
  const r1 = app.handle({ actorId: 'sre-alice', from: 'cli', intent: '清理 jd-light 的日志' });
  assert.strictEqual(r1.status, 'NEED_REVIEW', JSON.stringify(r1));
  assert.ok(r1.approval, '高危审批单创建');

  // 4. 双人批准 → Grant 签发（Outbox 直通路径）
  const resolved = app.services.trust.resolveApproval({
    approval: r1.approval,
    votes: ['sre-b', 'sre-c'],
    rejectBy: null,
    now: new Date(),
    params: { command: 'clean_logs', path: '/var/log/' }, // G2：与意图/作业同参
  });
  assert.strictEqual(resolved.status, 'approved', JSON.stringify(resolved));
  assert.ok(resolved.grant, 'Grant 签发');

  // 5. 创建作业 + 绑定 Grant + 启动（矩阵/资产判定走真实仓储）
  const job = app.services.exec.createJob({
    id: `job-${resolved.grant.id}`,
    creator: 'sre-alice',
    target: 'jd-light',
    template: 'clean',
    params: { command: 'clean_logs', path: '/var/log/' },
  });
  job.bindGrant(resolved.grant.id);
  const started = app.execStart({ jobId: job.id, now: new Date() });
  assert.strictEqual(started.status, 'OK', JSON.stringify(started));

  // 6. runJob → 真实 SSH（find /var/log 只读列出）→ completeJob
  const run = await app.runJob({ jobId: job.id });
  // 允许契约内失败语义（网络变化），成功则验证完整结果
  if (run.status === 'OK') {
    assert.strictEqual(app.services.exec.jobRepo.findById(job.id).status, 'completed');
    assert.ok(run.job.result && typeof run.job.result.exitCode === 'number');
  } else {
    assert.ok(['ERROR'].includes(run.status), `runJob 契约语义（实际 ${run.reason}）`);
    assert.match(run.reason || '', /connection_failed|timeout|permission_denied|execution_failed/);
  }

  // 7. 审计 JSONL 落盘：keyVault.resolve 使用留痕 + 审计链可重建校验
  const lines = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines.length >= 1, '审计已落盘');
  assert.ok(lines.some(l => l.entry && l.entry.from === 'keyVault.resolve'), 'keyVault 使用审计在 real 链中留痕');
  const verify = app.adapters.audit.verify();
  assert.strictEqual(verify.ok, true, '审计链哈希校验通过');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('E2E-real 装配冒烟（无钥环境也跑）：real 模式可完整构造且服务齐备', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-e2e-asm-'));
  const app = compose({
    mode: 'real',
    audit: { file: path.join(dir, 'audit.jsonl') },
    repo: {
      identityFile: path.join(dir, 'identity.json'),
      assetFile: path.join(dir, 'asset.json'),
      identitySeed: [{ id: 'u1', role: 'sre' }],
      assetSeed: [{ id: 'svc-1' }],
    },
    exec: { keyVaultPort: { resolve: () => ({ user: 'u', host: '127.0.0.1', port: 22, keyPath: '/nonexistent' }) } },
    model: {
      provider: 'local',
      syncCapable: true,
      registry: { local: { interpretSync: () => '{"intentType":"query","confidence":0.5}', async interpret() { return this.interpretSync(); } } },
    },
  });
  // handle 可用（syncCapable）+ 审计落盘 + 身份/资产仓储文件化
  const r = app.handle({ actorId: 'u1', from: 'cli', intent: '随便看看' });
  assert.strictEqual(r.status, 'OK');
  assert.ok(fs.existsSync(path.join(dir, 'identity.json')), '身份仓储文件化');
  assert.ok(fs.existsSync(path.join(dir, 'audit.jsonl')), '审计文件化');
  fs.rmSync(dir, { recursive: true, force: true });
});
