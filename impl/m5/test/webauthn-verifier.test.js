// WebAuthn 验签器契约测试：lib 注入点映射 / 失败语义归一 / 构造校验
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createWebAuthnVerifier } = require('../src/auth/webauthn-verifier.js');

/** 假 @simplewebauthn/server 库（受控行为注入） */
function fakeLib({ regVerified = true, assertionVerified = true, counter = 5, throwOnVerify = null } = {}) {
  return {
    async generateRegistrationOptions(opts) { return { rpID: opts.rpID, user: opts.userName }; },
    async verifyRegistrationResponse() {
      if (throwOnVerify) throw new Error(throwOnVerify);
      return {
        verified: regVerified,
        registrationInfo: regVerified ? { credential: { id: 'cred-xyz', publicKey: new Uint8Array([1, 2, 3]), counter } } : null,
      };
    },
    async generateAuthenticationOptions(opts) { return { challenge: 'chal-x', rpID: opts.rpID }; },
    async verifyAuthenticationResponse() {
      if (throwOnVerify) throw new Error(throwOnVerify);
      return { verified: assertionVerified, authenticationInfo: { newCounter: counter } };
    },
  };
}

const BASE = { rpID: 'voyage.example.com', origin: 'https://voyage.example.com' };

test('V1 构造校验：rpID/origin 必填；lib 缺失显式报因不静默', () => {
  assert.throws(() => createWebAuthnVerifier({}), /rpID/);
  assert.throws(() => createWebAuthnVerifier({ rpID: 'x' }), /origin/);
});

test('V2 注册选项生成：透传 userName/RPID/排除凭据', async () => {
  const v = createWebAuthnVerifier({ ...BASE, lib: fakeLib() });
  const opts = await v.generateRegistrationOptions({ userName: 'sre-alice', excludeCredentials: [{ id: 'c1' }] });
  assert.strictEqual(opts.user, 'sre-alice');
  assert.strictEqual(opts.rpID, 'voyage.example.com');
  await assert.rejects(() => v.generateRegistrationOptions({}), /missing_user_name/);
});

test('V3 注册验证成功 → 公钥 base64url 化 + 计数器映射（入库形态）', async () => {
  const v = createWebAuthnVerifier({ ...BASE, lib: fakeLib({ counter: 7 }) });
  const r = await v.verifyRegistration({ response: { x: 1 }, expectedChallenge: 'chal' });
  assert.strictEqual(r.credentialId, 'cred-xyz');
  assert.strictEqual(r.publicKeyB64u, Buffer.from([1, 2, 3]).toString('base64url'));
  assert.strictEqual(r.counter, 7);
});

test('V4 注册验证失败语义归一：未验证/库异常 → 带 reason 的错误', async () => {
  const v1 = createWebAuthnVerifier({ ...BASE, lib: fakeLib({ regVerified: false }) });
  await assert.rejects(() => v1.verifyRegistration({ response: {}, expectedChallenge: 'c' }), /registration_not_verified/);
  const v2 = createWebAuthnVerifier({ ...BASE, lib: fakeLib({ throwOnVerify: 'bad attestation' }) });
  await assert.rejects(() => v2.verifyRegistration({ response: {}, expectedChallenge: 'c' }), (e) => e.reason === 'registration_rejected:bad attestation');
});

test('V5 断言验签成功 → verified + 新计数器；公钥解码回传库', async () => {
  let captured = null;
  const lib = fakeLib();
  lib.verifyAuthenticationResponse = async (opts) => {
    captured = opts;
    return { verified: true, authenticationInfo: { newCounter: 9 } };
  };
  const v = createWebAuthnVerifier({ ...BASE, lib });
  const r = await v.verifyAssertion({
    response: { id: 'cred-1' }, expectedChallenge: 'chal',
    credentialId: 'cred-1', publicKeyB64u: Buffer.from([9, 9]).toString('base64url'), currentCounter: 3,
  });
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.newCounter, 9);
  assert.deepStrictEqual([...captured.credential.publicKey], [9, 9], 'base64url 解码回传');
  assert.strictEqual(captured.credential.counter, 3);
  assert.strictEqual(captured.expectedRPID, 'voyage.example.com');
  assert.strictEqual(captured.expectedOrigin, 'https://voyage.example.com');
});

test('V6 断言失败语义归一：未验证/库异常 → reason 可消费', async () => {
  const v1 = createWebAuthnVerifier({ ...BASE, lib: fakeLib({ assertionVerified: false }) });
  await assert.rejects(() => v1.verifyAssertion({ response: {}, expectedChallenge: 'c', publicKeyB64u: 'AA' }), /assertion_not_verified/);
  const v2 = createWebAuthnVerifier({ ...BASE, lib: fakeLib({ throwOnVerify: 'challenge mismatch' }) });
  await assert.rejects(
    () => v2.verifyAssertion({ response: {}, expectedChallenge: 'c', publicKeyB64u: 'AA' }),
    (e) => e.reason === 'assertion_rejected:challenge mismatch',
  );
});

test('V7 初审修复锚定：newCounter 缺失 → missing_new_counter 拒绝（本层防重放不降级）', async () => {
  const lib = fakeLib();
  lib.verifyAuthenticationResponse = async () => ({ verified: true, authenticationInfo: {} }); // 无 newCounter
  const v = createWebAuthnVerifier({ ...BASE, lib });
  await assert.rejects(
    () => v.verifyAssertion({ response: {}, expectedChallenge: 'c', publicKeyB64u: 'AA' }),
    (e) => e.reason === 'missing_new_counter',
  );
});

test('V8 response.id 缺失 → fallback 到 credentialId 参数', async () => {
  let captured = null;
  const lib = fakeLib();
  lib.verifyAuthenticationResponse = async (opts) => { captured = opts; return { verified: true, authenticationInfo: { newCounter: 1 } }; };
  const v = createWebAuthnVerifier({ ...BASE, lib });
  await v.verifyAssertion({ response: {}, expectedChallenge: 'c', credentialId: 'cred-fallback', publicKeyB64u: 'AA' });
  assert.strictEqual(captured.credential.id, 'cred-fallback');
});
