// audit 数据层查询服务（ADR-006 阶段 2 余项 / t000037）：按范围（scope）收敛的审计查询
// 依据：ADR-006（数据层 self 过滤 + aggregate 聚合；INV-P4 全量闭合）、§4.2（audit_query=明细 / audit_summary=聚合）、AI评测策略（审计留痕）
// 边界：本层只做「授权 + 范围收敛 + 投影」，不做存储介质；条目来自 live 审计链（adapters.audit → AppendOnlyAuditChain）
// 安全模型：
//  - 授权取自身份投影（不可自报）：hasCapability('audit_query'|'audit_summary') + scopeOf 裁决
//  - self → 仅返回 who === actorId 的条目；full → 全部；aggregate → 仅统计（绝不下发明细行）
//  - 越权/无权一律 forbidden（不区分「无权」与「范围不符」，防探测）
//  - 元审计：每次查询（含越权尝试）经 INV-U4 查询类缓冲留痕（不入详情主链；留痕失败不阻断响应）

'use strict';

const { AuditEntry } = require('./domain.js');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 90;

/** 整数夹取（非法/缺省 → 默认值；越界 → 夹到边界） */
function clampInt(v, min, max, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n)) return null; // 非法（由调用方判 invalid_param）
  return Math.min(Math.max(n, min), max);
}

/**
 * 审计查询服务工厂
 * @param {object} opts
 *  - identityPort: { findById(id) → Identity{active, hasCapability, scopeOf} }
 *  - auditRepo: adapters.audit（含 entries() / bufferQuery()）
 *  - timeSource: () => Date
 */
function createAuditQueryService({ identityPort, auditRepo, timeSource = () => new Date() } = {}) {
  if (!identityPort || typeof identityPort.findById !== 'function') throw new Error('createAuditQueryService: identityPort 必填（findById）');
  if (!auditRepo || typeof auditRepo.entries !== 'function') throw new Error('createAuditQueryService: auditRepo 必填（entries）');

  /** 元审计：查询类走 INV-U4 缓冲（不入详情主链）；失败不阻断 */
  function metaAudit(actorId, capability, result, reason = null) {
    try {
      if (typeof auditRepo.bufferQuery !== 'function') return;
      const entry = new AuditEntry({
        who: actorId, when: timeSource(), from: 'audit-query',
        action: { intent: 'query', capability },
        result,
        links: reason ? { reason } : {},
      });
      auditRepo.bufferQuery(entry, timeSource());
    } catch (e) { /* 留痕失败不阻断响应（查询面可用性优先） */ }
  }

  /** 身份解析（端口异常 → 视为 forbidden，fail-closed） */
  function resolveIdentity(actorId) {
    try { return identityPort.findById(actorId); } catch (e) { return null; }
  }

  /**
   * 明细查询（audit_query）
   * @returns { ok:true, entries, nextBefore } | { ok:false, reason:'forbidden'|'invalid_param' }
   */
  function query({ actorId, limit, before } = {}) {
    const lim = clampInt(limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
    if (lim === null) { metaAudit(actorId, 'audit_query', 'rejected', 'invalid_param'); return { ok: false, reason: 'invalid_param' }; }
    if (before !== undefined && before !== null && before !== '') {
      const b = typeof before === 'number' ? before : Number(before);
      if (!Number.isInteger(b) || b < 1) { metaAudit(actorId, 'audit_query', 'rejected', 'invalid_param'); return { ok: false, reason: 'invalid_param' }; }
      before = b;
    } else { before = null; }

    const ident = resolveIdentity(actorId);
    if (!ident || ident.active !== true || typeof ident.hasCapability !== 'function' || !ident.hasCapability('audit_query')) {
      metaAudit(actorId, 'audit_query', 'rejected', 'forbidden');
      return { ok: false, reason: 'forbidden' };
    }
    const scope = typeof ident.scopeOf === 'function' ? ident.scopeOf('audit_query') : 'full';
    if (scope !== 'full' && scope !== 'self') { // aggregate/owned/related 不适用于明细查询
      metaAudit(actorId, 'audit_query', 'rejected', 'forbidden');
      return { ok: false, reason: 'forbidden' };
    }

    let list = auditRepo.entries();
    if (scope === 'self') list = list.filter(e => e.who === actorId); // 范围收敛：仅本人记录
    if (before !== null) list = list.filter(e => e.seq < before);
    list = [...list].sort((a, b) => b.seq - a.seq); // newest-first
    const page = list.slice(0, lim).map(e => ({
      seq: e.seq, who: e.who, when: e.when, from: e.from,
      action: e.action, result: e.result, links: e.links,
    }));
    const nextBefore = list.length > lim ? list[lim - 1].seq : null; // 游标＝本页最后一条 seq（下一页取 seq<游标）
    metaAudit(actorId, 'audit_query', 'success');
    return { ok: true, scope, entries: page, nextBefore };
  }

  /**
   * 聚合视图（audit_summary）= 仅统计，绝不含明细行
   * @returns { ok:true, summary } | { ok:false, reason:'forbidden'|'invalid_param' }
   */
  function summary({ actorId, days } = {}) {
    const win = clampInt(days, 1, MAX_WINDOW_DAYS, DEFAULT_WINDOW_DAYS);
    if (win === null) { metaAudit(actorId, 'audit_summary', 'rejected', 'invalid_param'); return { ok: false, reason: 'invalid_param' }; }

    const ident = resolveIdentity(actorId);
    if (!ident || ident.active !== true || typeof ident.hasCapability !== 'function' || !ident.hasCapability('audit_summary')) {
      metaAudit(actorId, 'audit_summary', 'rejected', 'forbidden');
      return { ok: false, reason: 'forbidden' };
    }
    const scope = typeof ident.scopeOf === 'function' ? ident.scopeOf('audit_summary') : 'full';
    if (scope !== 'aggregate') {
      metaAudit(actorId, 'audit_summary', 'rejected', 'forbidden');
      return { ok: false, reason: 'forbidden' };
    }

    const cutoff = timeSource().getTime() - win * 24 * 60 * 60 * 1000;
    const list = auditRepo.entries().filter(e => {
      const t = Date.parse(e.when);
      return Number.isFinite(t) && t >= cutoff;
    });
    const byResult = {}, byActor = {}, byDay = {};
    for (const e of list) {
      byResult[e.result] = (byResult[e.result] || 0) + 1;
      byActor[e.who] = (byActor[e.who] || 0) + 1;
      const day = String(e.when).slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
    }
    metaAudit(actorId, 'audit_summary', 'success');
    return { ok: true, summary: { windowDays: win, total: list.length, byResult, byActor, byDay } };
  }

  return { query, summary, DEFAULT_LIMIT, MAX_LIMIT, DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS };
}

module.exports = { createAuditQueryService, DEFAULT_LIMIT, MAX_LIMIT, DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS };
