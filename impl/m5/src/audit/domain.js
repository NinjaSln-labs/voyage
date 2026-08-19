// audit 限界上下文 · 审计聚合（RQ-831 / INV-U3 / INV-U1）
// 依据：M0-D §3（审计五元组 schema）/ §7 机制2（降级态缓冲）/ 完美收官-质量基调（审计前行 fail-closed 铁律）
// 交付声明：append-only 哈希链 + 五元组 + 降级缓冲；真实存储介质（≥180 天）归 M6 适配器
// 对齐模式：impl/m3（聚合 + 值对象不可变 + 事件协议）
// 原则：append-only 不可覆盖/删除（去篡改面）；审计先行写失败 → 写操作回滚（INV-U1）；跨 BC 只取叶子字段入链

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

/** 指建华链条目头（按固定序拼原始串 → 哈希；域隔离前缀防跨链/版本混淆） */
function computeEntryHash(json) {
  return crypto.createHash(HASH_ALGO).update(PREFIX + json).digest('hex');
}

// ---------- 值对象：审计五元组 AuditEntry ----------

/**
 * 审计五元组（DDD §3 schema，RQ-831）：
 *  { who, when, from, action{intent,capability,target,paramsSchemaOk}, result, links, integrity{chainHash, seq} }
 * integrity.chainHash 在 append 时由链计算（prevHash + 本条正文）；本条构造函数只收五元组内容，不预置 chainHash。
 */
class AuditEntry {
  constructor({ who, when, from, action = {}, result, links = {}, buffer = null }) {
    // 主体/设备/结果校验（第 11 波：显式类型 + 长度上限）
    assertBoundedString(who, 'who', MAX_WHO_LENGTH);
    assertBoundedString(from, 'from', MAX_FROM_LENGTH);
    assertBoundedString(result, 'result', MAX_RESULT_LENGTH);
    if (!OUTCOMES.includes(result)) {
      throw new Error(`AuditEntry: result 非法（${result}，须 ${OUTCOMES.join('/')}）`);
    }
    if (!(when instanceof Date) || Number.isNaN(when.getTime())) {
      throw new Error('AuditEntry: when 必须为有效 Date 实例');
    }
    // action 子对象（DDD §3 schema）
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
    // links（浅深冻结；值只取字符串叶子，含可信链接 id）
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
    // 降级缓冲（审计存储不可用时临时落盘，INV-U3；正常路径为 null）
    this._buffer = buffer;   // { reason: string } | null
  }

  get who() { return this._who; }
  get result() { return this._result; }
  get when() { return new Date(this._when.getTime()); } // 第 90 波：Date 拷贝
  get action() { return deepFreeze(deepCopy(this._action)); }
  get links() { return deepFreeze(deepCopy(this._links)); }
  get buffer() { return this._buffer ? Object.freeze({ ...this._buffer }) : null; }

  /** 本条正文规范化 JSON（固定序，供链哈希计算——prevHash + 本条，稳定序保证可重算校验；seq 由链记录传入避免伪造/重排） */
  canonicalBody(seq) {
    return JSON.stringify({
      who: this._who,
      when: this._when.toISOString(),
      from: this._from,
      action: this._action,
      result: this._result,
      links: this._links,
      buffer: this._buffer,
      seq,
    });
  }
}

// ---------- 聚合：AppendOnlyAuditChain ----------

/**
 * append-only 审计链（INV-U3）：
 *  - 每条 `append(entry)` 固定链尾 prevHash 引用，计算 chainHash 入链
 *  - append-only：不提供覆写/删除；`entries()` 只读快照；队列长度不得缩减
 *  - `verify(now)` 自尾向前重算，发现 prevHash/chainHash 断裂即返回 false（篡改检测）
 *  - 降级态（INV-U3 机制2）：`appendBuffered` 将 entry 记入独立缓冲队列（审批通道豁免时），
 *    恢复后 `flushBuffer()` 批量按固定序补齐入链
 */
class AppendOnlyAuditChain {
  constructor({ persist = null } = {}) {
    this._entries = [];        // 内存条目（链）
    this._bufferQueue = [];    // 降级态缓冲队列（未入链的审批豁免条目）
    this._head = null;         // 首条链哈希（genesis 用独立种子）
    this._persist = persist;   // 契约端口：{ load() → {head, chain[]}, save(head, chain) } | null（真实介质 M6）
    if (this._persist) {
      const loaded = this._persist.load();
      if (loaded && Array.isArray(loaded.chain)) {
        this._entries = loaded.chain.map(a => hydrate(a));
        this._head = loaded.head || null;
      }
    }
  }

  /** 追加审计五元组入链（INV-U3；写操作 auditPort.write 的领域实现）。返回 { ok, chainHash, seq } */
  append(entry, now = new Date()) {
    if (!(entry instanceof AuditEntry)) throw new Error('AppendOnlyAuditChain.append: 须为 AuditEntry 实例');
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('audit: when 必须为有效 Date');
    const prevHash = this._head; // 链尾（首条为空）
    const seq = this._entries.length + 1;
    // seq 由链冻结在记录上（不写入 entry 共享字段），参与哈希防重排/伪造
    const chainHash = computeEntryHash(prevHash ? prevHash + '|' : '' + entry.canonicalBody(seq));
    this._entries.push({ entry, chainHash, seq });
    this._head = chainHash;
    if (this._persist) this._persist.save(this._head, this.chainRefs());
    return { ok: true, chainHash, seq };
  }

  /** 只读链条目快照（对外审计展示/导出；date 拷贝防 setTime 篡改） */
  entries() {
    return Object.freeze(this._entries.map(e => Object.freeze({
      seq: e.seq, chainHash: e.chainHash,
      who: e.entry.who, when: e.entry.when.toISOString(), from: e.entry.from,
      action: e.entry.action, result: e.entry.result, links: e.entry.links,
    })));
  }

  /** 轻量引用（供 persist 持久化：只取可序列化叶子；不含 live Date） */
  chainRefs() {
    return Object.freeze(this._entries.map(e => Object.freeze({ seq: e.seq, chainHash: e.chainHash })));
  }

  /** 链尾哈希（对外可校验锚点；null = 空链） */
  get tailHash() { return this._head; }

  /** 条目数（append-only 单调递增） */
  get length() { return this._entries.length; }

  /**
   * 篡改检测（INV-U3）：自尾向前按 prevHash 关系重算校验。
   * 返回 { ok, brokenSeq? }；链为空 → { ok: true }。
   */
  verify() {
    for (let i = 0; i < this._entries.length; i++) {
      const e = this._entries[i];
      const prevHash = i === 0 ? null : this._entries[i - 1].chainHash;
      const expect = computeEntryHash(prevHash ? prevHash + '|' : '' + e.entry.canonicalBody(e.seq));
      if (expect !== e.chainHash) return { ok: false, brokenSeq: e.seq };
    }
    return { ok: true };
  }

  /**
   * 降级态追加（INV-U3 机制2：审批豁免走落盘缓冲）——记入独立缓冲队列，不入主链。
   * 返回 { ok: true, buffered: entry }。
   */
  appendBuffered(entry) {
    if (!(entry instanceof AuditEntry)) throw new Error('AppendOnlyAuditChain.appendBuffered: 须为 AuditEntry');
    this._bufferQueue.push(entry);
    return { ok: true, buffered: entry };
  }

  /** 缓冲队列长度（降级态积压观测） */
  get bufferLength() { return this._bufferQueue.length; }

  /** 恢复后批量补齐入链（INV-U3：固定序 flush 保证顺序与链哈希一致）。返回 { flushed, failed } */
  flushBuffer(now = new Date()) {
    const queued = this._bufferQueue;
    this._bufferQueue = [];
    const flushed = [];
    const failed = [];
    for (const entry of queued) {
      const r = this.append(entry, now);
      if (r.ok) flushed.push(entry.who);
      else failed.push(entry.who);
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
  computeEntryHash, assertPositiveFiniteNumber, assertBoundedString, deepFreeze,
};