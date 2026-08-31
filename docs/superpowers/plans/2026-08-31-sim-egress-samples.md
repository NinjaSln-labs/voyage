# sim 生成器加 egress 样本实施计划

> **For agentic workers:** 每个任务完成后必须经过：全量测试（0 失败）→ 子代理审计 → 提交，三道门全部通过后才进入下一任务。

**Goal:** 在 `simulate-traffic.js` 的提示词中增加 egress 类意图生成要求，让影子流量覆盖 egress 类别，使 egress 审批流在自动化链中得到验证。

**Architecture:** 只改 `simulate-traffic.js` 的提示词构造——在 sre-c（谨慎型运维）和 dev-bob（开发新手）人格的生成提示词中，加入 egress 类意图示例。生成的文本会包含外传关键词（如"发给我""微信"），确定性规则层（P1）会自动覆写 `actionClass=egress`，走审批流。

**Tech Stack:** Node.js 24, node:test, 零依赖

**前置条件:** P1 确定性规则层已实现（`ea21f54`），关键词覆写已生效。

---

## 文件结构

| 文件 | 改动类型 | 职责 |
|------|---------|------|
| `impl/m5/scripts/simulate-traffic.js` | 修改 | `buildPromptForPersona` 中加 egress 示例 |
| `impl/m5/test/simulate-traffic.test.js` | 修改 | 验证 egress 相关提示词内容 |

---

### Task 1: sim 提示词加 egress 样本

**Files:**
- Modify: `impl/m5/scripts/simulate-traffic.js`（`buildPromptForPersona` 函数）
- Test: `impl/m5/test/simulate-traffic.test.js`（新增 egress 断言）

**Interfaces:**
- Consumes: `buildPromptForPersona(persona, n, avoidHint)`——已有函数
- Produces: 生成的提示词中包含 egress 类意图示例，使 LLM 输出含外传关键词的文本

- [ ] **Step 1: 读当前文件确认改点**

```bash
cd /home/shadow/ninjasin-labs/Voyage && grep -n "buildPromptForPersona\|paramConstraint\|isDevBob" impl/m5/scripts/simulate-traffic.js
```

- [ ] **Step 2: 修改 `buildPromptForPersona` 的 `paramConstraint`**

当前逻辑：SRE 人格要求 execute 意图带完整参数；dev-bob 人格保持参数不完整。

新增：在 `paramConstraint` 中加入 egress 类意图生成要求——对 sre-c（谨慎型运维）和 dev-bob（开发新手）人格，要求包含外传类意图（"把日志发给我""导出配置到网盘"等）。

```js
const buildPromptForPersona = (persona, n, avoidHint) => {
  const isDevBob = persona.id === 'dev-bob';
  const isSreC = persona.id === 'sre-c';
  const paramConstraint = isDevBob
    ? '- 优先生成简短、参数不完整的自然口语，例如"清下日志""切换环境""改下配置"'
    : '- 执行类意图中，clean/config_change/env_switch 必须包含具体路径或文件参数（clean 带 /var/log/xxx，config_change 带 /etc/xxx.conf，env_switch 带 /xxx/docker-compose.yml）；restart/scale 可不带额外参数';
  const egressHint = (isDevBob || isSreC)
    ? '\n- 部分意图应为数据外传类（把日志/文件/配置发给我、发到微信、导出到网盘、下载到本地），措辞要自然如"把日志发到我微信上""导出 jd-light 的配置到网盘"'
    : '';
  return `你是运维行为模拟器。扮演：${persona.profile}。
生成 ${n} 条该角色的中文运维口语意图。
要求：
- 目标资产从这些里选：jd-light、ali-ecs-99、ctyun-x、tencent-lh、oracle-arm-1
- 平台白名单能力：restart/clean(仅限/var/log 日志路径)/scale/config_change/env_switch；查询类随意
${paramConstraint}${egressHint}
- 措辞符合人设且彼此不重复${avoidHint ? `；避免这些已有表述的换皮重复：${avoidHint}` : ''}
只输出 JSON 字符串数组。`;
};
```

注意：`isSreC` 的选择是因为 sre-c 的 profile 是"谨慎型运维，主要做日志清理、配置变更、环境切换，措辞礼貌冗长带确认语气"——这种人格生成外传意图（"请把日志发给我"）自然合理。

- [ ] **Step 3: 更新 `simulate-traffic.test.js`**

添加 egress 相关测试：

```js
test('sre-c 人格提示词包含数据外传类意图要求', () => {
  const prompt = buildPromptForPersona(
    { id: 'sre-c', profile: '谨慎型运维，主要做日志清理、配置变更、环境切换' },
    6, null
  );
  assert.ok(prompt.includes('数据外传'), 'sre-c 应包含数据外传要求');
  assert.ok(prompt.includes('把日志发到我微信上'), 'sre-c 应有 egress 示例');
});

test('dev-bob 人格提示词包含数据外传类意图要求', () => {
  const prompt = buildPromptForPersona(
    { id: 'dev-bob', profile: '开发新手，口语化严重' },
    6, null
  );
  assert.ok(prompt.includes('数据外传'), 'dev-bob 应包含数据外传要求');
});

test('sre-alice 人格提示词不含数据外传类意图要求', () => {
  const prompt = buildPromptForPersona(
    { id: 'sre-alice', profile: '资深 SRE，指令简洁专业' },
    6, null
  );
  assert.ok(!prompt.includes('数据外传'), 'sre-alice 不应包含数据外传要求');
});
```

- [ ] **Step 4: 运行测试**

```bash
cd /home/shadow/ninjasin-labs/Voyage && node --test impl/m5/test/simulate-traffic.test.js
```
Expected: 8 tests pass（原有 4 个 + 新增 3 个 + 1 个已有 sre-alice 测试）。

- [ ] **Step 5: 全量测试**

```bash
cd /home/shadow/ninjasin-labs/Voyage && find impl -name "*.test.js" -exec sh -c 'cd "$(dirname "$1")" && node --test "$(basename "$1")" 2>&1 | grep -E "^(✗|ℹ fail [1-9])"' _ {} \; 2>&1 | head -5
```
Expected: 无输出（0 失败）。

- [ ] **Step 6: 子代理审计**

派独立子代理审计：

```
审计 `impl/m5/scripts/simulate-traffic.js` 的 buildPromptForPersona 改动：
1. egress 样本是否只加在 sre-c 和 dev-bob 人格（sre-alice/sre-b 不加，避免过度干扰 sim 数据分布）
2. egress 示例措辞是否自然（"把日志发到我微信上""导出配置到网盘"）
3. 生成的 egress 意图是否包含确定性规则层的关键词（如"发给我""微信"）
```

- [ ] **Step 7: 同步到服务器**

```bash
rsync -avz -e "ssh -i $HOME/.ssh/oracle_tokyo -p 22022" \
  impl/m5/scripts/simulate-traffic.js \
  ubuntu@161.33.159.216:/opt/voyage/impl/m5/scripts/
```

- [ ] **Step 8: 提交**

```bash
git add impl/m5/scripts/simulate-traffic.js impl/m5/test/simulate-traffic.test.js
git commit -m "feat(sim): 生成器加 egress 类别（sre-c/dev-bob 人格），影子流量覆盖外传审批"
```

---

## 质量门禁

| 门禁 | 标准 | 检查方式 |
|------|------|---------|
| 单元测试 | simulate-traffic.test.js 全部通过（旧 4 + 新 3 = 7） | `node --test impl/m5/test/simulate-traffic.test.js` |
| 全量测试 | 0 失败 | `find impl -name "*.test.js" -exec ...` |
| 子代理审计 | 提示词设计合理、关键词覆盖 | 独立 agent 审查 |
| 部署验证 | 下一轮 sim 生成时 egress 意图进入审计 | 查看 sim.log + audit.jsonl |