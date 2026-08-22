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
const { CAPABILITY_TO_COMMAND, EXEC_CAPABILITIES } = require('./shared-capabilities.js');

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
  let syncCapable = false; // real 模式：厂商是否有同步通道（决定 handle 是否可用）
  if (mode === 'real') {
    if (!model.apiKey) throw new Error('compose(real): model.apiKey 必填（Cohere Key，经注入不落盘）');
    if (model.registry) {
      // 自定义注册表（如本地规则引擎/其他厂商）：由调用方声明 sync 能力
      modelApi = createModelApi({ provider: model.provider, registry: model.registry, fallback: model.fallback });
      syncCapable = model.syncCapable === true;
    } else {
      const cohere = createCohereAdapter({ apiKey: model.apiKey, model: model.modelName || 'command', fetchImpl: model.fetchImpl });
      modelApi = createModelApi({ provider: 'cohere', registry: { cohere }, fallback: model.fallback });
      syncCapable = false; // Cohere HTTP 为 async——handle 不可用，走 handleAsync
    }
  } else {
    // mock 假模型：规则引擎（口语动词 → 结构化意图）
    modelApi = createModelApi({
      provider: 'mock-rule',
      registry: {
        'mock-rule': {
          interpretSync(text) {
            // 归一化视图判定（HANDOFF §4：语义判定一律先归一化——全角→半角）
            const s = String(text).replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ');
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
    syncCapable = true; // mock 规则引擎有 interpretSync
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

  // audit 桥接：integration/M4 传五元组对象 → 包装为 AuditEntry（chain.append 须实例）；
  //  写失败抛错（M5 _audit catch → 上层 ERROR，INV-U1 fail-closed）
  const auditWrite = (fiveTuple) => {
    const entry = fiveTuple instanceof AuditEntry ? fiveTuple : new AuditEntry(fiveTuple);
    auditRepo.write(entry);
    return { ok: true };
  };

  // RQ-411 凭据使用审计：keyVault.resolve 包一层——每次凭据解析留痕（不记 Key 值，只记 target/时间/结果）
  const auditedKeyVaultPort = (mode === 'real' && exec.keyVaultPort && typeof exec.keyVaultPort.resolve === 'function')
    ? {
        resolve(target) {
          const conn = exec.keyVaultPort.resolve(target);
          try {
            auditWrite({
              who: 'system', when: timeSource(), from: 'keyVault.resolve',
              action: { intent: 'query', capability: 'credential_resolve', target, paramsSchemaOk: true },
              result: conn ? 'success' : 'rejected',
              links: { target },
            });
          } catch (e) { /* 审计失败不影响凭据解析本身（读操作非 fail-closed 面） */ }
          return conn;
        },
      }
    : null;

  // M4 exec：执行服务。
  // assetPort 用真实资产仓储；matrixPort 用身份仓储角色→能力投影（RQ-415 服务端强制——审计修复：
  //  原实现 isAllowed: () => true 恒真，ROLE_CAPABILITIES 无消费方）。
  // matrix 判定语义：capability ∈ identity(creator).capabilities 才允许。actorId 经 opts.matrixActor 注入
  // （M4 start 的 isAllowed(template, target, undefined) 第三参为 role=undefined——组合根以「当前作业 creator」绑定）。
  const jobRepo = new InMemoryJobRepo();
  const eventBus = new InMemoryEventBus();
  const _jobCreatorOf = (template, target) => {
    // 从 jobRepo 找该 target+template 的 queued/running 作业 creator（矩阵判定按 creator 角色投影）
    const jobs = jobRepo.findByTarget ? jobRepo.findByTarget(target) : [];
    const hit = jobs.find(j => j.template === template);
    return hit ? hit.creator : null;
  };
  const execService = new ExecutionService({
    jobRepo,
    trustPort: { checkGrant: (grantRef, target, template, paramsHash, now) => trustService.checkGrant(grantRef, target, template, paramsHash, now) },
    assetPort: { isActive: (t) => assetRepo.isActive(t) },
    matrixPort: {
      isAllowed(capability, target) {
        const creator = _jobCreatorOf(capability, target);
        if (!creator) return false; // 无作业归属 → 拒绝（fail-closed）
        const ident = identityRepo.findById(creator);
        if (!ident || !ident.active) return false; // 身份不存在/停用 → 拒绝
        return ident.hasCapability(capability);   // 角色→能力投影判定（RQ-415）
      },
    },
    auditPort: { write: auditWrite },
    eventBus,
  });

  // M5 integration：编排层。
  // 同步契约桥接（审计修复 P0-2）：M5 IntegrationService.handle 为同步契约，真实模型 async 不能直插——
  // 组合根提供双入口：
  //   handle(text)      —— sync，走 interpretSync（real 模式须厂商提供 interpretSync，否则显式报错不静默降级）
  //   handleAsync(text) —— async，先 await 真实模型 interpret，再以预解析意图驱动同一 sync 编排管线

  const toConvResult = (r, intent) => {
    if (!r || r.ok !== true) {
      return { intentType: 'query', capability: 'query_status', confidence: 0, intentId: `int-${intent}`, subject: null, degraded: true };
    }
    return { intentType: r.intentType, capability: r.capability || 'query_status', confidence: r.confidence, intentId: `int-${intent}`, subject: r.subject, params: r.params };
  };

  let _preInterpreted = null; // handleAsync 预解析意图（单次消费）
  const integrationService = new IntegrationService({
    convPort: { interpret: ({ actorId, intent, now }) => {
      if (_preInterpreted) {
        const r = _preInterpreted;
        _preInterpreted = null;
        return toConvResult(r, intent);
      }
      return toConvResult(modelApi.interpretSync(intent, { actorId }), intent);
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

    /**
     * 同步编排入口（sync 契约）：走厂商 interpretSync。
     * real 模式厂商未提供 interpretSync → 显式报错（不静默降级为 query——审计修复 P0-2）。
     */
    handle({ actorId, from, intent, now }) {
      if (mode === 'real' && !syncCapable) {
        throw new Error('compose(real): 当前模型厂商无同步通道——请用 handleAsync（async 模型）');
      }
      return integrationService.handle({ actorId, from, intent, now });
    },

    /**
     * 异步编排入口：先 await 真实模型（interpret），再以预解析意图驱动同一 sync 编排管线。
     * 真实部署主通道（Cohere HTTP）；模型失败经 model-api 降级（confidence=0 走审核，INV-M2）。
     */
    async handleAsync({ actorId, from, intent, now }) {
      const r = await modelApi.interpret(intent, { actorId });
      _preInterpreted = r;
      try {
        return integrationService.handle({ actorId, from, intent, now });
      } finally {
        _preInterpreted = null; // 防泄漏（异常时也不残留）
      }
    },

    /**
     * 运行时执行链（审计修复 P1-1：exec 适配器接入运行时）：
     * 对 running 作业调 SSH 适配器执行，结果驱动 completeJob/failJob（ADAPTER-CONTRACTS §2 替换条件落地）。
     * 命令模板映射：capability → COMMAND_TEMPLATES（对齐 M4 TEMPLATE_BY_CAPABILITY 单值映射）。
     * @returns { status: 'OK'|'ERROR'|'SKIPPED', reason?, job? }
     */
    async runJob({ jobId, now = timeSource() }) {
      const job = jobRepo.findById(jobId);
      if (!job) return { status: 'ERROR', reason: 'job_not_found' };
      if (job.status !== 'running') return { status: 'SKIPPED', reason: 'not_running', jobStatus: job.status };
      // capability → 命令模板（单源映射：对齐 M4 TEMPLATE_BY_CAPABILITY）
      const cmdTemplate = CAPABILITY_TO_COMMAND[job.template];
      if (!cmdTemplate) {
        const f = execService.failJob({ jobId, reason: 'unsupported_template', now });
        return { status: 'ERROR', reason: 'unsupported_template', job: f.job };
      }
      // 参数映射：M4 job.params（command/path 等）→ SSH 适配器参数（command 键去掉，按模板取语义参数）
      const adapterParams = {};
      if (cmdTemplate === 'restart_service' && job.params.command) adapterParams.service = job.target;
      if (cmdTemplate === 'clean_logs' && job.params.path) adapterParams.path = job.params.path;
      const res = await execAdapter.execute(job.target, cmdTemplate, adapterParams);
      if (res.ok) {
        const done = execService.completeJob({ jobId, result: res.result, now });
        return { status: done.status, job: done.job };
      }
      const failed = execService.failJob({ jobId, reason: res.reason || 'execution_failed', now });
      return { status: 'ERROR', reason: res.reason, job: failed.job };
    },
  };
}

module.exports = { compose };
