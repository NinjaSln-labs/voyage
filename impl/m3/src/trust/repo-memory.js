// trust 仓储内存适配器（契约测试用）
// 契约：save 幂等（同版本）、findById、findOrCreate 聚合窗口

'use strict';

class InMemoryApprovalRepo {
  constructor() { this.store = new Map(); }
  async save(a) { this.store.set(a.id, a); return a; }
  async findById(id) { return this.store.get(id) || null; }
}

class InMemoryGrantRepo {
  constructor() { this.store = new Map(); }
  async save(g) { this.store.set(g.id, g); return g; }
  async findById(id) { return this.store.get(id) || null; }
}

class InMemoryAggregationRepo {
  constructor() { this.store = new Map(); }
  key(actorId, assetId, type) { return `${type}:${actorId}:${assetId}`; }
  findOrCreate(actorId, assetId, type) {
    const { AggregationWindow } = require('./domain');
    const k = this.key(actorId, assetId, type);
    if (!this.store.has(k)) this.store.set(k, new AggregationWindow({ actorId, assetId, windowType: type }));
    return this.store.get(k);
  }
}

module.exports = { InMemoryApprovalRepo, InMemoryGrantRepo, InMemoryAggregationRepo };
