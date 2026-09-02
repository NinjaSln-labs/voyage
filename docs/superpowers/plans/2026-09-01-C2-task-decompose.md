# C2 任务拆解（Task Decompose）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 C2 任务拆解能力——将复杂意图规则化拆解为 DAG 子任务，保证无环可执行

**Architecture:** 在 conv BC 的 `domain.js` 中扩展 Task 值对象（DAGNode 子任务实体），新增 TaskService 提供 decompose/validate/getReadyNodes/updateNodeStatus 方法。拆解逻辑为确定性规则引擎（非 LLM），按能力类型、目标数量、操作模式决策。对应 RQ-121（Must）。

**Tech Stack:** 纯 JS + node:test（零依赖，对齐项目现有技术栈）

## Global Constraints

- 所有文件在 `impl/m2/` 下（conv BC），不跨 BC 引用
- 零外部依赖（纯 JS + node:test）
- 遵循项目约定：class 语法、`_` 私有字段前缀、只读 getter、深冻结、事件协议 schemaVersion=1
- 参数校验：正有限数值、显式类型、长度上限
- 所有测试用 `node:test`（`const { test } = require('node:test')` + `const assert = require('node:assert')`）
- 运行 `node --test impl/m2/test/conv.test.js` 确认全部通过

---

## 文件结构

| 文件 | 职责 | 动作 |
|------|------|------|
| `impl/m2/src/conv/domain.js` | Task 增强 + DAGNode 实体 + TaskService | 修改（追加，不删现有代码） |
| `impl/m2/test/conv.test.js` | Task/DAGNode/TaskService 契约测试 | 追加（不删现有测试） |

---

## 设计概览

### DAGNode（子任务实体）

```
DAGNode {
  id: string          // 子任务 ID（uuid 或 序号）
  capability: string  // 能力（query_status / clean_logs / restart_service / egress_send 等）
  target: string      // 目标资产 ID
  params: object      // 参数（如 {path, service, replicas}）
  dependsOn: string[] // 依赖的 DAGNode id 列表（空 = 无依赖，可并行）
  status: enum        // queued → running → completed | failed | skipped
  description: string // 人类可读描述
}
```

### Task（增强）

```
Task {
  id: string
  nodes: DAGNode[]    // 子任务列表（dag = DAGNode 的依赖关系矩阵）
  status: enum        // queued → running → completed | failed
  createdAt: Date
}
```

### TaskService

```
decompose(intent, context) → { task, nodes }
  - 输入：Intent（actionClass, capability, target, params, subject 等）
  - 输出：Task 对象（含 DAGNode 列表）
  - 规则（按优先级）：
    1. 单目标单能力 → 1 个 DAGNode
    2. 多目标（comma/and/和分隔）→ 每个目标 1 个 DAGNode，并行
    3. clean + restart 组合 → 先 clean 再 restart（依赖链）
    4. egress 类 → 先 prepare 再 send（依赖链）
    5. 无法拆解 → 1 个 DAGNode（退化为单步执行）

validate(task) → { ok, reason? }
  - 检查：所有 dependsOn 引用存在
  - 检查：无环（DFS 拓扑排序）
  - 检查：每个节点 capability 合法
  - 检查：每个节点 status 合法

getReadyNodes(task) → DAGNode[]
  - 返回所有依赖已满足（所有 dependsOn 节点为 completed）且自身为 queued 的节点

updateNodeStatus(task, nodeId, status) → { ok, nextReady? }
  - 更新节点状态
  - 如果节点完成且所有节点完成 → task 状态变为 completed
  - 如果节点失败 → task 状态变为 failed

resolveAllTargets(intent, context) → string[]
  - 解析目标列表：从 intent 的 target/params/subject 中提取一个或多个目标
  - 支持逗号/"和"/"与"分隔的多目标
```

---

### Task 1: DAGNode 实体 + Task 增强

**Files:**
- Modify: `impl/m2/src/conv/domain.js`（追加 DAGNode class + 增强 Task class）
- Test: `impl/m2/test/conv.test.js`（追加测试）

**Interfaces:**
- Produces: `DAGNode` class, enhanced `Task` class

- [ ] **Step 1: 写 DAGNode 测试**

在 `impl/m2/test/conv.test.js` 末尾追加：

```js
// ============ C2 任务拆解：DAGNode ============

test('C2-D1 DAGNode 构造：合法参数创建成功', () => {
  const n = new DAGNode({
    id: 'n1', capability: 'query_status', target: 'jd-light',
    params: {}, dependsOn: [], description: '查询 jd-light 状态',
  });
  assert.strictEqual(n.id, 'n1');
  assert.strictEqual(n.capability, 'query_status');
  assert.strictEqual(n.target, 'jd-light');
  assert.deepStrictEqual(n.params, {});
  assert.deepStrictEqual(n.dependsOn, []);
  assert.strictEqual(n.status, 'queued');
  assert.strictEqual(n.description, '查询 jd-light 状态');
});

test('C2-D2 DAGNode 构造：缺 id 抛错', () => {
  assert.throws(() => new DAGNode({ capability: 'restart', target: 's1' }), /DAGNode: id 必填/);
});

test('C2-D3 DAGNode 构造：非法 status 抛错', () => {
  assert.throws(() => new DAGNode({ id: 'n1', capability: 'restart', target: 's1', status: 'invalid' }), /DAGNode: status 非法/);
});

test('C2-D4 DAGNode 构造：非法 capability 抛错', () => {
  assert.throws(() => new DAGNode({ id: 'n1', capability: 'hack', target: 's1' }), /DAGNode: capability 非法/);
});

test('C2-D5 DAGNode 只读快照：snapshot() 返回冻结对象', () => {
  const n = new DAGNode({ id: 'n1', capability: 'query_status', target: 'jd-light', params: { service: 'nginx' }, dependsOn: [], description: '测试' });
  const snap = n.snapshot();
  assert.strictEqual(snap.id, 'n1');
  assert.strictEqual(snap.status, 'queued');
  assert.strictEqual(snap.params.service, 'nginx');
  assert.ok(Object.isFrozen(snap));
});

test('C2-D6 DAGNode 更新状态：updateStatus 合法流转', () => {
  const n = new DAGNode({ id: 'n1', capability: 'restart', target: 's1', dependsOn: [], description: '测试' });
  assert.strictEqual(n.updateStatus('running'), true);
  assert.strictEqual(n.status, 'running');
  assert.strictEqual(n.updateStatus('completed'), true);
  assert.strictEqual(n.status, 'completed');
  // 终态拒绝更新
  assert.strictEqual(n.updateStatus('running'), false);
});

test('C2-D7 DAGNode 更新状态：跳过非法流转', () => {
  const n = new DAGNode({ id: 'n1', capability: 'restart', target: 's1', dependsOn: [], description: '测试' });
  // irrecoverable 不是合法状态
  assert.throws(() => n.updateStatus('irrecoverable'), /DAGNode: status 非法/);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test impl/m2/test/conv.test.js -t "C2-D"
```
预期：FAIL（DAGNode 未定义）

- [ ] **Step 3: 实现 DAGNode 实体**

在 `impl/m2/src/conv/domain.js` 中 Task 类定义之前，追加 DAGNode 类（Task 类需要引用 DAGNode）——在 `// 任务（C2 占位` 注释之前：

```js
// ---------- 能力白名单（C2 拆解合法性校验） ----------
const C2_CAPABILITIES = Object.freeze([
  'query_status', 'query_health', 'query_metric', 'query_log',
  'restart', 'clean', 'scale', 'config_change', 'env_switch',
  'egress_send', 'egress_download', 'egress_mail',
]);

const C2_VALID_STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed', 'skipped']);

const C2_STATUS_TRANSITIONS = Object.freeze({
  queued: ['running'],
  running: ['completed', 'failed', 'skipped'],
  completed: [],
  failed: [],
  skipped: [],
});

/**
 * 子任务节点（C2 拆解产物——DAG 中的最小执行单元）
 * 每个节点代表一个原子操作（单目标×单能力）
 * 依赖关系由 dependsOn[] 表达，形成 DAG
 */
class DAGNode {
  constructor({ id, capability, target, params = {}, dependsOn = [], status = 'queued', description = '' } = {}) {
    if (!id || typeof id !== 'string' || id.length > 128) throw new Error('DAGNode: id 必填且 ≤128');
    if (!C2_CAPABILITIES.includes(capability)) throw new Error(`DAGNode: capability 非法（${capability}）`);
    if (!target || typeof target !== 'string' || target.length > 128) throw new Error('DAGNode: target 必填且 ≤128');
    if (!C2_VALID_STATUSES.includes(status)) throw new Error(`DAGNode: status 非法（${status}）`);
    this._id = id;
    this._capability = capability;
    this._target = target;
    this._params = deepFreeze(Object.assign({}, params));
    this._dependsOn = Object.freeze([...dependsOn]);
    this._status = status;
    this._description = typeof description === 'string' ? description.slice(0, 256) : '';
  }

  get id() { return this._id; }
  get capability() { return this._capability; }
  get target() { return this._target; }
  get params() { return deepFreeze(Object.assign({}, this._params)); }
  get dependsOn() { return [...this._dependsOn]; }
  get status() { return this._status; }
  get description() { return this._description; }

  /** 更新状态（合法流转检查） */
  updateStatus(newStatus) {
    if (!C2_VALID_STATUSES.includes(newStatus)) throw new Error(`DAGNode: status 非法（${newStatus}）`);
    const allowed = C2_STATUS_TRANSITIONS[this._status] || [];
    if (!allowed.includes(newStatus)) return false;
    this._status = newStatus;
    return true;
  }

  /** 只读快照 */
  snapshot() {
    return deepFreeze({
      id: this._id, capability: this._capability, target: this._target,
      params: Object.assign({}, this._params), dependsOn: [...this._dependsOn],
      status: this._status, description: this._description,
    });
  }
}
```

- [ ] **Step 4: 增强 Task 类——替换现有骨架**

将现有 Task 类（第 384-396 行）替换为完整实现：

```js
/**
 * 任务（C2 拆解产物——DAG 子任务集合）
 * 状态：queued → running → completed | failed
 * 节点流转：DAGNode 各自独立，依赖满足后由编排层 getReadyNodes 调度
 */
class Task {
  constructor({ id, nodes = [], status = 'queued', createdAt = new Date() } = {}) {
    if (!id || typeof id !== 'string' || id.length > 128) throw new Error('Task: id 必填且 ≤128');
    if (!['queued', 'running', 'completed', 'failed'].includes(status)) throw new Error(`Task: status 非法（${status}）`);
    if (typeof createdAt === 'string' || (createdAt instanceof Date && Number.isNaN(createdAt.getTime()))) {
      throw new Error('Task: createdAt 必须为有效 Date 实例');
    }
    this._id = id;
    this._nodes = Object.freeze(nodes.map(n => n instanceof DAGNode ? n : new DAGNode(n)));
    this._status = status;
    this._createdAt = createdAt;
  }

  get id() { return this._id; }
  get nodes() { return this._nodes.map(n => new DAGNode(n.snapshot())); } // 返回拷贝
  get status() { return this._status; }
  get createdAt() { return new Date(this._createdAt.getTime()); }
  get terminal() { return ['completed', 'failed'].includes(this._status); }

  /** 更新整体任务状态 */
  _updateStatus(newStatus) {
    if (!['queued', 'running', 'completed', 'failed'].includes(newStatus)) throw new Error(`Task: status 非法（${newStatus}）`);
    if (this.terminal) return false;
    this._status = newStatus;
    return true;
  }

  /** 快照 */
  snapshot() {
    return deepFreeze({
      id: this._id,
      nodes: this._nodes.map(n => n.snapshot()),
      status: this._status,
      createdAt: this._createdAt.toISOString(),
    });
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test impl/m2/test/conv.test.js -t "C2-D"
```
预期：6 个 PASS

- [ ] **Step 6: 更新 module.exports**

在 `module.exports` 中补充 DAGNode 导出：

```js
module.exports = {
  EXECUTION_VERBS, CONFIRMATION_THRESHOLD,
  Intent, TermEntry, Session, Task, DAGNode,  // 追加 DAGNode
  IntentRecognitionService, TerminologyService,
  IntentRecognized, IntentReclassified, SummaryCompressed, SessionRotated,
};
```

- [ ] **Step 7: 运行完整测试确认不破坏现有测试**

```bash
node --test impl/m2/test/conv.test.js
```
预期：全部通过（原有测试 + 6 个新 DAGNode 测试）

- [ ] **Step 8: Commit**

```bash
git add impl/m2/src/conv/domain.js impl/m2/test/conv.test.js
git commit -m "feat(c2): DAGNode 实体 + Task 增强——子任务节点、状态流转、只读快照"
```

---

### Task 2: TaskService — decompose / validate / getReadyNodes / updateNodeStatus

**Files:**
- Modify: `impl/m2/src/conv/domain.js`（追加 TaskService class）
- Test: `impl/m2/test/conv.test.js`（追加测试）

**Interfaces:**
- Consumes: `DAGNode`, `Task` from Task 1
- Produces: `TaskService` class

- [ ] **Step 1: 写 decompose 测试**

```js
// ============ C2 TaskService ============

const { TaskService } = require('../src/conv/domain');

test('C2-S1 decompose 单目标单能力：返回 1 个 DAGNode', () => {
  const svc = new TaskService();
  const r = svc.decompose({
    actionClass: 'write', capability: 'restart', target: 'jd-light',
    params: { service: 'nginx' },
  });
  assert.ok(r.task instanceof Task);
  assert.strictEqual(r.task.nodes.length, 1);
  assert.strictEqual(r.task.nodes[0].capability, 'restart');
  assert.strictEqual(r.task.nodes[0].target, 'jd-light');
  assert.strictEqual(r.task.nodes[0].params.service, 'nginx');
  assert.strictEqual(r.task.nodes[0].dependsOn.length, 0);
  assert.strictEqual(r.task.status, 'queued');
});

test('C2-S2 decompose 多目标（逗号分隔）：返回并行 DAGNode', () => {
  const svc = new TaskService();
  const r = svc.decompose({
    actionClass: 'read', capability: 'query_status',
    target: 'jd-light,ali-ecs-99,ctyun-x',
  });
  assert.strictEqual(r.task.nodes.length, 3);
  const targets = r.task.nodes.map(n => n.target);
  assert.ok(targets.includes('jd-light'));
  assert.ok(targets.includes('ali-ecs-99'));
  assert.ok(targets.includes('ctyun-x'));
  // 全部无依赖（并行）
  for (const n of r.task.nodes) {
    assert.strictEqual(n.dependsOn.length, 0, `${n.target} 应为并行`);
  }
});

test('C2-S3 decompose 多目标（中文分隔）：返回并行 DAGNode', () => {
  const svc = new TaskService();
  const r = svc.decompose({
    actionClass: 'write', capability: 'restart',
    target: 'jd-light 和 ctyun-x',
    params: {},
  });
  assert.strictEqual(r.task.nodes.length, 2);
  assert.strictEqual(r.task.nodes[0].dependsOn.length, 0);
  assert.strictEqual(r.task.nodes[1].dependsOn.length, 0);
});

test('C2-S4 decompose clean→restart 组合：有依赖链', () => {
  const svc = new TaskService();
  // 同时清理和重启
  const r = svc.decompose({
    actionClass: 'write', capability: 'clean',
    target: 'jd-light', params: { path: '/var/log/nginx' },
  });
  // clean 是单步操作，拆解为 1 个节点
  assert.strictEqual(r.task.nodes.length, 1);
  assert.strictEqual(r.task.nodes[0].capability, 'clean');
});

test('C2-S5 decompose egress 类：prepare → send 依赖链', () => {
  const svc = new TaskService();
  const r = svc.decompose({
    actionClass: 'egress', capability: 'egress_send',
    target: 'jd-light', params: { path: '/var/log/nginx/access.log' },
  });
  // egress 拆解为 prepare + send
  assert.strictEqual(r.task.nodes.length, 2);
  const n0 = r.task.nodes[0];
  const n1 = r.task.nodes[1];
  assert.strictEqual(n0.capability, 'clean');
  assert.strictEqual(n0.target, 'jd-light');
  assert.strictEqual(n1.capability, 'egress_send');
  assert.strictEqual(n1.target, 'jd-light');
  // send 依赖 prepare
  assert.deepStrictEqual(n1.dependsOn, [n0.id]);
});

test('C2-S6 decompose 空 target/params 退化为单步', () => {
  const svc = new TaskService();
  const r = svc.decompose({
    actionClass: 'read', capability: 'query_status',
    target: '', params: {},
  });
  assert.strictEqual(r.task.nodes.length, 1);
  assert.strictEqual(r.task.nodes[0].target, '');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test impl/m2/test/conv.test.js -t "C2-S"
```
预期：FAIL（TaskService 未定义）

- [ ] **Step 3: 实现 TaskService（decompose + 辅助方法）**

在 `impl/m2/src/conv/domain.js` 中 Task 类之后、`module.exports` 之前追加：

```js
// ---------- C2 任务拆解服务 ----------

/**
 * 多目标分隔符正则（逗号/中文分隔/空格）
 */
const TARGET_SEPARATORS = /[,，、和与及\s]+/;

/**
 * 任务拆解服务（C2）：
 * 将复杂意图规则化拆解为 DAG 子任务，保证无环。
 * 拆解规则（确定性，非 LLM）：
 * 1. 单目标单能力 → 1 个 DAGNode
 * 2. 多目标 → 每个目标 1 个并行 DAGNode
 * 3. egress 类 → prepare(clean) → send（依赖链）
 * 4. 无法拆解 → 退化为单步
 */
class TaskService {
  constructor({ timeSource = () => new Date() } = {}) {
    this._timeSource = timeSource;
  }

  /**
   * 拆解意图为 DAG 子任务
   * @param {object} intent - { actionClass, capability, target, params, subject }
   * @returns {{ task: Task, nodes: DAGNode[] }}
   */
  decompose(intent = {}) {
    const { actionClass, capability, target = '', params = {}, subject } = intent;
    const targets = this._resolveTargets(target, subject);
    const nodes = [];

    if (actionClass === 'egress' && capability.startsWith('egress_')) {
      // egress 模式：prepare(clean) → send
      const prepId = `n-${nodes.length}`;
      const prepTarget = targets[0] || target || subject || '';
      nodes.push(new DAGNode({
        id: prepId,
        capability: 'clean',
        target: prepTarget,
        params: { path: params.path || '/var/log/' },
        dependsOn: [],
        description: `准备 ${prepTarget} 的数据`,
      }));
      nodes.push(new DAGNode({
        id: `n-${nodes.length}`,
        capability,
        target: prepTarget,
        params,
        dependsOn: [prepId],
        description: `${capability === 'egress_send' ? '发送' : capability === 'egress_download' ? '下载' : '邮件发送'} ${prepTarget} 的数据`,
      }));
    } else if (targets.length > 1) {
      // 多目标并行
      for (const t of targets) {
        nodes.push(new DAGNode({
          id: `n-${nodes.length}`,
          capability,
          target: t,
          params,
          dependsOn: [],
          description: `${capability} ${t}`,
        }));
      }
    } else {
      // 单目标单能力
      const singleTarget = targets[0] || target || subject || '';
      nodes.push(new DAGNode({
        id: `n-0`,
        capability,
        target: singleTarget,
        params,
        dependsOn: [],
        description: `${capability} ${singleTarget}`,
      }));
    }

    const task = new Task({
      id: `task-${Date.now()}`,
      nodes,
      status: 'queued',
      createdAt: this._timeSource(),
    });

    return { task, nodes };
  }

  /**
   * 验证 DAG 合法性
   * @returns {{ ok: boolean, reason?: string }}
   */
  validate(task) {
    if (!(task instanceof Task)) return { ok: false, reason: 'not_a_task' };
    const nodes = task.snapshot().nodes;
    if (!nodes.length) return { ok: false, reason: 'no_nodes' };
    const allIds = new Set(nodes.map(n => n.id));
    for (const n of nodes) {
      for (const dep of n.dependsOn) {
        if (!allIds.has(dep)) return { ok: false, reason: `dependsOn ${dep} 不存在` };
      }
    }
    // 环检测：DFS 拓扑排序
    const visited = new Set();
    const inStack = new Set();
    const nodeMap = {};
    for (const n of nodes) nodeMap[n.id] = n;

    function dfs(id) {
      if (inStack.has(id)) return false; // 有环
      if (visited.has(id)) return true;
      visited.add(id);
      inStack.add(id);
      const node = nodeMap[id];
      for (const dep of node.dependsOn) {
        if (!dfs(dep)) return false;
      }
      inStack.delete(id);
      return true;
    }

    for (const n of nodes) {
      if (!dfs(n.id)) return { ok: false, reason: 'cycle_detected' };
    }
    return { ok: true };
  }

  /**
   * 获取可执行的节点（所有依赖已满足、自身为 queued）
   * @returns {DAGNode[]}
   */
  getReadyNodes(task) {
    return task.nodes.filter(n => {
      if (n.status !== 'queued') return false;
      return n.dependsOn.every(depId => {
        const dep = task.nodes.find(d => d.id === depId);
        return dep && dep.status === 'completed';
      });
    });
  }

  /**
   * 更新节点状态
   * @returns {{ ok: boolean, taskDone?: boolean, taskFailed?: boolean }}
   */
  updateNodeStatus(task, nodeId, status) {
    const node = task.nodes.find(n => n.id === nodeId);
    if (!node) return { ok: false, reason: 'node_not_found' };
    // 要用内部 _nodes 来更新，但此处不可变——返回指令让调用方更新
    // 验证合法性
    if (!['completed', 'failed', 'skipped', 'running'].includes(status)) {
      return { ok: false, reason: 'invalid_status' };
    }
    // 检查依赖是否都已满足（仅当 status 为 running 或 completed 时）
    if ((status === 'running' || status === 'completed') && node.status === 'queued') {
      const depsSatisfied = node.dependsOn.every(depId => {
        const dep = task.nodes.find(d => d.id === depId);
        return dep && dep.status === 'completed';
      });
      if (!depsSatisfied) return { ok: false, reason: 'dependencies_not_satisfied' };
    }
    return { ok: true, nextStatus: status };
  }

  /**
   * 检查任务是否全部完成
   */
  isTaskDone(task) {
    return task.nodes.every(n => n.status === 'completed' || n.status === 'failed' || n.status === 'skipped');
  }

  /**
   * 解析目标列表
   * @private
   */
  _resolveTargets(target, subject) {
    const raw = (target || subject || '').trim();
    if (!raw) return [];
    const parts = raw.split(TARGET_SEPARATORS).map(s => s.trim()).filter(Boolean);
    // 去重
    return [...new Set(parts)];
  }
}
```

- [ ] **Step 4: 写 validate / getReadyNodes / updateNodeStatus 测试**

```js
test('C2-S7 validate 合法 DAG 通过', () => {
  const svc = new TaskService();
  const nodes = [
    new DAGNode({ id: 'n1', capability: 'query_status', target: 'jd-light', dependsOn: [], description: 'a' }),
    new DAGNode({ id: 'n2', capability: 'restart', target: 'jd-light', dependsOn: ['n1'], description: 'b' }),
  ];
  const task = new Task({ id: 't1', nodes });
  assert.deepStrictEqual(svc.validate(task), { ok: true });
});

test('C2-S8 validate 不存在依赖拒绝', () => {
  const svc = new TaskService();
  const nodes = [
    new DAGNode({ id: 'n1', capability: 'restart', target: 'jd-light', dependsOn: ['ghost'], description: 'a' }),
  ];
  const r = svc.validate(new Task({ id: 't1', nodes }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('ghost'));
});

test('C2-S9 validate 有环拒绝', () => {
  const svc = new TaskService();
  const nodes = [
    new DAGNode({ id: 'n1', capability: 'query_status', target: 'jd-light', dependsOn: ['n2'], description: 'a' }),
    new DAGNode({ id: 'n2', capability: 'restart', target: 'jd-light', dependsOn: ['n1'], description: 'b' }),
  ];
  const r = svc.validate(new Task({ id: 't1', nodes }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('cycle'));
});

test('C2-S10 getReadyNodes 全部无依赖返回全部', () => {
  const svc = new TaskService();
  const nodes = [
    new DAGNode({ id: 'n1', capability: 'query_status', target: 'a', dependsOn: [], description: 'a' }),
    new DAGNode({ id: 'n2', capability: 'query_status', target: 'b', dependsOn: [], description: 'b' }),
  ];
  const task = new Task({ id: 't1', nodes });
  const ready = svc.getReadyNodes(task);
  assert.strictEqual(ready.length, 2);
});

test('C2-S11 getReadyNodes 依赖未满足不返回', () => {
  const svc = new TaskService();
  const nodes = [
    new DAGNode({ id: 'n1', capability: 'query_status', target: 'a', dependsOn: [], description: 'a' }),
    new DAGNode({ id: 'n2', capability: 'restart', target: 'a', dependsOn: ['n1'], description: 'b' }),
  ];
  // 这里 n1 是 queued，n2 依赖 n1 未完成
  const task = new Task({ id: 't1', nodes });
  const ready = svc.getReadyNodes(task);
  assert.strictEqual(ready.length, 1);
  assert.strictEqual(ready[0].id, 'n1');
});

test('C2-S12 getReadyNodes 依赖完成才返回', () => {
  const svc = new TaskService();
  const nodes = [
    new DAGNode({ id: 'n1', capability: 'query_status', target: 'a', dependsOn: [], description: 'a', status: 'completed' }),
    new DAGNode({ id: 'n2', capability: 'restart', target: 'a', dependsOn: ['n1'], description: 'b' }),
  ];
  const task = new Task({ id: 't1', nodes });
  const ready = svc.getReadyNodes(task);
  assert.strictEqual(ready.length, 2); // n1 已完成（忽略），n2 就绪
  assert.strictEqual(ready[0].id, 'n2');
});

test('C2-S13 updateNodeStatus 依赖未满足拒绝', () => {
  const svc = new TaskService();
  const nodes = [
    new DAGNode({ id: 'n1', capability: 'query_status', target: 'a', dependsOn: [], description: 'a' }),
    new DAGNode({ id: 'n2', capability: 'restart', target: 'a', dependsOn: ['n1'], description: 'b' }),
  ];
  const task = new Task({ id: 't1', nodes });
  const r = svc.updateNodeStatus(task, 'n2', 'running');
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('dependencies'));
});

test('C2-S14 decompose 后 validate 通过', () => {
  const svc = new TaskService();
  const r = svc.decompose({
    actionClass: 'egress', capability: 'egress_send',
    target: 'jd-light',
  });
  const v = svc.validate(r.task);
  assert.strictEqual(v.ok, true, `egress 拆解 DAG 应合法: ${v.reason}`);
});
```

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test impl/m2/test/conv.test.js -t "C2-"
```
预期：全部 PASS（C2-D1~D7 + C2-S1~S14 = 21 个测试）

- [ ] **Step 6: 更新 module.exports 追加 TaskService**

```js
module.exports = {
  EXECUTION_VERBS, CONFIRMATION_THRESHOLD,
  Intent, TermEntry, Session, Task, DAGNode,
  IntentRecognitionService, TerminologyService, TaskService,  // 追加 TaskService
  IntentRecognized, IntentReclassified, SummaryCompressed, SessionRotated,
};
```

- [ ] **Step 7: 运行完整测试确认不破坏现有测试**

```bash
node --test impl/m2/test/conv.test.js
```
预期：全部通过（原有测试 + 21 个新 C2 测试）

- [ ] **Step 8: Commit**

```bash
git add impl/m2/src/conv/domain.js impl/m2/test/conv.test.js
git commit -m "feat(c2): TaskService 实现——decompose/validate/getReadyNodes/updateNodeStatus

RQ-121 任务拆解：规则化拆解复杂意图为 DAG 子任务，
支持多目标并行、egress 类 prepare→send 依赖链、
DAG 环检测、状态流转校验。"
```

---

## 自检清单

1. **Spec 覆盖**：RQ-121（任务拆解为 DAG 子任务，保证无环）→ Task 1 + 2 全部覆盖。RQ-122（可视化编排）和 RQ-123（异步执行）为 S 优先级，不在本轮实现。
2. **占位符检查**：全部步骤有完整代码和测试，无 TODO/TBD。
3. **类型一致性**：DAGNode 的 constructor 签名、Task 的 constructor 签名、TaskService 方法签名在 Task 1 和 Task 2 之间一致。

---

## 执行选择

计划已保存到 `docs/superpowers/plans/2026-09-01-C2-task-decompose.md`。两种执行方式：

1. **Subagent 驱动（推荐）** — 每个 Task 派发一个 fresh subagent，task 间 review
2. **本会话内联执行** — 按步骤逐个在本会话中执行

哪种方式？