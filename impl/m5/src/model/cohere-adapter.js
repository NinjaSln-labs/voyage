// Command Code 模型适配器（供应商实现，挂载到 model-api 注册表；HTTP 走 Cohere V1 Chat 端点）
// 依据：ADAPTER-CONTRACTS.md §6（modelApiPort）+ 供应商无关层 model-api.js
// 实现：HTTP 直调 Cohere V1 Chat API（/v1/chat，Bearer 认证），无 SDK；流式关闭（非流式单响应）
// 安全：API Key 经注入（构造参数），不落盘不打印；模型输出仅作为结构化意图候选（本地严格解析定稿）
// 失败语义：网络/HTTP 非 2xx/超时 → 抛错（上层 model-api 捕获 → 降级 confidence=0 走审核，INV-M2）
// 注意：本适配器不硬绑定任何具体模型名——模型名经构造参数注入（vendor-agnostic，可换 command/command-r 等）

'use strict';

// 默认端点与模型（可覆盖；不绑定具体模型）
const DEFAULT_ENDPOINT = 'https://api.cohere.com/v1/chat'; // Command Code API 端点（Cohere V1 Chat 兼容）
const DEFAULT_MODEL = 'command-code'; // 默认模型名（与供应商同名的自家模型；可换其他模型名）

// 意图理解系统提示（引导模型输出结构化 JSON；本地严格解析定稿，模型仅辅助）
const SYSTEM_PROMPT = [
  '你是运维意图识别器。将用户的中文运维口语意图分类为 query 或 execute。',
  'query：查询/查看/了解/确认类（无副作用）。',
  'execute：执行/重启/清理/扩容/变更/切换类（有副作用）。',
  '只输出一个 JSON 对象，格式：',
  '{"intentType": "query|execute", "capability": "query_status|query_health|query_metric|query_log|restart|clean|scale|config_change|env_switch", "confidence": 0.0-1.0, "subject": "目标资产ID或null"}',
  '不要输出其他文字。',
].join('\n');

/**
 * Cohere 适配器工厂
 * @param {object} opts
 *  - apiKey: Cohere API Key（必须；经注入，不落盘）
 *  - model: 具体模型名（默认 'command-code'）
 *  - endpoint: 端点（默认官方 V1 /v1/chat）
 *  - timeoutMs: 请求超时（默认 15000）
 *  - fetchImpl: fetch 实现（测试注入；默认全局 fetch）
 */
function createCohereAdapter({ apiKey = null, model = DEFAULT_MODEL, endpoint = DEFAULT_ENDPOINT, timeoutMs = 15000, fetchImpl = null } = {}) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('createCohereAdapter: apiKey 必填（经注入，不落盘）');
  }
  if (typeof model !== 'string' || model.length === 0) throw new Error('createCohereAdapter: model 必填');
  if (typeof endpoint !== 'string' || endpoint.length === 0) throw new Error('createCohereAdapter: endpoint 必填');
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('createCohereAdapter: 无可用 fetch（Node ≥18 或注入 fetchImpl）');

  async function _chat(messages) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-Client-Name': 'voyage-aiops',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0,
          max_tokens: 300,
          // 非流式单响应（不启用 stream——简化解析，语义一致）
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`cohere http ${res.status}`);
        err.code = res.status === 401 || res.status === 403 ? 'cohere_auth' : 'cohere_http';
        err.status = res.status;
        err.body = body.slice(0, 300);
        throw err;
      }
      const data = await res.json();
      // Cohere V1 chat 响应：{ message: { role, content: [{type:'text', text}] }, ... }
      const content = data && data.message && data.message.content;
      const text = Array.isArray(content)
        ? content.map(c => (c && typeof c.text === 'string' ? c.text : '')).join('')
        : (typeof data.text === 'string' ? data.text : '');
      if (!text) throw new Error('cohere empty response');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: 'command-code', // 供应商口径：Command Code

    /** 意图理解：interpret(text, ctx) → 模型原始文本（上层 model-api 解析结构化） */
    interpret(text, ctx) {
      return _chat([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `意图：${text}` },
      ]);
    },

    /** 知识检索：search(query, ctx) → 片段数组（V1 检索端点在接入点之后扩展；暂返回空降级） */
    search(query) {
      return Promise.resolve([]);
    },
  };
}

module.exports = { createCohereAdapter, SYSTEM_PROMPT };
