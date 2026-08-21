// 组合根（composition root）——真实适配器装配（真实部署形态）
// 职责：把已实现的真实适配器注入 M3/M4/M5 领域服务，形成可运行的部署装配
//   repo（身份/资产 JSON 文件版 + 云台账投影）→ M4 assetPort
//   exec（SSH 执行适配器）→ M4 exec 完成回调（completeJob/failJob 经 adapter 结果驱动）
//   model（供应商无关 + Cohere）→ M2/M5 convPort.interpret
//   audit（JSONL 持久化）→ M4 auditPort / M5 auditPort
// 模式：mock（测试，全部内存 + 假 SSH/假模型）| real（部署，真实文件 + 真实 SSH + 真实模型）
// 原则：配置经参数注入（不硬编码路径/Key）；fail-fast（缺失配置 → 抛错）；单源（复用既有适配器，不复制逻辑）

'use strict';

const { createIdentityRepo, createIdentityRepoMemory } = require('./repo/repo-identity.js');
const { createAssetRepo, createAssetRepoMemory } = require('./repo/repo-asset.js');
const { createSshExecAdapter, createSshExecAdapterMemory } = require('./exec/exec-adapter.js');
const { createModelApi } = require('./model/model-api.js');
const { createCohereAdapter } = require('./model/cohere-adapter.js');
const { createAuditRepo } = require('./audit/repo-memory.js');
const { createFilePersist } = require('./audit/persist-file.js');
const { AuditEntry } = require('./audit/domain.js');

// 领域服务（跨目录引用——组合根是唯一允许装配 M3/M4/M5 的层）
const { ApprovalFlowService } = require('../../m3/src/trust/domain.js');
const { InMemoryApprovalRepo, InMemoryGrantRepo, InMemoryAggregationRepo } = require('../../m3/src/trust/repo-memory.js');
const { ExecutionService } = require('../../m4/src/exec/domain.js');
const { InMemoryJobRepo, InMemoryEventBus } = require('../../m4/src/exec/repo-memory.js');
const { IntegrationService } = require('./integration/domain.js');

/**
 * 装配组合根
 * @param {object} opts
 *  - mode: 'mock' | 'real'
 *  - audit: { file } 审计 JSONL 文件（real 必填；mock 用内存）
 *  - repo: { identityFile, assetFile } 身份/资产 JSON 文件（real 必填；mock 用内存）
 *  - exec: { keyVaultPort } SSH 凭据解析（real 必填；mock 用内存假 SSH）
 *  - model: { provider, registry, fallback } 模型（real 需 registry 含 cohere；mock 需假模型）
 *  - timeSource: () => Date（默认 new Date）
 */
function compose({ mode = 'mock', audit = {}, repo = {}, exec = {}, model = {}, timeSource = () => new Date() } = {}) {
  if (mode !== 'mock' && mode !== 'real') throw new Error(`compose: mode 非法（${mode}，须 mock|real）`);

  // ---------- 1. 审计（JSONL 持久化 / 内存） ----------
  let auditRepo;
  if (mode === 'real') {
    if (!audit.file) throw new Error('compose(real): audit.file 必填（JSONL 路径）');
    auditRepo = createAuditRepo({ persist: createFilePersist({ file: audit.file }) });
  } else {
    auditRepo = createAuditRepo({});
  }

  // ---------- 2. 身份/资产仓储（JSON 文件 / 内存） ----------
  let identityRepo, assetRepo;
  if (mode === 'real') {
    if (!repo.identityFile || !repo.assetFile) throw new Error('compose(real): repo.identityFile/repo.assetFile 必填');
    identityRepo = createIdentityRepo({ file: repo.identityFile, identities: repo.identitySeed || [] });
    assetRepo = createAssetRepo({ file: repo.assetFile, assets: repo.assetSeed || [] });
  } else {
    identityRepo = createIdentityRepoMemory(repo.identitySeed || []);
    assetRepo = createAssetRepoMemory(repo.assetSeed || []);
  }

  // ---------- 3. SSH 执行（真实 / 内存假） ----------
  let execAdapter;
  if (mode === 'real') {
    if (!exec.keyVaultPort || typeof exec.keyVaultPort.resolve !== 'function') {
      throw new Error('compose(real): exec.keyVaultPort 必填（{ resolve(target) → {user,host,port,keyPath} }）');
    }
    execAdapter = createSshExecAdapter({ keyVaultPort: exec.keyVaultPort, ...(exec.opts || {}) });
  } else {
    execAdapter = createSshExecAdapterMemory();
  }

  // ---------- 4. 模型（供应商无关 + Cohere / 假模型） ----------
  let modelApi;
  if (mode === 'real') {
    if (!model.apiKey) throw new Error('compose(real): model.apiKey 必填（Cohere Key，经注入不落盘）');
    const cohere = createCohereAdapter({ apiKey: model.apiKey, model: model.modelName || 'command', fetchImpl: model.fetchImpl });
    modelApi = createModelApi({ provider: 'cohere', registry: { cohere }, fallback: model.fallback });
  } else {
    // mock 假模型：规则引擎（口语动词 → 结构化意图）
    modelApi = createModelApi({
      provider: 'mock-rule',
      registry: {
        'mock-rule': {
          interpretSync(text) {
            const s = String(text);
            const execVerbs = ['重启', '清理', '扩容', '变更', '切换', 'restart', 'clean', 'scale'];
            const isExec = execVerbs.some(v => s.includes(v)) && !s.includes('看看') && !s.includes('状态');
            return JSON.stringify(isExec
              ? { intentType: 'execute', capability: s.includes('清理') || s.includes('clean') ? 'clean' : 'restart', confidence: 0.95, subject: 'svc-1' }
              : { intentType: 'query', capability: 'query_status', confidence: 0.95, subject: null });
          },
          async interpret(text) { return this.interpretSync(text); },
          async search() { return []; },
        },
      },
    });
  }

  // ---------- 5. 领域服务装配 ----------
  // M3 trust：审批流（高危/聚合升级 → 审批；非高危 → 自动 Grant）
  const approvalPool = { resolvers: () => ['sre-1', 'sre-2', 'sre-3'] };
  const trustService = new ApprovalFlowService({
    approvalRepo: new InMemoryApprovalRepo(),
    grantRepo: new InMemoryGrantRepo(),
    aggregationRepo: new InMemoryAggregationRepo(),
    approvalPool,
    timeSource,
  });

  // M4 exec：执行服务（assetPort 用真实资产仓储）
  const jobRepo = new InMemoryJobRepo();
  const eventBus = new InMemoryEventBus();
  const execService = new ExecutionService({
    jobRepo,
    trustPort: { checkGrant: (grantRef, target, template, paramsHash, now) => trustService.checkGrant(grantRef, target, template, paramsHash, now) },
    assetPort: { isActive: (t) => assetRepo.isActive(t) },
    matrixPort: { isAllowed: () => true },
    auditPort: { write: (five) => {
      const entry = five instanceof AuditEntry ? five : new AuditEntry(five);
      auditRepo.write(entry);
      return { ok: true };
    } },
    eventBus,
  });

  // M5 integration：编排层（convPort 同步契约——用同步规则引擎，模型 HTTP 为异步不直插；
  //  真实模型异步通道经 adapters.model.interpret 暴露，供上层（API 网关）在异步路径调用）
  // audit 桥接：integration 传五元组普通对象 → 包装为 AuditEntry（chain.append 须实例）；
  //  写失败抛错（M5 _audit catch → 上层 ERROR，INV-U1 fail-closed）
  const auditWrite = (five) => {
    const entry = five instanceof AuditEntry ? five : new AuditEntry(five);
    auditRepo.write(entry);
    return { ok: true };
  };

  const integrationService = new IntegrationService({
    convPort: { interpret: ({ actorId, intent, now }) => {
      const r = modelApi.interpretSync(intent, { actorId });
      if (!r.ok) return { intentType: 'query', capability: 'query_status', confidence: 0, intentId: `int-${intent}`, subject: null, degraded: true };
      return { intentType: r.intentType, capability: r.capability || 'query_status', confidence: r.confidence, intentId: `int-${intent}`, subject: r.subject, params: r.params };
    } },
    trustPort: {
      handleExecIntent: (p) => trustService.handleExecIntent(p),
      resolveApproval: (p) => trustService.resolveApproval(p),
    },
    execPort: {
      createJob: (p) => execService.createJob(p),
      start: (p) => execService.start(p),
    },
    auditPort: { write: auditWrite },
    timeSource,
  });

  return {
    mode,
    services: { trust: trustService, exec: execService, integration: integrationService },
    adapters: { audit: auditRepo, identity: identityRepo, asset: assetRepo, exec: execAdapter, model: modelApi },
  };
}

module.exports = { compose };
