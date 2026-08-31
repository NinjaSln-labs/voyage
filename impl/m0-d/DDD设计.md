# M0-D 详细设计（DDD · 行舟 Voyage）

> 依据：`产品0-1计划.md` §2.5.2；输入种子 = C1–C17 + R1–R11 + §4.2 矩阵 + §11 术语 + RQ 需求化 + `AI红蓝对抗报告.md`（Critical/Major 逐条固化不变量）。
> 方法：限界上下文 → 聚合（实体/值对象）→ 不变量 → 领域事件 → 仓储接口 → 统一语言。
> 产出 7 项齐全；实现与测试（M1+）按本设计对齐。

---

## 1. 限界上下文与统一语言（BC ↔ 能力 ↔ 上下文）

| BC | 能力 | 职责 | 关键概念（统一语言） |
|----|------|------|---------------------|
| 对话编排 `conv` | C1–C4 | 口语输入→意图（动作+能力+置信度+服务端重分类）、术语翻译、任务拆解、多轮上下文 | 意图、动作分类、口语、标准术语、置信度、会话、摘要 |
| 知识 `know` | C5–C6 | 检索-重排-生成、FAQ 沉淀审阅 | 文档、密级标签、来源可信级、FAQ 条目、审阅状态 |
| 观测 `obs` | C7 | 指标/日志采集、健康报告 | 指标、日志（数据非指令）、资产健康 |
| 资产 `asset` | C9 | 资产注册/归属/生命周期 | 资产、归属、能力声明、命名 schema |
| 执行 `exec` | C8 | 作业生命周期、定时任务、一键简化 | 作业、命令模板、目标资产、Grant |
| 审批信任 `trust` | C10–C12 | 四层准入、审批、许可、角色投影、聚合判定 | 证据、审批单、批准人、Grant、高危面、聚合窗口 |
| 模型 `model` | C13/C17 | 路由/降级/评测门禁 | 模型、路由策略、降级态、评测集版本、校准集 |
| 身份 `ident` | C14 | 用户/组/凭据/IdP | 身份、身份组、主体、claim |
| 通知 `notif` | C15 | IM 推送/回执 | 通知、回执（提醒非签名） |
| 审计 `audit` | C16 | 五元组/哈希链/计数事件流 | 审计事件、五元组、计数事件、哈希链 |
| 度量 `metric` | — | 北极星/反指标计数 | 计数事件流、月读数 |

**统一语言铁律**：跨 BC 只讲标准术语；口语必须先过 `conv` 术语翻译（R10）。

> **应用编排层（application orchestration，非限界上下文）**：横切多 BC 的**编排职责**（五步权限判定点 §6 串联 + Outbox 事务边界 §7 + 事务时序）不归属任一 BC，实现为应用服务（`impl/m5/src/integration/` IntegrationService/OutboxJournal + `impl/m5/src/metric/` MetricService）。它是 conv↔trust↔exec↔audit↔metric 的横向编排，通过端口注入调用各 BC 领域服务，不承载领域状态，不复制任何 BC 的不变量。

**统一语言核心术语定义（严格审计补全）**：
- **意图**（intent）：口语经服务端重分类后的可执行语义对象 `{actionClass, capability, confidence, reclassified}`；动作分类（actionClass）分为读类（read）、写类（write）、外传类（egress）、授权类（authorize，预留），具体能力（capability）定义在能力清单中。
- **动作分类（actionClass）**：意图的粗粒度动作类型——`read`（只读查询，无系统内副作用）、`write`（系统内变更，如重启/清理/扩容/切换）、`egress`（数据外传出信任边界，如发送/导出/下载到外部）、`authorize`（授权/管理类操作，**预留**——当前无对应能力实现，后续扩展时需定义能力列表与不变量）。模型只负责匹配意图到动作+能力，安全决策由能力定义的风险等级决定，不依赖模型输出。**审计五元组中的 `action` 字段（操作记录）与此处的 `actionClass` 为不同概念，不可混淆**。
- **能力风险等级（risk level）**：每个能力预定义的安全风险等级——`low`（自动放行，如 query_status）、`high`（双人审批，如 restart、egress_send）、`critical`（直接拒绝，暂未定义）。安全决策由能力定义决定，不依赖模型输出的安全判断字段。
- **口语 / 标准术语**：口语=用户原始输入；标准术语=术语表（TermEntry）中唯一语义；「卡了→响应延迟」为种子（需求附录 A）。
- **会话**（session）：单一主体+设备绑定的交互上下文；压缩摘要保留安全关键信息（INV-C2）。
- **审批单**（approval）：高危操作的 ≥2 自然人批准凭证（INV-A1~A5）。
- **Grant**：执行许可——只从审批单存储读取，绑定作业/目标/命令/有效期（INV-G1~G4）。
- **高危面**（high-risk）：矩阵 ⚠️/审批类操作的聚合分类（HighRiskCatalog 版本化）。
- **聚合窗口**（aggregation window）：高危判定的滑动窗口状态（会话内/跨会话/跨桶/资产级，INV-C4）。
- **作业**（job）：白名单能力内的执行单元（模板+参数 schema+Grant 关联，INV-E1~E5）。
- **审计五元组**：`{who, when, from, action, result}` + 完整性 `{chainHash, seq}`（RQ-831）。
- **降级态 / 收窄**：审计存储不可用→写面只读+审批；模型未过门禁→执行面收窄只读+审批（INV-U3/M2）。
- **密级 / 敏感级**：文档密级（缺省最高，fail-closed）与资产敏感级（缺省最高，fail-closed）——两者同构（INV-K1/M3）。

## 2. 核心聚合与不变量清单

> 每条不变量标注来源：R#（业务规则）/RQ#（需求）/RC#（红蓝 Critical/Major 固化）。

### 2.1 审批单聚合（trust）
- 不变量 INV-A1【R1/RQ-621】批准人 ≥2 且为两个不同自然人；操作者不可自批；每票本人 WebAuthn。
- 不变量 INV-A2【R2/RQ-623】有时限（默认 30 分钟，目标值）；超时默认拒绝；超时判定与执行启动同事务，超时后已读批准快照失效。
- 不变量 INV-A3【R3/RQ-622】决定幂等：一经批准/拒绝不可翻转。
- 不变量 INV-A4【RQ-621-RC】审批人池 ≥3；补位授权双人确认（两名管理者或管理者+在职 SRE）+审计+矩阵版本化门禁；补位人技术背景资质+无利益冲突；时效 90 天；SRE 恢复自动回收。
- 不变量 INV-A5【RQ-614】审批确认唯一通道=Web 端本人 WebAuthn；IM 回执仅提醒；审批链接一次性+短时效+绑定会话。

### 2.2 Grant 聚合（trust）
- 不变量 INV-G1【R4/RQ-624-RC】Grant 只从审批单存储读取（对话内容不构成许可）。
- 不变量 INV-G2【RQ-624-RC】绑定作业+目标资产+命令参数+有效期（默认 24 小时，目标值）；签发与执行启动同事务。
- 不变量 INV-G3【R5/RQ-624】过期自动失效；吊销全网广播且即时废止；**执行中作业吊销语义：已启动节点完成并记审计（补偿留痕），未启动/排队节点一律拒绝（INV-E5）**。
- 不变量 INV-G4【RQ-624】矩阵 ✅ 通道 Grant 由矩阵授权记录+聚合计数自动签发（视同审批单存储）。

### 2.3 会话聚合（conv）
- 不变量 INV-C1【RQ-132】会话归属单一主体并绑定登录设备；切换后旧上下文不可见、旧 Grant 失效。
- 不变量 INV-C2【RQ-131-RC】摘要压缩保留安全关键信息且不新增授权语义；摘要结论仅上下文参考，每轮以审批单存储与权限现状重算；会话内权限变更（RQ-812）/Grant 吊销即时作废旧结论。
- 不变量 INV-C3【RQ-113】动作分类+能力匹配由服务端规则强制——执行面动词命中→write 类，外传动词命中→egress 类；置信度 <0.8（校准后生效）的 write/egress 类意图降级确认/审批。
- 不变量 INV-C4【RQ-633-RC】高危判定服务端聚合：滑动窗口（单会话 30 分钟+跨会话同主体 1 小时，用户×资产）；同类=同能力×同资产；跨账户按资产聚合；跨桶累计（同主体窗口内跨能力/跨资产同向破坏类 ≥10 次或 ≥10 台升级审批）；同类 ≥3 次或 ≥10 台升级审批；矩阵 ✅ 仅单次授权。

### 2.4 作业聚合（exec）
- 不变量 INV-E1【R4/R9】非 read 类意图（write/egress/authorize）先过信任预检（角色能力✓/Grant✓/资产未退役✓/高危面匹配✓）再拆解；作业启动前必须持有效 Grant。
- 不变量 INV-E2【RQ-414-RC】定时任务绑定创建者主体与执行身份；触发时校验 Grant 有效 + 聚合升级标志（置位即挂起转审批）；执行时按创建者维度纳入聚合。
- 不变量 INV-E3【附录 C-RC】执行仅限白名单能力∩矩阵允许；参数 schema 校验（目标资产∈资产库∩角色权限、命令限模板、路径白名单、编码变体拒绝）；参数化调用不 shell 拼接。
- 不变量 INV-E4【RQ-411】SSH 凭据经凭据保险库管理，不入模型上下文。
- 不变量 INV-E5【RQ-624-RC】执行中 Grant 吊销：已启动节点完成+审计留痕（副作用补偿记录），未启动/排队节点一律拒绝；吊销广播与节点调度原子（事件版本号）。（对应红蓝 R-07 残留的闭合）

### 2.5 资产聚合（asset）
- 不变量 INV-AS1【RQ-511-RC】资产注册须归属验证+审批（SRE 确认）；命名 schema（拒绝 shell 元字符/编码变体）。
- 不变量 INV-AS2【RQ-512/514】资产 ID 唯一引用；作业受理校验退役状态。
- 不变量 INV-AS3【RQ-513】注册/能力变更/退役事件全域广播；订阅方以事件更新本地快照，事件携带版本号防乱序。

### 2.6 知识/文档聚合（know）
- 不变量 INV-K1【RQ-211-RC】数据源分级（可信/受限/沙箱）；写入权限收口；密级标签治理，缺失默认最高密级（fail-closed）。
- 不变量 INV-K2【RQ-213-RC】数据-指令分层：入库消毒+注入前隔离标注（归一化解码后）；跨文档聚合按权限整体过滤；检索缓存含身份+密级键、随权限刷新联动失效。
- 不变量 INV-K3【RQ-222-RC】FAQ 写回审阅门（SRE 审阅、沙箱写回、生产二次确认复用双人语义）；F10 案例写回复用同一审阅门。

### 2.7 审计聚合（audit）
- 不变量 INV-U1【RQ-831-RC】审计先行（写入成功才下发外部执行）；操作提交与审计写入同事务，审计失败操作回滚（fail-closed 仅约束写操作）。
- 不变量 INV-U2【RQ-831-RC】append-only + 每日哈希链；断裂告警+分段重建+事件登记。
- 不变量 INV-U3【RQ-831-RC】降级态审批通道豁免 fail-closed（落盘缓冲重试+恢复补链）；应急通道同 WebAuthn 双人、不降强度；人工应急兜底。
- 不变量 INV-U4【RQ-831】北极星计数最小事件保序持久、与全量明细分离；查询类缓冲（容量上限+背压+溢出丢弃告警）。
- 不变量 INV-U5【R7/RQ-832】审计不可绕过；执行/审批类至少一次投递；留存 ≥180 天。

### 2.8 模型聚合（model）
- 不变量 INV-M1【RQ-712-RC】模型/路由变更一律先过评测门禁；已过门禁配置 <5 分钟生效；配置签名+权重哈希+变更审计。
- 不变量 INV-M2【RQ-711-RC】降级模型须过高危召回 100% 否则执行面收窄只读+审批（独立安全组件同步判定、先收窄后生效、组件故障 fail-closed、降级路径强制验签）。
- 不变量 INV-M3【RQ-714-RC】敏感判定服务端规则（标签+分级），标签缺失默认最高敏感级（fail-closed）；云端出站全量审计。
- 不变量 INV-M4【RQ-722-RC】高危召回 100% 三集分别（AND）为硬线；事故回填双人审阅仅入公开集；评测集变更自动重评回滚；分布漂移监控（扩充双人审阅不自动入集）。

### 2.9 身份/通知聚合（ident/notif）
- 不变量 INV-I1【RQ-811-RC】IdP 签名算法白名单+claim 白名单；CA 失陷/设备丢失预案。
- 不变量 INV-I2【RQ-812-RC】身份组变更会话即时刷新权限（最迟下轮交互）。
- 不变量 INV-N1【RQ-821/RQ-822】通知签名校验、回执仅提醒；回执超时重发与丢失检测；**通知幂等键（防重复/丢失）**。
- 不变量 INV-N2【RQ-713-RC】关键告警（反指标触线/审批绕过/审计完整性异常）永不合并不限频、不可静默。

### 2.11 观测/准入/矩阵/术语 补全组（严格审计新增）

- 不变量 INV-O1【RQ-311~315】观测只回真实观测（R8）；日志内容为数据非指令源（进模型前隔离标注）；Agent 内存 <50MB；RESTful API 接口；告警阈值可配置（目标值实测校准）；资产/服务健康报告只读口径（终版 §4.2 矩阵）。
- 不变量 INV-T1【RQ-611~613】四层准入（R6）：设备级 mTLS 无证拒绝（CRL/OCSP 维护）；账号级 WebAuthn 注册双通道+恢复流程+吊销即失效；行为级设备指纹+异常检测（异地/异常时间二次验证）；操作级高危审批。四层证据齐备才准入，缺层即拒绝或分层动作。
- 不变量 INV-P1【RQ-631/RQ-632】能力×角色矩阵服务端强制（唯一口径终版 §4.2）；特权动作（补位授权/矩阵变更/白名单变更/评测集变更）纳入全角色×能力校验与越权样本集。
- 不变量 INV-K4【RQ-112/RQ-721】术语表为受管配置：双人审阅（两个自然人，SRE）+全量回归（含高危意图集）+审计留痕；歧义意图先确认目标资产；术语表变更触发评测门禁。
- 不变量 INV-M5【RQ-715】月度评估（每月首个工作日评估新模型性能/价格，灰度放量）与分布漂移监控联动。
- 不变量 INV-E7【ADR-002】安全决策由能力定义决定，不依赖模型分类输出。模型只负责将文本匹配到动作+能力；每个能力预定义风险等级（low/high/critical），编排层按等级决定放行/审批/拒绝，不使用模型输出中的安全判断字段（如 type 或 egress 布尔）。能力定义增删改走双人审阅+全量回归（同 INV-K4 口径）。

### 2.10 无孤儿规则核查
- R1–R11 全部映射为不变量：R1→A1、R2→A2、R3→A3、R4→G1/E1、R5→G3、R6→T1、R7→U5、R8→O1（obs/know 回真实观测）、R9→E1、R10→K4（conv 术语翻译铁律）、R11→分层动作（conv/trust）。
- 红蓝 Critical/Major 逐条落位：审计原子性（U1/U3）、高危召回悬空（M4）、Grant 语义（G1/G2/G4）、白名单参数（E3）、降级收窄（M2/M3）、聚合跨桶（C4）、补位授权（A4）、摘要旧结论（C2）、定时任务 standing Grant（E2）、敏感缺省（M3）——**无孤儿、无遗漏**。

### 2.12 RQ → 不变量全量追溯矩阵（58 条，严格审计补全）

| RQ | 能力 | 不变量 | RQ | 能力 | 不变量 |
|----|------|--------|----|------|--------|
| RQ-111 | C1 | K4/C3（口语输入） | RQ-414 | C8 | E2 |
| RQ-112 | C1 | K4 | RQ-415 | C8 | P1 |
| RQ-113 | C1 | C3 | RQ-416 | C8 | E1 |
| RQ-121 | C2 | conv BC/§4 拆解 | RQ-417 | C8 | E3（一键=模板） |
| RQ-122 | C2 | conv BC/§4 | RQ-418 | C8 | U5（操作审计） |
| RQ-123 | C2 | conv BC/§4 异步 | RQ-511 | C9 | AS1 |
| RQ-131 | C3 | C2 | RQ-512 | C9 | AS2 |
| RQ-132 | C3 | C1 | RQ-513 | C9 | AS3（资产事件） |
| RQ-141 | C4 | conv BC/§4 解释 | RQ-514 | C9 | AS2 |
| RQ-142 | C4 | conv BC/§4 | RQ-611 | C10 | T1 |
| RQ-211 | C5 | K1 | RQ-612 | C10 | T1 |
| RQ-212 | C5 | K1（向量化入数据源治理） | RQ-613 | C10 | T1 |
| RQ-213 | C5 | K2 | RQ-614 | C10 | A5 |
| RQ-214 | C5 | K2（渐进） | RQ-621 | C11 | A1 |
| RQ-221 | C6 | K3 | RQ-622 | C11 | A3 |
| RQ-222 | C6 | K3 | RQ-623 | C11 | A2 |
| RQ-223 | C6 | K3（索引新鲜度并入写回治理） | RQ-624 | C11 | G1~G4 |
| RQ-311 | C7 | O1 | RQ-631 | C12 | P1 |
| RQ-312 | C7 | O1 | RQ-632 | C12 | P1 |
| RQ-313 | C7 | O1 | RQ-633 | C12 | C4 |
| RQ-314 | C7 | O1 | RQ-711 | C13 | M2 |
| RQ-315 | C7 | O1 | RQ-712 | C13 | M1 |
| RQ-411 | C8 | E4 | RQ-713 | C13 | N2 |
| RQ-412 | C8 | E1（批量） | RQ-714 | C13 | M3 |
| RQ-413 | C8 | E3（Web SSH 白名单） | RQ-715 | C13 | M5 |
| RQ-721 | C17 | M4 | RQ-821 | C15 | N1 |
| RQ-722 | C17 | M4 | RQ-822 | C15 | N1 |
| RQ-811 | C14 | I1 | RQ-831 | C16 | U1~U5 |
| RQ-812 | C14 | I2 | RQ-832 | C16 | U5 |

> **追溯铁律**：58/58 全覆盖——每条 RQ 至少映射到一个不变量/BC 契约；无孤儿需求（对照 `需求说明书-终版` §1 映射表与 §9 追溯矩阵）。

## 3. 领域事件目录

| 事件 | 发布者 | 订阅者 | 关键载荷 |
|------|--------|--------|---------|
| `IntentRecognized` | conv | exec/trust/know | 动作分类、能力、置信度、主体、会话 |
| `IntentReclassified` | conv（服务端重分类） | trust | 动作分类变更标记（如 read→write、read→egress）；**携带 `newAction` 字段（变更后的 actionClass 值）** |
| `ApprovalRequested` | exec/trust | notif | 审批单号、操作者、目标 |
| `ApprovalApproved / Rejected / TimedOut` | trust | exec/audit | 审批单号、批准人、时序 |
| `GrantIssued / Revoked / Expired` | trust | exec/audit | Grant ID、绑定对象、有效期 |
| `JobStarted / Completed / Failed` | exec | audit/metric/notif | 作业 ID、Grant 关联、结果 |
| `AggregationEscalated` | trust | exec/audit | 聚合窗口、阈值命中 |
| `SessionRotated` | conv | trust | 会话切换、旧 Grant 失效 |
| `PermissionChanged` | ident | conv/trust | 身份组变更、即时刷新 |
| `DocIngested / Rejected` | know | audit | 密级、可信级 |
| `FaqWrittenBack` | know | audit | 审阅门结果（含审阅人/二次确认） |
| `FaqStatusChanged` | know | audit | FAQ 条目状态迁移（pending→approved→written_back/rejected） |
| `ModelSwitchRequested / Gated / RolledBack` | model | audit/metric | 模型版本、评测集版本 |
| `FallbackTriggered / Narrowed` | model | exec/trust/notif | 降级态、收窄面 |
| `AuditWritten` | audit | metric | 五元组 |
| `BackfillCandidate` | audit | model（评测岗） | 事故样本（双人审阅后入集） |
| `SubstitutionGranted / Revoked` | trust | audit/ident | 补位授权、时效、回收 |
| `CapabilityDenied` | trust | audit | 白名单外能力拒绝（INV-E3：非白名单一律 REJECTED + 计审计） |
| `ChainIntegrityBreach` | audit | notif | 哈希链断裂序号、severity=critical（INV-N2 关键告警） |
| `QueryBufferOverflow` | audit | notif | 查询缓冲溢出丢弃数（INV-U4 背压告警） |

**审计五元组 schema（RQ-831）**：
```
AuditEvent {
  who: SubjectId            // 主体（身份目录唯一 ID，非会话文本）
  when: TrustedTimestamp     // 受信时间源（NTP/硬件时钟），漂移告警
  from: DeviceFingerprint    // 设备指纹（不可克隆强度、平台同步密钥不视为绑定证据）
  action: { intent, capability, target, params-schema-ok }
  result: Outcome            // 成功/拒绝/审批/回滚
  links: { approvalId?, grantId?, aggregationEscalation? }
  integrity: { chainHash, seq }   // append-only 哈希链
}
```

## 4. 能力接口契约（跨 BC 调用语义）

| 接口 | 调用方→提供方 | 契约要点 |
|------|-------------|---------|
| `conv.interpret(口语, 会话)` → 意图 | UI→conv | 返回动作+能力+置信度；服务端规则强制重分类；<0.8 的 write/egress 类降级 |
| `conv.translate(口语)` → 术语 | conv 内部 | 表为准、模型仅辅助；歧义→确认流程 |
| `know.search(意图, 主体)` → 片段 | conv→know | 检索级 ACL（密级×权限交集）；跨文档聚合过滤；缓存含身份键 |
| `obs.query(资产, 指标)` → 数据 | conv/exec→obs | 只回真实观测（R8）；数据非指令 |
| `exec.start(作业)` → 状态 | conv→exec | 前置：白名单∩矩阵+Grant+聚合标志；审计先行 |
| `trust.approve(审批单, 票)` → 结果 | UI→trust | WebAuthn 唯一通道；双人；超时同事务 |
| `trust.checkGrant(作业, 目标, 参数)` → 许可 | exec→trust | 只读审批单存储；绑定校验 |
| `trust.issueGrant(审批单/矩阵授权, 作业, 目标, 参数)` → Grant | trust 内部（审批链末尾） | 签发与执行启动同事务（本地事务+Outbox）；只从审批单存储读取；绑定作业/目标/命令/有效期 |
| `trust.evaluate(会话/意图)` → 高危判定 | conv→trust | 滑动窗口聚合；跨桶累计；升级标志 |
| `model.route(意图)` → 模型/路由 | conv→model | 敏感走本地（服务端规则）；降级→收窄通知 |
| `model.gate(变更)` → 门禁结果 | 运维→model | 三集分别 100%（AND）；变更审计 |
| `audit.write(事件)` → ack | 全部→audit | 同事务（写操作）；计数事件保序持久 |
| `metric.count(月)` → 读数 | 报表→metric | 北极星/反指标（审计计数事件流） |

**接口失败语义（统一约定）**：
- 每接口三态返回：`OK` / `REJECTED`（业务拒绝，含原因码：权限/白名单/聚合/过期/密级）/ `ERROR`（技术失败）。
- 写面接口（exec.start / trust.approve / audit.write）失败语义：**fail-closed**——`ERROR` 时调用方不得继续执行链（对应 INV-U1）；`REJECTED` 时进入分层动作（提示/确认/审批，R11）。
- 读面接口（obs.query / know.search / conv.interpret）失败语义：降级提示或重试，不阻断可用性（查询面口径）。
- 超时语义：读面可重试；写面超时视为未发生（幂等键防重放，对应 INV-N1/RQ-822）。
- 降级语义：模型路由失败→本地兜底→执行面收窄（INV-M2）；审计存储失败→写面降级态（INV-U3）。
- **输入防护（对话/意图层）**：单次输入长度上限（默认 4096 字符，目标值实测校准）+ 每主体会话速率限制（默认 30 次/分钟，防注入洪泛与评测污染塑形）+ 超限一律 REJECTED 并计审计（防洪泛/塑形，对应 INV-U4 背压语义与高危评测集「塑形」防线）。

## 5. 数据对象（实体/值对象核心字段）

- **资产**：`Asset{id, name(schema), owner, capabilityDecl, securityLabel(缺省最高密级/敏感级), status, snapshot}`
- **作业**：`Job{id, creator, target, template, params(schema-ok), grantRef, aggregationEscalated, status, nodeEffects[]}`
- **审批单**：`Approval{id, operator, target, highRiskType, votes[{person, webAuthn, seq}], deadline, status, terminalSeq}`
- **Grant**：`Grant{id, jobRef, target, commandTemplate, paramsHash, validUntil, issuedTx, revokedAt}`
- **意图**：`Intent{actionClass, capability, confidence, reclassified, session, actor}`（actionClass ∈ {read, write, egress, authorize}；authorize 为预留）
- **任务**：`Task{id, dag[], status}`（无环）
- **评测集版本**：`EvalSetVersion{id, setType, parts(公开/隐藏/红队), sampleHashes, maintainers, versionOfModel, rotDate}`
- **会话**：`Session{id, actor, deviceBinding, summary(安全关键信息), rotatedAt}`（INV-C1/C2）
- **审计事件**：`AuditEvent{who, when(受信时间源), from(设备指纹), action, result, links, integrity{chainHash, seq}}`（§3 schema 实体化，INV-U1~U5）
- **术语条目**：`TermEntry{oral, standard, status(待审/生效/废弃), reviewedBy, reviewedAt, version}`（INV-K4）
- **高危面清单**：`HighRiskCatalog{id, capability, riskLevel, aggregationBucket, version, changedBy}`（RQ-631 版本化，INV-P1）
- **通知**：`Notification{id, channel, type, contentHash, receiptStatus, idempotencyKey, timeoutRetry}`（INV-N1）
- **FAQ 条目**：`FaqEntry{id, content, status(pending/approved/written_back/rejected), reviewer, sandboxRef, productionRef, auditedAt}`（INV-K3 审阅状态机）
- **设备**：`Device{id, mTlsCertRef, platformKeyId(不可导出), deviceFingerprint, webAuthnRegistrations[], status(active/revoked), registeredVia(双通道)}`（INV-T1 设备级准入实体化）
- **补位授权**：`SubstitutionGrant{id, grantedBy(双人), grantee, qualification, conflicts(无利益冲突声明), validFrom, validUntil(默认 90 天), revokedAt(自动回收), auditRef}`（INV-A4）
- **聚合窗口状态**：`AggregationWindow{windowType(会话内/跨会话/跨桶/资产级), actorId?, assetId, capabilityBucket, slidingStart, count, escalated}`（INV-C4；**资产级窗口支持跨账户协同按资产聚合**）

## 6. 能力×角色矩阵服务端强制（权限判定点）

**判定点（按序，服务端强制，UI 隐藏不算隔离）**：
1. **意图层**（conv）：服务端规则强制重分类 → 动作+能力定稿；能力风险等级决定安全路径（low→放行，high→审批，critical→拒绝）。**确定性规则层**（compose.js toConvResult 或编排层前置，待实现）对模型输出的 actionClass/capability 做后处理校验——关键词匹配覆写（如"外传"类关键词命中时强制设定 egress 类），确保安全字段不依赖模型概率输出。
2. **拆解前**（trust.evaluate）：高危判定（聚合滑动窗口/跨桶）→ 高危？→ 必须审批。
3. **执行前**（exec 网关）：`白名单 ∩ 矩阵` 叠加裁决（矩阵 ❌ > 白名单不允许 > 审批要求）；参数 schema；Grant 校验；资产退役校验；聚合升级标志。
4. **审批链**（trust）：WebAuthn 唯一通道、双人、不可自批、超时同事务、幂等。
5. **审计**（audit）：五元组先行写入，写失败即回滚（写操作）。

**特权动作覆盖（RQ-632-RC）**：补位授权、矩阵变更、白名单变更、评测集变更——全部纳入全角色×能力服务端校验与越权样本集（100% 拦截率目标）。

## 7. 安全链路门禁时序（R1–R3 全链）

```
口语输入
  → conv.interpret（服务端规则：动作分类+能力匹配；置信度 <0.8 的 write/egress → 确认/审批）
  → 能力风险等级判定（能力定义决定：low→放行，high→审批，critical→拒绝）
  → trust.evaluate（滑动窗口聚合；跨桶累计；高危判定）
  → 高危? → trust 审批流（WebAuthn 唯一通道 → 双人不可自批 → 超时默认拒绝[同事务] → 幂等）
  → trust 签发 Grant（只从审批单存储读取；绑定作业/资产/命令/有效期；同事务）
  → exec 启动（白名单∩矩阵 → 参数 schema → Grant 校验 → 聚合升级标志 → 资产退役校验）
  → audit.write 先行（失败→回滚 fail-closed；计数事件保序）
  → 下发外部执行（幂等键+副作用补偿留痕）
  → 完成 → 审计终态 + 计数事件 + 通知（IM 仅提醒）

降级态（审计存储不可用）：写面只读+审批；审批通道豁免 fail-closed（落盘缓冲重试）；应急通道同 WebAuthn 双人；人工应急兜底。
模型降级（断网/成本）：未过高危门禁 → 执行面收窄只读+审批（独立安全组件同步判定，先收窄后生效）。
```

**时序铁律**：审计先行 > 执行下发；审批-执行同事务；聚合升级 > standing Grant；补位授权双人+时效+回收。

**跨 BC 事务边界机制（RQ-623 契约固化，严格审计补全）**：
「同事务」为**最终一致性事务边界**，按路径选型（M0-T 决策记录锁定，替换条件=契约测试回归）：
1. **审批-执行-审计链**（trust↔exec↔audit）：**本地事务 + 持久化 Outbox**——审批决定/Grant 签发/审计写入在同一本地事务提交，Outbox 消息驱动执行启动；执行侧收到消息后先重校验（Grant 仍有效、聚合未升级、资产未退役）再下发，不满足即回执拒绝并记审计。**Outbox 消费语义：消息 ID 幂等去重（消费端），失败指数退避重试，超限转死信并告警（关键告警不静默，INV-N2）**。
2. **降级态审批豁免**（audit 存储不可用）：审批走落盘缓冲（独立持久介质）重试，恢复后补齐入哈希链（INV-U3）。
3. **Saga 补偿**：批量作业跨节点副作用用幂等键+补偿任务（INV-U1 批量按节点记录副作用状态）。
4. **不可用即拒绝**：任何「同事务」参与方超时/失败 → 整链 fail-closed，不留半程副作用（RQ-831）。
5. **边界竞态裁决（严格审计补全）**：审批超时与聚合升级**同时触发**时——以「更保守者胜」：任一触发拒绝/升级即拒绝执行；两个判定在同一事务内按固定序（先聚合升级判定、后超时判定）串行执行，避免竞态双写。
6. **分布式时钟一致性（严格审计补全）**：审批超时/聚合窗口/审计时间戳判定依赖时钟——多节点部署须经受信时间源同步（NTP/硬件时钟，漂移告警，NFR 安全行已声明）；跨节点判定以**单写者时序**为准（审批单/Grant/审计事件的状态迁移由唯一权威节点串行），避免多副本时钟偏差导致超时判定不一致。
7. **性能预算（严格审计补全）**：审计先行路径（写审计→下发执行）须满足基础文档 §6.4 性能预算——简单问答 <5s/复杂 <30s 或「处理中」；审计写入与哈希链计算不得阻塞执行主链（异步落盘+同步 ack 快路径；哈希链每日批量校验非逐条在线）；M1 以压测校准并建档（指标口径双态原则）。
8. **可观测性（严格审计补全）**：模型任务成功率/响应时间/成本跟踪（NFR 可观测性行）由 `metric` BC 承接——`ModelTaskObserved` 事件（成功率/时延/成本/模型版本），月度评估（INV-M5）与预算告警（INV-N2）以之为数据源。

---

## 验收（M0-D 评审通过条件）

- [ ] 不变量清单齐全（R1–R11 + 红蓝 Critical/Major 逐条无遗漏）
- [ ] 无孤儿规则（每条规则/需求映射到至少一个不变量）
- [ ] 矩阵服务端强制（判定点 5 步 + 特权动作覆盖）
- [ ] 审计五元组 schema 定义且与 RQ-831 一致
- [ ] 接口契约可支撑契约测试（组件是适配器）
- [ ] 与基础文档对齐：本文全部条目可回溯到 C#/RQ#/R#/附录 C/红蓝报告
