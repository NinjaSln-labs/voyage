# 审计记录 — WebAuthn 真实验签 + mTLS 本地通链

## 元信息

- **日期**：2026-08-25 · **审计方**：接收 session（ox-alpha）+ 独立子代理（安全对抗视角）
- **对象**：webauthn-verifier.js（@simplewebauthn/server v13 包装）+ auth-adapter 真实验签路径/异步入口/会话级联吊销 + e2e-mtls-local.test.js 自签证书链通链
- **背景**：项目所有者批准首个 npm 依赖（2026-08-25）——依赖仅限 m5 部署层 auth 适配点，核心领域层保持零依赖
- **流程**：先审后提交

## 发现清单

| # | 级别 | 轴 | 发现 | 处置 | 锚定 |
|---|------|----|------|------|------|
| W1 | P1 | 安全 | 计数器防重放 `reg.signCounter &&` 在 0 基线短路跳过比较（桩路径与真实验签路径同病） | ✅ fixed：仅当认证器实际使用计数器（任一值>0）时强制单调——无计数器认证器（恒 0，WebAuthn 标准）不误判，基线推进后同值重放拒绝 | WA6 |
| W2 | P1 | 安全 | verifier 层 newCounter 缺失时静默通过——本层防重放被绕过（旧版/假库场景） | ✅ fixed：newCounter 非有限数值即 missing_new_counter 拒绝（防御纵深不依赖库单一防线） | V7 |
| W3 | P1 | 安全/测试 | mTLS 通链只验证「拦新接入」，未验证已签发会话在 CRL 更新后失效——RQ-611 要求全生命周期 | ✅ fixed：mTLS 会话绑定证书指纹，validateSession 级联查吊销集；e2e 断言已签发会话吊销后即时 certificate_revoked | e2e-mtls-local 步骤 c |
| W4 | P2 | 契约 | 桩路径 authenticateAsync 未测（注入/未注入双形态语义一致性） | ✅ fixed：WA5 | WA5 |
| W5 | P2 | 一致性 | verifier JSDoc 误标 registrationInfo.counter 顶层字段（v13 实为 .credential.counter）+ 死代码兜底分支 | ✅ fixed：直接访问 .credential 并形状校验 | V3/V4 回归 |
| W6 | P2 | 安全文档 | expectedChallenge 信任边界未声明——若调用方透传请求体值，challenge 绑定形同虚设 | ✅ fixed：adapter 与 verifier 双处显式声明「必须来自服务端会话存储」（调用方契约） | 注释 |
| W7 | P2 | 测试 | response.id 缺失 fallback credentialId 分支未测 | ✅ fixed：V8 | V8 |
| W8 | P3 | 安全 | publicKeyB64u 无 COSE 结构预校验——被污染存储可传恶意字节 | 📝 recorded：库 COSE 解析阶段报错 fail-closed，实际风险低 | — |

## 四轴结论

- **安全轴**：W1/W2/W3 修复后，WebAuthn 重放防线双层（verifier 强制 newCounter + adapter 单调判定）、mTLS 吊销全生命周期闭环
- **契约轴**：authenticateAsync 与 authenticate 对 mtls/jwt 完全同语义；webauthn_async_required 为 fail-closed 显式报因
- **正确性轴**：v13 结构直取 + 形状校验；base64url 编解码 Node 原生
- **测试充分性轴**：假库注入锚定本层职责（映射/归一/防御），mTLS 三向断言（合法/旁路握手拒/吊销级联）

## 回归证据

```
认证面：auth-adapter 33 例 + webauthn-verifier 8 例 + crl-mirror 8 例 + e2e-mtls-local 1 例 = 50 全通过
全量基线：416 → 431 tests（430 pass + 1 条件跳过，0 fail）
```
