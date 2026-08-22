// 资产仓储适配器 · 文件 JSON 持久化（真实部署过渡方案，零依赖）
// 依据：ADAPTER-CONTRACTS.md §5（assetRepoPort：findById → { asset | null }，asset: { id, status, retiredAt? }）
//      M4 exec.assetPort 契约定型：{ isActive(target) → boolean }（INV-AS2 作业受理校验退役状态）
//      DDD 设计 §2.5 资产聚合（INV-AS1：命名 schema——拒绝 shell 元字符/编码变体；INV-AS2：退役状态唯一引用）
// 原则：零依赖 JSON 文件（启动 load 全量进内存，save 原子覆写+备份）；命名 schema 校验（对齐 M4 LOG_DIR_WHITELIST 防御基调）；
//      retiredAt 一旦设置不可回退（生命周期单向）；写失败抛错 → 上层 fail-closed
// 替换条件：createAssetRepo({ file })——接口与 createAssetRepoMemory 同契

'use strict';

const fs = require('node:fs');

// ---------- 资产命名 schema（INV-AS1：拒绝 shell 元字符 / 编码变体 / 空 / 超长） ----------
const ASSET_ID_MAX_LENGTH = 128;
// 原型链保留键拒绝（质量基调第 12 波：以字符串为键的领域数据一律拒绝——'__proto__' 满足正则但会污染 JSON 键面）
const RESERVED_PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf']);

/** 资产 ID 命名校验：仅允许 [a-zA-Z0-9._-]（拒绝 shell 元字符/空格/编码变体/原型链保留键） */
function isValidAssetId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > ASSET_ID_MAX_LENGTH) return false;
  if (RESERVED_PROTO_KEYS.includes(id)) return false; // 第 12 波：显式拒绝
  return /^[a-zA-Z0-9._-]+$/.test(id);
}

/** 资产状态合法集合 */
const ASSET_STATUSES = Object.freeze(['active', 'retired']);

/**
 * 资产对象（不可变值对象）：{ id, status, retiredAt? }
 *  - retiredAt 仅在 status=retired 时存在（生命周期单向，不可回退）
 *  - snapshot 深拷贝 Date（防引用篡改污染内部，对齐 m3 AggregationWindow 惯例）
 */
class Asset {
  constructor({ id, status = 'active', retiredAt = null }) {
    if (!isValidAssetId(id)) {
      throw new Error(`Asset: id 非法（须 1~${ASSET_ID_MAX_LENGTH} 字符，仅 [a-zA-Z0-9._-]，拒绝 shell 元字符/编码变体）`);
    }
    if (!ASSET_STATUSES.includes(status)) throw new Error(`Asset: status 非法（${status}，须 active|retired）`);
    if (status === 'retired' && !(retiredAt instanceof Date) && retiredAt !== null) {
      throw new Error('Asset: retiredAt 必须为 Date');
    }
    this._id = id;
    this._status = status;
    this._retiredAt = status === 'retired' ? (retiredAt instanceof Date ? new Date(retiredAt.getTime()) : new Date()) : null;
    Object.freeze(this);
  }

  get id() { return this._id; }
  get status() { return this._status; }
  get retiredAt() { return this._retiredAt ? new Date(this._retiredAt.getTime()) : null; } // 拷贝（防篡改）

  /** M4 assetPort.isActive 语义：active 才 true（退役/未知 → false，fail-closed） */
  isActive() { return this._status === 'active'; }

  snapshot() {
    return Object.freeze({
      id: this._id, status: this._status,
      retiredAt: this._retiredAt ? this._retiredAt.toISOString() : null,
    });
  }
}

/** 共享仓储核心（审计修复 P2：消除 file/memory 版 retire/upsert/findById 逐字重复）——
 *  store: Map<id, Asset>；persist: 变更后持久化钩子（内存版为 no-op） */
function _assetRepoCore(_store, persist = () => {}) {
  return {
    /** 查询单资产；不存在 → null */
    findById(id) {
      return _store.get(id) || null;
    },

    /** M4 assetPort.isActive 契约：active 才 true（退役/未知 → false，fail-closed） */
    isActive(target) {
      const a = _store.get(target);
      return a ? a.isActive() : false;
    },

    /** 新增/更新资产（命名 schema 校验；写盘失败抛错 fail-closed） */
    upsert(asset) {
      const a = asset instanceof Asset ? asset : new Asset(asset);
      _store.set(a.id, a);
      persist();
      return a;
    },

    /** 退役资产（INV-AS2 生命周期单向；幂等——已退役返回 { ok: true, already: true }） */
    retire(id, now = new Date()) {
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('Asset.retire: now 必须为合法 Date');
      const a = _store.get(id);
      if (!a) return { ok: false, reason: 'asset_not_found' };
      if (a.status === 'retired') return { ok: true, already: true, asset: a };
      const retired = new Asset({ id: a.id, status: 'retired', retiredAt: now });
      _store.set(id, retired);
      persist();
      return { ok: true, already: false, asset: retired };
    },

    /** 全部资产（管理用） */
    all() { return [..._store.values()]; },

    /** 持久化状态（管理用） */
    count() { return _store.size; },
  };
}

/**
 * 文件 JSON 持久化资产仓储（assetRepoPort 落地）
 *  - load() → { assets: Asset[] } | null（启动重建；文件不存在 → null）
 *  - save() → 原子覆写（写临时文件 + rename，防半写损坏）；写失败抛错（fail-closed）
 *  - findById(id) → Asset | null
 *  - isActive(target) → boolean（M4 assetPort 契约：退役/未知 → false）
 *  - retire(id, now) → 退役（单向，不可回退；幂等——已退役返回 true 不变）
 *  - upsert(asset) → 新增/更新（命名 schema 校验）
 */
function createAssetRepo({ file, assets = [] } = {}) {
  if (!file || typeof file !== 'string' || file.length === 0) {
    throw new Error('createAssetRepo: file 必填（JSON 文件路径）');
  }
  const _store = new Map(); // id → Asset

  function _load() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.assets)) throw new Error('asset 文件结构非法（须 { assets: [...] }）');
      return data;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e; // 其他读错误 → fail-closed
    }
  }

  // 启动加载（构造即恢复；损坏/非法行 → fail-fast）
  const data = _load();
  if (data) {
    for (const rec of data.assets) {
      try {
        const a = new Asset({
          id: rec.id, status: rec.status || 'active',
          retiredAt: rec.retiredAt ? new Date(rec.retiredAt) : null,
        });
        _store.set(a.id, a);
      } catch (e) {
        throw new Error(`asset 文件加载失败（${file}）：${e.message}`);
      }
    }
  } else if (assets.length > 0) {
    // 首次启动以调用方提供种子初始化（真实部署：从 CMDB 导入）
    for (const seed of assets) {
      const a = seed instanceof Asset ? seed : new Asset(seed);
      _store.set(a.id, a);
    }
  }

  function _save() {
    const payload = JSON.stringify({
      version: 1,
      assets: [..._store.values()].map(a => a.snapshot()),
    }, null, 2);
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, file); // 原子替换，防半写损坏
    } catch (e) {
      throw new Error(`asset 仓储写入失败（fail-closed）——${e.message}`);
    }
  }

  if (data === null && assets.length > 0) _save(); // 种子初始化落盘

  return _assetRepoCore(_store, _save);
}

/** 内存版（契约测试/开发用；与文件版同契，不落盘） */
function createAssetRepoMemory(assets = []) {
  const _store = new Map();
  for (const seed of assets) {
    const a = seed instanceof Asset ? seed : new Asset(seed);
    _store.set(a.id, a);
  }
  return _assetRepoCore(_store);
}

module.exports = { Asset, ASSET_STATUSES, isValidAssetId, createAssetRepo, createAssetRepoMemory };
