# M1 观测底座（C7）交付说明

- 依据：`产品0-1计划.md` §4 M1（观测底座：纳管资产可观测、可查询）+ `DoD 门禁.md` Now（监控+知识库接入、审计留痕可查）+ M0-D 设计 obs 限界上下文
- 交付：领域模型 + 契约测试，全部通过

## 交付物

| 文件 | 内容 |
|------|------|
| `src/obs/domain.js` | obs 领域模型：AssetRef/MetricSample/LogEntry 值对象、AssetObservation 聚合、MetricRecorded/LogRecorded/HealthChanged 事件、AssetObservationRepository 仓储接口 |
| `src/obs/repo-memory.js` | 仓储内存适配器（契约测试用，幂等+防乱序） |
| `test/obs.test.js` | 契约测试 31 例（happy×4/error×3/edge×4 + 严格审计 S1~S20×20） |

## DoD-A（Now）勾选

- [x] 监控接入：指标采集（cpu/disk 等）+ 健康评估（真实观测推导）
- [x] 知识库接入：本里程碑不涉及（C5 属 M2）
- [x] 普通用户查状态：快照/密级过滤视图可查（G1/G2）
- [x] 审计留痕可查：obs 事件（MetricRecorded/LogRecorded/HealthChanged）发布，供 audit 订阅（契约预留）
- [x] 测试：node --test 全绿（33/33，经第 7~36 波严格审计）

## 与 M0-D 设计对齐（不变量 → 测试）

| 不变量 | 实现/测试 |
|--------|----------|
| INV-O1 真实观测 | H2（健康由观测推导）/E2（NaN 拒绝） |
| INV-O1 数据非指令 | H3（日志硬标记 isDataNotInstruction） |
| INV-AS2 只持 ID 快照 | G4（快照无执行面） |
| INV-K1/M3 密级 fail-closed | G1/G2（缺省最高密级、低权限 denied） |
| INV-AS3 版本防乱序/幂等 | E3/H4（版本校验、幂等返回） |
| INV-O1 告警阈值可配置 | G3（阈值注入） |

## 下一步（按计划）

- M2 口语对话层（C1/C3/C4/C13，读 C5/C7）：obs 事件流 + 快照查询为输入
- 生产适配器（真实监控源）：按 `m0-t/选型与POC框架.md` 契约测试回归原则替换内存适配器
