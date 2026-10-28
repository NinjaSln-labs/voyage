# CLI（技能自带脚本；解释器 `python3`，Windows 用 `python`）

> **节标题不写死仓内相对路径**——各仓装本技能的位置不同，写 `scripts/handoff.py`
> 会让别的项目的 agent 去执行一个它那儿不存在的文件。
> `$H` 指本技能目录（通常 `<项目>/.agents/skills/project-handoff`）。

<!--fact:verbs-->`add` · `agents-block` · `append` · `check` · `close` · `compact` · `compact-writes` · `confirm` · `decide` · `edit` · `export` · `filter` · `import` · `index` · `init` · `install-shim` · `log` · `next` · `read` · `rebase` · `resolve` · `retitle` · `rm` · `scope` · `seal` · `selftest` · `set` · `sync-dims` · `sync-queue` · `unconfirmed` · `unseal` · `unvoid` · `upgrade-prio` · `view`<!--/fact-->。

## 一、存储与并发机制

- **单写者锁**：每条命令进来先对**本存储**取一把排他锁（锁文件按存储路径哈希、落临时目录 ⇒ 不同仓互不阻塞），整段「解锁→写→回封」都在锁内。等锁**有界**（默认 15s，环境变量 `HANDOFF_LOCK_WAIT_S` 可调）：并发写是 agent 的常态用法（多条命令塞进一个工具调用并行发出），所以让两条都生效、只把**真卡住**的进程报出来；flock 由内核在进程退出时释放，**不会留残锁**。
- **`void` 有出口**：`void` 记的是「这 id 不再被任何东西持有、永不复用」。现 `rm` 按事实分流：**移走那一条之后该 id 仍被任何东西持有 ⇒ 不记作废**；历史死角走 `handoff unvoid <id>`（要把 trash/ 那份搬回 live 另加 `--restore`）。
- **sealed store（POSIX 上的附加加固）**：`.handoff/` 全树常态**只读**，写权限只归本 CLI（每条命令先解锁、末回封，自动维持）。**在 POSIX 上**这是内核级拦截——任何工具直改存储都会被 EACCES 拒绝，不依赖各 agent 的 hook；hook 只是可选的体验层。**非 POSIX（如 Windows）上该机制不生效**（chmod 语义不封存）：此平台上的实际保护只剩「写事件对账」这一道（手改仍会被抓到，但不是内核级拦截），`check` 会**显式提示**这一点、不静默跳过。维护态显式 `unseal`（**该库**本次不回封——维护态按存储路径记，不波及同一进程里的其它存储）；`check` 的 `sealed` 维判「进命令前应处封存态」。
- **写事件收窗（`compact-writes --keep N`）**：写事件台账（`writes.jsonl`）按次追加、**条数**随写命令线性增长，而**每条命令都要全量读它**（`note_pre_tamper` 读末次记录）⇒ 库越大越慢。`compact-writes` 把历史折叠成**一条基线**（＝截至收窗时的末次状态 ＋ 删除并集 ＋ op 直方图 ＋ **出处维的 `id_base` 基线并集与 `ids` 分配记录并集**）并保留最近 N 条事件（**带旁证 `pre_tamper` 的事件原样保留、不折叠**）。**判定不变**：末次记录（`latest`）、删除并集（`ever_removed`）、带旁证事件（`seen_tamper`）、id 出处基线（`id_base`）、分配记录（`ids`）**五项**与收窗前一致（基线事件带 `prov` 键，`keep 0` 时形状与其它事件一致；空集也保留键 ⇒ 新库不被打成老库）；**结案仍走 `rebase --force`**（它才是搬走旁证事件的机制——把带旁证的事件**搬进侧档**而非丢弃，`rebase --undo` 可搬回）。收窗是**显式命令**、不是 `check` 里的自动动作——门禁不改用户的台账（与「门禁不改使用方的文件」同一条纪律）；`check` 只在台账超阈值时给一句提示（只报不拦）。
- **热/冷分层**：`exit`/`summary` 是热层（接手要全量读），有硬闸（exit/summary 8KB、status 32KB；exit 单班段 ≤12 行）——超限 `set` 即拒并指向 `compact`。历史班段搬 `archive/<slot>.jsonl` 冷档（只进不删）；`append` 追加新班段/新行并自动挤出旧内容进冷档；`read` 合并热＋冷按需取（默认只读热层，`--tail N`／`--at 日期`／`--grep 词` 取历史）；`view` 渲**全局视图**：散文热层 ＋ **读时现算**的队列区与现态计数（**不落盘**）＋ 全部未销账条目 ＋ 归档与裁定清单。
- **内容硬限**：<!--fact:limits-->`close --outcome` ≤400 字、条目 `summary` ≤120 字、`detail` ≤2000 字<!--/fact-->——超限即拒，报错即修法。垃圾进不了账，而不是事后清。

## 二、判据与门禁

- **`check` ＝ 相位门禁**：不过即非零退出，相位不得前进。**verdict 之后给「## 现在该做什么」节**（FAIL 时也给）：下一步（`next` 指针，或按补位策略算出的候选）、本班**待交代**的条目（直接给现成的 `handoff append exit --covers <id…>` 写法）——**全部由库里实况现算**，你不必记住流程。它逐条检下列维度（**这份清单由 `CHECK_DIMENSIONS` 生成**：加判据只改代码那一处，再重跑生成；忘了会被漂移检查点名）：

<!-- check-dims:begin （由 CHECK_DIMENSIONS 生成，勿手改）-->

1. **slots** — 槽结构与 `index` 齐备（9 槽；槽清单见 `references/rules.md`）
2. **id** — id 形如 `<t|p|d|u|c><6 位>`、全局唯一、**前缀与所在槽相符**
3. **status** — live 行的 `status` 在该型闭集内（**`closed` 不是可写值**，关闭只经 `close`）
4. **blocked-stale** — **`status=blocked` 的行，其 `blockedBy` 必须仍活着**（已 close／已作废／被 supersede ⇒ 红，附三种修法）——两道入池谓词结论相反时，这条就「无人接手但谁也看不见」；**不判**「blocked 却不写 blockedBy」（那只是没记指向，非自相矛盾）
5. **blocked-owner** — **`status=blocked` 必须记下「在等什么」**：`blockedBy`（等库内 id）或 `waitingFor`（等所有者／等用户／等外部条件），**二者至少有一个** ⇒ 否则红（**修法可满足**：补其一即可）。为什么现在能判：阻塞有三型，字段层此前只承载第一型 ⇒ 「等所有者」的条目永远没有 blocker 可指，于是它不入池、无 owner、任何维都不报＝「无人接手但谁也看不见」（与 `decision-pending` 同型：那边补了维、这边没补）。
6. **fields** — 未知字段 ＋ 必填字段缺失（按型）
7. **dates** — `created`/`closed` 是合法日期、非未来日、且 `created ≤ closed ≤ today`
8. **single-line** — `summary` 单行（不得含换行/制表）
9. **next** — `next` 是合法 id、存在、且 **`status=open`**（附可执行修法）
10. **text-dangling** — 文本槽（`status`/`summary`/`exit`）点名的 `t/p/q/u` 型 id 必须既不在册、也不在 `trash/`·`void` 之外（**已作废 ≠ 不存在**；`c`/`d` 两型不参与，各有专门检查面）
11. **decision** — `decisions/*.md` 的 frontmatter id 必须等于文件名、日期合法、status 在闭集
12. **decision-pending** — **待追认的裁定**：`status: proposed` 的 `decisions/*.md` ⇒ 红。`proposed`＝提议了还没人拍板，而 d 型**不进补位池**、也不被新鲜度维点名（它们只管 t 型）⇒ 不判它，它就是个**零消费点的态**：不红、不入池、无闸看见，可以无限期挂着（v5.12.0／d000112）。修法＝`handoff decide <id> --status accepted|rejected|superseded`（原地改 status 一行，**不换 id、不改 created**）
13. **decision-prose** — **凡落裁定必走裁定件**：`exit`／`summary` 里命中库级形态表 `handoff-ruling-forms.txt`（store 同级；字面串、五区 `[topic]`／`[pending]`／`[record]`／`[skip]`／`[reference]`：topic 入门、pending／skip 免判、record 必带号、reference 只提示）的 `[record]` 形态、而**同一行**没有在册或已作废的 `dNNNNNN` ⇒ 红；`[reference]` 与闭集外形态只提示不判红（把未知露出来，不静默放过）。标题行不算记录。**形态表不存在＝本维不启用**（通用默认：形态语言由各库自定，不把任何一种语言的词表硬编码进随件代码）。
14. **scope** — `scope` 登记指向**活路径**或 glob 有命中（机械判据：登记必须可解析）
15. **void-reuse** — id 未复用已作废 id（`void` 拦截；**有出口**＝`unvoid`，报错自带修法）
16. **writes** — 写事件对账：内容哈希对不上＝**未经 CLI 记录的写入**；写前发现被外部动过＝**疑似补手续**（含判据缺陷留下的历史误报，用 `rebase --force` 结案）。**含 `decisions/*.md`**（v5.12.0 补：此前裁定件的 status 手改无闸可抓，`decide` 的「唯一写路径」只是声明——没有对账面就等于没有）。**结案可撤销**（v5.71.0）：`rebase --force` 把带旁证的历史事件**搬进侧档**（**不销毁**），`rebase --undo` 能把它们搬回⇒那次结案同时认账的 id 空间**不可撤销**（认账单调只增）
17. **partition-case** — 同槽分区文件名**大小写折叠后不得重名**（NTFS 大小写不敏感 ⇒ 仅大小写不同的两个 domain 会合并成一个分区文件、计数与现实脱节）
18. **index** — `index` 的各槽计数与 `next` 与落盘一致（漂移即红）
19. **fresh-queue** — **交接新鲜度**（口径 R2·v5.29.0 ＋ **refs 化**·v5.45.0）：**本班新增的** `t` 型条目必须被**最近班段点名覆盖**——v5.45.0 起**班段散文里写到 id 就算覆盖**（写时提取成 `refs` 落进班次台账，是**落盘证据**）⇒ **作者成本 0**（不必另写一份声明，覆盖事实的原件就是散文）；一次写不完（几十条 id）时用 `handoff append exit --covers <id…>` **打包声明**（**例外出口**，不是必经之路）。**老班段**（既没有 `refs` 也没有 `covers` 字段）⇒ 退回**旧口径扫散文**（迁移不误伤）。写入面同时拦（`append/set exit` 没点名也没声明 ⇒ **写入即拒**，报错给出要点的 id）——写入面拦，不靠事后红。**v5.32.0**：写面不再因「状态断言」拒写（散文不承担状态 ⇒ 判据也不拿散文比库里活状态；状态由 `view` 现算标注）。只取 `t` 型——p/d 进 exit 属背景叙述，逐条要求提及会淹没真信号。**义务只有一条：O(本班增量)**——存量与推不动的条目由**读时现算的视图**承担（`handoff view` 逐条列出全部未销账条目，`entry_display_line` 还带「等 owner／等 t000123」为什么推不动 ⇒ 读者看得见，散文不必再抄一份）。**推不动的**（`status≠open`／`waitingFor`／`blockedBy` 指向活着的裁定）**本班新增的**同样要点名（R·v5.23.0 曾要求它们**全部**点名 ⇒ 那是一条 O(存量) 的散文义务 ⇒ 与「区落盘」同型的死锁支，拐点 ≈1800 条）。**「本班新增」＝条目的 `bornShift` ≥ 上一次班段的班次序号**（v5.30.0 刀 F：**整数比较**、无并列、与时钟无关 ⇒ 同秒不再「留一班」）；**没有 `bornShift` 的老行**按创建时刻 ≥ 边界时刻（截到秒）算（保守＝仍算新增）；**导入存量**（`origin=import`）不算本班新增（迁移进来的旧工作，import 已用一行有界聚合交代）。
20. **queue-legacy** — **旧库残留的队列区**：`exit` 里**不该再有**队列渲染区——v5.29.0 起它**读时现算、不落盘**（读者看 `handoff view`）⇒ 落在文件里的那份是v5.28.x 之前的残留，**会陈旧**（它是当时的快照）且它是机器内容、留在人写的散文层里 ⇒ 与人写的叙述混在一起会被误读成「当时的现态」。⇒ 存在即红；修法：`handoff sync-queue`（剥掉；幂等）或任意一条写 exit 的命令（写入即剥）。**新库没有残留 ⇒ 不判红**
21. **prio-source** — **重要度单源**：live action 的 `prio` 必须在闭集 急/高/中/低/缓 内，且 summary 不得以**档位词元**开头（`[中]`／`[高·重定]` 判，`[高危]`／`[根因]` 不判——词元查表见 `is_tier_prefix`，d000111）——字段是唯一来源，留着旧前缀就是一条没人同步的假通道。修法给 `handoff upgrade-prio --apply`；想标**严重度**用不相交词表 `高危/中危/低危`（不判、不排序）。只判 live actions：pitfall／command 没有 prio 通道。
22. **derived-counts** — **现态计数不入散文**：`status`／`summary`／`exit` 里出现「现态锚点（`live`／现态／实况／当前）＋同行 ≥2 个槽名＋数字」（M0）**或**「锚点＋数字+汉字、同行无日期/取证语（为准/实算/实测/当日/现算）」（M5）⇒ 红。**不判那个数对不对**——比值要靠正则认出那一行，而行的形状由人写（本仓实测：锚点要求 `live：actions` 紧邻，真行写成 `live： actions`，多一个空格整行被跳过，而工具照打 OK）。数的唯一产生源＝`handoff index`（每次写重建）＋ `index` 维对账；**v5.30.0：counts 区也不再落盘**（与队列区同构收口 ⇒ 判据面净减一处，`counts-stale` 维已作废）⇒ 旧库残留的 counts 区先剥掉再判（它是机器渲染物）。修：删数、改指路语「现态以 `handoff index`／`view` 实算为准」；**带日期的历史快照放行**（那是当时事实）。写入侧同一道形状闸在 `set`／`append` 上（`guard_derived_counts`）。
23. **sealed** — **封存态**（v5.0 sealed store，**POSIX 上的附加加固**）：`.handoff/` 全树不得有可写位——写权限只归 CLI，POSIX 上任何工具直改都被 EACCES 拒绝；未封存即红（跑任意命令自动回封，或显式 `handoff seal`）。**非 POSIX 上本维不判**，且 `check` 会提示「此平台无封存保护」——别把绿灯读成「已封存」。**本命令现建的库不判**（v5.68.0）：进门前它还不是库 ⇒ 那时「可写」是必然的初始态、不是任何人 chmod 回来的 ⇒ 本维在这次调用里没有判别对象（实测：`import` 现建库后自带的 check 判「未封存」⇒ import 报失败，而内容完整落地、导入后零可写位）。**「现建」按实物判**（v5.69.0）：库里有没有本 CLI 的产物（index／条目槽／unconfirmed）⇒ 老库**被删掉 `index`** 也仍是老库（仍须判封存）；空目录仍算现建（不判）
24. **archive** — **冷档完整性**（v5.0 热/冷分层）：`archive/*.jsonl` 每行须为 JSON 且带 `archived`/`text`——历史班段只经 `append`/`compact` 搬入，防手改冷档
25. **agents-block** — **AGENTS.md 交接块与唯一源一致**（仅在已有标记区时启用）：标记区文本逐字比对标准源 `references/agents-handoff-block.md`；**漂移／多份 ⇒ 只报不改**（v5.18.0：门禁不改使用方的文件），要按唯一源重装跑 `handoff check --repair`（痕迹落 store 事件流）。**残缺／读不了 ⇒ 红且必须先人工解决**（无块界可分，不猜着修）。**无 AGENTS.md 或无标记区＝本维不启用**（未装块的仓零误伤）。**档位（basic／freshness）按独立证据比**：期望值取自「装过块」那条 d 型记录里记的档位，**不取自被检查的文件**——否则一次不带 `--profile` 的 `--install`就能把增强档仓**静默降级**（条款被搬出比对区）而检查自证通过（t000406）
26. **block-installed** — **本仓装过交接块、现在块不见了** ⇒ 红（装过的证据＝一条 d 型「事实登记」记录；`AGENTS.md` 无标记区、或整个文件不在，都算「不见了」）。**可选维**：从没装过块的仓不启用。修法：`handoff check --repair`／`handoff agents-block --install <仓根>`；本仓不再用交接则 `handoff rm <该记录 id>`
27. **rewrite-points** — **机制面重述点**（v5.44.0，终极律 L9）：本技能自己的代码与随件文档里，**同一事实的第二份陈述**＝重述点 ⇒ 抄件会漂 ⇒ 纪律被违反时静默 ⇒ 同一个根因反复复发。可实算的两类：① 判据面**拿散文/副本当输入**的分支（每处须在源码里显式标记 ⇒ 标记数＝实算数 ⇒ 新增一处就多一个重述点）；② 随件文档里**枚举型工具事实**没被渲染（复用文档面漂移闸）。⇒ 两类都只许**待在豁免名单里**（逐条写明死因与死期条件）⇒ 名单与实算**双向对账**：实算多了＝新增重述点（红）；豁免过期＝该治了（红）。修：把重述点消掉（改成引用/渲染），或同批在豁免名单里写明死期
28. **discipline-present** — **机制面纪律必现**（v5.52.0，终极律 L9 的另一投影）：纪律的落地历来是「往散文里加一行」⇒ ① 纪律**只进了闸、没进文档** ⇒ 改包文档的人（或 agent）**不知道有它** ⇒ 只靠闸兜（闸抓得到，但没人知道为什么）⇒ 纪律**事实上没落地**；② 落地物是**抄件** ⇒ 抄件会漂 ⇒ 纪律被违反时静默。⇒ 治法：**纪律清单落成数据**（`DISCIPLINE_PRESENT`，唯一源）＋ 随件文档里那一节**必须含锚点** ⇒ 「纪律在文档里」这件事**可实算**。修：在随件文档里补该纪律（锚点照抄 `DISCIPLINE_PRESENT` 的登记）
29. **id-provenance** — **凭空出现的 id**（v5.53.0 · t000448）：在册条目必须有**分配来历**——写事件台账记下每次 CLI **分配**的 id（`ids`）⇒ 人手加的、别的途径落的条目 ⇒ 红。写事件对账此前只对账**台账里有的文件**（内容哈希）⇒ **台账里没有的新文件**不在射程 ⇒ 手加一条**完全合法**的条目、重建 `index` 之后**彻底隐形**（t000448 实测复现）。**老库不误伤**：出处机制生效那一刻在册的 id 落一条**基线**（`id_base`，＝那一刻的 id 快照）认账（来历不可追，但可证明「那一刻就在册」）；基线**还没建立**的老库该维不判，另出一条「id 出处基线未建立」的可执行红项。**导入还原的作废 id 也认账**（v5.68.0：`import` 还原库级事实面（void／trash）时，那批 id 同样记进台账 ⇒ 一次合法往返不再被判「来历不可追」）。修：确认是自己加的 ⇒ `handoff rebase --force` 结案；不是 ⇒ `handoff rm <那条 id>`；**已在回收站的**另给一条出路（`rm` 对已作废的 id 会当场拒 ⇒ 用 `handoff unvoid <id> --restore`或删掉 `trash/`／`void` 里那一份）

<!-- check-dims:end -->
## 三、命令契约（行为·前提·出路）

- **`add` / `close` ＝ 唯一写入口**（坑的销账另有别名 `resolve`）；**日期脚本盖、id 脚本分配**（LLM 无从编造）。**`add` 参数面按型分列**：`handoff add action|pitfall|command|decision --…`，每型只收本型字段——旧 `add --slot <槽>` 的**并集面**会静默丢弃本型不消费的键，现**硬报错并印新形**；`edit` 亦按条目型校验可改面（不符即报错）。
- **`next` 自动补位**：`close`（含 `unconfirmed resolve` 的内部关闭）关掉的**正是当前 `next`** → 按策略补下一条（`--no-refill` 关；`handoff next --auto` 人工触发同一策略；`next <id>` 随时覆盖补位结果）。策略**确定性可复算**：候选池＝live `actions`（**仅 `status=open`／缺省入池**；blocked＝等待中、其余值非法均排除；**且 `blockedBy` 指向的 id 仍「活着」时也排除**）；排序键 `(prio, created↑, id↑)`——**天龄不在排序键里**；**重要度是字段 `prio`**，闭集 <!--fact:prio-->急／高／中／低／缓（降序，缺省「中」）<!--/fact-->——闭集外的词一律拒收、**不做别名归位**（`high`/`med` 那一族别名恰是「写了不认的词就悄悄落默认档」的入口）；**summary 前缀不再参与排序且写入即拒**（旧前缀留在原地＝一条没人同步的假通道，存量走 `upgrade-prio` 回填）；不给 `--prio` 时落「中」但**当场打印这句**（缺省≠静默）；**等待时长只提醒不改名次**：等够 30 天者在 `next --auto` 输出与 `exit` 的渲染队列区里标「超期」。补位/留空均**打印依据**（P3 不静默）。空池或全 blocked：`close` 留空并说明，`next --auto` **拒绝且不写指针**。
- **入池第三道谓词：`blockedBy`**。条目写了 `blockedBy: dNNNN` 而那个 id **仍然生效**（在 live 或 `decisions/`，未被作废、未被 `supersedes`）⇒ 现在推它必然白推，**不进池**。**「生效」的闭集不含已关闭（`closed/`）的条目**：关掉一条目＝它要办的事有结论了（办完，或判定不值得办），等着它的人本就该重新决策——继续拿它当挡路石，那条目就成了「无人接手也谁也看不见」。配套：① 条件一消失（`close`／`rm`／被 `supersede`）条目**自动回池，不需人手解禁**；② 人手 `next <id>` 把指针钉回被挡条目，`check` **硬失败**并给出一条命令的修法；③ 挡路方可以是 **decision**（发布冻结这类裁定），不限于 `t/p` 条目——**解除冻结的常规动作是「立新裁定 `supersedes` 旧的」，不是删文件**，故被 `supersedes` 的裁定也不再挡人。④ `rm` 的引用守卫与本谓词**故意不同口径**：那处判「这个 id 还有没有实体可删」（身份），本处判「它还挡不挡人」（效力）。**反例也是规矩**：`blockedBy` 指向**查不到**的 id **不算阻塞**，照常回池——否则一个手滑的 id 会永久踢掉一条本可推进的活；但若条目仍留着 `status=blocked`，`check` 的 **`blocked-stale` 维**会报红（那句 `status` 与谓词③结论相反）。
- **S7 `commands` 先薄**：只收 `AGENTS` / `README` 里**没有**的非显然命令 ＋ 环境例外（可推导的**不重复记**）→ **常空正常**。每次门禁落一条 `log` 快照（`handoff log --stats`），供日后据数据决定是否保留该槽。
- **`set <status|summary|exit>`**：单文件槽写入口（`add` 只覆盖条目槽 + `decisions`）；**单文件槽唯一写路径**。**整槽覆写、无追加语义**——想改一行也必须先读回全量再写。两道守卫：空内容拒写（`--allow-empty` 才放行）；旧内容非空且新内容 <60% 亦拒写（`--force` 才放行，防「把整槽覆写当局部编辑」）。**写入前不确定就先 `--dry-run`**：逐条列出**将丢失的行**、不落盘。**快照在真正写入之前**：守卫拒绝与 `--dry-run` **都不在盘上留痕迹**——被拒时一个字节都没写、槽还是原内容，**不需要回退**。因此**被拒时的报错里不给「回退到 prev/」的建议**：`prev/` 存的是**上一次成功写入**的版本，照做会把当前内容覆盖成上一个版本且全程无警告。要回退请用 `git` 或自己的备份。
- **改班段标题**：`handoff retitle exit (--at <序号> | --match <标题片段>) --title "<新标题>"`——只改该班段的 `## ` 行、正文逐字不动；只作用于 `exit` 热层（冷档是历史，不改）。`--at` 按 `handoff view` 的 exit 节顺序（1＝最新）；`--match` 须唯一命中（多命中改用 `--at`）。标题也可经 `--from-file` 的 `title=…` 传入。
- **`install-shim` ＝ PATH 入口（解析式）**：写 `~/.local/bin/handoff`（`--dir` 可改落位），**幂等、不改 PATH／rc**。运行时解析序：① 安装来源在**它自己的项目树内** ⇒ 用它（真源仓里跑源，editable）；② cwd 向上最近的 `<项目>/.agents/skills/project-handoff`（**版本跟项目**）；③ `$HOME/.agents/skills/project-handoff`（用户级标准位）；④ 安装来源；⑤ 都没有 ⇒ 报错退 127 并给修法。⇒ 全局入口不钉死任一副本：副本删除／移动不断链，版本不跟丢；无 shim 时的回退仍是 `python3 "$H/scripts/handoff.py"`。
- **散文不承担状态断言**：写面**不因状态拒写**（两个方向都不拦）；**无时点**的行里、紧邻 id 的**括号型**闭态标记会被**规范化掉**（`t000417（已闭）` → `t000417`，回显里告诉你改了几处）；**真状态由 `handoff view` 读时现算**标注（〔已闭 2026-10-23〕／〔在册〕）⇒ 作者不必抄状态副本。**带日期的历史陈述原样保留**（工具不裁决「当时是不是这样」）。**引用不改写**：反引号里的闭态标记是**引用一个形状**（证据、举例）⇒ 原样保留，真状态标在**引用外边**。**代价（如实）**：机器不再替你裁决语义（「把活的说成死的」不再拦写）⇒ 靠渲染标注把真状态并排显示出来。**点名不存在的 id 仍判红**（`text-dangling` 维）——那不是状态问题，是指针坏了。（来由与边界见 `references/rules.md` §一。）
- **报错自带出路**：每条报错末尾带「**修：**…」⇒ 那是**当场可执行**的下一步；出路表是判据的**唯一源**（加一条出路＝改表里那一行 ＋ 在站点声明那个键）。**出路口径（五形）**：**命令**（可复制：`handoff <子命令>`／子命令本身／已知外部命令）／**参数**（`--flag`，加到当前这条命令上即可）／**用法**（点明合法形态）／**指令**（祈使动作，**可执行但不可复制**）／**无需动作**（明说没有命令可跑）。⇒ 判据保证的是「**有下一步**」，不保证「可复制」——要可复制就写命令。**散文式出路算数**（不许为了过闸去抄一条不存在的命令）。**出路里点名的 `handoff <命令>` 必须真在 CLI 子命令表内**（有闸在判；照抄就能跑）；同一把尺还管三件事：出路里的 `--flag` 必须真在 **parser 树的 flag 集**里（全部层级并集）；`handoff add <kind>` 的 kind 必须真在 `add` 的 kind 面里；而**顶层全局参数在前**的合法写法（`handoff --store X check`——argparse 要求顶层参数写在子命令**之前**）**不再被误判成「命令不存在」**。⇒ 四项**全部从 parser 树派生**（`build_parser()` 是参数面唯一构造口 ⇒ 无手抄清单 ⇒ 零误报）；**外部命令**（如 `git diff --stat`）的 flag **不核**（不误伤）。
- **读面红项也自带出路**：`check` 报出的每条红项同样带「**修：**…」⇒ **两面同一把尺**。键＝**处境**（不是维度——同一维度常有多个处境，共用一条修法会不具体）；表在 `CHECK_FIXES`，红项一律经 `E(处境键, …)` 拼装（漏拼装 ⇒ 门禁当场红）。**出路里要 stating 事实时插值派生值**（id 形态／status 闭集／waitingFor 值域）⇒ 出路与实现同源，不许手抄。
- **交接块只留「领域决策＋动作」**：块是**逐字节分发**到各仓的拷贝 ⇒ 一句「换个版本可能不成立」的话不是合同、是机制现状 ⇒ **工具自己判**（内容闸）：块里不许有内部名／槽名、命令的**存在性**陈述、具体计数、写作格式要求。往块里加这类句子 ⇒ 门禁当场红。
- **`decide <dNNNNNN> --status <值>`**：**裁定件 status 的唯一改写路径**，只改 frontmatter 里 `status:` 那一行——`id`／`created`／正文**逐字不动**（重登记丢的正是前两样，而它们是「这条是哪天定的」的唯一证据）。待追认的 `proposed` 唯一改法是 `rm` ＋ 重加（换 id、`created` 记今天）。**接替旧裁定是立新事实** → 走 `add decision --supersedes`，本命令不给 `--supersedes`；空转（同状态）拒写。改完若仍有条目 `blockedBy` 它，命令会点名并给解法——**status 变了被挡的条目不会自动回池**（入池第三道谓词读的是「在册且未被别的裁定 supersedes」，不读 status）。裁定件已进写事件对账面：此后手改 status 会被 `writes` 维抓到。**`--freezes <tid>...`** 在同一条命令里把点名的 live action 的 `blockedBy` 写成该裁定 id：只接受 action、只允许 `--status accepted`、已有别的 live `blockedBy` 则拒（不静默覆盖冻结指针）；冻结后补位池不再把该条顶到队首。
- **纠错入口**：`edit <id>`（改安全字段；`id`/`created`/`closed` 不可改）与 `rm <id>`（→ `.handoff/trash/` ＋ 记 `void` 防 id 复用 ＋ 引用守卫；**移走那一条之后该 id 仍被任何东西持有 ⇒ 只移那一条、不记 void**）与 `unvoid <id> [--restore]`（`void` 的出口）——错误**不经手搓**，免 `export→改→import --force` 全量重写。── 两条契约：① `rm`／`close`／`edit` 一次只处置**那一条**（同一文件里落着两条同 id 时，另一条留在原处：不被顺带移走、不被静默丢弃、不被一并改写）；② `unvoid --restore` 的前提是「**`trash/` 里有那一份**」，**不再要求该 id 已作废** ⇒ 不记 void 的那条路（正是①的直接后果）也捞得回来。
- **导出/导入**：`export` 产出**整库清单**（JSONL），`import` 把清单**原样导回**——两者是**往返**，不是单向搬运 ⇒ 清单里除了条目面，还带**库级事实面**三段：`void`（**已作废 id 名单**）、`trash`（**已移走的那一份**）、`archive`（**冷档历史班段**）。**为什么必须带**：「**id 永不复用**」是库的硬不变量，而 `allocate` 正是靠「在册 id ＋ 已作废 id」取最大号来防复用 ⇒ 清单少了 `void` 段 ⇒ 一次往返就把那道防线弄丢（实测：导入库把源库已作废的 id **原样重新分配**出去，且无闸可抓）；少了 `trash` 段 ⇒ `unvoid --restore` 的前提没了。⇒ 清单形状有闸（`export` **写前自检**：形状不对就不写出）；**旧清单（schema 1）仍可导**，但导入时会显式提示「清单不含已作废 id 名单 ⇒ 导入后 id 可能被复用」，且**目标库原有的已作废名单保留不动**（清掉却还原不了＝毁掉无法还原的东西）。清单格式：`{"_format":"handoff","schema":2,…}` 为首行，随后每行一条记录（`_kind`＝`entry`／`doc`／`ref`／`void`／`trash`／`archive`）。
- **`status` 值域按型闭集**（`add`/`edit` 同一守卫）：<!--fact:status-->action／command＝`blocked`｜`open`；pitfall＝`blocked`｜`fixed`｜`open`<!--/fact-->——**`fixed` 不是销账**，它表示「缺陷已修、**留案以免重犯**」：条目**仍在 live 区**、仍计入各槽计数、仍被 `check`/`view` 看到，只是不进 `closed/`。要销账走 `close --outcome`（坑可直接用 `resolve <p-id> --outcome …`，等价且只收 p 型）。它**基本是自述**：别把「多数坑都 `open`」读成「多数坑都没修」；缺省（不传或清空）＝`open`。
- **坑的消解**：`resolve <p-id> --outcome "<结论>"`——销账归档到 `closed/p.jsonl`（等价 `close --outcome`）；只收 p 型、必须留结论，不留「静默销账」这条路。关闭序仍只有 `close` 一份实现，`resolve` 只做型别校验后转发。
  ⚠ **`pitfall`／`command` 的 `[高危]/[中危]/[低危]` 是严重度标注**：**不参与排序、不进 `prio` 字段**——档位词 `急/高/中/低/缓` 只能经 `--prio` 声明（前缀一律拒收），所以标注用了这五个词会被拒；存量由 `handoff upgrade-prio` 保义改写。**`closed` 不是可写值**——关闭唯一入口＝`close --outcome`（坑可走 `resolve`；edit/add 传 `closed` 或表外值即硬报错）；`check` 对 live 行同闭集硬判；补位池**仅 open 入池**（blocked＝等待中、其余＝非法值，均不补位）。`selftest [--quick|--full]` ＝ 机制自证的双向夹具（临时 store 内真 CLI；**断言数会随夹具增长，别在正文写死**——要数就跑 `selftest` 数 `ok` 行）。默认 `--full` 跑全部腿；`--quick` 只跑核心命令闭环 ＋ 三把静态机制闸的正控（负控/变异腿留给 full），供全库门禁每轮跑——门禁按源指纹决定：源变了自动升级跑 `--full`。
- **`confirm` ＝ 机检 read-back**：脚本出题、脚本判卷；**不 `PASS` ＝ 交接未完成**。题面**每次调用重新随机抽**——「先出题、后作答」必须两次带**同一 `--seed`**，否则题已换而答案错位。抽查题按**视图行文本**判分（`[id] topic summary`，非 open 条目含末尾 `  (status)`），照 `handoff view` 行原样抄（去掉行首 `- `）即可，勿只抄 summary。
- **`view`**：全局视图（认识整体），默认 stdout；`--save` 存盘（默认 `<项目根>/handoff-view.md`），属**用户所有、非权威、不 `check`**。
- 无 `python3` → **询问用户安装**；不可安装时**本技能不可用**（明确失败：sealed store 只读，手工改存储会被 EACCES 拒绝，也不该绕过 CLI）。

### 落点登记（每条判据维的落点·契约·作废条件·行为腿）

> **为什么有这张表**：判据维＝一条纪律。纪律的落地方式历来是「往散文里加一行」⇒ 落地物是**抄件** ⇒ 抄件会漂移 ⇒ 纪律被违反时静默 ⇒ 同一个根因反复复发。
> ⇒ 治本不是「把纪律搬进代码」，而是**给每条纪律一个落点**（事实自己的家）＋一条写明的**契约**（谁产生·谁能改·何时过期）＋一条**作废条件**（它盯的东西何时消失 ⇒ 依赖它的机制随之作废）＋**一条行为型腿**。
> **腿列由代码派生**（每条腿在自己的标注里指认「我证明哪一维」）⇒ 不抄第二份；新增判据维若不登记、或指认的腿没真跑过 ⇒ 门禁当场红。
> **作废条件是前置义务**：判据维的寿命＝它所盯的副本的寿命 ⇒ 新增一条维时**先写它什么时候该死**，否则它会在副本消失后长期空转。

<!-- landings:begin （由 FACT_LANDINGS 生成，勿手改）-->

| 判据维 | 事实 | 落点（文件·锚点） | 契约（产生｜可改｜过期） | 作废条件 | 行为腿 |
|---|---|---|---|---|---|
| `slots` | 库结构齐备：9 槽 ＋ index | `scripts/handoff.py` · `缺槽: ` | 产生：init 一次性建库｜可改：仅 CLI（工具直改会被写事件对账维抓住）｜过期：库目录被移走或删除 | 槽集合本身变更（增删槽）⇒ 本行作废，按新集合重写 | `v5.42.0 落点登记·slots：缺槽 ⇒ check 报「缺槽」（库结构不齐当场可见）` |
| `id` | id 的形、全局唯一、前缀与所在槽相符 | `scripts/handoff.py` · `id 重复 ` | 产生：CLI 分配（max+1 且永不复用）｜可改：仅 CLI（改号＝换条目）｜过期：条目被删且 id 转作废 | id 分配规则变更（前缀集或位数）⇒ 本行作废并重写 | `现状复现：live＋closed 同 id ⇒ check 报 id 重复` |
| `status` | 活条目的 status 在该型闭集内（closed 不是可写值） | `scripts/handoff.py` · `status 非法 ` | 产生：add/edit 写面｜可改：仅 CLI（关闭只经 close）｜过期：条目销账 | 各型 status 闭集变更 ⇒ 本行作废并重写 | `check 对 status=closed FAIL` |
| `blocked-stale` | 声称被挡、但挡住的东西已不再生效 ⇒ 红 | `scripts/handoff.py` · `status=blocked，但 blockedBy 指向的` | 产生：blockedBy 关系建立｜可改：仅 CLI｜过期：blocker 关闭／作废／被取代 | 补位池谓词改写（blocked 不再等价于「被挡」）⇒ 本行作废 | `正例：blocker 被 close 后 status=blocked 留在原处 ⇒ 红并给出三种修法` |
| `blocked-owner` | status=blocked 必须记下「在等什么」（blockedBy 或 waitingFor） | `scripts/handoff.py` · `status=blocked，但**没记在等什么**` | 产生：add/edit 写面｜可改：仅 CLI｜过期：条目销账或状态离开 blocked | 等待语义改由别的字段承载 ⇒ 本行作废 | `G′：blocked 且既无 blockedBy 也无 waitingFor ⇒ 红（修法可满足）` |
| `fields` | 未知字段 ＋ 必填字段缺失（按型） | `scripts/handoff.py` · `未知字段 ` | 产生：各型可改字段表｜可改：仅 CLI（扩字段须同批改判据）｜过期：键表变更 | 字段表变更 ⇒ 本行作废并重写 | `v5.42.0 落点登记·fields：未知字段 ⇒ check 报红` |
| `dates` | created/closed 是合法日期、非未来日、created ≤ closed ≤ today | `scripts/handoff.py` · `closed < created` | 产生：add/close 写面｜可改：仅 CLI｜过期：条目销账 | 日期口径变更（如允许时间戳）⇒ 本行作废 | `v5.42.0 落点登记·dates：created 是未来日 ⇒ check 报红` |
| `single-line` | summary 单行（不得含换行/制表）——写面即拒，是本维的权威闸 | `scripts/handoff.py` · `summary 含换行/制表` | 产生：写面（add/edit 当场拒）｜可改：仅 CLI｜过期：条目销账 | summary 改为多行结构 ⇒ 本行作废 | `v5.22 ⑥：`summary` 含制表 ⇒ 写入面当场拒（不是事后维才红）` |
| `next` | next 是合法 id、存在、且 status=open | `scripts/handoff.py` · `next: {nid} 不存在或已关闭` | 产生：close 的第二步（补位指针）｜可改：仅 CLI（人手钉回会被判红）｜过期：指针指向的条目销账 | 补位池谓词改写 ⇒ 本行作废 | `人手把 next 钉回被挡条目 ⇒ check 红（补位池跳过了，手钉这条路也得拦）` |
| `text-dangling` | 文本槽点名的 t/p/q/u 型 id 必须既不在册、也不在 trash/void 之外 | `scripts/handoff.py` · `但 live∪closed∪decisions 里没有这个 id` | 产生：作者写散文｜可改：作者（判据只读不算）｜过期：条目被改号或删除 | 文本槽不再承载 id 提及（或提及改由结构化引用承担）⇒ 本行作废 | `v5.42.0 落点登记·text-dangling：散文点了不存在的 id ⇒ check 报红` |
| `decision` | 裁定件 frontmatter id 与文件名一致、日期合法、status 在闭集 | `scripts/handoff.py` · `frontmatter id ` | 产生：add decision 写面｜可改：仅 decide（原地改 status）｜过期：裁定件销账 | 裁定件不再以文件承载（改结构化条目）⇒ 本行作废 | `v5.42.0 落点登记·decision：裁定件 id 与文件名不符 ⇒ check 报红` |
| `decision-pending` | status=proposed 的裁定件待追认 ⇒ 红 | `scripts/handoff.py` · `status=proposed ⇒ **待所有者追认**` | 产生：add decision｜可改：仅 decide（原地改 status）｜过期：被追认为终态 | d 型进入补位池或被别的维度覆盖 ⇒ 本行作废 | `d000112 正控①：`proposed` 裁定 ⇒ 红，且报错**自带一条命令的修法**` |
| `decision-prose` | 凡落裁定必走裁定件（散文里的 record 形态须有在册 d 号） | `scripts/handoff.py` · `凡落裁定必走裁定件` | 产生：库级形态表（跟库）｜可改：库主改形态表｜过期：形态表不存在则本维不启用 | 裁定只经结构化引用表达（散文不再承载裁定形态）⇒ 本行作废 | `t000376 正控：record 形态无 d 号 ⇒ decision-prose 红（10-19 只落散文的病根）` |
| `scope` | scope 登记指向活路径或 glob 有命中 | `scripts/handoff.py` · `scope 登记不可解析` | 产生：scope add｜可改：仅 CLI｜过期：登记指向的路径消失 | scope 登记不再以路径存在性为准 ⇒ 本行作废 | `v5.42.0 落点登记·scope：登记指向不存在的路径 ⇒ check 报红` |
| `void-reuse` | id 未复用已作废 id（void 拦截；出口＝unvoid） | `scripts/handoff.py` · `id 复用了已作废 id` | 产生：rm/unvoid 写面｜可改：仅 CLI｜过期：void 标记被清（unvoid） | void 机制取消（id 可自由复用）⇒ 本行作废 | `unvoid --restore 把条目搬回 live、trash 里那份清走、id 不重新分配` |
| `writes` | 写事件对账：内容哈希对不上＝未经 CLI 记录的写入 | `scripts/handoff.py` · `未经 CLI 记录的写入` | 产生：CLI 每次写｜可改：仅 CLI（`rebase --force` 才结案；结案**可撤销**——带旁证的事件**搬进侧档**不销毁，`rebase --undo` 可搬回）｜过期：写事件被收窗折叠 | 写事件台账取消（改用别的对账面）⇒ 本行作废 | `绕过 CLI 手改文件 → 报「未经 CLI 记录的写入」`；`v5.71.0 结案·负控：旁证事件在台账里 ⇒ 对账维报出那条历史旁证`；`v5.71.0 结案·正控：旁证事件**搬进侧档**（没有销毁）＋ 输出给出撤销出路`；`v5.71.0 结案·知情面：输出写明**第二项后果**（认账全部在册 id 不可撤销）`；`v5.71.0 结案·正控：台账里已没有那条旁证事件 ⇒ 那条历史旁证不再被报`；`v5.71.0 撤销·正控：`rebase --undo` 把旁证事件搬回 ⇒ 历史旁证**重新被报出来**`；`v5.71.0 撤销·负控：没有可撤销的结案 ⇒ 当场拒并给出可执行出路`；`v5.71.0 结案·变异自证：换回旧形（直接丢弃、不写侧档）⇒ 侧档不存在（腿有牙）` |
| `partition-case` | 同槽分区文件名大小写折叠后不得重名 | `scripts/handoff.py` · `仅大小写不同` | 产生：add 的 domain 分区｜可改：仅 CLI（改 domain 即改名）｜过期：分区文件被删 | 分区命名规则变更 ⇒ 本行作废 | `check 报出仅大小写不同的分区名` |
| `index` | index 的各槽计数与 next 与落盘一致 | `scripts/handoff.py` · `index 漂移` | 产生：每次写重建（handoff index）｜可改：仅 CLI｜过期：index 被删（重建即可） | index 不再落盘（改读时现算）⇒ 本行作废 | `v5.42.0 落点登记·index：index 计数与落盘对不上 ⇒ check 报红` |
| `fresh-queue` | 本班新增的 t 型条目必须被最近班段点名覆盖（散文里写到即算；批量可用 --covers） | `scripts/handoff.py` · `fresh-queue：` | 产生：班次台账的 refs 字段（写时提取）＋ covers 字段（例外出口）｜可改：仅 CLI｜过期：最后一个老班段被新班段取代（老口径分支随之死） | 覆盖声明改由结构化引用自动派生（作者不必列举）⇒ 本行作废 | `P1：本班登记的条目没被声明 ⇒ 必须报红（**牙在**：新条目没进任何班段的声明）` |
| `queue-legacy` | exit 里不该有队列渲染区（旧库残留） | `scripts/handoff.py` · `queue-legacy` | 产生：旧库的渲染区（旧形机器内容）｜可改：仅 CLI（sync-queue 剥除）｜过期：残留被剥掉即不再触发 | 队列区重新落盘 ⇒ 本行作废 | `v5.29.0⑨：旧库残留的区 ⇒ check 报 queue-legacy` |
| `prio-source` | live action 的 prio 在闭集内，summary 不以档位词元开头 | `scripts/handoff.py` · `prio-source` | 产生：add --prio ／ upgrade-prio 回填｜可改：仅 CLI｜过期：条目销账 | 档位词表变更 ⇒ 本行作废 | `d000108 判据：live 条目无 prio ⇒ prio-source 点名（旧形此处没人知道）` |
| `derived-counts` | 现态计数不入散文（写面形状闸） | `scripts/handoff.py` · `现态计数不该抄进散文` | 产生：写面守门（set/append）｜可改：仅 CLI｜过期：散文层不再承载叙述 | 计数不再入散文（派生物全部读时现算）⇒ 本行作废 | `d000109 判据：散文里存着现态计数 ⇒ derived-counts 点名到行（旧形此处没人知道）` |
| `sealed` | 封存态：.handoff/ 全树不得有可写位（未封存即红；**本命令现建的库不判**） | `scripts/handoff.py` · `def seal_store` | 产生：CLI 每次命令收尾自动回封｜可改：仅 CLI（unseal 是维护态）｜**本命令现建的库不判**（进门前它还不是库 ⇒「可写」是必然初始态，不是任何人 chmod 回来的 ⇒ 本维没有判别对象；v5.68.0）｜**「现建」按实物判**（库里有没有本 CLI 的产物 ⇒ 被删掉 index 的老库仍须判；空目录仍算现建；v5.69.0）｜过期：非 POSIX 平台无此保护 | 换用非权限位的封存机制 ⇒ 本行作废 | `seal 后全树无可写位`；`v5.69.0 封存维·负控：老库删掉 `index` 且被改回可写 ⇒ check 仍报红（旧形把它当现建 ⇒ 漏判一次）`；`v5.42.0 落点登记·sealed：库未封存 ⇒ check 报红` |
| `archive` | 冷档完整性：archive/*.jsonl 每行须为 JSON 且带 archived/text | `scripts/handoff.py` · `存在畸形行` | 产生：append/compact 搬入｜可改：仅 CLI（手改冷档即红）｜过期：历史被压成更冷的一层 | 冷档取消（历史不再单独存档）⇒ 本行作废 | `被挤出的班段进冷档`；`v5.42.0 落点登记·archive：冷档有畸形行 ⇒ check 报红` |
| `agents-block` | AGENTS.md 交接块与唯一源一致（仅在已有标记区时启用） | `scripts/handoff.py` · `def agents_block_text` | 产生：references/agents-handoff-block.md（唯一源）｜可改：仅改唯一源再重装｜过期：使用方仓不再装块 | 块机制取消 ⇒ 本行作废 | `check 内置块维：块与标准源一致 ⇒ 绿` |
| `block-installed` | 装过交接块的仓，块不见了 ⇒ 红 | `scripts/handoff.py` · `block-installed` | 产生：装过块那条 d 型事实登记｜可改：仅 CLI（rm 该记录即停用）｜过期：使用方仓不再用本技能 | 不再登记「装过块」这一事实 ⇒ 本行作废 | `v5.42.0 落点登记·block-installed：装过块却整段消失 ⇒ check 报红` |
| `rewrite-points` | 机制面重述点（同一事实的第二份陈述）只许待在豁免名单里，且豁免不得过期 | `scripts/handoff.py` · `rewrite-points：机制面重述点` | 产生：豁免名单（`REWRITE_EXEMPT`，唯一源在代码）｜可改：仅同批改代码｜过期：对应机制被消掉（豁免随即过期 ⇒ 闸红） | 重述点这套判据整体作废（机制面不再有第二份陈述）⇒ 本行作废 | `v5.44.0 重述点闸：机制面重述点超出豁免 ⇒ check 报红（新增即红）` |
| `discipline-present` | 机制面纪律**必须写在随件文档里**（纪律清单落成数据，锚点必现） | `scripts/handoff.py` · `discipline_present_violations` | 产生：纪律清单（`DISCIPLINE_PRESENT`，唯一源在代码）｜可改：仅同批改代码与随件文档（改纪律必同批改锚点）｜过期：该条纪律从清单里撤下 ⇒ 闸随即不判它 | 纪律必现这套判据整体作废（机制面纪律不再要求写进随件文档）⇒ 本行作废 | `v5.52.0 纪律必现闸：登记的纪律**都写在随件文档里**（纪律进闸也进文档）`；`v5.52.0 纪律必现闸·负控①：纪律没写在随件文档里 ⇒ 当场红`；`v5.52.0 纪律必现闸·负控②：新增纪律没同批写进随件文档 ⇒ 当场红`；`v5.52.0 纪律必现闸·负控③：随件文档不存在 ⇒ 当场红（不沉默跳过）`；`v5.52.0 纪律必现闸：纪律没进随件文档 ⇒ check 报红（纪律事实上没落地）` |
| `id-provenance` | 在册条目的**来历可追**（每个在册 id 都有 CLI 分配记录，或被基线认账） | `scripts/handoff.py` · `def id_provenance_violations(` | 产生：写事件台账的 `ids` 字段（CLI 分配记录）＋ `id_base` 基线（老库存量 id 的认账＝出处机制生效那一刻的 id 快照）｜可改：仅同批改代码（**新增分配 id 的写路径必须同批传 `ids`**，漏传⇒该 id 被判凭空出现；**`import` 还原库级事实面（void／trash）时也必须同批传 ids**，否则一次合法往返会被判「来历不可追」＝假红；v5.68.0）｜过期：写事件不再记分配 ⇒ 该事实随判据一起作废 | 出处台账这套判据整体作废（不再要求 id 的来历可追）⇒ 本行作废 | `v5.53.0 出处维·负控：正常写的条目**不红**（判据不是恒红）`；`v5.53.0 出处维·正控：手加的**新文件**里的条目 ⇒ check 报红且点名它`；`v5.53.0 出处维·耐洗：重建 `index` 之后**仍然红**（分配记录洗不掉）`；`v5.53.0 出处维·负控：老库（无分配记录无基线）的存量 id **不误伤**`；`v5.53.0 出处维·老库：基线还没建立 ⇒ 出一条**可执行**红项（不是静默不判）`；`v5.53.0 出处维·老库认账后：存量 id 认账 ⇒ 该维转绿（不误伤）`；`v5.53.0 出处维：老库认账后 + 手加新文件 ⇒ 只点名**外来那个**（存量 id 不误报）`；`v5.53.0 出处维·变异自证：摘掉**分配记录** ⇒ 正常写的条目也被判红（腿有牙）`；`t000486 前置：收窗前 check 绿`；`t000486 负控（--keep 0）：收窗后 check 仍绿（id_base 与 ids 一并保活）`；`t000486：二次收窗幂等——基线不丢、并集仍在（check 仍绿）`；`t000486 正控前置：手加外来 id ⇒ 收窗前红且点名它`；`t000486 正控：收窗后**仍然**点名同一个外来 id，且错误项逐项一致（判定不变也含红方向）`；`t000486 默认 keep（200）前置：合成事件后 check 绿`；`t000486 默认 keep（200）：折叠段含 id_base／ids 事件 ⇒ 收窗后仍绿`；`v5.68.0 跨库 import·正控：源库有过作废条目、目标库已有基线 ⇒ import 不红（还原回来的作废 id 已认账 ⇒ 出处维不判「来历不可追」）`；`v5.68.0 跨库 import·负控：抹掉台账里那批认账 ⇒ 出处维当场红（腿有牙）` |

<!-- landings:end -->
## 四、最短真实样例（初始化 → 交接一轮）

前置：项目根目录、解释器可用、已获用户显式授权建存储。
**解释器**：下文示例统一写 `python3`；**Windows 上改用 `python`**（那里通常没有 `python3`）。
`$H` 指本技能目录（通常在 `<项目>/.agents/skills/project-handoff`，各仓路径不同，故用绝对路径而非仓内相对路径）。

```bash
python3 "$H/scripts/handoff.py" init             # 建 .handoff/ ＋ 自动装标准交接块；自动生成 index
python3 "$H/scripts/handoff.py" add action --summary "修复登录重定向循环" --prio 高 --domain auth --src src/auth/login.ts:42
python3 "$H/scripts/handoff.py" add pitfall --summary "测试库必须先 seed，否则 check 全红" --domain test
printf '已完成认证重构；测试待补\n' | python3 "$H/scripts/handoff.py" set status --file -
python3 "$H/scripts/handoff.py" check               # 门禁：非零退出 = 不得收尾；含交接块漂移维
python3 "$H/scripts/handoff.py" confirm --seed 1    # 出题（两次须同 --seed）
python3 "$H/scripts/handoff.py" confirm --seed 1 --answers "<按 view 行原样逐行>"   # 判卷，PASS 才算交接完成
```

产出（摘录）：`handoff check` 打印 `handoff check: OK` 并落一条 `log` 快照；`confirm` 判卷通过打 `PASS`——**不 PASS ＝ 交接未完成**。接收方恢复上下文只读 `references/resume.md` 相位（`view` + `next` 即可接上）。
