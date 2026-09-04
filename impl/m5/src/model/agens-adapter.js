// Agens 模型适配器（供应商实现，挂载到 model-api 注册表）
// 依据：Agens API（apihub.agnes-ai.com/v1/chat/completions，OpenAI 兼容风格；模型 agnes-2.0-flash）
//      ADAPTER-CONTRACTS.md §6（modelApiPort）+ 供应商无关层 model-api.js
// 实现：HTTP 直调（无 SDK）；Bearer 认证；非流式单响应；意图理解走结构化 JSON 约束提示
// 安全：API Key 经注入不落盘；失败抛错 → 上层 model-api 降级（confidence=0 走审核，INV-M2）

'use strict';

const DEFAULT_ENDPOINT = 'https://apihub.agnes-ai.com/v1/chat/completions';
const DEFAULT_MODEL = 'agnes-2.0-flash';

// 意图理解系统提示（与 Command Code 适配器同约束：只输出 JSON；本地严格解析定稿）
const SYSTEM_PROMPT = [
  '你是运维意图识别器。将用户的中文运维口语意图分类并抽取执行参数。',
  '动作分类（actionClass）：',
  '- read：查询/查看/了解/确认类（无系统内副作用）。',
  '- write：执行/重启/清理/扩容/变更/切换类（有系统内副作用）。',
  '- egress：数据外传——把服务器数据（文件内容/日志/配置/凭据）发送/外传/导出/下载到信任边界之外（微信/邮件/网盘/外部系统）。',
  '- authorize：授权/管理类操作（预留，当前不应输出）。',
  '能力（capability）：query_status, query_health, query_metric, query_log, restart, clean, scale, config_change, env_switch, egress_send, egress_download, egress_mail',
  'egress 示例：',
  '- "把日志发到我微信上" → {"actionClass":"egress","capability":"egress_send"}',
  '- "看下 jd-light 状态" → {"actionClass":"read","capability":"query_status"}',
  '- "重启服务器" → {"actionClass":"write","capability":"restart"}',
  '参数抽取规则（仅从用户原话抽取，禁止编造）：',
  '- 用户提到具体服务名/进程名/资产ID → params.service，且 subject 必须填同一名称',
  '- 用户提到日志路径 → params.path',
  '- 用户提到副本数 → params.replicas',
  '- 未提到的参数不要输出。',
  '只输出一个 JSON 对象，格式：',
  '{"actionClass": "read|write|egress|authorize", "capability": "query_status|query_health|query_metric|query_log|restart|clean|scale|config_change|env_switch|egress_send|egress_download|egress_mail", "confidence": 0.0-1.0, "subject": "执行目标资产ID（确实无目标时才为null）", "params": {"service|path|replicas": "从原话抽取"}}',
  '不要输出其他文字。',
].join('\n');

/**
 * Agens 适配器工厂
 * @param {object} opts
 *  - apiKey: Agens API Key（必须；经注入不落盘）
 *  - model: 模型名（默认 'agnes-2.0-flash'）
 *  - endpoint: 端点（默认官方 apihub）
 *  - timeoutMs: 请求超时（默认 15000）
 *  - maxTokens: 输出 token 上限（默认 300；推理型供应商需 ≥900——HANDOFF §4 已知坑：
 *    300 会被 reasoning 截断 JSON，经 openaiCompat 包装接入推理模型时由调用方传入）
 *  - extraParams: 额外请求参数（如 { reasoning_effort: 'low' }），展开到请求体顶层；
 *    CommandCode API 支持 low|medium|high|xhigh|max（无 none），sensenova/teamorouter 支持 none
 *  - fetchImpl: fetch 实现（测试注入；默认全局 fetch）
 */
function createAgensAdapter({ apiKey = null, model = DEFAULT_MODEL, endpoint = DEFAULT_ENDPOINT, timeoutMs = 15000, maxTokens = 300, extraParams = null, fetchImpl = null } = {}) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('createAgensAdapter: apiKey 必填（经注入，不落盘）');
  }
  if (typeof model !== 'string' || model.length === 0) throw new Error('createAgensAdapter: model 必填');
  if (typeof endpoint !== 'string' || endpoint.length === 0) throw new Error('createAgensAdapter: endpoint 必填');
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 65536) throw new Error('createAgensAdapter: maxTokens 必须为正整数（≤65536）');
  if (extraParams !== null && (typeof extraParams !== 'object' || Array.isArray(extraParams))) {
    throw new Error('createAgensAdapter: extraParams 必须为对象或 null');
  }
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('createAgensAdapter: 无可用 fetch（Node ≥18 或注入 fetchImpl）');

  async function _chat(messages) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0,
          max_tokens: maxTokens,
          ...(extraParams || {}),
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        const err = new Error(`agens http ${res.status}`);
        err.code = res.status === 401 || res.status === 403 ? 'agens_auth' : 'agens_http';
        err.status = res.status;
        err.body = bodyText.slice(0, 300);
        throw err;
      }
      const data = await res.json();
      // OpenAI 兼容响应：{ choices: [{ message: { role, content } }] }
      const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
      const text = choice && choice.message && typeof choice.message.content === 'string'
        ? choice.message.content
        : '';
      if (!text) throw new Error('agens empty response');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: 'agens',

    /** 意图理解：interpret(text, ctx) → 模型原始文本（上层 model-api 解析结构化） */
    interpret(text, ctx) {
      return _chat([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `意图：${text}` },
      ]);
    },

    /** 知识检索：search(query, ctx) → 片段数组（C5 RAG 未立项——声明式桩，恒返空降级） */
    search() {
      return Promise.resolve([]);
    },
  };
}

module.exports = { createAgensAdapter, SYSTEM_PROMPT };
