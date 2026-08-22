// 认证适配器（authPort 落地）——真实部署过渡，零 npm 依赖
// 依据：ADAPTER-CONTRACTS.md §1（authPort：authenticate(credential) → { ok, identity }）
//      RQ-611（设备级 mTLS：无证拒绝；CRL 维护）/ RQ-612（账号级 WebAuthn：吊销即时失效）
//      RQ-811（IdP 签名算法白名单：禁 alg=none 与密钥混淆；claim 白名单仅信受控来源）
//      M0-T L5 选型：mTLS 由反向代理终结，应用层只验身份断言；WebAuthn 真实部署换 @simplewebauthn/server
// 安全模型：
//  - mTLS：反代终结 TLS 后传入断言 { subjectCN, fingerprintSHA256 }——适配器校验指纹在受信任清单 + 未吊销
//  - WebAuthn：结构校验（credentialId/authenticatorData/clientDataJSON）+ challenge 绑定 + 签名计数器防重放；
//    密码学验签（COSE/CBOR）为 @simplewebauthn 替换点（本层保证协议形状与重放面）
//  - JWT：HS256 验签（node:crypto HMAC）+ alg 白名单（禁 none/混淆）+ exp/nbf 校验 + claim 白名单投影
// 失败语义：{ ok:false, reason } → REJECTED（对齐契约）；会话吊销即时失效（RQ-132 旧 Grant 失效的上游）

'use strict';

const crypto = require('node:crypto');

// ---------- 常量 ----------

/** JWT 签名算法白名单（RQ-811：禁 alg=none 与密钥混淆） */
const JWT_ALG_WHITELIST = Object.freeze(['HS256']);

/** WebAuthn 断言必填字段 */
const WEBAUTHN_REQUIRED = Object.freeze(['credentialId', 'authenticatorData', 'clientDataJSON', 'signature']);

const SESSION_TTL_MS_DEFAULT = 30 * 60 * 1000;   // 会话默认 30 分钟（目标值，实测校准）
const MAX_SESSIONS = 10000;                       // 会话表上限（防内存放大）

/** 会话（内部可变状态最小化；不外泄内部引用） */
function newSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 认证适配器工厂（authPort）
 * @param {object} opts
 *  - identityRepo: 身份仓储（{ findById(id) → Identity|null }）——认证通过后投影 role/capabilities
 *  - mtlsTrustedFingerprints: string[] 受信任客户端证书指纹（SHA-256 hex）；空 = 拒绝一切 mTLS（fail-closed）
 *  - mtlsRevoked: Set<string> 已吊销指纹（CRL 本地镜像；真实部署接 OCSP/CRL 端点）
 *  - webauthnCredentials: Map<credentialId, { userId, signCounter, active }> 注册的通行密钥（本地镜像）
 *  - jwtSecret: string HS256 共享密钥（经注入不落盘；生产换 RS256/IdP JWKS）
 *  - sessionTtlMs: 会话有效期（默认 30 分钟）
 */
function createAuthAdapter({
  identityRepo = null,
  mtlsTrustedFingerprints = [],
  mtlsRevoked = null,
  webauthnCredentials = null,
  jwtSecret = null,
  sessionTtlMs = SESSION_TTL_MS_DEFAULT,
} = {}) {
  if (!identityRepo || typeof identityRepo.findById !== 'function') {
    throw new Error('createAuthAdapter: identityRepo 必填（{ findById(id) → Identity|null }）');
  }
  if (sessionTtlMs !== undefined && (typeof sessionTtlMs !== 'number' || !Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0)) {
    throw new Error('createAuthAdapter: sessionTtlMs 必须为正有限数值'); // 第 11 波
  }
  const _trusted = new Set(mtlsTrustedFingerprints);
  const _revoked = mtlsRevoked || new Set();
  const _credentials = webauthnCredentials || new Map();
  const _sessions = new Map(); // sessionId → { identityId, expiresAt, revoked }

  /** 认证成功 → 建会话 + 投影身份（契约输出 { id, role, sessionId }；capabilities 经 hasCapability 消费） */
  function _issueSession(identity) {
    if (_sessions.size >= MAX_SESSIONS) throw new Error('authAdapter: 会话表容量超限（防内存放大）');
    const sessionId = newSessionId();
    _sessions.set(sessionId, {
      identityId: identity.id,
      expiresAt: Date.now() + sessionTtlMs,
      revoked: false,
    });
    return { id: identity.id, role: identity.role, sessionId };
  }

  // ---------- mTLS 断言（反代终结后的应用层校验） ----------
  function authenticateMtls(cred) {
    if (!cred || typeof cred !== 'object') return { ok: false, reason: 'invalid_credential' };
    const { subjectCN, fingerprintSHA256 } = cred;
    if (typeof subjectCN !== 'string' || subjectCN.length === 0) return { ok: false, reason: 'missing_subject' };
    if (typeof fingerprintSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprintSHA256)) {
      return { ok: false, reason: 'invalid_fingerprint' }; // 无证/畸形拒绝接入（RQ-611）
    }
    if (!_trusted.has(fingerprintSHA256)) return { ok: false, reason: 'untrusted_certificate' };
    if (_revoked.has(fingerprintSHA256)) return { ok: false, reason: 'certificate_revoked' }; // CRL 命中
    const identity = identityRepo.findById(subjectCN);
    if (!identity || !identity.active) return { ok: false, reason: 'identity_not_found' };
    return { ok: true, identity: _issueSession(identity) };
  }

  // ---------- WebAuthn 断言（结构 + challenge 绑定 + 计数器防重放；密码学验签归 @simplewebauthn 替换点） ----------
  function authenticateWebAuthn(cred) {
    if (!cred || typeof cred !== 'object') return { ok: false, reason: 'invalid_credential' };
    for (const f of WEBAUTHN_REQUIRED) {
      if (typeof cred[f] !== 'string' || cred[f].length === 0) return { ok: false, reason: `missing_${f}` };
    }
    const reg = _credentials.get(cred.credentialId);
    if (!reg || reg.active === false) return { ok: false, reason: 'credential_not_registered' }; // 吊销即时失效（RQ-612）

    // clientDataJSON：challenge 绑定 + type=webauthn.get
    let clientData;
    try { clientData = JSON.parse(Buffer.from(cred.clientDataJSON, 'base64url').toString('utf8')); }
    catch (e) { return { ok: false, reason: 'malformed_client_data' }; }
    if (!clientData || clientData.type !== 'webauthn.get') return { ok: false, reason: 'wrong_client_data_type' };
    if (!cred.expectedChallenge || clientData.challenge !== cred.expectedChallenge) {
      return { ok: false, reason: 'challenge_mismatch' }; // 防重放：challenge 必须与本次会话绑定
    }
    if (clientData.origin && cred.expectedOrigin && clientData.origin !== cred.expectedOrigin) {
      return { ok: false, reason: 'origin_mismatch' };
    }

    // 签名计数器单调递增（克隆检测；authenticatorData 内 counter 的提取归替换点，此处消费断言字段）
    if (typeof cred.signCounter === 'number' && Number.isFinite(cred.signCounter)) {
      if (reg.signCounter && cred.signCounter <= reg.signCounter) {
        return { ok: false, reason: 'counter_replay' }; // 计数器不增 → 克隆/重放
      }
      reg.signCounter = cred.signCounter;
    }

    const identity = identityRepo.findById(reg.userId);
    if (!identity || !identity.active) return { ok: false, reason: 'identity_not_found' };
    return { ok: true, identity: _issueSession(identity) };
  }

  // ---------- JWT Bearer（HS256 验签 + alg 白名单 + exp/nbf + claim 白名单投影） ----------
  function authenticateJwt(cred) {
    if (!cred || typeof cred !== 'object' || typeof cred.token !== 'string' || cred.token.length === 0) {
      return { ok: false, reason: 'invalid_credential' };
    }
    if (!jwtSecret) return { ok: false, reason: 'jwt_secret_not_configured' };
    const parts = cred.token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed_token' };
    const [headB64, payloadB64, sigB64] = parts;

    let header, payload;
    try {
      header = JSON.parse(Buffer.from(headB64, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch (e) { return { ok: false, reason: 'malformed_token' }; }

    // RQ-811：alg 白名单——alg=none 或未列算法一律拒绝（防密钥混淆/降权）
    if (!header || !JWT_ALG_WHITELIST.includes(header.alg)) return { ok: false, reason: 'alg_not_allowed' };

    // HMAC-SHA256 验签（恒时比较）
    const expected = crypto.createHmac('sha256', jwtSecret)
      .update(`${headB64}.${payloadB64}`).digest('base64url');
    const got = Buffer.from(sigB64);
    const want = Buffer.from(expected);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      return { ok: false, reason: 'signature_invalid' };
    }

    // 时间约束
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && nowSec >= payload.exp) return { ok: false, reason: 'token_expired' };
    if (typeof payload.nbf === 'number' && nowSec < payload.nbf) return { ok: false, reason: 'token_not_yet_valid' };

    // claim 白名单：sub 必须映射到受管身份（角色/组织声明仅信任本地目录，不信 token 自报——RQ-811）
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return { ok: false, reason: 'missing_subject' };
    const identity = identityRepo.findById(payload.sub);
    if (!identity || !identity.active) return { ok: false, reason: 'identity_not_found' };
    return { ok: true, identity: _issueSession(identity) };
  }

  return {
    id: 'auth',

    /**
     * 认证入口（authPort 契约）：authenticate(credential) → { ok, identity } | { ok:false, reason }
     * credential.type: 'mtls' | 'webauthn' | 'jwt'
     */
    authenticate(credential) {
      if (!credential || typeof credential !== 'object' || typeof credential.type !== 'string') {
        return { ok: false, reason: 'invalid_credential' };
      }
      switch (credential.type) {
        case 'mtls': return authenticateMtls(credential);
        case 'webauthn': return authenticateWebAuthn(credential);
        case 'jwt': return authenticateJwt(credential);
        default: return { ok: false, reason: 'unsupported_credential_type' };
      }
    },

    /** 会话校验（后续请求鉴权；过期/吊销即时失效——RQ-132 上游） */
    validateSession(sessionId) {
      const s = _sessions.get(sessionId);
      if (!s) return { ok: false, reason: 'session_not_found' };
      if (s.revoked) return { ok: false, reason: 'session_revoked' };
      if (Date.now() >= s.expiresAt) return { ok: false, reason: 'session_expired' };
      return { ok: true, identityId: s.identityId };
    },

    /** 吊销会话（登出/应急；幂等） */
    revokeSession(sessionId) {
      const s = _sessions.get(sessionId);
      if (s) s.revoked = true;
      return { ok: true };
    },

    /** 吊销 WebAuthn 凭据（设备丢失应急 RQ-612：旧密钥即时失效） */
    revokeWebAuthnCredential(credentialId) {
      const reg = _credentials.get(credentialId);
      if (reg) reg.active = false;
      return { ok: !!reg };
    },
  };
}

module.exports = { createAuthAdapter, JWT_ALG_WHITELIST, WEBAUTHN_REQUIRED };
