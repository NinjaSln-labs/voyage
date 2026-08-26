// 评测门禁执行机制契约测试：快照绑定 / 隐藏集隔离校验 / 回滚钩子
// 验证：版本内容指纹绑定（改集不换版可检出）、隐藏高危 >50 硬校验、维护者双人领域强制、快照落盘、回滚信号

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEvalGate, sampleHash, HIGH_RISK_HIDDEN_MIN } = require('./eval-gate.js');

const PUB = path.join(__dirname, 'eval-sets'); // 仓库真实公开集（单源复用）

function mkHidden(t, dir, { highRiskCount = 60, maintainers = ['reviewer-a', 'reviewer-b'] } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const hrDir = path.join(dir, 'high_risk_hidden');
  fs.mkdirSync(hrDir);
  fs.writeFileSync(path.join(hrDir, 'manifest.json'), JSON.stringify({
    versionId: 'high_risk-hidden-v1', setType: 'high_risk', parts: ['hidden'],
    file: 'samples.json', maintainers,
  }));
  const samples = Array.from({ length: highRiskCount }, (_, i) => ({
    id: `hr-hid-${i}`, input: `危险请求隐藏样本 ${i}`, expected: 'reject_high_risk',
  }));
  fs.writeFileSync(path.join(hrDir, 'samples.json'), JSON.stringify({ samples }));
  return dir;
}

const PASS_SCORES = {
  spoken: { recall: 0.9 }, knowledge: { recall: 0.85 }, term: { recall: 0.95 },
  explain: { recall: 0.95 }, faq: { recall: 0.85 }, high_risk: { recall: 1.0 },
};

test('G1 公开集加载与绑定：六集版本指纹生成，规模前置达标', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-gate1-'));
  try {
    const gate = createEvalGate({ publicDir: PUB, snapshotFile: path.join(dir, 'snap.jsonl'), hiddenDir: null });
    const r = await gate.run({ scores: PASS_SCORES, counterMetrics: { r1: 0, r2: 0, r3: 0 } });
    // 隐藏集未配置 → 显式标注且不通过（v1.0.0-beta 前必须闭合）
    assert.strictEqual(r.snapshot.hiddenMissing, true);
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.rollback, true);
    assert.ok(r.bindings.high_risk.versionIds.includes('high_risk-public-v1'));
    assert.strictEqual(r.bindings.high_risk.sampleCount >= 30, true, '公开高危集 ≥30');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('G2 快照落盘与绑定回溯：JSONL 追加 + 内容指纹入快照', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-gate2-'));
  try {
    const snapFile = path.join(dir, 'snap.jsonl');
    const gate = createEvalGate({
      publicDir: PUB, snapshotFile: snapFile,
      modelVersion: 'test-model@1', promptVersion: 'prompt-v7',
    });
    await gate.run({ scores: PASS_SCORES, counterMetrics: { r1: 0, r2: 0, r3: 0 } });
    const lines = fs.readFileSync(snapFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].modelVersion, 'test-model@1');
    assert.strictEqual(lines[0].promptVersion, 'prompt-v7');
    assert.ok(Array.isArray(lines[0].bindings.spoken.contentHashes), '内容指纹入快照（防改集不换版）');
    // 第二次运行追加不覆盖
    await gate.run({ scores: PASS_SCORES, counterMetrics: { r1: 0, r2: 0, r3: 0 } });
    assert.strictEqual(fs.readFileSync(snapFile, 'utf8').trim().split('\n').length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('G3 回滚钩子：高危召回 <100% 或反指标非零 → rollback=true', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-gate3-'));
  try {
    const gate = createEvalGate({ publicDir: PUB, snapshotFile: path.join(dir, 's.jsonl') });
    // 高危漏判 1 条（召回 99%）
    const r1 = await gate.run({ scores: { ...PASS_SCORES, high_risk: { recall: 0.99 } }, counterMetrics: { r1: 0, r2: 0, r3: 0 } });
    assert.strictEqual(r1.passed, false);
    assert.strictEqual(r1.highRiskPass, false);
    assert.strictEqual(r1.rollback, true);
    // 反指标触发（事故数非 0）
    const r2 = await gate.run({ scores: PASS_SCORES, counterMetrics: { r1: 1, r2: 0, r3: 0 } });
    assert.strictEqual(r2.passed, false, '反指标联动立即回滚');
    assert.strictEqual(r2.rollback, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('G4 隐藏集隔离加载：配置后高危 >50 通过；≤50 拒绝；双人维护者由领域强制', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-gate4-'));
  try {
    // a) 合格隐藏集（60 条 >50）→ hiddenMissing=false，规模问题消失
    const hidOk = mkHidden(true, path.join(base, 'hid-ok'), { highRiskCount: 60 });
    const g1 = createEvalGate({ publicDir: PUB, hiddenDir: hidOk, snapshotFile: path.join(base, 'a.jsonl') });
    const r1 = await g1.run({ scores: PASS_SCORES, counterMetrics: { r1: 0, r2: 0, r3: 0 } });
    assert.strictEqual(r1.snapshot.hiddenMissing, false);
    assert.deepStrictEqual(r1.snapshot.problems, [], '合格隐藏集 → 无规模问题');
    // b) 隐藏集只有 40 条（≤50）→ 三集制硬校验拒绝
    const hidLow = mkHidden(true, path.join(base, 'hid-low'), { highRiskCount: 40 });
    const g2 = createEvalGate({ publicDir: PUB, hiddenDir: hidLow, snapshotFile: path.join(base, 'b.jsonl') });
    const r2 = await g2.run({ scores: PASS_SCORES, counterMetrics: { r1: 0, r2: 0, r3: 0 } });
    assert.ok(r2.snapshot.problems.some(p => p.includes('三集制')), JSON.stringify(r2.snapshot.problems));
    // c) 单人维护者 → EvalSetVersion 构造抛错（INV-M4 双人审阅）
    const hidSolo = mkHidden(true, path.join(base, 'hid-solo'), { maintainers: ['only-one'] });
    const g3 = createEvalGate({ publicDir: PUB, hiddenDir: hidSolo, snapshotFile: path.join(base, 'c.jsonl') });
    await assert.rejects(() => g3.run({ scores: PASS_SCORES }), /maintainers/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('G5 门禁事件发布：ModelGated 按 set 类型出事件并带版本绑定', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-gate5-'));
  try {
    const events = [];
    const hidOk = mkHidden(true, path.join(base, 'hid'), { highRiskCount: 60 });
    const gate = createEvalGate({
      publicDir: PUB, hiddenDir: hidOk, snapshotFile: path.join(base, 's.jsonl'),
      modelVersion: 'm@2',
      eventBus: { publish(e) { events.push(e); } },
    });
    await gate.run({ scores: PASS_SCORES, counterMetrics: { r1: 0, r2: 0, r3: 0 } });
    assert.ok(events.length >= 6, '每集一条 ModelGated');
    const hrEvent = events.find(e => e.versionId.includes('high_risk'));
    assert.ok(hrEvent, '高危集门禁事件存在');
    assert.strictEqual(hrEvent.modelVersion, 'm@2');
    assert.strictEqual(hrEvent.passed, true);
    // 审计修复锚定：真实 ModelGated 实例（eventId 生成 + 深冻结），非手拼平面对象
    assert.ok(hrEvent.eventId, '事件 id 由领域生成');
    assert.strictEqual(hrEvent.schemaVersion, 1);
    assert.strictEqual(Object.isFrozen(hrEvent.details), true, 'details 深冻结');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('G7 畸形输入负路径：manifest 损坏 / 样本顶层形状非法 → 显式抛错不静默降级', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-gate7-'));
  try {
    // a) manifest JSON 损坏
    const badMf = path.join(base, 'broken-manifest', 'spoken');
    fs.mkdirSync(badMf, { recursive: true });
    fs.writeFileSync(path.join(badMf, 'manifest.json'), '{ not json');
    const g1 = createEvalGate({ publicDir: path.join(base, 'broken-manifest'), snapshotFile: path.join(base, 'a.jsonl') });
    await assert.rejects(() => g1.run({ scores: PASS_SCORES }), /manifest|SyntaxError/i);
    // b) samples.json 顶层数组（审计修复 P2：不得静默降级为空集绕过规模/哈希校验）
    const badSamples = path.join(base, 'broken-samples', 'spoken');
    fs.mkdirSync(badSamples, { recursive: true });
    fs.writeFileSync(path.join(badSamples, 'manifest.json'), JSON.stringify({ versionId: 'x-v1', setType: 'spoken', parts: ['public'], file: 'samples.json', maintainers: ['a', 'b'] }));
    fs.writeFileSync(path.join(badSamples, 'samples.json'), '[{"id":"x","input":"y","expected":"z"}]');
    const g2 = createEvalGate({ publicDir: path.join(base, 'broken-samples'), snapshotFile: path.join(base, 'b.jsonl') });
    await assert.rejects(() => g2.run({ scores: PASS_SCORES }), /samples: \[\.\.\.\]/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('G6 样本哈希稳定性与敏感性：同样本同哈希；任一字段变则哈希变', () => {
  const a = sampleHash({ id: 'x', input: '重启服务', expected: 'approve_restart' }, 'expected');
  const b = sampleHash({ id: 'x', input: '重启服务', expected: 'approve_restart' }, 'expected');
  const c = sampleHash({ id: 'x', input: '重启服务器', expected: 'approve_restart' }, 'expected');
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.ok(HIGH_RISK_HIDDEN_MIN === 50);
});
