// obs 仓储内存适配器（契约测试用；生产适配器须满足同一契约）
// 契约（M0-D §4 / INV-AS3）：
//   - save 幂等：同版本号重复保存不产生重复事件
//   - 版本号防乱序：低版本写回被拒绝
//   - 资产唯一真相：同 ID 同聚合

'use strict';

const { AssetObservationRepository } = require('./domain');

class InMemoryAssetObservationRepository extends AssetObservationRepository {
  constructor() {
    super();
    this.store = new Map();   // assetId -> AssetObservation
    this.eventLog = [];       // 领域事件日志（订阅方消费源）
  }

  async findById(assetId) {
    return this.store.get(assetId) || null;
  }

  async delete(assetId) {
    if (!this.store.has(assetId)) return { deleted: false };
    this.store.delete(assetId);
    return { deleted: true };
  }

  async save(obs) {
    const existing = this.store.get(obs.id);
    if (existing && existing.version > obs.version) {
      throw new Error(`版本乱序：现有 v${existing.version} > 提交 v${obs.version}`);
    }
    if (existing && existing.version === obs.version) {
      // 同版本已存在 → 幂等返回（不重复落库，INV-AS3 幂等语义；与对象是否同一引用无关）
      return { idempotent: true, version: existing.version };
    }
    this.store.set(obs.id, obs);
    return { idempotent: false, version: obs.version };
  }
}

module.exports = { InMemoryAssetObservationRepository };
