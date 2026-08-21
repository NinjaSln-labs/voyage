// integration 限界上下文 · Outbox 事务边界（RQ-623 / DDD §7 机制1/5/6）
// 依据：M0-D §7 机制1（Outbox 消费语义：messageId 幂等去重/指数退避/超限死信+告警 INV-N2）
//      机制5（更保守者胜竞态裁决）/ 机制6（单写者时序串行）
// 交付声明：最终一致性事务边界的领域模型；真 DB 原子性归 M6 真实仓储适配器
// 对齐模式：impl/m3（聚合 + 值对象不可变 + 事件协议 + 幂等键）

'use strict';

// ---------- 常量（目标值声明，实测校准归 M0-T/M5 双态原则） ----------

const OUTBOX_MAX_RETRIES = 5;                 // 指数退避重试上限
const OUTBOX_BASE_BACKOFF_MS = 1000;          // 首次退避基数（目标值）
const OUTBOX_MAX_RETRY_MS = 1024 * 1000 * 1000; // 退避上限（> 幂等窗口即转死信，目标值）
const OUTBOX_MAX_EVENT_LENGTH = 8192;         // 事件载荷 JSON 长度上限（防水淹/放大）

// 消息状态机：pending ─┬─(消费成功)→ dispatched
//                      ├─(失败重试)→ pending(retry)  [attemptCount 递增]
//                      └─(超限)→ dead
class OutboxMessage {
  constructor({ id, event, createdAt = new Date(), attemptCount = 0, status = 'pending', nextAttemptAt = null }) {
    if (!id || typeof id !== 'string' || id.length > 128) throw new Error(`OutboxMessage: id 必填且 ≤128（${id}）`);
    if (!event || typeof event !== 'object' || !event.eventId || !event.type) {
      throw new Error('OutboxMessage: event 必含 eventId + type（跨 BC 事件协议）');
    }
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      throw new Error('OutboxMessage: createdAt 必须为有效 Date');
    }
    // 数值边界（第 33 波）：attemptCount 须为非负有限整数——外部传负/NaN/Infinity/小数会破坏退避与死信判定
    if (typeof attemptCount !== 'number' || !Number.isFinite(attemptCount) || !Number.isInteger(attemptCount) || attemptCount < 0) {
      throw new Error(`OutboxMessage: attemptCount 须为非负整数（${attemptCount}）`);
    }
    // 事件载荷序列化长度上限（防空淹/深冻结对象无法序列化）
    let len;
    try { len = JSON.stringify(event).length; }
    catch (e) { throw new Error('OutboxMessage: event 必须可序列化'); }
    if (len > OUTBOX_MAX_EVENT_LENGTH) throw new Error(`OutboxMessage: 事件载荷超长（${len} > ${OUTBOX_MAX_EVENT_LENGTH}）`);
    this._id = id;
    this._event = deepFreeze(event);         // 载荷不可变（跨 BC 事件协议）
    this._createdAt = createdAt;
    this._attemptCount = attemptCount;       // 已尝试消费次数
    this._status = 'pending';                // pending / dispatched / dead
    this._nextAttemptAt = nextAttemptAt;     // 下次可消费时间
  }

  get id() { return this._id; }
  get event() { return this._event; }        // 载荷深冻结已不可变（Event 无共享 Date 内部态）
  get eventId() { return this._event.eventId; }
  get type() { return this._event.type; }
  get createdAt() { return new Date(this._createdAt.getTime()); }  // Date 拷贝
  get attemptCount() { return this._attemptCount; }
  get status() { return this._status; }
  get nextAttemptAt() { return this._nextAttemptAt ? new Date(this._nextAttemptAt.getTime()) : null; } // Date 拷贝

  /** pending 且未达重试上限 → 标记 dispatch 尝试（消费端调用；先记录失败或成功后转移） */
  canConsume(now) {
    if (this._status !== 'pending') return false;
    if (this._nextAttemptAt && now.getTime() < this._nextAttemptAt.getTime()) return false; // 退避中
    return true;
  }

  /** 消费成功 → dispatched（终态） */
  markDispatched() {
    if (this._status !== 'pending') throw new Error(`OutboxMessage: 仅 pending 可标记 dispatched，当前 ${this._status}`);
    this._status = 'dispatched';
  }

  /**
   * 消费失败 → 指数退避重试或转死信（INV-N2）：
   *  - attemptCount ≥ MAX_RETRIES → status=dead（返回 { dead: true }）
   *  - 否则 attemptCount+1，nextAttemptAt = createdAt/base 递增退避
   * 返回 { dead, nextAttemptAt, attemptCount }（dead 时调用方须触发告警，静默转死信=违规）
   */
  markFailed(now = new Date()) {
    if (this._status !== 'pending') throw new Error(`OutboxMessage: 仅 pending 可重试，当前 ${this._status}`);
    this._attemptCount += 1;
    if (this._attemptCount >= OUTBOX_MAX_RETRIES) {
      this._status = 'dead';
      return { dead: true, attemptCount: this._attemptCount };
    }
    const backoff = Math.min(OUTBOX_BASE_BACKOFF_MS * Math.pow(2, this._attemptCount - 1), OUTBOX_MAX_RETRY_MS);
    this._nextAttemptAt = new Date(now.getTime() + backoff);
    return { dead: false, nextAttemptAt: this._nextAttemptAt, attemptCount: this._attemptCount };
  }

  /** 单调状态：pending → dispatched/dead（终态）；不允许回流 */
  get terminal() { return this._status === 'dispatched' || this._status === 'dead'; }
}

/** 深层冻结（事件载荷不可变跨 BC） */
function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return obj;
}

/**
 * Outbox 日志（编排层事务边界）：
 *  - `enqueue(event)`：单一编排事务内入队（pending）
 *  - `dispatch(now)`：按 nextAttemptAt 顺序弹出最多 1 条可消费消息，交给消费函数；
 *    消费成功 → dispatched；消费失败 → 指数退避/死信（INV-N2：达上限转 dead 须触发告警，静默=违规）
 *  - `dispatchAll(now)`：一次编排周期内串行消费全部到期消息（单写者时序，DDD §7 机制6）
 */
class OutboxJournal {
  constructor({ repo, timeSource = () => new Date(), consumer = null }) {
    if (!repo || typeof repo !== 'object') throw new Error('OutboxJournal: repo 必须注入');
    this.repo = repo;                    // 端口：{ enqueue(msg), findConsumable(now) → OutboxMessage[], findById(id), save(msg) }
    this.timeSource = timeSource;
    this.consumer = consumer || null;    // 编排层注入：async (event, now) => { return {status:'OK'} | 抛错 }
  }

  /** 事务边界内入队（审批决定/Grant 签发/审计写入后驱动执行启动消息） */
  enqueue(event) {
    const msg = new OutboxMessage({
      id: `ob-${event.eventId}`,
      event,
      createdAt: this.timeSource(),
    });
    this.repo.enqueue(msg);
    return msg;
  }

  /**
   * 消费到期消息（单条，供外部驱动一次事务）。返回处理摘要。
   * consumer 收到 { event, messageId } → 抛错视为失败（退避/死信），正常返回 → dispatched。
   */
  dispatchOne(now = this.timeSource()) {
    const consumable = this.repo.findConsumable(now);
    if (!consumable || consumable.length === 0) return { dispatched: 0, action: 'idle' };
    const msg = consumable[0]; // 单写者：一次只处理一条，保证串行
    let outcome;
    try {
      const r = this.consumeFor(msg, now);
      outcome = r;
    } catch (e) {
      outcome = { status: 'ERROR', reason: e.message };
    }
    if (outcome && outcome.status === 'OK') {
      msg.markDispatched();
      this.repo.save(msg);
      return { dispatched: 1, action: 'dispatched', messageId: msg.id };
    }
    const fail = msg.markFailed(now);
    this.repo.save(msg);
    if (fail.dead) {
      // INV-N2：关键告警不静默——死信必须通知；本层记录死信事件，由上层触发 notifPort.notify
      return { dispatched: 0, action: 'dead', messageId: msg.id, attemptCount: msg.attemptCount };
    }
    return { dispatched: 0, action: 'retry', messageId: msg.id, nextAttemptAt: msg.nextAttemptAt };
  }

  /** 消费钩子（默认以注入的 consumer 消费；未注入则抛错指明接线缺失） */
  consumeFor(msg, now) {
    if (!this.consumer) throw new Error('OutboxJournal: 未注入 consumer（编排层负责接线 exec 启动）');
    return this.consumer(msg.event, now);
  }

  /** 全体到期消息串行消费（单写者时序；一次编排周期调一次） */
  dispatchAll(now = this.timeSource()) {
    let dispatched = 0;
    const story = [];
    const maxIter = this.repo.pendingCount ? this.repo.pendingCount() + 1 : 1024; // 安全阀：防死锁/无限循环
    for (let i = 0; i < maxIter; i++) {
      const r = this.dispatchOne(now);
      story.push(r);
      if (r.action === 'idle') break;            // 无更多到期
      if (r.dispatched > 0) dispatched += r.dispatched;
      // dead/retry 继续下一次迭代（死信已出队、退避消息已推进），直到 idle 或安全阀到顶
    }
    return { dispatched, story };
  }

  /** 死信死：查询当前 dead 消息（供告警）。 */
  deadMessages() { return this.repo.deadMessages ? this.repo.deadMessages() : []; }
}

module.exports = {
  OUTBOX_MAX_RETRIES, OUTBOX_BASE_BACKOFF_MS, OUTBOX_MAX_RETRY_MS,
  OutboxMessage, OutboxJournal, deepFreeze,
};