// 应用编排层（application orchestration，非限界上下文）· 统一入口编排（DoD-B 统一入口 / M0-D §6 五步判定点服务端强制）
// 归属：M0-D §1「应用编排层」——横切 conv↔trust↔exec↔audit 的编排职责，不承载领域状态、不复制任何 BC 不变量
// 依据：M0-D §6（五步判定点）/ §7（时序铁律 + Outbox 事务边界）
//      RQ-623（跨 BC 事务边界）/ RQ-831（审计五元组）/ INV-U1（审计先行 fail-closed）/ INV-N2（关键告警不静默）
// 交付声明：编排层端口依赖注入（conv/trust/exec/audit），不跨目录 require M3/M4 源码——测试内建契约桩
// 对齐：M3 ApprovalFlowService（handleExecIntent/resolveApproval）+ M4 ExecutionService（createJob/start）
// 原则：不信任前端标志；五步判定点服务端强制；高危/白名单/自动审批判定单一来源=trust.handleExecIntent，不复制 HIGH_RISK 清单（防双源）

'use strict';

const { OutboxJournal } = require('./outbox.js');

// ---------- 常量 ----------

// ADR-002：安全决策由能力定义决定——RISK_LEVEL 为编排层分流的第一来源
const { RISK_LEVEL } = require('../shared-capabilities.js');

const MAX_INTENT_LENGTH = 4096;
const MAX_CONFIDENCE_REQUIRED = 0.8;
const MAX_HANDLED_INTENT_IDS = 10000;            // 幂等 Set 大小上限（防长会话内存无限增长）
// ADR-002：安全决策由能力定义决定，actionClass 用于分流（authorize 为预留，当前无实现路径）
const VALID_ACTION_CLASSES = Object.freeze(['read', 'write', 'egress', 'authorize']);

// ---------- 编排层统一入口 ----------

class IntegrationService {
  // convPort{interpret}, trustPort{handleExecIntent, resolveApproval}, execPort{createJob, start},
  // auditPort{write}, notifyPort{notify}, timeSource, outbox（可选；审批后 Outbox 驱动 exec 异步启动）
  constructor({ convPort, trustPort, execPort, auditPort, notifyPort = null, timeSource = () => new Date(), outbox = null, decomposePort = null }) {
    for (const [name, p] of Object.entries({ convPort, trustPort, execPort, auditPort })) {
      if (!p || typeof p !== 'object') throw new Error(`IntegrationService: 端口 ${name} 必须注入`);
    }
    this.convPort = convPort;
    this.trustPort = trustPort;
    this.execPort = execPort;
    this.auditPort = auditPort;
    this.notifyPort = notifyPort;
    this.timeSource = timeSource;
    this.outbox = outbox;
    this.decomposePort = decomposePort; // 可选 C2 拆解端口；null = 退化为单步执行（向后兼容）
    this._handledIntentIds = new Set();
    // 接线 Outbox 消费端（P0-2 修复）：GrantIssued 消息驱动 exec 启动——否则 deferred 路径作业永不启动
    if (this.outbox && !this.outbox.consumer) {
      const self = this;
      this.outbox.consumer = (event) => {
        if (event && event.type === 'GrantIssued' && event.grant) {
          // 第 31 波修复：用注入 timeSource 而非 new Date()——原硬编码真实时钟，与 grant 签发时钟不一致→误判 expired
          return self._launchFromGrant(event.grant, self.timeSource(), { creator: event.actorId, params: event.params });
        }
        return { status: 'OK' };
      };
    }
  }

  _now() { return this.timeSource(); }

  _validateInput({ actorId, from, intent }) {
    if (!actorId || typeof actorId !== 'string' || actorId.length > 128) return { ok: false, reason: 'invalid_actor' };
    if (!from || typeof from !== 'string' || from.length > 256) return { ok: false, reason: 'invalid_from' };
    if (!intent || typeof intent !== 'string' || intent.length === 0 || intent.length > MAX_INTENT_LENGTH) {
      return { ok: false, reason: 'invalid_intent' };
    }
    return { ok: true };
  }

  _audit(five) {
    try { const r = this.auditPort.write(five); return { ok: true, audit: r }; }
    catch (e) { return { ok: false, reason: e.message }; }
  }

  _auditInteract(actorId, from, now, act, result, links) {
    return this._audit({
      who: actorId, when: now, from,
      action: { intent: act.intent || 'execute', capability: act.capability, target: act.target, paramsSchemaOk: act.paramsSchemaOk === true },
      result, links: links || {},
    });
  }

  handle({ actorId, from, intent, now = this._now() }) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { status: 'ERROR', reason: 'invalid_time' };
    const vi = this._validateInput({ actorId, from, intent });
    if (!vi.ok) return { status: 'REJECTED', reason: vi.reason };

    // 1. 意图层（conv）
    let interp;
    try { interp = this.convPort.interpret({ actorId, intent, now }); }
    catch (e) { return { status: 'ERROR', reason: 'conv_interpret_failed' }; }
    if (!interp || typeof interp !== 'object' || (!interp.actionClass && !interp.intentType)) return { status: 'ERROR', reason: 'conv_port_malformed' };
    const { actionClass, capability, confidence, intentId, subject } = interp;
    // 向后兼容：从 actionClass 推导 intentType（无 actionClass 时回退模型原始 intentType）
    const intentType = actionClass ? (actionClass === 'read' ? 'query' : 'execute') : interp.intentType || 'execute';
    // ADR-002 收尾：actionClass 为主分流，intentType 为推导字段（后续全量迁移后可移除）
    if (actionClass && !VALID_ACTION_CLASSES.includes(actionClass)) {
      return { status: 'REJECTED', reason: 'invalid_action_class', needApproval: false, intentId };
    }

    if (intentId) {
      if (this._handledIntentIds.has(intentId)) return { status: 'OK', reason: 'duplicate_intent_idempotent', intentId };
      if (this._handledIntentIds.size >= MAX_HANDLED_INTENT_IDS) return { status: 'ERROR', reason: 'intent_capacity_exceeded' };
      this._handledIntentIds.add(intentId);
    }

    // 查询类（actionClass === 'read'，或向后兼容的 intentType === 'query'）
    if (actionClass === 'read' || intentType === 'query') {
      // 数据外传（egress 类）走信任预检，不在 query 分支放行——由下面的 execute 信任预检统一分流
      if (actionClass === 'egress') {
        // 向下走到 execute 信任预检逻辑
      } else {
        const a = this._auditInteract(actorId, from, now, { intent: 'query', capability: capability || 'query', target: subject, paramsSchemaOk: true }, 'success', {});
        if (!a.ok) return { status: 'ERROR', reason: 'audit_failed' };
        // 审计修复（入口初审补充）：透传 degraded——区分真实查询与「模型断连 confidence=0 兜底」（INV-M2 可观测性）
        return { status: 'OK', kind: 'query', needApproval: false, intentType, intentId, degraded: interp.degraded === true };
      }
    }

    // 执行类
    if (intentType !== 'execute') return { status: 'REJECTED', reason: 'non_execute_intent', needApproval: false, intentId };
    if (typeof confidence === 'number' && confidence < MAX_CONFIDENCE_REQUIRED) {
      return { status: 'NEED_REVIEW', reason: 'low_confidence', needApproval: true, intentId };
    }

    // ADR-002 判定点第 1 步：能力风险等级决定安全路径（RISK_LEVEL 为单源，不复制 trust HIGH_RISK 清单）
    if (capability && RISK_LEVEL[capability] === 'low') {
      // 低风险能力（如 query_* 误入执行路径）走自动放行，不经过信任预检
      const a = this._auditInteract(actorId, from, now, { intent: 'query', capability: capability || 'query', target: subject, paramsSchemaOk: true }, 'success', {});
      if (!a.ok) return { status: 'ERROR', reason: 'audit_failed' };
      return { status: 'OK', kind: 'query', needApproval: false, intentType, intentId, degraded: interp.degraded === true };
    }

    // 2+4 拆解前 + 审批链（单一来源：trust.handleExecIntent——仅 high/critical 风险能力经此）
    let trust;
    try { trust = this.trustPort.handleExecIntent({ intentId, actorId, target: subject, capability, params: interp.params || null, now }); }
    catch (e) { return { status: 'ERROR', reason: 'trust_handle_failed' }; }
    if (!trust || typeof trust !== 'object') return { status: 'ERROR', reason: 'trust_port_malformed' };

    if (trust.status === 'rejected') {
      return { status: 'REJECTED', reason: trust.reason || 'capability_not_in_whitelist', needApproval: false, intentId };
    }
    if (trust.status === 'pending_approval' || trust.escalated) {
      const a = this._auditInteract(actorId, from, now, { intent: 'execute', capability, target: subject, paramsSchemaOk: true }, 'approved',
        { approvalId: trust.approval ? trust.approval.id : undefined });
      if (!a.ok) return { status: 'ERROR', reason: 'audit_failed' };
      return { status: 'NEED_REVIEW', reason: trust.escalated ? 'aggregation_escalated' : 'pending_approval',
        needApproval: true, approval: trust.approval, grant: trust.grant || null, intentId, params: interp.params || {} }; // 第 29 波：返回 params 供 resolveApproval 透传（原丢失致审批→异步执行参数断链）
    }
    if (trust.status === 'auto_granted' && trust.grant) {
      // C2 拆解集成：信任预检通过后，若 decomposePort 存在则调用 decompose 将意图拆解为 DAG 子任务，
      // 对每个就绪节点创建 Job + 启动；decompose 失败（或无 decomposePort）时回退到单步执行。
      if (this.decomposePort) {
        try {
          const { task, nodes } = this.decomposePort.decompose({
            actionClass, capability, target: subject, params: interp.params || {},
            subject, trustPrechecked: true,
          });
          // 就绪节点：优先使用 decomposePort.getReadyNodes（与 TaskService 同语义），
          // 回退到手写过滤（兼容仅实现 decompose 的轻量端口）
          const readyNodes = typeof this.decomposePort.getReadyNodes === 'function'
            ? this.decomposePort.getReadyNodes(task)
            : task.nodes.filter(n => n.dependsOn.length === 0 && n.status === 'queued');
          let startedCount = 0;
          for (const node of readyNodes) {
            try {
              const job = this.execPort.createJob({
                id: `job-${intentId}-${node.id}`,
                creator: actorId, target: node.target,
                template: node.capability, params: node.params || {},
                grantRef: trust.grant.id,
              });
              const started = this.execPort.start({ jobId: job.id, now });
              if (started && started.status === 'OK') startedCount++;
            } catch (e) { /* 单节点失败不阻塞整体 */ }
          }
          return {
            status: 'OK', kind: 'execute',
            taskId: task.id, nodeCount: nodes.length, startedCount,
            grant: trust.grant, jobId: startedCount > 0 ? `job-${intentId}-${readyNodes[0].id}` : undefined,
            needApproval: false, intentId,
          };
        } catch (e) {
          // decompose 失败回退到单步执行（不阻断执行链），但记录异常供运维追溯
          console.error(`[IntegrationService] decompose 失败，回退到单步执行: ${e.message}`);
        }
      }
      // 原有单步执行逻辑（无 decomposePort，或 decompose 失败时）
      let job;
      try { job = this.execPort.createJob({ id: `job-${intentId}`, creator: actorId, target: subject, template: capability, params: interp.params || {}, grantRef: trust.grant.id }); }
      catch (e) { return { status: 'REJECTED', reason: 'param_schema_rejected', intentId }; }
      const started = this.execPort.start({ jobId: job.id, now });
      if (!started || typeof started !== 'object') return { status: 'ERROR', reason: 'exec_start_malformed' };
      if (started.status === 'ERROR') return { status: 'ERROR', reason: started.reason || 'audit_failed', intentId };
      if (started.status === 'REJECTED') return { status: 'REJECTED', reason: started.reason || 'exec_rejected', needApproval: false, intentId };
      return { status: 'OK', kind: 'execute', grant: trust.grant, jobId: job.id, needApproval: false, intentId };
    }
    return { status: 'REJECTED', reason: 'trust_unexpected', needApproval: false, intentId };
  }

  resolveApproval({ approval, votes = [], rejectBy = null, now = this._now(), actorId = approval && approval.operatorId, params = null }) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { status: 'ERROR', reason: 'invalid_time' };
    let res;
    try { res = this.trustPort.resolveApproval({ approval, votes, rejectBy, now }); }
    catch (e) { return { status: 'ERROR', reason: 'resolve_failed' }; }
    if (!res || typeof res !== 'object') return { status: 'ERROR', reason: 'resolve_port_malformed' };

    // ---- 审计先行（INV-U5：审批类写操作至少一次投递；审批决定本身须审计留痕）----
    const result = res.rejected ? 'rejected' : (res.timed_out ? 'rejected' : 'approved');
    const a = this._auditInteract(actorId || 'operator', 'ui', now,
      { intent: 'approve', capability: 'approval', target: approval && approval.id, paramsSchemaOk: true }, result,
      { approvalId: approval && approval.id, grantId: res.grant ? res.grant.id : undefined });
    if (!a.ok) return { status: 'ERROR', reason: 'audit_failed' };   // INV-U1：审批决定审计失败 → 不坠后续

    if (res.rejected || res.timed_out) return { status: 'REJECTED', reason: res.rejected ? 'rejected' : 'timed_out', approval };
    if (res.status === 'approved' && res.grant) {
      // 数据外传审批通过后，无系统内作业执行（egress 为授权凭证，非命令执行）
      if (res.grant.commandTemplate && (res.grant.commandTemplate === 'egress' || res.grant.commandTemplate.startsWith('egress_'))) {
        return { status: 'approved', grant: res.grant, approval, deferred: false };
      }
      if (this.outbox) {
        const ob = this.outbox.enqueue({ eventId: `grant-${res.grant.id}`, type: 'GrantIssued', grant: res.grant, actorId: actorId || res.grant.creator, params: params || res.grant.params, at: now });
        return { status: 'approved', grant: res.grant, approval, outboxId: ob.id, deferred: true };
      }
      const launched = this._launchFromGrant(res.grant, now, { creator: actorId || res.grant.creator, params: params || res.grant.params });
      return { status: launched.status === 'OK' ? 'approved' : 'REJECTED', grant: res.grant, approval, deferred: false, reason: launched.reason };
    }
    return { status: res.status, approval };
  }

  _launchFromGrant(grant, now, { creator = 'operator', params = null } = {}) {
    const jobId = `job-${grant.jobRef || grant.id}`;
    let job;
    try { job = this.execPort.createJob({ id: jobId, creator, target: grant.target, template: grant.commandTemplate, params: params || {}, grantRef: grant.id }); }
    catch (e) { return { status: 'REJECTED', reason: 'param_schema_rejected' }; }
    return this.execPort.start({ jobId: job.id, now });
  }
}

module.exports = { IntegrationService, MAX_CONFIDENCE_REQUIRED, MAX_INTENT_LENGTH, OutboxJournal };
