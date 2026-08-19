# M4 执行闭环（C8/C9/C2）交付说明

- 依据：`产品0-1计划.md` §4 M4（执行闭环）+ `DoD 门禁.md` Next + M0-D exec 限界上下文（INV-E1~E5）+ `impl/m4-方案评审.md`（7 节设计决策）+ `需求说明书-终版.md` 附录 C（白名单参数 schema）
- 交付：领域模型 + 契约测试，全部通过（依赖基线 M1/M2/M3 不受影响）

## 交付物

| 文件 | 内容 |
|------|------|
| `src/exec/domain.js` | exec 领域模型：Job 聚合 + NodeEffect + ExecutionService + 3 事件 + 白名单/参数 schema 规则（附录 C 落地） |
| `src/exec/repo-memory.js` | Job 内存仓储 + 内存事件总线（含幂等/订阅） |
| `test/exec.test.js` | 契约测试 H/E/G/A/S 命名（happy×error×edge×adversarial×fault-tolerance 五类） |

## DoD-B 勾选

- [x] 作业生命周期（queued→running→completed/failed）：H1
- [x] exec.start 判定点 3 服务端强制（白名单∩矩阵→参数 schema→Grant→聚合标志→资产→审计先行）：H1/H2/H3
- [x] 附录 C 参数 schema（命令限模板/路径白名单/shell 元字符/Base64/Unicode 同形拒绝）：H3/E3/A4
- [x] 订阅 M3 事件（GrantIssued/Revoked/Expired/AggregationEscalated/审批终态，幂等）：H4/G1/G2/G3/G4
- [x] INV-E5 执行中 Grant 吊销：已启动完成+未启动拒绝：G3/A5
- [x] INV-E2 聚合升级挂起：G1/A3

## 不变量 → 实现 → 测试映射表（质量基调 §三.1）

| 不变量 | 实现 | 测试 |
|--------|------|------|
| INV-E1 执行前信任预检（Grant 必持有+匹配/资产/高危面） | ExecutionService.start 步骤2/4/6 | H1/E2/E4 |
| INV-E2 定时任务触发校验+聚合升级挂起 | escalate/resume + start 硬门 + AggregationEscalated 订阅 | G1/A3 |
| INV-E3 白名单∩矩阵+参数 schema（附录 C 四类+编码变体） | WHITELIST_CAPABILITIES + validateParams + matrixPort | H3/E1/E3/A4 |
| INV-E4 凭据保险库（params 无凭据字段） | CREDENTIAL_KEYS 构造拒绝 | E5 |
| INV-E5 执行中 Grant 吊销：已启动完成+未启动拒绝 | _handleGrantRevoked | G3/A5 |
| 附录 C 命令限模板 | COMMAND_TEMPLATES + TEMPLATE_BY_CAPABILITY | H3/E3 |
| 附录 C 路径白名单（清理） | LOG_DIR_WHITELIST + PATH_CAPABILITIES | E3 |
| 附录 C shell 元字符/Base64/Unicode 同形拒绝 | SHELL_METACHARS + scanParamValue + normalizeUnicode | E3/A4 |
| INV-U1 审计先行 fail-closed | auditPort.write 成功才下发 | F1 |
| INV-C4 聚合标志（挂起转审批） | escalation → suspended → resume | G1 |
| 事件协议（schemaVersion+eventId+深冻结） | JobStarted/Completed/Failed | H5/A1/F2 |

## 说明

- **批量作业**：`nodeEffects[]` 结构支持批量（NodeEffect 按节点记录状态），本里程碑测试聚焦单节点（用户确认决策）。
- **Outbox 同事务**（审批-执行原子）归 M5 编排层；本里程碑领域层以「事件版本号单调+重放幂等」预留接口。
- 资产/矩阵/白名单/角色真实仓储均以契约端口 + stub 落地（M5 接真实实现）。
- 参数 schema 规则（元字符集/路径白名单/Base64 特征）为目标值，实测校准归 M0-T/M5。

## 下一步（按计划）

- **M5 整合入口+审计**：Outbox 事务边界、五步权限判定点串联、审计五元组、真实被管机执行适配器。