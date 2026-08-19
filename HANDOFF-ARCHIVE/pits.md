# HANDOFF 归档 · pits.md（已确认修复的坑）

> 正文 HANDOFF.md §4「已知坑」一旦确认修复即迁入本文件，改造成「编码铁律/经验」供参考，不再占用正文待处理坑位。
> 详情以 commit message 为权威（`git log`）；此处一行式摘要。

## Date 引用共享（第 90 波修复）

- 坑：`setTime()` 可篡改 Date 内部状态——深冻结只冻属性不冻 Date 内部态。
- 已修：所有领域 getter 一律 `new Date(x.getTime())` 拷贝返回。
- 影响新代码：M4 及后续新增 getter 必须拷贝（当前 M4 已遵此标准）。

## 语义判定多视图不一致（修复并固化）

- 坑：原始串 vs 归一化串双视图不一致 = 绕过面。
- 已修：疑问/否定/动词统一在归一化视图判定（M2 S32）。
- 影响新代码：新增语义判定一律先归一化（M4 参数校验已复用 normalizeUnicode + 统一视图扫描）。

## 事件协议跨 BC 私有协议（修复并固化）

- 坑：各 BC 私有事件协议 → 无法跨 BC 去重/演进。
- 已修：统一 schemaVersion=1 + eventId 幂等键 + 深冻结载荷（M1~M4 全对齐）。
- 影响新代码：新增 BC 事件必须对齐，不得私有协议。

## 构造参数静默隐式转换（修复并固化）

- 坑：字符串隐式转 Date / 0/负/NaN 数值 → 静默错误源。
- 已修：时间/数值/ID 一律「正有限 + 显式类型 + 长度上限」校验（M3 第 11 波）。
- 影响新代码：M4 及后续构造器同标准。

## 白名单外能力自动 Grant（修复）

- 坑：rm_rf_root/shell_exec_any 等任意命令被自动签发许可。
- 已修：WHITELIST∩QUERY 强制，非白名单 REJECTED + CapabilityDenied（M3 第 9 波 / M4 E1）。

## AggregationWindow 非高危能力升级崩溃（修复）

- 坑：非白名单能力达阈值升级时 highRiskType 用该能力 → 构造崩溃。
- 已修：非高危能力升级 highRiskType 归一化 'escalated'（M3 S18）。