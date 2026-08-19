// conv 读 obs 快照的适配器（M2 读 C7；DAG：M2 读 C5/C7）
// 契约：只读查询（obs.query），密级 fail-closed（INV-K2/M3 同构），数据非指令
// 第 5 波严格审计修复：requesterLabel 必须来自身份 BC 的服务端判定（防调用方伪造 trusted 绕过密级）

'use strict';

/** 身份判定端口：requesterLabel 由身份 BC（RQ-812 身份组投影）服务端判定，调用方不可自报 */
class IdentityPort {
  async resolveRequesterLabel(actor, sessionId) { throw new Error('未实现：resolveRequesterLabel'); }
}

/** obs 查询端口：conv → obs（M0-D §4 obs.query 契约） */
class ObservationQueryPort {
  async query(assetId, requesterLabel) { throw new Error('未实现：query'); }
}

/** 内存实现（契约测试用；与 m1 obs 的 snapshotFor 语义一致） */
class InMemoryObservationQuery extends ObservationQueryPort {
  constructor(assets) { super(); this.assets = assets; } // assets: Map<assetId, {securityLabel, metrics, health}>

  /**
   * 查询：requesterLabel 由调用方传入身份判定结果（须经 IdentityPort 解析，防伪造）。
   * 生产实现：query 入口先 identity.resolveRequesterLabel(actor, sessionId) 再进 obs。
   */
  async query(assetId, requesterLabel = 'public') {
    if (requesterLabel !== 'public' && requesterLabel !== 'restricted' && requesterLabel !== 'trusted') {
      throw new Error('query: requesterLabel 非法（必须为身份 BC 判定的合法值）'); // 防任意字符串伪装
    }
    const a = this.assets.get(assetId);
    if (!a) return { assetId, found: false };
    if (a.securityLabel !== 'public' && requesterLabel !== 'trusted') {
      return { assetId, found: true, denied: true }; // 密级 fail-closed
    }
    return { assetId, found: true, denied: false, metrics: a.metrics, health: a.health };
  }
}

module.exports = { ObservationQueryPort, InMemoryObservationQuery, IdentityPort };
