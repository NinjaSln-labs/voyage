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

## 交接

<!-- handoff:begin -->
- 接手先跑 `handoff check`（相位门禁，rc≠0 就别往下走），再 `handoff view` 看全局、`handoff next --auto` 取下一步——**`--auto` 才会按补位策略落指针**，光 `handoff next` 是读写入口。
- 条目只经 `handoff` CLI 写——**日期与 id 由脚本盖章／分配，命令行上根本没有这两个参数**，别自填、也别手改文件（手改会被 `check` 的写入对账抓住，含「同字节覆写后补手续」）。
- 待办的**完成判据满足时立刻 `handoff close`**——先落账再进版本；一批活拆多次提交、或结论要复验才定终态时，以**判据满足**为准，不以提交次数为准。
- 旧的交接内容**只归档不删**：`close` 迁 `closed/`、`append`／`compact` 把热层旧班段挤进 `archive/` 冷档、真要移除只走 `rm`（落 `trash/`＋记 `void` 防 id 复用）。
- 收尾跑 `handoff check`：`rc=0` 只代表**可机械判定的部分**没问题，不代表散文里的结论是实况。
- 本轮有实质改动（闭条目／开条目／换 next）时刷新 `handoff exit`；它是给下一班的**陈述**，不是历史记录。**追加新班段用 `handoff append`**（旧班段自动搬冷档，热层只留最新一节）；改现有内容用 `set`（整槽覆写、无追加语义，先 `--dry-run` 看将丢哪些行）。
- `check` 报「写入之前发现被改动过」而你确信没手改：**先核对**那几个文件确实没被手改，再 `handoff rebase --force` 对齐基线——它逐条打印「已结案」清单且**不可追回**，所以核对在前。
- 提及已闭条目时写 `t000095（已闭）` 这类显式标记——已闭与未闭不能靠读者推断。
<!-- handoff:freshness:begin -->

<!-- 增强档 A：fresh-queue／fresh-stale 两维**已随技能下沉**（`handoff check` 自带），
     抄这段 = 抄一条人人可执行的指令，没有「抄了却没装判据」的问题。 -->
- `handoff check` 另有两道新鲜度闸：未销账的条目在 `exit`/`summary` 里**沉默** ⇒ 红；把已闭条目写成候立、缺 `（已闭）` 这类显式标记 ⇒ 红。**收尾不跑这两道，事后没有第二条路能发现**——`exit` 写进去之后就定格，库里不会自己变红。
<!-- handoff:freshness:end -->
<!-- handoff:end -->
