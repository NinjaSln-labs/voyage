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

/** 全部能力（查询 + 执行；modelApiPort 白名单判定用） */
const CAPABILITIES = Object.freeze([...QUERY_CAPABILITIES, ...EXEC_CAPABILITIES]);

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

module.exports = { QUERY_CAPABILITIES, EXEC_CAPABILITIES, CAPABILITIES, CAPABILITY_TO_COMMAND, TEMPLATE_COMMANDS };
