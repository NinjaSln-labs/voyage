// audit 持久化适配器 · 文件 JSONL（真实部署过渡方案，零依赖）
// 依据：ADAPTER-CONTRACTS.md §3（auditStoragePort：append-only ≥180 天 · 不可覆写/删除 · write fail → fail-closed）
// 实现：每 entry 追加一行 JSON（append-only），启动时全量读取重建链；save 只追加增量（不重写历史，防覆写面）
// 原则：append-only（fs.appendFileSync 只增不覆写）；不可删除/修改历史行；write 失败抛错 → 上层 fail-closed（INV-U1）
// 替换条件：createAuditRepo({ persist: createFilePersist({ file }) })——接口与 createMemoryPersist 同契

'use strict';

const fs = require('node:fs');

/**
 * 文件 JSONL 持久化（M5 AppendOnlyAuditChain.persist 端口实现）
 *  - load() → { head, chain } | null（启动重建；文件不存在/空 → null）
 *  - save(head, chain) → 仅追加新增行（以 seq 增量判断），返回 { ok, appended }
 * 约束：append-only；历史行不可改/删；文件写入失败抛错（fail-closed）
 */
function createFilePersist({ file }) {
  if (!file || typeof file !== 'string' || file.length === 0) {
    throw new Error('createFilePersist: file 必填（JSONL 文件路径）');
  }
  // 已落盘的最大 seq（增量追加用；load 时同步）
  let _flushedSeq = 0;

  function _readAll() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) return [];
      return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    } catch (e) {
      if (e.code === 'ENOENT') return []; // 文件不存在 = 空链
      throw e; // 其他读错误 → fail-closed
    }
  }

  return {
    load() {
      const lines = _readAll();
      if (lines.length === 0) return null;
      _flushedSeq = lines.reduce((max, l) => Math.max(max, l.seq || 0), 0);
      return { head: lines[lines.length - 1].chainHash, chain: lines.map(l => ({ seq: l.seq, chainHash: l.chainHash, entry: l.entry })) };
    },

    save(head, chain) {
      // chain 为 entries() 快照（五元组在顶层：who/when/from/action/result/links）
      // 只追加新增 entry（seq > _flushedSeq），不重写历史——append-only 防覆写
      const fresh = (chain || []).filter(r => r.seq > _flushedSeq).sort((a, b) => a.seq - b.seq);
      let appended = 0;
      for (const r of fresh) {
        // 从快照重构 entry 对象（快照无 entry 字段，五元组在顶层）
        const entry = {
          who: r.who, when: r.when, from: r.from,
          action: r.action, result: r.result, links: r.links,
        };
        const line = JSON.stringify({ seq: r.seq, chainHash: r.chainHash, entry }) + '\n';
        try {
          fs.appendFileSync(file, line, 'utf8'); // 追加模式：只增不覆写
          appended += 1;
        } catch (e) {
          throw new Error(`audit persist: 写入失败（fail-closed INV-U1）——${e.message}`);
        }
      }
      _flushedSeq = Math.max(_flushedSeq, ...fresh.map(r => r.seq));
      return { ok: true, appended };
    },
  };
}

module.exports = { createFilePersist };