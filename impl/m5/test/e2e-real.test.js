// real 模式端到端冒烟（真实部署形态整链验证）
// 链路：compose(real) 装配 → 云台账投影喂资产种子 + 身份种子 → 本地引擎意图 → trust 审批签发 Grant
//      → execStart（资产/矩阵判定走真实仓储）→ runJob 真实 SSH（京东云只读模板 find /var/log）
//      → completeJob → 审计 JSONL 落盘验证（从盘重读重建独立链校验）
// 前置：~/.ssh/oracle_tokyo 私钥存在且 VOYAGE_E2E_REAL=1 才跑真实链（CI/无钥环境自动跳过——
//      默认门禁不含真实链证据，见 HANDOFF §4）
// G2 一致性：意图/Grant/作业同 params——测试取 handle 返回的 r1.params（模型产出）透传，不硬编码字面量
// 连接信息：本文件为「手抄镜像」非台账单源（投影有意剥离 ssh 字段防泄漏）——注释如实声明，见审计 S2

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFilePersist } = require('../src/audit/persist-file.js');
const { AppendOnlyAuditChain } = require('../src/audit/domain.js');
const { compose } = require('../src/compose.js');
const { createCloudAssetSeed } = require('../src/repo/repo-cloud-services.js');

const KEY_PATH = path.join(os.homedir(), '.ssh', 'oracle_tokyo');
const LEDGER_PATH = path.join(os.homedir(), 'Documents', 'cloud-services', 'cloud-services.json');
const RUN = fs.existsSync(KEY_PATH) && process.env.VOYAGE_E2E_REAL === '1';
// G2 同参单源（审计 S4：三处手抄字面量 → 一处 const，一致性结构性成立）
const CLEAN_PARAMS = { command: 'clean_logs', path: '/var/log/' };

test('E2E-real 整链：台账→装配→审批→真实 SSH 只读执行→审计落盘', { skip: !RUN }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-e2e-'));
  try {
    // 1. 云台账投影 → 执行面资产种子（仅 hardened:true 服务器进执行面）
    const { assets } = createCloudAssetSeed({ file: LEDGER_PATH });
    assert.ok(assets.find(a => a.id === 'jd-light'), '台账投影含 jd-light');

    // 2. real 装配：本地规则引擎（syncCapable）+ keyVault（连接信息为手抄镜像，见文件头声明）
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
              // G2 绑定：模型产出 CLEAN_PARAMS（trust Grant 绑定此 hash；runJob 同参执行）
              if (s.includes('日志')) return JSON.stringify({ intentType: 'execute', capability: 'clean', confidence: 0.95, subject: 'jd-light', params: CLEAN_PARAMS });
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
    // G2（审计 C1 修正）：params 取模型产出（r1.params），不硬编码——模型漂移此处即红
    assert.deepStrictEqual(r1.params, CLEAN_PARAMS, 'handle 返回 params 与引擎产出一致');

    // 4. 双人批准 → Grant 签发（审计 C1/C4 修正：走 M5 编排层 resolveApproval——
    //    INV-U5 审批决定审计 + _launchFromGrant 自动建作业并启动，不再手工 createJob/bindGrant）
    const resolved = app.services.integration.resolveApproval({
      approval: r1.approval,
      votes: ['sre-b', 'sre-c'],
      rejectBy: null,
      now: new Date(),
      actorId: 'sre-alice',
      params: r1.params, // G2 同源透传（模型产出 → Grant/作业同参）
    });
    assert.strictEqual(resolved.status, 'approved', JSON.stringify(resolved));
    assert.ok(resolved.grant, 'Grant 签发');
    assert.strictEqual(resolved.deferred, false, '无 Outbox 时直通启动');

    // 5. 编排层已自动创建并启动作业（job-<grant.jobRef>）——取回引用供 runJob
    const jobId = `job-${resolved.grant.jobRef || resolved.grant.id}`;
    const job = app.services.exec.jobRepo.findById(jobId);
    assert.ok(job, '编排层已自动建作业');
    assert.strictEqual(job.status, 'running', '直通路径已启动');

    // 6. runJob → 真实 SSH（find /var/log 只读列出）→ completeJob
    // 失败放行仅限契约网络三元组（审计 C2 收紧：execution_failed 可能是远端真实缺陷，不放行）
    const run = await app.runJob({ jobId });
    if (run.status === 'OK') {
      assert.strictEqual(app.services.exec.jobRepo.findById(jobId).status, 'completed');
      assert.ok(run.job.result && typeof run.job.result.exitCode === 'number');
    } else {
      assert.strictEqual(run.status, 'ERROR');
      assert.ok(
        ['connection_failed', 'timeout', 'permission_denied'].includes(run.reason),
        `仅网络类失败可放行（实际 ${run.reason}——execution_failed 视为真实缺陷不放行）`,
      );
      // 失败也要落终态 + 审计完整（不放行掩盖非网络回归）
      assert.strictEqual(app.services.exec.jobRepo.findById(jobId).status, 'failed', '失败作业落 failed 终态');
    }

    // 7. 审计 JSONL 落盘验证（审计 A1 补强）：
    //    a) keyVault 使用留痕；b) 审批类留痕；c) 从盘重读重建独立链 verify（非内存链自证）
    const auditFile = path.join(dir, 'audit.jsonl');
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(lines.length >= 1, '审计已落盘');
    assert.ok(lines.some(l => l.entry && l.entry.from === 'keyVault.resolve'), 'keyVault 使用审计留痕');
    assert.ok(lines.some(l => l.entry && l.entry.from === 'ui' && l.entry.result === 'approved'), '审批决定审计留痕（INV-U5）');
    // 独立重建：新实例从 JSONL load 重建 → verify 校验落盘内容完整性（损坏在此暴露）
    const rebuilt = new AppendOnlyAuditChain({ persist: createFilePersist({ file: auditFile }) });
    assert.strictEqual(rebuilt.verify().ok, true, '从盘重建链校验通过（落盘内容完整）');
    assert.ok(rebuilt.length >= lines.length - 1, '重建条数与落盘一致');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // 审计 S3：断言失败路径也不泄漏 tmp
  }
});

test('E2E-real 装配冒烟（无钥环境也跑）：real 模式可完整构造且服务齐备', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-e2e-asm-'));
  try {
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
