// OpenDesign 供应商模型单一真源（2026-11-22 实测，接替 CommandCode）。
//
// 端点：OpenAI 兼容，https://amr-link.open-design.ai/v1（/v1/models 实测 200，返回 14 个 id）。
// 凭据：jinteng 规范名 NKP_OPENDESIGN（明文不落仓，由服务端 voyage.env 注入）。
//
// 实测口径（入口真实系统提示词 + 6 条真实运维意图，生产同款适配器 agens-adapter.js + parseStructured）：
// - deepseek-v4.1-flash-eco  prompt_only 6/6 分类正确 p50 3.4s；json_object 6/6 p50 2.2s；
// - glm-5.3-flash           prompt_only 6/6 分类正确 p50 3.4s；json_object 6/6 p50 7.0s（单条最慢 28.9s）；
// - minimax-m3.1-flash      prompt_only 6/6 分类正确 p50 4.3s；json_object 5/6（1 条网络 fetch failed，非解析失败）。
//
// 参数差异（关键）：minimax-m3.1-flash **不接受 reasoning_effort=none**——下发即 400
//   {"error":{"message":"[code=upstream_error] The request could not be completed."}}（6/6 全失败）；
//   deepseek/glm 接受 none 与省略两种（省略亦 5/6~6/6 正确）。
// ⇒ 三家统一**不下发 reasoning_effort**（省略即最优，minimax 是硬约束，另两家是等价最优），
//   免得后续给某一家单独加档时把 minimax 打挂。
//
// ★2026-11-23 空壳成因（p000078）：三家都是**推理模型**，`reasoning_tokens` 计入 `completion_tokens`；
//   推理吃满 `max_tokens` 时上游返回 HTTP 200 但 `choices:[]`（usage 里 `completion_tokens` 恰等于上限），
//   归因落成 `body_no_choice(empty)`——不是模型死、不是 key 无效。
//   实测（真实 sim 提示词 + 真实运维意图，生产同款参数）：max_tokens=1500 时 deepseek 空壳 1/10
//   （空壳那次 completion_tokens=1500）；2500/3000 时 0/10。minimax 推理 p50~247、glm p50~23，
//   deepseek 推理 p50~696、max~1281 ⇒ 1500 对 deepseek 是紧贴上限。
//   ⇒ maxTokens 取 3000（推理预算 + 输出余量）；空壳重试由调用方既有策略承担（sim 两次、入口 failover）。
// 端点偶发 fetch failed（本机网络抖动，非模型能力问题），failover 链上靠多家兜底。
// 在册 ≠ 可调用：换模型前仍须原样实调（p000056）。
'use strict';

const OPENDESIGN_BASE_URL = 'https://amr-link.open-design.ai/v1';

// 入口链 provider id 带模型后缀，避免健康度把三个模型记成一家（与 cloudflare/coarena 同款处理）。
const OPENDESIGN_MODELS = Object.freeze([
  Object.freeze({ id: 'opendesign-deepseek', model: 'deepseek-v4.1-flash-eco', reasoningEffort: null, maxTokens: 3000 }),
  Object.freeze({ id: 'opendesign-glm', model: 'glm-5.3-flash', reasoningEffort: null, maxTokens: 3000 }),
  Object.freeze({ id: 'opendesign-minimax', model: 'minimax-m3.1-flash', reasoningEffort: null, maxTokens: 3000 }),
]);

// 评测/回放链单槽用这个（json_object 6/6、p50 最低）。
const OPENDESIGN_PRIMARY = OPENDESIGN_MODELS[0];

module.exports = { OPENDESIGN_BASE_URL, OPENDESIGN_MODELS, OPENDESIGN_PRIMARY };
