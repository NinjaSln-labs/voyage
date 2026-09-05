# AGENTS（AI 协作与工程纪律）— 行舟 · Voyage

> AI 运维平台：把运维能力民主化——口语化低门槛 × 零信任审批（AIOps democratized）。
> 本文件是本仓 AI 协作守则；人工协作者同样适用。详细架构/需求见 `docs/`（入口：`README.md` → `docs/产品说明书-终版.md` → `docs/需求说明书-终版.md`）。

## 项目概览

- **定位**：AI 运维平台，核心领域层**零依赖**（纯 JS + Node ≥20 内置 `node:test`），可解释、可审计的零信任审批链路。
- **仓库根即工程根**；分支、提交、验证规范见下。本仓无 `package.json`（零依赖设计），无锁文件——**这是有意取舍，不是疏漏**。
- **交接约定**：HANDOFF.md / `.githooks/` / `HANDOFF-ARCHIVE/` 为**本地私有，不入 git**（`.gitignore` 已挡），更新不提交。

## 提交规范

- **Conventional Commits 前缀 + 中文描述**：`feat(scope):` / `fix(scope):` / `docs:` / `test:` / `refactor:` / `chore:`；scope 用模块名（如 `model`/`sim`/`redteam`/`auth`/`deploy`）。**只用标准类型**——历史提交里的 `tune` 非规范类型，新提交避免使用。
- **提交前必须跑本仓验证链并全绿**（命令见下）。FAIL 修根因，不绕过；确需 `--no-verify` 必须在提交说明注明原因。
- 版本发布用 `docs(release):` + CHANGELOG 回填（当前 `v0.9.0-alpha`）。

## AI 协作守则（agent 贡献者必读）

1. **不猜 API/契约**：写代码前读 `impl/m6/ADAPTER-CONTRACTS.md`（六类适配器契约）与 `impl/m0-d/DDD设计.md`（42 不变量）；测试 stub 必须按真实契约形状写。
2. **完成的定义 = 验证链全绿 + 实机/测试验收**，不是"代码写完"；声称完成前附验证输出。
3. **机密红线**：本机绝对路径、个人邮箱、token/密钥、会过时的部署实况一律不入库；模型 API Key 经注入不落盘，不入仓库与文档。提交前 `git grep` 自查（`HANDOFF.md` §1 有凭据路径清单，只引用不写值）。
4. **不静默绕过门禁**：pre-commit/测试 FAIL 先修根因；确需跳过必须留痕注明。
5. **改动最小化**：不顺手重构、不改无关文件；核心领域层保持零依赖，新增 npm 依赖需显式批准并注明理由。
6. **文档同步**：行为/接口变化同步 README、`docs/`、CHANGELOG（如有）；架构决策走 `docs/decisions/ADR-*.md`。
7. **审计纪律**：重大改动按本仓双轴审计惯例（先审后提交，`impl/审计记录-*.md`）；新坑记录回 HANDOFF §4，确认修复即迁 `HANDOFF-ARCHIVE/pits.md`。

## 验证链（单源）

```bash
# 全量测试（零依赖，预期 526 pass / 0 fail / 1 skip）
find impl -name "*.test.js" | xargs -I{} sh -c 'cd $(dirname {}); node --test $(basename {})'
```

- `1 skip` 为 e2e-real，需 `VOYAGE_E2E_REAL=1` + 真实凭据才跑，非缺陷。
- 内测环境（oracle-arm-1）运维命令见 HANDOFF §4，不在此重复。

## 安全考虑

- 漏洞**不要**公开披露：走私密渠道向维护者反馈（GitHub issues 私密/邮件）。
- 依赖与 CI action 升级走仓库既定流程；新增 npm 依赖需在 PR 说明给出理由（当前仅 `@simplewebauthn/server`，限定 WebAuthn 验签点）。
- 凭据（模型 API Key、SSH 私钥）只从 HANDOFF §1 指定来源索取，不搜索代码/配置硬猜。
