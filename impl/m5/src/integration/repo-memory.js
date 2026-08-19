// Outbox 内存仓储（契约测试用）：穿透到内存消息队列，findConsumable 按 nextAttemptAt 排序

'use strict';

const { OutboxMessage } = require('./outbox.js');

/** Outbox 内存仓储：{ enqueue(msg), findConsumable(now) → [msg], findById(id), save(msg), pendingCount(), deadMessages() } */
function createOutboxRepo() {
  const _messages = new Map(); // id → OutboxMessage

  return {
    enqueue(msg) {
      if (_messages.has(msg.id)) return; // 幂等：同 id 已入队
      _messages.set(msg.id, msg);
    },
    findById(id) { return _messages.get(id) || null; },
    save(msg) { _messages.set(msg.id, msg); },

    /** 到期可消费：pending 且 nextAttemptAt ≤ now，按 nextAttemptAt 升序（FIFO 公平） */
    findConsumable(now) {
      const list = [];
      for (const msg of _messages.values()) {
        if (msg.canConsume(now)) list.push(msg);
      }
      return list.sort((a, b) => {
        const ta = a.nextAttemptAt ? a.nextAttemptAt.getTime() : 0;
        const tb = b.nextAttemptAt ? b.nextAttemptAt.getTime() : 0;
        return ta - tb;
      });
    },

    pendingCount() {
      let n = 0;
      for (const m of _messages.values()) if (m.status === 'pending') n += 1;
      return n;
    },
    deadMessages() {
      return [..._messages.values()].filter(m => m.status === 'dead');
    },
    all() { return [..._messages.values()]; },
  };
}

module.exports = { createOutboxRepo };