# C2 接入编排层（IntegrationService + decompose）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 C2 任务拆解（TaskService）接入 M5 编排层（IntegrationService），使编排层在信任预检通过后调用 decompose 将意图拆解为 DAG 子任务，再按节点粒度执行

**Architecture:** 在 IntegrationService 中新增 `decomposePort` 端口（可选注入，null = 退化为单步执行，向后兼容）。编排层在 `trust.handleExecIntent` 返回 `auto_granted` 后，调用 `decomposePort.decompose()` 拆解意图，然后对每个 ready 节点创建作业 + 启动。支持单节点（直接执行）、多节点并行（批量执行）、依赖链（分批执行）。

**Tech Stack:** 纯 JS + node:test（零依赖）

## Global Constraints

- 不改变现有 IntegrationService 的 `handle()` 返回结构（向后兼容）
- decomposePort 为可选注入（null = 退化为当前行为，不影响现有测试）
- 不修改 TaskService/Task/DAGNode 已有的代码（只新增接口）
- 所有测试在 `impl/m5/test/integration.test.js` 追加

---

## 文件结构

| 文件 | 职责 | 动作 |
|------|------|------|
| `impl/m5/src/integration/domain.js` | IntegrationService 新增 decomposePort 字段 + handle 中调用 decompose | 修改 |
| `impl/m5/test/integration.test.js` | C2 集成测试 | 追加 |
| `impl/m5/src/compose.js` | mock/real 模式注入 decomposePort | 修改 |

---

## 设计概览

### decomposePort 契约

```js
decomposePort: {
  decompose(intent) → { task, nodes }
  // task: Task 实例（含 nodes[] 和状态）
  // nodes: DAGNode[]（拆解后的子任务列表）
}
```

当 `decomposePort` 为 null 时（默认），`handle()` 保持当前行为不变。

### handle() 中的 C2 集成点

在 `handle()` 中，`trust.status === 'auto_granted' && trust.grant` 分支：

```
当前：createJob + start → 单个作业
改为：
  1. 如果 decomposePort 存在 → 调用 decompose({actionClass, capability, target, params, subject, trustPrechecked: true})
  2. 获取 getReadyNodes(task) → 一批就绪节点
  3. 对每个就绪节点：
     a. 用 DAGNode 的 capability/target/params 创建 Job
     b. 绑定 Grant（沿用原 trust.grant）
     c. 启动
  4. 返回结果含 taskId + 已启动节点数 + 总节点数
  5. 如果 decomposePort 不存在 → 保持当前行为（单步执行）
```

### 返回结构扩展

`handle()` 返回新增可选字段（不影响现有消费者）：

```js
{
  status: 'OK',
  kind: 'execute',
  grant: {...},
  jobId: 'job-...',           // 单节点时兼容
  taskId: 'task-...',         // 新增：C2 任务 ID
  nodeCount: 3,               // 新增：总子任务数
  startedCount: 2,            // 新增：已启动子任务数
}
```

---

### Task 1: IntegrationService 新增 decomposePort

**Files:**
- Modify: `impl/m5/src/integration/domain.js`（构造函数 + handle 方法中集成 C2）

**Interfaces:**
- Consumes: `TaskService`, `Task`, `DAGNode` from `impl/m2/src/conv/domain.js`
- Produces: 扩展 `handle()` 返回结构（taskId/nodeCount/startedCount）

- [ ] **Step 1: 写测试**

在 `impl/m5/test/integration.test.js` 末尾追加：

```js
// ============ C2 拆解集成 ============

const { TaskService, Task, DAGNode } = require('../../m2/src/conv/domain.js');

test('C2-I1 handle 单节点拆解：decomposePort 存在时走拆解路径', () => {
  let decomposeCalled = false;
  const svc = new IntegrationService({
    convPort: { interpret: () => ({ actionClass: 'write', capability: 'restart', confidence: 0.95, intentId: 'i1', subject: 'jd-light', params: { service: 'nginx' } }) },
    trustPort: {
      handleExecIntent: () => ({ status: 'auto_granted', grant: { id: 'g1', commandTemplate: 'restart_service', target: 'jd-light', creator: 'alice' } }),
      resolveApproval: () => ({}),
    },
    execPort: {
      createJob: ({ id, creator, target, template, params, grantRef }) => ({ id, creator, target, template, params, grantRef }),
      start: ({ jobId }) => ({ status: 'OK', job: { id: jobId } }),
    },
    auditPort: { write: () => ({ ok: true }) },
    decomposePort: {
      decompose(intent) {
        decomposeCalled = true;
        assert.strictEqual(intent.trustPrechecked, true, '应传递 trustPrechecked=true');
        const svc = new TaskService();
        return svc.decompose({ ...intent, trustPrechecked: true });
      },
    },
    timeSource: () => new Date('2026-09-01'),
  });
  const r = svc.handle({ actorId: 'alice', from: 'test', intent: '重启 jd-light 的 nginx' });
  assert.strictEqual(r.status, 'OK');
  assert.ok(decomposeCalled, 'decompose 应被调用');
  assert.strictEqual(r.taskId, 'task-0');
  assert.strictEqual(r.nodeCount, 1);
  assert.strictEqual(r.startedCount, 1);
  assert.ok(r.jobId, '单节点应返回 jobId');
});

test('C2-I2 handle 多目标并行拆解：每个目标创建作业', () => {
  const svc = new IntegrationService({
    convPort: { interpret: () => ({ actionClass: 'write', capability: 'restart', confidence: 0.95, intentId: 'i2', subject: 'jd-light,ali-ecs-99', params: {} }) },
    trustPort: {
      handleExecIntent: () => ({ status: 'auto_granted', grant: { id: 'g1', commandTemplate: 'restart_service', target: 'jd-light', creator: 'alice' } }),
      resolveApproval: () => ({}),
    },
    execPort: {
      createJob: ({ id, creator, target }) => ({ id, creator, target }),
      start: ({ jobId }) => ({ status: 'OK', job: { id: jobId } }),
    },
    auditPort: { write: () => ({ ok: true }) },
    decomposePort: {
      decompose(intent) {
        const svc = new TaskService();
        return svc.decompose({ ...intent, trustPrechecked: true });
      },
    },
    timeSource: () => new Date('2026-09-01'),
  });
  const r = svc.handle({ actorId: 'alice', from: 'test', intent: '重启 jd-light 和 ali-ecs-99' });
  assert.strictEqual(r.status, 'OK');
  assert.strictEqual(r.nodeCount, 2);
  assert.strictEqual(r.startedCount, 2, '并行节点全部启动');
});

test('C2-I3 handle decomposePort 为 null：退化为当前行为（向后兼容）', () => {
  const svc = new IntegrationService({
    convPort: { interpret: () => ({ actionClass: 'write', capability: 'restart', confidence: 0.95, intentId: 'i3', subject: 'jd-light', params: { service: 'nginx' } }) },
    trustPort: {
      handleExecIntent: () => ({ status: 'auto_granted', grant: { id: 'g1', commandTemplate: 'restart_service', target: 'jd-light', creator: 'alice' } }),
      resolveApproval: () => ({}),
    },
    execPort: {
      createJob: ({ id }) => ({ id }),
      start: ({ jobId }) => ({ status: 'OK', job: { id: jobId } }),
    },
    auditPort: { write: () => ({ ok: true }) },
    // 不传 decomposePort → 退化为当前行为
    timeSource: () => new Date('2026-09-01'),
  });
  const r = svc.handle({ actorId: 'alice', from: 'test', intent: '重启 nginx' });
  assert.strictEqual(r.status, 'OK');
  assert.strictEqual(r.taskId, undefined, '无 decomposePort 时不返回 taskId');
  assert.strictEqual(r.nodeCount, undefined);
  assert.strictEqual(r.startedCount, undefined);
  assert.ok(r.jobId, '应返回 jobId（兼容单步执行）');
});

test('C2-I4 handle decompose 失败：回退到单步执行', () => {
  const svc = new IntegrationService({
    convPort: { interpret: () => ({ actionClass: 'write', capability: 'restart', confidence: 0.95, intentId: 'i4', subject: 'jd-light', params: { service: 'nginx' } }) },
    trustPort: {
      handleExecIntent: () => ({ status: 'auto_granted', grant: { id: 'g1', commandTemplate: 'restart_service', target: 'jd-light', creator: 'alice' } }),
      resolveApproval: () => ({}),
    },
    execPort: {
      createJob: ({ id }) => ({ id }),
      start: ({ jobId }) => ({ status: 'OK', job: { id: jobId } }),
    },
    auditPort: { write: () => ({ ok: true }) },
    decomposePort: {
      decompose() { throw new Error('decompose 临时故障'); },
    },
    timeSource: () => new Date('2026-09-01'),
  });
  const r = svc.handle({ actorId: 'alice', from: 'test', intent: '重启 nginx' });
  // decompose 失败后应回退到单步执行
  assert.strictEqual(r.status, 'OK');
  assert.ok(r.jobId, '回退后应返回 jobId');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test impl/m5/test/integration.test.js -t "C2-I"
```
预期：4 个 FAIL（C2-I1~I4），因为 IntegrationService 还不认识 decomposePort

- [ ] **Step 3: 修改 IntegrationService 构造函数**

在 `impl/m5/src/integration/domain.js` 的 `constructor` 中新增 `decomposePort` 参数：

```js
constructor({ convPort, trustPort, execPort, auditPort, notifyPort = null, timeSource = () => new Date(), outbox = null, decomposePort = null }) {
    // ... 现有校验不变 ...
    this.decomposePort = decomposePort; // 可选，null = 退化为单步执行
    // ... 现有代码不变 ...
```

- [ ] **Step 4: 修改 handle() 中 auto_granted 分支**

找到 `handle()` 方法中 `trust.status === 'auto_granted' && trust.grant` 分支（约第 145 行），替换为：

```js
if (trust.status === 'auto_granted' && trust.grant) {
  // C2 拆解集成：如果 decomposePort 存在，调用 decompose 拆解意图
  if (this.decomposePort) {
    try {
      const { task, nodes } = this.decomposePort.decompose({
        actionClass, capability, target: subject, params: interp.params || {},
        subject, trustPrechecked: true,
      });
      const readyNodes = task.nodes.filter(n => n.dependsOn.length === 0 && n.status === 'queued');
      let startedCount = 0;
      for (const node of readyNodes) {
        try {
          const job = this.execPort.createJob({
            id: `job-${intentId}-${node.id}`,
            creator: actorId, target: node.target,
            template: node.capability, params: node.params || {},
            grantRef: trust.grant.id,
          });
          const started = this.execPort.start({ jobId: job.id, now });
          if (started && started.status === 'OK') startedCount++;
        } catch (e) { /* 单节点失败不阻塞整体 */ }
      }
      return {
        status: 'OK', kind: 'execute',
        taskId: task.id, nodeCount: nodes.length, startedCount,
        grant: trust.grant, jobId: startedCount > 0 ? `job-${intentId}-${readyNodes[0].id}` : undefined,
        needApproval: false, intentId,
      };
    } catch (e) {
      // decompose 失败回退到单步执行
    }
  }
  // 原有单步执行逻辑（无 decomposePort 或 decompose 失败时）
  let job;
  try { job = this.execPort.createJob({ id: `job-${intentId}`, creator: actorId, target: subject, template: capability, params: interp.params || {}, grantRef: trust.grant.id }); }
  catch (e) { return { status: 'REJECTED', reason: 'param_schema_rejected', intentId }; }
  const started = this.execPort.start({ jobId: job.id, now });
  if (!started || typeof started !== 'object') return { status: 'ERROR', reason: 'exec_start_malformed' };
  if (started.status === 'ERROR') return { status: 'ERROR', reason: started.reason || 'audit_failed', intentId };
  if (started.status === 'REJECTED') return { status: 'REJECTED', reason: started.reason || 'exec_rejected', needApproval: false, intentId };
  return { status: 'OK', kind: 'execute', grant: trust.grant, jobId: job.id, needApproval: false, intentId };
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test impl/m5/test/integration.test.js -t "C2-I"
```
预期：4 个 PASS

- [ ] **Step 6: 运行完整测试确认不破坏现有测试**

```bash
find impl -name "*.test.js" | sort | node --test
```
预期：全部通过

- [ ] **Step 7: Commit**

```bash
git add impl/m5/src/integration/domain.js impl/m5/test/integration.test.js
git commit -m "feat(c2): IntegrationService 接入 decomposePort——编排层消费 C2 拆解

C2 拆解流程：handle() 中 trust 预检通过后，若 decomposePort 存在，
则调用 decompose 将意图拆解为 DAG 子任务，对每个就绪节点创建作业+启动。
返回新增 taskId/nodeCount/startedCount 字段。decomposePort 为 null 时
退化为原单步执行行为（向后兼容）。decompose 失败时同样回退单步执行。"
```

---

### Task 2: compose.js 注入 decomposePort

**Files:**
- Modify: `impl/m5/src/compose.js`（mock/real 模式注入 TaskService 作为 decomposePort）

- [ ] **Step 1: 在 compose.js 导入 TaskService**

```js
const { TaskService } = require('../../m2/src/conv/domain.js');
```

放在现有导入区域（约第 22 行附近）。

- [ ] **Step 2: 在 compose() 中创建 decomposePort 并注入**

在创建 `integrationService` 之前（约第 268 行），添加：

```js
// C2 任务拆解端口（可选注入；null = 退化为单步执行）
const taskService = new TaskService({ timeSource });
```

然后在 `integrationService` 构造函数调用中传入：

```js
const integrationService = new IntegrationService({
  convPort: { interpret: ({ actorId, intent, now }) => { ... } },
  trustPort: { ... },
  execPort: { ... },
  auditPort: { ... },
  notifyPort: { ... },
  timeSource,
  outbox: ...,
  decomposePort: taskService,  // C2 拆解端口
});
```

- [ ] **Step 3: 运行测试确认通过**

```bash
find impl -name "*.test.js" | sort | node --test
```
预期：全部通过

- [ ] **Step 4: Commit**

```bash
git add impl/m5/src/compose.js
git commit -m "feat(c2): compose.js 注入 TaskService 作为 decomposePort
```

---

## 自检清单

1. **Spec 覆盖**：C2 接入编排层（#1 待办）全部覆盖。不改变现有 API 返回结构。decomposePort 可选注入向后兼容。
2. **占位符检查**：无 TODO/TBD，所有代码完整。
3. **类型一致性**：decomposePort 的 `decompose(intent)` 签名与 `TaskService.decompose` 一致。

---

## 执行选择

计划已保存到 `docs/superpowers/plans/2026-09-01-c2-integration-orchestration.md`。两种执行方式：

1. **Subagent 驱动（推荐）** — 每个 Task 派一个 fresh subagent
2. **本会话内联执行** — 直接在本会话中按步骤执行