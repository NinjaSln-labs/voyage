// eval-rotate 契约测试：季度数学 / 三集加载（双形态） / 轮换检测 / 首轮建账 / 归档隔离 / 前置 fail-closed
// 依据：docs/AI评测策略.md 三集制 + RQ-721（隐藏集按季度轮换）

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseQuarter, prevQuarter, quarterOf, formatQuarter, resolveQuarter, loadManifestSets, loadRedteam, classify, judge, rotate } = require('./eval-rotate.js');

// ---------- 夹具 ----------

function mkSet(root, name, { setType = 'spoken', versionId, parts = ['public'], maintainers = ['m-a', 'm-b'], count = 3, expected = 'query_status' } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ versionId, setType, parts, file: 'samples.json', maintainers }));
  const samples = Array.from({ length: count }, (_, i) => ({ id: `${name}-${i}`, input: `输入 ${name} ${i}`, expected }));
  fs.writeFileSync(path.join(dir, 'samples.json'), JSON.stringify({ samples }));
  return dir;
}

function mkFixtures(base, { hiddenCount = 60, hiddenVersion = 'high_risk-hidden-v1', hiddenExtra = 0 } = {}) {
  const pub = path.join(base, 'public');
  mkSet(pub, 'spoken', { setType: 'spoken', versionId: 'spoken-public-v1', count: 50 });
  mkSet(pub, 'high_risk', { setType: 'high_risk', versionId: 'high_risk-public-v1', count: 30, expected: 'reject' });
  const hid = path.join(base, 'hidden');
  mkSet(hid, 'high_risk_hidden', { setType: 'high_risk', versionId: hiddenVersion, parts: ['hidden'], maintainers: ['ai-evaluator-a', 'ai-evaluator-b'], count: hiddenCount + hiddenExtra, expected: 'reject' });
  const rt = path.join(base, 'redteam');
  mkSet(rt, 'redteam_v1', { setType: 'high_risk', versionId: 'redteam-v1-w34', parts: ['redteam'], maintainers: ['ai-redteam', 'project-owner'], count: 20, expected: 'reject' });
  return { pub, hid, rt };
}

function mkTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `voyage-${label}-`));
}

// ---------- Q1 季度数学 ----------

test('Q1 季度数学：解析/格式化/上一季/跨年回卷/日期推导', () => {
  assert.deepStrictEqual(parseQuarter('2026-Q3'), { year: 2026, q: 3 });
  assert.throws(() => parseQuarter('2026-Q5'), /季度标签非法/);
  assert.throws(() => parseQuarter('2026-3'), /季度标签非法/);
  assert.strictEqual(formatQuarter(2026, 4), '2026-Q4');
  assert.strictEqual(prevQuarter('2026-Q3'), '2026-Q2');
  assert.strictEqual(prevQuarter('2026-Q1'), '2025-Q4', '跨年回卷');
  assert.strictEqual(quarterOf(new Date(2026, 0, 1)), '2026-Q1', '1月→Q1');
  assert.strictEqual(quarterOf(new Date(2026, 2, 31)), '2026-Q1', '3月→Q1');
  assert.strictEqual(quarterOf(new Date(2026, 11, 31)), '2026-Q4', '12月→Q4');
  assert.throws(() => quarterOf(new Date('bad')), /非法日期/);
  // auto：按给定日期取当季（供定时器使用）
  assert.strictEqual(resolveQuarter('auto', new Date(2026, 9, 1)), '2026-Q4');
  assert.strictEqual(resolveQuarter('2025-Q2', new Date(2026, 9, 1)), '2025-Q2');
  assert.throws(() => resolveQuarter('2026-Q9'), /季度标签非法/);
});

// ---------- Q2 加载 ----------

test('Q2 三集加载：public 多集并入；红队 manifest 与扁平周更两形态', () => {
  const base = mkTmp('rot-load');
  try {
    const f = mkFixtures(base);
    const pub = loadManifestSets(f.pub, 'public');
    assert.deepStrictEqual(Object.keys(pub).sort(), ['high_risk', 'spoken']);
    // 红队 manifest 形态
    const rtManifest = loadRedteam(f.rt, 'redteam');
    assert.strictEqual(rtManifest.sampleCount, 20);
    assert.deepStrictEqual(rtManifest.versionIds, ['redteam-v1-w34']);
    // 红队扁平周更形态
    const flat = path.join(base, 'redteam-flat');
    fs.mkdirSync(flat);
    fs.writeFileSync(path.join(flat, 'redteam-2026-W35.json'), JSON.stringify({ samples: [{ id: 'r1', input: 'x', expected: 'reject' }] }));
    fs.writeFileSync(path.join(flat, 'redteam-2026-W36.json'), JSON.stringify({ samples: [{ id: 'r2', input: 'y', expected: 'reject' }, { id: 'r3', input: 'z', expected: 'reject' }] }));
    fs.writeFileSync(path.join(flat, 'redteam-2026-W36.json.bak-manual'), '{}'); // 备份文件须忽略
    const rtFlat = loadRedteam(flat, 'redteam');
    assert.strictEqual(rtFlat.sampleCount, 3);
    assert.deepStrictEqual(rtFlat.versionIds, ['redteam-flat-3']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ---------- Q3 轮换检测 ----------

test('Q3 轮换检测：rotated/amended/unchanged 分类与判定', () => {
  const v1 = { versionIds: ['h-v1'], contentHash: 'aaa' };
  const v2 = { versionIds: ['h-v2'], contentHash: 'bbb' };
  const amended = { versionIds: ['h-v1'], contentHash: 'zzz' };
  assert.strictEqual(classify(null, v1), 'no-prev');
  assert.strictEqual(classify(v1, v2), 'rotated');
  assert.strictEqual(classify(v1, amended), 'amended');
  assert.strictEqual(classify(v1, { versionIds: ['h-v1'], contentHash: 'aaa' }), 'unchanged');
  // 判定：改集不换版 → FAIL；隐藏集未变 → FAIL；public 未变 → 允许
  assert.strictEqual(judge('public', 'amended').fail, true);
  assert.strictEqual(judge('hidden', 'unchanged').fail, true);
  assert.strictEqual(judge('hidden', 'rotated').fail, false);
  assert.strictEqual(judge('public', 'unchanged').fail, false);
  assert.strictEqual(judge('redteam', 'unchanged').fail, false);
});

// ---------- Q4 首轮建账 vs 未轮换 ----------

test('Q4 首轮建账不判 FAIL；隐藏集版本未推进 → FAIL（未轮换）', () => {
  const base = mkTmp('rot-q4');
  try {
    const f = mkFixtures(base);
    const archive = path.join(base, 'archive');
    const reports = path.join(base, 'reports');
    // 首轮：Q2 建账
    const r1 = rotate({ quarter: '2026-Q2', publicDir: f.pub, hiddenDir: f.hid, redteamDir: f.rt, archiveDir: archive, reportsDir: reports });
    assert.strictEqual(r1.firstBaseline, true, '无上一季记录 → 首次建账');
    assert.strictEqual(r1.failed, false, '首次建账不判 FAIL');
    // 第二季：隐藏集版本未推进 → 未轮换 FAIL
    const r2 = rotate({ quarter: '2026-Q3', publicDir: f.pub, hiddenDir: f.hid, redteamDir: f.rt, archiveDir: archive, reportsDir: reports });
    assert.strictEqual(r2.firstBaseline, false);
    assert.strictEqual(r2.verdicts.hidden.status, 'unchanged');
    assert.strictEqual(r2.verdicts.hidden.fail, true);
    assert.strictEqual(r2.failed, true, '隐藏集未按季轮换 → 整体 FAIL');
    // 第三季：隐藏集换版 → 轮换完成
    fs.rmSync(path.join(f.hid, 'high_risk_hidden'), { recursive: true, force: true });
    mkSet(f.hid, 'high_risk_hidden', { setType: 'high_risk', versionId: 'high_risk-hidden-v2', parts: ['hidden'], maintainers: ['ai-evaluator-a', 'ai-evaluator-b'], count: 62, expected: 'reject' });
    const r3 = rotate({ quarter: '2026-Q4', publicDir: f.pub, hiddenDir: f.hid, redteamDir: f.rt, archiveDir: archive, reportsDir: reports });
    assert.strictEqual(r3.verdicts.hidden.status, 'rotated');
    assert.strictEqual(r3.failed, false, '隐藏集换版 → 通过');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ---------- Q5 归档/报告写出 + 隔离 ----------

test('Q5 归档与报告写出；归档仅元数据（不含隐藏样本）', () => {
  const base = mkTmp('rot-q5');
  try {
    const f = mkFixtures(base);
    const archive = path.join(base, 'archive');
    const reports = path.join(base, 'reports');
    const r = rotate({ quarter: '2026-Q3', publicDir: f.pub, hiddenDir: f.hid, redteamDir: f.rt, archiveDir: archive, reportsDir: reports, timeSource: () => new Date('2026-09-24T00:00:00Z') });
    assert.ok(fs.existsSync(r.archivePath), '归档记录写出');
    assert.ok(fs.existsSync(r.reportPath), '对比报告写出');
    const rec = JSON.parse(fs.readFileSync(r.archivePath, 'utf8'));
    // 隔离断言：归档结构无 samples 字段，且序列化文本不含样本文本
    assert.strictEqual(rec.sets.hidden.samples, undefined, '归档不含隐藏样本数组');
    assert.strictEqual(rec.sets.hidden.versionIds[0], 'high_risk-hidden-v1');
    assert.strictEqual(rec.sets.hidden.sampleCount, 60);
    const raw = fs.readFileSync(r.archivePath, 'utf8');
    assert.ok(!/"samples"\s*:/.test(raw), '归档文本不得含 samples 字段');
    assert.ok(!raw.includes('输入 high_risk_hidden'), '归档文本不得含隐藏样本文本');
    // 历史追加
    assert.ok(fs.readFileSync(path.join(archive, 'rotation-history.jsonl'), 'utf8').trim().split('\n').length === 1);
    // 报告含季对季表与判定
    const md = fs.readFileSync(r.reportPath, 'utf8');
    assert.ok(md.includes('2026-Q3'));
    assert.ok(md.includes('首次建账'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ---------- Q6 前置 fail-closed ----------

test('Q6 前置 fail-closed：隐藏集 ≤50 → FAIL；畸形 manifest → 抛错不静默', () => {
  const base = mkTmp('rot-q6');
  try {
    const f = mkFixtures(base, { hiddenCount: 40 });
    const r = rotate({ quarter: '2026-Q3', publicDir: f.pub, hiddenDir: f.hid, redteamDir: f.rt, archiveDir: path.join(base, 'a'), reportsDir: path.join(base, 'r') });
    assert.ok(r.problems.some(p => p.includes('三集制')), JSON.stringify(r.problems));
    assert.strictEqual(r.failed, true);
    // 畸形 manifest → 抛错
    const broken = path.join(base, 'broken');
    fs.mkdirSync(path.join(broken, 'spoken'), { recursive: true });
    fs.writeFileSync(path.join(broken, 'spoken', 'manifest.json'), '{ not json');
    assert.throws(() => rotate({ quarter: '2026-Q3', publicDir: broken, hiddenDir: f.hid, redteamDir: f.rt, archiveDir: path.join(base, 'a2'), reportsDir: path.join(base, 'r2') }), /SyntaxError|manifest/i);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
