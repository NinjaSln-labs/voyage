// 评测门禁执行机制（三集制配套基建）：快照绑定 + 隐藏集隔离加载 + 回滚钩子
// 依据：AI评测策略.md §3（三集分别 100% AND）/ §5（快照绑定模型↔评测集版本号、回滚）/ RQ-721
// 职责边界：样本「打分」归真实 LLM 评测（真实部署侧）；本模块消费得分做判定/绑定/落快照/给回滚信号
// 安全模型：
//  - 公开集：仓库内 eval-sets/（manifest 声明版本与维护者）
//  - 隐藏集：外部隔离路径 hiddenDir（仅门禁执行者可读，不入仓库）——manifest 维护者 ≥2 由领域强制（INV-M4）；
//    高危隐藏集 >50 条（三集制硬要求，加载时校验）
//  - 绑定：每次运行对每集计算样本内容哈希（sha256(id|input|expected)）→ 版本内容指纹入快照，防「改集不换版」
//  - 回滚：passed=false 或高危召回 <100% → rollback=true（放量档任一不达标即回滚的钩子语义）
// 维护者口径：公开集 manifest 的 maintainers 为开发侧角色占位——三集制的独立岗要求针对隐藏/红队集
//（外部 hiddenDir），由独立评测岗实名提供，领域构造 ≥2 强制（INV-M4）；公开集占位不替代该要求

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { GateService, EvalSetVersion, DATASET_MINIMUMS, DATASET_KINDS } = require('../m6/src/model/domain.js');

/** 三集制：高危隐藏集下限（策略文档口径「隐藏集 >50 条」） */
const HIGH_RISK_HIDDEN_MIN = 50;

function sampleHash(s, expField) {
  const material = `${s.id}|${s.input}|${s[expField] || ''}`;
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** 加载一个评测集目录：manifest.json（版本声明）+ 样本文件 → { version, samples, contentHash } */
function loadSetDir(dir, label) {
  const mfPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mfPath)) throw new Error(`eval-gate(${label}): 缺 manifest.json（${dir}）`);
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  if (!mf.setType || !DATASET_KINDS.includes(mf.setType)) throw new Error(`eval-gate(${label}): manifest.setType 非法`);
  if (!mf.versionId || typeof mf.versionId !== 'string') throw new Error(`eval-gate(${label}): manifest.versionId 必填`);
  const file = path.join(dir, mf.file || 'samples.json');
  if (!fs.existsSync(file)) throw new Error(`eval-gate(${label}): 样本文件缺失（${file}）`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 审计修复（评测初审 P2）：顶层形状校验——数组/标量静默降级为空集会绕过规模与哈希绑定
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.samples)) {
    throw new Error(`eval-gate(${label}): 样本文件须为 { samples: [...] } 对象（${file}）`);
  }
  const samples = raw.samples;
  const expField = mf.setType === 'term' ? 'standard' : 'expected';
  const usable = samples.filter(s => s.id && s.input && s[expField]);
  const hashes = usable.map(s => sampleHash(s, expField));
  const contentHash = crypto.createHash('sha256').update(hashes.join('|')).digest('hex').slice(0, 32);
  const version = new EvalSetVersion({
    id: mf.versionId,
    setType: mf.setType,
    parts: mf.parts || ['public'],
    sampleHashes: hashes,
    maintainers: mf.maintainers || [],
  }); // maintainers <2 → 领域构造抛错（INV-M4 双人审阅在此强制）
  return { version, samples: usable, contentHash };
}

/**
 * 评测门禁执行器工厂
 * @param {object} opts
 *  - publicDir: 公开集根目录（每集一个子目录含 manifest.json）
 *  - hiddenDir: 隐藏集根目录（外部隔离路径；null = 未配置，仅跑公开集并显式标注 hiddenMissing）
 *  - snapshotFile: 快照 JSONL 追加文件（回归基准，§5）
 *  - modelVersion / promptVersion: 绑定标识（git hash / 提示词版本号）
 *  - eventBus: { publish(event) } | null（ModelGated 事件出口，接审计/metric）
 */
function createEvalGate({ publicDir, hiddenDir = null, snapshotFile, modelVersion = null, promptVersion = null, eventBus = null, timeSource = () => new Date() } = {}) {
  if (!publicDir) throw new Error('createEvalGate: publicDir 必填');
  if (!snapshotFile) throw new Error('createEvalGate: snapshotFile 必填（快照回归基准 §5）');
  const gateService = new GateService({ eventBus });

  /** 收集一側全部集合目录 */
  function collect(root, label) {
    const out = {};
    if (!root || !fs.existsSync(root)) return out;
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const loaded = loadSetDir(dir, `${label}/${name}`);
      out[loaded.version.setType] = out[loaded.version.setType] || [];
      out[loaded.version.setType].push(loaded);
    }
    return out;
  }

  /**
   * 执行一次门禁运行
   * @param {object} p
   *  - scores: { spoken: {accuracy}, knowledge: {accuracy}, term: {recall}, explain: {recall}, faq: {recall}, high_risk: {recall} }
   *  - counterMetrics: { r1, r2, r3 } 反指标（事故计数，须全 0）
   * @returns { passed, rollback, highRiskPass, snapshot, bindings }
   */
  async function run({ scores = {}, counterMetrics = {} } = {}) {
    const pub = collect(publicDir, 'public');
    const hid = hiddenDir ? collect(hiddenDir, 'hidden') : {};

    // 规模前置校验（三集制：隐藏高危 >50；各集总量 ≥ DATASET_MINIMUMS 只约束公开集口径）
    const problems = [];
    for (const [ds, min] of Object.entries(DATASET_MINIMUMS)) {
      const n = (pub[ds] || []).reduce((a, b) => a + b.samples.length, 0);
      if (n < min) problems.push(`公开集 ${ds} ${n}<${min}`);
    }
    let hiddenMissing = false;
    if (!hiddenDir) {
      hiddenMissing = true;
      problems.push('隐藏集未配置（v1.0.0-beta 前必须闭合）');
    } else {
      const hrHid = (hid.high_risk || []).reduce((a, b) => a + b.samples.length, 0);
      if (!(hrHid > HIGH_RISK_HIDDEN_MIN)) problems.push(`隐藏高危集 ${hrHid}≤${HIGH_RISK_HIDDEN_MIN}（三集制要求 >50）`);
    }

    // 版本绑定：setType → 合并版本 id + 内容指纹（同型多集时拼接）
    const bindings = {};
    for (const ds of DATASET_KINDS) {
      const all = [...(pub[ds] || []), ...(hid[ds] || [])];
      if (!all.length) continue;
      bindings[ds] = {
        versionIds: all.map(v => v.version.id),
        contentHashes: all.map(v => v.contentHash),
        parts: [...new Set(all.flatMap(v => v.version.parts))],
        sampleCount: all.reduce((a, b) => a + b.samples.length, 0),
      };
    }

    // 判定（真实打分在外部完成后传入；本层只判阈值 + 反指标 + 高危硬线）
    const r = gateService.evaluate(scores, counterMetrics);
    const passed = r.pass && problems.length === 0;

    // 门禁事件（INV-M1：结果回落事件总线 → 审计）。
    // 审计修复（评测初审 P2）：发布真实 ModelGated 实例（eventId 生成 + 深冻结），不手拼平面对象——
    // 下游消费者依赖 eventId/冻结语义；判定仍单次 evaluate（gate() 会重复计算，纯性能取舍已记录）
    if (eventBus && typeof eventBus.publish === 'function') {
      const { ModelGated } = require('../m6/src/model/domain.js');
      for (const ds of Object.keys(bindings)) {
        eventBus.publish(new ModelGated({
          versionId: bindings[ds].versionIds.join('+'),
          modelVersion,
          passed,
          details: r.details.filter(d => d.dataset === ds),
          at: timeSource(),
        }));
      }
    }

    // 快照落盘（JSONL 追加；一行一次运行，可回溯 §5）
    const snapshot = {
      at: timeSource().toISOString(), modelVersion, promptVersion,
      scores, counterMetrics,
      passed, highRiskPass: r.highRiskPass, rollback: !passed,
      hiddenMissing, problems, bindings,
    };
    fs.appendFileSync(snapshotFile, JSON.stringify(snapshot) + '\n');

    return { passed, rollback: !passed, highRiskPass: r.highRiskPass, snapshot, bindings, details: r.details };
  }

  return { run, gateService };
}

module.exports = { createEvalGate, loadSetDir, HIGH_RISK_HIDDEN_MIN, sampleHash };
