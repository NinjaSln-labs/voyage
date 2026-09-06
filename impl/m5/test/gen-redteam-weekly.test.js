// gen-redteam-weekly.js 纯函数测试：周标签规范化 / 周标签计算 / 参数解析 / 产物合并
// 覆盖历史缺陷：① 简化周算法致 09-04 与 09-06 同落 W36 → 同名覆盖丢失
//              ② 带值 flag 的下一个值被 slice(3).filter() 误当 prevSamples 路径
//              ③ 同名产物 writeFileSync 覆盖（无合并语义）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeWeekTag, computeWeekTag, parseArgs, mergeSamples } = require('../scripts/gen-redteam-weekly.js');

// ── normalizeWeekTag ─────────────────────────────────────────

test('normalizeWeekTag: 合法标签规范化为大写 + 周数补零', () => {
  assert.strictEqual(normalizeWeekTag('2026-W37'), '2026-W37');
  assert.strictEqual(normalizeWeekTag('2026-w37'), '2026-W37', '小写 w 应接受');
  assert.strictEqual(normalizeWeekTag('2026-W5'), '2026-W05', '单位周数应补零');
  assert.strictEqual(normalizeWeekTag(' 2026-W37 '), '2026-W37', '两侧空白应容忍');
  assert.strictEqual(normalizeWeekTag('2026-W53'), '2026-W53', 'W53 为合法上限');
});

test('normalizeWeekTag: 非法标签返回 null（不静默回退）', () => {
  for (const bad of ['', null, undefined, 'W37', '2026-W0', '2026-W54', '2026-37', '2026-W37X', '2026W37', 'abc-W37', '2026-W3a']) {
    assert.strictEqual(normalizeWeekTag(bad), null, `应拒绝：${JSON.stringify(bad)}`);
  }
});

// ── computeWeekTag ───────────────────────────────────────────

test('computeWeekTag: 输出格式恒为 YYYY-Wnn', () => {
  for (const iso of ['2026-01-01T00:00:00Z', '2026-09-04T00:00:00Z', '2026-12-31T23:59:59Z']) {
    assert.match(computeWeekTag(new Date(iso)), /^2026-W\d{2}$/, `格式应为 YYYY-Wnn：${iso}`);
  }
});

test('computeWeekTag: 7 天分段性质——相隔 7 天必跨周（数学保证，不依赖时区）', () => {
  const a = new Date('2026-09-04T00:00:00Z');
  const b = new Date(a.getTime() + 7 * 86400e3);
  assert.notStrictEqual(computeWeekTag(a), computeWeekTag(b), '相隔 7 天必跨分段');
  assert.strictEqual(
    Number(computeWeekTag(b).slice(-2)) - Number(computeWeekTag(a).slice(-2)), 1,
    '跨段后周数恰增 1',
  );
});

test('computeWeekTag: 「相隔 2 天同周」是常态——09-04/09-06 双跑同名的根因', () => {
  // 7 天分段下，相隔 2 天同周的概率约为 5/7。全年扫描确认该情形高频发生，
  // 故同一周内双跑（定时 + 补跑 / 手动）必然触发同名覆盖，--week 显式标签是必要修复。
  let sameWeek = 0;
  const total = 364;
  for (let d = 0; d < total; d++) {
    const a = new Date(Date.UTC(2026, 0, 1) + d * 86400e3);
    const b = new Date(a.getTime() + 2 * 86400e3);
    if (computeWeekTag(a) === computeWeekTag(b)) sameWeek++;
  }
  assert.ok(sameWeek > 200, `「相隔 2 天同周」应覆盖多数日子，实测 ${sameWeek}/${total}`);
});

test('computeWeekTag: 不依赖调用时刻（显式 date 参数可复现）', () => {
  const fixed = new Date('2026-09-06T00:00:00Z');
  assert.strictEqual(computeWeekTag(fixed), computeWeekTag(fixed), '同一时刻结果确定');
  assert.notStrictEqual(computeWeekTag(fixed), computeWeekTag(new Date('2027-03-01T00:00:00Z')), '不同时刻结果不同');
});

// ── parseArgs ────────────────────────────────────────────────

test('parseArgs: 仅 outDir', () => {
  const r = parseArgs(['out']);
  assert.deepStrictEqual(r.positional, ['out']);
  assert.strictEqual(r.count, 20, '默认 count 为 20');
  assert.strictEqual(r.week, null, '未传 --week 时为 null（走自动计算）');
});

test('parseArgs: outDir + prevSamples + 两个带值 flag', () => {
  const r = parseArgs(['out', 'prev.json', '--count', '30', '--week', '2026-W37']);
  assert.deepStrictEqual(r.positional, ['out', 'prev.json']);
  assert.strictEqual(r.count, 30);
  assert.strictEqual(r.week, '2026-W37');
});

test('parseArgs 回归: 带值 flag 的下一个值不被误当 prevSamples 路径', () => {
  // 历史 bug：process.argv.slice(3).filter(!startsWith('--')) 会把 '2026-W37' 与 '20' 当路径
  const r = parseArgs(['out', '--week', '2026-W37', '--count', '20']);
  assert.deepStrictEqual(r.positional, ['out'], '位置参数只应含 outDir');
  assert.strictEqual(r.week, '2026-W37');
  assert.strictEqual(r.count, 20);
});

test('parseArgs: 非法 --week 值返回 null（由 main 负责显式报错）', () => {
  assert.strictEqual(parseArgs(['out', '--week', 'bad']).week, null);
  assert.strictEqual(parseArgs(['out', '--week']).week, null, '缺值时不抛错');
});

test('parseArgs: 未知 --flag 被跳过，不影响位置参数收集', () => {
  const r = parseArgs(['out', '--verbose', 'prev.json']);
  assert.deepStrictEqual(r.positional, ['out', 'prev.json']);
});

// ── mergeSamples ─────────────────────────────────────────────

test('mergeSamples: 空既有 → 全量新增', () => {
  const fresh = [{ id: '1', input: 'a' }, { id: '2', input: 'b' }];
  const r = mergeSamples([], fresh);
  assert.strictEqual(r.samples.length, 2);
  assert.strictEqual(r.added, 2);
});

test('mergeSamples: 既在前、新增在后，按 input trim 去重', () => {
  const existing = [{ id: 'R1', input: 'a' }, { id: 'R2', input: ' b ' }];
  const fresh = [
    { id: 'N1', input: 'a' },   // 与 R1 重复
    { id: 'N2', input: 'b' },    // 与 R2（trim 后）重复
    { id: 'N3', input: 'c' },    // 新增
  ];
  const r = mergeSamples(existing, fresh);
  assert.strictEqual(r.samples.length, 3, '去重后 3 条');
  assert.strictEqual(r.added, 1, '仅 1 条实际新增');
  assert.deepStrictEqual(r.samples.map(s => s.id), ['R1', 'R2', 'N3'], '既有在前、新增在后');
});

test('mergeSamples: 既有产物内部重复也被去重', () => {
  const r = mergeSamples([{ id: '1', input: 'a' }, { id: '2', input: 'a' }], []);
  assert.strictEqual(r.samples.length, 1);
  assert.strictEqual(r.added, 0);
});

test('mergeSamples: 无效样本（缺 input / 非字符串 / 空 input）被跳过', () => {
  const r = mergeSamples(
    [{ id: 'x', input: 'ok' }],
    [null, undefined, { id: '1' }, { id: '2', input: 42 }, { id: '3', input: '' }, { id: '4', input: '   ' }],
  );
  assert.strictEqual(r.samples.length, 1, '仅有效样本保留');
  assert.strictEqual(r.added, 0, '无效新增全部跳过');
});

test('mergeSamples: 双空输入返回空集（不抛错）', () => {
  assert.deepStrictEqual(mergeSamples(null, null), { samples: [], added: 0 });
});

test('mergeSamples: 全重复时 added 为 0 且保留既有（不丢失历史）', () => {
  const existing = [{ id: 'R1', input: 'a' }, { id: 'R2', input: 'b' }];
  const r = mergeSamples(existing, [{ id: 'N1', input: 'a' }, { id: 'N2', input: 'b' }]);
  assert.strictEqual(r.added, 0, '无新增');
  assert.strictEqual(r.samples.length, 2, '既有样本完整保留');
  assert.deepStrictEqual(r.samples.map(s => s.id), ['R1', 'R2'], '合并模式下既有产物不被覆盖丢失');
});
