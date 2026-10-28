# 审计报告：project-handoff 技能描述

- 审计对象：`project-handoff/SKILL.md`（frontmatter `description`）
- 审计日期：2026-10-24
- 审计指纹：8217632230e2
- 取证位置：本次实跑直接读被审文件本体，无暂存副本
- 审计方式：description ↔ SKILL.md 正文交叉验证 + Agent Skills 描述合规检查
- 审计独立性：本次为**外派独立审计**（渠道 `command-code@z-ai/glm-5.3-flash`；本席经 `scripts/audit-independence-check.py --skill project-handoff --channel command-code@z-ai/glm-5.3-flash` 判**独立**）。B 组题面与答案空间未变，答案与引文冻结自 2026-10-22 的独立复审（codex@deepseek/deepseek-v4.1-flash · 授权 g26），本轮只重算 A 组实算值并复核受 v5.48.0 正文改动影响的 4 题（NAME-02／REF-03／VOL-02／VOL-04）：FP-01 指纹 7b6d8d55e547→6b7ed6b62543、STR-01 字母占比 30.6%→32.0%；LEN-03 仍 47 行。
- 结论：无缺陷。
<!-- report-header:begin （由 criteria-set.yaml 渲染，勿手改） -->

- 判据集版本：SDA-Q4.10
- CONF-FLOOR = 0.5

<!-- report-header:end -->

---

## 一、判据集结果

> 逐题作答，**答案须落在判据集枚举内**；`B` 组须给置信度。低置信题按「置信度与降级」处理。
>
> ⚠ **四个格子都不要写竖线 `|`**。（本报告含竖线原文的引用全部移入「八、备注」取证块。）
> ⚠ `「」` 只装被审件的逐字原文；命令输出不带引号、判词写普通散文。
> ⚠ 引公共件（catalog.yaml）原文写成 引文「…」＋该件 路径:行号。

<!-- criteria-rows:begin （由 criteria-set.yaml 渲染，勿手改） -->

| ID | 答案 | 置信 | 证据（文件:行号 / 命令输出） |
|---|---|---|---|
| WHAT-01 | 是 | 0.95 | 做什么：project-handoff/SKILL.md:6 引文「Maintain a project's handoff store」＋ project-handoff/SKILL.md:9 引文「plus a machine-checked read-back」；何时用：project-handoff/SKILL.md:4 引文「User-invoked only: run it when the user asks to hand off, resume, or wrap up a project」 |
| NAME-01 | 是 | 0.95 | project-handoff/SKILL.md:2 引文「name: project-handoff」；project-handoff/SKILL.md:6 引文「Maintain a project's handoff store」——名称域与 description 声称的项目交接域一致 |
| NAME-02 | 是 | 0.95 | project-handoff/SKILL.md:31 引文「维护项目**交接存储** `.handoff/`（纯文本）」——正文以 CLI＋门禁实做该能力 |
| SEM-02 | 否 | 0.95 | project-handoff/SKILL.md:2 引文「name: project-handoff」——name 无宿主前缀，去掉 project- 修饰后仍剩独立功能名 handoff，无宿主名挤占 |
| NAM-02 | 否 | 0.90 | ①路以 YAML 解析器取 catalog.yaml skills 节实算 95 件，仅 experiment-handoff 为近名且语义可辨（catalog.yaml:179 引文「experiment-handoff: { tier: on-demand, when: [experiment], invoke: user-only }」）；②路 environment-declaration.py --latest 取 environment-snapshot-2026-10-21.yaml，route2_extra 7 件（i-have-adhd、ponytail 族）均不争交接请求 |
| EXCL-01 | 是 | 0.92 | 形① 划界句落在 description：project-handoff/SKILL.md:13 引文「NOT for: ephemeral scratch notes, work outside a project, or a」＋ project-handoff/SKILL.md:14 引文「mid-project experiment/spike handed off from a sandbox — that is experiment-handoff.」——与 ① 路近邻 experiment-handoff 划界 |
| REF-01 | 是 | 1.00 | criteria-a-group.py 输出： description 引用文件 0 个缺失 |
| REF-02 | 是 | 1.00 | criteria-a-group.py 输出： 包内分发面件（枚举与排除表同源）：零指路 0｜仅目录级指路 0（本轮不判，留 t000188）｜上游自带件排除 0｜已定性豁免 0｜逐文件已点名者不进结果 |
| REF-03 | 是 | 0.95 | 包内分发面非 SKILL 文本 10 件全部可达：references/resume.md（project-handoff/SKILL.md:40）、handoff.md（:41）、init.md（:42）、migrate.md（:43）、cli.md／failures.md／rules.md（:44）、agents-handoff-block.md（:66）均在正文逐字点名；scripts/handoff.py 与 scripts/migrate.sh 由已点名文件一跳承接（references/resume.md:8 引文「python3 <技能>/scripts/handoff.py check」；references/migrate.md:26 引文「sh <技能>/scripts/migrate.sh」）；rules.md 的 FAQ 入口见 project-handoff/references/rules.md:98 引文「## 六、FAQ」 |
| REF-04 | 是 | 1.00 | criteria-a-group.py 当场输出： 随件文本仓根引用 0 处；distribution-surface-check --skill project-handoff 当场实算：OK（两类都干净，缺口计 0 条） |
| LEN-03 | 是 | 1.00 | criteria-a-group.py 输出： 实算正文 47 行 ≤ 500？True |
| RUN-01 | 是 | 1.00 | criteria-a-group.py 输出： 正文声明相对路径入口 0 个不存在｜未声明参数 0 处｜（参数面声明来自 cli-surface-drift 的 --help 枚举；脚本不在本件包内或取不到声明面即放过）｜根指令规则号 0 处 |
| FP-01 | 是 | 1.00 | criteria-a-group.py 输出： 报告头 8217632230e2 / 现文件 8217632230e2；skill-audit-fp.py 输出： project-handoff 8217632230e2 |
| LEN-01 | 是 | 1.00 | criteria-a-group.py 输出： 实算 895 ≤ 1024？True |
| LEN-02 | 895 | 1.00 | criteria-a-group.py 输出： 实算 895 字符 |
| STR-01 | 是 | 1.00 | criteria-a-group.py 输出： frontmatter 段 2（已闭合）；description 汉字0/字母705，正文字母占比 31.8%（语言一致） |
| NAM-01 | 是 | 1.00 | criteria-a-group.py 输出： name=project-handoff / 目录=project-handoff |
| STRUCT-01 | 是 | 0.95 | 结构闭合与语言一致由 criteria-a-group.py 输出承接（见 STR-01 行）；WHAT＋WHEN 两段由 WHAT-01 两条证据成立；第三人称成立；emoji：description／metadata／正文均为 0，正文无 U+FE0F 或 ZWJ；frontmatter 仅含 name／description／version／metadata，均界内 |
| VOL-02 | 无易变表 | 0.90 | 候选 1 条：references/handoff.md（volatile-freshness --coverage 输出： [未在册候选] 1 条）；逐条读该件：其表是 references/handoff.md:13 引文「下表＝本技能的**写槽表**」承载的命令形，均为本技能自身接口，不含会随外部源变更而过期的取值，不属该登记的易变指向性数据 |
| VOL-03 | 不适用 | 1.00 | criteria-a-group.py 输出： 时效清单未登记本件任何表 ⇒ 无档期可判分不分档（新鲜度见 VOL-05） |
| VOL-04 | 是 | 0.95 | 支一：正文无裸 localhost／127.0.0.1；支二：数值均不指向外部可变源——references/cli.md:11 引文「默认 15s，环境变量 `HANDOFF_LOCK_WAIT_S` 可调」为运行时额，references/cli.md:16 引文「`close --outcome`」后接的 ≤400／≤120／≤2000 字为功能代码常量（原第三项所引的本机实测性能记录，已随 v5.67.0 的随件文档清理删除——历史记录不进随件面；该结论由前两项支撑） |
| VOL-05 | 无登记 | 1.00 | criteria-a-group.py 输出： 时效清单未登记本件任何表 ⇒ 无在册行可判新鲜度；「有没有该登记的外置表」由 VOL-02 判（分母＝包内表形件候选，跑 --coverage 取）|
| COV-02 | 否 | 0.90 | 无假称：project-handoff/SKILL.md:9 引文「plus a machine-checked read-back」在正文有对应——references/cli.md:71 引文「`confirm` ＝ 机检 read-back」（同义：脚本出题、脚本判卷）|
| SEM-01 | 是 | 0.95 | project-handoff/SKILL.md:2 引文「name: project-handoff」——两段复合名称，非单段泛名、非工具／个人绑定名 |
| INV-01 | 已收敛 | 0.95 | project-handoff/SKILL.md:34 引文「**调用权**：**仅用户调用**（`disable-model-invocation: true`）」＋ project-handoff/SKILL.md:20 同字段已收敛，描述与之一致 |
| FOR-01 | 否 | 0.90 | R2 判别：被点名半句是 project-handoff/SKILL.md:14 引文「that is experiment-handoff.」——排除域划界，明确该类请求落另一件独立产物而不织入本件能力；R2 反向自检：正文未把任何自身能力交给该件，project-handoff/SKILL.md:40–44 各相位均指本包 |
| PRQ-01 | 逐条不同 | 0.80 | 逐条：python3 解释器可得性＝通用能力 ⇒ 自足（序 6；references/cli.md:73 引文「无 `python3` → **询问用户安装**」）；旧模型先迁移、读到相应相位才建库＝本技能职责内（序 1，project-handoff/SKILL.md:63 引文「有旧模型时**告知用户并请求迁移**」）；未命中序 3/4/5 |
| PRQ-02 | 不适用 | 0.80 | PRQ-01 逐条均落序 1／6（通过档），未命中 3/4/5 |
| SEV-01 | 无 | 1.00 | §五 无 outstanding 发现（REF-04 的 [中] 已随 5.15.3 随件脚本收口消解，沿革见 §五）；档位实源＝「五、问题」节实档，本行为派生汇总 |
| REL-01 | 是 | 1.00 | criteria-a-group.py 输出： 报告头 SDA-Q4.10 / 当前 SDA-Q4.10 |

<!-- criteria-rows:end -->

---

## 二、规范合规检查

| 检查项 | 结果 |
|--------|------|
| 描述非空 | 通过 |
| 长度（折叠后） | 通过 895 字符 ≤ 1024 |
| 结构（WHAT + WHEN） | 通过 |
| 第三人称 | 通过 |
| YAML / name 与目录 | 通过 |
| 正文非空（或 thin-allowlist）| 通过 |
| 官方字段（license/compatibility/allowed-tools）| 通过 合法（未声明这些可选项；frontmatter 仅含 name／description／version／metadata 及 metadata 自选键） |
| name 保留词 / XML 标签 | 通过 |
| 调用与授权（user-invoked only）| 通过 已收敛 |
| 判据前提归属（`PRQ-01`／`PRQ-02`）| 通过 职责内 ＋ 通过 全自足（逐条不同，均通过档） |
| 正文规模 / 引用层级 / 时效性 | 通过 |
| 无 emoji / 表情（description/metadata/正文）| 通过（description／metadata／正文均 0；无 FE0F 或 ZWJ） |
| 能力外借（`FOR-01`）| 通过 本技能独立成立、无能力被他件指路代替 |

## 三、数据外置检查（易变数据分层）

| 检查项 | 结果 |
|--------|------|
| 易变数据识别（会因外部源变更而过期的指向性数据）| 通过 无 |
| 防双源（正文示例与 description 不写死上述数值）| 通过 |
| 外置状态（该外置的是否已外置成表）| 不适用 无易变数据 |
| 登记（承载易变指向性数据的表形件是否在时效清单有行）| 不适用 无易变表 |
| 新鲜度（在册表距末次真验过的天数在不在档期内）| 不适用 无登记（漏登记不由该值转移，另由 VOL-02 分母独立承接） |
| 刷新档期分档（本件各行档期是否同一档）| 不适用 无行 |


## 四、description 与正文交叉验证

| 正文能力 | 优先级 | 描述覆盖 | 判定 |
|----------|--------|----------|------|
| 维护 .handoff/ 九槽交接存储（纯文本、单写 CLI）| 标志性 | project-handoff/SKILL.md:6 引文「Maintain a project's handoff store」 | 通过 |
| 脚本强制的 handoff CLI（单写路径＋覆盖声明）| 标志性 | project-handoff/SKILL.md:10 引文「`handoff` CLI (single write path, coverage statement)」 | 通过 |
| 机检 read-back（confirm 双向确认）| 标志性 | project-handoff/SKILL.md:9 引文「plus a machine-checked read-back」 | 通过 |
| AGENTS.md 交接块写入 | 重要 | project-handoff/SKILL.md:6 引文「into that project's AGENTS.md handoff block」 | 通过 |
| 旧 HANDOFF.md 模型迁移（仅显式调用）| 重要 | project-handoff/SKILL.md:12 引文「migrating an old HANDOFF.md model」 | 通过 |
| next 指针与自动补位策略 | 细节 | 未提及 | 可接受省略 |

## 五、问题

无 outstanding 发现。

（2026-10-21 随 v5.16.0 机械重出：SKILL.md 新增 `agents-block` check 维并删一行示例；题面未变，B 组答案与引文冻结，A 组 LEN-03 仍 169、STR-01 28.7%→28.8%、FP-01 指纹 6be6eaaa4137→af7d0f8861a1；坐标 :114→:115、:130→:131、:131→:132 已逐处复核。）

（2026-10-21 随 v5.17.0 机械重出：`handoff check` 的 `agents-block` 维改为漂移／多份自动重装；SKILL.md 仅改三处既有行措辞、正文仍 169 行；题面未变，B 组答案与引文冻结，A 组 STR-01 28.8%→28.5%、FP-01 指纹 af7d0f8861a1→0a2330c2560f；全部坐标逐处复核未漂。）

（沿革：上一轮报告曾有一条 [中]——#1 REF-04：随件分发文本 scripts/handoff.py 的注释/docstring 含 7 处指向分发面之外的仓根引用（目标为 audits／design／scripts 等发布面之外的资产，file:line 为 scripts/handoff.py:4、:1362、:1924、:1926、:2800、:2804、:4263，消费环境里取不到）。该发现已在本次 5.15.3 收口消解——上述注释/docstring 已删除或改为能力表述，本轮实算 REF-04＝是（仓根引用 0 处）、distribution-surface-check --skill project-handoff 实算 OK；SKILL.md 的 description 与正文未改，随 bump 的 version 不进审计指纹。）
（2026-10-22 随 v5.18.0 机械重出：SKILL.md 压成路由器（CLI 全表／判据清单渲染块／失败出口三块移进 references/cli.md 与 references/failures.md，正文 169→83 行）；`handoff check` 判据与修复分离（新增 `--repair`，默认只报不改）；新增 `waitingFor` 字段与两道维（`blocked-owner`／`block-installed`）；`init` 不再自动装全局 PATH shim。**题面未变（SDA-Q4.10），B 组答案冻结**；引文坐标按新正文**逐条改指**（引文原文一字未改，21 条坐标当场自证对上）；A 组 LEN-03 169→83、STR-01 28.5%→29.1%、FP-01 指纹 0a2330c2560f→84714824e91b。）

（2026-10-22 独立复审：按现行 v5.18.0 正文重核全部判据格与 §四；未发现新增描述缺陷，历史 #1 REF-04 维持已解。报告自身陈旧项已在本轮改正——REF-03 由「五件」改为分发面 9 件逐件可达，STRUCT-01／§二 emoji 计数 4→1，NAM-02 快照 2026-10-19→2026-10-21，§八 表行坐标 39–42→42–47，description 引文补全 `SKILL.md:行号`；判据答案与 SEV-01 不变。）

（2026-10-22 v5.19.0 重出：SKILL.md 压至 5,796 字节／正文 47 行，规则来由、反面清单与 FAQ 移入 `references/rules.md`；新增 `compact-writes`、`blocked-owner`、`block-installed`，并修掉手改坏行导致 `check` 崩栈的缺口。未发现新描述缺陷，也无原有缺陷消失：description 仍准确覆盖存储、CLI、read-back、AGENTS 块与迁移；FAQ 经 `SKILL.md:44` 可发现，落在 `references/rules.md:55`；历史 `REF-04` 维持已解。A 组实算使 `LEN-03` 83→47、`STR-01` 29.1%→30.9%、`FP-01` 84714824e91b→748ce6488708；B 组答案与 §五 结论均未改变。）

（2026-10-22 v5.20.0 机械重出（多轮实测后）：**B 组题面与答案空间未变、答案与引文冻结自 v5.19.0 的独立复审**（codex@deepseek/deepseek-v4.1-flash · g26）——本轮只动三处：① 正文 `waitingFor` 值域写法（管道形改三条分列，照抄不再被 shell 当管道）；② 代码侧补上 `block-installed` 维的**实现**（此前只在判据清单里声明、check 里没人判 ⇒ 承诺的红永不出现），并把它的报错改成只列**此刻可执行**的修法；③ 条目的唯一呈现形带上「在等什么」（`(blocked·等 owner)`）——此前「在等什么」在 view 列表／view --id 上都看不见。三处均不改判据的答案空间。A 组实算：`FP-01` 748ce6488708→7b6d8d55e547、`STR-01` 30.9%→30.6%，`LEN-03` 仍 47 行；§五 结论不变（无缺陷）。引文回验 39 条判定 0 不合格。）

（2026-10-24 外派独立重出（v5.48.0）：SKILL.md 正文 4 句手抄事实改指路语（唯一源＝`references/rules.md`），description 逐字未改；指纹 7b6d8d55e547→6b7ed6b62543。B 组只复核受影响的 NAME-02／REF-03／VOL-02／VOL-04，未发现新缺陷；A 组 STR-01 30.6%→32.0%、LEN-03 仍 47；REF-03 保留行证据因 rules.md FAQ 行号漂移由 :55 改 :66、VOL-04 因 cli.md 生成块重渲染由 :14/:18/:20 改 :9/:13/:15 —— 详情见 §八 前因行。）

（2026-10-28 随 v5.73.1 机械重出：SKILL.md 的「init 不自动装全局 PATH shim」条补一句解析语义（正文仍 47 行），description 逐字未改；A 组 FP-01 指纹 6b7ed6b62543→8217632230e2、STR-01 32.0%→31.8%、LEN-03 仍 47；B 组答案与引文冻结，未发现新缺陷。）
## 六、建议

- 对应问题：无问题，无需改动
- 行动：维持现状
- 推荐文案：无
- 改进要点：无
- 约计折叠字符数：不适用

（未应用到 SKILL.md。）

## 七、验收标准

- [x] 折叠后 description ≤ 1024 且非空；含 WHAT + WHEN
- [x] 无假称：描述中的能力均可在正文找到对应（含同义）
- [x] 重要输入词/术语与正文一致（无正文不存在的输入类型）
- [x] 数据外置：本件无承载易变指向性数据的表（VOL-02 语义判定），在册行为空集（VOL-05 日期源＝git 实算）
- [x] `PRQ-01`／`PRQ-02` 已逐条填空并按序定档（逐条不同，序 1／序 6，均通过档）
- [x] 历史问题 #1（[中] REF-04）已销账：handoff.py 内仓根引用 7 处清零（本轮 REF-04 复算＝是，SEV-01 维持无）

## 八、备注

- **2026-10-25 坐标刷新（答案·结论·指纹一律未动）**：随件文档自 v5.67.0 起按读者时刻重排（`rules.md`／`cli.md` 重排，v5.68.0–v5.71.1 又多处增补）⇒ 本报告**作答表**里的 4 处定位过期。机器回验用本技能自带口径 `verify-quotes.py`（逐字命中 ＋ 行号容差 3）：刷新前 39 条判定中 **4 条不合格**——VOL-04 与 REF-03 各一条引文搜不到，COV-02 与 PRQ-01 各一条行号超容差。本轮只刷新**定位与引文形式**：`cli.md` 9→11、15→16、66→71、68→73；`rules.md` 的 FAQ 入口由 :66『### FAQ』改为 :98『## 六、FAQ』（该节仍在，只是层级与标题随重排变为六、FAQ）；VOL-04 的第三项证据（`cli.md:13` 那句本机实测性能记录）**已随 v5.67.0 的随件文档清理删除**（历史记录不进随件面）⇒ 该项撤下，VOL-04 的『是』（数值不指向外部可变源）仍由同格前两项支撑。**答案、置信、§五 结论（无缺陷）、审计指纹 `6b7ed6b62543` 全部未动**——被审对象（`SKILL.md`）本轮一字未改；刷新后机器回验 39 条判定 **0 条不合格**。

- **本次重出的前因（v5.48.0 事实存在性闸＋事实抄件归位）**：v5.48.0 把「一致性闸」升级为「**存在性**闸」（一条事实的渲染形态只许出现在原件与引用处），随批把 SKILL.md 正文的 4 句手抄事实（:31 槽数、:33 与 :61 槽集合固定、:48 `id` 形态）改成指现代化语，指向 `references/rules.md` 里已渲染的那一份；frontmatter `description` 逐字未改、version 5.46.0→5.48.0 不进指纹 ⇒ 审计指纹 7b6d8d55e547→6b7ed6b62543（skill-audit-fp.py 当场复算同值）。本轮 A 组全量重算（STR-01 30.6%→32.0%、REF-02 证据串与脚本输出同形化、VOL-03／VOL-05 证据按脚本现行输出更新，其余一致逐字保留）；B 组只复核 4 题：NAME-02 引文逐字仍命中 :31、VOL-02 引文逐字仍命中 references/handoff.md:13（结论均不变）；REF-03 保留行证据因 rules.md FAQ 漂至 :66 而改指；VOL-04 保留行证据因 references/cli.md 生成块由 sync-dims 重渲染行号漂移而改指 :9／:13／:15（结论均不变）。§五／SEV-01／§六／§七 维持「无 outstanding 发现／无／无缺陷」。
- 本次为**外派独立审计**（渠道 `command-code@z-ai/glm-5.3-flash`，independence-check 判独立）。沿革：2026-10-20 独立审计（command-code@z-ai/glm-5.3-flash）未修改 SKILL.md；2026-10-21 随 v5.16.0／v5.17.0 的正文改动刷新指纹与 A 组值；2026-10-22 按 v5.18.0 现行正文重答并回验 B 组，不再沿用冻结结论。
- 报告含强制节：问题、建议、验收标准。
- 报告路径：`project-handoff/DESCRIPTION-AUDIT.md`
- EXCL-01 分母两路落盘：① 路＝YAML 解析器取 catalog.yaml 的 skills 节（实算 95 件；禁 glob、禁 grep 计数）；② 路＝environment-declaration.py --latest 取 environment-snapshot-2026-10-21.yaml，route2_extra 7 件（快照非当日＝按原口径仅告警，不判缺陷）。
- 全部 B 组题置信 ≥ CONF-FLOOR（0.5），无降级项。
- **本次重出的前因（REF-04 收口）**：随件脚本 scripts/handoff.py 的注释/docstring 中指向发布面之外的仓根路径（audits／design／scripts）已删除或改写为能力表述；SKILL.md 的 description 与正文未动，仅 bump version 至 5.15.3（version 不进审计指纹，skill-audit-fp.py 当场复算 6be6eaaa4137 同值）。故本轮 A 组 REF-04 由「否」翻「是」（当场输出「随件文本仓根引用 0 处」）；其余 A 组行逐行对照 criteria-a-group.py 当场实算全部一致、未改；B 组未变题沿用原答案与原引文。对照账：§五 改写为「无 outstanding 发现 ＋ 沿革句」、SEV-01 由「中」改「无」、§六 删除已消解项的行动、§七 最后一项验收箱勾销、报告头「结论」行改为无 outstanding 口径。
- **2026-10-21 机械重出（v5.16.0）**：SKILL.md 正文新增 `agents-block` check 维（第 27 维）并删除冗余示例行，净行数不变；题面未变（SDA-Q4.4），B 组答案与引文冻结，A 组 LEN-03 仍 169、STR-01 28.7%→28.8%、FP-01 指纹 6be6eaaa4137→af7d0f8861a1；坐标 :114→:115、:130→:131、:131→:132 已逐处复核。
- **2026-10-22 机械重出（v5.18.0）**：SKILL.md 压成路由器（39.5 KB→10.1 KB，三块移进 references/）；`handoff check` 判据与修复分离（新增 `--repair`）；新增 `waitingFor` 字段 ＋ 两道维；`init` 不再自动装全局 shim。题面未变（SDA-Q4.10），B 组答案冻结，**引文坐标逐条改指（原文未改，21 条当场自证）**；A 组 LEN-03 169→83、STR-01 28.5%→29.1%、FP-01 指纹 0a2330c2560f→84714824e91b。
- **2026-10-22 独立复审（v5.18.0）**：A 组实算 FP-01＝84714824e91b、LEN-03＝83、STR-01＝29.1%；B 组逐格按现行正文重核，REF-03 的新分母为 references 七件＋scripts 两件，全部可达。修正报告陈旧项：REF-03「五件」、STRUCT-01／§二 emoji 4 处、NAM-02 快照 10-19、§八 表行坐标、description 引文缺 `SKILL.md:行号`；§五 结论、SEV-01 与 §六 行动不变。
- **2026-10-22 重出（v5.19.0）**：SKILL.md 5,796 字节／47 行（v5.18.0 为 10,144／83）；规则来由、反面清单与 FAQ 移入 `references/rules.md`；新增 `compact-writes`（写事件台账收窗，末次记录／删除并集／带旁证事件三项判定不变）、`blocked-owner`、`block-installed`，以及坏行缺 `id` 时不再崩栈。A 组实算 FP-01＝748ce6488708、LEN-03＝47、STR-01＝30.9%；REF-03 分母 10 件全部可达（含 `rules.md`，FAQ 在 `references/rules.md:55`）；B 组逐格重判，答案与 §五 结论不变。
- **2026-10-21 机械重出（v5.17.0）**：`handoff check` 的 `agents-block` 维改为漂移／多份自动重装（t000387）；SKILL.md 仅改三处既有行措辞、正文仍 169 行；题面未变（SDA-Q4.4），B 组答案与引文冻结，A 组 STR-01 28.8%→28.5%、FP-01 指纹 af7d0f8861a1→0a2330c2560f；全部坐标逐处复核未漂。

### 取证块（含竖线的逐字原文，只在这里铺原文）

```text
—— project-handoff/SKILL.md:40
| 接手 / 继续之前的工作 / 新 session 进入已有项目 | `references/resume.md` |
—— project-handoff/SKILL.md:41
| 交接 / 收尾 / 跨会话·跨工具移交 | `references/handoff.md` |
—— project-handoff/SKILL.md:42
| 新项目 / 尚无工作存储 | `references/init.md`（**仅显式调用**）|
—— project-handoff/SKILL.md:43
| **发现旧模型**（`HANDOFF.md` / `HANDOFF-ARCHIVE/` / `.handoff/fp.*`）| **先** `references/migrate.md`（一次性，**仅显式调用**）|
—— project-handoff/SKILL.md:44
| **要下命令** / 想知道 `check` 判哪几条 / **命令报错** / **想知道某条规则为什么这么定** | `references/cli.md`（命令全表 ＋ 判据清单 ＋ 样例）· `references/failures.md`（按报错给修法）· `references/rules.md`（规则来由）|
```
