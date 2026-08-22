// 能力/模板单源锚定测试（审计修复 R7：M3/M4/shared 三方同值——漂移即 runJob 与领域校验分叉）
// M3/M4 领域层常量保持独立副本（历史测试锚定），本测试锁定三方同值；漂移时此处先红

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { QUERY_CAPABILITIES, EXEC_CAPABILITIES, CAPABILITY_TO_COMMAND, TEMPLATE_COMMANDS } = require('../src/shared-capabilities.js');
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
