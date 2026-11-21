// Coarena 免费档模型单一真源（2026-11-17 实测）。
//
// 免费账号只开放以下 3 个模型，其余模型一律 402，原文点名：
//   "Free accounts can use GPT-6 Luna, Gemini 3.8 Flash and DeepSeek V4.1 Flash 1017."
// 目录 /models 返回 18 个模型 ≠ 可调用（在册不等于免费）；新增模型前必须按免费档原样实调，
// 不能只看目录或定价页。
//
// 限制：$1/日（UTC）、10 rpm/key、10 rpm/account、10 rpm/model、并发 2。
// 因此入口链把 Coarena 放在 failover 后位，不承担主流量；评测链只放 1 个模型，
// 避免 126 条串行样本在十几秒内打满 account 级限流。
//
// 参数差异（入口实测 9/9 意图分类正确）：
// - gpt-6-luna / deepseek-v4-1-flash-1017 支持 reasoning_effort='none'（reasoning_tokens=0）；
// - gemini-3-8-flash 不支持 'none'，最低 'low'；推理 token 会吃 max_tokens，入口 maxTokens 须 ≥900。
'use strict';

const COARENA_BASE_URL = 'https://coarena.ai/api/v1';

const COARENA_FREE_MODELS = Object.freeze({
  // 键名即入口链 provider id（带模型后缀，避免健康度把三个模型记成一家）。
  'coarena-luna': Object.freeze({ model: 'gpt-6-luna', reasoningEffort: 'none' }),
  'coarena-deepseek': Object.freeze({ model: 'deepseek-v4-1-flash-1017', reasoningEffort: 'none' }),
  'coarena-gemini': Object.freeze({ model: 'gemini-3-8-flash', reasoningEffort: 'low' }),
});

module.exports = { COARENA_BASE_URL, COARENA_FREE_MODELS };
