// trust 限界上下文 · 审批信任域（C10–C12）领域模型
// 依据：M0-D §2.1（审批单 INV-A1~A5）/§2.2（Grant INV-G1~G4）/§2.11（四层准入 INV-T1）
//      INV-C4（服务端聚合判定：滑动窗口/跨桶/跨账户）/INV-E5（执行中吊销）/RQ-632（特权动作）
// 原则：零外部依赖；Grant 只从审批单存储读取；双人=两个不同自然人；超时-执行同事务；聚合判定服务端强制

'use strict';

// ---------- 常量 ----------
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;      // 审批时限（默认 30 分钟，目标值实测校准）
const GRANT_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // Grant 有效期（默认 24 小时，目标值）
const SUBSTITUTION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 补位授权时效（默认 90 天）
const AGG_WINDOW_SESSION_MS = 30 * 60 * 1000;     // 聚合：单会话窗口 30 分钟
const AGG_WINDOW_ACCOUNT_MS = 60 * 60 * 1000;     // 聚合：跨会话同主体窗口 1 小时
const AGG_SAME_KIND_THRESHOLD = 3;                // 同类 ≥3 次升级审批
const AGG_CROSS_BUCKET_THRESHOLD = 10;            // 跨桶累计 ≥10 次/台升级审批

// 高危能力类型（HighRiskCatalog 版本化，INV-P1；M1 最小集）
const HIGH_RISK_CAPABILITIES = Object.freeze(['restart', 'clean', 'delete', 'scale', 'config_change', 'env_switch']);

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
  /** 是否过期（INV-A2：超时判定与执行启动同事务） */
  isExpired(now = new Date()) { return now.getTime() > this.deadline.getTime(); }

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
    this.id = id;
    this.jobRef = jobRef;           // G2 绑定作业
    this.target = target;           // G2 绑定目标资产
    this.commandTemplate = commandTemplate; // G2 绑定命令模板
    this.paramsHash = paramsHash;   // G2 绑定参数哈希
    this.issuedAt = issuedAt;
    this.validUntil = validUntil || new Date(issuedAt.getTime() + ttlMs);
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

/**
 * 服务端聚合判定（INV-C4）：
 *  - 滑动窗口：单会话 30 分钟 + 跨会话同主体 1 小时（用户×资产）
 *  - 同类=同能力编号×同资产；跨账户按资产聚合
 *  - 跨桶累计：跨能力/跨资产同向破坏类 ≥10 次/台升级审批
 *  - 同类 ≥3 次/≥10 台升级审批；矩阵 ✅ 仅单次授权
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

  /** 窗口是否过期（滑动窗口语义） */
  isExpired(now = new Date()) { return now.getTime() - this.createdAt.getTime() > this.durationMs; }

  /** 记录一次操作（滑动窗口内；过期窗口重置） */
  record(capability, at = new Date()) {
    if (this.isExpired(at)) { this.events = []; this.createdAt = at; }
    this.events.push({ capability, at });
    return this.events.length;
  }

  /** 同类计数（同能力编号在此窗口内的次数） */
  countSameKind(capability) { return this.events.filter(e => e.capability === capability).length; }

  /** 跨桶累计（窗口内总次数） */
  get totalCount() { return this.events.length; }
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
  constructor({ approvalRepo, grantRepo, aggregationRepo, approvalPool, timeSource = () => new Date() }) {
    this.approvalRepo = approvalRepo;     // 端口：{ save(approval), findById(id) }
    this.grantRepo = grantRepo;           // 端口：{ save(grant), findById(id) }
    this.aggregationRepo = aggregationRepo; // 端口：{ findOrCreate(actorId, assetId, type) }
    this.approvalPool = approvalPool;     // 端口：{ resolvers() -> [personId] }（审批人池 ≥3，INV-A4）
    this.timeSource = timeSource;
  }

  /**
   * 处理执行意图：高危 → 创建审批单；非高危（矩阵 ✅ 单次）→ 自动 Grant（INV-G4）
   * 返回 { status: 'approved'|'pending_approval'|'rejected'|'auto_granted', approval?, grant? }
   */
  handleExecIntent({ intentId, actorId, target, capability, now = this.timeSource() }) {
    // 聚合判定（INV-C4）：同类/跨桶达到阈值 → 升级审批
    const window = this.aggregationRepo.findOrCreate(actorId, target, 'session');
    window.record(capability, now);
    const escalated = window.countSameKind(capability) >= AGG_SAME_KIND_THRESHOLD ||
                      window.totalCount >= AGG_CROSS_BUCKET_THRESHOLD;

    if (HIGH_RISK_CAPABILITIES.includes(capability) || escalated) {
      const approval = new Approval({ id: `ap-${intentId}`, operatorId: actorId, target, highRiskType: capability, createdAt: now });
      this.approvalRepo.save(approval);
      return { status: 'pending_approval', approval };
    }
    // 矩阵 ✅ 单次授权 → 自动 Grant（INV-G4，视同审批单存储）
    const grant = new Grant({ id: `gr-${intentId}`, jobRef: intentId, target, commandTemplate: capability, paramsHash: '', source: 'matrix', issuedAt: now });
    this.grantRepo.save(grant);
    return { status: 'auto_granted', grant };
  }

  /** 补位授权（INV-A4）：双人确认（两管理者或管理者+在职 SRE）、时效、SRE 恢复自动回收 */
  grantSubstitution({ grantedBy, grantee, now = this.timeSource(), confirmators }) {
    if (!grantedBy || !grantee) throw new Error('grantSubstitution: grantedBy/grantee 必填');
    if (grantedBy === grantee) throw new Error('grantSubstitution: 补位授权人不可自我授权');
    const distinct = new Set(confirmators);
    if (distinct.size < 2) throw new Error('grantSubstitution: 补位须双人确认（INV-A4）');
    if (!confirmators.every(c => c !== grantee)) throw new Error('grantSubstitution: 被授权人不可参与确认');
    return { grantee, validFrom: now, validUntil: new Date(now.getTime() + SUBSTITUTION_TTL_MS), autoRevokeWhen: 'sre_pool_restored' };
  }
}

// ---------- 领域事件（trust 发布；订阅：exec/audit/notif） ----------

class ApprovalRequested { constructor(approval) { this.type = 'ApprovalRequested'; this.approval = approval; } }
class ApprovalResolved { constructor(approval) { this.type = 'ApprovalResolved'; this.approval = approval; } }
class GrantIssued { constructor(grant) { this.type = 'GrantIssued'; this.grant = grant; } }
class GrantRevoked { constructor(grant) { this.type = 'GrantRevoked'; this.grant = grant; } }
class AggregationEscalated { constructor({ actorId, target, capability, count }) { this.type = 'AggregationEscalated'; this.actorId = actorId; this.target = target; this.capability = capability; this.count = count; } }
class SubstitutionGranted { constructor(s) { this.type = 'SubstitutionGranted'; this.substitution = s; } }

module.exports = {
  APPROVAL_TIMEOUT_MS, GRANT_DEFAULT_TTL_MS, SUBSTITUTION_TTL_MS,
  AGG_WINDOW_SESSION_MS, AGG_WINDOW_ACCOUNT_MS, AGG_SAME_KIND_THRESHOLD, AGG_CROSS_BUCKET_THRESHOLD,
  HIGH_RISK_CAPABILITIES,
  ApprovalVote, Approval, Grant, AggregationWindow, AccessEvidence,
  ApprovalFlowService,
  ApprovalRequested, ApprovalResolved, GrantIssued, GrantRevoked, AggregationEscalated, SubstitutionGranted,
};
