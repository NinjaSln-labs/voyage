# AGENTS

AI 运维平台：口语化低门槛接入、零信任审批链路。人类向介绍见 `README.md`。

## 通用规则

1. 提交前跑完整验证链并全绿；FAIL 修根因，确需 `--no-verify` 在提交说明注明原因。
2. 写代码前读 `impl/m6/ADAPTER-CONTRACTS.md`（六类适配器契约）与 `impl/m0-d/DDD设计.md`（42 不变量），测试 stub 按真实契约形状写（不猜 API）。
3. 模型 API Key 经注入不落盘，凭据值不进仓库与文档；本机绝对路径、个人邮箱、token、会过时的部署实况同样不入库。提交前 `git grep` 自查。
4. 新增 npm 依赖需你批准并注明理由（核心领域层保持零依赖）。
5. 重大改动走双轴审计：先审后提交，审计件落 `impl/审计记录-*.md`；架构决策走 `docs/decisions/ADR-*.md`。
6. 漏洞不公开披露，走私密渠道反馈维护者。

## 命令

```bash
# 验证链：全量测试，零依赖，输出末行汇总（Node ≥20，无 npm install）
find impl -name "*.test.js" | xargs -I{} sh -c 'cd $(dirname {}); node --test $(basename {})'

# 交接门禁：9 槽齐 + index 一致 + id 唯一 + next 有效，不过不得前进
python3 /home/shadow/.agents/skills/project-handoff/scripts/handoff.py check
```

验证链含 1 个 skip（`e2e-real`，需 `VOYAGE_E2E_REAL=1` 与真实凭据，非缺陷）。内测环境（oracle-arm-1）命令在 `.handoff/commands/`，不在此重复。

## 内容落位

1. 人类向介绍（项目是什么、怎么装）→ `README.md` → `docs/产品说明书-终版.md` → `docs/需求说明书-终版.md`。
2. 架构决策 → `docs/decisions/ADR-*.md`；行为或接口变化同步 README 与 `docs/`，发版用 `docs(release):` 并回填 `CHANGELOG.md`。
3. 代码审计 → `impl/审计记录-*.md`。
4. 未决项、坑、运维命令、决策、未能确认 → `.handoff/`，只经 `handoff` CLI 写，勿手搓。
5. 新坑记 `.handoff/pitfalls/`；确认修复后 `handoff close` 迁 `.handoff/closed/`。
6. `.handoff/`、`.githooks/`、`.skill-fit/` 不入 git（`.gitignore` 已挡），更新不提交。旧模型文件在 `.handoff/legacy/`，读但不删。

## 提交

用 Conventional Commits 前缀 + 中文描述：`feat(model):` / `fix(sim):` / `docs:` / `test:` / `refactor:` / `chore:`；scope 用模块名。不用历史提交里的非规范类型（如 `tune`）。版本号唯一源见 `CHANGELOG.md`。
