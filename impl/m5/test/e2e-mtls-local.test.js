// mTLS 本地通链 E2E：自签开发 CA → 反代终结（node https 模拟）→ 指纹断言 → authAdapter 认证
// 验证：RQ-611 整链（证书签发/受信指纹/CRL 吊销/会话签发）+ crl-mirror 联动
// 前置：openssl 二进制可用；不可用自动跳过（CI 兼容）

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const tls = require('node:tls');
const { createAuthAdapter } = require('../src/auth/auth-adapter.js');
const { createCrlMirror } = require('../src/auth/crl-mirror.js');
const { createIdentityRepoMemory } = require('../src/repo/repo-identity.js');

function opensslOk() {
  try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); return true; } catch (e) { return false; }
}
/** openssl req/x509 参数封装：一键签发 subject=CN 的自签叶子证书 */
function issueCert(dir, name, cn, caCert, caKey, opts = {}) {
  const key = path.join(dir, `${name}.key`), crt = path.join(dir, `${name}.crt`), csr = path.join(dir, `${name}.csr`);
  const subj = `/CN=${cn}`;
  if (opts.selfSignedCA) {
    // 自签根：直接输出证书（-out crt，非 csr）
    execFileSync('openssl', ['req', '-new', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', subj], { stdio: 'pipe' });
  } else {
    execFileSync('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', key, '-out', csr, '-subj', subj], { stdio: 'pipe' });
    execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial',
      '-out', crt, '-days', '2'], { stdio: 'pipe' });
  }
  return { key, crt };
}
const sha256Fingerprint = (crtPath) =>
  execFileSync('openssl', ['x509', '-in', crtPath, '-noout', '-fingerprint', '-sha256'])
    .toString().split('=')[1].trim().toLowerCase().replace(/:/g, '');

test('E2E-mtls 本地通链：CA 签发→TLS 终结→指纹断言→认证→CRL 吊销即时失效', { skip: !opensslOk() && 'openssl 不可用' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-mtls-'));
  try {
    // 1. 开发 CA + 服务端证书 + 客户端设备证书
    const ca = issueCert(dir, 'dev-ca', 'Voyage Dev Root CA', null, null, { selfSignedCA: true });
    const server = issueCert(dir, 'server', 'localhost', ca.crt, ca.key);
    const clientA = issueCert(dir, 'client-a', 'sre-alice', ca.crt, ca.key);
    const clientB = issueCert(dir, 'client-b', 'dev-bob', ca.crt, ca.key);
    const fpA = sha256Fingerprint(clientA.crt);
    const fpB = sha256Fingerprint(clientB.crt);

    // 2. 认证面装配：受信指纹清单 + CRL 镜像（共享 Set）
    const revoked = new Set();
    const identities = createIdentityRepoMemory([{ id: 'sre-alice', role: 'sre' }, { id: 'dev-bob', role: 'dev' }]);
    const adapter = createAuthAdapter({
      identityRepo: identities,
      mtlsTrustedFingerprints: [fpA, fpB],
      mtlsRevoked: revoked,
    });
    const audit = { entries: [], write(e) { this.entries.push(e); return { ok: true }; } };
    let sourceList = [];
    const mirror = createCrlMirror({ revokedSet: revoked, source: async () => sourceList, auditPort: audit });

    // 3. TLS 终结面（模拟反向代理）：要求客户端证书 → 提取指纹/CN → 组装应用层断言
    const tlsServer = https.createServer({
      key: fs.readFileSync(server.key),
      cert: fs.readFileSync(server.crt),
      ca: fs.readFileSync(ca.crt),
      requestCert: true,
      rejectUnauthorized: true,
    }, (req, res) => {
      const peer = req.socket.getPeerCertificate();
      const assertion = {
        type: 'mtls',
        subjectCN: peer.subject.CN,
        fingerprintSHA256: peer.fingerprint256.toLowerCase().replace(/:/g, ''),
      };
      const r = adapter.authenticate(assertion);
      res.writeHead(r.ok ? 200 : 403, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r));
    });
    await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
    const port = tlsServer.address().port;

    /** 模拟客户端持证书发起请求（一次性连接，不复用 keep-alive） */
    const request = (cert, key) => new Promise((resolve, reject) => {
      const req = https.request({
        host: '127.0.0.1', port, method: 'GET',
        agent: new https.Agent({ keepAlive: false }),
        cert: cert ? fs.readFileSync(cert) : undefined,
        key: key ? fs.readFileSync(key) : undefined,
        rejectUnauthorized: false,
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end();
    });

    // a) 合法设备证书 → 认证通过 + 会话
    const okRes = await request(clientA.crt, clientA.key);
    assert.strictEqual(okRes.status, 200, JSON.stringify(okRes.body));
    assert.strictEqual(okRes.body.identity.id, 'sre-alice');
    assert.ok(adapter.validateSession(okRes.body.identity.sessionId).ok, '会话可校验');

    // b) 未入信任清单的证书（自签旁路）→ TLS 握手层即拒（服务端 rejectUnauthorized），连接被重置
    const rogue = issueCert(dir, 'rogue', 'intruder', null, null, { selfSignedCA: true });
    await assert.rejects(() => request(rogue.crt, rogue.key), /hang up|ECONNRESET|certificate/i, '旁路证书握手失败');

    // c) CRL 镜像吊销 client-b + client-a → 新接入拒绝 + 已签发会话级联失效（RQ-611 全生命周期）
    sourceList = [fpA, fpB];
    const sync = await mirror.refresh();
    assert.strictEqual(sync.added, 2);
    const revokedRes = await request(clientB.crt, clientB.key);
    assert.strictEqual(revokedRes.status, 403);
    assert.strictEqual(revokedRes.body.reason, 'certificate_revoked');
    // 已签发会话（步骤 a）即时失效——不只拦新接入
    const sess = adapter.validateSession(okRes.body.identity.sessionId);
    assert.strictEqual(sess.ok, false);
    assert.strictEqual(sess.reason, 'certificate_revoked');
    assert.ok(audit.entries.some(e => e.from === 'crl.mirror'), '吊销同步审计留痕');

    // 收尾：Node≥19 全局 agent 默认 keep-alive——显式断连防测试进程挂起
    tlsServer.closeAllConnections();
    tlsServer.close();
  } finally {
    try { tlsServer.closeAllConnections(); tlsServer.close(); } catch (e) { /* 已关闭 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
