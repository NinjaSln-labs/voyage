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
const { createAgensAdapter } = require('./model/agens-adapter.js');
const { createAuditRepo } = require('./audit/repo-memory.js');
const { createFilePersist } = require('./audit/persist-file.js');
const { AuditEntry } = require('./audit/domain.js');
const { CAPABILITY_TO_COMMAND } = require('./shared-capabilities.js');

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
 *  - model: { provider, registry, fallback } 模型（real 默认供应商 command-code；mock 需假模型）
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
  // audit 桥接（先于 SSH 装配——keyVault 使用审计依赖）：integration/M4 传五元组对象 → 包装为 AuditEntry
  //  （chain.append 须实例）；写失败抛错（M5 _audit catch → 上层 ERROR，INV-U1 fail-closed）
  const auditWrite = (fiveTuple) => {
    const entry = fiveTuple instanceof AuditEntry ? fiveTuple : new AuditEntry(fiveTuple);
    auditRepo.write(entry);
    return { ok: true };
  };

  // RQ-411 凭据使用审计：keyVault.resolve 包一层——每次凭据解析留痕（不记 Key 值，只记 target/时间/结果）
  const auditedKeyVaultPort = (exec.keyVaultPort && typeof exec.keyVaultPort.resolve === 'function')
    ? {
        resolve(target) {
          let conn = null;
          try { conn = exec.keyVaultPort.resolve(target); } catch (e) {
            try {
              auditWrite({
                who: 'system', when: timeSource(), from: 'keyVault.resolve',
                action: { intent: 'query', capability: 'credential_resolve', target, paramsSchemaOk: true },
                result: 'rejected', links: { target, error: e.message },
              });
            } catch (e2) { /* 审计失败不掩盖原始错误 */ }
            throw e;
          }
          try {
            auditWrite({
              who: 'system', when: timeSource(), from: 'keyVault.resolve',
              action: { intent: 'query', capability: 'credential_resolve', target, paramsSchemaOk: true },
              result: conn ? 'success' : 'rejected',
              links: { target },
            });
          } catch (e) { /* 审计失败不影响凭据解析本身 */ }
          return conn;
        },
      }
    : null;

  let execAdapter;
  if (mode === 'real') {
    if (!auditedKeyVaultPort) {
      throw new Error('compose(real): exec.keyVaultPort 必填（{ resolve(target) → {user,host,port,keyPath} }）');
    }
    execAdapter = createSshExecAdapter({ keyVaultPort: auditedKeyVaultPort, ...(exec.opts || {}) }); // 审计修复：注入带留痕的包装层（原直插裸 port）
  } else {
    execAdapter = createSshExecAdapterMemory();
  }

  // ---------- 4. 模型（供应商无关 + Cohere / 假模型） ----------
  let modelApi;
  let syncCapable = false; // real 模式：厂商是否有同步通道（决定 handle 是否可用）
  if (mode === 'real') {
    if (model.registry) {
      // 自定义注册表（本地规则引擎/其他厂商）：Key 非必需——real 冒烟可用本地引擎驱动真实 SSH/审计
      modelApi = createModelApi({ provider: model.provider, registry: model.registry, fallback: model.fallback });
      syncCapable = model.syncCapable === true;
    } else {
      if (!model.apiKey) throw new Error('compose(real): model.apiKey 必填（供应商 Key，经注入不落盘；或注入自定义 model.registry 走本地引擎）');
      const vendor = model.vendor || 'command-code'; // 供应商：'command-code'（默认）| 'agens'
      let adapter;
      let providerId;
      // 审计修复（部署实测）：free 档上游延迟可达 10-16s，逼近默认 15s 超时——timeoutMs 必须可配
      const timeoutMs = typeof model.timeoutMs === 'number' && Number.isFinite(model.timeoutMs) && model.timeoutMs > 0
        ? model.timeoutMs : undefined;
      if (vendor === 'agens') {
        adapter = createAgensAdapter({ apiKey: model.apiKey, model: model.modelName || 'agnes-2.0-flash', fetchImpl: model.fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });
        providerId = 'agens';
      } else {
        adapter = createCohereAdapter({ apiKey: model.apiKey, model: model.modelName || 'command-code', fetchImpl: model.fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });
        providerId = 'command-code';
      }
      modelApi = createModelApi({ provider: providerId, registry: { [providerId]: adapter }, fallback: model.fallback });
      syncCapable = false; // 云端 HTTP 为 async——handle 不可用，走 handleAsync
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

  // M4 exec：执行服务。
  // assetPort 用真实资产仓储；matrixPort 用身份仓储角色→能力投影（RQ-415 服务端强制）。
  // creator 解析（审计修复 R3 错配）：M4 start 调 isAllowed(template, target, role=undefined) 不带 jobId——
  // 组合根以「启动上下文」绑定：start 包装层先把 jobId→creator 存入 pending Map（键 target|template），
  // matrixPort 判定取该 Map（精确归属本次启动），判定后清除；Map 无命中 → fail-closed 拒绝。
  // 不再按 jobRepo 反查首个作业（终态/他人作业会错配身份）。
  const jobRepo = new InMemoryJobRepo();
  const eventBus = new InMemoryEventBus();
  const _pendingMatrixCtx = new Map(); // "target|template" → creator（本次启动的精确归属）
  const execService = new ExecutionService({
    jobRepo,
    trustPort: { checkGrant: (grantRef, target, template, paramsHash, now) => trustService.checkGrant(grantRef, target, template, paramsHash, now) },
    assetPort: { isActive: (t) => assetRepo.isActive(t) },
    matrixPort: {
      isAllowed(capability, target) {
        const key = `${target}|${capability}`;
        const creator = _pendingMatrixCtx.get(key);
        _pendingMatrixCtx.delete(key); // 单次消费（防残留跨请求错配）
        if (!creator) return false;    // 无启动上下文 → 拒绝（fail-closed）
        const ident = identityRepo.findById(creator);
        if (!ident || !ident.active) return false; // 身份不存在/停用 → 拒绝
        return ident.hasCapability(capability);   // 角色→能力投影判定（RQ-415）
      },
    },
    auditPort: { write: auditWrite },
    eventBus,
  });

  /** start 包装：注入「本次启动的 creator」上下文（矩阵判定按此归属，不反查 jobRepo）；
   *  finally 清残留（审计窄验证 N1：M4 早退路径——terminal/wrong_state/whitelist——不消费上下文，防陈旧 creator 跨请求错配） */
  const startWithContext = ({ jobId, now }) => {
    const job = jobRepo.findById(jobId);
    const key = job ? `${job.target}|${job.template}` : null;
    if (key) _pendingMatrixCtx.set(key, job.creator);
    try {
      return execService.start({ jobId, now });
    } finally {
      if (key) _pendingMatrixCtx.delete(key); // 单次消费语义兜底：M4 早退未消费也清除
    }
  };

  // M5 integration：编排层。
  // 同步契约桥接（审计修复 P0-2）：M5 IntegrationService.handle 为同步契约，真实模型 async 不能直插——
  // 组合根提供双入口：
  //   handle(text)      —— sync，走 interpretSync（real 模式须厂商提供 interpretSync，否则显式报错不静默降级）
  //   handleAsync(text) —— async，先 await 真实模型 interpret，再以预解析意图驱动同一 sync 编排管线

  /** 意图幂等键：intent 文本 + actorId（审计修复 R8：纯文本键会跨 actor 误判 duplicate） */
  const intentIdOf = (intent, actorId) => `int-${actorId}-${intent}`;

  // 能力默认参数补全（Agens 真实链发现：意图模型只回分类不回执行参数——M4 构造即校验会拒绝空 params）。
  // 安全边界（附录 C）：固定命令模板可安全补全；涉及破坏性目标的参数（clean 的 path）不静默补——
  //   留给 M4 schema 校验拒绝 → 编排层 REJECTED param_schema_rejected → 走确认流程（fail-closed 语义正确复用）。
  const CAPABILITY_DEFAULT_PARAMS = {
    restart: { command: 'restart_service' },
    scale: { command: 'scale_replicas', replicas: 1 },
    config_change: { command: 'change_config' },
    env_switch: { command: 'switch_env' },
    // clean 补固定命令模板（Agens 真实链复验产出：模型只回 {path}，缺 command 被 M4 模板白名单拒绝）——
    //   command 是白名单固定值可安全补全；path 仍不补：破坏性目标，缺省即拒绝转确认（不静默默认 /var/log/）
    clean: { command: 'clean_logs' },
  };

  const toConvResult = (r, intent, actorId) => {
    const id = intentIdOf(intent, actorId);
    if (!r || r.ok !== true) {
      return { intentType: 'query', capability: 'query_status', confidence: 0, intentId: id, subject: null, degraded: true };
    }
    let params = r.params && typeof r.params === 'object' ? { ...r.params } : {};
    // 目标补全（Agens 真实链复验产出：模型偶发漏填 subject——执行目标缺失会被信任层 invalid_params 拒绝）。
    // 安全边界：仅当 params.service 精确命中资产仓储的活跃资产才投影为 subject（校验过的同源值，非编造）；
    // 未命中保持 null 走原拒绝路径（fail-closed 不放宽）。
    let subject = r.subject || null;
    if (!subject && params.service && assetRepo.isActive(params.service)) {
      subject = params.service;
    }
    const defaults = CAPABILITY_DEFAULT_PARAMS[r.capability];
    if (defaults) {
      for (const [k, v] of Object.entries(defaults)) {
        if (params[k] === undefined) params[k] = v; // 只补缺失键，不覆盖模型产出
      }
    }
    return { intentType: r.intentType, capability: r.capability || 'query_status', confidence: r.confidence, intentId: id, subject, params };
  };

  // handleAsync 预解析意图队列（审计修复 R2：单槽在并发下会串包——A 消费到 B 的模型结果；
  //  FIFO + token 匹配双保险：每个 handleAsync 持独立 token，convPort 只消费队首且校验归属）
  const _preQueue = [];
  const integrationService = new IntegrationService({
    convPort: { interpret: ({ actorId, intent, now }) => {
      // 队列消费：仅当队首元素属于本次调用（token 由 handleAsync 入队时绑定 intent+actorId）
      const idx = _preQueue.findIndex(e => e.intent === intent && e.actorId === actorId);
      if (idx !== -1) {
        const [entry] = _preQueue.splice(idx, 1);
        return toConvResult(entry.result, intent, actorId);
      }
      return toConvResult(modelApi.interpretSync(intent, { actorId }), intent, actorId);
    } },
    trustPort: {
      handleExecIntent: (p) => trustService.handleExecIntent(p),
      resolveApproval: (p) => trustService.resolveApproval(p),
    },
    execPort: {
      createJob: (p) => execService.createJob(p),
      start: startWithContext, // 矩阵判定按本次启动的 creator 归属（审计修复 R3）
    },
    auditPort: { write: auditWrite },
    timeSource,
  });



  return {
    mode,
    services: { trust: trustService, exec: execService, integration: integrationService },
    adapters: { audit: auditRepo, identity: identityRepo, asset: assetRepo, exec: execAdapter, model: modelApi },

    /** 启动作业（带矩阵归属上下文——审计修复 R3；services.exec.start 是裸 M4 入口，测试/内部用） */
    execStart: startWithContext,

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
     * 并发安全：意图入 FIFO 队列（intent+actorId 绑定），convPort 按归属消费（审计修复 R2 串包漏洞）。
     */
    async handleAsync({ actorId, from, intent, now }) {
      const r = await modelApi.interpret(intent, { actorId });
      const entry = { actorId, intent, result: r };
      _preQueue.push(entry);
      try {
        return integrationService.handle({ actorId, from, intent, now });
      } finally {
        // 防泄漏：无论成功/异常，清掉本次入队元素（若未被消费）
        const i = _preQueue.indexOf(entry);
        if (i !== -1) _preQueue.splice(i, 1);
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
      // 参数映射（审计修复 R4 补全）：M4 job.params → SSH 适配器参数；缺必填参数 → failJob（不裸跑命令前缀）
      const p = job.params || {};
      const adapterParams = {};
      let missingParam = null;
      if (cmdTemplate === 'restart_service') {
        if (p.command === 'restart_service') adapterParams.service = job.target;
        else missingParam = 'command';
      } else if (cmdTemplate === 'clean_logs') {
        if (p.path) adapterParams.path = p.path; else missingParam = 'path';
      } else if (cmdTemplate === 'scale_replicas') {
        if (p.service) adapterParams.service = p.service;
        else adapterParams.service = job.target;
        if (p.replicas !== undefined) adapterParams.replicas = p.replicas;
        else missingParam = missingParam || 'replicas';
      } else if (cmdTemplate === 'change_config') {
        if (p.file) adapterParams.file = p.file; else missingParam = 'file';
        if (p.expr) adapterParams.expr = p.expr; else missingParam = missingParam || 'expr';
      } else if (cmdTemplate === 'switch_env') {
        if (p.compose_file) adapterParams.compose_file = p.compose_file; else missingParam = 'compose_file';
      }
      if (missingParam) {
        const f = execService.failJob({ jobId, reason: `missing_param:${missingParam}`, now });
        return { status: 'ERROR', reason: `missing_param:${missingParam}`, job: f.job };
      }
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
