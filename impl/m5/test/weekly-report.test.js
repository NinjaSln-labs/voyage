// 周报结论判定测试：服务端错误／认证失败必须参与判定
// 起因：历史周报记「服务端错误 264 仍标健康」——错误数只被打印在同一行，不进 verdict
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'weekly-report.js');

/** 造一份含 N 天的日聚合快照（collect-metrics 的 {days:{...}} 形态） */
function history(days) {
  const d = {};
  for (const [day, v] of Object.entries(days)) {
    d[day] = {
      intents: v.intents ?? 100,
      degradedIntents: v.degraded ?? 0,
      approvalsCreated: 0,
      authFailures: v.authFailures ?? 0,
      serverErrors: v.serverErrors ?? 0,
      latencyMs: { p50: 800 },
    };
  }
  return JSON.stringify({ generatedAt: new Date().toISOString(), days: d });
}

function run(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-'));
  const hist = path.join(dir, 'metrics-history.jsonl');
  const outDir = path.join(dir, 'reports');
  fs.writeFileSync(hist, rows);
  let out = '';
  try {
    out = execFileSync(process.execPath, [SCRIPT, hist, outDir], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

const TODAY = new Date().toISOString().slice(0, 10);

test('WR1 服务端错误 >0 → 结论不得标「健康」（旧码：264 次错误仍标 ✅ 健康）', () => {
  const out = run(history({ [TODAY]: { intents: 100, degraded: 0, serverErrors: 264 } }));
  assert.match(out, /⚠️/);
  assert.ok(!out.includes('✅ 健康'), '有服务端错误时不得判健康');
  assert.match(out, /服务端错误 264/);
});

test('WR2 认证失败 >0 → 结论不得标「健康」（带凭证 401 须为 0）', () => {
  const out = run(history({ [TODAY]: { intents: 100, degraded: 0, authFailures: 3 } }));
  assert.ok(!out.includes('✅ 健康'), '有认证失败时不得判健康');
  assert.match(out, /认证失败 3/);
});

test('WR3 降级率 ≥30% → 结论标降级率偏高', () => {
  const out = run(history({ [TODAY]: { intents: 100, degraded: 30, serverErrors: 0, authFailures: 0 } }));
  assert.match(out, /⚠️/);
  assert.match(out, /降级率/);
});

test('WR4 三类异常皆为 0 → 判健康', () => {
  const out = run(history({ [TODAY]: { intents: 100, degraded: 5, serverErrors: 0, authFailures: 0 } }));
  assert.match(out, /✅ 健康/);
  assert.ok(!out.includes('⚠️'), '无异常时不应有告警');
});

test('WR5 服务端错误与认证失败同时出现 → 两个问题都要点名', () => {
  const out = run(history({ [TODAY]: { intents: 100, degraded: 0, serverErrors: 5, authFailures: 2 } }));
  assert.match(out, /服务端错误 5/);
  assert.match(out, /认证失败 2/);
  assert.ok(!out.includes('✅ 健康'));
});

// ── 累计快照重复计数（collect-metrics 每轮重算整份 access 日志）──
test('WR6 累计快照多行 → 指标不得按行累加（生产 69 行曾把 7 天算成 49 天）', () => {
  const day = TODAY;
  const one = JSON.stringify({
    generatedAt: new Date().toISOString(),
    days: { [day]: { intents: 100, degradedIntents: 0, approvalsCreated: 0, authFailures: 0, serverErrors: 0, latencyMs: { p50: 800 } } },
  });
  const out = run([one, one, one].join('\n'));
  assert.match(out, /意图总量：\*\*100\*\*/, '三行同内容只应计一次');
  assert.ok(!out.includes('49 天'), '天数不应被行数放大');
  assert.match(out, /影子运行周报（1 天）/);
});

test('WR7 最新快照覆盖旧的（累计语义）：旧行有额外天数时不得并入', () => {
  const old = new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10);
  const line = (days) => JSON.stringify({ generatedAt: new Date().toISOString(), days });
  const day = (intents) => ({ intents, degradedIntents: 0, approvalsCreated: 0, authFailures: 0, serverErrors: 0, latencyMs: { p50: 800 } });
  // 第一行含 3 天前与今天共 120 intents；第二行（更新）只含今天 100
  const out = run([line({ [old]: day(20), [TODAY]: day(100) }), line({ [TODAY]: day(100) })].join('\n'));
  assert.match(out, /意图总量：\*\*100\*\*/, '应取最新快照，不与旧行相加');
});
