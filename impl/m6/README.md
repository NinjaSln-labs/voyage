# M6 内测上线（DoD-A+B）交付说明

- 依据：`产品0-1计划.md` §4 M6 + `DoD 门禁.md` §2 Next + `impl/m6-方案评审.md`
- 交付：评测门禁（model BC）+ 四角色端到端走查 + 真实适配器契约定型
- 归属说明（DDD §1）：评测门禁归 **model BC**（C13/C17），非独立 gate BC——评测集版本=EvalSetVersion、门禁事件=ModelGated

## 交付物

| 文件 | 内容 |
|------|------|
| `src/model/domain.js` | model BC：GateService（门禁判定+ModelGated 发布）+ EvalSetVersion 实体（DDD §5）+ ModelGated 事件（DDD §3） |
| `test/model.test.js` | 门禁 + 评测集版本 + 门禁事件契约测试 H/E/G/A/F + V/M 类（21 例） |
| `test/e2e-journey.test.js` | 四角色×五旅程端到端走查（9 例） |
| `ADAPTER-CONTRACTS.md` | 六类真实适配器契约定型 |

## DoD-A+B 勾选

- [x] 评测门禁规则（三集基数 + 门禁判定硬线）
- [x] 评测集版本实体 EvalSetVersion（DDD §5：parts/sampleHashes/maintainers 双人）
- [x] 门禁结果事件 ModelGated（DDD §3：model→audit/metric）
- [x] 四角色经统一入口完成查询+知识+受限执行+审批+审计
- [x] 高危意图识别集召回 100% 硬线 + 反指标 >0 冻结
- [ ] 真实适配器（mTLS/WebAuthn/SSH/审计持久/模型API）—— ADAPTER-CONTRACTS.md 定型，实现归真实部署

## 不变量 → 实现 → 测试映射表

| 不变量 | 实现 | 测试 |
|--------|------|------|
| INV-M4 三集分别 100%（AND）+ 高危召回 100% 硬线 | GateService.evaluate（六集阈值） | H1/H2/E1/E3 |
| INV-M1 变更审计（门禁结果落事件） | GateService.gate → ModelGated | M1/M2/M3 |
| DDD §5 EvalSetVersion 实体（parts/sampleHashes/maintainers 双人） | EvalSetVersion 构造校验 | V1~V5 |
| DDD §3 ModelGated 事件（schemaVersion+eventId+深冻结） | ModelGated | M4 |
| 反指标 R1/R2/R3 >0 → 冻结 | GateService.evaluate counter | E2/G1 |
| DoD-B 四角色走查 | e2e-journey.test.js（J1~J9） | J1~J9 |
| DoD-B 高危审批双人 | J5/J6（SRE 审批/否决） | J5/J6 |

## 说明

- 评测集**样本**未建（口语/知识/高危/术语/解释/FAQ 各 ≥30~50 条）——归 M0-T 真实选型后三集制初建
- 真实适配器以端口契约定型，不实现——与 M4/M5「契约桩+真实接下一阶段」原则一致
- INV-M1 配置签名/权重哈希、INV-M4 回滚/漂移监控归适配器层（M0-T 选型后）

## 下一步

- 真实部署阶段：按 ADAPTER-CONTRACTS.md 替换条件逐一实现适配器 + 评测集样本初建 + 梯度放量