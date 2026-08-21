// 身份/角色仓储适配器 · 文件 JSON 持久化（真实部署过渡方案，零依赖）
// 依据：ADAPTER-CONTRACTS.md §4（identityRepoPort：findById/findByRole → { identity: { id, role, capabilities, active } }）
//      INV-I1（IdP 签名白名单/claim 白名单——本文件版为受控本地身份库，角色/能力仅从受管配置读取，不信任自报）
//      INV-I2（身份组变更会话即时刷新——本文件版以「读取时投影」实现：变更即生效，最迟下轮交互）
//      产品说明书 §4.2 能力×角色权限矩阵（唯一口径）
// 原则：零依赖 JSON 文件（启动 load 全量进内存，save 原子覆写+备份）；角色→能力投影单源在 ROLE_CAPABILITIES；
//      active=false 的 identity 不参与任何判定（fail-closed）；写失败抛错 → 上层 fail-closed
// 替换条件：createIdentityRepo({ file, roles })——接口与 createIdentityRepoMemory 同契

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------- 角色 → 能力投影（产品说明书 §4.2 唯一口径；只读、受管配置） ----------
// 能力名对齐 M3 trust.WHITELIST_CAPABILITIES / QUERY_CAPABILITIES / 矩阵行
// 图例：✅ 可直接 · ⚠️ 需审批或受限 · ❌ 禁止（本投影只收录 ✅/⚠️ 的准入；❌ 不录入即视为拒绝）
const ROLE_CAPABILITIES = Object.freeze({
  sre: Object.freeze([
    // 全部能力：查询/执行/审批/审计
    'query_status', 'query_health', 'query_metric', 'query_log',
    'restart', 'clean', 'scale', 'config_change', 'env_switch',
    'approve', 'audit_query',
  ]),
  dev: Object.freeze([
    // 研发：查询全部 + 自己服务重启/清理（高危需审批）+ 定时编排（⚠️）
    'query_status', 'query_health', 'query_metric', 'query_log',
    'restart', 'clean', 'schedule',
  ]),
  test: Object.freeze([
    // 测试/产品：只读 + 相关服务只读
    'query_status', 'query_health', 'query_metric', 'query_log',
  ]),
  manager: Object.freeze([
    // 管理者：只读大盘 + 汇总报表
    'query_health', 'query_metric', 'audit_summary',
  ]),
});

/** 角色合法性校验（fail-fast：未知角色直接拒绝，防伪造角色声明） */
function isValidRole(role) {
  return typeof role === 'string' && Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, role);
}

/**
 * 身份对象（不可变值对象）：{ id, role, capabilities, active }
 *  - capabilities 由角色投影派生（单源 ROLE_CAPABILITIES），不接受外部传入（防自报能力伪造）
 *  - active=false → 判定侧 fail-closed（INV-I2 吊销即时生效）
 */
class Identity {
  constructor({ id, role, active = true }) {
    if (!id || typeof id !== 'string' || id.length === 0 || id.length > 128) {
      throw new Error(`Identity: id 非法（须 1~128 字符字符串）`);
    }
    if (!isValidRole(role)) throw new Error(`Identity: 角色非法（${role}，须为受管角色）`);
    if (typeof active !== 'boolean') throw new Error('Identity: active 必须为布尔');
    this._id = id;
    this._role = role;
    this._active = active;
    // 投影派生能力（单源；禁止外部传入能力清单）
    this._capabilities = ROLE_CAPABILITIES[role];
    Object.freeze(this);
  }

  get id() { return this._id; }
  get role() { return this._role; }
  get capabilities() { return this._capabilities; }
  get active() { return this._active; }

  /** 是否具备某能力（投影判定；active=false 一律 false，fail-closed） */
  hasCapability(cap) {
    if (!this._active) return false;
    return this._capabilities.includes(cap);
  }

  /** 脱敏快照（不暴露内部引用；审计用） */
  snapshot() {
    return Object.freeze({
      id: this._id, role: this._role,
      capabilities: this._capabilities.slice(),
      active: this._active,
    });
  }
}

/**
 * 文件 JSON 持久化身份仓储（identityRepoPort 落地）
 *  - load() → { identities: Identity[] } | null（启动重建；文件不存在 → null）
 *  - save() → 原子覆写（写临时文件 + rename，防半写损坏）；写失败抛错（fail-closed）
 *  - findById(id) → Identity | null
 *  - findByRole(role) → Identity[]（只返回 active 的，fail-closed）
 *  - upsert(identity) → 新增/更新（同 id 覆写；角色变更即时生效——INV-I2 最迟下轮交互）
 */
function createIdentityRepo({ file, identities = [] } = {}) {
  if (!file || typeof file !== 'string' || file.length === 0) {
    throw new Error('createIdentityRepo: file 必填（JSON 文件路径）');
  }
  let _store = new Map(); // id → Identity

  function _load() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.identities)) throw new Error('identity 文件结构非法（须 { identities: [...] }）');
      return data;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e; // 其他读错误 → fail-closed
    }
  }

  // 启动加载（构造即恢复；损坏/非法行 → fail-fast）
  const data = _load();
  if (data) {
    for (const rec of data.identities) {
      try {
        const idn = new Identity({ id: rec.id, role: rec.role, active: rec.active !== false });
        _store.set(idn.id, idn);
      } catch (e) {
        throw new Error(`identity 文件加载失败（${file}）：${e.message}`);
      }
    }
  } else if (identities.length > 0) {
    // 首次启动以调用方提供种子初始化（真实部署：从 LDAP/IdP 导入的受管身份）
    for (const seed of identities) {
      const idn = seed instanceof Identity ? seed : new Identity(seed);
      _store.set(idn.id, idn);
    }
    _save();
  }

  function _save() {
    const payload = JSON.stringify({
      version: 1,
      identities: [..._store.values()].map(i => i.snapshot()),
    }, null, 2);
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, file); // 原子替换，防半写损坏
    } catch (e) {
      throw new Error(`identity 仓储写入失败（fail-closed）——${e.message}`);
    }
  }

  return {
    /** 查询单身份；不存在 → null；active=false 仍返回（供判定侧可见吊销状态） */
    findById(id) {
      return _store.get(id) || null;
    },

    /** 按角色查询；只返回 active 的（fail-closed：吊销/停用身份不参与任何判定） */
    findByRole(role) {
      if (!isValidRole(role)) return [];
      return [..._store.values()].filter(i => i.active && i.role === role);
    },

    /** 新增/更新身份（角色变更即时生效；写盘失败抛错 fail-closed） */
    upsert(identity) {
      const idn = identity instanceof Identity ? identity : new Identity(identity);
      _store.set(idn.id, idn);
      _save();
      return idn;
    },

    /** 全部身份（含停用；管理/审计用） */
    all() {
      return [..._store.values()];
    },

    /** 持久化状态（管理用） */
    count() { return _store.size; },
  };
}

/** 内存版（契约测试/开发用；与文件版同契，不落盘） */
function createIdentityRepoMemory(identities = []) {
  const _store = new Map();
  for (const seed of identities) {
    const idn = seed instanceof Identity ? seed : new Identity(seed);
    _store.set(idn.id, idn);
  }
  return {
    findById(id) { return _store.get(id) || null; },
    findByRole(role) {
      if (!isValidRole(role)) return [];
      return [..._store.values()].filter(i => i.active && i.role === role);
    },
    upsert(identity) {
      const idn = identity instanceof Identity ? identity : new Identity(identity);
      _store.set(idn.id, idn);
      return idn;
    },
    all() { return [..._store.values()]; },
    count() { return _store.size; },
  };
}

module.exports = { Identity, ROLE_CAPABILITIES, isValidRole, createIdentityRepo, createIdentityRepoMemory };
