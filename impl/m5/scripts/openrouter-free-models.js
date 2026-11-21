// OpenRouter 免费档模型单一真源（2026-11-22 实测）。
//
// 免费池换代：dots-studio/dots-3-note-preview:free 上游回 404
//   "dots-studio/dots-3-note-preview:free is no longer available on OpenRouter:
//    no provider serves this model anymore"
// 同池的 cohere/north-mini-code:free 也不在 /api/v1/models 的 :free 列表里了（同样下架）。
// 现存 :free 共 5 个（/api/v1/models 实测）：baidu/ernie-5.5-flash-preview、google/gemma-4-26b-a4b-it、
// google/gemma-4-31b-it、inclusionai/ling-3.2-flash、recursive/flint-v1.0。
//
// 实测口径（入口真实系统提示词 + 6 条真实运维意图，2026-11-22，脚本 /tmp/probe-entry.js 同款链路）：
// - recursive/flint-v1.0:free      prompt_only 6/6 分类正确 p50 3.9s；json_object 6/6 p50 3.2s；
// - baidu/ernie-5.5-flash-preview  prompt_only 6/6 分类正确 p50 1.3s；json_object 4/6（2 条是上游 429 限流，非解析失败）；
// - inclusionai/ling-3.2-flash:free 6/6 全 429（上游限流）⇒ 不用；
// - google/gemma-4-*-it:free       全 429 ⇒ 不用。
// 免费池漂移是常态：换模型前必须按免费档**原样实调**（不能只看目录或定价页，p000056）。
//
// 参数差异（关键）：这两个端点**强制推理**，下发 reasoning_effort='none' 会被上游拒
//   400 "Reasoning is mandatory for this endpoint and cannot be disabled."
//   ⇒ 一律不下发 reasoning_effort；推理 token 会吃 max_tokens，maxTokens 须 ≥900（入口/评测用 1500）。
'use strict';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// 入口链 provider id 带模型后缀，避免健康度把两个模型记成一家（与 cloudflare 两模型同款处理）。
const OPENROUTER_FREE_MODELS = Object.freeze([
  Object.freeze({
    id: 'openrouter-flint',
    model: 'recursive/flint-v1.0:free',
    reasoningEffort: null,
    maxTokens: 1500,
  }),
  Object.freeze({
    id: 'openrouter-ernie',
    model: 'baidu/ernie-5.5-flash-preview:free',
    reasoningEffort: null,
    maxTokens: 1500,
  }),
]);

// 评测/回放链单槽用这个（json_object 6/6，最稳）；入口链两个都放（flint 先、ernie 后）。
const OPENROUTER_PRIMARY = OPENROUTER_FREE_MODELS[0];

module.exports = { OPENROUTER_BASE_URL, OPENROUTER_FREE_MODELS, OPENROUTER_PRIMARY };
