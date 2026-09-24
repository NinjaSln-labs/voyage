// 资产归属仓储适配器 · 文件 JSON 持久化（ADR-006 阶段2-1：为矩阵「范围维度」提供 owned/related 数据源）
// 依据：ADR-006（能力×角色×范围；owned=自己负责的服务 / related=相关服务只读）+ 产品说明书 §4.2 范围限定词
// 原则：零依赖 JSON 文件（启动 load 全量进内存，save 原子覆写）；命名 schema 校验（资产 id 复用 repo-asset 的
//      isValidAssetId；主体 id 独立校验）；非法形状/未知键 → 抛错 fail-closed；写失败抛错 → 上层 fail-closed
// 端口：ownersOf/relatedOf/isOwnedBy/isRelatedTo/listOwnedBy/all/count/upsert
// 替换条件：createAssetOwnershipRepo({ file, ownership })——接口与 createAssetOwnershipRepoMemory 同契

'use strict';

const fs = require('node:fs');
const { RESERVED_PROTO_KEYS } = require('../shared-capabilities.js');
const { isValidAssetId } = require('./repo-asset.js');

const SUBJECT_ID_MAX_LENGTH = 128;

/** 主体 ID 命名校验（对齐 identity id 约束基调：非空 ≤128、拒绝原型链保留键/空白/控制字符） */
function isValidSubjectId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > SUBJECT_ID_MAX_LENGTH) return false;
  if (RESERVED_PROTO_KEYS.includes(id)) return false;
  return !/[\s\u0000-\u001f]/.test(id);
}

function assertSubjectList(list, label) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`AssetOwnership: ${label} 须为数组`);
  const out = [];
  const seen = new Set();
  for (const s of list) {
    if (!isValidSubjectId(s)) throw new Error(`AssetOwnership: ${label} 含非法主体 id（${s}）`);
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

/**
 * 资产归属（不可变值对象）：{ assetId, owners:[subjectId…], related:[subjectId…] }
 *  - owners：负责主体集合（owned 范围）；related：相关主体集合（related 范围）
 *  - 去重、深冻结；非法 id → 构造即抛
 */
class AssetOwnership {
  constructor({ assetId, owners = [], related = [] }) {
    if (!isValidAssetId(assetId)) {
      throw new Error(`AssetOwnership: assetId 非法（${assetId}，须 1~128 字符 [a-zA-Z0-9._-]）`);
    }
    this._assetId = assetId;
    this._owners = Object.freeze(assertSubjectList(owners, 'owners'));
    this._related = Object.freeze(assertSubjectList(related, 'related'));
    Object.freeze(this);
  }

  get assetId() { return this._assetId; }
  get owners() { return this._owners; }
  get related() { return this._related; }

  snapshot() {
    return Object.freeze({ assetId: this._assetId, owners: this._owners.slice(), related: this._related.slice() });
  }
}

/** 共享仓储核心：store: Map<assetId, AssetOwnership>；persist: 变更后持久化钩子（内存版 no-op） */
function _core(store, persist = () => {}) {
  return {
    /** 负责主体集合（未知资产 → []） */
    ownersOf(assetId) {
      const r = store.get(assetId);
      return r ? r.owners.slice() : [];
    },
    /** 相关主体集合（未知资产 → []） */
    relatedOf(assetId) {
      const r = store.get(assetId);
      return r ? r.related.slice() : [];
    },
    /** 主体是否负责该资产（owned 范围判定） */
    isOwnedBy(subjectId, assetId) {
      const r = store.get(assetId);
      return r ? r.owners.includes(subjectId) : false;
    },
    /** 主体是否与该资产相关（related 范围判定） */
    isRelatedTo(subjectId, assetId) {
      const r = store.get(assetId);
      return r ? r.related.includes(subjectId) : false;
    },
    /** 该主体负责的资产集合 */
    listOwnedBy(subjectId) {
      const out = [];
      for (const r of store.values()) if (r.owners.includes(subjectId)) out.push(r.assetId);
      return out;
    },
    upsert(rec) {
      const r = rec instanceof AssetOwnership ? rec : new AssetOwnership(rec);
      store.set(r.assetId, r);
      persist();
      return r;
    },
    all() { return [...store.values()]; },
    count() { return store.size; },
  };
}

function createAssetOwnershipRepo({ file, ownership = [] } = {}) {
  if (!file || typeof file !== 'string' || file.length === 0) {
    throw new Error('createAssetOwnershipRepo: file 必填（JSON 文件路径）');
  }
  const _store = new Map();

  function _load() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.ownership)) throw new Error('ownership 文件结构非法（须 { ownership: [...] }）');
      return data;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e; // 其他读错误 → fail-closed
    }
  }

  const data = _load();
  if (data) {
    for (const rec of data.ownership) {
      try {
        const r = new AssetOwnership({ assetId: rec.assetId, owners: rec.owners, related: rec.related });
        _store.set(r.assetId, r);
      } catch (e) {
        throw new Error(`ownership 文件加载失败（${file}）：${e.message}`);
      }
    }
  } else if (ownership.length > 0) {
    for (const seed of ownership) {
      const r = seed instanceof AssetOwnership ? seed : new AssetOwnership(seed);
      _store.set(r.assetId, r);
    }
  }

  function _save() {
    const payload = JSON.stringify({ version: 1, ownership: [..._store.values()].map(r => r.snapshot()) }, null, 2);
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, file); // 原子替换
    } catch (e) {
      throw new Error(`ownership 仓储写入失败（fail-closed）——${e.message}`);
    }
  }

  if (data === null && ownership.length > 0) _save(); // 种子初始化落盘

  return _core(_store, _save);
}

/** 内存版（契约测试/开发用；与文件版同契，不落盘） */
function createAssetOwnershipRepoMemory(ownership = []) {
  const _store = new Map();
  for (const seed of ownership) {
    const r = seed instanceof AssetOwnership ? seed : new AssetOwnership(seed);
    _store.set(r.assetId, r);
  }
  return _core(_store);
}

module.exports = { AssetOwnership, isValidSubjectId, createAssetOwnershipRepo, createAssetOwnershipRepoMemory };
