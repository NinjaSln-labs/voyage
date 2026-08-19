# M2 口语对话层（C1/C3/C4/C13）交付说明

- 依据：`产品0-1计划.md` §4 M2（口语问知识/查状态可用、术语翻译/结果解释）+ `DoD 门禁.md` Now + M0-D conv 限界上下文
- 交付：领域模型 + 契约测试，全部通过（52/52，经第 7~36 波严格审计）

## 交付物

| 文件 | 内容 |
|------|------|
| `src/conv/domain.js` | conv 领域模型：Intent/TermEntry/Session 聚合、IntentRecognitionService（服务端重分类+置信度降级）、TerminologyService（表为准+歧义确认）、4 领域事件 |
| `src/conv/obs-query.js` | conv → obs 查询适配器（读 C7，密级 fail-closed） |
| `test/conv.test.js` | 契约测试 13 例（happy×7/error×4/edge×2） |

## DoD-A（Now）勾选

- [x] 口语理解：服务端动词重分类 + 置信度 <0.8 降级确认/审批（H1/H3/H4）
- [x] 术语翻译：表为准 + 歧义确认 + 未审阅条目不生效（H5/E1/E2）
- [x] 多轮上下文：摘要压缩保留安全关键信息 + 需重预检（H6/G1）+ 会话切换作废（E3）
- [x] 查状态：obs 快照查询对接，密级 fail-closed（H7/G2）
- [x] 测试：node --test 全绿（49/49）

## 与 M0-D 设计对齐（不变量 → 测试）

| 不变量 | 实现/测试 |
|--------|----------|
| INV-C3 服务端重分类 + 置信度 <0.8 降级 | H1/H3/H4（查询伪装→执行类、低置信度需确认） |
| INV-K4 术语表受管 + 歧义确认 | H5/E1/E2（表为准、歧义待确认、pending 不生效） |
| INV-C1 会话归属 + 设备绑定 + 切换作废 | E3 |
| INV-C2 摘要安全保留 + 不新增授权 | H6/G1（needsRecheck 恒真） |
| INV-K2 密级 fail-closed | G2 |
| R8 不编造观测 | E4（found=false） |
| R10 表为准、模型仅辅助 | TerminologyService 设计 |

## 说明

- 意图识别的模型部分（intentModel 端口）为适配点：M0-T 选型后接真实模型 API / 本地模型；领域层不依赖具体模型（配置优于代码原则 #5）。
- C13 模型路由/评测门禁（model BC）属 M3/M0-T 范围，M2 仅使用 intentModel 端口占位。

## 下一步（按计划）

- **M3 信任模型**（C10/C11/C12）：四层准入、矩阵服务端强制、双人审批——conv 输出的意图将进 trust.evaluate（聚合判定），M2 的 IntentRecognized/IntentReclassified 事件为其输入。
