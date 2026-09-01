// 模型适配器层 · 供应商无关（modelApiPort 落地）
// 依据：ADAPTER-CONTRACTS.md §6（modelApiPort：interpret(text, ctx) / search(query, ctx)）
//      M2 intentModel 契约（interpret(text) → {type, confidence}）
//      M5 convPort 消费契约（interpret → {intentType, capability, confidence, intentId, subject, params}）
// 原则：供应商无关——厂商实现经注册表挂载，核心不 import 任何厂商；模型输出必须为结构化 JSON（本地严格解析）；
//      解析失败/结构非法 → 降级（confidence=0 走审核，INV-M2 断连→本地兜底）；单次计费+超时（INV-N2）
// 模式对齐：M4 端口注入（构造 fail-fast）+ 结构校验 fail-fast + 失败语义归一

'use strict';

const { CAPABILITIES, EGRESS_CAPABILITIES } = require('../shared-capabilities.js');

// ---------- 动作类别 / 能力白名单（单源在 ../shared-capabilities.js——审计修复 P1-3） ----------

const ACTION_CLASSES = Object.freeze(['read', 'write', 'egress', 'authorize']);

const DEFAULT_CONFIDENCE_FLOOR = 0;      // 解析失败 → confidence=0（INV-M2 超时→审核）
const MAX_INPUT_LENGTH = 4096;           // 对齐 M2 MAX_INPUT_LENGTH
const MAX_MODEL_OUTPUT_LENGTH = 8192;    // 模型输出上限（防洪泛）

/**
 * 供应商无关模型适配器（modelApiPort 统一契约）
 * @param {object} opts
 *  - provider: 注册表内的厂商 id（如 'cohere'）
 *  - registry: 厂商注册表 { id → { interpret(text, ctx), search(query, ctx) } }（默认内置注册表）
 *  - fallback: 断连/超时本地兜底（INV-M2：返回 confidence=0 走审核）
 */
function createModelApi({ provider = null, registry = null, fallback = null } = {}) {
  if (!provider || typeof provider !== 'string') throw new Error('createModelApi: provider 必填（如 cohere）');
  const reg = registry || null;
  const impl = reg ? reg[provider] : null;
  if (!impl) throw new Error(`createModelApi: 供应商 ${provider} 未注册`);

  function _validateInput(text, ctx) {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_INPUT_LENGTH) {
      return { ok: false, reason: 'invalid_input' };
    }
    if (ctx && typeof ctx !== 'object') return { ok: false, reason: 'invalid_ctx' };
    return { ok: true };
  }

  function _parseStructured(raw) {
    // 模型输出 → 结构化 JSON（提取首个 JSON 块；解析失败 → 降级）
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_MODEL_OUTPUT_LENGTH) {
      return { ok: false, reason: 'empty_or_oversized_output' };
    }
    const trimmed = raw.trim();
    // 兼容 markdown 代码块包裹
    const blockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = blockMatch ? blockMatch[1] : trimmed;
    let obj = null;
    try { obj = JSON.parse(candidate); } catch (e) { return { ok: false, reason: 'invalid_json' }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not_object' };
    // 结构校验（fail-closed：actionClass 缺失或非法 → 尝试向后兼容 intentType）
    if (!obj.actionClass || !ACTION_CLASSES.includes(obj.actionClass)) {
      // 向后兼容：若模型输出旧的 intentType，映射到 actionClass
      if (obj.intentType === 'query') obj.actionClass = 'read';
      else if (obj.intentType === 'execute') obj.actionClass = 'write';
      else return { ok: false, reason: 'invalid_action_class' };
    }
    if ((obj.actionClass === 'write' || obj.actionClass === 'egress') && !CAPABILITIES.includes(obj.capability)) {
      return { ok: false, reason: 'invalid_capability' };
    }
    const confidence = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence) ? obj.confidence : 0;
    const subject = typeof obj.subject === 'string' ? obj.subject : null;
    const intentType = obj.actionClass === 'read' ? 'query' : 'execute';
    return { ok: true, value: { actionClass: obj.actionClass, intentType, capability: obj.capability || null, confidence, subject, params: obj.params && typeof obj.params === 'object' ? obj.params : null } };
  }

  /** 意图理解：interpret(text, ctx) → { actionClass, intentType, capability, confidence, intentId?, subject?, params? }（async 契约）
   *  返回含 intentType 为向后兼容推导字段（actionClass=read→query, 其他→execute） */
  async function interpret(text, ctx) {
    const vi = _validateInput(text, ctx);
    if (!vi.ok) return { ok: false, reason: vi.reason };
    let raw;
    try {
      raw = await impl.interpret(text, ctx);
    } catch (e) {
      // 厂商异常（网络/超时）→ 本地兜底（INV-M2）——兜底结果同过白名单校验（审计修复：不绕 fail-closed）
      if (fallback && typeof fallback.interpret === 'function') {
        try { return _finalize(await fallback.interpret(text, ctx)); } catch (e2) { /* 兜底也失败 → 降级 */ }
      }
      return { ok: false, reason: 'provider_error', degraded: true, actionClass: 'read', intentType: 'query', confidence: DEFAULT_CONFIDENCE_FLOOR };
    }
    return _finalize(raw);
  }

  /** 同步意图理解（供同步契约消费方，如 M5 IntegrationService.handle）：厂商须提供 interpretSync，否则降级 */
  function interpretSync(text, ctx) {
    const vi = _validateInput(text, ctx);
    if (!vi.ok) return { ok: false, reason: vi.reason };
    if (typeof impl.interpretSync !== 'function') {
      return { ok: false, reason: 'no_sync_provider', degraded: true, actionClass: 'read', intentType: 'query', confidence: DEFAULT_CONFIDENCE_FLOOR };
    }
    let raw;
    try {
      raw = impl.interpretSync(text, ctx);
    } catch (e) {
      if (fallback && typeof fallback.interpretSync === 'function') {
        try { return _finalize(fallback.interpretSync(text, ctx)); } catch (e2) { /* 兜底失败 → 降级 */ }
      }
      return { ok: false, reason: 'provider_error', degraded: true, actionClass: 'read', intentType: 'query', confidence: DEFAULT_CONFIDENCE_FLOOR };
    }
    return _finalize(raw);
  }

  /** 终判：厂商/兜底输出 → 白名单校验（字符串 JSON 或结构化对象均过同一校验——审计修复：兜底不绕 fail-closed） */
  function _finalize(raw) {
    let parsed;
    if (typeof raw === 'string') {
      parsed = _parseStructured(raw);
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      // 兜底引擎直接返回结构化对象：同走白名单校验（intentType/capability 合法性）
      const asJson = _parseStructured(JSON.stringify(raw));
      parsed = asJson;
    } else {
      parsed = { ok: false, reason: 'provider_returned_non_string' };
    }
    if (!parsed.ok) {
      // 模型输出无法结构化 → 降级（INV-M2：confidence=0 走审核；不抛错不静默成功）
      return { ok: false, reason: parsed.reason, degraded: true, actionClass: 'read', intentType: 'query', confidence: DEFAULT_CONFIDENCE_FLOOR };
    }
    return { ok: true, ...parsed.value };
  }

  /** 知识检索：search(query, ctx) → { ok, results? }
   *  【声明式桩】C5 RAG 知识检索**未定/未接入**——此方法仅为对齐 ADAPTER-CONTRACTS §6 契约形状
   *  （modelApiPort 含 interpret/search），恒返降级空结果，无任何调用方。
   *  接入知识检索时：厂商实现 search + 检索级 ACL（密级×权限交集）+ 数据非指令分层（INV-K2），替换本桩。 */
  async function search(query, ctx) {
    const vi = _validateInput(query, ctx);
    if (!vi.ok) return { ok: false, reason: vi.reason };
    try {
      const raw = impl.search ? await impl.search(query, ctx) : null;
      if (raw === null) return { ok: true, results: [], degraded: true };
      return { ok: true, results: Array.isArray(raw) ? raw : [raw] };
    } catch (e) {
      return { ok: true, results: [], degraded: true };
    }
  }

  return { interpret, interpretSync, search, _parseStructured };
}

module.exports = { createModelApi, CAPABILITIES, DEFAULT_CONFIDENCE_FLOOR, MAX_INPUT_LENGTH };
