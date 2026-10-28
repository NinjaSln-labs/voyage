// run-ingress WebAuthn 装配契约：启用条件 / 凭据镜像加载 / 半配置与畸形输入 fail-fast
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildWebAuthn } = require('../scripts/run-ingress.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-wa-'));
}

function fakeVerifier(opts) {
  return { id: 'fake-verifier', ...opts };
}

test('WA-I1 未配置 RPID/ORIGIN → 不启用（返回 null，不加载库）', () => {
  assert.strictEqual(buildWebAuthn({ env: {}, dataDir: '/nonexistent' }), null);
});

test('WA-I2 半配置 → fail-fast（不允许静默退回桩路径）', () => {
  assert.throws(() => buildWebAuthn({ env: { VOYAGE_WEBAUTHN_RPID: 'voyage.example.com' } }), /必须同时配置/);
  assert.throws(() => buildWebAuthn({ env: { VOYAGE_WEBAUTHN_ORIGIN: 'https://voyage.example.com' } }), /必须同时配置/);
});

test('WA-I3 完整配置 → 注入验签器 + 凭据镜像归一（缺省 counter=0、active 默认 true）', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'creds.json');
    fs.writeFileSync(file, JSON.stringify([
      { credentialId: 'cred-a', userId: 'sre-alice', signCounter: 7, publicKeyB64u: 'AAEC' },
      { credentialId: 'cred-b', userId: 'dev-bob', active: false },
    ]));
    const env = {
      VOYAGE_WEBAUTHN_RPID: 'voyage.example.com',
      VOYAGE_WEBAUTHN_ORIGIN: 'https://voyage.example.com',
      VOYAGE_WEBAUTHN_CREDENTIALS: file,
    };
    const wa = buildWebAuthn({ env, dataDir: dir, createVerifier: fakeVerifier });
    assert.strictEqual(wa.rpID, 'voyage.example.com');
    assert.strictEqual(wa.verifier.origin, 'https://voyage.example.com');
    assert.strictEqual(wa.verifier.rpID, 'voyage.example.com');
    assert.strictEqual(wa.credentials.size, 2);
    assert.deepStrictEqual(wa.credentials.get('cred-a'), {
      userId: 'sre-alice', signCounter: 7, active: true, publicKeyB64u: 'AAEC',
    });
    assert.deepStrictEqual(wa.credentials.get('cred-b'), {
      userId: 'dev-bob', signCounter: 0, active: false,
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('WA-I4 凭据文件缺失 → 空表启用（fail-closed：所有通行密钥被拒）', () => {
  const dir = tmpDir();
  try {
    const env = { VOYAGE_WEBAUTHN_RPID: 'voyage.example.com', VOYAGE_WEBAUTHN_ORIGIN: 'https://voyage.example.com' };
    const wa = buildWebAuthn({ env, dataDir: dir, createVerifier: fakeVerifier });
    assert.strictEqual(wa.credentials.size, 0);
    assert.strictEqual(wa.file, path.join(dir, 'webauthn-credentials.json'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('WA-I5 凭据镜像畸形 → fail-fast（非数组 / 缺 credentialId|userId）', () => {
  const dir = tmpDir();
  try {
    const env = {
      VOYAGE_WEBAUTHN_RPID: 'voyage.example.com',
      VOYAGE_WEBAUTHN_ORIGIN: 'https://voyage.example.com',
      VOYAGE_WEBAUTHN_CREDENTIALS: path.join(dir, 'creds.json'),
    };
    fs.writeFileSync(env.VOYAGE_WEBAUTHN_CREDENTIALS, '{"credentialId":"x"}');
    assert.throws(() => buildWebAuthn({ env, dataDir: dir, createVerifier: fakeVerifier }), /必须是数组/);
    fs.writeFileSync(env.VOYAGE_WEBAUTHN_CREDENTIALS, JSON.stringify([{ credentialId: 'x' }]));
    assert.throws(() => buildWebAuthn({ env, dataDir: dir, createVerifier: fakeVerifier }), /缺 credentialId\/userId/);
    fs.writeFileSync(env.VOYAGE_WEBAUTHN_CREDENTIALS, JSON.stringify([{ credentialId: 'x', userId: 'u', signCounter: '7' }]));
    assert.throws(() => buildWebAuthn({ env, dataDir: dir, createVerifier: fakeVerifier }), /signCounter 必须为非负数值/);
    fs.writeFileSync(env.VOYAGE_WEBAUTHN_CREDENTIALS, JSON.stringify([{ credentialId: 'x', userId: 'u', signCounter: -1 }]));
    assert.throws(() => buildWebAuthn({ env, dataDir: dir, createVerifier: fakeVerifier }), /signCounter 必须为非负数值/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
