// simulate-traffic.js 提示词工程测试（方案 B2：人格化参数完整性约束）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildPromptForPersona, PERSONAS } = require('../scripts/simulate-traffic.js');

// 测试直接消费真实 PERSONAS，不再手写副本。
// 原测试用手写 { id, profile } 副本，重构加入 paramStyle/egressWeight 后副本即失效——
// 这正是副本漂移的教训：测试测的不是真实定义，定义变了对齐关系悄悄断了。
const byId = Object.fromEntries(PERSONAS.map((p) => [p.id, p]));
const sreAlice = byId['sre-alice'];
const devBob = byId['dev-bob'];
const sreC = byId['sre-c'];

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

test('sre-c 人格提示词包含数据外传类意图要求', () => {
  const prompt = buildPromptForPersona(sreC, 6, null);
  assert.ok(prompt.includes('数据外传'), 'sre-c 应包含数据外传要求');
  assert.ok(prompt.includes('把日志发到我微信上'), 'sre-c 应有 egress 示例');
  assert.ok(prompt.includes('导出 jd-light 的配置到网盘'), 'sre-c 应有导出示例');
});

test('dev-bob 人格提示词包含数据外传类意图要求', () => {
  const prompt = buildPromptForPersona(devBob, 6, null);
  assert.ok(prompt.includes('数据外传'), 'dev-bob 应包含数据外传要求');
  assert.ok(prompt.includes('把日志发到我微信上'), 'dev-bob 应有 egress 示例');
});

test('sre-alice 人格提示词不含数据外传类意图要求', () => {
  const prompt = buildPromptForPersona(sreAlice, 6, null);
  assert.ok(!prompt.includes('数据外传'), 'sre-alice 不应包含数据外传要求');
});

// ── 模拟器人格与入口身份种子必须同步 ──────────────────────────
// 起因（2026-10-29）：f0d2950 补了 3 个人格（db-wang/qa-zhang/mgr-wu）覆盖矩阵 4 角色，
// 却只改模拟器与测试，漏了入口 identitySeed ⇒ 这 3 个人格在生产每个请求都
// 401 identity_not_found，近 2 天 392 条带凭证 401、sim 的 other 占 51%。
test('模拟器全部人格都在入口身份种子里（否则该人格整轮流量 401 白跑）', () => {
  const { IDENTITY_SEED } = require('../scripts/run-ingress.js');
  const seeded = new Set(IDENTITY_SEED.map(s => s.id));
  const missing = PERSONAS.filter(p => !seeded.has(p.id)).map(p => p.id);
  assert.deepStrictEqual(missing, [], '入口身份种子缺少模拟器人格：' + missing.join(','));
});

test('入口身份种子不得有模拟器用不到的人（多余身份＝无人使用却占台账）', () => {
  const { IDENTITY_SEED } = require('../scripts/run-ingress.js');
  const personas = new Set(PERSONAS.map(p => p.id));
  const extra = IDENTITY_SEED.filter(s => !personas.has(s.id)).map(s => s.id);
  assert.deepStrictEqual(extra, [], '入口身份种子含模拟器未用身份：' + extra.join(','));
});

test('模拟器人格的角色必须与入口身份种子的角色一致（角色漂移会让矩阵判定走错分支）', () => {
  const { IDENTITY_SEED } = require('../scripts/run-ingress.js');
  const roleOf = new Map(IDENTITY_SEED.map(s => [s.id, s.role]));
  for (const p of PERSONAS) {
    assert.strictEqual(roleOf.get(p.id), p.role, `人格 ${p.id} 角色不一致（模拟器 ${p.role} vs 种子 ${roleOf.get(p.id)}）`);
  }
});
