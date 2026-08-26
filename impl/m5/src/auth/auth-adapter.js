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
//    RS256/IdP JWKS（零依赖 node:crypto）：kid 定位公钥 + 算法族硬隔离（HS 只用共享密钥、RS 只用非对称钥——
//    防经典算法混淆攻击：攻击者拿 RSA 公钥当 HMAC 密钥自签 / 拿共享密钥冒充 RSA）；轮换经 rotateJwks 原子替换
// 失败语义：{ ok:false, reason } → REJECTED（对齐契约）；会话吊销即时失效（RQ-132 旧 Grant 失效的上游）

'use strict';

const crypto = require('node:crypto');

// ---------- 常量 ----------

/** JWT 签名算法支持集（RQ-811：禁 alg=none 与密钥混淆；实例按已配置钥材料取有效子集） */
const JWT_ALG_WHITELIST = Object.freeze(['HS256', 'RS256']);

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
 *  - jwtSecret: string HS256 共享密钥（经注入不落盘）
 *  - jwtPublicKey: string|KeyObject RS256 单钥部署的验证公钥（无 kid 时使用；与 jwksKeys 互斥优先级：kid 命中 jwks 优先）
 *  - jwksKeys: Map<kid, string|KeyObject>|object IdP JWKS 本地镜像（公钥集；HTTP 拉取/刷新为部署侧关注点，轮换用 rotateJwks）
 *  - webauthnVerifier: createWebAuthnVerifier(...) 注入后启用密码学真实验签——
 *    验签为 async，WebAuthn 凭据走 authenticateAsync；同步 authenticate 对该形态显式报 webauthn_async_required。
 *    注册入库形态扩展：webauthnCredentials 值增 publicKeyB64u 字段（经 verifyRegistration 产出）
 *  - sessionTtlMs: 会话有效期（默认 30 分钟）
 */
function createAuthAdapter({
  identityRepo = null,
  mtlsTrustedFingerprints = [],
  mtlsRevoked = null,
  webauthnCredentials = null,
  webauthnVerifier = null,
  jwtSecret = null,
  jwtPublicKey = null,
  jwksKeys = null,
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
  const _jwks = new Map(); // kid → string PEM | KeyObject（RS256 验证公钥镜像）
  if (jwksKeys instanceof Map) { for (const [k, v] of jwksKeys) _jwks.set(String(k), v); }
  else if (jwksKeys && typeof jwksKeys === 'object') { for (const [k, v] of Object.entries(jwksKeys)) _jwks.set(k, v); }
  // 审计修复（RS256 初审 P1-1）：单静态公钥与 JWKS 集合互斥——并存时无 kid token 的解析语义有歧义
  //（静默失效 vs 静默回退都是混淆面），构造即拒绝（fail-fast 对齐领域「构造即校验」基调）
  if (jwtPublicKey != null && _jwks.size > 0) {
    throw new Error('createAuthAdapter: jwtPublicKey 与 jwksKeys 互斥——单钥部署不配 JWKS，多钥部署统一走 JWKS（无 kid 一律拒绝）');
  }
  const _allowHs = typeof jwtSecret === 'string' && jwtSecret.length > 0;
  const _allowRs = jwtPublicKey != null || _jwks.size > 0;
  const _sessions = new Map(); // sessionId → { identityId, expiresAt, revoked }

  /** RS256 公钥归一：字符串 PEM → KeyObject（格式非法 → null，调用方报 signing_key_invalid 而非掩盖成签名错） */
  function _toKeyObject(key) {
    if (!key) return null;
    if (typeof key === 'string') {
      try { return crypto.createPublicKey(key); } catch (e) { return null; }
    }
    return key; // 已是 KeyObject
  }

  /** 认证成功 → 建会话 + 投影身份（契约输出 { id, role, sessionId }；capabilities 经 hasCapability 消费）
   *  extra: 附加会话绑定（如 mtls 的 certFingerprint——CRL 吊销级联失效用，RQ-611 全生命周期） */
  function _issueSession(identity, extra = {}) {
    if (_sessions.size >= MAX_SESSIONS) throw new Error('authAdapter: 会话表容量超限（防内存放大）');
    const sessionId = newSessionId();
    _sessions.set(sessionId, {
      identityId: identity.id,
      expiresAt: Date.now() + sessionTtlMs,
      revoked: false,
      ...extra,
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
    // 会话绑定证书指纹：CRL 更新后 validateSession 级联失效（RQ-611 不只拦新接入）
    return { ok: true, identity: _issueSession(identity, { certFingerprint: fingerprintSHA256 }) };
  }

  // ---------- WebAuthn 断言 ----------
  // 桩路径（未注入 webauthnVerifier）：结构 + challenge 绑定 + 计数器防重放（协议形状与重放面保证）
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

    // 签名计数器单调递增（克隆检测）：仅当认证器实际使用计数器（任一值 >0）时强制——
    // 审计修复（WA 初审 P1）：原 `reg.signCounter &&` 写法在 0 基线下短路跳过比较
    if (typeof cred.signCounter === 'number' && Number.isFinite(cred.signCounter)) {
      const counterUsed = cred.signCounter > 0 || (reg.signCounter || 0) > 0;
      if (counterUsed && cred.signCounter <= (reg.signCounter || 0)) {
        return { ok: false, reason: 'counter_replay' }; // 计数器不增 → 克隆/重放
      }
      reg.signCounter = cred.signCounter;
    }

    const identity = identityRepo.findById(reg.userId);
    if (!identity || !identity.active) return { ok: false, reason: 'identity_not_found' };
    return { ok: true, identity: _issueSession(identity) };
  }

  // ---------- WebAuthn 真实验签（webauthnVerifier 注入后启用；async——库验签为异步） ----------
  // 密码学验签（COSE/CBOR + ES256/RS256 签名）+ challenge/origin/RPID 绑定由 @simplewebauthn/server 执行；
  // 本层保留：凭据注册态/吊销即时失效（RQ-612）+ 计数器单调防重放 + 受管身份投影。
  // 安全前提：cred.expectedChallenge 必须来自服务端会话存储（下发时暂存），不得透传请求体值——调用方契约
  async function authenticateWebAuthnReal(cred) {
    if (!cred || typeof cred !== 'object') return { ok: false, reason: 'invalid_credential' };
    const credentialId = cred.credentialId || (cred.response && cred.response.id);
    if (!credentialId || !cred.response) return { ok: false, reason: 'invalid_credential' };
    const reg = _credentials.get(credentialId);
    if (!reg || reg.active === false) return { ok: false, reason: 'credential_not_registered' }; // 吊销即时失效（RQ-612）
    if (!reg.publicKeyB64u) return { ok: false, reason: 'credential_missing_public_key' };
    if (!cred.expectedChallenge) return { ok: false, reason: 'challenge_mismatch' };

    let v;
    try {
      v = await webauthnVerifier.verifyAssertion({
        response: cred.response,
        expectedChallenge: cred.expectedChallenge,
        credentialId,
        publicKeyB64u: reg.publicKeyB64u,
        currentCounter: reg.signCounter || 0,
      });
    } catch (e) {
      return { ok: false, reason: e.reason || 'assertion_rejected' }; // 库拒绝语义归一（challenge/origin/签名错）
    }
    // 计数器单调递增（克隆检测）：仅当认证器实际使用计数器（任一值 >0）时强制——
    // 审计修复（WA 初审 P1）：0 基线短路写法已修；newCounter 缺失已被 verifier 层拒绝，此处必有有限数值
    const newCounter = v.newCounter;
    {
      const counterUsed = newCounter > 0 || (reg.signCounter || 0) > 0;
      if (counterUsed && newCounter <= (reg.signCounter || 0)) return { ok: false, reason: 'counter_replay' };
      reg.signCounter = newCounter;
    }
    const identity = identityRepo.findById(reg.userId);
    if (!identity || !identity.active) return { ok: false, reason: 'identity_not_found' };
    return { ok: true, identity: _issueSession(identity) };
  }
  // ---------- JWT Bearer（HS256/RS256 验签 + alg 白名单 + 算法族硬隔离 + exp/nbf + claim 白名单投影） ----------
  function authenticateJwt(cred) {
    if (!cred || typeof cred !== 'object' || typeof cred.token !== 'string' || cred.token.length === 0) {
      return { ok: false, reason: 'invalid_credential' };
    }
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
    if (header.alg === 'HS256' && !_allowHs) return { ok: false, reason: 'jwt_secret_not_configured' };
    if (header.alg === 'RS256' && !_allowRs) return { ok: false, reason: 'alg_not_configured' };

    // 签名验证——算法族硬隔离（防混淆）：header.alg 唯一决定钥材料来源，两条路径互不取钥
    //   HS256 → 仅 jwtSecret（即使 token 带 kid 指向 JWKS 也不采信）；RS256 → 仅 jwks/jwtPublicKey（永不碰共享密钥）
    if (header.alg === 'HS256') {
      const expected = crypto.createHmac('sha256', jwtSecret)
        .update(`${headB64}.${payloadB64}`).digest('base64url');
      const got = Buffer.from(sigB64);
      const want = Buffer.from(expected);
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
        return { ok: false, reason: 'signature_invalid' };
      }
    } else {
      // RS256：kid 定位公钥；缺 kid 仅在「单静态公钥且无 JWKS」时接受；未知 kid fail-closed
      let key = null;
      if (typeof header.kid === 'string' && header.kid.length > 0) {
        key = _jwks.get(header.kid) || null;
      } else if (jwtPublicKey != null && _jwks.size === 0) {
        key = jwtPublicKey;
      }
      if (!key) return { ok: false, reason: 'signing_key_not_found' };
      const keyObj = _toKeyObject(key); // 审计修复（P2-3）：坏 PEM 显式报 signing_key_invalid，不静默混入签名错
      if (!keyObj) return { ok: false, reason: 'signing_key_invalid' };
      const verifier = crypto.createVerify('SHA256');
      verifier.update(`${headB64}.${payloadB64}`);
      verifier.end();
      let sigOk = false;
      try { sigOk = verifier.verify(keyObj, Buffer.from(sigB64, 'base64url')); } catch (e) { sigOk = false; }
      if (!sigOk) return { ok: false, reason: 'signature_invalid' };
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
        case 'webauthn':
          // 真实验签为 async——同步契约不静默降级，显式指引走 authenticateAsync
          if (webauthnVerifier) return { ok: false, reason: 'webauthn_async_required' };
          return authenticateWebAuthn(credential);
        case 'jwt': return authenticateJwt(credential);
        default: return { ok: false, reason: 'unsupported_credential_type' };
      }
    },

    /**
     * 异步认证入口（webauthnVerifier 注入后的 WebAuthn 主通道；mtls/jwt 与同步契约同语义）。
     * credential.type: 'mtls' | 'webauthn' | 'jwt'
     */
    async authenticateAsync(credential) {
      if (!credential || typeof credential !== 'object' || typeof credential.type !== 'string') {
        return { ok: false, reason: 'invalid_credential' };
      }
      switch (credential.type) {
        case 'mtls': return authenticateMtls(credential);
        case 'webauthn':
          return webauthnVerifier ? authenticateWebAuthnReal(credential) : authenticateWebAuthn(credential);
        case 'jwt': return authenticateJwt(credential);
        default: return { ok: false, reason: 'unsupported_credential_type' };
      }
    },

    /** 会话校验（后续请求鉴权；过期/吊销即时失效——RQ-132 上游）。
     *  审计修复（WA 初审 P1）：mTLS 会话级联 CRL——证书在会话有效期内被吊销 → 即时失效（RQ-611 全生命周期） */
    validateSession(sessionId) {
      const s = _sessions.get(sessionId);
      if (!s) return { ok: false, reason: 'session_not_found' };
      if (s.revoked) return { ok: false, reason: 'session_revoked' };
      if (s.certFingerprint && _revoked.has(s.certFingerprint)) return { ok: false, reason: 'certificate_revoked' };
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

    /**
     * JWKS 轮换（IdP 密钥轮换；原子替换防半更新窗口）
     * 审计修复（RS256 初审 P1-2）：拒绝空/非法输入——轮换成空集等于自拆认证门（fail-closed）
     * @param {Map|object} next 新公钥集 kid → PEM|KeyObject（非空必填）
     */
    rotateJwks(next) {
      const incoming = new Map();
      if (next instanceof Map) { for (const [k, v] of next) incoming.set(String(k), v); }
      else if (next && typeof next === 'object') { for (const [k, v] of Object.entries(next)) incoming.set(k, v); }
      if (incoming.size === 0) return { ok: false, reason: 'invalid_jwks_payload' };
      _jwks.clear();
      for (const [k, v] of incoming) _jwks.set(k, v);
      return { ok: true, keyCount: _jwks.size };
    },

    /** 吊销单个 JWKS 公钥（IdP 私钥泄露应急；即时失效） */
    revokeJwksKey(kid) {
      return { ok: _jwks.delete(String(kid)) };
    },
  };
}

module.exports = { createAuthAdapter, JWT_ALG_WHITELIST, WEBAUTHN_REQUIRED };
