# Changelog

> 格式：Keep a Changelog；版本口径见 `docs/版本计划.md`；每条详情以 git hash 为准（`git log` 权威），此处只留一行摘要。

## [Unreleased]

### Added
- **AI 团队模拟流量全自动化**：simulate-traffic.js（LLM 生成意图×虚拟角色池）+ systemd 三 timer（模拟每 4h/日聚合/周报）——影子数据零人工积累
- **影子数据采集层**：入口访问日志（不含 intent 明文）+ `collect-metrics.js` 日粒度聚合（降级率/时延分位/活跃身份数/审批决定/执行终态）——rc 阈值校准数据源
- **oracle-arm-1 内测环境上线**（影子模式）：ingress systemd 服务 + 真实 Agens 意图分类 → 审批单创建全链实测；部署实测三修复——模型超时可配、degraded 降级可观测、影子门禁
- **入口多供应商故障转移链**：CommandCode→OpenCode→TeamoRouter→Agens(free兜底) 按实测延迟排序，意图分类延迟从 10-30s 高降级降至 2.9-4.1s
- **HTTP 统一入口**（`impl/m5/src/server/http-ingress.js`）：零依赖 node:http——JWT 认证门禁→意图编排→审批解析（属主绑定、G2 同参透传）→自动执行链→作业只读投影；双轴审计先审后提交（审批授权面 P1 等全修复）；oracle-arm-1 内测部署清单就绪
- **WebAuthn 密码学真实验签**（`impl/m5/src/auth/webauthn-verifier.js`）：@simplewebauthn/server v13 包装（注册/认证流程 + base64url 公钥映射），经 `webauthnVerifier` 注入启用——核心领域层保持零依赖；`authenticateAsync` 异步认证入口（同步契约对 verifier 形态显式报 `webauthn_async_required` 不静默降级）
- **mTLS 本地通链 E2E**：openssl 自签开发 CA → TLS 终结 → 指纹断言 → 认证 → CRL 级联吊销全链测试
- **AI 专家团评测岗首轮产出**（项目所有者授权 recorded 变通）：隐藏高危集 64 条（双人独立生成合并去重）+ 红队对抗集 24 条，隔离保管于仓库外；评测门禁 hiddenDir 端到端实测通过
- **评测门禁执行机制**（`impl/m0-baseline/eval-gate.js`）：三集制配套——公开/隐藏集 manifest 版本声明 + 样本内容 sha256 指纹绑定（防改集不换版）+ 快照 JSONL 回归基准 + 回滚钩子（不达标即 rollback 信号）；隐藏高危 >50 硬校验、维护者双人由领域强制（RQ-721/INV-M4）
- **CRL 吊销镜像**（`impl/m5/src/auth/crl-mirror.js`）：与 authAdapter 共享 Set 差量同步 + fail-closed（空源默认拒绝防全量解除吊销、拉取失败保留原集）+ 审计留痕不含指纹值 + 定时启停
- 评测集布局迁移：平铺 JSON → `<type>/{manifest.json,samples.json}`（单源迁移，runner/测试同步）

### Changed
- **评测集跨模型交叉评审闭环**：deepseek-official 首轮评审 FAIL → 三轮返工（硬违规清零、标签错置修正、模板化/机翻腔改写、红队真实感提升+三盲区补齐）→ clinepass 终审 PASS；隐藏高危 64 条 / 红队 27 条（11 类攻击面）
- TeamoRouter 供应商路由修复：本地 CONNECT 中继（systemd 服务自愈）+ hosts 条目，路由恢复可用

- **mTLS 会话级联吊销**：会话绑定证书指纹，CRL 更新后已签发会话即时失效（RQ-611 全生命周期，审计 W3）
- WebAuthn 计数器防重放修正：仅当认证器实际使用计数器时强制单调（0 基线短路修复，审计 W1）；newCounter 缺失即拒绝（审计 W2）

## [v0.9.0-alpha] - 2026-08-25

首个发布锚点：功能收口（M0–M6）+ 真实部署六类适配器 + real 链 E2E 实测通过 + 双轴审计闭环。基线 401 tests（400 pass + 1 条件跳过）。

### Added
- **文档集**（2026-08-19，`451f440`）：产品/需求/指标/评测/DoD/计划 9 份终版 + 审计 100/100 + 红蓝对抗十轮收敛（96 处修复固化）
- **DDD 设计与选型**（M0）：42 不变量设计（`impl/m0-d`）+ 8 层技术选型决策（`impl/m0-t`）
- **领域实现**（M1–M3）：观测 obs 43 测试 / 对话 conv 56 测试 / 信任 trust 62 测试；157 波严格审计 + DDD 综合审计收敛
- **执行闭环**（M4，`a11ffad`）：Job 聚合 + ExecutionService + 附录 C 参数 schema，27 测试
- **整合层**（M5/M6，`975bb9c`）：Outbox 五步串联 + 审计链 + 评测门禁 GateService + 四角色走查 + 适配器契约（ADAPTER-CONTRACTS.md）
- **评测集公开集**（`08e95db`）：220 条样本（口语/知识/高危/术语/解释/FAQ）+ runner
- **真实部署适配器**（六类全落地）：审计 JSONL 持久化（`a710f88`）/ 身份资产仓储（`e8e0b8d`）/ 云台账投影（`edb4983`）/ SSH 执行（`80fe31b`）/ 模型接入——供应商无关层 + Cohere Command Code（`cf59dfd`）+ Agens 双供应商（`ce0ef6c`）/ 组合根装配 mock|real（`b233d21`）/ 认证 mTLS+WebAuthn+JWT HS256（`49465ed`）
- **real 链 E2E**（`26a2b1a`）：云端意图→双人审批→Grant→自动建作业→真实 SSH（京东云只读）→审计落盘从盘重建校验；`VOYAGE_E2E_REAL=1` 开关
- **认证 RS256/JWKS**（`d1a16a3`）：kid 定位公钥 + 算法族硬隔离防混淆（公钥当 HMAC 密钥攻击被测试锚定拒绝）+ rotateJwks/revokeJwksKey 轮换
- **Agens 复验驱动**（`138e7ae`）：参数抽取版提示词下完整审批执行链实测通过（意图→审批→Grant→真实 SSH→审计 verify）

### Fixed
- 真实适配器四轮双轴审计闭环（`8653264`/`90f1ee9`/`9d754f6`/`c5ce125`）：P0 real 模式模型桥接、handleAsync 并发串包（intent+actorId 归属队列）、matrixPort creator 错配（启动上下文绑定）、keyVault 审计假修复返工等 30+ 项
- DDD 全维度审计 38+ 轮（第 24–33 波）：事件跨 BC 一致性、时钟一致性、聚合封装、容量上限防 DoS 等 15+ 项（3 个 P0）
- Agens 复验产出三缺陷修复（`138e7ae`）：subject 抽取提示词、组合根目标投影（活跃资产校准 fail-closed）、clean 命令模板补全（path 破坏性目标仍不补）

### Security
- alg 白名单禁 none/密钥混淆（RQ-811）；JWT 恒时验签 + claim 白名单投影受管身份
- WebAuthn challenge 绑定 + 计数器防重放 + 吊销即时失效（RQ-612）；mTLS 无证拒绝 + CRL 吊销（RQ-611）
- 执行网关白名单硬门（INV-E3）：非白名单能力一律 REJECTED 不签发 Grant

### 已知限制（alpha 不上生产的理由）
- WebAuthn 密码学验签为 @simplewebauthn 替换点（协议形状已保证）；mTLS 待真实 CA 证书链
- 评测隐藏集/红队集未建（待独立评测岗双人/红队岗，RQ-721）
- 聚合阈值为目标值未实测校准（`指标口径.md` 双态原则）

[Unreleased]: https://github.com/NinjaSln-labs/voyage/compare/v0.9.0-alpha...HEAD
[v0.9.0-alpha]: https://github.com/NinjaSln-labs/voyage/commits/v0.9.0-alpha
