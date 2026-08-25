// Agens 完整真实链复验驱动（HANDOFF §3 待办：参数抽取版提示词下的完整审批执行链）
// 链路：AGNES_API_KEY 注入（不落盘）→ compose(real, vendor='agens') → 台账投影喂资产
//      → handleAsync 口语意图（模型抽 service/path）→ NEED_REVIEW 审批 → 双人批准 → Grant
//      → 自动建作业 → runJob 真实 SSH（jd-light，clean_logs=只读 find）→ 审计从盘重建校验
// 运行：node impl/m5/scripts/agens-real-chain.js（需 ~/.ssh/oracle_tokyo + 云台账 + 凭据条目）
// 说明：一次性验证驱动，命名不带 .test.js——不入 find 基线；free 档偶发超时经重试吸收

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { compose } = require('../src/compose.js');
const { createFilePersist } = require('../src/audit/persist-file.js');
const { AppendOnlyAuditChain } = require('../src/audit/domain.js');
const { createCloudAssetSeed } = require('../src/repo/repo-cloud-services.js');

const KEY_PATH = path.join(os.homedir(), '.ssh', 'oracle_tokyo');
const LEDGER_PATH = path.join(os.homedir(), 'Documents', 'cloud-services', 'cloud-services.json');
const CRED_PATH = path.join(os.homedir(), '.dsh', '.credentials.yaml');
const INTENT = '清理 jd-light 的 /var/log/ 日志'; // 参数抽取验证点：原话含服务名 + 路径

function readAgnesKey() {
  const text = fs.readFileSync(CRED_PATH, 'utf8'); // 仅内存注入，不写任何文件/日志
  const m = text.match(/^\s*AGNES_API_KEY:\s*(\S+)\s*$/m);
  if (!m) throw new Error('凭据文件无 AGNES_API_KEY 条目');
  return m[1];
}

async function main() {
  if (!fs.existsSync(KEY_PATH)) throw new Error('缺少 SSH 私钥 ' + KEY_PATH);
  if (!fs.existsSync(LEDGER_PATH)) throw new Error('缺少云台账 ' + LEDGER_PATH);
  const apiKey = readAgnesKey();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-agens-chain-'));
  try {
    // 1. 云台账投影 → 执行面资产种子（仅 hardened:true）
    const { assets } = createCloudAssetSeed({ file: LEDGER_PATH });
    console.log('[1] 台账投影资产数:', assets.length, '| 含 jd-light:', assets.some(a => a.id === 'jd-light'));

    // 3. handleAsync：Agens 意图理解 → 高危审批。free 档偶发超时 → 重试（最多 3 次）。
    //    注意：intentId 幂等键 = int-<actor>-<intent>——同 app 实例重试会命中 duplicate_intent_idempotent，
    //    故每轮尝试都新建装配（隔离 _handledIntentIds）。
    const buildApp = () => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      auditFile = path.join(dir, `audit-${stamp}.jsonl`);
      return compose({
        mode: 'real',
        audit: { file: auditFile },
        repo: {
          identityFile: path.join(dir, `identity-${stamp}.json`),
          assetFile: path.join(dir, `asset-${stamp}.json`),
          identitySeed: [{ id: 'sre-alice', role: 'sre' }],
          assetSeed: [{ id: 'jd-light' }],
        },
        exec: {
          keyVaultPort: {
            resolve: (t) => (t === 'jd-light'
              ? { user: 'root', host: '117.72.186.97', port: 22022, keyPath: KEY_PATH }
              : null),
          },
        },
        model: { vendor: 'agens', apiKey, modelName: 'agnes-2.0-flash' },
      });
    };

    let app = null;
    let r1 = null;
    let auditFile = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[3] handleAsync 第 ${attempt} 次尝试：「${INTENT}」`);
      app = buildApp();
      r1 = await app.handleAsync({ actorId: 'sre-alice', from: 'cli', intent: INTENT });
      console.log('    编排完整结果:', JSON.stringify(r1));
      if (r1.status === 'NEED_REVIEW') break;
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
    }
    if (!r1 || r1.status !== 'NEED_REVIEW' || !r1.approval) {
      throw new Error('未进入高危审批（status=' + (r1 && r1.status) + ', reason=' + (r1 && r1.reason) + '）——参数抽取或模型链路失败');
    }
    if (!r1.params || !r1.params.path) {
      throw new Error('模型未从原话抽出 path 参数：' + JSON.stringify(r1.params));
    }
    console.log('[3] ✅ 高危审批单已建，模型抽取 params:', JSON.stringify(r1.params));

    // 4. 双人批准 → Grant → 自动建作业并启动（走 integration.resolveApproval：INV-U5 审计 + Outbox 直通）
    const resolved = app.services.integration.resolveApproval({
      approval: r1.approval,
      votes: ['sre-b', 'sre-c'],
      rejectBy: null,
      now: new Date(),
      actorId: 'sre-alice',
      params: r1.params, // G2 同参单源：模型产出透传 Grant/作业
    });
    console.log('[4] 审批决定:', resolved.status, '| Grant:', !!resolved.grant, '| deferred:', resolved.deferred);
    if (resolved.status !== 'approved' || !resolved.grant) throw new Error('审批/Grant 失败: ' + JSON.stringify(resolved));

    // 5. 取自动创建的作业引用
    const jobId = `job-${resolved.grant.jobRef || resolved.grant.id}`;
    const job = app.services.exec.jobRepo.findById(jobId);
    console.log('[5] 作业:', jobId, '| 状态:', job && job.status);
    if (!job || job.status !== 'running') throw new Error('作业未处于 running');

    // 6. runJob → 真实 SSH 只读 find → completeJob/failJob
    const run = await app.runJob({ jobId });
    console.log('[6] 执行结果:', run.status, run.reason ? '(' + run.reason + ')' : '',
      run.job && run.job.result ? '| exitCode=' + run.job.result.exitCode : '');

    // 7. 审计落盘独立校验（从盘重建 verify，非内存链自证）
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const rebuilt = new AppendOnlyAuditChain({ persist: createFilePersist({ file: auditFile }) });
    const verified = rebuilt.verify();
    console.log('[7] 审计条数:', lines.length,
      '| keyVault留痕:', lines.some(l => l.entry && l.entry.from === 'keyVault.resolve'),
      '| 审批留痕:', lines.some(l => l.entry && l.entry.from === 'ui' && l.entry.result === 'approved'),
      '| 从盘verify:', verified.ok);

    const chainOk = run.status === 'OK' && verified.ok;
    console.log(chainOk ? '\n✅ Agens 完整真实链复验通过（参数抽取版提示词）' : '\n❌ 复验未全通过');
    process.exitCode = chainOk ? 0 : 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // tmp 清理（Key 不落盘：audit 无凭据值）
  }
}

main().catch((e) => { console.error('❌', e.message); process.exitCode = 1; });
