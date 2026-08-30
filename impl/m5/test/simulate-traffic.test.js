// simulate-traffic.js 提示词工程测试（方案 B2：人格化参数完整性约束）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildPromptForPersona } = require('../scripts/simulate-traffic.js');

const sreAlice = { id: 'sre-alice', profile: '资深 SRE，指令简洁专业' };
const devBob = { id: 'dev-bob', profile: '开发新手，口语化严重' };

test('SRE 人格提示词要求 execute 意图带完整参数', () => {
  const prompt = buildPromptForPersona(sreAlice, 6, null);
  assert.ok(prompt.includes('必须包含具体路径或文件参数'), 'SRE 应要求完整参数');
  assert.ok(prompt.includes('/var/log/xxx'), 'clean 路径示例存在');
  assert.ok(prompt.includes('/etc/xxx.conf'), 'config_change 文件示例存在');
  assert.ok(prompt.includes('/xxx/docker-compose.yml'), 'env_switch compose 文件示例存在');
  assert.ok(!prompt.includes('参数不完整'), 'SRE 不应鼓励参数不完整');
});

test('dev-bob 人格提示词保持参数不完整（模拟真实新手分布）', () => {
  const prompt = buildPromptForPersona(devBob, 6, null);
  assert.ok(prompt.includes('参数不完整'), 'dev-bob 应允许参数不完整');
  assert.ok(prompt.includes('清下日志'), 'dev-bob 示例包含清下日志');
  assert.ok(!prompt.includes('必须包含具体路径'), 'dev-bob 不应强制完整参数');
});

test('提示词仍包含基础约束：目标资产、能力白名单、JSON 输出', () => {
  for (const p of [sreAlice, devBob]) {
    const prompt = buildPromptForPersona(p, 6, null);
    assert.ok(prompt.includes('jd-light、ali-ecs-99、ctyun-x、tencent-lh、oracle-arm-1'), `${p.id} 应包含目标资产`);
    assert.ok(prompt.includes('config_change'), `${p.id} 应包含能力白名单`);
    assert.ok(prompt.includes('只输出 JSON 字符串数组'), `${p.id} 应要求 JSON 输出`);
  }
});

test('avoidHint 不为空时会被注入提示词', () => {
  const prompt = buildPromptForPersona(sreAlice, 6, 'jd-light 清理 /var/log');
  assert.ok(prompt.includes('避免这些已有表述的换皮重复'), '应注入去重提示');
  assert.ok(prompt.includes('jd-light 清理 /var/log'), 'avoidHint 应出现在 prompt 中');
});
