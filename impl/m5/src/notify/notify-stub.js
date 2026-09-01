// 通知端口桩（C15 声明式占位——无真实推送能力）
// 契约：{ notify(type, payload) → { ok: true } }
// 当前静默接受并丢弃，不抛异常、不落日志。
// 接入真实 IM/WebSocket 适配器时替换本文件或另接注入。
'use strict';

function createNotifyStub() {
  return {
    notify(type, payload) {
      return { ok: true };
    },
  };
}

module.exports = { createNotifyStub };