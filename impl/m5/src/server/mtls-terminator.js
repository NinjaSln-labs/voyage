// mTLS TLS 终结层（生产形态：node:https 服务端 + 客户端证书验证 + 断言提取 → 同进程转发到 ingress）
// 依据：产品0-1计划 §5 L5（mTLS 设备级认证）；ADAPTER-CONTRACTS §1 authPort（mtls 形态）
// 模式对齐：与 e2e-mtls-local.test.js 第 65-80 行 TLS 终结模式完全一致
// 安全模型：
//  - CA 信任链验证：客户端证书必须由 caCertPem 签发（rejectUnauthorized=true，非本 CA 签发握手即失败）
//  - 指纹断言提取：req.socket.getPeerCertificate() → { subjectCN, fingerprintSHA256 }
//  - 认证分派：auth.authenticate({ type: 'mtls', subjectCN, fingerprintSHA256 })
//    经 auth-adapter 校验信任清单 + CRL 吊销 + identity 存在性（fail-closed）
//  - 同进程转发：认证成功后 req._mtlsIdentity 注入 → 调 ingress.handleRequest(req, res)
//    不经网络，零额外端口暴露（mTLS 终结层与 ingress 同进程）
//  - 零 npm 依赖：node:https + node:fs
// 已知硬化待办（recorded）：
//  - 会话 TTL 与 ingress 的 PENDING_TTL 对齐（当前 mTLS 会话由 auth-adapter 管理，30min）
//  - mTLS 8443 端口仅对运维网络段开放（Oracle Cloud 安全组），不开放 0.0.0.0/0

'use strict';

const https = require('node:https');

/**
 * mTLS 终结层工厂
 * @param {object} opts
 *  - caCertPem: string CA 根证书 PEM（验证客户端证书信任链）
 *  - serverKeyPem: string 服务端私钥 PEM
 *  - serverCertPem: string 服务端证书 PEM
 *  - auth: createAuthAdapter 结果（authenticate 同步契约）
 *  - ingress: createHttpIngress 结果（须含 handleRequest 方法）
 *  - port: number 监听端口（默认 8443）
 *  - host: string 监听地址（默认 0.0.0.0——mTLS 终结层需外部可达；安全组限制到运维网络段）
 * @returns {object} { server, listen(), close(), stats() }
 */
function createMtlsTerminator({ caCertPem, serverKeyPem, serverCertPem, auth, ingress, port = 8443, host = '0.0.0.0' } = {}) {
  if (!caCertPem || typeof caCertPem !== 'string') throw new Error('createMtlsTerminator: caCertPem 必填（CA 根证书 PEM）');
  if (!serverKeyPem || typeof serverKeyPem !== 'string') throw new Error('createMtlsTerminator: serverKeyPem 必填');
  if (!serverCertPem || typeof serverCertPem !== 'string') throw new Error('createMtlsTerminator: serverCertPem 必填');
  if (!auth || typeof auth.authenticate !== 'function') throw new Error('createMtlsTerminator: auth 必填（authAdapter）');
  if (!ingress || typeof ingress.handleRequest !== 'function') throw new Error('createMtlsTerminator: ingress.handleRequest 必填');

  const _counters = { requests: 0, authOk: 0, authFail: 0, noCert: 0 };

  const server = https.createServer({
    key: serverKeyPem,
    cert: serverCertPem,
    ca: caCertPem,
    requestCert: true,
    rejectUnauthorized: true, // 无证书/非本 CA 签发 → TLS 握手即失败（fail-closed）
  }, (req, res) => {
    _counters.requests += 1;

    // 1. 提取客户端证书断言
    const peer = req.socket.getPeerCertificate();
    if (!peer) {
      _counters.noCert += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no_client_certificate' }));
      return;
    }
    const assertion = {
      type: 'mtls',
      subjectCN: peer.subject.CN,
      fingerprintSHA256: peer.fingerprint256.toLowerCase().replace(/:/g, ''),
    };

    // 2. 应用层认证（auth-adapter：信任清单 + CRL + identity 存在性）
    const r = auth.authenticate(assertion);
    if (!r.ok) {
      _counters.authFail += 1;
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'auth_failed', reason: r.reason }));
      return;
    }
    _counters.authOk += 1;

    // 3. 注入认证身份 → 同进程转发到 ingress 路由（不经网络）
    req._mtlsIdentity = r.identity;
    ingress.handleRequest(req, res);
  });

  return {
    /** 启动监听。返回 Promise<void> */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });
    },
    close() {
      return new Promise((resolve) => server.closeAllConnections?.() ?? server.close(() => resolve()));
    },
    /** 观测（不含证书/指纹值——只暴露计数，防泄漏） */
    stats() {
      return {
        requests: _counters.requests,
        authOk: _counters.authOk,
        authFail: _counters.authFail,
        noCert: _counters.noCert,
        listening: !server.listening ? server.listening : server.listening,
      };
    },
    /** 内部测试用：直接访问 https server */
    _server: server,
  };
}

module.exports = { createMtlsTerminator };
