# 确定性规则层（关键词覆写）实施计划

> **For agentic workers:** 实施前请加载 `writing-plans` 技能。每个任务完成后必须经过：全量测试（0 失败）→ 子代理审计 → 提交，三道门全部通过后才进入下一任务。

**Goal:** 在 `compose.js` 的 `toConvResult` 中增加确定性规则层，对模型输出的 `actionClass` 做关键词覆写——命中外传关键词时强制设为 `egress`，确保安全字段不依赖模型概率输出。

**Architecture:** 单层单点改动——`toConvResult` 是模型输出到编排层的唯一透传点，在此处加一条关键词匹配规则，命中即覆写 `actionClass` 和 `capability`。这对应 ADR-002 §6 判定点第 1 步的"确定性规则层"描述。

**Tech Stack:** Node.js 24, node:test, 零依赖

**前置条件:** ADR-002 代码已实现（`46e6bc4`），actionClass 全链已跑通。

---

## 文件结构

| 文件 | 改动类型 | 职责 |
|------|---------|------|
| `impl/m5/src/compose.js` | 修改 | `toConvResult` 中加关键词匹配规则 |
| `impl/m5/test/compose.test.js` | 修改 | 新增关键词覆写测试 |

---

### Task 1: 实现确定性规则层

**Files:**
- Modify: `impl/m5/src/compose.js`（`toConvResult` 方法）
- Test: `impl/m5/test/compose.test.js`（新增测试）

**Interfaces:**
- Consumes: `modelApi` 输出的 `{actionClass, intentType, capability, ...}`
- Produces: 同上，但外传关键词命中时 `actionClass` 强制为 `'egress'`、`capability` 强制为 `'egress_send'`、`intentType` 同步为 `'execute'`

- [ ] **Step 1: 读当前文件确认改点**

```bash
cd /home/shadow/ninjasin-labs/Voyage && grep -n "toConvResult\|egress\|actionClass\|return" impl/m5/src/compose.js | head -30
```

- [ ] **Step 2: 在 `toConvResult` 返回前插入关键词规则**

找到 `toConvResult` 方法（约 line 233-253），在 `return { ... }` 之前插入关键词匹配逻辑：

```js
const toConvResult = (r, intent, actorId) => {
  const id = intentIdOf(intent, actorId);
  if (!r || r.ok !== true) {
    return { actionClass: 'read', intentType: 'query', capability: 'query_status', confidence: 0, intentId: id, subject: null, degraded: true };
  }
  let params = r.params && typeof r.params === 'object' ? { ...r.params } : {};
  let subject = r.subject || null;
  if (!subject && params.service && assetRepo.isActive(params.service)) {
    subject = params.service;
  }
  const defaults = CAPABILITY_DEFAULT_PARAMS[r.capability];
  if (defaults) {
    for (const [k, v] of Object.entries(defaults)) {
      if (params[k] === undefined) params[k] = v;
    }
  }
  const aClass = r.actionClass || (r.intentType === 'query' ? 'read' : 'write');

  // --- 确定性规则层（ADR-002 §6 判定点第 1 步）---
  // 关键词匹配覆写：模型输出不可靠时，用确定性规则兜底安全字段。
  // 外传关键词命中时，强制 actionClass=egress，capability=egress_send。
  const EGRESS_KEYWORDS = ['发给我', '发我', '微信', '邮件', 'mail', '网盘', '导出', '下载', '外传', '发送到', '传给我', '复制到', '粘贴到', '传到', 'wechat', 'weixin', 'email', '发给'];
  if (intent && EGRESS_KEYWORDS.some(k => intent.includes(k))) {
    return { actionClass: 'egress', intentType: 'execute', capability: 'egress_send', confidence: r.confidence || 0, intentId: id, subject, params };
  }
  // --- 规则层结束 ---

  return { actionClass: aClass, intentType: r.intentType || (aClass === 'read' ? 'query' : 'execute'), capability: r.capability || 'query_status', confidence: r.confidence, intentId: id, subject, params };
};
```

**注意点：**
- `EGRESS_KEYWORDS` 放在函数内部，避免模块级常量污染
- 关键词匹配命中后**直接返回**，不经过后续的 `aClass` 推断——因为 `actionClass` 已经被强制设为 `egress`
- 关键词匹配的 `intent` 是用户原始输入文本，由 `toConvResult` 的调用方传入——检查调用链确认 `intent` 参数存在

- [ ] **Step 3: 验证调用链中 `intent` 参数是否传入 `toConvResult`**

检查 `toConvResult` 的调用者：

```bash
grep -n "toConvResult" impl/m5/src/compose.js
```

如果 `toConvResult` 的调用方没有传入 `intent` 文本，需要修改调用方或从 `r` 中获取。预期调用方是 `convPort.interpret` 的回调（line 264 和 266），它们有 `intent` 参数，需要修改 `toConvResult` 签名以接收 `intent`。

- [ ] **Step 4: 更新 `toConvResult` 签名和调用方**

如果当前 `toConvResult` 签名是 `(r, intent, actorId)`，则 `intent` 参数已存在。如果签名是 `(r)`，则需改为 `(r, intent, actorId)` 并更新所有调用方。

- [ ] **Step 5: 新增 compose.test.js 测试**

添加以下测试到 `impl/m5/test/compose.test.js`：

```js
test('F14 确定性规则层：外传关键词命中时强制 actionClass=egress', () => {
  const model = { provider: 'local', syncCapable: true, registry: { local: { interpretSync: () => '{"actionClass":"read","capability":"query_status","confidence":0.9}', async interpret() { return this.interpretSync(); } } } };
  const app = compose({ mode: 'mock', model });
  // 意图中含"发给我"关键词
  const r = app.handleSync({ actorId: 'sre-alice', from: 'test', intent: '把日志发给我' });
  assert.strictEqual(r.status, 'NEED_REVIEW', '外传关键词命中应触发审批');
  assert.strictEqual(r.needApproval, true);
});

test('F15 确定性规则层：无外传关键词时保持模型输出', () => {
  const model = { provider: 'local', syncCapable: true, registry: { local: { interpretSync: () => '{"actionClass":"read","capability":"query_status","confidence":0.9}', async interpret() { return this.interpretSync(); } } } };
  const app = compose({ mode: 'mock', model });
  const r = app.handleSync({ actorId: 'sre-alice', from: 'test', intent: '看下状态' });
  assert.strictEqual(r.status, 'OK', '无关键词时正常查询放行');
  assert.strictEqual(r.needApproval, false);
});
```

注意：需要先确认 `compose.test.js` 中 `compose` 的 `handleSync` 方法签名和返回值，以及测试文件是否已有 `compose` 导入。

- [ ] **Step 6: 全量测试**

```bash
cd /home/shadow/ninjasin-labs/Voyage && find impl -name "*.test.js" -exec sh -c 'cd "$(dirname "$1")" && node --test "$(basename "$1")" 2>&1 | grep -E "^(✗|ℹ fail [1-9])"' _ {} \; 2>&1 | head -5
```
Expected: 无输出（0 失败）。

- [ ] **Step 7: 子代理审计**

派一个独立子代理审计代码质量和设计一致性：

```text
审计 `impl/m5/src/compose.js` 的 toConvResult 改动：
1. 关键词列表是否完整（覆盖面）
2. 关键词命中后的返回值是否与编排层兼容（actionClass=egress + intentType=execute + capability=egress_send）
3. 是否处理了边界情况（关键词在意图中间、大小写、空intent）
4. 是否有性能风险（每轮匹配 O(n) 关键词，n=20，可接受）
5. 确认调用链中 intent 参数已传入
```

- [ ] **Step 8: 提交**

```bash
git add impl/m5/src/compose.js impl/m5/test/compose.test.js
git commit -m "feat(compose): 确定性规则层 — 关键词匹配覆写 egress"
```

---

## 质量门禁

| 门禁 | 标准 | 检查方式 |
|------|------|---------|
| 单元测试 | compose.test.js 新增测试通过 | `node --test impl/m5/test/compose.test.js` |
| 全量测试 | 0 失败 | `find impl -name "*.test.js" -exec ...` |
| 子代理审计 | 无逻辑错误、无边界遗漏 | 独立 agent 审查 |
| 设计一致性 | 关键词覆写返回值与编排层兼容 | 子代理审计 |

## 审计门禁（子代理执行）

子代理审计必须检查以下问题：

1. **关键词覆盖完整性**：列表是否覆盖了常见外传措辞（发给我/微信/邮件/网盘/导出/下载/外传/发送到/传给我/复制到/粘贴到/传到）
2. **返回值兼容性**：`{actionClass:'egress', intentType:'execute', capability:'egress_send'}` 是否与 `integration/domain.js` 的 execute 分流兼容
3. **边界情况**：关键词在意图中间、大小写混用、空 intent、关键词在非外传语境中的误报风险
4. **性能**：20 个关键词的 `some()` 匹配，每意图一次，可接受
5. **调用链完整性**：`toConvResult` 的 `intent` 参数是否从调用方正确传入