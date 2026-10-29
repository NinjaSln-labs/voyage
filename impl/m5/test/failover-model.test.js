// failover 故障转移契约（t000045）：按失败类型分流 —— 凭据失效短路、限流计数跳过、分类归因可追溯
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createFailoverModel } = require('../scripts/run-ingress.js');

/** 造一家按脚本失败的供应商：依次抛出指定错误 */
function provider(id, errors, okValue = 'OK') {
  let i = 0;
  return {
    id,
    interpret: async () => {
      if (i < errors.length) {
        const e = errors[i++];
        throw e;
      }
      return okValue;
    },
  };
}

function httpErr(status, msg) {
  const e = new Error(msg || `http ${status}`);
  e.status = status;
  return e;
}

test('FO-I1 401 凭据失效 → 该家停用（后续请求不再试它），其余家照常兜底', async () => {
  let authCalls = 0;
  const auth = {
    id: 'auth-provider',
    interpret: async () => { authCalls++; throw httpErr(401, 'agens http 401'); },
  };
  let goodCalls = 0;
  const good = { id: 'good', interpret: async () => { goodCalls++; return 'GOOD'; } };
  const fo = createFailoverModel([auth, good]);

  const r1 = await fo.interpret('查状态', {});
  assert.strictEqual(r1, 'GOOD', '应跳过 401 的家、由后一家兜底');
  assert.strictEqual(authCalls, 1, '401 的家首次失败后不应再被调用');

  const r2 = await fo.interpret('查状态', {});
  assert.strictEqual(r2, 'GOOD');
  assert.strictEqual(authCalls, 1, '401 的家已停用：后续请求不得再试（重试无意义）');
  assert.strictEqual(goodCalls, 2);
});

test('FO-I2 403 同样短路（凭据类不止 401）', async () => {
  let calls = 0;
  const auth = { id: 'p403', interpret: async () => { calls++; throw httpErr(403, 'agens http 403'); } };
  const good = { id: 'g', interpret: async () => 'G' };
  const fo = createFailoverModel([auth, good]);
  assert.strictEqual(await fo.interpret('x', {}), 'G');
  assert.strictEqual(await fo.interpret('x', {}), 'G');
  assert.strictEqual(calls, 1, '403 的家应被停用');
});

test('FO-I3 429 连续达阈值 → 该家被跳过；成功一次即清零计数', async () => {
  let calls = 0;
  const limited = { id: 'rl', interpret: async () => { calls++; throw httpErr(429, 'http 429'); } };
  const good = { id: 'g', interpret: async () => 'G' };
  const fo = createFailoverModel([limited, good], { rateLimitSkipThreshold: 2 });

  await fo.interpret('x', {});
  assert.strictEqual(calls, 1);
  await fo.interpret('x', {});
  assert.strictEqual(calls, 2, '未达阈值前仍会试（第一次 429 不该立刻放弃）');
  await fo.interpret('x', {});
  assert.strictEqual(calls, 2, '连续 429 达阈值 → 该家被跳过，不再白等');
});

test('FO-I4 全链失败 → 抛错带分类与逐家明细（不是一句 provider_error）', async () => {
  const fo = createFailoverModel([
    provider('a', [httpErr(429, 'http 429')]),
    provider('b', [httpErr(401, 'http 401')]),
  ]);
  await assert.rejects(fo.interpret('x', {}), (e) => {
    assert.strictEqual(e.degradeReason, 'auth', '分类须落到最后一次失败的原因');
    assert.ok(Array.isArray(e.providerFailures), '须带逐家明细');
    assert.strictEqual(e.providerFailures.length, 2);
    assert.strictEqual(e.providerFailures[0].provider, 'a');
    assert.strictEqual(e.providerFailures[0].reason, 'rate_limit');
    assert.strictEqual(e.providerFailures[1].provider, 'b');
    assert.strictEqual(e.providerFailures[1].reason, 'auth');
    return true;
  });
});

test('FO-I5 超时归类为 timeout（AbortError / abort 文案）', async () => {
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  const fo = createFailoverModel([provider('a', [abort])]);
  await assert.rejects(fo.interpret('x', {}), (e) => {
    assert.strictEqual(e.degradeReason, 'timeout');
    return true;
  });
});

test('FO-I6 成功路径不受影响（零误伤）：第一家直接成功', async () => {
  const fo = createFailoverModel([{ id: 'ok', interpret: async () => 'V' }]);
  assert.strictEqual(await fo.interpret('x', {}), 'V');
});

test('FO-I8 健康度快照：每家成功/失败计数 + 最近失败原因 + 停用标记（t000045 ④）', async () => {
  // 顺序有意义：失败的家必须排在成功家之前，否则链在第一家就返回，后面的家不会被试（统计自然为 0）
  const fo = createFailoverModel([
    { id: 'limited', interpret: async () => { throw httpErr(429, 'http 429'); } },
    { id: 'broken', interpret: async () => { throw httpErr(401, 'http 401'); } },
    { id: 'good', interpret: async () => 'G' },
  ]);
  await fo.interpret('x', {});
  const h1 = fo.health();
  assert.strictEqual(h1.good.ok, 1, '成功计数');
  assert.strictEqual(h1.good.fail, 0);
  assert.strictEqual(h1.limited.fail, 1);
  assert.strictEqual(h1.limited.lastReason, 'rate_limit', '最近失败原因须可分辨处置');
  assert.strictEqual(h1.limited.rateLimitCount, 1);
  assert.strictEqual(h1.broken.lastReason, 'auth');
  assert.strictEqual(h1.broken.disabled, true, '凭据失效的家须标停用（后续请求不再试）');

  // 成功清零限流计数（成功即清零；此处构造：先 429 一次，再成功一次）
  let flakyCalls = 0;
  const fo2 = createFailoverModel([
    { id: 'flaky', interpret: async () => { flakyCalls++; if (flakyCalls === 1) throw httpErr(429, 'http 429'); return 'F'; } },
    { id: 'backup', interpret: async () => 'B' },
  ]);
  await fo2.interpret('x', {});
  assert.strictEqual(fo2.health().flaky.rateLimitCount, 1, '429 后限流计数为 1');
  await fo2.interpret('x', {});
  assert.strictEqual(fo2.health().flaky.rateLimitCount, 0, '成功即清零限流计数');
  assert.strictEqual(fo2.health().flaky.ok, 1, '成功计数');
});

test('FO-I7 端到端：failover 分类 → model-api → domain（t000045 全链贯通）', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { compose } = require('../src/compose.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-fo-e2e-'));
  try {
    const authFail = { id: 'auth', interpret: async () => { const e = new Error('agens http 401'); e.status = 401; throw e; } };
    const fo = createFailoverModel([authFail]);
    const app = compose({
      mode: 'real',
      audit: { file: path.join(dir, 'audit.jsonl') },
      repo: {
        identityFile: path.join(dir, 'i.json'),
        assetFile: path.join(dir, 'a.json'),
        identitySeed: [{ id: 'u1', role: 'sre' }],
        assetSeed: [{ id: 'svc-1' }],
      },
      exec: { keyVaultPort: { resolve: () => null } },
      model: { provider: 'failover', registry: { failover: fo } },
    });
    const r = await app.handleAsync({ actorId: 'u1', from: 'http', intent: '执行命令 shutdown -h now' });
    assert.strictEqual(r.status, 'NEED_REVIEW', '降级须转审核');
    assert.strictEqual(r.degradeReason, 'auth', '凭据失效须贯通到编排层返回值');
    // 审计落分类
    const lines = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean);
    const rec = lines.map((l) => JSON.parse(l)).find((e) => e.entry && e.entry.links && e.entry.links.degradeReason);
    assert.ok(rec, '审计须落 degradeReason');
    assert.strictEqual(rec.entry.links.degradeReason, 'auth');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
