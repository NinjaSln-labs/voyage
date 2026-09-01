<div align="center">

# 行舟 · Voyage

> **潮平两岸阔，风正一帆悬** · *Smooth Sailing*
> 把**运维能力民主化**的 AI 运维平台：听得懂大白话，指挥得了系统。

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs Audit](https://img.shields.io/badge/Docs%20Audit-100%2F100-brightgreen)](PRODUCT-DOC-AUDIT.md)
[![Security](https://img.shields.io/badge/Security%20RB%20Converged-%E2%9C%93-success)](AI红蓝对抗报告.md)
[![Tests](https://img.shields.io/badge/Tests-388-green)](impl/)

**[English](README.en.md)** | 中文

</div>

---

## 简介

**行舟（xíng zhōu）**——"行"=运行/执行（运维本体），"舟"=系统之舟；出处：王湾《次北固山下》「客路青山外，**行舟绿水前**」。

把**运维能力民主化**的 AI 运维平台：听得懂大白话，指挥得了系统。

- **一句话目标**：让 SRE、研发、测试/产品、管理者都用自然语言**安全地**完成查询与受限操作。
- **全球定位对位**：同类 Agentic AIOps 都服务 on-call 工程师；行舟服务「**不敢碰运维的人**」——差异化 = **口语化低门槛 × 零信任审批**。
- **护城河**：执行 + 信任审批（查询/问答层正被云厂商免费化，差异化压在执行与信任）。
- **五层架构**：感知（可观测）→ 决策（主 Agent）→ 知识（RAG）→ 执行（副 Agent 群）→ 整合（统一网关 + 零信任）。
- **模型中立**：云 API 优先 · 本地兜底 · 私有化（敏感不出域），全配置化切换。

## 当前状态

| 域 | 状态 |
|----|------|
| 文档集 `docs/`（9 份） | ✅ 终版 · 审计 100/100 |
| 安全红蓝对抗 | ✅ 十轮收敛（96 处修复固化） |
| M0~M6 领域实现 | ✅ 全部落地（基线/选型/DDD 设计 + 观测 + 对话 + 信任 + 执行 + 整合审计 + 内测走查） |
| 真实部署适配器 | ✅ 审计持久化 · 身份/资产仓储 · SSH 被管机执行 · 模型接入（多供应商）· 认证（mTLS/WebAuthn/JWT）· 组合根装配 |
| 端到端验证 | ✅ real 链实测：云端意图 → 双人审批 → Grant → 真实 SSH → 审计落盘 |

## 目录结构

| 目录/文件 | 内容 |
|-----------|------|
| `docs/` | 产品说明书 · 需求说明书 · 0-1 计划 · 指标口径 · AI 评测策略 · DoD 门禁 · 用户画像 · 产品原则 · 路线图 |
| `impl/m0-*` ~ `impl/m6` | 各里程碑领域模型与契约测试（零依赖纯 JS + node:test） |
| `impl/m5/src/repo/` | 身份/资产真实仓储 + 云台账投影 |
| `impl/m5/src/exec/` | SSH 被管机执行适配器 |
| `impl/m5/src/model/` | 供应商无关模型层 + 多供应商适配器 |
| `impl/m5/src/auth/` | 认证适配器（mTLS / WebAuthn / JWT） |
| `impl/m5/src/compose.js` | 组合根（mock/real 双模式装配） |
| `impl/m6/ADAPTER-CONTRACTS.md` | 六类真实适配器契约 |
| `AI红蓝对抗报告.md` | 十轮红蓝对抗史（安全完备性） |


## 开发

```bash
# 全量契约测试（零依赖，Node ≥20，node:test 内置）
find impl -name "*.test.js" | xargs -I{} sh -c 'cd $(dirname {}); node --test $(basename {})'
# → 387 pass + 1 条件跳过（real SSH E2E 需 VOYAGE_E2E_REAL=1 + 本机私钥）

# real 模式端到端冒烟（可选：需 ~/.ssh 私钥 + 云服务器台账）
VOYAGE_E2E_REAL=1 node --test impl/m5/test/e2e-real.test.js
```

## Git

- 分支 `main`；提交规范 Conventional Commits。

## License

[MIT](LICENSE) © 2026 NinjaSln-labs
