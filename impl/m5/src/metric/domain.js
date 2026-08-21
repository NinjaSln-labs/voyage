// metric 限界上下文 · 北极星/反指标计数（DDD §1：metric BC「计数事件流、月读数」）
// 依据：M0-D §1（metric BC 职责）/ §4（metric.count(月) 接口）/ §3（AuditWritten audit→metric）
// 交付声明：订阅 AuditWritten 事件 → 北极星（意图完成/作业成功）+ 反指标（拒绝/回滚）月读数聚合
// 统一语言对齐：北极星 = 审计计数事件流（会话意图完成 + 作业执行成功），自然月（产品0-1计划 §7）

'use strict';

// ---------- 常量 ----------

const MAX_MONTH_LENGTH = 7;   // 自然月键 'YYYY-MM' 长度
// 反指标报警异常类别（DoD §1：AI 误执行/审批绕过/高危未走审批）

function deepFreeze(obj) {
  Object.freeze(obj);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return obj;
}

// ---------- 服务：MetricService（DDD §4 metric.count 接口实现） ----------

/**
 * 北极星/反指标月读数聚合（metric BC）：
 *  - 订阅 AuditWritten（audit→metric）：按 entry.when 的自然月归桶
 *  - 分类：北极星 intent（意图完成）+ job（执行成功）；反指标 rejected（拒绝）+ rolled_back（回滚）
 *  - count(month) → { northStar:{intent,job}, counters:{rejected,rolledBack} }（只读快照）
 */
class MetricService {
  constructor() {
    this._months = new Map();   // monthKey → { intent, job, rejected, rolledBack }
  }

  _monthKey(when) {
    const d = when instanceof Date ? when : new Date(when);
    if (Number.isNaN(d.getTime())) throw new Error('MetricService: when 必须为有效时间');
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  _bucket(monthKey) {
    if (!this._months.has(monthKey)) {
      this._months.set(monthKey, { intent: 0, job: 0, rejected: 0, rolledBack: 0 });
    }
    return this._months.get(monthKey);
  }

  /**
   * 消费 AuditWritten 事件（at-least-once：eventId 幂等去重——同 eventId 只计一次）。
   * 返回 { handled: true } / { handled: false, reason: 'duplicate'|'invalid' }
   */
  onAuditWritten(event) {
    if (!event || typeof event !== 'object' || !event.eventId || event.type !== 'AuditWritten') {
      return { handled: false, reason: 'invalid' };
    }
    if (this._seenEventIds === undefined) this._seenEventIds = new Set();
    if (this._seenEventIds.has(event.eventId)) return { handled: false, reason: 'duplicate' };
    this._seenEventIds.add(event.eventId);

    const entry = event.entry || {};
    const monthKey = this._monthKey(entry.when);
    const b = this._bucket(monthKey);
    const result = entry.result;
    const isExecute = entry.action && entry.action.intent === 'execute';
    if (result === 'success' && isExecute) b.job += 1;        // 北极星：作业执行成功
    else if (result === 'success') b.intent += 1;             // 北极星：意图完成（查询/知识）
    else if (result === 'rejected') b.rejected += 1;          // 反指标：业务拒绝
    else if (result === 'rolled_back') b.rolledBack += 1;     // 反指标：回滚
    return { handled: true };
  }

  /** 月读数（DDD §4 metric.count(月) → 读数）。返回只读快照 */
  count(month) {
    if (typeof month !== 'string' || month.length !== MAX_MONTH_LENGTH || !/^\d{4}-\d{2}$/.test(month)) {
      throw new Error(`MetricService.count: month 须为 'YYYY-MM'（${month}）`);
    }
    const b = this._months.get(month) || { intent: 0, job: 0, rejected: 0, rolledBack: 0 };
    return Object.freeze({ northStar: Object.freeze({ intent: b.intent, job: b.job }), counters: Object.freeze({ rejected: b.rejected, rolledBack: b.rolledBack }) });
  }

  /** 全部聚合月键（观测） */
  get months() { return Object.freeze([...this._months.keys()]); }
}

module.exports = { MetricService, MAX_MONTH_LENGTH };