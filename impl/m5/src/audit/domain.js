// audit 限界上下文 · 审计聚合（RQ-831 / INV-U1~U5 / DDD §3 审计五元组 + AuditWritten 事件）
// 依据：M0-D §2.7（审计聚合 INV-U1~U5）/ §3（审计五元组 schema + AuditWritten 事件）/ §7 机制2（降级缓冲）
//      完美收官-质量基调（审计先行 fail-closed 铁律 + 事件协议 schemaVersion+eventId+深冻结）
// 交付声明：append-only 哈希链 + 五元组 + 降级缓冲 + 北极星计数分离 + 查询缓冲背压 + 断裂告警/重建/事件登记；真实存储介质（≥180 天）归 M6 适配器
// 对齐模式：impl/m3（聚合 + 值对象不可变 + 事件协议 + 幂等键）
// 原则：
//   - append-only 不可覆盖/删除（INV-U2）；审计先行写失败 → 写操作回滚（INV-U1）
//   - 北极星计数最小事件与全量明细分离（INV-U4）
//   - 查询类缓冲：容量上限 + 溢出丢弃告警（INV-U4 背压语义）
//   - 断裂告警触发 INV-N2 关键告警（永不合并不限频不可静默）+ 分段重建 + 断裂事件登记（INV-U2）
//   - 事件至少一次投递：AuditWritten 以 seq 确定 eventId 幂等键（INV-U5）

'use strict';

const crypto = require('node:crypto');

// ---------- 常量（目标值声明，实测校准归 M0-T/M5 双态原则） ----------

const MAX_WHO_LENGTH = 128;            // 主体 ID 上限
const MAX_FROM_LENGTH = 256;           // 设备指纹上限
const MAX_INTENT_LENGTH = 128;         // 意图类型长度上限
const MAX_CAPABILITY_LENGTH = 128;
const MAX_TARGET_LENGTH = 128;
const MAX_LINK_LENGTH = 128;           // links 中 id 长度上限
const MAX_RESULT_LENGTH = 128;         // outcome 枚举/原因长度
const HASH_ALGO = 'sha256';
const PREFIX = 'V1:';                  // 哈希链前缀（防版本混淆 + 域隔离）

// 北极星计数种类（INV-U4：最小事件保序持久，与全量明细分离）
const POLAR_KINDS = Object.freeze(['intent', 'job']);   // 意图完成 / 作业执行成功
// 查询类缓冲容量上限（INV-U4 背压：容量上限 + 溢出丢弃告警，目标值）
const MAX_QUERY_BUFFER = 1000;
// 降级态缓冲容量上限（INV-U3：审批豁免走落盘缓冲；对齐 M3 AGG_WINDOW_MAX_EVENTS=10000 防无界内存 DoS；满则 fail-closed 审批记录不可静默丢）
const MAX_BUFFER_QUEUE = 10000;
// 断裂事件登记容量上限（INV-U2 登记观测用途；保留最近 MAX_BREACH_RECORDS 条环形覆盖——关键告警由 ChainIntegrityBreach 事件发出，登记不丢信息）
const MAX_BREACH_RECORDS = 100;

// 原型链保留键（第 12 波标准：links 的键名不允许 __proto__ 等）
const RESERVED_PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

// outcome 合法值（DDD §3 result: Outcome）
const OUTCOMES = Object.freeze(['success', 'rejected', 'approved', 'rolled_back', 'pending']);

// ---------- 工具 ----------

/** 正有限数值校验（第 11 波标准） */
function assertPositiveFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}: 必须为正有限数值（${value}）`);
  }
}

/** 受限字符串校验（非空 + 类型 + 长度上限） */
function assertBoundedString(value, label, maxLen) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLen) {
    throw new Error(`${label}: 必须为非空字符串且 ≤${maxLen}（${value}）`);
  }
}

/** 深冻结（audit 快照入链前不可变） */
function deepFreeze(obj) {
  Object.freeze(obj);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return obj;
}

/** 链条目头哈希（按固定序拼原始串 → 哈希；域隔离前缀防跨链/版本混淆） */
function computeEntryHash(json) {
  return crypto.createHash(HASH_ALGO).update(PREFIX + json).digest('hex');
}

/** 事件幂等键（对齐 M3 事件协议：时间基 + 序号 + 随机）——非确定性事件用 */
let auditEventSeq = 0;
function nextAuditEventId() {
  auditEventSeq += 1;
  return `${Date.now().toString(36)}-${auditEventSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- 值对象：审计五元组 AuditEntry ----------

/**
 * 审计五元组（DDD §3 schema，RQ-831）：
 *  { who, when, from, action{intent,capability,target,paramsSchemaOk}, result, links, integrity{chainHash, seq} }
 * integrity.chainHash 在 append 时由链计算；本条构造函数只收五元组内容，不预置 chainHash。
 */
class AuditEntry {
  constructor({ who, when, from, action = {}, result, links = {}, buffer = null }) {
    assertBoundedString(who, 'who', MAX_WHO_LENGTH);
    assertBoundedString(from, 'from', MAX_FROM_LENGTH);
    assertBoundedString(result, 'result', MAX_RESULT_LENGTH);
    if (!OUTCOMES.includes(result)) {
      throw new Error(`AuditEntry: result 非法（${result}，须 ${OUTCOMES.join('/')}）`);
    }
    if (!(when instanceof Date) || Number.isNaN(when.getTime())) {
      throw new Error('AuditEntry: when 必须为有效 Date 实例');
    }
    const intent = typeof action.intent === 'string' ? action.intent : '';
    const capability = typeof action.capability === 'string' ? action.capability : '';
    const target = typeof action.target === 'string' ? action.target : '';
    const paramsSchemaOk = action.paramsSchemaOk === true;
    if (intent.length > MAX_INTENT_LENGTH) throw new Error('AuditEntry: action.intent 超长');
    if (capability.length > MAX_CAPABILITY_LENGTH) throw new Error('AuditEntry: action.capability 超长');
    if (target.length > MAX_TARGET_LENGTH) throw new Error('AuditEntry: action.target 超长');
    this._who = who;
    this._when = when;
    this._from = from;
    this._action = deepFreeze({ intent, capability, target, paramsSchemaOk });
    this._result = result;
    const lk = {};
    for (const [k, v] of Object.entries(links || {})) {
      if (RESERVED_PROTO_KEYS.includes(k)) throw new Error(`AuditEntry: links 键名保留（${k}）——第 12 波`);
      if (v === null || v === undefined) continue;
      if (typeof v === 'string') {
        if (v.length > MAX_LINK_LENGTH) throw new Error(`AuditEntry: links.${k} 超长（>${MAX_LINK_LENGTH}）`);
        lk[k] = v;
      } else if (typeof v === 'boolean' || typeof v === 'number') {
        lk[k] = v;
      } else {
        throw new Error(`AuditEntry: links.${k} 仅支持 string/number/boolean`);
      }
    }
    this._links = deepFreeze(lk);
    this._buffer = buffer;   // { reason: string } | null（降级态）
  }

  get who() { return this._who; }
  get result() { return this._result; }
  get when() { return new Date(this._when.getTime()); } // 第 90 波：Date 拷贝
  get action() { return deepFreeze(deepCopy(this._action)); }
  get links() { return deepFreeze(deepCopy(this._links)); }
  get buffer() { return this._buffer ? Object.freeze({ ...this._buffer }) : null; }

  /** 本条正文规范化 JSON（固定序，供链哈希计算；seq 由链记录传入避免伪造/重排） */
  canonicalBody(seq) {
    return JSON.stringify({
      who: this._who, when: this._when.toISOString(), from: this._from,
      action: this._action, result: this._result, links: this._links, buffer: this._buffer, seq,
    });
  }
}

// ---------- 领域事件（audit 发布；协议对齐 schemaVersion+eventId+深冻结） ----------

/** AuditWritten（DDD §3：audit→metric；每入链一条发布；INV-U5 至少一次投递 = seq 确定 eventId 幂等键） */
class AuditWritten {
  constructor({ seq, who, when, action, result }) {
    this.type = 'AuditWritten';
    this.schemaVersion = 1;
    this.eventId = `auditw-${seq}`;   // 幂等键：同 seq 重投 → 消费端去重
    this.entry = deepFreeze({ seq, who, when: when.toISOString(), action: deepFreeze(deepCopy(action)), result });
    Object.freeze(this);
  }
}

/** ChainIntegrityBreach（INV-U2：断裂告警 → notif，INV-N2 关键告警永不合并不限频不可静默） */
class ChainIntegrityBreach {
  constructor({ brokenSeq, at }) {
    this.type = 'ChainIntegrityBreach';
    this.schemaVersion = 1;
    this.eventId = nextAuditEventId();
    this.brokenSeq = brokenSeq;
    this.at = at.toISOString();
    this.severity = 'critical';
    Object.freeze(this);
  }
}

/** QueryBufferOverflow（INV-U4：查询缓冲溢出丢弃告警） */
class QueryBufferOverflow {
  constructor({ dropped, at }) {
    this.type = 'QueryBufferOverflow';
    this.schemaVersion = 1;
    this.eventId = nextAuditEventId();
    this.dropped = dropped;
    this.at = at.toISOString();
    Object.freeze(this);
  }
}

// ---------- 聚合：AppendOnlyAuditChain ----------

/**
 * append-only 审计链（INV-U1~U5 聚合根）：
 *  - 详情链 append-only（INV-U2）：不覆写/删除；verify 重算校验
 *  - 北极星计数（INV-U4）：最小事件保序计数，与全量明细链分离
 *  - 查询类缓冲（INV-U4）：容量上限 MAX_QUERY_BUFFER，溢出丢弃 + QueryBufferOverflow 告警
 *  - 降级态缓冲（INV-U3）：appendBuffered/flushBuffer 审批豁免落盘重试
 *  - 断裂告警 + 分段重建 + 断裂登记（INV-U2）：verify 断裂 → ChainIntegrityBreach 事件 + 登记 + rebuildFrom
 *  - 事件发布（INV-U5）：AuditWritten 以 seq 幂等键 at-least-once 投递
 */
class AppendOnlyAuditChain {
  constructor({ persist = null, eventBus = null } = {}) {
    this._entries = [];        // 全量明细链
    this._bufferQueue = [];    // 降级态缓冲队列
    this._queryBuffer = [];    // 查询类缓冲（Inv-U4 背压）
    this._polarCounts = { intent: 0, job: 0 };  // 北极星计数（与明细链分离）
    this._breaches = [];       // 断裂事件登记
    this._head = null;
    this._persist = persist;   // 端口 { load(), save() } | null
    this._eventBus = eventBus; // 端口 { publish(event) } | null
    if (this._persist) {
      const loaded = this._persist.load();
      if (loaded && Array.isArray(loaded.chain)) {
        this._entries = loaded.chain.map(a => hydrate(a));
        this._head = loaded.head || null;
      }
    }
  }

  _publish(event) { if (this._eventBus) this._eventBus.publish(event); }

  /** 追加审计五元组入详情链（INV-U1/U2/U5）。返回 { ok, chainHash, seq } */
  append(entry, now = new Date()) {
    if (!(entry instanceof AuditEntry)) throw new Error('AppendOnlyAuditChain.append: 须为 AuditEntry 实例');
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('audit: when 必须为有效 Date');
    const prevHash = this._head;
    const seq = this._entries.length + 1;
    const chainHash = computeEntryHash(prevHash ? prevHash + '|' : '' + entry.canonicalBody(seq));
    this._entries.push({ entry, chainHash, seq });
    this._head = chainHash;
    if (this._persist) this._persist.save(this._head, this.chainRefs());
    // INV-U5：至少一次投递——AuditWritten 以 seq 确定 eventId（幂等键），重投消费端去重
    this._publish(new AuditWritten({ seq, who: entry.who, when: entry.when, action: entry.action, result: entry.result }));
    return { ok: true, chainHash, seq };
  }

  /** 只读链条目快照（date 拷贝防 setTime 篡改） */
  entries() {
    return Object.freeze(this._entries.map(e => Object.freeze({
      seq: e.seq, chainHash: e.chainHash,
      who: e.entry.who, when: e.entry.when.toISOString(), from: e.entry.from,
      action: e.entry.action, result: e.entry.result, links: e.entry.links,
    })));
  }

  /** 轻量引用（供 persist 持久化：只取可序列化叶子） */
  chainRefs() {
    return Object.freeze(this._entries.map(e => Object.freeze({ seq: e.seq, chainHash: e.chainHash })));
  }

  /** 链尾哈希 */
  get tailHash() { return this._head; }
  /** 详情链条目数 */
  get length() { return this._entries.length; }

  /**
   * 篡改检测（INV-U2）：自尾向前按 prevHash 关系重算。
   * 断裂时（INV-U2）：发布 ChainIntegrityBreach（INV-N2 关键告警）+ 登记断裂事件。
   * 返回 { ok, brokenSeq? }；链为空 → { ok: true }。
   */
  verify() {
    for (let i = 0; i < this._entries.length; i++) {
      const e = this._entries[i];
      const prevHash = i === 0 ? null : this._entries[i - 1].chainHash;
      const expect = computeEntryHash(prevHash ? prevHash + '|' : '' + e.entry.canonicalBody(e.seq));
      if (expect !== e.chainHash) {
        const at = new Date();
        const breach = new ChainIntegrityBreach({ brokenSeq: e.seq, at });
        // 断裂事件登记（环形保留最近 MAX_BREACH_RECORDS 条；INV-N2 关键告警由事件发布不静默）
        this._breaches.push({ seq: e.seq, at: at.toISOString() });
        if (this._breaches.length > MAX_BREACH_RECORDS) this._breaches.shift();
        this._publish(breach);
        return { ok: false, brokenSeq: e.seq };
      }
    }
    return { ok: true };
  }

  /** INV-U2 分段重建：自 brokenSeq 起重新计算后缀链哈希（保留前段 intact）。返回 { ok, rebuilt } */
  rebuildFrom(brokenSeq, now = new Date()) {
    if (!(Number.isInteger(brokenSeq) && brokenSeq >= 1 && brokenSeq <= this._entries.length)) {
      throw new Error(`AppendOnlyAuditChain.rebuildFrom: brokenSeq 越界（${brokenSeq}）`);
    }
    let prevHash = brokenSeq === 1 ? null : this._entries[brokenSeq - 2].chainHash;
    for (let i = brokenSeq - 1; i < this._entries.length; i++) {
      const e = this._entries[i];
      const newHash = computeEntryHash(prevHash ? prevHash + '|' : '' + e.entry.canonicalBody(e.seq));
      e.chainHash = newHash;
      prevHash = newHash;
    }
    this._head = this._entries.length ? this._entries[this._entries.length - 1].chainHash : null;
    if (this._persist) this._persist.save(this._head, this.chainRefs());
    return { ok: true, rebuilt: this._entries.length - brokenSeq + 1 };
  }

  /** 断裂事件登记只读快照 */
  get breaches() { return Object.freeze(this._breaches.map(b => Object.freeze({ ...b }))); }

  // ---------- INV-U4：北极星计数（与全量明细分离） ----------

  /** 北极星计数 +1（最小事件保序持久；kind ∈ {intent, job}）。返回 { ok, kind, count } */
  countPolar(kind, now = new Date()) {
    if (!POLAR_KINDS.includes(kind)) throw new Error(`AppendOnlyAuditChain.countPolar: kind 非法（${kind}，须 ${POLAR_KINDS.join('/')}）`);
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('audit: when 必须为有效 Date');
    this._polarCounts[kind] += 1;
    return { ok: true, kind, count: this._polarCounts[kind] };
  }

  /** 北极星计数只读快照（与明细链分离，供 metric.count 读北极星数） */
  metricCounts() {
    return Object.freeze({ ...this._polarCounts });
  }

  // ---------- INV-U4：查询类缓冲（容量上限 + 溢出丢弃告警） ----------

  /** 查询类审计入缓冲（不入详情链，读面降级不阻断可用性）；溢出丢弃 + QueryBufferOverflow 告警。返回 { ok, buffered, dropped } */
  bufferQuery(entry, now = new Date()) {
    if (!(entry instanceof AuditEntry)) throw new Error('AppendOnlyAuditChain.bufferQuery: 须为 AuditEntry');
    if (this._queryBuffer.length < MAX_QUERY_BUFFER) {
      this._queryBuffer.push(entry);
      return { ok: true, buffered: true, dropped: 0 };
    }
    // 溢出：丢弃 + 告警（INV-U4 背压语义；不阻断查询主路）
    this._publish(new QueryBufferOverflow({ dropped: 1, at: now }));
    return { ok: true, buffered: false, dropped: 1, reason: 'query_buffer_overflow' };
  }

  /** 查询缓冲长度（背压观测） */
  get queryBufferLength() { return this._queryBuffer.length; }

  /** 查询缓冲落地到详情链（批量固定序）。返回 { flushed, failed } */
  flushQueryBuffer(now = new Date()) {
    const queued = this._queryBuffer;
    this._queryBuffer = [];
    const flushed = [], failed = [];
    for (const entry of queued) {
      const r = this.append(entry, now);
      if (r.ok) flushed.push(entry.who); else failed.push(entry.who);
    }
    return { flushed, failed };
  }

  // ---------- INV-U3：降级态缓冲 ----------

  /** 降级态追加（审批豁免走落盘缓冲，不入主链）。返回 { ok, buffered }；满则 fail-closed（审批记录不可静默丢） */
  appendBuffered(entry) {
    if (!(entry instanceof AuditEntry)) throw new Error('AppendOnlyAuditChain.appendBuffered: 须为 AuditEntry');
    if (this._bufferQueue.length >= MAX_BUFFER_QUEUE) {
      return { ok: false, buffered: false, reason: 'buffer_queue_full' }; // INV-U3 对齐防无界：满则拒绝，上层须触发关键告警
    }
    this._bufferQueue.push(entry);
    return { ok: true, buffered: entry };
  }

  /** 降级缓冲队列长度 */
  get bufferLength() { return this._bufferQueue.length; }

  /** 恢复后批量补齐入链（INV-U3：固定序 flush）。返回 { flushed, failed } */
  flushBuffer(now = new Date()) {
    const queued = this._bufferQueue;
    this._bufferQueue = [];
    const flushed = [], failed = [];
    for (const entry of queued) {
      const r = this.append(entry, now);
      if (r.ok) flushed.push(entry.who); else failed.push(entry.who);
    }
    return { flushed, failed };
  }
}

function deepCopy(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  return JSON.parse(JSON.stringify(obj));
}

// 持久化 restread：从 {seq, chainHash, ...} 反建（真实介质 M6；构造测试用）
function hydrate(a) {
  return { seq: a.seq, chainHash: a.chainHash, entry: new AuditEntry(a.entry) };
}

module.exports = {
  OUTCOMES, AuditEntry, AppendOnlyAuditChain,
  AuditWritten, ChainIntegrityBreach, QueryBufferOverflow,
  POLAR_KINDS, MAX_QUERY_BUFFER, MAX_BUFFER_QUEUE, MAX_BREACH_RECORDS,
  computeEntryHash, assertPositiveFiniteNumber, assertBoundedString, deepFreeze,
};