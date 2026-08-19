# 六类真实适配器契约定型（M6 内测上线 + 后续真实部署）

> 依据：`impl/m6-方案评审.md` §2.3 · M4/M5 端口契约惯例
> 所有契约已在 M4/M5 领域模型中以端口注入方式就绪，本文件定义替换条件与失败语义。

## 1. 认证适配器 `authPort`
- 方法：`authenticate(credential)` → `{ ok, identity }`
- 输入：mTLS 证书链 / WebAuthn 断言 / OAuth2 Bearer Token
- 输出：`{ ok, identity: { id, role, sessionId } }`
- 失败：`{ ok: false, reason }` → REJECTED
- 依赖：证书信任链/硬件 Key/IdP JWT
- 替换条件：M5 actorId 改为经 authPort 注入 identity

## 2. 被管机执行适配器 `execAdapterPort`
- 方法：`execute(target, template, params)` → `{ ok, result }`
- 输出：`result: { stdout?, stderr?, exitCode?, nodeEffects[] }`
- 失败：timeout / permission_denied / connection_failed
- 依赖：SSH 连接（凭据经 keyVaultPort 注入）
- 替换条件：M4 节点完成回调改为实时 call adapter + 审计留痕

## 3. 审计持久化适配器 `auditStoragePort`
- 方法：`persist(entry)` / `query(opts)` → `{ entries }`
- 约束：append-only ≥ 180 天 · 不可覆写/删除
- 失败语义：write fail → fail-closed（INV-U1）→ 降级态缓冲队列
- 替换条件：M5 createAuditRepo 注入真实持久化实现

## 4. 身份/角色仓储适配器 `identityRepoPort`
- 方法：`findById(id)` / `findByRole(role)`
- 输出：`{ identity: { id, role, capabilities, active } }`
- 依赖：LDAP / IdP / 本地身份库
- 安全：不在事件载荷中曝光凭据

## 5. 资产仓储适配器 `assetRepoPort`
- 方法：`findById(id)` → `{ asset | null }`
- 输出：`asset: { id, status, retiredAt? }`
- 依赖：CMDB / 真实资产库
- 替换条件：M4 exec.start 注入真实 assetPort

## 6. 模型 API 适配器 `modelApiPort`
- 方法：`interpret(text, ctx)` / `search(query, ctx)`
- 失败：断连→本地兜底（INV-M2）；超时→confidence=0 走审核
- 成本：单次计费+月上限告警（INV-N2）+ 超限自动降级
- 替换条件：M5 convPort 注入真实模型

## 补充
- 凭据保险库 keyVaultPort 归于 execAdapterPort 内部实现
- 通知 notifyPort 由真实推送通道（IM/Webhook）实现——M5 已预留 notify 端口
- 建议部署时序：(a) 审计+资产+身份仓储先行 → (b) SSH+模型+认证接网络
