// HTTP 统一入口契约测试：认证门禁 / 意图编排 / 审批解析+运行时执行 / fail-closed 错误语义
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createHttpIngress } = require('../src/server/http-ingress.js');
const { compose } = require('../src/compose.js');
const { createAuthAdapter, JWT_ALG_WHITELIST } = require('../src/auth/auth-adapter.js');
const crypto = require('node:crypto');
const { createIdentityRepoMemory } = require('../src/repo/repo-identity.js');

const SECRET = 'ingress-test-secret';
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function hsJwt(payload) {
  const head = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
const EXP_OK = () => Math.floor(Date.now() / 1000) + 600;

async function request(port, method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: encodeURI(path),
      agent: new http.Agent({ keepAlive: false }),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'content-type': 'application/json' } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** mock 整链 + JWT 认证面 */
async function mkStack() {
  const identities = createIdentityRepoMemory([
    { id: 'sre-alice', role: 'sre' },
    { id: 'dev-bob', role: 'dev' },
  ]);
  const auth = createAuthAdapter({
    identityRepo: identities,
    jwtSecret: SECRET,
    webauthnCredentials: new Map([['cred-alice-key', { userId: 'sre-alice', signCounter: 5, active: true }]]),
  });
  const app = compose({
    mode: 'mock',
    repo: {
      assetSeed: [{ id: 'svc-1' }],
      identitySeed: [{ id: 'sre-alice', role: 'sre' }, { id: 'dev-bob', role: 'dev' }],
    },
  });
  app.adapters.exec.registerResult('svc-1', 'restart_service', { stdout: 'Restarted', stderr: '', exitCode: 0, nodeEffects: [] });
  const ingress = createHttpIngress({ app, auth, port: 0 });
  const port = await ingress.listen();
  return { ingress, port, auth };
}

test('H1 healthz 免认证可达；未知路由 404', async () => {
  const { ingress, port } = await mkStack();
  try {
    const h = await request(port, 'GET', '/healthz');
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.body.ok, true);
    const nf = await request(port, 'GET', '/v1/nothing');
    assert.strictEqual(nf.status, 404);
  } finally { await ingress.close(); }
});

test('H2 认证门禁：缺 token/坏 token/过期 token → 401（不泄漏内部细节）', async () => {
  const { ingress, port } = await mkStack();
  try {
    assert.strictEqual((await request(port, 'POST', '/v1/intent', { body: { intent: '看看 svc-1' } })).status, 401);
    assert.strictEqual((await request(port, 'POST', '/v1/intent', { token: 'garbage', body: { intent: 'x' } })).body.reason, 'malformed_token');
    const expired = hsJwt({ sub: 'dev-bob', exp: Math.floor(Date.now() / 1000) - 10 });
    assert.strictEqual((await request(port, 'POST', '/v1/intent', { token: expired, body: { intent: 'x' } })).body.reason, 'token_expired');
  } finally { await ingress.close(); }
});

test('H3 查询意图整链：合法 JWT → OK(kind=query)，actorId 取自身份非请求体', async () => {
  const { ingress, port } = await mkStack();
  try {
    const r = await request(port, 'POST', '/v1/intent', {
      token: hsJwt({ sub: 'dev-bob', exp: EXP_OK() }),
      body: { intent: '看看 svc-1 的状态', actorId: 'fake-admin' }, // 自报 actorId 必须被忽略
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, 'OK');
    assert.strictEqual(r.body.kind, 'query');
  } finally { await ingress.close(); }
});

test('H4 高危审批全链：intent→NEED_REVIEW→双人批准→Grant→自动执行→作业终态可查', async () => {
  const { ingress, port } = await mkStack();
  try {
    // a) 高危意图 → NEED_REVIEW + approvalId（投票人清单不下发）
    const r1 = await request(port, 'POST', '/v1/intent', {
      token: hsJwt({ sub: 'sre-alice', exp: EXP_OK() }),
      body: { intent: '重启 svc-1' },
    });
    assert.strictEqual(r1.body.status, 'NEED_REVIEW', JSON.stringify(r1.body));
    assert.ok(r1.body.approvalId);
    assert.strictEqual(r1.body.resolversHint, undefined);

    // b) 未终态前重复解析同一单 → 404 防护在终态后生效；先正常批准
    const r2 = await request(port, 'POST', '/v1/approvals/resolve', {
      token: hsJwt({ sub: 'sre-alice', exp: EXP_OK() }),
      body: { approvalId: r1.body.approvalId, votes: ['sre-b', 'sre-c'] },
    });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
    assert.strictEqual(r2.body.status, 'approved');
    assert.ok(r2.body.jobId);
    assert.strictEqual(r2.body.execution.status, 'OK');

    // c) 终态后审批单移除 → 404（防重放已决审批）
    const r3 = await request(port, 'POST', '/v1/approvals/resolve', {
      token: hsJwt({ sub: 'sre-alice', exp: EXP_OK() }),
      body: { approvalId: r1.body.approvalId, votes: ['sre-b', 'sre-c'] },
    });
    assert.strictEqual(r3.status, 404);

    // d) 作业只读投影（属主校验）：creator 可查；他人 403
    const j = await request(port, 'GET', `/v1/jobs/${r2.body.jobId}`, { token: hsJwt({ sub: 'sre-alice', exp: EXP_OK() }) });
    assert.strictEqual(j.status, 200);
    assert.strictEqual(j.body.status, 'completed');
    assert.strictEqual(j.body.target, 'svc-1');
    const jOther = await request(port, 'GET', `/v1/jobs/${r2.body.jobId}`, { token: hsJwt({ sub: 'dev-bob', exp: EXP_OK() }) });
    assert.strictEqual(jOther.status, 403);
    assert.strictEqual(jOther.body.error, 'not_job_owner');
  } finally { await ingress.close(); }
});

test('H7 审批解析授权面（初审 P1 锚定）：跨身份解析他人审批单 → 403', async () => {
  const { ingress, port } = await mkStack();
  try {
    const r1 = await request(port, 'POST', '/v1/intent', {
      token: hsJwt({ sub: 'sre-alice', exp: EXP_OK() }),
      body: { intent: '重启 svc-1' },
    });
    // dev-bob 尝试解析 sre-alice 的审批单 → 403 not_approval_owner
    const r2 = await request(port, 'POST', '/v1/approvals/resolve', {
      token: hsJwt({ sub: 'dev-bob', exp: EXP_OK() }),
      body: { approvalId: r1.body.approvalId, votes: ['sre-b', 'sre-c'] },
    });
    assert.strictEqual(r2.status, 403);
    assert.strictEqual(r2.body.error, 'not_approval_owner');
    // 属主仍可正常解析（单未被破坏）
    const r3 = await request(port, 'POST', '/v1/approvals/resolve', {
      token: hsJwt({ sub: 'sre-alice', exp: EXP_OK() }),
      body: { approvalId: r1.body.approvalId, votes: ['sre-b', 'sre-c'] },
    });
    assert.strictEqual(r3.body.status, 'approved', JSON.stringify(r3.body));
  } finally { await ingress.close(); }
});

test('H8 超限载荷（初审 P2 竞态锚定）：>64KB → 客户端收到完整 413 响应', async () => {
  const { ingress, port } = await mkStack();
  try {
    const big = { intent: 'x'.repeat(70 * 1024) };
    const r = await request(port, 'POST', '/v1/intent', { token: hsJwt({ sub: 'dev-bob', exp: EXP_OK() }), body: big });
    assert.strictEqual(r.status, 413);
    assert.strictEqual(r.body.error, 'payload_too_large');
  } finally { await ingress.close(); }
});

test('H9 投票卫生（初审 P2/P3 锚定）：重复票归一、空票保持 pending 可重试', async () => {
  const { ingress, port } = await mkStack();
  try {
    // a) 重复票去重后仍有效（不 500）
    const r1 = await request(port, 'POST', '/v1/intent', {
      token: hsJwt({ sub: 'sre-alice', exp: EXP_OK() }),
      body: { intent: '重启 svc-1' },
    });
    const r2 = await request(port, 'POST', '/v1/approvals/resolve', {
      token: hsJwt({ sub: 'sre-alice', exp: EXP_OK() }),
      body: { approvalId: r1.body.approvalId, votes: ['sre-b', 'sre-b', 'sre-c'] },
    });
    assert.strictEqual(r2.body.status, 'approved', JSON.stringify(r2.body));
  } finally { await ingress.close(); }
  // b) 空票：独立实例（避开 a 的意图幂等键）——不终态、条目保留可重试
  const { ingress: i2, port: p2 } = await mkStack();
  try {
    const r1 = await request(p2, 'POST', '/v1/intent', {
      token: hsJwt({ sub: 'sre-alice', exp: EXP_OK() }),
      body: { intent: '重启 svc-1' },
    });
    assert.strictEqual(r1.body.status, 'NEED_REVIEW');
    const rEmpty = await request(p2, 'POST', '/v1/approvals/resolve', {
      token: hsJwt({ sub: 'sre-alice', exp: EXP_OK() }),
      body: { approvalId: r1.body.approvalId, votes: [] },
    });
    assert.ok(rEmpty.body.status !== 'approved', JSON.stringify(rEmpty.body));
    // 条目仍在：补票后可批准
    const rRetry = await request(p2, 'POST', '/v1/approvals/resolve', {
      token: hsJwt({ sub: 'sre-alice', exp: EXP_OK() }),
      body: { approvalId: r1.body.approvalId, votes: ['sre-b', 'sre-c'] },
    });
    assert.strictEqual(rRetry.body.status, 'approved', JSON.stringify(rRetry.body));
  } finally { await i2.close(); }
});

test('H5 fail-closed 输入卫生：畸形 JSON/超限载荷/非法 intent → 400/413', async () => {
  const { ingress, port } = await mkStack();
  try {
    const token = hsJwt({ sub: 'dev-bob', exp: EXP_OK() });
    // 畸形 JSON
    const bad = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/intent',
        agent: new http.Agent({ keepAlive: false }),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
        let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', reject); req.end('{ not json');
    });
    assert.strictEqual(bad.status, 400);
    // intent 缺失/超长
    assert.strictEqual((await request(port, 'POST', '/v1/intent', { token, body: {} })).status, 400);
    assert.strictEqual((await request(port, 'POST', '/v1/intent', { token, body: { intent: 'x'.repeat(5000) } })).status, 400);
  } finally { await ingress.close(); }
});

test('H6 构造校验：app/auth 必填 fail-fast', () => {
  assert.throws(() => createHttpIngress({}), /app/);
  const identities = createIdentityRepoMemory([{ id: 'u', role: 'sre' }]);
  assert.throws(() => createHttpIngress({ app: compose({ mode: 'mock' }) }), /auth/);
});
