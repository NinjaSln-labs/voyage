// audit 内存仓储（契约测试用）：穿透到 AppendOnlyAuditChain；含 persist 桩供链重建

'use strict';

const { AppendOnlyAuditChain } = require('./domain.js');

/** 内存持久化桩（真实介质 M6）：save/load 往返可验证链重建 */
function createMemoryPersist() {
  let _head = null;
  let _chain = [];
  return {
    load() { return _chain.length ? { head: _head, chain: _chain } : null; },
    save(head, chain) {
      _head = head;
      _chain = chain.map(r => r); // 拷贝引用（chainRefs 已冻结）
    },
  };
}

/** 审计仓储：封装 AppendOnlyAuditChain（端口 { write, writeBuffered, flushBuffer, verify, tailHash, length, entries, bufferLength }） */
function createAuditRepo({ persist = null } = {}) {
  const chain = new AppendOnlyAuditChain({ persist });
  return {
    chain,

    /** 写审计五元组（INV-U1：写失败由 AuditEntry/链构造抛错 → 上层 fail-closed） */
    write(entry) {
      return chain.append(entry);
    },

    /** 降级态缓冲（审批豁免通道） */
    writeBuffered(entry) {
      return chain.appendBuffered(entry);
    },

    flushBuffer(now) { return chain.flushBuffer(now); },

    /** 篡改检测 */
    verify() { return chain.verify(); },

    tailHash() { return chain.tailHash; },
    length() { return chain.length; },
    entries() { return chain.entries(); },
    bufferLength() { return chain.bufferLength; },
  };
}

module.exports = { createMemoryPersist, createAuditRepo };