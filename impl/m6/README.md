# M6 内测上线（DoD-A+B）交付说明

- 依据：`产品0-1计划.md` §4 M6 + `DoD 门禁.md` §2 Next + `impl/m6-方案评审.md`
- 交付：评测门禁规则引擎 + 四角色端到端走查 + 真实适配器契约定型

## 交付物

| 文件 | 内容 |
|------|------|
| `src/gate/domain.js` | 评测门禁：GateService（三集基数 + 门禁判定 + 高危硬线 100%） |
| `test/gate.test.js` | 门禁规则契约测试 H/E/G/A/F（12 例） |
| `test/e2e-journey.test.js` | 四角色×五旅程端到端走查（9 例） |
| `ADAPTER-CONTRACTS.md` | 六类真实适配器契约定型 |

## DoD-A+B 勾选

- [x] 评测门禁规则（三集基数 + 门禁判定硬线）
- [x] 四角色经统一入口完成查询+知识+受限执行+审批+审计
- [x] 高危意图识别集召回 100% 硬线
- [x] 反指标判定（R1/R2/R3 >0 → 冻结）
- [ ] 真实适配器（mTLS/WebAuthn/SSH/审计持久/模型API）—— ADAPTER-CONTRACTS.md 定型，实现归真实部署

## 不变量 → 实现 → 测试映射表

| 不变量 | 实现 | 测试 |
|--------|------|------|
| INV-M5 月度评测门禁 | GateService.evaluate（六集阈值） | H1/H2/E1/E3 |
| 高危集召回 100% 硬线 | DEFAULT_THRESHOLDS.high_risk.recall=1.0 | E1 |
| 反指标 R1/R2/R3 >0 → 冻结 | GateService.evaluate counter | E2/G1 |
| DoD-B 四角色走查 | e2e-journey.test.js（J1~J9） | J1~J9 |
| DoD-B 高危审批双人 | J5/J6（SRE 审批/否决） | J5/J6 |

## 说明

- 评测集**样本**未建（口语/知识/高危/术语/解释/FAQ 各 ≥30~50 条）——归 M0-T 真实选型后三集制初建
- 真实适配器以端口契约定型，不实现——与 M4/M5「契约桩+真实接下一阶段」原则一致

## 下一步

- 真实部署阶段：按 ADAPTER-CONTRACTS.md 替换条件逐一实现适配器 + 评测集样本初建 + 梯度放量