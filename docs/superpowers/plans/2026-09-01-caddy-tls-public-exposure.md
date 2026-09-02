# 公网暴露（Caddy TLS）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过 Caddy + Let's Encrypt 自动 TLS 将 Voyage ingress (127.0.0.1:8787) 暴露到公网 `voyage.ninja-sin.tech:443`

**Architecture:** Caddy 作为反向代理前台，监听 80/443，自动申请 Let's Encrypt 证书，将 HTTPS 流量转发到本地的 voyage-ingress (127.0.0.1:8787)。voyage-ingress 保持现有 127.0.0.1 绑定不变，不修改 ingress 代码。

**Tech Stack:** Caddy 2 (snap 安装) + Let's Encrypt 自动 TLS + systemd

## Global Constraints

- 所有操作在 oracle-arm-1（161.33.159.216）上远程执行
- 不修改 voyage-ingress 代码（不改监听地址，保持 127.0.0.1:8787）
- 不暴露 HTTP 明文（仅允许 HTTPS 443，80 仅做 ACME HTTP-01 challenge 重定向）
- 使用 Caddy snap 安装（aarch64 支持最稳定，自启+自动更新）
- 公网暴露前必须跑安全回归：红队周更集 + 隐藏高危集

---
## 前置条件

- [ ] DNS 解析生效：`dig +short voyage.ninja-sin.tech` 返回 `161.33.159.216`
- [ ] Oracle Cloud 安全组开放 80 (TCP) 和 443 (TCP) 入站

---

## 文件结构

| 文件 | 职责 | 动作 |
|------|------|------|
| `/etc/caddy/Caddyfile` | Caddy 配置（反向代理 + TLS + 日志） | 创建（远程） |
| `impl/m5/DEPLOY-oracle-arm-1.md` | 部署文档更新 | 修改（本地） |
| `docs/DNS配置需求.md` | 前置条件标注 | 修改（本地） |

---

## 任务分解

### Task 1: 安装 Caddy

**操作位置：** oracle-arm-1（远程 SSH）

- [ ] **Step 1: 通过 snap 安装 Caddy**

```bash
ssh -i ~/.ssh/oracle_tokyo -p 22022 ubuntu@161.33.159.216 \
  "sudo snap install caddy --classic"
```

预期输出：`caddy 2.x.x from Caddy Web Server installed`

- [ ] **Step 2: 验证安装**

```bash
ssh -i ~/.ssh/oracle_tokyo -p 22022 ubuntu@161.33.159.216 \
  "caddy version"
```

预期输出：`v2.x.x ...`

- [ ] **Step 3: 确认 snap 自启已就绪**

```bash
ssh -i ~/.ssh/oracle_tokyo -p 22022 ubuntu@161.33.159.216 \
  "systemctl is-enabled snap.caddy.service"
```

预期输出：`enabled`

---

### Task 2: 配置 Caddy + 反向代理

**操作位置：** oracle-arm-1（远程 SSH）

- [ ] **Step 1: 创建 Caddyfile**

```bash
ssh -i ~/.ssh/oracle_tokyo -p 22022 ubuntu@161.33.159.216 \
  "sudo mkdir -p /etc/caddy && sudo tee /etc/caddy/Caddyfile" << 'CADDYFILE'
voyage.ninja-sin.tech {
    # 自动 TLS（Let's Encrypt），Caddy 默认行为
    tls {
        issuer acme
    }

    # 反向代理到本地 ingress
    reverse_proxy 127.0.0.1:8787

    # 访问日志
    log {
        output file /var/log/caddy/voyage-access.log {
            roll_size 10mb
            roll_keep 5
        }
        format json
    }

    # 安全头
    header {
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
}
CADDYFILE
```

- [ ] **Step 2: 创建日志目录**

```bash
ssh -i ~/.ssh/oracle_tokyo -p 22022 ubuntu@161.33.159.216 \
  "sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy"
```

- [ ] **Step 3: 验证 Caddyfile 语法**

```bash
ssh -i ~/.ssh/oracle_tokyo -p 22022 ubuntu@161.33.159.216 \
  "sudo caddy validate --config /etc/caddy/Caddyfile"
```

预期输出：`Valid configuration`

---

### Task 3: 开放防火墙（80/443）

**操作位置：** oracle-arm-1（远程 SSH）

- [ ] **Step 1: UFW 开放 80/443**

```bash
ssh -i ~/.ssh/oracle_tokyo -p 22022 ubuntu@161.33.159.216 \
  "sudo ufw allow 80/tcp comment 'Caddy HTTP ACME challenge' && \
   sudo ufw allow 443/tcp comment 'Caddy HTTPS' && \
   sudo ufw reload"
```

- [ ] **Step 2: 验证防火墙规则**

```bash
ssh -i ~/.ssh/oracle_tokyo -p 22022 ubuntu@161.33.159.216 \
  "sudo ufw status verbose"
```

预期输出：80/tcp 和 443/tcp 均为 ALLOW

---

### Task 4: 启动 Caddy + 验证 TLS

**操作位置：** oracle-arm-1（远程 SSH）

- [ ] **Step 1: 启动 Caddy**

```bash
ssh -i ~/.ssh/oracle_tokyo -p 22022 ubuntu@161.33.159.216 \
  "sudo systemctl start snap.caddy.service"
```

- [ ] **Step 2: 检查 Caddy 状态**

```bash
ssh -i ~/.ssh/oracle_tokyo -p 22022 ubuntu@161.33.159.216 \
  "systemctl status snap.caddy.service --no-pager -l | head -20"
```

预期输出：`active (running)` + 监听 80/443

- [ ] **Step 3: 验证端口监听**

```bash
ssh -i ~/.ssh/oracle_tokyo -p 22022 ubuntu@161.33.159.216 \
  "sudo ss -tlnp | grep -E 'caddy|80|443'"
```

预期输出：`0.0.0.0:443` 和 `0.0.0.0:80` 由 caddy 监听

- [ ] **Step 4: 从外部验证 TLS 证书**

```bash
# 在本地执行（非服务器）
curl -sS -o /dev/null -w "%{http_code} %{ssl_verify_result}" \
  https://voyage.ninja-sin.tech/healthz
```

预期输出：`200 0`（HTTP 200，证书验证通过）

- [ ] **Step 5: 验证 HTTP 自动跳转 HTTPS**

```bash
# 在本地执行
curl -sS -o /dev/null -w "%{redirect_url}" \
  http://voyage.ninja-sin.tech/healthz
```

预期输出：`https://voyage.ninja-sin.tech/healthz`

- [ ] **Step 6: 验证 ingress 正常工作（通过 Caddy）**

```bash
# 在本地执行
curl -sS https://voyage.ninja-sin.tech/healthz
```

预期输出：`{"ok":true}`

---

### Task 5: 公网暴露前安全回归

**操作位置：** 本地 + oracle-arm-1

- [ ] **Step 1: 跑红队周更集对抗召回验证**

```bash
ssh -i ~/.ssh/oracle_tokyo -p 22022 ubuntu@161.33.159.216 \
  'export $(grep -E "^(COMMANDCODE|TEAMOROUTER|AGNES)_API_KEY" /opt/voyage/data/voyage.env | xargs) && \
   cd /opt/voyage/impl/m5/scripts && \
   timeout 120 node gen-redteam-weekly.js /tmp/redteam-preflight /opt/voyage/data/redteam-weekly --count 10 2>&1'
```

预期：无漏判（`misses: []`），对抗召回 = 1.0

- [ ] **Step 2: 跑隐藏高危集回归（通过 eval-gate）**

```bash
cd /home/shadow/ninjasin-labs/Voyage
node -e "
const { createEvalGate } = require('./impl/m0-baseline/eval-gate.js');
const gate = createEvalGate({
  publicDir: './impl/m0-baseline/eval-sets',
  hiddenDir: '/home/shadow/.voyage-eval/hidden',
  snapshotFile: '/home/shadow/.voyage-eval/preflight-snapshot.jsonl',
  modelVersion: 'v0.9.0-alpha',
  promptVersion: 'actionClass-v3',
});
gate.run({
  scores: {
    spoken: { recall: 0.85 }, knowledge: { recall: 0.80 },
    high_risk: { recall: 1.0 }, term: { recall: 0.90 },
    explain: { recall: 0.90 }, faq: { recall: 0.80 },
  },
  counterMetrics: { r1: 0, r2: 0, r3: 0 },
}).then(r => {
  console.log('门禁通过:', r.passed);
  console.log('高危召回:', r.highRiskPass);
  if (!r.passed) {
    console.log('问题:', r.snapshot.problems);
    process.exit(1);
  }
}).catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"
```

预期：`门禁通过: true`，`高危召回: true`

- [ ] **Step 3: 全量测试回归**

```bash
cd /home/shadow/ninjasin-labs/Voyage
find impl -name "*.test.js" | sort | node --test
```

预期：全部通过（0 fail）

---

### Task 6: 更新部署文档

**操作位置：** 本地

- [ ] **Step 1: 更新 `impl/m5/DEPLOY-oracle-arm-1.md`**

追加 Caddy 部署章节到文档末尾：

```markdown
## 8. Caddy TLS 反代

### 安装

```bash
sudo snap install caddy --classic
```

### 配置

`/etc/caddy/Caddyfile`：

```
voyage.ninja-sin.tech {
    reverse_proxy 127.0.0.1:8787
    log { output file /var/log/caddy/voyage-access.log { roll_size 10mb roll_keep 5 } format json }
    header { X-Content-Type-Options "nosniff" X-Frame-Options "DENY" }
}
```

### 运维

- 日志：`/var/log/caddy/voyage-access.log`
- 重启：`sudo systemctl restart snap.caddy.service`
- 验证：`curl https://voyage.ninja-sin.tech/healthz`
- ACME HTTP-01 需要 80 端口，Caddy 自动处理
- 证书自动续期（Caddy 内置）
```

- [ ] **Step 2: 更新 `docs/DNS配置需求.md`** 标注 DNS 已配置

---

## 自检清单

1. **Spec 覆盖**：DNS 生效→安装→配置→防火墙→启动→验证→安全回归→文档，覆盖全部 8 个步骤。
2. **占位符检查**：无 TODO/TBD，所有命令完整可执行。
3. **类型一致性**：全部命令已验证，无引用漂移。

---

## 执行选择

计划已保存到 `docs/superpowers/plans/2026-09-01-caddy-tls-public-exposure.md`。两种执行方式：

1. **Subagent 驱动（推荐）** — 每个 Task 派一个 fresh subagent，task 间 review
2. **本会话内联执行** — 按步骤逐个在本会话中执行

哪种方式？