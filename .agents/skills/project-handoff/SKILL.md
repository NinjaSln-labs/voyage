---
name: project-handoff
description: >-
  User-invoked only: run it when the user asks to hand off, resume, or wrap up a project —
  never on your own initiative, because it writes into the project's .handoff/ store and
  into that project's AGENTS.md handoff block. Maintain a project's handoff store
  (.handoff/, plain text): a multi-dimensional
  project handoff — status, summary, actions, pitfalls, decisions, commands, scope, exit,
  plus a machine-checked read-back — with a next-step pointer, driven by a script-enforced
  `handoff` CLI (single write path, coverage statement). Use when handing off between
  sessions or tools, or resuming or continuing prior work on a project. Initializing a
  new project's store or migrating an old HANDOFF.md model is done only when the user
  explicitly asks. NOT for: ephemeral scratch notes, work outside a project, or a
  mid-project experiment/spike handed off from a sandbox — that is experiment-handoff.
version: 5.73.1
metadata:
  changelog-repo: design/project-handoff/version-history.md
  slug: project-handoff
  displayName: project-handoff
  disable-model-invocation: true
---

# 项目交接（Project Handoff · v3 存储模型）

> **本文是路由器**：只放**任一相位都必须先知道的**东西（规则清单 ＋ 去向）。**为什么**见
> `references/rules.md`；**要下命令**见 `references/cli.md`（含判据清单）；**报错怎么修**见
> `references/failures.md`。别在本文里找命令。

## 角色

维护项目**交接存储** `.handoff/`（纯文本）：一份「让接收方（agent / LLM）接得上」的**多维交接件**（**不止未决项**；槽清单见 `references/rules.md`）。条目**只经**本技能自带的 CLI 写（**单一写入口** ＋ **机检门禁**）。

- **维度闭合**：槽集合固定（清单见 `references/rules.md`）；槽外 → `unconfirmed`，**不即兴开槽**。**只记不可推导项**（可读的用指针，读不到的才记）。
- **调用权**：**仅用户调用**（`disable-model-invocation: true`）——它会改项目的 `.handoff/` 与 `AGENTS.md` 交接块；`init`／`migrate` 另需显式请求。**P1 不删 / P2 可重建 / P3 不静默**。

## 何时读哪个相位

| 意图 | 读 |
|---|---|
| 接手 / 继续之前的工作 / 新 session 进入已有项目 | `references/resume.md` |
| 交接 / 收尾 / 跨会话·跨工具移交 | `references/handoff.md` |
| 新项目 / 尚无工作存储 | `references/init.md`（**仅显式调用**）|
| **发现旧模型**（`HANDOFF.md` / `HANDOFF-ARCHIVE/` / `.handoff/fp.*`）| **先** `references/migrate.md`（一次性，**仅显式调用**）|
| **要下命令** / 想知道 `check` 判哪几条 / **命令报错** / **想知道某条规则为什么这么定** | `references/cli.md`（命令全表 ＋ 判据清单 ＋ 样例）· `references/failures.md`（按报错给修法）· `references/rules.md`（规则来由）|

## 存储（`.handoff/`，纯文本，不假设 git）

`index`（脚本生成）· `status` `summary` `scope` `exit` ＋ 四目录（`actions/` `pitfalls/` `commands/` `decisions/`）＋ `unconfirmed.jsonl` `closed/` `next` `log/`。条目键序固定（`id/created/summary/[status,blockedBy,waitingFor]/topic?/src?/detail?`），`id` 形态由脚本分配（形态见 `references/rules.md`）。**逐条语义见 `references/rules.md`。**

## 不变量（任一相位必须守）

- **P1 不删**：只追加；`closed` 永不重写；移除仅在关闭序内原子完成。
- **P2 可重建**：`index` 由脚本重建；**不生成、不落盘第二副本**。
- **P3 不静默**：每次运行输出「**读到 / 写入 / 未能确认**」；`confirm` 为**双向确认**。
- **写入只经 CLI，且绕过必被抓到**：台账记每文件「**最后一次 CLI 写入时**」的哈希 ＋ 纳秒 mtime ⇒ 手改即红；补手续由 mtime 旁证抓（**哈希为主、mtime 只在哈希相同时作旁证**）。**封存（POSIX 的内核级只读）是附加加固、不是前提**——非 POSIX 上只剩对账一道（`check` **显式提示**，不静默）。

## 硬约束（逐条说明在 `references/rules.md`）

1. **不假设** git／语言／工具／布局；需用则**先探测**。
2. **未决语义唯一落点 `.handoff/`**；别处的待办文本是**候选**，非未决项。
3. **维度闭合**：槽集合固定（清单见 `references/rules.md`），槽外 → `unconfirmed`。
4. **源登记表闭合**：**只有 `scope` 登记的源被读**；登记必须**可解析**。
5. **迁移先于交接**：有旧模型时**告知用户并请求迁移**，同意后先走 `migrate`。
6. **阻塞必须记「在等什么」**：`status=blocked` 须有 `blockedBy`（等库内 id）或 `waitingFor`（等所有者／用户／外部条件，值域 `owner`／`user`／`external:<描述>`）——**二者至少有一个**，否则 `blocked-owner` 维判红（修法：补其一即可）；等太久的这类由 `next --auto` 独立点名。
7. **判据与修复分离**：**门禁默认只读**——`check` 撞到交接块漂移／多份时只报不改（报红 ＋ 给命令），重装跑 `handoff check --repair`，痕迹落 store 事件流、**不新增退出码**。
8. **标准交接块**：`init` 把它写进**本项目**的 `AGENTS.md`（唯一源＝`references/agents-handoff-block.md`）；**不手工编辑块内条目**；被手改 ⇒ `check` 报红 ⇒ `--repair` 重装（**人写的行不删**，搬到块外仓专属区）；标记区**残缺** ⇒ 拒绝并报错。装块即记一条 d 型**事实登记** ⇒ 块被整段删掉时仍判（`block-installed` 维）。
9. **`init` 不自动装全局 PATH shim**：项目级动作不越界改机器级状态；要装显式跑 `handoff install-shim`（幂等，`--dir` 可选落位）。shim **解析式**：本仓 editable → 最近项目副本（版本跟项目）→ 用户级 → 安装来源兜底。
10. **崩溃最坏产生重复**（并发有锁兜着）；**重复不会被动西掉**——`check` 报 id 重复并给 CLI 修法。
