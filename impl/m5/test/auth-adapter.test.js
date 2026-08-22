// 认证适配器契约测试（authPort 落地）
// 验证：mTLS（指纹信任+CRL 吊销）、WebAuthn（结构/challenge 绑定/计数器防重放/吊销即时失效）、
//      JWT（alg 白名单禁 none/HMAC 恒时验签/exp/claim 白名单投影）、会话生命周期（签发/校验/吊销/过期）

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createAuthAdapter, JWT_ALG_WHITELIST } = require('../src/auth/auth-adapter.js');
const { createIdentityRepoMemory } = require('../src/repo/repo-identity.js');

const FP_GOOD = 'a'.repeat(64);
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function makeAdapter(over = {}) {
  const identities = createIdentityRepoMemory([
    { id: 'sre-alice', role: 'sre' },
    { id: 'dev-bob', role: 'dev' },
    { id: 'gone-carl', role: 'dev', active: false },
  ]);
  const creds = new Map([
    ['cred-alice-key', { userId: 'sre-alice', signCounter: 5, active: true }],
    ['cred-dead-key', { userId: 'dev-bob', signCounter: 1, active: false }],
  ]);
  return createAuthAdapter({
    identityRepo: identities,
    mtlsTrustedFingerprints: [FP_GOOD],
    webauthnCredentials: creds,
    jwtSecret: 'test-secret',
    ...over,
  });
}

// ---------- mTLS ----------

test('M1 mTLS：受信任指纹 + 活跃身份 → 认证通过 + 会话签发', () => {
  const auth = makeAdapter();
  const r = auth.authenticate({ type: 'mtls', subjectCN: 'sre-alice', fingerprintSHA256: FP_GOOD });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.identity.id, 'sre-alice');
  assert.strictEqual(r.identity.role, 'sre');
  assert.ok(r.identity.sessionId);
});

test('M2 mTLS：无证/畸形/不受信/已吊销 → 拒绝（RQ-611 无证拒绝接入）', () => {
  const auth = makeAdapter();
  assert.strictEqual(auth.authenticate({ type: 'mtls' }).reason, 'missing_subject', '无 subject 拒绝');
  assert.strictEqual(auth.authenticate({ type: 'mtls', subjectCN: 'x' }).reason, 'invalid_fingerprint', '无指纹拒绝（无证接入）');
  assert.strictEqual(auth.authenticate({ type: 'mtls', subjectCN: 'x', fingerprintSHA256: 'ZZ' }).reason, 'invalid_fingerprint');
  assert.strictEqual(auth.authenticate({ type: 'mtls', subjectCN: 'sre-alice', fingerprintSHA256: 'b'.repeat(64) }).reason, 'untrusted_certificate');
  const revoked = makeAdapter({ mtlsRevoked: new Set([FP_GOOD]) });
  assert.strictEqual(revoked.authenticate({ type: 'mtls', subjectCN: 'sre-alice', fingerprintSHA256: FP_GOOD }).reason, 'certificate_revoked');
});

test('M3 mTLS：身份停用 → 拒绝（fail-closed）', () => {
  const auth = makeAdapter();
  const r = auth.authenticate({ type: 'mtls', subjectCN: 'gone-carl', fingerprintSHA256: FP_GOOD });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'identity_not_found');
});

// ---------- WebAuthn ----------

function webauthnCred(over = {}) {
  return {
    type: 'webauthn',
    credentialId: 'cred-alice-key',
    authenticatorData: 'AnY', // 非空占位（密码学验签归 @simplewebauthn 替换点）
    clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: 'ch-123', origin: 'https://voyage.example' })).toString('base64url'),
    signature: 'sig',
    expectedChallenge: 'ch-123',
    expectedOrigin: 'https://voyage.example',
    signCounter: 6,
    ...over,
  };
}

test('W1 WebAuthn：结构完整 + challenge 匹配 + 计数器递增 → 通过', () => {
  const auth = makeAdapter();
  const r = auth.authenticate(webauthnCred());
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.identity.id, 'sre-alice');
});

test('W2 WebAuthn：challenge 不匹配 → 拒绝（防重放核心）', () => {
  const auth = makeAdapter();
  assert.strictEqual(auth.authenticate(webauthnCred({ expectedChallenge: 'other' })).reason, 'challenge_mismatch');
  assert.strictEqual(auth.authenticate(webauthnCred({ expectedChallenge: undefined })).reason, 'challenge_mismatch');
});

test('W3 WebAuthn：计数器不增 → 拒绝（克隆/重放检测）', () => {
  const auth = makeAdapter();
  assert.strictEqual(auth.authenticate(webauthnCred({ signCounter: 5 })).reason, 'counter_replay', '等于上次计数拒绝');
  assert.strictEqual(auth.authenticate(webauthnCred({ signCounter: 3 })).reason, 'counter_replay', '小于上次计数拒绝');
});

test('W4 WebAuthn：吊销即时失效（RQ-612）+ 未注册凭据拒绝', () => {
  const auth = makeAdapter();
  assert.strictEqual(auth.authenticate(webauthnCred({ credentialId: 'cred-ghost' })).reason, 'credential_not_registered');
  assert.strictEqual(auth.authenticate(webauthnCred({ credentialId: 'cred-dead-key' })).reason, 'credential_not_registered', '已吊销密钥');
  // 运行时吊销后旧密钥即时失效
  assert.strictEqual(auth.revokeWebAuthnCredential('cred-alice-key').ok, true);
  assert.strictEqual(auth.authenticate(webauthnCred()).reason, 'credential_not_registered');
});

test('W5 WebAuthn：缺必填字段/畸形 clientData/type 错误 → 拒绝', () => {
  const auth = makeAdapter();
  assert.strictEqual(auth.authenticate(webauthnCred({ signature: undefined })).reason, 'missing_signature');
  assert.strictEqual(auth.authenticate(webauthnCred({ clientDataJSON: 'not-base64!!' })).reason, 'malformed_client_data');
  const wrongType = webauthnCred();
  wrongType.clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: 'ch-123' })).toString('base64url');
  assert.strictEqual(auth.authenticate(wrongType).reason, 'wrong_client_data_type');
});

// ---------- JWT ----------

function jwt(payload, secret = 'test-secret', alg = 'HS256') {
  const head = b64url({ alg, typ: 'JWT' });
  const body = b64url(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

test('J1 JWT：合法 HS256 token → 认证通过（sub 投影受管身份）', () => {
  const auth = makeAdapter();
  const token = jwt({ sub: 'dev-bob', exp: Math.floor(Date.now() / 1000) + 600 });
  const r = auth.authenticate({ type: 'jwt', token });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.identity.id, 'dev-bob');
  assert.strictEqual(r.identity.role, 'dev');
});

test('J2 JWT：alg=none / 未列算法 → 拒绝（RQ-811 白名单）', () => {
  const auth = makeAdapter();
  // alg=none：空签名
  const head = b64url({ alg: 'none', typ: 'JWT' });
  const body = b64url({ sub: 'dev-bob', exp: Math.floor(Date.now() / 1000) + 600 });
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: `${head}.${body}.` }).reason, 'alg_not_allowed');
  // alg 混淆（HS512 不在白名单）
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: jwt({ sub: 'dev-bob' }, 'test-secret', 'HS512') }).reason, 'alg_not_allowed');
  assert.deepStrictEqual([...JWT_ALG_WHITELIST], ['HS256']);
});

test('J3 JWT：签名篡改/密钥错误 → 拒绝（恒时比较）', () => {
  const auth = makeAdapter();
  const evil = jwt({ sub: 'sre-alice', exp: Math.floor(Date.now() / 1000) + 600 }, 'wrong-secret');
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: evil }).reason, 'signature_invalid');
  // 合法签名但 sub 改包后签名不匹配
  const token = jwt({ sub: 'dev-bob', exp: Math.floor(Date.now() / 1000) + 600 });
  const [h, , s] = token.split('.');
  const forgedBody = b64url({ sub: 'sre-alice', exp: Math.floor(Date.now() / 1000) + 600 });
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: `${h}.${forgedBody}.${s}` }).reason, 'signature_invalid');
});

test('J4 JWT：过期/未生效 → 拒绝', () => {
  const auth = makeAdapter();
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: jwt({ sub: 'dev-bob', exp: Math.floor(Date.now() / 1000) - 10 }) }).reason, 'token_expired');
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: jwt({ sub: 'dev-bob', exp: Math.floor(Date.now() / 1000) + 600, nbf: Math.floor(Date.now() / 1000) + 300 }) }).reason, 'token_not_yet_valid');
});

test('J5 JWT：claim 白名单——sub 不在受管身份目录 → 拒绝（token 自报身份不可信，RQ-811）', () => {
  const auth = makeAdapter();
  const token = jwt({ sub: 'hacker-self-claimed', role: 'sre', exp: Math.floor(Date.now() / 1000) + 600 });
  const r = auth.authenticate({ type: 'jwt', token });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'identity_not_found', 'token 自报 role 不被采信');
});

// ---------- 会话生命周期 ----------

test('S1 会话：校验/吊销/过期', async () => {
  const auth = makeAdapter({ sessionTtlMs: 50 });
  const r = auth.authenticate({ type: 'mtls', subjectCN: 'sre-alice', fingerprintSHA256: FP_GOOD });
  const sid = r.identity.sessionId;
  assert.strictEqual(auth.validateSession(sid).ok, true);
  // 吊销即时失效
  auth.revokeSession(sid);
  assert.strictEqual(auth.validateSession(sid).reason, 'session_revoked');
  // 过期
  const r2 = auth.authenticate({ type: 'mtls', subjectCN: 'sre-alice', fingerprintSHA256: FP_GOOD });
  await new Promise(res => setTimeout(res, 60));
  assert.strictEqual(auth.validateSession(r2.identity.sessionId).reason, 'session_expired');
});

test('S2 构造校验：identityRepo 必填/sessionTtlMs 正有限（第 11 波）', () => {
  assert.throws(() => createAuthAdapter({}), /identityRepo 必填/);
  assert.throws(() => makeAdapter({ sessionTtlMs: NaN }), /正有限数值/);
  assert.throws(() => makeAdapter({ sessionTtlMs: -1 }), /正有限数值/);
});

test('S3 未知凭据类型 → unsupported（不抛错，契约 REJECTED 语义）', () => {
  const auth = makeAdapter();
  assert.strictEqual(auth.authenticate({ type: 'password', user: 'x' }).reason, 'unsupported_credential_type');
  assert.strictEqual(auth.authenticate(null).reason, 'invalid_credential');
});
