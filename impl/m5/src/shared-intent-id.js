// 意图幂等键单源（t000046：重复意图在模型调用后才做幂等检查，白耗一次模型调用）
//
// 为什么独立成模块：幂等键算法原先住在 compose.js 的局部函数里，编排层（domain）拿不到，
//   于是「模型调用前查重」这件事没法做——查重必须在 convPort.interpret 之前，
//   而键只能由 actorId + intent 算出。两处各写一份必然漂移（键一漂，幂等静默失效：
//   同一请求不再被认作重复 → 重复副作用照旧发生）⇒ 必须单源。
//
// 键格式不变（`int-<actorId>-<intent>`，审计修复 R8：纯文本键会跨 actor 误判 duplicate）——
//   审批单 ID 由此键派生（ap-<intentId>），改格式会连带改审批单 ID，破坏在途审批单。

'use strict';

/** 意图幂等键：intent 文本 + actorId（R8：纯文本键会跨 actor 误判 duplicate） */
function intentIdOf(intent, actorId) {
  return `int-${actorId}-${intent}`;
}

module.exports = { intentIdOf };
