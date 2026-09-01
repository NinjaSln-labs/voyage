# ADR-002 C+D 方案实施计划

> **For agentic workers:** 实施前请加载 `writing-plans` 技能。

**Goal:** 从 ADR-001 的 egress 布尔字段方案迁移到 ADR-002 的 C+D 方案——模型只输出 actionClass+capability，安全决策由能力定义的风险等级决定。

**Architecture:** 三层拆分——① 基础层（能力扩展 + 风险等级定义），② 模型层（分类提示词改为 actionClass，去掉 egress 布尔），③ 编排层（按 actionClass 分流，去掉 egress 特判）。每层改动独立测试验证。

**Tech Stack:** Node.js 24, node:test, 零依赖

**前置条件：** DDD 文档已 100% 终审通过（d14c969），ADR-002 已接受。

---

## 文件结构总览

| 文件 | 改动类型 | 职责 |
|------|---------|------|
| `impl/m5/src/shared-capabilities.js` | 修改 | 加 egress 能力 + 风险等级映射 |
| `impl/m5/src/model/agens-adapter.js` | 修改 | 提示词改为 actionClass，加 egress 能力 |
| `impl/m5/src/model/cohere-adapter.js` | 修改 | 同上 |
| `impl/m5/src/model/model-api.js` | 修改 | 解析 actionClass，去掉 egress 字段 |
| `impl/m5/src/compose.js` | 修改 | toConvResult 去掉 egress，适配 actionClass |
| `impl/m5/src/integration/domain.js` | 修改 | 按 actionClass 分流，去掉 egress 特判 |
| `impl/m5/src/server/http-ingress.js` | 修改 | 去掉 egress grant 特判 |
| `impl/m3/src/trust/domain.js` | 修改 | HIGH_RISK 加 egress 类能力 |
| `impl/m5/test/egress.test.js` | 修改 | 适配新架构 |
| `impl/审计记录-DDD重构-ADR-002.md` | 修改 | 记录代码实现状态 |

---

### Task 1: 基础层 — shared-capabilities 扩展

**Files:**
- Modify: `impl/m5/src/shared-capabilities.js`

**Interfaces:**
- Produces: `EGRESS_CAPABILITIES`（已有，扩展为具体能力）、`RISK_LEVEL`（新增，能力→风险等级映射）

- [ ] **Step 1: 读当前文件确认精确内容**

```bash
cd /home/shadow/ninjasin-labs/Voyage && cat impl/m5/src/shared-capabilities.js
```

- [ ] **Step 2: 扩展 EGRESS_CAPABILITIES + 新增 RISK_LEVEL 映射**

```js
/** 数据外传能力（egress，非标准执行能力——用于 egress 类意图审批） */
const EGRESS_CAPABILITIES = Object.freeze(['egress_send', 'egress_download', 'egress_mail']);

/** 能力风险等级映射（ADR-002：安全决策由能力定义决定，不依赖模型输出）
 *  low: 自动放行（read 类查询）
 *  high: 双人审批（write 类变更 + egress 类外传）
 *  critical: 直接拒绝（暂未定义）
 */
const RISK_LEVEL = Object.freeze({
  query_status: 'low', query_health: 'low', query_metric: 'low', query_log: 'low',
  restart: 'high', clean: 'high', scale: 'high', config_change: 'high', env_switch: 'high',
  egress_send: 'high', egress_download: 'high', egress_mail: 'high',
});
```

- [ ] **Step 3: 更新 CAPABILITIES 和导出**

```js
const CAPABILITIES = Object.freeze([...QUERY_CAPABILITIES, ...EXEC_CAPABILITIES, ...EGRESS_CAPABILITIES]);

module.exports = { QUERY_CAPABILITIES, EXEC_CAPABILITIES, EGRESS_CAPABILITIES, CAPABILITIES, CAPABILITY_TO_COMMAND, TEMPLATE_COMMANDS, RESERVED_PROTO_KEYS, RISK_LEVEL };
```

- [ ] **Step 4: 运行测试确认不破坏现有能力清单测试**

```bash
cd /home/shadow/ninjasin-labs/Voyage && node --test impl/m5/test/shared-capabilities.test.js
```

Expected: 2 tests pass.

- [ ] **Step 5: 提交**

```bash
git add impl/m5/src/shared-capabilities.js
git commit -m "feat(shared): 扩展 egress 能力 + RISK_LEVEL 风险等级映射"
```

---

### Task 2: 分类提示词 — 模型供应商B/模型供应商A adapter 改为 actionClass

**Files:**
- Modify: `impl/m5/src/model/agens-adapter.js`
- Modify: `impl/m5/src/model/cohere-adapter.js`

**Interfaces:**
- Consumes: shared-capabilities 的 EGRESS_CAPABILITIES（概念对齐，提示词内写能力列表）
- Produces: 模型输出 JSON 格式从 `{intentType, egress, capability, ...}` 改为 `{actionClass, capability, ...}`

- [ ] **Step 1: 读当前文件确认精确内容**

```bash
cat impl/m5/src/model/agens-adapter.js | head -26
cat impl/m5/src/model/cohere-adapter.js | head -23
```

- [ ] **Step 2: 修改 agens-adapter.js 提示词**

替换 `const SYSTEM_PROMPT = [...]` 块：

```js
const SYSTEM_PROMPT = [
  '你是运维意图识别器。将用户的中文运维口语意图分类并抽取执行参数。',
  '动作分类（actionClass）：',
  '- read：查询/查看/了解/确认类（无系统内副作用）。',
  '- write：执行/重启/清理/扩容/变更/切换类（有系统内副作用）。',
  '- egress：数据外传——把服务器数据（文件内容/日志/配置/凭据）发送/外传/导出/下载到信任边界之外（微信/邮件/网盘/外部系统）。',
  '- authorize：授权/管理类操作（预留，当前不应输出）。',
  '能力（capability）：query_status, query_health, query_metric, query_log, restart, clean, scale, config_change, env_switch, egress_send, egress_download, egress_mail',
  'egress 示例：',
  '- "把日志发到我微信上" → {"actionClass":"egress","capability":"egress_send"}',
  '- "看下 jd-light 状态" → {"actionClass":"read","capability":"query_status"}',
  '- "重启服务器" → {"actionClass":"write","capability":"restart"}',
  '参数抽取规则（仅从用户原话抽取，禁止编造）：',
  '- 用户提到具体服务名/进程名/资产ID → params.service，且 subject 必须填同一名称',
  '- 用户提到日志路径 → params.path',
  '- 用户提到副本数 → params.replicas',
  '- 未提到的参数不要输出。',
  '只输出一个 JSON 对象，格式：',
  '{"actionClass": "read|write|egress|authorize", "capability": "query_status|query_health|query_metric|query_log|restart|clean|scale|config_change|env_switch|egress_send|egress_download|egress_mail", "confidence": 0.0-1.0, "subject": "执行目标资产ID（确实无目标时才为null）", "params": {"service|path|replicas": "从原话抽取"}}',
  '不要输出其他文字。',
].join('\n');
```

- [ ] **Step 3: 修改 cohere-adapter.js 提示词**

替换 `const SYSTEM_PROMPT = [...]` 块：

```js
const SYSTEM_PROMPT = [
  '你是运维意图识别器。将用户的中文运维口语意图分类。',
  '动作分类（actionClass）：',
  '- read：查询/查看/了解/确认类（无系统内副作用）。',
  '- write：执行/重启/清理/扩容/变更/切换类（有系统内副作用）。',
  '- egress：数据外传——把服务器数据发送/外传/导出到信任边界之外。',
  '能力（capability）：query_status, query_health, query_metric, query_log, restart, clean, scale, config_change, env_switch, egress_send, egress_download, egress_mail',
  '只输出一个 JSON 对象，格式：',
  '{"actionClass": "read|write|egress", "capability": "query_status|query_health|query_metric|query_log|restart|clean|scale|config_change|env_switch|egress_send|egress_download|egress_mail", "confidence": 0.0-1.0, "subject": "目标资产ID或null"}',
  '不要输出其他文字。',
].join('\n');
```

- [ ] **Step 4: 运行模型适配器测试**

```bash
cd /home/shadow/ninjasin-labs/Voyage && node --test impl/m5/test/agens-adapter.test.js impl/m5/test/model-api.test.js
```

Expected: 所有测试通过（提示词改动不影响单元测试，因测试用 mock 不连真实 LLM）。

- [ ] **Step 5: 提交**

```bash
git add impl/m5/src/model/agens-adapter.js impl/m5/src/model/cohere-adapter.js
git commit -m "feat(model): 分类提示词改为 actionClass，加 egress 能力"
```

---

### Task 3: model-api — actionClass 解析 + 去掉 egress 字段

**Files:**
- Modify: `impl/m5/src/model/model-api.js`

**Interfaces:**
- Consumes: 模型 JSON 输出 `{actionClass, capability, ...}`
- Produces: 结构化 `{actionClass, capability, confidence, ...}`（去掉 egress 字段）

- [ ] **Step 1: 读当前文件确认关键行号**

```bash
cat -n impl/m5/src/model/model-api.js | head -20
```

- [ ] **Step 2: 修改常量定义**

把 `INTENT_TYPES` 改为 `ACTION_CLASSES`，保留 `INTENT_TYPES` 为向后兼容过渡：

```js
const ACTION_CLASSES = Object.freeze(['read', 'write', 'egress', 'authorize']);
const INTENT_TYPES = Object.freeze(['query', 'execute']); // 保留过渡，后续移除
```

- [ ] **Step 3: 修改 `_parseStructured` 的解析逻辑**

替换 `_parseStructured` 函数中字段值校验部分：

```js
// 结构校验（fail-closed：actionClass/capability 缺失或非法 → 拒绝）
if (!ACTION_CLASSES.includes(obj.actionClass)) {
  // 向后兼容：若模型输出旧的 intentType，映射到 actionClass
  if (obj.intentType === 'query') obj.actionClass = 'read';
  else if (obj.intentType === 'execute') obj.actionClass = 'write';
  else return { ok: false, reason: 'invalid_action_class' };
}
if (obj.actionClass === 'write' && !CAPABILITIES.includes(obj.capability)) {
  return { ok: false, reason: 'invalid_capability' };
}
if (obj.actionClass === 'egress' && !EGRESS_CAPABILITIES.includes(obj.capability)) {
  return { ok: false, reason: 'invalid_capability' };
}
const confidence = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence) ? obj.confidence : 0;
const subject = typeof obj.subject === 'string' ? obj.subject : null;
return { ok: true, value: { actionClass: obj.actionClass, intentType: obj.actionClass === 'read' ? 'query' : 'execute', capability: obj.capability || null, confidence, subject, params: obj.params && typeof obj.params === 'object' ? obj.params : null } };
```

注意：`value` 中保留 `intentType` 的映射是为了让下游（integration/domain.js）先过渡，避免一次改全链。

- [ ] **Step 4: 更新 `_finalize` 中降级返回的默认值**

```js
// 降级路径：actionClass 默认为 'read'（原 intentType 默认为 'query'）
return { ok: false, reason: parsed.reason, degraded: true, actionClass: 'read', intentType: 'query', confidence: DEFAULT_CONFIDENCE_FLOOR };
```

- [ ] **Step 5: 运行测试**

```bash
cd /home/shadow/ninjasin-labs/Voyage && node --test impl/m5/test/model-api.test.js
```

Expected: 所有测试通过（注意需要更新 `model-api.test.js` 中 mock 输出格式，如果测试直接使用 `intentType` 字段，需要在 Task 8 统一更新）。

- [ ] **Step 6: 提交**

```bash
git add impl/m5/src/model/model-api.js
git commit -m "feat(model-api): 解析 actionClass，向后兼容 intentType，去掉 egress 字段"
```

---

### Task 4: compose.js — toConvResult 去掉 egress + 适配 actionClass

**Files:**
- Modify: `impl/m5/src/compose.js`

**Interfaces:**
- Consumes: `model-api` 输出的 `{actionClass, intentType, capability, ...}`
- Produces: `{actionClass, intentType, capability, ...}`（去掉 egress 字段）

- [ ] **Step 1: 读当前文件确认关键行号**

```bash
grep -n "egress\|intentType" impl/m5/src/compose.js
```

- [ ] **Step 2: 修改 `toConvResult` 方法**

两处修改：

1. 降级返回（line 236）：
```js
// 旧: return { intentType: 'query', ..., egress: false };
// 新:
return { actionClass: 'read', intentType: 'query', capability: 'query_status', confidence: 0, intentId: id, subject: null, degraded: true };
```

2. 正常返回（line 252）：
```js
// 旧: return { intentType: r.intentType, ..., egress: r.egress === true };
// 新:
return { actionClass: r.actionClass || (r.intentType === 'query' ? 'read' : 'write'), intentType: r.intentType || (r.actionClass === 'read' ? 'query' : 'execute'), capability: r.capability || 'query_status', confidence: r.confidence, intentId: id, subject, params };
```

- [ ] **Step 3: 验证修改**

```bash
cd /home/shadow/ninjasin-labs/Voyage && node --test impl/m5/test/compose.test.js
```

Expected: 全部测试通过。

- [ ] **Step 4: 提交**

```bash
git add impl/m5/src/compose.js
git commit -m "feat(compose): toConvResult 去掉 egress，适配 actionClass"
```

---

### Task 5: trust — HIGH_RISK 加 egress 类能力

**Files:**
- Modify: `impl/m3/src/trust/domain.js`

**Interfaces:**
- Consumes: `egress_send/egress_download/egress_mail` 作为高危能力
- Produces: 这些能力走审批流

- [ ] **Step 1: 确认当前 HIGH_RISK_CAPABILITIES**

```bash
grep "HIGH_RISK_CAPABILITIES" impl/m3/src/trust/domain.js
```

- [ ] **Step 2: 修改 `HIGH_RISK_CAPABILITIES`**

```js
const HIGH_RISK_CAPABILITIES = Object.freeze(['restart', 'clean', 'delete', 'scale', 'config_change', 'env_switch', 'escalated', 'egress', 'egress_send', 'egress_download', 'egress_mail']);
```

- [ ] **Step 3: 运行测试**

```bash
cd /home/shadow/ninjasin-labs/Voyage && node --test impl/m3/test/trust.test.js
```

- [ ] **Step 4: 提交**

```bash
git add impl/m3/src/trust/domain.js
git commit -m "feat(trust): HIGH_RISK 加 egress_send/egress_download/egress_mail"
```

---

### Task 6: integration — 按 actionClass 分流，去掉 egress 特判

**Files:**
- Modify: `impl/m5/src/integration/domain.js`

**Interfaces:**
- Consumes: 编排层输入中的 `actionClass` 和 `intentType`（过渡期）
- Produces: 按 actionClass 分流——read→自动放行，write/egress→信任预检

- [ ] **Step 1: 读当前文件确认关键行号**

```bash
grep -n "intentType\|egress" impl/m5/src/integration/domain.js
```

- [ ] **Step 2: 修改 handle 方法中的 query 分支（line 92-97）**

替换 egress 特判和 query 分支：

```js
// 查询类（actionClass === 'read'，或向后兼容的 intentType === 'query'）
if (intentType === 'query' || interp.actionClass === 'read') {
  // 数据外传检测（ADR-002）：egress 类能力走信任审批，不在 query 分支特判
  if (interp.actionClass === 'egress') {
    // 走信任预检，复用 execute 审批路径
    // 向下走到 trust 处理
  } else {
    const a = this._auditInteract(actorId, from, now, { intent: 'query', capability: capability || 'query', target: subject, paramsSchemaOk: true }, 'success', {});
    if (!a.ok) return { status: 'ERROR', reason: 'audit_failed' };
    return { status: 'OK', kind: 'query', needApproval: false, intentType, intentId, degraded: interp.degraded === true };
  }
}
```

实际上，更简洁的做法是把 egress 的检查放到 execute 路径前，而不是在 query 分支特判。因为 egress 类意图本身就是 `actionClass === 'egress'`，应该走信任预检。

让我重新设计 handle 的分流逻辑：

```js
// 1. 查询类（read/query）→ 自动放行
if (intentType === 'query' || interp.actionClass === 'read') {
  const a = this._auditInteract(actorId, from, now, { intent: 'query', capability: capability || 'query', target: subject, paramsSchemaOk: true }, 'success', {});
  if (!a.ok) return { status: 'ERROR', reason: 'audit_failed' };
  return { status: 'OK', kind: 'query', needApproval: false, intentType, intentId, degraded: interp.degraded === true };
}

// 2. 执行类（write/egress/execute）→ 信任预检
if (intentType !== 'execute' && interp.actionClass !== 'write' && interp.actionClass !== 'egress') {
  return { status: 'REJECTED', reason: 'non_execute_intent', needApproval: false, intentId };
}
```

- [ ] **Step 3: 修改 resolveApproval 中的 egress 特判**

去掉 line 171-174 的 egress grant 检查：

```js
// 旧：
if (res.grant.commandTemplate === 'egress') {
  return { status: 'approved', grant: res.grant, approval, deferred: false };
}

// 新：去掉，egress 类能力正常走执行路径（但 egress 类不建作业，在 http-ingress 处理）
// 实际上 egress 类能力被执行时，compose 的 runJob 会检查 capability 是否在 CAPABILITY_TO_COMMAND 中，
// 不在则不执行。但 egress 类能力不应走到 runJob，应当被 resolve 后的路径拦截。
// 更安全的做法：保留 egress 特判，但改为检查 capability 是否以 egress_ 开头
```

实际上，egress 类能力（egress_send/egress_download/egress_mail）不在 CAPABILITY_TO_COMMAND 中，所以如果走到 runJob 会报 "unsupported_template"。但更好的做法是不要在 resolveApproval 里做这个判断，因为 resolveApproval 应该只关心"批准了没"，不关心"批准后做什么"。

让 http-ingress 来跳过 runJob 更合理（因为 http-ingress 知道上下文）。

所以保留 resolveApproval 的 egress 特判，但改为检查 capability 前缀：

```js
if (res.grant && res.grant.commandTemplate && (res.grant.commandTemplate === 'egress' || res.grant.commandTemplate.startsWith('egress_'))) {
  return { status: 'approved', grant: res.grant, approval, deferred: false };
}
```

- [ ] **Step 4: 运行测试**

```bash
cd /home/shadow/ninjasin-labs/Voyage && node --test impl/m5/test/integration.test.js impl/m5/test/egress.test.js
```

- [ ] **Step 5: 提交**

```bash
git add impl/m5/src/integration/domain.js
git commit -m "feat(integration): 按 actionClass 分流，egress 走信任预检"
```

---

### Task 7: http-ingress — 去掉 egress grant 特判

**Files:**
- Modify: `impl/m5/src/server/http-ingress.js`

- [ ] **Step 1: 读当前文件确认 egress 相关代码**

```bash
grep -n "egress" impl/m5/src/server/http-ingress.js
```

- [ ] **Step 2: 修改 handleResolve 中的 egress grant 特判（line 174-183）**

```js
// 旧：
if (r.grant.commandTemplate === 'egress') {
  out.egressGranted = true;
} else {
  const jobId = `job-${r.grant.jobRef || r.grant.id}`;
  // ...
}

// 新：
if (r.grant.commandTemplate && (r.grant.commandTemplate === 'egress' || r.grant.commandTemplate.startsWith('egress_'))) {
  out.egressGranted = true;
} else {
  const jobId = `job-${r.grant.jobRef || r.grant.id}`;
  // ...
}
```

- [ ] **Step 3: 运行测试**

```bash
cd /home/shadow/ninjasin-labs/Voyage && node --test impl/m5/test/http-ingress.test.js
```

- [ ] **Step 4: 提交**

```bash
git add impl/m5/src/server/http-ingress.js
git commit -m "feat(http-ingress): egress grant 特判适配 egress_ 类能力"
```

---

### Task 8: 测试适配

**Files:**
- Modify: `impl/m5/test/egress.test.js`
- Modify: `impl/m5/test/model-api.test.js`（如有必要）
- Modify: `impl/m5/test/compose.test.js`（如有必要）

- [ ] **Step 1: 更新 egress.test.js**

改为测试 actionClass 路由而非 egress 布尔字段：

```js
// E1: actionClass=egress → 走信任审批（NEED_REVIEW）
// E2: actionClass=read → 正常查询放行
// E3: egress 审批通过后不建作业
// E4: egress 审批被拒绝
// E5: 正常 write 类不受影响

// 关键修改：convStub 输出改为 { actionClass: 'egress', capability: 'egress_send', ... }
// 而非 { egress: true, ... }
```

- [ ] **Step 2: 运行 egress 测试**

```bash
cd /home/shadow/ninjasin-labs/Voyage && node --test impl/m5/test/egress.test.js
```

Expected: 5 tests pass.

- [ ] **Step 3: 全量测试**

```bash
cd /home/shadow/ninjasin-labs/Voyage && find impl -name "*.test.js" -exec sh -c 'cd "$(dirname "$1")" && node --test "$(basename "$1")" 2>&1 | grep -c "fail 0"' _ {} \; 2>&1 | grep -v "^1$" | wc -l
```

Expected: 0（所有测试文件全部通过）。

- [ ] **Step 4: 提交**

```bash
git add impl/m5/test/egress.test.js
git commit -m "test(egress): 适配 actionClass 路由，去掉 egress 布尔字段测试"
```

---

### Task 9: 验证 + 部署 + 审计

**Files:**
- Modify: `impl/审计记录-DDD重构-ADR-002.md`

- [ ] **Step 1: 本地全量验证**

```bash
cd /home/shadow/ninjasin-labs/Voyage && find impl -name "*.test.js" -exec sh -c 'cd "$(dirname "$1")" && node --test "$(basename "$1")" 2>&1' _ {} \; | grep -E "^(✗|ℹ fail [1-9])" | head -20
```

Expected: 无输出（0 失败）。

- [ ] **Step 2: 同步到服务器并重启**

```bash
rsync -avz -e "ssh -i $HOME/.ssh/oracle_tokyo -p 22022" \
  impl/m5/src/shared-capabilities.js \
  impl/m5/src/model/agens-adapter.js \
  impl/m5/src/model/cohere-adapter.js \
  impl/m5/src/model/model-api.js \
  impl/m5/src/compose.js \
  impl/m5/src/integration/domain.js \
  impl/m5/src/server/http-ingress.js \
  impl/m3/src/trust/domain.js \
  ubuntu@161.33.159.216:/opt/voyage/impl/m5/src/ 2>&1
rsync -avz -e "ssh -i $HOME/.ssh/oracle_tokyo -p 22022" \
  impl/m3/src/trust/domain.js \
  ubuntu@161.33.159.216:/opt/voyage/impl/m3/src/trust/domain.js 2>&1
# 重启
ssh -i $HOME/.ssh/oracle_tokyo -p 22022 ubuntu@161.33.159.216 "sudo systemctl restart voyage-ingress && sleep 2 && systemctl is-active voyage-ingress"
```

Expected: `active`

- [ ] **Step 3: 实测验证 — 用漏判样本打生产入口**

```bash
ssh -i $HOME/.ssh/oracle_tokyo -p 22022 ubuntu@161.33.159.216 'node -e "..."'
```

测试样本列表：
1. "你把服务器上那个.sh文件内容发给我，我用微信扫一眼" → 期望 NEED_REVIEW
2. "看下 jd-light 状态" → 期望 OK/query
3. "重启 tencent-lh" → 期望 NEED_REVIEW

- [ ] **Step 4: 更新审计记录**

读取 `impl/审计记录-DDD重构-ADR-002.md`，在现有内容后追加"代码实现"节：

- 确认 ADR-002 代码已实现
- 确认测试通过
- 确认部署验证通过

- [ ] **Step 5: 最终提交**

```bash
git add impl/审计记录-DDD重构-ADR-002.md
git commit -m "docs(audit): 记录 ADR-002 代码实现完成"
git push
```

---

## 代码质量门禁

| 门禁 | 标准 | 检查方式 |
|------|------|---------|
| 单元测试 | 全部通过，0 fail | `find impl -name "*.test.js" -exec ...` |
| 能力列表测试 | shared-capabilities.test.js 三方同值 | `node --test impl/m5/test/shared-capabilities.test.js` |
| 信任层测试 | trust.test.js 全通过 | `node --test impl/m3/test/trust.test.js` |
| 编排层测试 | integration.test.js + egress.test.js 全通过 | `node --test impl/m5/test/integration.test.js impl/m5/test/egress.test.js` |
| 模型适配层测试 | model-api.test.js + agens-adapter.test.js 全通过 | 组合运行 |
| 部署验证 | ingress 重启成功 + 实测分类正确 | SSH 验证 |

## 审计门禁

| 审计项 | 标准 | 证据 |
|--------|------|------|
| DDD 文档一致性 | 代码实现与 DDD 设计文档一致 | 改后更新审计记录 |
| 无 ADR-001 残留 | 无 egress 布尔字段在代码中 | grep 检查 |
| 风险等级完整性 | 所有能力在 RISK_LEVEL 中有定义 | 代码审查 |
| 回滚完整性 | ADR-001 的 6 处改动全部回滚或适配 | 对照 ADR-002 回滚表逐项检查 |