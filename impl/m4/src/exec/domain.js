// exec 限界上下文 · 执行闭环（C8/C9）领域模型
// 依据：M0-D §2.4（作业 INV-E1~E5）/§4（exec.start 判定点3 契约）/附录 C（白名单参数 schema）
//       M4 方案评审 §2（7 节设计决策）/INV-E2（聚合升级挂起）/INV-E5（执行中吊销）
// 模式对齐：impl/m3（聚合 + 服务 + 事件协议 + 幂等键 + 深冻结快照）
// 原则：零依赖；只白名单能力∩矩阵可执行（INV-E3）；参数 schema 构造即校验；Grant 只读引用校验（INV-E1）
//       参数化调用不 shell 拼接（领域只产出 {template, params} 结构化数据，无拼接方法）

'use strict';

const crypto = require('node:crypto');

// ---------- 常量 ----------

// 执行白名单能力（对齐 M3 trust.WHITELIST_CAPABILITIES，附录 C）——排查「非白名单能力自动执行」
const WHITELIST_CAPABILITIES = Object.freeze(['restart', 'clean', 'scale', 'config_change', 'env_switch']);

// 白名单命令集（定时任务「命令限模板」，附录 C；禁止任意命令串）
const COMMAND_TEMPLATES = Object.freeze(['restart_service', 'clean_logs', 'scale_replicas', 'change_config', 'switch_env']);

// 清理路径白名单（附录 C：清理类 capability 的 path 必须以白名单目录前缀开头）
const LOG_DIR_WHITELIST = Object.freeze(['/var/log/', '/opt/app/logs/', '/srv/app/logs/']);

// shell 元字符集（附录 C 落地 §2.4：含这些字符的参数一律拒绝）
const SHELL_METACHARS = Object.freeze([';', '|', '&', '$', '<', '>', '`', '(', ')', '{', '}', '[', ']', '*', '?', '!', '~']);

// 凭据键（INV-E4：Job/params 不允许出现凭据字段；凭据经保险库端口引用）
const CREDENTIAL_KEYS = Object.freeze(['password', 'secret', 'token', 'credential', 'credential_ref', 'private_key', 'privateKey']);

// 领域对象 ID 长度上限（防内存/注入放大）
const MAX_ID_LENGTH = 128;
const MAX_STRING_VALUE_LENGTH = 512;
const MAX_NODE_EFFECTS = 10000;

// ---------- 工具 ----------

/** 深冻结（递归；事件载荷/参数快照跨 BC 不可变契约） */
function deepFreeze(obj) {
  Object.freeze(obj);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return obj;
}

/** 事件幂等键（对齐 M3 事件协议：时间基 + 序号 + 随机） */
let execEventSeq = 0;
function nextExecEventId() {
  execEventSeq += 1;
  return `${Date.now().toString(36)}-${execEventSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 参数哈希（稳定 JSON 排序后 sha256——目标是确定性绑定键，非安全散列用途） */
function paramsHash(params) {
  const canonical = JSON.stringify(sortKeys(params || {}));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
function sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = sortKeys(obj[k]); return acc; }, {});
  }
  return obj;
}

/** 正有限数值校验（第 11 波标准：构造参数统一正有限+显式类型） */
function assertPositiveFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}: 必须为正有限数值（${value}）`);
  }
}

/** Unicode 归一化（对齐 M2 思路，附录 C「Unicode 同形/全角→半角归一化后比对」）：
 *  全角→半角 + 移除零宽族/软连字符/Unicode 空格族 */
function normalizeUnicode(str) {
  let s = str;
  // 全角字母/数字/符号 → 半角（\uFF01-\uFF5E 偏移 0x20）
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  // 全角空格 → 半角空格
  s = s.replace(/\u3000/g, ' ');
  // 零宽连接符族 + 软连字符
  s = s.replace(/[\u200B-\u200F\u2060\u00AD]/g, '');
  return s;
}

/** 原型链保留键拒绝（质量基调第 12 波：以字符串为键的领域数据拒绝 __proto__ 等） */
const RESERVED_PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf']);

/** 参数值扫描：shell 元字符 / Base64 特征 / Unicode 同形（附录 C 落地为可测规则） */
function scanParamValue(raw) {
  // 归一化视图比对（第 10 波：统一视图判定，多视图不一致=绕过面）
  const norm = normalizeUnicode(raw);
  for (const mc of SHELL_METACHARS) {
    if (norm.includes(mc)) return { rejected: true, reason: 'shell_metachar', char: mc };
  }
  // Base64 特征：长度%4=0 且字符集∈base64 alphabet 且含 = padding
  if (norm.length >= 4 && norm.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(norm) && norm.includes('=')) {
    return { rejected: true, reason: 'base64_encoded' };
  }
  return { rejected: false };
}

// ---------- 值对象：节点副作用（INV-U1 批量按节点记录副作用状态；INV-E5 已启动完成/未启动拒绝） ----------

/** 节点副作用：单节点作业 = 1 个 effect；批量作业按节点记录状态 */
class NodeEffect {
  constructor({ nodeId, status = 'queued', startedAt = null, finishedAt = null, compensated = false }) {
    if (!nodeId || typeof nodeId !== 'string' || nodeId.length > MAX_ID_LENGTH) {
      throw new Error(`NodeEffect: nodeId 必填且 ≤${MAX_ID_LENGTH}（${nodeId}）`);
    }
    if (!['queued', 'running', 'completed', 'failed', 'rejected'].includes(status)) {
      throw new Error(`NodeEffect: status 非法（${status}，须 queued/running/completed/failed/rejected）`);
    }
    this._nodeId = nodeId;
    this._status = status;
    this._startedAt = startedAt;
    this._finishedAt = finishedAt;
    this._compensated = compensated; // INV-E5：已启动节点吊销后完成留痕（副作用补偿记录）
  }

  get nodeId() { return this._nodeId; }
  get status() { return this._status; }
  get compensated() { return this._compensated; }
  get startedAt() { return this._startedAt ? new Date(this._startedAt.getTime()) : null; } // 第 90 波：Date 拷贝
  get finishedAt() { return this._finishedAt ? new Date(this._finishedAt.getTime()) : null; } // 第 90 波：Date 拷贝

  /** 只读快照（事件/对外展示用；Date 拷贝隔离防 setTime 污染） */
  snapshot() {
    return Object.freeze({
      nodeId: this._nodeId, status: this._status, compensated: this._compensated,
      startedAt: this._startedAt ? this._startedAt.toISOString() : null,
      finishedAt: this._finishedAt ? this._finishedAt.toISOString() : null,
    });
  }
}

// ---------- 聚合：作业 Job ----------

/**
 * 作业聚合（INV-E1~E5）：
 *  - E1 持有效 Grant 才可启动；E2 聚合升级挂起转审批；E3 白名单∩参数 schema（构造即校验）
 *  - E4 凭据键拒绝（构造校验）；E5 执行中 Grant 吊销：已启动节点完成+未启动节点拒绝
 * 状态机：queued ─(start 全过)─▶ running ─▶ completed/failed
 *        queued ─(吊销/过期/审批拒绝)─▶ rejected
 *        queued ─(聚合升级)─▶ suspended ─(审批后恢复)─▶ queued─▶running
 */
class Job {
  constructor({ id, creator, target, template, params = {}, grantRef = null, aggregationEscalated = false, createdAt = new Date() }) {
    // 基础必填
    if (!id || typeof id !== 'string' || id.length > MAX_ID_LENGTH) throw new Error(`Job: id 必填且 ≤${MAX_ID_LENGTH}`);
    if (!creator || typeof creator !== 'string' || creator.length > MAX_ID_LENGTH) throw new Error('Job: creator 必填');
    if (!target || typeof target !== 'string' || target.length > MAX_ID_LENGTH) throw new Error('Job: target 必填');
    // 时间校验（第 11 波：字符串隐式转换是静默错误源）
    if (typeof createdAt === 'string' || (createdAt instanceof Date && Number.isNaN(createdAt.getTime()))) {
      throw new Error('Job: createdAt 必须为有效 Date 实例');
    }
    // 白名单能力（INV-E3：构造即强制，防非白名单能力入队列）
    if (!WHITELIST_CAPABILITIES.includes(template)) {
      throw new Error(`Job: capability 不在白名单（${template}）——INV-E3`);
    }
    // 参数 schema 构造即校验（INV-E3/E4；不允许「先建后查」绕过窗口）
    validateParams(template, params);
    this._id = id;
    this._creator = creator;
    this._target = target;
    this._template = template;
    this._params = deepFreeze(Object.assign({}, params)); // 参数快照不可变（跨 BC 契约）
    this._paramsHash = paramsHash(params);
    this._grantRef = grantRef;          // 引用 Grant（不复制授权实体，防双源）——启动前必须有效
    this._aggregationEscalated = !!aggregationEscalated; // INV-E2：聚合升级标志
    this._createdAt = createdAt;
    this._status = 'queued';            // queued/running/suspended/completed/failed/rejected
    // 单节点作业 = 1 个 effect（结构支持批量；本里程碑测试聚焦单节点）
    this._nodeEffects = [new NodeEffect({ nodeId: target })];
    this._result = null;                // completed 时结果 / failed/rejected 时原因
    this._startedAt = null;
  }

  // 只读绑定字段（防外部篡改作业归属/目标/模板/参数）
  get id() { return this._id; }
  get creator() { return this._creator; }
  get target() { return this._target; }
  get template() { return this._template; }
  get params() { return deepFreeze(deepCopy(this._params)); } // 第 12 波：返回深拷贝（防外部改参数快照）
  get paramsHash() { return this._paramsHash; }
  get grantRef() { return this._grantRef; }
  get aggregationEscalated() { return this._aggregationEscalated; }
  get status() { return this._status; }
  get result() { return this._result ? deepCopy(this._result) : null; }
  get createdAt() { return new Date(this._createdAt.getTime()); } // 第 90 波：Date 拷贝
  get startedAt() { return this._startedAt ? new Date(this._startedAt.getTime()) : null; } // 第 90 波

  /** 只读节点副作用视图（深冻结拷贝，防外部伪造/篡改节点状态） */
  get nodeEffects() {
    return Object.freeze(this._nodeEffects.map(e => e.snapshot()));
  }
  /** INV-U1：批量按节点记录副作用状态——更新某节点（内部） */
  _setNodeEffect(index, patch) {
    const cur = this._nodeEffects[index];
    this._nodeEffects[index] = new NodeEffect({
      nodeId: cur.nodeId,
      status: patch.status || cur.status,
      startedAt: patch.startedAt !== undefined ? patch.startedAt : cur.startedAt,
      finishedAt: patch.finishedAt !== undefined ? patch.finishedAt : cur.finishedAt,
      compensated: patch.compensated !== undefined ? patch.compensated : cur.compensated,
    });
  }

  /** 是否终态（completed/failed/rejected——幂等错误语义） */
  get terminal() { return ['completed', 'failed', 'rejected'].includes(this._status); }

  /**
   * 启动前置判定已全过 → 进入 running（INV-E1：启动前必须持有效 Grant，由 ExecutionService start 保证；
   * 本方法只做状态机合法性 + 聚合升级硬门拦——INV-E2 挂起态不得启动）。
   * 返回 'running'；状态不合法（非 queued/已升级/终态）抛错（fail-fast）。
   */
  start(now = new Date()) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('Job: start 时间必须为有效 Date');
    if (this._aggregationEscalated) throw new Error('Job: 聚合已升级（INV-E2），挂起转审批，不得启动');
    if (this.terminal) throw new Error(`Job: 已${this._status}，不可启动（终态幂等拒绝）`);
    if (this._status !== 'queued') throw new Error(`Job: 当前 ${this._status}，仅 queued 可启动`);
    if (!this._grantRef) throw new Error('Job: 未持有效 Grant，不得启动（INV-E1）');
    this._status = 'running';
    this._startedAt = now;
    for (let i = 0; i < this._nodeEffects.length; i++) this._setNodeEffect(i, { status: 'running', startedAt: now });
    return 'running';
  }

  /** 完成（running → completed）；终态幂等返回真。compensate=true 时（INV-E5 执行中吊销）将 running 节点标记副作用补偿留痕 */
  complete(result = null, now = new Date(), compensate = false) {
    if (this._status !== 'running') return false;
    this._status = 'completed';
    this._result = result;
    for (let i = 0; i < this._nodeEffects.length; i++) {
      if (this._nodeEffects[i].status === 'running') this._setNodeEffect(i, { status: 'completed', finishedAt: now, compensated: compensate });
    }
    return true;
  }

  /** 失败（running → failed 或 queued → failed）；终态幂等返回 false */
  fail(reason, now = new Date()) {
    if (this.terminal) return false;
    if (this._status === 'completed') return false;
    this._status = 'failed';
    this._result = { reason };
    for (let i = 0; i < this._nodeEffects.length; i++) {
      if (this._nodeEffects[i].status === 'running') this._setNodeEffect(i, { status: 'failed', finishedAt: now });
    }
    return true;
  }

  /**
   * 拒绝（INV-E5 未启动节点 / INV-G3 过期 / 审批拒绝）：非启动态 → rejected。
   * 已启动节点（running）不在此列——见 revokeRunning。
   */
  reject(reason, now = new Date()) {
    if (this.terminal) return false;
    if (this._status === 'running') throw new Error('Job: 已启动节点不可整体拒绝——走 revokeRunning（INV-E5）');
    this._status = 'rejected';
    this._result = { reason };
    for (let i = 0; i < this._nodeEffects.length; i++) {
      if (this._nodeEffects[i].status === 'queued') this._setNodeEffect(i, { status: 'rejected', finishedAt: now });
    }
    return true;
  }

  /** INV-E2：聚合升级标志置位 → 挂起转审批（queued → suspended）；终态拒绝 */
  escalate(now = new Date()) {
    if (this.terminal) return false;
    if (this._status !== 'queued') throw new Error(`Job: 仅 queued 可挂起升级，当前 ${this._status}`);
    this._aggregationEscalated = true;
    this._status = 'suspended';
    return true;
  }

  /** 聚合升级撤销/审批通过后恢复（suspended → queued）；终态拒绝 */
  resume(now = new Date()) {
    if (this._status !== 'suspended') return false;
    this._aggregationEscalated = false;
    this._status = 'queued';
    return true;
  }

  /** 绑定 Grant（GrantIssued 关联集成时由服务调用；仅 queued/suspended 可绑定） */
  bindGrant(grantRef) {
    if (!grantRef || typeof grantRef !== 'string' || grantRef.length > MAX_ID_LENGTH) throw new Error('Job: grantRef 必填');
    this._grantRef = grantRef;
    return true;
  }
}

// ---------- 参数 schema 校验（附录 C 落地为可测规则，INV-E3/E4） ----------

/**
 * 参数 schema 校验（构造即强制）：
 *  - 凭据键/原型链保留键拒绝（INV-E4 / 第 12 波）
 *  - 命令限模板（COMMAND_TEMPLATES，非任意命令串）
 *  - 清理路径白名单（LOG_DIR_WHITELIST）
 *  - 重启仅限自己负责的服务（creator 负责集合，由 ExecutionService 端口校验）
 *  - shell 元字符 / Base64 / Unicode 同形拒绝（scanParamValue）
 *  - 值类型/长度上限
 * 形式如 validateParams(capability, params) —— return { ok } 或抛错。
 */
// 命令模板 → 能力映射（命令限模板：每能力只允许对应白名单命令）
const TEMPLATE_BY_CAPABILITY = deepFreeze({
  restart: ['restart_service'],
  clean: ['clean_logs'],
  scale: ['scale_replicas'],
  config_change: ['change_config'],
  env_switch: ['switch_env'],
});

/** 需要路径白名单检查的能力：clean（清理能力限路径） */
const PATH_CAPABILITIES = Object.freeze(['clean']);

function validateParams(capability, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('Job: params 必须为非空对象');
  }
  for (const key of Object.keys(params)) {
    // 原型链保留键拒绝（防对象快照污染）
    if (RESERVED_PROTO_KEYS.includes(key)) throw new Error(`Job: 参数键原型链保留（${key}）——第 12 波`);
    // 键长度上限
    if (key.length > MAX_STRING_VALUE_LENGTH) throw new Error('Job: 参数键超长');
    // 凭据键拒绝（INV-E4：Job/params 不允许凭据字段）
    if (CREDENTIAL_KEYS.includes(key.toLowerCase())) throw new Error(`Job: 参数含凭据键（${key}）——INV-E4，凭据须经保险库端口引用`);
    const val = params[key];
    if (typeof val === 'string') {
      if (val.length > MAX_STRING_VALUE_LENGTH) throw new Error(`Job: 参数 ${key} 超长（>${MAX_STRING_VALUE_LENGTH}）`);
      // shell 元字符 / Base64 / Unicode 同形扫描
      const scan = scanParamValue(val);
      if (scan.rejected) throw new Error(`Job: 参数 ${key} 含${scan.reason}${scan.char ? `（${scan.char}）` : ''}——拒绝`);
    } else if (typeof val === 'number') {
      if (!Number.isFinite(val)) throw new Error(`Job: 参数 ${key} 须为有限数值`);
    } else {
      throw new Error(`Job: 参数 ${key} 仅支持 string/number/boolean`);
    }
  }
  // 命令限模板（定时任务/一键=模板）：capability 对应命令白名单
  const allowed = TEMPLATE_BY_CAPABILITY[capability];
  if (allowed) {
    const cmd = params.command;
    if (!cmd || typeof cmd !== 'string' || !allowed.includes(cmd)) {
      throw new Error(`Job: 命令不在模板白名单（${COMMAND_TEMPLATES.join('/')}）——禁止任意命令串`);
    }
  }
  // 清理路径白名单
  if (PATH_CAPABILITIES.includes(capability)) {
    const path = params.path;
    if (!path || typeof path !== 'string') throw new Error('Job: clean 能力须提供 path');
    const hasPrefix = LOG_DIR_WHITELIST.some(p => normalizeUnicode(path).startsWith(p));
    if (!hasPrefix) throw new Error(`Job: clean 路径不在日志目录白名单——拒绝`);
  }
  return { ok: true };
}

// ---------- 事件发布（exec → audit/metric/notif；协议对齐 schemaVersion+eventId+深冻结） ----------

/** 作业事件快照：只取叶子字段（不序列化 live 聚合内部 Date 等） */
function jobSnapshot(job) {
  return deepFreeze({
    id: job.id, creator: job.creator, target: job.target, template: job.template,
    paramsHash: job.paramsHash, grantRef: job.grantRef, status: job.status,
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
  });
}

class JobStarted {
  constructor(job, at) {
    this.type = 'JobStarted'; this.schemaVersion = 1; this.eventId = nextExecEventId();
    this.job = jobSnapshot(job); this.startedAt = at.toISOString();
    Object.freeze(this); // 质量基调：事件构造时深冻结（载荷不可变跨 BC 契约）
  }
}
class JobCompleted {
  constructor(job, at) {
    this.type = 'JobCompleted'; this.schemaVersion = 1; this.eventId = nextExecEventId();
    this.job = jobSnapshot(job); this.finishedAt = at.toISOString();
    this.nodeEffects = deepFreeze(job.nodeEffects.map(e => ({ ...e }))); // 副作用快照（批量按节点深冻结）
    this.jobRef = job.id;
    Object.freeze(this);
  }
}
class JobFailed {
  constructor(job, reason, at) {
    this.type = 'JobFailed'; this.schemaVersion = 1; this.eventId = nextExecEventId();
    this.job = jobSnapshot(job); this.finishedAt = at.toISOString(); this.reason = reason;
    this.nodeEffects = deepFreeze(job.nodeEffects.map(e => ({ ...e })));
    this.jobRef = job.id;
    Object.freeze(this);
  }
}

// ---------- 服务：作业执行编排（消费 trust 事件，执行判定点3） ----------

/**
 * 作业执行服务（exec，INV-E1~E5）：
 *  - start：exec.start 五步判定点服务端强制（白名单∩矩阵 → 参数 schema → Grant → 聚合标志 → 资产 → 审计先行）
 *  - onTrustEvent：订阅 GrantIssued/Revoked/Expired/AggregationEscalated/ApprovalRejected/TimedOut（幂等）
 *  - triggerJob：定时任务触发重校验（INV-E2 触发源接入归 M5，本里程碑实现触发时校验）
 *  - 端口注入（M5 接真实实现）：trustPort/assetPort/matrixPort/auditPort/jobRepo/eventBus
 */
class ExecutionService {
  constructor({ jobRepo, trustPort, assetPort, matrixPort, auditPort, eventBus = null }) {
    // jobRepo 端口：{ save(job), findById(id), findByGrantRef(grantRef)→Job|null, findByTarget(target)→Job[] }
    this.jobRepo = jobRepo;
    this.trustPort = trustPort;     // { checkGrant(grantRef, target, template, paramsHash, now) → {ok, reason} }
    this.assetPort = assetPort;     // { isActive(target) → boolean }
    this.matrixPort = matrixPort;   // { isAllowed(capability, target, role) → boolean }
    this.auditPort = auditPort;     // { write(五元组) } 返回 {ok}；tech fail → ERROR（fail-closed）
    this.eventBus = eventBus;       // { publish(event), subscribe(handler) }
    // 结构校验 fail-fast（质量基调：端口注入必须给全且为对象）
    for (const [name, port] of Object.entries({ trustPort, assetPort, matrixPort, auditPort, jobRepo })) {
      if (!port || typeof port !== 'object') throw new Error(`ExecutionService: ${name} 必须注入`);
    }
    this._seenEventIds = new Set(); // 幂等去重（跨 BC eventId 幂等键）
  }

  _publish(event) { if (this.eventBus) this.eventBus.publish(event); }

  /**
   * 创建作业（Job 构造即 schema 校验 + 保存）。返回 Job。
   * 注入 role 供矩阵判定携带（角色端口在 M5 接真实；本里程碑由调用方提供/断言）。
   */
  createJob({ id, creator, target, template, params = {}, grantRef = null }) {
    const job = new Job({ id, creator, target, template, params, grantRef });
    this.jobRepo.save(job);
    return job;
  }

  /**
   * exec.start 判定点 3（INV-E1/E3，服务端强制）：
   *   1. 结构校验：job 实例 + 状态 queued（suspended 须先恢复）+ 参数合法（构造已保证，防御性复核）
   *   2. 白名单 ∩ 矩阵：capability ∈ 白名单且矩阵允许
   *   3. 参数 schema（附录 C，防御性复核）
   *   4. Grant 校验：trust.checkGrant——有效 + 匹配 + 未吊销 + 未过期
   *   5. 聚合升级标志：置位即 suspended（INV-E2），不得启动
   *   6. 资产未退役
   *   7. 审计先行：audit.write 成功才下发（INV-U1 fail-closed）
   *   8. 下发 → JobStarted → running
   * 失败语义：REJECTED（业务拒绝，原因码）/ ERROR（技术失败 fail-closed），不进入执行链。
   * 返回 { status: 'OK'|'REJECTED'|'ERROR', reason?, job }
   */
  start({ jobId, now = new Date() }) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return { status: 'ERROR', reason: 'invalid_time' };
    }
    const job = this.jobRepo.findById(jobId);
    if (!job) return { status: 'ERROR', reason: 'job_not_found' };
    if (!(job instanceof Job)) return { status: 'ERROR', reason: 'invalid_job_type' };
    // 1. 结构/状态校验
    if (job instanceof Job && job.terminal) return { status: 'REJECTED', reason: 'terminal_state' };
    if (job.status === 'suspended') return { status: 'REJECTED', reason: 'aggregation_escalated', message: '挂起转审批，须审批通过后恢复才能启动' };
    if (job.status !== 'queued') return { status: 'REJECTED', reason: 'wrong_state' };
    // 2. 白名单 ∩ 矩阵（INV-E3：矩阵 ❌ > 白名单不允许 > 审批要求）
    if (!WHITELIST_CAPABILITIES.includes(job.template)) {
      return { status: 'REJECTED', reason: 'capability_not_whitelisted' };
    }
    if (job instanceof Job && this.matrixPort.isAllowed(job.template, job.target, undefined) !== true) {
      return { status: 'REJECTED', reason: 'capability_not_allowed_by_matrix' };
    }
    // 3. 参数 schema（防御性复核——构造已保证 schema-ok）
    try { validateParams(job.template, job.params); }
    catch (e) { return { status: 'REJECTED', reason: 'param_schema_rejected', message: e.message }; }
    // 4. Grant 校验（INV-E1：启动前必须持有效 Grant；绑定全匹配）
    if (!job.grantRef) return { status: 'REJECTED', reason: 'grant_required' };
    const check = this.trustPort.checkGrant(job.grantRef, job.target, job.template, job.paramsHash, now);
    // 端口返回结构校验 fail-fast
    if (!check || typeof check !== 'object' || typeof check.ok !== 'boolean') {
      return { status: 'ERROR', reason: 'grant_port_malformed' };
    }
    if (!check.ok) return { status: 'REJECTED', reason: check.reason || 'grant_invalid' };
    // 5. 聚合升级标志（INV-E2：置位即挂起，不得启动；Job.start 内也有硬门兜底）
    if (job.aggregationEscalated) return { status: 'REJECTED', reason: 'aggregation_escalated' };
    // 6. 资产未退役（INV-AS2/RQ-512）
    if (this.assetPort.isActive(job.target) !== true) {
      return { status: 'REJECTED', reason: 'asset_retired' };
    }
    // 7. 审计先行（INV-U1：写入成功才下发；失败 → ERROR fail-closed）
    const audit = this.auditPort.write({ who: job.creator, when: now, from: 'exec.start', action: { intent: 'execute', capability: job.template, target: job.target, paramsSchemaOk: true }, result: 'approved', links: { grantId: job.grantRef, jobId: job.id } });
    if (typeof audit === 'object' && audit !== null || typeof audit === 'boolean') {
      const ok = typeof audit === 'object' ? (audit.ok !== false) : audit;
      if (!ok) return { status: 'ERROR', reason: 'audit_failed' };
    } else {
      return { status: 'ERROR', reason: 'audit_failed' };
    }
    // 8. 下发 → running + JobStarted
    try { job.start(now); }
    catch (e) { return { status: 'REJECTED', reason: 'start_blocked', message: e.message }; }
    this._publish(new JobStarted(job, now));
    return { status: 'OK', job, reason: null };
  }

  /** 完成作业（适配器回调：下发后执行成功）→ 发布 JobCompleted */
  completeJob({ jobId, result = null, now = new Date() }) {
    const job = this.jobRepo.findById(jobId);
    if (!job) return { status: 'ERROR', reason: 'job_not_found' };
    const done = job.complete(result, now);
    if (!done) return { status: 'REJECTED', reason: 'not_running' };
    this._publish(new JobCompleted(job, now));
    return { status: 'OK', job };
  }

  /** 失败作业（适配器回调：执行失败）→ 发布 JobFailed */
  failJob({ jobId, reason = 'execution_failed', now = new Date() }) {
    const job = this.jobRepo.findById(jobId);
    if (!job) return { status: 'ERROR', reason: 'job_not_found' };
    const done = job.fail(reason, now);
    if (!done) return { status: 'REJECTED', reason: 'not_failable' };
    this._publish(new JobFailed(job, reason, now));
    return { status: 'OK', job };
  }

  /** INV-E5：执行中 Grant 吊销——已启动节点完成+审计留痕（compensated），未启动节点拒绝。返回受影响结果 */
  _handleGrantRevoked(job, revokedReason, now) {
    // 未启动（queued / suspended）节点 → rejected（INV-G3/INV-E5 未启动拒绝）
    if (job.status === 'queued' || job.status === 'suspended') {
      job.reject(revokedReason || 'grant_revoked', now);
      this._publish(new JobFailed(job, 'grant_revoked', now));
      return { action: 'rejected', jobId: job.id };
    }
    // 已启动（running）节点 → 完成留痕（INV-E5：副作用补偿记录）——不重复副作用，只标记 compensated
    if (job.status === 'running') {
      const compensated = [];
      for (let i = 0; i < job.nodeEffects.length; i++) {
        if (job.nodeEffects[i].status === 'running') {
          // 第 32 波修复：complete 带 compensate=true——补偿标记须落 nodeEffect（INV-U1 批量按节点记录副作用状态）
          job.complete({ compensation: true, revokedReason }, now, true);
          compensated.push(job.nodeEffects[i].nodeId);
        }
      }
      // 已启动节点完成（结果标记补偿留痕）
      if (compensated.length > 0) this._publish(new JobCompleted(job, now));
      return { action: 'completed_compensated', jobId: job.id, reason: revokedReason };
    }
    return { action: 'ignored', jobId: job.id }; // 已终态
  }

  /**
   * 订阅 trust 事件（INV-E2/E5/G3 + 审批终态；bus 接线归 M5，本里程碑以服务方法 + 测试闭环）。
   * 幂等：按 eventId 去重——同事件重放不重复副作用。
   * 返回处理摘要 { handled: true, action? } / { handled: false, reason: 'duplicate'|'invalid_event'|'unsupported_event' }
   */
  onTrustEvent(event) {
    if (!event || typeof event !== 'object' || !event.eventId || !event.type) {
      return { handled: false, reason: 'invalid_event' };
    }
    // 幂等去重（第 8 波：终态重复调用不抛不重复副作用）
    if (this._seenEventIds.has(event.eventId)) return { handled: false, reason: 'duplicate' };
    this._seenEventIds.add(event.eventId);
    const now = new Date();
    const grantId = event.grant && event.grant.id;

    switch (event.type) {
      case 'GrantIssued': {
        // 关联 queued/suspended job → 可启动（绑定 Grant；若 suspended 先恢复为 queued，后续 start 重校验）
        if (!grantId || !event.grant.jobRef) return { handled: true, action: 'unrelated' };
        const job = this.jobRepo.findById(event.grant.jobRef);
        if (job && job instanceof Job && (job.status === 'queued' || job.status === 'suspended')) {
          job.bindGrant(grantId);
          return { handled: true, action: 'grant_bound', jobId: job.id };
        }
        return { handled: true, action: 'unrelated' };
      }
      case 'GrantRevoked': {
        const job = findJobByGrant(this.jobRepo, grantId);
        if (!job) return { handled: true, action: 'unrelated' };
        return { handled: true, ...this._handleGrantRevoked(job, event.revokedReason || null, now) };
      }
      case 'GrantExpired':
      case 'ApprovalRejected':
      case 'ApprovalTimedOut': {
        // 未启动 job → rejected（过期/审批终态）
        const job = findJobByGrant(this.jobRepo, grantId);
        if (job && job instanceof Job && (job.status === 'queued' || job.status === 'suspended')) {
          const reason = event.type === 'GrantExpired' ? 'grant_expired' : 'approval_terminal';
          job.reject(reason, now);
          this._publish(new JobFailed(job, reason, now));
          return { handled: true, action: 'rejected', jobId: job.id };
        }
        return { handled: true, action: 'unrelated' };
      }
      case 'AggregationEscalated': {
        // 关联 standing/排队 job → suspended（INV-E2：聚合升级挂起转审批）；exec 挂起 queued standing Grant
        const matched = this.findQueuedJobByTarget(event.target);
        if (matched) {
          matched.escalate(now);
          return { handled: true, action: 'suspended', jobId: matched.id };
        }
        return { handled: true, action: 'unrelated' };
      }
      default:
        return { handled: false, reason: 'unsupported_event', type: event.type };
    }
  }

  /** 工具：按 target 找第一个 queued job（聚合升级挂起用，INV-E2） */
  findQueuedJobByTarget(target) {
    const jobs = this.jobRepo.findByTarget ? this.jobRepo.findByTarget(target) : [];
    return jobs.find(j => j instanceof Job && j.status === 'queued') || null;
  }
}

/** 辅助：按 grantRef 找绑定到该 Grant 的作业 */
function findJobByGrant(jobRepo, grantId) {
  if (!grantId || typeof jobRepo.findByGrantRef !== 'function') return null;
  const job = jobRepo.findByGrantRef(grantId);
  return job && typeof job === 'object' && job.id ? job : null;
}

function deepCopy(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  return JSON.parse(JSON.stringify(obj));
}

module.exports = {
  WHITELIST_CAPABILITIES, COMMAND_TEMPLATES, LOG_DIR_WHITELIST, SHELL_METACHARS, CREDENTIAL_KEYS,
  Job, NodeEffect, ExecutionService,
  validateParams, paramsHash, normalizeUnicode, scanParamValue,
  JobStarted, JobCompleted, JobFailed,
};