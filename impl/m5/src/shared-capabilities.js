// 能力/命令模板单源共享常量（审计修复 P1-3：消除多源漂移）
// 单源原则：能力清单与模板映射唯一定义于此；M3 trust / M4 exec / model-api / repo-identity / exec-adapter 一律引用本模块
// 对齐：附录 C 白名单 + M3 WHITELIST_CAPABILITIES / QUERY_CAPABILITIES + M4 TEMPLATE_BY_CAPABILITY
// 注：M3/M4 领域模块的既有常量保持不动（历史测试锚定）；本模块为**新增消费方**（m5 适配器层）的单源，
//     领域层与适配器层通过本模块对齐——新增能力时改这里 + M3/M4 各一处（领域层常量引用本模块属后续重构，不在本次审计范围）

'use strict';

/** 查询类能力（只读面，C1~C7） */
const QUERY_CAPABILITIES = Object.freeze(['query_status', 'query_health', 'query_metric', 'query_log']);

/** 执行白名单能力（附录 C，INV-E3）——与 M3/M4 同值 */
const EXEC_CAPABILITIES = Object.freeze(['restart', 'clean', 'scale', 'config_change', 'env_switch']);

/** 数据外传能力（egress，非标准执行能力——用于 egress 类意图审批）
 *  cred_lend=凭据借出（ADR-007 一等能力）：信任边界内资产转移，与外传同走双人审批轴、
 *  不走 §4.2 角色矩阵（ADR-005 同边界）；审批凭证能力，无系统内作业执行（与 egress_send 同语义）。 */
const EGRESS_CAPABILITIES = Object.freeze(['egress_send', 'egress_download', 'egress_mail', 'cred_lend']);

/** 范围维度取值（ADR-006：能力×角色×范围；§4.2 范围限定词的单源）
 *  full=无收窄；aggregate=大盘（禁明细）；owned=自己负责的服务；related=相关服务只读；self=仅本人记录 */
const SCOPES = Object.freeze(['full', 'aggregate', 'owned', 'related', 'self']);

/** 能力风险等级映射（ADR-002：安全决策由能力定义决定，不依赖模型输出）
 *  low: 自动放行（read 类查询）
 *  high: 双人审批（write 类变更 + egress 类外传 + cred_lend 凭据借出）
 *  critical: 直接拒绝（暂未定义）
 */
const RISK_LEVEL = Object.freeze({
  query_status: 'low', query_health: 'low', query_metric: 'low', query_log: 'low',
  restart: 'high', clean: 'high', scale: 'high', config_change: 'high', env_switch: 'high',
  egress_send: 'high', egress_download: 'high', egress_mail: 'high', cred_lend: 'high',
});

/** 全部能力（查询 + 执行 + egress；modelApiPort 白名单判定用） */
const CAPABILITIES = Object.freeze([...QUERY_CAPABILITIES, ...EXEC_CAPABILITIES, ...EGRESS_CAPABILITIES]);

/** 角色扩展能力（非模型可输出；单源在 repo-identity.js 的 ROLE_CAPABILITIES，此处仅登记全集供映射表校验）
 *  p000042 口径：角色扩展能力**模型触发通道不可达**（不进 CAPABILITIES 模型能力码表），审计记录查询等属人工/UI 通道。 */
const ROLE_EXTENSION_CAPABILITIES = Object.freeze(['approve', 'audit_query', 'audit_summary', 'schedule']);

/** §4.2 矩阵行 ↔ 能力码映射（ADR-004 单源；键为 §4.2 行标签原文，值为能力码数组，空数组=该行不对应模型可匹配能力码）
 *  背景：§4.2 是产品功能粒度，能力码是模型可匹配 + 服务端判定粒度，二者非 1:1（如行1 捆绑 query_metric + query_status）。
 *  关键口径（ADR-004）：query_status = 资产/服务/部署状态「明细」，管理者 ❌；管理者「大盘」= query_metric + query_health。
 *  变更本表视同矩阵变更，走评测门禁 + 审计（RQ-631）。 */
const MATRIX_ROW_CAPABILITIES = Object.freeze({
  '监控指标 / 服务状态查询': Object.freeze(['query_metric', 'query_status']),
  '日志查看': Object.freeze(['query_log']),
  '知识问答（RAG）': Object.freeze([]),
  '告警 / 健康报告查看': Object.freeze(['query_health']),
  '部署状态查看': Object.freeze(['query_status']),
  '重启自己负责的服务': Object.freeze(['restart']),
  '清理日志': Object.freeze(['clean']),
  '定时任务编排': Object.freeze(['schedule']),
  '扩容缩容': Object.freeze(['scale']),
  '配置变更': Object.freeze(['config_change']),
  '环境切换': Object.freeze(['env_switch']),
  '系统级操作 / 内核调优': Object.freeze([]),
  '批量变更 / 任意命令': Object.freeze([]),
  'Web 在线终端（SSH）': Object.freeze([]),
  '高危审批：发起': Object.freeze([]),
  '高危审批：批准': Object.freeze(['approve']),
  '审计记录查询': Object.freeze(['audit_query', 'audit_summary']),
  '界面风格': Object.freeze([]),
});

/** capability → 命令模板（M4 TEMPLATE_BY_CAPABILITY 同值；runJob/SSH 适配器共用） */
const CAPABILITY_TO_COMMAND = Object.freeze({
  restart: 'restart_service',
  clean: 'clean_logs',
  scale: 'scale_replicas',
  config_change: 'change_config',
  env_switch: 'switch_env',
});

/** 命令模板 → 远端命令前缀（exec-adapter 远端白名单脚本与 JS 侧共用——消除 JS/Python 双源） */
const TEMPLATE_COMMANDS = Object.freeze({
  restart_service: ['systemctl', 'restart'],
  clean_logs: ['find'],                         // 只读列出（真实删除语义由远端脚本增强，见 HANDOFF 待办）
  scale_replicas: ['docker', 'compose', 'scale'],
  change_config: ['sed', '-i'],
  switch_env: ['docker', 'compose', 'up', '-d'],
});

/** 原型链保留键拒绝单源（质量基调第 12 波；审计修复 R6：4 处定义成员不一致——m5 消费方统一引用此处；
 *  M3/M4 领域层既有副本不动（历史测试锚定），但成员集与本单源一致） */
const RESERVED_PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf']);

// ---------- 结构不变量（p000043：CAPABILITIES 与 RISK_LEVEL 必须逐一对应）----------
// 新增/删除能力时漏改另一处 → require 本模块即 fail-fast（防多源漂移，消除结构耦合）
for (const c of CAPABILITIES) {
  if (!RISK_LEVEL[c]) throw new Error(`shared-capabilities: 能力 ${c} 未在 RISK_LEVEL 登记`);
}
for (const c of Object.keys(RISK_LEVEL)) {
  if (!CAPABILITIES.includes(c)) throw new Error(`shared-capabilities: RISK_LEVEL 含未登记能力 ${c}`);
}

module.exports = { QUERY_CAPABILITIES, EXEC_CAPABILITIES, EGRESS_CAPABILITIES, SCOPES, CAPABILITIES, ROLE_EXTENSION_CAPABILITIES, MATRIX_ROW_CAPABILITIES, CAPABILITY_TO_COMMAND, TEMPLATE_COMMANDS, RESERVED_PROTO_KEYS, RISK_LEVEL };
