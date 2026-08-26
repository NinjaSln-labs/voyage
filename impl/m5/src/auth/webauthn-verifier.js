// WebAuthn 真实验签器（@simplewebauthn/server 包装）——M0-T 选型落地，authPort 替换点兑现
// 边界：本模块是 m5 部署层唯一 npm 依赖消费点；auth-adapter 核心仍零依赖（经注入启用，
//       未注入时保持协议形状桩路径——零依赖基调不破坏）
// 职责：注册选项生成 / 注册响应验证（产出公钥入库）/ 认证断言验证（产出新计数器）
// 安全：challenge 绑定 + origin/RPID 校验 + 计数器防重放由库内核实；本层做映射与失败语义归一

'use strict';

const b64uEncode = (u8) => Buffer.from(u8).toString('base64url');
const b64uDecode = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

/**
 * WebAuthn 验签器工厂
 * @param {object} opts
 *  - rpID: RP ID（域名，如 'voyage.example.com'；本地开发用 localhost）
 *  - origin: 前端来源 URL（如 'https://voyage.example.com'）
 *  - lib: @simplewebauthn/server 注入点（默认 require；测试注入假实现）
 */
function createWebAuthnVerifier({ rpID, origin, lib = null } = {}) {
  if (!rpID || typeof rpID !== 'string') throw new Error('createWebAuthnVerifier: rpID 必填（域名）');
  if (!origin || typeof origin !== 'string') throw new Error('createWebAuthnVerifier: origin 必填（前端 URL）');
  const _lib = lib || (() => { try { return require('@simplewebauthn/server'); } catch (e) {
    throw new Error('createWebAuthnVerifier: @simplewebauthn/server 未安装（cd impl/m5 && npm install）');
  } })();

  const _fail = (reason) => Object.assign(new Error(reason), { reason });

  return {
    id: 'webauthn-verifier',
    rpID,
    origin,

    /** 注册选项（浏览器侧 @simplewebauthn/browser startRegistration 消费） */
    async generateRegistrationOptions({ userName, excludeCredentials = [], authenticatorSelection } = {}) {
      if (!userName) throw _fail('missing_user_name');
      return _lib.generateRegistrationOptions({
        rpName: '行舟 Voyage',
        rpID,
        userName,
        attestationType: 'none', // 不要求证明书（企业设备链场景走 mTLS）
        excludeCredentials,
        authenticatorSelection: authenticatorSelection || { residentKey: 'preferred', userVerification: 'preferred' },
      });
    },

    /** 注册响应验证：成功 → { credentialId, publicKeyB64u, counter }（入库 webauthnCredentials 形态） */
    async verifyRegistration({ response, expectedChallenge }) {
      if (!response || !expectedChallenge) throw _fail('invalid_registration_input');
      let v;
      try {
        v = await _lib.verifyRegistrationResponse({
          response,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
        });
      } catch (e) {
        throw _fail(`registration_rejected:${e.message}`);
      }
      if (!v || v.verified !== true || !v.registrationInfo || !v.registrationInfo.credential) {
        throw _fail('registration_not_verified');
      }
      const info = v.registrationInfo.credential; // v13 结构（id/publicKey/counter）
      return {
        credentialId: info.id,
        publicKeyB64u: b64uEncode(info.publicKey),
        counter: typeof info.counter === 'number' ? info.counter : 0,
      };
    },

    /** 认证选项（挑战下发） */
    async generateAuthenticationOptions({ allowCredentials = [] } = {}) {
      return _lib.generateAuthenticationOptions({ rpID, allowCredentials });
    },

    /**
     * 认证断言验证：密码学验签 + challenge/origin 绑定由库执行。
     * 安全前提（审计 P2 声明）：expectedChallenge 必须取自服务端会话存储，不得透传请求体值——
     * 否则 clientDataJSON.challenge 绑定形同虚设。
     * @returns { verified:true, newCounter } | 抛错（带 reason）；newCounter 缺失即拒绝（防重放防线不降级）
     */
    async verifyAssertion({ response, expectedChallenge, credentialId, publicKeyB64u, currentCounter }) {
      if (!response || !expectedChallenge || !publicKeyB64u) throw _fail('invalid_assertion_input');
      let v;
      try {
        v = await _lib.verifyAuthenticationResponse({
          response,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: { id: credentialId || response.id, publicKey: b64uDecode(publicKeyB64u), counter: currentCounter || 0 },
        });
      } catch (e) {
        throw _fail(`assertion_rejected:${e.message}`);
      }
      if (!v || v.verified !== true) throw _fail('assertion_not_verified');
      const newCounter = v.authenticationInfo ? v.authenticationInfo.newCounter : undefined;
      // 审计修复（初审 P1）：库类型声明 newCounter 必填，但旧版/假库可能缺失——缺失即拒绝，
      // 不静默跳过本层防重放（防御纵深不依赖单一防线）
      if (typeof newCounter !== 'number' || !Number.isFinite(newCounter)) throw _fail('missing_new_counter');
      return { verified: true, newCounter };
    },
  };
}

module.exports = { createWebAuthnVerifier };
