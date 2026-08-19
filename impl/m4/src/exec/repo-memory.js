// exec 仓储内存适配器 + 内存事件总线（契约测试用）
// 契约（对齐 M4 方案 §2.7 端口）：
//  - InMemoryJobRepo: save / findById / findByGrantRef / findByTarget
//  - InMemoryEventBus: publish / subscribe（含幂等去重发布记录，测试闭环）

'use strict';

class InMemoryJobRepo {
  constructor() { this.store = new Map(); }
  save(j) { this.store.set(j.id, j); return j; }
  findById(id) { return this.store.get(id) || null; }
  findByGrantRef(grantRef) {
    for (const j of this.store.values()) if (j.grantRef === grantRef) return j;
    return null;
  }
  findByTarget(target) {
    return [...this.store.values()].filter(j => j.target === target);
  }
}

/** 内存事件总线：记录发布事件 + 同步分发订阅者（测试闭环用）；含已发布事件历史供查询 */
class InMemoryEventBus {
  constructor() {
    this.handlers = [];
    this.history = [];        // 已发布事件（幂等查询/审计断言）
    this.subscribed = [];     // 订阅记录
  }

  publish(event) {
    if (!event || typeof event !== 'object' || !event.eventId) throw new Error('EventBus: 事件须含 eventId');
    this.history.push(event);
    for (const h of this.handlers) h(event);
    return true;
  }

  subscribe(handler) {
    if (typeof handler !== 'function') throw new Error('EventBus: subscribe 须传入函数');
    this.handlers.push(handler);
    this.subscribed.push(handler);
    // 返回退订闭包（生命周期可逆，对齐 Cordis 生态习惯）
    return () => { this.handlers = this.handlers.filter(h => h !== handler); };
  }

  /** 只读已发布事件快照（深拷贝；Date 已序列化为字符串） */
  snapshot() { return this.history.slice().map(e => Object.assign({}, e)); }

  /** 按类型过滤已发布事件 */
  byType(type) { return this.history.filter(e => e.type === type); }
}

module.exports = { InMemoryJobRepo, InMemoryEventBus };