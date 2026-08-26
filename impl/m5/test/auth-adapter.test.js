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
  assert.deepStrictEqual([...JWT_ALG_WHITELIST], ['HS256', 'RS256']);
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

// ---------- JWT RS256/IdP JWKS（零依赖落地：kid 定位 + 算法族硬隔离防混淆 + 轮换） ----------

const { privateKey: RSA_PRIV, publicKey: RSA_PUB } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: RSA_PRIV_2, publicKey: RSA_PUB_2 } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_PUB_PEM = RSA_PUB.export({ type: 'spki', format: 'pem' });

function rsJwt(payload, privKey, kid, headerOverride = null) {
  const headObj = headerOverride || { alg: 'RS256', typ: 'JWT' };
  if (kid !== undefined && kid !== null) headObj.kid = kid;
  const head = b64url(headObj);
  const body = b64url(payload);
  const signer = crypto.createSign('SHA256');
  signer.update(`${head}.${body}`);
  signer.end();
  return `${head}.${body}.${signer.sign(privKey, 'base64url')}`;
}

const EXP_OK = { sub: 'dev-bob', exp: Math.floor(Date.now() / 1000) + 600 };

test('J6 RS256+JWKS：合法 token（kid 命中）→ 认证通过；过期 → 拒绝', () => {
  const auth = makeAdapter({ jwtSecret: null, jwksKeys: { 'key-2026-08': RSA_PUB } });
  const r = auth.authenticate({ type: 'jwt', token: rsJwt(EXP_OK, RSA_PRIV, 'key-2026-08') });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.identity.id, 'dev-bob');
  // exp 约束在 RS256 路径同样生效
  const expired = rsJwt({ sub: 'dev-bob', exp: Math.floor(Date.now() / 1000) - 10 }, RSA_PRIV, 'key-2026-08');
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: expired }).reason, 'token_expired');
});

test('J7 RS256 单静态公钥：无 kid → 用 jwtPublicKey 验签通过', () => {
  const auth = makeAdapter({ jwtSecret: null, jwtPublicKey: RSA_PUB });
  const r = auth.authenticate({ type: 'jwt', token: rsJwt(EXP_OK, RSA_PRIV) });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('J8 RS256 fail-closed：未知 kid / 缺 kid（JWKS 多钥模式）→ signing_key_not_found', () => {
  const auth = makeAdapter({ jwtSecret: null, jwksKeys: { 'key-a': RSA_PUB } });
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: rsJwt(EXP_OK, RSA_PRIV, 'key-unknown') }).reason, 'signing_key_not_found');
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: rsJwt(EXP_OK, RSA_PRIV) }).reason, 'signing_key_not_found');
});

test('J9 算法族硬隔离（RQ-811 密钥混淆防御核心）', () => {
  // a) 经典混淆攻击：攻击者拿 RSA 公钥当 HMAC 密钥自签 HS256（alg 头改 HS256、签名重算）——
  //    即使 adapter 同时配置 jwtSecret + JWKS，HS 路径只认 jwtSecret → 公钥自签必拒
  const confusedHead = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url(EXP_OK);
  const evilSig = crypto.createHmac('sha256', RSA_PUB_PEM).update(`${confusedHead}.${body}`).digest('base64url');
  const evilToken = `${confusedHead}.${body}.${evilSig}`;
  const dualAuth = makeAdapter({ jwksKeys: { 'key-a': RSA_PUB } }); // jwtSecret 默认存在
  assert.strictEqual(dualAuth.authenticate({ type: 'jwt', token: evilToken }).reason, 'signature_invalid');
  // b) RS-only 部署收到 HS256 → 拒绝（不静默降级）
  const rsOnly = makeAdapter({ jwtSecret: null, jwksKeys: { 'key-a': RSA_PUB } });
  assert.strictEqual(rsOnly.authenticate({ type: 'jwt', token: jwt(EXP_OK) }).reason, 'jwt_secret_not_configured');
  // c) HS-only 部署收到 RS256 → 拒绝（共享密钥不进 RSA 路径，alg_not_configured 显式报因）
  const hsOnly = makeAdapter(); // 仅 jwtSecret
  assert.strictEqual(hsOnly.authenticate({ type: 'jwt', token: rsJwt(EXP_OK, RSA_PRIV, 'k') }).reason, 'alg_not_configured');
});

test('J10 RS256 签名面：错误密钥对 / payload 篡改 → signature_invalid', () => {
  const auth = makeAdapter({ jwtSecret: null, jwksKeys: { 'key-a': RSA_PUB } });
  // 错误密钥对（另一把私钥签名）
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: rsJwt(EXP_OK, RSA_PRIV_2, 'key-a') }).reason, 'signature_invalid');
  // payload 篡改（换 sub 提权尝试）
  const token = rsJwt(EXP_OK, RSA_PRIV, 'key-a');
  const parts = token.split('.');
  const tampered = `${parts[0]}.${b64url({ sub: 'sre-alice', exp: EXP_OK.exp })}.${parts[2]}`;
  const r = auth.authenticate({ type: 'jwt', token: tampered });
  assert.strictEqual(r.reason, 'signature_invalid'); // claim 白名单前置防线不被绕过
});

test('J11 JWKS 轮换：rotateJwks 原子替换 + revokeJwksKey 即时失效', () => {
  const auth = makeAdapter({ jwtSecret: null, jwksKeys: { 'key-old': RSA_PUB } });
  // 旧钥通过
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: rsJwt(EXP_OK, RSA_PRIV, 'key-old') }).ok, true);
  // 轮换到新钥
  auth.rotateJwks({ 'key-new': RSA_PUB_2 });
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: rsJwt(EXP_OK, RSA_PRIV_2, 'key-new') }).ok, true, '新钥可用');
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: rsJwt(EXP_OK, RSA_PRIV, 'key-old') }).reason, 'signing_key_not_found', '旧钥轮出即失效');
  // 单钥应急吊销
  auth.revokeJwksKey('key-new');
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: rsJwt(EXP_OK, RSA_PRIV_2, 'key-new') }).reason, 'signing_key_not_found');
});

test('J12 全未配置 JWT 材料：fail-closed 显式报因（不抛错）', () => {
  const auth = makeAdapter({ jwtSecret: null });
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: jwt(EXP_OK) }).reason, 'jwt_secret_not_configured');
});

// ---------- RS256 初审修复锚定（P1-1/P1-2/P2-3/P2-5） ----------

test('J13 RS256 时间/形态补面：nbf 生效 + KeyObject 直接注入可用', () => {
  // nbf 未生效窗口 → 拒绝
  const auth = makeAdapter({ jwtSecret: null, jwksKeys: { 'key-a': RSA_PUB } });
  const nbfFuture = rsJwt({ sub: 'dev-bob', exp: Math.floor(Date.now() / 1000) + 600, nbf: Math.floor(Date.now() / 1000) + 300 }, RSA_PRIV, 'key-a');
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: nbfFuture }).reason, 'token_not_yet_valid');
  // KeyObject 形态直接注入（非 PEM 字符串）
  const koAuth = makeAdapter({ jwtSecret: null, jwksKeys: { 'key-ko': RSA_PUB } });
  assert.strictEqual(koAuth.authenticate({ type: 'jwt', token: rsJwt(EXP_OK, RSA_PRIV, 'key-ko') }).ok, true);
});

test('J14 JWKS 轮换防御：空/非法输入拒绝（不自拆认证门）', () => {
  const auth = makeAdapter({ jwtSecret: null, jwksKeys: { 'key-a': RSA_PUB } });
  assert.strictEqual(auth.rotateJwks(null).reason, 'invalid_jwks_payload');
  assert.strictEqual(auth.rotateJwks({}).reason, 'invalid_jwks_payload');
  assert.strictEqual(auth.rotateJwks(new Map()).reason, 'invalid_jwks_payload');
  // 拒绝后旧钥集不受影响（原子性：拒绝不产生半更新）
  assert.strictEqual(auth.authenticate({ type: 'jwt', token: rsJwt(EXP_OK, RSA_PRIV, 'key-a') }).ok, true);
});

test('J15 构造互斥校验：jwtPublicKey 与 jwksKeys 并存 → fail-fast（消除无 kid 解析歧义）', () => {
  assert.throws(() => makeAdapter({ jwtSecret: null, jwtPublicKey: RSA_PUB, jwksKeys: { 'key-a': RSA_PUB_2 } }), /互斥/);
});

test('J16 坏公钥显式报因：非法 PEM → signing_key_invalid（不混入 signature_invalid 掩盖配置错误）', () => {
  const badAuth = makeAdapter({ jwtSecret: null, jwtPublicKey: 'not-a-pem' });
  assert.strictEqual(badAuth.authenticate({ type: 'jwt', token: rsJwt(EXP_OK, RSA_PRIV) }).reason, 'signing_key_invalid');
  // revokeJwksKey 幂等：重复吊销同一 kid 不抛错
  const auth = makeAdapter({ jwtSecret: null, jwksKeys: { 'key-a': RSA_PUB } });
  assert.strictEqual(auth.revokeJwksKey('key-a').ok, true);
  assert.strictEqual(auth.revokeJwksKey('key-a').ok, false); // 已不存在，幂等返回 false
});

// ---------- WebAuthn 真实验签（webauthnVerifier 注入路径；async 通道） ----------

test('WA1 同步契约显式报因：注入 verifier 后 sync authenticate → webauthn_async_required（不静默降级）', async () => {
  const creds = new Map([['cred-alice-key', { userId: 'sre-alice', signCounter: 1, active: true, publicKeyB64u: 'AAEC' }]]);
  const auth = makeAdapter({ webauthnVerifier: { verifyAssertion: async () => ({ verified: true, newCounter: 2 }) }, webauthnCredentials: creds });
  const cred = webauthnCred();
  assert.strictEqual(auth.authenticate(cred).reason, 'webauthn_async_required');
  // 异步通道：真实验签形态（response 载荷）→ 可用
  const real = { type: 'webauthn', credentialId: 'cred-alice-key', response: { id: 'cred-alice-key' }, expectedChallenge: 'chal-1' };
  const r = await auth.authenticateAsync(real);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('WA2 真实验签主链：验签通过 → 计数器更新 + 会话签发', async () => {
  let called = null;
  const verifier = {
    verifyAssertion: async (p) => { called = p; return { verified: true, newCounter: 42 }; },
  };
  const creds = new Map([['cred-alice-key', { userId: 'sre-alice', signCounter: 5, active: true, publicKeyB64u: 'AAEC' }]]);
  const auth = makeAdapter({ webauthnVerifier: verifier, webauthnCredentials: creds });
  const cred = { type: 'webauthn', credentialId: 'cred-alice-key', response: { id: 'cred-alice-key' }, expectedChallenge: 'chal-1' };
  const r = await auth.authenticateAsync(cred);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.identity.id, 'sre-alice');
  assert.strictEqual(called.currentCounter, 5, '旧计数器传入库');
  assert.strictEqual(creds.get('cred-alice-key').signCounter, 42, '新计数器回写（防重放基线推进）');
});

test('WA3 重放防御：库返回计数器不增 → counter_replay 拒绝且不回写', async () => {
  const verifier = { verifyAssertion: async () => ({ verified: true, newCounter: 5 }) };
  const creds = new Map([['cred-alice-key', { userId: 'sre-alice', signCounter: 10, active: true, publicKeyB64u: 'AAEC' }]]);
  const auth = makeAdapter({ webauthnVerifier: verifier, webauthnCredentials: creds });
  const cred = { type: 'webauthn', credentialId: 'cred-alice-key', response: { id: 'x' }, expectedChallenge: 'c' };
  const r = await auth.authenticateAsync(cred);
  assert.strictEqual(r.reason, 'counter_replay');
  assert.strictEqual(creds.get('cred-alice-key').signCounter, 10, '拒绝时不推进基线');
});

test('WA4 失败语义归一：未注册/已吊销/缺公钥/缺挑战/库拒绝', async () => {
  const verifier = { verifyAssertion: async () => { const e = new Error('x'); e.reason = 'assertion_rejected:challenge mismatch'; throw e; } };
  const creds = new Map([
    ['cred-ok', { userId: 'sre-alice', signCounter: 0, active: true, publicKeyB64u: 'AAEC' }],
    ['cred-dead', { userId: 'sre-alice', signCounter: 0, active: false, publicKeyB64u: 'AAEC' }],
    ['cred-nopk', { userId: 'sre-alice', signCounter: 0, active: true }],
  ]);
  const auth = makeAdapter({ webauthnVerifier: verifier, webauthnCredentials: creds });
  const mk = (id, over = {}) => ({ type: 'webauthn', credentialId: id, response: { id }, expectedChallenge: 'c', ...over });
  assert.strictEqual((await auth.authenticateAsync(mk('cred-unknown'))).reason, 'credential_not_registered');
  assert.strictEqual((await auth.authenticateAsync(mk('cred-dead'))).reason, 'credential_not_registered', '吊销即时失效');
  assert.strictEqual((await auth.authenticateAsync(mk('cred-nopk'))).reason, 'credential_missing_public_key');
  assert.strictEqual((await auth.authenticateAsync(mk('cred-ok', { expectedChallenge: null }))).reason, 'challenge_mismatch');
  assert.strictEqual((await auth.authenticateAsync(mk('cred-ok'))).reason, 'assertion_rejected:challenge mismatch', '库拒绝原因透传');
  assert.strictEqual((await auth.authenticateAsync({ type: 'webauthn', credentialId: 'cred-ok' })).reason, 'invalid_credential');
});

// ---------- WA 初审修复锚定（counter=0 基线 / 桩路径 async / newCounter 缺失拒绝） ----------

test('WA5 桩路径 authenticateAsync：未注入 verifier 时与同步桩语义一致', async () => {
  const auth = makeAdapter();
  const r = await auth.authenticateAsync(webauthnCred());
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const dead = await auth.authenticateAsync(webauthnCred({ credentialId: 'cred-dead-key' }));
  assert.strictEqual(dead.reason, 'credential_not_registered');
});

test('WA6 计数器 0 基线边界（初审 P1 锚定）：无计数器认证器（恒 0）可用；基线推进后同值重放拒绝', async () => {
  // a) 无计数器认证器：注册/断言均 0 → 不误判重放（WebAuthn 标准行为）
  const vZero = { verifyAssertion: async () => ({ verified: true, newCounter: 0 }) };
  const creds0 = new Map([['cred-alice-key', { userId: 'sre-alice', signCounter: 0, active: true, publicKeyB64u: 'AAEC' }]]);
  const a1 = makeAdapter({ webauthnVerifier: vZero, webauthnCredentials: creds0 });
  const r1 = await a1.authenticateAsync({ type: 'webauthn', credentialId: 'cred-alice-key', response: { id: 'x' }, expectedChallenge: 'c' });
  assert.strictEqual(r1.ok, true, JSON.stringify(r1));
  assert.strictEqual(creds0.get('cred-alice-key').signCounter, 0);
  // b) 有计数器认证器：基线 5，库返回 5 → 重放拒绝
  const vSame = { verifyAssertion: async () => ({ verified: true, newCounter: 5 }) };
  const creds5 = new Map([['cred-alice-key', { userId: 'sre-alice', signCounter: 5, active: true, publicKeyB64u: 'AAEC' }]]);
  const a2 = makeAdapter({ webauthnVerifier: vSame, webauthnCredentials: creds5 });
  assert.strictEqual((await a2.authenticateAsync({ type: 'webauthn', credentialId: 'cred-alice-key', response: { id: 'x' }, expectedChallenge: 'c' })).reason, 'counter_replay');
});
