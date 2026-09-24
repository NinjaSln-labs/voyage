// 能力/模板单源锚定测试（审计修复 R7：M3/M4/shared 三方同值——漂移即 runJob 与领域校验分叉）
// M3/M4 领域层常量保持独立副本（历史测试锚定），本测试锁定三方同值；漂移时此处先红

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { QUERY_CAPABILITIES, EXEC_CAPABILITIES, CAPABILITY_TO_COMMAND, TEMPLATE_COMMANDS, CAPABILITIES, ROLE_EXTENSION_CAPABILITIES, MATRIX_ROW_CAPABILITIES, RISK_LEVEL } = require('../src/shared-capabilities.js');
const { ROLE_CAPABILITIES } = require('../src/repo/repo-identity.js');
const trust = require('../../m3/src/trust/domain.js');
const exec = require('../../m4/src/exec/domain.js');

test('S1 能力清单三方同值：shared == M3 trust == M4 exec', () => {
  // 查询类：shared == M3 QUERY_CAPABILITIES
  assert.deepStrictEqual([...QUERY_CAPABILITIES].sort(), [...trust.QUERY_CAPABILITIES].sort(), 'shared QUERY == M3 QUERY');
  // 执行白名单：shared == M3 == M4
  assert.deepStrictEqual([...EXEC_CAPABILITIES].sort(), [...trust.WHITELIST_CAPABILITIES].sort(), 'shared EXEC == M3 WHITELIST');
  assert.deepStrictEqual([...EXEC_CAPABILITIES].sort(), [...exec.WHITELIST_CAPABILITIES].sort(), 'shared EXEC == M4 WHITELIST');
});

test('S2 模板映射同值：shared 与 M4 校验行为锚定（M4 未导出映射表，以行为校验）', () => {
  // 模板全集：shared TEMPLATE_COMMANDS 键 == M4 COMMAND_TEMPLATES
  assert.deepStrictEqual(Object.keys(TEMPLATE_COMMANDS).sort(), [...exec.COMMAND_TEMPLATES].sort(), '模板全集同值');
  // 行为锚定：shared 映射的每个 capability→command 组合必须通过 M4 validateParams（构造 Job 同路）
  for (const [cap, cmd] of Object.entries(CAPABILITY_TO_COMMAND)) {
    const params = cap === 'clean' ? { command: cmd, path: '/var/log/' } : { command: cmd };
    assert.doesNotThrow(() => exec.validateParams(cap, params), `capability ${cap} + command ${cmd} 须过 M4 schema`);
  }
  // 反向锚定：shared 之外的执行 capability → M4 Job 构造拒绝（白名单同值的行为面）
  assert.throws(() => new exec.Job({ id: 'j-anchor', creator: 'u', target: 't', template: 'nonexistent_cap', params: { command: 'x' } }), /不在白名单/);
});

test('S3 矩阵行↔能力码映射（ADR-004）：每个映射值 ⊆ 能力码 ∪ 角色扩展码', () => {
  const known = new Set([...CAPABILITIES, ...ROLE_EXTENSION_CAPABILITIES]);
  for (const [row, codes] of Object.entries(MATRIX_ROW_CAPABILITIES)) {
    assert.ok(Array.isArray(codes), `行「${row}」映射须为数组`);
    for (const code of codes) {
      assert.ok(known.has(code), `行「${row}」映射含未知能力码「${code}」`);
    }
  }
  // 扩展码单源一致：MACRO 登记 == ROLE_CAPABILITIES 实际用到的扩展码
  const usedExtensions = new Set(Object.values(ROLE_CAPABILITIES).flat());
  for (const ext of ROLE_EXTENSION_CAPABILITIES) {
    assert.ok(usedExtensions.has(ext), `扩展码「${ext}」未被任何角色使用（登记漂移）`);
  }
});

test('S4 管理者投影与映射表一致（ADR-004）：大盘=query_metric+query_health，不含明细码', () => {
  const mapped = new Set(Object.values(MATRIX_ROW_CAPABILITIES).flat());
  const mgr = ROLE_CAPABILITIES.manager;
  // 管理者每个能力都须在映射表内（无孤儿能力）
  for (const cap of mgr) assert.ok(mapped.has(cap), `管理者能力「${cap}」不在矩阵映射表内`);
  // 关键口径：大盘由 metric+health 承载；明细码 query_status/query_log 不在管理者能力集
  assert.ok(mgr.includes('query_metric') && mgr.includes('query_health'), '管理者持有大盘码');
  assert.ok(!mgr.includes('query_status'), '管理者无 query_status（明细码，ADR-003/t000033 一致）');
  assert.ok(!mgr.includes('query_log'), '管理者无 query_log（行「日志查看」❌）');
});

test('S5 行1 双码捆绑锚定（ADR-004）：行「监控指标 / 服务状态查询」含 query_metric + query_status', () => {
  const row1 = MATRIX_ROW_CAPABILITIES['监控指标 / 服务状态查询'];
  assert.ok(row1.includes('query_metric'), '行1 含 query_metric（监控指标）');
  assert.ok(row1.includes('query_status'), '行1 含 query_status（服务/部署状态明细）');
  // 行「部署状态查看」归属于 query_status
  assert.deepStrictEqual([...MATRIX_ROW_CAPABILITIES['部署状态查看']], ['query_status']);
});

test('S6 RISK_LEVEL 完备（p000043）：CAPABILITIES 与 RISK_LEVEL 双向逐一对应', () => {
  // 每个能力都有风险等级（载入期不变量已保证，此处再从测试面锚定）
  for (const cap of CAPABILITIES) {
    assert.ok(RISK_LEVEL[cap], `能力「${cap}」缺 RISK_LEVEL`);
    assert.ok(['low', 'high', 'critical'].includes(RISK_LEVEL[cap]), `能力「${cap}」风险等级非法`);
  }
  // 反向：RISK_LEVEL 不含未登记能力（防孤儿等级）
  for (const cap of Object.keys(RISK_LEVEL)) {
    assert.ok(CAPABILITIES.includes(cap), `RISK_LEVEL 含未登记能力「${cap}」`);
  }
  // EXEC + EGRESS 必为 high（执行/外传同一审批面）；QUERY 必为 low
  for (const cap of [...EXEC_CAPABILITIES]) assert.strictEqual(RISK_LEVEL[cap], 'high', `执行能力「${cap}」须 high`);
  for (const cap of [...QUERY_CAPABILITIES]) assert.strictEqual(RISK_LEVEL[cap], 'low', `查询能力「${cap}」须 low`);
});

test('S7 角色扩展能力模型不可触发（p000042）：ROLE_EXTENSION_CAPABILITIES ∩ CAPABILITIES = ∅', () => {
  const capSet = new Set(CAPABILITIES);
  for (const ext of ROLE_EXTENSION_CAPABILITIES) {
    assert.ok(!capSet.has(ext), `角色扩展能力「${ext}」不得进入模型能力码表 CAPABILITIES`);
  }
  // 审计记录查询为人工/UI 通道，模型触发通道不可达
  assert.ok(!capSet.has('audit_query'), 'audit_query 不得模型可触发');
  assert.ok(!capSet.has('audit_summary'), 'audit_summary 不得模型可触发');
});
