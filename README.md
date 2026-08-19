<div align="center">

# 行舟 · Voyage

> **潮平两岸阔，风正一帆悬** · *Smooth Sailing*
> 把**运维能力民主化**的 AI 运维平台：听得懂大白话，指挥得了系统。
> *An AIOps platform that democratizes operations — plain-language in, safe control out.*

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Audit 100/100](https://img.shields.io/badge/Docs%20Audit-100%2F100-brightgreen)](PRODUCT-DOC-AUDIT.md)
[![Red-Blue Converged](https://img.shields.io/badge/Security%20RB%20Converged-%E2%9C%93-success)](AI红蓝对抗报告.md)
[![Tests 78/78](https://img.shields.io/badge/Contract%20Tests-78%2F78-green)](impl/)

</div>

---

## 简介 · About

**行舟（xíng zhōu）**——"行"=运行/执行（运维本体），"舟"=系统之舟；出处：王湾《次北固山下》「客路青山外，**行舟绿水前**」。
**Voyage**——远航；与"行舟"词根对位，读来即"系统之远航"。

- **一句话目标**：让 SRE、研发、产品、管理者都用自然语言**安全地**完成查询与受限操作。
- **全球定位对位**：同类 Agentic AIOps 都服务 on-call 工程师；行舟服务「**不敢碰运维的人**」——差异化 = **口语化低门槛 × 零信任审批**。
- **护城河**：执行 + 信任审批（查询/问答层正被云厂商免费化，差异化压在执行与信任）。
- **五层架构**：感知（可观测）→ 决策（主 Agent）→ 知识（RAG）→ 执行（副 Agent 群）→ 整合（统一网关 + 零信任）。
- **模型中立**：云 API 优先 · 本地兜底 · 私有化（敏感不出域），全配置化切换。

> One-line goal: let SRE, engineers, QA, and managers complete **query & restricted operations safely in plain language**.
> Global positioning: while Agentic AIOps serves on-call engineers, **Voyage serves those who "dare not touch ops"** — differentiation = plain-language low barrier × zero-trust approval.
> Moat: **execution + trusted approval** (query/QA layers are being commoditized by cloud vendors).

---

## 目录结构 · Repository Layout

| 目录/文件 | 内容 | 状态 |
|-----------|------|------|
| `docs/` | 产品/项目终版文档集（产品说明书 · 需求说明书 · 0-1 计划 · 指标口径 · AI 评测 · DoD 门禁 · 用户画像 · 产品原则 · 路线图） | ✅ 终版（审计 100/100） |
| `impl/` | 实施工作区：M0 基线/选型/DDD 设计 + M1 观测 + M2 对话 + M3 信任（领域模型与契约测试） | ✅ 78 测试全绿 |
| `AI红蓝对抗报告.md` | 十轮红蓝对抗史：96 处修复、收敛裁定（安全完备性） | ✅ 收敛 |
| `PRODUCT-DOC-AUDIT.md` | 文档集三层审计报告 | ✅ 100/100 |

> `docs/` — product & project final docs (specs, 0-1 plan, metrics, eval, DoD, personas, principles, roadmap).
> `impl/` — implementation workspace: M0 baseline/selection/DDD design + M1 obs + M2 conv + M3 trust domain models with contract tests.

---

## 当前状态 · Status

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| M0 基线 / M0-T 选型 / M0-D DDD 设计 | 度量建档 · 评测集 · 42 不变量设计（严格审计收敛） | ✅ |
| **M1 观测底座**（C7） | 资产可观测：指标/日志/健康（数据非指令 · 密级 fail-closed） | ✅ 25 测试 |
| **M2 口语对话层**（C1/C3/C4/C13） | 意图服务端重分类 · 术语表 · 摘要压缩（对抗性输入防线） | ✅ 36 测试 |
| **M3 信任模型**（C10/C11/C12） | 双人审批 · Grant · 聚合判定 · 四层准入（R1–R3） | ✅ 17 测试 |
| **M4 执行闭环**（C8/C9/C2） | 作业聚合 · standing Grant 挂起 · 定时任务 | ⬜ 待推进 |
| **M5 整合入口 + 审计**（C14–C16） | 统一网关 · 认证 · 审计五元组 | ⬜ 待推进 |
| **M6 内测上线** | 四角色端到端 · 反指标 0 · 评测门禁 | ⬜ 待推进 |

- **文档就绪度**：100/100（`PRODUCT-DOC-AUDIT.md`，含对抗后重审）
- **安全完备性**：十轮红蓝对抗收敛（96 处修复固化进文档与设计）
- **质量基调**：对抗性输入 / 生产健壮性 / 事件协议 / 资源上限——每里程碑默认标准（`impl/完美收官-质量基调.md`）

---

## 路线图 · Roadmap

> 完整计划见 [`docs/产品0-1计划.md`](docs/产品0-1计划.md)（阶段/里程碑/依赖 DAG/退出条件）。
> *Full plan: docs/产品0-1计划.md (phases, milestones, dependency DAG, exit criteria).*

```
阶段 A（Now）  M0 基线 → M1 观测 → M2 口语对话层        ← 当前
阶段 B（Next） M3 信任 → M4 执行闭环 → M5 整合入口+审计
阶段 C（收口） M6 内测上线（反指标 0 + 评测门禁通过）
```

**依赖铁律**：信任域（M3）必须先于执行闭环（M4）；审计（M5）随任意可写操作一并上线，不后置。

**0-1 终点（「1」）**：四类角色经统一入口，用自然语言完成**查询 / 知识问答 / 受限执行**，高危操作走**双人审批**，全链路**审计留痕**；DoD（Now+Next）全过、反指标 = 0、评测门禁通过。

**Later（1→N）**：多模型智能路由梯度放量 · FAQ/案例自进化 · 生产经营。

---

## 开发 · Development

```bash
# 领域契约测试（零依赖，node:test 内置）
cd impl/m1 && node --test test/obs.test.js
cd impl/m2 && node --test test/conv.test.js
cd impl/m3 && node --test test/trust.test.js

# 一次性全量
find impl -name "*.test.js" | xargs -I{} sh -c 'echo "== {}"; cd $(dirname {}); node --test $(basename {})'
```

## Git

- 分支：`main`；提交规范：Conventional Commits（`feat:`/`fix:`/`docs:`/`test:`/`refactor:`）

## License

[MIT](LICENSE) © 2026 NinjaSln-labs
