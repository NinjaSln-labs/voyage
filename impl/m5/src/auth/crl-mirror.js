// CRL 吊销镜像（mTLS 吊销集自动化）：外部吊销源 → 定时拉取 → 差量同步 → 审计留痕
// 依据：RQ-611（CRL 维护）+ auth-adapter mtlsRevoked 集的自动化镜像
// 职责边界：CRL/OCSP 的 DER 解析归部署侧 source 适配（本层消费指纹数组，零依赖不做 ASN.1）
// 安全模型：
//  - fail-closed：source 拉取失败/返回非法 → 保留当前吊销集不变（宁可多拒不放行）
//  - 与 authAdapter 共享同一个 Set 实例（mtlsRevoked 注入同源），同步即生效
//  - 变更审计：每次刷新差量（added/removed/total）经 auditPort 留痕（对齐 keyVault.resolve 留痕口径）

'use strict';

const FP_RE = /^[a-f0-9]{64}$/;

/**
 * CRL 吊销镜像工厂
 * @param {object} opts
 *  - revokedSet: Set<string> 与 createAuthAdapter({ mtlsRevoked }) 共享的同一实例
 *  - source: async () => string[] 吊销指纹列表（部署侧适配 JSON 端点 / CRL 文件解析）
 *  - auditPort: { write(fiveTuple) } | null 审计出口（组合根 auditWrite 兼容）
 *  - intervalMs: number|null 定时刷新周期；null = 仅手动 refresh()；start() 需要
 *  - allowEmpty: boolean 源返回空数组是否接受（默认 false——「成功但空」极可能是源故障，
 *    空集等于全量解除吊销，fail-closed 默认拒绝并保留原集；确有全量过期场景显式开启）
 *  - timeSource: () => Date
 */
function createCrlMirror({ revokedSet, source, auditPort = null, intervalMs = null, allowEmpty = false, timeSource = () => new Date() } = {}) {
  if (!(revokedSet instanceof Set)) throw new Error('createCrlMirror: revokedSet 必填（与 authAdapter 共享的 Set 实例）');
  if (typeof source !== 'function') throw new Error('createCrlMirror: source 必填（async () => string[]）');
  if (intervalMs !== null && (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0)) {
    throw new Error('createCrlMirror: intervalMs 须为正有限数值或 null');
  }
  let _timer = null;
  let _refreshCount = 0;
  let _lastError = null;
  let _refreshing = false; // 防重入（上一次拉取未完成不叠加）

  function _audit(links, result) {
    if (!auditPort || typeof auditPort.write !== 'function') return;
    try {
      auditPort.write({
        who: 'system', when: timeSource(), from: 'crl.mirror',
        action: { intent: 'query', capability: 'credential_revoke_sync', target: 'crl-mirror', paramsSchemaOk: true },
        result, links,
      });
    } catch (e) { /* 审计失败不影响吊销同步本身（与 keyVault 留痕同语义） */ }
  }

  /**
   * 拉取并差量同步。返回 { ok, added, removed, total, invalid?|reason? }
   * 失败时保留原集（fail-closed），错误记 _lastError 并审计 rejected。
   */
  async function refresh() {
    if (_refreshing) return { ok: false, reason: 'refresh_in_progress' };
    _refreshing = true;
    try {
      const raw = await source();
      if (!Array.isArray(raw)) {
        _lastError = 'source_not_array';
        _audit({ reason: _lastError }, 'rejected');
        return { ok: false, reason: _lastError };
      }
      const valid = [...new Set(raw.filter(f => typeof f === 'string' && FP_RE.test(f.toLowerCase())).map(f => f.toLowerCase()))];
      const invalidCount = raw.length - valid.length;
      // 审计修复（CRL 初审 P0）：空源默认拒绝——空集 = 全量解除吊销，是源故障的典型形状；
      // 默认 fail-closed 保留原集，确需清空的部署显式 allowEmpty:true
      if (valid.length === 0 && !allowEmpty) {
        _lastError = 'empty_source';
        _audit({ reason: _lastError, invalid: invalidCount }, 'rejected');
        return { ok: false, reason: _lastError };
      }
      const next = new Set(valid);
      const prev = new Set(revokedSet);
      const added = valid.filter(f => !prev.has(f));
      const removed = [...prev].filter(f => !next.has(f)); // 审计修复（P2）：Set 判定替代数组 includes（O(n²)→O(n)）
      revokedSet.clear();
      for (const f of valid) revokedSet.add(f);
      _refreshCount += 1;
      _lastError = null;
      _audit({ added: added.length, removed: removed.length, total: valid.length, invalid: invalidCount }, 'success');
      return { ok: true, added: added.length, removed: removed.length, total: valid.length, invalid: invalidCount };
    } catch (e) {
      _lastError = e && e.message ? e.message : 'source_error';
      _audit({ reason: _lastError }, 'rejected');
      return { ok: false, reason: 'source_error', detail: _lastError };
    } finally {
      _refreshing = false;
    }
  }

  return {
    /** 手动刷新 */
    refresh,

    /** 启动定时刷新（intervalMs 构造时必须已配置）；幂等 */
    start() {
      if (_timer) return { ok: true, alreadyRunning: true };
      if (intervalMs === null) throw new Error('crlMirror.start: intervalMs 未配置（构造 opts.intervalMs）');
      _timer = setInterval(() => { void refresh(); }, intervalMs);
      if (typeof _timer.unref === 'function') _timer.unref(); // 不阻止进程退出
      return { ok: true };
    },

    /** 停止定时刷新；幂等 */
    stop() {
      if (_timer) { clearInterval(_timer); _timer = null; }
      return { ok: true };
    },

    /** 观测（不含指纹值——只暴露计数，防泄漏） */
    stats() {
      return { size: revokedSet.size, refreshCount: _refreshCount, lastError: _lastError, running: _timer !== null };
    },
  };
}

module.exports = { createCrlMirror };
