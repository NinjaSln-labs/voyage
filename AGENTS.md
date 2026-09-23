# AGENTS

AI 运维平台：口语化低门槛接入、零信任审批链路。人类向介绍见 `README.md`。

## 通用规则

1. 凭据值与本机绝对路径不进仓库与文档（模型 API Key 经注入不落盘）；提交前 `git grep` 自查。
2. 新增 npm 依赖先批准并注明理由（核心领域层保持零依赖）。
3. 重大改动先审后提交，走双轴审计。
4. 漏洞走私密渠道反馈，不公开披露。

## 命令

```bash
# 验证链：全量测试，零依赖；skip 1 为 e2e-real（需注入真实凭据，非缺陷）
find impl -name "*.test.js" | xargs -I{} sh -c 'cd $(dirname {}); node --test $(basename {})'

# 交接门禁：不过不得前进
python3 /home/shadow/.agents/skills/project-handoff/scripts/handoff.py check
```

## 提交

用 Conventional Commits 前缀 + 中文描述，scope 用模块名：`feat(model):` / `fix(sim):` / `docs:` / `test:` / `refactor:` / `chore:`。提交前跑验证链并全绿；FAIL 修根因，确需 `--no-verify` 在说明注明原因。版本号唯一源见 `CHANGELOG.md`，发版用 `docs(release):` 并回填。

## 内容落位

1. 介绍与需求 → `README.md` → `docs/产品说明书-终版.md` → `docs/需求说明书-终版.md`；架构决策 → `docs/decisions/ADR-*.md`。
2. 代码审计 → `impl/审计记录-*.md`。
3. 未决项、坑、运维命令、未能确认 → `.handoff/`，只经 `handoff` CLI 写（`check` / `view` / `close`）。
4. 新坑记 `.handoff/pitfalls/`，确认修复后 `close` 迁 `.handoff/closed/`。
5. `.handoff/`、`.skill-fit/`、`.githooks/`、`docs/云服务器需求/` 不入 git，更新不提交；旧交接模型在 `.handoff/legacy/`，读但不删。
