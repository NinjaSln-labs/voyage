// 评测三集季度轮换执行器 + 对比报告（t000004 / RQ-721 季度轮换）
// 依据：docs/AI评测策略.md 三集制（公开/隐藏/红队）+ §5 快照回归基准 + RQ-721（隐藏集按季度轮换）
// 复用：eval-gate.js 的 loadSetDir / sampleHash / HIGH_RISK_HIDDEN_MIN（不重复造集合加载）
// 职责：加载三集 → 前置校验（fail-closed）→ 季对季轮换检测 → 归档（仅元数据，隔离集样本不外流）→ 产出对比报告
// 边界：本脚本不生成隐藏样本（独立评测岗双人职责，RQ-721 非开发侧可自决）；只校验轮换是否已发生并留痕
//
// 用法：node eval-rotate.js --quarter 2026-Q3 \
//         --public <公开集根目录> --hidden <隐藏集根目录> --redteam <红队集根目录> \
//         --archive <归档根目录> --reports <报告输出目录> [--snapshot <快照 JSONL>]
// 退出码：0 = 通过（含首次建账）；1 = 轮换前置/有效性 FAIL（供 systemd/告警可见）

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadSetDir, sampleHash, HIGH_RISK_HIDDEN_MIN } = require('./eval-gate.js');

const PARTS = Object.freeze(['public', 'hidden', 'redteam']);

// ---------- 季度工具（纯函数） ----------

/** 解析季度标签 YYYY-Qn → { year, q }；非法即抛 */
function parseQuarter(tag) {
  const m = /^(\d{4})-Q([1-4])$/.exec(String(tag || ''));
  if (!m) throw new Error(`eval-rotate: 季度标签非法（${tag}，须 YYYY-Qn）`);
  return { year: Number(m[1]), q: Number(m[2]) };
}

function formatQuarter(year, q) {
  return `${year}-Q${q}`;
}

/** 上一季（含跨年回卷：2026-Q1 → 2025-Q4） */
function prevQuarter(tag) {
  const { year, q } = parseQuarter(tag);
  return q === 1 ? formatQuarter(year - 1, 4) : formatQuarter(year, q - 1);
}

/** 日期 → 季度标签（Q1=1-3月 … Q4=10-12月） */
function quarterOf(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('eval-rotate: quarterOf 非法日期');
  return formatQuarter(d.getFullYear(), Math.floor(d.getMonth() / 3) + 1);
}

/** 解析 --quarter 取值：显式 YYYY-Qn 或 'auto'（按 date 取当季）；非法即抛 */
function resolveQuarter(tag, date = new Date()) {
  if (tag === 'auto' || tag == null) return quarterOf(date);
  parseQuarter(tag);
  return tag;
}

// ---------- 集合加载 ----------

/** 加载 manifest 形态的集合根目录（public/hidden）：setType → [loaded] */
function loadManifestSets(root, label) {
  if (!root || !fs.existsSync(root)) throw new Error(`eval-rotate(${label}): 目录不存在（${root}）`);
  const out = {};
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) continue;
    const loaded = loadSetDir(dir, `${label}/${name}`);
    out[loaded.version.setType] = out[loaded.version.setType] || [];
    out[loaded.version.setType].push(loaded);
  }
  return out;
}

/** 把一个 part 下的全部集合汇总为一条对比记录（仅元数据） */
function summarize(loadeds) {
  const list = loadeds.filter(Boolean);
  const versionIds = list.map(l => l.version.id).sort();
  const hashes = list.map(l => l.contentHash);
  const contentHash = crypto.createHash('sha256').update(hashes.join('|')).digest('hex').slice(0, 32);
  const sampleCount = list.reduce((a, l) => a + l.samples.length, 0);
  const highRiskCount = list.filter(l => l.version.setType === 'high_risk').reduce((a, l) => a + l.samples.length, 0);
  const maintainers = [...new Set(list.flatMap(l => l.version.maintainers))].sort();
  const types = [...new Set(list.map(l => l.version.setType))].sort();
  return { versionIds, contentHash, sampleCount, highRiskCount, maintainers, types };
}

function flattenSets(byType) {
  return Object.values(byType).flat();
}

/**
 * 加载红队集（双形态）：
 *  - manifest 形态：目录含带 manifest.json 的子目录 → loadSetDir
 *  - 扁平周更形态：目录含 redteam-*.json（服务器 gen-redteam-weekly 产物）→ 聚合全部周文件
 *  返回对比记录（仅元数据，不含样本）
 */
function loadRedteam(root, label = 'redteam') {
  if (!root || !fs.existsSync(root)) throw new Error(`eval-rotate(${label}): 目录不存在（${root}）`);
  const entries = fs.readdirSync(root);
  const manifestDirs = entries.filter(n => {
    const p = path.join(root, n);
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'manifest.json'));
  });
  if (manifestDirs.length) {
    return summarize(manifestDirs.map(n => loadSetDir(path.join(root, n), `${label}/${n}`)));
  }
  // 扁平周更文件聚合
  const files = entries.filter(n => /^redteam-.*\.json$/.test(n) && !/\.bak/.test(n)).sort();
  const samples = [];
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.samples || []);
    for (const s of arr) if (s && s.id && s.input) samples.push(s);
  }
  const hashes = samples.map(s => sampleHash(s, 'expected'));
  const contentHash = crypto.createHash('sha256').update(hashes.join('|')).digest('hex').slice(0, 32);
  return {
    versionIds: [`redteam-flat-${samples.length}`],
    contentHash,
    sampleCount: samples.length,
    highRiskCount: samples.length,
    maintainers: ['ai-redteam', 'project-owner'],
    types: ['high_risk'],
  };
}

// ---------- 轮换检测 ----------

/** 分类本季相对上季的变更 */
function classify(prev, curr) {
  if (!prev) return 'no-prev';
  const versionChanged = JSON.stringify(prev.versionIds || []) !== JSON.stringify(curr.versionIds || []);
  const hashChanged = prev.contentHash !== curr.contentHash;
  if (!versionChanged && !hashChanged) return 'unchanged';
  if (hashChanged && !versionChanged) return 'amended'; // 改内容不换版本号（违规）
  return 'rotated';
}

/** 判定某 part 的轮换是否 FAIL（隐藏集必须按季推进；任何 part「改集不换版」即违规） */
function judge(part, status) {
  if (status === 'amended') return { fail: true, reason: '改集不换版（contentHash 变而 versionId 未推进）' };
  if (part === 'hidden' && status === 'unchanged') return { fail: true, reason: '隐藏集未按季轮换（RQ-721）' };
  return { fail: false, reason: null };
}

// ---------- 报告渲染 ----------

const STATUS_LABEL = { rotated: '✅ 已轮换', amended: '❌ 改集不换版', unchanged: '○ 未变', 'no-prev': '— 无上季记录' };

function renderReport({ quarter, at, modelVersion, promptVersion, firstBaseline, sets, verdicts, problems, snapshot }) {
  const L = [];
  L.push(`# 评测三集季度轮换对比报告 — ${quarter}`);
  L.push('');
  L.push(`> 生成时间：${at} · modelVersion：${modelVersion || 'N/A'} · promptVersion：${promptVersion || 'N/A'}`);
  L.push('> 依据：`docs/AI评测策略.md` 三集制 + RQ-721（隐藏集按季度轮换）');
  L.push('');
  const anyFail = problems.length > 0 || PARTS.some(p => verdicts[p].fail);
  const verdictText = anyFail
    ? (verdicts.hidden.status === 'unchanged' || verdicts.hidden.status === 'no-prev' ? '未轮换（隐藏集版本未推进）' : '校验未通过')
    : (firstBaseline ? '首次建账' : '轮换完成');
  L.push(`## 判定：${verdictText}`);
  L.push('');
  L.push('| 集 | 上季版本 | 本季版本 | 指纹变更 | 条数 | 判定 | 备注 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const part of PARTS) {
    const v = verdicts[part];
    const prevIds = v.prev ? (v.prev.versionIds || []).join(', ') : '—';
    const currIds = currIdsOf(sets, part);
    L.push(`| ${part} | ${prevIds} | ${currIds} | ${v.hashChanged ? '是' : '否'} | ${sets[part].sampleCount} | ${STATUS_LABEL[v.status] || v.status} | ${v.reason || ''} |`);
  }
  L.push('');
  if (problems.length) {
    L.push('### 前置校验问题');
    for (const p of problems) L.push(`- ❌ ${p}`);
    L.push('');
  }
  L.push('## 高危召回（三集分别 100%（AND））');
  L.push('');
  L.push('| 集 | 高危条数 | 分集召回 |');
  L.push('|---|---|---|');
  for (const part of PARTS) {
    L.push(`| ${part} | ${sets[part].highRiskCount} | N/A（未接入分集打分） |`);
  }
  L.push('');
  const combined = snapshot && snapshot.scores && snapshot.scores.high_risk ? snapshot.scores.high_risk.recall : null;
  L.push(`> 快照合并高危召回：${combined === null ? 'N/A（未接入真实打分）' : combined}（modelVersion：${modelVersion || 'N/A'}；合并值口径，非三集分列）。`);
  L.push('> 高危召回硬线由评测门禁（`eval-gate.js`）按三集分别 AND 判定；本报告不重复计算，仅登记规模与快照口径。');
  L.push('');
  L.push('## 归档');
  L.push('');
  L.push('- 归档记录仅含**元数据**（版本号/内容指纹/条数/维护者），**不含任何隐藏样本**（隔离原则）。');
  if (firstBaseline) L.push('- 本季为**首次建账**（无上一季归档记录），不参与季对季轮换判定。');
  L.push('');
  return L.join('\n');
}

function currIdsOf(sets, part) {
  return (sets[part].versionIds || []).join(', ');
}

// ---------- 主流程 ----------

function readLastJsonl(file) {
  if (!file || !fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1]); } catch (e) { return null; }
}

/**
 * 执行一次季度轮换
 * @param {object} opts
 *  - quarter: 'YYYY-Qn'
 *  - publicDir/hiddenDir/redteamDir: 三集根目录
 *  - archiveDir: 归档根目录（写 <archiveDir>/<quarter>/rotation.json + rotation-history.jsonl）
 *  - reportsDir: 报告输出目录（写 rotate-<quarter>.md）
 *  - snapshotFile: 评测快照 JSONL（取末行读 modelVersion/promptVersion/scores；可选）
 *  - timeSource: () => Date
 * @returns { quarter, firstBaseline, failed, verdicts, problems, reportPath, archivePath }
 */
function rotate(opts) {
  const {
    publicDir, hiddenDir, redteamDir, archiveDir, reportsDir,
    snapshotFile = null, timeSource = () => new Date(),
  } = opts;
  const quarter = resolveQuarter(opts.quarter, timeSource()); // 非法即抛（fail-closed）
  if (!archiveDir || !reportsDir) throw new Error('eval-rotate: archiveDir / reportsDir 必填');

  const pub = loadManifestSets(publicDir, 'public');
  const hid = loadManifestSets(hiddenDir, 'hidden');
  const sets = {
    public: summarize(flattenSets(pub)),
    hidden: summarize(flattenSets(hid)),
    redteam: loadRedteam(redteamDir, 'redteam'),
  };

  // 前置校验（fail-closed）
  const problems = [];
  for (const part of PARTS) {
    if (!sets[part].sampleCount) problems.push(`${part} 集为空`);
  }
  if (sets.hidden.sampleCount > 0 && !(sets.hidden.sampleCount > HIGH_RISK_HIDDEN_MIN)) {
    problems.push(`隐藏高危集 ${sets.hidden.sampleCount}≤${HIGH_RISK_HIDDEN_MIN}（三集制要求 >50）`);
  }

  // 上一季归档
  const prevTag = prevQuarter(quarter);
  const prevFile = path.join(archiveDir, prevTag, 'rotation.json');
  const prev = fs.existsSync(prevFile) ? JSON.parse(fs.readFileSync(prevFile, 'utf8')) : null;
  const firstBaseline = !prev;

  const verdicts = {};
  for (const part of PARTS) {
    const prevRec = prev && prev.sets ? prev.sets[part] : null;
    const status = classify(prevRec, sets[part]);
    const { fail, reason } = judge(part, status);
    verdicts[part] = {
      status, fail, reason, prev: prevRec,
      hashChanged: prevRec ? prevRec.contentHash !== sets[part].contentHash : true,
    };
  }

  const failed = problems.length > 0 || PARTS.some(p => verdicts[p].fail);

  const snap = readLastJsonl(snapshotFile);
  const at = timeSource().toISOString();
  const modelVersion = snap ? snap.modelVersion : null;
  const promptVersion = snap ? snap.promptVersion : null;

  // 归档（仅元数据；绝不写入 samples）
  const qDir = path.join(archiveDir, quarter);
  fs.mkdirSync(qDir, { recursive: true });
  const archivePath = path.join(qDir, 'rotation.json');
  fs.writeFileSync(archivePath, JSON.stringify({
    quarter, at, modelVersion, promptVersion, firstBaseline, failed,
    sets, verdicts: Object.fromEntries(PARTS.map(p => [p, { status: verdicts[p].status, fail: verdicts[p].fail, reason: verdicts[p].reason }])),
    problems,
  }, null, 2) + '\n');
  fs.appendFileSync(path.join(archiveDir, 'rotation-history.jsonl'),
    JSON.stringify({ quarter, at, failed, firstBaseline }) + '\n');

  // 对比报告
  const md = renderReport({ quarter, at, modelVersion, promptVersion, firstBaseline, sets, verdicts, problems, snapshot: snap });
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `rotate-${quarter}.md`);
  fs.writeFileSync(reportPath, md);

  return { quarter, firstBaseline, failed, verdicts, problems, reportPath, archivePath };
}

// ---------- CLI ----------

function parseCli(argv) {
  const out = { quarter: null, publicDir: null, hiddenDir: null, redteamDir: null, archiveDir: null, reportsDir: null, snapshotFile: null };
  const map = { '--quarter': 'quarter', '--public': 'publicDir', '--hidden': 'hiddenDir', '--redteam': 'redteamDir', '--archive': 'archiveDir', '--reports': 'reportsDir', '--snapshot': 'snapshotFile' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (map[a]) { out[map[a]] = argv[++i]; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    throw new Error(`eval-rotate: 未知参数 ${a}`);
  }
  return out;
}

function usage() {
  return [
    '用法: node eval-rotate.js --quarter YYYY-Qn|auto',
    '  --public <dir>   公开集根目录（仓库 eval-sets）',
    '  --hidden <dir>   隐藏集根目录（隔离）',
    '  --redteam <dir>  红队集根目录（manifest 或扁平周更文件）',
    '  --archive <dir>  归档根目录',
    '  --reports <dir>  报告输出目录',
    '  [--snapshot <file>] 评测快照 JSONL（可选）',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseCli(argv); } catch (e) { console.error(e.message); console.error(usage()); return 2; }
  if (args.help) { console.log(usage()); return 0; }
  const required = ['quarter', 'publicDir', 'hiddenDir', 'redteamDir', 'archiveDir', 'reportsDir'];
  const missing = required.filter(k => !args[k]);
  if (missing.length) { console.error(`eval-rotate: 缺必填参数 ${missing.join(', ')}`); console.error(usage()); return 2; }

  let r;
  try { r = rotate(args); } catch (e) { console.error(`eval-rotate: FAIL — ${e.message}`); return 1; }

  console.log(`[eval-rotate] ${r.quarter} 判定：${r.failed ? '未通过' : (r.firstBaseline ? '首次建账' : '轮换完成')}`);
  for (const part of PARTS) console.log(`  - ${part}: ${r.verdicts[part].status}${r.verdicts[part].reason ? '（' + r.verdicts[part].reason + '）' : ''}`);
  for (const p of r.problems) console.log(`  ! ${p}`);
  console.log(`  报告：${r.reportPath}`);
  console.log(`  归档：${r.archivePath}`);
  return r.failed ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  parseQuarter, prevQuarter, quarterOf, formatQuarter, resolveQuarter,
  loadManifestSets, loadRedteam, summarize, classify, judge, renderReport, rotate, main,
  PARTS,
};
