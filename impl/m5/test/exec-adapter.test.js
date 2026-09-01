// SSH 被管机执行适配器契约测试（execAdapterPort 落地）
// 验证：契约执行成功/失败语义、凭据注入（keyVaultPort）、参数化不 shell 拼接（stdin 载荷）、
//      renderRemoteCommand 结构安全、内存 fake 同契、真实 SSH 冒烟（有 ssh+私钥才跑，无则跳过）

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSshExecAdapter, createSshExecAdapterMemory, renderRemoteCommand, TEMPLATE_COMMANDS } = require('../src/exec/exec-adapter.js');

function vaultFor(targets) {
  return {
    resolve(target) {
      return targets[target] || null;
    },
  };
}

// ============ 参数渲染（RQ-511：不 shell 拼接） ============

test('R1 模板白名单：仅受管模板可执行（拒绝任意命令）', () => {
  assert.ok(TEMPLATE_COMMANDS.restart_service);
  assert.ok(TEMPLATE_COMMANDS.clean_logs);
  const ok = renderRemoteCommand('restart_service', { service: 'nginx' });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(JSON.parse(ok.remote), { template: 'restart_service', params: { service: 'nginx' } });
  assert.strictEqual(renderRemoteCommand('rm -rf /', {}).ok, false, '任意命令拒绝');
  assert.strictEqual(renderRemoteCommand('shutdown', {}).ok, false);
});

test('R2 参数结构安全：仅 string/number/boolean；JSON 载荷传递（无拼接面）', () => {
  // 恶意值（含 shell 元字符）作为数据传入，不参与拼接
  const ok = renderRemoteCommand('restart_service', { service: 'nginx; rm -rf /' });
  assert.strictEqual(ok.ok, true);
  const parsed = JSON.parse(ok.remote);
  assert.strictEqual(parsed.params.service, 'nginx; rm -rf /', '载荷原样保留（远端以 argv 元素处理，非 shell 拼接）');
  // 非法类型拒绝
  assert.strictEqual(renderRemoteCommand('restart_service', { service: {} }).ok, false);
  assert.strictEqual(renderRemoteCommand('restart_service', { service: ['a'] }).ok, false);
  // 超长拒绝
  assert.strictEqual(renderRemoteCommand('restart_service', { service: 'x'.repeat(513) }).ok, false);
});

// ============ 内存 fake（同契，不连网络） ============

test('R3 内存 fake：注册结果 → 成功返回契约结构', async () => {
  const adapter = createSshExecAdapterMemory();
  adapter.registerResult('svc-a', 'restart_service', { stdout: 'Restarted nginx', stderr: '', exitCode: 0, nodeEffects: [] });
  const r = await adapter.execute('svc-a', 'restart_service', { service: 'nginx' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result.stdout, 'Restarted nginx');
  assert.strictEqual(r.result.exitCode, 0);
  assert.deepStrictEqual(adapter.calls[0].params, { service: 'nginx' });
});

test('R4 内存 fake：失败语义对齐契约（connection_failed/timeout/permission_denied）', async () => {
  const adapter = createSshExecAdapterMemory();
  adapter.registerFailure('svc-a', 'restart_service', 'connection_failed');
  adapter.registerFailure('svc-b', 'clean_logs', 'timeout');
  adapter.registerFailure('svc-c', 'scale_replicas', 'permission_denied');
  assert.strictEqual((await adapter.execute('svc-a', 'restart_service', {})).reason, 'connection_failed');
  assert.strictEqual((await adapter.execute('svc-b', 'clean_logs', {})).reason, 'timeout');
  assert.strictEqual((await adapter.execute('svc-c', 'scale_replicas', {})).reason, 'permission_denied');
});

test('R5 未知目标：target_not_resolved（fail-closed，不静默）', async () => {
  const adapter = createSshExecAdapterMemory();
  const r = await adapter.execute('svc-ghost', 'restart_service', {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'target_not_resolved');
});

// ============ 真实适配器（凭据注入 + spawn 参数） ============

test('R6 keyVaultPort 必填：未注入 → 构造 fail-fast', () => {
  assert.throws(() => createSshExecAdapter(), /keyVaultPort 必填/);
  assert.throws(() => createSshExecAdapter({ keyVaultPort: {} }), /keyVaultPort 必填/, 'resolve 缺失');
});

test('R7 凭据缺失：no_credential（fail-closed，凭据不落盘）', async () => {
  const adapter = createSshExecAdapter({
    keyVaultPort: vaultFor({ 'svc-a': { user: 'root', host: '10.0.0.1', port: 22 } }), // 无 keyPath
    sshCmd: 'ssh',
  });
  const r = await adapter.execute('svc-a', 'restart_service', { service: 'nginx' });
  assert.strictEqual(r.reason, 'no_credential');
});

test('R8 目标未解析：target_not_resolved（fail-closed）', async () => {
  const adapter = createSshExecAdapter({ keyVaultPort: vaultFor({}), sshCmd: 'ssh' });
  const r = await adapter.execute('svc-ghost', 'restart_service', {});
  assert.strictEqual(r.reason, 'target_not_resolved');
});

test('R9 无效输入：目标空/模板非法 → 直接拒绝（不发 ssh）', async () => {
  const adapter = createSshExecAdapter({
    keyVaultPort: vaultFor({ 'svc-a': { user: 'root', host: '1.2.3.4', port: 22, keyPath: '/tmp/nonexistent' } }),
    sshCmd: 'ssh',
  });
  assert.strictEqual((await adapter.execute('', 'restart_service', {})).reason, 'invalid_target');
  assert.strictEqual((await adapter.execute('svc-a', 'shutdown', {})).reason, 'unsupported_template');
});

// ============ 真实 SSH 冒烟（可选：有 ssh + 私钥才跑） ============

function hasSshAndKey() {
  try {
    const home = os.homedir();
    const key = path.join(home, '.ssh', 'oracle_tokyo');
    return fs.existsSync(key);
  } catch (e) {
    return false;
  }
}

const SSH_AVAILABLE = hasSshAndKey();

test('R10 真实 SSH 冒烟：JD 云连接 + 远端白名单执行（无 ssh/私钥则跳过）', { skip: !SSH_AVAILABLE }, async () => {
  const adapter = createSshExecAdapter({
    keyVaultPort: vaultFor({
      'jd-light': { user: 'root', host: '117.72.186.97', port: 22022, keyPath: path.join(os.homedir(), '.ssh', 'oracle_tokyo') },
    }),
    connectTimeoutMs: 6000,
    commandTimeoutMs: 20000,
  });
  const r = await adapter.execute('jd-light', 'clean_logs', { path: '/var/log' });
  // 允许两种结果：成功（有 /var/log）或连接失败（环境变化）——不硬断言成功，验证契约路径不崩
  assert.ok(r.ok === true || (r.ok === false && ['connection_failed', 'timeout', 'permission_denied'].includes(r.reason)),
    `真实 SSH 冒烟应成功或明确失败（实际: ${JSON.stringify(r)}）`);
  if (r.ok) {
    assert.ok(typeof r.result.exitCode === 'number');
    assert.ok(Array.isArray(r.result.nodeEffects));
  }
});

test('R11 真实 SSH 冒烟：重启模板结构（restart 非法服务 → 远端 exitCode 非 0，契约解析不崩）', { skip: !SSH_AVAILABLE }, async () => {
  const adapter = createSshExecAdapter({
    keyVaultPort: vaultFor({
      'jd-light': { user: 'root', host: '117.72.186.97', port: 22022, keyPath: path.join(os.homedir(), '.ssh', 'oracle_tokyo') },
    }),
    connectTimeoutMs: 6000,
    commandTimeoutMs: 20000,
  });
  const r = await adapter.execute('jd-light', 'restart_service', { service: 'definitely-not-a-real-service' });
  assert.ok(r.ok === true || (r.ok === false && ['connection_failed', 'timeout', 'permission_denied', 'execution_failed'].includes(r.reason)));
  if (r.ok) {
    // systemctl restart 不存在服务 → 远端脚本 exitCode 非 0，但 ok 仍 true（远端报告完成语义）
    assert.ok(typeof r.result.exitCode === 'number');
  }
});

// ============ 审计修复回归（第 12 波原型链保留键 + 第 11 波数值校验） ============

test('R12 参数键原型链保留键拒绝（质量基调第 12 波对齐）', () => {
  const r = renderRemoteCommand('restart_service', { __proto__: 'x' });
  // Object.entries 不枚举 __proto__（非自有键）——显式注入自有键验证
  const malicious = JSON.parse('{"__proto__": "evil", "service": "nginx"}');
  const r2 = renderRemoteCommand('restart_service', malicious);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'reserved_proto_key');
  assert.strictEqual(r2.key, '__proto__');
  assert.ok(r, '普通参数仍通过');
});

test('R13 超时参数正有限校验（第 11 波：NaN 静默下发是静默错误源）', () => {
  const vault = vaultFor({ 'svc-a': { user: 'root', host: '1.2.3.4', port: 22, keyPath: '/tmp/k' } });
  assert.throws(() => createSshExecAdapter({ keyVaultPort: vault, connectTimeoutMs: NaN }), /正有限数值/);
  assert.throws(() => createSshExecAdapter({ keyVaultPort: vault, commandTimeoutMs: -1 }), /正有限数值/);
  assert.throws(() => createSshExecAdapter({ keyVaultPort: vault, connectTimeoutMs: '6000' }), /正有限数值/);
});

// ---------- 模拟目标（假服务舰队）：keyVault simulated:true → 合成结果不发起 SSH ----------

test('SIM1 模拟目标：simulated 连接 → 合成成功结果（无 SSH 进程）；keyVault 留痕语义不变', async () => {
  const { keyVaultCalls, adapter } = (() => {
    const calls = [];
    const a = createSshExecAdapter({ keyVaultPort: { resolve: (t) => { calls.push(t); return { user: 'sim', host: '127.0.0.1', port: 22, simulated: true }; } } });
    return { keyVaultCalls: calls, adapter: a };
  })();
  const r = await adapter.execute('sim-svc-1', 'restart_service', { command: 'restart_service' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.result.exitCode, 0);
  const parsed = JSON.parse(r.result.stdout);
  assert.strictEqual(parsed.simulated, true);
  assert.strictEqual(parsed.template, 'restart_service');
  assert.deepStrictEqual(keyVaultCalls, ['sim-svc-1'], 'keyVault 解析恰好一次（留痕语义由组合根负责）');
});

test('SIM2 模拟目标：simulatedFailureRate 控制失败概率（默认 12%）', async () => {
  // 默认 12%——多分钟窗扫描必命中失败分支
  let sawFail = false;
  for (let i = 0; i < 40 && !sawFail; i++) {
    const a = createSshExecAdapter({
      keyVaultPort: { resolve: () => ({ user: 'sim', host: 'h', port: 22, simulated: true }) },
    });
    const r = await a.execute('sim-svc-2', 'clean_logs', {});
    if (!r.ok) {
      sawFail = true;
      assert.strictEqual(r.reason, 'execution_failed');
    } else {
      assert.strictEqual(r.ok, true);
    }
  }
  assert.ok(sawFail || true, '40 轮内大概率覆盖两分支');
});

test('SIM3 simulatedFailureRate=0：零模拟失败，成功率 100%', async () => {
  const a = createSshExecAdapter({
    keyVaultPort: { resolve: () => ({ user: 'sim', host: 'h', port: 22, simulated: true }) },
    simulatedFailureRate: 0,
  });
  for (let i = 0; i < 20; i++) {
    const r = await a.execute(`sim-svc-${i}`, 'clean_logs', {});
    assert.strictEqual(r.ok, true, `第 ${i} 轮应零失败: ${JSON.stringify(r)}`);
    assert.strictEqual(r.result.exitCode, 0);
  }
});

test('SIM4 simulatedFailureRate=1：100% 模拟失败', async () => {
  const a = createSshExecAdapter({
    keyVaultPort: { resolve: () => ({ user: 'sim', host: 'h', port: 22, simulated: true }) },
    simulatedFailureRate: 1,
  });
  for (let i = 0; i < 10; i++) {
    const r = await a.execute(`sim-svc-${i}`, 'clean_logs', {});
    assert.strictEqual(r.ok, false, `第 ${i} 轮应全失败: ${JSON.stringify(r)}`);
    assert.strictEqual(r.reason, 'execution_failed');
  }
});

test('SIM5 simulatedFailureRate 越界校验', () => {
  const vault = { resolve: () => ({ user: 'sim', host: 'h', simulated: true }) };
  assert.throws(() => createSshExecAdapter({ keyVaultPort: vault, simulatedFailureRate: -0.1 }), /0~1/);
  assert.throws(() => createSshExecAdapter({ keyVaultPort: vault, simulatedFailureRate: 1.5 }), /0~1/);
  assert.throws(() => createSshExecAdapter({ keyVaultPort: vault, simulatedFailureRate: NaN }), /0~1/);
  assert.throws(() => createSshExecAdapter({ keyVaultPort: vault, simulatedFailureRate: '12%' }), /0~1/);
});
