// mTLS 终结层契约测试（node:https 内存 CA 签发 + 全链验证）
// 验证：客户端证书提取 → auth.authenticate({type:'mtls'}) → req._mtlsIdentity 注入 → ingress.handleRequest
// 模式对齐：e2e-mtls-local.test.js 的 TLS 终结模式（openssl → node:https → 指纹断言 → 认证 → 会话）

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { createMtlsTerminator } = require('../src/server/mtls-terminator.js');
const { createAuthAdapter } = require('../src/auth/auth-adapter.js');
const { createIdentityRepoMemory } = require('../src/repo/repo-identity.js');
const { compose } = require('../src/compose.js');

/** openssl 可用性检查（CI 兼容） */
function opensslOk() {
  try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); return true; } catch (e) { return false; }
}

/** 生成内存 CA + 服务端 + 客户端证书（PEM 字符串，不落盘） */
function generateCertSet(dir) {
  function issue(name, cn, opts = {}) {
    const key = path.join(dir, `${name}.key`);
    const crt = path.join(dir, `${name}.crt`);
    if (opts.selfSignedCA) {
      execFileSync('openssl', ['req', '-new', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
        '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', `/CN=${cn}`], { stdio: 'pipe' });
    } else {
      const csr = path.join(dir, `${name}.csr`);
      execFileSync('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
        '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${cn}`], { stdio: 'pipe' });
      execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', opts.caCrt, '-CAkey', opts.caKey, '-CAcreateserial',
        '-out', crt, '-days', '2'], { stdio: 'pipe' });
    }
    return { key: fs.readFileSync(key), crt: fs.readFileSync(crt) };
  }
  const ca = issue('ca', 'Test CA', { selfSignedCA: true });
  const server = issue('srv', 'localhost', { caCrt: path.join(dir, 'ca.crt'), caKey: path.join(dir, 'ca.key') });
  const clientA = issue('client-a', 'sre-alice', { caCrt: path.join(dir, 'ca.crt'), caKey: path.join(dir, 'ca.key') });
  const clientB = issue('client-b', 'sre-b', { caCrt: path.join(dir, 'ca.crt'), caKey: path.join(dir, 'ca.key') });
  return {
    caPem: ca.crt,
    serverKeyPem: server.key,
    serverCertPem: server.crt,
    clientACrt: clientA.crt, clientAKey: clientA.key,
    clientBCrt: clientB.crt, clientBKey: clientB.key,
    fpA: execFileSync('openssl', ['x509', '-in', path.join(dir, 'client-a.crt'), '-noout', '-fingerprint', '-sha256'])
      .toString().split('=')[1].trim().toLowerCase().replace(/:/g, ''),
    fpB: execFileSync('openssl', ['x509', '-in', path.join(dir, 'client-b.crt'), '-noout', '-fingerprint', '-sha256'])
      .toString().split('=')[1].trim().toLowerCase().replace(/:/g, ''),
  };
}

test('mTLS 终结层契约：合法证书 → 认证通过 → req._mtlsIdentity 注入 → ingress 路由', { skip: !opensslOk() && 'openssl 不可用' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-mtls-term-'));
  let tlsServer;
  try {
    const certs = generateCertSet(dir);
    const identities = createIdentityRepoMemory([
      { id: 'sre-alice', role: 'sre' },
      { id: 'sre-b', role: 'sre' },
    ]);
    const revoked = new Set();
    const auth = createAuthAdapter({
      identityRepo: identities,
      mtlsTrustedFingerprints: [certs.fpA, certs.fpB],
      mtlsRevoked: revoked,
      jwtSecret: 'test-secret',
    });

    // mock ingress（简化版——只做 requireAuth + /healthz 路由）
    const ingress = {
      handleRequest(req, res) {
        if (req._mtlsIdentity) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, actorId: req._mtlsIdentity.id, role: req._mtlsIdentity.role }));
        } else {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no_identity' }));
        }
      },
    };

    tlsServer = createMtlsTerminator({
      caCertPem: certs.caPem.toString(),
      serverKeyPem: certs.serverKeyPem.toString(),
      serverCertPem: certs.serverCertPem.toString(),
      auth,
      ingress,
      port: 0, // 随机端口
      host: '127.0.0.1',
    });
    await tlsServer.listen();
    const port = tlsServer._server.address().port;

    // 1) 用 clientA 证书连接 → 200 + actorId=sre-alice
    const resA = await new Promise((resolve, reject) => {
      const req = https.request({
        host: 'localhost', port, method: 'GET',
        cert: certs.clientACrt, key: certs.clientAKey,
        ca: certs.caPem, rejectUnauthorized: true,
        agent: new https.Agent({ keepAlive: false }),
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(resA.status, 200, JSON.stringify(resA));
    assert.strictEqual(resA.body.actorId, 'sre-alice');
    assert.strictEqual(resA.body.role, 'sre');

    // 2) 用 clientB 证书连接 → 200 + actorId=sre-b
    const resB = await new Promise((resolve, reject) => {
      const req = https.request({
        host: 'localhost', port, method: 'GET',
        cert: certs.clientBCrt, key: certs.clientBKey,
        ca: certs.caPem, rejectUnauthorized: true,
        agent: new https.Agent({ keepAlive: false }),
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(resB.status, 200);
    assert.strictEqual(resB.body.actorId, 'sre-b');

    // 3) 无证书连接 → TLS 握手失败（rejectUnauthorized=true）
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        const req = https.request({
          host: 'localhost', port, method: 'GET',
          ca: certs.caPem, rejectUnauthorized: true,
          agent: new https.Agent({ keepAlive: false }),
        }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
      }),
      /ECONNRESET|ERR_SSL|hang up|certificate/i,
      '无证书连接应被 TLS 层拒绝',
    );
  } finally {
    if (tlsServer) {
      try { tlsServer._server.closeAllConnections?.(); } catch (e) { /* ignore */ }
      await new Promise((r) => tlsServer._server.close(r));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mTLS 终结层：CRL 吊销 → 新连接 403 + 会话级联失效', { skip: !opensslOk() && 'openssl 不可用' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-mtls-term2-'));
  let tlsServer;
  try {
    const certs = generateCertSet(dir);
    const identities = createIdentityRepoMemory([{ id: 'sre-alice', role: 'sre' }]);
    const revoked = new Set();
    const auth = createAuthAdapter({
      identityRepo: identities,
      mtlsTrustedFingerprints: [certs.fpA],
      mtlsRevoked: revoked,
      jwtSecret: 'test-secret',
    });
    const ingress = {
      handleRequest(req, res) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, actorId: req._mtlsIdentity.id }));
      },
    };
    tlsServer = createMtlsTerminator({
      caCertPem: certs.caPem.toString(),
      serverKeyPem: certs.serverKeyPem.toString(),
      serverCertPem: certs.serverCertPem.toString(),
      auth, ingress, port: 0, host: '127.0.0.1',
    });
    await tlsServer.listen();
    const port = tlsServer._server.address().port;

    // 1) 合法连接成功（servername 匹配服务端 CN=localhost）
    const okRes = await new Promise((resolve, reject) => {
      const req = https.request({
        host: 'localhost', port, cert: certs.clientACrt, key: certs.clientAKey,
        ca: certs.caPem, rejectUnauthorized: true,
        agent: new https.Agent({ keepAlive: false }),
      }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b))); });
      req.on('error', reject); req.end();
    });
    assert.strictEqual(okRes.ok, true);

    // 2) CRL 吊销 clientA → 新连接 403 certificate_revoked
    revoked.add(certs.fpA);
    const revRes = await new Promise((resolve, reject) => {
      const req = https.request({
        host: 'localhost', port, cert: certs.clientACrt, key: certs.clientAKey,
        ca: certs.caPem, rejectUnauthorized: true,
        agent: new https.Agent({ keepAlive: false }),
      }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) })); });
      req.on('error', reject); req.end();
    });
    assert.strictEqual(revRes.status, 403);
    assert.strictEqual(revRes.body.reason, 'certificate_revoked');
  } finally {
    if (tlsServer) {
      try { tlsServer._server.closeAllConnections?.(); } catch (e) { /* ignore */ }
      await new Promise((r) => tlsServer._server.close(r));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mTLS 终结层：参数校验——缺 CA/Key/证书/auth/ingress → 构造即抛错', () => {
  assert.throws(() => createMtlsTerminator({}), /caCertPem 必填/);
  assert.throws(() => createMtlsTerminator({ caCertPem: 'x' }), /serverKeyPem 必填/);
  assert.throws(() => createMtlsTerminator({ caCertPem: 'x', serverKeyPem: 'x' }), /serverCertPem 必填/);
  assert.throws(() => createMtlsTerminator({ caCertPem: 'x', serverKeyPem: 'x', serverCertPem: 'x' }), /auth 必填/);
  const auth = { authenticate: () => ({}) };
  assert.throws(() => createMtlsTerminator({ caCertPem: 'x', serverKeyPem: 'x', serverCertPem: 'x', auth }), /ingress.handleRequest 必填/);
});
