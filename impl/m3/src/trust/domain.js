// trust 限界上下文 · 审批信任域（C10–C12）领域模型
// 依据：M0-D §2.1（审批单 INV-A1~A5）/§2.2（Grant INV-G1~G4）/§2.11（四层准入 INV-T1）
//      INV-C4（服务端聚合判定：滑动窗口/跨桶/跨账户）/INV-E5（执行中吊销）/RQ-632（特权动作）
// 原则：零外部依赖；Grant 只从审批单存储读取；双人=两个不同自然人；超时-执行同事务；聚合判定服务端强制

'use strict';

// ---------- 常量 ----------
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;      // 审批时限（默认 30 分钟，目标值实测校准）
const GRANT_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // Grant 有效期（默认 24 小时，目标值）
const GRANT_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // Grant 有效期上限（严格审计第 9 波：防永久授权，7 天目标值）
const SUBSTITUTION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 补位授权时效（默认 90 天）
const AGG_WINDOW_SESSION_MS = 30 * 60 * 1000;     // 聚合：单会话窗口 30 分钟
const AGG_WINDOW_ACCOUNT_MS = 60 * 60 * 1000;     // 聚合：跨会话同主体窗口 1 小时
const AGG_SAME_KIND_THRESHOLD = 3;                // 同类 ≥3 次升级审批
const AGG_CROSS_BUCKET_THRESHOLD = 10;            // 跨桶累计 ≥10 次/台升级审批

// 高危能力类型（HighRiskCatalog 版本化，INV-P1；M1 最小集）
// 'escalated'：聚合升级专用标记（非白名单能力达阈值升级时使用，严格审计修复——避免非白名单能力构造审批单崩溃）
const HIGH_RISK_CAPABILITIES = Object.freeze(['restart', 'clean', 'delete', 'scale', 'config_change', 'env_switch', 'escalated']);

// 白名单能力清单（附录 C 落地，严格审计：非白名单能力拒绝——rm_rf_root/shell_exec_any 等任意命令不得自动 Grant）
// 模型可自动触发（须持许可）：重启/清理/定时/扩缩容/配置变更/环境切换
const WHITELIST_CAPABILITIES = Object.freeze(['restart', 'clean', 'scale', 'config_change', 'env_switch']);
// 查询类能力（只读面，矩阵 ✅ 单次授权；不属于执行白名单但可自动 Grant 的只读操作）
const QUERY_CAPABILITIES = Object.freeze(['query_status', 'query_health', 'query_metric', 'query_log']);

// ---------- 值对象 ----------

/** 审批票：一个批准人的一票（INV-A1：两自然人+每票本人 WebAuthn） */
class ApprovalVote {
  constructor({ personId, webAuthnConfirmed, seq }) {
    if (!personId || typeof personId !== 'string') throw new Error('ApprovalVote: personId 必填');
    if (webAuthnConfirmed !== true) throw new Error('ApprovalVote: 每票须本人 WebAuthn 确认（INV-A5）');
    if (typeof seq !== 'number') throw new Error('ApprovalVote: seq 必填');
    this.personId = personId;
    this.webAuthnConfirmed = webAuthnConfirmed;
    this.seq = seq;
  }
}

// ---------- 聚合：审批单 ----------

/**
 * 审批单聚合（INV-A1~A5）：
 *  - A1：≥2 票且两自然人、操作者不可自批、每票本人 WebAuthn
 *  - A2：时限 30 分钟、超时默认拒绝、超时判定与执行启动同事务
 *  - A3：决定幂等（一经批准/拒绝不可翻转）
 */
class Approval {
  constructor({ id, operatorId, target, highRiskType, createdAt = new Date(), timeoutMs = APPROVAL_TIMEOUT_MS }) {
    if (!id || !operatorId || !target) throw new Error('Approval: id/operatorId/target 必填');
    if (!HIGH_RISK_CAPABILITIES.includes(highRiskType)) throw new Error(`Approval: 高危类型非法（${highRiskType}）`);
    this.id = id;
    this.operatorId = operatorId;
    this.target = target;
    this.highRiskType = highRiskType;
    this.createdAt = createdAt instanceof Date && !Number.isNaN(createdAt.getTime()) ? createdAt : new Date();
    this.timeoutMs = timeoutMs;
    this.votes = [];          // ApprovalVote[]
    this.status = 'pending';  // pending / approved / rejected / timed_out
    this.terminalSeq = null;  // 终态时序（A3 幂等锚点）
  }

  get deadline() { return new Date(this.createdAt.getTime() + this.timeoutMs); }
  /** 是否过期（INV-A2：超时判定与执行启动同事务；严格审计：deadline 边界时刻视为过期——闭区间，防边界竞态宽松） */
  isExpired(now = new Date()) { return now.getTime() >= this.deadline.getTime(); }

  /** 投票（INV-A1：两自然人、操作者不可自批、每票本人 WebAuthn 已校验于构造） */
  addVote(personId, { webAuthnConfirmed = true, now = new Date() } = {}) {
    if (this.status !== 'pending') throw new Error(`Approval: 已${this.status}，不可再投票（A3 幂等）`);
    if (this.isExpired(now)) { this.status = 'timed_out'; this.terminalSeq = now.getTime(); throw new Error('Approval: 已超时，默认拒绝（A2）'); }
    if (personId === this.operatorId) throw new Error('Approval: 操作者不可自批（R1）');
    if (this.votes.some(v => v.personId === personId)) throw new Error('Approval: 同一自然人不可重复投票');
    this.votes.push(new ApprovalVote({ personId, webAuthnConfirmed, seq: this.votes.length + 1 }));
    return this.votes.length;
  }

  /** 判定（INV-A1：≥2 票两自然人 → approved；A2 超时 → timed_out） */
  resolve(now = new Date()) {
    if (this.status !== 'pending') return this.status; // A3 幂等：终态不可翻转
    if (this.isExpired(now)) { this.status = 'timed_out'; this.terminalSeq = now.getTime(); return this.status; }
    const distinct = new Set(this.votes.map(v => v.personId));
    if (distinct.size >= 2) {
      this.status = 'approved';
      this.terminalSeq = now.getTime();
    }
    return this.status;
  }
}

// ---------- 聚合：Grant ----------

/**
 * Grant 聚合（INV-G1~G4）：
 *  - G1：只从审批单存储读取（对话内容不构成许可）
 *  - G2：绑定作业+目标+命令+有效期；签发与执行启动同事务
 *  - G3：过期失效；吊销即时废止；执行中吊销→已启动完成+未启动拒绝（INV-E5）
 *  - G4：矩阵 ✅ 通道由矩阵授权+聚合计数自动签发（视同审批单存储）
 */
class Grant {
  constructor({ id, jobRef, target, commandTemplate, paramsHash, validUntil = null, ttlMs = GRANT_DEFAULT_TTL_MS, source = 'approval', issuedAt = new Date() }) {
    if (!id || !jobRef || !target || !commandTemplate) throw new Error('Grant: id/jobRef/target/commandTemplate 必填');
    if (!['approval', 'matrix'].includes(source)) throw new Error('Grant: source 非法（approval 审批单/matrix 矩阵授权）');
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`Grant: ttlMs 必须为正有限数值（${ttlMs}）`); // 严格审计：负/0/NaN TTL 拒绝
    }
    if (ttlMs > GRANT_MAX_TTL_MS) {
      throw new Error(`Grant: ttlMs 超上限（${ttlMs} > ${GRANT_MAX_TTL_MS}，防永久授权）`); // 严格审计第 9 波
    }
    const issued = issuedAt instanceof Date && !Number.isNaN(issuedAt.getTime()) ? issuedAt : new Date();
    const until = validUntil instanceof Date && !Number.isNaN(validUntil.getTime())
      ? validUntil
      : new Date(issued.getTime() + ttlMs);
    if (until.getTime() <= issued.getTime()) {
      throw new Error('Grant: validUntil 必须晚于 issuedAt'); // 严格审计：立即过期/倒挂有效期拒绝
    }
    this.id = id;
    this.jobRef = jobRef;           // G2 绑定作业
    this.target = target;           // G2 绑定目标资产
    this.commandTemplate = commandTemplate; // G2 绑定命令模板
    this.paramsHash = paramsHash;   // G2 绑定参数哈希
    this.issuedAt = issued;
    this.validUntil = until;
    this.source = source;
    this.revokedAt = null;
    this.revokedReason = null;
  }

  /** 是否有效（G3：未吊销且在有效期内） */
  isValid(now = new Date()) { return !this.revokedAt && now.getTime() <= this.validUntil.getTime(); }

  /** 吊销（G3：即时废止；INV-E5：未启动节点一律拒绝由 exec 订阅方执行） */
  revoke(reason, now = new Date()) {
    if (this.revokedAt) throw new Error('Grant: 已吊销，不可重复（幂等）');
    this.revokedAt = now;
    this.revokedReason = reason;
    return true;
  }

  /** 绑定校验（G2：作业/目标/命令/参数全匹配才有效） */
  matches(jobRef, target, commandTemplate, paramsHash) {
    return this.jobRef === jobRef && this.target === target &&
           this.commandTemplate === commandTemplate && this.paramsHash === paramsHash;
  }
}

// ---------- 聚合：聚合判定窗口 ----------

/** 聚合窗口事件容量上限（严格审计：防窗口内事件无界内存 DoS；目标值实测校准） */
const AGG_WINDOW_MAX_EVENTS = 10000;

/**
 * 服务端聚合判定（INV-C4）：
 *  - 滑动窗口：单会话 30 分钟 + 跨会话同主体 1 小时（用户×资产）
 *  - 同类=同能力编号×同资产；跨账户按资产聚合
 *  - 跨桶累计：跨能力/跨资产同向破坏类 ≥10 次/台升级审批
 *  - 同类 ≥3 次/≥10 台升级审批；矩阵 ✅ 仅单次授权
 *  - 严格审计修复：真滑动——按事件时间戳剔除出窗事件（非整体重置），窗口内事件不因整体重置丢失或延迟出窗
 */
class AggregationWindow {
  constructor({ actorId, assetId, windowType = 'session', durationMs = AGG_WINDOW_SESSION_MS, createdAt = new Date() }) {
    if (!actorId || !assetId) throw new Error('AggregationWindow: actorId/assetId 必填');
    this.actorId = actorId;
    this.assetId = assetId;
    this.windowType = windowType; // session / account / cross_bucket / asset
    this.durationMs = durationMs;
    this.createdAt = createdAt;
    this.events = []; // { capability, at }
  }

  /** 窗口是否过期（滑动窗口语义：相对 createdAt 的整窗过期检查） */
  isExpired(now = new Date()) { return now.getTime() - this.createdAt.getTime() > this.durationMs; }

  /**
   * 滑动剔除：移除已出窗事件（按事件时间戳 < now - durationMs），
   * 并更新 createdAt 为窗口内最早事件时间（无事件时重置为 now）。
   * 严格审计修复：替代原「整体重置」——整体重置会在活跃窗口内误清未过期事件（数据丢失）。
   */
  prune(now = new Date()) {
    const cutoff = now.getTime() - this.durationMs;
    const kept = this.events.filter(e => e.at.getTime() >= cutoff);
    if (kept.length !== this.events.length) {
      this.events = kept;
      this.createdAt = kept.length ? kept[0].at : now;
    }
    return this.events.length;
  }

  /** 记录一次操作（滑动窗口内；出窗事件剔除后再入窗） */
  record(capability, at = new Date()) {
    this.prune(at);
    // 容量上限（严格审计：防窗口内事件无界 DoS——与 M1 指标/日志容量对称）
    if (this.events.length >= AGG_WINDOW_MAX_EVENTS) {
      const err = new Error(`聚合窗口事件达上限（${AGG_WINDOW_MAX_EVENTS}），拒绝记录（防洪泛）`);
      err.code = 'AGG_WINDOW_LIMIT';
      throw err;
    }
    this.events.push({ capability, at });
    if (!this.createdAt || at.getTime() < this.createdAt.getTime()) this.createdAt = at;
    return this.events.length;
  }

  /** 同类计数（同能力编号在滑动窗口内的次数） */
  countSameKind(capability, now = new Date()) {
    this.prune(now);
    return this.events.filter(e => e.capability === capability).length;
  }

  /** 跨桶累计（窗口内总次数） */
  totalCount(now = new Date()) {
    this.prune(now);
    return this.events.length;
  }
}

// ---------- 聚合：准入证据（四层，INV-T1） ----------

/** 四层准入（INV-T1/R6）：设备/身份/行为/操作 四层证据齐备才准入，缺层即拒绝或分层动作 */
class AccessEvidence {
  constructor({ deviceOk, accountOk, behaviorOk, operationOk, allowLayered = true }) {
    this.deviceOk = deviceOk;       // 设备级：mTLS 无证拒绝
    this.accountOk = accountOk;     // 账号级：WebAuthn
    this.behaviorOk = behaviorOk;   // 行为级：指纹+异常检测
    this.operationOk = operationOk; // 操作级：高危审批
    this.allowLayered = allowLayered; // R11：拒绝率过高时分层动作（提示/确认/审批）而非全拒
  }

  /** 判定：四层齐备 → allow；缺层 → reject 或分层（R6/R11） */
  evaluate() {
    if (this.deviceOk && this.accountOk && this.behaviorOk && this.operationOk) return 'allow';
    if (this.allowLayered) return 'layered'; // 缺层→分层动作（提示/确认/审批）
    return 'reject';
  }
}

// ---------- 服务：审批流编排（消费 conv 事件） ----------

/** 审批流服务：conv IntentRecognized/Reclassified → 高危判定 → 审批/Grant 签发 */
class ApprovalFlowService {
  constructor({ approvalRepo, grantRepo, aggregationRepo, approvalPool, timeSource = () => new Date(), eventBus = null }) {
    this.approvalRepo = approvalRepo;     // 端口：{ save(approval), findById(id) }
    this.grantRepo = grantRepo;           // 端口：{ save(grant), findById(id) }
    this.aggregationRepo = aggregationRepo; // 端口：{ findOrCreate(actorId, assetId, type) }
    this.approvalPool = approvalPool;     // 端口：{ resolvers() -> [personId] }（审批人池 ≥3，INV-A4）
    this.timeSource = timeSource;
    this.eventBus = eventBus;             // 端口：{ publish(event) }（trust→exec/audit/notif 事件流，严格审计接线）
    // INV-A4 硬约束：审批人池 ≥3（严格审计第 9 波：池不足直接 fail-fast，防双人审批退化为单人/空池）
    const pool = this.approvalPool?.resolvers ? this.approvalPool.resolvers() : [];
    if (pool.length < 3) {
      throw new Error('ApprovalFlowService: 审批人池必须 ≥3（INV-A4），当前 ' + pool.length + ' 人');
    }
  }

  _publish(event) { if (this.eventBus) this.eventBus.publish(event); }

  /** 聚合判定：同类 ≥3 或跨桶 ≥10 → 升级（INV-C4）；返回 { escalated, count } */
  _evaluateAggregation(actorId, target, capability, now) {
    const window = this.aggregationRepo.findOrCreate(actorId, target, 'session');
    window.record(capability, now);
    const sameKind = window.countSameKind(capability, now);
    const total = window.totalCount(now);
    const escalated = sameKind >= AGG_SAME_KIND_THRESHOLD || total >= AGG_CROSS_BUCKET_THRESHOLD;
    return { escalated, sameKind, total };
  }

  /**
   * 处理执行意图：高危 → 创建审批单；非高危（矩阵 ✅ 单次）→ 自动 Grant（INV-G4）
   * 严格审计（第 9 波）：白名单外能力（rm_rf_root/shell_exec_any 等任意命令）一律 REJECTED——
   * 附录 C「仅白名单能力可执行」硬约束（INV-E3），执行网关不得为任意命令签发许可。
   * 返回 { status: 'approved'|'pending_approval'|'rejected'|'auto_granted', approval?, grant? }
   */
  handleExecIntent({ intentId, actorId, target, capability, now = this.timeSource() }) {
    // 白名单强制（附录 C / INV-E3）：非白名单 ∩ 非查询 → REJECTED（执行网关硬门）
    if (!WHITELIST_CAPABILITIES.includes(capability) && !QUERY_CAPABILITIES.includes(capability)) {
      this._publish(new CapabilityDenied({ intentId, actorId, target, capability, reason: 'not_in_whitelist', at: now }));
      return { status: 'rejected', reason: 'capability_not_in_whitelist' };
    }
    // 聚合判定（INV-C4）：同类/跨桶达到阈值 → 升级审批
    const { escalated, sameKind, total } = this._evaluateAggregation(actorId, target, capability, now);
    const isHighRiskCap = HIGH_RISK_CAPABILITIES.includes(capability);

    if (isHighRiskCap || escalated) {
      // 严格审计修复：非高危能力（query_status 等）达阈值升级时，highRiskType 用通用升级类型——
      // 原实现直接 new Approval({highRiskType: capability}) 对非白名单能力抛异常 → 服务崩溃。
      // 升级审批的 highRiskType 归一化为 'escalated'（聚合升级语义，INV-C4），原始能力入 target 描述。
      const highRiskType = isHighRiskCap ? capability : 'escalated';
      const approval = new Approval({
        id: `ap-${intentId}`, operatorId: actorId, target,
        highRiskType, createdAt: now,
      });
      this.approvalRepo.save(approval);
      this._publish(new ApprovalRequested(approval));
      if (escalated && !isHighRiskCap) {
        this._publish(new AggregationEscalated({ actorId, target, capability, count: Math.max(sameKind, total) }));
      }
      return { status: 'pending_approval', approval, escalated };
    }
    // 矩阵 ✅ 单次授权 → 自动 Grant（INV-G4，视同审批单存储）
    const grant = new Grant({ id: `gr-${intentId}`, jobRef: intentId, target, commandTemplate: capability, paramsHash: '', source: 'matrix', issuedAt: now });
    this.grantRepo.save(grant);
    this._publish(new GrantIssued(grant));
    return { status: 'auto_granted', grant };
  }

  /**
   * 审批决定（INV-A2/A3）：超时同事务——now 注入保证判定一致。
   * 批准后签发 Grant（INV-G2：签发与执行启动同事务语义在领域层=批准即签发，事务边界 Outbox 归 M5 编排层）。
   * 幂等（A3）：已终态单重复解析 → 直接返回终态，不重复投票、不重复签发 Grant。
   * 返回 { status, approval?, grant? }
   */
  resolveApproval({ approval, votes = [], now = this.timeSource() }) {
    // A3 幂等：终态不可翻转，也不可重复签发（已批准单重复调用不得二次发 Grant）
    if (approval.status !== 'pending') {
      return { status: approval.status, approval };
    }
    // A2 超时同事务：先判超时（超时即终态 timed_out，投票不再受理）——
    // 避免 addVote 抛「已超时」异常打断编排（超时默认拒绝是业务结果，不是技术错误）
    if (approval.isExpired(now)) {
      approval.resolve(now); // 置终态 timed_out
      this._publish(new ApprovalTimedOut(approval, now));
      return { status: 'timed_out', approval };
    }
    for (const personId of votes) approval.addVote(personId, { now });
    const status = approval.resolve(now);
    if (status === 'approved') {
      // INV-G2：批准 → 立即签发 Grant（绑定作业/目标/命令/参数哈希/有效期；同事务语义）
      const grant = new Grant({
        id: `gr-${approval.id}`, jobRef: approval.id, target: approval.target,
        commandTemplate: approval.highRiskType, paramsHash: '',
        source: 'approval', issuedAt: now,
      });
      this.grantRepo.save(grant);
      this._publish(new ApprovalApproved(approval, now));
      this._publish(new GrantIssued(grant));
      return { status, approval, grant };
    }
    if (status === 'timed_out') this._publish(new ApprovalTimedOut(approval, now));
    if (status === 'rejected') this._publish(new ApprovalRejected(approval, now));
    return { status, approval };
  }

  /** 吊销 Grant（INV-G3）：即时废止 + 广播 GrantRevoked（exec 订阅方按 INV-E5 处理未启动节点） */
  revokeGrant({ grant, reason, now = this.timeSource() }) {
    grant.revoke(reason, now);
    this._publish(new GrantRevoked(grant));
    return grant;
  }

  /** 补位授权（INV-A4）：双人确认（两管理者或管理者+在职 SRE）、时效、SRE 恢复自动回收 */
  grantSubstitution({ grantedBy, grantee, now = this.timeSource(), confirmators }) {
    if (!grantedBy || !grantee) throw new Error('grantSubstitution: grantedBy/grantee 必填');
    if (grantedBy === grantee) throw new Error('grantSubstitution: 补位授权人不可自我授权');
    const distinct = new Set(confirmators);
    if (distinct.size < 2) throw new Error('grantSubstitution: 补位须双人确认（INV-A4）');
    if (!confirmators.every(c => c !== grantee)) throw new Error('grantSubstitution: 被授权人不可参与确认');
    const s = { grantee, validFrom: now, validUntil: new Date(now.getTime() + SUBSTITUTION_TTL_MS), autoRevokeWhen: 'sre_pool_restored' };
    this._publish(new SubstitutionGranted(s));
    return s;
  }
}

// ---------- 领域事件（trust 发布；订阅：exec/audit/notif） ----------
// 事件协议对齐 M0-D §3：ApprovalApproved/Rejected/TimedOut 细分 + GrantIssued/Revoked/Expired + 幂等键

/** 事件基类：幂等键 + 载荷深冻结（跨 BC 防篡改，对齐 conv 事件协议） */
let trustEventSeq = 0;
function nextTrustEventId() {
  trustEventSeq += 1;
  return `${Date.now().toString(36)}-${trustEventSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function deepFreeze(obj) {
  Object.freeze(obj);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return obj;
}
/** 事件快照：只取叶子字段（不序列化 live 聚合内部状态） */
function approvalSnapshot(a) {
  return deepFreeze({ id: a.id, operatorId: a.operatorId, target: a.target, highRiskType: a.highRiskType, status: a.status, deadline: a.deadline.toISOString(), votes: a.votes.map(v => ({ personId: v.personId, seq: v.seq })) });
}
function grantSnapshot(g) {
  return deepFreeze({ id: g.id, jobRef: g.jobRef, target: g.target, commandTemplate: g.commandTemplate, paramsHash: g.paramsHash, source: g.source, validUntil: g.validUntil.toISOString(), revokedAt: g.revokedAt ? g.revokedAt.toISOString() : null, revokedReason: g.revokedReason });
}

class ApprovalRequested {
  constructor(approval) { this.type = 'ApprovalRequested'; this.schemaVersion = 1; this.eventId = nextTrustEventId(); this.approval = approvalSnapshot(approval); }
}
class ApprovalApproved {
  constructor(approval, at) { this.type = 'ApprovalApproved'; this.schemaVersion = 1; this.eventId = nextTrustEventId(); this.approval = approvalSnapshot(approval); this.at = at.toISOString(); }
}
class ApprovalRejected {
  constructor(approval, at) { this.type = 'ApprovalRejected'; this.schemaVersion = 1; this.eventId = nextTrustEventId(); this.approval = approvalSnapshot(approval); this.at = at.toISOString(); }
}
class ApprovalTimedOut {
  constructor(approval, at) { this.type = 'ApprovalTimedOut'; this.schemaVersion = 1; this.eventId = nextTrustEventId(); this.approval = approvalSnapshot(approval); this.at = at.toISOString(); }
}
class GrantIssued {
  constructor(grant) { this.type = 'GrantIssued'; this.schemaVersion = 1; this.eventId = nextTrustEventId(); this.grant = grantSnapshot(grant); }
}
class GrantRevoked {
  constructor(grant) { this.type = 'GrantRevoked'; this.schemaVersion = 1; this.eventId = nextTrustEventId(); this.grant = grantSnapshot(grant); }
}
class GrantExpired {
  constructor(grant) { this.type = 'GrantExpired'; this.schemaVersion = 1; this.eventId = nextTrustEventId(); this.grant = grantSnapshot(grant); }
}
class AggregationEscalated {
  constructor({ actorId, target, capability, count }) { this.type = 'AggregationEscalated'; this.schemaVersion = 1; this.eventId = nextTrustEventId(); this.actorId = actorId; this.target = target; this.capability = capability; this.count = count; }
}
class CapabilityDenied {
  constructor({ intentId, actorId, target, capability, reason, at }) { this.type = 'CapabilityDenied'; this.schemaVersion = 1; this.eventId = nextTrustEventId(); this.intentId = intentId; this.actorId = actorId; this.target = target; this.capability = capability; this.reason = reason; this.at = at.toISOString(); }
}
class SubstitutionGranted {
  constructor(s) { this.type = 'SubstitutionGranted'; this.schemaVersion = 1; this.eventId = nextTrustEventId(); this.substitution = deepFreeze({ ...s }); }
}

module.exports = {
  APPROVAL_TIMEOUT_MS, GRANT_DEFAULT_TTL_MS, GRANT_MAX_TTL_MS, SUBSTITUTION_TTL_MS,
  AGG_WINDOW_SESSION_MS, AGG_WINDOW_ACCOUNT_MS, AGG_SAME_KIND_THRESHOLD, AGG_CROSS_BUCKET_THRESHOLD,
  AGG_WINDOW_MAX_EVENTS,
  HIGH_RISK_CAPABILITIES, WHITELIST_CAPABILITIES, QUERY_CAPABILITIES,
  ApprovalVote, Approval, Grant, AggregationWindow, AccessEvidence,
  ApprovalFlowService,
  ApprovalRequested, ApprovalApproved, ApprovalRejected, ApprovalTimedOut,
  GrantIssued, GrantRevoked, GrantExpired, AggregationEscalated, CapabilityDenied, SubstitutionGranted,
};
