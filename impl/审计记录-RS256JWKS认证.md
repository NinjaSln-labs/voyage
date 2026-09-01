# 审计记录 — 认证适配器 RS256/JWKS 落地

## 元信息

- **日期**：2026-08-25 · **审计方**：接收 session（ox-alpha）+ 独立子代理（安全对抗视角）
- **对象**：auth-adapter.js JWT 从仅 HS256 扩展 RS256/IdP JWKS（零依赖 node:crypto）+ 契约测试 J6–J16
- **流程**：实现 → 子代理盲审 → **修复后再回归**（先审后提交，区别于供应商复验轮的事后补审）

## 发现清单（初审）

| # | 级别 | 发现 | 处置 | 锚定 |
|---|------|------|------|------|
| P1-1 | P1 | jwtPublicKey 与 jwksKeys 并存时，无 kid token 的解析静默失效——运维误以为双源容灾生效 | ✅ fixed：构造即校验，两者并存 fail-fast 抛错 | J15 |
| P1-2 | P1 | rotateJwks(null/{}) 清空全部公钥且无防御——等于自拆认证门 | ✅ fixed：空/非法输入拒绝 invalid_jwks_payload，拒绝不产生半更新 | J14 |
| P2-3 | P2 | 非法 PEM 被 catch 吞成 signature_invalid，掩盖部署配置错误 | ✅ fixed：公钥归一化前置，坏 PEM 显式报 signing_key_invalid | J16 |
| P2-4 | P2 | JWT_ALG_WHITELIST 语义从「实例已启用算法」变为「协议支持集」，若有上游按常量推断实例能力需评估 | 📝 recorded：当前无运行时消费者（仅测试快照断言）；注释已声明「按已配置钥材料取有效子集」 | 注释+J2 |
| P2-5 | P2 | 测试缺口：RS256 nbf / KeyObject 形态注入 / 重复吊销幂等 / 双空配置 fail-closed / rotate 空输入 | ✅ fixed：J13/J14/J16 全部补齐 | J13-J16 |
| P3-6 | P3 | HS256 恒时比较作用于 base64url 字符串表示（非解码字节）——固定长度下无实际泄露 | 📝 recorded：风格级，HMAC-SHA256 输出恒 44 字节无长度泄漏面 | — |

## 四轴结论

- **算法混淆轴**：硬化通过——alg 唯一决定钥材料来源，两路径零交集；J9a 真实构造「RSA 公钥当 HMAC 密钥」攻击并锚定拒绝
- **向后兼容轴**：HS256 行为与全部 reason 字符串保持；既有 J1–J5 不改一字通过
- **正确性轴**：base64url 解码修复后 KeyObject/PEM 双形态可用；Node createVerify 恒时
- **测试充分性轴**：初审缺口全部补齐（J13–J16），轮换原子性有负路径锚定

## 回归证据

```
认证契约测试：16 → 27 例全通过
全量基线：397 → 401 tests（400 pass + 1 条件跳过，0 fail）
```

## 剩余替换点声明

- mTLS 真实 CA 证书链 + CRL/OCSP 端点、@simplewebauthn/server 密码学验签——仍需用户提供外部资源（交接文档 §3）
