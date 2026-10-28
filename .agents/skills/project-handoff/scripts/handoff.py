#!/usr/bin/env python3
"""handoff — 项目交接存储 CLI（单一写入口 + 机检门禁）

设计依据：交接存储设计简报（2026-09-21，维护者资产，不随件分发）
不变量：P1 不删（append-only）/ P2 可重建（无第二副本）/ P3 不静默。

子命令共 31 条，清单与语义见 SKILL.md 的「CLI」节（**单一源，本文件不复制**——
复制即第二份源，将来必漂：v2.0 之前这里抄了一份 17 条的旧清单，与现实差 14 条）。
"""
from __future__ import annotations

import argparse
import ast
import fnmatch
import glob
import hashlib
import io
import json
import os
import random
import re
import shlex
import shutil
import sys
import tempfile
import time
from datetime import date, datetime, timedelta
from pathlib import Path

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ID_RE = re.compile(r"^([tpducq])(\d{6})$")

# 文本槽里扫条目 id 用（`exit`/`summary` 的交接陈述面）。与死指针判据**刻意同源**——
# 之前本仓 `handoff-freshness-check.py` 自己抄了一份 `\bt\d{6}\b`，两处模式若各自演进
# 就会一次判了、另一次没判（双源缺口）。这里单一模式，两条判据共用。
#
# ⚠ v5.30.0：**不用 `\b`**。Python 的 `\b` 把**汉字当词字符** ⇒ id 紧跟汉字时**不存在词边界**
#   ⇒ 「修好了t000411这条」这类**最自然的中文写法扫不到** ⇒ 两处后果都伤：
#   ① **误报**（fresh-queue）：作者确实点了名，门禁仍判「没点名」⇒ 红
#      （2026-10-23 实测：班段写「修好了t000411这条」⇒ `check` rc=1 报「exit 沉默」）；
#   ② **漏报**（fresh-stale／fresh-false）：同一模式扫 ⇒ 紧跟汉字的 id **根本进不了检查**
#      ⇒ 「把活的说成死的」能逃过闸（比死的没标更误导接班人）。
#   仓库里已有同类先例（derived-counts 维注释）：「本仓实测被一个空格判瞎过，且瞎的时候打 OK」
#   ——**同一个病，第二次咬人，这次咬的是牙**。
# ⇒ 改成「非 ASCII 字母数字边界」：只有紧邻 **ASCII** 字母数字才算粘连（汉字、标点都不算）
#   ⇒ 中文行文里 id 贴着一个字也算「提及」。
#   **大小写不敏感**：id 的规范形是小写，但散文里写 `T000411` 同样是在指同一条 ⇒ 按同一 id 计，
#   免得因大小写把作者判成「没点名」（误报方向优先堵）⇒ 捕获后统一小写再查库。
FIND_ID_RE = re.compile(r"(?<![0-9A-Za-z])[tT]\d{6}(?![0-9A-Za-z])")
# v5.45.0（refs 化）：**点名**口径＝词边界的条目 id 形态（全部型，别只 t）
REF_ID_RE = re.compile(r"(?<![0-9A-Za-z])[tpducq]\d{6}(?![0-9A-Za-z])", re.IGNORECASE)
# 提及已闭条目时，**紧邻该 id** 必须带的显式关闭标记。**刻意收窄成显式标记而非推断**：
# 已闭/closed/完成/毕/已发布/已收口/已落地。措辞变了该改这张表，不是改判据去迁就。
CLOSED_MARKERS = ("已闭", "closed", "CLOSED", "已完成", "完成", "毕",
                  "已发布", "已收口", "已落地")
# ── d000105 第 0 层：**「紧邻」的操作化** ─────────────────────────────────────
# 旧判据是「同一行任意位置出现任一闭态词就算标记」。那让**自由散文**能替结构化状态
# 背书（实测：在册 exit 里 ``t000267`[中]（REF 双向误配完成，剩夹具）`` 这句里的「完成」
# 说的是子任务、不是条目闭态，却足以让整行过关），而反向判据若原样建在这套机制上，
# 第一天就会被合法散文顶穿——**两向的误判方向还不对称**：
#   正向（已闭须带标记）漏写 ⇒ 红，误判方向是「该写的没写」，安全；
#   反向（open 不许标已闭）误伤 ⇒ 红，误判方向是「不该写的被罚」，是假阳、会被绕过。
# ⇒ 闭态标记必须**贴着 id**：两者之间只容许空白、Markdown 反引号、括号类、档位记号
# 与极少量连接标点。散在别处的词**不参与判定**。
_TIER_TOK = r"(?:\[(?:高|中|低|high|med|medium|mid|low)\])"
# id 与标记之间容许的连接子：空白、反引号、各式括号引号、少量连接标点，外加**一个**档位记号。
# 刻意不含「。」「，」以外的句读与拉丁字母——那样就不是「紧邻」而是「同一句」了。
_GAP_CHARS = r"\s`·、,，:：;；（）()【】\[\]「」『』"
_CLOSED_GAP = re.compile(rf"^(?:{_TIER_TOK}|[{_GAP_CHARS}])*")


# ── v5.32.0（P1／批 A）：状态不再由作者抄写 ─────────────────────────────────
# 旧形（v5.31.0 及以前）：作者在散文里**手抄**条目状态，闸在写时与事后**双向**校验
# （`guard_state_claims` ＋ `fresh-stale`／`fresh-false`）。实测它**生产它要防的东西**：
#   · 写面会拒 113 处，其中 109 处（96%）是**带时点的历史陈述**被误判；
#   · 三句**没有毛病**的普通中文全部被拒写——「修好了 t000417 这条」（要求补「（已闭）」）、
#     「t000418 完成了迁移」（散文里的普通动词被当成状态标记 ⇒ 判成「把活的说成死的」）、
#     「t000417 的迁移收尾了」；
#   · 库里 21 处状态副本是**闸逼出来的**（同一事实 `closed/*.jsonl` 已有一份）。
# ⇒ v5.32.0：**散文不再承担状态断言**。
#   · 写面**两个方向都不再因状态拒写**（作者写什么都不拦）；
#   · **无时点**的行里、紧邻 id 的**括号型**闭态标记由写面**规范化掉**（带时点的历史陈述不动）；
#   · 状态由**渲染现算**补（`view` 在无时点的行里给每个提及标真状态）⇒ 读者看得到，不必抄；
#   · 判据面作废 `fresh-stale`／`fresh-false`（散文不再断言状态 ⇒ 拿散文比库内活状态没有意义）。
# 代价（如实写明）：机器不再替作者裁决语义（「把活的说成死的」不再拦写）⇒ **用可见性换拦截力**；
# 剩下的语义风险由渲染标注（真状态并排显示）承担。
#
# 时点＝**日期或版本号**（两者都把「当时」与「现在」分开）。
# ⚠ 与派生计数维的 `DATE_MARK_RE` **刻意不同**：那边只要日期（历史快照），
#   这边还要认版本号（「v5.31.0 落地：…」同样是历史陈述）——两处口径不同是**有意的**，
#   各在自己的 docstring 里写明了理由，别合并成一条。
_VER_RE = re.compile(r"(?<![0-9A-Za-z])v\d+\.\d+")


def has_timepoint(line: str) -> bool:
    """该行是否带**时点**（日期或版本号）⇒ 那是在说「当时」，不是「现在」。

    `DATE_MARK_RE` 定义在本文件后面的派生计数段（同一份「日期」口径，不另立）。
    """
    return bool(DATE_MARK_RE.search(line) or _VER_RE.search(line))


def _closed_marker_span(line: str, end: int) -> tuple[str, int, int] | None:
    """id 在 `line` 里结束于 `end`；返回**紧邻**它的闭态标记与该标记的 (起点, 终点) 偏移。

    只认 id **之后**的标记（这是全库的成文形态）。两者之间只容许空白、Markdown 反引号、
    括号类、档位记号与极少量连接标点（`_CLOSED_GAP`）——散在别处的闭态词**不参与判定**。
    偏移用于**规范化**（把标记连括号一起摘掉）；判定口径与旧形逐字一致。
    """
    tail = line[end:]
    m = _CLOSED_GAP.match(tail)
    off = m.end() if m else 0
    for mk in CLOSED_MARKERS:
        if tail.startswith(mk, off):
            return mk, end + off, end + off + len(mk)
    return None


# 括号对：规范化时**连括号一起**摘掉（只动窄形态）
_BRACKET_PAIRS = {"（": "）", "(": ")", "[": "]", "【": "】", "「": "」", "『": "』", "{": "}"}


def _code_spans(line: str) -> list[tuple[int, int]]:
    """行内 **code span**（成对反引号，含双反引号）的区间。

    **为什么要有它**（v5.38.0）：`引用` 与 `断言` **长得一样**但不是一回事——
    写在反引号里的「`t000417（已闭）`」是**引用一个形状**（证据、举例、旧形示范），
    不是**断言一个事实**。v5.32.0 的规范化不区分二者 ⇒ **把证据改坏了**
    （实测：`旧形要求写成 `t000417（已闭）`` 落盘变成 `` `t000417` `` ⇒ 证据被抹掉）。
    ⇒ 判据升级为三维：**载体 × 行 × 引用**——
      · **载体**：哪一类载体上的散文算「现况叙述」（⇒ 状态副本才有害）；
      · **行**：行内带时点 ⇒ 历史陈述，不动；
      · **引用**：在 code span 里 ⇒ 引文，不改写（但真状态仍在**引用外边**给出）。
    """
    spans: list[tuple[int, int]] = []
    i, n = 0, len(line)
    while i < n:
        if line[i] != "`":
            i += 1
            continue
        j = i
        while j < n and line[j] == "`":      # 反引号**游程**（`x` / ``x``）
            j += 1
        run = j - i
        k = j
        closed_at = -1
        while k < n:
            if line[k] == "`":
                m = k
                while m < n and line[m] == "`":
                    m += 1
                if m - k == run:              # 同长游程 ⇒ 配对成功
                    closed_at = m
                    break
                k = m
            else:
                k += 1
        if closed_at < 0:                    # 没有配对 ⇒ 不是 code span（当普通字符）
            i = j
            continue
        spans.append((i, closed_at))
        i = closed_at
    return spans


def _in_spans(pos: int, spans: list[tuple[int, int]]) -> tuple[int, int] | None:
    """`pos` 落在哪个 code span 里？⇒ 返回该 span；不在则 None。"""
    for s, e in spans:
        if s <= pos < e:
            return (s, e)
    return None


def _annotation_span(line: str, mk_start: int, mk_end: int) -> tuple[int, int]:
    """标记若被**括号**包住 ⇒ 返回连括号一起的区间；否则只返回标记本身。

    只动**括号型**（`t000417（已闭）`）——**裸词型不规范化**：散文里「t000418 完成了迁移」
    的「完成」是动词不是状态，摘掉它会把句子改坏。
    """
    before, after = line[:mk_start], line[mk_end:]
    for op, cl in _BRACKET_PAIRS.items():
        if before.endswith(op) and after.startswith(cl):
            return mk_start - 1, mk_end + 1
    return mk_start, mk_end


def normalize_state_claims(text: str) -> tuple[str, list[str]]:
    """把**无时点**的行里、紧邻 id 的**括号型**闭态标记规范化掉。

    返回 (新文本, 改动清单)。**带时点**（日期或版本号）的行**不动**——那是历史陈述，
    工具不裁决「当时是不是这样」。

    **v5.38.0：code span（反引号）里的窄形态也不动**——那是**引文**（证据、举例、
    旧形示范），不是状态断言 ⇒ 规范化会把证据改坏（实测过）⇒ **引用不改写**。
    真状态仍由渲染在旁边给出（见 `annotate_states`：标注落在**引用外边**）。
    """
    if not text:
        return text, []
    tail_nl = "\n" if text.endswith("\n") else ""
    out: list[str] = []
    changes: list[str] = []
    for i, line in enumerate(text.splitlines(), 1):
        if has_timepoint(line):
            out.append(line)
            continue
        _spans = _code_spans(line)
        spans: list[tuple[int, int, str, str]] = []
        for m in FIND_ID_RE.finditer(line):
            sp = _closed_marker_span(line, m.end())
            if sp:
                mk, s, e = sp
                s2, e2 = _annotation_span(line, s, e)
                if _in_spans(s2, _spans):       # **引文** ⇒ 不是断言 ⇒ 不改写
                    continue
                spans.append((s2, e2, mk, m.group(0).lower()))
        for s, e, mk, rid in sorted(spans, reverse=True):
            line = line[:s] + line[e:]
            changes.append(f"行{i}：{rid}「{mk}」")
        out.append(line)
    return "\n".join(out) + tail_nl, changes


def _state_maps(st: Store) -> tuple[dict[str, str], set[str]]:
    """(已销账条目 → 销账日期, 仍在册的 `t` 型 id)——两处读面（渲染标注）同源。"""
    closed: dict[str, str] = {}
    for f in sorted((st.d / "closed").glob("*.jsonl")):
        for r in read_jsonl(f):
            if r.get("id") and r.get("closed"):
                closed[r["id"]] = str(r["closed"])
    live: set[str] = set()
    for sl in ENTRY_SLOTS:
        for f in sorted((st.d / sl).glob("*.jsonl")):
            for r in read_jsonl(f):
                rid = r.get("id")
                if rid_re_match(rid) and rid[0] == "t":
                    live.add(rid)
    return closed, live - set(closed)


def annotate_states(st: Store, text: str) -> str:
    """在**无时点**的行里，给每个提到的 `t` 型条目**现算**标注真状态。

    只给读面用（`view`）——**不落盘**（L9：渲染不漂移）。带时点的行**不动**
    （那是历史陈述，工具不裁决「当时是不是这样」）。只标 `t` 型（与旧形同范围：
    `p`／`c`／`u`／`d` 不参与状态断言）。渲染标记用〔〕——与作者自己写的（已闭）区分开，
    免得读者把渲染物当成散文。
    """
    if not text:
        return text
    closed, live = _state_maps(st)
    tail_nl = "\n" if text.endswith("\n") else ""
    out: list[str] = []
    for line in text.splitlines():
        if has_timepoint(line):
            out.append(line)
            continue
        _spans = _code_spans(line)
        ins: list[tuple[int, str]] = []
        for m in FIND_ID_RE.finditer(line):
            rid = m.group(0).lower()
            ann = None
            if rid in closed:
                ann = f"〔已闭 {closed[rid]}〕"
            elif rid in live:
                ann = "〔在册〕"
            if ann is None:
                continue
            pos = m.end()
            _cspan = _in_spans(m.start(), _spans)
            if _cspan:
                # **引文**：标注落在**引用外边**（引用不被污染，真状态仍然给出）——
                # 写面不改引用、读面在引用旁给真相 ⇒ 同一口径（引用不是断言）。
                pos = _cspan[1]
            ins.append((pos, ann))
        _by_pos: dict[int, list[str]] = {}
        for _p, _a in ins:
            _by_pos.setdefault(_p, []).append(_a)
        for _pos in sorted(_by_pos, reverse=True):
            line = line[:_pos] + "".join(_by_pos[_pos]) + line[_pos:]
        out.append(line)
    return "\n".join(out) + tail_nl


def rid_re_match(rid: object) -> bool:
    return isinstance(rid, str) and bool(ID_RE.match(rid))

# 条目槽（JSONL、按分区落文件）
ENTRY_SLOTS = {
    "actions": {"type": "t", "part": "domain"},
    "pitfalls": {"type": "p", "part": "domain"},
    "commands": {"type": "c", "part": "purpose"},
}
UNCONF_SLOT = "unconfirmed"            # 单文件 unconfirmed.jsonl
DOC_SLOT = "decisions"                 # decisions/<id>.md（frontmatter + 正文）
TYPE2SLOT = {"t": "actions", "p": "pitfalls", "c": "commands", "u": "unconfirmed", "d": "decisions", "q": "closed"}
KEY_ORDER = ["id", "created", "createdAt", "origin", "bornShift", "summary", "prio", "status", "blockedBy",
            "waitingFor", "topic", "src", "detail", "closed", "outcome"]
ALLOWED_KEYS = set(KEY_ORDER)
SINGLES = ("status", "summary", "scope", "exit")
# 文本槽里**含散文**的那三个（`scope` 是源登记表，不写现态陈述 ⇒ 不在面内）
PROSE_SLOTS = ("status", "summary", "exit")

# ── 派生常量（v5.47.0／v5.48.0）：事实的**唯一源** ───────────────────────────
# 这些值此前散在**字面量**里（`ID_RE` 的字符类、消息里的「owner｜user｜external」、
# 判据文本里的「t/p/q/u」…）⇒ 文案抄了一份、改一处漏一处（实测已漂：正文写的 id
# 字母序与 `ID_RE` 不一致）。⇒ 事实只存这一份，文案插值。
def _derive_id_form() -> str:
    """id 的形态串（唯一源＝`ID_RE` 的字符类，去掉 `q`＝closed 专用的那个）。"""
    _m = re.search(r"\[([a-z]+)\]", ID_RE.pattern)
    _letters = [c for c in (_m.group(1) if _m else "tpducq") if c != "q"]
    return f"<{'|'.join(_letters)}><6 位>"


ID_FORM = _derive_id_form()
WAITING_FOR_FORMS = ("owner", "user", "external:<描述>")
RESOLVE_AS_FORMS = ("action", "pitfall", "decision")
# 类型字母的三个**子集**（v5.48.0：此前散在字面量里——消息与判据文本各抄一份）
IMPORT_TYPE_LETTERS = ("t", "p", "d", "c", "q")     # closed 记录可带的 `_type`
TEXT_DANGLING_TYPES = ("t", "p", "q", "u")           # 文本槽死指针检查参与的型
RESTORABLE_TYPES = ("t", "p", "c", "u")              # `unvoid --restore` 能搬回的型
IMPORT_TYPE_FORM = "|".join(IMPORT_TYPE_LETTERS)
TEXT_DANGLING_FORM = "/".join(TEXT_DANGLING_TYPES)
RESTORABLE_FORM = "/".join(RESTORABLE_TYPES)


def _slot_count() -> int:
    """槽数（唯一源＝`SINGLES` ＋ `ENTRY_SLOTS` ＋ `DOC_SLOT` ＋ `UNCONF_SLOT`）。"""
    return len(SINGLES) + len(ENTRY_SLOTS) + 2



# ── v5.38.0：「状态副本」的**面**（判据的唯一源）────────────────────────────
# **边界不是「哪个槽」，是三个维度：载体 × 行 × 引用。**
#   · **载体**：只有**现况叙述面**上的副本才有害（读者据以判断「现在怎么样」）。
#     现况叙述面＝三个**槽级**散文（`PROSE_SLOTS`）——热层散文就是给接班人看现况的。
#   · **行**：行内带时点 ⇒ 历史陈述 ⇒ 工具不裁决「当时是不是这样」（`has_timepoint`）。
#   · **引用**：code span 里的窄形态是**引文**（证据、举例、旧形示范）⇒ **不改写**；
#     真状态仍由渲染在**引用外边**给出（`annotate_states`）⇒ 引用与断言**同一口径**。
# **历史面**（载体自带日期、讲的是「当时」）：归档行（`closed/`）与裁定正文（`decisions/`）
#   ⇒ **不在面内**——工具不裁决历史文档。⚠ 这条不是假设：`edit` 能改**归档行**的
#   summary/outcome ⇒ 将来若把现况面扩到条目级散文，**必须**先按载体排除归档行与裁定件，
#   否则会**静默改写历史**（v5.38.0 把这条钉成腿，见 selftest 的 v5.38.0 ③）。
# **条目级散文**（live 条目的 `summary`／`detail`／`topic`）**刻意不在面内**：
#   实测**真实副本 0 处**（唯一两处窄形态**都是引文**）⇒ 扩面＝改用户写的字、而收益量不出来
#   （D5 收益律判负）⇒ **不扩**（推导过程见本版版本演进记录；随件文本不写仓内路径）。
STATE_HISTORY_CARRIERS = ("closed", "decisions")

# ── d000109：散文里的**现态计数**是一个不该存在的通道 ─────────────────────────
# 为什么拦形状而不是比值：槽计数由 `handoff index` 每次写重建、并由 `check` 的 `index` 维
# 对账 ⇒ 产生源已经存在且有闸。散文再抄一遍＝第二份**无人负责**的拷贝：它只随人的动作变，
# 而数随库的每一次写变。本仓实证两次——① 抄的那行漂了 72 条闭单而没人发现，因为兜它的
# 扫描器要求 `live：actions` 紧邻，真行写成 `live： actions`（多一个空格）⇒ 整行被跳过、
# 工具照打 OK；② 本条登记时写的 `actions 3` 在同一次收尾里就变成 4（登记动作自己占一条）。
# ⇒ 比值判据的覆盖面**取决于散文长得像不像**，而这正是它今天失效的原因。改成两件事：
#   · **写入面拦**（`guard_derived_counts`，挂 `set`／`append` 两条文本槽写路）；
#   · **存在性判据**（`derived-counts` 维：散文里还有这种行就红，不判它对不对）。
# 假阳代价＝换一句话（把数删掉、改指路语）；假阴代价＝散文里留一句没闸的话——**都不包含
# 「工具替一句假称背书」**，这是它比扫描器强的地方。
# 锚点闭集只收**现在时声明词**；`实算`／`当日实测`／`本轮输出` 属取证语（自带时点），不在面内。
DERIVED_ANCHOR_RE = re.compile(r"live|现态|实况|当前")
SLOT_NAMES = (*ENTRY_SLOTS, UNCONF_SLOT, DOC_SLOT, "closed")     # 名单取自 schema，不另立
SLOT_COUNT_RE = re.compile(
    r"(?<![A-Za-z])(?:" + "|".join(SLOT_NAMES) + r")[\s]*[＝:：]?\s*\d+")
DATE_MARK_RE = re.compile(r"(?<![\d.])\d{1,4}-\d{1,2}(?!\d)")     # 同行带时点＝历史快照，放行
# M5（t000314）：锚点＋「数字+汉字」（允许中间空白，否则「7 条」永远判不到）；
# 同行带日期或取证语（为准/实算/实测/当日/现算）＝历史快照/实算输出，放行。
DIGIT_HAN_RE = re.compile(r"(?<![A-Za-z0-9.`~])\d+[ \t]*[\u4e00-\u9fff]")
EVIDENCE_RE = re.compile(r"为准|实算|实测|当日|现算")


def derived_count_hits(text: str) -> list[tuple[int, str]]:
    """返回 (行号, 行文本)：M0＝锚点＋同行 ≥2 个「槽名＋数字」；M5＝锚点＋数字+汉字。
    两者都要求同行无日期；M5 另要求同行无取证语（实算/实测/为准/当日/现算）。"""
    hits: list[tuple[int, str]] = []
    for i, line in enumerate(text.splitlines(), 1):
        if not DERIVED_ANCHOR_RE.search(line):
            continue
        if DATE_MARK_RE.search(line):
            continue
        m0 = len(SLOT_COUNT_RE.findall(line)) >= 2
        m5 = bool(DIGIT_HAN_RE.search(line)) and not EVIDENCE_RE.search(line)
        if m0 or m5:
            hits.append((i, line.strip()[:80]))
    return hits


def guard_derived_counts(cmd: str, slot: str, text: str) -> None:
    """`set`／`append` 写文本槽时拦现态计数（d000109）。两条合法出口都印出来。"""
    if slot not in PROSE_SLOTS:
        return
    hits = derived_count_hits(_strip_rendered(text))
    if not hits:
        return
    die(f"{cmd} {slot}: 现态计数不该抄进散文（命中 {len(hits)} 行）：\n  - "
        + "\n  - ".join(f"行 {n}：{t}" for n, t in hits[:6])
        + ("\n  …" if len(hits) > 6 else "")
        + "\n　槽计数由 `handoff index` 每次写重建、`check` 的 `index` 维对账——散文抄一份＝"
        f"第二份无人同步的拷贝（本仓实证：它漂了 72 条闭单没人发现）。\n"
        f"　两条修法（选一）：① 删数、改指路语「现态以 `handoff index`／`view` 实算为准」；"
        f"② 若这是**当时**的取证快照，就在同行写明日期（如「09-25 现算」），判据按时点放行。")


# scope 建库即写注释头：空项目留空不再是 0 字节——0 字节＝「未执行 init」（t000018）
SCOPE_HEADER = ("# 对账范围（P3）：未决项可能落在哪（一行一路径/glob；# 注释允许）\n"
                "# 空项目可只留本注释——register-first：未登记 ≠ 未决源。\n")

# ---------------- add 参数面：按**型**声明，一处生成两侧（v3.2.0 / t000089） ----------------
# 旧形 `add --slot <槽>` 把五种异构记录的参数**并集**挂在同一子命令上：argparse 全接受、
# cmd_add 按槽只读子集，余下**静默丢弃**（实测 4/4 组合丢内容仍 rc=0 且 `check` OK——丢弃＝缺席，
# 产物本身合法，故下游无从反推；文档照抄即成假称）。现把参数面拆到型一级：**下面的 fields 列表
# 既是该型子命令的 flag 面、又是 cmd_add 消费的键**，两侧同源；main() 的自检逐型比对 argparse
# 实得 dest，任一侧被单独改动即当场报错（不做"看起来能用"的沉默）。
ADD_KINDS: dict[str, dict] = {
    "action":   {"slot": "actions",   "part": "domain",
                 "fields": ["summary", "prio", "domain", "status", "blockedBy", "topic", "src", "detail", "waitingFor"],
                 "live_status": {"open", "blocked"}},
    "pitfall":  {"slot": "pitfalls",  "part": "domain",
                 "fields": ["summary", "domain", "status", "blockedBy", "topic", "src", "detail", "waitingFor"],
                 "live_status": {"open", "fixed", "blocked"}},
    "command":  {"slot": "commands",  "part": "purpose",
                 "fields": ["summary", "purpose", "status", "blockedBy", "topic", "src", "detail", "waitingFor"],
                 "live_status": {"open", "blocked"}},
    "decision": {"slot": "decisions", "part": None,
                 "fields": ["title", "body", "status", "supersedes", "domain", "topic"]},
}
KIND2SLOT = {k: v["slot"] for k, v in ADD_KINDS.items()}
# 裁定件 status 闭集（`add` 的写入面、`check` 的 `decision` 维、`decide` 三处共用一份）
DECISION_STATUSES = ("proposed", "accepted", "deprecated", "superseded", "rejected")
# 非 `proposed` 即终态：追认过了。`decide` 只**提示**不拦（拦了就成「存储锁死在 FAIL」，
# p000122），出口是「改回去或另立新裁定」。
DECISION_TERMINAL = tuple(s for s in DECISION_STATUSES if s != "proposed")


def decision_pending(fm: dict) -> bool:
    """待追认＝frontmatter 的 `status` 恰是 `proposed`（闭集里唯一那个**非终态**）。

    单独成函数是为了让 `check` 的一处判读可被夹具换掉做变异自证——判据写在函数里
    就换得掉，写死在判据体内就只能在真源上手改（d000111 同款做法）。
    """
    return fm.get("status") == "proposed"
SLOT2KIND = {v: k for k, v in KIND2SLOT.items()}
SLOT_FIELDS = {v["slot"]: set(v["fields"]) for v in ADD_KINDS.values()}


def live_status_of(kind: str) -> set[str]:
    """该型条目在 live 区的 status 值闭集（缺省视为 open）。closed 不在其中：
    关闭唯一入口＝`close --outcome`（edit/add 拒收，t000138——否则旁路写入会造出
    无 closed/outcome、不迁 closed/ 的半关行，并混进补位池）。

    **`pitfall` 的 `fixed` 不是销账**（2026-10-03 用户裁定改语义）：它表示
    「这个坑对应的缺陷已修，**留案以免重犯**」——条目**仍留在 live 区**、仍被
    `check`/`view`/`index` 当活条目、仍计入各槽计数，**不进 `closed/`、不迁走、
    不销账**。记成 `fixed` 的坑与记成 `open` 的坑，在**绝大多数判据面前等价**：
    值域校验（只验「在不在闭集里」）与各槽计数、补位池、视图呈现**都不看这个值**。
    **唯一的例外是 next 指针判据**——它要求 next 指向 `open` 行，所以 `fixed` 的坑
    不能当 next（实测：`next <fixed 的坑>` rc=0 但随后 `check` rc=1 报
    「status='fixed'，不是 open」）。而那是在**守 next 的有效性、不在销坑**。
    换句话说 `fixed` **基本是自述，不是账**——别把「大部分坑都 open」读成「大部分坑都没
    修」（本库实测过一批：多数有守卫已修、有意设计的不算缺陷，真缺陷仍在的是少数）。
    要销账走 `close --outcome`，那是另一回事。
    **更正**：先前此处写「唯一读它的是值域校验」是**错的**（独立审计实测证伪）——
    `check` 的 next 指针判据也读 status：把一条 `fixed` 的坑设成 next，`check` 会 rc=1 报
    「status='fixed'，不是 open」。所以它**有**一个消费者，但那个消费者是在**守** next 指针
    的有效性、不是在销坑。**别为此再加闸**：给一个刻意「不被依赖」的状态造依赖，与本语义
    的立意相反。
    """
    return ADD_KINDS[kind].get("live_status", set())


# v5.18.0（G′）：`waitingFor` 的值域。阻塞有三型——被库内 id 挡（`blockedBy` 能表达）、
# **等所有者**、等用户答复/等外部条件；后两型**没有库内 id 可指**，此前无法表达 ⇒
# 条目只能硬写 `status=blocked` 而不记「在等什么」⇒ 零消费点的态（本仓 t000009／t000127）。
WAITING_FOR_RE = re.compile(r"^(owner|user|external:.+)$")


def guard_waiting_for(val) -> None:
    """`waitingFor` 值域校验（写入面）——错值落盘后唯一能改它的路又是 rm ＋ 重加。"""
    if val is None or str(val).strip() == "":
        return
    if not WAITING_FOR_RE.match(str(val).strip()):
        die(f"waitingFor 值域非法：{val!r}——闭集＝{'｜'.join(WAITING_FOR_FORMS)}"
            "（等谁/等什么必须能被人读懂，不能留空）")


def guard_single_line(cmd: str, val) -> None:
    """`summary` 必须**单行**（不得含换行/制表）——写入面拦。

    为什么要有这道（v5.22.1 实测）：`single-line` 维只看**事后**，而仓里的规矩是
    「**垃圾进不了账**，而不是事后清」——落盘时那行垃圾已经进了 store，还占了 `summary`
    的字预算、还让 view 的一行渲染断成两行。与 `single-line` 维**同口径**
    （禁的就是换行与制表两个）。
    """
    if not val:
        return
    s = str(val)
    if "\n" in s or "\t" in s:
        die(f"{cmd}: --summary 含换行/制表（须单行）——"
            f"一行说一件事；要分段就写进 --detail")


def guard_blocked_by(st: Store, cmd: str, val) -> None:
    """`blockedBy` 必须指向**在册**的 id（写入面拦）。

    为什么要有这道（v5.21.1 实测）：池谓词③只认「**还活着**的 blocker」⇒ 指向不存在 id
    的行**照样入池**（被当成可推的活派给接班人）；而条目行会显示「等 t999999」⇒ 接班人
    拿到的是一条**指向幽灵的指令**（去等一个根本不存在的条目）。写面拦掉这类手误（多半是
    打错 id），判据面继续管「指向**已死**的东西」（时序级，blocked-stale 那道）。
    """
    if not val:
        return
    v = str(val).strip()
    if not v:
        return
    known = {r.get("id") for r in st.load_live() + st.load_closed()}
    dd = st.decisions_dir()
    if dd.is_dir():
        for f in dd.glob("*.md"):
            known.add(f.stem)
            fm = _frontmatter(f)
            if fm.get("id"):
                known.add(fm["id"])
    if v not in known:
        die(f"{cmd}: --blockedBy 指向的 id {v!r} **不在册**（live／closed／decisions 都没有）"
            f"——多半是打错了：先 `handoff add` 建那条，或改指真实存在的 id"
            f"（判据面只管「指向已死的东西」，这类手误在写入面拦）")


def guard_status(kind: str, val) -> None:
    if val is not None and val != "" and val not in live_status_of(kind):
        die(f"status {val!r} 非法（该型合法：{sorted(live_status_of(kind))}，缺省=open）；"
            f"关闭唯一入口＝close --outcome")


UNCONF_FIELDS = {"summary", "src", "detail"}      # 候选行落盘面（`--ref` 存成 src）
CLOSED_FIELDS = {"summary", "detail", "topic", "outcome"}


def guard_partition(where: str, key: str, val) -> str:
    """分区键（domain/purpose）**会被拼成文件名**（`<slot>/<值>.jsonl`），故必须先校验。

    缺陷 p000046：值里带 `/` 会拼出子目录（`commands/a/b.jsonl`），而加载面用
    `glob("*.jsonl")` **不递归** ⇒ 那条已登记的条目对 `check`/`view`/`index` **完全
    隐形**：check 报 OK、index 计数 0、现实 1，且无任何东西报错。

    允许 CJK（本库实际在用「交接」「发布」「门禁」等作 domain），禁的是**路径语义**：
    分隔符、NUL、`.`/`..`、前后空白、超长名。不用白名单字符集——那会把 CJK 和将来
    合理的命名一起拒掉；用「不能改变路径指向」来判，才不会误伤。
    """
    if val is None:
        return "_global"
    v = str(val)
    bad = []
    if not v or not v.strip():
        bad.append("空")
    if v != v.strip():
        bad.append("前后有空白")
    if v in (".", ".."):
        bad.append("是路径相对段")
    if any(c in v for c in ("/", "\\", "\0")):
        bad.append("含路径分隔符/NUL")
    if ":" in v:
        # Windows：**盘符相对**（`C:evil`）解析到该盘当前目录而非 store ⇒ 写到 store
        # 之外；`ok:hidden` 是 NTFS 备用数据流，`glob` 永远扫不到。两者都**改变路径
        # 指向**，与分隔符同级，不是超纲要求（本技能正文承诺支持 Windows）。
        bad.append("含 `:`（Windows 盘符相对 / 备用数据流）")
    # Windows 对尾随空格/点的设备名（`com1 .txt`）同样按设备处理 ⇒ 一并去掉。
    # **刻意不拦 Windows 保留设备名**（CON/NUL/COM1…）——曾按推演加过，Windows 10.0.26200
    # 实测证伪：经 Win32 `CreateFile`（＝CPython 走的那条路）`CON.jsonl`/`NUL.jsonl`/
    # `con.jsonl`/`COM1.jsonl` **全部创建成功、`File.Exists=True`、且目录枚举可见**。
    # 设备名解析发生在 **cmd/PowerShell 路径层**，不在 `CreateFile` 层；用 `New-Item` 验会
    # 因两层解析不一致得到自相矛盾的结果（`New-Item` 说没建成、目录里却有）。拦它是误拒。
    # 同理不拦尾随空格/点（`com1 .txt`、`nul .jsonl`、`con..jsonl` 实测均正常创建）。
    if any(ord(c) < 32 for c in v):
        # 只拦 **ASCII C0**（< 0x20）：这类会串行化、破坏文件名结构。
        # `\x7f`／ZWSP／RTL **刻意不拦**——它们不改路径指向，p000046 幽灵模式
        # 不复现（glob/index/check 都正常），拦了属超纲；残留后果只是 `ls` 不可见
        # 导致可能重名，与「条目不可见」不是一回事。
        bad.append("含 ASCII C0 控制字符")
    if len(v) > 64:
        bad.append(f"超长（{len(v)} > 64）")
    if bad:
        die(f"{where}: 分区键 {key}={v!r} 不可用作文件名（{'、'.join(bad)}）。"
            f"它会被拼成 <槽>/<值>.jsonl；带分隔符会写进子目录、含 `:` 或为设备名会写到别处"
            f"或静默丢失，而加载面不递归 ⇒ 条目就成了 check/view/index 都看不见的幽灵。"
            f"用单段普通名字（可含中文），别用 `/` `\\` `:` 或设备名。")
    return v


def editable_fields(slot: str) -> set[str]:
    """该槽**条目实际可承载**的键集——edit 的 flag 面由它并集生成，两侧同源不另立名单。

    分区键（domain/purpose）可改＝换分区文件；closed 归档行只可改摘要类字段＋结局；
    unconfirmed 走自己的落盘面（`outcome` 属关闭动作，不由 edit 伪造）。
    这里**不再回落到 `ALLOWED_KEYS`**：回落会让表外槽接受任意存储键，与文档承诺相反。
    """
    if slot == "closed":
        return set(CLOSED_FIELDS)
    if slot == UNCONF_SLOT:
        return set(UNCONF_FIELDS)
    if slot == DOC_SLOT:
        return set()                            # 决策文档不走 edit（改判＝另开一条 --supersedes）
    kind = SLOT2KIND.get(slot)
    return set(ADD_KINDS[kind]["fields"]) if kind else set()


EDIT_KEYS = sorted({f for s in (*SLOT_FIELDS, UNCONF_SLOT, "closed") for f in editable_fields(s)})

# 条目写入类命令：都要求存储已存在（见 main 的守卫）。建库只归 init / import（migrate 流程）。
WRITER_CMDS = {"add", "close", "resolve", "set", "retitle", "edit", "rm", "unvoid", "unconfirmed",
               "next", "sync-queue", "decide", "compact-writes"}


# ── v5.35.0（B2）出路律：错误文案的**出路表**（判据的唯一源）────────────────
# 一句报错若不给下一步，用户撞上就得自己想 ⇒ 那是让人背流程（工具的欠账）。
# 这里把「出错了 → 当场可执行的下一步」集中在**一张表**里：`die(msg, key="…")`
# **按站点显式声明的键**取出路并追加 ⇒ 加一条出路＝改这张表一行 ＋ 在站点声明那个键。
# ⚠ 出路必须**当场可执行**（块面纪律第 4 条：出口不能只是「去看看」这种不可执行的建议）。
# ⚠ **v5.46.0（H3 结构性根因）**：键不再由消息里的**处境词子串**推断 ⇒ 旧形里泛化键
#   （如「未找到」）会吃掉**将来**新写的消息 ⇒ 用户拿到**指错路**的修法，而出路律
#   （判「用户看到的那段话」）**判不出这条路对不对** ⇒ 现在由站点写死一行，声明错当场红。
# ⚠ 一个键可覆盖多条同处境的报错（出处不同、要走的路一样）——但**每个站点都要显式声明**。
DIE_FIXES: dict[str, str] = {
    "live / closed / decisions 均无": "它三个地方都没有 ⇒ 找相近的：`handoff filter --topic <词>`／"
                                     "`handoff filter --id <id>`；确实要新开一条：`handoff add action --summary ...`。",
    "未找到候选": "候选不在库里 ⇒ `handoff unconfirmed list` 看现存的候选；确认要撤这条："
                  "`handoff unconfirmed resolve <id> --as action`（按实际类型选 `action`／`pitfall`／`decision`）。",
    "未找到 live 条目": "它不在 live 槽 ⇒ `handoff view --id <id>` 看它在 closed／trash 的哪；"
                        "确实要新开一条：`handoff add action --summary ...`。",
    "不存在或已关闭": "先看它的下落：`handoff view --id <id>`（已闭的在 `closed/`、作废的在 `trash/`）。",
    "已作废": "它已作废 ⇒ 先解除：`handoff unvoid <id>`（要连条目一起找回：`handoff unvoid --restore <id>`）。",
    "没有可撤销的结案": "库里没有可撤销的结案（`writes.jsonl` 里没有带 `rebased_to` 的 `__rebase__` 标记）⇒ "
                       "要重新结案：`handoff rebase --force`（带旁证的事件会**先搬进侧档**、不销毁）。",
    "侧档已丢失": "侧档被删过 ⇒ 那些旁证事件已无法搬回 ⇒ 重新结案：`handoff rebase --force`；"
                 "要找回旧侧档：从 `git log`/备份里取 `.handoff/writes-rebased-*.jsonl` 再手工搬回。",
    "force 与 undo 互斥": "二选一：结案用 `handoff rebase --force`（把带旁证的事件搬进侧档），"
                          "撤销上一次结案用 `handoff rebase --undo`（把它们搬回）。",
    "不在 void": "它没被作废 ⇒ 查下落：`handoff view --id <id>`；若确在 `trash/` 里，"
                 "恢复那条的命令是 `handoff unvoid --restore <id>`。",
    "blockedBy 引用": "先看引用关系：`handoff view --id <id>`（谁指向它）⇒ 先解掉引用再删。",
    "supersedes 引用": "先看替代关系：`handoff view --id <id>`；确要删先 `handoff decide <id> --status deprecated`。",
    "标准源缺标记": "补上 `<!-- handoff:begin -->`／`<!-- handoff:end -->` 标记；"
                   "标准源该长什么样：`handoff agents-block --print`。",
    "导入后 check 未过": "按 `handoff check` 报出的那几条逐条改（内容已落地，别重复导）。",
    "非法 JSON": "修好那一行再导：`handoff import <file>`（格式见 `references/cli.md` 的 import 段）。",
    "缺 meta 头": "补上 meta 头（`_format=handoff`）再导：`handoff import <file>`。",
    "缺合法 _id": "补上 `_id`（形如 `d000001`）再导：`handoff import <file>`。",
    "缺 _id": "补上 `_id` 再导：`handoff import <file>`。",
    "与文件名不符": "把 frontmatter 的 `id` 改成与文件名一致（`d000001` 形）再导：`handoff import <file>`。",
    "created 缺或非日期": "把 `created` 补成 `YYYY-MM-DD` 再导：`handoff import <file>`。",
    "非日期": "把日期字段补成 `YYYY-MM-DD` 再导：`handoff import <file>`。",
    "不支持的": "改成受支持的形态再导：`handoff import <file>`"
                "（受支持的槽与形态见 `references/cli.md` 的 import 段）。",
    "清单形状不对": "清单形状不对（导出清单须带**库级事实面**三段：已作废 id 名单／trash／冷档）"
                    "⇒ 重导一份：`handoff export --out <文件>`；手写的清单照 `references/cli.md` 的"
                    "「导出/导入」段补齐那三段再 `handoff import <文件>`。",
    "回读不通过": "先查 `.handoff/trash/` 与 git，确认那条还能捞回来再动手。",
    "回读查不到": "先查落点分区文件（`.handoff/actions/` 等）有没有那几行；有就是读面问题、"
                  "没有就是写入丢了 ⇒ 重导一次。",
    "仍在 void 里": "void 标记写丢了 ⇒ 看 `.handoff/void/` 里那行，再 `handoff unvoid <id>` 重试。",
    "答案非 JSON": "答案要是一段 JSON（`{\"ok\": true}` 这样）⇒ 重问一遍。",
    "未给任何可改字段": "要改的字段名见 `handoff edit --help`；至少给一个（`--summary`／`--detail`／`--prio`…）。",
    "条目不接受": "该型能改的字段见 `handoff edit --help`；别的字段要改就新开一条再销旧的。",
    "同值无操作": "要改内容：`handoff edit <id> --summary ...`／`--detail ...`；要搬分区换一个不同的值。",
    "字符超上限": "写少点：git／库里能查到的内容不复述，只留结论＋落点（id 或 file:line）。",
    "行 > 单班段上限": "班段只写「做了／发现／裁定／接下来」四件事 ⇒ 压到 10 行正文内，"
                       "或拆成两次 `handoff append exit`。",
    "班段不存在": "先看热层现有班段：`handoff read exit`（或 `handoff view` 的 exit 节）；"
                  "冷档里的历史班段不改标题。",
    "标题匹配不唯一": "用 `--at <序号>` 指定唯一班段（序号按 `handoff view` 的 exit 节顺序，1＝最新）。",
    "无事可做": "想改别的字段：`handoff edit <id> --status ...`；要另立一条：`handoff add decision --title ...`。",
    "开不了锁文件": "确认该路径归属后由属主删掉它，或给本存储换一条解析后的路径。",
    "未找到": "先看它在不在：`handoff view --id <id>`（live／closed／decisions 都没有就 "
              "`handoff filter --topic <词>` 找相近的；确实要新开一条：`handoff add action --summary ...`）。",
    "不改裁定": "改判据＝`handoff decide <id> --status accepted|rejected|superseded`"
                "（要另立一条：`handoff add decision --title ...`）。",
}


# ── v5.39.0（B2′）出路律第二刀：**出路必须当场可执行**（五形，缺一即无出路）────
# 为什么再切一刀：旧口径「反引号里出现任何东西就算出路」太松——实测 112 个 die 站点里
# 有 4 处**只有诊断、没有下一步**（用户撞上仍要自己想怎么办 ⇒ 工具的欠账没还完）。
# 现在的判据＝**五形**（唯一源＝`exit_shape`）：
#   ① 命令形：反引号里出现**可复制**的调用——`handoff <子命令>`／子命令本身／已知外部命令。
#   ② 参数形：出现 `--flag`——用户把它加到**当前这条命令**上就能走。
#   ③ 用法形：文本点明**合法形态**（需要／只支持／闭集＝／可接受：／形如…）。
#   ④ 指令形：**枚举**出来的祈使形态（见下表）——散文动作也算出路，但**不可复制**，
#      所以它是下界不是上界（口径说明见 `references/cli.md`：命令形才算「可复制」）。
#   ⑤ 无需动作形：明说「无需动作」／「没有命令可跑」，或属内部不变量（用户无动作可做）。
# ⚠ **形态表是数据不是判据**（形态从**真实样本**穷举；新说法要先加进这张表，
#   不加就判红）——「出路」因此是**可枚举**的，不靠模型现场判断（形态能从真实样本穷举
#   就切列＋枚举查表；模糊匹配族默认不进门禁）。
# ⚠ 为什么不是「只认命令」：那会把诚实的散文出路（如「用单段普通名字」）判死 ⇒ 用户被逼
#   去抄一条没有的假命令。实算（2026-10-24）：真缺口只有「**没有下一步**」那几处。
#
# ── 义务面与「两问」（v5.39.0／批 D 的落法）────────────────────────────────
# **面向用户的义务**的可枚举全集＝三处：①**写面拒写**（`die` 站点；数量由 selftest 的
#   出路闸那条腿实算）②**读面红项**（`CHECK_DIMENSIONS` 表，每条自带规则文本）
#   ③**合同面**（交接块合同句，标准源生成）。⇒ 完整性因此**机械可判**：
#   义务**不必另立登记实体**（不靠「每个机制都有标记」这种人工口径——那正是批 D
#   原案里说不清代价的地方；此处用「义务＝用户当场要做的下一步」把它化掉）。
# ⇒ **两问**（**新增义务时先答**；判「是」就**改机制**，别加闸）：
#     ② 它是否要求在别处重述一个活事实？　③ 它是否要求用户记住某条规则？
#   实算（2026-10-24，义务面逐行判读）⇒ **两问全否** ⇒ 做成闸会**恒绿**
#   ⇒ 按「持续消费才进门禁；偶发消费写进 docstring；写不出有牙的判据就不进门禁」
#   ⇒ **两问不作闸**，只作设计期纪律。
#   为什么两问能被机械地推出「否」：出路在**当场**给出（③ 不成立）；出路是**命令**时
#   由工具算（② 不成立）——这两条正是上面那把尺在判的东西。
#   ⇒ 代价（如实）：语义层的两问机器判不了 ⇒ 新增义务时**靠人答**；这条纪律没有闸，
#     复发只能靠「新增时有人答」＋ 出路闸（形态层）兜底。
# ⇒ **第三问（机制选型，v5.41.0）**：新增任何机制（判据维／门禁／腿）前再答一句——
#     **它守的是「事实」，还是「副本的状态」？**
#     · 守事实（不依赖任何副本）⇒ 可长期在册（实测：守事实的判据维在册 12~25 版）。
#     · 盯副本（拿副本的状态当判据）⇒ 死因同构：**副本被消灭 ⇒ 本维随之作废**
#       （实测：盯副本的维分别只活了 22 版／17 版／1 版即作废）⇒ 它的治法必须是
#       「**消灭副本**」，不是「盯着副本」；且新增时必须写明「**它盯的东西何时消失
#       ⇒ 届时本维作废**」（生命周期字段 ⇒ 归入落点登记那一项）。
#     ⇒ 机器帮不上（这是**选型**判断，不是形状）⇒ 与前两问同作**设计期纪律**。
def _real_cli_verbs() -> tuple[str, ...]:
    """**真实子命令表**＝parser 树自己（唯一源）——不是手抄副本（v5.62.0 · t000466）。

    **为什么不是副本**（根因推导，见本技能的**版本演进记录** v5.62.0 条目）：
    旧形是一份**手抄字面量**（32 个子命令各写一遍）⇒ 它与 argparse 的实表是**两份** ⇒
    加子命令而忘了改副本 ⇒ ① 文档「命令全表」漏项（渲染自副本）② 出路闸把**真命令**
    判成「命令不存在」（假红）③ 反向漂移时出路闸**放行不存在的命令**（假绿＝v5.41.0
    那条闸要防的病）⇒ 而**没有任何闸**对账二者（重述点闸只实算 `legacy_scan`／
    `doc_facts` 两类；机制覆盖登记只管**载体面**＝散文与源码文本 ⇒ 代码内的常量副本
    **整类无机制覆盖**）。
    ⇒ **治法＝消灭副本**（不是「盯副本」）：本仓 v5.41.0 已裁定的机制选型判据写着
    「盯副本的治法必须是**消灭副本**，不是盯着副本」⇒ 加对账闸那条路**判负**。
    ⇒ 真源现成：`build_parser()` 自 v5.10.0（d000110）起就是**参数面的唯一构造口**
    ⇒ 派生表与实表**同一份** ⇒ 副本在**原理上**不再可能。
    ⚠ 必须**惰性**求值：`build_parser` 定义在本文件末尾 ⇒ 模块顶层调用会 NameError。
    """
    ap = build_parser()
    for act in ap._actions:
        if isinstance(act, argparse._SubParsersAction):
            return tuple(sorted(act.choices.keys()))
    return ()


_CLI_VERBS_CACHE: tuple[str, ...] | None = None


def cli_verbs() -> tuple[str, ...]:
    """`CLI_VERBS` 的**唯一入口**（惰性派生 ＋ 缓存一次）。

    所有消费点走这里 ⇒ 加子命令时**自动跟上**（文档渲染、出路判据、出路命令闸
    三处同时生效）⇒ 不再需要「记得同步副本」这件事（副本已不存在）。
    """
    global _CLI_VERBS_CACHE
    if _CLI_VERBS_CACHE is None:
        _CLI_VERBS_CACHE = _real_cli_verbs()
    return _CLI_VERBS_CACHE
EXIT_EXTERNAL_CMDS = ("pgrep", "git", "sed", "grep", "ls", "cat")
EXIT_TICK_RE = re.compile(r"`([^`\n]+)`")
EXIT_FLAG_RE = re.compile(r"--[a-z][\w-]*")
EXIT_USAGE_RE = re.compile(
    r"需要\s*\S|只支持\s*\S|只收\s|只能\s|可用：|闭集＝|合法：|可接受：|不在闭集|"
    r"须为\s*\S|须给\s*\S|须单行|形如\s|可恢复："
)
EXIT_NOACTION_RE = re.compile(r"无需动作|没有命令可跑|内部不一致|自检|不可能|不该出现|异常")
# 指令形态表：**祈使形态的字面串**（穷举自 142 个真样本）。新增说法先加这里。
EXIT_DIRECTIVE_FORMS = (
    "请用", "别用", "改成", "改用", "改指", "补上", "补回", "补齐", "删掉", "去掉",
    "换成", "先查", "重问", "重导", "重跑", "压到", "写少点", "另开一条", "整理成",
    "指定", "新建", "带上", "点掉", "只留", "合并成", "喂内容",
)

EXIT_SHAPES = ("命令", "参数", "用法", "指令", "无需动作")


def _exit_has_command(text: str) -> bool:
    """反引号里有没有**可复制**的调用：`handoff <子命令>`／子命令本身／已知外部命令。
    动词表＝CLI 的真实子命令集（`cli_verbs()`＝parser 树派生，唯一源）——不认得的词不算出路。"""
    verbs = cli_verbs()
    for inner in EXIT_TICK_RE.findall(text):
        words = inner.strip().split()
        if not words:
            continue
        head = words[0]
        if head == "handoff" and len(words) > 1 and words[1] in verbs:
            return True
        if head in verbs or head in EXIT_EXTERNAL_CMDS:
            return True
    return False


def exit_shape(text: str) -> str:
    """出路形态（v5.39.0 判据的**唯一源**）：'命令'／'参数'／'用法'／'指令'／'无需动作'；
    空串＝**没有出路**（用户撞上得自己想下一步 ⇒ 工具欠账）。"""
    if _exit_has_command(text):
        return "命令"
    if EXIT_FLAG_RE.search(text):
        return "参数"
    if EXIT_USAGE_RE.search(text):
        return "用法"
    if any(f in text for f in EXIT_DIRECTIVE_FORMS):
        return "指令"
    if EXIT_NOACTION_RE.search(text):
        return "无需动作"
    return ""


def exit_key_violations(src: str) -> list[str]:
    """**出路键闸**（v5.46.0 · H3 结构性根因）：出路必须**显式声明**，且声明得对。

    三项：
    ① 站点声明的 `key` 必须在 `DIE_FIXES` 里（写错键 ⇒ 用户拿到**错路**）；
    ② `DIE_FIXES` 的每一行必须**至少被一个站点声明**（不许有死行——死行＝没人走的那条路）；
    ③ 消息里**含**出路表的键、却**没显式声明** key 的站点 ⇒ 红
       （旧形：泛化键如「未找到」会按子串**隐式**吃掉这类消息 ⇒ 将来新写的消息只要碰巧
       带上这个词，就会拿到**指错路**的修法；显式声明把这条路变成站点上写死的一行）。

    为什么值得单立一闸：出路律（v5.39.0）判的是「用户实际看到的那段话」，**判不出
    「这条路是不是碰巧选对的」** ⇒ 隐式匹配那类错路能一路混过 ⇒ 只能从**声明**这一层卡。
    """
    import ast as _ast_k
    out: list[str] = []
    try:
        tree = _ast_k.parse(src)
    except SyntaxError as e:
        return [f"源码解析失败：{e}"]
    used: set[str] = set()
    for n in _ast_k.walk(tree):
        if not (isinstance(n, _ast_k.Call) and isinstance(n.func, _ast_k.Name)
                and n.func.id == "die" and n.args):
            continue
        _k = next((kw.value.value for kw in n.keywords
                   if kw.arg == "key" and isinstance(kw.value, _ast_k.Constant)), None)
        if _k is not None:
            if _k not in DIE_FIXES:
                out.append(f"L{n.lineno}: 出路键 {_k!r} 不在出路表里"
                           "（写错键 ⇒ 用户拿到错路；出路表在 `DIE_FIXES`）")
            else:
                used.add(_k)
            continue
        _msg = _ast_k.unparse(n.args[0])
        _hit = next((k for k in sorted(DIE_FIXES, key=len, reverse=True) if k in _msg), "")
        if _hit:
            out.append(f"L{n.lineno}: 消息里含出路表的键 {_hit!r}，却**没显式声明** key"
                       "（隐式匹配会吃掉它 ⇒ 将来必指错路；请显式 `die(msg, key=…)`）")
    for k in DIE_FIXES:
        if k not in used:
            out.append(f"出路表行 {k!r} 没有任何站点声明（死行：没人走的那条路）")
    return out


def exit_text(msg: str, key: str = "") -> str:
    """用户**实际看到**的那段话：原消息 ＋ **显式声明的**出路（`die()` 会追加它）。
    判据闸查的是它，不是源码里的片段——判据输入必须是**用户看到的东西**。

    v5.46.0（H3 结构性根因）：出路**由站点显式声明**（`die(msg, key="…")`）⇒
    **不再按消息做子串匹配**。旧形（按处境词子串匹配）会让**泛化键**（如「未找到」）
    吃掉**将来**的新处境 ⇒ 用户拿到**指错路**的修法（而当时那条绿是"碰巧"对的）。
    ⇒ 显式声明把「这条路是哪一条」变成**站点上写死的一行**，改错当场可见、可审。"""
    return msg + ("　修：" + DIE_FIXES[key] if key and key in DIE_FIXES else "")


def die(msg: str, code: int = 1, key: str = ""):
    """报错并退出。**出路律（v5.35.0／v5.39.0／v5.46.0）**：站点显式声明 `key=` ⇒ 自动追加
    一条**当场可执行**的下一步（用户撞上不必自己想下一步 ⇒ 不让人背流程）；
    出路形态判据见 `exit_shape`（五形：命令／参数／用法／指令／无需动作）。

    `key=""`＝这个站点的出路**写在消息自己里**（自带的散文出路）⇒ 不查表。
    ⇒ **不许再按消息子串匹配**（v5.46.0 起删除：那会让泛化键吃掉新处境 ⇒ 指错路）。"""
    if key and key in DIE_FIXES:
        msg = f"{msg}　修：{DIE_FIXES[key]}"
    print(f"handoff: {msg}", file=sys.stderr)
    sys.exit(code)


def today() -> str:
    return date.today().isoformat()


def now_iso() -> str:
    """条目行的**创建时刻**（ISO 8601，带本地时区）。

    为什么 `created`（日粒度）不够（t000407）：「本班新增」判据要拿条目的创建时刻与
    **上一次 exit 班段写入时刻**比 ⇒ 用日粒度就只能按「天」比 ⇒ 同一天里前几班登记的条目
    在后面每一班都仍算「本班新增」⇒ 逐班点名负担随当天累计量涨（实测 300 条）。
    ⇒ 行里多存一个**精确时刻**；老行（无 `createdAt`）按 `created` 那天的**末尾**算
    （保守：仍算「新增」，与旧行为一致，不静默放松牙）。
    """
    return datetime.now().astimezone().isoformat()


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", str(s)).strip()


def split_set_answer(got) -> tuple[set[str], set[str]]:
    """集合题答案的两种切分，取其一命中即过。

    ① 换行／逗号／分号／**中文顿号**切：保留路径里的空格（`docs/a b.md，docs/c.md`）；
    ② 连同空白一起切：供 id 列表这类不含空格的答案。
    顿号曾漏在集合外（p000112）：答题者按中文习惯写 `a、b`，闸判 FAIL 而「应/实」两串
    看着一模一样——肉眼分不出是分隔符没切。两种解释都保留，是为了不把路径空格切坏。
    """
    a_nl = {x.strip() for x in re.split(r"[\n,，;；、]+", str(got)) if x.strip()}
    a_ws = {x for x in re.split(r"[,，、\s]+", str(got)) if x}
    return a_nl, a_ws


# 命令行里最容易被 shell 吃掉内容的字符（p000016/p000019/p000035/p000039/p000041 同族，
# 本会话已踩四次）。它们到达 CLI 时**通常已被 shell 展开或截断** ⇒ CLI 看见的往往不是用户
# 想写的东西，所以这类内容根本不该走 argv。
# 只有这两种会被 shell **替换内容**（反引号＝命令替换、`$`＝变量展开）。
# 反斜杠**刻意不拦**：它只做转义、不替换内容，且在 Windows 路径 / Markdown / 代码引用里
# 极常见，拦它会大面积误伤（本会话第一版就误加了，已去掉）。
SHELL_UNSAFE = ("`", "$")


def require_text(cmd: str, label: str, v, from_shell: bool = True) -> None:
    """写入型字符串参数守卫：① 非空（t000121/p000048/p000051）；② 不含 shell 危险字符。

    ① 空串与全空白＝删除语义，静默写入即数据丢失。`None`＝未提供（放行）；`""`／全空白＝
    提供但为空（拒）。报错文案与「条目不存在」区分开——两者是不同故障。

    ② **根治方向是「内容不走 argv」**：这里拒的是**已经错了的值**并指向 `--from-file`。
    单纯的 denylist 不够（CWE-88：denylist 不可作唯一防线，parameterization 才是 High
    效力缓解）——但 denylist 有独立价值：它把「shell 吃掉了内容」这件事**当场暴露**，
    而不是让人拿着一段被截断的文本以为写对了。**真正的保障是 `--from-file`／stdin。**
    """
    if v is None:
        return
    s = str(v)
    if not s.strip():
        die(f"{cmd}: {label} 为空——写入型字符串参数不接受空串/全空白"
            "（空串＝删除语义，疑似漏喂变量如 `$(cat 空文件)`）；"
            "补上非空值再跑（`--from-file` 里的值同样要非空）")
    # 只对**走 argv** 的值提示 shell 危险字符。`--from-file`/stdin 来的内容由程序
    # 解析、从未经过 shell，里面的反引号/`$` 就是字面量，提示它反而是噪声。
    #
    # **为什么不硬拒（2026-10-03 改）**：本机实测单引号内反引号/`$` **不展开**，而 CLI
    # 收到的值无法区分「用户用双引号、已被展开」与「用户用单引号、本就安全」——
    # 值到达时两者形态相同（前者已无反引号，后者还带反引号字面量）。于是硬拒必然
    # **误拒单引号这种安全写法**，而该抓的「已被展开」又因值里没有反引号而**抓不到**。
    # CWE-88 的分工也是这样：Parameterization 是唯一 High 效力项（即 `--from-file`），
    # validation 只是辅助、且原文说的是「不要**只**依赖查找畸形输入」，并明确承认
    # denylist 对「畸形到该直接拒绝」的输入有用——而单引号传参并不畸形。
    # 所以这里降为**提示**，真检出交给写后回读（`echo_back`）：它看的是**落盘结果**，
    # 不猜输入形态，双引号被吃掉时当场可见，单引号安全写法零干扰。
    if from_shell:
        hit = [c for c in SHELL_UNSAFE if c in s]
        if hit:
            # 提示只对**还带字面量**的值有意义：`$(...)` 被双引号展开后到达 CLI 时已无痕迹，
            # 那种情况只有写后回读能看见。所以这里不承诺「能检出」，只把安全路径说死。
            kind = ("`$(...)`／反引号＝命令替换" if ("$(" in s or "`" in s)
                    else "`$VAR`＝变量展开")
            print(f"  ⚠ {cmd}: {label} 含 shell 特殊字符 {hit}——**若你用了双引号，这段内容"
                  f"可能已被 shell 展开**（{kind}；展开后的值到达 CLI 时已无痕迹，"
                  f"下方回读才是唯一当场证据）。单引号只在内容不含单引号时安全；"
                  f"**根治＝内容不走 argv**：`--from-file <路径|->`（每行 `字段=值`，"
                  f"由程序解析、不经 shell，可从 stdin 喂）。写完请核对下方回读值。",
                  file=sys.stderr)


# ---------------- v5.0：内容硬限（t000196④）----------------
# 「写多冗余」从源头拒绝而不是事后清理：超限即拒，报错即修法。语义质量不进判据
# （文风审查必误伤，这是「判据输入必须是落盘证据」这条纪律的教训），限长＋落点这类**机械可判**的才进。
OUTCOME_CAP = 400          # close --outcome：归档行是冷数据，一行说清结论＋落点即可
SUMMARY_CAP = 120          # 条目 summary：一句话说清「什么事、为什么悬着」
TITLE_CAP = 120            # retitle：班段标题一行说清主题（与 summary 同量级）
DETAIL_CAP = 2000          # 条目 detail：只收「指针到不了才记」的信息
# `edit` 自己的字段上限表（t000261）。**表外字段落 10**9 兜底＝无闸**，所以每加一个可改
# 字段都得在这里配一条，否则「同一字段两条写路两个口径」：close 走 OUTCOME_CAP、edit 无闸
# （实测 edit 写 630 字 rc=0 落盘，而 close 写 401 字 rc=1）。
# `outcome` 只存在于**已闭槽**（`CLOSED_FIELDS`），但它的长度理由绑在**字段的角色**上——
# 归档行是冷数据——不是绑在命令上，故与 close 共用同一个常量。
EDIT_CAPS = {"summary": SUMMARY_CAP, "detail": DETAIL_CAP, "outcome": OUTCOME_CAP}
HOT_CAPS = {"exit": 8192, "summary": 8192, "status": 32768}   # 热层硬闸（字节）
EXIT_SECTION_LINES = 12    # exit 单班段行数上限（按 `## ` 切节）
# v5.55.0（t000447）：**提示类输出也有体量口径**——「只报不拦」的提示若把全部空洞 id
# 铺成一行 ⇒ 真正的红项被淹在后面（实测：一次列 900 个 id ＝ 约 4 KB 的单行）。
# ⇒ 提示只给**计数 ＋ 摘要**（每个前缀点名最低的几个，其余只给计数）⇒ 与错误行同口径。
HOLE_SAMPLE = 5              # 空洞提示每个前缀最多点名几个（其余只给计数）
KEEP_EXIT_SECTIONS = 1     # compact/append 后热层保留的班段数

# ── v5.30.0 刀 E：命令的**参数合法域**（唯一源）────────────────────────────
# 族 E 的假称就长在「文案里手写命令参数」上：报错说「先 `handoff compact status` 再写」，
# 而 `compact` **压根不支持 status**（实测 rc=1）—— 命令名对、**参数组合非法**，按命令名
# 扫根本查不出来。⇒ 参数域只此一份：**校验**与**文案**共用 ⇒ 不可能再写出非法组合。
SLOT_SET = ("status", "summary", "exit")   # `set` 的散文槽（scope 有专门子命令）
SLOT_APPEND = ("exit", "summary")           # `append` 按班段／按行
SLOT_COMPACT = ("exit", "summary")          # `compact` 只支持这两个（status 不分冷热层）
SLOT_READ = ("exit", "summary")             # `read` 只支持这两个
SLOT_VOCAB = ("exit", "summary", "status", "scope", "actions", "pitfalls",
              "commands", "unconfirmed", "closed", "decisions", "next")
# 「哪些命令收哪个槽位」的唯一表——**校验**用它，**文案**用它，**自检**也用它。
CMD_SLOT_DOMAIN = {"set": SLOT_SET, "append": SLOT_APPEND,
                   "compact": SLOT_COMPACT, "read": SLOT_READ}

# ── v5.29.0：队列现态区**不再落盘**，改读时现算 ──────────────────────────────
# v5.7.0 d000105 第 2 层把区改成「渲染物」（不再手抄状态），但**仍存进 exit 热层** ⇒
# 于是**派生物落进了人写的散文层** ⇒ 它同时背三口锅：
#   ① O(池规模) 的行数塞进热层 ⇒ 库一大就撞 8192 字节闸 ⇒ `append exit` 被拒 ⇒
#      **班段永久写不进**（实测 500 条 ⇒ 区 9610 字节 ⇒ append rc=1；且无自救出口：
#      `set --force` 会被重新渲染的区顶回去、`compact exit` 无可归档 ⇒ 唯一出路是把
#      未销账条目关到 ~430 条以下）；
#   ② 区会陈旧 ⇒ 于是专门养了一个判据维 `queue-stale` 兜它；
#   ③ 区会陈旧是因为「每次改池都得记得复渲染」⇒ 那个写点清单**历史上漏接过三次**
#      （v5.7.0 的 rm／edit／compact、t000405 的 supersede）。
# ⇒ v5.29.0：区**只读时现算**（读者看 `handoff view`）⇒ 三口锅一起消失：热层里不再有
#   O(库规模) 的东西；**没有会陈旧的存储态区，就没有 `queue-stale` 维**；也没有「改池
#   要记得复渲染」的写点负担。
# ⚠ **标记串逐字不动**（v5.29.0 之前落盘的区还要靠它剥）——只改说明，不改标记。
# ⚠ 旧库残留：写命令自动剥（`strip_queue_block`），也可 `handoff sync-queue` 手动剥
#   ⇒ 判据 `queue-legacy` 点名残留并给修法。
QUEUE_BEGIN = "<!-- queue:begin （由 refill_pool 渲染，勿手改） -->"
QUEUE_END = "<!-- queue:end -->"

# 点名容量账本（v5.29.0 刀 4）：报错必须给**真实**可容纳量，否则闸把存储锁死而报错
# 自身还指错方向（实测旧文案：150 条时说「约 13 行 … exit 班段 12 行都放得下」——
# 13 > 12，那条建议字面上做不到；同时它又过于悲观：按 40 个/行只要 4 行）。
NAME_IDS_PER_LINE = 40      # 一行放多少个 id（每 id ≈10 字节 ⇒ ≈400 字节/行，热层槽 8192 内安全）
NAME_EXIT_LINES = EXIT_SECTION_LINES - 2   # exit 班段**正文**行数（12 行含标题行与标题后空行）
# ── t000315／d000121：status 顶部 counts 渲染区（C 案；queue-stale 同型） ─────
# 块外散文仍只放指针（d000109 其余条款不废止）；块内是机器渲染物，改它＝手改派生物。
# 写点挂在 `Store.write_index()` 这一个漏斗上：所有写路径最后都过它 ⇒ 不会漏接某个命令
# （d000106 的教训：只补调用等于把写点清单抄长，下一条新命令照样漏）。
COUNTS_BEGIN = "<!-- counts:begin （由库渲染，勿手改） -->"
COUNTS_END = "<!-- counts:end -->"
KEEP_SUMMARY_LINES = 30    # summary 热层保留行数
NAME_SUMMARY_LINES = KEEP_SUMMARY_LINES   # summary 可用于点名的行数（v5.29.0 刀 4 的容量账本）
ARCHIVE_DIR = "archive"    # 冷档目录（archive/exit.jsonl / archive/summary.jsonl）


def guard_len(cmd: str, label: str, v, cap: int, extra: str = "") -> None:
    """写入型字符串的**长度硬限**：超限即拒（不是警告），报错给出修法。"""
    if v is None:
        return
    s = str(v)
    if len(s) > cap:
        die(f"{cmd}: {label} {len(s)} 字符超上限 {cap}——"
            f"{extra or '写少点：git／库里能查到的内容不复述，只留结论＋落点（id 或 file:line）'}", key="字符超上限")


# ---------------- v5.0：sealed store（t000196①）----------------
# 通用拦截层：`.handoff/` 全树常态只读，写权限只归本 CLI（每次命令「先解锁、末回封」）。
# 任何 agent 用任何工具直改都会被内核 EACCES 拒绝——拦截发生在操作系统，不依赖各
# agent 的 hook 机制，因此对**一切能装技能的工具**通用。边界（如实写明）：防的是
# 「顺手手改」这一实测失败模式；防不住蓄意 chmod 的对抗者（那不是威胁模型，对抗级
# 加固需存储归专用用户＋CLI 经 sg 写，暂不上）。
SEAL_OK = os.name == "posix"
_STAY_UNSEALED: set[str] = set()   # 「本次不回封」按**存储路径**记，不是进程开关
# ⚠ 为什么必须是集合（2026-10-18 实测出的假红）：`unseal` 会经 `main()` 在**同进程内**被
# 递归调用（`handoff selftest` 的夹具就是在一个进程里跑多条 `main([...])`）。旧形是进程级
# 布尔 ⇒ 夹具对**临时库**跑一次 `unseal`，外层那条命令的 finally 就以为「本次留门」，
# 于是**真库被留在可写态**，下一班接手跑 `handoff check` 必报 `sealed` 红一次、再跑才自愈。
# 门禁的偶发假红比缺闸更坏——它训练人把红当噪声（p000022 同族）。维护态是**某个库**的属性，
# 不是进程的属性，所以键必须是路径。


def _iter_tree(d: Path):
    yield d
    for p in sorted(d.rglob("*")):
        yield p


def store_sealed(d: Path) -> bool:
    """True＝全树无可写位（或环境不支持封存——视为恒封，不判红）。"""
    if not SEAL_OK or not d.is_dir():
        return True
    return not any(p.stat().st_mode & 0o222 for p in _iter_tree(d))


# ---- v5.69.0（t000475·②）：「进门前这个库在不在」的**判据对象**从代理改成实物 ----
# 旧形用「`index` 在不在」当代理 ⇒ 一个**被删掉 `index` 的老库**会被当成本命令现建的
# ⇒ 封存维在那一刻**没有判别对象**（漏判一次；v5.68.0 的诚实残余③）。
# 新形按**实物**判：库里任一**本 CLI 的产物**在不在 ⇒ 老库即便没了 index 也仍是老库。
# 只认**本 CLI 自己的结构名**（不认 `archive/`／`closed/` 这类通用词）⇒ `import` 到一个
# 普通项目目录时不会被误判成「老库可写」（那是 v5.68.0 F-I2 修掉的假红，回归即自伤）。
STORE_ARTIFACTS = ("index", "unconfirmed.jsonl", "actions", "pitfalls", "commands")


def store_preexisting(d: Path) -> bool:
    """进门前这个库里**已经有本 CLI 的东西**吗（＝「老库」⇒ 封存维有判别对象）。

    **做成函数**（不是内联表达式）：变异自证要在夹具里把它换回旧代理（只看 `index`）
    ⇒ 换得掉才有「去掉修复 ⇒ 负控转绿」的实证（d000111 同款做法）。"""
    if not d.is_dir():
        return False
    return any((d / name).exists() for name in STORE_ARTIFACTS)


def seal_store(d: Path) -> None:
    if not SEAL_OK or not d.is_dir():
        return
    for p in _iter_tree(d):
        try:
            p.chmod(p.stat().st_mode & ~0o222)
        except OSError:
            pass


def unseal_store(d: Path) -> None:
    """恢复**属主**写位（目录另加执行位）。原 group/other 写位不恢复——封存是有意的收紧。"""
    if not SEAL_OK or not d.is_dir():
        return
    for p in _iter_tree(d):
        try:
            m = p.stat().st_mode | 0o200
            if p.is_dir():
                m |= 0o100
            p.chmod(m)
        except OSError:
            pass


# ---------------- v5.1：单写者锁（cloud-services 实战报回）----------------
# 并发跑两条命令实测出两种损坏：① A 还在写、B 的 `finally: seal_store()` 把全树 chmod
# 回只读 ⇒ A 报 `PermissionError: .handoff/actions/<域>.jsonl`；② 同一条目的 `edit` 与
# `close` 并行 ⇒ read-modify-write 交错 ⇒ 同一个 id 同时落 live 与 closed，`check` 报
# id 重复。原有的「close 两阶段拆分」只防自己半程失败，**防不住外部进程**。
LOCK_WAIT_S = 15.0          # 单写者锁的有界等待上限（真卡住的进程由它兜，不无限等）
try:
    import fcntl                                          # posix
except ImportError:
    fcntl = None
try:
    import msvcrt                                         # Windows
except ImportError:
    msvcrt = None


def _lock_path(d: Path) -> Path:
    """锁文件＝解析后的存储路径哈希，落**临时目录**、按存储分键。

    为什么不放进 `.handoff/`：那棵树常态是**封存态**（目录无写位 ⇒ 建不出锁文件），
    而 `init` 之前它整个不存在——「先取锁、再决定动不动存储」这两条都会落空。
    不同仓的哈希不同 ⇒ 互不阻塞。进程退出即释放，文件留着只是个空壳（无内容、无残留状态）。
    """
    key = hashlib.sha256(str(d.resolve()).encode("utf-8")).hexdigest()[:16]
    return Path(tempfile.gettempdir()) / f"handoff-{key}.lock"


def acquire_store_lock(st: "Store"):
    """取存储级排他锁：**有界等待**（默认 15s），等不到才报错退出。

    为什么不是纯 fail-fast（原报单推荐的那个）：agent 把 `add` 与 `close` 塞进同一个工具
    调用并行发出是**常态用法**，不是误用。fail-fast 会让其中一条静默不执行——写命令的意图
    丢了，而「丢了」只体现在一条需要人回头重跑的报错上。有界等待两条都生效（串行），
    同时挂住的进程仍能被抓出来：flock 由内核在进程退出时释放，**不会有残留锁**，所以
    超时只可能意味着「真有个长任务在跑」，那时报错比无限等好。
    """
    if fcntl is None and msvcrt is None:      # 没有锁原语就明说，不假装受保护
        print("handoff: 本环境既无 fcntl 也无 msvcrt——并发写**不受**锁保护", file=sys.stderr)
        return None
    lp = _lock_path(st.d)
    try:
        fd = os.open(str(lp), os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as e:
        die(f"开不了锁文件 {lp}（{e.strerror}）——共享机器上这通常是别人的同名锁文件（0600 只认属主）。"
            f"修法：确认该路径归属后由属主删掉它，或给本存储换一条解析后的路径；"
            f"**不要**改判据、也不要绕过 CLI 直接写 {st.d}。", key="开不了锁文件")
    wait = float(os.environ.get("HANDOFF_LOCK_WAIT_S") or LOCK_WAIT_S)
    deadline, waited = time.monotonic() + wait, False
    while True:
        try:
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                # 非阻塞同语义。⚠ Windows 分支本机无法实测（与 `seal` 同一环境边界），
                # 语义照 msvcrt 文档取 LK_NBLCK；验证只覆盖 posix 那条。
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError:
            if not waited:
                waited = True   # 真发生过争用就留痕（P3 不静默：串行化不是无痕的）
            if time.monotonic() >= deadline:
                os.close(fd)
                die(f"另一 handoff 进程占着本存储已超 {wait:.0f}s（{st.d}）——"
                    f"本命令已放弃、未写任何东西。先查有没有卡住的 handoff 进程："
                    "`pgrep -af handoff`；确认没有就重跑本命令。"
                    "（等这么久的锁不会自己松开，别在它上面叠第二条写命令。）")
            time.sleep(0.05)
        else:
            if waited:
                print("handoff: （另一进程正占用，已等它结束后继续）", file=sys.stderr)
            return fd


def release_store_lock(fd) -> None:
    if fd is None:
        return
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_UN)
        else:
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    os.close(fd)


def from_file_value_field_prefix_lines(value: str, allowed: set) -> list[tuple[int, str]]:
    """落盘值里「以 `allowed` 内的字段名开头」的行（行号, 字段名）。

    为什么要有它（v5.70.0 · t000482）：`--from-file` 的**续行是值的原样正文**——
    载荷生成器若在**每一行**都写上 `字段=`，那些前缀会被**原样拼进值里**，
    解析器**不报错**（本班就这样污染过两份权威件：t000474 的 detail 与 d000167 的正文）。
    这里**只定位**这种行（不改值、不拦），由写面出**告警**。
    **只认 `allowed` 内的字段名**：正文里出现 `foo=bar` 这类合法内容不会被指。
    """
    hits: list[tuple[int, str]] = []
    for off, ln in enumerate(value.split("\n"), 1):
        m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=", ln)
        if m and m.group(1) in allowed:
            hits.append((off, m.group(1)))
    return hits


def load_from_file(cmd: str, path: str, allowed: set) -> dict:
    """`--from-file <路径|->`：内容**由程序解析**，完全不经过 shell（p000016/019 根治）。

    格式：**字段名只写在首行**——首行 `字段=值`，其后是这个值的**续行**（行尾 `\\`）。
    值可跨行续写（行尾 `\\`）——因为要贴代码片段/多行说明时，单行 `k=v` 装不下。
    **续行是值的原样正文**：续行里再写 `字段=…` 会被**原样拼进值里**（解析器不报错）
    ⇒ 生成载荷时续行**不要带字段名**；写面会就此**告警**（不拦——正文举例
    「detail=…」是合法内容，硬拒会误伤 ⇒ 机器消费另须**零误报**），
    见 `from_file_value_field_prefix_lines` 与坑 p000171。
    空行与 `#` 开头（行首无 `=`）忽略。字段不在 `allowed` 内即报错
    （防把 `--summary` 写进文件却静默丢弃，那正是本 CLI 早前的老病）。

    **行尾 `\\` 是本格式自己的标记物，解析时必须剔除**——它是分隔符不是内容。留着它
    等于把每个续行的末字符原样写进用户的条目（旧实现就是这样：判了续行却没削，
    落盘值里每行都挂着一个 `\\`，用户读到的是自己没写过的字符）。同理，文件末尾还
    开着续行＝标记说「后面还有」，却已经没有后面了 ⇒ 告警而不是静默（值已按标记削好）。
    由此带来的已知限制：**值本身要以单个反斜杠结尾时无法表达**（该字符恒被当标记）。
    要写 Windows 路径请让路径后面还有别的字元（如 `C:\\Users\\x\\` 之外的任何续行内容），
    或改走 `--detail`（走 argv，不经本解析器）。
    """
    raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    out: dict[str, str] = {}
    key = None
    key_ln = 0
    for ln_no, ln in enumerate(raw.splitlines(), 1):
        cont = ln.endswith("\\")          # 标记物：判续行**且**要削掉
        if key is None:
            s = ln.strip()
            if not s or s.startswith("#"):
                continue
            if "=" not in s:
                die(f"{cmd} --from-file: 行 {s[:40]!r} 不是 `字段=值` 格式")
            k, v = s.split("=", 1)
            k = k.strip().lstrip("-")
            if k not in allowed:
                die(f"{cmd} --from-file: 字段 {k!r} 不被本命令接受"
                    f"（可接受：{'、'.join(sorted(allowed))}）")
            if k in out:
                die(f"{cmd} --from-file: 字段 {k!r} 重复出现（第 {ln_no} 行）——"
                    f"后者覆盖前者是**静默丢弃**，请合并成一处")
            key = k
            key_ln = ln_no
            out[key] = v[:-1] if cont else v
            if not cont:
                key = None
        else:
            out[key] += "\n" + (ln[:-1] if cont else ln)
            if not cont:
                key = None
    if key is not None:
        print(f"handoff: ⚠ {cmd} --from-file: 字段 {key!r}（第 {key_ln} 行）以续行标记结尾，"
              f"但文件已到末尾——标记已剔除，值按到此处为止取。", file=sys.stderr)
    if not out:
        die(f"{cmd} --from-file: 没解析出任何 `字段=值`")
    # v5.70.0（t000482）：续行里若又写了「字段=」，那行会被**原样拼进值里**（解析器不报错）
    # ⇒ 写面**告警**（**不拦**：正文举例「detail=…」是合法内容，硬拒会误伤 ⇒ 机器消费
    # 另须**零误报**）。告警只说「这一行被原样拼进来了」，不替用户改值。
    for _k, _v in out.items():
        for _off, _fk in from_file_value_field_prefix_lines(_v, allowed):
            print(f"handoff: ⚠ {cmd} --from-file: 字段 {_k!r} 的值第 {_off} 行以 {_fk}= 开头 ⇒ "
                  f"续行是**原样正文**、字段名只写首行；若这是正文举例可忽略，"
                  f"否则载荷写错了（该行会被原样拼进值里）", file=sys.stderr)
    return out


def echo_back(st: Store, entry_id: str, label: str = "回读", strict: bool = False) -> None:
    """写完**回读**落盘值并显示（P3 不静默；p000019/p000041 根治的关键一环）。

    `strict=True`：回读不到 ⇒ **非 0 退出**，不再只打一行 stderr。写命令的回读是它的
    自证——「写完读不到」意味着这次写入没生效或被覆盖，此时打印成功信息就是撒谎
    （p000135：`edit --domain` 自迁移抹掉条目后仍打印成功、rc=0）。默认关，因为
    `add decision` 之类**已解释的未命中**（decisions 不在 live/closed，见下）不能当真异常。

    为什么必须有它：命令行里的反引号/`$` 被 shell 展开后，**CLI 收到的是展开后的值**，
    它无从知道原意 —— 硬拒抓不到、单引号安全写法又会被误拒。唯一可靠的判据是
    **看结果**：把刚写进磁盘的那行读回来摆在你面前，双引号被吃掉时当场可见
    （不用等几小时后回读才发现），而单引号安全写法**不会**产生任何额外噪声。
    它检测的是落盘事实，不猜输入形态。

    显示长文本字段的前若干字 —— 被吃掉最常发生在 `detail`／`src` 这类长文本上。
    """
    row = None
    for r in st.load_live():
        if r.get("id") == entry_id:
            row = r
            break
    if row is None:
        for r in st.load_closed():
            if r.get("id") == entry_id:
                row = r
                break
    if row is None:
        # decisions 槽是 `decisions/<id>.md`（frontmatter ＋ 正文），**不在**
        # live/closed 里。原实现查不到就报「异常」——而 `add decision` 明明成功，
        # **把成功报成失败**，与 P3「不静默」的本意正好相反（独立审计实测抓到）。
        for f in sorted(st.decisions_dir().glob("*.md")) if st.decisions_dir().is_dir() else []:
            if f.stem == entry_id:
                fm = _frontmatter(f)
                print(f"  ↩ {label} {entry_id}（已落盘，实际值）：")
                # 键表＝实测会出现在 decisions frontmatter 里的字段；**`title` 是死键**
                # （writer 只把 title 写成正文 H1，frontmatter 永不含它）——独立审计抓到。
                for k in ("topic", "status", "domain", "supersedes"):
                    if fm.get(k):
                        print(f"      {k}: {str(fm[k])[:160]}")
                _fm_text, _bd, _ok = _fm_split(f.read_text(encoding="utf-8"))
                tail = (_bd if _ok else "").strip().splitlines()
                if tail:
                    print(f"      body: {' '.join(tail)[:160]}"
                          f"{'…（已截断，全文见文件）' if len(' '.join(tail)) > 160 else ''}")
                return
        if strict:
            die(f"{label}：条目 {entry_id} 写完回读不到 ⇒ 本次写入未生效或被覆盖（异常）")
        print(f"  ↩ {label}：条目 {entry_id} 未在 live/closed/decisions 中找到（异常）",
              file=sys.stderr)
        return
    print(f"  ↩ {label} {entry_id}（已落盘，实际值）：")
    # 键表＝**实测**会出现在 live/closed 行里的字段（不是"看着相关就加上"）：
    # 实测 action 行 = id/created/summary/status/detail/src/topic，closed 行多 outcome。
    # `title`/`body`/`ref` **都不在通用路径**（body 只在 decisions 槽、已由下面的
    # decisions 专用分支回读；ref 只在 unconfirmed、而它不在 live/closed 里）——
    # 上一版把三者塞进键表，变异测试证明那是**死项**（去掉也不影响任何断言）。
    # v5.19.0：补 `blockedBy`／`waitingFor`／`status`（非默认时）——阻塞语义靠这三个字段
    # 承载（`blocked-owner` 维判「在等什么」），不回读它们＝用户看不到「落对了没有」。
    for k in ("summary", "topic", "detail", "src", "outcome"):
        v = row.get(k)
        if not v:
            continue
        s = str(v).replace("\n", " ⏎ ")
        print(f"      {k}: {s[:160]}{'…（已截断显示，全文见文件）' if len(s) > 160 else ''}")
    for k in ("status", "blockedBy", "waitingFor"):
        v = row.get(k)
        if not v or (k == "status" and v == "open"):
            continue
        print(f"      {k}: {str(v)[:160]}")


def ordered(entry: dict) -> dict:
    return {k: entry[k] for k in KEY_ORDER if k in entry}


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    if not path.is_file():
        return rows
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as e:
            _hint = ""
            if path.name == WRITES_LOG:
                _hint = ("\n  修：写事件台账坏了 ⇒ `handoff rebase --force` 可**按当前落盘事实重建基线**"
                         "（代价：丢掉历史事件里的旁证，疑似补手续的线索一并消失）")
            elif path.parent.name in ("actions", "pitfalls", "commands", "closed"):
                _hint = (f"\n  修：分区文件坏了 ⇒ 从备份/git 恢复该文件；"
                         f"实在没有就 `handoff rm <该分区里的坏 id>` 把它移出去再重建分区")
            die(f"{path}:{i} 非法 JSON: {e}{_hint}", key="非法 JSON")
    return rows


def write_jsonl_atomic(path: Path, rows: list[dict]):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(ordered(r), ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def append_jsonl(path: Path, row: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(ordered(row), ensure_ascii=False) + "\n")


class Store:
    def __init__(self, root: Path):
        self.d = root
        self.root_dir = root.resolve().parent
        self._pre_tamper: list | None = None    # 写前旁证快照，见 note_pre_tamper

    # ---- 路径 ----
    def live_shards(self) -> list[Path]:
        out = []
        for slot in ENTRY_SLOTS:
            sd = self.d / slot
            if sd.is_dir():
                out += sorted(sd.glob("*.jsonl"))
        return out

    def closed_shards(self) -> list[Path]:
        cd = self.d / "closed"
        return sorted(cd.glob("*.jsonl")) if cd.is_dir() else []

    def unconf_file(self) -> Path:
        return self.d / "unconfirmed.jsonl"

    def decisions_dir(self) -> Path:
        return self.d / "decisions"

    # ---- 载入 ----
    def load_live(self) -> list[dict]:
        rows = []
        for slot in ENTRY_SLOTS:
            sd = self.d / slot
            if sd.is_dir():
                for f in sorted(sd.glob("*.jsonl")):
                    for r in read_jsonl(f):
                        r["_slot"] = slot
                        r["_file"] = f
                        rows.append(r)
        for r in read_jsonl(self.unconf_file()):
            r["_slot"] = "unconfirmed"
            r["_file"] = self.unconf_file()
            rows.append(r)
        return rows

    def load_closed(self) -> list[dict]:
        rows = []
        for f in self.closed_shards():
            for r in read_jsonl(f):
                r["_slot"] = "closed"
                r["_file"] = f
                rows.append(r)
        return rows

    def all_ids(self) -> list[str]:
        ids = [r["id"] for r in self.load_live() if "id" in r]
        ids += [r["id"] for r in self.load_closed() if "id" in r]
        for f in sorted(self.decisions_dir().glob("*.md")) if self.decisions_dir().is_dir() else []:
            ids.append(f.stem)
        return ids

    def allocate(self, typ: str) -> str:
        mx = 0
        for i in self.all_ids() + _void_ids(self):   # 已作废 id 不复用
            m = ID_RE.match(i)
            if m and m.group(1) == typ:
                mx = max(mx, int(m.group(2)))
        return f"{typ}{mx + 1:06d}"

    def next_id(self) -> str:
        p = self.d / "next"
        if not p.is_file():
            return ""
        line = p.read_text(encoding="utf-8").strip()
        return line

    def set_next(self, value: str):
        self.d.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(self.d))
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(value + "\n" if value else "")
        os.replace(tmp, self.d / "next")

    # ---- index ----
    def build_index(self) -> dict:
        slots: dict = {}
        domains: dict = {}
        topics: dict = {}
        for slot in ENTRY_SLOTS:
            files = []
            total = 0
            sd = self.d / slot
            if sd.is_dir():
                for f in sorted(sd.glob("*.jsonl")):
                    n = len(read_jsonl(f))
                    total += n
                    part = f.stem
                    files.append({"file": f"{slot}/{f.name}", "partition": part, "count": n})
                    if slot in ("actions", "pitfalls"):
                        domains.setdefault(part, []).append(f"{slot}/{f.name}")
            slots[slot] = {"count": total, "files": files}
        uc = read_jsonl(self.unconf_file())
        slots["unconfirmed"] = {"count": len(uc), "files": ["unconfirmed.jsonl"] if self.unconf_file().is_file() else []}
        dc = sorted(self.decisions_dir().glob("*.md")) if self.decisions_dir().is_dir() else []
        slots["decisions"] = {"count": len(dc), "files": [f"decisions/{p.name}" for p in dc]}
        for r in self.load_live():
            t = r.get("topic")
            if t:
                topics.setdefault(t, []).append(str(r.get("_file")))
        return {
            "schema": 1,
            "generated": today(),
            "slots": slots,
            "domains": domains,
            "topics": {k: sorted(set(v)) for k, v in topics.items()},
            "closed_count": len(self.load_closed()),
            "next": self.next_id(),
        }

    def note_pre_tamper(self, extra: list | None = None) -> None:
        """写命令**开始时**取一次旁证快照（同一命令内只算一次）。

        为什么不能放在 `write_index` 里算：`set`/`add`/`edit` 的写序是「先写内容、
        后 write_index」，那时文件 mtime 已经被**本次自己的写**更新了——于是每次
        经这些命令写 `status`/`exit` 都会被自己的 pre_tamper 判据误报（真源实测：
        连我自己用 `set exit` 回填一次都被报成「未经 CLI 之外改动过」）。

        `extra`＝**本次命令自己要动、但不属于常规受管面**的文件（v5.12.0：`decide`
        要改的那一份 `decisions/<id>.md`）。⚠ **v5.57.0（t000461）**：裁定件载体**已进**
        `_write_targets()`（增量记录 ⇒ 台账不会按事件次数膨胀）⇒ `extra` 现在是
        **对本次要动的那一份的显式声明**（定点、不依赖增量判定）。
        """
        if self._pre_tamper is None:
            self._pre_tamper = _tamper_since_last_write(self, self._write_targets())
        if extra:
            self._pre_tamper = sorted(set(self._pre_tamper)
                                      | set(_tamper_since_last_write(self, extra)))

    def _dirty_targets(self) -> list:
        """本次**实际被写过**的受管文件（与末次写事件比，内容或 mtime 变了的那些）。

        v5.18.0（v2.0 E′）。为什么不是「全部受管文件」：全量记录让台账变成**快照流**
        ——本仓实测 1,939 条事件／10.9 MB，其中 79% 是 89 个文件里**根本没变**的那些；
        更糟的是语义是错的：`latest[f]` 会被**无关的写**刷新，于是「该文件最后一次
        CLI 写入时的状态」这个真正需要的量被冲掉（补手续检测的 mtime 旁证被稀释）。

        判据＝**落盘证据**：内容哈希或 mtime 与末次记录不同 ⇒ 这次真的动过它。
        `index` 每次都重建 ⇒ 恒在；`extra`（定点入账，如 `decisions/<id>.md`）照旧追加。
        """
        last = _last_recorded(self)
        out = []
        for f in self._write_targets():
            if not f.is_file():
                continue
            rel = str(f.relative_to(self.d))
            rec = last.get(rel)
            try:
                sha = _sha(f.read_text(encoding="utf-8"))
                mt = f.stat().st_mtime_ns
            except OSError:
                continue
            if rec is None or rec.get("sha") != sha or rec.get("mt") != mt:
                out.append(f)
        return out

    def _removed_since_last_write(self) -> list:
        """本 Store 生命周期内、写事件记过但**现已不存在**的文件。

        4.8.1 之前这里是死红：`edit --domain` 换分区会「搬空即删」旧分区文件（4.7.5 的
        刻意修复），而 `audit_writes` 把「latest 里有、落盘没有」一律判成「疑似被 CLI
        之外的途径删掉」⇒ 每次换分区后 `check` 永久红，且 `rebase` 也解不开（它同样保留
        `latest`）。根治：**写事件要记「谁删的」**，对账时才分得清「经 CLI 正常删掉」与
        「凭空消失」。
        """
        wl = self.d / WRITES_LOG
        if not wl.is_file():
            return []
        seen: set[str] = set()
        for e in read_jsonl(wl):
            seen |= set(e.get("files") or {})
            seen |= set(e.get("removed") or [])
        return sorted(f for f in seen if not (self.d / f).exists())

    def write_index(self, op: str | None = None, extra: list | None = None,
                    ids: list | None = None):
        # **不要在这里取快照**：调用点都在「内容已写完之后」，那时 mtime 已被本次
        # 自己的写更新 ⇒ 每次经 set/add/edit 写 status/exit 都被自己的判据误报
        # （第一版修法把「每次算」改成「每实例算一次」，时机仍是写后，等于没修；
        #   真源 check 报红才暴露）。写命令须在**第一行**调 note_pre_tamper()。
        # `extra` 见 note_pre_tamper 的 docstring（v5.12.0：`decisions/<id>.md` 定点入账）。
        pre_tamper = self._pre_tamper or []
        idx = self.build_index()
        strip_counts_legacy(self)   # v5.30.0：counts 区不再落盘 ⇒ 这里只清**旧库残留**（幂等）
        p = self.d / "index"
        fd, tmp = tempfile.mkstemp(dir=str(self.d))
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(idx, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, p)
        # 写事件记在**索引重建之后**——所有写路径最后都过这里，集中记才不会漏。
        _targets = self._dirty_targets()
        if (self.d / "index").is_file():
            _targets = _targets + [self.d / "index"]
        log_write(self, op or "write_index", _targets + list(extra or []),
                  pre_tamper, removed=self._removed_since_last_write(), ids=ids)

    def _write_targets(self) -> list:
        """本次落盘的全部受管文件（分区 jsonl/md ＋ 四个单文件槽 ＋ **裁定件载体**）。

        **v5.57.0（t000461）：裁定件载体进受管面**——此前 d 型不在这里 ⇒ 导入来的裁定件
        载体**不进台账 `files`** ⇒ 手改其正文不被写事件对账抓住（内容哈希对不上这一道
        只对账台账里有的文件）。⇒ 现在 d 型也进受管面。

        **为什么台账不会被撑大**（旧注释里的担心：「那 100+ 件每次全量入账会把台账撑成
        三倍」）：台账**每条事件只记变过的文件**（`_dirty_targets` 拿每个文件的**末次记录**
        比对内容哈希/mtime）⇒ 裁定件只有**自己变了**才被记一次 ⇒ 每条事件的增量与此前
        同量；总量只多「每个裁定件一条记录」（本仓约百来件 ⇒ 十几 KB，一次性）。
        """
        out = []
        for slot in ENTRY_SLOTS:
            d = self.d / slot
            if d.is_dir():
                out += sorted(d.glob("*.jsonl"))
                out += sorted(d.glob("*.md"))
        dd = self.decisions_dir()            # 裁定件载体也要进对账面（v5.57.0 · t000461）
        if dd.is_dir():
            out += sorted(dd.glob("*.md"))
        for s in SINGLES:
            f = self.d / s
            if f.is_file():
                out.append(f)
        uf = self.unconf_file()            # unconfirmed.jsonl 也要进对账面
        if uf.is_file():
            out.append(uf)
        sh = self.d / SHIFTS_FILE          # 班次台账（v5.30.0 刀 F）也要进对账面
        if sh.is_file():
            out.append(sh)
        cl = self.d / "closed"
        if cl.is_dir():
            out += sorted(cl.glob("*.jsonl"))
        arc = self.d / ARCHIVE_DIR
        if arc.is_dir():                                   # v5.0 冷档也进对账面
            out += sorted(arc.glob("*.jsonl"))
        return out


# ---------------- init ----------------
def cmd_init(st: Store, a) -> int:
    if (st.d / "index").is_file() and not a.force:
        die(f"init: {st.d} 已存在（--force 重建骨架）")
    st.d.mkdir(parents=True, exist_ok=True)
    for s in SINGLES:
        if not (st.d / s).is_file():
            (st.d / s).write_text(SCOPE_HEADER if s == "scope" else "", encoding="utf-8")
    for slot in ENTRY_SLOTS:
        (st.d / slot).mkdir(parents=True, exist_ok=True)
    st.decisions_dir().mkdir(parents=True, exist_ok=True)
    (st.d / "closed").mkdir(parents=True, exist_ok=True)
    if not st.unconf_file().is_file():
        st.unconf_file().write_text("", encoding="utf-8")
    if not (st.d / "next").is_file():
        st.set_next("")
    if not (st.d / "log.jsonl").is_file():
        (st.d / "log.jsonl").write_text("", encoding="utf-8")
    st.write_index()
    print(f"handoff init: 已建骨架 {st.d}/（{_slot_count()} 槽 + index）")
    # 顺手把标准交接块装进**本项目**的 AGENTS.md——写入是使用方自己的动作，不是
    # 库维护者跨仓代劳。init 是用户显式启用交接的那一刻，也就是最自然的安装时机。
    # 不阻断 init：AGENTS.md 不存在就跳过（此时无法装块）；存在则一律装上——
    # 已有 `## 交接` 节的走整理覆盖，不需要人先手工并入标记区。
    repo = st.d.parent
    agents = repo / "AGENTS.md"
    if agents.is_file():
        class _A:  # 复用 --install 的落盘逻辑，不走 argparse
            install = str(repo)
            profile = "basic"
            print_only = False
            check = None
        rc = cmd_agents_block(st, _A())
        if rc != 0:
            print("  提示：交接块未自动写入（见上），修好后再跑一次 "
                  "`handoff.py agents-block --install .` 即可。")
    else:
        print(f"  提示：{agents} 不存在，跳过交接块安装；建好 AGENTS.md 后跑 "
              "`handoff.py agents-block --install .`")
    # v5.18.0（v2.0 K′）：**不再顺手装 PATH shim**——init 是「在本项目建存储」这个
    # **项目级**动作，却往 `~/.local/bin`（**机器级**状态）写文件＝越界。
    # 要装显式跑 `handoff install-shim`（幂等）；`--with-shim` 可要求本轮就装。
    if getattr(a, "with_shim", False) and os.environ.get("HANDOFF_SELFTEST_SUB") != "1":
        try:
            cmd_install_shim(st, a)
        except Exception as e:
            print(f"  提示：shim 安装失败（{e}）——不影响交接功能，可手跑 `handoff install-shim`")
    else:
        print("  提示：PATH shim **未安装**（init 不再自动改全局目录）——"
              "要让 `handoff` 命令随处可用，跑 `handoff install-shim`（幂等）")
    return 0


# ---------------- log（使用数据，供日后优化/裁剪槽位） ----------------
def _log_path(st: Store) -> Path:
    return st.d / "log.jsonl"


def _sha(text: str) -> str:
    """内容哈希（不是 mtime——mtime 可 `touch -d` 伪造，一戳就破）。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


WRITES_LOG = "writes.jsonl"
REBASED_ARCHIVE_PREFIX = "writes-rebased-"   # v5.71.0（t000483）：旁证事件的侧档前缀（可 `--undo` 搬回）
SHIFTS_FILE = "shifts.jsonl"   # 班次台账（v5.30.0 刀 F）：散文写入的**序号**——界碑的唯一源
# 出处台账的版本标记（v5.53.0 · t000448）：写事件里带 `prov` ⇒ 判「本机制落地后的第一条
# 事件」只看台账尾部就够（老库第一次写就落基线，不必全量扫台账）。
PROV_VERSION = 1


def _last_recorded(st: Store) -> dict[str, dict]:
    """写事件台账里**每个文件的末次记录**（sha ＋ mt）。

    **唯一源**：`audit_writes` 的对账、`_tamper_since_last_write` 的旁证、v5.18.0 的
    增量记录（`_dirty_targets`）都读它——三处各建一份「last 表」迟早分叉。
    """
    wl = st.d / WRITES_LOG
    if not wl.is_file():
        return {}
    last: dict[str, dict] = {}
    for e in read_jsonl(wl):
        for f, rec in (e.get("files") or {}).items():
            last[f] = rec if isinstance(rec, dict) else {"sha": rec, "mt": None}
    return last


def _tamper_since_last_write(st: Store, targets) -> list:
    """写**之前**的旁证检查：这些文件的 mtime 与上次写事件记录的不一致
    ⇒ 上次 CLI 写之后有人动过它们（哪怕内容最终写回一样 —— 那正是补手续）。"""
    last = _last_recorded(st)
    if not last:
        return []
    out = []
    for t in targets:
        t = Path(t)
        if not t.is_file():
            continue
        rel = str(t.relative_to(st.d))
        rec = last.get(rel)
        if rec and rec.get("mt") is not None and t.stat().st_mtime_ns > rec["mt"]:
            out.append(rel)
    return out


def log_write(st: Store, op: str, targets, pre_tamper=None, removed=None,
             ids=None) -> None:
    """每次 CLI **写**都记一条 append-only 事件（p000025 的判据面，4.7.8）。

    记 `op` ＋ 每个受影响文件的**写后内容哈希**。它让两件原本「钉不进判据」的事变成
    可判定：
      · 有人绕过 CLI 手改文件 ⇒ `check` 重算当前文件哈希，与最后一条写事件对不上
        ⇒ **存在未经 CLI 记录的写入**（含「改了又改回」以外的一切痕迹）。
      · 「补手续」（先手改、再用 CLI 覆写同样字节）⇒ 同一 target 出现**内容哈希相同、
        紧邻相邻**的两条写事件 ⇒ 疑似补手续（真去做了同一件事两次）。
    判据输入全是落盘证据。时间戳用 **`st_mtime_ns`（纳秒）**而非 `int(st_mtime)`：
    秒级取整会把同一秒内的多次写压成同一个值，判据当场失效（第一版就这么全绿的）。
    best-effort：日志写失败不阻断业务写（否则日志成了新的单点）。

    **`ids`＝本次写**分配**的条目 id**（v5.53.0 · t000448）：写事件原来只记**文件**
    ⇒ 台账答不出「**这个 id 是谁分配的**」⇒ **凭空出现**的条目（人手加的、别的途径落的）
    因此隐形：它的载体不在台账里（`latest` 无它）⇒ 无从比对哈希 ⇒ `index` 重建后**彻底隐形**
    （t000448 实测复现：手加一条完全合法的条目 ⇒ 重建索引后 `check` 直接 OK）。
    ⇒ 记下**分配**这件事 ⇒ 判据可判「在册 id 没有任何 CLI 写事件分配过它」⇒ 红。
    **记「分配」而不是「文件里恰好有的 id」**：后者会被下一次任意 CLI 写洗掉
    （CLI 写那个文件 ⇒ 文件里的 id 一起被记成 CLI 写的 ⇒ 外来 id 被认领）。
    「分配」只有 CLI 做得出来 ⇒ 台账只追加 ⇒ **洗不掉**。

    **`prov`＝出处机制的版本标记**（每条事件都带）：判「本机制落地后的第一条事件」
    只看**台账尾部**那一条就够（⇒ 老库第一次写就落基线，不必全量扫台账）。

    **`id_base`＝老库基线**（只落在**第一条** prov 事件上）：老库存量 id 早于本机制
    ⇒ 台账里没有它们的分配记录 ⇒ 一律当「来历不明」会把老库打成恒红 ⇒ 落一条
    **快照**（此刻在册的 id 全集）把它们认账。快照只落一次（此后由 `ids` 逐条记分配）。
    """
    try:
        if not (st.d / "index").is_file():        # 同 _log：非库不落盘
            return
        ev = {"ts": datetime.now().astimezone().isoformat(timespec="seconds"),
              "op": op,
              "pre_tamper": sorted(pre_tamper or []),
              "removed": sorted(removed or []),
              "prov": PROV_VERSION,
              "files": {str(Path(t).relative_to(st.d)): {
                            "sha": _sha(Path(t).read_text(encoding="utf-8")),
                            "mt": Path(t).stat().st_mtime_ns}
                        for t in targets if Path(t).is_file()}}
        if ids:
            ev["ids"] = sorted(set(ids))
        if not _prov_live(st):
            # 本机制落地后的**第一条**写事件 ⇒ 落**老库基线**＝此刻在册 id 的**快照**
            # （来历不可追的老库存量 id 一律认账 ⇒ 不误伤老库）。
            # 为什么是快照而不是「台账记过的载体里现在有的 id」（v5.53.0 第一版的错法）：
            # 台账只记**它写过的载体** ⇒ 老库里**从没被台账记过**的载体（典型：老版本
            # `import` 写的裁定件——那批 id 从没进过台账）里的 id 永远缺席 ⇒ 老库恒红
            # （本仓实测 101 处误伤）。快照＝「此刻在册的一切」⇒ 与台账历史深度无关。
            ev["id_base"] = sorted(_used_ids(st, tolerant=True))
        with open(st.d / WRITES_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(ev, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _prov_live(st: Store) -> bool:
    """台账里**已经有**出处机制的标记了吗（唯一源）。

    为什么只看**尾部窗口**：本机制落地后每条写事件都带 `prov` ⇒ 尾部窗口里出现过它
    ⇒ 就说明机制已生效 ⇒ 判「是不是第一条」不必全量扫台账（本仓台账动辄上万条／十几 MB，
    每写一次扫一遍太贵）。**口径＝「尾部窗口里出现过」而不是「最后一条有没有」**：
    尾部若混进一条**旧格式**事件（人手补写的旧记录），按「最后一条」判会把已生效的机制
    误判成「还没生效」⇒ 白白再落一次基线（＝多一次认账窗口）。
    尾部窗口读不出任何 dict（末行被写坏／台账为空）⇒ 退化为**全量扫描**：
    宁可慢，也不把「老库」误判成「新库」（那会让基线落空 ⇒ 老库存量 id 全被当成外来）。
    """
    wl = st.d / WRITES_LOG
    if not wl.is_file():
        return False
    try:
        with open(wl, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            if size == 0:
                return False
            f.seek(max(0, size - 16384))
            blob = f.read()
    except OSError:
        return False
    lines = [l for l in blob.decode("utf-8", "replace").splitlines() if l.strip()]
    if len(blob) < size:
        lines = lines[1:]          # 掐断处那行是残行 ⇒ 丢掉（下面还有别的行可读）
    for l in lines:
        try:
            e = json.loads(l)
        except ValueError:
            continue
        if isinstance(e, dict) and e.get("prov"):
            return True
    for e in read_jsonl(wl):        # 尾部读不出 ⇒ 全量扫描（末行被写坏的情形）
        if isinstance(e, dict) and e.get("prov"):
            return True
    return False


def _safe_jsonl(p: Path) -> list[dict]:
    """读 JSONL，**跳过坏行**（唯一源＝`_used_ids(tolerant=True)` 用它）。

    为什么容错：基线在**写路径**上算（`log_write` 落基线）⇒ 载体坏了不能把写命令炸掉
    （数据已经落盘了，再炸＝半截操作；更糟：`log_write` 整块在 try 里 ⇒ 炸了＝**写事件
    整条丢失**）。主判据那边仍用 `read_jsonl`（坏了当场报错并给出修法）——
    **两处口径不同是故意的**：写路径求稳，读路径求准。
    """
    out: list[dict] = []
    try:
        text = p.read_text(encoding="utf-8")
    except OSError:
        return out
    return _safe_jsonl_text(text)


def _safe_jsonl_text(text: str) -> list[dict]:
    """**JSONL 文本**版（`_safe_jsonl` 的唯一实现体，v5.68.0 拆出）。

    清单里的载体内容是**文本**（`import` 从 `trash` 段还原的那一份就是文本）⇒
    要读它的 id 就得有一个吃文本的入口 ⇒ 与吃路径的入口**共用一份实现**
    （容错口径同源：跳过坏行）。
    """
    out: list[dict] = []
    for l in text.splitlines():
        if not l.strip():
            continue
        try:
            d = json.loads(l)
        except ValueError:
            continue
        if isinstance(d, dict):
            out.append(d)
    return out


def _safe_lines(p: Path) -> list[str]:
    """读纯文本行，**跳过读不出来的**（唯一源＝`_used_ids(tolerant=True)` 读 `void` 用它）。"""
    try:
        return [l.strip() for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
    except OSError:
        return []


def _id_baseline(evs) -> set[str] | None:
    """**出处基线**＝已被认账的存量 id 集合；`None`＝**基线还没建立**（唯一源＝本函数）。

    基线＝**出处机制生效那一刻在册的 id 快照**（写事件里的 `id_base` 字段）。
    取**全部**事件的并集（单调只增：认账不可撤销——`rebase --force` 再认一次也只是加）。

    **为什么是快照而不是「台账记过的载体里现在有的 id」**（v5.53.0 第一版的错法）：
    台账只记**它写过的载体** ⇒ 老库里**从没被台账记过**的载体（典型：老版本 `import`
    写的裁定件——那批 id 从没进过台账）里的 id 永远缺席 ⇒ 老库恒红（本仓实测 101 处误伤）。
    快照＝「此刻在册的一切」⇒ **与台账历史深度无关**（任何深度的老库都一次认账干净）。

    「基线已落但内容为空」与「基线还没落」必须**分得开**（前者＝新库，基线就是空的；
    后者＝老库，还没认账）⇒ 返回 `None` 表示「没落」，而不是「落了个空集」。
    """
    out: set[str] = set()
    seen = False
    for e in evs:
        if "id_base" in e:
            seen = True
            out |= {str(x) for x in (e.get("id_base") or [])}
    return out if seen else None


def audit_writes(st: Store) -> list[str]:
    """对账写事件与落盘现实（`check` 的一维，p000025）。

    两条判据，**都以内容哈希为主、mtime 为辅**：
      · **内容哈希对不上** ⇒ 存在**未经 CLI 记录的写入**（手改文件；`writes.jsonl`
        只记 CLI 写，手改不留痕）。
      · **内容哈希相同、但 mtime 更新了** ⇒ 文件**被动过又写回同样内容**——这正是
        「先手改、再用 CLI 覆写同样字节来补手续」的指纹。CLI 侧看不见那次手改的
        内容，但它**动了文件**，时间戳留下了。
    为什么不用纯 mtime 判「有没有被改」：mtime 可 `touch -d` 伪造。所以哈希是主判据、
    mtime 只在**哈希相同**时作旁证（那种情况本来就没内容差异可判）。
    """
    wl = st.d / WRITES_LOG
    if not wl.is_file():
        return []
    evs = read_jsonl(wl)
    if not evs:
        return []
    latest: dict[str, dict] = {}
    problems: list[str] = []
    for e in evs:
        for f, rec in (e.get("files") or {}).items():
            if isinstance(rec, str):          # 兼容旧格式（纯 sha）
                rec = {"sha": rec, "mt": None}
            latest[f] = rec
    ever_removed: set = set()
    for e in evs:
        ever_removed |= set(e.get("removed") or [])
    seen_tamper: set = set()
    for e in evs:
        for f in (e.get("pre_tamper") or []):
            if f not in seen_tamper:
                seen_tamper.add(f)
                problems.append(
                    f"{f}：在 {e.get('op')} 写入**之前**发现它已被 CLI 之外改动过"
                    f"（内容哈希可能仍与记录一致）——若是先手改文件、再用 CLI 覆写同样"
                    f"字节来「补手续」，那次手改的时间窗已无法追回")
    for f, rec in latest.items():
        p = st.d / f
        if not p.is_file():
            # 区分两种「不在了」：**经 CLI 正常删掉**（如 edit 换分区的「搬空即删」，
            # 4.7.5）不报；**凭空消失**（没有任何写事件记录过删它）才报。
            if f in ever_removed:
                continue
            problems.append(f"{f}：写事件记过它，现已不存在，且**没有任何 CLI 记录删过它**"
                            f"（疑似被 CLI 之外的途径删掉）")
            continue
        now_sha = _sha(p.read_text(encoding="utf-8"))
        if now_sha != rec.get("sha"):
            problems.append(
                f"{f}：内容哈希 {rec.get('sha')} ≠ 落盘实际 {now_sha} —— 存在"
                f"**未经 CLI 记录的写入**（`writes.jsonl` 只记 CLI 写；手改文件不留痕）")
        elif rec.get("mt") is not None and p.stat().st_mtime_ns > rec["mt"]:
            problems.append(
                f"{f}：内容**没变**（哈希同为 {now_sha}）但文件被改动过（mtime 更新）——"
                f"疑似「先手改、再用 CLI 覆写同样字节」的补手续；那次手改的时间窗已无法追回")
    return problems


def id_provenance_violations(st: Store) -> list[tuple[str, str]]:
    """**凭空出现的 id**（v5.53.0 · t000448）＝在册 id 的**来历不可追** ⇒ 红。

    返回 `[(id, 红项文案), …]`（空＝合规）⇒ id 单独带出来，好让出路**点名具体对象**。

    **病灶**：`audit_writes` 只对账**台账里有的文件**（内容哈希）⇒ **台账里没有的文件**
    不在射程：手加一条**完全合法**的条目（前缀对、prio 合法、日期合法）⇒ 别的维都不报
    （它本身合法）⇒ 跑一次 `handoff index` 重建索引后 ⇒ **写事件维也不报了**
    ⇒ 那条手加的条目**从此隐形**（t000448 实测复现）。

    **为什么不用「载体级」判据（台账里没有的文件 ⇒ 红）**：那个口径**会被洗掉**——
    `write_index` 的 `_dirty_targets` 用「内容或 mtime 与末次记录不同」判定「本次写过的
    文件」⇒ 对**台账里没有**的载体，「与末次记录不同」恒成立 ⇒ **下一次任意 CLI 写**
    （含 `handoff index`）就把它认领进台账 ⇒ 红项当场消失（实测复现）。

    ⇒ 改用**洗不掉的证据**：**分配**这件事只有 CLI 做得出来，而台账只追加。
    写事件记下本次**分配**的 id（`ids`）⇒ 判据可判「在册 id 没有任何 CLI 写事件
    分配过它」⇒ 红；`index` 重建改的是载体清单，改不了分配记录 ⇒ **洗不掉**。

    **老库怎么办**：存量 store 的 id 早于本机制 ⇒ 台账里没有它们的分配记录 ⇒
    一律当「来历不明」会把老库打成恒红 ⇒ 落一条**基线**（`id_base`，见
    `_id_baseline`）：**出处机制生效那一刻在册 id 的快照** ⇒ 存量 id 认账（不误伤）；
    此后新增的 id 必须有分配记录（`ids`）⇒ 判得出。

    **基线还没建立**（老库还没被新码写过）⇒ **本维不判**（存量 id 的来历不可追，
    判了必误伤）⇒ 但**不判 ≠ 静默**：另出一条可执行红项（见 `id_baseline_missing`）。

    **判据输入全是落盘证据**：写事件台账（谁分配过）＋ 库里在册 id（谁在这儿）。
    """
    wl = st.d / WRITES_LOG
    if not wl.is_file():
        return []              # 没有台账＝这个库从没有 CLI 写历史 ⇒ 无从判来历
    evs = read_jsonl(wl)
    if not evs:
        return []
    proven, anchored = _proven_ids(st, evs)
    if not anchored:
        return []              # 基线还没建立 ⇒ 本维不判（红项走 `id_baseline_missing`）
    out: list[tuple[str, str]] = []
    for _i in sorted(_used_ids(st) - proven):
        out.append((_i, f"{_i}：在册条目**没有任何 CLI 写事件分配过它** ⇒ 它的来历不可追"
                        "（人手加的、别的途径落的）——写事件对账此前只对账台账里有的文件，"
                        "这类**新文件**里的条目在 `index` 重建后完全隐形（t000448 实测复现）"))
    return out


def id_baseline_missing(st: Store) -> str | None:
    """**出处基线还没建立**时的红项文案（`None`＝已建立或无从谈起）（唯一源＝本函数）。

    为什么要有这条：老库在出处机制落地前的 id **来历不可追**（台账里没有分配记录）
    ⇒ 一律当「凭空出现」必然误伤 ⇒ 该维**不判**。但不判＝闸静默缺席＝「垃圾进不了账」
    这件事又变成没人管 ⇒ 这里给一条**可执行**的红项：认账一次即可（跑一次 CLI 写
    会自动落基线；`rebase --force` 是显式结案口）。

    **不是老库就不报**：库压根没有写事件台账（从没被 CLI 写过）⇒ 无从谈基线。
    """
    wl = st.d / WRITES_LOG
    if not wl.is_file():
        return None
    evs = read_jsonl(wl)
    if not evs:
        return None
    if _id_baseline(evs) is not None:
        return None
    return ("本库还没有 **id 出处基线**：老库存量 id 早于出处机制 ⇒ 台账里没有它们的"
            "分配记录 ⇒ 一律当「凭空出现」会把存量条目全打成误伤 ⇒ 该维**暂不判**。"
            "（认账一次即可：跑一次 CLI 写（如 `handoff index`）会自动落基线；"
            "`handoff rebase --force` 是显式结案口。）")


def _used_ids(st: Store, tolerant: bool = False) -> set[str]:
    """库里**在册**的条目 id 全集（唯一源＝本函数）。

    范围＝活层各槽（含 `unconfirmed`）＋ 冷档 `closed/` ＋ `decisions/` ＋
    `trash/` ＋ `void`。**回收站与 `void` 必须在范围内**：`rm` 掉的 id 进这两处 ⇒
    它们是「已用」⇒ 出处维要判它们的来历（否则手放进 `trash/` 的假 id 没人管）。
    不含 `archive/`：那里只有班段原文（`{"archived":…, "text":…}`），没有条目 id。

    **`tolerant=True`＝写路径**（基线快照）：载体坏了**跳过坏行**、不炸——
    `log_write` 整块在 try 里，炸了＝**写事件整条丢失**（数据已落盘、台账却没记）。
    **`tolerant=False`＝读路径**（判据）：坏了当场报错并给修法（`read_jsonl` 会 `die`）。
    **两处口径同源、容错度不同是故意的**：写路径求稳，读路径求准。
    """
    def _rows(p: Path) -> list[dict]:
        return _safe_jsonl(p) if tolerant else read_jsonl(p)

    out: set[str] = set()
    for slot in ENTRY_SLOTS:
        sd = st.d / slot
        if sd.is_dir():
            for f in sorted(sd.glob("*.jsonl")):
                for r in _rows(f):
                    if r.get("id"):
                        out.add(str(r["id"]))
    for r in _rows(st.unconf_file()):
        if r.get("id"):
            out.add(str(r["id"]))
    for f in st.closed_shards():
        for r in _rows(f):
            if r.get("id"):
                out.add(str(r["id"]))
    dec = st.decisions_dir()
    if dec.is_dir():
        out |= {f.stem for f in dec.glob("*.md")}
    # void ∪ trash（`_voided_ids` 的同源口径；tolerant 时坏行跳过）
    if tolerant:
        out |= set(_safe_lines(st.d / "void"))
        trash = st.d / "trash"
        if trash.is_dir():
            for f in sorted(trash.glob("*.jsonl")):
                for r in _safe_jsonl(f):
                    if r.get("id"):
                        out.add(str(r["id"]))
            out |= {f.stem for f in trash.glob("*.md")}
    else:
        out |= _voided_ids(st)
    return out


def _proven_ids(st: Store, evs) -> tuple[set[str], bool]:
    """**来历已知**的 id 全集 ＋ 基线是否已建立（唯一源＝本函数）。

    ⇒ `(proven, anchored)`：`proven`＝写事件记下的**分配**记录（`ids`）∪ **基线**
    （`id_base`，老库存量 id 的认账集合）；`anchored`＝基线**已建立**。

    **基线还没建立时不能拿现算口径顶替**（v5.53.0 第一版的错法）：「台账记过的载体里
    现在有的 id」在老库里**永远缺一块**（从没被台账记过的载体——典型是老版本 `import`
    写的裁定件）⇒ 老库恒红（本仓实测 101 处误伤）。⇒ 基线没落＝**不判**
    （红项走 `id_baseline_missing`），而不是判一个残缺的口径。
    """
    prov: set[str] = set()
    for e in evs:
        prov |= {str(x) for x in (e.get("ids") or [])}
    base = _id_baseline(evs)
    if base is None:
        return prov, False
    return prov | base, True


def _log(st: Store, event: str, **extra):
    """每次门禁落一条快照（best-effort，不因日志失败中断）。

    `extra` 用来挂事件专属字段（如 `close` 事件带被关 id 与 outcome）——快照的槽位
    计数部分对所有事件相同，事件本身只多一行语义。

    副作用边界：`--store` 指到**不是库**的目录时不落 log——`open(..., "a")` 会凭空建出文件，
    那等于让只读命令在任意路径写脏（实测：`handoff --store . check` 曾在仓库根造出 log.jsonl）。
    判据用 `index` 是否存在（init / import 都先写它），无 index＝不是库。
    """
    try:
        if not (st.d / "index").is_file():
            return
        live = st.load_live()
        slots = {s: len([r for r in live if r.get("_slot") == s]) for s in ENTRY_SLOTS}
        slots["unconfirmed"] = len(read_jsonl(st.unconf_file()))
        slots["decisions"] = len(list(st.decisions_dir().glob("*.md"))) if st.decisions_dir().is_dir() else 0
        slots["closed"] = len(st.load_closed())
        rec = {"ts": datetime.now().astimezone().isoformat(timespec="seconds"),
               "event": event, "slots": slots,
               "commands_empty": slots.get("commands", 0) == 0}
        rec.update(extra)
        with open(_log_path(st), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False, sort_keys=True) + "\n")
    except Exception:
        pass


def cmd_log(st: Store, a) -> int:
    p = _log_path(st)
    if not p.is_file():
        print("handoff log: （无日志）")
        return 0
    rows = read_jsonl(p)
    if a.stats:
        n = len(rows)
        ce = sum(1 for r in rows if r.get("commands_empty"))
        tot: dict[str, int] = {}
        for r in rows:
            for k, v in (r.get("slots") or {}).items():
                tot[k] = tot.get(k, 0) + int(v)
        print(f"runs={n}  commands_empty={ce}  commands_nonempty={n - ce}  last={rows[-1].get('ts','') if rows else ''}")
        print("sum(slots): " + json.dumps(tot, ensure_ascii=False))
        return 0
    tail = rows[-a.tail:] if a.tail else rows
    for r in tail:
        print(json.dumps(r, ensure_ascii=False))
    return 0


# ---------------- check ----------------
# ── `check` 判据清单：**唯一产生源**（2026-10-03 单源化试点）──
# 同一事实（有哪些判据）此前被复述在两处：`cmd_check` 的代码段 与 `SKILL.md` 正文的
# 判据清单 —— 加一条判据要改两处，本会话已因此反复「只改了一半」（正文与实现分叉）。
# 现在：**这一张表是唯一源**，`SKILL.md` 的清单由 `sync-dims` 从它生成，
# `selftest` 里有一条漂移检查兜住（生成物与源不同步即红）。
# 加判据时**只改这里**，然后跑 `handoff.py sync-dims` 写回生成块（可 `--check` 只验不写）。
RULING_FORMS_FILE = "handoff-ruling-forms.txt"
RULING_FORM_SECTIONS = ("topic", "pending", "record", "skip", "reference")

CHECK_DIMENSIONS: list[tuple[str, str]] = [
    ("slots", f"槽结构与 `index` 齐备（{_slot_count()} 槽；槽清单见 `references/rules.md`）"),
    ("id", f"id 形如 `{ID_FORM}`、全局唯一、**前缀与所在槽相符**"),
    ("status", "live 行的 `status` 在该型闭集内（**`closed` 不是可写值**，关闭只经 `close`）"),
    ("blocked-stale", "**`status=blocked` 的行，其 `blockedBy` 必须仍活着**（已 close／已作废／"
                      "被 supersede ⇒ 红，附三种修法）——两道入池谓词结论相反时，这条就"
                      "「无人接手但谁也看不见」；**不判**「blocked 却不写 blockedBy」"
                      "（那只是没记指向，非自相矛盾）"),
    ("blocked-owner", "**`status=blocked` 必须记下「在等什么」**：`blockedBy`（等库内 id）"
                      "或 `waitingFor`（等所有者／等用户／等外部条件），**二者至少有一个** ⇒ "
                      "否则红（**修法可满足**：补其一即可）。为什么现在能判：阻塞有三型，"
                      "字段层此前只承载第一型 ⇒ 「等所有者」的条目永远没有 blocker 可指，"
                      "于是它不入池、无 owner、任何维都不报＝「无人接手但谁也看不见」"
                      "（与 `decision-pending` 同型：那边补了维、这边没补）。"),
    ("fields", "未知字段 ＋ 必填字段缺失（按型）"),
    ("dates", "`created`/`closed` 是合法日期、非未来日、且 `created ≤ closed ≤ today`"),
    ("single-line", "`summary` 单行（不得含换行/制表）"),
    ("next", "`next` 是合法 id、存在、且 **`status=open`**（附可执行修法）"),
    ("text-dangling", f"文本槽（`status`/`summary`/`exit`）点名的 `{TEXT_DANGLING_FORM}` 型 id 必须既不在册、"
                      "也不在 `trash/`·`void` 之外（**已作废 ≠ 不存在**；`c`/`d` 两型不参与，"
                      "各有专门检查面）"),
    ("decision", "`decisions/*.md` 的 frontmatter id 必须等于文件名、日期合法、status 在闭集"),
    ("decision-pending", "**待追认的裁定**：`status: proposed` 的 `decisions/*.md` ⇒ 红。"
                         "`proposed`＝提议了还没人拍板，而 d 型**不进补位池**、也不被新鲜度维"
                         "点名（它们只管 t 型）⇒ 不判它，它就是个**零消费点的态**："
                         "不红、不入池、无闸看见，可以无限期挂着（v5.12.0／d000112）。"
                         "修法＝`handoff decide <id> --status accepted|rejected|superseded`"
                         "（原地改 status 一行，**不换 id、不改 created**）"),
    ("decision-prose", "**凡落裁定必走裁定件**：`exit`／`summary` 里命中库级形态表 "
                      f"`{RULING_FORMS_FILE}`（store 同级；字面串、五区 "
                      f"{'／'.join(f'`[{k}]`' for k in RULING_FORM_SECTIONS)}："
                      "topic 入门、pending／skip 免判、record 必带号、reference 只提示）的 "
                      "`[record]` 形态、而**同一行**没有在册或已作废的 `dNNNNNN` ⇒ 红；"
                      "`[reference]` 与闭集外形态只提示不判红（把未知露出来，不静默放过）。"
                      "标题行不算记录。**形态表不存在＝本维不启用**（通用默认：形态语言由各库"
                      "自定，不把任何一种语言的词表硬编码进随件代码）。"),
    ("scope", "`scope` 登记指向**活路径**或 glob 有命中（机械判据：登记必须可解析）"),
    ("void-reuse", "id 未复用已作废 id（`void` 拦截；**有出口**＝`unvoid`，报错自带修法）"),
    ("writes", "写事件对账：内容哈希对不上＝**未经 CLI 记录的写入**；写前发现被外部动过＝"
               "**疑似补手续**（含判据缺陷留下的历史误报，用 `rebase --force` 结案）。"
               "**含 `decisions/*.md`**（v5.12.0 补：此前裁定件的 status 手改无闸可抓，"
               "`decide` 的「唯一写路径」只是声明——没有对账面就等于没有）。"
               "**结案可撤销**（v5.71.0）：`rebase --force` 把带旁证的历史事件**搬进侧档**"
               "（**不销毁**），`rebase --undo` 能把它们搬回⇒那次结案同时认账的 id 空间"
               "**不可撤销**（认账单调只增）"),
    ("partition-case", "同槽分区文件名**大小写折叠后不得重名**（NTFS 大小写不敏感 ⇒ 仅大小写"
                       "不同的两个 domain 会合并成一个分区文件、计数与现实脱节）"),
    ("index", "`index` 的各槽计数与 `next` 与落盘一致（漂移即红）"),
    ("fresh-queue", "**交接新鲜度**（口径 R2·v5.29.0 ＋ **refs 化**·v5.45.0）：**本班新增的** "
                    "`t` 型条目必须被**最近班段点名覆盖**——v5.45.0 起**班段散文里写到 id "
                    "就算覆盖**（写时提取成 `refs` 落进班次台账，是**落盘证据**）⇒ "
                    "**作者成本 0**（不必另写一份声明，覆盖事实的原件就是散文）；"
                    "一次写不完（几十条 id）时用 `handoff append exit --covers <id…>` "
                    "**打包声明**（**例外出口**，不是必经之路）。"
                    "**老班段**（既没有 `refs` 也没有 `covers` 字段）⇒ 退回**旧口径扫散文**"
                    "（迁移不误伤）。"
                    "写入面同时拦（`append/set exit` 没点名也没声明 ⇒ **写入即拒**，报错给出要点的 id）"
                    "——写入面拦，不靠事后红。**v5.32.0**：写面不再因「状态断言」拒写"
                    "（散文不承担状态 ⇒ 判据也不拿散文比库里活状态；状态由 `view` 现算标注）。"
                    "只取 `t` 型——p/d 进 exit 属背景叙述，逐条要求提及会淹没真信号。"
                    "**义务只有一条：O(本班增量)**——存量与推不动的条目由**读时现算的视图**承担"
                    "（`handoff view` 逐条列出全部未销账条目，`entry_display_line` 还带"
                    "「等 owner／等 t000123」为什么推不动 ⇒ 读者看得见，散文不必再抄一份）。"
                    "**推不动的**（`status≠open`／`waitingFor`／`blockedBy` 指向活着的裁定）"
                    "**本班新增的**同样要点名（R·v5.23.0 曾要求它们**全部**点名 ⇒ 那是一条 "
                    "O(存量) 的散文义务 ⇒ 与「区落盘」同型的死锁支，拐点 ≈1800 条）。"
                    "**「本班新增」＝条目的 `bornShift` ≥ 上一次班段的班次序号**（v5.30.0 刀 F："
                    "**整数比较**、无并列、与时钟无关 ⇒ 同秒不再「留一班」）；"
                    "**没有 `bornShift` 的老行**按创建时刻 ≥ 边界时刻（截到秒）算（保守＝仍算新增）；"
                    "**导入存量**（`origin=import`）不算本班新增（迁移进来的旧工作，import "
                    "已用一行有界聚合交代）。"),
    # ⚠ **v5.32.0（P1／批 A）：`fresh-stale`／`fresh-false` 两维已作废**——
    #   散文**不再承担状态断言**（写面不因状态拒写；无时点的括号标记由写面规范化掉）
    #   ⇒ 拿散文比库里活状态**没有意义了**（那是拿死的载体判活的事实，L2）。
    #   旧形的代价（实算）：写面会拒 113 处，其中 109 处（96%）是**带时点的历史陈述**被误判；
    #   三句普通中文全部被拒写；库里 21 处状态副本是**闸逼出来的**。
    #   现在的做法：**状态由渲染现算补**（`view` 在无时点的行里给每个提及标真状态）
    #   ⇒ 读者看得到真状态，作者不必抄；机器也不再替作者裁决语义（用可见性换拦截力）。
    ("queue-legacy", "**旧库残留的队列区**：`exit` 里**不该再有**队列渲染区——v5.29.0 起它"
                     "**读时现算、不落盘**（读者看 `handoff view`）⇒ 落在文件里的那份是"
                     "v5.28.x 之前的残留，**会陈旧**（它是当时的快照）且它是机器内容、"
                     "留在人写的散文层里 ⇒ 与人写的叙述混在一起会被误读成「当时的现态」。"
                     "⇒ 存在即红；修法：`handoff sync-queue`（剥掉；幂等）或任意一条写 exit 的"
                     "命令（写入即剥）。**新库没有残留 ⇒ 不判红**"),
    ("prio-source", "**重要度单源**：live action 的 `prio` 必须在闭集 急/高/中/低/缓 内，"
                    "且 summary 不得以**档位词元**开头（`[中]`／`[高·重定]` 判，`[高危]`／`[根因]` 不判——"
                    "词元查表见 `is_tier_prefix`，d000111）——字段是唯一来源，留着旧前缀就是一条没人"
                    "同步的假通道。修法给 `handoff upgrade-prio --apply`；想标**严重度**用不相交词表 "
                    "`高危/中危/低危`（不判、不排序）。只判 live actions：pitfall／command 没有 prio 通道。"),
    ("derived-counts", "**现态计数不入散文**：`status`／`summary`／`exit` 里出现「现态锚点"
                    "（`live`／现态／实况／当前）＋同行 ≥2 个槽名＋数字」（M0）**或**"
                    "「锚点＋数字+汉字、同行无日期/取证语（为准/实算/实测/当日/现算）」（M5）⇒ 红。"
                    "**不判那个数对不对**——比值要靠正则认出那一行，而行的形状由人写（本仓实测："
                    "锚点要求 `live：actions` 紧邻，真行写成 `live： actions`，多一个空格整行被跳过，"
                    "而工具照打 OK）。数的唯一产生源＝`handoff index`（每次写重建）＋ `index` 维对账；"
                    "**v5.30.0：counts 区也不再落盘**（与队列区同构收口 ⇒ 判据面净减一处，"
                    "`counts-stale` 维已作废）⇒ 旧库残留的 counts 区先剥掉再判（它是机器渲染物）。"
                    "修：删数、改指路语「现态以 `handoff index`／`view` 实算为准」；"
                    "**带日期的历史快照放行**（那是当时事实）。"
                    "写入侧同一道形状闸在 `set`／`append` 上（`guard_derived_counts`）。"),
    ("sealed", "**封存态**（v5.0 sealed store，**POSIX 上的附加加固**）：`.handoff/` 全树不得有可写位"
               "——写权限只归 CLI，POSIX 上任何工具直改都被 EACCES 拒绝；未封存即红（跑任意命令"
               "自动回封，或显式 `handoff seal`）。**非 POSIX 上本维不判**，且 `check` 会提示"
               "「此平台无封存保护」——别把绿灯读成「已封存」。"
               "**本命令现建的库不判**（v5.68.0）：进门前它还不是库 ⇒ 那时「可写」是必然的"
               "初始态、不是任何人 chmod 回来的 ⇒ 本维在这次调用里没有判别对象"
               "（实测：`import` 现建库后自带的 check 判「未封存」⇒ import 报失败，"
               "而内容完整落地、导入后零可写位）。"
               "**「现建」按实物判**（v5.69.0）：库里有没有本 CLI 的产物（index／条目槽／"
               "unconfirmed）⇒ 老库**被删掉 `index`** 也仍是老库（仍须判封存）；"
               "空目录仍算现建（不判）"),

    ("archive", "**冷档完整性**（v5.0 热/冷分层）：`archive/*.jsonl` 每行须为 JSON 且带 "
                "`archived`/`text`——历史班段只经 `append`/`compact` 搬入，防手改冷档"),
    ("agents-block", "**AGENTS.md 交接块与唯一源一致**（仅在已有标记区时启用）：标记区文本逐字比对"
                     "标准源 `references/agents-handoff-block.md`；**漂移／多份 ⇒ 只报不改**"
                     "（v5.18.0：门禁不改使用方的文件），要按唯一源重装跑 `handoff check --repair`"
                     "（痕迹落 store 事件流）。**残缺／读不了 ⇒ 红且必须先人工解决**（无块界可分，"
                     "不猜着修）。**无 AGENTS.md 或无标记区＝本维不启用**（未装块的仓零误伤）。"
                     "**档位（basic／freshness）按独立证据比**：期望值取自「装过块」那条 d 型记录里"
                     "记的档位，**不取自被检查的文件**——否则一次不带 `--profile` 的 `--install`"
                     "就能把增强档仓**静默降级**（条款被搬出比对区）而检查自证通过（t000406）"),
    ("block-installed", "**本仓装过交接块、现在块不见了** ⇒ 红（装过的证据＝一条 d 型"
                        "「事实登记」记录；`AGENTS.md` 无标记区、或整个文件不在，都算「不见了」）。"
                        "**可选维**：从没装过块的仓不启用。修法：`handoff check --repair`／"
                        "`handoff agents-block --install <仓根>`；本仓不再用交接则 "
                        "`handoff rm <该记录 id>`"),
("rewrite-points", "**机制面重述点**（v5.44.0，终极律 L9）：本技能自己的代码与随件文档里，"
                       "**同一事实的第二份陈述**＝重述点 ⇒ 抄件会漂 ⇒ 纪律被违反时静默 ⇒ "
                       "同一个根因反复复发。可实算的两类：① 判据面**拿散文/副本当输入**的分支"
                       "（每处须在源码里显式标记 ⇒ 标记数＝实算数 ⇒ 新增一处就多一个重述点）；"
                       "② 随件文档里**枚举型工具事实**没被渲染（复用文档面漂移闸）。"
                       "⇒ 两类都只许**待在豁免名单里**（逐条写明死因与死期条件）⇒ 名单与实算"
                       "**双向对账**：实算多了＝新增重述点（红）；豁免过期＝该治了（红）。"
                       "修：把重述点消掉（改成引用/渲染），或同批在豁免名单里写明死期"),
    ("discipline-present", "**机制面纪律必现**（v5.52.0，终极律 L9 的另一投影）：纪律的落地"
                           "历来是「往散文里加一行」⇒ ① 纪律**只进了闸、没进文档** ⇒ 改包文档的"
                           "人（或 agent）**不知道有它** ⇒ 只靠闸兜（闸抓得到，但没人知道为什么）"
                           "⇒ 纪律**事实上没落地**；② 落地物是**抄件** ⇒ 抄件会漂 ⇒ 纪律被违反时静默。"
                           "⇒ 治法：**纪律清单落成数据**（`DISCIPLINE_PRESENT`，唯一源）＋ 随件文档里"
                           "那一节**必须含锚点** ⇒ 「纪律在文档里」这件事**可实算**。"
                           "修：在随件文档里补该纪律（锚点照抄 `DISCIPLINE_PRESENT` 的登记）"),
    ("id-provenance", "**凭空出现的 id**（v5.53.0 · t000448）：在册条目必须有**分配来历**——"
                      "写事件台账记下每次 CLI **分配**的 id（`ids`）⇒ 人手加的、别的途径落的"
                      "条目 ⇒ 红。写事件对账此前只对账**台账里有的文件**（内容哈希）⇒ "
                      "**台账里没有的新文件**不在射程 ⇒ 手加一条**完全合法**的条目、"
                      "重建 `index` 之后**彻底隐形**（t000448 实测复现）。"
                      "**老库不误伤**：出处机制生效那一刻在册的 id 落一条**基线**"
                      "（`id_base`，＝那一刻的 id 快照）认账（来历不可追，但可证明"
                      "「那一刻就在册」）；基线**还没建立**的老库该维不判，另出一条"
                      "「id 出处基线未建立」的可执行红项。"
                      "**导入还原的作废 id 也认账**（v5.68.0：`import` 还原库级事实面"
                      "（void／trash）时，那批 id 同样记进台账 ⇒ 一次合法往返不再被判"
                      "「来历不可追」）。"
                      "修：确认是自己加的 ⇒ `handoff rebase --force` 结案；"
                      "不是 ⇒ `handoff rm <那条 id>`；**已在回收站的**另给一条出路"
                      "（`rm` 对已作废的 id 会当场拒 ⇒ 用 `handoff unvoid <id> --restore`"
                      "或删掉 `trash/`／`void` 里那一份）"),
]
CHECK_BEGIN = "<!-- check-dims:begin （由 CHECK_DIMENSIONS 生成，勿手改）-->"
CHECK_END = "<!-- check-dims:end -->"

# ── 落点登记（v5.42.0）──────────────────────────────────────────────────────
# **为什么要有这张表**：判据维＝一条纪律。纪律的落地方式历来是「往散文里加一行」
# ⇒ 落地物是**抄件** ⇒ 抄件会漂移 ⇒ 纪律被违反时静默 ⇒ 同一个根因反复复发
# （族 G／J／E 都是它的投影：事实/规则**没有自己的落点** ⇒ 被塞进别人的容器
# ⇒ 继承别人的契约）。
# ⇒ 治本不是「把纪律搬进代码」，而是**给每条纪律一个落点**（事实自己的家）
# ＋一条写明的**契约**（谁产生·谁能改·何时过期）＋一条**作废条件**
# （它盯的东西何时消失 ⇒ 依赖它的机制随之作废）＋**一条行为型腿**。
#
# **「腿」这一列不写在这里**（写了就是第二份抄件）⇒ 由代码派生：腿在自己的
# `expect(..., dim="…")` 里指认「我证明哪一维」⇒ 唯一源＝那段标注。
#
# 四个字段的写法（判据会机械核对；格式即义务）：
#   fact      一句话说清这一维判的是什么（人读）
#   landing   (文件, 锚点)＝**判据实现处**：文件是包内相对路径，锚点须在该文件里逐字出现
#   contract  「产生：…｜可改：…｜过期：…」三段（缺一段＝没想清这条事实怎么活）
#   void_when 「触发条件 ⇒ 后果」——**判据维的寿命＝它所盯的副本的寿命**
#             （实测：盯副本的维分别只活了 22 版／17 版／1 版即作废；守事实的维在册 12~25 版）
FACT_LANDINGS: dict[str, dict[str, str]] = {
    "slots": {
        "fact": f"库结构齐备：{_slot_count()} 槽 ＋ index",
        "landing": ("scripts/handoff.py", "缺槽: "),
        "contract": "产生：init 一次性建库｜可改：仅 CLI（工具直改会被写事件对账维抓住）"
                    "｜过期：库目录被移走或删除",
        "void_when": "槽集合本身变更（增删槽）⇒ 本行作废，按新集合重写",
    },
    "id": {
        "fact": "id 的形、全局唯一、前缀与所在槽相符",
        "landing": ("scripts/handoff.py", "id 重复 "),
        "contract": "产生：CLI 分配（max+1 且永不复用）｜可改：仅 CLI（改号＝换条目）"
                    "｜过期：条目被删且 id 转作废",
        "void_when": "id 分配规则变更（前缀集或位数）⇒ 本行作废并重写",
    },
    "status": {
        "fact": "活条目的 status 在该型闭集内（closed 不是可写值）",
        "landing": ("scripts/handoff.py", "status 非法 "),
        "contract": "产生：add/edit 写面｜可改：仅 CLI（关闭只经 close）｜过期：条目销账",
        "void_when": "各型 status 闭集变更 ⇒ 本行作废并重写",
    },
    "blocked-stale": {
        "fact": "声称被挡、但挡住的东西已不再生效 ⇒ 红",
        "landing": ("scripts/handoff.py", "status=blocked，但 blockedBy 指向的"),
        "contract": "产生：blockedBy 关系建立｜可改：仅 CLI｜过期：blocker 关闭／作废／被取代",
        "void_when": "补位池谓词改写（blocked 不再等价于「被挡」）⇒ 本行作废",
    },
    "blocked-owner": {
        "fact": "status=blocked 必须记下「在等什么」（blockedBy 或 waitingFor）",
        "landing": ("scripts/handoff.py", "status=blocked，但**没记在等什么**"),
        "contract": "产生：add/edit 写面｜可改：仅 CLI｜过期：条目销账或状态离开 blocked",
        "void_when": "等待语义改由别的字段承载 ⇒ 本行作废",
    },
    "fields": {
        "fact": "未知字段 ＋ 必填字段缺失（按型）",
        "landing": ("scripts/handoff.py", "未知字段 "),
        "contract": "产生：各型可改字段表｜可改：仅 CLI（扩字段须同批改判据）｜过期：键表变更",
        "void_when": "字段表变更 ⇒ 本行作废并重写",
    },
    "dates": {
        "fact": "created/closed 是合法日期、非未来日、created ≤ closed ≤ today",
        "landing": ("scripts/handoff.py", "closed < created"),
        "contract": "产生：add/close 写面｜可改：仅 CLI｜过期：条目销账",
        "void_when": "日期口径变更（如允许时间戳）⇒ 本行作废",
    },
    "single-line": {
        "fact": "summary 单行（不得含换行/制表）——写面即拒，是本维的权威闸",
        "landing": ("scripts/handoff.py", "summary 含换行/制表"),
        "contract": "产生：写面（add/edit 当场拒）｜可改：仅 CLI｜过期：条目销账",
        "void_when": "summary 改为多行结构 ⇒ 本行作废",
    },
    "next": {
        "fact": "next 是合法 id、存在、且 status=open",
        "landing": ("scripts/handoff.py", "next: {nid} 不存在或已关闭"),
        "contract": "产生：close 的第二步（补位指针）｜可改：仅 CLI（人手钉回会被判红）"
                    "｜过期：指针指向的条目销账",
        "void_when": "补位池谓词改写 ⇒ 本行作废",
    },
    "text-dangling": {
        "fact": f"文本槽点名的 {TEXT_DANGLING_FORM} 型 id 必须既不在册、也不在 trash/void 之外",
        "landing": ("scripts/handoff.py", "但 live∪closed∪decisions 里没有这个 id"),
        "contract": "产生：作者写散文｜可改：作者（判据只读不算）｜过期：条目被改号或删除",
        "void_when": "文本槽不再承载 id 提及（或提及改由结构化引用承担）⇒ 本行作废",
    },
    "decision": {
        "fact": "裁定件 frontmatter id 与文件名一致、日期合法、status 在闭集",
        "landing": ("scripts/handoff.py", "frontmatter id "),
        "contract": "产生：add decision 写面｜可改：仅 decide（原地改 status）｜过期：裁定件销账",
        "void_when": "裁定件不再以文件承载（改结构化条目）⇒ 本行作废",
    },
    "decision-pending": {
        "fact": "status=proposed 的裁定件待追认 ⇒ 红",
        "landing": ("scripts/handoff.py", "status=proposed ⇒ **待所有者追认**"),
        "contract": "产生：add decision｜可改：仅 decide（原地改 status）｜过期：被追认为终态",
        "void_when": "d 型进入补位池或被别的维度覆盖 ⇒ 本行作废",
    },
    "decision-prose": {
        "fact": "凡落裁定必走裁定件（散文里的 record 形态须有在册 d 号）",
        "landing": ("scripts/handoff.py", "凡落裁定必走裁定件"),
        "contract": "产生：库级形态表（跟库）｜可改：库主改形态表｜过期：形态表不存在则本维不启用",
        "void_when": "裁定只经结构化引用表达（散文不再承载裁定形态）⇒ 本行作废",
    },
    "scope": {
        "fact": "scope 登记指向活路径或 glob 有命中",
        "landing": ("scripts/handoff.py", "scope 登记不可解析"),
        "contract": "产生：scope add｜可改：仅 CLI｜过期：登记指向的路径消失",
        "void_when": "scope 登记不再以路径存在性为准 ⇒ 本行作废",
    },
    "void-reuse": {
        "fact": "id 未复用已作废 id（void 拦截；出口＝unvoid）",
        "landing": ("scripts/handoff.py", "id 复用了已作废 id"),
        "contract": "产生：rm/unvoid 写面｜可改：仅 CLI｜过期：void 标记被清（unvoid）",
        "void_when": "void 机制取消（id 可自由复用）⇒ 本行作废",
    },
    "writes": {
        "fact": "写事件对账：内容哈希对不上＝未经 CLI 记录的写入",
        "landing": ("scripts/handoff.py", "未经 CLI 记录的写入"),
        "contract": "产生：CLI 每次写｜可改：仅 CLI（`rebase --force` 才结案；结案**可撤销**——"
                    "带旁证的事件**搬进侧档**不销毁，`rebase --undo` 可搬回）｜过期：写事件被收窗折叠",
        "void_when": "写事件台账取消（改用别的对账面）⇒ 本行作废",
    },
    "partition-case": {
        "fact": "同槽分区文件名大小写折叠后不得重名",
        "landing": ("scripts/handoff.py", "仅大小写不同"),
        "contract": "产生：add 的 domain 分区｜可改：仅 CLI（改 domain 即改名）｜过期：分区文件被删",
        "void_when": "分区命名规则变更 ⇒ 本行作废",
    },
    "index": {
        "fact": "index 的各槽计数与 next 与落盘一致",
        "landing": ("scripts/handoff.py", "index 漂移"),
        "contract": "产生：每次写重建（handoff index）｜可改：仅 CLI｜过期：index 被删（重建即可）",
        "void_when": "index 不再落盘（改读时现算）⇒ 本行作废",
    },
    "fresh-queue": {
        "fact": "本班新增的 t 型条目必须被最近班段点名覆盖（散文里写到即算；批量可用 --covers）",
        "landing": ("scripts/handoff.py", "fresh-queue："),
        "contract": "产生：班次台账的 refs 字段（写时提取）＋ covers 字段（例外出口）｜可改：仅 CLI"
                    "｜过期：最后一个老班段被新班段取代（老口径分支随之死）",
        "void_when": "覆盖声明改由结构化引用自动派生（作者不必列举）⇒ 本行作废",
    },
    "queue-legacy": {
        "fact": "exit 里不该有队列渲染区（旧库残留）",
        "landing": ("scripts/handoff.py", "queue-legacy"),
        "contract": "产生：旧库的渲染区（旧形机器内容）｜可改：仅 CLI（sync-queue 剥除）"
                    "｜过期：残留被剥掉即不再触发",
        "void_when": "队列区重新落盘 ⇒ 本行作废",
    },
    "prio-source": {
        "fact": "live action 的 prio 在闭集内，summary 不以档位词元开头",
        "landing": ("scripts/handoff.py", "prio-source"),
        "contract": "产生：add --prio ／ upgrade-prio 回填｜可改：仅 CLI｜过期：条目销账",
        "void_when": "档位词表变更 ⇒ 本行作废",
    },
    "derived-counts": {
        "fact": "现态计数不入散文（写面形状闸）",
        "landing": ("scripts/handoff.py", "现态计数不该抄进散文"),
        "contract": "产生：写面守门（set/append）｜可改：仅 CLI｜过期：散文层不再承载叙述",
        "void_when": "计数不再入散文（派生物全部读时现算）⇒ 本行作废",
    },
    "sealed": {
        "fact": "封存态：.handoff/ 全树不得有可写位（未封存即红；**本命令现建的库不判**）",
        "landing": ("scripts/handoff.py", "def seal_store"),
        "contract": "产生：CLI 每次命令收尾自动回封｜可改：仅 CLI（unseal 是维护态）"
                    "｜**本命令现建的库不判**（进门前它还不是库 ⇒「可写」是必然初始态，"
                    "不是任何人 chmod 回来的 ⇒ 本维没有判别对象；v5.68.0）"
                    "｜**「现建」按实物判**（库里有没有本 CLI 的产物 ⇒ 被删掉 index 的老库"
                    "仍须判；空目录仍算现建；v5.69.0）"
                    "｜过期：非 POSIX 平台无此保护",
        "void_when": "换用非权限位的封存机制 ⇒ 本行作废",
    },
    "archive": {
        "fact": "冷档完整性：archive/*.jsonl 每行须为 JSON 且带 archived/text",
        "landing": ("scripts/handoff.py", "存在畸形行"),
        "contract": "产生：append/compact 搬入｜可改：仅 CLI（手改冷档即红）｜过期：历史被压成更冷的一层",
        "void_when": "冷档取消（历史不再单独存档）⇒ 本行作废",
    },
    "agents-block": {
        "fact": "AGENTS.md 交接块与唯一源一致（仅在已有标记区时启用）",
        "landing": ("scripts/handoff.py", "def agents_block_text"),
        "contract": "产生：references/agents-handoff-block.md（唯一源）｜可改：仅改唯一源再重装"
                    "｜过期：使用方仓不再装块",
        "void_when": "块机制取消 ⇒ 本行作废",
    },
    "block-installed": {
        "fact": "装过交接块的仓，块不见了 ⇒ 红",
        "landing": ("scripts/handoff.py", "block-installed"),
        "contract": "产生：装过块那条 d 型事实登记｜可改：仅 CLI（rm 该记录即停用）"
                    "｜过期：使用方仓不再用本技能",
        "void_when": "不再登记「装过块」这一事实 ⇒ 本行作废",
    },
    "rewrite-points": {
        "fact": "机制面重述点（同一事实的第二份陈述）只许待在豁免名单里，且豁免不得过期",
        "landing": ("scripts/handoff.py", "rewrite-points：机制面重述点"),
        "contract": "产生：豁免名单（`REWRITE_EXEMPT`，唯一源在代码）｜可改：仅同批改代码"
                    "｜过期：对应机制被消掉（豁免随即过期 ⇒ 闸红）",
        "void_when": "重述点这套判据整体作废（机制面不再有第二份陈述）⇒ 本行作废",
    },
    "discipline-present": {
        "fact": "机制面纪律**必须写在随件文档里**（纪律清单落成数据，锚点必现）",
        "landing": ("scripts/handoff.py", "discipline_present_violations"),
        "contract": "产生：纪律清单（`DISCIPLINE_PRESENT`，唯一源在代码）｜可改：仅同批改代码"
                    "与随件文档（改纪律必同批改锚点）｜过期：该条纪律从清单里撤下 ⇒ 闸随即不判它",
        "void_when": "纪律必现这套判据整体作废（机制面纪律不再要求写进随件文档）⇒ 本行作废",
    },
    "id-provenance": {
        "fact": "在册条目的**来历可追**（每个在册 id 都有 CLI 分配记录，或被基线认账）",
        "landing": ("scripts/handoff.py", "def id_provenance_violations("),
        "contract": "产生：写事件台账的 `ids` 字段（CLI 分配记录）＋ `id_base` 基线"
                    "（老库存量 id 的认账＝出处机制生效那一刻的 id 快照）"
                    "｜可改：仅同批改代码（**新增分配 id 的写路径"
                    "必须同批传 `ids`**，漏传⇒该 id 被判凭空出现；"
                    "**`import` 还原库级事实面（void／trash）时也必须同批传 ids**，"
                    "否则一次合法往返会被判「来历不可追」＝假红；v5.68.0）"
                    "｜过期：写事件不再记分配 ⇒ 该事实随判据一起作废",
        "void_when": "出处台账这套判据整体作废（不再要求 id 的来历可追）⇒ 本行作废",
    },
}
LANDINGS_BEGIN = "<!-- landings:begin （由 FACT_LANDINGS 生成，勿手改）-->"
LANDINGS_END = "<!-- landings:end -->"
CONTRACT_PARTS = ("产生：", "可改：", "过期：")


def leg_dims_from_src(src: str) -> dict[str, list[str]]:
    """从源码派生「判据维 → 行为腿名」（唯一源＝`expect(..., dim="…")` 的标注）。

    为什么静态派生而不是运行时收集：**渲染器**（`sync-dims`）在 selftest 之外跑，
    它要画同一张表 ⇒ 两处必须同源。分工：静态＝「有哪些腿」，运行时＝「腿真跑过」
    （后者由 selftest 单独核对，见 `landing_registry_violations` 的 `ran` 参数）。
    """
    import ast as _ast_ld
    out: dict[str, list[str]] = {}
    try:
        tree = _ast_ld.parse(src)
    except SyntaxError:
        return out
    for n in _ast_ld.walk(tree):
        if not (isinstance(n, _ast_ld.Call) and isinstance(n.func, _ast_ld.Name)
                and n.func.id == "expect" and n.args):
            continue
        _dim = None
        for _kw in n.keywords:
            if _kw.arg == "dim" and isinstance(_kw.value, _ast_ld.Constant):
                _dim = _kw.value.value
        if not _dim:
            continue
        _a = n.args[0]
        _name = (_a.value if isinstance(_a, _ast_ld.Constant) and isinstance(_a.value, str)
                 else _ast_ld.unparse(_a))
        out.setdefault(_dim, []).append(_name)
    return out


def landing_registry_violations(src: str, pkg_root: Path,
                                ran: dict[str, list[str]] | None = None) -> list[str]:
    """落点登记的对账闸（唯一源）：返回违例清单（空＝合规）。

    四项：
    ① **覆盖**：每个判据维恰有一行登记；登记里不得有表外的维（多写＝登记自己漂了）
    ② **腿**：每个维至少一条**带 dim 标注**的行为腿（没有腿的纪律＝会漂移的抄件）；
       标注指向的维必须真存在（写错维名＝假腿）；给了 `ran` 时还要求那条腿**真跑过**
    ③ **落点可达**：登记写的文件在包内存在、锚点逐字出现（假落点当场红）
    ④ **契约与作废条件**：契约三段齐全（「产生／可改／过期」）、作废条件写成
       「触发 ⇒ 后果」（留空＝没想清这条事实什么时候该死）
    """
    out: list[str] = []
    dims = [d[0] for d in CHECK_DIMENSIONS]
    dims_set = set(dims)
    for k in dims:
        if k not in FACT_LANDINGS:
            out.append(f"判据维 `{k}` 没有落点登记行"
                       "（新增判据维必须同时写清：落点·契约·作废条件·行为腿）")
    for k in FACT_LANDINGS:
        if k not in dims_set:
            out.append(f"落点登记里的 `{k}` 不是判据维（登记漂移：判据维已删或改名）")
    legs = leg_dims_from_src(src)
    for k, names in legs.items():
        if k not in dims_set:
            out.append(f"行为腿标注了不存在的判据维 `{k}`"
                       f"（标注的腿：{'；'.join(names[:2])}）")
    for k in dims:
        if k not in FACT_LANDINGS:
            continue
        names = legs.get(k) or []
        if not names:
            out.append(f"判据维 `{k}` 没有行为腿（没有腿的纪律＝会漂移的抄件）")
        if ran is not None and not (ran.get(k) or []):
            out.append(f"判据维 `{k}` 的行为腿**一条都没跑过**"
                       "（标注落在没走到的分支里 ⇒ 那条腿不承重）")
        row = FACT_LANDINGS[k]
        f, anchor = row["landing"]
        fp = pkg_root / f
        if not fp.is_file():
            out.append(f"判据维 `{k}` 的落点文件不存在：{f}")
        elif anchor not in fp.read_text(encoding="utf-8", errors="replace"):
            out.append(f"判据维 `{k}` 的落点锚点在 {f} 里找不到：{anchor!r}"
                       "（落点漂移了 ⇒ 改登记或改实现，二者必须同步）")
        contract = row.get("contract", "")
        missing = [p for p in CONTRACT_PARTS if p not in contract]
        if missing:
            out.append(f"判据维 `{k}` 的契约缺 {'／'.join(missing)}"
                       "（契约三段＝谁产生·谁能改·何时过期）")
        vw = row.get("void_when", "")
        if "⇒" not in vw:
            out.append(f"判据维 `{k}` 的作废条件没写成「触发 ⇒ 后果」"
                       "（没写清它盯的东西何时消失 ⇒ 这一维什么时候该死）")
    return out


def render_landings() -> str:
    """落点登记的**渲染物**（唯一源＝`FACT_LANDINGS` ＋ 代码派生的腿列）。

    为什么是渲染物而不是手抄的表：手抄的表自己就是一份会漂移的抄件 ⇒ 复发机制照旧。
    """
    src = Path(__file__).read_text(encoding="utf-8")
    legs = leg_dims_from_src(src)
    lines = [LANDINGS_BEGIN, "",
             "| 判据维 | 事实 | 落点（文件·锚点） | 契约（产生｜可改｜过期） | 作废条件 | 行为腿 |",
             "|---|---|---|---|---|---|"]
    for key, _doc in CHECK_DIMENSIONS:
        row = FACT_LANDINGS.get(key)
        if not row:
            lines.append(f"| `{key}` | **未登记** | — | — | — | — |")
            continue
        names = legs.get(key) or []
        lines.append(f"| `{key}` | {row['fact']} | `{row['landing'][0]}` · `{row['landing'][1]}` "
                     f"| {row['contract']} | {row['void_when']} "
                     f"| {'；'.join('`' + n + '`' for n in names) or '**无腿**'} |")
    lines += ["", LANDINGS_END]
    return "\n".join(lines)


# ── 文档面事实注册表（v5.43.0 · 批 E）────────────────────────────────────────
# **为什么有这张表**：文档里凡是**枚举工具事实**的地方（槽清单／id 形态／status 闭集／
# prio 闭集／写面上限／写入类命令），那串事实**归代码所有** ⇒ 手抄进文档就是**第二份抄件**
# ⇒ 抄件会漂 ⇒ 文档慢慢变成假称（族 E 的复发机制）。
# ⇒ 治法：**事实只存一份（在代码里）**，文档里只留**渲染区**
# （`<!--fact:ID-->…<!--/fact-->`），渲染器写回、对账闸逐字比对 ⇒ 手改渲染区当场红。
#
# **判据（写死，不留给模型现场抉择）**：能被代码断言的句子 ⇒ 渲染；纯纪律/契约句 ⇒ 手写。
# （契约句没有代码事实可断言 ⇒ 搬进代码也只是换个地方抄 ⇒ 不搬。）
FACT_RE = re.compile(r"<!--fact:([A-Za-z0-9_-]+)-->(.*?)<!--/fact-->", re.S)


def _doc_fact_slots() -> str:
    """槽清单（唯一源＝`SINGLES` ＋ `ENTRY_SLOTS` ＋ `DOC_SLOT` ＋ `UNCONF_SLOT`）。"""
    _dirs = [*ENTRY_SLOTS, DOC_SLOT]
    _n = _slot_count()
    return f"{_n} 槽（{'／'.join(SINGLES)} ＋ {'／'.join(_dirs)} ＋ {UNCONF_SLOT}）"


def _doc_fact_id() -> str:
    """id 的形态与前缀映射（唯一源＝`ID_RE` ＋ `TYPE2SLOT`）。"""
    _m = re.search(r"\[([a-z]+)\]", ID_RE.pattern)
    _letters = list(_m.group(1)) if _m else []
    _dm = re.search(r"\\d\{(\d+)\}", ID_RE.pattern)
    _width = _dm.group(1) if _dm else "6"
    _live = [c for c in _letters if c != "q"]
    _map = "／".join(f"{c}→{TYPE2SLOT[c]}" for c in _letters if c in TYPE2SLOT)
    return f"<{'|'.join(_live)}><{_width} 位>（{_map}）"


def _doc_fact_status() -> str:
    """各型条目的 status 闭集（唯一源＝`ADD_KINDS[*].live_status`）。"""
    _by: dict[frozenset, list[str]] = {}
    for _k, _v in ADD_KINDS.items():
        if _v.get("live_status"):
            _by.setdefault(frozenset(_v["live_status"]), []).append(_k)
    _parts = []
    for _s, _ks in _by.items():
        _parts.append(f"{'／'.join(_ks)}＝`{'`｜`'.join(sorted(_s))}`")
    return "；".join(_parts)


def _doc_fact_prio() -> str:
    """重要度闭集与缺省（唯一源＝`PRIO_LEVELS` ＋ `PRIO_DEFAULT`）。"""
    return f"{'／'.join(PRIO_LEVELS)}（降序，缺省「{PRIO_DEFAULT}」）"


def _doc_fact_limits() -> str:
    """写面上限（唯一源＝`OUTCOME_CAP`／`SUMMARY_CAP`／`DETAIL_CAP`）。"""
    return (f"`close --outcome` ≤{OUTCOME_CAP} 字、条目 `summary` ≤{SUMMARY_CAP} 字、"
            f"`detail` ≤{DETAIL_CAP} 字")


def _doc_fact_writers() -> str:
    """写入类命令清单（唯一源＝`WRITER_CMDS`）——这批命令**不建库**。"""
    return "／".join(f"`{c}`" for c in sorted(WRITER_CMDS))


def _doc_fact_verbs() -> str:
    """CLI 子命令清单（唯一源＝`cli_verbs()`＝parser 树派生）——文档里不许手抄这份清单。"""
    return " · ".join(f"`{v}`" for v in cli_verbs())


DOC_FACTS: dict[str, Callable[[], str]] = {
    "slots": _doc_fact_slots,
    "id": _doc_fact_id,
    "status": _doc_fact_status,
    "prio": _doc_fact_prio,
    "limits": _doc_fact_limits,
    "writers": _doc_fact_writers,
    "verbs": _doc_fact_verbs,
}


def doc_fact_value(fid: str) -> str | None:
    """事实的**代码派生值**（`None`＝没有这条事实）。"""
    _f = DOC_FACTS.get(fid)
    return _f() if _f else None


# ── 派生常量（v5.47.0）：id 形态与 waitingFor 值域的**唯一源** ────────────────
# 为什么单立：这两条事实此前散在**字面量**里（`ID_RE` 的字符类、报错文案里的
# 「owner｜user｜external:<描述>」）⇒ 文案抄了一份、改一处漏一处（实测已漂：正文里
# 写的 id 字母序与 `ID_RE` 不一致）。⇒ 事实只存这一份，文案插值。
# ── v5.48.0：事实的**渲染形态闭集**（形态表；唯一源）────────────────────────
# **为什么要有这张表**：v5.43.0 立的机制是「**一致性闸**」——渲染区与代码派生值**逐字比对**。
# 它管的是「**已登记的那一处**有没有漂」，**不管「这类事实还有没有第二份」**。
# ⇒ 实测（2026-10-24）：**22 处**手抄的事实抄件散在五个用户可见面上，现役闸**一处都抓不到**
#   （其中 1 处**已经漂**：正文写的 id 字母序与 `ID_RE` 不一致）。
# ⇒ 治法：把判断从「一致」升到「**存在**」——一条事实的**渲染形态**只许出现在
#   ① 事实注册表（原件）② 引用它的地方（渲染区／运行时插值）③ 本表自身。
#   **形态表是数据不是判据**（决策规程 §3）：形态从真实样本穷举；新增形态＝加一行。
#
# ── v5.55.0（t000458）：形态表**不存派生值**——派生事实的形态改「引用声明」──────
# **为什么**：形态表是**登记处**（原件在这里不算抄件），但登记处里若存着派生事实的
#   **现值抄件**（槽数随槽结构变、抄的那份不会跟着变）⇒ 形态表自己成了第二个漂移源。
# **口径三选一**（只有第三个同时满足那两条约束）：
#   ① 表里放**可执行表达式** ⇒ 表变成代码（形态表是**数据**不是判据）✗
#   ② 表里放**渲染值**（把现值写死）⇒ 抄件 ⇒ 会漂（这正是原来那形态）✗
#   ③ 表里放**引用声明**（指向唯一源的具名引用）＋**解析期实算** ⇒ 表仍是数据、
#      现值仍只有一份（产生源不变）✓
# ⇒ 唯一源＝`FACT_REF_SOURCES`（引用名 → 实算函数）；形态表里只写引用名。
FACT_REF_SOURCES: dict[str, Callable[[], str]] = {
    "@slot_count": lambda: f"{_slot_count()} 槽",
}


def _fact_form(form: str) -> str:
    """形态表里一条形态的**现值**（唯一源）：字面量原样返回；引用声明按 `FACT_REF_SOURCES` 实算。

    **为什么要有这一层**：形态表是数据 ⇒ 它只许存「不变的形态」（形态串、值域、闭集）；
    派生事实的现值会变 ⇒ 只能存**引用声明**（指向产生源），由本函数在读时实算。
    ⇒ 表里若写了现值（等于抄了产生源那份）⇒ 事实存在性闸当场红（见 `fact_copy_violations`）。
    """
    _src = FACT_REF_SOURCES.get(form)
    return _src() if _src else form


def _fact_variants() -> list[tuple[str, str]]:
    """形态表的**现值对**（唯一源）：[(事实名, 形态现值)…]——引用声明在此解析一次。

    **为什么三个消费面都走它**（文档面／代码面／注释面）：形态表改一处、三个面各算一遍
    ⇒ 同一事实三个结论 ⇒ 分叉。⇒ 解析只此一处，三面取同一份现值。
    """
    return [(fact, _fact_form(form)) for fact, form in FACT_VARIANTS]


FACT_VARIANTS: list[tuple[str, str]] = [
    ("槽数", "@slot_count"),
    ("id 形态", "<t|p|d|c|u><6 位>"),
    ("id 形态", "<t|p|d|u|c><6 位>"),
    ("类型字母（import 的 _type）", IMPORT_TYPE_FORM),
    ("类型字母（文本槽死指针参与型）", TEXT_DANGLING_FORM),
    ("类型字母（可恢复型）", RESTORABLE_FORM),
    ("waitingFor 值域", "｜".join(WAITING_FOR_FORMS)),
    ("resolve --as 值域", "|".join(RESOLVE_AS_FORMS)),
    ("写面上限", "400 字"),
    ("写面上限", "120 字"),
    ("写面上限", "2000 字"),
    ("prio 闭集", "急／高／中／低／缓"),   # 形态表＝形态的登记处（原件在这里，不算抄件）
]


# ── v5.51.0：事实形态的**匹配器**（Q4 形态 · 独立席定形）────────────────────
# ⚠ **本块说明里不写形态字面量**：形态只在 `FACT_VARIANTS` 里存一份；说明里举例就得
#   抄一份 ⇒ 抄件 ⇒ 自己的闸抓自己 ⇒ 恒红（这是本块自己撞过一次的地方）。
#   ⇒ 举例一律**指路**（「槽数那条形态」「写面上限那几条」），形态本体去看形态表。
#
# **为什么换掉子串匹配**：旧形用「形态是不是文本的子串」⇒ **双向假阳**（实测三处）：
#   · **数不同**（多一位的数 ⊃ 少一位的数）
#   · **单位不同**（字节估算 ⊃ 字那条形态——单位不同却撞上了）
#   · 同一形态的合法变体之间也分不开
# ⇒ 且子串匹配判的不是「事实的形态」而是「某段字符」⇒ 这是族 E 的老路
#   （用死的载体判活的事实）在**匹配层**的重演。
#
# **Q4 形态（两分，逐字穷举、零正则）**：
#   · **符号类**（值域／形态串，如 waitingFor 值域、id 形态那几条）：
#       形态自带定界符 ⇒ **整段子串逐字比对** ＋ **边界检查**（前一二字符非 ASCII 字母数字）
#       ⇒ 防前缀截胡（形态前紧邻字母数字时不算命中）。
#   · **数字类**（值＋单位，如槽数、写面上限那几条）：结构化化为 **(数, 单位)**；
#       **单位闭集在表内显式登记**（`FACT_UNITS`）⇒ 匹配时按**最长单位 munch** 切出
#       (数, 单位) 候选，再与形态**逐字全等**比较。
#       ⇒ 「字节」与「字」是两个单位 ⇒ 字节估算**不**命中「字」那条形态（假阳消解）
#       ⇒ 数值不同 ⇒ 不命中；位数不同 ⇒ 不命中（数必须**逐字全等**）。
# ⚠ 本块的说明文字里**不写形态字面量**（那会变成判据抄自己的形态 ⇒ 自己的闸抓自己
#   ⇒ 见「事实只存一份」：形态只在 `FACT_VARIANTS` 里存一份，说明里一律指路）。
FACT_UNITS: tuple[str, ...] = ("字", "字节", "槽")   # **单位闭集**（唯一源；新单位须登记）


def _fact_is_numeric_form(form: str) -> bool:
    """这个形态是不是**数字类**（数＋单位）？

    判据（封闭枚举，不靠正则）：形态＝`数` ＋ 分隔空白 ＋ 单位，且单位 ∈ `FACT_UNITS`。
    ⇒ 「形态串里带数字」的那几条（id 形态里的位数）**不是**数字类（那个数是形态内部的
      一部分，不是「值＋单位」）⇒ 归符号类，整段逐字比对。
    """
    parts = form.split()
    if len(parts) != 2:
        return False
    num, unit = parts
    return bool(num) and num.isdigit() and unit in FACT_UNITS


def _fact_form_at(text: str, form: str) -> int:
    """形态 `form` 在 `text` 里的起始下标；没命中 ⇒ −1（**唯一源**＝事实存在性闸的判据）。

    两类各走各的判法（Q4 形态）：
      · 数字类：按**最长单位 munch** 切出 (数, 单位) 候选，再与形态全等比较；
      · 符号类：整段子串逐字比对 ＋ 边界检查（前一二字符非字母数字）。
    """
    if _fact_is_numeric_form(form):
        want_num, want_unit = form.split()
        for idx, num, unit in _fact_munch_numbers(text):
            if num == want_num and unit == want_unit:
                return idx
        return -1
    # 符号类：整段逐字 ＋ 边界
    start = 0
    while True:
        i = text.find(form, start)
        if i < 0:
            return -1
        # 边界：前一二字符非字母数字（防前缀截胡）
        if _fact_boundary_ok(text, i):
            return i
        start = i + 1


def _fact_boundary_ok(text: str, i: int) -> bool:
    """形态起点 `i` 前的字符是否构成合法边界（**前一二字符非 ASCII 字母数字**）。

    为什么看**前一二**个而不是一个：形态可能以分隔符开头（如 waitingFor 值域那条，
    它的首词前面紧邻的是引号 ⇒ 非字母数字 ✓），而形态前紧邻一个字母数字时
    （如某个字母前缀粘着）⇒ 那是**截胡** ⇒ 判否。
    二字符窗口是为了覆盖「形态本身以字母数字开头、且紧邻又紧邻一个字母数字」的情形
    （数紧邻着另一个数时）。

    ⚠ **只认 ASCII 字母数字**（`str.isalnum()` 对**汉字也返回真** ⇒ 会把
    「形如〈id 形态〉」这种**前面紧邻汉字**的合法引用误判成截胡）。
    本仓已有同族教训（`\\b` 把汉字当词字符 ⇒ 中文写法里的 id 扫不到）⇒ 这里不重复那个错。
    """
    for k in (1, 2):
        j = i - k
        if j < 0:
            continue
        c = text[j]
        if (c.isascii() and c.isalnum()):
            return False
    return True


def _fact_munch_numbers(text: str):
    """把文本里的「数＋单位」按**最长单位优先**munch 出来。

    产出 (起始下标, 数字串, 单位) 三元组。**最长优先**是必需的：单位闭集里「字节」比
    「字」长 ⇒ 若按短的先切，会把「字节」切成「字」＋ 剩一个字 ⇒ **假阳**；按**最长**
    先切 ⇒ 单位正确 ⇒ 不命中 ✓。

    单位只认闭集 `FACT_UNITS`（形态表里显式登记的）⇒ 新单位漏进来＝**漏报**（不是假阳），
    漏报由「闭集刷新须配负控」这条纪律兜住（负控在 selftest 里）。
    """
    units_sorted = sorted(FACT_UNITS, key=len, reverse=True)
    i = 0
    n = len(text)
    while i < n:
        if text[i].isdigit():
            j = i
            while j < n and text[j].isdigit():
                j += 1
            num = text[i:j]
            # 数与单位之间允许空白（形态里就是空格分隔）
            k = j
            while k < n and text[k] == " ":
                k += 1
            for u in units_sorted:
                if text.startswith(u, k):
                    yield (i, num, u)
                    i = k + len(u)
                    break
            else:
                i = j
            continue
        i += 1


def _fact_copy_in_text(text: str, fname: str) -> list[str]:
    """**文档面**的事实抄件（唯一源＝`fact_copy_violations` 调它；负控也走它⇒一处判据）。"""
    out: list[str] = []
    for fact, form in _fact_variants():
        idx = _fact_form_at(text, form)
        if idx < 0:
            continue
        line = text[:idx].count("\n") + 1
        out.append(f"{fname}:{line} ｜ 事实『{fact}』的渲染形态『{form}』出现在散文里"
                   f"（抄件：事实只许在注册表与引用处；这里要改成插值或指路语）")
    return out


def _fact_copy_in_code(src: str) -> list[str]:
    """**代码面**的事实抄件（唯一源＝`fact_copy_violations` 调它；负控也走它⇒一处判据）。"""
    import ast as _ast_fc2
    out: list[str] = []
    try:
        tree = _ast_fc2.parse(src)
    except SyntaxError as e:
        return [f"源码解析失败：{e}"]
    excl_lines: set[int] = set()
    for n in _ast_fc2.walk(tree):
        if isinstance(n, (_ast_fc2.FunctionDef, _ast_fc2.AsyncFunctionDef)):
            # 事实注册表（原件）与测试台（不是消费面）不扫；
            # 静态机制闸的负控探针也是测试台（2026-10-28 从 cmd_selftest 抽出，豁免随迁）
            if (n.name.startswith("_doc_fact_") or n.name == "cmd_selftest"
                    or n.name in ("_selftest_static_mechanism_gates", "_selftest_shim")):
                excl_lines.update(range(n.lineno, n.end_lineno + 1))
        if isinstance(n, (_ast_fc2.Assign, _ast_fc2.AnnAssign)):
            for t in (n.targets if isinstance(n, _ast_fc2.Assign) else [n.target]):
                # **登记处不是抄件**：`FACT_VARIANTS`（形态原件）与 `FACT_COMMENT_EXEMPT`
                # （注释面豁免登记）里写着形态字面量 ⇒ 那是**登记**，不是第二份抄件
                # ⇒ 与形态表同理排除（否则判据抓自己的登记 ⇒ 恒红）。
                if getattr(t, "id", None) in ("FACT_VARIANTS", "FACT_COMMENT_EXEMPT"):
                    excl_lines.update(range(n.lineno, n.end_lineno + 1))
    for n in _ast_fc2.walk(tree):
        if not (isinstance(n, _ast_fc2.Constant) and isinstance(n.value, str)):
            continue
        if n.lineno in excl_lines:
            continue
        for fact, form in _fact_variants():
            if _fact_form_at(n.value, form) >= 0:
                out.append(f"L{n.lineno} ｜ 事实『{fact}』的渲染形态『{form}』出现在代码文案里"
                           f"（抄件：改成插值派生值，别手抄）")
                # ⚠ **不 break**：同一个字符串常量里可能同时抄了**多个**形态 ⇒
                #   只报第一个 ⇒ 另一个抄件被静默放过（漏报）。
    return out


def fact_copy_violations(pkg_root: Path, src: str) -> list[str]:
    """事实**存在性闸**（v5.48.0 起；v5.51.0 补注释面）：渲染形态只许出现在原件、引用处与形态表自身。

    扫**五个用户可见消费面**（B/C/D 三面都在「代码字符串」这一面里，按载体分）：
      A 随件文档散文（`references/*.md` ＋ `SKILL.md`；**剔除**渲染区与生成块——
        那两处是「引用」不是「抄件」）；
      B 代码侧注册表单元（`CHECK_DIMENSIONS` 的规则文本、`FACT_LANDINGS` 的事实描述——
        它们会被渲染进随件文档 ⇒ 抄件会进用户眼前）；
      C 写面报错消息（`die` 的字面量）；
      D 读面红项（`check` 的字面量）；
      E 代码里的**注释**（**开发面**；v5.51.0 起用 `tokenize` 单独扫——AST 里没有注释节点）。

    ⚠ **v5.49.0 纠过一处假称**（独立席 Q7.1 的活样本）：v5.48.0 的本文写的是
    「E 代码里的 docstring／注释（开发面）」，但**实现是纯 AST 扫描**——AST 里注释节点
    根本不存在 ⇒ **声称覆盖 > 实际覆盖**，且就发生在元根因自己的治本机制身上。
    ⇒ v5.49.0 先把它**显式登记为不管面**（当时挂在 `待建:comment_surface` 这个**欠账**名下），
      **v5.51.0 补上实现**（`tokenize` 面）⇒ 本版起**面清单与实现对上了**
      （覆盖面登记见 `MECHANISM_COVERAGE`；治本路径见本技能的**审计记录**
      （仓内 `audits/` 下，**不随件分发**）里「最佳方案路径·定案」一节的 §四）。
    ⚠ **v5.54.0 废掉了「待建」这个欠账形态**：它承诺「到期未落 ⇒ 闸红」而代码里从没实现
      ⇒ 挂上去的面既没人扫又永远绿（无期限免检口）⇒ 现在只有两类归属值：
      **永久豁免**（带非空理由）或**真机制**（且它真扫那个面）。

    ⚠ **射程＝现行机制面**：**历史面载体**（自带日期、讲的是「当时」的记录型载体，例：
      审计记录 `DESCRIPTION-AUDIT.md`）**不在射程** ⇒ 那里的事实陈述是**历史审计事实**，
      不是现态抄件 ⇒ 不判（登记见 `MECHANISM_COVERAGE` 的「不管面」）。

    命中即红（**存在性**，不是一致性）：这句话在陈述一个事实 ⇒ 它必须是**插值**，不是抄件。
    """
    out: list[str] = []
    # ── A 随件文档散文 ──
    gen = ((CHECK_BEGIN, CHECK_END), (LANDINGS_BEGIN, LANDINGS_END))
    docs = sorted(pkg_root.glob("references/*.md")) + [pkg_root / "SKILL.md"]
    for d in docs:
        try:
            text = d.read_text(encoding="utf-8")
        except OSError:
            continue
        stripped = re.sub(r"<!--fact:.*?<!--/fact-->", "", text, flags=re.S)
        for b, e in gen:
            stripped = re.sub(re.escape(b) + r".*?" + re.escape(e), "", stripped, flags=re.S)
        out += _fact_copy_in_text(stripped, d.name)
    # ── B/C/D 代码面（字符串字面量）──
    out += _fact_copy_in_code(src)
    # ── E 注释面（`tokenize`；AST 看不见注释 ⇒ 必须单独扫）──
    out += _fact_copy_in_comments(src)
    # ── 形态表自身：派生事实的**现值**不许进表（v5.55.0 · t000458）──
    # 表里若写了现值（等于把产生源那份抄进登记处）⇒ 产生源一改、表就漂
    # ⇒ 登记处自己成了第二份抄件（这正是形态表自存派生值的病）。
    for _ref, _fn in FACT_REF_SOURCES.items():
        _live = _fn()
        for _fact, _form in FACT_VARIANTS:
            if _form == _live:
                out.append(f"形态表里存了派生事实『{_fact}』的现值（形态『{_live}』）"
                           f"⇒ 表里只能放引用声明（{_ref}）——派生值一改就漂")
    return out


def _fact_copy_in_comments(src: str) -> list[str]:
    """**注释面**的事实抄件（唯一源＝`fact_copy_violations` 调它；负控也走它⇒一处判据）。

    **豁免口径**：注释里**讲历史**的那些句子（引的是漂移前的旧值／旧上限）命中形态，
    但它们是**证据**不是现态事实 ⇒ 逐条登记在 `FACT_COMMENT_EXEMPT`（带死因与死期）⇒
    豁免表与实算**双向对账**（对账本身由 `fact_comment_exempt_violations` 判）。

    ⚠ **一条注释里的多个形态要全报**（不 `break`）：一处注释同时抄了两个事实时，
    只报第一个 ⇒ **另一个抄件被静默放过** ⇒ 闸漏报（负控当场抓出过这个形态）。
    """
    out: list[str] = []
    for line, fact, form, txt in _fact_comment_hits(src):
        if _fact_exempt_match(form, txt):
            continue                      # 已显式豁免（讲历史）⇒ 不算抄件
        out.append(f"L{line} ｜ 事实『{fact}』的渲染形态『{form}』出现在**注释**里"
                   f"（抄件：注释不能插值 ⇒ 改成指路语或删掉；原文：{txt[:60]}）")
    return out


# ── v5.47.0（B3′）读面出路表：`check` 的红项也必须自带当场可执行的下一步 ──────
# **为什么单立这张表**（t000443）：写面早就有出路表（`DIE_FIXES`）＋五形闸＋命令真实性闸，
# **读面没有** ⇒ 实测 56 个红项站点里 **38 个一个字的下一步都没有**（另 18 个把出路
# 内嵌在消息里）⇒ 用户撞上红项仍得自己想下一步。
#
# **键＝处境，不是维度**：同一维度常有多个处境（`dates` 维有「非日期／未来日／
# closed < created」），共用一条修法会不具体 ⇒ 按**处境**分列（与写面 41 键同款形状）；
# 维度仍出现在红项文案里（用户看得出哪条规则红了）。
#
# **表值里不手抄事实**：要 stating 事实（如 id 形态、status 闭集）时**插值**派生值
# ⇒ 出路里的事实与实现同源（`ID_FORM`／`doc_fact_value`）⇒ 事实改了出路跟着改。
#
# **写面那 72 处「自带散文出路」的站点不搬**（v5.47.0 实测后的判负）：
# 五形闸与命令真实性闸判的都是**用户看到的那段话**（`exit_text` ＝ 消息 ＋ 表值）
# ⇒ 写面 113 处**已被两把闸全覆盖**；搬进表不增加任何覆盖面，只改 72 条用户可见文案
# ⇒ 按 D5 收益律（收益量不出来的改动判负）不搬。
CHECK_FIXES: dict[str, str] = {
    "缺槽": f"跑 `handoff init --force` 补齐缺失的槽（只补缺的文件与目录，不删已有条目）："
            f"{doc_fact_value('slots')}",
    "缺 index": "跑 `handoff index` 重建索引（写面每次写也会重建）。",
    "非法 id": f"改成合规 id：{ID_FORM}；前缀要对上所在槽。",
    "id 重复": "改掉其中一条的 id，或把旧的那条 `handoff rm <id>` 掉（作废的号不复用）。",
    "id 前缀与槽不符": f"改成合规 id：{ID_FORM}；或 `handoff rm <id>` 后用 `handoff add` "
                       f"按目标槽重开一条。",
    "unconfirmed 前缀": "改成 u 前缀的 id（unconfirmed 槽只收 u 型）。",
    "closed 文件前缀": "把冷档文件名改成与 id 前缀一致（形如 `t000123.jsonl`）。",
    "status 非法": f"改成该型闭集内的值：{doc_fact_value('status')}；"
                   f"关闭只经 `handoff close <id> --outcome \"...\"`。",
    "未知字段": "删掉那个字段（工具只认各型声明的字段），或用 `handoff import` 整条重导。",
    "缺必填": "补上那个字段：`handoff edit <id> --summary <值>`"
              "（要改的字段见 `handoff edit --help`）。",
    "created 非日期": "把 `created` 改成 `YYYY-MM-DD`（写面只收合法日期 ⇒ 这一行是手改进去的）。",
    "created 为未来日": "把 `created` 改成今天或更早（日期不能在未来）。",
    "closed 非日期": "把 `closed` 改成 `YYYY-MM-DD`（写面只收合法日期 ⇒ 这一行是手改进去的）。",
    "closed 为未来日": "把 `closed` 改成今天或更早（日期不能在未来）。",
    "closed 早于 created": "把 `closed` 改成不早于 `created` 的日期（顺序是 created ≤ closed ≤ today）。",
    "summary 含换行": "压成单行（分段写进 `handoff edit <id> --detail <内容>`）。",
    "next 非法 id": "跑 `handoff next --auto` 重选指针（非法 id 不能当决策点）。",
    "next 不存在": "跑 `handoff next --auto` 重选指针。",
    "next 不是 open": "跑 `handoff next --auto` 重选指针（等待中的条目不该当决策点）。",
    "next 卡在 blocker": "先解掉挡路的那条（`handoff close <挡路id> --outcome \"...\"` "
                         "或改它的 `blockedBy`），再跑 `handoff next --auto`。",
    "文本槽死指针": "把那处 id 改成在册的真实 id，或 `handoff rm <id>` 把真条目删掉"
                    "（文本不会自己跟着变）。",
    "blockedBy 已失效": "择一：条件确已消失 → `handoff edit {id} --status open`；"
                        "改等另一条 → `handoff edit {id} --blockedBy <还活着的 id>`；"
                        "已不值得等 → `handoff close {id} --outcome \"...\"`。",
    "blocked 缺等谁": "择一：等库内某条 → `handoff edit {id} --blockedBy <还活着的 id>`；"
                      "等所有者／用户／外部 → `handoff edit {id} --waitingFor owner`"
                      "（值域：" + "｜".join(WAITING_FOR_FORMS) + "，**别把 `|` 一起粘**"
                      "——会被 shell 当管道）；条件已消失 → `handoff edit {id} --status open`。",
    "裁定件 id 与文件名不符": "把 frontmatter 的 `id` 改成与文件名一致（形如 `d000001`）。",
    "裁定件 created 非日期": "把 frontmatter 的 `created` 补上 `YYYY-MM-DD`。",
    "裁定件 status 非法": "改成闭集内的值（" + "／".join(DECISION_STATUSES) + "）；"
                          "原地改 status 用 `handoff decide <id> --status <值>`。",
    "待追认的裁定": "`handoff decide {stem} --status accepted`"
                    "（原地改 status，不换 id、不改 created）。",
    "裁定形态表不可用": "按库里的形态表建一份（形态语言由各库自定）；"
                        "先 `handoff scope add <形态表路径>` 让它进登记面再试。",
    "裁定陈述无在册 d 号": "先 `handoff add decision --title .. --body ..` 立件，"
                          "再把 `dNNNNNN` 写进**同一行**。",
    "scope 不可解析": "改登记：`handoff scope remove <路径>` 或 `handoff scope add <路径>`"
                      "（登记必须能解析：路径存在或 glob 有命中）。",
    "id 复用已作废号": "`handoff unvoid {id}`（条目本身也要从 trash/ 搬回来就加 `--restore`）。",
    "写事件对账": "核对 `.handoff/log.jsonl` 与该文件的写事件：确认是手改 ⇒ "
                  "`handoff rebase --force` 结案；漏写 ⇒ `handoff import` 重导那条。",
    "凭空出现的 id": "先确认这条是不是自己加的：是 ⇒ `handoff rebase --force`"
                     "（把当前 id 空间结案成基线，来历不追究）；不是 ⇒ "
                     "`handoff rm {id}` 把它移出去。",
    # v5.68.0（t000475 · F-I1）：**已在回收站的那种**单列一条出路——
    # 旧形那条出路写「`handoff rm {id}` 把它移出去（条目本体在 trash/ 里）」⇒ 而
    # **已在 trash/／void 里的 id，`rm` 会当场拒**（「已作废」）⇒ 用户照着敲撞墙。
    # ⇒ 这种情况的出路必须是**当场可执行**的：捞回来（unvoid --restore）或
    #   直接把那一份删掉（手放的假 id 就在那儿）。
    "凭空出现的 id（已在回收站）": "它已经在 `trash/`／`void` 里 ⇒ `handoff rm {id}` 会当场拒"
                                  "（已作废）⇒ 要它回活层用 `handoff unvoid {id} --restore`；"
                                  "要彻底清掉就把 `trash/`／`void` 里那一份删掉"
                                  "（手放的假 id 就在那儿）；确认是自己加的 ⇒ "
                                  "`handoff rebase --force` 结案。",
    "id 出处基线未建立": "跑一次 `handoff index`（会自动认账当前 id 空间＝落基线）；"
                         "要显式结案用 `handoff rebase --force`。"
                         "（基线建立前「凭空出现的 id」维不判——老库存量 id 的分配记录"
                         "追不回来，判了必误伤。）",
    "分区名大小写重名": "改成其中一个的 domain（大小写折叠后不得重名）："
                        "`handoff edit <id> --domain <新名>`。",
    "index 漂移": "跑 `handoff index` 重建（写面每次写也会重建）。",
    "index 非法 JSON": "删掉那个 `index` 文件再跑 `handoff index` 重建。",
    "本班条目没被点名": "写一个新班段并点名：`handoff append exit` 里**写到这些 id 就算覆盖**"
                        "（作者成本 0）；一次写不完就打包声明 `handoff append exit --covers <id…>`。",
    "本班条目没被点名（老口径）": "**新班段用 `handoff append exit` 追加**（把上面这些条目点名写进去）；"
                                  "**一行可以写多个 id（打包）**，不必一行一个 ⇒ {where}；"
                                  "要改旧内容再 `handoff set exit` 整槽喂回（先 `--dry-run`）。",
    "队列区残留": "跑 `handoff sync-queue` 剥掉（幂等；任意一条写 exit 的命令也会顺手剥）。",
    "重要度来源不一致": "跑 `handoff upgrade-prio --apply` 回填旧前缀；"
                        "单条改 `handoff edit <id> --prio <值>`。",
    "散文抄了现态计数": "删数改指路语「现态以 `handoff index`／`view` 实算为准」；"
                        "若那是**当时**的取证快照，就在同行写明日期。",
    "存储未封存": "跑任意 `handoff` 命令即自动回封，或显式 `handoff seal`。",
    "冷档畸形行": "那一行不是 `append`／`compact` 写的 ⇒ 回退手改，或 `handoff import` 重导。",
    "交接块与唯一源不一致": "按唯一源重装：`handoff check --repair`"
                           "（或 `handoff agents-block --install {root}`）。",
    "交接块标记残缺": "补全或删掉残端，再跑 `handoff agents-block --install {root}`。",
    "交接块标记残缺（带坐标）": "补全或删掉残端（check 不猜着修），"
                              "再跑 `handoff agents-block --install {root}`。",
    "装块失败": "确认 `AGENTS.md` 可写后重跑 `handoff check`"
                "（或手跑 `handoff agents-block --install {root}`）。",
    "重装后仍不一致": "`handoff agents-block --check {root}` 看差在哪（check 不改你的文件）。",
    "读不了交接块": "确认文件可读后重跑 `handoff check`。",
    "装过块却找不到标记区": "`handoff agents-block --install {root}`"
                            "（标记区已无，`check --repair` 无块可修）；"
                            "本仓不再用交接则 `handoff rm {rec}`。",
    "重述点与豁免对不上": "把重述点消掉（改成引用／渲染），或同批在豁免名单里写明死因与死期。",
    "纪律没进随件文档": "在随件文档（`references/rules.md`）里补上该纪律——纪律清单与锚点见代码里的"
                        " `DISCIPLINE_PRESENT`；补完同批把锚点照抄进文档，闸才认。",
}


def E(key: str, text: str, **fmt) -> str:
    """读面红项的**唯一拼装入口**（v5.47.0）：站点文案 ＋ 出路（`CHECK_FIXES` 表值）。

    键不在表里 ⇒ **当场报错**（写错键＝用户拿到错路；与写面 `die(msg, key=…)` 同款纪律）。
    表值里要 stating 事实时**插值**派生值 ⇒ 出路与实现同源。
    `fmt`＝表值里的**实例占位符**（如 `{id}`＝这条红项真的那个 id）⇒ 出路能点名具体对象，
    不必让用户自己把 `<id>` 换掉（出路律的门槛是「当场可执行」）。
    占位符没给值 ⇒ 当场报错（表值与站点脱节＝用户拿到一条跑不成的出路）。
    """
    _fix = CHECK_FIXES.get(key)
    if _fix is None:
        die(f"check 红项出路键 {key!r} 不在出路表里（写错键 ⇒ 用户拿到错路）"
            f"——**内部不一致**：站点声明的键不在表里")
    if fmt:
        try:
            _fix = _fix.format(**fmt)
        except (KeyError, IndexError) as _e:
            die(f"读面出路键 {key!r} 的占位符没给值（{_e}）——出路与站点脱节，"
                f"用户拿到的是一条跑不成的出路——**内部不一致**：表值与站点脱节")
    return f"{text}　修：{_fix}"


def check_fix_violations(src: str) -> list[str]:
    """**读面出路闸**（v5.47.0 · t000443）：每个红项都必须自带当场可执行的下一步。

    四项：
    ① 每个 `errs.append(...)` 站点都必须经 `E("处境键", …)` 拼装（漏声明 ⇒ 红项没有出路）；
    ② 声明的键必须在 `CHECK_FIXES` 里（写错键 ⇒ 用户拿到错路）；
    ③ 表里不许有死行（每行至少被一个站点声明——没人走的那条路不是路）；
    ④ 每条出路自身**成形**（五形，`exit_shape`）且点名的 `handoff <命令>` **真存在**
       （复用 `exit_shape` 与 `exit_nonexistent_commands_violations`——同一把尺用在两面）。

    判据输入是**用户看到的那段话**（站点文案 ＋ 表值），不是源码片段——判据输入必须是
    用户看到的东西，不是作者写下的片段。
    """
    import ast as _ast_cf
    out: list[str] = []
    try:
        tree = _ast_cf.parse(src)
    except SyntaxError as e:
        return [f"源码解析失败：{e}"]
    used: set[str] = set()
    for n in _ast_cf.walk(tree):
        if not (isinstance(n, _ast_cf.Call) and isinstance(n.func, _ast_cf.Attribute)
                and n.func.attr == "append" and isinstance(n.func.value, _ast_cf.Name)
                and n.func.value.id == "errs" and n.args):
            continue
        _arg = n.args[0]
        if not (isinstance(_arg, _ast_cf.Call) and isinstance(_arg.func, _ast_cf.Name)
                and _arg.func.id == "E" and _arg.args):
            out.append(f"L{n.lineno}: 红项没有经 `E(处境键, …)` 拼装"
                       "（读面红项必须自带出路——用户撞上不该再自己想下一步）")
            continue
        _k = next((a.value for a in _arg.args
                   if isinstance(a, _ast_cf.Constant) and isinstance(a.value, str)), None)
        if _k is None:
            out.append(f"L{n.lineno}: 红项的处境键不是字面量（判据要能静态核对）")
            continue
        if _k not in CHECK_FIXES:
            out.append(f"L{n.lineno}: 出路键 {_k!r} 不在读面出路表里"
                       "（写错键 ⇒ 用户拿到错路；出路表在 `CHECK_FIXES`）")
            continue
        used.add(_k)
    for k, v in CHECK_FIXES.items():
        if k not in used:
            out.append(f"出路表行 {k!r} 没有任何红项站点声明（死行：没人走的那条路）")
        if not exit_shape(v):
            out.append(f"出路表行 {k!r} 的出路**不成形**（五形缺一 ⇒ 用户撞上仍得自己想）")
        for _i, _c in exit_nonexistent_commands_violations([v]):
            out.append(f"出路表行 {k!r} 点名的 `{_c}` 不在 CLI 子命令表内（照抄跑不了）")
    return out


def doc_fact_text_violations(text: str, fname: str) -> list[str]:
    """单个文档的事实闸（`doc_fact_violations` 逐文件调它；负控也走它⇒一处判据）。

    两项：① 渲染区与代码派生的值不一致（手改渲染物）；② 渲染区引用了不存在的事实。
    """
    out: list[str] = []
    for m in FACT_RE.finditer(text):
        fid, cur = m.group(1), m.group(2)
        want = doc_fact_value(fid)
        if want is None:
            out.append(f"{fname}: 渲染区引用了**不存在**的事实 `{fid}`"
                       "（事实清单在代码里；加一条事实就要在文档里用它）")
        elif cur.strip() != want.strip():
            out.append(f"{fname}: 事实 `{fid}` 的渲染区与代码派生的值**不一致**"
                       f"（生成物=「{cur.strip()[:60]}」｜代码=「{want.strip()[:60]}」）")
    return out


def doc_fact_violations(pkg_root: Path) -> list[str]:
    """文档面事实闸：渲染区必须与代码派生的值**逐字一致**（手改渲染物 ⇒ 红）。

    三项：① 渲染区与代码不一致（手改渲染物）；② 渲染区引用了不存在的事实；
    ③ 注册表里的事实一条都没被用（死事实＝白登记）。
    """
    out: list[str] = []
    used: set[str] = set()
    for f in sorted(pkg_root.glob("references/*.md")):
        try:
            text = f.read_text(encoding="utf-8")
        except OSError:
            continue
        out += doc_fact_text_violations(text, f.name)
        used |= {m.group(1) for m in FACT_RE.finditer(text)}
    for fid in DOC_FACTS:
        if fid not in used:
            out.append(f"事实 `{fid}` 没有任何渲染区在用（注册表里的死事实）")
    return out


# ── v5.52.0（C 批）：**纪律必现表**（机制面纪律的落点＝随件文档里那一节）────────
# **为什么要有这张表**（t000446）：纪律的落地方式历来是「往散文里加一行」⇒
#   ① 纪律**只进了闸、没进文档** ⇒ 改包文档的人（或 agent）**不知道有它** ⇒
#      只靠闸兜（闸能抓到，但人不知道为什么要这么做）⇒ 纪律**事实上没落地**；
#   ② 纪律的落地物是**抄件** ⇒ 抄件会漂 ⇒ 纪律被违反时静默（同族 E 的老路）。
# ⇒ 治法：**纪律清单落成数据**（本表，唯一源）＋ 随件文档里那一节**必须含锚点**
#   ⇒ 「纪律在文档里」这件事本身**可实算**（本闸）⇒ 纪律被删／被改写 ⇒ 当场红。
#
# **为什么不用 `DOC_FACTS` 渲染区**：那条路的值由**代码派生**⇒ 适合「值会变」的事实
#   （槽数、上限、命令清单）；而纪律是**一句不该变的话**⇒ 做成派生值就得把纪律正文
#   搬进代码 ⇒ 文档里那行又变成渲染物 ⇒ 人读不到纪律本身 ⇒ 本末倒置。
#   ⇒ 本表只登记**锚点**（纪律正文的**关键片段**），正文仍由人在随件文档里写：
#   锚点＝纪律的可核对指纹（改写纪律必改锚点 ⇒ 同批改本表 ⇒ 纪律漂移有闸）。
DISCIPLINE_PRESENT: dict[str, str] = {
    # 纪律 id → 必现锚点（纪律正文的**关键片段**）
    "one-source": "事实只存一份",
    "interpolate-not-copy": "要插值，别手抄",
    # v5.53.0（t000448）：在册 id 的**来历**必须可追（分配记录）——纪律进了闸，
    # 就得在随件文档里有那一节，否则改包的人不知道有它（那正是 t000446 的病）。
    "id-provenance": "每个在册 id 都要有分配记录",
    # v5.54.0（t000456）：事实闸的**射程**＝现行机制面 ⇒ 历史面载体（审计记录）整份不在
    # 射程 ⇒ 那里的事实陈述是历史审计事实、不是现态抄件 ⇒ 不判。
    "historical-surface-out-of-scope": "历史面载体不在事实闸射程",
    # 同批：面登记成「不管面」时，永久豁免必须**写明理由**（空理由＝无痕免检口）。
    "exemption-requires-reason": "永久豁免要写明理由",
    # v5.55.0（t000458）：形态表（登记处）里**不许存派生事实的现值**——否则登记处自己
    # 成了第二份抄件 ⇒ 产生源一改就漂。⇒ 表里只写引用声明，现值读时实算。
    "variant-table-no-derived": "形态表不存派生值",
    # v5.55.0（t000447）：提示类输出**也有体量口径**——「只报不拦」不等于可以铺开写
    # （铺开就把真红项淹了）⇒ 计数 ＋ 摘要，单行长度有界。
    "output-volume-cap": "输出有体量口径",
    # v5.56.0（t000457）：写路**按行定位**——一次只处置**一条**，不按 id 整表过滤。
    # 同文件里落着两条同 id 时，多余那条留在原处（不被顺带处置）；备份与恢复按条数对称。
    "row-precise-write": "写路按行定位，不按 id 整表过滤",
    # v5.57.0（t000461）：**CLI 写到的载体一律进台账**——载体面不许有例外
    # （d 型曾被排除 ⇒ 导入来的裁定件改正文没人抓）；台账按增量记 ⇒ 覆盖面补齐不撑大台账。
    "carrier-in-ledger": "CLI 写到的载体一律进台账",
    # v5.59.0（t000459）：**新纪律要同批登记**——这条是**设计期纪律**：它管的那件事
    # （纪律的「全不全」）机器判不了（枚举口径三条候选都判负，见
    # `discipline_present_violations` 的 docstring）⇒ 靠「新增时有人答」。
    # 登记它 ⇒ 它的**存在**仍由锚点必现闸机械可判（不许被静默删掉）。
    "new-discipline-registered": "新纪律要同批登记",
    # v5.61.0（t000465）：**改契约必同批改命令参考**——纪律登了不等于命令参考跟上了
    # （本闸只对账 `references/rules.md` 一份 ⇒ 命令参考不在射程里）。
    # 它管的**同步**没有闸（命令参考这一面没有可机械枚举的全集）⇒ 靠「改契约时同批改」
    # ＋多维实测的常设维度兜底；登记它 ⇒ 它的**存在**由本闸机械可判。
    "contract-sync-command-ref": "改契约必同批改命令参考",
    # v5.62.0（t000466）：**子命令表只有一个源，别手抄**——加子命令只改参数面
    # （`build_parser()`）⇒ 文档渲染／出路判据／出路命令闸三处自动跟上。
    # 旧形把子命令名**另抄一份**到常量 ⇒ 抄件与实表漂移（文档漏项／出路闸误判或放行）⇒
    # 治法＝消灭副本（v5.41.0 已裁定的选型判据：盯副本的治法必须是消灭副本）。
    # 它管的「新增时别手抄」有闸（单一源闸：副本复活 ⇒ 红），但**完整性**（有没有别的
    # 常量也该只有一个源）机器判不了 ⇒ 如实不冒充。
    "cli-verbs-single-source": "子命令表只有一个源，别手抄",
    # v5.63.0（d000161）：**每个机制都得声明有没有纪律**——完整性闸的对账对象
    # （分母＝机制全集 ⇒ 可枚举 ⇒ 不需要「纪律全集」⇒ 绕开 d000158 的死结）。
    # 它管的「值不值得」是判断 ⇒ 闸只能对账**有没有声明**，判不了**声明得对不对**。
    "declare-discipline-per-mechanism": "每个机制都得声明有没有纪律",
}

# ── v5.63.0（d000161）立、**v5.65.0 换源换形**（t000469 · F-B／F-C）：**机制 → 声明**表（唯一源；一个机制一行）
# （旧形是两张**方向相反**的表：纪律→机制 与 机制→理由 ⇒ 同一机制可同时收进两张
#   ⇒ 5 处自相矛盾，且差集语义在交集上失效 ⇒ 守护关系可静默腐烂；v5.65.0 合成
#   一张「机制 → 声明」表，**值的两种形态互斥** ⇒ 矛盾在结构上不可能。）
# **键**＝机制名（判据维名／闸函数名）；**值**＝
#   · `tuple[str, ...]` → **有纪律**：守护它的在册纪律 id 列表（非空）；
#   · `str`             → **无纪律**：为什么它不需要一条要读者记住的纪律（非空）。
# **值的两种形态互斥**（`tuple` vs `str`）⇒ **同一机制两处都声明在结构上不可能**
#   （旧形两张**方向相反**的表可同时收同一机制 ⇒ 实测 5 处自相矛盾；且差集语义
#   在交集上失效 ⇒ 删掉一条守护关系也**不红** ⇒ 守护关系可静默腐烂）。
#
# **分母＝机制全集**（v5.65.0 换源）：判据维（`CHECK_DIMENSIONS`，判据的唯一源）∪
#   **代码里被消费的闸**（`consumed_gates()`：全模块 AST 枚举**调用点** ∩ `_violations`
#   命名约定）⇒ **不再靠人工表枚举** ⇒ 新闸不登记就自动进全集。旧形的分母是三张
#   人工表 ⇒ 实测有 **3 个真实被消费**的闸（出路命令闸／注释面豁免闸／出处台账闸）
#   不在对账面内 ⇒ 完整性闸对它们**完全无效**。
# ⚠ **归类仍是人工口径**（判断「这个机制值不值得读者记住一条纪律」）——本表换的是
#   「**人工做一次、闸只对账**」，**不是消除人工**；闸判的是**形状**（每个机制一行
#   ＋ 值的形态合法 ＋ 守护者纪律 id 真存在 ＋ 无纪律的理由非空 ＋ 在册纪律不孤儿）。
DISCIPLINE_DECL: dict[str, tuple[str, ...] | str] = {
    # ── 有纪律（守护者＝在册纪律 id）──────────────────────────────────
    # 判据维（规则文本由渲染块带进随件文档，但**机制**是它们被机检的那一面）
    "id-provenance": ("id-provenance",),
    "rewrite-points": ("variant-table-no-derived",),
    "fresh-queue": ("output-volume-cap",),
    "writes": ("row-precise-write", "carrier-in-ledger"),
    "decision": ("carrier-in-ledger",),
    "discipline-present": ("new-discipline-registered",),
    # 闸（判据读源码结构／登记表那一族）
    "fact_copy_violations": ("one-source", "interpolate-not-copy", "historical-surface-out-of-scope"),
    "doc_fact_violations": ("one-source",),
    "id_provenance_violations": ("id-provenance",),
    "mechanism_coverage_violations": ("exemption-requires-reason",),
    "rewrite_gate_violations": ("variant-table-no-derived",),
    "rewrite_exempt_violations": ("variant-table-no-derived",),
    "discipline_present_violations": ("new-discipline-registered",),
    "exit_key_violations": ("contract-sync-command-ref",),
    "cli_verb_source_violations": ("cli-verbs-single-source",),
    "discipline_completeness_violations": ("declare-discipline-per-mechanism",),
    # ── 无纪律（理由非空）────────────────────────────────────────────
    "agents-block": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md`；"
                    "「标准交接块」在 §四 硬约束里 ⇒ 不另设",
    "archive": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md` ⇒ 漏不掉",
    "block-installed": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md` ⇒ 漏不掉",
    "blocked-owner": "闸型纪律：规则文本已渲染；『阻塞必须记在等什么』在 §四 硬约束里 ⇒ 不另设",
    "blocked-stale": "规则文本随判据清单渲染进 `references/cli.md`（闸型纪律，漏不掉）；"
                     "它的行为由 `blocked-owner` 那条纪律覆盖 ⇒ 不另设",
    "dates": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md` ⇒ 漏不掉",
    "decision-pending": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md` ⇒ 漏不掉",
    "decision-prose": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md` ⇒ 漏不掉",
    "derived-counts": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md` ⇒ 漏不掉",
    "fields": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md` ⇒ 漏不掉",
    "id": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md`；"
          "「id 永不复用／脚本分配」在 §二 存储里 ⇒ 不另设",
    "index": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md`；"
             "「P2 可重建」在 §三 不变量里 ⇒ 不另设",
    "next": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md` ⇒ 漏不掉",
    "partition-case": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md` ⇒ 漏不掉",
    "prio-source": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md` ⇒ 漏不掉",
    "queue-legacy": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md` ⇒ 漏不掉",
    "scope": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md`；"
             "「源登记表闭合」在 §四 硬约束里 ⇒ 不另设",
    "sealed": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md`；"
              "「封存只是附加加固」在 §三 不变量里 ⇒ 不另设",
    "single-line": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md` ⇒ 漏不掉",
    "slots": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md`；"
             "「维度闭合」在 §四 硬约束里 ⇒ 不另设",
    "status": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md` ⇒ 漏不掉",
    "text-dangling": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md` ⇒ 漏不掉",
    "void-reuse": "闸型纪律：规则文本随判据清单渲染进 `references/cli.md`；"
                  "「id 永不复用」在 §二 存储里 ⇒ 不另设",
    "check_fix_violations": "闸的形状闸（读面红项出路对账），不对应读者要记住的纪律",
    "constant_leg_violations": "闸的形状闸（恒绿腿扫描），不对应读者要记住的纪律",
    "doc_fact_text_violations": "闸的形状闸（单文档事实闸的调用侧），不对应读者要记住的纪律",
    "exit_nonexistent_commands_violations": "闸的形状闸（出路点名的命令必须真存在），"
                                            "不对应读者要记住的纪律",
    "fact_comment_exempt_violations": "闸的形状闸（注释面豁免形状），不对应读者要记住的纪律",
    "landing_registry_violations": "闸的形状闸（落点登记对账），不对应读者要记住的纪律",
    "export_roundtrip_violations": "闸的形状闸（导出清单必须带库级事实面三段），"
                                   "不对应读者要记住的纪律",
}

# ── v5.65.0：**没有机制承载**的纪律（纪律 id → 理由）────────────────────────
# 为什么需要这张表：纪律是**读者要记住的话**，机制是**机器判的东西**⇒ 二者不
#   一定一一对应（一条纪律可以只管流程面，没有机制承载它）⇒ 但「没有机制承载」
#   这件事**必须显式登记**（否则＝无痕免检口：没人知道它靠什么生效）⇒ 闸判：
#   每条在册纪律**要么**被某个机制声明为守护者，**要么**在这里写明理由。
#   （合并成一张表后，「纪律 → 守护哪些机制」这个方向是**派生**的 ⇒ 孤儿纪律
#   不再隐形 ⇒ 这张表就是它的登记位。当前为空：13 条在册纪律都有承载机制。）
DISCIPLINE_UNWATCHED: dict[str, str] = {
    # 纪律 id → 为什么它没有机制承载（理由非空）
}

# 纪律**住在哪份随件文档**（载体清单，**写在代码里**⇒ 覆盖登记的覆盖面能从代码推导；
# 见 `discipline_present_violations` 的 docstring 里的理由）。
DISCIPLINE_DOCS: tuple[str, ...] = ("references/rules.md",)


def discipline_present_violations(pkg_root: Path) -> list[str]:
    """**纪律必现闸**（唯一源）：本表登记的纪律锚点必须出现在随件文档里。

    **为什么要有这道闸**（t000446）：纪律进了闸却没进文档 ⇒ 改包的人不知道有它 ⇒
    只靠闸兜（闸抓得到，但没人知道为什么）⇒ 纪律**事实上没落地**。
    ⇒ 本闸把「纪律在文档里」变成**可实算的事实**：锚点缺失 ⇒ 红。

    **为什么锚点而不是整句比对**：整句比对＝把纪律正文抄成第二份（漂移的老路）；
    锚点＝纪律的**指纹**（改写纪律必改锚点 ⇒ 同批改本表 ⇒ 漂移有闸）。

    **本闸只判「登记的纪律在文档里」，不判「该有的纪律都登记了」（t000459）**：
    后者要一份「纪律全集」的独立枚举 ⇒ 三条候选枚举口径**逐条判负**：
      ① **文档侧派生**（把随件文档里的纪律句当全集）：「哪些句子算纪律」本身是判断
         （同一份文档里既有纪律句、也有事实句与硬约束）⇒ 机械判不了；若把全集**渲染**进
         清单，清单＝文档的拷贝 ⇒ 闸恒真 ⇒ 无鉴别力。
      ② **机制侧标记**（每个机制声明「我有没有配套纪律」）：人工口径 ⇒ 按本仓的准入
         判据（**写不出有牙的判据就不进门禁**）与 t000436 的先例（两问逐行判读全为否
         ⇒ 恒绿 ⇒ 判负）⇒ 不做。
      ③ **散文扫描**（用模型／模糊匹配从散文里捞纪律句）：不是零误报判据（形态纪律 §6）
         ⇒ 不进门禁。
    ⇒ **残余缺口的确切形状**：**闸型纪律**（判据维的规则文本与契约）完整性**机械可判**——
    它们由渲染块（判据清单／落点登记）带进随件文档 ⇒ 漏不掉；**非闸型纪律**（只写在文档与
    代码注释里的那类）完整性**机器判不了** ⇒ 按 t000436 的先例降为**设计期纪律**：
    新增机制／新增契约时**先答**「它有没有一条要读者记住的纪律」，判「有」就同批登记进
    `DISCIPLINE_PRESENT` 并把锚点抄进随件文档 ⇒ **不为此另建闸**（本仓准入：
    写不出有牙的判据就不进门禁）。
    ⇒ 代价（如实）：完整性机器判不了 ⇒ 靠「新增时有人答」；复发只能靠那条纪律**被看见**
    （它在随件文档里，也在 `DISCIPLINE_PRESENT` 旁——登记它 ⇒ 它的**存在**仍由本闸机械可判）。

    **本闸的射程只有 `DISCIPLINE_DOCS` 里那些文档（t000465）**：纪律登了 ⇒ 它出现在
    `references/rules.md` ✔；但**命令参考**（`references/cli.md`）里那些**命令契约**（行为、
    前提、出路）**不在本闸射程内** ⇒ 「纪律登了、命令参考没跟上」这件事本闸抓不到
    （2026-10-24 多维实测实据：v5.56.0／v5.58.0 的两条契约在 cli.md 里查不到 ⇒ 用户以为
    `unvoid --restore` 必须先作废）⇒ ⇒ 那条同步靠**设计期纪律**「改契约必同批改命令参考」
    （登记在 `DISCIPLINE_PRESENT` ⇒ 它的**存在**由本闸机械可判；它管的**同步**没有闸——
    命令参考这一面没有可机械枚举的全集：要么把契约收进代码＝新登记实体，要么从散文里读
    ＝不是零误报判据）＋多维实测的常设维度兜底。

    **文档清单写在代码里（`DISCIPLINE_DOCS`）而不是表里**：覆盖登记的第 ⑥ 项要判
    「声称面 ＝ 代码真扫面」⇒ 覆盖面必须**能从代码推导**（推导器认 `pkg_root / "X.md"`
    形态的字面量）⇒ 文档清单若在表里（数据），推导器认不出 ⇒ 声称面与实扫面必然对不上。
    ⇒ 纪律**清单**在表里（那是纪律的唯一源），纪律**住在哪份文档**在代码里（那是载体）。
    """
    out: list[str] = []
    for did, anchor in DISCIPLINE_PRESENT.items():
        for rel in DISCIPLINE_DOCS:
            fp = pkg_root / rel
            if not fp.is_file():
                out.append(f"纪律 `{did}` 该在的随件文档不存在：{rel}"
                           "（纪律住在哪份文档由 `DISCIPLINE_DOCS` 定 ⇒ 文档挪位要同批改它）")
                continue
            try:
                text = fp.read_text(encoding="utf-8")
            except OSError as e:
                out.append(f"纪律 `{did}` 该在的随件文档读不了：{rel}（{e}）")
                continue
            if anchor not in text:
                out.append(f"纪律 `{did}` 没写在随件文档里（{rel} 里找不到锚点 {anchor!r}）"
                           "（纪律只进了闸、没进文档 ⇒ 改包的人不知道有它 ⇒ 纪律事实上没落地）")
    return out


def render_doc_facts(text: str) -> str:
    """把渲染区写成代码派生的值（唯一写入口＝`sync-dims`）。"""
    def _sub(m: re.Match) -> str:
        _v = doc_fact_value(m.group(1))
        return m.group(0) if _v is None else f"<!--fact:{m.group(1)}-->{_v}<!--/fact-->"
    return FACT_RE.sub(_sub, text)


# ── 机制面重述点（v5.44.0 · 终极律 L9）────────────────────────────────────────
# **什么是重述点**：某个事实 F 在**第二处**被陈述 ⇒ 那是抄件 ⇒ 抄件会漂 ⇒ 且**漂了没人知道**
# ⇒ 纪律被违反时静默 ⇒ 同一个根因反复复发（族 E／G／H／J 都是它的投影）。
#
# **能进门禁的只有「机制面」**：本技能自己的代码与随件文档里，第二份陈述的**存在点**。
# （用户库里的历史副本＝**存量面**：机器改不了用户的历史，只能保证「不再新增」⇒ 只报不拦。）
#
# **两类机制面重述点（都可实算，判据唯一源＝本块）**：
#   ① **判据读副本**：判据面拿散文/台账当**输入**的那一处（拿死的载体判活的事实）。
#      ⇒ 新增一处**必须显式标记**（源码里写下面那个标记）⇒ 标记数＝实算数
#      ⇒ 复发成本前置到「加机制那一刻」：不标记就抓不到，标记了就要进豁免名单。
#   ② **文档枚举事实未渲染**：随件文档里枚举工具事实（槽清单／id 形态／status 闭集…）却没被
#      渲染 ⇒ **复用** v5.43.0 的漂移闸（`doc_fact_violations`）⇒ 不抄第二份判据。
#
# **豁免名单**：每条写明**死因**与**死期条件**（机械可判）⇒ 死期到了还在豁免 ⇒ 闸红
# ⇒ 到期必须处理（不是「有空再说」）。⇒ 名单与实算**双向对账**：多出来＝新增重述点（红）；
# 豁免过期＝该治了（红）。
REWRITE_MARKER = "重述点机制面" + "A"   # 判据读副本的分支标记（**拼出来**⇒ 说明块里不撞车）
REWRITE_EXEMPT: list[dict] = [
    {
        "cls": "legacy_scan",
        "count": 1,
        "why": "老班段兼容：v5.31.0 之前写的班段没有 `covers` 字段 ⇒ 判据退回旧口径扫散文"
               "（逐字不变 ⇒ 迁移不误伤）",
        "dead": "判据面里这个分支被删掉（兼容期结束）⇒ 同批删掉本条豁免",
        "dead_when": "marker_gone",
    },
]


# ── v5.51.0（C 批 N1）：**注释面**的豁免名单（逐条登记死因与死期）────────────
# **为什么要有这张表**：注释面进闸后，注释里**讲历史**的那些句子会命中形态（它们引的是
# 漂移前的旧值／旧上限，属**证据**不是现态事实）⇒ 但它们**不能一删了事**（那会把事故记录
# 一起删掉）⇒ 只能**显式豁免**并写明**死因**与**死期条件**。
#
# **每条按 (形态, 原文锚) 定位**（不是按行号、也不是按类计数）——
#   · **不用行号**：行号随任何一次编辑就漂 ⇒ 豁免表会被自己的编辑打散（实测踩过：
#     改几行说明文字，6 条豁免的「行」全错位 ⇒ 表直接失去意义）。
#   · **不用类计数**：注释面的每处形态都是**不同的**那句话，按类聚合会把「为什么豁免」
#     糊成一条 ⇒ 死因就查不出来了。
#   · **用原文锚**：锚是那行注释里**唯一的一段字**（形态所在句的片段）⇒ 编辑不挪位置，
#     改写则锚失配 ⇒ 闸逼着重新裁定（这正是「死期」要的语义）。
#
# **死期条件（dead_when）**：机械可判的闭集 ⇒ 死期到了还在豁免 ⇒ 闸红（到期必须处理）。
#   · `gone`  ：该锚在注释面里**找不到了**（被改写或删掉）⇒ 豁免过期 ⇒ 红（同批删掉本条）
#   · `kept`  ：该锚仍在，但**形态不再命中**（那句话被改写得不带形态了）⇒ 豁免过期 ⇒ 红
FACT_COMMENT_EXEMPT: list[dict] = [
    {
        "form": "t/p/q/u", "anchor": "判据文本里的",
        "why": "历史叙述：讲 v5.47.0 那次「文案抄了一份、改一处漏一处（实测已漂）」的旧值引文"
               "——引的是**漂移前**的值，属证据不是现态",
        "dead": "该处不再引旧值（改写或删掉）⇒ 同批删掉本条豁免",
        "dead_when": "gone",
    },
    {
        "form": "owner｜user｜external:<描述>", "anchor": "文案抄了一份、改一处漏一处（实测已漂：正文里",
        "why": "历史叙述：同上一条，讲「文案抄了一份」的旧值引文（waitingFor 值域的旧写法）",
        "dead": "该处不再引旧值 ⇒ 同批删掉本条豁免",
        "dead_when": "gone",
    },
    {
        "form": "120 字", "anchor": "同一形状在 close 上是第二条",
        "why": "历史叙述：讲 v5.12.1 那个洞（from-file 绕过长度闸）时**当时**的 SKILL.md 口径引文"
               "（上限值本身归 `SUMMARY_CAP`，此处只引旧口径）",
        "dead": "该处不再引旧口径 ⇒ 同批删掉本条豁免",
        "dead_when": "gone",
    },
    {
        "form": "400 字", "anchor": "起因是**我自己踩出来的**",
        "why": "历史叙述：d000113 事件叙述「本会话写了 400 字的 summary」——写的是**历史动作**，"
               "不是现态上限（现态上限归 `SUMMARY_CAP`）",
        "dead": "该处不再引那次事件 ⇒ 同批删掉本条豁免",
        "dead_when": "gone",
    },
    {
        "form": "120 字", "anchor": "畅通无阻；而 SKILL.md 明写",
        "why": "历史叙述：同上条，同段内**当时**口径的引文",
        "dead": "该处不再引旧口径 ⇒ 同批删掉本条豁免",
        "dead_when": "gone",
    },
    {
        "form": "120 字", "anchor": "tab/换行能进账",
        "why": "历史叙述：v5.22.1 事后补丁叙述（「此前只有 single-line 维」）里引的**当时**预算口径",
        "dead": "该处不再引旧口径 ⇒ 同批删掉本条豁免",
        "dead_when": "gone",
    },
]


def _fact_comment_hits(src: str) -> list[tuple[int, str, str, str]]:
    """**注释面**的形态命中实算（唯一源）⇒ (行号, 事实名, 形态, 注释原文)。

    **为什么注释面要单独算**：AST 里**没有注释节点** ⇒ 注释对 `ast.walk` 完全不可见 ⇒
    事实存在性闸的代码面**天然扫不到注释**（这正是 v5.48.0 那处假称的病根）。
    ⇒ 注释面必须用 `tokenize` 单独扫 ⇒ 且**豁免表**也只对注释面生效。
    """
    import io as _io_fc
    import tokenize as _tok_fc
    out: list[tuple[int, str, str, str]] = []
    try:
        toks = list(_tok_fc.generate_tokens(_io_fc.StringIO(src).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError) as e:
        return [(0, "?", "?", f"源码词法解析失败：{e}")]
    for t in toks:
        if t.type != _tok_fc.COMMENT:
            continue
        txt = t.string.lstrip("#").strip()
        for fact, form in _fact_variants():
            if _fact_form_at(txt, form) >= 0:
                out.append((t.start[0], fact, form, txt))
                # ⚠ **不 break**：一条注释里可能同时抄了**多个**形态 ⇒ 只记第一个
                #   ⇒ 另一个抄件被静默放过（漏报）⇒ 实测踩过这个形态。
    return out


def _fact_exempt_match(form: str, txt: str) -> bool:
    """这条命中是否落在某条豁免里（**按原文锚**判定，不按行号）。

    锚＝那行注释里的一段字（形态所在句的片段）⇒ 编辑不挪位置；改写则锚失配 ⇒ 豁免过期。
    """
    return any(str(e.get("form")) == form and str(e.get("anchor", "")) in txt
               for e in FACT_COMMENT_EXEMPT)


def fact_comment_exempt_violations(src: str) -> list[str]:
    """**注释面豁免表**的双向对账闸（唯一源）——空＝对得上。

    ① **多出来**（实算有命中、豁免表没有）⇒ 新增注释抄件 ⇒ 红（要么归位、要么登记豁免）。
    ② **豁免过期**（豁免表那条的锚在注释面里找不到了）⇒ 红（必须同批删掉本条豁免）。
    ③ **豁免形状**：每条必须有 form／anchor／why／dead／dead_when ⇒ 缺项红
       （豁免必须写明死因与死期）。
    """
    out: list[str] = []
    hits = _fact_comment_hits(src)
    hit_keys: set[tuple[str, str]] = set()
    for line, fact, form, txt in hits:
        if _fact_exempt_match(form, txt):
            hit_keys.add((form, str(next((str(e.get("anchor")) for e in FACT_COMMENT_EXEMPT
                                          if str(e.get("form")) == form
                                          and str(e.get("anchor", "")) in txt), ""))))
            continue
        out.append(f"注释面 L{line} 有事实形态『{form}』（{fact}）但**不在豁免表里**"
                   "（新增注释抄件 ⇒ 归位或登记豁免）")
    all_txt = "\n".join(t for _l, _f, _fm, t in hits) + "\n" + "\n".join(
        t.string.lstrip("#").strip() for t in _all_comments(src))
    for e in FACT_COMMENT_EXEMPT:
        for f in ("form", "anchor", "why", "dead", "dead_when"):
            if e.get(f) in (None, ""):
                out.append(f"注释面豁免（锚 {e.get('anchor')!r}）缺 `{f}`"
                           "（豁免必须写明死因与死期）")
        anchor = str(e.get("anchor", ""))
        dw = str(e.get("dead_when", ""))
        if dw not in ("gone", "kept"):
            out.append(f"注释面豁免（锚 {anchor!r}）的 `dead_when` 取值 {dw!r} 不在闭集里"
                       "（合法取值：`gone`／`kept`）")
            continue
        if not anchor:
            continue
        if dw == "gone":
            # `gone`：该处被改写／删掉 ⇒ 豁免过期 ⇒ 必须同批删掉本条
            if anchor not in all_txt:
                out.append(f"注释面豁免（锚 {anchor!r}，形态『{e.get('form')}』）**已过期**："
                           "该处已不存在 ⇒ 同批删掉本条豁免")
        else:
            # `kept`：该处**仍在**，但那句已不再命中该形态 ⇒ 豁免也过期
            # （有人把那句历史改成了不带形态的写法 ⇒ 豁免的依据消失 ⇒ 重新裁定）
            if anchor in all_txt and not any(
                    str(e.get("form")) == form and anchor in txt
                    for _l, _f, form, txt in hits):
                out.append(f"注释面豁免（锚 {anchor!r}，形态『{e.get('form')}』）**已过期**："
                           "该处仍在但不再命中该形态 ⇒ 重新裁定（归位或改写豁免）")
    return out


def _all_comments(src: str) -> list:
    """全部注释 token（豁免锚查找用：锚可能在**没命中形态**的那行上）。"""
    import io as _io_fc2
    import tokenize as _tok_fc2
    try:
        return [t for t in _tok_fc2.generate_tokens(_io_fc2.StringIO(src).readline)
                if t.type == _tok_fc2.COMMENT]
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return []


def rewrite_point_counts(pkg_root: Path) -> dict[str, int]:
    """机制面重述点的**实算**（唯一源＝本块）。

    ① `legacy_scan`＝源码里那个标记的出现次数（每个「判据读副本」的分支一个标记）。
    ② `doc_facts` ＝文档面漂移闸的违例数（**复用** `doc_fact_violations`，不另立判据）。
    """
    import ast as _ast_rw
    src = Path(__file__).read_text(encoding="utf-8")
    counts = {"legacy_scan": src.count(REWRITE_MARKER),
              "doc_facts": len(doc_fact_violations(pkg_root))}
    return counts


def rewrite_exempt_violations() -> list[str]:
    """豁免名单自身的**形状闸**：每条必须写明**死因**与**死期条件**。

    为什么形状也要判：豁免是「先欠着、到期必须还」⇒ 欠账必须写清**什么时候还**，
    否则它就是永久豁免 ⇒ 复发机制照旧。
    """
    out: list[str] = []
    for e in REWRITE_EXEMPT:
        cls = str(e.get("cls", "?"))
        for f in ("cls", "count", "why", "dead", "dead_when"):
            if f not in e or e.get(f) in (None, ""):
                out.append(f"豁免 `{cls}` 缺 `{f}`（豁免必须写明死因与死期条件）")
    return out


def rewrite_gate_violations(pkg_root: Path) -> list[str]:
    """重述点闸（机制面）：**双向对账**——实算与豁免名单必须**不多不少**地对上。

    ① 实算 > 豁免 ⇒ 新增了重述点（红：必须消掉，或同批写进豁免名单并写明死期）。
    ② 实算 < 豁免 ⇒ 豁免**过期**了（红：那个机制已经没了 ⇒ 这条豁免该删）。
    ③ 豁免里的类名不在实算表里 ⇒ 豁免指向了不存在的东西（红）。
    """
    counts = rewrite_point_counts(pkg_root)
    exempt = {str(e.get("cls")): e for e in REWRITE_EXEMPT}
    out: list[str] = []
    for cls, n in counts.items():
        e = exempt.get(cls)
        base = int(e.get("count", 0)) if e else 0
        if n > base:
            out.append(f"机制面重述点 `{cls}` 实算 {n} 处 > 豁免基线 {base}"
                       "（新增重述点：消掉它，或同批把豁免基线调高并写明死期）")
        elif e and n < base:
            out.append(f"机制面重述点 `{cls}` 实算 {n} 处 < 豁免基线 {base}"
                       f"（豁免**过期**了：{e.get('dead', '死期已到')} ⇒ 同批删掉这条豁免）")
    for cls, e in exempt.items():
        if cls not in counts:
            out.append(f"豁免 `{cls}` 指向的类不在实算表里（豁免自身漂了）")
    out += rewrite_exempt_violations()
    return out


# ── v5.49.0（B 批）机制覆盖登记（唯一源）────────────────────────────────────
# **元纪律**：机制「说自己扫了什么」不算数 ⇒ 登记 ＋ 对账。
# 依据：本技能的**审计记录**（仓内 `audits/` 下，**不随件分发**）里
#   「最佳方案路径·定案」一节的 §四（族 E 治本路径）＋「治本路径·独立复核」一节。
#
# **三个概念**：
# · **面**＝事实可能藏身的**载体位置**：`prose:<路径>`（散文面）｜
#   `code-str:<路径>`（源码里 AST 看得见的字符串面）｜
#   `code-cmt:<路径>`（源码里的注释面 —— AST **看不见**，须 tokenize 才看得见）。
#   面全集由**枚举器**派生（`_surface_faces`），不是手写清单 ⇒ 新增一个随件 md 立刻进全集。
# · **族**＝共享同一**检测对象**的一组机制；覆盖闭合按族判（族「事实存在性」＝查事实
#   渲染形态 ⇒ 散文面与源码两面都得有人管）。
# · **结构面机制**＝只读源码**结构**（不查载体内容）的闸：它们的「面」不可枚举成载体，
#   故入 `MECHANISM_STRUCTURE`（登记理由与执行面），不入覆盖闭合。
#
# **面 id 词表是同一套字符串字面量源**：登记表与扫描侧共用，不许各自写字面量
# （手写两份就是第二份源，抄错时无人发现 —— 这正是族 E 的老路）。
SURFACE_PROSE = "prose"
SURFACE_CODE_STR = "code-str"
SURFACE_CODE_CMT = "code-cmt"

# 载体后缀 → 面种类（**枚举器口径**：随件文档与本包源码；shell 迁移脚本不承载事实
# 形态登记 ⇒ 边界，在 `MECHANISM_STRUCTURE` 里说明）。
_SURFACE_SUFFIX_FACES = {
    ".md": (SURFACE_PROSE,),
    ".py": (SURFACE_CODE_STR, SURFACE_CODE_CMT),
}

# 「不管面」归属值里**永久豁免**的前缀（唯一源＝本常量；登记表与判据共用同一串
# ⇒ 不许两处各写字面量（抄错时无人发现 —— 那是族 E 的老路））。
EXEMPT_PREFIX = "豁免:"

# ── 机制覆盖登记（唯一源）────────────────────────────────────────────────
# **族「事实存在性」**（载体面机制）：覆盖闭合按族判 ⇒ 每个面要么被某机制扫，
# 要么被**显式**登记成「不管面」并写明归属与理由。
#
# **「不管面」的两类归属值**（v5.54.0 起；「待建」形态已废）：
#   · `豁免:<理由>` ⇒ **永久豁免**：这个面**设计上就不该被扫**（例：审计记录
#     `DESCRIPTION-AUDIT.md`——自带日期、讲的是「当时」⇒ 整份文件是**历史面**⇒
#     那里的事实陈述不是现态抄件；且它不随件发布 ⇒ 不是用户可见面）。
#     **理由必须非空**（空 ⇒ 当场红）⇒ 否则「豁免」会退化成无痕免检口。
#   · `<真机制名>` ⇒ 归属方必须是**登记表里存在的真机制**，且它**声明覆盖该面**
#     （见下面的 ④ 与 ⑥ 两项检查）⇒ 归属不真实 ⇒ 当场红。
#   ⚠ **「待建:<机制>」形态已废**（v5.54.0）：它承诺「落地版本到期未落 ⇒ 闸红」，
#     但**代码里从没实现过那条期限检查** ⇒ 「待建」实际是**无期限的免检口**
#     （挂上去的面被算成「已覆盖」，而没人真扫它）⇒ 本仓唯一的待建条目
#     （`待建:pkg_doc_closure`）就是这么把 `prose:DESCRIPTION-AUDIT.md`
#     藏了好几个版本的 ⇒ 该形态**删掉**：面要么被真机制真扫（⑥ 强制「声称覆盖＝真扫」），
#     要么带理由永久豁免（无痕免检口没有立足点）。
MECHANISM_COVERAGE: dict[str, dict] = {
    "fact_copy_violations": {
        "落点": ("scripts/handoff.py", "def fact_copy_violations("),
        "族": "事实存在性",
        # v5.51.0：注释面（`code-cmt`）**真被扫了**（`tokenize` 面；v5.49.0 时还是「待建」）
        "覆盖面": ("prose:references/*.md", "prose:SKILL.md",
                   "code-str:scripts/handoff.py", "code-cmt:scripts/handoff.py"),
        "实扫面": ("prose:references/*.md", "prose:SKILL.md",
                   "code-str:scripts/handoff.py", "code-cmt:scripts/handoff.py"),
        "不管面": {
            # v5.54.0（t000456）：这个面**永久豁免**，不是「欠着一笔等某机制来扫」。
            # 依据＝**历史面载体**：审计记录自带日期、讲的是「当时」⇒ 整份文件讲的是
            # 「那次审计当时的事实」，不是现态事实陈述 ⇒ 它里那处**写面上限**的重述
            # 是**历史审计事实**，不是现态抄件 ⇒ 不判。
            # （旧形把它当成待归位的抄件 ⇒ 逼人改审计证据；改审计证据要重跑外派审计。）
            "prose:DESCRIPTION-AUDIT.md": "豁免:历史面载体（审计记录·自带日期·讲的是「当时」"
                                         "·不随件发布⇒不是用户可见面）",
        },
        "执行面": ("scripts/handoff.py", "cmd_selftest"),
    },
    # v5.52.0：机制面**纪律必现**闸（判据面：纪律必须写在随件文档里）
    "discipline_present_violations": {
        "落点": ("scripts/handoff.py", "def discipline_present_violations("),
        "族": "机制面纪律",
        "覆盖面": ("prose:references/rules.md",),
        "实扫面": ("prose:references/rules.md",),
        "不管面": {},
        "执行面": ("scripts/handoff.py", "cmd_selftest"),
    },
}

# 结构面机制（只读源码**结构**，不查载体内容）⇒ 不入覆盖闭合；登记落点与理由。
# 理由不是「免责声明」，是**判据**：这些闸的判据输入是源码结构节点（调用点／断言／
# 登记表行），不是载体内容 ⇒ 它们没有「载体面」可言。
MECHANISM_STRUCTURE: dict[str, tuple[str, tuple[str, str]]] = {
    "check_fix_violations": ("读面出路闸：判据读源码结构（红项站点），不查载体内容",
                              ("scripts/handoff.py", "cmd_selftest")),
    "cli_verb_source_violations": ("子命令表单一源闸：判据读源码结构（模块级赋值 ＋ 两份表的集合差），"
                                   "不查载体内容", ("scripts/handoff.py", "cmd_selftest")),
    "discipline_completeness_violations": ("纪律完整性闸：判据读登记表自身（机制全集 − 已声明集合 ＋ 理由非空），"
                                           "不查载体内容", ("scripts/handoff.py", "cmd_selftest")),
    "export_roundtrip_violations": ("导出往返闸：判据读导出清单的形状（三段齐 ＋ schema≥2），不查载体内容",
                                    ("scripts/handoff.py", "cmd_selftest")),
    "constant_leg_violations": ("恒绿腿闸：判据读源码结构（断言节点），不查载体内容",
                                ("scripts/handoff.py", "cmd_selftest")),
    "doc_fact_text_violations": ("单文档事实闸：随文档面事实闸调用的单文件版",
                                 ("scripts/handoff.py", "cmd_selftest")),
    "doc_fact_violations": ("文档面事实闸：只对渲染区与代码派生值做一致性，不查形态抄件",
                             ("scripts/handoff.py", "cmd_selftest")),
    "exit_key_violations": ("出路键闸：判据读源码结构（die 站点），不查载体内容",
                             ("scripts/handoff.py", "cmd_selftest")),
    "exit_nonexistent_commands_violations": ("出路命令闸：判据读出路表（命令名须真在 parser 树里），"
                                             "不查载体内容", ("scripts/handoff.py", "cmd_selftest")),
    "fact_comment_exempt_violations": ("注释面豁免闸：判据读登记表自身（豁免表与实算双向对账），"
                                       "不查载体内容", ("scripts/handoff.py", "cmd_selftest")),
    "id_provenance_violations": ("出处台账闸：判据读登记台账（在册 id 都要有分配记录），不查载体内容",
                                 ("scripts/handoff.py", "cmd_selftest")),
    "landing_registry_violations": ("落点登记闸：判据读源码结构与登记表行，不查载体内容",
                                    ("scripts/handoff.py", "cmd_selftest")),
    "mechanism_coverage_violations": ("本闸：判据读源码结构与登记表，不查载体内容",
                                      ("scripts/handoff.py", "cmd_selftest")),
    "rewrite_exempt_violations": ("豁免形状闸：判据读登记表自身，不查载体内容",
                                  ("scripts/handoff.py", "cmd_selftest")),
    "rewrite_gate_violations": ("重述点闸：只对重述点计数与豁免对账，不查形态抄件",
                                ("scripts/handoff.py", "cmd_selftest")),
}


def _surface_faces(pkg_root: Path) -> dict[str, str]:
    """**面全集**（枚举器派生，不是手写清单）：包内每个载体按其可读方式展开成面。

    返回 {面 id: 载体相对路径}；面 id 形如 `prose:SKILL.md`。
    ⇒ 新增一个随件 md 立刻进全集 ⇒ 没人管它 ⇒ 对账闸当场红（Q7.6 的「第 N+1 个随件 md」）。
    """
    out: dict[str, str] = {}
    for p in sorted(pkg_root.rglob("*")):
        if not p.is_file() or "__pycache__" in p.parts:
            continue
        kinds = _SURFACE_SUFFIX_FACES.get(p.suffix)
        if not kinds:
            continue
        rel = p.relative_to(pkg_root).as_posix()
        for k in kinds:
            out[f"{k}:{rel}"] = rel
    return out


def _mc_expand(patterns, faces: dict[str, str]) -> set[str]:
    """把覆盖面声明（面 id 模式）展开成具体面 id 集合（模式 ⇒ 实例）。"""
    return {f for f in faces for pat in patterns if fnmatch.fnmatchcase(f, pat)}


def _mc_top_funcs(tree) -> dict[str, object]:
    """模块级函数表（面推导的输入）。"""
    import ast as _ast_mc
    return {n.name: n for n in tree.body if isinstance(n, _ast_mc.FunctionDef)}


def _mc_closure(funcs: dict[str, object], name: str) -> set[str]:
    """某函数的**调用闭包**（包内模块级函数）：判定它实际读了哪些载体。"""
    import ast as _ast_mc
    seen: set[str] = set()
    stack = [name]
    while stack:
        cur = stack.pop()
        if cur in seen or cur not in funcs:
            continue
        seen.add(cur)
        node = funcs[cur]
        for n in _ast_mc.walk(node):
            if isinstance(n, _ast_mc.Call) and isinstance(n.func, _ast_mc.Name) and n.func.id in funcs:
                stack.append(n.func.id)
    return seen


def _mc_derive_faces(src: str, mech: str, carrier: str, faces: dict[str, str]) -> set[str]:
    """**实扫面**（由代码推导，不是手写登记）：该机制调用闭包里的扫描手段决定。

    判据（封闭枚举，逐条可判）：
      · 读到 .md 载体（glob／路径字面量／read_text）⇒ `prose` 面
      · `_ast_mc.parse`／`_ast_mc.walk` ⇒ `code-str` 面（AST 看得见的字符串）
      · `tokenize` ⇒ `code-cmt` 面（注释）
      · 整读 .py 全文（read_text／open）⇒ `code-str` ＋ `code-cmt` 两面都看得见

    `carrier`＝该机制所在文件（源码面扫的就是它自己的文件）。
    """
    import ast as _ast_mc
    tree = _ast_mc.parse(src)
    funcs = _mc_top_funcs(tree)
    closure = _mc_closure(funcs, mech)
    prose_pats: set[str] = set()
    code_str = False
    code_cmt = False
    # 模块级**元组常量**里的字符串路径（载体清单走这条路，如 `DISCIPLINE_DOCS`）⇒ 散文面。
    # 为什么需要它：纪律**清单**是数据（在表里），但纪律**住在哪份文档**是载体（写在代码里）
    # ⇒ 覆盖登记的覆盖面才能从代码推导出来（否则「声称面 ＝ 实扫面」必然对不上）。
    _module_tuple_paths: dict[str, tuple[str, ...]] = {}
    for _stmt in tree.body:
        # `X = (...)` 与 `X: T = (...)` 两种写法都要认（带注解的那种更常见）
        if isinstance(_stmt, _ast_mc.Assign):
            if len(_stmt.targets) != 1:
                continue
            _tgt, _val = _stmt.targets[0], _stmt.value
        elif isinstance(_stmt, _ast_mc.AnnAssign):
            _tgt, _val = _stmt.target, _stmt.value
        else:
            continue
        if not isinstance(_tgt, _ast_mc.Name):
            continue
        if not (isinstance(_val, _ast_mc.Tuple) or
                isinstance(_val, (_ast_mc.List, _ast_mc.Set))):
            continue
        _vals = tuple(e.value for e in _val.elts
                      if isinstance(e, _ast_mc.Constant) and isinstance(e.value, str))
        if _vals:
            _module_tuple_paths[_tgt.id] = _vals
    # 本文件按惯例局部别名导入 ast／tokenize ⇒ 别名集合**从代码实算**（不硬编）
    ast_aliases: set[str] = set()
    tok_aliases: set[str] = set()
    for n in _ast_mc.walk(tree):
        if isinstance(n, _ast_mc.Import):
            for al in n.names:
                if al.name == "ast":
                    ast_aliases.add(al.asname or al.name)
                elif al.name == "tokenize":
                    tok_aliases.add(al.asname or al.name)
    for fname in closure:
        for n in _ast_mc.walk(funcs[fname]):
            # 模块级**元组常量**里的 .md 路径（纪律清单的载体清单走这条路：
            # `DISCIPLINE_DOCS = ("references/rules.md",)`）⇒ 散文面
            if isinstance(n, _ast_mc.Name):
                _tv = _module_tuple_paths.get(n.id)
                if _tv:
                    prose_pats.update(f"{SURFACE_PROSE}:{p}" for p in _tv if p.endswith(".md"))
            # glob／rglob 的字面量参数 ⇒ 散文面
            if isinstance(n, _ast_mc.Call) and isinstance(n.func, _ast_mc.Attribute) \
                    and n.func.attr in ("glob", "rglob") and n.args \
                    and isinstance(n.args[0], _ast_mc.Constant) and isinstance(n.args[0].value, str):
                if n.args[0].value.endswith(".md"):
                    prose_pats.add(f"{SURFACE_PROSE}:{n.args[0].value}")
            # pkg_root / "X.md" ⇒ 散文面
            if isinstance(n, _ast_mc.BinOp) and isinstance(n.op, _ast_mc.Div) \
                    and isinstance(n.right, _ast_mc.Constant) and isinstance(n.right.value, str) \
                    and n.right.value.endswith(".md"):
                prose_pats.add(f"{SURFACE_PROSE}:{n.right.value}")
            # read_text("X.md") ⇒ 散文面；read_text("X.py")／open ⇒ 源码两面都看得见
            if isinstance(n, _ast_mc.Call) and isinstance(n.func, _ast_mc.Attribute) \
                    and n.func.attr in ("read_text", "open") and n.args \
                    and isinstance(n.args[0], _ast_mc.Constant) and isinstance(n.args[0].value, str):
                tgt = n.args[0].value
                if tgt.endswith(".md"):
                    prose_pats.add(f"{SURFACE_PROSE}:{tgt}")
                elif tgt.endswith(".py"):
                    code_str = True
                    code_cmt = True
            # ast.parse／ast.walk ⇒ AST 看得见的字符串面（**认本地别名**：
            # 本文件按惯例 `import ast as _ast_xxx` ⇒ 只认 `ast` 会漏判）
            if isinstance(n, _ast_mc.Call) and isinstance(n.func, _ast_mc.Attribute) \
                    and n.func.attr in ("parse", "walk"):
                base = n.func.value
                bid = base.id if isinstance(base, _ast_mc.Name) else (
                    base.attr if isinstance(base, _ast_mc.Attribute) else "")
                if bid in ast_aliases:
                    code_str = True
            # tokenize ⇒ 注释面（认别名）
            if isinstance(n, _ast_mc.Call) and isinstance(n.func, _ast_mc.Attribute) \
                    and isinstance(n.func.value, _ast_mc.Name) \
                    and n.func.value.id in tok_aliases:
                code_cmt = True
            if isinstance(n, _ast_mc.Name) and n.id in tok_aliases:
                code_cmt = True
    out = _mc_expand(prose_pats, faces)
    if code_str:
        out.add(f"{SURFACE_CODE_STR}:{carrier}")
    if code_cmt:
        out.add(f"{SURFACE_CODE_CMT}:{carrier}")
    return out


def mechanism_coverage_violations(src: str, pkg_root: Path) -> list[str]:
    """**机制覆盖登记的对账闸**（v5.49.0 · B 批 · 唯一源）。

    治的是**元根因**（族 E）：「机制只覆盖它自己那一片，漏掉的那一片没人管」＋
    「机制宣称覆盖却没覆盖」＋「机制造好却不跑」三族复发。

    **七项**（全机械，落盘证据 ⇒ 零误报）：
    ① **覆盖闭合**：面全集（`_surface_faces` 枚举器派生）－ 各机制覆盖面 － 各机制
       「不管面」＝∅ ⇒ **有一个面没人管** ⇒ 红。
    ② **声明可达**：登记里的机制名在代码里真存在（AST 找 FunctionDef）⇒ 假机制名红。
    ③ **落点可达**：登记的落点文件在包内存在、锚点逐字出现 ⇒ 假落点红。
    ④ **归属真实**：「不管面」的归属值要么是**永久豁免**（`豁免:` 前缀，**理由非空**
       ——空理由＝无痕免检口 ⇒ 红），要么是**真机制**（真存在且真声明该面）⇒ 假归属红。
       （v5.54.0：**「待建」欠账形态已废**——它承诺「到期未落 ⇒ 闸红」而代码里从没实现
       ⇒ 挂上去的面既没人扫又永远绿 ⇒ 现在它落到「假归属」红。）
    ⑤ **执行面在跑**：该机制真被某个自动面调用 ⇒ 「造好却不跑」红。
    ⑥ **声称面 ↔ 实扫面**：登记的「覆盖面」必须与**代码实际扫的面**（`_mc_derive_faces`
       由 AST 推导，不看 docstring）一致 ⇒ **宣称覆盖却没覆盖**红。
       （独立席 Q2：**不许拿 docstring 当实扫面的证据** —— v5.48.0 当代那处
       「声称面 E 含注释、实扫只扫 AST 字符串」的病，正是本项要抓的。）
    ⑦ **落点登记闭合**（v5.65.0 · t000469）：**被消费的闸都必须登记**——闸的集合从
       **代码派生**（调用点 ∩ 命名约定）⇒ 被消费却没登记 ⇒ 它没有落点也没有执行面 ⇒
       覆盖率与执行面的判据对它一律无效（v5.63.0 实测有三个这样的闸）。

    **为什么实扫面由 AST 推导而不是读 docstring**：docstring 是散文，会漂；
    而「这个闸真读了哪些载体」在代码里是**可判的事实**（读了哪个 glob／哪个 ast／
    哪个 tokenize）⇒ 判据输入必须是落盘证据。
    """
    out: list[str] = []
    import ast as _ast_mc
    faces = _surface_faces(pkg_root)
    if not faces:
        out.append("面全集为空（枚举器没扫到任何载体）⇒ 判据输入不可信（报红，不沉默）")
        return out
    try:
        tree = _ast_mc.parse(src)
    except SyntaxError as e:
        return [f"源码解析失败：{e}"]
    funcs = _mc_top_funcs(tree)

    # ── ② 声明可达（先做：后面的项要用它筛真机制）──
    real: set[str] = set()
    for name in list(MECHANISM_COVERAGE) + list(MECHANISM_STRUCTURE):
        if name not in funcs:
            out.append(f"机制 `{name}` 在代码里不存在（登记指向了不存在的机制）")
        else:
            real.add(name)

    # ── ⑦ 落点登记闭合（v5.65.0 · t000469 · F-B）：**被消费的闸都必须��册** ──
    #   机制全集的「闸」那一半是从**代码派生**的（`consumed_gates()`：调用点 ∩ 命名
    #   约定）⇒ 若某个闸被消费却**没登记**落点/执行面 ⇒ 它既没有落点也没有执行面 ⇒
    #   覆盖率与执行面的判据对它一律无效（v5.63.0 实测就有三个这样的闸：出路命令闸／
    #   注释面豁免闸／出处台账闸）。
    _consumed = set(consumed_gates(src))
    _unregistered = sorted(_consumed - (set(MECHANISM_COVERAGE) | set(MECHANISM_STRUCTURE)))
    if _unregistered:
        out.append(f"**{len(_unregistered)} 个被消费的闸没在落点登记里**"
                   "（它们没有落点也没有执行面 ⇒ 覆盖率与执行面的判据对它们无效）："
                   f"{_unregistered[:6]}（加进 `MECHANISM_STRUCTURE` 或 `MECHANISM_COVERAGE`）")

    # ── ① 覆盖闭合 ──
    covered: set[str] = set()
    unmanaged: dict[str, str] = {}
    for name, row in MECHANISM_COVERAGE.items():
        if name not in real:
            continue
        covered |= _mc_expand(row.get("覆盖面", ()), faces)
        for face, owner in (row.get("不管面") or {}).items():
            unmanaged[face] = owner
    for face in sorted(faces):
        if face in covered or face in unmanaged:
            continue
        out.append(f"面 `{face}` 没人管（既没被任何机制声明覆盖，也没被登记为「不管面」）"
                   "（漏掉的那一片没人管 ⇒ 机制覆盖登记失效）")
    # 「不管面」里的面必须**真在面全集里**（登记指向了不存在的面 ⇒ 假登记）
    for face in sorted(unmanaged):
        if face not in faces:
            out.append(f"「不管面」登记了面全集里没有的面 `{face}`（登记漂移了）")

    # ── ③ 落点可达 ──
    for name, row in MECHANISM_COVERAGE.items():
        if name not in real:
            continue
        f, anchor = row["落点"]
        fp = pkg_root / f
        if not fp.is_file():
            out.append(f"机制 `{name}` 的落点文件不存在：{f}")
        elif anchor not in fp.read_text(encoding="utf-8", errors="replace"):
            out.append(f"机制 `{name}` 的落点锚点在 {f} 里找不到：{anchor!r}"
                       "（落点漂移了 ⇒ 改登记或改实现，二者必须同步）")

    # ── ④ 归属真实 ──
    # **两类归属值**（v5.54.0）：`豁免:<理由>`＝永久豁免（理由必须非空）；
    # 其余＝归属方名，必须是登记表里**存在的真机制**且**声明覆盖该面**。
    # ⚠ **「待建:<机制>」不再是合法归属值**（v5.54.0 废止）：它承诺的「到期未落 ⇒ 闸红」
    # 从没实现 ⇒ 挂上去的面既没人扫、又永远绿 ⇒ 无期限免检口 ⇒ 现在它落到「假归属」红。
    for name, row in MECHANISM_COVERAGE.items():
        if name not in real:
            continue
        for face, owner in (row.get("不管面") or {}).items():
            if isinstance(owner, str) and owner.startswith(EXEMPT_PREFIX):
                if not owner[len(EXEMPT_PREFIX):].strip():
                    out.append(f"面 `{face}` 登记成**永久豁免**却没写理由"
                               "（豁免必须写明为什么这个面不该被扫 ⇒ 空理由＝无痕免检口）")
                continue
            owner_row = MECHANISM_COVERAGE.get(owner)
            if owner_row is None:
                out.append(f"面 `{face}` 的归属方 `{owner}` 不存在（假归属）")
                continue
            if face not in _mc_expand(owner_row.get("覆盖面", ()), faces):
                out.append(f"面 `{face}` 的归属方 `{owner}` 并未声明覆盖该面"
                           "（归属不真实 ⇒ 这一片仍然没人管）")

    # ── ⑤ 执行面在跑 ──
    # **判据＝AST 调用闭包，不是字面量出现**：字面量在**定义处**也会命中 ⇒
    # 「定义了但从不被调用」的字面量判据恒绿 ⇒ 抓不住探针⑤那族病（造好却不跑）。
    # ⇒ 判据：该机制 ∈ 执行面函数的**调用闭包**（含传递调用）。
    for name in sorted(real):
        row = MECHANISM_COVERAGE.get(name)
        if row is None:
            row = {"执行面": MECHANISM_STRUCTURE[name][1]}
        f, entry = row["执行面"]
        if not (pkg_root / f).is_file():
            out.append(f"机制 `{name}` 的执行面文件不存在：{f}")
            continue
        if entry not in funcs:
            out.append(f"机制 `{name}` 的执行面入口 `{entry}` 在 {f} 里不存在"
                       "（执行面登记漂移了 ⇒ 机制不在任何自动面里 ⇒ 造好却不跑）")
            continue
        if name not in _mc_closure(funcs, entry):
            out.append(f"机制 `{name}` 的执行面入口 `{entry}` **没有调用**它"
                       "（机制不在任何自动面里 ⇒ 造好却不跑）")

    # ── ⑥ 声称面 ↔ 实扫面 ──
    for name, row in MECHANISM_COVERAGE.items():
        if name not in real:
            continue
        carrier = row["落点"][0]
        derived = _mc_derive_faces(src, name, carrier, faces)
        claimed = _mc_expand(row.get("覆盖面", ()), faces)
        for face in sorted(claimed - derived):
            out.append(f"机制 `{name}` 声称覆盖面 `{face}`，但代码**没真扫**它"
                       "（宣称覆盖却没覆盖 ⇒ 覆盖登记失效）")
        for face in sorted(derived - claimed):
            out.append(f"机制 `{name}` 代码真扫面 `{face}`，但登记**没声明**它"
                       "（扫了却没登记 ⇒ 覆盖登记漏了一片）")
        # 登记的「实扫面」字段（机器可读）也必须与推导一致 —— 两处登记不许各说各话
        for face in sorted(_mc_expand(row.get("实扫面", ()), faces) - derived):
            out.append(f"机制 `{name}` 的「实扫面」登记了代码没扫的面 `{face}`"
                       "（实扫面登记漂移了）")
    return out


def render_check_dims() -> str:
    """判据清单的 Markdown 生成物（`SKILL.md` 与任何文档都从它派生）。"""
    lines = [CHECK_BEGIN, ""]
    lines += [f"{i}. **{d[0]}** — {d[1]}" for i, d in enumerate(CHECK_DIMENSIONS, 1)]
    lines += ["", CHECK_END]
    return "\n".join(lines)


def cmd_sync_dims(check_only: bool = False) -> int:
    """把**生成块**写回 `references/cli.md`（`--check` 只验不写）。

    v5.18.0（J′）：生成块从 SKILL.md 移到 `references/cli.md`——判据清单是**按需查阅**内容
    （门禁红了才需要逐条读），放在正文里是每次入场都要付的常驻成本（实测 7.9 KB）。
    SKILL.md 只留一句「判据清单见 references/cli.md」＋ 判据**条数**（不手写，由渲染器给）。

    v5.42.0：第二个生成块＝**落点登记**（源＝`FACT_LANDINGS`，腿列由代码派生）。
    两个块共用这一条命令 ⇒ **只有一个写入口** ⇒ 不会出现「只同步了一个」的半同步。
    """
    md = Path(__file__).resolve().parent.parent / "references" / "cli.md"
    try:
        text = md.read_text(encoding="utf-8")
    except OSError as e:
        print(f"sync-dims: 读不到 {md}: {e}", file=sys.stderr)
        return 2
    blocks = [
        (CHECK_BEGIN, CHECK_END, render_check_dims, "判据清单"),
        (LANDINGS_BEGIN, LANDINGS_END, render_landings, "落点登记"),
    ]
    new = text
    for begin, end, render, label in blocks:
        if begin not in new or end not in new:
            print(f"sync-dims: FAIL（{md.name} 缺{label}生成块——"
                  f"把下面这段插到 references/cli.md 的对应位置）", file=sys.stderr)
            print(render(), file=sys.stderr)
            return 1
        block = render()
        cur = new.split(begin, 1)[1].split(end, 1)[0]
        want = block.split(begin, 1)[1].split(end, 1)[0]
        if cur.strip() == want.strip():
            continue
        if check_only:
            print(f"sync-dims: FAIL（{md.name} 的{label}生成块与源不同步——"
                  f"跑一次 `handoff.py sync-dims` 写回）", file=sys.stderr)
            return 1
        new = new.split(begin, 1)[0] + block + new.split(end, 1)[1]
    changed: list[str] = []
    if new != text:
        changed.append(md.name)
        md.write_text(new, encoding="utf-8")
    # 文档面**事实渲染区**（v5.43.0）：随件文档里凡是枚举工具事实的地方，都从代码派生
    for f in sorted((Path(__file__).resolve().parent.parent / "references").glob("*.md")):
        try:
            t = f.read_text(encoding="utf-8")
        except OSError:
            continue
        t2 = render_doc_facts(t)
        if t2 == t:
            continue
        if check_only:
            print(f"sync-dims: FAIL（{f.name} 的事实渲染区与代码派生的值不同步——"
                  f"跑一次 `handoff.py sync-dims` 写回）", file=sys.stderr)
            return 1
        f.write_text(t2, encoding="utf-8")
        changed.append(f.name)
    if not changed:
        print("sync-dims: OK（生成块与事实渲染区都已是最新）")
        return 0
    print(f"sync-dims: 已写回 {'／'.join(changed)}")
    return 0


def _id_holes(st: Store) -> dict[str, list[str]]:
    """各前缀下「≤ 最大号却不在册」的 id 空洞（t000238①，**只报不拦**）。

    在册口径＝`all_ids()`（live ∪ closed ∪ decisions）∪ `_voided_ids()`（void ∪ trash），
    与 `allocate` 的「已作废不复用」口径同源。分配器是 `max+1` 顺序，所以某前缀下
    小于最大号却不存在的号，**曾经一定被分配过**——只是如今不在任何地方。
    """
    present: set[str] = set(st.all_ids()) | _voided_ids(st)
    by_prefix: dict[str, list[int]] = {}
    for i in present:
        m = ID_RE.match(i)
        if m:
            by_prefix.setdefault(m.group(1), []).append(int(m.group(2)))
    holes: dict[str, list[str]] = {}
    for typ, nums in by_prefix.items():
        miss = [n for n in range(1, max(nums) + 1) if n not in set(nums)]
        if miss:
            holes[typ] = [f"{typ}{n:06d}" for n in miss]
    return holes


def _rb_missing(st: Store, ids) -> list[str]:
    """写完回读（正向）：这些 id 应在 live∪closed∪decisions 里——返回**查不到的**。

    口径＝`all_ids()`，与 `echo_back` 的搜索域、`allocate` 的「已作废不复用」同源。
    """
    have = set(st.all_ids())
    return [i for i in ids if i not in have]


def _rb_after_rm(st: Store, i: str, expect_void: bool, moved_place: str = "",
                 left_same: int = 0) -> list[str]:
    """`rm` 的写完回读（**反向**）：条目预期**不在**册，且 trash/ 里必须有它。

    为什么不能套用正向模板：`rm` 的目的就是让该 id 从 live∪closed 消失，用「查不到即失
    败」去读它会把每一条正常 `rm` 都判死。`rm` 的写序是「先追加到 trash/、再整表覆写
    源文件」——与 5.1.3 修掉的自迁移同型：**追加若静默丢失，源文件又已被抹掉，条目净
    消失**。故这里验三件事：册里查不到、trash/ 里查得到（非空）、按分支该记的 void 记上了。

    **v5.50.0（t000444）**：判据的粒度从「这个 id」改成「**本命令移走的那一条**」。
    旧形断言「`i` 不在 live」⇒ 在「同 id 落两槽」时，另一槽那条**本来就应该**在 live
    （`rm` 只移走一条）⇒ 每次这样的 `rm` 都被判死 ⇒ rc=1 而实际已移走成功 ⇒
    用户以为失败、实则库已变（半成品状态）。⇒ 现在验的是「**移走的那条**不在它原来的
    位置」＋「**剩下的持有者**与动前算出的预期一致」。
    """
    bad: list[str] = []
    if moved_place:
        # 本命令移走的那一条：它不该再在原来的那个文件里。
        # ⚠ v5.56.0（t000457）：判据从「有没有同 id」改成**计数**——同 id 落同一文件时，
        #   **另一条仍留在那个文件里**是合法的（旧形按「有没有同 id」判 ⇒ 把合法状态
        #   判成「没抹掉」⇒ 每次这种 rm 都被判死）。
        _p = st.d / moved_place if not moved_place.startswith("/") else Path(moved_place)
        if _p.is_file():
            _now = sum(1 for r in _read_rows(_p) if r.get("id") == i)
            if _now != left_same:
                bad.append(f"{i} 在原位置 {moved_place} 还有 {_now} 条（应剩 {left_same} 条——"
                           f"移走的是**那一条**，同 id 的另一条留在原处）")
    elif i in {r.get("id") for r in st.load_live()}:
        bad.append(f"{i} 仍在 live（源文件没被抹掉？）")
    # ⚠ 只在 expect_void 时才断言「全册都查不到」：v5.1 的分流里有一种合法情形是
    #   live 副本移走了、**closed 仍持有该 id** ⇒ 按事实不记 void，但该 id 确实仍在册。
    #   早先无脑断言 `not in all_ids()` 把这种正常 `rm` 判死，被既有夹具当场抓出。
    #   v5.50.0：expect_void 为真 ⇔ 动前算出的「剩余持有者」为空 ⇒ 此时全册查不到才成立。
    if expect_void and i in set(st.all_ids()):
        bad.append(f"{i} 仍在 live∪closed（已作废却仍在册）")
    tm, tj = st.d / "trash" / f"{i}.md", st.d / "trash" / f"{i}.jsonl"
    if tm.is_file():
        pass
    elif tj.is_file():
        if not _read_rows(tj):
            bad.append(f"trash/{i}.jsonl 是空的（追加进黑洞——条目已从源文件抹掉且没写进 trash）")
    else:
        bad.append(f"trash/ 里没有 {i}（追加丢失且源文件已覆写 ⇒ 该条目已无处可寻）")
    if expect_void and i not in _void_ids(st):
        bad.append(f"{i} 未记 void（该 id 将来会被 allocate 复用）")
    return bad


def load_ruling_forms(root: Path) -> tuple[dict[str, list[str]] | None, str | None]:
    """读库级「裁定形态表」（store 同级 `handoff-ruling-forms.txt`，五个字面串区）。

    判据机制随件、形态表跟库：形态是**数据**不是模式（字面串，不是正则），
    加一条形态＝加一行。
    文件不存在 ⇒ (None, None)＝本维不启用（未 opt-in 的库零误伤）；
    文件存在但区残缺/有未知区 ⇒ ({}, err)＝红（配置错误不能静默失能）。
    """
    p = root / RULING_FORMS_FILE
    if not p.is_file():
        return None, None
    forms: dict[str, list[str]] = {k: [] for k in RULING_FORM_SECTIONS}
    sec: str | None = None
    for n, raw in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("[") and s.endswith("]"):
            name = s[1:-1].strip()
            if name not in forms:
                return {}, (f"{p.name}:{n} 未知区 [{name}]"
                            f"（只认 {'/'.join(RULING_FORM_SECTIONS)}）")
            sec = name
            continue
        if sec is None:
            return {}, (f"{p.name}:{n} 形态行不在任何区里"
                        f"（先写 {'／'.join(f'[{k}]' for k in RULING_FORM_SECTIONS)}）")
        forms[sec].append(s)
    if not forms["topic"] or not forms["record"]:
        return {}, (f"{p.name}: 缺 [topic] 或 [record] 区"
                    f"（topic 判「这一行在说什么」，record 判「哪些写法是在记录一条裁定」）")
    return forms, None


def _now_next(st: Store) -> list[str]:
    """**现在该做什么**（出路律·v5.33.0）：全部由库里实况现算——用户不必记住流程。

    只报**机械可算**的事（算不出来的就不报，别拿猜测充数）：
      ① **下一步**：next 指针；为空 ⇒ 按补位策略给候选（`refill_pick` 只算不写）。
      ② **本班待交代**：自上一次散文写入以来新增的 `t` 型条目
         （`_pending_cover_ids` ＝ 写入面同一口径）⇒ 给出现成的 `--covers` 写法，
         作者不必自己数该交代谁。
    ⚠ 刻意**不报**「该销哪条」：销账判据是**领域判断**（机器判不了）⇒ 那是合同里
    留给人的一条纪律，不该由工具假装能算。
    """
    out: list[str] = ["## 现在该做什么"]
    nid = st.next_id()
    if nid:
        out.append(f"- 下一步＝**{nid}**（next 指针；补位顺序与未销账清单见 `handoff view`）")
    else:
        cand, why = refill_pick(st)
        out.append("- 指针为空 ⇒ 跑 `handoff next --auto`（按补位策略落指针"
                   + (f"：{cand}" if cand else "；池空") + f"｜{why}）")
    pending = _pending_cover_ids(st)
    if pending:
        out.append(f"- 本班新增 {len(pending)} 条**待交代**：在班段散文里**写到这些 id 即算覆盖**"
                   f"（`handoff append exit`；refs 化：作者成本 0）"
                   f"——一次写不完就打包声明 `handoff append exit --covers "
                   f"{','.join(pending[:8])}" + ("…" if len(pending) > 8 else "")
                   + "`（声明落在班次台账里，是落盘证据）")
    else:
        out.append("- 本班没有待交代的新条目；若本轮有实质改动 ⇒ 写一个新班段："
                   "`handoff append exit --file <段>`（散文只写叙述）")
    return out


def cmd_check(st: Store, no_log: bool = False, repair: bool = False) -> int:
    """`check`＝相位门禁。**默认只读**：判据不改使用方的任何文件（v5.18.0／A′）。

    `repair=True` 时才允许按唯一源重装交接块（`handoff check --repair`）：痕迹落既有
    事件流（log.jsonl），退出码语义不动。"""
    errs: list[str] = []
    # 单槽存在性（槽清单＝`SINGLES`，唯一源；**不写死个数**——数字会漂）
    for s in SINGLES:
        if not (st.d / s).is_file():
            errs.append(E("缺槽", f"缺槽: {s}"))
    for slot in ENTRY_SLOTS:
        if not (st.d / slot).is_dir():
            errs.append(E("缺槽", f"缺槽目录: {slot}/"))
    if not st.unconf_file().is_file():
        errs.append(E("缺槽", "缺槽: unconfirmed.jsonl"))
    if not st.decisions_dir().is_dir():
        errs.append(E("缺槽", "缺槽目录: decisions/"))
    if not (st.d / "closed").is_dir():
        errs.append(E("缺槽", "缺槽目录: closed/"))
    if not (st.d / "index").is_file():
        errs.append(E("缺 index", "缺 index"))

    # 条目校验
    seen: dict[str, str] = {}
    live = st.load_live() + st.load_closed()
    for r in live:
        loc = f"{r.get('_file')}"
        i = r.get("id", "")
        m = ID_RE.match(i)
        if not m:
            errs.append(E("非法 id", f"{loc}: 非法 id {i!r}（应 {ID_FORM}）"))
            continue
        typ = m.group(1)
        if i in seen:
            errs.append(E("id 重复", f"{loc}: id 重复 {i}（已见 {seen[i]}）"))
        seen[i] = loc
        # 槽 ↔ 类型
        if r.get("_slot") in ENTRY_SLOTS:
            want = ENTRY_SLOTS[r["_slot"]]["type"]
            if typ != want:
                errs.append(E("id 前缀与槽不符", f"{loc}: id 前缀 {typ} 与槽 {r['_slot']} 不符（应 {want}）"))
        elif r.get("_slot") == "unconfirmed" and typ != "u":
            errs.append(E("unconfirmed 前缀", f"{loc}: unconfirmed 内 id 前缀应为 u，得 {typ}"))
        elif r.get("_slot") == "closed":
            stem = Path(str(r.get("_file"))).stem
            if re.fullmatch(r"[tpducq]", stem) and typ != stem:
                errs.append(E("closed 文件前缀", f"{loc}: closed 文件 {stem}.jsonl 与 id 前缀 {typ} 不符"))
        knd = SLOT2KIND.get(r.get("_slot")) if r.get("_slot") in ENTRY_SLOTS else None
        if knd and (r.get("status") or "open") not in live_status_of(knd):
            errs.append(E("status 非法", f"{loc}: status 非法 {r.get('status')!r}"
                        f"（该型合法 {sorted(live_status_of(knd))}；closed 须经 close 流程）"))
        for k in r:
            if k in ("_slot", "_file"):
                continue
            if k not in ALLOWED_KEYS:
                errs.append(E("未知字段", f"{loc}: 未知字段 {k!r}"))
        if r.get("_slot") != "closed":
            for req in ("id", "created", "summary"):
                if not r.get(req):
                    errs.append(E("缺必填", f"{loc}: 缺必填 {req}"))
        cr = r.get("created", "")
        if cr and not DATE_RE.match(cr):
            errs.append(E("created 非日期", f"{loc}: created 非日期 {cr!r}"))
        if cr and cr > today():
            errs.append(E("created 为未来日", f"{loc}: created 为未来日 {cr}"))
        cl = r.get("closed")
        if cl is not None:
            if not DATE_RE.match(str(cl)):
                errs.append(E("closed 非日期", f"{loc}: closed 非日期 {cl!r}"))
            elif cl > today():
                errs.append(E("closed 为未来日", f"{loc}: closed 为未来日 {cl}"))
            elif cr and cl < cr:
                errs.append(E("closed 早于 created", f"{loc}: closed < created（{cl} < {cr}）"))
        if "\n" in r.get("summary", "") or "\t" in r.get("summary", ""):
            errs.append(E("summary 含换行", f"{loc}: summary 含换行/制表（须单行）"))

    # next 指针
    nid = st.next_id()
    if nid:
        if not ID_RE.match(nid):
            errs.append(E("next 非法 id", f"next: 非法 id {nid!r}"))
        else:
            live_recs = {r["id"]: r for r in st.load_live() if "id" in r}
            if nid not in live_recs:
                errs.append(E("next 不存在", f"next: {nid} 不存在或已关闭"))
            elif (live_recs[nid].get("status") or "open") != "open":
                # 存在但不是 open：blocked/等待中的条目当决策点＝空指针。调用方
                # （接手的人或 agent）照着 next 走会立刻卡住，而结构上看不出问题。
                errs.append(E("next 不是 open", f"next: {nid} 的 status="
                            f"{live_recs[nid].get('status') or 'open'!r}，不是 open"
                            f"（等待中的条目不该当决策点）"))
            elif live_recs[nid].get("blockedBy") in blocking_ids(st):
                # t000242：`status=open` 但 `blockedBy` 指向还活着的东西 —— 结构上完全正常，
                # 接手的人却会在第一眼撞上一个推不动的活（t000196×两班）。补位池已跳过它，
                # 这里管的是**人手 `handoff next <id>` 把它钉回去**的那条路。
                errs.append(E("next 卡在 blocker", f"next: {nid} 卡在 {live_recs[nid]['blockedBy']} 上"
                            f"（blockedBy 指向的条目还活着 ⇒ 现在推它必然白推）"))

    # 文本槽死指针（D1，2026-10-03）：文本槽是纯手写散文，条目删了/改号了它不会
    # 自己跟着变。结构校验看不出这类漂移——槽文件存在、id 合法、引用闭合，全都对。
    # id 不随时间失效，所以这一维可**全量**判。**但不是「无假阳性」**——判据只覆盖
    # 下面 ② 点名的那几型；**被排除的类型不因此变成「没问题」，只是另有检查面**。
    #
    # **两个刻意的收窄**（都是被真文本逼出来的，不是预防性设计）：
    #  ① **已作废 ≠ 不存在**。`rm` 会把条目落进 `trash/` 并记入 `void`；此后文本里
    #     写「t000105 作废」是**正当的历史陈述**（真源实测共 6 处：`status` 3 ＋ `summary` 1 ＋ `exit` 2），
    #     判它死指针就是逼着人把正确记录改掉。故作废 id 不计。
    #  ② **`c` 与 `d` 两型不参与本维**（2026-10-03 用户裁定，原只排 `c`）。
    #     理由写准（此处前两版都写错过，故把推演留下）：
    #       · 判据用的模式是 `\b([tpqu]\d{6})\b`（**d 已从字符类里去掉**），
    #         长度**恒为 7 字符** ⇒ 6 字符的 git 短 hash 长度不足、**永不匹配**。
    #       · `c697750`（7 字符）也不匹配，原因是 **`c` 根本不在字符类**——排除它
    #         之后这条恒成立，与词边界无关。
    #       · 字符类 `tpdqu` 里**只有 `d` 是 hex 字符**。故 `d` 型与 7 字符全 hex 的
    #         commit 短 hash（如 `d697750`）**形态不可区分**，且**实测可复现**：把
    #         这种 hash 写进文本槽，`check` 立刻 rc=1 把它判成死指针。
    #     所以排除的其实是 **`d`**（够得着的那个），`c` 排除只是顺带的零成本项。
    #     **收窄不是放弃检查**：「`d` 型 id 查不到」这件事有专门且语义正确的检查面
    #     —— `view --id dNNNNNN`：**已作废**的 id 打印「已作废」并 rc=0（与本闸
    #     「已作废 ≠ 不存在」同口径），**真正查不到**才 rc=2 并明说「live / closed /
    #     decisions 均无，且不在 trash/·void」；`check` 另有一条判 `decisions/<file>`
    #     的 frontmatter id 必须等于文件名（抓改号）。分工已实测：把 d000001.md
    #     改名 → view 仍按 frontmatter id 命中（rc=0）而 check 立刻 rc=1 报
    #     「frontmatter id 与文件名不符」；把文件移走 → view rc=2；只把文件挪进
    #     `trash/` 不记 `void` → 两边都认「已作废」。**交给语义正确的命令，别靠
    #     形态猜。**
    voided = _voided_ids(st)          # 单源：void ∪ trash/（见 _voided_ids）
    known_ids = set(st.all_ids()) | voided
    for s in ("status", "summary", "exit"):
        sp = st.d / s
        if not sp.is_file():
            continue
        for ref in sorted(set(re.findall(r"\b([tpqu]\d{6})\b", sp.read_text(encoding="utf-8")))):
            if ref not in known_ids:
                errs.append(E("文本槽死指针", f"{s}: 提到 {ref}，但 live∪closed∪decisions 里没有这个 id"
                            f"（既不在册、也不在 trash/void——条目被删或改号了，文本不会自己跟着变）"))

    # ⑲ blocked-stale（t000255）：声称被挡，挡的东西已经没了
    for _bid, _bb in blocked_dead_rows(st):
        errs.append(E("blockedBy 已失效", f"{_bid}: status=blocked，但 blockedBy 指向的 {_bb} 已不再生效"
                    "（已关闭／已作废／已被 supersede）⇒ 补位池两道谓词对它结论相反："
                    "谓词③说「没被挡」、入池谓词②说「被挡」——它既不会被补位选中，"
                    "也不出现在被阻清单的实质理由里，实际是「无人接手但谁也看不见」。", id=_bid))

    # ---- v5.18.0 G′：blocked 却没记「在等什么」⇒ 红（修法可满足：补其一即可）----
    for _r in st.load_live():
        if (_r.get("status") or "open") != "blocked":
            continue
        if _r.get("blockedBy") or _r.get("waitingFor"):
            continue
        errs.append(E("blocked 缺等谁", f"{_r['id']}：status=blocked，但**没记在等什么**——"
                    f"既无 `blockedBy`（等库内某条）也无 `waitingFor`"
                    f"（等所有者／等用户／等外部条件）⇒ 它不进补位池、无 owner、"
                    f"任何维都不报＝「无人接手但谁也看不见」。", id=_r['id']))

    # 决策文档校验
    if st.decisions_dir().is_dir():
        for f in sorted(st.decisions_dir().glob("*.md")):
            fm = _frontmatter(f)
            if fm.get("id") != f.stem:
                errs.append(E("裁定件 id 与文件名不符", f"decisions/{f.name}: frontmatter id {fm.get('id')!r} 与文件名 {f.stem!r} 不符"))
            if not DATE_RE.match(fm.get("created", "")):
                errs.append(E("裁定件 created 非日期", f"decisions/{f.name}: created 缺或非日期"))
            if fm.get("status") and fm["status"] not in DECISION_STATUSES:
                errs.append(E("裁定件 status 非法", f"decisions/{f.name}: status 非法 {fm['status']!r}"
                            f"（闭集 {'/'.join(DECISION_STATUSES)}）"))
            # 待追认的裁定（v5.12.0／d000112）：d 型不进补位池、也不被三道新鲜度维点名，
            # 所以「等你拍板」这件事在库里没有任何消费点——不判它，它就永远挂着。
            if decision_pending(fm):
                errs.append(E("待追认的裁定", f"decisions/{f.name}: status=proposed ⇒ **待所有者追认**，"
                            f"无人拍板就没有任何闸会再提它（d 型不进补位池）——", stem=f.stem))

    # decision-prose（t000376／d000123）：凡落裁定必走裁定件。
    # 判据机制随件、形态表跟库：只认**落盘证据**（散文行 ＋ decisions/ ＋ void/trash/）。
    # record 形态命中而没有在册/已作废 d 号 ⇒ 红（10-19 那次「裁定只落 exit 散文」的病根）；
    # reference／闭集外形态 ⇒ 只提示不判红（标题行不是记录，跳过）。
    _rf, _rf_err = load_ruling_forms(st.root_dir)
    if _rf_err:
        errs.append(E("裁定形态表不可用", f"decision-prose: {_rf_err}"))
    elif _rf:
        _ledger_d = {p.stem for p in st.decisions_dir().glob("d*.md")} | set(_voided_ids(st))
        _dp_bad: list[str] = []
        _dp_tips: list[str] = []
        for _s in ("exit", "summary"):
            _sp = st.d / _s
            if not _sp.is_file():
                continue
            for _n, _ln in enumerate(
                    _sp.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if not any(_t in _ln for _t in _rf["topic"]):
                    continue
                if _ln.lstrip().startswith("#"):
                    continue
                _ds = re.findall(r"(?<![0-9A-Za-z])d\d{6}(?![0-9A-Za-z])", _ln)
                if any(_d in _ledger_d for _d in _ds):
                    continue                      # 已有落点：记录/引用都成立
                if any(_f in _ln for _f in _rf["pending"]):
                    continue                      # 待裁不是已裁
                if any(_f in _ln for _f in _rf["skip"]):
                    continue                      # 已知非记录形态（含「已裁不补」这类引用语法）
                if any(_f in _ln for _f in _rf["record"]):
                    _dp_bad.append(f"{_s}:{_n} {_ln.strip()[:80]}")
                    continue
                _kind = "引用" if any(_f in _ln for _f in _rf["reference"]) else "闭集外"
                _dp_tips.append(f"{_s}:{_n} [{_kind}] {_ln.strip()[:80]}")
        if _dp_bad:
            errs.append(
                E("裁定陈述无在册 d 号", f"decision-prose：{len(_dp_bad)} 处裁定陈述没有**在册** d 号"
                f"（凡落裁定必走裁定件）→ {_dp_bad[:5]}{'…' if len(_dp_bad) > 5 else ''}"))
        if _dp_tips:
            print(f"handoff check: 提示：decision-prose 有 {len(_dp_tips)} 行引用/未识别形态"
                  f"（只报不拦，闭集外形态靠这条露出来）→ {_dp_tips[:4]}", file=sys.stderr)

    # 源登记表可解析（机械判据：登记必须指向活路径 / glob 有命中）
    for e in _scope_lines(st):
        if not _scope_resolves(st, e):
            errs.append(E("scope 不可解析", f"scope 登记不可解析：{e}（路径不存在 / glob 无命中）"))
    void = set(_void_ids(st))
    if void:
        closed_ids = {r.get("id") for r in st.load_closed()}
        for i in st.all_ids():
            if i in void:
                # 报错必须**自带出口**（v5.1）：这条判据曾在 live＋closed 同 id 的修复现场
                # 把存储锁死在 FAIL——`void` 只进不出、`rm` 又拒碰已作废 id，于是「修法只经
                # CLI」成了假承诺。现在点名 unvoid，并分清「该留 closed 那份」与「该恢复条目」。
                where = ("closed 里合法在册" if i in closed_ids else "live 里在册")
                errs.append(E("id 复用已作废号", f"id 复用了已作废 id：{i}（该 id 在 {where}，与 void 的「永不复用」矛盾）", id=i))

    # v5.19.0（t000402）：台账体量**只提示不拦**——收窗是显式命令（`compact-writes`），
    # 门禁不改用户的台账（A′：门禁不改使用方的文件，同一条纪律）。阈值只作提示：
    # 收窗前后**判定不变**，所以它不是缺陷、只是「该收窗了」。
    _wl = st.d / WRITES_LOG
    if _wl.is_file():
        try:
            _sz = _wl.stat().st_size
            _cnt = sum(1 for _l in _wl.read_text(encoding="utf-8").splitlines() if _l.strip())
            if _sz > LEDGER_HINT_BYTES or _cnt > LEDGER_HINT_EVENTS:
                print(f"writes: 写事件台账已 {_cnt} 条／{_sz // 1024} KB——"
                      f"可跑 `handoff compact-writes --keep 200` 收窗"
                      f"（**不改变判定**：末次记录／删除并集／带旁证事件三项原样保留；"
                      f"结案仍走 rebase --force）", file=sys.stderr)
        except OSError:
            pass

    # 写事件对账（p000025，4.7.8）：把「绕过 CLI 手改文件」与「补手续」从纪律变成判据。
    for _w in audit_writes(st):
        errs.append(E("写事件对账", _w))

    # **凭空出现的 id**（v5.53.0 · t000448）：在册 id 的来历不可追 ⇒ 红。
    # 单独成一路（不并进上面的写事件对账）：两者的**出路不同**——文件级的是
    # 「核对台账／重导那条」，id 级的是「这条不是 CLI 分配的 ⇒ 删掉它，或认账它」。
    for _pid, _p in id_provenance_violations(st):
        # v5.68.0（t000475 · F-I1）：**已在回收站的**与**还在活层的**给两条不同的出路
        # ——`rm` 对已作废的 id 会当场拒 ⇒ 旧形那条出路在这种情况下不可执行。
        if _pid in _voided_ids(st):
            errs.append(E("凭空出现的 id（已在回收站）", _p, id=_pid))
        else:
            errs.append(E("凭空出现的 id", _p, id=_pid))

    # **出处基线还没建立**（v5.53.0 · t000448）：老库没被新码写过 ⇒ 存量 id 的来历
    # 不可追 ⇒ 上面的维**不判**（判了必误伤）⇒ 但不判≠闸缺席 ⇒ 这里给一条**可执行**红项。
    _bm = id_baseline_missing(st)
    if _bm:
        errs.append(E("id 出处基线未建立", _bm))

    # 分区文件名**大小写折叠后重名**（2026-10-03，Windows 实测带出的真问题）：
    # NTFS 大小写**不敏感** —— 实测同时创建 `Case.jsonl` 与 `case.jsonl`，目录枚举
    # **只得到 1 个文件**。所以仅大小写不同的两个 domain，在 Windows 上会**合并成一个
    # 分区文件**：index 计数少一条、两条目挤进同一文件 ⇒ 正是 p000046 那个「index 与现实
    # 不符、check 却报 OK」的形态。**这条在 Linux 上也判**（折叠后重名是纯粹的命名冲突），
    # 因为它是**平台无关的前提**——在 Linux 上它无害，在 Windows 上它丢数据。
    for slot in ENTRY_SLOTS:
        d = st.d / slot
        if not d.is_dir():
            continue
        seen: dict[str, str] = {}
        for f in sorted(d.glob("*.jsonl")):
            key = f.name.lower()
            if key in seen:
                errs.append(
                    E("分区名大小写重名", f"{slot}/{f.name} 与 {seen[key]} 仅大小写不同：Windows/NTFS 大小写不敏感，"
                    f"两者会合并成同一个分区文件（实测枚举只得 1 个）⇒ 改其中一个的 domain"))
            else:
                seen[key] = f.name

    # index 一致性
    if (st.d / "index").is_file():
        try:
            idx = json.loads((st.d / "index").read_text(encoding="utf-8"))
            for slot in ENTRY_SLOTS:
                want = len([r for r in st.load_live() if r.get("_slot") == slot])
                got = idx.get("slots", {}).get(slot, {}).get("count")
                if got != want:
                    errs.append(E("index 漂移", f"index 漂移: {slot} 计数 表={got} 实={want}"))
            want_uc = len(read_jsonl(st.unconf_file()))
            got_uc = idx.get("slots", {}).get("unconfirmed", {}).get("count")
            if got_uc != want_uc:
                errs.append(E("index 漂移", f"index 漂移: unconfirmed 计数 表={got_uc} 实={want_uc}"))
            want_nx, got_nx = st.next_id(), idx.get("next")
            if got_nx != want_nx:
                errs.append(E("index 漂移", f"index 漂移: next 表={got_nx!r} 实={want_nx!r}（跑 handoff index 重建）"))
        except json.JSONDecodeError:
            errs.append(E("index 非法 JSON", "index 非法 JSON"))

    # ── 交接陈述新鲜度（2026-10-03 下沉自本仓 scripts/handoff-freshness-check.py）──
    # 下面两条此前是**库专属脚本**，判的却是每个使用方都需要的交接纪律，形态错了：
    # 消费方是技能使用者，判据就该随技能分发（消费主体跟着谁走）。下沉后兄弟仓跑
    # `handoff check` 同样受益。
    #
    # 事实面：`closed` 槽给出「哪些已闭、哪天闭的」；`actions` ∪ `closed` 减去已闭
    # 就是「仍**未销账**的队列」（含 `status=blocked`——blocked 也是没做完的事，见下面 fresh-queue）。
    # **只取 `t` 型**（待办）：p* 是坑、d* 是决定，进 exit 属
    # 背景叙述，池里常有上百条 open，逐条要求 exit 提及既不现实也会淹没真信号。
    # ⚠ **v5.32.0**：这里曾为 `fresh-stale`／`fresh-false` 两维各算一份「已闭表／未销账表」——
    #   两维已作废（散文不承担状态）⇒ 那两份表随之作废；**状态表现在只有一处**
    #   （`_state_maps`：已闭表 ＋ 仍在册的 `t` 型）⇒ 不留第二份口径。
    _closed_map, _open_ids = _state_maps(st)

    def _slot_text(sl: str) -> str:
        p = st.d / sl
        return p.read_text(encoding="utf-8", errors="replace") if p.is_file() else ""

    _exit_txt, _summary_txt = _slot_text("exit"), _slot_text("summary")

    # fresh-queue（R·2026-10-23）：「未销账条目要在 exit/summary 里点名」这条判据的
    # **谓词按「渲染区能不能代表」拆成两段** —— 旧形是「全部未销账 t 型」，那让散文同时
    # 回答了两个不同的问题：Q1「读者知不知道队列」（渲染区已经答，且 queue-stale 保证它
    # 不撒谎）与 Q2「作者有没有注意到」（这才是散文点名的本意）⇒ Q1 的冗余成本（O(存量)）
    # 压在 Q2 的必要成本（O(本班增量)）头上 ⇒ 存量一涨就废，且**先被淹的是 parked 型**
    # （等所有者/等外部/卡在活裁定上的活）——那恰恰是最不该被淹的一类。
    #
    # R2（v5.29.0 刀 2）：R 的两段**统一为「只有本班增量要点名」**。
    # R（v5.23.0）原来分两段：① parked 型（区装不下）⇒ **全部**必须点名；
    #   ② actionable 型 ⇒ 只有本班新增的要点名。
    # ⇒ 段①是**第二条 O(存量) 的散文义务**（与「区落盘」同型的第二个死锁支：
    #   拐点按字节预算 ≈1800 条——exit+summary 两槽 16KB ÷ 每 id ≈9 字节；
    #   实测 200 条 parked 仍可满足，再往上触顶）⇒ 库一大照样锁死。
    # ⇒ 段①的前提（「区里根本没有它们，不点名就等于从交接里彻底消失」）**已经不成立**：
    #   v5.29.0 起区读时现算，而 `handoff view` 逐条列出**全部 live 条目**，
    #   `entry_display_line` 还带「等 owner／等 t000123」——**为什么推不动已经写在
    #   读者看得见的地方** ⇒ Q1「读者知不知道」由视图如实回答，散文不必再抄一份。
    # ⇒ 于是段①段②统一：**散文点名义务＝O(本班增量)**，存量与推不动的条目由
    #   **读时现算的视图**承担 ⇒ 库里再大也不会锁死（没有拐点）。
    #   牙没有消失，只是**从「散文里逐条抄」搬到「视图里如实呈现」**——搬走的是
    #   O(存量) 的那一份，留下的是 O(增量) 的那一份。
    #
    # 「本班新增」＝ **创建时刻** ≥ **上一次**班段散文写入时刻（精确到秒，t000407；
    #   边界取法与它自己吃掉自己的坑见 `_shift_boundary` 的 docstring）。
    #
    # ⚠ 仍必须**剥掉 exit 尾部的队列渲染区**再取 id（t000285）：v5.29.0 起区不再落盘，
    #   但**旧库残留**仍在文件里（判据 `queue-legacy` 会点名并给修法）⇒ 剥掉它才
    #   不会让残留区的 id 冒充「这一班的人点名过」。
    _blocking = blocking_ids(st)
    # v5.30.0 刀 F：边界＝**班次序号**（显式、单调、与时钟无关）；老条目按时刻兜底。
    _boundary = _shift_boundary(st)
    _parked: dict[str, str] = {}           # 推不动的（值＝排除原因）
    _new_parked: set[str] = set()          # 推不动**且本班新增** ⇒ 要点名（刀 2）
    _new_actionable: set[str] = set()      # 能推**且本班新增** ⇒ 要点名
    for r in st.load_live():
        if r.get("_slot") != "actions":
            continue
        _rid = r.get("id") or ""
        if _rid not in _open_ids:
            continue
        # 「本班新增」＝ **创建时刻** ≥ **上一次**班段散文写入时刻（**精确到秒**，
        # t000407）。日粒度会把同一天里前几班登记的条目也算成「本班新增」⇒
        # 逐班点名负担随当天累计量涨；精确时刻后，「本班」＝ 这一班。
        # ⚠ 边界必须取**上一次**散文写入，不能取最后一次——否则当前班段自己
        #   刚写的那次把边界吃掉 ⇒ 本班条目全落在边界之前 ⇒ 牙静默失效
        #   （2026-10-23 实测；详见 `_shift_boundary`）。
        _is_new = _is_shift_new(r, _boundary)
        # v5.29.0 刀 3：**导入存量**（`origin=import`）不算「本班新增」——它是迁移
        # 进来的旧工作，不是本班新增的活。import 自己已用一行有界聚合如实交代
        # （逐条见 `handoff view`，它列全部 live 条目）⇒ 逐条点名既无必要，又会把
        # 散文变成 id 清单（旧形实测：导入 700 条 ⇒ 点名行 8538 字节 ⇒ 撞热层上限）。
        if r.get("origin") == "import":
            _is_new = False
        _why = _pool_exclusion(r, _blocking, "")
        if _why:
            _parked[_rid] = _why
            if _is_new:
                _new_parked.add(_rid)
        elif _is_new:
            _new_actionable.add(_rid)
    _must_name = _new_parked | _new_actionable
    # v5.45.0（refs 化）：判据输入换成**覆盖集合**＝班段散文里**点名到的 id**（写时提取，
    #    落在班次台账里）∪ **结构化声明**（`--covers`，批量出口）⇒ 散文里提到即算覆盖
    #    （作者成本 0）⇒ 覆盖事实的**原件**是散文，声明不再是必经的第二份陈述。
    # **老班段兼容**：最近班段既没有 `refs` 也没有 `covers` 字段（v5.45.0 之前写的）⇒ 退回
    # **旧口径扫散文**（逐字不变 ⇒ 迁移不误伤）——「用该班段自己的记录来判：有集合按集合，
    # 没有按老口径」。
    _cov, _is_legacy = _shift_covered(st)
    _use_covers = not _is_legacy
    if _use_covers:
        _covers = _cov or set()
        _silent = sorted(_must_name - _covers)
    else:
        # ⇒ 重述点机制面A：老班段兼容分支——判据面拿散文当覆盖声明的输入（抄件当判据输入，
        #    族 H 的老口径）。豁免在 `REWRITE_EXEMPT` 里；**本分支删掉时同批删掉那条豁免**
        #    （豁免名单与实算双向对账 ⇒ 过期即红）。
        _blob = "\n".join((_strip_queue(_exit_txt), _summary_txt))
        _mentioned = {x.lower() for x in FIND_ID_RE.findall(_blob)} if FIND_ID_RE else set()
        _silent = sorted(_must_name - _mentioned)
    if _silent:
        _n_parked = sum(1 for i in _silent if i in _new_parked)
        _n_new = len(_silent) - _n_parked
        _parts = []
        if _n_parked:
            _why_txt = "、".join(sorted({_parked[i] for i in _silent if i in _new_parked})[:3])
            _parts.append(f"推不动的 {_n_parked} 条（{_why_txt}）——**本班新增的**要点名")
        if _n_new:
            _parts.append(f"能推的 {_n_new} 条——只有**本班新增**的要点名")
        # **报错自带出路（t000409／v5.29.0 刀 4）**：规模场景下作者最容易卡在「点名要
        #   写多少行」上 ⇒ 报错必须按**真实预算**算，不能拍脑袋。旧文案两处都不真：
        #   ① 说「约 13 行 … exit 班段 12 行都放得下」（实测 150 条）——13 > 12，那条
        #      建议**字面上做不到**；② 又过于悲观（150 条按 40 个/行只要 4 行）。
        #   ⇒ 真实容量＝exit 班段正文 10 行 ＋ summary 热层 30 行，每行约 40 个 id。
        #   报错只说矛盾不给出口＝**闸把存储锁死在 FAIL**（p000122 同族）。
        _need_lines = (len(_silent) + NAME_IDS_PER_LINE - 1) // NAME_IDS_PER_LINE
        _cap_lines = NAME_EXIT_LINES + NAME_SUMMARY_LINES
        if _need_lines <= NAME_EXIT_LINES:
            _where = (f"打包后约 {_need_lines} 行 ⇒ exit 班段放得下"
                      f"（正文上限 {NAME_EXIT_LINES} 行，每行约 {NAME_IDS_PER_LINE} 个 id）")
        elif _need_lines <= _cap_lines:
            _where = (f"打包后约 {_need_lines} 行 ⇒ exit 班段放不下（正文上限 {NAME_EXIT_LINES} 行）"
                      f"⇒ 前 {NAME_EXIT_LINES} 行写 exit、其余约 {_need_lines - NAME_EXIT_LINES} 行写 summary"
                      f"（两槽合计 {_cap_lines} 行）")
        else:
            _where = (f"打包后约 {_need_lines} 行 ⇒ **超出两槽可容纳上限**"
                      f"（exit {NAME_EXIT_LINES} 行 ＋ summary {NAME_SUMMARY_LINES} 行，"
                      f"每行约 {NAME_IDS_PER_LINE} 个 ⇒ 约 {_cap_lines * NAME_IDS_PER_LINE} 条）"
                      f"⇒ 分批登记：每批 ≤ {_cap_lines * NAME_IDS_PER_LINE} 条，"
                      f"且每批要在**下一次散文写入前**点名")
        if _use_covers:
            # v5.45.0（refs 化）：新路径的报错**自带出路**——班段散文里点名即覆盖（成本 0）；
            # 一次写不完就用 `--covers` 打包声明（例外出口）。
            errs.append(
                E("本班条目没被点名", f"fresh-queue：{len(_silent)} 条该点名的 `t` 型条目**没被最近班段点名覆盖**："
                f"{_silent[:8]}{'…（只列前 8，共 %d 条）' % len(_silent) if len(_silent) > 8 else ''}"
                f"　（口径 R2：{'；'.join(_parts)}）"))
        else:
            errs.append(
                E("本班条目没被点名（老口径）", f"fresh-queue：{len(_silent)} 条该点名的 `t` 型条目在 exit/summary 里没出现（exit 沉默）："
                f"{_silent[:8]}{'…（只列前 8，共 %d 条）' % len(_silent) if len(_silent) > 8 else ''}"
                f"　（口径 R2：{'；'.join(_parts)}）"
                f"　（最近班段是 v5.31.0 之前写的 ⇒ 按**老口径**扫散文；"
                f"写一个新班段并用 `--covers` 声明 ⇒ 就不再依赖散文文本）", where=_where))

    # ⚠ **v5.32.0（P1／批 A）：`fresh-stale`／`fresh-false` 两维已作废**——
    #   散文**不再承担状态断言**（写面不因状态拒写；无时点的括号标记由写面规范化掉）
    #   ⇒ 拿散文比库里活状态**没有意义了**（拿死的载体判活的事实，L2）。
    #   旧形的代价（实算）：写面会拒 113 处，其中 109 处（96%）是**带时点的历史陈述**被误判；
    #   三句普通中文全部被拒写；库里 21 处状态副本是**闸逼出来的**。
    #   现在的做法：**状态由渲染现算补**（`view` 在无时点的行里给每个提及标真状态）
    #   ⇒ 读者看得到真状态，作者不必抄；机器也不再替作者裁决语义（用可见性换拦截力）。

    # queue-legacy：v5.29.0 起队列区**读时现算、不落盘** ⇒ 文件里若还有区，那是
    # v5.28.x 之前的**残留**：它是当时的快照（会陈旧）＋ 机器内容留在人写的散文层
    # （与叙述混在一起会被误读成当时的现态）⇒ 存在即红。
    # ⚠ 旧形的 `queue-stale`（区必须与池实算逐行相等）**已作废**：没有存储态区就没有
    #   会陈旧的区 ⇒ 也就没有这道判据；同时「每次改池都得记得复渲染」的写点清单整条
    #   消失（它历史上漏接过三次：v5.7.0 的 rm／edit／compact、t000405 的 supersede）。
    if QUEUE_BEGIN in _exit_txt or QUEUE_END in _exit_txt:
        errs.append(
            E("队列区残留", "queue-legacy：`exit` 里还有 v5.29.0 之前的队列渲染区残留——队列现态改为"
            "**读时现算、不落盘**（`handoff view` 现给你），文件里这份是当时的快照、"
            "会陈旧，且它是机器内容、留在人写的散文层里（已销账的 id 会被误报成"
            "「没带关闭标记」）。"))

    # counts-stale（t000315／d000121）**已作废**（v5.30.0）：counts 区**不再落盘** ⇒
    # 没有存储态副本就没有会陈旧的副本 ⇒ 这道判据随区一起消失（判据面净减一处）。
    # 旧库残留的区由写路径（`write_index` → `strip_counts_legacy`）幂等剥掉；
    # **残留本身不判红**（它只是旧库痕迹，不是矛盾——与 `queue-legacy` 的处理同构：
    # 残留即提示、判红的是「散文里的话与库矛盾」，不是「机器内容还在」）。

    # prio-source：重要度**只能有一个来源**（d000108）。两条都判：
    #   ① live action 的 `prio` 必须在闭集里（缺字段＝没回填，或有人绕过 CLI 手改）；
    #   ② summary **不得再以档位词开头**——字段已是唯一来源，留着旧前缀就是一条没人
    #      同步的假通道（字段改了、前缀没改，读者按前缀读就错）。
    # 非档位的方括号前缀（本仓在册的 `[根因]`／`[装配面]`／`【已更正】`）**不判**：不表达重要度，硬拒是误拒。
    _pbad: list[str] = []
    for _f in sorted((st.d / "actions").glob("*.jsonl")) if (st.d / "actions").is_dir() else []:
        for _r in read_jsonl(_f):
            if _r.get("closed"):
                continue
            _pv = _r.get("prio")
            if _pv not in PRIO_RANK:
                _pbad.append(f"{_r.get('id','?')}：prio={_pv!r} 不在闭集 {'/'.join(PRIO_LEVELS)}")
            elif is_tier_prefix(_r.get("summary", "")):
                _pbad.append(f"{_r.get('id','?')}：字段已是「{_pv}」而 summary 仍以档位前缀开头"
                             f"（{_r.get('summary','')[:14]}…）")
    if _pbad:
        errs.append(
            E("重要度来源不一致", f"prio-source：重要度来源不一致 {len(_pbad)} 处 → {_pbad[:5]}{'…' if len(_pbad) > 5 else ''}"))

    # derived-counts（d000109）：文本槽散文里的**现态计数**——存在即红，**不判它对不对**。
    # 与 `guard_derived_counts` 同一个 matcher（同源，不抄第二份）。刻意不比值：比值就得
    # 靠正则认出那一行，而那一行的形状由人写——本仓实测被一个空格判瞎过，且瞎的时候打 OK。
    _dc: list[str] = []
    for _s in PROSE_SLOTS:
        _p = st.d / _s
        if not _p.is_file():
            continue
        _t = _p.read_text(encoding="utf-8")
        for _n, _txt in derived_count_hits(_strip_rendered(_t)):
            _dc.append(f"{_s}:{_n} {_txt}")
    if _dc:
        errs.append(
            E("散文抄了现态计数", f"derived-counts：文本槽散文里抄了现态计数 {len(_dc)} 处 → {_dc[:4]}"
            f"{'…' if len(_dc) > 4 else ''}　数由 `handoff index` 每次写重建、`index` 维对账，"
            f"散文抄一份＝第二份无人同步的拷贝。"))

    # ---- v5.0 sealed（t000196①）：进 CLI **之前**的封存态快照（st._was_sealed）----
    # check 自己也要解锁才能跑，所以判的是「命令开始前」的状态：未封存说明有人/某
    # 工具把它 chmod 回来了，或这是该仓第一次跑 v5 CLI（跑完本次即自动回封）。
    # selftest 子模式不回封（夹具要手工写临时文件），本维跳过——封存行为由下方
    # 直接调用夹具＋「真 CLI 命令跑完自动回封」夹具覆盖，不是不测。
    if (SEAL_OK and st.d.is_dir() and not getattr(st, "_was_sealed", True)
            and getattr(st, "_store_preexisting", True)
            and os.environ.get("HANDOFF_SELFTEST_SUB") != "1"):
        errs.append(E("存储未封存", "sealed: 存储未封存（存在可写位）"))
    elif not SEAL_OK and st.d.is_dir() and os.environ.get("HANDOFF_SELFTEST_SUB") != "1":
        # v5.18.0（v2.0 B′）：**非 POSIX 上没有封存这道闸**（chmod 语义不封存，
        # `SEAL_OK = os.name == "posix"`）——过去这里是**静默跳过**，绿灯被读成「已封存」。
        # 显式化：告诉使用者这个平台上真正的防线只有「写事件对账」这一道。
        # 只提示不拦：拦了也没用（没有可执行的修法），且会把「平台差异」误报成「存储坏了」。
        print("sealed: 提示：此平台无封存保护（封存＝POSIX 的 chmod 机制）——"
              "实际防线只有「写事件对账」这一道；手改存储仍会被抓到，但不是内核级拦截。",
              file=sys.stderr)
    # ---- v5.0 archive（t000196②）：冷档行完整性 ----
    arc = st.d / ARCHIVE_DIR
    if arc.is_dir():
        for f in sorted(arc.glob("*.jsonl")):
            bad = False
            for ln in f.read_text(encoding="utf-8").splitlines():
                if not ln.strip():
                    continue
                try:
                    r = json.loads(ln)
                    if not isinstance(r, dict) or "archived" not in r or "text" not in r:
                        raise ValueError
                    if not _ARCHIVE_DATE_RE.match(str(r["archived"])):
                        raise ValueError
                except Exception:
                    bad = True
                    break
            if bad:
                errs.append(E("冷档畸形行", f"archive: {f.name} 存在畸形行（须 JSON 且带合法 archived/text）"
                            f"——冷档只经 `append`/`compact` 写入，手改请回退"))
    # ---- v5.16 agents-block：交接块单源（有标记区才启用）----
    # 各仓装不装块由自己的 AGENTS.md 决定：无 AGENTS.md／无标记区一律跳过，
    # 否则未装块的仓每次入场都会被这条误伤。判据与 `agents-block --check` 同源。
    # v5.18.0（v2.0 A′）：**判据与修复分离**——check 默认**只报不改**。为什么改：
    # 门禁顺手改使用方的文件是**副作用**，而退出码不承载「我改过你的文件」⇒ CI 判绿、
    # 人只在 stderr 看见一句提示（易丢）；且同一个技能里两张脸结论相反——显式
    # `agents-block --check` 对漂移报 FAIL，check 却把它修掉并报 OK。
    # 修复走显式 `handoff check --repair`，痕迹落 store 的**既有事件流**（log.jsonl），
    # **不新增退出码**（0/1/2 含义不动，2 仍是 `view --id` 的「查不到」）。
    # d000134（2026-10-21 裁定「能机器做的事别留成人再跑一遍」）的**动机**由 `--repair`
    # 兑现（一条命令搞定），但**边界**变了：判据不再顺手改别人的文件。
    # **档位的期望值取自独立证据**（2026-10-23，t000406）：「装过块」那条 d 型记录里
    # 记着本仓**应当**用的档位 ⇒ 判据按它比，而不是按文件自己说的档位比
    # （旧形按文件自报 ⇒ 静默降级即自证通过 ⇒ 降级对所有闸不可见）。
    _ab_profile = _block_install_profile(st)
    _ab = inspect_agents_block(st.root_dir, profile=_ab_profile)
    if _ab["state"] in ("drift", "partial", "duplicate", "error"):
        _root = st.root_dir
        _fixed = False
        _auto_err = False
        if _ab["state"] in ("drift", "duplicate"):
            if not repair:
                # 只报、不改：文案必须自带**一条可执行命令**（判据的修法不许留给人猜）。
                errs.append(E("交接块与唯一源不一致", f"agents-block: {_ab['file']} 的交接块与唯一源不一致"
                            f"（{_ab['state']}）——**check 不改你的文件**", root=_root))
            else:
                _prof = _ab.get("effective", "basic")
                _new_text, _verb, _conv, _salv = install_block(_ab["text"], agents_block_text(_prof))
                if _verb == "残缺标记":
                    _auto_err = True
                    errs.append(E("交接块标记残缺", f"agents-block: {_ab['file']} 标记残缺，无法自动收敛——"
                                "**必须先解决**：补全或删掉残端，再重跑 check"))
                else:
                    try:
                        _ab["file"].write_text(_new_text, encoding="utf-8")
                    except OSError as e:
                        _auto_err = True
                        errs.append(E("装块失败", f"agents-block: 自动安装标准块失败（{e}）——"
                                    f"**必须先解决**：确认 {_ab['file']} 可写后重跑 check", root=_root))
                    else:
                        _re = inspect_agents_block(_root, profile=_ab_profile)
                        if _re["state"] == "ok":
                            _fixed = True
                            # 痕迹落**既有事件流**：机器可读、`handoff log` 可见。
                            # 「搬走了哪些行」也进事件（内容不丢但位置变了——得可回查）。
                            _moved = list(_ab.get("extra") or [])
                            print(f"agents-block: 已按唯一源重装（{_verb}）→ {_ab['file']}")
                            if _moved:
                                print(f"  ⚠ 块内 {len(_moved)} 行源里没有的内容已搬到块外"
                                      f"「{REPO_HOME}」区，请过目。")
                            _log(st, "agents-block:repaired", file=str(_ab["file"]), verb=_verb,
                                 moved=len(_moved))
                        else:
                            _auto_err = True
                            errs.append(E("重装后仍不一致", f"agents-block: 自动安装后仍不一致（{_re['state']}）——"
                                        f"**必须先解决**", root=_root))
        if not _fixed and not _auto_err:
            if _ab["state"] == "error":
                errs.append(E("读不了交接块", f"agents-block: 读不了 {_ab['file']}（{_ab['error']}）"
                            "——**必须先解决**：确认文件可读后重跑 check"))
            elif _ab["state"] == "partial":
                errs.append(E("交接块标记残缺（带坐标）", f"agents-block: {_ab['file']} 的交接块标记残缺"
                            f"（begin {_ab['begin']}／end {_ab['end']}）——"
                            f"**必须先解决**（check 不猜着修）", root=_root))

    # ---- v5.19.0 F′：装过块、现在块不见了（**可选维**：没装过块的仓不启用）----
    # 事实落在**库里**（一条 d 型「事实登记」），不在会被删掉的那个文件里 ⇒
    # 「装过」与「没装过」在证据上可区分 ⇒ 最重的漂移形态能被报。
    _brec = _block_install_record(st)
    if _brec is not None:
        _bstate = inspect_agents_block(st.root_dir)["state"]
        if _bstate in ("no-markers", "missing"):
            # 修法只列**此刻真的能跑**的那条：标记区已经没了 ⇒ `check --repair`
            # 无块可修（它只重装**已有**块区），能跑的是 `agents-block --install`。
            # 「报错自带出口」里的出口必须当场可执行，否则报错就在骗人。
            errs.append(E("装过块却找不到标记区", f"agents-block: 本仓**装过**交接块（库内记录 {_brec.stem}），"
                        f"现在 AGENTS.md 里找不到标记区了（{_bstate}）——最重的漂移形态。", root=st.root_dir, rec=_brec.stem))

    # v5.44.0：`rewrite-points` 维——机制面重述点只许待在**豁免名单**里（双向对账）。
    _rw = rewrite_gate_violations(Path(__file__).resolve().parent.parent)
    if _rw:
        errs.append(E("重述点与豁免对不上", "rewrite-points：机制面重述点与豁免名单**对不上**——"
                    + "；".join(_rw[:3])))

    # v5.52.0：`discipline-present` 维——机制面纪律**必须写在随件文档里**（纪律只进闸
    # ⇒ 改包的人不知道有它 ⇒ 纪律事实上没落地）。
    _dp = discipline_present_violations(Path(__file__).resolve().parent.parent)
    if _dp:
        errs.append(E("纪律没进随件文档", "discipline-present：机制面纪律**没写在随件文档里**——"
                    + "；".join(_dp[:3])))

    if errs:
        print(f"handoff check: FAIL（{len(errs)} 处）")
        for e in errs:
            print(f"  - {e}")
        # v5.33.0 出路律：**门禁 verdict 之后立刻给下一步**（用户不必记住流程）。
        for _line in _now_next(st):
            print(_line)
        if not no_log:
            _log(st, "check:fail")
        return 1
    if not store_has_entries(st):
        print("handoff check: 提示：无任何条目——新项目正常；若刚迁移，通常意味着清单未成功导入", file=sys.stderr)
    # id 空洞：**只报不拦**（t000238①，用户 10-12 裁）。为什么不拦——各仓都有历史空洞
    # （迁移未带入、决策被撤、早期丢数据，来源异质），硬失败等于把存量 store 锁死；
    # 且「分配过又丢了」与「从来没分配过」在落盘证据上**无法区分**（`log.jsonl` 只记
    # check 与 close、不记 id 分配）⇒ 没有免基线的分法。写时静默丢失已由各写命令的
    # `echo_back strict` 兜住（v5.1.3/5.1.4），这条只负责让盲区**可见**。
    # ⚠ **v5.55.0（t000447）：这条提示也有体量口径**——只报不拦≠可以铺开写：
    #   旧形把每个前缀的空洞 id **全部列在一行**（实测：一次 900 个 ≈ 4 KB 单行）
    #   ⇒ 真正的红项被淹在后面。⇒ 改成**计数 ＋ 摘要**（点名最低的几个，其余给计数）。
    _holes = _id_holes(st)
    if _holes:
        _tot = sum(len(v) for v in _holes.values())
        print(f"handoff check: 提示：id 空洞 {_tot} 个（≤ 最大号却不在 live∪closed∪"
              f"decisions∪void∪trash——只报不拦）：", file=sys.stderr)
        for _typ in sorted(_holes):
            _ids = _holes[_typ]
            _more = f" …（其余 {len(_ids) - HOLE_SAMPLE} 个未列）" if len(_ids) > HOLE_SAMPLE else ""
            print(f"  - {_typ} 前缀 {len(_ids)} 个：{' '.join(_ids[:HOLE_SAMPLE])}{_more}",
                  file=sys.stderr)
        print("  判不了成因（迁移遗留／被撤／早期丢数据三者在证据上同形）；"
              "若确认某批是历史遗留，登记后即可忽略。", file=sys.stderr)
    print("handoff check: OK")
    # v5.33.0 出路律：**verdict 之后立刻给下一步**（用户不必记住流程）——
    # 这一节由库里实况现算（`_now_next`），不是写死的文案。
    for _line in _now_next(st):
        print(_line)
    if not no_log:
        _log(st, "check:ok")
    return 0


# ---------------- write ----------------
def _norm_prio(v, kind: str) -> str:
    """`prio` 的唯一校验口：**闭集外一律拒收**，不做模糊匹配、不静默归位——
    判据输入必须是闭集查表而非相似度分数（模糊匹配族不进硬判）。"""
    if v is None:
        return PRIO_DEFAULT
    s = str(v).strip()
    if s not in PRIO_RANK:
        die(f"add {kind}: --prio 只收闭集 {'/'.join(PRIO_LEVELS)}（重要度降序），收到 {v!r}。"
            f"　不猜别名——旧版 high/med/mid 那一族别名正是「写了不认的词就悄悄落默认档」的入口。")
    return s


def guard_tier_prefix(cmd: str, summary: str | None) -> None:
    """summary 开头写档位前缀 ⇒ **拒收**（d000108）。

    前缀不再是排序来源，留着它就等于同一事实两个通道（且新通道改了、旧通道没人同步）。
    谓词＝`is_tier_prefix`（**词元查表**，d000111）：`[中]`／`[高·重定]` 是档位前缀（旧窄正则
    漏掉后一种 ⇒ 静默降级），而 `[高危]`／`[根因]`／`【已更正】` **不是**——上一版只要「以档位词
    开头」就拒，等于把兄弟仓在 pitfall 上标**严重度**的那 48 条（跨仓实算）一并禁掉、又不给替代写法。
    要标严重度请用不相交的词表 `高危/中危/低危`；要声明重要度只能用 `--prio`。
    """
    if not summary:
        return
    if is_tier_prefix(summary):
        die(f"{cmd}: 重要度不再写在 summary 前缀里（收到 {summary[:24]!r}）——"
            f"前缀已**不是排序来源**，留着它就是一条没人同步的假通道。"
            f"　修法：去掉前缀，改用 `--prio <{'/'.join(PRIO_LEVELS)}>`；"
            f"想标**严重度**请写 [{'/'.join(SEVERITY_TAGS)}]（不参与排序）；存量走 `handoff upgrade-prio`。")
    elif _BRACKET_HEAD.match(summary):
        print(f"  提示：`{summary[:14]}…` 这类方括号前缀**不参与排序**（重要度只认 prio 字段）。")


def cmd_add(st: Store, kind: str, f: dict) -> int:
    """按**型**登记条目。`f` 的键集＝该型子命令声明的 flag（两侧同源，见 ADD_KINDS）。

    旧 `cmd_add(st, a)` 收整个 Namespace ＋ `--slot` 分流，是「参数并集 ⊃ 消费子集」的成因；
    现签名收显式 dict，未消费的键在结构上不可能出现，且真出现（改了声明忘了改这里）由下方
    drift 守卫当场报错——**静默丢弃在本 CLI 里不再是可达状态**。

    **`decision` 型的写入面纪律**（2026-10-20，t000333 落地）：
    **凡落一条裁定 ⇒ 先 `handoff add decision` 立件，再把它的号（`dNNNNNN`）写进同一段
    散文**——裁定件是机器唯一读得到的裁定落点；只写在散文里的裁定机器读不到。**病根实例**：
    2026-10-19 那次「审计报告合不合规不属本仓门禁」的裁定只落当班 exit 散文、当时未立件 ⇒
    销账链与补位策略都读不到它（补立见 d000118；该补记写明「原裁定 10-19 落散文」，
    **不伪装成当时就立了**）。
    **例外**：**外派授权**走台账、不走裁定件——`dispatch-precheck.py record` 落 grant 事件
    （机器可读面＝`dispatch-ledger.jsonl`）。
    **收尾对账**：用维护仓自带的裁定台账对账工具（库专属手动工具，不随件分发；判 2 维＝
    裁定号闭合／外派授权闭合；③「裁定记录候选」**只告警不判红**——「散文记录了裁定」这个
    形态不可穷举，模糊匹配族不进硬门禁）。
    """
    st.note_pre_tamper()          # 写前旁证快照（本次写自己的 mtime 变化不算外部改动）
    spec = ADD_KINDS[kind]
    slot, part_key = spec["slot"], spec["part"]
    consumed = ({"title", "body", "status", "supersedes", "domain", "topic"} if slot == DOC_SLOT
                else {"summary", "prio", "status", "blockedBy", "waitingFor", "topic", "src",
                      "detail", part_key})
    ff_keys: set = set()
    ff = f.pop("_from_file", None)
    if ff:
        got = load_from_file(f"add {kind}", ff, set(consumed))
        # 同一字段同时给了 flag 与文件：**报错**，不静默取一个（静默丢弃是老病）。
        # 只比**真正给了值**的 flag —— `{k: v for k in fields}` 里键恒存在、值常为 None，
        # 直接比键集会把「没传的」全判成冲突。
        dup = sorted({k for k, v in f.items() if v is not None} & set(got))
        if dup:
            die(f"add {kind}: 字段 {dup} 同时出现在命令行与 --from-file；只留一处")
        f.update(got)
        ff_keys = set(got)
    # v5.0 内容硬限（t000196④）：summary/detail 是条目的全部体积，源头限长。
    # ⚠ **必须跑在 --from-file 合并之后**（v5.12.1 修）：原写法在合并前跑，于是
    # 「不经 shell 的入口」把闸整个绕开——实测 300 字的 summary 经 --from-file 直接落盘，
    # 而 SKILL.md 明写「条目 summary ≤120 字……超限即拒」。同一形状在 close 上是第二条
    # （空 outcome 也能从文件溜进来，p000051 那个洞在 from-file 面重开），在 unconfirmed
    # 上更是**根本没闸**。⇒ 规矩：**凡是吃自由文本的守卫，一律跑在值最终确定之后。**
    guard_len(f"add {kind}", "--summary", f.get("summary"), SUMMARY_CAP)
    guard_single_line(f"add {kind}", f.get("summary"))
    guard_len(f"add {kind}", "--detail", f.get("detail"), DETAIL_CAP)
    doc_touched: list = []
    for k in sorted(consumed):
        require_text(f"add {kind}", f"--{k}", f.get(k),
                     from_shell=k not in (ff_keys if ff else set()))
    if slot == DOC_SLOT:
        if not f.get("title"):
            die("add decision: 需要 --title")
        # **写入面守卫**：`--title` 会被写成正文 H1（见下方 text 拼装），`--body` 已是正文体。
        # 两者逐字重复 ⇒ 文件里 H1 与正文首行同一句（d000097／d000102 实测 95 份决策件里 2 份）。
        # **成因不在工具**：拼装只做 `# {title}\n\n{body}`，从没把 title 塞进 body——
        # 是调用方把标题又写了一遍进 `--body`。按「信任边界输入校验」在这里拦，
        # 且**报错而不是静默剥**：静默剥会把调用方的笔误藏起来，下次照抄。
        _first = (f.get("body") or "").lstrip("#").strip().split("\n")[0].strip()
        if _first and _first == f["title"].strip():
            die(f"add decision: --body 首行与 --title 完全相同（{_first!r}）——"
                f"标题已被写成正文 H1，body 里不必再写一遍。"
                f"修法：删掉 --body 里这行重复的标题（不是把 --title 去掉）。")
        did = st.allocate("d")
        st.decisions_dir().mkdir(parents=True, exist_ok=True)
        # 写入面校验（信任边界）：status 在闭集外就当场拒，不靠 `check` 事后红——
        # 错值落盘后唯一能改它的路又是 `rm` ＋ 重加（换 id、改 created，d000112）。
        if f.get("status") and f["status"] not in DECISION_STATUSES:
            die(f"add decision: --status {f['status']!r} 不在闭集 "
                f"{'/'.join(DECISION_STATUSES)}")
        text = f"---\nid: {did}\ncreated: {today()}\nstatus: {f.get('status') or 'accepted'}\n"
        for k in ("supersedes", "domain", "topic"):
            if f.get(k):
                text += f"{k}: {f[k]}\n"
        text += f"---\n# {f['title']}\n\n{f.get('body') or ''}\n"
        doc = st.decisions_dir() / f"{did}.md"
        doc.write_text(text, encoding="utf-8")
        new_id = did
        doc_touched = [doc]
    else:
        if not f.get("summary"):
            die(f"add {kind}: 需要 --summary")
        guard_tier_prefix(f"add {kind}", f.get("summary"))
        guard_status(kind, f.get("status"))
        guard_waiting_for(f.get("waitingFor"))
        guard_blocked_by(st, f"add {kind}", f.get("blockedBy"))
        e = {"id": st.allocate(ENTRY_SLOTS[slot]["type"]), "created": today(),
             "createdAt": now_iso(), "summary": norm(f["summary"])}
        # v5.30.0 刀 F：记下**出生班次**（「本班新增」判据改用班次序号 ⇒ 整数比较、无并列）
        e["bornShift"] = _current_shift_seq(st)
        for k in ("status", "blockedBy", "waitingFor", "topic", "src", "detail"):
            if f.get(k) is not None:
                e[k] = f[k]
        if slot == "actions":
            e["prio"] = _norm_prio(f.get("prio"), kind)
            if f.get("prio") is None:
                # 缺省＝中，但**不当静默处理**：落盘当场说出来。旧形「无前缀 ⇒ 悄悄算中」
                # 配合「`【接手第一优先】` 也被算中」，等于把作者最急的意图降了档还没人知道。
                print(f"handoff add {kind}: 未给 --prio ⇒ 重要度落「中」（闭集 {'/'.join(PRIO_LEVELS)}；"
                      f"要改走 `edit {e['id']} --prio <值>`）")
        part = guard_partition(f"add {kind}", part_key, f.get(part_key))
        append_jsonl(st.d / slot / f"{part}.jsonl", e)
        new_id = e["id"]
    if drift := set(f) - consumed:
        die(f"内部不一致：add {kind} 声明了 {sorted(drift)} 却无人消费（补 ADD_KINDS 或消费分支）")
    # v5.29.0：**没有「改池就复渲染队列区」这回事了**——区改为读时现算、不落盘 ⇒
    # 「每次改池都得记得复渲染」的写点清单整条消失（它历史上漏接过三次：v5.7.0 的
    # rm／edit／compact、t000405 的 supersede）。池的成员由 `refill_pool` 现算，
    # 读者看 `handoff view` 即得 ⇒ 没有任何存储态快照可以陈旧。
    # ⚠ t000405 那条修复（supersede ⇒ 被挡条目回池 ⇒ 区当场复渲染）在 v5.29.0 里
    # **改写成「回池这件事本身」**：回池由 `refill_pool` 的谓词现算，不需要任何写点。
    st.write_index(extra=doc_touched or None, ids=[new_id])
    print(f"handoff add {kind}: ok（slot={slot}） id={new_id}")
    echo_back(st, new_id, strict=True)
    return 0


def cmd_decide(st: Store, a) -> int:
    """裁定件 status 的**唯一改写路径**（v5.12.0／d000112）。

    此前决策文档**不可编辑**（`edit` 的可改字段按型分列，decisions 不在其中），
    `add` 只会分配**新** id ⇒ 「待追认的 proposed」既不能原地转正、又没有别的出口：
    唯一改法是 `rm` ＋ 重加，代价是**换 id ＋ created 记今天**。d000085 → d000086 那次
    重登就是这么来的（`t000172` 的 outcome 至今引着已不存在的 d000085，只能靠正文一句
    「重登说明」消歧）。状态既无出口、又不进补位池、也不被任何闸看见 ⇒ 「等你拍板」
    的裁定在库里是个**零消费点的态**：本仓两条（d000025 挂了 25 天、d000086 挂了 13 天）。

    本命令**只改 `status:` 那一行**：`id`／`created`／正文逐字不动（重登丢的正是前两样），
    所以不存在「为了让闸过而顺手改历史」这条路。落盘后该文件**进写事件对账面**
    （`write_index(extra=…)`）⇒ 此后手改 status 会被 `writes` 维抓住——没有这层，
    「唯一写路径」只是一句声明。

    **不提供 `--supersedes`**：接替一件旧裁定是**新事实**，走 `add decision --supersedes`
    立新件；让 `decide` 改旧件的字段就是原地改历史。

    **`--freezes <tid>...`（t000313）**：在改 status 的同一命令里，把点名的 live action
    的 `blockedBy` 写成本裁定 id——「冻结」此前只活在裁定件正文与 exit 散文里，机器读不到，
    补位策略会把用户明令「只登记不动手」的条目排在队首。只写 actions；先全量校验再落盘；
    已有别的 live `blockedBy` 则拒（不静默覆盖冻结指针）。只允许 `--status accepted`：
    冻结必须指向一条已生效的裁定。
    """
    if not re.match(r"^d\d{6}$", a.id or ""):
        die(f"decide: {a.id!r} 不是裁定件 id（形如 d000001）——本命令只改 `decisions/` "
            f"里的裁定件；条目请走 `edit <id> --status` / `close <id>`")
    p = st.decisions_dir() / f"{a.id}.md"
    if not p.is_file():
        die(f"decide: {p} 不存在——用 `handoff view --id {a.id}` 查它在册与否；"
            f"新裁定走 `handoff add decision --title …`")
    text = p.read_text(encoding="utf-8")
    fm_text, _body, ok = _fm_split(text)
    if not ok:
        die(f"decide: {p.name} 没有可解析的 frontmatter（首行须是整行 `---`）——"
            f"不猜边界，拒写；补上整行 `---` 头再跑，或另开一条："
            f"`handoff add decision --title \"…\"`")
    cur = _fm_parse(fm_text).get("status")
    if cur == a.status:
        die(f"decide: {a.id} 的 status 已是 {a.status!r}，无事可做——"
            f"空转也会刷新写事件、造一条「动过」的痕迹，所以拒", key="无事可做")
    # t000313：`--freezes` 是「冻结」的写入面——与 status 同批落，机器读得到。
    # 先全量校验再动任何字节：非 action、不存在、已有别的 live blockedBy 都当场拒。
    freeze_ids = list(dict.fromkeys(getattr(a, "freezes", None) or []))
    freeze_rows: dict[str, dict] = {}
    if freeze_ids:
        if a.status != "accepted":
            die(f"decide: --freezes 只能挂在 accepted 裁定上（本次 --status {a.status}）——"
                f"冻结必须指向一条已生效的裁定")
        live = {r["id"]: r for r in st.load_live() if r.get("_slot") == "actions"}
        missing = [i for i in freeze_ids if i not in live]
        if missing:
            die(f"decide: --freezes 点名的 {missing} 不是 live action"
                f"（本命令只冻结 actions；pitfall／command／decision 各有自己的状态面）")
        conflict = [i for i in freeze_ids
                    if live[i].get("blockedBy") and live[i]["blockedBy"] != a.id]
        if conflict:
            die(f"decide: --freezes 点名的 {conflict} 已有别的 live blockedBy——"
                f"不静默覆盖冻结指针；先 close 或另裁后再冻结")
        freeze_rows = {i: live[i] for i in freeze_ids}
    st.note_pre_tamper(extra=[p])
    # 改写走**原文本按 `\n` 切**而不是 `_fm_split` 的返回：后者用 `splitlines()`，
    # 会把 CRLF 件的 `\r` 一并吃掉，拿它回写等于顺手把该文件的 frontmatter 转成 LF
    # （正文还留着 `\r` ⇒ 一个文件两套行尾）。这里只换 status 的值，其余字节原样拼回。
    raw = text.split("\n")
    close_i = next((i for i in range(1, len(raw)) if raw[i].strip() == "---"), None)
    hit = 0
    if close_i is not None:
        for i in range(1, close_i):
            k, sep, _ = raw[i].partition(":")
            if sep and k.strip() == "status":
                raw[i] = raw[i][:raw[i].index(":") + 1] + " " + a.status + (
                    "\r" if raw[i].endswith("\r") else "")
                hit += 1
    if hit != 1:
        why = ("没有 status 行——本命令只改既有的那行，不新增"
               if hit == 0 else f"status 行有 {hit} 处")
        die(f"decide: {p.name} 的 frontmatter {why}（须恰好 1 处）——不猜，拒写；"
            f"修法：整理成一行再跑，或 `rm` 后 `add decision --status "
            f"{'|'.join(DECISION_STATUSES)}` 重立（注意重立会换 id）")
    p.write_text("\n".join(raw), encoding="utf-8")
    if freeze_rows:
        by_file: dict[Path, set[str]] = {}
        for i in freeze_rows:
            by_file.setdefault(freeze_rows[i]["_file"], set()).add(i)
        for f, ids in by_file.items():
            rows = _read_rows(f)
            for r in rows:
                if r.get("id") in ids:
                    r["blockedBy"] = a.id
            _write_rows(f, rows)
    st.write_index("decide", extra=[p])
    print(f"handoff decide: {a.id} status {cur} → {a.status}"
          f"（id／created／正文未动）")
    if cur in DECISION_TERMINAL:
        print(f"  ↳ {cur} 是**终态**，本次是回退——若那是纠错，在正文留一行说明；"
              f"要彻底改口请另立新裁定（旧件留史）")
    held = [r.get("id") for r in st.load_live() if r.get("blockedBy") == a.id]
    if held:
        # 入池第三道谓词读的是「文件在册且未被**别的裁定** supersedes」，**不读 status**
        # （这是 v5.2.0 刻意分开的口径：identity 与 efficacy 不同问）。不说清就会
        # 让人以为「标成 superseded 了，被挡的条目该自动回池」——它不会。
        print(f"  ↳ 但 {len(held)} 条 live 条目仍 `blockedBy` 本裁定：{' '.join(held)}"
              f"——**status 变了它们也不会自动回池**；解冻走「另立裁定 "
              f"`add decision --supersedes {a.id}`」或「close 那几条」")
    return 0


def _find_live(st: Store, id_: str):
    for r in st.load_live():
        if r.get("id") == id_:
            return r
    return None


# ---------------- next 自动补位（refill） ----------------
REFILL_STEP_DAYS = 30                      # 超期线：等够这么多天就在 next 输出里被点名（v5.7.0 起**不再升档**）
# ── v5.8.0／d000108：重要度是**字段**，不是 summary 前缀 ──────────────────────
# 为什么换通道（实测，不是偏好；数字＝2026-10-18 那次快照，会随闭单增长漂，别当现值读）：
# 已闭 `t` 型 **71.5%（191/267）落在「中」**（87 条显式
# `[中]` ＋ 104 条无前缀吃默认），三档实际退化成两档；更要紧的是前缀**会静默误读**——
# 旧窄正则要求档位词后紧跟闭括号，`[高·重定]`（t000107）／`[高·已过大半]`（t000224）
# 这类「作者想说要更急」的写法整条掉进默认档、零提示（本仓已闭 `t` 型实测 2 例，另有
# v5.11.0／d000111 又把判法换成**词元查表**（`is_tier_prefix`）：`[高危]` 这类严重度标注
# 不再被当成 `[高]`——兄弟仓在 pitfall 上标严重度的有 48 条，一刀切就是删别人的语义。
# `【接手第一优先】` 一条属**非档位形状**，前缀判据管不到、更没人提醒）。⇒ 前缀不再参与
# 排序，且**写入时拒收**（见 `guard_tier_prefix`）；留着的旧前缀由 `check` 的 `prio-source`
# 维对上，单通道不由人自觉。
# ⚠ 闭集**只有这五个词**，不给 high/med/mid 之类别名：别名表本身就是上一版静默降级的
#   入口之一（`med` 认、`medium-ish` 不认 ⇒ 悄悄落默认）。写错必拒，且报错里列出闭集。
PRIO_LEVELS = ("急", "高", "中", "低", "缓")                  # 顺序即重要度降序
PRIO_RANK = {k: i for i, k in enumerate(PRIO_LEVELS)}        # 急0 … 缓4；缺省视作「中」=2
PRIO_DEFAULT = "中"
# 旧三档的**排序标度**：只留给夹具复算「旧形会排出什么次序」（迁移安全线的对照组用），
# 不再是任何判定或写入路径的输入。
PRIO_BASE = {"高": 0, "high": 0, "中": 1, "med": 1, "medium": 1, "mid": 1, "低": 2, "low": 2}

# ── v5.11.0／d000111：档位前缀的判定改**词元查表**，并给严重度让出一个不相交的词表 ──
# 为什么换判法（实测，不是审美）：上一版的 `TIER_PREFIX_RE` 只要求「括号里以档位词**开头**」，
# 于是 `[高危]` 也被当成 `[高]`——而兄弟仓恰恰在 pitfall 上用 `[高]/[中]/[低]` 标**严重度**
# （跨仓实算：22 个有 store 的仓里 6 个受影响、live 56 条，其中 **pitfalls 48／actions 8**）。
# 一刀切拒收等于顺手删掉别人的另一种语义。⇒ 现在按**词元**判：取开头括号里的第一段
# （以 `·，、:;／-` 或空白切分），**整个词元落在档位闭集里**才算档位前缀。
# 效果：`[中]`／`[高·重定]` 仍是档位前缀（拒收／可回填），`[高危]`／`[根因]`／`【已更正】` 不是。
# 严重度的正规写法＝`高危／中危／低危`（与排序词汇**不相交**），所以双解不需要靠「按槽分面」维持。
# ⚠ 已知残余：`[high-severity]` 的词元是 `high` ⇒ 仍按档位前缀拒（英文仓要写 `[highsev]` 或不带括号）。
#   这是闭集查表的代价，如实记在这里，不改成相似度匹配（那会把判定面变成猜）。
TIER_TOKENS = {"急", "高", "中", "低", "缓", "high", "med", "medium", "mid", "low"}
SEVERITY_TAGS = ("高危", "中危", "低危")            # pitfall／command 的标注词表（不参与排序）
SEVERITY_MAP = {"高": "高危", "中": "中危", "低": "低危"}   # 存量保义改写的映射；急／缓**不猜**
_BRACKET_HEAD = re.compile(r"^\s*([\[【])([^\]】\n]{1,16})([\]】])")
_TOKEN_SPLIT = re.compile(r"[·．.,，、:：;；/／|\s\-—]+")


def tier_head(summary: str | None):
    """开头若是「括号里第一段＝档位词」⇒ 返回 (左括号, 括号内原文, 右括号)；否则 None。"""
    m = _BRACKET_HEAD.match(summary or "")
    if not m:
        return None
    tok = (_TOKEN_SPLIT.split(m.group(2).strip(), 1) or [""])[0].strip().lower()
    return (m.group(1), m.group(2), m.group(3)) if tok in TIER_TOKENS else None


def is_tier_prefix(summary: str | None) -> bool:
    """档位前缀的唯一谓词（写入面拒收、`prio-source` 判据、迁移三处共用，不抄第二份）。"""
    return tier_head(summary) is not None


def tier_token_of(summary: str | None) -> str:
    head = tier_head(summary)
    return "" if head is None else _TOKEN_SPLIT.split(head[1].strip(), 1)[0].strip().lower()


def strip_tier_head(summary: str | None) -> str:
    """剥掉**档位词本身**，限定语留在原括号里：`[高·用户自持，勿催] x` → `[用户自持，勿催] x`；
    `[高] x` → `x`。限定语是作者的指令，删它就是迁移毁语义（d000111 立这条的原因）。"""
    m = _BRACKET_HEAD.match(summary or "")
    if m is None or tier_head(summary) is None:
        return summary or ""
    rest = (_TOKEN_SPLIT.split(m.group(2).strip(), 1) + [""])[1].strip()
    new_inner = f"{m.group(1)}{rest}{m.group(3)}" if rest else ""
    out = (summary or "")[:m.start()] + new_inner + (summary or "")[m.end():]
    return out.lstrip() if not rest else out


def severityize(summary: str | None) -> str | None:
    """非 action 槽的保义改写：`[中]` → `[中危]`、`[高·X]` → `[高危·X]`；`急/缓` 读不出对应词 ⇒ None（不猜）。"""
    tok = tier_token_of(summary)
    sev = SEVERITY_MAP.get(tok)
    if not sev:
        return None
    head = tier_head(summary)
    rest = (_TOKEN_SPLIT.split(head[1].strip(), 1) + [""])[1].strip()
    inner = f"{sev}·{rest}" if rest else sev
    return re.sub(r"^\s*[\[【][^\]】\n]{1,16}[\]】]", f"{head[0]}{inner}{head[2]}", summary or "", count=1)
# 旧三档→新五档是**保序映射**（高1→1、中2→2、低3→3），故回填后池序与现状逐条相同
# ——这条就是 d000108 要的负控。别名走 PRIO_BASE 的键，不另立名单。
LEGACY_TO_PRIO = {"高": "高", "中": "中", "低": "低", "high": "高", "med": "中",
                  "medium": "中", "mid": "中", "low": "低"}


def _age_days(created: str) -> int:
    if not DATE_RE.match(created or ""):
        return 0
    try:
        return max(0, (date.today() - date.fromisoformat(created)).days)
    except ValueError:
        return 0


def alive_ids(st: Store) -> set[str]:
    """**还活着的** id：live 条目 ＋ `decisions/*.md`，减去已作废（`rm` 落 trash/）的。

    **已关闭（`closed/`）的条目不在此集内**（t000255）。这不是疏忽，是把两件不同的事分开：
      · 「id 还在不在」——身份问题，判删除守卫、判文本死指针用（那些场景下 closed 确实算存在）。
      · 「这件事还挡不挡人」——效力问题，读本集。**关掉一条目＝它要办的事有结论了**
        （办完，或被判定不值得办），等着它的人本来就该重新决策；继续把它当挡路石，
        等于让那条目「无人接手但谁也看不见」（t000155 等 t000152，t000152 已于 10-05 闭，
        而 t000155 至今仍写着 blocked——补位池第三道谓词说它没被挡、入池第二道谓词说它被挡）。

    被 supersede 的裁定同样**不算**（v5.2.0）：文件在册 ≠ 还有效力，解冻的常规动作是「立一条新
    裁定 supersede 旧的」，不是删文件。
    """
    void = set(_void_ids(st))
    alive: set[str] = set()
    for r in st.load_live():
        i = r.get("id")
        if i and i not in void:
            alive.add(i)
    # **decision 也在册**（`decisions/<id>.md`）。漏了这一片就会踩本函数自己写下的那个分叉：
    # 挡人的是「发布冻结」这类**裁定**时，blockedBy 指向的是 dNNNN 而非 t/p 条目，
    # 于是这里判「它不在册」⇒ 条目回池，而 `rm dNNNN` 的守卫却还在拦它删——
    # 同一对事实两处读成两个结论。`rm` 的 blockedBy 循环本来就对 decision 无条件生效，
    # 这里跟着对齐即可（两者读的是同一个「id 还活着」的闭集）。
    ddir = st.decisions_dir()
    if ddir.is_dir():
        for d in ddir.glob("*.md"):
            if d.stem not in void:
                alive.add(d.stem)
        # **被 supersede 的裁定不再挡人**（v5.2.0）。文件还在册 ≠ 还有效力：解冻的常规
        # 动作是「立一条新裁定 supersede 旧的」，不是删文件。只判「存在」的话，解冻后
        # 挡路的那条仍在册 ⇒ 条目被永久踢出池——把原病（指针停在死条件上）换了个方向重犯，
        # 而且更隐蔽：症状从「第一眼撞死活」变成「有条目永远轮不到」。
        # 与 `rm` 的 supersedes 守卫读同一个 frontmatter 字段，口径对齐。
        for d in ddir.glob("*.md"):
            sup = _fm_fields(d.read_text(encoding="utf-8")).get("supersedes")
            if sup and sup not in void:
                alive.discard(sup)
    return alive


def blocking_ids(st: Store) -> set[str]:
    """**仍然挡着别人**的 id 集合（取自 live 行的 `blockedBy`，且该 id 仍活着）。

    口径**只**与入池谓词③对齐；与 `rm` 的守卫（`blockedBy == i` ⇒ 拒删）**故意不同**：
    那处判的是「这个 id 还有没有实体可删」，是身份问题；本处判「它还挡不挡人」，是效力问题。
    两处曾被强行对齐（v5.2.0 注释写着「同一对事实两处读成两个结论」）——那个对齐本身
    就是 t000255 的病根：一旦 blocker 被 `close`，删除守卫该拦的照拦（对象还在 `closed/`），
    而「还挡不挡人」已经该答否了，两者不是同一问。t000196（blockedBy=d000088 裁定、
    用户明令冻结）两种口径答案相同，故那次对齐没暴露问题。
    """
    alive = alive_ids(st)
    return {r.get("blockedBy") for r in st.load_live()
            if r.get("blockedBy") and r["blockedBy"] in alive}


def blocked_dead_rows(st: Store) -> list[tuple[str, str]]:
    """**⑲ blocked-stale** 的判据：`(id, blocker)` 列表——`status=blocked` 却指着
    一个已经**不再生效**的 blocker（已 close／已作废／被 supersede／查无此 id）。

    这不是笔误级的小瑕疵，而是**两处对同一对事实读出两个结论**：补位池第三道谓词
    （t000242）按「blocker 还生效吗」判 ⇒ 谓词说它**没被挡**；入池第二道谓词按
    `status == open` 精确排 ⇒ 又说它**被挡**。两头一夹，它既不会被补位选中，也不会出现在
    「被阻」的实质理由里——实际状态是**无人接手但谁也看不见**（t000255 实例）。

    刻意**只**判这一种矛盾，不判「`status=blocked` 却没写 `blockedBy`」：那只是没记
    指向，不是自相矛盾，补位池的两道谓词对它给不出相反结论，判红即为误报。
    """
    alive = alive_ids(st)
    out = []
    for r in st.load_live():
        if (r.get("status") or "open") != "blocked":
            continue
        bb = r.get("blockedBy")
        if bb and bb not in alive:
            out.append((r["id"], bb))
    return out


def _pool_exclusion(r: dict, blocking: set[str], exclude: str = "") -> str | None:
    """补位池的**入池谓词（唯一源）**：入池返回 None，被排除返回**排除原因**。

    `refill_pool`（渲染区、补位）与 `fresh-queue` 判据（哪些条目散文必须点名）
    **共用这一份实算**——判据里再写一遍谓词，就是本仓反复在治的「同一条规则抄第二份必分叉」
    （p000085/p000147 同族）：那份分叉会让判据把该管的漏掉、把不该管的报出来，
    而两边都看不出成因。

    **排除原因分两类**（R 的判据据此分工）：
      - 「推不动」＝`status≠open`／`waitingFor` 非空／`blockedBy` 指向活着的裁定
        ⇒ 渲染区的入池谓词**恰好**排掉它们 ⇒ 区**装不下** ⇒ 散文必须点名；
      - 「关掉的那条」＝`exclude`（close 两阶段化用的过渡参数）⇒ 不是一类，判据不用它。
    """
    if exclude and r.get("id") == exclude:
        return "关闭中"
    if (r.get("status") or "open") != "open":
        # 仅 open 入池（t000138：只精确排 blocked 会放进 status=closed 的半关行；blocked＝等待中也不补位）
        return f"status={r.get('status') or 'open'}"
    if r.get("blockedBy") in blocking:
        # t000242：卡在还活着的东西上 ⇒ 不当决策点。
        return f"被 {r.get('blockedBy')} 挡住"
    if r.get("waitingFor"):
        # v5.18.0（G′）：等所有者/等用户/等外部条件 ⇒ 同样不是现在能推的活；
        # 但它没有库内 id 可指，所以不靠 blockedBy 表达。
        return f"等 {r.get('waitingFor')}"
    return None


def _prose_writes(st: Store) -> list[dict]:
    """写事件台账里的**散文写入事件**（按发生顺序）——**班次台账缺失时的重建源**。

    什么算「散文写入」：`append exit`（追加一个班段）与 `set exit`（整槽覆写散文）。
    **不算**的：`sync-queue`（只剥旧库残留的区、散文原样保留）、`compact exit`
    （只把旧班段搬冷档）、以及一切 `add`／`close`——它们都不写散文。
    把它们算进来 ⇒ 边界会被无关写入一次次推前 ⇒ 新条目随即逃出增量。
    ⚠ v5.29.0 起 `sync-queue` **没有位置参数**（旧 docstring 写的 `sync-queue exit`
      是假称：`handoff sync-queue exit` 会被 argparse 当成多余参数拒掉）。

    v5.30.0 刀 F 起，本函数**只**用于「班次台账还没有」的老库**重建**（迁移兜底）。
    """
    wl = st.d / WRITES_LOG
    if not wl.is_file():
        return []
    return [e for e in read_jsonl(wl)
            if isinstance(e, dict) and e.get("op") in ("append exit", "set exit")]


def _shift_records(st: Store) -> list[dict]:
    """**班次台账**（`shifts.jsonl`）的记录，按 `seq` 升序（v5.30.0 刀 F）。

    一条记录＝一次**散文写入**（`append exit`／`set exit`）——不是一切写：
    `compact exit`（只搬冷档）、`sync-queue`（只剥残留）、`add`／`close` 都不算
    ⇒ 把它们算进来，边界会被无关写入一次次推前 ⇒ 新条目随即逃出点名义务。

    为什么单独建一个台账，而不用**写事件台账**（`writes.jsonl`）：
      · 写事件台账会被 `compact-writes` **折叠**、被 `rebase --force` **重置**
        ⇒ 拿它当界碑，边界会随台账维护动作漂移；
      · 班次台账是**独立、单调、不折叠**的事实 ⇒ 界碑是**落盘证据**，不是推断。

    **迁移兜底**：v5.30.0 之前建的库还没有这个文件 ⇒ 从写事件台账**重建**（散文写入
    事件按顺序编号）⇒ 界碑与升级前**逐字一致**（老条目走时刻兜底 ⇒ 判定不变、
    牙不放松）；老库的**下一次**散文写入会把重建结果落盘，之后班次台账即唯一源。
    """
    p = st.d / SHIFTS_FILE
    if p.is_file():
        rows = [r for r in read_jsonl(p)
                if isinstance(r, dict) and isinstance(r.get("seq"), int)]
        return sorted(rows, key=lambda r: r["seq"])
    return [{"seq": i + 1, "ts": str(e.get("ts") or ""), "op": e.get("op")}
            for i, e in enumerate(_prose_writes(st))]


def _current_shift_seq(st: Store) -> int:
    """当前班次序号＝**已发生的散文写入次数**（还没有则 0）。条目登记时记进 `bornShift`。"""
    recs = _shift_records(st)
    return int(recs[-1]["seq"]) if recs else 0


def _append_shift(st: Store, op: str, covers: list[str] | None = None,
                  refs: list[str] | None = None) -> int:
    """给一次散文写入记下班次序号（append-only ⇒ 序号单调、永不复用）。

    `covers`（v5.31.0 壬-2）：作者**声明**本段覆盖的条目 id ⇒ 记进**班次台账**的同一条
    记录 ⇒ 判据读它（**落盘证据**），不再解析散文文本 ⇒ 散文回归纯叙述。
    v5.45.0（refs 化）：`refs`＝**写时从本段散文里提取的点名 id** ⇒ 覆盖的**主路**
    （作者成本 0：散文里提到就覆盖）；`covers` 降级为**例外出口**（几十条 id 提不动时打包）。
    **两个字段都没有**＝这次班段是 v5.45.0 之前写的 ⇒ 判据退回**老口径扫散文**（迁移不误伤）。
    """
    p = st.d / SHIFTS_FILE
    recs = _shift_records(st)
    seq = (int(recs[-1]["seq"]) + 1) if recs else 1
    rec = {"seq": seq, "ts": now_iso(), "op": op}
    if covers is not None:
        rec["covers"] = sorted(set(covers))
    if refs is not None:
        rec["refs"] = sorted(set(refs))
    existed = p.is_file()
    with open(p, "a", encoding="utf-8") as f:
        if not existed:
            # 迁移：先把**重建**出来的历史班次落盘（老库的界碑与升级前逐字一致）
            for r in recs:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return seq


def _shift_covered(st: Store) -> tuple[set[str] | None, bool]:
    """最近班段的**覆盖集合**与它是不是**老班段**（v5.45.0 refs 化）。

    覆盖集合＝**班段散文里点到的 id**（refs，写时提取、落在班次台账里）
    ∪ **结构化声明**（`--covers`，批量出口）⇒ 散文里提到就覆盖（作者成本 0）
    ⇒ 覆盖事实的**原件**是散文 ⇒ 声明不再须作者另写一份（不是第二份陈述）。

    返回 `(集合, False)`＝新班段（按集合判）；返回 `(None, True)`＝**老班段**
    （既没有 `refs` 也没有 `covers` 字段 ⇒ v5.45.0 之前写的）⇒ 判据退回**旧口径**
    （扫散文文本，逐字与升级前一致 ⇒ 迁移不误伤）。

    为什么单独抽成函数：口径的**选择**本身要能被夹具**变异自证**（把它换掉 ⇒ 结论必须
    反转 ⇒ 证明那个绿真是「按集合判」带来的，不是「判据压根不报」的空腿）。
    """
    recs = _shift_records(st)
    latest = recs[-1] if recs else None
    if not latest:
        return None, True
    has_refs = "refs" in latest
    has_covers = "covers" in latest
    if not has_refs and not has_covers:
        return None, True
    out: set[str] = set()
    if has_refs:
        out |= {str(x).lower() for x in (latest.get("refs") or [])}
    if has_covers:
        out |= {str(x).lower() for x in (latest.get("covers") or [])}
    return out, False


def _pending_cover_ids(st: Store) -> list[str]:
    """**自上一班以来新增**、因而必须被本段声明覆盖的条目（v5.31.0 壬-2）。

    边界取法与判据面**同一个函数**（`_shift_boundary(st, offset=-1)`＝「上一次散文写入」）
    ⇒ 口径只有一份 ⇒ 写入面与判据面不会各算各的（分叉＝两处结论不一致的起点）。
      · 写入面：界碑＝**上一次**散文写入 ⇒ 本段必须覆盖「它之后新增的条目」；
      · 判据面：界碑＝**上上一次**散文写入 ⇒ 最近班段必须覆盖同一批。
    ⇒ 两处算出来的集合一致 ⇒ 写入面能**提前**挡住「写完班段再红」。
    """
    bnd = _shift_boundary(st, offset=-1)
    out: list[str] = []
    for r in st.load_live():
        if r.get("_slot") != "actions":
            continue
        rid = r.get("id") or ""
        if not rid_re_match(rid) or rid[0] != "t":
            continue
        if r.get("origin") == "import":      # 导入存量不算本班新增（v5.29.0 刀3）
            continue
        if _is_shift_new(r, bnd):
            out.append(rid)
    return sorted(out)


def _shift_boundary(st: Store, offset: int = -2) -> dict:
    """「本班新增」的判定边界（v5.30.0 刀 F：**班次序号**——显式、单调、与时钟无关）。

    返回 `{"seq": int|None, "ts": str|None}`：
      · `seq`＝**班次序号**（第几次散文写入）——**整数比较** ⇒ **无并列**、不依赖时钟
        ⇒ 「同秒留一班」这类现象从**结构上**消失：旧形拿「散文写入时刻」（秒级截断）
        与「条目创建时刻」（微秒）比 ⇒ 同一秒内创建的条目**必然 ≥ 边界** ⇒ 下一班还要
        再点一次名（作者负担），而且夹具得靠 `sleep` 跨秒才不被掩盖（**同秒掩盖**＝盲区）。
      · `ts`＝那次写入的时刻——**老条目兜底**用（没有 `bornShift` 的条目按旧口径比，
        牙**不放松**：旧行的判定与升级前逐字一致）。

    边界取「**当前盘上散文之前**那次散文写入」（`offset=-2`）：
      · 盘上的散文是**当前班段**写的 ⇒ 本班的起点＝上一次散文写入；
      · 散文写入不足 2 次 ⇒ 没有上一班 ⇒ 空边界 ⇒ 一切能推的条目都算「新增」
        （最严的一档，牙不放松）；
      · 检查发生在「本班还没写散文」时 ⇒ 盘上是上一班的散文 ⇒ 边界＝上上次
        ⇒ 上一班登记的条目仍算「新增」（它们本就该出现在上一班的散文里），
        本班新登记的条目也算「新增」（还没进任何散文）⇒ 严格方向，不静默放过。

    ⚠ **不是「最后一次散文写入」**——那样边界会落在**当前班段自己刚写的那次**上
    ⇒ 本班登记的条目全在边界**之前** ⇒ 「本班新增」恒空 ⇒ **牙静默失效**。
    （2026-10-23 实测：`add` 登记一条 → `set exit` 写一段**不点名**它的散文 → `check` **rc=0**。
    日粒度版没这个病（同一天仍是「新增」）⇒ 这是**精确时刻化自己引入的回归**，
    不是原有行为。当时夹具全绿是因为整个夹具跑在**同一秒**里——秒级截断把
    「上一次」与「最后一次」抹平了（**同秒掩盖**＝夹具盲区）。）
    """
    recs = _shift_records(st)
    idx = len(recs) + offset if offset < 0 else offset
    if idx < 0 or idx >= len(recs):
        return {"seq": None, "ts": None}
    r = recs[idx]
    return {"seq": int(r["seq"]), "ts": (str(r.get("ts") or "") or None)}


def _as_aware(dt: datetime) -> datetime:
    """naive ⇒ 按**本地时区**补 tzinfo。

    为什么需要（t000407 实测踩到）：`createdAt` 是带偏移的 ISO 串（`now_iso()` 造的），
    而老行回填出来的 `created` 是**日粒度**（无时刻、无偏移）⇒ 两者直接比较会抛
    `TypeError: can't compare offset-naive and offset-aware datetimes` ⇒ 判据当场崩
    （不是红，是崩 ⇒ 整条维度的结论作废）。统一按本地时区补齐后，两边永远可比较。
    """
    return dt.astimezone() if dt.tzinfo is None else dt


def _is_shift_new(r: dict, boundary: dict) -> bool:
    """「本班新增」判定（v5.30.0 刀 F：**班次序号**优先，老条目按时刻兜底）。

    ① **有 `bornShift` 的条目**（v5.30.0 起登记的）⇒ 按**班次序号**比：
       `bornShift >= boundary.seq` —— **整数比较** ⇒ 无并列、与时钟无关
       ⇒ 「同秒留一班」从结构上消失（旧的秒级时刻比较：条目创建与散文写入落在同一秒时，
       createdAt ≥ 边界 ⇒ 下一班仍算「本班新增」⇒ 还要再点一次名）。
    ② **没有 `bornShift` 的条目**（老条目／导入的）⇒ 按**旧口径**比：创建时刻 ≥ 边界时刻，
       且边界时刻**截到秒**（与升级前逐字一致）⇒ **牙不放松**（老行的判定不变）。
    ③ 没有边界（还没写过班段）或判不出创建时刻 ⇒ **算「本班新增」**
       ⇒ 牙不放松（宁可多要求点名，不许静默放过）。比较异常（naive/aware 混比等）
       也按「算新增」处理——判据崩掉比判据松更危险。

    抽成函数是为了让夹具能换掉它做**变异自证**（d000111 同款做法）：写死在判据体内
    就只能在真源上手改，腿就没法证明自己咬得住。
    """
    _bs = boundary.get("seq")
    _born = r.get("bornShift")
    if _bs is not None and isinstance(_born, int):
        return _born >= _bs
    _cutoff_s = boundary.get("ts")
    if not _cutoff_s:
        return True
    _created = _entry_created_dt(r)
    if _created is None:
        return True
    try:
        _cut = datetime.fromisoformat(str(_cutoff_s)).replace(microsecond=0)
        return _as_aware(_created) >= _as_aware(_cut)
    except (TypeError, ValueError):
        return True


def _entry_created_dt(r: dict) -> datetime | None:
    """条目的**创建时刻**（datetime）——「本班新增」判据的另一半。

    有 `createdAt` 就用它（工具盖的精确时刻）；**老行没有**（本字段引入前建的）⇒
    按 `created` 那天的**末尾**算（本地时区）⇒ **保守**：仍算「新增」＝与旧行为一致，
    不因为字段缺失就静默放松牙。

    为什么取「当天末尾」而不是「当天开头」：老行只有日粒度 ⇒ 只能取一个代表时刻。
      - 取末尾 ⇒ 它落在这天的**所有**班次边界之后 ⇒ 老行在**当天**永远算「新增」
        （与日粒度旧判据同口径：旧判据比的是日期，created 当天 ≥ 边界当天 ⇒ 新增）；
      - 取开头 ⇒ 它落在这天**任何**班次边界之前 ⇒ 老行**当天一班都不算新增**
        ⇒ 与旧判据反了 ⇒ 老条目从第一班起就逃出点名 ⇒ 静默放松（更危险）。
    两者都拿不到 ⇒ None（调用方按「算新增」处理）。
    """
    _ca = r.get("createdAt")
    if _ca:
        try:
            return _as_aware(datetime.fromisoformat(str(_ca)))
        except ValueError:
            pass
    _c = r.get("created")
    if _c:
        try:
            return _as_aware(datetime.fromisoformat(str(_c)).replace(
                hour=23, minute=59, second=59, microsecond=999999))
        except ValueError:
            pass
    return None


def refill_pool(st: Store, exclude: str = ""):
    """补位池 = live actions（status 非 live 闭集者一律排除）。返回 (有序候选, 池大小, 排除数)。

    排序键全序确定：**(重要度档, created↑, id↑)** —— 天龄**不在排序键里**（d000104）。
    重要度取自 **`prio` 字段**（闭集 急0/高1/中2/低3/缓4，缺省视作中；d000108）——
    **不再**从 summary 前缀解析：前缀会把 `[高·重定]` 这类写法静默读成默认档（2026-10-18 实测
    本仓已闭 `t` 型漏 2 条），且三档实际退化成两档（当日实测 191/267＝**71.5% 落「中」**）；
    同档内一律按登记年龄老→新排，`id` 只作全序的最终 tiebreak。

    **为什么取消「超期升档」（v5.7.0，d000104）**：旧形是 `有效档 = max(0, 基础档 − 年龄//30)`
    ——注意它**本来就是有界的**（floor 0），所以「老化无界」从来不是病根。真病根是**等待
    时长被允许跨档改写声明过的档位**：[低] 熬够 30 天就爬进 [中] 那格，等于让 nice 值 19
    老化到 0。外部成熟做法也一致——优先级与时间戳是两个独立排序键（K8s activeQ 即
    `sorted by priority and then timestamp`），饥饿单独处理而不靠改写优先级顺带解决。
    实证代价：`t000009`（[低]、等所有者裁定）2026-10-20 满 30 天升档后凭 `created` 最老
    **跳池首**，把三件真正推得动的 [中] 活全压下去，而它的重要度一分钟都没变。
    ⇒ 防饿死意图**不靠改排序**，改为 `refill_pick` 在输出里对超期条目**独立点名**：
    提醒落在做决定的那一刻。`REFILL_STEP_DAYS` 随之从「升档步长」降格为「超期线」。

    入池谓词有三道（任一不满足即排除，且都计入 `blocked`）：
      ① 不是 `exclude`（见下）
      ② `status == open`（t000138：只精确排 blocked 会放进 status=closed 的半关行）
      ③ **`blockedBy` 指向的 id 仍然活着**（t000242）。这是本轮的第三道：条目自己写着
         「我卡在 X 上」，而 X 还存在 ⇒ 现在去推它必然白推。指针应该落到真正推得动的活上。
         反过来 X 没了（已 close/作废）⇒ 自动回池，不需人手解禁——条件消失即解锁。

    `exclude`：**把某 id 排除在池外**。这是 `close` 两阶段化（4.8.1）的关键——阶段 1
    算补位候选时源行**还没删**、该条目**仍是 open**，不排除它就会**把自己补成 next**
    （关掉的条目立刻又成了当前决策点）。漏了这个参数，方案就从「根治」变成「换一个 bug」。
    """
    rows, blocked = [], 0
    ls = live_status_of("action")
    blocking = blocking_ids(st)
    for r in st.load_live():
        if r.get("_slot") != "actions":
            continue
        if _pool_exclusion(r, blocking, exclude) is not None:
            # 入池谓词在 `_pool_exclusion`（唯一源）——渲染区、补位与 `fresh-queue` 判据共用。
            blocked += 1
            continue
        # 排序来源＝`prio` 字段（d000108）。字段缺失时按「中」——**这是缺省、不是静默**：
        # `add` 落字段时会明打印，`check` 的 `prio-source` 维又要求 live 条目要么有合法
        # 字段、要么前缀已被回填清掉，所以「没人填」不会悄悄变成长期状态。
        if not r.get("id"):
            # v5.19.0：手改存储若把行**改坏**（缺 id），池计算不能崩栈——崩栈会让「报错自带
            # 出口」这条纪律失效（用户看到的是 traceback，不是修法）。坏行**交给 `fields` 维
            # 报**（它才判必填字段缺失）⇒ 这里跳过，不静默（那一维会红）。
            continue
        base = PRIO_RANK[r.get("prio") if r.get("prio") in PRIO_RANK else PRIO_DEFAULT]
        age = _age_days(r.get("created", ""))
        overdue = age >= REFILL_STEP_DAYS
        rows.append(((base, r.get("created", ""), r["id"]), r, base, overdue, age))
    rows.sort(key=lambda x: x[0])
    return rows, len(rows), blocked


def refill_pick(st: Store, exclude: str = ""):
    """按策略给出补位目标：返回 (id, 解释)。池空 → ('', 解释)。"""
    rows, n, blocked = refill_pool(st, exclude)
    why = f"池 {n} 条" + (f"（排除非 open {blocked}）" if blocked else "")
    over = [(r["id"], age) for _k, r, _b, od, age in rows if od]
    if over:
        # 超期**只提醒、不改排序**（d000104）：等得久不再是「更重要」的代理，
        # 但它仍然是「该看一眼」的信号——提醒落在做决定的那一刻，而不是靠改排名喊。
        why += "·超期 " + "、".join(f"{i}({a}天)" for i, a in over)
    # v5.18.0（G′）：**等外部/等所有者的条目不在池里**（不可推），但「等太久」本身仍是信号
    # ⇒ 独立点名。实证代价：t000009（等所有者裁定）2026-10-20 凭 created 最老跳池首，
    # 把三件真正推得动的 [中] 活全压下去——防饿死不能靠改排序，只能靠「到点就喊」。
    _waits = [(r["id"], _age_days(r.get("created", "")), r.get("waitingFor"))
              for r in st.load_live()
              if r.get("_slot") == "actions" and r.get("waitingFor")]
    _waits_long = [(i, a, w) for i, a, w in _waits if a >= REFILL_STEP_DAYS]
    if _waits_long:
        why += "·等太久 " + "、".join(f"{i}({a}天,等{w})" for i, a, w in _waits_long)
    if not rows:
        return "", why + "·无可补"
    _, r, base, _od, age = rows[0]
    return r["id"], f"{why}·{r['id']} 重要度{PRIO_LEVELS[base]}（登记 {age} 天）"


def _queue_rows(st: Store) -> list[str]:
    """队列区的**唯一渲染规则**（d000106）：池实算 → 逐行文本。

    渲染器与 `queue-stale` 判据**都走这里**——判据里再写一遍拼装规则，就是本仓反复在治的
    「同一条规则抄第二份必分叉」（p000085/p000147 同族）：那份分叉会让判据把正确区判红、
    或把错误区判绿，而两者都看不出成因。
    """
    rows, _n, _b = refill_pool(st)
    return ([f"- `{r['id']}` {PRIO_LEVELS[base]}·{r.get('status') or 'open'}"
             for _k, r, base, _od, _age in rows] or ["- （池空）"])


def _queue_block(st: Store) -> str:
    """渲染「队列现态」块（d000105 第 2 层）。行文本来自 `_queue_rows`，不在此另立规则。"""
    # 区里**只存稳定三元组** `id · 重要度 · status`（d000106 第三件）。天龄与「超期」是会随
    # 日历自己变的数——写点全接对也没用：明天无人跑任何命令，存文的 `0天` 就成了假称；而
    # `queue-stale` 若把天龄纳入比对会天天红。⇒ 天龄/超期只在 `next --auto` 运行时现算现打。
    lines = [QUEUE_BEGIN, "**队列现态**（v5.29.0 起**读时现算、不落盘**；以库为准；补位顺序；"
              "只列稳定字段 `id · 重要度 · status`，天龄与超期见 `next --auto`）"]
    lines += _queue_rows(st)
    return "\n".join(lines) + "\n" + QUEUE_END + "\n"


def _strip_counts(text: str) -> str:
    """取掉 `status` 顶部的 counts 渲染区（区外散文一字不动；重复区一并清掉）。"""
    while True:
        m = re.search(rf"^{re.escape(COUNTS_BEGIN)}\n.*?^{re.escape(COUNTS_END)}\n?",
                      text, re.M | re.S)
        if not m:
            break
        text = text[:m.start()] + text[m.end():]
    return text.strip("\n")


def _strip_rendered(text: str) -> str:
    """剥掉所有机器渲染区（exit 的 queue 区 ＋ status 的 counts 区）再判散文形状。"""
    return _strip_counts(_strip_queue(text))


def counts_lines(st: Store, idx: dict | None = None) -> list[str]:
    """现态计数（渲染物 · **现算 · 不落盘**）——`view` 里那一段的唯一产出口。

    数值取 `build_index()` 的同一份实算结果（不另算一遍——第二份实现必分叉）；
    只列稳定字段：槽计数／closed／next。天龄这类随日历变的数不进段（d000106 同一条）。
    """
    idx = idx or st.build_index()
    lines = ["**现态计数**（渲染物 · 现算 · 不落盘；以库为准；只列稳定字段）"]
    for slot in ("actions", "pitfalls", "commands", "unconfirmed", "decisions"):
        lines.append(f"- {slot}：{idx['slots'][slot]['count']}")
    lines.append(f"- closed：{idx['closed_count']}")
    lines.append(f"- next：{idx['next'] or '（空）'}")
    return lines


def strip_counts_legacy(st: Store) -> None:
    """剥掉 `status` 里**旧库残留**的 counts 渲染区（v5.30.0 起区**读时现算、不落盘**）。

    为什么不再渲染写入（**根因**：一槽三职——同一份事实落了两份）：
      · counts 区是**存储态派生物**（现态计数的第二份副本）⇒ 它会陈旧 ⇒ 于是专门养了
        一个判据维 `counts-stale` 兜它（判据面净减一处的机会就在这里）；
      · 它贴近上限时会**静默跳过写入**（实测：status 散文 32600 字符 ⇒ `set status` rc=0
        而区从文件里消失、`check` 仍绿 ⇒ 副本**无声丢失**，且报错给的建议命令
        `handoff compact status` **根本不存在**（compact 只支持 exit／summary））；
      · 「每次写都得记得复渲染」= 一条**写点清单**——队列区那条同类清单历史上漏接三次。
    ⇒ 与 v5.29.0 的队列区**同构收口**：区只读时现算（读者看 `handoff view`），
      `status` 槽回归**纯散文**，判据维 `counts-stale` 作废。
    ⇒ 本函数只服务**旧库残留**的清理：**幂等**——没有残留就一个字节都不写
      （不搅乱 mtime 与写事件对账，那会让「写入对账」判据抓不到真正的旁路写入）。
    """
    tgt = st.d / "status"
    if not tgt.is_file():
        return
    old = tgt.read_text(encoding="utf-8")
    if COUNTS_BEGIN not in old and COUNTS_END not in old:
        return
    new = _strip_counts(old)
    if new == old:
        return
    # v5.30.0 刀 C：也经唯一漏斗写（`index=False`：本函数是被 `write_index` 调用的，
    # 再调 write_index 会递归；`force=True`：维护型清理不该被字节闸挡住——旧库可能本就超限）。
    _write_slot(st, "status", new, "sync-counts", force=True, snapshot=False, index=False)


def _strip_queue(text: str) -> str:
    """取掉热层里已有的渲染区（区外的散文**一字不动**）。

    ⚠ 只认**行首**的标记：渲染器恒把标记写在行首，而散文里引用这个串太常见了
    （写本条夹具时就在 exit 里引了一次）——按裸子串切会把引用点之后到真区尾的
    **散文整段吞掉**，那是数据丢失，不是显示瑕疵。
    """
    m = re.search(rf"^{re.escape(QUEUE_BEGIN)}\n.*?^{re.escape(QUEUE_END)}\n?",
                  text, re.M | re.S)
    if not m:
        return text.strip("\n")
    return (text[:m.start()] + text[m.end():]).strip("\n")


def strip_queue_block(st: Store) -> None:
    """剥掉 exit 热层里**遗留**的队列渲染区（v5.29.0 起区读时现算、不落盘）。

    v5.29.0 之前区是**存储态派生物**：随池变化被反复重渲 ⇒ ① O(池规模) 的行数塞进人写的
    散文层 ⇒ 库一大就撞 8192 字节闸 ⇒ `append exit` 被拒 ⇒ 班段永久写不进（实测 500 条
    ⇒ 区 9610 字节 ⇒ append rc=1，且无自救出口）；② 区会陈旧 ⇒ 养出一个判据维
    `queue-stale` 兜它；③ 区会陈旧是因为「每次改池都得记得复渲染」⇒ 那个写点清单
    **历史上漏接了三次**（v5.7.0 的 rm／edit／compact、t000405 的 supersede）。
    ⇒ 现在区**只读时现算**（读者看 `handoff view`）；**写入即剥**由唯一漏斗 `_write_slot`
    负责（任何写热层的命令都会剥掉它写入内容里的区）⇒ 本函数只服务**文件里**的旧残留：
    **幂等**——没有残留就一个字节都不写（不搅乱 mtime 与写事件对账，那会让「写入对账」
    判据抓不到真正的旁路写入）。

    ⚠ **v5.30.0 刀 C**：本函数此前**没有调用点**（死代码）——旧形注释称「写命令自动剥
    （`strip_queue_block`）」，实际是各写命令剥**自己写入的内容**，文件里的旧残留靠
    `handoff sync-queue` 手动剥 ⇒ **那条注释是假称**（族 E）。⇒ 现在把残留清理也并进
    漏斗（写即剥）⇒ 手动入口 `handoff sync-queue` 保留（清「没人写过的旧库」）。
    """
    tgt = st.d / "exit"
    if not tgt.is_file():
        return
    hot = tgt.read_text(encoding="utf-8")
    if QUEUE_BEGIN not in hot:
        return
    body = _strip_queue(hot)
    if body != hot:
        # v5.30.0 刀 C：经唯一漏斗写（原先这里直写文件 ⇒ 漏斗形同虚设）
        _write_slot(st, "exit", body, "sync-queue")


def plan_close(st: Store, id: str, outcome: str | None,
               no_refill: bool, outcome_from_shell: bool = True) -> dict:
    """**阶段 1：纯计算、零落盘**。任何 `die()` 都在一个字节都没写时发生。

    这是 p000069 的根治点。旧形把「算补位」放在「写 closed / 删源行 / 清 next」
    **之后**，于是补位策略一旦抛错，落盘已完成一半：条目已归档、`next` 仍指着已关
    条目——而那时 `check` 只能事后发现。拆成 plan/apply 后，可预见的失败全部前置；
    残留窗口只剩阶段 2 内两次 IO 之间（每步各自原子），且 `check` 抓得到、给得出修法。

    关键技术点：算补位候选时源行**还没删**、被关条目**仍是 open**，必须 `exclude=id`
    ——否则会「把自己补成 next」，关掉的条目立刻又成了当前决策点。
    """
    st.note_pre_tamper()
    r = _find_live(st, id)
    if not r:
        die(f"close: 未找到 live 条目 {id}", key="未找到 live 条目")
    typ = ID_RE.match(id).group(1)
    out = {k: r[k] for k in KEY_ORDER if k in r and not k.startswith("_")}
    out["closed"] = today()
    if outcome:
        out["outcome"] = outcome
    was_next = st.next_id() == id
    nid, why = ("", "（--no-refill，不补位）")
    if was_next and not no_refill:
        nid, why = refill_pick(st, exclude=id)      # ← 排除即将被关的那条
    elif not was_next:
        why = "（next 不是本条，不动指针）"
    src = Path(r["_file"])
    rows = read_jsonl(src)
    # ── v5.58.0（t000463）：按**行**摘——只摘**本命令要关的那一条** ──
    # 病：旧形按 id 整表过滤 ⇒ 同一文件里落着两条同 id 时**两条一起被移走**，
    #   而归档的只有一条 ⇒ 另一条既没归档、也没进 trash ⇒ **静默丢数据**。
    # ⇒ 现在按**位置**摘（`_find_live` 给的就是首个命中那条）⇒ 另一条留在原处。
    _pick = _row_index(rows, id)
    if _pick < 0:
        die(f"close: {id} 在 {src.name} 里读不到那一行（落盘与在册面不一致——多半刚被并发改动）"
            f"⇒ 拒绝盲改；重试一次，仍读不到 ⇒ `handoff view --id {id}` 查它在不在",
            key="未找到 live 条目")
    rest = [x for k, x in enumerate(rows) if k != _pick]
    return {"id": id, "typ": typ, "out": out, "was_next": was_next,
            "nid": nid, "why": why, "src": src, "rest": rest}


def apply_close(st: Store, plan: dict) -> int:
    """**阶段 2：纯落盘**。无 `die`、无依赖外部状态的分支判断。

    `next` **只写一次**（旧形先 `set_next("")` 再 `set_next(nid)`，中间那个窗口正是
    「指针既不是原值也不是新值」的事故现场）。
    """
    append_jsonl(st.d / "closed" / f"{plan['typ']}.jsonl", plan["out"])
    write_jsonl_atomic(plan["src"], plan["rest"])
    if plan["was_next"]:
        st.set_next(plan["nid"])
    # d000105 第 2 层：close 之后队列区**当场复渲染**，散文不再失效。必须排在
    # `write_index` 之前——写事件把 `exit` 的哈希一并记录（`_write_targets` 含单文件槽），
    # 渲染若落在其后，下一条命令就会把它当成「CLI 之外的改动」（实测 check 因此红）。
    st.write_index()      # 必须在 next 落定之后（index 内嵌 next，防陈旧）
    print(f"handoff close: {plan['id']} → closed/{plan['typ']}.jsonl")
    echo_back(st, plan["id"], strict=True)
    if plan["was_next"]:
        if plan["nid"]:
            print(f"handoff next: 自动补位 → {plan['nid']}｜{plan['why']}")
            print(f"  策略：actions 池 · 排除非 open · 键(prio, created↑, id↑) · "
                  f"重要度＝prio 字段（闭集 急/高/中/低/缓，缺省中）· "
                  f"等够 {REFILL_STEP_DAYS} 天者仅点名提醒（不改排序）")
        else:
            print(f"handoff next: 已清空（{plan['why']}）")
    return 0


def cmd_close(st: Store, id: str, outcome: str | None = None,
              no_refill: bool = False, from_file: str | None = None,
              **_ignored) -> int:
    """关闭一条 live 条目。**收显式参数而非 Namespace**（p000016 根治，4.8.0）。

    两阶段：先 `plan_close` 纯算、再 `apply_close` 纯写（p000069，4.8.1）——可预见的
    失败（找不到条目、引用守卫、补位策略）全部在**零落盘**时发生。

    关账事件入流水（4.9.3）：此前 `log.jsonl` **只有 check 事件**（本仓实测 474 次
    check:ok / 38 次 check:fail，**0 条 close**）⇒ 条目生命周期根本没进流水，事后查不出
    「哪一轮闭的、当时 exit 更新没」，`exit` 过期连痕迹都没有。落点选在这里而不是
    `apply_close`：那里拿不到 `outcome`（它不在 plan 字典里），插那儿会 NameError。
    `exit` 是否同步更新不在这里判——那是 fresh-stale 的活，这里只保证「闭过」可查。
    """
    st.note_pre_tamper()
    # d000110：`--from-file` 与 flag 同时给＝报错（不静默取一个），与 add／edit 同一条规矩
    from_shell = True
    if from_file:
        got = load_from_file("close", from_file, {"outcome"})
        dup = sorted(({"outcome"} if outcome is not None else set()) & set(got))
        if dup:
            die(f"close: 字段 {dup} 同时出现在命令行与 --from-file；只留一处")
        outcome = got["outcome"]
        from_shell = False
    # 空 outcome＝静默销账（p000051）；`from_shell` 只在值真经 shell 时才查危险字符。
    # ⚠ 两条守卫都跑在**值最终确定之后**（v5.12.1）：原先它们在 --from-file 合并前跑，
    # 于是超长与空串都能从文件那条路溜进来——被绕开的正是它们各自要防的那件事。
    require_text("close", "--outcome", outcome, from_shell=from_shell)
    guard_len("close", "--outcome", outcome, OUTCOME_CAP)
    plan = plan_close(st, id, outcome, no_refill, outcome_from_shell=from_shell)
    apply_close(st, plan)
    print(f"handoff close: {plan['id']} → closed/{plan['typ']}.jsonl")
    echo_back(st, plan["id"], strict=True)
    _log(st, "close", id=plan["id"], outcome=outcome or "", typ=plan["typ"])
    if plan["was_next"]:
        if plan["nid"]:
            print(f"handoff next: 自动补位 → {plan['nid']}｜{plan['why']}")
            print(f"  策略：actions 池 · 排除非 open · 键(prio, created↑, id↑) · "
                  f"重要度＝prio 字段（闭集 急/高/中/低/缓，缺省中）· "
                  f"等够 {REFILL_STEP_DAYS} 天者仅点名提醒（不改排序）")
        else:
            print(f"handoff next: 已清空（{plan['why']}）")
    return 0


def cmd_next(st: Store, a) -> int:
    if a.clear:
        st.set_next("")
        st.write_index()
        print("handoff next: 已清空")
        return 0
    if a.auto:
        nid, why = refill_pick(st)
        if not nid:
            # 池空 ⇒ **把指针清空**（2026-10-03 修）。旧形直接 `die`、什么也不写：
            # 于是当 next 指向一个已关条目、而池里确实没有可补的条目时，照着
            # `check` 给的修法（`handoff next --auto`）跑完**指针依然坏着**——
            # 指引给了一条不保证有效的命令，等于没给。`next --auto` 的语义是
            # 「把 next 设成按策略算出的值」，池空时那个值就是空。
            st.set_next("")
            st.write_index()
            print(f"handoff next: 已清空（按补位策略无候选）｜{why}")
            return 0
        st.set_next(nid)
        st.write_index()
        print(f"handoff next: {nid}（按补位策略）｜{why}")
        return 0
    if not a.id:
        die("next: 需要 <id>、--auto 或 --clear")
    if not _find_live(st, a.id):
        die(f"next: {a.id} 不存在或已关闭", key="不存在或已关闭")
    st.set_next(a.id)
    st.write_index()
    print(f"handoff next: {a.id}")
    return 0


def cmd_unconfirmed(st: Store, a) -> int:
    # d000110：`unconfirmed` 的 summary/detail/outcome 同样落盘，入口与 add／edit 对齐
    ff = getattr(a, "from_file", None)
    ff_keys: set = set()
    if ff:
        allowed = {"ref", "summary", "detail"} if a.action == "add" else {"outcome", "summary"}
        got = load_from_file(f"unconfirmed {a.action}", ff, allowed)
        dup = sorted({k for k in allowed if getattr(a, k, None) is not None} & set(got))
        if dup:
            die(f"unconfirmed {a.action}: 字段 {dup} 同时出现在命令行与 --from-file；只留一处")
        for k, v in got.items():
            setattr(a, k, v)
        ff_keys = set(got)
    if a.action == "add":
        for label, key in (("--ref", "ref"), ("--summary", "summary"), ("--detail", "detail")):
            require_text("unconfirmed add", label, getattr(a, key),
                         from_shell=key not in ff_keys)
        # ⚠ 这一槽此前**根本没有长度闸**（v5.12.1 补）：`add`／`close` 至少还有守卫，
        # 只是跑在合并前；这里是两条路都不限长。unconfirmed 也是落盘条目，凭什么例外？
        guard_len("unconfirmed add", "--summary", a.summary, SUMMARY_CAP)
        guard_len("unconfirmed add", "--detail", a.detail, DETAIL_CAP)
        summ = a.summary or a.ref
        if not summ:
            die("unconfirmed add: 需要 --ref 或 --summary（不可空）")
        e = {"id": st.allocate("u"), "created": today(), "summary": norm(summ)}
        if a.ref:
            e["src"] = a.ref
        if a.detail:
            e["detail"] = a.detail
        append_jsonl(st.unconf_file(), e)
        st.write_index(ids=[e["id"]])
        print(f"handoff unconfirmed add: {e['id']}")
        return 0
    if a.action == "resolve":
        require_text("unconfirmed resolve", "--outcome", a.outcome,
                     from_shell="outcome" not in ff_keys)
        guard_len("unconfirmed resolve", "--outcome", a.outcome, OUTCOME_CAP)
        r = _find_live(st, a.id)
        if not r or r.get("_slot") != "unconfirmed":
            die(f"unconfirmed resolve: 未找到候选 {a.id}", key="未找到候选")
        if a.as_slot:
            if a.as_slot not in ADD_KINDS:
                die(f"unconfirmed resolve: --as 须为 {'|'.join(RESOLVE_AS_FORMS)}")
            if a.as_slot == "decision":
                cmd_add(st, "decision", {"title": a.summary or r["summary"]})
            else:
                cmd_add(st, a.as_slot, {k: v for k, v in
                                        {"summary": a.summary or r["summary"], "domain": a.domain,
                                         "topic": r.get("topic"), "src": r.get("src"),
                                         "detail": r.get("detail")}.items() if v is not None})
            outcome = a.outcome or ("转正 " + a.as_slot)
        elif a.dismiss:
            outcome = a.outcome or "dismiss（作废）"
        else:
            die(f"unconfirmed resolve: 须给 `--as {'|'.join(RESOLVE_AS_FORMS)}`"
                f"（转正）或 `--dismiss`（作废）")
        cmd_close(st, a.id, outcome, a.no_refill)
        return 0
    die("unconfirmed: 需要 add|resolve")


# ---------------- read / render ----------------
LEDGER_HINT_BYTES = 4 * 1024 * 1024      # 台账体量提示阈值（4 MB）
LEDGER_HINT_EVENTS = 1000                 # 台账条数提示阈值


def cmd_compact_writes(st: Store, a) -> int:
    """**收窗**写事件台账（`writes.jsonl`）：把历史折叠成一条基线 ＋ 保留最近 N 条。

    为什么需要（v5.19.0／t000402）：台账按次追加、**条数**随写命令线性增长。本仓实测
    1,984 条／11.4 MB（E′ 的增量记录已把**每条**的体量降了约 15 倍，但条数仍在长），
    而**每条命令都要全量读它**（`note_pre_tamper` 读末次记录）⇒ 库越大越慢。

    **收窗不改变判定**（硬要求，逐条对齐 `audit_writes` 与出处维的**五个**并集）：
      · `latest`（每文件最后一次 CLI 写入时的 sha＋mt）＝折叠段的末次记录 ＋ 保留段，逐字一致；
      · `ever_removed`（CLI 记过的删除并集）＝折叠段并集 ＋ 保留段，并集一致；
      · **带旁证（pre_tamper）的事件原样保留、不折叠** ⇒ 「疑似补手续」仍逐条报出，
        **结案仍走 `rebase --force`**（它才是丢弃旁证的机制）——收窗不偷做结案；
      · `id_base`（老库存量 id 的认账基线）＝全部事件的并集，折掉那条落基线的事件
        ⇒ 基线永久失据 ⇒ `check` 恒红（t000486）；基线**只做并集、不新增快照**
        （收窗无权扩大认账范围——那是 `rebase --force` 的语义）；
      · `ids`（CLI 分配记录）＝全部事件的并集，折掉就再也追不回 ⇒ 老 id 被判「来历不可追」。
      空集也保留 `id_base`／`ids` 键：`_id_baseline()` 用「有没有这个键」区分
      「基线已落但为空」（新库）与「基线还没落」（老库）。
    折叠掉的只有**op 分布**（谁在什么时候写了什么）⇒ 记成基线里的 `ops` 计数，形状不丢。

    **显式命令，不是 check 里的自动动作**：门禁不改用户的台账（A′：门禁不改使用方的文件）。
    """
    wl = st.d / WRITES_LOG
    if not wl.is_file():
        print(f"handoff compact-writes: 本库没有写事件台账（{WRITES_LOG}）——无可收")
        return 0
    evs = read_jsonl(wl)
    if not evs:
        print("handoff compact-writes: 台账为空，无需收窗")
        return 0
    keep_n = max(0, int(getattr(a, "keep", 200) or 0))
    n = len(evs)
    tainted = {i for i, e in enumerate(evs) if e.get("pre_tamper")}
    tail = set(range(max(0, n - keep_n), n))
    keep_idx = sorted(tainted | tail)
    fold_idx = [i for i in range(n) if i not in keep_idx]
    # 基线＝**截至收窗时的末次状态**（逐字取自全部事件，不只是被折的那段）——
    # 它的每个文件条目就是 `latest` 的最终值 ⇒ 与收窗前逐字一致。
    base_files: dict[str, dict] = {}
    removed: set[str] = set()
    ops: dict[str, int] = {}
    for e in evs:                       # 全部事件（折的＋留的）取末次记录
        for f, rec in (e.get("files") or {}).items():
            base_files[f] = rec if isinstance(rec, dict) else {"sha": rec, "mt": None}
    for i in fold_idx:
        removed |= set(evs[i].get("removed") or [])
        op = str(evs[i].get("op") or "?")
        if op == "__compact__":
            # 折的是**上一条基线** ⇒ 它的 op 直方图要**并进来**（否则二次收窗把
            # 再上一次的历史分布抹掉——收窗不能一代一代吃掉历史）。
            for _op, _c in (evs[i].get("ops") or {}).items():
                ops[_op] = ops.get(_op, 0) + int(_c)
            ops["__compact__"] = ops.get("__compact__", 0) + 1
        else:
            ops[op] = ops.get(op, 0) + 1
    for e in evs:                       # 删除并集取全部事件（判定要的是并集）
        removed |= set(e.get("removed") or [])
    # 出处维的两样东西也必须折叠进基线，否则收窗会改变「凭空出现的 id」维的判定（t000486）：
    #   · id_base：全部事件的 id_base 并集（认账单调只增；不新增快照）
    #   · ids    ：全部事件的 ids 并集（CLI 分配记录，折掉就再也追不回）
    folded_base: set[str] = set()
    folded_ids: set[str] = set()
    for e in evs:
        folded_base |= {str(x) for x in (e.get("id_base") or [])}
        folded_ids |= {str(x) for x in (e.get("ids") or [])}
    baseline = {
        "ts": datetime.now().astimezone().isoformat(),
        "op": "__compact__",
        "prov": PROV_VERSION,          # 与其它事件同形（keep 0 时台账里只剩这一条）
        "files": base_files,
        "removed": sorted(removed),
        "pre_tamper": [],
        "folded": len(fold_idx),
        "ops": ops,
        "id_base": sorted(folded_base),   # 空集也保留键 ⇒ 「基线已落但为空」与「没落」可分
        "ids": sorted(folded_ids),
    }
    # 保留的事件**去掉它们逐件的 files 映射**（已被基线的末次状态取代）：
    # 那些**中间态**在本仓**没有任何消费者**（各维只看末次状态与并集）⇒
    # 按「查不到消费点＝伪状态」折掉；事件身份（op／时点／删除并集／带旁证）原样保留。
    kept_events = []
    for i in keep_idx:
        e = dict(evs[i])
        e.pop("files", None)
        kept_events.append(e)
    out: list[dict] = ([baseline] if fold_idx or base_files else []) + kept_events
    before = wl.stat().st_size
    tmp = wl.with_suffix(".jsonl.tmp")
    tmp.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in out), encoding="utf-8")
    os.replace(str(tmp), str(wl))
    after = wl.stat().st_size
    print(f"handoff compact-writes: 已收窗 {n} 条 → {len(out)} 条"
          f"（折叠 {len(fold_idx)} 条为 1 条基线，保留最近 {len(tail)} 条 ＋ "
          f"带旁证事件 {len(tainted)} 条原样不动；保留事件的逐件中间态已折进基线）；"
          f"{before} → {after} 字节（省 {max(0, before - after)}）")
    print(f"  **判定不变**：末次记录（latest）、删除并集（ever_removed）、带旁证事件（seen_tamper）、"
          f"id 出处基线（id_base）、分配记录（ids）五项与收窗前一致；"
          f"结案仍走 `handoff rebase --force`。")
    return 0


def _rebased_archive_name(st: Store) -> str:
    """旁证事件**侧档**的文件名（`.handoff/writes-rebased-<ts>.jsonl`）；同秒重跑不覆盖。

    v5.71.0（t000483）：`rebase` 不再**销毁**旁证事件 ⇒ 搬进这个侧档，`__rebase__` 标记
    记路径 ⇒ `rebase --undo` 能搬回。侧档放在**库根**（与 `writes.jsonl` 同级）——
    不放 `archive/`（那是 exit/summary 的冷档，语义不同），也不放 `trash/`（那是条目的
    回收站，`unvoid` 读它，混进去会让 id 语义串台）。
    """
    ts = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    name = f"{REBASED_ARCHIVE_PREFIX}{ts}.jsonl"
    i = 2
    while (st.d / name).exists():
        name = f"{REBASED_ARCHIVE_PREFIX}{ts}-{i}.jsonl"
        i += 1
    return name


def _write_rebased_archive(st: Store, tainted: list) -> str:
    """把旁证事件**写进侧档**并返回相对文件名（空串＝没有旁证事件）。

    v5.71.0（t000483）：这是「**不销毁**」的那一步——旧形是直接丢弃（真删）⇒ 那些结论
    「已不可追回」。单独成函数是为了让**变异自证**换得掉：换回旧形（不写侧档）⇒ 侧档
    不存在 ⇒ 正控腿当场红（腿有牙）。
    """
    if not tainted:
        return ""
    name = _rebased_archive_name(st)
    with open(st.d / name, "w", encoding="utf-8") as f:
        for e in tainted:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    return name


def cmd_rebase(st: Store, a) -> int:
    """**重建写事件基线**（`writes.jsonl`）为当前落盘事实——给「判据缺陷产生过的误报」结案。

    为什么需要它：`audit_writes` 扫的是**全部历史事件**。若某版本的前置旁证判据有缺陷
    （4.7.8 曾因在 `write_index` 里取快照，把「本次命令自己写的 mtime 变化」当成外部
    改动，4.7.9 已改为写命令**开始时**取快照），那些误报会**永久留在历史里、每次
    check 都红**，修判据也消不掉。没有结案出路，被误报卡住的人就只能去手改
    `writes.jsonl`——而那正是本工具要防的事。

    所以：判据出错时，跑 `handoff rebase --force`（**先手工核对**确有手改嫌疑之外的
    情况）把基线对齐现实。它是显式动作、需确认、打印重建前后条数，不是静默自愈。

    **v5.71.0（t000483）：结案不再销毁证据 ＋ 结案可撤销。**
    旧形把带旁证的历史事件**真丢弃** ⇒ 输出只能印「这些结论已不可追回」⇒ 真手改被
    一并结案时证据**永久消失**（与本 CLI 别处的惯例不一致：`rm` 走 trash ＋
    `unvoid --restore`，删除是可撤销的）。现在：旁证事件**搬进侧档**
    `.handoff/writes-rebased-<ts>.jsonl`，`__rebase__` 标记记路径 ⇒
    `handoff rebase --undo` 可把它们**搬回**（旁证红项随之重新出现＝结案被撤销）。
    **判据面不动**：`audit_writes` 只扫 `writes.jsonl` ⇒ 旁证事件搬出那个文件，红项自然消失。

    ⚠ **另一半不可撤销**（按既有设计）：本次结案同时把**当前全部在册 id 认账**
    （`id_base`）⇒「凭空出现的 id」维随之转绿；认账**单调只增**（`_id_baseline` 取
    全部事件的并集）⇒ `--undo` **不回退**这一半 ⇒ 输出每次都写明。
    """
    if not (st.d / "index").is_file():
        die(f"rebase: {st.d} 不是交接存储（缺 index）——拒绝凭空建出 {WRITES_LOG}"
            f"（这正是 `_log`/`log_write` 都有的守卫）；"
            f"在库目录里跑：先 `handoff init` 建库，或 `cd` 到有 `.handoff/` 的目录")
    wl = st.d / WRITES_LOG
    before = len(read_jsonl(wl)) if wl.is_file() else 0
    if getattr(a, "undo", False):
        if getattr(a, "force", False):
            die("rebase: --force 与 --undo 互斥（一个结案、一个撤结案）", key="force 与 undo 互斥")
        return _rebase_undo(st, wl)
    if not a.force:
        die("rebase: 会把带旁证的历史事件**搬进侧档**并认账当前 id 空间"
            "（那里面可能还藏着真问题）——确认已排除手改嫌疑后加 --force；"
            "要撤销上一次结案：加 --undo")
    # 旁证的历史事件**搬走而不是丢弃**（v5.71.0）：旧形真丢弃 ⇒ 那些结论「已不可追回」
    # ⇒ 真手改被一并结案时证据永久消失。现在搬进侧档（标记记路径 ⇒ 可 `--undo` 搬回）。
    evs = read_jsonl(wl) if wl.is_file() else []
    tainted = [e for e in evs if e.get("pre_tamper")]
    keep = [e for e in evs if not e.get("pre_tamper") and e.get("op") != "__rebase__"]
    removed: set[str] = set()
    for e in keep:
        removed |= set(e.get("removed") or [])
    latest: dict[str, dict] = {}
    for e in keep:
        for f, rec in (e.get("files") or {}).items():
            # 已被 CLI 正常删掉的文件**不进新基线**：留着它，重建后仍会被判
            # 「文件不存在」⇒ rebase 对这类死红无效（4.8.1 的实测）。
            if f in removed:
                continue
            latest[f] = rec if isinstance(rec, dict) else {"sha": rec, "mt": None}
    archive_rel = _write_rebased_archive(st, tainted)
    now = {"ts": datetime.now().astimezone().isoformat(timespec="seconds"),
           "op": "__rebase__", "pre_tamper": [],
           "prov": PROV_VERSION,
           # **出处基线也一并结案**（v5.53.0 · t000448）：`rebase --force` 的语义是
           # 「把基线对齐当前落盘」⇒ 当前在册的 id 一律认账（来历不追究）⇒
           # 「凭空出现的 id」维随之转绿。这正是它的**显式出口**。
           "id_base": sorted(_used_ids(st)),
           "files": {f: {"sha": _sha((st.d / f).read_text(encoding="utf-8")),
                         "mt": (st.d / f).stat().st_mtime_ns}
                     for f in latest if (st.d / f).is_file()}}
    if archive_rel:
        # 标记记路径 ⇒ `--undo` 知道去哪儿搬回；侧档**进基线** ⇒ 它的内容哈希被对账维
        # 看着（有人手改侧档 ⇒ 红 ⇒ 证据侧档受保护）。
        now["rebased_to"] = archive_rel
        now["rebased_count"] = len(tainted)
        now["files"][archive_rel] = {"sha": _sha((st.d / archive_rel).read_text(encoding="utf-8")),
                                      "mt": (st.d / archive_rel).stat().st_mtime_ns}
    with open(wl, "w", encoding="utf-8") as f:
        for e in keep + [now]:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    print(f"handoff rebase: 写事件基线已对齐当前落盘"
          f"（历史 {before} 条 → 搬走 {len(tainted)} 条带旁证的、"
          f"保留 {len(keep)} 条 ＋ 1 条 rebase 标记）")
    for e in tainted:
        for f in (e.get("pre_tamper") or []):
            print(f"    · 已结案：{f}（{e.get('op')}，{e.get('ts')}）")
    if archive_rel:
        print(f"  旁证事件**已搬进** `{archive_rel}`（**没有销毁**）⇒ "
              f"要撤销这次结案：`handoff rebase --undo`")
    else:
        print("  本次没有带旁证的事件（无需搬移）")
    print("  ⚠ 本次结案同时**认账了当前全部在册 id**（`id_base`）⇒「凭空出现的 id」维随之转绿；"
          "认账按既有设计**单调只增**，`rebase --undo` **不回退**这一半")
    return 0


def _rebase_undo(st: Store, wl: Path) -> int:
    """把最近一次结案**搬走**的旁证事件搬回 `writes.jsonl`（v5.71.0 · t000483）。

    撤销的是「旁证结案」这半：搬回 ⇒ `audit_writes` 又会逐条报那些历史旁证 ⇒ 那是
    **撤销结案**应有的样子（红项回来）。另一半（id 空间的认账）按既有设计单调只增
    ⇒ 不回退（输出写明）。

    台账**只追加**：搬回的事件追加在尾部 ⇒ 位置变了 ⇒ 它们的**旧**文件快照会成
    「最新」⇒ 对账维会拿旧快照比当前内容 ⇒ 一片假红 ⇒ 所以末尾补一条 `__unrebase__`
    事件把基线**重新对齐当前落盘**（与 rebase 建基线同法）。
    """
    evs = read_jsonl(wl) if wl.is_file() else []
    undone = {str(e.get("unrebased_from")) for e in evs if e.get("op") == "__unrebase__"}
    mark = None
    for e in reversed(evs):
        rel = e.get("rebased_to")
        if e.get("op") == "__rebase__" and rel and str(rel) not in undone:
            mark = e
            break
    if mark is None:
        die("rebase --undo: 库里没有可撤销的结案（`writes.jsonl` 里没有带 `rebased_to` 的 "
            "`__rebase__` 标记）⇒ 要重新结案跑 `handoff rebase --force`",
            key="没有可撤销的结案")
    arch = st.d / str(mark.get("rebased_to"))
    if not arch.is_file():
        die(f"rebase --undo: 侧档 `{arch.name}` 已丢失 ⇒ 那些旁证事件已无法搬回"
            f"（被手工删过？）⇒ 只能重新结案：`handoff rebase --force`", key="侧档已丢失")
    restored = read_jsonl(arch)
    latest: dict[str, dict] = {}
    removed: set[str] = set()
    for e in evs + restored:
        removed |= set(e.get("removed") or [])
        for f, rec in (e.get("files") or {}).items():
            latest[f] = rec if isinstance(rec, dict) else {"sha": rec, "mt": None}
    files: dict[str, dict] = {}
    for f in latest:
        if f in removed:
            continue
        p = st.d / f
        if p.is_file():
            files[f] = {"sha": _sha(p.read_text(encoding="utf-8")), "mt": p.stat().st_mtime_ns}
    now = {"ts": datetime.now().astimezone().isoformat(timespec="seconds"),
           "op": "__unrebase__", "pre_tamper": [], "prov": PROV_VERSION,
           "unrebased_from": arch.name, "restored": len(restored),
           "files": files}
    with open(wl, "a", encoding="utf-8") as f:      # 台账只追加
        for e in restored:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
        f.write(json.dumps(now, ensure_ascii=False) + "\n")
    print(f"handoff rebase --undo: 已把 {len(restored)} 条旁证事件搬回 `{WRITES_LOG}`"
          f"（来自侧档 `{arch.name}`）⇒ 那些历史旁证**会重新被报出来**（结案已撤销）")
    print("  ⚠ id 空间的认账（`id_base`）**不回退**（按既有设计单调只增）")
    return 0


def cmd_filter(st: Store, a) -> int:
    rows = st.load_live() if not a.id else st.load_live() + st.load_closed()
    if a.id:
        rows = [r for r in rows if r.get("id") == a.id]
        if not rows:
            die(f"filter: 未找到条目 {a.id}（live 与 closed 均无）", 2, key="未找到")
    if a.topic:
        rows = [r for r in rows if r.get("topic") == a.topic]
    if a.domain:
        rows = [r for r in rows if str(r.get("_file", "")).endswith(f"/{a.domain}.jsonl")]
    if a.status:
        rows = [r for r in rows if r.get("status", "open") == a.status]
    if a.json:
        print(json.dumps([ordered(r) for r in rows], ensure_ascii=False, indent=2))
    else:
        for r in rows:
            print(f"{r['id']}\t{r.get('topic','-')}\t{r.get('summary','')}")
    return 0


def entry_display_line(r: dict) -> str:
    """条目在视图与 confirm 题面里的唯一呈现形（[id] + topic + summary ＋ 非 open 时的状态后缀）。
    两处共用同一函数——否则「照视图作答」与「判分口径」必然分叉（09-22 实测连错两题）。"""
    head = " ".join(x for x in (f"[{r['id']}]", r.get("topic", ""), r["summary"]) if x)
    st_ = r.get("status", "open")
    tail = f"  ({st_}" if st_ != "open" else ""
    # v5.19.1：**在等什么也要看得见**。只显示「(blocked)」而不显示等谁/等什么，
    # 接手方就只知道自己被挡了、不知道挡在哪 ⇒ G′ 的「在等什么」模型在**所有读面**
    # （view 列表／view --id／写回读）上都是死的。两种等法都写出来：
    # 等库内某条（blockedBy）＝等那个 id；等所有者/用户/外部（waitingFor）＝等那个值。
    if r.get("blockedBy"):
        tail += f"·等 {r['blockedBy']}"
    elif r.get("waitingFor"):
        tail += f"·等 {r['waitingFor']}"
    if tail:
        tail += ")"
    return head + tail


def decision_title(f: Path) -> str:
    """裁定件的标题（**正文 H1 首行**）。

    为什么取 H1 而不是 frontmatter 的 `title`：`title` 在本技能是**死键**——writer 只把
    标题写成正文 H1，frontmatter 永不含它（独立审计抓到过一次误写，见 `view --id` 的回读
    注释）。加一个 frontmatter 字段要动 `decision` 维的 frontmatter 校验 ＋ 批量改存量
    裁定件，代价远大于收益。

    **唯一源**：view 的裁定节与 confirm 的裁定题都调它——两处各写一遍就会分叉（与
    `entry_display_line` 同理：09-22 实测过连错两题）。
    """
    try:
        text = f.read_text(encoding="utf-8")
    except OSError:
        return ""
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("#"):
            return s.lstrip("#").strip()
    return ""


def _render(st: Store) -> str:
    idx = json.loads((st.d / "index").read_text(encoding="utf-8")) if (st.d / "index").is_file() else {}
    lines = [f"<!-- 生成物 · 非权威 · 由 handoff view 生成于 {today()} -->",
             "# 项目交接视图（handoff view）", ""]
    for s in ("summary", "status", "scope", "exit"):
        p = st.d / s
        lines.append(f"## {s}")
        if p.is_file():
            _txt = p.read_text(encoding="utf-8").strip()
            # v5.32.0（P1）：**散文槽的状态由渲染现算补**（读时算、不落盘 ⇒ 不漂移）：
            # 无时点的行里，每个提到的 `t` 型条目旁标出**真状态** ⇒ 作者不必抄状态副本，
            # 读者也不会把「当时的说法」误读成「现在的实况」。
            if s in PROSE_SLOTS and _txt:
                _txt = annotate_states(st, _txt)
            lines.append(_txt)
        else:
            lines.append("（空）")
        lines.append("")
    # v5.29.0：队列现态**读时现算**（不再落盘）⇒ 读者在视图里直接看到补位顺序，
    # 而热层散文里不再有 O(库规模) 的机器内容。v5.30.0 刀 D：与 `read --derived`
    # **同一个渲染器**（`render_derived`）⇒ 两条读面口径不可能不齐。
    _dv = render_derived(st)
    lines.append("## 队列现态（现算 · 不落盘）")
    lines.append(_dv["queue"].strip())
    lines.append("")
    # v5.30.0：现态计数同样**读时现算、不落盘**（与队列区同构收口）⇒ `status` 槽回归纯散文，
    # 判据维 `counts-stale` 作废（判据面净减一）。渲染规则单源：`counts_lines`。
    lines.append("## 现态计数（现算 · 不落盘）")
    lines.append(_dv["counts"])
    lines.append("")
    nid = st.next_id()
    lines += ["## next（下一步唯一一条）", nid or "（未指定）", ""]
    for slot in ENTRY_SLOTS:
        lines.append(f"## {slot}")
        for r in sorted((x for x in st.load_live() if x.get("_slot") == slot), key=lambda x: x.get("id", "")):
            lines.append("- " + entry_display_line(r))
        lines.append("")
    uc = read_jsonl(st.unconf_file())
    lines.append("## unconfirmed（未能确认）")
    for r in uc:
        lines.append(f"- [{r['id']}] {r.get('src','')} {r['summary']}")
    lines.append("")
    lines.append("## decisions")
    if st.decisions_dir().is_dir():
        # v2.0 D′：① 带标题（认得出）② 标出正在挡路的记录（**哪条现在管我**）。
        # 「生效中」复用现成关系 `blocking_ids(st)`（还在挡人的 id），不另造第二份判断。
        _inforce = blocking_ids(st)
        _held: dict[str, list[str]] = {}
        for r in st.load_live():
            if r.get("blockedBy"):
                _held.setdefault(r["blockedBy"], []).append(r["id"])
        for f in sorted(st.decisions_dir().glob("*.md")):
            fm = _frontmatter(f)
            did = fm.get("id", f.stem)
            title = decision_title(f)
            mark = f"（生效中：挡住 {' '.join(sorted(_held.get(did, [])))}）" if did in _inforce else ""
            lines.append(f"- [{did}] {fm.get('status','')} {fm.get('domain','')} {fm.get('topic','')}"
                         f"{(' — ' + title[:60]) if title else ''}{mark}")
        lines.append("（按 topic 收窄：`handoff filter --topic <词>`；按 id 取全文：`handoff view --id <id>`）")
    lines.append("")
    lines.append("## closed（归档）")
    for r in st.load_closed():
        lines.append(f"- [{r['id']}] {r.get('closed','')} {r.get('summary','')}")
    lines.append("")
    # v5.30.0：末尾那行 JSON 计数**删掉**——现态计数已在上面「现态计数（现算）」一节里，
    # 两处都给同一份事实 = 第二份副本（族 A 的病）。机器面用 `handoff index`。
    return "\n".join(lines) + "\n"


def _fm_split(text: str) -> tuple[str | None, str, bool]:
    """frontmatter 切分的**本件唯一实现**（停手条件②：本脚本随技能分发、装进别仓时不能
    import 宿主仓的 frontmatter 单源，所以认它**自己目录内**的单源 1 处）。

    边界语义与仓内单源一致：**按行**找闭合 `---`（正文里的水平线不参与切分）、不认 YAML
    文档结束符 `...`、开括号＝**首行去尾随空白后恰为 `---`**（行首空白、多一横都不算；
    与宿主仓 frontmatter 单源里的 `split()` 同口径）。此前本件里有
    三套走法（正则 `\n---` 非贪婪、`content.find("\\n---", 3)`、`text.split("---", 2)`），
    对 CRLF 与畸形开括号的反应各不相同 ⇒ 同一个决策文件在不同命令里被解析成不同结果。
    现只此一处。"""
    lines = text.splitlines()
    if not lines or lines[0].rstrip() != "---":
        return None, text, False
    close = next((i for i, l in enumerate(lines[1:], 1) if l.strip() == "---"), None)
    if close is None:
        return None, text, False
    return "\n".join(lines[1:close]), "\n".join(lines[close + 1:]), True


def _fm_parse(fm_text: str | None) -> dict:
    """在**已切出**的 frontmatter 原文上取字段（`key: value` 单层，本件不引 YAML 依赖）。"""
    out: dict = {}
    for ln in (fm_text or "").splitlines():
        if ":" in ln:
            k, v = ln.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def _frontmatter(path: Path) -> dict:
    return _fm_parse(_fm_split(path.read_text(encoding="utf-8"))[0])


def cmd_view(st: Store, a) -> int:
    if a.id:
        hit = [r for r in st.load_live() + st.load_closed() if r.get("id") == a.id]
        if not hit and st.decisions_dir().is_dir():
            # decisions 槽是 `decisions/<id>.md`（frontmatter ＋ 正文），**不在**
            # load_live()/load_closed() 里——那两者只覆盖 jsonl 槽。原实现因此对
            # **每一条决策记录**都报「未找到（live 与 closed 均无）」，而它们明明
            # 在册。查不到的假报比查不到更坏：接收方据此以为决策丢了。
            for f in sorted(st.decisions_dir().glob("*.md")):
                fm = _frontmatter(f)
                if fm.get("id") == a.id or f.stem == a.id:
                    st_ = fm.get("status", "")
                    head = " ".join(x for x in (
                        f"[{a.id}]", fm.get("topic", ""),
                        fm.get("title", "") or f.stem) if x)
                    print(head + (f"  ({st_})" if st_ and st_ != "open" else "")
                          + f"  → {f}")
                    return 0
        if not hit and a.id in _voided_ids(st):
            # **已作废 ≠ 不存在**，与 check 的 D1 同口径（`rm` 会把条目落进
            # `trash/` 并记 `void`）。原实现只看 live/closed/decisions，于是对一个
            # 已经 `rm` 过的 id 报「均无」rc=2 —— 与本技能自己写下的口径相反，
            # 会把人引去查一个根本不该再查的东西。
            print(f"[{a.id}]（已作废：rm 落 trash/ 并记 void，非「查不到」）")
            return 0
        if not hit:
            die(f"view: 未找到条目 {a.id}（live / closed / decisions 均无，且不在 trash/·void）", 2, key="live / closed / decisions 均无")
        for r in hit:
            print(entry_display_line(r))
        return 0
    text = _render(st)
    if not a.save and not a.out:
        sys.stdout.write(text)
        return 0
    path = Path(a.out) if a.out else (st.root_dir / "handoff-view.md")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    except OSError as e:
        print(f"handoff view: 写入失败: {e}", file=sys.stderr)
        return 1
    print(f"handoff view: 已写入 {path.resolve()}")
    return 0


# ---------------- confirm ----------------
def _facts(st: Store):
    live = st.load_live()
    entries = [r for r in live if r.get("_slot") in ENTRY_SLOTS]
    return live, entries


def _slot_questions(st: Store, live: list[dict], entries: list[dict], rng, n: int) -> list[dict]:
    """题面**从槽清单派生**（v2.0 C′）。

    为什么派生而不是硬编码几问：「槽增加」与「题目增加」本是同一件事——写死几问，加一个
    槽就会**静默漏**，而 read-back 是**唯一可机检的转交证据**：漏掉的槽等于没交出去。
    （v2 之前 d 型裁定与 u 型台账永不入题，本仓 125 条裁定在转交证据里是缺席的。）

    每问三段：**问什么（呈现在哪）**、**期望值（从落盘实况算）**、**评分口径**。
    """
    qs: list[dict] = []
    # ── actions 槽：当前条数（最常被问的量）──
    n_actions = len([r for r in live if r.get("_slot") == "actions"])
    qs.append({"q": "actions 槽当前条数？", "kind": "count", "expect": n_actions})
    # ── 跨槽事实：谁在等谁（blocked 的条目）──
    blocked = sorted(r["id"] for r in live if r.get("status") == "blocked")
    qs.append({"q": "列出 status=blocked 的 id（无则答 无）", "kind": "set", "expect": blocked})
    # ── next 指针：下一步唯一一条 ──
    nid = st.next_id()
    qs.append({"q": "next（下一步唯一一条）的 id？", "kind": "scalar", "expect": nid if nid else "无"})
    # ── ENTRY_SLOTS 三槽：随机抽条目核行 ＋ 核它属于哪个槽 ──
    if entries:
        for r in rng.sample(entries, min(n, len(entries))):
            qs.append({"q": f"{r['id']} 的条目行（按视图呈现：[id] + topic + summary，"
                        f"非 open 含末尾 (status〔·等 <blocker 或 waitingFor>〕)）？",
                       "kind": "scalar", "expect": entry_display_line(r)})
        r0 = rng.choice(entries)
        qs.append({"q": f"{r0['id']} 属于哪个槽？", "kind": "scalar", "expect": r0["_slot"]})
    # ── scope 槽：登记了哪些源 ──
    sp = st.d / "scope"
    scope_paths = sorted({l.strip() for l in sp.read_text(encoding="utf-8").splitlines()
                          if l.strip() and not l.strip().startswith("#")}) if sp.is_file() else []
    qs.append({"q": "scope 命中的路径（集合）？", "kind": "set", "expect": scope_paths})
    # ── unconfirmed 槽（u 型：未能确认的事实）──
    uc = read_jsonl(st.unconf_file())
    if uc:
        qs.append({"q": "unconfirmed（未能确认）台账里的 id（集合）？", "kind": "set",
                   "expect": sorted(r["id"] for r in uc)})
    # ── decisions 槽（d 型：已落定的裁定）——抽一条问它的标题 ──
    dec_files = sorted(st.decisions_dir().glob("*.md")) if st.decisions_dir().is_dir() else []
    if dec_files:
        f = rng.choice(dec_files)
        qs.append({"q": f"{f.stem} 这条裁定的标题（正文 H1 首行，前 40 字）？", "kind": "scalar",
                   "expect": decision_title(f)[:40]})
    return qs


def cmd_confirm(st: Store, a) -> int:
    live, entries = _facts(st)
    rng = random.Random(a.seed)
    qs = _slot_questions(st, live, entries, rng, a.n)

    if not a.answers:
        for i, q in enumerate(qs, 1):
            print(f"Q{i}. {q['q']}")
        print("\n# JSON 题面：")
        print(json.dumps([{"q": f"Q{i}", "ask": q["q"]} for i, q in enumerate(qs, 1)], ensure_ascii=False, indent=2))
        return 0

    raw = sys.stdin.read() if a.answers == "-" else Path(a.answers).read_text(encoding="utf-8")
    try:
        ans = json.loads(raw)
    except json.JSONDecodeError as e:
        die(f"confirm: 答案非 JSON: {e}", key="答案非 JSON")
    bad = []
    for i, q in enumerate(qs, 1):
        got = ans.get(f"Q{i}", "")
        if q["kind"] == "set":
            exp = set(q["expect"])
            a_nl, a_ws = split_set_answer(got)
            ok = (exp == a_nl) or (exp == a_ws) if exp else (str(got).strip() in ("无", "", "none", "None"))
        else:
            ok = norm(got) == norm(q["expect"])
        if not ok:
            bad.append((i, q["q"], q["expect"], got))
    if bad:
        print(f"handoff confirm: FAIL（{len(bad)}/{len(qs)} 题不符）")
        for i, q, exp, got in bad:
            print(f"  Q{i} {q}\n    应: {exp}\n    实: {got}")
        return 1
    print(f"handoff confirm: PASS（{len(qs)} 题）")
    return 0


BEGIN_MARK = "<!-- handoff:begin -->"
END_MARK = "<!-- handoff:end -->"


def agents_block_text(profile: str = "basic") -> str:
    """标准交接块正文（两标记之间的内容，逐字节唯一源）。

    唯一源＝`project-handoff/references/agents-handoff-block.md`。别的仓通过
    `--install` 取同一份，**不要在各自 AGENTS.md 里手改条目**：改了不会同步，
    而 `--check` 会立刻报漂移——这与「复制 catalog 条款」导致漂移是同一个病。
    """
    src = Path(__file__).resolve().parent.parent / "references" / "agents-handoff-block.md"
    text = src.read_text(encoding="utf-8")
    if BEGIN_MARK not in text or END_MARK not in text:
        die(f"agents-block: 标准源缺标记（{BEGIN_MARK} / {END_MARK}）：{src}", 2, key="标准源缺标记")
    body = text.split(BEGIN_MARK, 1)[1].split(END_MARK, 1)[0]
    if profile == "freshness":
        fb, fe = "<!-- handoff:freshness:begin -->", "<!-- handoff:freshness:end -->"
        if fb in text and fe in text:
            # 连 **begin 标记一起**带上：它就是 --check 的档位识别锚点。
            # 丢了它，--check 会把增强档误判成 basic（行数不等、且逐行比对打不出差异行，
            # 症状极难认）。这个 bug 就是被 --check 本身抓出来的。
            # ⚠ **end 也必须一起带**（5.1.2 修）：只拼 begin 会让装出来的增强档成为
            #     「只有 begin 的残缺区」，而 --check 拿同一个函数的输出比两边 ⇒ 这种残缺
            #     在源与安装面**同时为真**，任何一次比对都不会红。主区残缺有 `die` 拦，
            #     增强档没有 ⇒ 在下面成对断言补上（能机械判定的就该钉进脚本，别留现场裁量）。
            seg = text.split(fb, 1)[1].split(fe, 1)[0].rstrip()
            body = body.rstrip() + "\n" + fb + "\n" + seg + "\n" + fe + "\n"
    elif profile != "basic":
        die(f"agents-block: 未知档位 {profile!r}（可用：basic / freshness）", 2)
    out = BEGIN_MARK + body.rstrip() + "\n" + END_MARK + "\n"
    # 增强档标记**成对**才谈得上「标记区」：只有一头时 --check 反而永远比不出红
    # （源与安装面都由这同一个函数生成，残缺在两边同时为真）。主区有 die 拦，补这一道。
    if out.count(FRESH_BEGIN) != out.count(FRESH_END):
        die(f"agents-block: 标准源的增强档标记不成对"
            f"（begin {out.count(FRESH_BEGIN)}／end {out.count(FRESH_END)}）——"
            f"残缺区会随 --install 逐字进各仓，且 --check 看不见；修法＝补回源里缺的那一半：{src}", 2)
    return out


FRESH_BEGIN = "<!-- handoff:freshness:begin -->"
FRESH_END = "<!-- handoff:freshness:end -->"

# ── v5.34.0（批 E）：交接块的**内容闸**（V0）────────────────────────────────
# V0：**一句合同句若换个版本可能不成立，它就不是合同，是机制现状** ⇒ 块里不许出现这类句。
# 为什么要有闸：块是**逐字节分发**到各仓的拷贝 ⇒ 一句机制陈述过期时，坏的不是一行而是
# 所有装了块的仓（族 E）。旧形靠人记（块自己的第 4 条纪律「不写机制现状陈述」）⇒ 实测
# 块里 63% 的载荷正是机制陈述与写作格式 ⇒ 那条纪律没被执行 ⇒ 改成**可机械判定**并钉进门禁。
#
# 枚举形态（判定面**只此一份**：本文件里的 `block_line_violation`；仓内那份量化脚本也走它，
# 不另立一套——发布仓不带仓内路径 ⇒ 这里也不写仓内相对路径）。
BLOCK_MECH_TOKENS = (
    "槽", "closed/", "trash/", "archive/", "prev/",
    "writes.jsonl", "log.jsonl", "shifts.jsonl",
    "冷档", "热层", "班次序号", "按补位策略", "落指针", "读写入口",
)
BLOCK_EXIST_RE = re.compile(r"没有[^。；\n]*这条命令|不存在[^。；\n]*命令")
# 「具体计数」的**形态闭集**（v5.37.0 补全，见下）：中文数字或阿拉伯数字 ＋ 量词。
# ⚠ v5.34.0 的旧形只收「X条」与「数字＋{条,道,个,行,次}」⇒ **中文数字＋其它量词全漏**
#   （实测：「三道新鲜度闸」「两项纪律」「三步流程」「四次写入」一律抓不到）
#   ⇒ 旧形**连它自己 docstring 里举的那个例句都抓不到** ⇒ 判据文案假称 ＋ 闸有假阴。
#   修：中文数字补上量词（条/道/次/项/步/款/份/轮/层）；「个」**只对阿拉伯数字**生效
#   （「一个」「两个」多是指代而非计数⇒ 对中文数字开放会误伤）。
BLOCK_COUNT_CN = "条|道|次|项|步|款|份|轮|层"
BLOCK_COUNT_AR = "条|道|个|行|次|项|步|款|份|轮|层"
BLOCK_COUNT_RE = re.compile(rf"[一二三四五六七八九十两]\s*(?:{BLOCK_COUNT_CN})"
                             rf"|[0-9]+\s*(?:{BLOCK_COUNT_AR})")
BLOCK_FORMAT_RE = re.compile(r"紧邻|[（(](?:已闭|已完成|完成|closed)[）)]")


def block_line_violation(line: str) -> str | None:
    """交接块的一行合同句是否**越界**（V0）——返回原因，或 None（合规）。

    判据是**枚举形态**（可机械判定，不靠眼力）：
      ① 散文里出现内部名／槽名／目录名（**命令与 flag 除外**——它们是 CLI 面，跨版本稳定）；
      ② 命令的**存在性**陈述（「没有 x 这条命令」——换版本就可能不成立）；
      ③ 具体计数（中文数字或阿拉伯数字＋量词：「三条」「三道新鲜度闸」「两项纪律」「3 条」）
         ——块自己第 2 条纪律：列举即可，计数一变就假；
      ④ 写作格式要求（「紧邻」「（已闭）」这类）——格式是**工具的欠账**，不该进合同。
    """
    prose = re.sub(r"`(?:handoff |--)[^`]*`", "", line)     # 命令/flag 是稳定接口，不算机制陈述
    for tok in BLOCK_MECH_TOKENS:
        if tok in prose:
            return f"内部名「{tok}」"
    if BLOCK_EXIST_RE.search(line):
        return "命令存在性陈述"
    if BLOCK_COUNT_RE.search(line):
        return "具体计数"
    if BLOCK_FORMAT_RE.search(line):
        return "写作格式要求"
    return None


def inspect_agents_block(repo: Path, profile: str | None = None) -> dict:
    """只读判定 `<repo>/AGENTS.md` 的交接块——`check` 与 `agents-block --check` 共用同一判据。

    `profile`＝**比较用哪一档**（basic／freshness）。缺省＝按文件自己说的档位比
    （旧形）；给出时按它比 ⇒ 期望值可以来自**独立证据**（「装过块」那条 d 型记录里
    记的档位）⇒ 静默降级不再自证通过（t000406）。文件自报的档位始终在 `file_profile` 里。

    state：
      missing    — AGENTS.md 不存在（`check` 视为本维不启用）
      no-markers — 两端标记都不存在（未装块 ⇒ `check` 不启用）
      partial    — 只有一端标记（手改坏过；`--install` 也会拒）
      duplicate  — 多份标记区（单源已破）
      drift      — 块与标准源不一致
      ok         — 一致
      error      — AGENTS.md 读不了

    这里只回答「是哪一态、差在哪」；富文案归调用方——单源的是判据，不是措辞。
    """
    out: dict = {"file": repo / "AGENTS.md", "state": "missing"}
    try:
        text = out["file"].read_text(encoding="utf-8")
    except FileNotFoundError:
        return out
    except (OSError, UnicodeDecodeError) as e:
        out.update(state="error", error=str(e))
        return out
    out["text"] = text
    nb, ne = text.count(BEGIN_MARK), text.count(END_MARK)
    if nb == 0 and ne == 0:
        out["state"] = "no-markers"
        return out
    if (nb == 0) != (ne == 0):
        out.update(state="partial", begin=nb, end=ne)
        return out
    if nb > 1 or ne > 1:
        first = text.split(BEGIN_MARK, 1)[1].split(END_MARK, 1)[0]
        out.update(state="duplicate", begin=nb, end=ne,
                   effective="freshness" if FRESH_BEGIN in first else "basic")
        return out
    got = text.split(BEGIN_MARK, 1)[1].split(END_MARK, 1)[0].strip()
    # 档位：**比较用哪一档**与**文件自己是哪一档**是**两件事**（2026-10-23，t000406）。
    # 旧形只按文件自己说的档位比 ⇒ 期望值取自被检查物本身 ⇒ **静默降级（把增强档条款
    # 搬出比对区）会让检查自证通过**，降级对所有闸不可见（本仓 38814f8 就是这么降的）。
    # ⇒ `profile` 给出时按它比（调用方用**独立证据**——「装过块」那条 d 型记录里记的档位——
    #   解析出期望档位）；`file_profile` 始终报文件自己是什么档，供诊断用。
    file_profile = "freshness" if FRESH_BEGIN in got else "basic"
    effective = profile or file_profile
    want = agents_block_text(effective).split(BEGIN_MARK, 1)[1].split(END_MARK, 1)[0].strip()
    g_lines = [l.strip() for l in got.splitlines() if l.strip()]
    w_lines = [l.strip() for l in want.splitlines() if l.strip()]
    g_set, w_set = set(g_lines), set(w_lines)
    extra = [l for l in g_lines if l not in w_set]
    missing = [l for l in w_lines if l not in g_set]
    out.update(
        state="ok" if got == want else "drift",
        got=got, want=want, effective=effective, file_profile=file_profile,
        extra=extra, missing=missing,
        order_only=(got != want and not extra and not missing),
    )
    return out


HANDOFF_HEADING = re.compile(r"^#{2,3}\s+交接\s*$")


def find_handoff_sections(lines: list) -> list:
    """定位**所有** `## 交接` / `### 交接` 节，返回按出现顺序的 (起, 止右开) 列表。

    识别只认**标题行本身**（可有尾随空白），不靠正文里的「交接」二字——否则会
    把提到交接的普通段落整段吃掉。节到下一个同级或更高级标题为止；文末到 EOF。
    返回全部而非第一个：重复的交接节本身就是「单源」被破坏的现场，只收敛
    第一个会把第二个留在仓里继续被 agent 读到。
    """
    heads = [i for i, ln in enumerate(lines) if HANDOFF_HEADING.match(ln.rstrip())]
    secs = []
    for start in heads:
        level = len(lines[start]) - len(lines[start].lstrip("#"))
        stop = len(lines)
        for j in range(start + 1, len(lines)):
            s = lines[j]
            if s.startswith("#"):
                lv = len(s) - len(s.lstrip("#"))
                if lv <= level:
                    stop = j
                    break
        secs.append((start, stop))
    return secs


def find_handoff_section(lines: list) -> tuple | None:
    secs = find_handoff_sections(lines)
    return secs[0] if secs else None


# 块外的「仓专属」区：**也用成对标记**。理由是领地要能被机器认出来，不能靠「标题下面
# 那一段」这种排版推断——`--install` 要能把它整体读出、合并、原位重写，且永不长出第二个。
# `--check` 只比 `handoff:begin/end` 内部 ⇒ 这个区随仓怎么写都不算漂移。
REPO_HEAD = "### 仓专属交接约定（标准块不收编，勿并入上面那块）"
REPO_BEGIN = "<!-- handoff:repo:begin -->"
REPO_END = "<!-- handoff:repo:end -->"
REPO_HOME = REPO_HEAD.split("（")[0].lstrip("# ").strip()   # 给人看的落点名（去掉括号说明）


def _std_line_set(block: str) -> set:
    """标准块的**行集合**（去首尾空白、跳空行）＝「这行是标准条款吗」的唯一判据。

    用行集合全等、不用相似度：能穷举成闭集的就查表。代价如实写明：
    被改写过措辞的标准条款会被判成「仓专属」而进专节——**多留一行噪声**远小于
    **静默删掉一条人写约定**，两个方向的代价不等，所以分不清就留。
    """
    inner = block.split(BEGIN_MARK, 1)[1].split(END_MARK, 1)[0]
    return {ln.strip() for ln in inner.splitlines() if ln.strip()}


def _repo_lines(text: str) -> list:
    """现有仓专属区的行（原样）。没有该区 → 空。

    只剔**区自己的那一行标题**（按全等），不按 `startswith("#")` 筛——用户完全可能把
    一个小节标题写进自己的约定里，按前缀筛会在「读出来→再写回去」这一圈里**静默丢掉它**，
    而那正是本函数所属的这次修复要根治的病灶。
    """
    if REPO_BEGIN not in text or REPO_END not in text:
        return []
    seg = text.split(REPO_BEGIN, 1)[1].split(REPO_END, 1)[0]
    return [ln for ln in seg.splitlines() if ln.strip() and ln.strip() != REPO_HEAD.strip()]


REPO_SLOT = "\x00handoff-repo-region\x00"      # 摘区时的占位符（原位回填用）


def _restore_repo_region(text: str, lines: list, had_region: bool) -> str:
    """把仓专属区**原位**放回（v5.18.0）。

    - 原文件里有区 ⇒ 占位符原位替换（位置与区前后的空白**原样保留**）。
    - 原文件里没有区 ⇒ 插在标准块之后（与旧行为一致）。
    """
    if not lines:
        return text.replace(REPO_SLOT, "")
    body = [REPO_HEAD, ""] + lines + [""]
    seg = REPO_BEGIN + "\n" + "\n".join(body) + "\n" + REPO_END
    if had_region:
        return text.replace(REPO_SLOT, seg)
    i = text.index(END_MARK) + len(END_MARK)
    return text[:i] + ("\n\n" + seg if lines else "") + text[i:]


def install_block(text: str, block: str) -> tuple:
    """把标准块装进 AGENTS.md 正文。返回 (新正文, 动作, 收敛掉的手写副本行数, 仓专属区行数)。

    三种情形，唯一目标都是**单源**：标记区在 → 原地覆写块内；整节在但标记区不在 →
    整理覆盖该节；都没有 → 新建 `## 交接` 节。

    **人写的行不删，搬出去**（5.1.0，cloud-services 实战报回）。旧形把整节收敛成标准块，
    理由写的是「不留第二份、要原文找 git」——但**很多仓根本不入 git**，那节里的仓专属
    约定当场永久丢失（实测：3 条手写约定被顶掉，既不备份也不给落点）。正解不是事后
    dump 到某个文件等人去捡，而是**安装时就分清领地**：与标准块逐行全等的＝手写副本，
    收敛掉（这单源要的效果）；其余＝仓专属，原样搬进块外的仓专属区（`REPO_*` 标记）。
    于是单源不破（标准条款仍只有一份）、内容不丢（专属条款还在本文件里、就在原位附近）。
    覆写块内与整节收敛**两条路径同一处置**——同一根因不该只修一半。
    """
    inner = block.split(BEGIN_MARK, 1)[1].split(END_MARK, 1)[0]
    new_block = BEGIN_MARK + inner + END_MARK
    std = _std_line_set(block)
    if (BEGIN_MARK in text) != (END_MARK in text):
        # 残缺标记（只有一个端）。此时**不能**继续往下走：静默走整节替换会把
        # 含残片的那一段连人写的内容一起吃掉。宁可拒绝，让人先看。
        return text, "残缺标记", -1, -1
    if text.count(BEGIN_MARK) > 1 or text.count(END_MARK) > 1:
        # 剥块时**保留空行结构**（别顺手 rstrip/丢空行，那会把整个文件的
        # 段落间距和章节顺序搅乱——单源达成不等于可以把别人的排版改掉）。
        text = re.sub(re.escape(BEGIN_MARK) + r".*?" + re.escape(END_MARK),
                      "", text, flags=re.DOTALL)
        return install_block(text, block)  # 剥干净后必是「整节」或「都没有」
    # 旧仓专属区**先整体摘出、读完再重写**：不摘的话它自己那对标记会被下面的
    # 「节内非标准行」扫描当成人写内容二次收编，装一遍就多一层壳。
    merged: list = _repo_lines(text)
    # v5.18.0 修「install 不幂等」：旧形把仓专属区**摘除再插回**，两个点的空白处理不对称
    # ⇒ 每跑一次 `agents-block --install` 就给区后多留几行空行（本仓实测每次 +2～3 行，
    # 跑几次后区与正文之间堆出一片空行）。改成**占位符原位回填**：位置与前后空白原样保留。
    _had_repo = REPO_BEGIN in text and REPO_END in text
    if _had_repo:
        text = re.sub(re.escape(REPO_BEGIN) + r".*?" + re.escape(REPO_END),
                      REPO_SLOT, text, count=1, flags=re.DOTALL)
    if BEGIN_MARK in text:
        # 块内＝标准块的领地 ⇒ 整块覆写；但块内**不属于标准块**的行是有人写进来的，
        # 搬到块外（覆写块内不等于有权删别人的话）。块外的其它内容一律不动。
        head, rest = text.split(BEGIN_MARK, 1)
        old_inner, tail = rest.split(END_MARK, 1)
        mine = [ln.rstrip() for ln in old_inner.splitlines()
                if ln.strip() and ln.strip() not in std]
        n_conv = len([ln for ln in old_inner.splitlines() if ln.strip()]) - len(mine)
        out = head + new_block + tail
        for ln in mine:
            if ln.strip() not in {m.strip() for m in merged}:
                merged.append(ln)
        return _restore_repo_region(out, merged, _had_repo), "更新", n_conv, len(merged)
    lines = text.splitlines()
    secs = find_handoff_sections(lines)
    if secs:
        start, end = secs[0]
        old = [ln for ln in lines[start + 1:end] if ln.strip()]
        # 重复的交接节：全部并入第一节处理，只留第一个装标准块（留着就是第二份来源）。
        for s2, e2 in reversed(secs[1:]):
            old += [ln for ln in lines[s2:e2] if ln.strip()]
            del lines[s2:e2]
            # 注意：start/end 是**剥块后旧位置**算出的，secs[1:] 都在它们之后，
            # 删掉不影响前面的索引——这里绝不能再改 start/end（曾经写成
            # `start = end = min(start, s2)`，链式赋值把 end 压成 start，
            # 于是 lines[4:4]=[...] 变成插入而非替换，原标题被顶到块后面）。
        mine = [ln.rstrip() for ln in old if ln.strip() not in std]
        for ln in mine:
            if ln.strip() not in {m.strip() for m in merged}:
                merged.append(ln)
        seg = [lines[start], "", new_block.rstrip("\n"), ""]
        if merged:
            seg += [REPO_BEGIN, REPO_HEAD, ""] + merged + ["", REPO_END, ""]
        lines[start:end] = seg
        verb = "整理覆盖" if len(secs) == 1 else "整理覆盖+合并重复节"
        return "\n".join(lines).rstrip("\n") + "\n", verb, len(old) - len(mine), len(merged)
    return text.rstrip("\n") + "\n\n## 交接\n\n" + block, "新建", 0, len(merged)


BLOCK_RECORD_MARK = "handoff-block-installed:"
BLOCK_PROFILE_MARK = "handoff-block-profile:"


def _block_install_record(st: Store, repo: Path | None = None) -> Path | None:
    """本仓「装过交接块」那条 d 型记录（幂等查找；没有则 None）。

    **按仓路径作用域化**（v5.21.0）：这条事实说的是「**这个仓**的 AGENTS.md 装过块」，
    而 store 是**可导出/可导入**的（换机/换人）⇒ 导入到新路径后，那条记录描述的是
    **旧路径**的事，对新仓不成立 ⇒ 若不按路径过滤，导入后的 check 会**永久报红**
    （新机还没装块 ⇒ 块维说「装过却不见了」）——那是把别的仓的事实当成本仓的。
    旧记录里存的是**相对路径**（当年写法）⇒ 一律按当前仓根解释（向后兼容）。

    `repo` 缺省＝**本仓**（`st.root_dir`）；给出时按那个路径找 ⇒ `--check <别的仓>`
    不会拿本仓的记录去判别仓。
    """
    dd = st.decisions_dir()
    if not dd.is_dir():
        return None
    want = str(Path(st.root_dir if repo is None else repo).resolve())
    for f in sorted(dd.glob("*.md")):
        try:
            txt = f.read_text(encoding="utf-8")
        except OSError:
            continue
        if BLOCK_RECORD_MARK not in txt:
            continue
        for ln in txt.splitlines():
            if not ln.startswith(BLOCK_RECORD_MARK):
                continue
            raw = ln[len(BLOCK_RECORD_MARK):].strip()
            if not raw:
                continue
            try:
                cand = str(Path(raw).resolve())
            except OSError:
                continue
            if cand == want:
                return f
    return None


def _block_install_profile(st: Store, repo: Path | None = None) -> str | None:
    """「装过块」那条记录里记的**档位**（basic／freshness）；没有记录或没记档位 ⇒ None。

    **为什么档位要落进这条记录**（2026-10-23，t000406）：块的档位（basic／freshness）
    此前**只能从被检查的那个文件里推**（块内有增强档标记就按增强档比）⇒ ⇒ **期望值取自
    被检查物本身** ⇒ 任何一次「静默降级」（把增强档条款搬出比对区）都会让检查**自证通过**
    ——降级对所有闸不可见（本仓 2026-10-20 的批 A 提交 `38814f8` 就是这么降的，跟到
    2026-10-23 才被外报抓出）。⇒ 档位的**期望值**必须落在**独立证据**上：这条 d 型记录
    正好是「本仓装过块、装的是哪一档」的落盘证据 ⇒ 判据拿它与文件现状对账 ⇒ 降级即红。
    """
    f = _block_install_record(st, repo)
    if f is None:
        return None
    try:
        txt = f.read_text(encoding="utf-8")
    except OSError:
        return None
    for ln in txt.splitlines():
        if ln.startswith(BLOCK_PROFILE_MARK):
            p = ln[len(BLOCK_PROFILE_MARK):].strip()
            if p in ("basic", "freshness"):
                return p
    return None


def _resolve_block_profile(st: Store, repo: Path, explicit: str | None = None) -> str:
    """块档位的**解析口径（唯一源）**：显式 `--profile` 优先；否则按
    **记录（独立证据）⇒ 文件现状 ⇒ basic**。

    为什么不能一律用 basic（2026-10-23，t000406）：那会让**任何一次不带 `--profile` 的
    `--install` 把增强档仓静默降级**（增强档条款被搬出比对区 ⇒ 变成无人看守的手抄副本），
    而降级对所有闸不可见（期望值取自被检查物本身 ⇒ 自证通过）。
    缺省时的解析顺序：
      ① **记录里记着的档位**（独立证据，权威）⇒ 装块时按它装 ⇒ 顺带把降级**修回来**；
      ② 没有记录 ⇒ **文件现状**的档位 ⇒ 保住既有档位，不静默改档；
      ③ 都没有 ⇒ basic（首次安装的缺省）。
    """
    if explicit:
        return explicit
    p = _block_install_profile(st, repo)
    if p:
        return p
    info = inspect_agents_block(repo)
    eff = info.get("effective")
    if eff in ("basic", "freshness"):
        return eff
    return "basic"


def _record_block_install(st: Store, repo: Path, profile: str = "basic") -> Path | None:
    """把「本仓装过交接块」记成一条 d 型记录（幂等；已记过且档位一致则 None）。

    为什么要有这条记录：`init`/install 时块被装进 AGENTS.md，但**事实只存在于那个文件里**
    ——人把它整段删掉后，「装过」与「没装过」在证据上不可区分 ⇒ 最重的漂移形态永远不会被报。

    落点选 d 型（`decisions/<id>.md`）而不是新文件类型：d 型已有整套机制（view 可见、
    可作废、可 supersedes、迁移随 store 走），**新文件类型＝新的一套生命周期要养**。
    **它是事实登记，不是判断**（d 型语义扩展：事实类记录用固定 topic「事实登记」）。

    **记录里也记档位**（2026-10-23，t000406）：档位此前只能从被检查的文件里推 ⇒ 期望值
    取自被检查物本身 ⇒ 静默降级对所有闸不可见 ⇒ 档位的期望值必须落在**独立证据**上。

    写事件对账：d 型已进 `_write_targets()`（v5.57.0 · t000461）⇒ 裁定件载体也在台账里
    （增量记录 ⇒ 每条事件只多「变过的那几件」）。
    """
    _existing = _block_install_record(st, repo)
    if _existing is not None:
        # 已记过：**只在档位变了**时就地改那一行（`id`／`created`／正文逐字不动——
        # 它们是「这是哪条记录、哪天的记录」的证据，改了就是篡改登记）。
        _txt = _existing.read_text(encoding="utf-8")
        if BLOCK_PROFILE_MARK in _txt:
            _new = re.sub(rf"^{re.escape(BLOCK_PROFILE_MARK)}.*$",
                          f"{BLOCK_PROFILE_MARK} {profile}", _txt, count=1, flags=re.M)
        else:
            _new = _txt.replace(
                f"{BLOCK_RECORD_MARK} {Path(repo).resolve()}\n",
                f"{BLOCK_RECORD_MARK} {Path(repo).resolve()}\n{BLOCK_PROFILE_MARK} {profile}\n", 1)
        if _new == _txt:
            return None
        _existing.write_text(_new, encoding="utf-8")
        return _existing
    did = st.allocate("d")
    st.decisions_dir().mkdir(parents=True, exist_ok=True)
    text = (f"---\nid: {did}\ncreated: {today()}\nstatus: accepted\ntopic: 事实登记\n"
            f"---\n# 本仓启用交接块\n\n"
            f"{BLOCK_RECORD_MARK} {Path(repo).resolve()}\n"
            f"{BLOCK_PROFILE_MARK} {profile}\n\n"
            f"本仓 AGENTS.md 的交接块由 project-handoff 的唯一源管理"
            f"（`references/agents-handoff-block.md`）。\n\n"
            f"**这条记录的作用**：块若被整段删掉，`check` 靠它判「本仓装过、现在不见了」"
            f"——没有它，「装过」与「没装过」在证据上不可区分，最重的漂移形态就永远不会被报。\n\n"
            f"**档位也记在这里**：`handoff-block-profile` 是本仓**应当**用的块档位——"
            f"它是独立于被检查文件的期望值 ⇒ 有人把增强档条款搬出比对区（静默降级）时，"
            f"`check` 拿它与文件现状对账 ⇒ 降级即红（此前降级对所有闸不可见，t000406）。\n\n"
            f"本仓不再用交接时：`handoff rm {did}`（落 trash ＋ 记 void）。\n")
    doc = st.decisions_dir() / f"{did}.md"
    doc.write_text(text, encoding="utf-8")
    return doc


def cmd_agents_block(st: Store, a) -> int:

    if a.print_only:
        sys.stdout.write(agents_block_text(a.profile or _resolve_block_profile(st, st.root_dir)))
        return 0

    if a.check is not None:
        repo = Path(a.check).resolve()
        _prof = _resolve_block_profile(st, repo, a.profile)
        info = inspect_agents_block(repo, profile=_prof)
        f = info["file"]
        if info["state"] == "missing":
            print(f"agents-block: FAIL（{f} 不存在）", file=sys.stderr)
            return 1
        if info["state"] == "error":
            print(f"agents-block: FAIL（读不了 {f}：{info['error']}）", file=sys.stderr)
            return 1
        text = info["text"]
        # v5.21.0：**两种情形要分开**——
        # ① 本仓**没有任何交接节** ⇒ 它根本没用本约定 ⇒ 与 `check` 的同名维同口径「不启用」
        #    （此前 `--check` 报 FAIL ⇒ 用本技能的其它仓在 smoke 里跑这条命令会必红）；
        # ② 本仓**有交接节、但没有受管标记区** ⇒ 它确实在用交接约定、只是内容不是受管块 ⇒
        #    **该红**，且要给内容级对照（哪些是手写副本、哪些独有、哪些会被 install 搬走）。
        _secs0 = find_handoff_sections(text.splitlines())
        if info["state"] == "no-markers" and not _secs0:
            print(f"agents-block: 不适用（{f} 没有标记区、也没有「## 交接」节——"
                  f"本仓未用交接块约定；`check` 的同名维也按「不启用」处理）")
            return 0
        if info["state"] in ("no-markers", "partial"):
            print(f"agents-block: FAIL（{f} 没有 {BEGIN_MARK} / {END_MARK} 标记区）", file=sys.stderr)
            # 「没标记区」这支**不在** 4.9.0 三态分流范围内（分流要先认得出标记区）。
            # `--install` 在这种仓上走「整节收敛」。**v5.1 起不再吃人写内容**：与标准块
            # 全等的行＝手写副本（块里自带，收敛无损），其余原样搬进块外专节。这里提前
            # 把**两类行数与独有行本身**打出来——旧形只给一个总数，「哪些内容会丢」还得
            # 人自己逐条比（cloud-services 实测：规避靠用户先发现会丢什么）。
            secs = find_handoff_sections(text.splitlines())
            risky = [s for s in secs
                     if any(l.strip() for l in text.splitlines()[s[0] + 1:s[1]])]
            if risky:
                _ln = text.splitlines()
                body = [l for s in risky for l in _ln[s[0] + 1:s[1]] if l.strip()]
                _std = _std_line_set(agents_block_text(_prof))
                extra = [l.rstrip() for l in body if l.strip() not in _std]
                print(f"  ⚠ 判定：仓里有 {len(risky)} 个非空 `## 交接` 节（共 {len(body)} 行非空）"
                      f"但认不出标记区。", file=sys.stderr)
                print(f"  `--install` 走整节收敛：{len(body) - len(extra)} 行是标准条款的**手写副本**"
                      f"（块里本来就有，收敛不产生丢失）；{len(extra)} 行**不在标准块里** ⇒ 原样搬进"
                      f"块外的「{REPO_HOME}」区。", file=sys.stderr)
                for l in extra[:5]:
                    print(f"    独有: {l[:90]}", file=sys.stderr)
                if len(extra) > 5:
                    print(f"    …另有 {len(extra) - 5} 行（install 后都在那个专节里）", file=sys.stderr)
                print(f"  修：直接跑 `--install {repo}` 即可，不必先手工备份。", file=sys.stderr)
            else:
                print(f"  判定：没有非空的 `## 交接` 节，`--install` 会新建一节，"
                      f"不丢内容。", file=sys.stderr)
                print(f"  修：python3 <handoff>/scripts/handoff.py agents-block --install {repo}",
                      file=sys.stderr)
            return 1
        if info["state"] == "duplicate":
            print(f"agents-block: FAIL（{f} 有 {info['begin']} 个 {BEGIN_MARK}／"
                  f"{info['end']} 个 {END_MARK}——多份交接块并存＝单源已破）",
                  file=sys.stderr)
            print(f"  修：--install 会收敛到一份（重复的交接节一并合并）。", file=sys.stderr)
            return 1
        if info["state"] == "drift":
            got, want = info["got"], info["want"]
            print(f"agents-block: FAIL（{f} 的交接块与标准源不一致）", file=sys.stderr)
            # 差异按**行集合**分三类（不按位置）——旧形用 zip 按位置比，
            # 短序列一截断就**零差异行**（只在块末追加一行时实测 rc=1 但什么也不说）。
            g_lines = [l.strip() for l in got.splitlines() if l.strip()]
            w_lines = [l.strip() for l in want.splitlines() if l.strip()]
            extra = info["extra"]
            missing = info["missing"]
            n_diff = 0
            for i in range(max(len(g_lines), len(w_lines))):
                g = g_lines[i] if i < len(g_lines) else "（仓里没有这一行）"
                w = w_lines[i] if i < len(w_lines) else "（源里没有这一行）"
                if g != w:
                    n_diff += 1
                    if n_diff <= 3:
                        print(f"  差异 行{i + 1}:", file=sys.stderr)
                        print(f"    仓里: {g[:90]}", file=sys.stderr)
                        print(f"    源里: {w[:90]}", file=sys.stderr)
            if n_diff > 3:
                print(f"  …另有 {n_diff - 3} 行差异", file=sys.stderr)
            # 分流：有没有「人写内容」决定 `--install` 危不危险——它会覆盖块内一切。
            # 混为一谈就会在「块里有人写的条款」时把人写的内容静默吃掉
            # （与 4.8.6 修掉的 prev/「回退建议」同型：把静默丢弃说成正常操作）。
            if extra:
                print(f"  判定：块内有 {len(extra)} 行**源里没有的内容**（人手写条款）"
                      f"——`--install` 会把它们**原样搬进块外的「{REPO_HOME}」区**"
                      f"（v5.1 起不再覆盖；此前会静默吃掉）。", file=sys.stderr)
                for l in extra[:3]:
                    print(f"    人写: {l[:90]}", file=sys.stderr)
                print("  修：直接 --install，然后去那个专节逐条读一遍——留在块外还是删掉，"
                      f"是你的判断不是工具的。--install {repo}", file=sys.stderr)
            if missing:
                tag = "且" if extra else "块内是标准的、只是"
                print(f"  判定：{tag}**缺 {len(missing)} 行标准条款**（版本落后或被删）"
                      f"——`--install` 补装不会丢你写的内容。", file=sys.stderr)
                print(f"  修：--install {repo}（块外不动）。", file=sys.stderr)
            if not extra and not missing:
                print("  判定：两侧行集合相同、只是**顺序/重复**不同（手工整理过）。", file=sys.stderr)
                print(f"  修：--install {repo} 收敛为标准顺序（内容无损）。", file=sys.stderr)
            # **档位对账**（2026-10-23，t000406）：文件自报的档位 vs 记录里要求的档位。
            # 两者不一致＝有人把增强档条款搬出了比对区（静默降级）⇒ 此前**对所有闸不可见**
            # （期望值取自被检查物本身 ⇒ 自证通过）。这里点明它，并给自愈命令。
            _rec_prof = _block_install_profile(st, repo)
            _file_prof = info.get("file_profile")
            if _rec_prof and _file_prof and _rec_prof != _file_prof:
                print(f"  判定：**块档位被降了**——库内记录要求「{_rec_prof}」档，"
                      f"文件现在自报「{_file_prof}」档"
                      f"（增强档条款被搬出了比对区 ⇒ 它成了无人看守的手抄副本）。",
                      file=sys.stderr)
                print(f"  修：--install {repo}（**不带 --profile** 即可：档位按库内记录解析，"
                      f"装块时会把降级修回来）。", file=sys.stderr)
            return 1
        print(f"agents-block: OK（{f} 交接块与标准源一致）")
        return 0

    if a.install is not None:
        repo = Path(a.install).resolve()
        # 档位按**独立证据**解析（记录 ⇒ 文件现状 ⇒ basic），不一律用 basic ⇒
        # 一次不带 `--profile` 的 `--install` **不会再把增强档仓静默降级**
        # （t000406：降级对所有闸不可见，因为期望值取自被检查物本身）。
        _prof = _resolve_block_profile(st, repo, a.profile)
        block = agents_block_text(_prof)
        f = repo / "AGENTS.md"
        if not f.is_file():
            print(f"agents-block: FAIL（{f} 不存在——先建仓或给对仓根）", file=sys.stderr)
            return 1
        text = f.read_text(encoding="utf-8")
        text, verb, converged, salvaged = install_block(text, block)
        if verb == "残缺标记":
            print(f"agents-block: FAIL（{f} 的标记区残缺——只有 "
                  f"{BEGIN_MARK if BEGIN_MARK in text else END_MARK}，缺另一端）",
                  file=sys.stderr)
            print("  这是手改坏过的痕迹。不自动修：**认不出块界就分不了「哪行是标准条款、哪行是你写的」**，"
                  "安置与收敛都无从谈起，硬走整节替换会连带吃掉人写内容。"
                  "修：把残缺的那一行删掉（或补齐另一端），再跑 --install。", file=sys.stderr)
            return 1
        f.write_text(text, encoding="utf-8")
        # v5.18.0（v2.0 F′）：装块＝把「本仓装过块」这个**事实**落进库里（幂等）。
        # 没有它，人把块整段删掉后「装过」与「没装过」不可区分 ⇒ 最重的漂移形态不被报。
        try:
            st.note_pre_tamper()
            _rec = _record_block_install(st, repo, _prof)
            if _rec is not None:
                st.write_index("agents-block:install", extra=[_rec], ids=[_rec.stem])
                print(f"agents-block: 已登记「本仓启用交接块」→ {_rec.name}"
                      f"（档位 {_prof}）")
        except Exception as e:      # 登记失败不阻断装块（块已装好；缺登记只是少一道闸）
            print(f"  提示：交接块已装好，但「装过块」的库内登记失败（{e}）"
                  f"——不影响本次安装。", file=sys.stderr)
        # 来源由 `verb` 分得出来，不必靠相似度猜：**「更新」搬出去的行原来在标记区内**，
        # 那最可能是**上一版标准条款的旧拷贝**（标准源改了措辞，旧行就不再逐行全等）；
        # 而「整理覆盖」搬出去的行来自手写节，默认就是仓专属。两种都要说清怎么办——
        # 留在仓专属区的旧拷贝是**慢动作双源**：`--check` 不比块外，它不会自己报警。
        if salvaged and verb == "更新":
            print(f"agents-block: {verb}交接块 → {f}（块外内容未动）",
                  f"\n  ⚠ {salvaged} 行**原在标记区内**、且不等于当前标准条款 ⇒ 多半是上一版"
                  f"标准条款的旧拷贝。已安置到「{REPO_HOME}」区，但请逐条确认："
                  f"确认是旧的就**删掉那行**（块内已有新版），别让它长期当仓专属约定留着。",
                  file=sys.stderr)
        else:
            tail = (f"；{salvaged} 行**标准块里没有**的内容已原样安置到块外的「{REPO_HOME}」区"
                    if salvaged else "")
            if verb.startswith("整理覆盖"):
                print(f"agents-block: {verb}交接块 → {f}"
                      f"（节内 {converged} 行与标准块逐行相同 ⇒ 按手写副本收敛，块里本来就有{tail}）")
            else:
                print(f"agents-block: {verb}交接块 → {f}（块外内容未动{tail}）")
        return 0

    print("用法：agents-block --print | --install <仓根> | --check <仓根>", file=sys.stderr)
    return 2


# ---------------- export / import ----------------
# **导出清单的格式版本**（v5.64.0 · t000468）：schema 2 ＝ 带**库级事实面**三段
#   （已作废 id 名单／已移走的那一份／冷档）。schema 1 是旧形（只搬条目面）⇒
#   一次往返就把「**id 永不复用**」这条硬不变量弄丢（实测：导入库把源库已作废的
#   `t000001` 原样重新分配出去，且无闸可抓）⇒ 旧清单仍可读，但**导入后必须提示**。
EXPORT_SCHEMA = 2


def export_records(st: Store) -> list[dict]:
    """**整库往返清单**（v5.64.0 · t000468）：条目面 ＋ **库级事实面**三段。

    **为什么必须带那三段**（根因推导见本技能的**版本演进记录** v5.64.0 条目）：
    「整库事实」有**两个产生源**——**条目面**（actions/pitfalls/commands/unconfirmed/
    closed/decisions ＋ 文本槽 ＋ next）与**库级事实面**（`void` 已作废 id 名单／
    `trash/` 已移走的那一份／`archive/` 冷档）。旧形只搬前者 ⇒ 一次往返：①
    `allocate` 靠 `all_ids() + _void_ids()` 防复用的**那道防线没了** ⇒ 源库已作废的
    id 被原样重新分配出去；② `unvoid --restore` 的前提（trash 里有那一份）没了；
    ③ 冷档班段没了。⇒ **export 必须是全库往返**——`references/cli.md` 把
    `export→改→import --force` 列为**纠错入口** ⇒ 它就是整库搬运的载体。
    """
    recs = [{"_format": "handoff", "schema": EXPORT_SCHEMA,
             "exported": date.today().isoformat(),
             "counts": {s: len([r for r in st.load_live() if r.get("_slot") == s]) for s in ENTRY_SLOTS}}]
    for slot in ENTRY_SLOTS:
        for f in sorted((st.d / slot).glob("*.jsonl")):
            part_key = "purpose" if slot == "commands" else "domain"
            for r in read_jsonl(f):
                rec = {"_kind": "entry", "_slot": slot, f"_{part_key}": f.stem}
                rec.update(ordered(r))
                recs.append(rec)
    for r in read_jsonl(st.unconf_file()):
        rec = {"_kind": "entry", "_slot": "unconfirmed"}
        rec.update(ordered(r))
        recs.append(rec)
    for r in st.load_closed():
        rec = {"_kind": "entry", "_slot": "closed"}
        rec.update(ordered(r))
        recs.append(rec)
    for f in sorted(st.decisions_dir().glob("*.md")) if st.decisions_dir().is_dir() else []:
        recs.append({"_kind": "doc", "_slot": "decisions", "_id": f.stem, "content": f.read_text(encoding="utf-8")})
    for s in SINGLES:
        p = st.d / s
        recs.append({"_kind": "doc", "_slot": s, "content": p.read_text(encoding="utf-8") if p.is_file() else ""})
    recs.append({"_kind": "ref", "_slot": "next", "ref": st.next_id()})
    # ── 库级事实面三段（v5.64.0）——**恒发**（哪怕是空的）⇒ 清单形状恒定 ⇒ 闸可判 ──
    recs.append({"_kind": "void", "ids": _void_ids(st)})
    _trash: list[dict] = []
    _td = st.d / "trash"
    if _td.is_dir():
        for f in sorted(_td.iterdir()):
            if f.is_file():
                _trash.append({"_name": f.name, "content": f.read_text(encoding="utf-8")})
    recs.append({"_kind": "trash", "items": _trash})
    _arch: list[dict] = []
    _ad = st.d / "archive"
    if _ad.is_dir():
        for f in sorted(_ad.glob("*.jsonl")):
            _arch.append({"_slot": f.stem, "lines": f.read_text(encoding="utf-8")})
    recs.append({"_kind": "archive", "items": _arch})
    return recs


def export_roundtrip_violations(recs: list[dict] | None = None) -> list[str]:
    """**导出往返闸**（v5.64.0 · t000468）：清单必须带齐**库级事实面**三段。

    **判据（形状、可实算、零误报）**：
    ① meta 的 `schema` ≥ 2（schema 1 ＝ 旧形，不带库级事实面 ⇒ 往返会丢不变量）；
    ② 三段（`void`／`trash`／`archive`）**各恰一段**（export 恒发 ⇒ 形状恒定
       ⇒ 可判；少一段＝有人把搬运面删了）；
    ③ `void` 段的 `ids` 是字符串列表；`trash` 段每项有 `_name`＋`content`；
       `archive` 段每项有 `_slot`＋`lines`。

    **消费主体**（持续消费 ⇒ 进门禁）：① `export` 命令**写前自检**
    （不写出坏清单）；② selftest 的正控（现清单零违例）＋负控（拿掉 void 段 ⇒ 红）。
    """
    out: list[str] = []
    if recs is None:
        return ["导出往返闸：没拿到清单（调用方漏传）⇒ 无法判"]
    if not recs:
        return ["导出往返闸：清单为空 ⇒ 不是合法导出"]
    meta = recs[0] if isinstance(recs[0], dict) else {}
    _schema = meta.get("schema")
    if not isinstance(_schema, int) or _schema < EXPORT_SCHEMA:
        out.append(f"导出清单的 schema＝{_schema!r}（< {EXPORT_SCHEMA}）⇒ 不带库级事实面"
                   f"（已作废 id 名单／trash／冷档）⇒ **往返会丢「id 永不复用」这条不变量**"
                   f"　修：重导一份 schema {EXPORT_SCHEMA} 的清单")
    by_kind: dict[str, list[dict]] = {}
    for rec in recs[1:]:
        if isinstance(rec, dict):
            by_kind.setdefault(str(rec.get("_kind")), []).append(rec)
    for kind, what in (("void", "已作废 id 名单"), ("trash", "已移走的那一份"),
                       ("archive", "冷档")):
        secs = by_kind.get(kind, [])
        if len(secs) != 1:
            out.append(f"导出清单里 `{kind}` 段（{what}）有 {len(secs)} 段（须恰好 1 段）"
                       f"　修：export 恒发这三段（哪怕是空的）")
            continue
        sec = secs[0]
        if kind == "void":
            ids = sec.get("ids")
            if not isinstance(ids, list) or any(not isinstance(x, str) for x in ids):
                out.append("导出清单 `void` 段的 `ids` 不是字符串列表"
                           "　修：写成 `{\"_kind\":\"void\",\"ids\":[…]}`")
        elif kind == "trash":
            items = sec.get("items")
            if not isinstance(items, list):
                out.append("导出清单 `trash` 段的 `items` 不是列表　"
                           "修：写成 `{\"_kind\":\"trash\",\"items\":[…]}`")
            else:
                for it in items:
                    if not isinstance(it, dict) or "_name" not in it or "content" not in it:
                        out.append("导出清单 `trash` 段里有项缺 `_name`／`content`"
                                   "　修：每项写成 `{\"_name\":…,\"content\":…}`")
                        break
        else:
            items = sec.get("items")
            if not isinstance(items, list):
                out.append("导出清单 `archive` 段的 `items` 不是列表　"
                           "修：写成 `{\"_kind\":\"archive\",\"items\":[…]}`")
            else:
                for it in items:
                    if not isinstance(it, dict) or "_slot" not in it or "lines" not in it:
                        out.append("导出清单 `archive` 段里有项缺 `_slot`／`lines`"
                                   "　修：每项写成 `{\"_slot\":…,\"lines\":…}`")
                        break
    return out


def cmd_export(st: Store, a) -> int:
    recs = export_records(st)
    # **写前自检**（v5.64.0）：清单形状不对 ⇒ 不写出去（写出去就是一份会把不变量
    # 弄丢的清单，而用户看不出问题）⇒ 形状闸是**写面**闸，不是事后闸。
    _viol = export_roundtrip_violations(recs)
    if _viol:
        die("export: 清单形状不对，拒绝写出（会写出丢不变量的清单）\n  - "
            + "\n  - ".join(_viol[:6]), key="清单形状不对")
    text = "\n".join(json.dumps(r, ensure_ascii=False) for r in recs) + "\n"
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8")
        print(f"handoff export: 已写入 {Path(a.out).resolve()}")
    else:
        sys.stdout.write(text)
    return 0


def store_has_entries(st: Store) -> bool:
    for f in st.live_shards() + st.closed_shards():
        if f.stat().st_size > 0:
            return True
    if st.unconf_file().is_file() and st.unconf_file().stat().st_size > 0:
        return True
    if st.decisions_dir().is_dir() and any(st.decisions_dir().glob("*.md")):
        return True
    return False


def _reset_store(st: Store):
    """清空数据槽（保留 legacy/ 归档），供 import --force 重置。

    **库级事实面（`void`／`trash/`／`archive/`）不在清空范围内**（v5.64.0）：
    清掉却还原不了＝毁掉无法还原的东西 ⇒ 清单带这三段时由写入段**替换**，
    清单不带（schema 1）时**原样保留**（并提示，见 `cmd_import`）。
    """
    for slot in ENTRY_SLOTS:
        d = st.d / slot
        if d.is_dir():
            shutil.rmtree(d)
    for d in (st.decisions_dir(), st.d / "closed"):
        if d.is_dir():
            shutil.rmtree(d)
    for f in (st.unconf_file(), st.d / "index", st.d / "next", st.d / "log.jsonl", *[st.d / s for s in SINGLES]):
        if f.is_file():
            f.unlink()


def _fm_fields(content: str) -> dict:
    """字符串入口（`import` 预校验、`supersedes` 扫描拿的是内容而非路径）。
    切分与取字段都走本件唯一实现 `_fm_split`／`_fm_parse`，不再另起一套边界判定。"""
    return _fm_parse(_fm_split(content)[0])


def _prevalidate_import(recs, today_: str):
    """写前校验：失败即中止，**不留半写存储**（不先重置）。"""
    for i, rec in enumerate(recs[1:], 2):
        k, slot = rec.get("_kind"), rec.get("_slot")
        if k == "entry":
            if slot not in ("actions", "pitfalls", "commands", "unconfirmed", "closed"):
                die(f"import: 第 {i} 行不支持的 entry _slot={slot!r}", key="不支持的")
            for f in ("created", "closed"):
                v = rec.get(f)
                if v and not DATE_RE.match(str(v)):
                    die(f"import: 第 {i} 行 {f}={v!r} 非日期（YYYY-MM-DD）", key="非日期")
            if slot == "closed" and not rec.get("id") and rec.get("_type") not in ("t", "p", "d", "c", "q"):
                die(f"import: 第 {i} 行 closed 记录缺 id 且 `_type` 非法——"
                    f"closed 记录要带 `id` 与 `_type`（{IMPORT_TYPE_FORM}）；"
                    f"补上再导：`handoff import <file>`")
        elif k == "doc":
            if slot == "decisions":
                did = rec.get("_id")
                if not did or not re.match(r"^d\d{6}$", str(did)):
                    die(f"import: 第 {i} 行 decisions doc 缺合法 _id（d<6 位>）", key="缺合法 _id")
                fm = _fm_fields(rec.get("content", ""))
                if fm.get("id") != did:
                    die(f"import: 第 {i} 行 decisions/{did}.md frontmatter id={fm.get('id')!r} 与文件名不符", key="与文件名不符")
                if not DATE_RE.match(str(fm.get("created", ""))):
                    die(f"import: 第 {i} 行 decisions/{did}.md frontmatter created 缺或非日期", key="created 缺或非日期")
            elif slot not in SINGLES:
                die(f"import: 第 {i} 行不支持的 doc _slot={slot!r}", key="不支持的")
            elif slot in ("exit", "summary", "status"):
                # v5.30.0 刀 C：**热层字节闸在写入前**生效（不留半写存储）。
                # 旧形 import 直写文件绕过闸 ⇒ 能造出 exit 16220 字节的非法库而 check 仍绿。
                # ⇒ 源清单的热层超限即拒，并说清怎么改（清单是 JSONL ⇒ 直接编辑那份文件）。
                _cap = _hot_cap_limit(slot)
                _txt = str(rec.get("content", ""))
                if _cap and len(_txt) > _cap:
                    die(f"import: 第 {i} 行 {slot} 内容 {len(_txt)} 字符超热层上限 {_cap}"
                        f"——**拒绝导入**（不留半写存储）：先把清单里这个槽裁到 {_cap} 字符内"
                        f"（清单是 JSONL ⇒ 直接编辑那一份文件），或用 `handoff compact {slot}`"
                        f" 裁剪**源库**后再导出")
        elif k == "ref" and slot == "next":
            pass
        elif k == "void":                 # v5.64.0（t000468）：库级事实面三段
            ids = rec.get("ids")
            if not isinstance(ids, list) or any(not isinstance(x, str) for x in ids):
                die(f"import: 第 {i} 行 `void` 段的 ids 不是字符串列表"
                    "（清单形状不对 ⇒ 拒绝导入，不留半写存储）", key="清单形状不对")
        elif k == "trash":
            items = rec.get("items")
            if not isinstance(items, list) or any(
                    not isinstance(it, dict) or "_name" not in it or "content" not in it
                    for it in items):
                die(f"import: 第 {i} 行 `trash` 段形状不对（每项须有 `_name` 与 `content`）"
                    "（清单形状不对 ⇒ 拒绝导入，不留半写存储）", key="清单形状不对")
        elif k == "archive":
            items = rec.get("items")
            if not isinstance(items, list) or any(
                    not isinstance(it, dict) or "_slot" not in it or "lines" not in it
                    for it in items):
                die(f"import: 第 {i} 行 `archive` 段形状不对（每项须有 `_slot` 与 `lines`）"
                    "（清单形状不对 ⇒ 拒绝导入，不留半写存储）", key="清单形状不对")
        else:
            die(f"import: 第 {i} 行不支持的记录 _kind={k!r} _slot={slot!r}（不静默丢弃）", key="不支持的")


# ---- v5.69.0（t000475·③）：import 后 check 未过 ⇒ **三类原因**分列，各带可执行出路 ----
# 旧形一句「内容仍落地，请检查」把三类原因混在一起 ⇒ 用户不知道该查哪（第三轮 #9）。
# 分类依据＝**check 自己打印的原文**（落盘证据）：三个维的报错串各不相同且稳定 ⇒
# 不猜、不靠模型判断。三类都没命中时如实说「不是这三类」并给原文 ⇒ 不硬塞。
IMPORT_FAIL_CLASSES = (
    ("scope 不可解析", "① scope 不可解析",
     "登记的路径/glob 在库里解析不到 ⇒ 修：`handoff scope rm <登记>`（或把路径补回再导一次）"),
    ("没有这个 id", "② 文本悬空",
     "散文里点名的条目 id 在库里查不到 ⇒ 修：补齐那条 id 的条目，或把散文里的 id 改成库里已有的"),
    ("写事件对账", "③ 写事件重导",
     "导入内容与写事件台账对不上 ⇒ 修：先 `handoff export --out <清单>` 核对，"
     "再 `handoff import --force` 重导一次（旧库已被重置，别叠加）"),
)


def import_check_failure_message(raw: str) -> str:
    """把 check 的原文变成**按三类原因分列**的报错（每类自带可执行出路）。

    做成**纯函数**（输入＝check 的输出原文）：夹具能直接拿它做断言与变异自证
    （改输入 ⇒ 消息必变 ⇒ 这条腿不是恒绿）。

    分类**只看 check 的红项行**（`- ` 开头）＋ FAIL 头 ⇒ 不把 stderr 上的平台提示
    （非 POSIX 那句里也含「写事件对账」四个字）算成红项。"""
    err_lines = [ln.strip() for ln in raw.splitlines()
                 if ln.strip().startswith("- ") or ln.strip().startswith("handoff check:")]
    body = "\n".join(err_lines)
    hits = [(title, fix) for sig, title, fix in IMPORT_FAIL_CLASSES if sig in body]
    lines = ["import: 导入后 check 未过（**内容仍已落地**，别回滚、别重复导）——按原因对号入座："]
    for title, fix in hits:
        lines.append(f"　{title}：{fix}")
    if not hits:
        lines.append("　（**不属于**这三类：scope 不可解析／文本悬空／写事件重导——"
                     "按下面 check 原文里的维名对号入座）")
    lines.append("　check 原文：")
    lines.extend("　　" + ln for ln in err_lines)
    return "\n".join(lines)


def cmd_import(st: Store, a) -> int:
    raw = sys.stdin.read() if a.file == "-" else Path(a.file).read_text(encoding="utf-8")
    recs = []
    for i, line in enumerate(raw.splitlines(), 1):
        if line.strip():
            try:
                recs.append(json.loads(line))
            except json.JSONDecodeError as e:
                die(f"import: 第 {i} 行非法 JSON: {e}", key="非法 JSON")
    if not recs or recs[0].get("_format") != "handoff":
        die("import: 缺 meta 头（_format=handoff）", key="缺 meta 头")
    # **旧清单提示**（v5.64.0 · t000468）：schema 1 不带库级事实面 ⇒ 往返会丢
    # 「id 永不复用」⇒ **显式提示**（P3 不静默）；且目标库原有的已作废名单
    # **保留不动**（清掉却还原不了＝毁掉无法还原的东西）。
    _schema = recs[0].get("schema", 1)
    if not isinstance(_schema, int) or _schema < EXPORT_SCHEMA:
        print(f"handoff import: ⚠ 清单 schema={_schema}（旧形：不含已作废 id 名单／trash／冷档）"
              "⇒ 若源库有过作废 id，导入后 id 可能被复用；目标库原有的已作废名单**保留不动**"
              f"　修：重导一份 schema {EXPORT_SCHEMA} 的清单（`handoff export --out …`）")
    # 先校验（此时尚未改存储）——清单坏 → 原存储原样保留
    _prevalidate_import(recs, today())
    if store_has_entries(st):
        if not a.force:
            die(f"import: {st.d} 已有条目，拒绝（`--force` 会**先重置**再导入）")
        _reset_store(st)   # --force = 重置重建（非增量追加），避免与旧存储混

    # 建骨架（幂等；容忍 init 已建——消除「init→import 必失败」）
    st.d.mkdir(parents=True, exist_ok=True)
    for s in SINGLES:
        if not (st.d / s).is_file():
            (st.d / s).write_text(SCOPE_HEADER if s == "scope" else "", encoding="utf-8")
    for slot in ENTRY_SLOTS:
        (st.d / slot).mkdir(parents=True, exist_ok=True)
    st.decisions_dir().mkdir(parents=True, exist_ok=True)
    (st.d / "closed").mkdir(parents=True, exist_ok=True)
    if not st.unconf_file().is_file():
        st.unconf_file().write_text("", encoding="utf-8")
    if not (st.d / "next").is_file():
        st.set_next("")

    today_ = today()
    slot_type = {"actions": "t", "pitfalls": "p", "commands": "c", "unconfirmed": "u"}
    _imported: list[str] = []          # 写完回读用：本次导入分配/保留的 id（v5.1.6）
    _new_ids: list[str] = []           # v5.21.1：**本次新分配**的 id（清单里原本没有 id 的那些）
    # v5.68.0（t000475 · F-I1）：**本次还原进库的「已作废 id」也要记台账**——
    # 库级事实面（void／trash）还原回来的 id **同样是在册 id**（`_used_ids` 把回收站与
    # `void` 计入在册，这是 t000448 的既定口径）⇒ 台账只记条目面导入的 id ⇒ 这批 id
    # 「在册却无分配记录」⇒ 出处维判「来历不可追」⇒ **假红**（实测：目标库已有基线
    # 时，跨库 import 一律 rc=1；而目标库还没有基线时又恰好绿 ⇒ 同一份清单两种结论，
    # 差的只是台账里少一条记录）。
    _restored: list[str] = []           # 本次从 void／trash 段**还原**回库的 id
    for rec in recs[1:]:
        k = rec.get("_kind")
        slot = rec.get("_slot")
        if k == "entry":
            if slot not in ("actions", "pitfalls", "commands", "unconfirmed", "closed"):
                die(f"import: 不支持的 entry _slot={slot!r}（须 actions/pitfalls/commands/unconfirmed/closed）", key="不支持的")
            body = {kk: vv for kk, vv in rec.items() if kk in ALLOWED_KEYS}
            if slot in ENTRY_SLOTS:
                # v5.29.0 刀 3：**机器来源标记**——导入进来的是**存量**，不是本班新增的活。
                # 无条件盖写（清单里自己带的 `origin` 一律作废）⇒ 清单不能把它标成别的，
                # 也不能靠它躲开点名义务。判据读这个字段（见 fresh-queue 维）。
                body["origin"] = "import"
            # 缺日期 → 脚本补（迁移者可留空，不靠 LLM 编造）
            if slot == "closed" and not body.get("closed"):
                body["closed"] = today_   # 取不到 → 脚本盖迁移日（与 created 同规则）
            if not body.get("created"):
                body["created"] = body.get("closed") or today_
            # **创建时刻**（t000407）：清单里没带就盖导入时刻——「本班新增」判据要拿
            # 它与上一次班段写入时刻比（日粒度判不准）。带了就原样保留（导出再导入
            # 不改事实：原库登记于何时，那还是何时）。
            if not body.get("createdAt") and slot in ENTRY_SLOTS:
                body["createdAt"] = now_iso()
            # 缺 id → 脚本分配（closed 可给 `_type` 提示：值域＝`IMPORT_TYPE_FORM`）
            if not body.get("id"):
                if slot == "closed":
                    typ = rec.get("_type")
                    if typ not in ("t", "p", "d", "c", "q"):
                        die(f"import: closed 记录缺 id，且未给有效 `_type`（{IMPORT_TYPE_FORM}）——"
                            "补上 `id` 与 `_type` 再导：`handoff import <file>`")
                    body["id"] = st.allocate(typ)
                else:
                    body["id"] = st.allocate(slot_type[slot])
                    _new_ids.append(body["id"])
            if slot in ENTRY_SLOTS:
                part = rec.get("_purpose") if slot == "commands" else rec.get("_domain", "_global")
                _pkey = "purpose" if slot == "commands" else "domain"
                append_jsonl(st.d / slot
                             / f"{guard_partition('import', _pkey, part)}.jsonl", body)
                _imported.append(body["id"])
            elif slot == "unconfirmed":
                append_jsonl(st.unconf_file(), body)
                _imported.append(body["id"])
            elif slot == "closed":
                m = ID_RE.match(body.get("id", ""))
                typ = m.group(1) if m else "x"
                append_jsonl(st.d / "closed" / f"{typ}.jsonl", body)
                _imported.append(body["id"])
        elif k == "doc":
            if slot == "decisions":
                if "_id" not in rec:
                    die("import: doc decisions 缺 _id", key="缺 _id")
                (st.decisions_dir() / f"{rec['_id']}.md").write_text(rec.get("content", ""), encoding="utf-8")
                # **裁定件的 id 也要记进写事件的分配记录**（v5.53.0 · t000448）：
                # 裁定件同样是「在册 id」⇒ 出处维要判它的来历 ⇒ 导入时分配的 id
                # 不记 ⇒ 合法导入会被判「凭空出现」（假红）。
                # （**载体**本身：v5.57.0 · t000461 起，d 型已进 `_write_targets()`
                #  ⇒ 裁定件载体也进台账 `files` ⇒ 手改其正文会被写事件哈希对账抓住。
                #  此前 d 型不在受管面 ⇒ 导入来的裁定件**不受**对账 ⇒ 那处老洞已闭合。）
                _imported.append(str(rec["_id"]))
            elif slot in SINGLES:
                _txt = rec.get("content", "")
                if slot == "exit":
                    # v5.29.0：旧库残留的队列区可能随内容进来 ⇒ 一并剥掉（区不再落盘）。
                    _txt = _strip_queue(_txt)
                    if _new_ids:
                        # v5.29.0 刀 3：**有界聚合**取代逐条点名。
                        # v5.21.1 那条逐条行是 **O(导入量) 的机器内容塞进人写的散文层** ⇒
                        # 库一大就撞 8192 字节闸（实测：导入 700 条 ⇒ 点名行 8538 字节 ⇒
                        # 此后 `append exit` 被拒 ⇒ 存储进退两难），而且它是机器写的散文 ⇒
                        # 导入条目一旦销账，fresh-stale 会误报「没带关闭标记」（人改不动那行）。
                        # ⇒ 现在：导入的条目带机器来源标记 `origin=import`（**不算「本班新增」**
                        #   ⇒ 逐条点名的义务根本不存在），散文里只留一行有界聚合——真话：
                        #   逐条见 `handoff view`，它列全部 live 条目。
                        _txt = (_txt.rstrip() + "\n\n## 迁入带入的未销账条目（id 由脚本分配）\n\n"
                                "- 迁入的存量未销账条目（**不是本班新增**）；逐条见 `handoff view`\n")
                # v5.30.0 刀 C：经唯一漏斗写 ⇒ **import 不再能写出超上限热层**
                # （旧形：直写文件绕过字节闸 ⇒ 实测落盘 exit 16220 字节而 check 仍绿）。
                # 超限的清单在**写入前**就被 `_prevalidate_import` 拒掉（不留半写存储）。
                _write_slot(st, slot, _txt, "import", snapshot=False, index=False)
            else:
                die(f"import: 不支持的 doc _slot={slot!r}", key="不支持的")
        elif k == "ref" and slot == "next":
            st.set_next(rec.get("ref", ""))
        elif k == "void":                 # v5.64.0（t000468）：还原已作废 id 名单
            _vf = _void_file(st)
            _vf.parent.mkdir(parents=True, exist_ok=True)
            _vf.write_text("\n".join(rec.get("ids") or []) + ("\n" if rec.get("ids") else ""),
                           encoding="utf-8")
        elif k == "trash":                # v5.64.0：还原「已移走的那一份」
            _td = st.d / "trash"
            _td.mkdir(parents=True, exist_ok=True)
            for _old in list(_td.iterdir()):
                if _old.is_file():
                    _old.unlink()
            for it in rec.get("items") or []:
                (_td / str(it["_name"])).write_text(str(it.get("content", "")), encoding="utf-8")
                # v5.68.0：还原回来的那一份里的 id **也要认账**（同 F-I1 的口径）
                for _r in _safe_jsonl_text(str(it.get("content", ""))):
                    if _r.get("id"):
                        _restored.append(str(_r["id"]))
        elif k == "archive":              # v5.64.0：还原冷档（历史班段）
            _ad = st.d / "archive"
            _ad.mkdir(parents=True, exist_ok=True)
            for _old in list(_ad.glob("*.jsonl")):
                _old.unlink()
            for it in rec.get("items") or []:
                (_ad / f"{it['_slot']}.jsonl").write_text(str(it.get("lines", "")), encoding="utf-8")
        else:
            die(f"import: 不支持的记录 _kind={k!r} _slot={slot!r}（不静默丢弃）", key="不支持的")
    # v5.68.0（t000475 · F-I1）：台账认账**两类** id——条目面导入的（`_imported`）
    # ＋ 库级事实面（void／trash）**还原**回来的（`_restored`）⇒ 后者不再「在册却
    # 无分配记录」⇒ 出处维不再对一次合法往返判「来历不可追」（假红）。
    st.write_index(ids=sorted(set(_imported) | set(_restored)))
    # v5.69.0（t000475·③）：check 的输出**收进来**再报错——旧形把 check 的红项留在 stdout、
    # 报错里只有一句「请检查」⇒ 三类原因（scope 不可解析／文本悬空／写事件重导）混成一句。
    import io as _io, contextlib as _ctx
    _buf = _io.StringIO()
    with _ctx.redirect_stdout(_buf), _ctx.redirect_stderr(_buf):
        rc = cmd_check(st)
    if rc != 0:
        die(import_check_failure_message(_buf.getvalue()), key="导入后 check 未过")
    # 写完回读（v5.1.6）：`cmd_check` 只判**跨条目**的一致性，抓不到「某行压根没写进去」
    # ——落点若被黑洞吞了，分配号仍会推进，判据看不出少了谁。逐 id 点名才是自证。
    _miss = _rb_missing(st, _imported)
    if _miss:
        die(f"import: {len(_miss)}/{len(_imported)} 条导入后回读查不到 ⇒ 写入丢失（落点被黑洞吞了？）"
            f"：{_miss[:8]}{'…' if len(_miss) > 8 else ''}　**先查落点分区文件再重导**", key="回读查不到")
    print("handoff import: ok")
    return 0


# ---------------- scope（源登记表）----------------
def _void_file(st: Store) -> Path:
    return st.d / "void"


def _void_ids(st: Store) -> list[str]:
    p = _void_file(st)
    if not p.is_file():
        return []
    return [l.strip() for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


def _voided_ids(st: Store) -> set[str]:
    """作废 id ＝ `void` ∪ `trash/`（**单源**，check 与 view 共用）。

    `rm` 的正常路径同时做「移入 trash/」＋「记 void」，故两者天然同步（本仓实测
    6/6 一致）；但把口径写成两处各算一遍，只差一步就会分叉成「check 说已作废、
    view 说查不到」。判据间的口径必须同源，否则同一个事实两处结论相反。
    """
    out = set(_void_ids(st))
    trash = st.d / "trash"
    if trash.is_dir():
        for f in sorted(trash.glob("*.jsonl")):
            for r in read_jsonl(f):
                if r.get("id"):
                    out.add(r["id"])
        out |= {f.stem for f in trash.glob("*.md")}
    return out


def _add_void(st: Store, i: str):
    st.d.mkdir(parents=True, exist_ok=True)
    with open(_void_file(st), "a", encoding="utf-8") as f:
        f.write(i + "\n")


def _del_void(st: Store, i: str) -> None:
    """从 `void` 摘掉一个 id（v5.1，`unvoid` 的落盘面）。原文件整表重写、只去这一项。"""
    p = _void_file(st)
    if not p.is_file():
        return
    keep = [x for x in _void_ids(st) if x != i]
    tmp = p.parent / (p.name + ".tmp")
    tmp.write_text("".join(x + "\n" for x in keep), encoding="utf-8")
    os.replace(tmp, p)


def _read_rows(p: Path) -> list[dict]:
    if not p.is_file():
        return []
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


def _write_rows(p: Path, rows: list[dict]):
    fd, tmp = tempfile.mkstemp(dir=str(p.parent))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(ordered(r), ensure_ascii=False) + "\n")
    os.replace(tmp, p)


def _row_index(rows: list[dict], i: str) -> int:
    """文件里**那一条**（首个命中）的下标；没有 ⇒ −1。

    **唯一源**（v5.58.0 · t000463）：写路按**行**定位时都用它——`_find_entry`／`_find_live`
    给的就是**首个命中**那条（它按 `load_live()` 的顺序扫：槽序 → 文件名序 → 行序），
    ⇒ 在**同一个文件**里，首个命中就是**文件里第一个同 id 的行**。

    **为什么不能按 id 整表过滤**：同一文件里可能落着**两条同 id**（存量形态）⇒ 按 id 过滤
    等于把「同 id 的所有行」当成「那一条」⇒ `rm` 多删、`close` 静默丢数据、`edit` 静默改两条。
    """
    return next((k for k, r in enumerate(rows) if r.get("id") == i), -1)


def _id_holders(st: Store, i: str) -> dict[str, list[str]]:
    """**「谁持有这个 id」的唯一源**（v5.50.0 · t000444）。

    返回 {载体类别: [具体位置…]}，键的闭集：
      `live`（各数据槽的分区文件，含 `unconfirmed`）｜`closed`｜`decisions`｜`trash`｜`void`
    ⇒ 同一个 id 在**多个载体**上同时在册（本仓实测：同 id 落在两个数据槽）时，
    **一处也不漏**——旧形 `_find_entry` 只返回**首个 live 命中**，于是「谁还在册」这件事
    在不同调用点各答一遍，答案还互相矛盾 ⇒ `rm` 按「closed 里没有同 id」判定「记 void」，
    而另一槽那条**仍在 live** ⇒ 同一 id **既在册又已作废** ⇒ check 恒红、rm/edit 出不了。

    **为什么必须是唯一源**：判定口径分两处各算一遍，只差一步就会分叉成
    「rm 说已移走、check 说还在册」——同一个事实两处结论相反，比没判更坏。
    """
    out: dict[str, list[str]] = {}
    for r in st.load_live():
        if r.get("id") == i:
            out.setdefault("live", []).append(str(r.get("_file", "")))
    for r in st.load_closed():
        if r.get("id") == i:
            out.setdefault("closed", []).append(str(r.get("_file", "")))
    dec = st.decisions_dir() / f"{i}.md"
    if dec.is_file():
        out.setdefault("decisions", []).append(f"decisions/{i}.md")
    trash = st.d / "trash"
    if trash.is_dir():
        for f in sorted(trash.glob(f"{i}.*")):
            out.setdefault("trash", []).append(f"trash/{f.name}")
    if i in _void_ids(st):
        out.setdefault("void", []).append("void")
    return out


def _find_entry(st: Store, i: str):
    """返回 (row, file, slot)；未找到 → (None, None, None)。

    ⚠ **只答「首个命中」**：它**不能**用来判断「这个 id 还有谁持有」——那是
    `_id_holders` 的职责（v5.50.0 · t000444）。首个命中在「同 id 落两槽」时只覆盖一槽，
    拿它当「还有谁持有」⇒ 会把「另一槽还在册」判成「不在册」⇒ 记了 void ⇒ 死角。
    """
    for r in st.load_live():
        if r.get("id") == i:
            return r, r["_file"], r["_slot"]
    for r in st.load_closed():
        if r.get("id") == i:
            return r, r["_file"], "closed"
    return None, None, None


def cmd_rm(st: Store, a) -> int:
    """受控删除：移入 `.handoff/trash/` ＋ 记 `void`（防 id 复用）＋ 引用守卫。

    `void` 只在 id **真的不再被任何东西持有**时才记（v5.1）：live 与 closed 同 id 时
    本命令移走的是 live 副本，closed 那份仍在册 ⇒ 记作废就是自相矛盾，会锁死 check。

    **v5.50.0（t000444）三处治本**：
    ① **先判后动**：动手前用 `_id_holders`（唯一源）算出「移走这一条之后该 id 是否
       还被别处持有」⇒ 据此决定记不记 void。旧形只查 `closed`，**漏掉「另一数据槽里
       同 id 那条仍在 live」**（本仓实测：同 id 落 actions 与 pitfalls 两槽）⇒ 记了 void
       ⇒ 同一 id 既在册又已作废 ⇒ check 恒红、`rm`/`edit` 都被 `void` 守卫挡住 ⇒ 死角。
    ② **写后失败明说已写入**：回读不过时按**实测**报出已落盘的内容（trash/void/index
       写了什么、源行还在哪），不说「可能已无处可寻」——那是**未实测的猜测**。
    ③ **归因实测**：文案按实测分支给（谁还在册／源行还在哪），不再一律说「源文件没被抹掉？」。
    """
    st.note_pre_tamper()          # 写前旁证快照（本次写自己的 mtime 变化不算外部改动）
    i = a.id
    if i in _void_ids(st):
        die(f"rm: {i} 已作废", key="已作废")
    row, f, slot = _find_entry(st, i)
    dec = st.decisions_dir() / f"{i}.md"
    if row is None and not dec.is_file():
        die(f"rm: 未找到 {i}", key="未找到")
    if st.next_id() == i:
        die(f"rm: {i} 是 next（先 `handoff next --clear`）")
    for r in st.load_live() + st.load_closed():
        if r.get("id") != i and r.get("blockedBy") == i:
            die(f"rm: {i} 被 {r['id']} 的 blockedBy 引用", key="blockedBy 引用")
    if dec.is_file():
        for d in sorted(st.decisions_dir().glob("*.md")):
            if d.stem == i:
                continue
            if _fm_fields(d.read_text(encoding="utf-8")).get("supersedes") == i:
                die(f"rm: {i} 被决策 {d.stem} supersedes 引用", key="supersedes 引用")
    # ── ① 先判后动：移走这一条之后，该 id 还被谁持有？（唯一源，不看「首个命中」）──
    holders_before = _id_holders(st, i)
    # 本命令只移走**一条**（live 首个命中 / decisions 那份）⇒ 剩下的持有者＝移走后仍在册的。
    # ⚠ 排除要**按行**逐个排，不能按类别整体排：`live` 类别里可能同时有**两条**同 id
    #   （同 id 落两槽）⇒ 只排掉「本命令要移走的那条」，**另一条要留下**。
    # ⚠ v5.56.0（t000457）：同 id 还可能落在**同一个文件**里 ⇒ 排除只能排**一条**；
    #   排掉整个文件＝把仍在册的那条也当成「已移走」⇒ 白记一次 void。
    _moved_live = row is not None and slot != "closed"
    _moved_place = str(row.get("_file", "")) if _moved_live else ""
    # 先把源文件的行读出来（纯读，不写）：「同 id 落同一文件」的判定要用它。
    # 旧形到写的时候才读 ⇒ 那时才发现「不止一条」已经晚了（t000457）。
    _rows = _read_rows(row.get("_file")) if (row is not None and not dec.is_file()) else []
    still_held: list[str] = []
    for _kind, _places in holders_before.items():
        if _kind in ("trash", "void"):
            continue                       # trash 是**备份**、void 是标记 ⇒ 不算「还在册」
        _rest = list(_places)
        if _kind == "live" and _moved_place and _moved_place in _rest:
            _rest.remove(_moved_place)    # 只排掉**本命令移走的那一条**
        if _rest:
            still_held.append(f"{_kind}：{', '.join(_rest)}")
    tdir = st.d / "trash"
    tdir.mkdir(parents=True, exist_ok=True)
    _left_same = 0            # 源文件里「移走那一条」之后应剩几条同 id（v5.56.0 · t000457）
    if dec.is_file():
        os.replace(str(dec), str(tdir / f"{i}.md"))
    else:
        rows = _rows
        # ── v5.56.0（t000457）：按**行**定位——只摘**首个命中**那一条 ──
        # 病：同一文件里可能落着**两条同 id** ⇒ 旧形按 id 整表过滤 ⇒ 备份写了两条、
        #   源文件里那条也一起没了 ⇒ 用户没让删的那条被静默移走；事后
        #   `unvoid --restore` 又把两条一起搬回来 ⇒ 重复状态原样复活。
        # ⇒ 现在按**位置**摘（`_find_entry` 给的就是首个命中那条）⇒ 另一条留在原处。
        #   写序不变：**先追加 trash、再覆写源文件**（追加若静默丢失、源文件已被抹掉
        #   ⇒ 条目净消失 ⇒ 回读拦得住，见 `_rb_after_rm`）。
        _pick = _row_index(rows, i)
        if _pick < 0:
            die(f"rm: {i} 在 {f.name} 里读不到那一行（落盘与在册面不一致——多半刚被并发改动）"
                f"⇒ 拒绝盲改；重试一次，仍读不到 ⇒ `handoff view --id {i}` 查它在不在",
                key="未找到")
        _left_same = sum(1 for r in rows if r.get("id") == i) - 1
        with open(tdir / f"{i}.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps(ordered(rows[_pick]), ensure_ascii=False) + "\n")
        _write_rows(f, [r for k, r in enumerate(rows) if k != _pick])
        # 备份行里**没有**分区键（分区只存在于文件名——见 v5.1.3 的同一个双轨根因），
        # 故来源分区必须单独记下来，否则 `unvoid --restore` 只能把条目扔进 `_global`
        # （实测：带 `domain=back` 的条目被恢复到 `_global.jsonl`）。sidecar 与 trash
        # 同寿命，`unvoid --restore` 成功后才删。
        if slot in ENTRY_SLOTS:
            (tdir / f"{i}.src").write_text(f.name, encoding="utf-8")
    # `void` 的语义＝「这个 id 不再被任何东西持有，永不复用」。rm 从前**总是**顺手记
    # void，于是在「live 与 closed 同 id」的修复现场造出死角：移走 live 副本后该 id
    # 仍在 closed 合法在册，却也被标成已作废 ⇒ check 恒红、而 rm/edit/rebase 都出不了
    # （cloud-services 实测卡死）。根治＝按事实分流：还有人在册就不记作废。
    # v5.50.0：分流依据换成**唯一源**（`_id_holders`），旧形只查 closed ⇒ 漏「另一数据槽
    # 里同 id 那条仍在 live」⇒ 照样记了 void ⇒ 死角照旧。
    if still_held:
        expect_void = False
        print(f"handoff rm: {i} 的 live 副本 → .handoff/trash/；"
              f"{'；'.join(still_held)} 仍持有该 id ⇒ **不记 void**（记了＝同一 id 既在册又已作废）")
    else:
        expect_void = True
        _add_void(st, i)
        print(f"handoff rm: {i} → .handoff/trash/（作废，id 不复用）")
    st.write_index()
    # 写完回读（方向与其它写命令相反，见 `_rb_after_rm` 的 docstring）
    # `moved_place`＝**本命令移走的那一条**原在哪个文件（库内相对路径）⇒ 回读按它判，
    # 而不是按「这个 id 还在不在 live」判（同 id 落两槽时另一条本就该在 live）。
    _mp = ""
    if _moved_live and row is not None:
        try:
            _mp = str(Path(str(row.get("_file", ""))).resolve().relative_to(st.d.resolve()))
        except (ValueError, OSError):
            _mp = ""
    _bad = _rb_after_rm(st, i, expect_void, _mp, _left_same)
    if _bad:
        # ── ② 写后失败：**明说已写入**（实测事实），不说「可能已无处可寻」──
        _wrote = []
        if (st.d / "trash" / f"{i}.jsonl").is_file():
            _wrote.append(f"trash/{i}.jsonl（备份已写）")
        if (st.d / "trash" / f"{i}.md").is_file():
            _wrote.append(f"trash/{i}.md（决策件已移走）")
        if i in _void_ids(st):
            _wrote.append("void（已记作废）")
        _left = [f"{k}：{', '.join(v)}" for k, v in _id_holders(st, i).items() if k != "trash"]
        _state = ("；".join(_wrote) + "　**已落盘**" if _wrote else "无落盘")
        _lefts = ("；".join(_left) if _left else "（该 id 已不在册）")
        # ── ③ 归因实测：按实测说「谁还在册／哪一行还在」──
        die(f"rm: {i} 删除后回读不通过 ⇒ " + "；".join(_bad)
            + f"　**已落盘**：{_state}｜**仍在册**：{_lefts}"
            + "　**修**：先看上面的实测位置（该 id 还在哪一册），再决定是补删那一册还是"
              f"`handoff unvoid {i}` 解作废标记；条目本体在 trash/ 里可 `handoff unvoid --restore` 捞回",
            key="回读不通过")
    return 0


def cmd_unvoid(st: Store, a) -> int:
    """`void` 的出口：摘掉「作废不复用」标记；`--restore` 另把 `trash/` 里的条目搬回原槽。

    为什么必须有（v5.1，cloud-services 实测）：v5.0 的 `void` **只进不出**，而 `rm` 既是
    移除条目的唯一入口、又顺手记 void ⇒ 「live 与 closed 同 id」的修复现场会把存储锁死：
    `rm` 的开头守卫拒再碰该 id、`edit` 改不动名单、`rebase` 只重建写事件、`import --force`
    是全量重置——SKILL 承诺的「修法只经 CLI」在这条路上成了假陈述。根治在 `cmd_rm`
    （按事实决定记不记，见那里），本命令补的是**已经造成的死角与任何误记的出口**。

    **v5.56.0（t000457）：`--restore` 的前提改成「trash/ 里有那一份」**——不再要求该 id
    已作废。因为 `rm` 移走**一条**后，若同 id 仍被别处持有 ⇒ 按事实**不记 void**
    ⇒ 而「解作废」这条路是给**作废标记**用的 ⇒ 对「没作废的 id」天然不通
    ⇒ 移走的那条就捞不回来 ⇒ 「修法只经 CLI」的承诺破在那儿。
    ⇒ 现在：`--restore` 只搬 trash 那份（搬回**一条**，与 `rm` 移走**一条**对称）；
    该 id 若本来就作废 ⇒ 连作废标记一起解。
    """
    st.note_pre_tamper()
    i = a.id
    ids = _void_ids(st)
    tm, tj = st.d / "trash" / f"{i}.md", st.d / "trash" / f"{i}.jsonl"
    _trashable = tm.is_file() or tj.is_file()
    # 「解作废后这个 id 还有谁持有」＝**同一唯一源**（v5.50.0 · t000444）
    _hold = {k: v for k, v in _id_holders(st, i).items() if k not in ("void", "trash")}
    # ⚠ v5.56.0（t000457）：`--restore` 的前提改成「**trash/ 里有那一份**」，不再要求
    #   该 id 已作废。为什么：rm 移走**一条**后，若同 id 仍被别处持有 ⇒ 按事实**不记 void**
    #   ⇒ 而「解作废」是给**作废标记**用的 ⇒ 那条路对「没作废的 id」天然不通
    #   ⇒ 移走的那条就捞不回来（「修法只经 CLI」的承诺破在那儿）。
    if i not in ids and not (a.restore and _trashable):
        die(f"unvoid: {i} 不在 void（现有 {len(ids)} 项：{', '.join(ids) or '空'}）"
            + ("　trash/ 里也没有它 ⇒ 无从恢复（--restore 搬的就是 trash 那份）" if a.restore else ""),
            key="不在 void")
    if i in ids:
        _del_void(st, i)
    if not a.restore:
        st.write_index(op="unvoid")
        if i in _void_ids(st):
            die(f"unvoid: {i} 解除作废标记后回读仍在 void 里 ⇒ void 文件写入丢失"
                f"（该 id 仍被禁用；条目本身在 trash/ 未动）", key="仍在 void 里")
        # 「解作废后这个 id 还有谁持有」＝**同一唯一源**（v5.50.0 · t000444）：
        # 解作废＝「这个 id 可以被复用了」⇒ 若它**仍被别处持有**，解作废后 id 会被
        # allocate 重新发出去 ⇒ 同一 id 两份在册 ⇒ 必须先说清「谁还持有」，不能默默解。
        if _hold:
            print(f"handoff unvoid: {i} 解除作废标记（条目本身不动——要把 trash/ 那份搬回原槽加 --restore）"
                  f"　⚠ **该 id 仍被持有**：{'；'.join(f'{k}：{', '.join(v)}' for k, v in _hold.items())}"
                  f" ⇒ 复用前先处理那些持有者")
        else:
            print(f"handoff unvoid: {i} 解除作废标记（条目本身不动——要把 trash/ 那份搬回原槽加 --restore）")
        return 0
    if tm.is_file():
        os.replace(str(tm), str(st.decisions_dir() / tm.name))
        back = f"decisions/{tm.name}"
    elif tj.is_file():
        rows = _read_rows(tj)
        if not rows:
            die(f"unvoid --restore: trash/{i}.jsonl 是空的，没有可恢复的行")
        dst = []
        for r in rows:
            # 落点由**行本身**决定，不由 id 前缀决定：同是 `t` 型，live 那份归
            # `actions/<域>.jsonl`、带 `closed` 的那份归 `closed/t.jsonl`（apply_close 的命名）。
            if r.get("closed"):
                p = st.d / "closed" / f"{i[0]}.jsonl"
            else:
                slot = TYPE2SLOT.get(i[0])
                if slot == UNCONF_SLOT:
                    p = st.unconf_file()          # 单文件槽，无分区名可言
                elif slot in ENTRY_SLOTS:
                    part_key = ENTRY_SLOTS[slot]["part"]
                    # 分区键只存在于文件名（备份行里没有它，见 `cmd_rm` 的 sidecar 说明），
                    # 所以**来源优先取 rm 时记下的 sidecar**；没有 sidecar 的旧备份件才
                    # 回退到行上的字段——那一路等于 `_global`，须如实告诉使用者。
                    _side = st.d / "trash" / f"{i}.src"
                    _part = _side.read_text(encoding="utf-8").strip() if _side.is_file() else ""
                    if _part.endswith(".jsonl"):
                        _part = _part[: -len(".jsonl")]
                    elif not _part:
                        _part = r.get(part_key) or "_global"
                    p = st.d / slot / (guard_partition("unvoid --restore", part_key, _part) + ".jsonl")
                else:
                    die(f"unvoid --restore: {i} 型 {i[0]!r} 没有 live 落点"
                        f"（可恢复：{RESTORABLE_FORM}；决策件走 trash/{i}.md）")
            append_jsonl(p, r)
            dst.append(p)
        # 回读**先于**删 trash 源文件：写序是「追加到落点 → unlink trash 那份」，追加若
        # 静默丢失而源文件已被删 ⇒ 净消失。先验落点、通过了再删，是这条写序唯一能自证
        # 的时机（`v5.1.6`）。
        _miss = _rb_missing(st, [i])
        if _miss:
            _landed = "、".join(sorted({q.name for q in dst})) or "落点"
            die(f"unvoid --restore: {i} 写进 {_landed} 后回读查不到 ⇒ "
                f"追加丢失（落点被黑洞吞了？）且 trash/{i}.jsonl **尚未删除**，条目仍可捞回", key="回读查不到")
        tj.unlink()
        _side = st.d / "trash" / f"{i}.src"
        if _side.is_file():
            _side.unlink()
        back = "、".join(sorted({q.name for q in dst}))
    else:
        die(f"unvoid --restore: trash/ 里没有 {i}，条目无从恢复——只要解除作废标记就别加 --restore")
    st.write_index(op="unvoid")
    _tag = "解除作废 ＋ " if i in ids else "（该 id 未作废·仍被别处持有 ⇒ 只搬回 trash 那份）"
    print(f"handoff unvoid: {i} {_tag}条目搬回 {back}")
    if any(r.get("id") == i for r in st.load_closed()) and \
       any(r.get("id") == i for r in st.load_live()):
        print(f"  ⚠ {i} 现在 live 与 closed **各有一份** ⇒ check 会报 id 重复。"
              f"要留 closed 那份：`handoff rm {i}`（v5.1 起这种情形只移 live 副本、不记 void）",
              file=sys.stderr)
    return 0


def cmd_edit(st: Store, a) -> int:
    """受控修正安全字段（id / created / closed 不可改）；改 domain/purpose → 迁移分区。

    可改面按**条目所属槽**当场核（`editable_fields`，与 add 同一声明源）：型不符的键**硬报错**，
    不再像旧版那样落进 `ALLOWED_KEYS` 过滤器里静默丢弃（`edit <action> --purpose` 曾无声消失）。
    `edit` 无法按型分 flag 面——型由 id 前缀推出、不在命令行上，故这里用运行时守卫补同一缺口。
    """
    row, f, slot = _find_entry(st, a.id)
    if row is None:
        # 两种「没有这一行」要分开说（v5.39.0／H3）：裁定件**在**库里，只是 `edit` 不改它 ⇒
        # 泛化键「未找到」会把出路指到「找相近的／新开一条」＝指错路。
        if (st.decisions_dir() / f"{a.id}.md").is_file():
            die(f"edit: {a.id} 是裁定件（decisions/），edit 不改裁定", key="不改裁定")
        die(f"edit: 未找到条目 {a.id}", key="未找到")
    upd = {k: getattr(a, k) for k in EDIT_KEYS if getattr(a, k, None) is not None}
    ff_keys: set = set()
    ff = getattr(a, "from_file", None)
    if ff:
        allowed = editable_fields(slot)
        got = load_from_file(f"edit {slot}", ff, allowed)
        # 同一字段既给 flag 又给文件 → 报错，不静默取一个（静默丢弃是本 CLI 的老病）
        dup = sorted(set(upd) & set(got))
        if dup:
            die(f"edit {a.id}: 字段 {dup} 同时出现在命令行与 --from-file；只留一处")
        upd.update(got)
        ff_keys = set(got)
    if not upd:
        die(f"edit: 未给任何可改字段（{'/'.join('--' + k for k in EDIT_KEYS)}）", key="未给任何可改字段")
    for k in sorted(upd):
        require_text("edit", f"--{k}", upd[k],          # 空串＝清空字段（p000048：643→0）
                     from_shell=k not in ff_keys)       # --from-file 来的值不经 shell，不查危险字符
        guard_len("edit", f"--{k}", upd[k], EDIT_CAPS.get(k, 10 ** 9))
        if k == "summary":
            guard_single_line("edit", upd[k])
    if slot == "actions":
        # 同一道校验两条写路都得过——只在 add 拦等于留个「用 edit 照样写前缀」的后门。
        guard_tier_prefix("edit", upd.get("summary"))
        if upd.get("prio") is not None:
            upd["prio"] = _norm_prio(upd["prio"], "edit")
    allowed = editable_fields(slot)
    if bad := set(upd) - allowed:
        die(f"edit: {slot} 条目不接受 {sorted(bad)}（该型可改＝{sorted(allowed)}）", key="条目不接受")
    if "status" in upd:                                 # t000138：closed 只能走 close 流程
        kind = SLOT2KIND.get(slot)
        if kind:
            guard_status(kind, upd["status"])
        if "blockedBy" in upd:
            guard_blocked_by(st, "edit", upd["blockedBy"])
    if "waitingFor" in upd:                             # v5.18.0（G′）值域同 add
        guard_waiting_for(upd["waitingFor"])
    pkey = ENTRY_SLOTS[slot]["part"] if slot in ENTRY_SLOTS else None
    self_move = False
    if pkey in upd:                                     # domain/purpose → 换分区文件
        newpart = guard_partition(f"edit {slot}", pkey, upd.pop(pkey))
        tgt = st.d / slot / f"{newpart}.jsonl"
        if f.resolve() == tgt.resolve():
            # **自迁移**（p000135）：源分区 == 目标分区。原先这里先 append 到目标、再把
            # 同一个文件整表覆写或删掉 ⇒ 刚追加的条目被自己抹掉（静默丢数据，且该 id 不记
            # void ⇒ 下次 add 发出同一个号，首份内容永久不可寻回）。跨分区不受影响。
            # 迁移在这种情况下本就是空操作 ⇒ 走非迁移路径就地更新；只给 --domain 时无字段
            # 可改 ⇒ 硬报错（静默无操作是本 CLI 明令规避的老病）。
            self_move = True
            if not upd:
                die(f"edit {a.id}: 已在 '{newpart}' 分区，--{pkey} 同值无操作可做"
                    f"（要改内容用 --{'/--'.join(sorted(set(editable_fields(slot)) - {pkey}))}；"
                    f"要搬分区换一个不同的 --{pkey}）", key="同值无操作")
            rows = _read_rows(f)
            _pick = _row_index(rows, a.id)
            if _pick < 0:
                die(f"edit {a.id}: 未在 {f.name} 找到条目（异常）")
            # ── v5.58.0（t000463）：只改**那一条**（同 id 的另一条原样）──
            for k, v in upd.items():
                if k in ALLOWED_KEYS:
                    rows[_pick][k] = v
            _write_rows(f, rows)
        else:
            rows = _read_rows(f)
            _pick = _row_index(rows, a.id)
            if _pick < 0:
                die(f"edit {a.id}: 未在 {f.name} 找到条目（异常）")
            # ── v5.58.0（t000463）：只搬**那一条**（同 id 的另一条留在原处）──
            for k, v in upd.items():
                if k in ALLOWED_KEYS:
                    rows[_pick][k] = v
            append_jsonl(st.d / slot / f"{newpart}.jsonl", rows[_pick])
            rest = [r for k, r in enumerate(rows) if k != _pick]
            if rest:
                _write_rows(f, rest)
            else:
                # 旧分区被搬空 ⇒ **删掉空文件**。原实现留着它：Linux 上无害（glob 扫得到、
                # 计数 0），但它仍是一个**占着名字的分区文件**——而分区名就是索引维度。与另一
                # 个仅大小写不同的分区并存时，Windows/NTFS 上两者会合并，index 计数与现实脱节。
                # 本条是 4.7.5 新增「大小写折叠重名」判据**暴露出来的既有残留**。
                f.unlink(missing_ok=True)
    else:
        rows = _read_rows(f)
        _pick = _row_index(rows, a.id)
        if _pick < 0:
            die(f"edit {a.id}: 未在 {f.name} 找到条目（异常）")
        # ── v5.58.0（t000463）：只改**那一条**（同 id 的另一条原样）──
        for k, v in upd.items():
            if k in ALLOWED_KEYS:
                rows[_pick][k] = v
        _write_rows(f, rows)
    st.write_index()
    print(f"handoff edit: {a.id}（改 {', '.join(sorted(upd)) or pkey}）")
    if self_move:
        print(f"  ↳ 已在 '{newpart}' 分区：--{pkey} 无搬移效果，就地更新未移动文件"
              f"（分区键只存在文件名里，迁移路径从不把它写进行）")
    echo_back(st, a.id, strict=True)
    return 0


# ---------------- v5.0：热/冷分层（t000196②）----------------
# 接手时要全量读的是热层（exit/summary/status 槽文件）；历史班段是冷数据，搬到
# `archive/<slot>.jsonl`（每行 {"archived": 日期, "text": 原文}，追加式、按时间升序）。
# 读取面按需取：`read` 子命令合并热＋冷；`view` 不变（只读槽文件＝只渲热层）。
# 冷档条目永不重写、永不删除（P1 细化：热/冷**搬家**不丢）。

_ARCHIVE_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _split_exit_sections(text: str) -> list[str]:
    """按顶层 `## ` 切班段（保序；节前的前言并进第一节）。"""
    secs: list[str] = []
    for ln in text.splitlines():
        if ln.startswith("## ") or not secs:
            secs.append([])
        secs[-1].append(ln)
    out = ["\n".join(seg).strip("\n") for seg in secs]
    return [s for s in out if s.strip()]


def _archive_rows(st: Store, slot: str) -> list[dict]:
    f = st.d / ARCHIVE_DIR / f"{slot}.jsonl"
    if not f.is_file():
        return []
    return [r for r in read_jsonl(f) if isinstance(r, dict)]


def _archive_append(st: Store, slot: str, rows: list[str]) -> None:
    if not rows:
        return
    ad = st.d / ARCHIVE_DIR
    ad.mkdir(exist_ok=True)
    f = ad / f"{slot}.jsonl"
    with open(f, "a", encoding="utf-8") as fh:
        for txt in rows:
            fh.write(json.dumps({"archived": today(), "text": txt}, ensure_ascii=False) + "\n")


def _hot_cap_limit(slot: str) -> int | None:
    """热层槽的字节上限——`HOT_CAPS` 的**唯一**读取点（v5.30.0 刀 C）。

    为什么要收敛到一处：旧形这条约束散在**三处调用点**（`cmd_append`／`cmd_set`／
    `sync_counts`），而 `cmd_import` 直写文件绕过全部 ⇒ 能造出超上限的非法库而无人知。
    ⇒ 现在上限值只此一份、施加点只此一处（`_hot_cap_check`）⇒ 加新槽位只需改这一处。
    """
    return HOT_CAPS.get(slot)


def _hot_cap_exceeded(slot: str, content: str, force: bool = False) -> bool:
    """这个槽的内容是否超上限（**不**写盘、只判）。import 的写前校验用它。"""
    cap = _hot_cap_limit(slot)
    return bool(cap) and len(content) > cap and not force


def _hot_cap_check(slot: str, content: str, op: str, force: bool = False,
                   hint: str = "") -> None:
    """热层**字节闸**——`HOT_CAPS` 的**唯一**施加点（v5.30.0 刀 C）。

    为什么必须唯一（**根因：约束挂在调用点**）：旧形这条约束有**三处调用点实现**
    （`cmd_append`／`cmd_set`／`sync_counts`），而 `cmd_import` **直写文件、绕过全部**
    ⇒ 实测：导入可写出 exit **16220** 字节（上限 8192）而 `check` 仍绿（判据面没有这一维）
    ⇒ 违规库被**合法写者**造出来、且无人知；随后 `set exit` 一直被拒、整槽覆写这条路死掉。
    ⇒ 现在：所有热层槽的落盘都经 `_write_slot()` ⇒ 闸在这里 ⇒ **只有一个施加点**。

    消息里的命令**只引用参数合法域常量**（`SLOT_COMPACT` 等）⇒ 不会出现
    「建议的命令根本不存在」（族 E 的假称：旧形那句「先 `handoff compact status` 再写」
    ——`compact` 压根不支持 `status`）。
    """
    cap = _hot_cap_limit(slot)
    if not cap or len(content) <= cap or force:
        return
    if slot in SLOT_COMPACT:
        how = (f"历史班段请搬冷档：`handoff compact {slot}`"
               f"（追加新班段用 `handoff append {slot}`，会自动挤出旧段）")
    else:
        how = (f"{slot} 不分冷热层 ⇒ 直接改写整槽：`handoff set {slot}`"
               f"（追加用 `handoff append {slot}`）")
    die(f"{op}: {slot} 新内容 {len(content)} 字符超热层上限 {cap}——{how}"
        f"；确要强写加 --force" + (f"　（{hint}）" if hint else ""))


def _parse_covers(st: Store, raw: str | None) -> list[str]:
    """解析 `--covers`（逗号／空格分隔的 id 列表）并**逐个校验**（v5.31.0 壬-2）。

    校验：① id 形态；② **在库里**（查不到就拒——写错 id 声明了等于没声明，
    而「没声明」的后果是判据红 ⇒ 宁可当场报错，也不让错误声明静默生效）。

    ② 的口径＝**库里存在**（live ＋ closed ＋ decisions），**不是「还没销账」**：
    「先 `close` 再写班段」是**自然动线**（本班刚办完的条目正是要交代的那些）⇒
    若只认 live，则 close 之后再声明同一条 id 会被写入面拒死 ⇒ 作者被迫
    「声明一个查不到的 id」或「不声明自己刚办的条目」⇒ 两难都把纪律变成噪音。
    已闭 id 进了 covers 只是**留痕**，不改变任何判定（判据只关心**未销账**的条目）。
    """
    if not raw:
        return []
    ids = [x.strip() for x in re.split(r"[,，\s]+", str(raw)) if x.strip()]
    known = set(st.all_ids())
    out: list[str] = []
    for i in ids:
        if not rid_re_match(i):
            die(f"--covers: {i!r} 不是条目 id 形态（{ID_FORM}）——不猜")
        if i not in known:
            die(f"--covers: {i!r} 在库里查不到（不存在或已删除）——"
                f"要声明的必须是**库里存在的条目 id**；`handoff view` 看全部条目")
        out.append(i)
    return sorted(set(out))


def _extract_refs(text: str) -> list[str]:
    """从**班段散文**里提取「点名到的条目 id」（refs）——写时一次，落进班次台账。

    v5.45.0（refs 化）：覆盖义务的**主路**从「作者另写一份声明」改成「**散文里提到即算**」
    ⇒ 作者成本 0（提到就覆盖）⇒ 覆盖事实的**原件**就是散文，声明不再是必经的第二份陈述。

    口径：词边界的条目 id 形态（与 `ID_RE` 同形：`[tpducq]` ＋ 6 位数字）——
    词边界 ⇒ 不会从 `t0001234`／`xt000123` 里切出半个 id。
    """
    if not text:
        return []
    return sorted({m.group(0).lower() for m in REF_ID_RE.finditer(text)})


def _guard_covers(st: Store, op: str, covers: list[str], text: str = "") -> None:
    """写入面：**自上一班以来新增的条目必须被本段点名覆盖**（v5.31.0 壬-2／v5.45.0 refs 化）。

    覆盖集合＝**班段散文里点到的 id**（refs）∪ **结构化声明**（`--covers`，批量出口）
    ⇒ 散文里提到就覆盖（作者成本 0）⇒ 几十条 id 提不动时用 `--covers` 打包。

    为什么前移到写入面：判据面红之后要改的是**散文整槽**（`set` 是整槽覆写）⇒ 成本高；
    而「交代」本来就是一次**写动作**⇒ 在写这一刻要求它顺手带上，成本最低
    （与既有的 `guard_derived_counts` 同一纪律：写入面拦，不靠事后红）。
    """
    pending = _pending_cover_ids(st)
    covered = set(covers) | set(_extract_refs(text))
    missing = [i for i in pending if i not in covered]
    if not missing:
        return
    die(f"{op}: 自上一班以来新增 {len(pending)} 条条目，本段**必须点名覆盖**"
        f"（还缺 {len(missing)} 条：{' '.join(missing[:8])}{'…' if len(missing) > 8 else ''}）"
        f"——**班段散文里写到这些 id 就算覆盖**（refs 化：作者成本 0）；"
        f"一次写不完就用 `--covers {','.join(missing)}` 打包声明"
        f"（散文只写叙述，声明是例外出口）")


def _write_slot(st: Store, slot: str, content: str, op: str, *,
                force: bool = False, snapshot: bool = True, index: bool = True,
                hint: str = "", covers: list[str] | None = None,
                refs: list[str] | None = None) -> None:
    """热层槽（exit／summary／status）的**唯一**写入口（v5.30.0 刀 C）。

    漏斗做四件事（顺序固定）：
      ① **剥机器渲染块**（exit 的队列区／status 的 counts 区）——派生物不进散文层
         （⇒ 「每次改池都记得复渲染」那类**写点清单**整条消失：队列区历史上漏接三次）；
      ② **热层字节闸**（`_hot_cap_check`，唯一施加点）；
      ③ **prev 快照**（上一次成功写入的版本）；
      ④ **落盘 ＋ 写事件台账**（`write_index` 是写事件的唯一记录点）。

    `index=False`：给**维护型写**用（`write_index` 内部剥旧库残留时）——那时再调
    `write_index` 会递归。
    """
    if slot == "exit":
        content = _strip_queue(content)
    elif slot == "status":
        content = _strip_counts(content)
    _hot_cap_check(slot, content, op, force=force, hint=hint)
    tgt = st.d / slot
    old = tgt.read_text(encoding="utf-8") if tgt.is_file() else ""
    if snapshot and old.strip():
        prev = st.d / "prev"
        prev.mkdir(exist_ok=True)
        (prev / slot).write_text(old, encoding="utf-8")
    tgt.write_text(content, encoding="utf-8")
    # v5.30.0 刀 F：**散文写入记下班次序号**（界碑的唯一源）⇒ 只认两种 op：
    # `append exit`（追加一个班段）与 `set exit`（整槽覆写散文）。
    # `compact exit`（只搬冷档）、`sync-queue`（只剥残留）、`import`（迁移）都**不是**新班段
    # ⇒ 把它们算进来，边界会被无关写入一次次推前 ⇒ 新条目随即逃出点名义务。
    if slot == "exit" and op in ("append", "set"):
        _append_shift(st, f"{op} exit", covers=covers, refs=refs)
    if index:
        st.write_index(f"{op} {slot}")


def _append_summary(st: Store, text: str) -> int:
    # v5.37.0（覆盖实测轮）：**与 `set summary` 同口径**——v5.32.0 的状态规范化挂在
    # `set`（散文槽）与 `append exit` 上，**漏了 `append summary`** ⇒ 同一个槽两条写路
    # 产出不同（实测：`set summary` 把「t000418（已闭）」规范化成「t000418」，
    # `append summary` 原样落盘）⇒ 状态副本仍能从这条路产生 ⇒ 验收线 A4「新写不再产生
    # 状态副本」未真正达成。**只规范化新写进来的行**（存量热层不动——工具不静默改旧文）。
    text, _norm = normalize_state_claims(text)
    if _norm:
        print(f"handoff append: 已规范化 {len(_norm)} 处状态标记（状态由 `handoff view` 现算补）→ "
              + "；".join(_norm[:5]) + ("…" if len(_norm) > 5 else ""))
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        die("append: 内容为空（--file - 忘了喂 stdin？）")
    hot = (st.d / "summary").read_text(encoding="utf-8") if (st.d / "summary").is_file() else ""
    merged = (text.rstrip("\n") + "\n" + hot).strip("\n")
    all_lines = merged.splitlines()
    evict = [ln for ln in all_lines[KEEP_SUMMARY_LINES:] if ln.strip()]
    keep = all_lines[:KEEP_SUMMARY_LINES]
    new_hot = "\n".join(keep) + "\n"
    # v5.31.0：**字节闸先于归档**（拒写零落盘）。
    # 2026-10-23 实测（本版收口时撞到）：`handoff append summary` 写出 8345 字符 > 上限 8192
    # ⇒ 被字节闸拒写 ⇒ 但**归档已经写过了**（`_archive_append` 在写槽之前）⇒ 落盘留痕、
    # 台账没记 ⇒ `handoff check` 报「archive/summary.jsonl：存在**未经 CLI 记录的写入**」⇒
    # 一次**被正确拒绝**的写把库弄红了。
    # 根因与 v5.30.0 刀 C 同族：**闸挪了位置、副作用没跟着挪**——归档是写事件要记的副作用，
    # 必须排在闸**之后**、写槽**之前**（写槽负责把两个文件一起记进同一条写事件）。
    # `_hot_cap_check` 是纯判定（不写盘、不留痕）⇒ 提前调它只是把拒绝提前，不改判定口径。
    _hot_cap_check("summary", new_hot, "append")
    _archive_append(st, "summary", evict)
    # v5.30.0 刀 C：经唯一漏斗写（字节闸在这里统一施加点——旧形 summary 这条路**根本没有闸**）
    _write_slot(st, "summary", new_hot, "append")
    print(f"handoff append: summary（+{len(lines)} 行，热层 {len(keep)} 行"
          + (f"，冷档挤出 {len(evict)} 行" if evict else "，无挤出") + "）")
    return 0


def cmd_append(st: Store, a) -> int:
    """单文件槽的**追加**写入口（v5.0）：补「set 只有整槽覆写」的语义缺口。

    手改头号根因＝「只想加一段，却被迫整槽取回拼装」。append 把这条正确路径的摩擦
    降到比手改更低。exit 追加一个班段（热层只留最新 KEEP_EXIT_SECTIONS 节，旧节自动
    搬冷档）；summary 追加若干行（热层保 KEEP_SUMMARY_LINES 行，溢出行搬冷档）。
    """
    st.note_pre_tamper()
    if a.slot not in SLOT_APPEND:
        die(f"append: 只支持 {'／'.join(SLOT_APPEND)}（exit 按班段／summary 按行）")
    content = sys.stdin.read() if a.file == "-" else Path(a.file).read_text(encoding="utf-8")
    if not content.strip():
        die("append: 内容为空——确认要写空请用 set --allow-empty")
    if a.slot == "summary":
        return _append_summary(st, content)
    text = content.strip("\n")
    if a.slot == "exit":
        # v5.29.0：区不再落盘 ⇒ 作者把旧区整段粘进来时剥掉（否则机器内容进散文层）。
        text = _strip_queue(text)
    if not text.lstrip().startswith("## "):
        text = f"## 追加（{today()[5:]}）· 未命名\n" + text
        print("  提示：内容未带 `## ` 班段标题，已自动补「## 追加（MM-DD）· 未命名」——"
              "下次请自带标题（例：`## 10-07 第二十二段 · 主题`）")
    sec_lines = len(text.splitlines())
    if sec_lines > EXIT_SECTION_LINES:
        die(f"append: 新班段 {sec_lines} 行 > 单班段上限 {EXIT_SECTION_LINES} 行"
            f"（12 行里**含标题行与标题后的空行**⇒ 正文最多 {EXIT_SECTION_LINES - 2} 行）——"
            f"班段只写「做了／发现／裁定／接手一步」，过程叙述删掉", key="行 > 单班段上限")
    # v5.32.0（P1／批 A）：**状态不再由作者抄写** ⇒ 写面**不因状态拒写**（两个方向都不拦），
    # 只把**无时点**行里紧邻 id 的**括号型**闭态标记规范化掉（带时点的历史陈述不动）。
    text, _norm = normalize_state_claims(text)
    if _norm:
        print(f"handoff append: 已规范化 {len(_norm)} 处状态标记（状态由 `handoff view` 现算补）→ "
              + "；".join(_norm[:5]) + ("…" if len(_norm) > 5 else ""))
    guard_derived_counts("append", "exit", text)
    # v5.31.0 壬-2：**结构化覆盖声明**——自上一班以来新增的条目必须被本段声明
    # ⇒ 判据读声明（落盘证据），不再解析散文文本 ⇒ 散文回归纯叙述。
    covers = _parse_covers(st, getattr(a, "covers", None))
    _guard_covers(st, "append", covers, text)
    hot = (st.d / "exit").read_text(encoding="utf-8") if (st.d / "exit").is_file() else ""
    sections = [text] + [s for s in _split_exit_sections(hot)]
    evict = sections[KEEP_EXIT_SECTIONS:]
    keep = sections[:KEEP_EXIT_SECTIONS]
    # v5.29.0：**不注入队列区**——区读时现算（`handoff view`）⇒ 热层里不再有
    # O(池规模) 的机器内容 ⇒ 库再大也写得进班段（实测 500 条时旧形 append rc=1）。
    new_hot = "\n\n".join(keep)
    # v5.30.0 刀 C：字节闸搬进唯一漏斗（这里不再自己判——第二处实现就是分叉的起点）
    _hot_cap_check("exit", new_hot, "append", hint="新班段写短一点")
    _archive_append(st, "exit", evict)
    _write_slot(st, "exit", new_hot, "append", hint="新班段写短一点", covers=covers,
                refs=_extract_refs(text))
    print(f"handoff append: exit（新班段 {sec_lines} 行"
          + (f"，冷档挤出 {len(evict)} 节" if evict else "，无挤出") + "）")
    return 0


def cmd_retitle(st: Store, a) -> int:
    """改 exit **热层**某一班段的标题：只动该节 `## ` 行，正文逐字不动。

    只支持热层：冷档 `archive/exit.jsonl` 是历史事实（`read --at/--grep` 可读），
    不做原地改写。`--at N` 按 `handoff view` 的 exit 节顺序（1＝最新）；
    `--match` 按当前标题唯一子串定位，多命中时要求改用 `--at`。
    """
    title = a.title
    from_shell = True
    if getattr(a, "from_file", None):
        got = load_from_file("retitle", a.from_file, {"title"})
        if title is not None and "title" in got:
            die("retitle: --title 同时出现在命令行与 --from-file；只留一处")
        title = got.get("title", title)
        from_shell = False
    require_text("retitle", "--title", title, from_shell=from_shell)
    if title is None:
        die("retitle: 需要 --title <新标题>（或用 --from-file 给 title=…）")
    new_title = re.sub(r"^#+\s*", "", str(title).strip())
    if not new_title:
        die("retitle: --title 去掉 `#` 后为空——给一个非空标题")
    if "\n" in new_title or "\r" in new_title:
        die("retitle: --title 必须单行（标题只占一行）")
    guard_len("retitle", "--title", new_title, TITLE_CAP)
    hot_file = st.d / "exit"
    hot = hot_file.read_text(encoding="utf-8") if hot_file.is_file() else ""
    sections = _split_exit_sections(hot)
    if not sections:
        die("retitle: exit 热层没有班段可改——先 `handoff append exit --file <段>` 写一段", key="班段不存在")
    if a.at is not None:
        if not 1 <= a.at <= len(sections):
            die(f"retitle: --at {a.at} 超出范围（现有 {len(sections)} 段，1＝最新）",
                key="班段不存在")
        idx = a.at - 1
    else:
        needle = (a.match or "").strip()
        if not needle:
            die("retitle: --match 为空——给标题片段，或用 --at <序号>")
        hits = [i for i, s in enumerate(sections) if needle in s.splitlines()[0]]
        if len(hits) != 1:
            listing = "；".join(f"{i + 1}: {s.splitlines()[0]}" for i, s in enumerate(sections))
            die(f"retitle: --match {needle!r} 命中 {len(hits)} 段（须恰好 1 段）——现有：{listing}",
                key="标题匹配不唯一")
        idx = hits[0]
    lines = sections[idx].splitlines()
    if not lines[0].startswith("## "):
        die(f"retitle: 第 {idx + 1} 段首行不是 `## ` 标题（节前前言不充当班段）",
            key="班段不存在")
    old = lines[0]
    lines[0] = f"## {new_title}"
    sections[idx] = "\n".join(lines)
    _write_slot(st, "exit", "\n\n".join(sections), "retitle", hint="标题改短一点")
    print(f"handoff retitle: {old} → ## {new_title}")
    return 0


def cmd_resolve(st: Store, a) -> int:
    """消解一条坑（p 型）：销账归档到 `closed/p.jsonl`，等价 `close --outcome`。

    只收 p 型（其它条目走 `close`）；必须给结论（`--outcome` 或 `--from-file` 的
    `outcome=…`），不留「静默销账」这条路。关闭序本身仍只有 `plan_close`／
    `apply_close` 一份实现。
    """
    if not str(a.id).startswith("p"):
        die(f"resolve: 只消解坑（p 型）；{a.id} 不是坑——条目请用 `handoff close {a.id} --outcome …`")
    if a.outcome is None and not getattr(a, "from_file", None):
        die("resolve: 必须给 --outcome <消解结论>（销账要留结论；等价 close --outcome）")
    rc = cmd_close(st, a.id, a.outcome, no_refill=True,
                   from_file=getattr(a, "from_file", None))
    if rc == 0:
        print(f"handoff resolve: {a.id} 已消解（销账归档到 closed/p.jsonl）")
    return rc


def cmd_upgrade_prio(st: Store, a) -> int:
    """把 summary 前缀里的**旧声明**收进各自的正规通道：d000108（actions）＋ d000111（非 action 槽）。

    两条腿，语义不同、都不许猜：
    · **actions 腿**——前缀曾是排序来源 ⇒ 读进 `prio` 字段，并**只剥档位词、限定语留在 summary**
      （`[高·用户自持，勿催]` → `prio=高` ＋ `[用户自持，勿催] …`）。上一版这条腿用窄正则
      （要求档位词后紧跟闭括号），于是 `[高·X]` 被判「不可解析」⇒ **悄悄落默认档**，实测在
      neonforge-v1 的副本上把作者标「高」的活条目降成了「中」——拒收面要严、回填面要宽，
      两个面共用一条正则正好制造它本要治的静默降级（`t000278`）。
    · **非 action 腿**（pitfalls／commands）——那里的 `[高]/[中]/[低]` 说的是**严重度**，不是
      「先做哪个」（跨仓实算 56 条里 48 条在这两个槽）⇒ **保义改写**成不相交的词表
      `高危/中危/低危`（`[中]` → `[中危]`）。`急/缓` 没有对应的严重度词 ⇒ 不猜、点名人工定。

    默认**只出计划、不落盘**（`--apply` 才写）：批量改写必须先看得清。`.handoff/` 不入 git ⇒
    改任何一行前把受影响文件整份拷进 `prev/upgrade-prio/`，恢复不寄托在 git 上（p000123）。
    **closed 永不重写**（P1）：只扫 live——归档里的前缀是当时的历史事实。幂等：改写后的
    `[高危]` 不再命中档位谓词，再跑一次报「无待回填」。
    """
    plan: dict[Path, list[dict]] = {}          # 文件 → 改写后的整份行（不动的就是原行）
    act_rows: list[tuple[str, str, str]] = []  # (id, 新 prio, 说明)
    sev_rows: list[str] = []                   # 非 action 槽：改了哪些 id
    unparsed: list[str] = []                   # 读不出对应词 ⇒ 不猜、点名
    slots = {"actions": (st.d / "actions").is_dir(), "pitfalls": (st.d / "pitfalls").is_dir(),
             "commands": (st.d / "commands").is_dir()}
    for slot in (k for k, v in slots.items() if v):
        for f in sorted((st.d / slot).glob("*.jsonl")):
            rows = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
            out, changed = [], False
            for r in rows:
                if r.get("closed"):
                    out.append(r); continue
                summ = r.get("summary", "") or ""
                if slot != "actions":
                    if not is_tier_prefix(summ):
                        out.append(r); continue
                    news = severityize(summ)
                    if news is None:                       # 急／缓：没有对应严重度词，不猜
                        unparsed.append(f"{r.get('id','?')}（{slot}，前缀 {tier_token_of(summ)!r} 无严重度对应词）")
                        out.append(r); continue
                    nr = dict(r); nr["summary"] = news
                    out.append(nr); changed = True
                    sev_rows.append(r.get("id", "?"))
                    continue
                if "prio" in r:                            # 已回填过 ⇒ 不动
                    out.append(r); continue
                tok = tier_token_of(summ)
                prio = (tok if tok in PRIO_RANK else LEGACY_TO_PRIO.get(tok)) if tok else None
                nr = dict(r)
                nr["prio"] = prio or PRIO_DEFAULT
                if prio:
                    nr["summary"] = strip_tier_head(summ)
                    act_rows.append((r.get("id", "?"), prio, "前缀已读进字段"))
                else:
                    if _BRACKET_HEAD.match(summ):
                        unparsed.append(f"{r.get('id','?')}（action，前缀 {summ[:12]!r} 读不出档位词）")
                    act_rows.append((r.get("id", "?"), PRIO_DEFAULT, "读不出档位词 ⇒ 落默认『中』，请人工复核"))
                out.append(nr); changed = True
            if changed:
                plan[f] = out
    if not (act_rows or sev_rows):
        print("handoff upgrade-prio: 无待回填条目（live 条目要么已有 prio 字段，要么前缀不是档位词）")
        return 0
    print(f"handoff upgrade-prio: 待处理 {len(act_rows) + len(sev_rows)} 条"
          f"（actions {len(act_rows)}／标注改写 {len(sev_rows)}）"
          + ("" if a.apply else "（默认只出计划，确认无误加 --apply）"))
    for i, pr, note in act_rows:
        print(f"  {i}: prio={pr}（{note}）")
    if sev_rows:
        print("  严重度改写（不猜语义，只换词表）：" + "、".join(sev_rows)
              + f" ⇒ 形如 `[中]` 改 `[{'/'.join(SEVERITY_TAGS)}]` 之一")
    if unparsed:
        print(f"  ⚠ {len(unparsed)} 条**不猜**、请人工定档：" + "；".join(unparsed[:6])
              + ("…" if len(unparsed) > 6 else ""))
    if not a.apply:
        return 0
    bk = st.d / "prev" / "upgrade-prio"
    bk.mkdir(parents=True, exist_ok=True)
    for f, out in plan.items():
        (bk / f.name).write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
        write_jsonl_atomic(f, out)
    st.write_index("upgrade-prio")
    print(f"handoff upgrade-prio: 已改写 {len(act_rows) + len(sev_rows)} 条；原件备份在 prev/upgrade-prio/")
    return 0


def cmd_sync_queue(st: Store, a) -> int:
    """队列区专用命令（v5.29.0 改语义）。

    v5.29.0 起队列现态区**读时现算、不落盘**（读者看 `handoff view`）⇒ 本命令不再
    「复渲染区」（那件事已不存在：没有存储态区 ⇒ 就没有会陈旧的区 ⇒ 就没有
    `queue-stale` 维，也没有「改池要记得复渲染」的写点清单）。现在它管两件事：
      · **默认**：剥掉 exit 里**旧库残留**的区（v5.29.0 之前落盘的）。判据
        `queue-legacy` 的报错指向这条命令 ⇒ **它必须真能剥掉**——指一条不存在的修法
        是本仓记过的假称形态（p000044 同族）。
      · **`--print`**：现算打印队列区（**不落盘**）——读者要一眼看队列时用这条。
    幂等：没有残留就**一个字节都不写**（写一次 `sync-queue` 不该把 exit 的 mtime 与
    写事件搅乱，那会让「写入对账」判据抓不到真正的旁路写入）。
    """
    st.note_pre_tamper()
    if getattr(a, "print", False):
        rows = _queue_rows(st)
        print("handoff sync-queue --print：队列现态（现算，不落盘；补位顺序）")
        print("\n".join(rows) if rows else "（池空）")
        return 0
    tgt = st.d / "exit"
    hot = tgt.read_text(encoding="utf-8") if tgt.is_file() else ""
    if QUEUE_BEGIN not in hot:
        print("handoff sync-queue: exit 里没有遗留队列区（v5.29.0 起区读时现算、不落盘）"
              "——队列现态看 `handoff view`")
        return 0
    body = _strip_queue(hot)
    # v5.30.0 刀 C：剥残留走同一函数（原先这里是**第二份**剥区实现 ⇒ 两处会分叉）
    strip_queue_block(st)
    print("handoff sync-queue: 旧库残留的队列区已剥掉（队列现态改由 `handoff view` 现算）")
    return 0


def cmd_compact(st: Store, a) -> int:
    """热层裁剪（v5.0）：把超出保留额的历史搬进冷档。`--keep` 缺省＝exit 1 节／summary 30 行。"""
    st.note_pre_tamper()
    if a.slot not in SLOT_COMPACT:
        die(f"compact: 只支持 {'／'.join(SLOT_COMPACT)}"
            f"（status 是散文槽、不分冷热层 ⇒ 裁剪＝直接改写整槽）")
    tgt = st.d / a.slot
    hot = tgt.read_text(encoding="utf-8") if tgt.is_file() else ""
    if a.slot == "exit":
        units = _split_exit_sections(hot)
        keep_n = a.keep if a.keep else KEEP_EXIT_SECTIONS
    else:
        units = [ln for ln in hot.splitlines() if ln.strip()]
        keep_n = a.keep if a.keep else KEEP_SUMMARY_LINES
    if len(units) <= keep_n:
        print(f"handoff compact: {a.slot} 现 {len(units)} 单元 ≤ 保留 {keep_n}，无可归档")
        return 0
    evict, keep = units[keep_n:], units[:keep_n]
    _archive_append(st, a.slot, evict)
    joiner = "\n\n" if a.slot == "exit" else "\n"
    body = joiner.join(keep) + ("\n" if a.slot == "summary" else "")
    if a.slot == "exit":
        # v5.29.0：区不再落盘 ⇒ 压缩后**不注入**区；遗留区顺手剥掉。
        body = _strip_queue(body)
    # v5.30.0 刀 C：经唯一漏斗写（字节闸统一施加点）
    _write_slot(st, a.slot, body, "compact")
    print(f"handoff compact: {a.slot} 保留 {len(keep)} 单元，冷档归档 {len(evict)} 单元"
          f"（ archive/{a.slot}.jsonl 现 {len(_archive_rows(st, a.slot))} 行）")
    return 0


def render_derived(st: Store) -> dict[str, str]:
    """**派生视图的唯一渲染器**（v5.30.0 刀 D）。

    派生物（队列现态／现态计数）**只在渲染期存在**（v5.29.0 刀1 ＋ v5.30.0 刀B）⇒
    旧形「`view` 现算、`read` 只给原文」＝**两条读面对同一事实给不同答案**（族 D），
    而读者拿到哪一份取决于他敲了哪条命令 ⇒ 现在两条读面都从这里取 ⇒ 口径不可能不齐。

    渲染规则各一个唯一源：队列现态＝`_queue_rows`；现态计数＝`counts_lines`。
    """
    return {"queue": _queue_block(st), "counts": "\n".join(counts_lines(st))}


def cmd_read(st: Store, a) -> int:
    """热＋冷合并的**按需读**（v5.0）：接手默认只读热层；要历史用 --tail/--at/--grep。

    **读面边界（v5.30.0 刀 D，说真话）**：本命令给的是**散文原文**（＋冷档历史）；
    派生的现算视图（队列现态／现态计数）**不在默认输出里** ⇒ 要它就加 `--derived`
    （现算、不落盘，永远与库一致）—— 也可以直接跑 `handoff view`（含全部派生视图）。
    旧形两条读面口径不齐（`view` 有现算区、`read` 没有）⇒ 现在同一个渲染器出两份。
    """
    if a.slot not in SLOT_READ:
        die(f"read: 只支持 {'／'.join(SLOT_READ)}")
    hot = (st.d / a.slot).read_text(encoding="utf-8") if (st.d / a.slot).is_file() else ""
    if a.slot == "exit":
        units = [{"date": "", "text": hot}] if hot.strip() else []
        units += list(reversed(_archive_rows(st, a.slot)))   # 冷档升序追加 → 倒序 = 最新在前
    else:
        units = [{"date": "", "text": "\n".join(
            ln for ln in hot.splitlines() if ln.strip())}] if hot.strip() else []
        units += [{"date": r["archived"], "text": r["text"]}
                  for r in reversed(_archive_rows(st, a.slot))]
    out = units
    if not (a.tail or a.at or a.grep or a.all):
        out = out[:1]            # 默认＝只读热层（历史按需取，别把冷档全量灌给读者）
    if a.tail:
        out = out[:a.tail]
    if a.at:
        if a.at == "today":
            a.at = today()
        if not _ARCHIVE_DATE_RE.match(a.at):
            die("read: --at 须为 YYYY-MM-DD（或 today）")
        out = [u for u in out if u.get("date") == a.at]
    if a.grep:
        out = [u for u in out if a.grep.lower() in u.get("text", "").lower()]
    if getattr(a, "derived", False):
        # 现算派生视图（与 `view` 同一渲染器 ⇒ 口径不可能不齐）
        _dv = render_derived(st)
        print("【现算派生视图 · 不落盘】")
        print("## 队列现态")
        print(_dv["queue"].strip())
        print("## 现态计数")
        print(_dv["counts"])
        print()
    if not out:
        print(f"handoff read: {a.slot} 无匹配（热层"
              + ("为空" if not hot.strip() else "不匹配")
              + "；冷档用 --all/--tail/--grep 取）")
        return 0
    for u in out:
        print(f"【{'热' if not u.get('date') else u['date']}】")
        print(u["text"])
        print()
    return 0


# ---------------- v5.0：install-shim（t000196③）----------------
def _shim_script(anchor: Path) -> str:
    """`handoff` PATH shim 的内容（唯一源：install-shim 写它、selftest 测它）。

    **解析式，不是固定路径**（v5.73.1）。消费侧是各项目的真实拷贝且版本各自演进
    （d000179/d000180）⇒ 全局入口钉死某一副本会让版本不跟项目、副本一删就断。
    解析顺序（版本管理器的常态语义）：
      ① 锚点（安装来源）在 **它自己的项目树内** ⇒ 锚点——editable 语义：在真源仓里
         开发时跑**源**，而不是 `.agents/skills/` 里的自装副本；
         「项目根」由锚点路径反推（`<root>/project-handoff/scripts/handoff.py` 或
         `<root>/.agents/skills/project-handoff/scripts/handoff.py`）——**不能**按
         「任意共同祖先」判：那会让同一 `$HOME` 下所有项目都命中锚点；
         用户级安装（反推结果＝`$HOME`）不参与本条；
      ② cwd 向上最近的 `<dir>/.agents/skills/project-handoff/scripts/handoff.py`
         ——消费项目的**版本跟项目**；
      ③ `$HOME/.agents/skills/project-handoff/scripts/handoff.py`——用户级标准位；
      ④ 锚点；⑤ 都没有 ⇒ 报错 exit 127（给出可执行修法）。
    仍然**不改 PATH、不碰 rc 文件**。
    """
    a = shlex.quote(anchor.as_posix())
    return f'''#!/usr/bin/env bash
# handoff CLI resolver（`handoff install-shim` 生成；内容一致则不重写）
# ① 安装来源在它自己的项目树内 ⇒ 用它（editable：在真源仓里跑源）
# ② 最近的 <项目>/.agents/skills/project-handoff（版本跟项目）
# ③ $HOME/.agents/skills/project-handoff（用户级标准位）④ 安装来源 ⑤ 报错
anchor={a}
py=python3
command -v python3 >/dev/null 2>&1 || py=python
aroot=${{anchor%/project-handoff/scripts/handoff.py}}
case "$aroot" in */.agents/skills) aroot=${{aroot%/.agents/skills}};; esac
[ "$aroot" = "$HOME" ] && aroot=
if [ -n "$aroot" ] && [ -f "$anchor" ]; then
  case "$(pwd -P)" in
    "$aroot"|"$aroot"/*) exec "$py" "$anchor" "$@";;
  esac
fi
d=$(pwd -P)
while :; do
  if [ -f "$d/.agents/skills/project-handoff/scripts/handoff.py" ]; then
    exec "$py" "$d/.agents/skills/project-handoff/scripts/handoff.py" "$@"
  fi
  [ "$d" = / ] && break
  d=$(dirname "$d")
done
if [ -f "$HOME/.agents/skills/project-handoff/scripts/handoff.py" ]; then
  exec "$py" "$HOME/.agents/skills/project-handoff/scripts/handoff.py" "$@"
fi
if [ -f "$anchor" ]; then exec "$py" "$anchor" "$@"; fi
echo 'handoff: 找不到可用的 CLI——当前目录及 $HOME 下都没有 .agents/skills/project-handoff，安装时副本也已不存在' >&2
echo '  修法：在项目里安装技能（.agents/skills/project-handoff），或从任一副本重跑 install-shim' >&2
exit 127
'''


def cmd_install_shim(st: Store, a) -> int:
    """把 `handoff` 命令装进 `~/.local/bin`（PATH shim，解析式）。

    运行时按 `_shim_script` 的顺序解析：本仓 editable → 最近项目副本 → 用户级 →
    安装来源。幂等：内容一致即不写；**绝不改 PATH、绝不碰任何 rc 文件**——
    `~/.local/bin` 在主流发行版默认 PATH 内；不在时只打印提示，由用户自行决定。
    """
    bin_dir = Path(getattr(a, "dir", None) or (Path.home() / ".local" / "bin")).expanduser()
    target = bin_dir / "handoff"
    script = Path(__file__).resolve()
    desired = _shim_script(script)
    bin_dir.mkdir(parents=True, exist_ok=True)
    cur = target.read_text(encoding="utf-8") if target.is_file() else ""
    if cur == desired:
        print(f"handoff install-shim: 已是最新（幂等，未改动）→ {target}")
    else:
        target.write_text(desired, encoding="utf-8")
        target.chmod(0o755)
        print(f"handoff install-shim: {'更新' if cur else '安装'} → {target}")
    onpath = str(bin_dir) in os.environ.get("PATH", "").split(os.pathsep)
    if onpath:
        print("  PATH 已含该目录，无需任何配置")
    else:
        print(f"  提示：{bin_dir} 不在 PATH——请自行加入（本命令不改 PATH／rc 文件）")
    return 0


def cmd_seal(st: Store, a) -> int:
    seal_store(st.d)
    print("handoff seal: 已封存（全树只读；任何工具直改将被 EACCES 拒绝，"
          "写入口＝`handoff` CLI）。任意 v5 命令跑完会自动维持封存。")
    return 0


def cmd_unseal(st: Store, a) -> int:
    _STAY_UNSEALED.add(str(st.d.resolve()))    # main 的 finally 按**这个库**判断要不要回封
    unseal_store(st.d)
    print("handoff unseal: 已解锁且本次不回封（维护态）。维护完请 `handoff seal`，"
          "或跑任意写命令（自动回封）。")
    return 0


def cmd_set(st: Store, a) -> int:
    """单文件槽增量写入口（status/summary/exit）——补「add 无覆盖」缺口。"""
    st.note_pre_tamper()          # 写前旁证快照（本次写自己的 mtime 变化不算外部改动）
    if a.slot == "scope":
        die("set: scope 请用 `scope add/remove/prune`")
    if a.slot not in SLOT_SET:
        die(f"set: 只支持单文件槽 {'／'.join(SLOT_SET)}")
    content = sys.stdin.read() if a.file == "-" else Path(a.file).read_text(encoding="utf-8")
    st.d.mkdir(parents=True, exist_ok=True)
    tgt = st.d / a.slot
    old = tgt.read_text(encoding="utf-8") if tgt.is_file() else ""
    # d000105 第 2 层：队列区是**派生物**——热层硬闸／单班段行限／骤降比／状态断言
    # 一律**只量散文**。否则「读回 exit、改一行、整槽写回」这条正当路径会被区自己顶爆
    # 12 行班段闸（区并进最后一个班段计数）。prev/ 快照仍存**原始**旧文（含区），
    # 保「上一次成功写入的版本」这个语义不打折。
    _old_prose = _strip_rendered(old) if a.slot in ("exit", "status") else old
    if a.slot == "exit":
        content = _strip_queue(content)
    elif a.slot == "status":
        content = _strip_counts(content)
    if not content.strip() and not a.allow_empty:
        # P1 不删：空内容多半是 `--file -` 忘了喂 stdin，静默清空槽位即数据丢失
        die("set: 内容为空——确认要清空请加 --allow-empty（P1 不删：疑似 stdin 漏喂）"
            )   # 被拒时**一个字节都没写、也没快照**（快照在守卫之后，4.8.4）——别在这里提 prev/
    # 拒空守门只拦「零字节」，拦不住「把整槽覆写当局部编辑用」——09-22 实测复发：
    # 只喂一行表头就把 3677 字符的 status 清成 11 字符。
    #
    # **原来的 `len(old) > 200` 是条盲区**（p000029，2026-10-03 实测）：旧内容 123B／315B
    # 时只喂一行 → 截断到 17B 却**静默放行 rc=0**；1957B 起才拦。而小仓/新项目恰恰最容易被
    # 随手写一行，那条下限正好把它们全漏掉。现改为**旧内容非空即判**（不设字节下限）——
    # 「整槽覆写 vs 局部编辑」是**语义**问题，不该由文件大小决定。小文件误判由 60% 降幅本身
    # 兜住（本就几十字节的槽删几行才算骤降）；且错误信息**直接给出可复制的恢复命令**：
    # 反复确认会被自动化掉，**易 undo 才是真正的安全**。
    #
    # **本判据的固有边界（如实写明，别当它无所不能）**：在**极小内容**上比例阈值不可靠——
    # 一个 25 字符的槽删到 10 字符（降幅 40%）分不清「有意删掉一行」与「只喂了表头」。
    # 这类残余误用由 `--dry-run`（写入前逐条列出将丢失的行）兜，而不是继续调阈值：
    # 阈值再调就必然开始误伤正常的小幅删减。
    # v5.0 热层硬闸（t000196④/②）：热层是接手时要全量读的，膨胀直接烧 token。
    # 超限即拒并指向 compact；--force 仍可强写（维护态不堵死）。
    # v5.30.0 刀 C：闸搬进唯一施加点 `_hot_cap_check`（本处**先查一次**只为保住报错位置：
    # 它在骤降守卫与 --dry-run 之前 ⇒ 旧形的报错次序不变；漏斗落盘前再查一次＝防御纵深）。
    _hot_cap_check(a.slot, content, "set", force=a.force)
    if a.slot == "exit" and not a.force:
        # 单班段行数上限：班段是「接手一步」级的信息单元，超过 12 行多半混进了
        # 流水账或复述。按 `## ` 切节逐节判（节内含标题行计数）。
        import itertools
        sec_lines, cur = [], None
        for ln in content.splitlines():
            if ln.startswith("## "):
                if cur is not None:
                    sec_lines.append(cur)
                cur = 1
            elif cur is not None:
                cur += 1
        if cur is not None:
            sec_lines.append(cur)
        over = [n for n in sec_lines if n > EXIT_SECTION_LINES]
        if over:
            die(f"set: exit 有班段 {max(over)} 行 > 单班段上限 {EXIT_SECTION_LINES} 行"
                f"（12 行里**含标题行与标题后的空行**⇒ 正文最多 {EXIT_SECTION_LINES - 2} 行）——"
                f"班段只写「做了／发现／裁定／接手一步」，过程叙述删掉；确要强写加 --force", key="行 > 单班段上限")
    if a.slot in PROSE_SLOTS:
        # v5.32.0（P1／批 A）：**状态不再由作者抄写** ⇒ 写面不因状态拒写，
        # 只把**无时点**行里紧邻 id 的**括号型**闭态标记规范化掉（带时点的历史陈述不动）。
        content, _norm = normalize_state_claims(content)
        if _norm:
            print(f"handoff set: 已规范化 {len(_norm)} 处状态标记（状态由 `handoff view` 现算补）→ "
                  + "；".join(_norm[:5]) + ("…" if len(_norm) > 5 else ""))
    guard_derived_counts("set", a.slot, content)
    # v5.31.0 壬-2：结构化覆盖声明（只有 **exit**（班段）需要；summary 是纯摘要）
    covers = _parse_covers(st, getattr(a, "covers", None)) if a.slot == "exit" else []
    if a.slot == "exit":
        _guard_covers(st, "set", covers, content)
    if getattr(a, "dry_run", False):
        # exit 的 dry-run **一律用剥掉队列区之后的散文**比对：区是派生物、写入时自动重注入，
        # 拿含区的旧文去比剥区的新内容会把那几行报成「将丢失」——那是**不实陈述**，而
        # `--dry-run` 的全部意义就是「将丢哪些行」看得准（p000029 那条事故的兜底面）。
        _cmp_old = _old_prose
        print(f"handoff set --dry-run: {a.slot}")
        print(f"  将写入 {len(content)} 字符 / {len(content.splitlines())} 行"
              + (f"；现有 {len(_cmp_old)} 字符 / {len(_cmp_old.splitlines())} 行"
                 if old else "（槽现为空）"))
        if a.slot == "exit" and QUEUE_BEGIN in old:
            print("  （队列区已改为读时现算、不落盘：上面比的是剥掉区后的散文；"
                  "写入时遗留区会被剥掉）")
        if _cmp_old and len(content) < len(_cmp_old):
            print(f"  ⚠ 将**减少** {len(_cmp_old) - len(content)} 字符"
                  f"（{len(_cmp_old)} → {len(content)}）——单文件槽是整槽覆写")
        lost = [ln for ln in _cmp_old.splitlines() if ln.strip() and ln not in content]
        for ln in lost[:10]:
            print(f"  - 将丢失行: {ln[:100]}")
        if len(lost) > 10:
            print(f"  … 另有 {len(lost) - 10} 行将丢失")
        print("  （未写入任何内容；去掉 --dry-run 执行）")
        return 0
    o_len, n_len = len(_old_prose.strip()), len(content.strip())
    if _old_prose.strip() and n_len < 0.6 * o_len and not a.force:
        # **不要在这里给「恢复命令」**（4.8.5 独立审计实测：这是条**死命令且危险**的
        # 建议）。被拒时**一个字节都没写**，`{a.slot}` 还是原内容——根本不需要回退；
        # 而 `prev/` 存的是**上一次成功写入**的版本，读者照做反而会把当前内容
        # 覆盖成上一个版本，**全程无警告**（自建样例：当前 W、prev 是陈旧 V，
        # 照提示复制 ⇒ W 被 V 覆盖）。要回退请用 `git` 或你自己留的备份。
        die(f"set: {a.slot} 内容骤降 {o_len} → {n_len} 字符（<60%）——"
            f"单文件槽是**整槽覆写**、无追加语义；**新班段用 `handoff append {a.slot}` 追加**"
            f"（不必整槽喂回）；确实要改旧内容再取回全文、改完整槽喂回；"
            f"确要大幅删减加 --force。\n"
            f"  （本次**未写入任何内容**，`{a.slot}` 仍是原内容，不需要回退。"
            f"要恢复到别的版本请用 git 或你自己的备份——`prev/` 是**上一次成功写入**"
            f"的版本，不是「本该写进去但没写」的那个。）")
    if a.slot == "exit":
        # v5.29.0：队列现态区**不再落盘**（读时现算，`handoff view` 现给你）⇒ 写入前把
        # 内容里的遗留区剥掉——作者整槽喂回旧文件、或旧库残留，都不能把机器内容留在
        # 人写的散文层（机器行留在散文里 ⇒ 已销账的 id 会被 fresh-stale 误报成「没带
        # 关闭标记」，而那行是人改不动的）。
        content = _strip_queue(content).rstrip("\n") + "\n"
    # v5.30.0 刀 C：经唯一漏斗写（剥渲染块 → 字节闸 → prev 快照 → 落盘 → 写事件台账）。
    # 快照放在**所有守卫之后、真正写入之前**：守卫拒绝与 `--dry-run` 都不该在盘上
    # 留痕迹（旧实现快照在最前 ⇒ `--dry-run` 明明输出「未写入任何内容」却改了 prev/，
    # 独立审计实测抓到）。`prev/` 的语义因此更准＝**上一次成功写入的版本**。
    _write_slot(st, a.slot, content, "set", force=a.force, covers=covers,
                refs=(_extract_refs(content) if a.slot == "exit" else None))
    print(f"handoff set: {a.slot}（{len(content)} 字符" + (f"，旧内容快照 prev/{a.slot}" if old.strip() else "") + "）")
    return 0


def _scope_lines(st: Store) -> list[str]:
    p = st.d / "scope"
    if not p.is_file():
        return []
    return [s for s in (l.strip() for l in p.read_text(encoding="utf-8").splitlines())
            if s and not s.startswith("#")]


def _scope_resolves(st: Store, entry: str) -> bool:
    pat = entry if os.path.isabs(entry) else str(st.root_dir / entry)
    if any(c in entry for c in "*?["):
        return bool(glob.glob(pat, recursive=True))
    return os.path.exists(pat)


_SKIP_DIRS = {".handoff", ".git", "node_modules", ".venv", "__pycache__", ".scaffold"}
_LEGACY = ("HANDOFF.md", "HANDOFF-ARCHIVE")

# 完备性扫描标记词表（t000098）：原只认 `- [ ]` / `<!-- open:`，漏掉「建议以表格／散文形态
# 存在于报告里」这一整类（09-22 实测：21 条建议全在表格里，五份出处只捞到 1 份）。
# 基表取自 2026-09-20 待办丢失根因设计件 L183 的封闭词表（维护者资产，不随件分发）；
# 项目可在 `.handoff/scope-vocab` 追加词、在 `.handoff/scope-ignore` 登记 fnmatch 豁免。
_MARKER_HEAD = ("建议", "待办", "未决", "待决", "残余", "下一步", "待定", "TBD", "遗留",
                "未实施", "未闭环", "待裁", "待回填", "未办", "缺口", "待投入")
_MARKER_TOKENS = ("TODO", "FIXME", "XXX")          # ASCII，按词边界匹配
_MARKER_CJK = ("未做", "备而未用")                  # 句内出现即算（CJK 无 ASCII 词边界可依）


def _conf_lines(p: Path) -> list[str]:
    if not p.is_file():
        return []
    return [s for ln in p.read_text(encoding="utf-8", errors="replace").splitlines()
            if (s := ln.split("#", 1)[0].strip())]


def scope_markers(st: "Store") -> re.Pattern:
    words = list(_MARKER_HEAD)                                  # 标题/表格内命中（防正文噪声）
    extra = _conf_lines(st.d / "scope-vocab")                   # 项目追加词：全文命中（opt-in）
    alt = "|".join(re.escape(w) for w in words)
    toks = "|".join(re.escape(t) for t in _MARKER_TOKENS)
    cjk = "|".join(re.escape(t) for t in (*_MARKER_CJK, *extra))
    return re.compile(
        r"^\s*-\s*\[ \]" r"|<!--\s*open:"
        rf"|\b(?:{toks})\b"
        rf"|^#{{1,6}}\s[^\n]*(?:{alt})"            # 标题含建议词
        rf"|^\|[^\n]*\|[^\n]*(?:{alt})[^\n]*\|"    # 表格行含建议词（表格建议行）
        rf"|(?:{cjk})", re.M)


def scope_ignore(st: "Store") -> list[str]:
    return _conf_lines(st.d / "scope-ignore")


def _gitignore_patterns(root: Path) -> list[str]:
    p = root / ".gitignore"
    if not p.is_file():
        return []
    out = []
    for l in p.read_text(encoding="utf-8", errors="replace").splitlines():
        s = l.strip()
        if s and not s.startswith("#") and not s.startswith("!"):
            out.append(s)
    return out


def _ignored(patterns: list[str], rel: str) -> bool:
    import fnmatch
    parts = rel.split("/")
    for pat in patterns:
        p = pat.rstrip("/")
        if "/" in p:
            if fnmatch.fnmatch(rel, p) or rel.startswith(p + "/"):
                return True
        elif any(fnmatch.fnmatch(part, p) for part in parts):
            return True
    return False


def _brace_expand(s: str) -> list[str]:
    m = re.search(r"\{([^{}]+)\}", s)
    if not m:
        return [s]
    out = []
    for alt in m.group(1).split(","):
        out += _brace_expand(s[:m.start()] + alt + s[m.end():])
    return out


def _scope_scan(st: Store) -> int:
    """机械候选提议：命中标记 / 旧模型件 / 旧 HANDOFF 引用，且未登记。纯提议、非权威。

    标记词表＝基表（`scope_markers`，t000098 已扩到标题/表格形态）＋ `.handoff/scope-vocab`
    项目追加词；`.handoff/scope-ignore` 的 fnmatch 模式**豁免**文件（压噪声，均属纯提议面）。
    """
    root = st.root_dir
    reg = set(_scope_lines(st))
    ign = _gitignore_patterns(root)
    ignores = scope_ignore(st)
    marker = scope_markers(st)
    cands: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames
                       if d not in _SKIP_DIRS and not _ignored(ign, str((Path(dirpath) / d).relative_to(root)))]
        for fn in filenames:
            fp = Path(dirpath) / fn
            rel = str(fp.relative_to(root))
            if _ignored(ign, rel) or not fn.lower().endswith((".md", ".markdown", ".txt")):
                continue
            if any(fnmatch.fnmatch(rel, p) for p in ignores):
                continue
            try:
                text = fp.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if marker.search(text):
                cands.add(rel)
    # 旧模型件总提议（主迁移源，即便无标记）
    for leg in _LEGACY:
        t = root / leg
        if t.is_dir():
            for f in sorted(t.rglob("*.md")):
                cands.add(str(f.relative_to(root)))
        elif t.is_file():
            cands.add(leg)
    # 旧 HANDOFF 引用（花括号展开；跳过绝对 / URL / 锚）
    ho = root / "HANDOFF.md"
    if ho.is_file():
        text = ho.read_text(encoding="utf-8", errors="replace")
        for raw in re.findall(r"`([^`\s]+)`", text) + re.findall(r"\]\(([^)\s]+)\)", text):
            for m in _brace_expand(raw.strip()):
                if not m or m.startswith(("http", "#", "/")):
                    continue
                try:
                    rp = (root / m).resolve()
                    if rp == st.d.resolve() or st.d.resolve() in rp.parents:
                        continue
                except OSError:
                    pass
                if os.path.exists(str(root / m)):
                    cands.add(m)
    for c in sorted(x for x in cands if x not in reg):
        print(c)
    return 0


def cmd_scope(st: Store, a) -> int:
    p = st.d / "scope"
    if a.action == "list":
        for e in _scope_lines(st):
            print(e)
        return 0
    if a.action == "add":
        if not a.path:
            die("scope add: 需要 <path|glob>")
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(a.path.strip() + "\n")
        st.write_index("scope add")   # 写事件：否则 scope 的改动无记录，
                                      # 之后**任何**写命令都把它当成「CLI 之外的改动」
                                      # （分发点统一取快照也救不了——快照只是读，不产生记录）
        print(f"handoff scope add: {a.path}")
        return 0
    if a.action == "remove":
        lines = p.read_text(encoding="utf-8").splitlines() if p.is_file() else []
        kept = [l for l in lines if l.strip() != (a.path or "").strip()]
        fd, tmp = tempfile.mkstemp(dir=str(st.d))
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("\n".join(kept) + ("\n" if kept else ""))
        os.replace(tmp, p)
        st.write_index("scope remove")
        print(f"handoff scope remove: {a.path}")
        return 0
    if a.action == "prune":
        lines = p.read_text(encoding="utf-8").splitlines() if p.is_file() else []
        kept, dropped = [], []
        for l in lines:
            s = l.strip()
            if not s:
                continue
            if s.startswith("#") or _scope_resolves(st, s):
                kept.append(l)
            else:
                dropped.append(s)
        fd, tmp = tempfile.mkstemp(dir=str(st.d))
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("\n".join(kept) + ("\n" if kept else ""))
        os.replace(tmp, p)
        for d in dropped:
            print(f"handoff scope prune: 移除不可解析 {d}")
        if not dropped:
            print("handoff scope prune: 无可移除")
        st.write_index("scope prune")
        return 0
    if a.action == "scan":
        return _scope_scan(st)
    die("scope: 需要 list|add|remove|prune|scan")


# ---------------- main ----------------
def _reject_legacy_form(argv: list[str]) -> None:
    """`add --slot <槽>` 已废（v3.2.0）：并集参数面会让本型不消费的键静默消失。

    不留兼容层——留了就等于把并集面留着，病没治。旧形**非零退出**并直接印出新形（P3 不静默）。
    """
    if "add" not in argv:
        return
    j = argv.index("add") + 1                   # 位置判定：旧形的 --slot 紧跟 add；
    if j >= len(argv) or not argv[j].startswith("--slot"):
        return                                  # 否则只是某个参数值里提到了 --slot（如写废止说明）
    tok = argv[j]
    val = tok.split("=", 1)[1] if "=" in tok else (
        argv[j + 1] if j + 1 < len(argv) and not argv[j + 1].startswith("-") else "")
    new = SLOT2KIND.get(val)
    tip = (f"改用 `handoff add {new} …`" if new
           else "改用 `handoff unconfirmed add --ref <路径#锚> [--summary …]`" if val == "unconfirmed"
           else "改指某型：`handoff add action|pitfall|command|decision …`")
    die(f"add --slot {val or '<槽>'} 已废（该面按型不消费的字段会静默丢弃）：{tip}", 2)


def constant_leg_violations(src: str) -> list[tuple[int, str]]:
    """**恒绿腿**扫描（v5.40.0／批 C-③ 的可机械那半，判据的唯一源）：
    `expect(...)` 的断言若是**常量**（True／False／数字／字符串）⇒ 那条腿**没有断言任何东西**
    ⇒ 恒绿 ⇒ 废腿（仓规：「断言必须落在会坏的东西上」——这条把它机械化）。

    **唯一的豁免**：常量断言处在 if/else 分支里 ⇒ 那是**报告层**（「检出缺陷 ⇒ 报一条失败的腿」
    用的就是常量 False）。但豁免要求该分支的**判别式不是常量**，否则 `if True:` 就能把它
    变成合法 ⇒ 豁免会失效。

    返回 [(行号, 腿名), ...]（行号 1-based）。"""
    import ast as _ast_c

    tree = _ast_c.parse(src)
    out: list[tuple[int, str]] = []

    def _const(node) -> bool:
        return isinstance(node, _ast_c.Constant)

    def _walk(node, in_report_branch: bool) -> None:
        for child in _ast_c.iter_child_nodes(node):
            branch = in_report_branch
            if isinstance(child, _ast_c.If):
                branch = in_report_branch or not _const(child.test)
            if (isinstance(child, _ast_c.Call) and isinstance(child.func, _ast_c.Name)
                    and child.func.id == "expect" and child.args
                    and isinstance(child.args[0], _ast_c.Constant)
                    and isinstance(child.args[0].value, str)):
                cond = child.args[1] if len(child.args) > 1 else None
                if cond is not None and _const(cond) and not branch:
                    out.append((child.lineno, child.args[0].value))
            _walk(child, branch)

    _walk(tree, False)
    return out


def const_str_sets(src: str) -> list[tuple[str, int, frozenset[str]]]:
    """**任意作用域的常量**的静态字符串集合（AST 派生，v5.66.0 · t000471 · F-D 首立；
    v5.68.0 · t000475 · F-I3 放宽两维）。

    返回 [(常量名, 行号, 字符串集合), ...]；值不是「静态可求的字符串集合」时**不出现**
    （例如 `tuple(sorted(...))`、函数调用、推导式 ⇒ 求不出就不判 ⇒ 零误报）。

    **为什么要 AST 而不是正则**：正则只能盯**某个变量名的某一种写法**（旧形只能认出
    `CLI_VERBS = (`）⇒ 副本换个写法就复活；AST 判的是**形态**——「有个常量（**任何
    作用域**），它的内容是子命令表的全集（**或超集**）」⇒ 换写法、换名、换作用域、
    多一项都抓得住。

    **v5.68.0 放宽的两维（实测漏了三条，逐条见版本演进记录）**：
      ① **作用域**：旧形只扫**模块级**（`tree.body`）⇒ 副本写进函数体或类属性里
         ⇒ 闸不报（实测「函数局部副本」「类属性副本」两条都绿）。
      ② **集合关系**：旧形判**等于**全集 ⇒ 副本比真表**多一项**（多出来那个命令在
         parser 里**不存在**）⇒ 闸不报——而那正是这条闸存在的理由（放行不存在的命令）。
      ③ **容器形态**：旧形只认 tuple/list/set 字面量与 `tuple()/list()/set()` 调用
         ⇒ 写成 **dict 的键**、或写成**两段拼接** ⇒ 闸不报。

    **能判的形态（穷举自真样本，判据输入全是源码结构）**：
      · `X = ("a", "b")`／`[...]`／`{...}`（元素全是字符串常量）
      · `X = tuple([...])`／`list([...])`／`set([...])`
      · `X = {"a": 1, "b": 2}`（**键**是字符串常量 ⇒ 取键集）
      · `X = A + B`（A、B 都能静态求值 ⇒ 取并集）
      · `X = A`（A 指向另一个能静态求值的常量 ⇒ 别名也是副本）
    求不出（非字面量／含非字符串元素／名字查不到）⇒ 跳过 ⇒ 零误报。
    """
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []
    # ── 收集**所有作用域**的赋值（模块级 / 函数体 / 类体 / 嵌套块）────────
    assigns: list[tuple[str, int, ast.AST]] = []
    for node in ast.walk(tree):
        targets: list[ast.Name] = []
        value = None
        if isinstance(node, ast.Assign):
            value = node.value
            targets = [t for t in node.targets if isinstance(t, ast.Name)]
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            value = node.value
            targets = [node.target]
        if value is None or not targets:
            continue
        for t in targets:
            assigns.append((t.id, getattr(node, "lineno", 0), value))
    # ── 名字表：供 `X = A`／`X = A + B` 这类**引用型**赋值解析 ──
    names: dict[str, frozenset[str]] = {}
    for _nm, _ln, _val in assigns:
        _v = _static_str_set(_val, names)
        if _v is not None:
            names[_nm] = _v
    out: list[tuple[str, int, frozenset[str]]] = []
    for _nm, _ln, _val in assigns:
        _v = _static_str_set(_val, names)
        if _v is not None:
            out.append((_nm, _ln, _v))
    return out


def _static_str_set(node: ast.AST, names: dict[str, frozenset[str]] | None = None
                    ) -> frozenset[str] | None:
    """静态求值：tuple/list/set 字面量，或 tuple()/list()/set() 调用的字符串元素；
    另加（v5.68.0）dict 的**键集**、`A + B` 拼接、`X = A` 引用。

    求不出（非字面量／含非字符串元素／名字查不到）⇒ 返回 None ⇒ 判据跳过 ⇒ 零误报。
    """
    names = names or {}
    if isinstance(node, ast.Dict):
        vals: set[str] = set()
        for k in node.keys:
            if k is None:                       # `**x` 展开 ⇒ 求不出
                return None
            if not (isinstance(k, ast.Constant) and isinstance(k.value, str)):
                return None
            vals.add(k.value)
        return frozenset(vals)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = _static_str_set(node.left, names)
        right = _static_str_set(node.right, names)
        if left is None or right is None:
            return None
        return left | right
    if isinstance(node, ast.Name):
        return names.get(node.id)              # 引用型：查不到 ⇒ None
    elts: list[ast.AST] | None = None
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        elts = list(node.elts)
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) \
            and node.func.id in ("tuple", "list", "set") and node.args:
        arg = node.args[0]
        if isinstance(arg, (ast.Tuple, ast.List, ast.Set)):
            elts = list(arg.elts)
    if elts is None:
        return None
    vals = set()
    for e in elts:
        if isinstance(e, ast.Constant) and isinstance(e.value, str):
            vals.add(e.value)
        else:
            return None
    return frozenset(vals)


def cli_verb_source_violations(src: str, derived: tuple[str, ...] | None = None) -> list[str]:
    """**子命令表单一源**闸（v5.62.0 · t000466）：「CLI 子命令表」这个事实**只许有一个产生源**。

    **为什么要有这道闸**（t000466 的根因）：旧形是一份**手抄字面量**（32 个子命令各写一遍）
    ⇒ 它与 argparse 的实表是**两份** ⇒ 加子命令而忘了改副本 ⇒ 文档「命令全表」漏项、
    出路闸把真命令判成「命令不存在」（假红）、反向漂移时**放行不存在的命令**（假绿）
    ⇒ 而重述点闸只实算 `legacy_scan`／`doc_facts` 两类、机制覆盖登记只管**载体面**
    ⇒ **代码内的常量副本整类无机制覆盖**。
    ⇒ 治法＝**消灭副本**（本仓 v5.41.0 已裁定的机制选型判据：「盯副本的治法必须是消灭副本，
    不是盯着副本」）⇒ 真源＝**parser 树**（`build_parser()` 自 v5.10.0 起是唯一构造口）。
    ⇒ 本闸守住那个成果：**可手抄的子命令表不许再出现**（出现＝有人把副本写了回来）。

    **判据（机械、可实算）**：
    ① 源码里不得有**手抄的子命令表**：**任何作用域**的常量，其字符串集合 **⊇** parser
       子命令表的全集 ⇒ 红（**判形态，不判变量名、不判写法**——v5.66.0 起判 AST 而非
       正则；v5.68.0 再放宽作用域与集合关系两维，见 `const_str_sets` 的 docstring）；
    ② 派生表与 parser 实表必须**恒等**（`derived` == 从 `build_parser()` 枚举出的集合）；
    ③ 派生值不得为空（空＝枚举口径坏了，会让出路闸把**所有**命令判成不存在）。

    `derived` 可显式传入（负控用：喂一个与实表不一致的表 ⇒ 闸必须红）；
    缺省＝取实跑派生值。

    返回违例清单（空＝合规）。"""
    out: list[str] = []
    try:
        real = _real_cli_verbs()
    except Exception as e:                                  # 枚举口径坏了 ⇒ 闸要红
        return [f"parser 实表取不到（{type(e).__name__}: {e}）⇒ 判不了副本"]
    real_for_copy_check = set(real)
    # ① 副本不许回来——**判形态，不判变量名**（v5.66.0 · t000471 · F-D；
    #    v5.68.0 · t000475 · F-I3 再放宽两维：**作用域**＋**集合关系**）：
    #    **任何作用域**的常量，其字符串集合 **⊇** parser 子命令表的全集 ⇒ 红。
    #    ⇒ 换写法（list／tuple()／带类型注解）、换名、**换作用域**（函数体／类属性）
    #      都抓得住；**超集**也抓得住（副本多一项＝多了一个**不存在**的命令，比原样
    #      抄更糟——正是这条闸要防的「放行不存在的命令」）。
    #    **部分**集合（白名单形态）不误伤（那类本就该合法）。
    for _nm, _ln, _vals in const_str_sets(src):
        if _vals and _vals >= set(real_for_copy_check):
            out.append(f"L{_ln}：常量 `{_nm}`（任何作用域）的字符串集合 **⊇** CLI 子命令表全集"
                       f" ⇒ 又变回了一份**手抄副本**（子命令表只许一个源＝parser 树）")
    # ②③ 派生表 == 实表，且非空
    if derived is None:
        try:
            derived = tuple(cli_verbs())
        except Exception as e:                                  # 枚举口径坏了 ⇒ 闸要红
            return out + [f"派生子命令表取不到（{type(e).__name__}: {e}）⇒ 出路闸会把所有命令判成不存在"]
    if not derived:
        out.append("派生子命令表为空 ⇒ 出路闸会把**所有**命令判成「不存在」（枚举口径坏了）")
    elif set(derived) != set(real):
        out.append(f"派生表 != parser 实表：多={sorted(set(derived) - set(real))} 少={sorted(set(real) - set(derived))}")
    return out


def consumed_gates(src: str) -> list[str]:
    """**从代码派生**的「机制全集」之闸部分（v5.65.0 · t000469 · F-B）。

    **形态**（可枚举、零误报；实测见本技能的**版本演进记录** v5.65.0 条目）：
    本模块里**被调用**、且名字以 `_violations` 结尾的函数 ⇒ 每一个就是一个闸（机制）。
    判据输入＝**源码结构**（调用点 AST）⇒ **不靠任何人工表** ⇒ 新闸不登记就自动进全集。

    **为什么以「调用点」为准而不是「函数定义」**：定义了却没人调的闸不是机制（死代码）；
    调用点＝**消费点**（持续消费才是机制 ⇒ 持续消费才进门禁）。
    **为什么靠命名约定**：可枚举的筛子只有这一把——实测「全模块调用点」共 307 个、
    其中 291 个是普通辅助函数 ⇒ 必须有筛子；另一把候选「selftest 的 `expect` 条件里
    被调用的名字」**既误抓又漏**（误抓 `Path`/`len`/`sorted` 等 33 个，漏 14 个真闸）
    ⇒ 判负。故：闸函数的命名必须统一带 `_violations` 后缀（v5.65.0 把
    `exit_nonexistent_commands` 改名 `exit_nonexistent_commands_violations` 就是为了
    **消掉那个特例**，让派生纯靠命名约定、无需任何例外名单）。

    ⚠ **诚实残余**：命名约定本身是约定——新闸若**不**带 `_violations` 后缀 ⇒ 派生不出它
    ⇒ 完整性闸看不见它 ⇒ 这是「命名约定 = 机制形态」这条链的代价（靠「新闸要同批登记」
    的纪律兜）。
    """
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []
    out: set[str] = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name):
            if n.func.id.endswith("_violations"):
                out.add(n.func.id)
    return sorted(out)


def discipline_completeness_violations(src: str | None = None) -> list[str]:
    """**纪律完整性闸**（v5.63.0 · d000161 首立；v5.65.0 换分母 ＋ 换声明形态）：**每个机制都被声明了**。

    **判什么**（F2＝「纪律完整性」的根因推导结论，见本技能的**版本演进记录** v5.63.0 条目）：「该有的纪律都登记了」若按**文档侧**判 ⇒ 需要一份「纪律全集」⇒
    **全集不可枚举**（实测：随件文档里 `- **标题**：` 形态条目 28 条，其中 **20 条不是纪律**
    ＝解释性散文／事实陈述／契约句 ⇒ 任何「文档→清单」方向的零误报形态都抓不全）
    ⇒ d000158 判负三条枚举口径（本轮逐条复核，**三条结论都成立**）。

    ⇒ **分治**（d000158 自己已认定的那条分界）：
      · **闸型纪律**（判据维的规则文本与契约）完整性**机械可判**——规则文本由渲染块带进
        随件文档（实测 **29/29** 维都在 `references/cli.md` 的渲染块里）⇒ 漏不掉 ⇒ 不判；
      · **非闸型纪律**（只写在随件文档里、不在判据清单里）才需要登记 ⇒ 而它们**没有全集**。

    ⇒ **本闸怎么让它可判**：不判「全集」，判**集合差**——
      **① 分母＝机制全集**（v5.65.0 换源）：判据维（`CHECK_DIMENSIONS`）∪
      **代码里被消费的闸**（`consumed_gates()` 派生）⇒ **不再靠人工表枚举**
      （旧分母＝三张人工表 ⇒ 实测 3 个**真实被消费**的闸不在对账面内 ⇒ 本闸对它们无效）；
      **② 声明形态互斥**（v5.65.0）：每个机制**一行**声明，值要么是守护者纪律 id 列表、
      要么是「无纪律＋理由」⇒ **同一机制两处都声明在结构上不可能**（旧形两张方向相反
      的表可同时收同一机制 ⇒ 实测 5 处自相矛盾 ⇒ 差集语义在交集上失效 ⇒ 删掉一条守护
      关系也**不红** ⇒ 守护关系可静默腐烂）；
      **③ 理由非空**（空理由＝无痕免检口）⇒ **红**；
      **④ 守护者纪律 id 必须真在纪律清单里**（假登记 ⇒ 红）；
      **⑤ 表里的机制名必须真存在**（指向不存在的东西 ⇒ 红）；
      **⑥ 在册纪律不许孤儿**（没有机制声明它 ⇒ 它靠什么生效？⇒ 须登记在
      `DISCIPLINE_UNWATCHED` 里并写明理由）——合并成一张表后「纪律→守护哪些机制」这个
      方向变成**派生**的 ⇒ 这条判据把**旧形顺带查出来的那个方向**保住。
      ⇒ 全是**形状／集合**判据 ⇒ **零误报、零语义**；失败给出**可执行修法**。

    **诚实残余**：① 归类（「这条机制值不值得一条纪律」「该纪律守护哪些机制」）**仍是人工
    口径**——本闸换的是「人工做一次、闸只对账」，**不是消除人工**；② 闸的**命名约定**
    （`_violations` 后缀）是形态约定 ⇒ 不带后缀的新闸派生不出来（靠「新闸要同批登记」的
    纪律兜）；③ 射程仍只有 `DISCIPLINE_DOCS` 那一份随件文档（命令参考不在内，同 t000465
    的已知缺口）。

    返回违例清单（空＝合规）。"""
    out: list[str] = []
    if src is None:
        try:
            src = Path(__file__).read_text(encoding="utf-8")
        except OSError as e:
            return [f"读不到自身源码（{type(e).__name__}: {e}）⇒ 派生不出机制全集 ⇒ 完整性判不了"]
    mechs = {d[0] for d in CHECK_DIMENSIONS} | set(consumed_gates(src))
    declared = set(DISCIPLINE_DECL)
    # ① 每个机制都有声明
    missing = sorted(mechs - declared)
    if missing:
        out.append(f"机制 {len(missing)} 条**没有任何纪律声明**（要么登记守护者纪律 id 列表，"
                   f"要么登记「无纪律＋理由」）：{missing[:6]}"
                   f"（加进 `DISCIPLINE_DECL`）")
    # ② 表里的机制名必须真存在
    extra = sorted(declared - mechs)
    if extra:
        out.append(f"`DISCIPLINE_DECL` 里的机制 {len(extra)} 条**不存在**（指向了不存在的东西）："
                   f"{extra[:6]}（机制名须是判据维名或本模块里被消费的闸名）")
    # ③ 逐条声明的形状
    guarded_by: dict[str, list[str]] = {}
    for mname, val in DISCIPLINE_DECL.items():
        if isinstance(val, tuple):
            if not val:
                out.append(f"机制 `{mname}` 声明「有纪律」但**守护者列表为空**"
                           "（要么列守护者纪律 id，要么改成「无纪律＋理由」）")
            for did in val:
                guarded_by.setdefault(did, []).append(mname)
                if did not in DISCIPLINE_PRESENT:
                    out.append(f"机制 `{mname}` 的守护纪律 `{did}` **不在纪律清单**"
                               "（`DISCIPLINE_PRESENT`）⇒ 假登记")
        elif isinstance(val, str):
            if not val.strip():
                out.append(f"机制 `{mname}` 声明「无纪律」但**理由为空**"
                           "（空理由＝无痕免检口 ⇒ 必写明为什么它不需要一条要读者记住的纪律）")
        else:
            out.append(f"机制 `{mname}` 的声明形态非法（须是守护者 id 列表 `tuple` 或理由字符串 `str`）")
    # ④ 在册纪律不许孤儿（没有机制声明它 ⇒ 须登记在 `DISCIPLINE_UNWATCHED` 里并写明理由）
    for did in sorted(DISCIPLINE_PRESENT):
        if did not in guarded_by and did not in DISCIPLINE_UNWATCHED:
            out.append(f"在册纪律 `{did}` **没有任何机制声明它守护** ⇒ 它靠什么生效？"
                       f"（要么给某个机制登记它为守护者，要么登记进 `DISCIPLINE_UNWATCHED` 并写明理由）")
    for did, why in DISCIPLINE_UNWATCHED.items():
        if did not in DISCIPLINE_PRESENT:
            out.append(f"`DISCIPLINE_UNWATCHED` 里的纪律 `{did}` **不在纪律清单** ⇒ 假登记")
        if not (why or "").strip():
            out.append(f"纪律 `{did}` 登记为「没有机制承载」但**理由为空**")
        if did in guarded_by:
            out.append(f"纪律 `{did}` 既被机制声明为守护者、又登记为「没有机制承载」⇒ 矛盾")
    return out


def parser_facts() -> dict[str, object]:
    """**parser 树的事实**（v5.66.0 · t000471 · F-E／F-F／F-G 的唯一来源）。

    返回：
      · `verbs` ＝ 顶层子命令名（元组）；
      · `global_flags` ＝ **顶层** parser 的选项串（全局参数，如 `--store`）；
      · `global_flag_takes_value` ＝ 全局参数**是否带值**（argparse 的 `nargs`；
        带值的参数后面那个词是它的值 ⇒ 取命令名时必须跳过它）；
      · `all_flags` ＝ **全部层级**的选项串并集（含各子命令自己的 flag）；
      · `kinds` ＝ 顶层子命令的**第二层**子命令名（`add` ⇒ action/pitfall/command/decision）。

    **为什么一切从这棵树派生**：`build_parser()` 是**参数面唯一构造口**（v5.10.0 起）⇒
    命令名、flag 名、kind 名**都只有一个源** ⇒ 判据不需要任何手抄清单。
    """
    ap = build_parser()
    verbs: list[str] = []
    global_flags: set[str] = set()
    takes_value: dict[str, bool] = {}
    kinds: dict[str, list[str]] = {}
    for act in ap._actions:
        # argparse 的 `nargs=None` 表示「收一个值」；只有 store_true／store_false／
        # count／help／version 这几类**不收值** ⇒ 用 action 类型判，别拿 nargs 判。
        _noval = (argparse._StoreTrueAction, argparse._StoreFalseAction,
                  argparse._CountAction, argparse._HelpAction, argparse._VersionAction)
        for opt in act.option_strings:
            global_flags.add(opt)
            takes_value[opt] = not isinstance(act, _noval)
        choices = getattr(act, "choices", None)
        if isinstance(choices, dict):
            for name, sub in choices.items():
                verbs.append(name)
                for a2 in getattr(sub, "_actions", []):
                    if a2.__class__.__name__ == "_SubParsersAction":
                        ki = getattr(a2, "choices", None)
                        if isinstance(ki, dict):
                            kinds[name] = sorted(ki.keys())
    all_flags: set[str] = set(global_flags)

    def _walk(parser, acc):
        for act in parser._actions:
            acc |= set(act.option_strings)
            choices = getattr(act, "choices", None)
            if isinstance(choices, dict):
                for sub in choices.values():
                    _walk(sub, acc)

    _walk(ap, all_flags)
    return {"verbs": tuple(sorted(verbs)), "global_flags": global_flags,
            "global_flag_takes_value": takes_value,
            "all_flags": all_flags, "kinds": kinds}


# ---- v5.69.0（t000475·④）：flag 记号**长 short 都算** ----
# 旧形只认 `startswith("--")` ⇒ **短 flag 天然放行**：出路里点名一个不存在的短 flag
# （`handoff check -Z`）不红 ⇒ 闸在这半边没有覆盖面。
# 短 flag 的形状取 POSIX 惯例：`-` ＋ 字母（可连写）⇒ 数字（`-1`）、单个 `-`（stdin）、
# 负数都**不是** flag 记号（那是值，不是记号）。
SHORT_FLAG_RE = re.compile(r"^-[A-Za-z][A-Za-z0-9]*$")


def _is_flag_token(w: str) -> bool:
    """这个词是不是 flag 记号（长 `--x`／`--x=v`，或短 `-x`）。

    **做成函数**（不是内联判断）：变异自证要在夹具里把它换回旧形（只认 `--`）⇒
    换得掉才有「去掉修复 ⇒ 负控转绿」的实证（d000111 同款做法）。"""
    if w.startswith("--"):
        return True
    return bool(SHORT_FLAG_RE.match(w))


def exit_nonexistent_commands_violations(texts: list[str]) -> list[tuple[int, str]]:
    """**出路文案的合法性闸**（v5.41.0 首立；v5.66.0 扩到 flag／第二层／全局参数写法）。

    **判什么**（全从 parser 树派生 ⇒ 无手抄清单 ⇒ 零误报）：
      ① 出路文案里反引号中的 `handoff <命令>` ⇒ **命令必须真在子命令表里**
         （照着敲要能跑：防 t000413 那族「照抄一条不存在的命令」）；
      ② **跳过顶层全局参数及其值**再取命令名（`--store` 是顶层参数，argparse 要求它写在
         子命令**之前** ⇒ `handoff --store .handoff check` 是**唯一合法写法** ⇒ 旧形把它
         判成「命令不存在」＝**假红**）；
      ③ 命令是 `add` 时，下一个词必须真在它的 **kind 面**（action/pitfall/command/decision）
         ⇒ 不存在的 kind 不该放行；
      ④ 出路文案里的 `--flag` 必须真在 **parser 树的 flag 集**里（全部层级并集）。

    **只看 `handoff …` 开头的反引号串**：外部命令（如 `git diff --stat`）的 flag **不核**
    ⇒ 不误伤（d000022 当年判负「跨技能 flag 检查」的理由之一就是假阳难压；本闸只核
    **本技能自己**的 parser 树派生集合 ⇒ 不触那条病）。

    返回 [(序号, 记号原文), ...]（序号＝texts 的下标＋1）；空＝全部合法。"""
    facts = parser_facts()
    verbs = set(facts["verbs"])
    gflags = facts["global_flags"]
    takes_value = facts["global_flag_takes_value"]
    allflags = facts["all_flags"]
    kinds = facts["kinds"]
    out: list[tuple[int, str]] = []
    for i, text in enumerate(texts, 1):
        for inner in EXIT_TICK_RE.findall(text):
            words = inner.strip().split()
            if not words or words[0] != "handoff":
                continue
            j = 1
            # ② 跳过顶层全局参数及其值（`--flag`／`--flag=value`）
            while j < len(words):
                w = words[j]
                base = w.split("=", 1)[0]
                if base not in gflags:
                    break
                j += 1
                if "=" not in w and takes_value.get(base) and j < len(words) \
                        and not words[j].startswith("-"):
                    j += 1                      # 该全局参数的值
            if j >= len(words):
                continue
            cmd = words[j]
            if cmd not in verbs:
                out.append((i, inner))
                continue
            # ③ 第二层子命令（kind 面）
            if cmd in kinds and j + 1 < len(words):
                nxt = words[j + 1]
                if not nxt.startswith("-") and nxt not in kinds[cmd]:
                    out.append((i, inner))
                    continue
            # ④ flag 必须真存在（全部层级并集）——**长 flag 与短 flag 都核**
            #    （v5.69.0 · t000475·④）：旧形 `if w.startswith("--")` ⇒ 短 flag 放行。
            if any(w.split("=", 1)[0] not in allflags
                   for w in words[j:] if _is_flag_token(w)):
                out.append((i, inner))
    return out

def _selftest_static_mechanism_gates(expect, quick: bool = False) -> None:
    """静态机制闸的腿（quick/full 共用；唯一源）。

    收的是只能靠 selftest 执行的机制闸及其负控/变异腿（exit-key、
    check_fix_violations、fact_copy_violations）与静态配套（注释面豁免、形态表、
    Q4 匹配器）。这些腿只读源码、不建库。
    `quick=True` 只跑三把闸的**正控**：它们是对 15k 行源做多轮 AST/注释扫描，
    全集约 8s；负控/变异留给 full。为什么 quick 敢省：本档的唯一消费者是全库门禁，
    而门禁按**源指纹**决定跑不跑 full——改坏闸＝源变 ⇒ full 必然跑 ⇒ 负控不会静默缺席。
    **行为腿**（红项自带出路）依赖 _leg_store，留在 full 主体；quick 用「拒收文案
    带出路」的行为腿代其覆盖。本函数必须由 cmd_selftest 调用——机制覆盖闸
    （mechanism_coverage_violations）按调用闭包判实扫面。
    """
    if quick:
        _q_src = Path(__file__).read_text(encoding="utf-8")
        _q_pkg = Path(__file__).resolve().parent.parent
        _q_ek = exit_key_violations(_q_src)
        _q_cf = check_fix_violations(_q_src)
        _q_fc = fact_copy_violations(_q_pkg, _q_src)
        expect("quick·出路键闸：每个站点的出路显式声明、键在表里、表里没有死行",
               not _q_ek, "；".join(_q_ek[:4]))
        expect("quick·读面出路闸：每个红项都经 E(处境键,…) 拼装、都带下一步",
               not _q_cf, "；".join(_q_cf[:4]))
        expect("quick·事实存在性闸：事实的渲染形态只出现在原件与引用处",
               not _q_fc, "；".join(_q_fc[:4]))
        return
    # ---- v5.46.0：出路键**显式化**（H3 结构性根因）----
    # 旧形：出路按消息里的**处境词子串**匹配 ⇒ 泛化键（如「未找到」）会吃掉**将来**的新消息
    # ⇒ 用户拿到**指错路**的修法，而出路律（判「用户看到的那段话」）**判不出这条路对不对**。
    # ⇒ 新形：出路由**站点显式声明**（`die(msg, key="…")`）⇒ 声明错＝当场可见、可审。
    _src_k = Path(__file__).read_text(encoding="utf-8")
    _ek = exit_key_violations(_src_k)
    expect("v5.46.0 出路键闸：每个站点的出路**显式声明**、键在表里、表里没有死行",
           not _ek, "；".join(_ek[:4]))
    # 负控①：声明一个不存在的键 ⇒ 红（写错键 ⇒ 用户拿到错路）
    _ek1 = exit_key_violations(_src_k.replace('key="未找到"', 'key="no-such-key"', 1))
    expect("v5.46.0 出路键闸·负控①：声明的键不在表里 ⇒ 当场红",
           any("不在出路表里" in x for x in _ek1), f"违例 {_ek1[:2]}")
    # 负控②：把声明删掉（消息里仍含那个键）⇒ 红（隐式匹配的老毛病不许复活）
    _ek2 = exit_key_violations(_src_k.replace(', key="未找到"', "", 1))
    expect("v5.46.0 出路键闸·负控②：消息里含键却没显式声明 ⇒ 当场红（不许隐式匹配复活）",
           any("没显式声明" in x for x in _ek2), f"违例 {_ek2[:2]}")
    # 负控③：表里多一行没人声明 ⇒ 红（死行＝没人走的那条路）
    _real_fx = DIE_FIXES
    try:
        globals()["DIE_FIXES"] = {**_real_fx, "no-such-row": "修：`handoff check`"}
        _ek3 = exit_key_violations(_src_k)
    finally:
        globals()["DIE_FIXES"] = _real_fx
    expect("v5.46.0 出路键闸·负控③：表里多一行没人声明 ⇒ 当场红",
           any("死行" in x for x in _ek3), f"违例 {_ek3[:2]}")

    # ---- v5.47.0：读面出路闸（唯一源＝`check_fix_violations`）----
    # t000443：写面早就有出路表＋五形闸＋命令真实性闸，**读面没有** ⇒ 56 个红项站点里
    # 38 个一个字的下一步都没有 ⇒ 用户撞上红项仍得自己想。现在两面同一把尺。
    _src_cf = Path(__file__).read_text(encoding="utf-8")
    _cf = check_fix_violations(_src_cf)
    expect("v5.47.0 读面出路闸：每个红项都经 `E(处境键,…)` 拼装、都带当场可执行的下一步",
           not _cf, "；".join(_cf[:4]))
    # 负控①：把一个站点的 `E(...)` 包装摘掉 ⇒ 红（漏声明＝红项没有出路）
    _cf1 = check_fix_violations(
        _src_cf.replace('errs.append(E("缺槽", f"缺槽: {s}"))',
                         'errs.append(f"缺槽: {s}")', 1))
    expect("v5.47.0 读面出路闸·负控①：红项漏了 `E(…)` 拼装 ⇒ 当场红",
           any("没有经" in x for x in _cf1), f"违例 {_cf1[:2]}")
    # 负控②：声明的键不在表里 ⇒ 红（写错键 ⇒ 用户拿到错路）
    _cf2 = check_fix_violations(
        _src_cf.replace('E("缺槽", f"缺槽: {s}")',
                         'E("no-such-key", f"缺槽: {s}")', 1))
    expect("v5.47.0 读面出路闸·负控②：出路键不在表里 ⇒ 当场红",
           any("不在读面出路表里" in x for x in _cf2), f"违例 {_cf2[:2]}")
    _real_cf = CHECK_FIXES
    try:
        # 负控③：表里多一行没人声明 ⇒ 红（死行＝没人走的那条路）
        globals()["CHECK_FIXES"] = {**_real_cf, "no-such-row": "修：`handoff check`"}
        _cf3 = check_fix_violations(_src_cf)
    finally:
        globals()["CHECK_FIXES"] = _real_cf
    expect("v5.47.0 读面出路闸·负控③：表里多一行没人声明 ⇒ 当场红（死行）",
           any("死行" in x for x in _cf3), f"违例 {_cf3[:2]}")
    try:
        # 负控④：一条出路不成形（只有诊断、没有下一步）⇒ 红
        globals()["CHECK_FIXES"] = {**_real_cf, "缺槽": "缺槽: 坏了"}
        _cf4 = check_fix_violations(_src_cf)
    finally:
        globals()["CHECK_FIXES"] = _real_cf
    expect("v5.47.0 读面出路闸·负控④：出路不成形（只有诊断没有下一步）⇒ 当场红",
           any("不成形" in x for x in _cf4), f"违例 {_cf4[:2]}")
    try:
        # 负控⑤：出路里点名不存在的命令 ⇒ 红（照抄跑不了）
        globals()["CHECK_FIXES"] = {**_real_cf, "缺槽": "修：`handoff nosuchcmd --x`"}
        _cf5 = check_fix_violations(_src_cf)
    finally:
        globals()["CHECK_FIXES"] = _real_cf
    expect("v5.47.0 读面出路闸·负控⑤：出路点名不存在的命令 ⇒ 当场红",
           any("不在 CLI 子命令表内" in x for x in _cf5), f"违例 {_cf5[:2]}")
    try:
        # 变异自证：把一条**真出路**里的命令名改错 ⇒ 闸当场点名（腿有牙）
        globals()["CHECK_FIXES"] = {**_real_cf,
                                    "缺槽": _real_cf["缺槽"].replace("handoff init", "handoff initx", 1)}
        _cf6 = check_fix_violations(_src_cf)
    finally:
        globals()["CHECK_FIXES"] = _real_cf
    expect("v5.47.0 读面出路闸·变异自证：把真出路里的命令名改错 ⇒ 闸当场点名（腿有牙）",
           any("不在 CLI 子命令表内" in x for x in _cf6), f"违例 {_cf6[:2]}")
    # ---- v5.48.0：事实**存在性闸**（唯一源＝`fact_copy_violations`）----
    # v5.43.0 的机制是「一致性闸」（渲染区与代码派生值逐字比对）⇒ 它管「已登记的那一处
    # 有没有漂」，不管「这类事实还有没有第二份」⇒ 实测 22 处手抄的抄件闸外自由生长。
    # 本闸把判断从「一致」升到「**存在**」：渲染形态只许出现在原件、引用处与形态表自身。
    _pkg_root_fc = Path(__file__).resolve().parent.parent
    _src_fc = Path(__file__).read_text(encoding="utf-8")
    _fc = fact_copy_violations(_pkg_root_fc, _src_fc)
    expect("v5.48.0 事实存在性闸：事实的渲染形态只出现在原件与引用处（没有第二份）",
           not _fc, "；".join(_fc[:4]))
    # 负控①：文档散文里塞一份手抄事实 ⇒ 红
    _fc1 = _fact_copy_in_text("这一句说库里有 9 槽，还带一条 id 形如 <t|p|d|c|u><6 位>。",
                              "探针.md")
    expect("v5.48.0 事实存在性闸·负控①：散文里手抄事实 ⇒ 当场红",
           len(_fc1) >= 2 and "抄件" in _fc1[0], f"违例 {_fc1[:2]}")
    # 负控②：代码字面量里塞一份手抄事实 ⇒ 红
    _fc2 = _fact_copy_in_code('X = "闭集＝owner｜user｜external:<描述>"\n')
    expect("v5.48.0 事实存在性闸·负控②：代码文案里手抄事实 ⇒ 当场红",
           len(_fc2) == 1 and "抄件" in _fc2[0], f"违例 {_fc2[:2]}")
    # 负控③：形态表**自身**（原件）不被判红（否则闸恒红、自己打自己）
    _fc3 = _fact_copy_in_code(_src_fc)
    expect("v5.48.0 事实存在性闸·负控③：形态表自身（原件）不被判红",
           not _fc3, "；".join(_fc3[:2]))
    # 变异自证：把真代码里的一处插值改回手抄 ⇒ 闸当场点名（腿有牙）
    _fc4 = _fact_copy_in_code(
        _src_fc.replace("f\"{loc}: 非法 id {i!r}（应 {ID_FORM}）\"",
                         "f\"{loc}: 非法 id {i!r}（应 <t|p|d|c|u><6 位>）\"", 1))
    expect("v5.48.0 事实存在性闸·变异自证：把真插值改回手抄 ⇒ 闸当场点名（腿有牙）",
           any("抄件" in x for x in _fc4), f"违例 {_fc4[:2]}")

    # ---- v5.51.0（C 批 N1）：**注释面**进闸 ＋ 匹配器形态（Q4）＋ 豁免双向对账 ----
    # 这一批治的是 v5.48.0 当代那处**假称**（docstring 说扫注释，实现只扫 AST 字符串）：
    #   ① 匹配器换 Q4 形态（结构化数字＋单位 munch 闭集＋符号类边界）⇒ 子串假阳消解；
    #   ② 注释面用 `tokenize` **真扫**（AST 里没有注释节点 ⇒ 必须单独扫）；
    #   ③ 注释里**讲历史**的那几处（引的是漂移前的旧值）⇒ 逐条豁免（带死因与死期），
    #      豁免表与实算**双向对账**（多出来／过期都红）。
    # 顺序约束（独立席 Q3①）：**匹配器不先修，注释面不许进闸**——否则字节估算那处假阳立刻爆红。
    # 负控①：注释里塞一份现态事实形态 ⇒ 当场红（注释面真被扫到了）
    _fc5 = _fact_copy_in_comments("# 库里有 9 槽，还带一条 id 形如 <t|p|d|c|u><6 位>。\n")
    expect("v5.51.0 注释面闸·负控①：注释里手抄事实 ⇒ 当场红（注释面真被扫到了）",
           len(_fc5) >= 2 and all("注释" in x for x in _fc5), f"违例 {_fc5[:2]}")
    # 负控②：**讲历史**的那几处豁免 ⇒ 不算抄件（豁免口径生效）
    _fc6 = _fact_copy_in_comments("# 讲 v5.47.0 那次旧值引文：判据文本里的 t/p/q/u …\n")
    expect("v5.51.0 注释面闸·负控②：讲历史的那处有豁免 ⇒ 不算抄件（豁免口径生效）",
           not _fc6, f"违例 {_fc6[:2]}")
    # 正控③：注释面实算与豁免表**双向对得上**（多出来／过期都红）
    _fce = fact_comment_exempt_violations(_src_fc)
    expect("v5.51.0 注释面豁免表：与实算**双向对得上**（无新增抄件、无过期豁免）",
           not _fce, "；".join(_fce[:4]))
    # 负控④：豁免表里多一条（指向不存在的锚）⇒ 过期 ⇒ 红
    _real_fce = FACT_COMMENT_EXEMPT
    try:
        globals()["FACT_COMMENT_EXEMPT"] = [*_real_fce, {
            "form": "9 槽", "anchor": "此处并无此锚",
            "why": "内控", "dead": "内控", "dead_when": "gone"}]
        _fce2 = fact_comment_exempt_violations(_src_fc)
    finally:
        globals()["FACT_COMMENT_EXEMPT"] = _real_fce
    expect("v5.51.0 注释面豁免表·负控④：豁免指向不存在的锚 ⇒ **已过期**当场红",
           any("已过期" in x for x in _fce2), f"违例 {_fce2[:2]}")
    # 负控⑤：豁免表少一条（真命中被抹掉登记）⇒ 多出来 ⇒ 红
    try:
        globals()["FACT_COMMENT_EXEMPT"] = [
            e for e in _real_fce if str(e.get("anchor")) != "判据文本里的"]
        _fce3 = fact_comment_exempt_violations(_src_fc)
    finally:
        globals()["FACT_COMMENT_EXEMPT"] = _real_fce
    expect("v5.51.0 注释面豁免表·负控⑤：真命中没登记豁免 ⇒ 「多出来」当场红",
           any("不在豁免表里" in x for x in _fce3), f"违例 {_fce3[:2]}")
    # 负控⑥：`dead_when` 取值不在闭集里 ⇒ 红（豁免的到期条件必须是可判的）
    try:
        globals()["FACT_COMMENT_EXEMPT"] = [
            {**e, "dead_when": "whatever"} if i == 0 else e
            for i, e in enumerate(_real_fce)]
        _fce4 = fact_comment_exempt_violations(_src_fc)
    finally:
        globals()["FACT_COMMENT_EXEMPT"] = _real_fce
    expect("v5.51.0 注释面豁免表·负控⑥：`dead_when` 不在闭集里 ⇒ 当场红"
           "（豁免的到期条件必须可判）",
           any("不在闭集里" in x for x in _fce4), f"违例 {_fce4[:2]}")
    # Q4 形态：子串假阳**三处**必须消解（数不同／单位不同／位数不同）
    _fp = _fact_form_at("一行放多少个 id（每 id ≈10 字节 ⇒ ≈400 字节/行，热层槽 8192 内安全）", "400 字")
    expect("v5.51.0 匹配器（Q4 形态）：**单位不同**不命中（字节估算 ⊃ 字那条形态）",
           _fp < 0, f"下标 {_fp}")
    _fp2 = _fact_form_at("库里有 19 槽", "9 槽")
    expect("v5.51.0 匹配器（Q4 形态）：**数不同**不命中", _fp2 < 0, f"下标 {_fp2}")
    _fp3 = _fact_form_at("上界 1120 字", "120 字")
    expect("v5.51.0 匹配器（Q4 形态）：**位数不同**不命中", _fp3 < 0, f"下标 {_fp3}")
    # Q4 形态：真命中**仍要命中**（形态不是「碰巧是子串」）
    expect("v5.51.0 匹配器（Q4 形态）：真形态仍命中（结构化比较不漏）",
           _fact_form_at("库里有 9 槽", "9 槽") >= 0
           and _fact_form_at("outcome ≤400 字", "400 字") >= 0
           and _fact_form_at("id 形如 <t|p|d|c|u><6 位>", "<t|p|d|c|u><6 位>") >= 0, "")
    # 边界：形态前紧邻字母数字 ⇒ 截胡 ⇒ 不命中
    expect("v5.51.0 匹配器（Q4 形态）：形态前粘着字母数字 ⇒ **截胡不命中**",
           _fact_form_at("xt|p|d|c|q", "t|p|d|c|q") < 0, "")
    # 边界：**汉字**不算字母数字（`str.isalnum()` 对汉字为真 ⇒ 中文引用会被误杀）
    expect("v5.51.0 匹配器（Q4 形态）：形态前紧邻**汉字**⇒ 仍命中（`isalnum` 的汉字坑）",
           _fact_form_at("id 形如 <t|p|d|c|u><6 位>", "<t|p|d|c|u><6 位>") >= 0, "")

    # ---- v5.55.0（t000458）：形态表**不存派生值**——派生事实的形态改「引用声明」----
    # 病：形态表是**登记处**（原件在这里不算抄件），但登记处里存着派生事实的**现值抄件**
    #   ⇒ 产生源一改、表就漂 ⇒ 形态表自己成了第二个漂移源。
    # 治法：表里只写**引用声明**（指向唯一源），现值在**解析期实算**（表仍是数据）。
    # 正控①：引用声明解析出的现值＝产生源的实算值（不是表里写死的那份）
    _ref_live = _fact_form("@slot_count")
    expect("v5.55.0 形态表不存派生值·正控①：引用声明解析出的现值＝产生源的实算值",
           _ref_live == f"{_slot_count()} 槽", f"解析得 {_ref_live!r}")
    # 正控②：形态表里**没有**任何派生源的现值（表里只有引用声明）
    _live_forms = {fn() for fn in FACT_REF_SOURCES.values()}
    _copied = [fm for _f, fm in FACT_VARIANTS if fm in _live_forms]
    expect("v5.55.0 形态表不存派生值·正控②：表里只有引用声明，没有现值抄件",
           not _copied, f"表里存了现值 {_copied}")
    # 变异自证：把引用声明换成现值（回到旧形态）⇒ 事实存在性闸当场红（闸有牙）
    _real_fv = FACT_VARIANTS
    try:
        globals()["FACT_VARIANTS"] = [
            (_f, (_fact_form(_fm) if _fm in FACT_REF_SOURCES else _fm)) for _f, _fm in _real_fv]
        _fcv = fact_copy_violations(_pkg_root_fc, _src_fc)
    finally:
        globals()["FACT_VARIANTS"] = _real_fv
    expect("v5.55.0 形态表不存派生值·变异自证：把引用声明换成现值 ⇒ 当场红",
           any("只能放引用声明" in x for x in _fcv), f"违例 {_fcv[:2]}")


def _selftest_shim(expect) -> None:
    """v5.73.1：resolver shim 的行为腿（quick/full 共用；唯一源）。

    在假树里放几种「脚本」——各自打印标记、退不同退出码——断言解析顺序：
    ① editable（安装来源在 cwd 祖先树内）② 最近项目副本 ③ 用户级 ④ 锚点 ⑤ 报错。
    另有一条**变异自证**：把内容生成器换回固定路径写法 ⇒ 项目解析腿必须失效（腿有牙）。
    """
    _bash = shutil.which("bash")
    if not _bash:
        print("  · shim 腿跳过：本机无 bash（shim 是 bash 脚本；本仓 smoke 同样要求 bash）")
        return
    import subprocess as _sp
    with tempfile.TemporaryDirectory(prefix="handoff-shim-") as _td:
        td = Path(_td)
        home = td / "home"

        def _fake(p: Path, tag: str, code: int) -> None:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(f"import sys; print({tag!r}); sys.exit({code})\n", encoding="utf-8")

        repo = td / "repo"
        anchor = repo / "project-handoff" / "scripts" / "handoff.py"
        _fake(anchor, "ANCHOR", 8)
        # editable 腿：锚点自己项目树内**也**放一份自装副本 ⇒ 锚点仍须优先
        _fake(repo / ".agents/skills/project-handoff/scripts/handoff.py", "SELF", 9)
        proj = td / "proj"
        _fake(proj / ".agents/skills/project-handoff/scripts/handoff.py", "PROJECT", 7)
        _fake(home / ".agents/skills/project-handoff/scripts/handoff.py", "USER", 6)
        shim = td / "bin" / "handoff"
        shim.parent.mkdir(parents=True, exist_ok=True)
        shim.write_text(_shim_script(anchor), encoding="utf-8")
        for _d in (repo / "sub", proj / "sub", td / "nowhere", td / "emptyhome"):
            _d.mkdir(parents=True, exist_ok=True)

        def _run(cwd: Path, home_dir: Path = home) -> tuple[int, str]:
            r = _sp.run([_bash, str(shim)], cwd=str(cwd), capture_output=True, text=True,
                        env={**os.environ, "HOME": str(home_dir)})
            return r.returncode, r.stdout + r.stderr

        rc, out = _run(proj / "sub")
        expect("v5.73.1 shim·项目解析：cwd 向上最近的 .agents/skills 副本被选用（版本跟项目）",
               rc == 7 and "PROJECT" in out, f"rc={rc} out={out[-120:]!r}")
        rc, out = _run(repo / "sub")
        expect("v5.73.1 shim·editable：安装来源在它自己的项目树内 ⇒ 锚点优先于自装副本",
               rc == 8 and "ANCHOR" in out, f"rc={rc} out={out[-120:]!r}")
        # 消费者布局：锚点＝某项目的自装副本 ⇒ 项目根须跨过 /.agents/skills 反推，
        # 否则同一 $HOME/父目录下的**其它项目**会被锚点吞掉（第一版实测踩过）。
        proj_a = td / "projA"
        anchor_a = proj_a / ".agents/skills/project-handoff/scripts/handoff.py"
        _fake(anchor_a, "ANCHOR2", 5)
        shim_a = td / "bin" / "handoff-a"
        shim_a.write_text(_shim_script(anchor_a), encoding="utf-8")
        (proj_a / "sub").mkdir(parents=True, exist_ok=True)

        def _run_a(cwd: Path) -> tuple[int, str]:
            r = _sp.run([_bash, str(shim_a)], cwd=str(cwd), capture_output=True, text=True,
                        env={**os.environ, "HOME": str(home)})
            return r.returncode, r.stdout + r.stderr

        rc_a, out_a = _run_a(proj_a / "sub")
        rc_b, out_b = _run_a(proj / "sub")
        expect("v5.73.1 shim·消费者锚点：本仓用锚点、同父目录下别的项目仍用各自副本",
               rc_a == 5 and "ANCHOR2" in out_a and rc_b == 7 and "PROJECT" in out_b,
               f"A rc={rc_a} out={out_a[-80:]!r} B rc={rc_b} out={out_b[-80:]!r}")
        rc, out = _run(td / "nowhere")
        expect("v5.73.1 shim·用户级：不在任何项目内 ⇒ 用 $HOME/.agents/skills 副本",
               rc == 6 and "USER" in out, f"rc={rc} out={out[-120:]!r}")
        rc, out = _run(td / "nowhere", td / "emptyhome")
        expect("v5.73.1 shim·锚点回退：项目与用户级都没有 ⇒ 用安装来源",
               rc == 8 and "ANCHOR" in out, f"rc={rc} out={out[-120:]!r}")

        missing = td / "bin" / "handoff-missing"
        missing.write_text(_shim_script(td / "gone" / "handoff.py"), encoding="utf-8")
        r = _sp.run([_bash, str(missing)], cwd=str(td / "nowhere"), capture_output=True,
                    text=True, env={**os.environ, "HOME": str(td / "emptyhome")})
        expect("v5.73.1 shim·无可用副本 ⇒ 报错退 127 并给出可执行修法",
               r.returncode == 127 and "找不到" in (r.stdout + r.stderr),
               f"rc={r.returncode} out={(r.stdout + r.stderr)[-120:]!r}")

        _real_fn = globals().get("_shim_script")
        try:
            globals()["_shim_script"] = lambda p: (
                '#!/usr/bin/env bash\nexec python3 "' + p.as_posix() + '" "$@"\n')
            shim.write_text(_shim_script(anchor), encoding="utf-8")
            _mrc, _mout = _run(proj / "sub")
        finally:
            globals()["_shim_script"] = _real_fn
            shim.write_text(_shim_script(anchor), encoding="utf-8")
        expect("v5.73.1 shim·变异自证：换回固定路径写法 ⇒ 项目副本不再被解析（腿有牙）",
               _mrc == 8 and "PROJECT" not in _mout, f"rc={_mrc} out={_mout[-120:]!r}")


def cmd_selftest(st: Store, a) -> int:
    """双向夹具（t000138）：闭集守卫的判据全部落在**退出码＋落盘行**上，不留给现场抉择。

    在临时 store 里跑真 CLI（main 递归、--store 指向 tmp），七步覆盖：
    edit/add 对 closed 及表外值的拒收（负向）、pitfall fixed 与 blocked 的放行（正向）、
    脏行混入后 refill 出池＋check FAIL（机检兜底）、close 两步修复后 check 复绿。
    """
    import tempfile
    import contextlib as _contextlib
    fails: list[str] = []
    os.environ["HANDOFF_SELFTEST_SUB"] = "1"   # 递归 main 不回封临时 store（夹具要手工写文件）

    cur_store = [""]          # run() 的目标 store（--store 须置于子命令前，全局 flag）

    def pending_covers() -> list[str]:
        """当前库里「自上一班以来新增」而必须被声明的 `t` 型条目（**写入面同口径**）。

        v5.31.0 壬-2：写 `exit` 班段时，作者要用 `--covers` **声明**本段覆盖的条目；
        写入面（`_guard_covers`）会当场拒「有新增却没声明」的班段 ⇒ 夹具里凡写 exit
        的地方都必须带上声明，否则整条旧腿都会变成「写入被拒 ⇒ 断言失败」的假失败。

        这个辅助让夹具扮演一个**守纪律的作者**：默认自动补齐声明（`covers="auto"`）；
        要测「缺声明 ⇒ 写入即拒」的腿显式传 `covers=False`（完全不带 flag），
        要测「声明不全 ⇒ 拒」的腿传 `covers=[...]`（只带一部分）。
        """
        try:
            return _pending_cover_ids(Store(Path(cur_store[0])))
        except OSError:
            return []

    def run(*argv, inp=None, covers="auto"):
        argv = list(argv)
        # v5.31.0 壬-2：写 exit 班段要带 `--covers`（见 `pending_covers`）。
        # 只对 `set/append exit` 注入；`summary`/`status` 不是班段，不需要声明。
        if (covers is not False and len(argv) >= 2 and argv[0] in ("set", "append")
                and argv[1] == "exit" and "--covers" not in argv):
            _ids = list(covers) if covers != "auto" else pending_covers()
            if _ids:
                argv = argv + ["--covers", ",".join(_ids)]
        buf = io.StringIO()
        err = io.StringIO()
        so, se, sin = sys.stdout, sys.stderr, sys.stdin
        rc = 0
        sys.stdout, sys.stderr = buf, err
        if inp is not None:
            sys.stdin = io.StringIO(inp)
        try:
            rc = main(["--store", cur_store[0], *argv]) or 0
        except SystemExit as e:
            rc = e.code if isinstance(e.code, int) else 1
        finally:
            sys.stdout, sys.stderr, sys.stdin = so, se, sin
        return rc, buf.getvalue() + err.getvalue()

    def rows(slot: str) -> list[dict]:
        return [r for r in Store(Path(cur_store[0])).load_live() if r.get("_slot") == slot]

    def non_tamper(out: str) -> str:
        """剔除写事件对账的行。

        为什么需要：本夹具**自己**就是靠手工写文件注入坏行来造脏件的（不这样造就没有
        「脏行」可测），而那**正是**「未经 CLI 记录的写入」——新判据理应报它。所以
        「修好了吗」不能问 `rc==0`，只能问「除那条已知的 tamper 外没有别的问题」。
        """
        keep = []
        _in_guid = False
        for l in (out or "").splitlines():
            if l.startswith("handoff check:"):        # 汇总行也要剔，否则它让 strip() 非空
                continue
            if l.strip() == "## 现在该做什么":      # v5.33.0 出路律的指引节：**不是问题**
                _in_guid = True                      # ⇒ 「除已知 tamper 外无其它问题」这类
                continue                             #   断言不该被它撑成非空
            if _in_guid:
                if l.startswith("- "):               # 指引节的条目行（错误行是「  - 」缩进两级）
                    continue
                _in_guid = False
            if any(k in l for k in ("未经 CLI 记录的写入", "写入**之前**发现",
                                    "补手续疑似", "写事件记录过它", "mtime 更新")):
                continue
            keep.append(l)
        return "\n".join(keep)

    _leg_dims: dict[str, list[str]] = {}   # 判据维 → 本次真跑过的腿（运行时那一份）

    def expect(name: str, cond: bool, detail: str = "", dim: str | None = None):
        """一条腿。`dim=` ＝**这条腿证明哪一维**（落点登记的腿列由它派生 ⇒ 不抄第二份）。

        为什么要这个标注：纪律的落地靠「往散文里加一行」⇒ 抄件会漂移 ⇒ 纪律被违反时静默。
        ⇒ 每条纪律都必须指认一条**行为型**腿；标注就是那条指认，且它是**代码里的一行**，
        删腿、改名、改维都会当场被对账闸抓住（不靠人记得）。
        """
        print(f"  {'ok' if cond else 'FAIL'}  {name}" + (f"（{detail}）" if detail and not cond else ""))
        if not cond:
            fails.append(name)
        if dim:
            _leg_dims.setdefault(dim, []).append(name)

    def finish() -> int:
        if fails:
            print(f"handoff selftest: FAIL（{len(fails)} 项：{', '.join(fails)}）")
            return 1
        print("handoff selftest: PASS")
        return 0

    if getattr(a, "quick", False):
        # quick 档（2026-10-28）：核心命令闭环 ＋ 静态机制闸；full 仍是权威。
        # 全库门禁每轮跑本档，源指纹变化时自动升级跑 full（见 skill-smoke.sh 的戳）。
        # 只允许依赖本点之前定义的东西：mk_runner/_leg_store/_ff_load 等在后面才定义。
        with tempfile.TemporaryDirectory(prefix="handoff-selftest-quick-") as _qt:
            cur_store[0] = str(Path(_qt) / "h")
            rc, out = run("init")
            expect("quick·init 退出 0", rc == 0, out[-160:])
            rc, out = run("add", "action", "--summary", "quick 条目一")
            _qtid = next(iter(re.findall(r"id=(t\d+)", out)), "")
            expect("quick·add action 正控", rc == 0 and bool(_qtid), out[-160:])
            rc, out = run("add", "action", "--summary", "quick 条目二", "--status", "done")
            expect("quick·add action --status done 负控拒收", rc != 0, out[-160:])
            rc, out = run("add", "pitfall", "--summary", "quick 坑", "--status", "fixed")
            _qpid = next(iter(re.findall(r"id=(p\d+)", out)), "")
            expect("quick·add pitfall --status fixed 放行", rc == 0 and bool(_qpid), out[-160:])
            rc, out = run("edit", _qtid, "--status", "closed")
            expect("quick·edit --status closed 拒收且给出 close 出路",
                   rc != 0 and "close --outcome" in out, out[-160:])
            rc, out = run("edit", _qtid, "--status", "blocked")
            expect("quick·edit --status blocked 放行", rc == 0, out[-160:])
            rc, out = run("close", "t999999", "--outcome", "不存在")
            expect("quick·close 不存在的 id 拒收（两阶段前置）", rc != 0, out[-160:])
            rc, out = run("close", _qtid, "--outcome", "已完成")
            _ct = Path(cur_store[0]) / "closed" / "t.jsonl"
            _ct_ids = [json.loads(l)["id"] for l in _ct.read_text(encoding="utf-8").splitlines()
                       if l.strip()] if _ct.is_file() else []
            expect("quick·close --outcome 放行且落 closed/t.jsonl",
                   rc == 0 and _qtid in _ct_ids, out[-160:])
            rc, out = run("resolve", _qpid)
            expect("quick·resolve 缺 --outcome 拒收", rc != 0 and "--outcome" in out, out[-160:])
            rc, out = run("resolve", _qpid, "--outcome", "已消解")
            _cp = Path(cur_store[0]) / "closed" / "p.jsonl"
            _cp_ids = [json.loads(l)["id"] for l in _cp.read_text(encoding="utf-8").splitlines()
                       if l.strip()] if _cp.is_file() else []
            expect("quick·resolve 成功：坑移出 live、进 closed/p.jsonl",
                   rc == 0 and _qpid in _cp_ids, out[-160:])
            rc, out = run("resolve", _qpid, "--outcome", "再来一次")
            expect("quick·resolve 重复消解拒收", rc != 0, out[-160:])
            rc, out = run("add", "action", "--summary", "不是坑")
            _qt2 = next(iter(re.findall(r"id=(t\d+)", out)), "")
            rc, out = run("resolve", _qt2, "--outcome", "错型")
            expect("quick·resolve 非 p 型拒收并指向 close",
                   rc != 0 and "只消解坑" in out and "handoff close" in out, out[-160:])
            rc, out = run("add", "action", "--from-file", "-", inp="summary=从文件条目\n")
            expect("quick·--from-file 落盘", rc == 0 and "从文件条目" in out, out[-160:])
            rc, out = run("set", "exit", "--file", "-", inp="## 旧标题\n正文第一行\n")
            expect("quick·写 exit 班段（覆盖 pending）", rc == 0, out[-160:])
            rc, out = run("check", "--no-log")
            expect("quick·班段覆盖后 check 绿", rc == 0, out[-200:])
            rc, out = run("compact-writes", "--keep", "0")
            expect("quick·compact-writes --keep 0 退出 0", rc == 0, out[-160:])
            rc, out = run("check", "--no-log")
            expect("quick·收窗后 check 仍绿（判定不变）", rc == 0, out[-200:])
            _ct_ids2 = [json.loads(l)["id"] for l in _ct.read_text(encoding="utf-8").splitlines()
                        if l.strip()] if _ct.is_file() else []
            expect("quick·收窗后已结条目未丢", _qtid in _ct_ids2, f"closed={_ct_ids2[-4:]}")
            rc, out = run("retitle", "exit", "--at", "1", "--title", "新标题")
            _exit_text = (Path(cur_store[0]) / "exit").read_text(encoding="utf-8")
            expect("quick·retitle 只改标题行",
                   rc == 0 and _exit_text.startswith("## 新标题") and "正文第一行" in _exit_text,
                   out[-160:])
            rc, out = run("check", "--no-log")
            expect("quick·闭环后 check 绿", rc == 0, out[-200:])
        _selftest_shim(expect)
        _selftest_static_mechanism_gates(expect, quick=True)
        return finish()

    def make_legacy_shift() -> None:
        """把**最近**一条班次记录改回「v5.31.0 之前」的形状（**没有** `covers` 字段）。

        v5.31.0 壬-2 的兼容腿要用它：**老班段**（声明机制之前写的）⇒ 判据退回**旧口径**
        （扫散文）⇒ 迁移不误伤。班次台账是 append-only 的事实文件，这里手改它**就是**
        「模拟一个 v5.31.0 之前写的库」——代价：写事件对账维会报「未经 CLI 记录的写入」
        ⇒ 这类腿一律用 `non_tamper()` 过滤（只断言 fresh-queue 维的结论）。
        """
        p = Path(cur_store[0]) / SHIFTS_FILE
        recs = read_jsonl(p)
        if not recs:
            return
        recs[-1].pop("covers", None)
        recs[-1].pop("refs", None)      # v5.45.0：refs 化 ⇒ 老班段＝两个字段都没有
        p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in recs) + "\n",
                     encoding="utf-8")

    # p000112：集合题切分必须认中文顿号；两种解释取其一命中即过，且不得切坏带空格路径。
    _nl, _ws = split_set_answer("t1、t2，t3")
    expect("confirm 集合切分认中文顿号", _nl == {"t1", "t2", "t3"} == _ws)
    _nl2, _ = split_set_answer("docs/a b.md，docs/c.md")
    expect("confirm 集合切分保留路径空格（换行/逗号解释）",
           _nl2 == {"docs/a b.md", "docs/c.md"})
    _, _ws3 = split_set_answer("t1 t2")
    expect("confirm 集合切分空白解释仍可用（id 列表）", _ws3 == {"t1", "t2"})

    with tempfile.TemporaryDirectory(prefix="handoff-selftest-") as tmp:
        cur_store[0] = str(Path(tmp) / "h")
        run("init")
        rc, _ = run("add", "action", "--summary", "s1")
        expect("add action 退出 0", rc == 0)
        aid = rows("actions")[0]["id"] if rows("actions") else ""
        rc, out = run("edit", aid, "--status", "closed")
        expect("edit --status closed 拒收", rc != 0 and "close --outcome" in out)
        rc, _ = run("edit", aid, "--status", "blocked")
        expect("edit --status blocked 放行", rc == 0 and rows("actions")[0].get("status") == "blocked")
        rc, _ = run("add", "pitfall", "--summary", "p1", "--status", "fixed")
        expect("add pitfall --status fixed 放行", rc == 0)
        rc, _ = run("add", "action", "--summary", "s2", "--status", "done")
        expect("add action --status done 拒收", rc != 0)

        # ── 自迁移回归（p000135）────────────────────────────────────────────
        # 旧实现对 `edit <id> --domain <同分区>` 先 append 到目标文件、再把同一个文件
        # 整表覆写（或直接 unlink）⇒ 条目被自己抹掉，rc=0、`check` 仍 OK，且该 id 不记
        # void ⇒ 下次 add 发出同一个号。两个破坏模式（源文件有他条／仅此条）与 id 复用
        # 三条腿都钉在这儿：守卫被去掉，下面每条都会红。
        rc, out = run("add", "pitfall", "--summary", "自迁移一号")
        sm = (re.search(r"id=(p\d+)", out) or [None, ""])[1]
        rc, _ = run("edit", sm, "--domain", "smtest")           # 跨分区（真搬移）：应成功
        expect("自迁移·前置跨分区搬移成功",
               rc == 0 and any(r["id"] == sm for r in rows("pitfalls")))
        smfile = Path(cur_store[0]) / "pitfalls" / "smtest.jsonl"
        expect("自迁移·前置分区文件已建", smfile.exists())

        # 模式 B：源文件仅此条 ⇒ 旧实现 append 后 unlink，整个分区文件被删
        rc, out = run("edit", sm, "--domain", "smtest")          # 自迁移·只给 --domain
        expect("自迁移·只给 --domain 硬报错（非静默无操作）",
               rc != 0 and "无操作可做" in out, out[-160:])
        expect("自迁移·报错后条目仍在（模式 B 不丢）",
               any(r["id"] == sm for r in rows("pitfalls")))
        expect("自迁移·报错后分区文件仍在", smfile.exists())

        # 模式 A：源文件有他条 ⇒ 旧实现 append 后整表覆写，目标条丢、他条留
        rc, out = run("add", "pitfall", "--summary", "同分区他条")
        other = (re.search(r"id=(p\d+)", out) or [None, ""])[1]
        rc, _ = run("edit", other, "--domain", "smtest")
        expect("自迁移·他条已就位（模式 A 前置）",
               rc == 0 and any(r["id"] == other for r in rows("pitfalls")))
        rc, out = run("edit", sm, "--domain", "smtest", "--summary", "自迁移改过")
        expect("自迁移·带其它字段放行并就地更新",
               rc == 0 and any(r["id"] == sm and r["summary"] == "自迁移改过"
                               for r in rows("pitfalls")), out[-160:])
        expect("自迁移·他条未受影响（模式 A 不误伤）",
               any(r["id"] == other for r in rows("pitfalls")))
        expect("自迁移·回读有成功信息",
               rc == 0 and "无搬移效果" in out, out[-160:])

        # id 复用：条目丢了却不记 void ⇒ 下一个 add 会拿到同一个号
        rc, out = run("add", "pitfall", "--summary", "自迁移二号")
        nid = (re.search(r"id=(p\d+)", out) or [None, ""])[1]
        expect("自迁移·id 未被复用", rc == 0 and nid not in ("", sm, other), f"新条目 {nid}")
        # 三条 id 各在一次、且内容如预期（本段不查 check：此刻 store 里还有本夹具更早建的
        # 未回写 exit 的 open 条目，fresh-queue 本就该红；整库健康由夹具尾部那条断言管）
        live = [r["id"] for r in rows("pitfalls")]
        expect("自迁移·三条 id 各在一次（无丢失、无重复）",
               all(live.count(i) == 1 for i in (sm, other, nid)) and len(set(live)) == len(live),
               f"live={live}")

        # echo_back 的 strict 档（p000135 第二道）：写命令的回读是它的自证，回读不到必须
        # 非 0；默认档保持「只提示」，因为 `add decision` 的未命中是**已解释的**（decisions
        # 不在 live/closed，见 echo_back 里的 decisions fallback），把它当异常会误伤。
        _st = Store(Path(cur_store[0]))
        _rb = {}
        for _strict in (False, True):
            _so, _se = sys.stdout, sys.stderr
            sys.stdout, sys.stderr = io.StringIO(), io.StringIO()
            try:
                echo_back(_st, "p999999", label="夹具", strict=_strict)
                _rb[_strict] = 0
            except SystemExit as _e:
                _rb[_strict] = _e.code if isinstance(_e.code, int) else 1
            finally:
                sys.stdout, sys.stderr = _so, _se
        expect("echo_back 默认档：回读不到只提示不失败（已解释的未命中不能误伤）",
               _rb[False] == 0, f"rc={_rb[False]}")
        expect("echo_back strict 档：回读不到必须非 0（写命令的自证不许静默）",
               _rb[True] != 0, f"rc={_rb[True]}")

        # strict 在 add/close 上的**接线**是否真的生效：注入一次真·静默丢失——把目标
        # 分区文件换成指向 /dev/null 的符号链接，于是 append **成功返回、没有异常**，
        # 条目却真的没落盘。这正是原 bug 那类「写完看不见却 rc=0」的现场。
        # 接线没开 strict 时这两条会红（rc=0、只多一行 stderr）。
        _sink = Path("/dev/null")
        with tempfile.TemporaryDirectory() as _td2:
            _s2 = Path(_td2) / "s"
            run2 = lambda *a: run(*a)          # noqa: E731（下面要用独立 store）
            _prev_store = cur_store[0]
            cur_store[0] = str(_s2)
            run("init")
            (_s2 / "pitfalls").mkdir(exist_ok=True)
            (_s2 / "pitfalls" / "sink.jsonl").symlink_to(_sink)
            rc, out = run("add", "pitfall", "--summary", "落进黑洞", "--domain", "sink")
            expect("add 写丢失 ⇒ strict 令其非 0（接线生效）",
                   rc != 0 and "回读不到" in out, f"rc={rc} {out[-160:]}")
            (_s2 / "actions").mkdir(exist_ok=True)
            rc, out = run("add", "action", "--summary", "待闭黑洞")
            aid2 = (re.search(r"id=(t\d+)", out) or [None, ""])[1]
            rc, out = run("add", "action", "--summary", "正常对照", "--domain", "okpart")
            (_s2 / "closed").mkdir(exist_ok=True)
            (_s2 / "closed" / "t.jsonl").symlink_to(_sink)
            rc, out = run("close", aid2, "--outcome", "闭进黑洞")
            expect("close 写丢失 ⇒ strict 令其非 0（接线生效）",
                   rc != 0 and "回读不到" in out, f"rc={rc} {out[-200:]}")
            cur_store[0] = _prev_store

        # id 空洞判据（t000238①，**只报不拦**）：造一个**低位**空洞——把已存在的条目跨
        # 分区搬进黑洞，它从在册面上消失而前后号仍在 ⇒ 形成「≤最大号却不存在」的低位洞。
        # （只让写丢失的那条当最大号造不出洞：它在册面消失后 max 跟着退，洞不可见。）
        with tempfile.TemporaryDirectory() as _td3:
            _prev_store = cur_store[0]
            cur_store[0] = str(Path(_td3) / "s3")
            run("init")
            for _s in ("一号", "二号", "三号"):
                run("add", "pitfall", "--summary", _s, "--domain", "seq")
            _pf = Path(cur_store[0]) / "pitfalls"
            (_pf / "sink.jsonl").symlink_to(_sink)
            run("edit", "p000002", "--domain", "sink")          # 二号搬进黑洞 ⇒ 只剩一号/三号
            rc, out = run("check", "--no-log")
            expect("id 空洞：低位洞被点名且仍 rc=0（只报不拦）",
                   rc == 0 and "空洞" in out and "p000002" in out, f"rc={rc} {out[-200:]}")
            cur_store[0] = _prev_store
        # 反向：无洞的库不该报洞（零噪声是只报不拦的前提，否则天天刷屏）
        rc, out = run("check", "--no-log")
        expect("id 空洞：无洞时不报（不刷屏）",
               "id 空洞" not in out, out[-160:])
        # v5.55.0（t000447）：**提示类输出也有体量口径**——「只报不拦」的提示不许铺开写。
        # 造一个**大空洞面**（手加一条高位号条目 ⇒ 它前面的号全成洞；`rebase --force`
        # 结案认账 ⇒ 这一轮只余「洞」这一个盲区）⇒ ① 提示行长度有界（不全列）；
        # ② 另有红项时，红项照样被点名（不被提示淹掉）。
        with tempfile.TemporaryDirectory() as _td5:
            _prev_store = cur_store[0]
            cur_store[0] = str(Path(_td5) / "s5")
            run("init")
            run("add", "pitfall", "--summary", "一号", "--domain", "seq")
            _pf5 = Path(cur_store[0]) / "pitfalls" / "seq.jsonl"
            with open(_pf5, "a", encoding="utf-8") as _fh:
                _fh.write(json.dumps({"id": "p000901", "created": today(),
                                      "createdAt": now_iso(), "summary": "高位号条目"},
                                     ensure_ascii=False) + "\n")
            run("index")                    # 重建 index（手加的行要进计数，否则 index 维先红）
            run("rebase", "--force")          # 结案：认账当前 id 空间 ⇒ 只剩「洞」这一个盲区
            rc, out = run("check", "--no-log")
            _hole_lines = [l for l in out.splitlines() if "前缀" in l]
            expect("v5.55.0 输出体量·提示有界：空洞再多，提示行也不铺开（计数＋摘要，不全列）",
                   rc == 0 and bool(_hole_lines) and all(len(l) <= 120 for l in _hole_lines)
                   and "p000002" in _hole_lines[0] and "p000900" not in _hole_lines[0]
                   and "handoff check: OK" in out,
                   f"rc={rc} 提示行 {_hole_lines[:1]} {out[-160:]}")
            # 同一库再手改一次 ⇒ 这一轮有红项 ⇒ 红项必须被点名（提示不淹红项）
            _pf5.write_text(_pf5.read_text(encoding="utf-8").replace("一号", "一号改"),
                            encoding="utf-8")
            rc2, out2 = run("check", "--no-log")
            expect("v5.55.0 输出体量·真红项不被淹：另有红项时，红项照样被点名",
                   rc2 != 0 and "未经 CLI 记录的写入" in out2
                   and all(len(l) <= 120 for l in out2.splitlines() if "前缀" in l),
                   f"rc={rc2} {out2[-200:]}")
            cur_store[0] = _prev_store

        # ---- v5.1.6：rm / unvoid --restore / import 三个写入口的回读自证 ----
        # 三者的**方向各不相同**，所以各写一条腿：rm 是反向（条目该不在册）、unvoid --
        # restore 与 import 是正向（条目该在册）。夹具仍用 /dev/null 符号链接注入静默丢失。
        with tempfile.TemporaryDirectory() as _td4:
            _prev_store = cur_store[0]
            cur_store[0] = str(Path(_td4) / "s4")
            run("init")
            # ① `rm`：写序＝先追加到 trash/、再整表覆写源文件 ⇒ 追加丢失即净消失。
            #    把 trash 落点预置成黑洞（rm 自己 mkdir 时不碰已有路径）。
            run("add", "pitfall", "--summary", "待删条目", "--domain", "d1")
            (Path(cur_store[0]) / "trash").mkdir(exist_ok=True)
            (Path(cur_store[0]) / "trash" / "p000001.jsonl").symlink_to(_sink)
            rc, out = run("rm", "p000001")
            expect("rm：追加进黑洞 ⇒ 回读拦下（rc≠0）",
                   rc != 0 and "回读不通过" in out, f"rc={rc} {out[-200:]}")
            # ② `unvoid --restore`：写序＝追加到落点、再 unlink trash 源文件。
            #    黑洞落点 ⇒ 回读必须在删源文件**之前**拦下，条目仍可捞回。
            (Path(cur_store[0]) / "trash" / "p000001.jsonl").unlink()
            run("add", "pitfall", "--summary", "待恢复条目", "--domain", "back")
            run("rm", "p000002")
            _back = Path(cur_store[0]) / "pitfalls" / "back.jsonl"
            if _back.exists():
                _back.unlink()
            _back.symlink_to(_sink)
            rc, out = run("unvoid", "p000002", "--restore")
            expect("unvoid --restore：追加进黑洞 ⇒ 回读拦下（rc≠0）",
                   rc != 0 and "回读查不到" in out, f"rc={rc} {out[-200:]}")
            expect("unvoid --restore 失败时 trash 源文件仍在（条目仍可捞回）",
                   (Path(cur_store[0]) / "trash" / "p000002.jsonl").is_file())
            cur_store[0] = _prev_store
        with tempfile.TemporaryDirectory() as _td5:
            _prev_store = cur_store[0]
            cur_store[0] = str(Path(_td5) / "s5")
            run("init")
            (Path(cur_store[0]) / "pitfalls").mkdir(exist_ok=True)
            (Path(cur_store[0]) / "pitfalls" / "imp.jsonl").symlink_to(_sink)
            _man = "\n".join([
                json.dumps({"_format": "handoff"}),
                json.dumps({"_kind": "entry", "_slot": "pitfalls", "_domain": "imp",
                            "summary": "导入黑洞", "created": today()}),
            ]) + "\n"
            rc, out = run("import", "-", inp=_man)
            expect("import：写入黑洞 ⇒ 回读逐 id 点名（rc≠0）",
                   rc != 0 and "回读查不到" in out, f"rc={rc} {out[-200:]}")
            cur_store[0] = _prev_store

        # ---- v5.1.6 顺带逼出来的第三个 bug：`--restore` 把带分区的条目扔进 `_global` ----
        # 备份行里没有分区键（分区只存在于文件名，与 v5.1.3 同一个双轨根因），而 `rm` 备份
        # 时只抄行不抄来源 ⇒ 恢复时无从知道该回哪个分区。修法＝rm 时另存来源分区 sidecar。
        with tempfile.TemporaryDirectory() as _td6:
            _prev_store = cur_store[0]
            cur_store[0] = str(Path(_td6) / "s6")
            run("init")
            run("add", "pitfall", "--summary", "带分区的条目", "--domain", "back")
            run("rm", "p000001")
            _side = Path(cur_store[0]) / "trash" / "p000001.src"
            expect("备份件带来源分区 sidecar（rm 时记下）", _side.is_file())
            rc, out = run("unvoid", "p000001", "--restore")
            _back = Path(cur_store[0]) / "pitfalls" / "back.jsonl"
            _gl = Path(cur_store[0]) / "pitfalls" / "_global.jsonl"
            _btxt = _back.read_text(encoding="utf-8") if _back.is_file() else ""
            _gtxt = _gl.read_text(encoding="utf-8") if _gl.is_file() else ""
            expect("restore 搬回**原分区**而不是 _global",
                   rc == 0 and "p000001" in _btxt and "p000001" not in _gtxt,
                   f"rc={rc} back={_btxt!r} _global={_gtxt!r}")
            expect("restore 成功后 sidecar 已清（不留残件）", not _side.exists())
            cur_store[0] = _prev_store

        # 交接队列回写（2026-10-03；**v5.31.0 壬-2 起判据输入是结构化声明**）：
        # 本夹具用真 CLI 建了 open 条目，却从不写 `exit` 槽 ⇒ fresh-queue 会把它们全报成
        # 「exit 沉默」。那**不是**判据误报，而是夹具自己没履行交接纪律——真实使用方
        # 建完条目同样要回写队列段。所以这里显式走一遍 `set exit`，让夹具面与真实纪律
        # 一致。
        # ⚠ v5.31.0 起「回写」是**两件事**：**散文**（叙述）＋ **声明**（`--covers`，落进
        #   班次台账）。判据只认**声明** ⇒ 散文里写不写 id 都行（壬-2 的收益：散文回归
        #   纯叙述、12 行预算全给叙述）。`run()` 默认按「守纪律的作者」自动补齐声明。
        _open_t = [r["id"] for r in rows("actions") if r.get("id", "").startswith("t")]
        run("set", "exit", inp="交接队列：\n" + "".join(f"- {i} 待办\n" for i in _open_t))
        rc, _ = run("check", "--no-log")
        expect("回写 exit 班段（声明齐全）后 fresh-queue 不报",
               rc == 0 or "fresh-queue" not in non_tamper(run("check", "--no-log")[1]))
        # **blocked 条目**：R2（v5.29.0）之后，**推不动的条目只有「本班新增」的要点名** ⇒
        # 旧形（要求全部 blocked 都逐条点名）是**第二条 O(存量) 的散文义务** ⇒ 与「区落盘」
        # 同型的死锁支（拐点按字节预算 ≈1800 条）⇒ 那个义务被搬给**读时现算的视图**。
        # 这条腿守住搬过去的那一半：**读者侧看得到它**（`handoff view` 逐条列出全部 live
        # 条目，`entry_display_line` 还带「等 owner／等 t000123」为什么推不动）。
        # ⚠「本班新增的 blocked 仍必须被声明」那半由 **v5.29.0⑭** 守着（独立临时库）——
        #   共享夹具里这条 blocked 是**存量**（它与散文写入是否同秒会改结论）⇒ 在这里
        #   断言它的声明义务＝**时序敏感**＝废腿（空腿恒绿）。
        _blocked_id = next((r["id"] for r in rows("actions") if r.get("status") == "blocked"), "")
        expect("R2：读者侧看得到那条推不动的条目（视图逐条列出 live 条目）",
               bool(_blocked_id) and _blocked_id in run("view")[1], "")
        run("set", "exit", inp="交接队列：\n" + "".join(f"- {i} 待办\n" for i in _open_t))
        # t000285 的反例腿（**v5.31.0 的现代形**）：**open** 条目没被**声明**覆盖 ⇒ 必须报。
        # 旧形靠「散文里少写了那个 id」暴露；新形靠「声明里少了那个 id」暴露——而且
        # **更早暴露**：写入面当场拒（牙前移，d000149），判据面独立地再报一次。
        # 「队列渲染区不算「出现过」」在壬-2 下**结构上不成立**：判据只读班次台账的
        # `covers` 字段，队列区（读时现算）压根不在判据输入里 ⇒ 下面两条腿把它钉住：
        # 视图的队列区**列着**它，但它没被声明 ⇒ 照样红。
        # 必须**现造**一条 open 的：此刻库里唯一那条 t 型就是上面用的 blocked 那条，
        # 拿它测等于又测回 blocked 那条腿（本版第一版就是这么写的，当场假失败）。
        # 测完即 `rm`——`rm` 是本文件既有的夹具手法（见 d000106 那组），不留残件。
        _, _o = run("add", "action", "--summary", "t000285 反例腿用", "--domain", "fqleg")
        _open_only = next(iter(re.findall(r"id=(t\d+)", _o)), "")
        rc, out_o = run("set", "exit", "--force", inp="交接队列：\n"
                        + "".join(f"- {i} 待办\n" for i in _open_t), covers=False)
        expect("没点名也没声明 ⇒ **写入即拒**（牙前移到写入面；报错点名要点名的 id 与现成写法）",
               bool(_open_only) and rc != 0 and "必须点名覆盖" in out_o and _open_only in out_o,
               f"挑中={_open_only!r} rc={rc} {out_o[-200:]}")
        rc, _out_o = run("check", "--no-log")
        expect("没声明 ⇒ fresh-queue 报红并点名它（**队列渲染区不算「已覆盖」**，t000285）",
               bool(_open_only) and rc != 0 and "fresh-queue" in _out_o and _open_only in _out_o,
               f"挑中={_open_only!r} rc={rc} {_out_o[-160:]}")
        run("rm", _open_only)
        rc, _ = run("check", "--no-log")
        expect("删掉那条 open 的 ⇒ 回到绿（反例腿自身不留红）",
               rc == 0 or "fresh-queue" not in non_tamper(run("check", "--no-log")[1]))

        # ── R（2026-10-23）：判据谓词拆成两段 —— 新腿 ──────────────────────────────
        # R 的两句：① **推不动的**（渲染区装不下：status≠open／waitingFor／被活裁定挡住）
        #    ⇒ 必须被**声明**；② **能推的** ⇒ 只有**本班新增**的要被声明，其余由区承担。
        # 下面三条腿分别钉住这两句，外加「原覆盖集仍被管」的差集实测（p000162 的证法）。

        # 腿 R-a：**推不动的**条目（`waitingFor` 变体）没被声明 ⇒ 必须报红。
        #   鉴别力：这类条目**渲染区装不下**（区的入池谓词排掉 waitingFor）⇒ 区永远救不了它；
        #   声明里没有它，它就从交接陈述里彻底消失。旧形（谓词＝live 减已闭）覆盖得到，
        #   但「渲染区算数」那种放宽会**漏掉它** ⇒ 这条腿就是 p000162 说的差集实测。
        _, _w = run("add", "action", "--summary", "R 腿：等所有者的活", "--domain", "fqleg",
                    "--waitingFor", "owner")
        _wait_id = next(iter(re.findall(r"id=(t\d+)", _w)), "")
        rc, out_w = run("set", "exit", "--force", inp="交接队列：\n"
                        + "".join(f"- {i} 待办\n" for i in _open_t), covers=False)
        expect("R-a：推不动的条目（waitingFor）没被点名也没被声明 ⇒ **写入即拒**（渲染区装不下它）",
               bool(_wait_id) and rc != 0 and "必须点名覆盖" in out_w and _wait_id in out_w,
               f"挑中={_wait_id!r} rc={rc} {out_w[-200:]}")
        rc, _out_w = run("check", "--no-log")
        expect("R-a：推不动的条目没被声明 ⇒ fresh-queue 报红（渲染区装不下它）",
               bool(_wait_id) and rc != 0 and "fresh-queue" in _out_w and _wait_id in _out_w,
               f"挑中={_wait_id!r} rc={rc} {_out_w[-160:]}")
        run("rm", _wait_id)

        # 腿 R-b：**存量的**能推条目（不是本班新增）没被声明 ⇒ **不报红**（R 的放宽点）。
        #   这条腿必须**显式断言是绿**：否则「把谓词收窄成什么都不管」也能让旧夹具全绿——
        #   正是 t000285 当年被恒绿蒙住的那类假绿。
        #   造法：造一条 open 条目，把它**降级成老条目**（去掉 `bornShift` ⇒ 走时刻兜底）
        #   并把**创建时刻**回填成**早于边界时刻** ⇒ 它就不是「本班新增」⇒ 区承担它
        #   ⇒ 声明里没有它不算沉默（直写 live 是本文件既有手法，见下面 d000104 那组）。
        _, _n = run("add", "action", "--summary", "R 腿：存量活", "--domain", "fqleg")
        _old_id = next(iter(re.findall(r"id=(t\d+)", _n)), "")
        _of = Path([r["_file"] for r in rows("actions") if r.get("id") == _old_id][0])
        _recs = [json.loads(ln) for ln in _of.read_text(encoding="utf-8").splitlines() if ln.strip()]
        # v5.30.0 刀 F：边界＝班次序号；老条目（无 bornShift）走**时刻**兜底 ⇒ 这里取 ts
        _bnd = _shift_boundary(Store(Path(cur_store[0])))
        _cut = _bnd.get("ts")
        _before_cut = ((datetime.fromisoformat(_cut) - timedelta(days=1)).isoformat()
                       if _cut else "2000-01-01T00:00:00")
        for _r in _recs:
            if _r.get("id") == _old_id:
                _r.pop("bornShift", None)      # 降级成老条目 ⇒ 走时刻兜底
                _r["createdAt"] = _before_cut
                _r["created"] = _before_cut[:10]
        _of.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in _recs) + "\n",
                       encoding="utf-8")
        # 存量条目不在「本班新增」里 ⇒ 写入面**不要求**声明它（不带 `--covers` 也放行）
        rc, out_oldw = run("set", "exit", "--force", inp="交接队列：\n"
                           + "".join(f"- {i} 待办\n" for i in _open_t), covers=False)
        expect("R-b 配套：存量条目不在声明义务里 ⇒ 写入面放行（不误伤）",
               rc == 0, f"rc={rc} {out_oldw[-160:]}")
        rc, _out_old = run("check", "--no-log")
        expect("R-b：存量的能推条目没被声明 ⇒ **不报红**（R 的放宽点：区承担它）",
               "fresh-queue" not in non_tamper(_out_old),
               f"挑中={_old_id!r} created={_before_cut} rc={rc} {_out_old[-160:]}")
        # 腿 R-c：那条存量活**出现在队列渲染区里**（读者看得到它）⇒ R 的第二段
        #   （能推的存量活由区承担）真的落地，而不是判据失灵。
        #   R-b 与 R-c 合起来才是完整的一对：**读者侧看得到 ＋ 作者侧不必声明**。
        # v5.29.0：区改**读时现算** ⇒ 这条断言要落在**视图**上（不是文件里——
        # 断言「文件里有 id」会是恒真：view 的 actions 段也列它 ⇒ 空腿恒绿）。
        _reg = run("view")[1]
        _qseg = _reg.split(QUEUE_BEGIN, 1)[1].split(QUEUE_END, 1)[0] if QUEUE_BEGIN in _reg else ""
        expect("R-c：存量活出现在**现算的**队列区里（读者侧看得到 ⇒ 区承担了它）",
               _old_id in _qseg, _reg[-200:])
        run("rm", _old_id)

        # ── t000407／v5.30.0 刀 F：「本班新增」的边界＝**班次序号** ──────────────────
        # （为什么不是「最后一次散文写入」、为什么不是日粒度：见 `_shift_boundary` 与
        #   `_is_shift_new` 的 docstring——那是本仓踩过的两个真坑：秒级界碑留下「同秒留一班」
        #   的重复点名；界碑取「最后一次」则让「本班新增」恒空 ⇒ **牙静默失效**。）
        # ⚠ v5.31.0 壬-2 之后，这两条腿的**形态**变了：点名（散文）→ **声明**（结构化）。
        #   两条**变异自证**（M1 日粒度／M2 边界取最后一次）**迁到「老口径组」**——
        #   在新口径下它们**不再有鉴别力**（新口径的结论是「有没有新条目没被声明覆盖」，
        #   与界碑取法无关 ⇒ 变异后结论不变 ⇒ 留在原处就是**空腿恒绿**）。
        _, _o407 = run("add", "action", "--summary", "t000407 腿：本班登记的活", "--domain", "fq407")
        _n407 = next(iter(re.findall(r"id=(t\d+)", _o407)), "")
        rc, _out_p1 = run("check", "--no-log")
        expect("P1：本班登记的条目没被声明 ⇒ 必须报红（**牙在**：新条目没进任何班段的声明）",
               bool(_n407) and rc != 0 and "fresh-queue" in _out_p1 and _n407 in _out_p1,
               f"挑中={_n407!r} rc={rc} {_out_p1[-200:]}", dim="fresh-queue")
        rc, out_p1w = run("set", "exit", "--force", inp="## 这一班做了一件事。\n", covers=False)
        expect("P1 配套：没点名也没声明就写班段 ⇒ **写入即拒**（牙前移到写入面，d000149）",
               bool(_n407) and rc != 0 and "必须点名覆盖" in out_p1w and _n407 in out_p1w,
               f"rc={rc} {out_p1w[-200:]}")

        # 腿 P2（存量不再被要求声明＝t000407 的收益）：N 已在**上一班**的声明里覆盖过
        #   ⇒ 这班的班段不再声明它，也**不该**再被要求声明（这正是日粒度版做不到的）。
        run("set", "exit", "--force", inp="## 这一班做了一件事。\n", covers=[_n407])
        rc, _out_p2 = run("check", "--no-log")
        expect("P2：上一班已声明的条目，这班不再声明 ⇒ **不报红**（班次序号⇒「本班」＝这一班）",
               "fresh-queue" not in non_tamper(_out_p2),
               f"id={_n407!r} rc={rc} {_out_p2[-200:]}")
        # 再写一班（**不声明**它）⇒ 仍然不报红 ⇒ 义务只与**本班增量**有关（存量免声明）
        run("set", "exit", "--force", inp="## 又做了一件事。\n", covers=False)
        rc, _out_p2b = run("check", "--no-log")
        expect("P2 配套：跨班后它仍**不需要**被声明（义务＝O(本班增量)，不是 O(存量)）",
               "fresh-queue" not in non_tamper(_out_p2b),
               f"id={_n407!r} rc={rc} {_out_p2b[-200:]}")
        run("rm", _n407)

        # 脏行（status=closed）直写 live：refill 不选 + check FAIL
        dirty = rows("actions")[0]
        f = Path(dirty["_file"])
        lines = [ln for ln in f.read_text(encoding="utf-8").splitlines() if ln.strip()]
        kept = [ln for ln in lines if json.loads(ln).get("id") != dirty["id"]]
        kept.append(json.dumps({**{k: v for k, v in dirty.items() if not k.startswith("_")},
                                "status": "closed"}, ensure_ascii=False))
        f.write_text("\n".join(kept) + "\n", encoding="utf-8")
        nid, _ = refill_pick(Store(Path(cur_store[0])))
        expect("refill_pick 不选 status=closed 行", nid != dirty["id"])
        rc, out = run("check", "--no-log")
        expect("check 对 status=closed FAIL", rc != 0 and "status 非法" in out and "'closed'" in out, dim="status")


        # 两步修复：edit 回 open → close，check 复绿
        run("edit", dirty["id"], "--status", "open")
        run("close", dirty["id"], "--outcome", "fixed")
        # close 之后必须更新 `exit` 队列段（2026-10-03，fresh-stale 判据带出的真实纪律）：
        # 刚关掉的条目若在 `exit` 里仍写成「待办」，fresh-stale 就报「把已闭说成候立」。
        # 这不是判据误报——**交接文本本来就要跟着条目状态走**，所以这里走一遍改写，
        # 顺带证明 fresh-stale 只看 `exit` 那一行有没有关闭标记。
        run("set", "exit", inp=f"交接队列：\n- {dirty['id']}（已闭）\n"
                                + "".join(f"- {i} 待办\n" for i in _open_t if i != dirty["id"]))
        rc, out2 = run("check", "--no-log")
        expect("两步修复后除已记录的 tamper 外无其它问题", rc == 0 or not non_tamper(out2).strip())

        # ---- v5.7.0 d000104：取消超期升档，天龄退出排序 ----
        # 对照组必须造出**熬过两条超期线**的 [低] 项：旧形（有效档＝基础档−年龄//30）会把它
        # 抬到与 [中] 并档、又因 created 更老而排到 [中] **前面**；新形里天龄不进排序键。
        run("add", "action", "--summary", "排序键对照项", "--domain", "排序键", "--prio", "中")
        run("add", "action", "--summary", "熬很久的项", "--domain", "排序键", "--prio", "低")
        _acts = rows("actions")
        _mid = [r["id"] for r in _acts if r.get("summary") == "排序键对照项"][0]
        _old_low = [r["id"] for r in _acts if r.get("summary") == "熬很久的项"][0]
        _of = Path([r["_file"] for r in _acts if r.get("id") == _old_low][0])
        _recs = [json.loads(ln) for ln in _of.read_text(encoding="utf-8").splitlines() if ln.strip()]
        _old_date = date.fromordinal(date.today().toordinal() - REFILL_STEP_DAYS * 2).isoformat()
        for _r in _recs:
            if _r.get("id") == _old_low:
                _r["created"] = _old_date
        _of.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in _recs) + "\n",
                       encoding="utf-8")
        _st = Store(Path(cur_store[0]))
        _pool = refill_pool(_st)[0]
        _order = [r["id"] for _k, r, *_ in _pool]
        # 正控：熬够两倍超期线的 [低] 仍排在当日新登记的 [中] 之后。
        expect("d000104 正控：[低] 熬过两条超期线仍不越过 [中]（天龄退出排序键）",
               _order.index(_mid) < _order.index(_old_low),
               f"mid@{_order.index(_mid)} low@{_order.index(_old_low)}")
        # 负控①：排序键第 0 位**就是声明的档**，没被超期改写。
        expect("d000104 负控①：排序键首位＝prio 字段（天龄未进键）",
               all(k[0] == PRIO_RANK.get(r.get("prio"), PRIO_RANK[PRIO_DEFAULT])
                   for k, r, *_ in _pool))
        # 负控②：`refill_pick` 输出**点名超期项**——提醒替代升档，两头都不能空。
        _nid, _why = refill_pick(Store(Path(cur_store[0])))
        _seg = _why.split("·超期 ")[1].split("·")[0] if "·超期 " in _why else ""
        expect("d000104 负控②：超期项在 next 输出里被独立点名", _old_low in _seg, _why[:100])
        # 负控③：点名**只覆盖真的超期项**——提醒不许变成对全池的无差别噪音。
        expect("d000104 负控③：被点名的都确实超期",
               all(_age_days(next(x["created"] for x in _st.load_live() if x.get("id") == i))
                   >= REFILL_STEP_DAYS for i in re.findall(r"[tp]\d{6}", _seg)), _seg)
        # 变异自证：把天龄塞回排序键（退回旧形）⇒ 正控必须转红，证明夹具咬得住老 bug。
        _mut = sorted((max(0, k[0] - _age_days(r.get("created", "")) // REFILL_STEP_DAYS),
                       r.get("created", ""), r["id"]) for k, r, *_ in _pool)
        _mo = [x[2] for x in _mut]
        expect("变异：把天龄塞回排序键 ⇒ 正控转红（该腿有牙）",
               _mo.index(_mid) > _mo.index(_old_low),
               f"旧形 mid@{_mo.index(_mid)} low@{_mo.index(_old_low)}")

        # ---- v5.32.0（P1／批 A）：**状态不再由作者抄写** ----
        # 旧形（d000105 第 0／1 层）：作者必须手抄状态、闸在写时与事后双向校验 ⇒ 实测写面
        # 会拒 113 处（其中 109 处是**带时点的历史陈述**被误判）、三句普通中文全部被拒写、
        # 库里 21 处状态副本是**闸逼出来的** ⇒ 新形：**写面不因状态拒写**；无时点的
        # **括号型**标记由写面**规范化掉**；状态由**渲染现算**补（`view`）；两维作废。
        _open_ref, _closed_ref = _mid, dirty["id"]          # 一个仍 open、一个已闭
        # 正控①：三句**没有毛病**的普通中文全部放行（旧形：3/3 拒写）。
        _plain = [
            f"## 散文一\n- 修好了 {_closed_ref} 这条\n",
            f"## 散文二\n- {_open_ref} 完成了迁移\n",
            f"## 散文三\n- {_closed_ref} 的迁移收尾了\n",
        ]
        _rcs = [run("set", "exit", inp=t)[0] for t in _plain]
        expect("v5.32.0 正控①：三句普通中文**全部放行**（写面不再因状态拒写）",
               all(rc == 0 for rc in _rcs), str(_rcs))
        # 正控②：**括号型**标记被规范化掉（无时点的行）⇒ 存储里不再留状态副本
        # （已闭的与**仍在册**的都规范化——后者是「把活的说成死的」那种写法，
        #   新形不拦写，而是把标记摘掉、由渲染现算给真状态）。
        run("set", "exit",
            inp=f"## 规范形\n- {_closed_ref}（已闭）\n- {_open_ref}（已闭）\n- {_open_ref} 待办\n")
        _stored = (Path(cur_store[0]) / "exit").read_text(encoding="utf-8")
        expect("v5.32.0 正控②：无时点的括号状态标记**被规范化掉**（存储里不留状态副本）",
               "（已闭）" not in _stored and _closed_ref in _stored and _open_ref in _stored,
               _stored[:160])
        # 正控③：**带时点**的行原样保留（历史陈述说的是「当时」，工具不裁决）。
        run("set", "exit", inp=f"## 历史\n- 2026-10-23 {_closed_ref}（已闭）\n")
        _stored2 = (Path(cur_store[0]) / "exit").read_text(encoding="utf-8")
        expect("v5.32.0 正控③：带时点的行**原样保留**（历史陈述不被改写）",
               "（已闭）" in _stored2, _stored2[:160])
        # 正控④：**渲染现算**——`view` 在**无时点**的行里给每个提及标真状态（读时算、不落盘）。
        #   （此时 exit 里是上一段「带时点」的历史行 ⇒ 那里**不该**有标注 ⇒ 先写一段无时点的。）
        run("set", "exit", inp=f"## 现在\n- {_closed_ref} 这条\n- {_open_ref} 那条\n")
        rc2, _v = run("view")
        expect("v5.32.0 正控④：`view` 现算标注真状态（读者看得到，作者不必抄）",
               rc2 == 0 and ("〔已闭" in _v or "〔在册" in _v), _v[-200:])
        # 正控④b：**带时点**的历史行**不标**（那是当时的说法，工具不裁决）。
        run("set", "exit", inp=f"## 历史\n- 2026-10-23 {_closed_ref}（已闭）\n")
        rc2, _v3 = run("view")
        expect("v5.32.0 正控④b：带时点的历史行**不标**（渲染只管现在时）",
               "〔已闭" not in _v3 and "〔在册" not in _v3, _v3[-200:])
        # 正控⑤：判据面**不再拿散文比库里活状态** ⇒ 直写的假闭态不再被 check 判红
        # （机器不再替作者裁决语义 ⇒ **用可见性换拦截力**；这条如实钉住代价）。
        _cf = Path(cur_store[0]) / "exit"
        _cf.write_text(f"## 直写\n- {_open_ref}（已闭）\n", encoding="utf-8")
        rc2, _o2 = run("check", "--no-log")
        expect("v5.32.0 正控⑤：check **不再**因散文里的状态标记判红（散文不承担状态）",
               "fresh-false" not in _o2 and "fresh-stale" not in _o2, _o2[-200:])
        # **变异自证①**：把规范化摘掉（退回原样落盘）⇒ 正控②必须转红（该腿有牙）。
        _real_norm = normalize_state_claims
        try:
            globals()["normalize_state_claims"] = lambda text: (text, [])
            run("set", "exit", inp=f"## 规范形\n- {_closed_ref}（已闭）\n")
            _mut = (Path(cur_store[0]) / "exit").read_text(encoding="utf-8")
            expect("v5.32.0 变异①：摘掉规范化 ⇒ 正控②转红（该腿有牙）", "（已闭）" in _mut, _mut[:80])
        finally:
            globals()["normalize_state_claims"] = _real_norm
        # **变异自证②**：把渲染标注摘掉 ⇒ 正控④必须转红（该腿有牙）。
        _real_ann = annotate_states
        try:
            globals()["annotate_states"] = lambda st, text: text
            rc2, _v2 = run("view")
            expect("v5.32.0 变异②：摘掉渲染标注 ⇒ 正控④转红（该腿有牙）",
                   "〔已闭" not in _v2 and "〔在册" not in _v2, _v2[-120:])
        finally:
            globals()["annotate_states"] = _real_ann

        # ---- v5.33.0（B1）出路律：`check` 增「现在该做什么」节 --------------------
        # 用**独立临时库**：共享夹具的池/指针/待交代集都随前面的腿变动 ⇒ 在那儿断言就是废腿。
        _gn = tempfile.mkdtemp(prefix="handoff-selftest-v533guid.")
        _saved_gn = cur_store[0]
        cur_store[0] = str(Path(_gn) / ".handoff")
        run("init")
        _, _gn_o = run("add", "action", "--summary", "指引腿：待交代的一条")
        _gn_id = next(iter(re.findall(r"id=(t\d+)", _gn_o)), "")
        rc2, out2 = run("check", "--no-log")
        expect("v5.33.0 B1①：`check` 输出含「现在该做什么」节（用户不必记住流程）",
               "## 现在该做什么" in out2, out2[-200:])
        expect("v5.33.0 B1②：该节点名**本班待交代**的条目并给出现成写法（工具替人算）",
               _gn_id in out2 and "handoff append exit --covers" in out2, out2[-300:])
        expect("v5.33.0 B1③：指针为空 ⇒ 给出现成的补位命令（机械可算的那条必须在）",
               "handoff next --auto" in out2, out2[-300:])
        # **变异自证**：把指引节掏空 ⇒ B1① 必须转红（该腿有牙、不是恒绿）。
        _real_gn = _now_next
        try:
            globals()["_now_next"] = lambda st: []
            rc2, out3 = run("check", "--no-log")
        finally:
            globals()["_now_next"] = _real_gn
        expect("v5.33.0 B1 变异自证：掏空指引节 ⇒ B1① 转红（该腿有牙）",
               "## 现在该做什么" not in out3, out3[-200:])
        cur_store[0] = _saved_gn
        shutil.rmtree(_gn, ignore_errors=True)
        closed_rows = read_jsonl(Path(cur_store[0]) / "closed" / "t.jsonl")
        expect("close 行带 closed+outcome", any(r.get("id") == dirty["id"] and r.get("closed") and r.get("outcome") for r in closed_rows))

        # ---- v5.0 内容硬限（t000196④）：负向＝超限拒收，正向＝贴限放行 ----
        # 注意用**独立的 open 条目**：上面的两步修复已把 aid 关进 closed/，close 401 的
        # 夹具若还打 aid，会先在 guard_len 拒（负向假过）、「恰 400」却死在「未找到」。
        run("add", "action", "--summary", "限长夹具")
        _lid = [r["id"] for r in rows("actions") if r.get("summary") == "限长夹具"][0]
        rc, out = run("close", _lid, "--outcome", "长" * 401)
        expect("close --outcome 401 字拒收（上限 400）", rc != 0 and "400" in out)
        rc, _ = run("close", _lid, "--outcome", "结" * 400)
        expect("close --outcome 恰 400 字放行", rc == 0)
        # t000261：**同一条 outcome 两条写路**。上面那两条只走 close 路径；`edit` 经自己
        # 那张上限表，漏配时落 10**9 兜底＝无闸（实测 630 字 rc=0 落盘）。故另配两条。
        rc, out = run("edit", _lid, "--outcome", "长" * 401)
        expect("edit --outcome 401 字拒收（上限 400，与 close 同一口径）", rc != 0 and "400" in out)
        rc, _ = run("edit", _lid, "--outcome", "改" * 400)
        expect("edit --outcome 恰 400 字放行", rc == 0)
        # **变异自证**：`run()` 走进程内 `main()`，故改模块级表即可模拟旧实现。
        # 摘掉 outcome 那一项 ⇒ 同一份 401 字**当场放行** ⇒ 证明上面那条红真是这条闸兜住的，
        # 不是别的守卫（`require_text` 只查危险字符，查不出长度）。
        _saved_outcome = EDIT_CAPS.pop("outcome")
        try:
            rc_m, _ = run("edit", _lid, "--outcome", "长" * 401)
            expect("变异：EDIT_CAPS 摘掉 outcome ⇒ 401 字当场放行（正控真由这条闸兜住）", rc_m == 0)
        finally:
            EDIT_CAPS["outcome"] = _saved_outcome
        rc, _ = run("edit", _lid, "--outcome", "毕")
        expect("还原后闸复效（变异没留下痕迹）", rc == 0)
        rc, out = run("add", "action", "--summary", "字" * 121)
        expect("add --summary 121 字拒收（上限 120）", rc != 0 and "120" in out)
        rc, _ = run("add", "action", "--summary", "字" * 120)
        expect("add --summary 恰 120 字放行", rc == 0)
        big = "x" * 8200
        rc, out = run("set", "exit", inp=big)
        expect("set exit 8200 字符拒收（热层硬闸 8192）", rc != 0 and "8192" in out)
        rc, out = run("set", "exit", inp="## 甲\n" + "- 行\n" * 13)
        expect("set exit 单班段 13 行拒收（上限 12）", rc != 0 and "12 行" in out)


        # ---- v5.0 热/冷分层（t000196②）：append 挤出 / compact 归档 / read 合并 ----
        # --force：旧 exit 内容（交接队列段）远长于新单节内容，骤降守卫会拦——这里是
        # 刻意重置热层，属有意大幅删减。
        run("set", "exit", "--force", inp="## 甲\n- a\n")
        run("append", "exit", inp="## 乙\n- b\n")
        hot = (Path(cur_store[0]) / "exit").read_text(encoding="utf-8")
        expect("append 后热层只留最新班段", "## 乙" in hot and "## 甲" not in hot)
        arc = read_jsonl(Path(cur_store[0]) / ARCHIVE_DIR / "exit.jsonl")
        expect("被挤出的班段进冷档", len(arc) == 1 and "## 甲" in arc[0].get("text", ""), dim="archive")
        run("append", "exit", inp="## 丙\n- c\n")
        rc, out = run("read", "exit", "--tail", "3")
        expect("read --tail 取回热＋冷共 3 班段", all(k in out for k in ("## 甲", "## 乙", "## 丙")))
        rc, out = run("read", "exit")
        expect("read 默认只读热层", "## 丙" in out and "## 甲" not in out)
        for _i in range(35):
            run("append", "summary", inp=f"- 第{_i}行\n")
        s_hot = (Path(cur_store[0]) / "summary").read_text(encoding="utf-8")
        expect("summary 热层裁到保留行数内", len(s_hot.splitlines()) <= KEEP_SUMMARY_LINES,
               f"实得 {len(s_hot.splitlines())} 行")
        s_arc = read_jsonl(Path(cur_store[0]) / ARCHIVE_DIR / "summary.jsonl")
        expect("summary 溢出行进冷档", len(s_arc) >= 5)
        rc, out = run("compact", "exit")
        expect("compact 无可归档时明说", rc == 0 and "无可归档" in out)

        # ---- v5.0 sealed store（t000196①）：封存自证（权限位是落盘证据）----
        seal_store(Path(cur_store[0]))
        expect("seal 后全树无可写位", store_sealed(Path(cur_store[0])), dim="sealed")
        unseal_store(Path(cur_store[0]))
        expect("unseal 后恢复可写", not store_sealed(Path(cur_store[0])))

        # ---- guard_partition 双向夹具（p000046 / 4.7.0-4.7.2）----
        # 为什么放进 selftest：本轮前两版曾在 patches 里自报「18 例鉴别力」，
        # 而**仓内没有任何可复跑夹具**——自报的数会随库/手改漂移，且对没有本仓的
        # 消费者恒假。判据的输入必须是落盘证据，判据本身也得有落盘证据。
        bad_parts = [("a/b", "含 /"), ("../evil", "含 .."), ("..", "纯 .."),
                     ("  auth  ", "前后空白"), ("a\\b", "反斜杠"),
                     ("a" * 70, "超长 >64"),
                     ("C:evil", "Windows 盘符相对"), ("ok:hidden", "NTFS 备用数据流"),
                     ("x\x01y", "ASCII C0 控制字符")]
        # 注意：**不能**同时放 `auxiliary` 与 `AUXILIARY` 之类的大小写变体——那正是本组
        # 要检的冲突，会让后面「夹具跑完 check 仍绿」自己变红（第一版就这么栽过）。
        ok_parts = [("auth", ""), ("_global", ""), ("skill-fit", ""),
                    ("交接", ""), ("v1.2", ""), ("ok-null", ""), ("auxiliary", ""),
                    ("conx", ""),
                    # Windows 实测：设备名经 Win32 CreateFile 全部**正常创建且可见**，
                    # 拦它们是误拒（见 guard_partition 里的说明）。
                    ("CON", ""), ("NUL", ""), ("aux", ""), ("COM1", ""),
                    ("com1 .txt", ""), ("nul .jsonl", ""), (".con", "")]
        n_bad = 0
        for val, why in bad_parts:
            rc2, out2 = run("add", "action", "--summary", f"bad-{val[:6]}", "--domain", val)
            if rc2 != 0:
                n_bad += 1
            else:
                expect(f"guard_partition 拒「{why}」", False, f"{val!r} 被放行 rc=0")
        expect(f"guard_partition 拒全部 {len(bad_parts)} 类危险分区名", n_bad == len(bad_parts),
               f"只拒了 {n_bad}/{len(bad_parts)}")
        n_ok = 0
        for val, _ in ok_parts:
            rc2, _out = run("add", "action", "--summary", f"ok-{val[:8]}", "--domain", val)
            n_ok += (rc2 == 0)
        expect(f"guard_partition 放行全部 {len(ok_parts)} 个合法分区名（含 CJK/下划线/连字符/带点）",
               n_ok == len(ok_parts), f"只放行了 {n_ok}/{len(ok_parts)}")
        # 拒绝后不得留下任何子目录/文件（幽灵的根因就是写进了子目录）
        subdirs = [q for q in (Path(cur_store[0]) / "actions").iterdir() if q.is_dir()]
        expect("被拒的分区名不留下子目录（幽灵的根因）", not subdirs,
               f"留下 {[q.name for q in subdirs]}")
        # 上面这批 `ok-*` 条目是**在首次回写 exit 之后**新建的，队列段已覆盖不到它们 ⇒
        # fresh-queue 会报「exit 沉默」。真实使用方同样会遇到（加了一堆条目却没回写队列），
        # 所以这里再回写一次：把当前所有 open `t` 型重新扫一遍写进 exit。
        _open_t2 = [r["id"] for r in rows("actions") if r.get("id", "").startswith("t")]
        run("set", "exit", inp="交接队列：\n" + "".join(f"- {i} 待办\n" for i in _open_t2))
        rc2, _o = run("check", "--no-log")
        expect("夹具跑完 check 除已记录的 tamper 外无其它问题",
               rc2 == 0 or not non_tamper(_o).strip())

        # ---- v5.29.0（d000147）：队列现态区**不再落盘**，改读时现算 -----------------
        # 这组腿的存在理由：v5.28.x 的区是**存储态派生物** ⇒ 它把 O(池规模) 的机器内容
        # 塞进人写的散文层 ⇒ 库一大就撞 8192 字节闸 ⇒ `append exit` 被拒 ⇒ 班段永久
        # 写不进（实测 500 条：exit 6138→17329 字节、append rc=1、且无自救出口——
        # `set --force` 会被重新渲染的区顶回去、`compact` 无可归档）⇒ 同一约束还散在
        # 两处实现（有闸的路径被拒、无闸的路径静默超限）。
        # ⇒ v5.29.0：区只读时现算（`view`）⇒ 热层里不再有 O(库规模) 的东西。
        _qx = (Path(cur_store[0]) / "exit").read_text(encoding="utf-8")
        expect("v5.29.0①：exit 热层里**没有**队列区（区不落盘）",
               QUEUE_BEGIN not in _qx, _qx[-120:])
        # 视图里的区与库**同源**：逐行列出的 id 恰等于 `refill_pool` 的实算集合（不多不少、不乱序）。
        _qrows = refill_pool(Store(Path(cur_store[0])))[0]
        _vout = run("view")[1]
        _qids = re.findall(r"^- `(t\d{6})`", _vout, re.M)
        expect("v5.29.0②：`view` 现算的区＝refill_pool 实算（同序，无第二个源）",
               _qids == [r["id"] for _k, r, *_ in _qrows],
               f"{_qids[:4]} vs {[r['id'] for _k,r,*_ in _qrows][:4]}")
        # close 后：视图里的区不再有该条（现算 ⇒ 天然跟上），且**散文逐字未动**。
        _before = _qx.rstrip("\n")
        run("close", _open_ref, "--outcome", "v5.29.0 夹具收口")
        _after = (Path(cur_store[0]) / "exit").read_text(encoding="utf-8")
        expect("v5.29.0③：close 后视图里的区不再有该条（现算，不必等任何写点）",
               f"`{_open_ref}`" not in run("view")[1].split("队列现态（现算")[-1])
        expect("v5.29.0③配套：散文部分**逐字未动**（机器内容不再混进散文层）",
               _after.rstrip("\n") == _before)
        # 旧节进冷档：v5.29.0 起**冷档节里不带区**（区从不落盘 ⇒ 没有「当时的快照」）。
        run("set", "exit", "--force", inp="## 甲班段\n- a\n")
        run("append", "exit", inp="## 乙班段\n- b\n")
        _arc = read_jsonl(Path(cur_store[0]) / ARCHIVE_DIR / "exit.jsonl")
        _evicted = [a.get("text", "") for a in _arc if "甲班段" in a.get("text", "")]
        expect("v5.29.0④：挤出的旧节**不带**区（区不落盘 ⇒ 冷档里没有派生物）",
               len(_evicted) == 1 and QUEUE_BEGIN not in _evicted[0] and "## 甲班段" in _evicted[0])
        # 行内引用标记串不得被吞（写这版时真踩过：exit 的散文里引了一次
        # `queue:begin`，按裸子串切会把引用点之后到真区尾的散文整段删掉＝数据丢失）。
        _quoted = ("## 甲段\n散文里引用了 `" + QUEUE_BEGIN + "` 这个串，后面还有干货。\n")
        _mixed = _quoted + "\n" + _queue_block(Store(Path(cur_store[0])))
        expect("v5.29.0⑤：行内引用标记串 ⇒ 散文一字不丢（只认行首标记）",
               "干货" in _strip_queue(_mixed) and "引用了" in _strip_queue(_mixed))
        # 读回整槽、原样写回 ⇒ 幂等（写入时剥区 ⇒ 区不累积、也不吃班段行数闸）。
        _rt = (Path(cur_store[0]) / "exit").read_text(encoding="utf-8")
        rc2, out2 = run("set", "exit", inp=_rt)
        expect("v5.29.0⑥：读回 exit 原样写回 ⇒ rc=0 且**区不落盘**（幂等）",
               rc2 == 0 and QUEUE_BEGIN not in (Path(cur_store[0]) / "exit").read_text(encoding="utf-8"),
               out2[-120:])
        # ---- v5.29.0：原 d000106 的三条「区跟上」腿改成**池谓词**腿 ----
        # 旧形断言「区里跟着变」⇒ 那是**存储态快照**的义务（写点清单漏接 ⇒ 陈旧）。
        # 现在区是现算的 ⇒ 断言「区」会**恒真**＝废腿（本仓记过：空腿恒绿）⇒ 改断言
        # **池的成员与档位**（现算的唯一源 `refill_pool`）——那才是会坏的地方。
        _pool0 = [r["id"] for _k, r, *_ in refill_pool(Store(Path(cur_store[0])))[0]]
        _t_r = next(i for i in _pool0 if i != _mid)
        rc2, _ = run("rm", _t_r)
        _pool1 = [r["id"] for _k, r, *_ in refill_pool(Store(Path(cur_store[0])))[0]]
        expect("v5.29.0⑦：rm 之后该条**不再进池**（池谓词现算，不是快照）",
               rc2 == 0 and _t_r not in _pool1)
        _t_e = next(i for i in _pool1 if i not in (_mid, _t_r))
        rc2, _ = run("edit", _t_e, "--prio", "高")
        _v2 = run("view")[1]
        expect("v5.29.0⑧：edit 改 prio ⇒ 现算的区里档位跟上",
               rc2 == 0 and f"- `{_t_e}` 高·open" in _v2 and f"- `{_t_e}` 中·open" not in _v2,
               _v2[-160:])
        # ---- v5.29.0：queue-legacy 维（残留区）＋ 报错指向的修法真能执行 ----
        _p4 = Path(cur_store[0]) / "exit"
        _p4.write_text(_p4.read_text(encoding="utf-8") + "\n"
                       + _queue_block(Store(Path(cur_store[0]))), encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("v5.29.0⑨：旧库残留的区 ⇒ check 报 queue-legacy",
               rc2 != 0 and "queue-legacy" in out2, out2[-160:], dim="queue-legacy")
        rc2, out2 = run("sync-queue")
        expect("v5.29.0⑨配套：报错里那条 `handoff sync-queue` 真能剥掉残留（非空壳命令）",
               rc2 == 0 and QUEUE_BEGIN not in _p4.read_text(encoding="utf-8")
               and "queue-legacy" not in run("check", "--no-log")[1], out2[:100])
        rc2, out2 = run("sync-queue")
        expect("v5.29.0⑨配套②：sync-queue 幂等（没有残留就一个字节都不写）",
               rc2 == 0 and "没有遗留" in out2, out2[:70])
        rc2, out2 = run("check", "--no-log")
        expect("v5.29.0⑨负控：exit 没有残留区 ⇒ queue-legacy 不凭空判红（新库不误伤）",
               "queue-legacy" not in out2, out2[-100:])
        # 负控④：`--dry-run` 不得把**遗留区**报成「将丢失行」——写入时会剥掉它，
        # 拿含区的旧文比剥区新内容＝不实陈述。
        _p6 = Path(cur_store[0]) / "exit"
        _p6.write_text("## 有区的班段\n- 内容\n\n" + _queue_block(Store(Path(cur_store[0]))),
                       encoding="utf-8")
        rc2, out2 = run("set", "exit", "--dry-run", inp="## 有区的班段\n- 内容\n")
        expect("v5.29.0⑩：dry-run 不把遗留区报成将丢失（并声明区改为读时现算）",
               rc2 == 0 and "将丢失" not in out2 and "读时现算" in out2, out2[-180:])
        rc2, out2 = run("set", "exit", "--dry-run", inp="## 别的班段\n- 新\n")
        expect("v5.29.0⑩配套：真丢散文时 dry-run 仍要点名（收紧没把它弄成哑巴）",
               rc2 == 0 and "将丢失行" in out2 and "有区的班段" in out2, out2[-180:])
        run("sync-queue")   # 清掉本腿留下的残留区（后面几条腿要干净底）


        # ---- v5.30.0 刀 B：counts 区**不再落盘**（`counts-stale` 维作废） --------------
        # 旧形：counts 区是**存储态派生物**（现态计数的第二份副本）⇒ 它会陈旧 ⇒ 专门养一个
        # 判据维 `counts-stale` 兜它；它贴近上限时还会**静默跳过写入**（实测：status 散文
        # 32600 字符 ⇒ `set status` rc=0 而区从文件里消失、`check` 仍绿 ⇒ 副本**无声丢失**），
        # 且跳过时给的建议命令 `handoff compact status` **根本不存在**（compact 只支持
        # exit／summary）⇒ 族 E 的假称同型。
        # ⇒ v5.30.0：与队列区**同构收口**——区读时现算（`view`），`status` 槽回归纯散文，
        #    判据面**净减一处**（`counts-stale` 作废）。
        _cs = Path(cur_store[0]) / "status"
        _ct = _cs.read_text(encoding="utf-8")
        expect("v5.30.0 B①：写命令后 status 里**没有** counts 区（派生物零落盘）",
               COUNTS_BEGIN not in _ct and COUNTS_END not in _ct, _ct[:80])
        _v_cnt = run("view")[1]
        expect("v5.30.0 B④：`view` 里有一段现算的「现态计数」（读者看得到、且不是文件里的副本）",
               "## 现态计数（现算 · 不落盘）" in _v_cnt and "- actions：" in _v_cnt, _v_cnt[-200:])
        # B③：旧库残留的 counts 区 ⇒ **不判红**（维已作废 ⇒ 残留只是旧库痕迹，不是矛盾）
        run("unseal")
        _cs.write_text(COUNTS_BEGIN + "\n**现态计数**（旧库残留）\n- actions：999\n"
                       + COUNTS_END + "\n\n" + _ct, encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("v5.30.0 B③：旧库残留的 counts 区 ⇒ check **不判红**（counts-stale 维已作废）",
               "counts-stale" not in out2, out2[-120:])
        # B②：任意一条写命令 ⇒ 残留被**幂等剥掉**（写路径统一清理）
        run("next", "--auto")
        _cs_after = _cs.read_text(encoding="utf-8")
        expect("v5.30.0 B②：写命令后旧库残留的 counts 区被剥掉（幂等清理）",
               COUNTS_BEGIN not in _cs_after and COUNTS_END not in _cs_after, _cs_after[:120])
        _cs_txt = _cs.read_text(encoding="utf-8")
        run("next", "--auto")
        expect("v5.30.0 B②配套：没有残留 ⇒ 再写也不动 status（幂等，不搅乱写事件对账）",
               _cs.read_text(encoding="utf-8") == _cs_txt, "")

        # ---- v5.8.0 d000108：重要度从 summary 前缀搬进 prio 字段 ----
        # 用**独立临时库**跑：这组要自己构造「旧库形状」（无 prio 字段），
        # 拿共享 cur_store 改文件会污染别组，且分区文件名靠 glob 撞运气（前一版就这么 IndexError 过）。
        _ps = tempfile.mkdtemp(prefix="handoff-prio.")
        def mk_runner(store_path):
            """在指定 store 上跑一条 CLI 并收回输出（每组各造临时库，互不污染文件面）。"""
            def _r(*argv, inp=None):
                buf, err, so, se, sin = io.StringIO(), io.StringIO(), sys.stdout, sys.stderr, sys.stdin
                sys.stdout, sys.stderr = buf, err
                if inp is not None:
                    sys.stdin = io.StringIO(inp)
                try:
                    rc = main(["--store", store_path, *argv]) or 0
                except SystemExit as e:
                    rc = e.code if isinstance(e.code, int) else 1
                finally:
                    sys.stdout, sys.stderr, sys.stdin = so, se, sin
                return rc, buf.getvalue() + err.getvalue()
            return _r
        run2 = mk_runner(_ps)
        run2("init")
        run2("add", "action", "--summary", "缓的那个先登记", "--domain", "粒度", "--prio", "缓")
        run2("add", "action", "--summary", "急的后登记", "--domain", "粒度", "--prio", "急")
        _prows = [json.loads(l) for f in sorted((Path(_ps) / "actions").glob("*.jsonl"))
                  for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
        _ji = next(r["id"] for r in _prows if r["summary"] == "急的后登记")
        _huan = next(r["id"] for r in _prows if r["summary"] == "缓的那个先登记")
        _ord = [r["id"] for _k, r, *_ in refill_pool(Store(Path(_ps)))[0]]
        expect("d000108 正控①：池按 prio 排（后登记的「急」排在先登记的「缓」之前）",
               _ord.index(_ji) < _ord.index(_huan), f"急@{_ord.index(_ji)} 缓@{_ord.index(_huan)}")
        # v5.29.0：区读时现算 ⇒ 断言落在**视图**的区段上（不是 exit 文件）
        _hot = run2("view")[1]
        _qseg = _hot.split(QUEUE_BEGIN, 1)[1].split(QUEUE_END, 1)[0] if QUEUE_BEGIN in _hot else ""
        expect("d000108 正控①配套：**现算的**区打的是档名（五档名都在闭集内，非三档前缀残留）",
               f"`{_ji}` 急·" in _qseg and f"`{_huan}` 缓·" in _qseg, _hot[-140:])
        rc2, out2 = run2("add", "action", "--summary", "[高] 还想用前缀", "--domain", "粒度")
        expect("d000108 正控②：add 带档位前缀 ⇒ 拒收并指向 --prio", rc2 != 0 and "--prio" in out2)
        rc2, out2 = run2("edit", _ji, "--summary", "[中] 绕过 add 试试")
        expect("d000108 正控②配套：edit 同样拦（只拦 add 等于留后门）", rc2 != 0 and "--prio" in out2)
        rc2, out2 = run2("add", "action", "--summary", "[高·重定] 旧正则漏的那类", "--domain", "粒度")
        expect("d000108 正控③：`[高·重定]`（旧窄正则漏网⇒静默降档的那类）也被拒",
               rc2 != 0 and "--prio" in out2)
        rc2, out2 = run2("add", "action", "--summary", "[根因] 非档位前缀项", "--domain", "粒度")
        expect("d000108 负控①：非档位前缀放行（`[根因]` 本仓在册，硬拒就是误拒）", rc2 == 0, out2[-70:])
        rc2, out2 = run2("add", "action", "--summary", "别名尝试", "--domain", "粒度", "--prio", "high")
        expect("d000108 负控②：--prio high（别名）⇒ 拒收并列闭集，不做模糊归位",
               rc2 != 0 and "急/高/中/低/缓" in out2)
        rc2, out2 = run2("add", "action", "--summary", "带括号抄来的值", "--domain", "粒度", "--prio", "[高]")
        expect("d000108 负控②配套：`--prio [高]` 同样拒收（闭集就是那五个词，**不剥括号猜其意**）",
               rc2 != 0 and "急/高/中/低/缓" in out2)
        rc2, out2 = run2("add", "action", "--summary", "未指定重要度", "--domain", "粒度")
        expect("d000108 负控③：未给 --prio ⇒ 落中且当场明打印（缺省≠静默）", rc2 == 0 and "未给 --prio" in out2)
        # 造旧库形状：剥掉 prio、一条挂可解析前缀、一条挂**不可解析**前缀
        run2("unseal")
        _pf = sorted((Path(_ps) / "actions").glob("*.jsonl"))[0]
        _rr = [json.loads(l) for l in _pf.read_text(encoding="utf-8").splitlines() if l.strip()]
        for _r in _rr:
            _r.pop("prio", None)
        _rr[0]["summary"] = "[高] 待回填项"
        _rr[1]["summary"] = "【接手第一优先】不可解析项"
        _pf.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in _rr) + "\n",
                       encoding="utf-8")
        # 旧形（前缀解析）算出的次序——回填后必须与它**逐条相同**（保序映射的安全线）。
        # 旧标度是三档 0/1/2；相对次序与新五档一致才构成「保序」，故这里刻意用 PRIO_BASE。
        def _legacy_base(summary: str) -> int:
            # 旧窄语义的忠实复现：括号里**只有一个档位词**才认（`[高·重定]` 当年就漏在这）
            h = _BRACKET_HEAD.match(summary or "")
            if not h:
                return 1
            tok = h.group(2).strip().lower()
            return PRIO_BASE[tok] if tok in PRIO_BASE else 1
        _legacy_ord = [x[2] for x in sorted(
            ((_legacy_base(r.get("summary", "")), r.get("created", ""), r["id"]) for r in _rr))]
        rc2, out2 = run2("check", "--no-log")
        expect("d000108 判据：live 条目无 prio ⇒ prio-source 点名（旧形此处没人知道）",
               rc2 != 0 and "prio-source" in out2, out2[-80:], dim="prio-source")
        rc2, out2 = run2("upgrade-prio")
        _still = _pf.read_text(encoding="utf-8")
        expect("d000108 回填·默认只出计划：一个字节不写", rc2 == 0 and "只出计划" in out2 and "prio" not in _still)
        rc2, out2 = run2("upgrade-prio", "--apply")
        _af = [json.loads(l) for l in _pf.read_text(encoding="utf-8").splitlines() if l.strip()]
        _a0 = next(r for r in _af if r["summary"] == "待回填项")
        _a1 = next(r for r in _af if "不可解析" in r["summary"])
        expect("d000108 回填·可解析前缀：写字段并摘除前缀", _a0["prio"] == "高" and not _a0["summary"].startswith("["))
        expect("d000108 回填·不可解析前缀：**不猜其意**（字段落中、summary 原样、点名人工复核）",
               _a1["prio"] == "中" and _a1["summary"].startswith("【接手第一优先】") and "请人工复核" in out2)
        expect("d000108 回填·保序：新次序与旧前缀算出的次序逐条相同（迁移安全线）",
               [r["id"] for _k, r, *_ in refill_pool(Store(Path(_ps)))[0]] == _legacy_ord,
               f"{_legacy_ord}")
        expect("d000108 回填·备份落 prev/upgrade-prio/（.handoff 不入 git，恢复不能靠 git）",
               (Path(_ps) / "prev" / "upgrade-prio" / _pf.name).is_file())
        rc2, out2 = run2("upgrade-prio")
        expect("d000108 回填·幂等：再跑报『无待回填』", rc2 == 0 and "无待回填" in out2)
        rc2, out2 = run2("check", "--no-log")
        expect("d000108 判据·复绿：回填后 prio-source 不再点名（有牙，但不是恒红）",
               "prio-source" not in out2, out2[-80:])
        # 变异自证：把排序退回读前缀 ⇒ 正控①必须翻面（证明字段真是来源）
        _prows2 = [json.loads(l) for f in sorted((Path(_ps) / "actions").glob("*.jsonl"))
                   for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
        _mut = [x[2] for x in sorted(((_legacy_base(r.get("summary", "")),
                                       r.get("created", ""), r["id"]) for r in _prows2))]
        expect("d000108 变异：排序退回读前缀 ⇒ 正控①翻面（该腿有牙）",
               _mut.index(_ji) > _mut.index(_huan), f"旧形 急@{_mut.index(_ji)} 缓@{_mut.index(_huan)}")

        # ---- v5.9.0 d000109：现态计数不写进散文（写入面拦 ＋ 存在性判据）----
        _ds = tempfile.mkdtemp(prefix="handoff-derivcount.")
        run5 = mk_runner(_ds)
        run5("init")
        _st_bak = (Path(_ds) / "status").read_text(encoding="utf-8")
        # 正控①：写入面拦。**两种形状都要拦**——旧扫描器就是被「live：」后多一个空格判瞎的，
        # 形状变体不放过的判据等于没有判据（这条断言是那次事故的直接回归）。
        # `--force`：这几条都是**一行短内容**，不加强制会先撞上热层的骤降比守卫，
        # 那笔账记不到本判据头上（假失败会被读成实现没修——v5.7.1 的夹具同一条坑）。
        for _shape, _lbl in (("live：actions 1 / pitfalls 1 / closed 1", "紧邻形"),
                            ("live： actions 1 / pitfalls 1 / closed 1", "多一个空格的真形")):
            rc2, out2 = run5("set", "status", "--force", "--file", "-", inp=f"| x | {_shape} |\n")
            expect(f"d000109 正控①-{_lbl}：set status 写现态计数 ⇒ 拒",
                   rc2 != 0 and "不该抄进散文" in out2, out2[-80:])
        expect("d000109 正控·拒写不留痕：status 仍是原内容",
               (Path(_ds) / "status").read_text(encoding="utf-8") == _st_bak)
        # 正控②：append 那条写路同样得罩（只拦 set＝留一条绕过守卫的门）
        rc2, out2 = run5("append", "exit", inp="## 现态\n- live：actions 1 / pitfalls 1 / closed 1\n")
        expect("d000109 正控②：append 同样拦（写路两点齐全，不是只堵 set）",
               rc2 != 0 and "不该抄进散文" in out2, out2[-80:])
        # 负控①：同行带日期＝历史快照 ⇒ 放行（把当年的取证数删掉是篡改历史，不是治理）
        rc2, out2 = run5("set", "status", "--force", "--file", "-",
                         inp="| 实况（10-18 现算） | live：actions 1 / pitfalls 1 / closed 1 |\n")
        expect("d000109 负控①：同行有日期 ⇒ 按历史快照放行", rc2 == 0, out2[-80:])
        # 负控②：只有**一个**槽名＋数字 ⇒ 放行（阈值 ≥2，不然「actions 4 条待办」这类顺带引用全被误伤）
        rc2, out2 = run5("set", "status", "--force", "--file", "-",
                         inp="| 现态 | actions 还剩若干条，见 index |\n")
        expect("d000109 负控②：无「≥2 槽名＋数字」⇒ 放行", rc2 == 0, out2[-80:])
        # 负控③：指路语（本判据要求的正解）不得被拦——判据报错给的修法必须真能执行（p000044）
        rc2, out2 = run5("set", "status", "--force", "--file", "-",
                         inp="| 本仓 `.handoff/` | 现态以 `handoff index`／`handoff view` 实算为准 |\n")
        expect("d000109 负控③：指路语放行（报错里给的修法自己能写进去）", rc2 == 0, out2[-80:])
        # 负控④：**面边界**——本判据只管散文文本槽，条目字段不在面内（`scope` 更压根
        # 不走 `set`：它只收 `scope add/remove/prune`，面外之物无从写）
        rc2, out2 = run5("add", "pitfall", "--summary", "实况：actions 1 / pitfalls 1", "--domain", "d")
        expect("d000109 负控④：条目 summary 不在面内（判据只管散文文本槽）", rc2 == 0, out2[-80:])
        # M5（t000314）：锚点＋数字+汉字（允许中间空白），同行无日期/取证语。
        rc2, out2 = run5("set", "status", "--force", "--file", "-",
                         inp="| 现态 | 2 中待办 |\n")
        expect("t000314 正控 M5：锚点＋数字+汉字 ⇒ 拒写",
               rc2 != 0 and "不该抄进散文" in out2, out2[-80:])
        rc2, out2 = run5("set", "status", "--force", "--file", "-",
                         inp="| 现态 | 实算 2 中待办 |\n")
        expect("t000314 负控 M5：同行带取证语（实算）⇒ 放行", rc2 == 0, out2[-80:])
        rc2, out2 = run5("set", "status", "--force", "--file", "-",
                         inp="| 实况（10-18） | 2 中待办 |\n")
        expect("t000314 负控 M5：同行带日期 ⇒ 放行", rc2 == 0, out2[-80:])
        rc2, out2 = run5("set", "status", "--force", "--file", "-",
                         inp="| 现态 | 7 条待办 |\n")
        expect("t000314 正控 M5：数字与汉字间有空白（7 条）也命中", rc2 != 0, out2[-80:])
        rc2, out2 = run5("set", "status", "--force", "--file", "-",
                         inp="| 其它 | 7 条待办 |\n")
        expect("t000314 负控 M5：无锚点 ⇒ 不判（M4 宽形会制造淹没）", rc2 == 0, out2[-80:])
        # 判据面：手塞一行（模拟「守卫上线前就写进去」的存量）⇒ check 必须点名到行
        run5("unseal")
        (Path(_ds) / "status").write_text("| x | live： actions 9 / pitfalls 9 / closed 9 |\n",
                                          encoding="utf-8")
        rc2, out2 = run5("check", "--no-log")
        expect("d000109 判据：散文里存着现态计数 ⇒ derived-counts 点名到行（旧形此处没人知道）",
               rc2 != 0 and "derived-counts" in out2, out2[-90:], dim="derived-counts")
        rc2, out2 = run5("set", "status", "--force", "--file", "-",
                         inp="| 本仓 | 现态以 `handoff index` 实算为准 |\n")
        rc2, out2 = run5("check", "--no-log")
        expect("d000109 判据·复绿：改成指路语后不再点名（有牙，但不是恒红）",
               "derived-counts" not in out2, out2[-90:])
        # 变异自证：① 拆掉「≥2」阈值 ⇒ 单槽名负控转红；② 拆掉日期放行 ⇒ 历史快照正控转红
        import inspect as _insp4              # noqa: PLC0415 — 仅 selftest 用
        _src = _insp4.getsource(derived_count_hits)
        for _mut_lbl, _from, _to, _probe, _want in (
                ("拆掉 ≥2 阈值 ⇒ 单槽名行也被判（该腿有牙）",
                 "len(SLOT_COUNT_RE.findall(line)) >= 2", "len(SLOT_COUNT_RE.findall(line)) >= 1",
                 "| 现态 | actions 1 |\n", 1),
                ("拆掉日期放行 ⇒ 历史快照也被判（该腿有牙）",
                 "if DATE_MARK_RE.search(line):", "if False:",
                 "| 实况（10-18 现算） | live：actions 1 / pitfalls 1 |\n", 1)):
            _ns = dict(globals())
            exec(_src.replace(_from, _to), _ns)                    # noqa: S102 — 自证：跑改过的源码
            _got = 1 if _ns["derived_count_hits"](_probe) else 0
            expect(f"d000109 变异：{_mut_lbl}", _got == _want, f"实得 {_got}，期望 {_want}")
        shutil.rmtree(_ds, ignore_errors=True)

        # ---- v5.10.0 d000110：落盘自由文本必须有不经 shell 的入口 ----
        _xs = tempfile.mkdtemp(prefix="handoff-shellfree.")
        run6 = mk_runner(_xs)
        run6("init")
        rc2, out2 = run6("add", "action", "--summary", "待关的那条", "--domain", "d")
        _xid = out2.split("id=")[1].strip().split()[0]
        _ocf = Path(_xs) / "oc.txt"
        _ocf.write_text("outcome=修好了 `guard_derived_counts` 与 `check` 两处，细节见 `handoff index`\n",
                        encoding="utf-8")
        # 正控①：**本轮事故的确切形状**——带反引号的长文本走 --from-file，逐字入库。
        # 旧形（只能走 argv）里这两处反引号会被 bash 当命令替换执行掉，落库少了两个名字且零报错。
        rc2, out2 = run6("close", _xid, "--from-file", str(_ocf))
        _closed = [json.loads(l) for l in (Path(_xs) / "closed" / "t.jsonl").read_text(encoding="utf-8").splitlines()
                   if l.strip()]
        expect("d000110 正控①：close --from-file 里的反引号**逐字**入库（不经 shell ⇒ 无从被展开）",
               rc2 == 0 and "`guard_derived_counts`" in _closed[0]["outcome"]
               and "`handoff index`" in _closed[0]["outcome"], _closed[0]["outcome"][:70])
        # 正控②：unconfirmed 的 summary/detail 同理（这两条字段也会落盘）
        _ucf = Path(_xs) / "uc.txt"
        _ucf.write_text("summary=候选 `scripts/x.py` 的口径\ndetail=见 `handoff check` 的输出\n", encoding="utf-8")
        rc2, out2 = run6("unconfirmed", "add", "--from-file", str(_ucf))
        _uc = [json.loads(l) for l in (Path(_xs) / "unconfirmed.jsonl").read_text(encoding="utf-8").splitlines()
               if l.strip()]
        expect("d000110 正控②：unconfirmed add --from-file 同样逐字入库",
               rc2 == 0 and "`scripts/x.py`" in _uc[0]["summary"] and "`handoff check`" in _uc[0]["detail"],
               out2[-70:])
        # 正控③：flag 与 --from-file 同时给同一字段 ⇒ 报错，不静默取一个（与 add／edit 同规）
        rc2, out2 = run6("add", "action", "--summary", "命令行版的", "--from-file", str(_ocf), "--domain", "d")
        expect("d000110 正控③·配套：文件里的字段与本型不匹配 ⇒ 当场报错（不静默丢弃）",
               rc2 != 0 and "outcome" in out2, out2[-90:])
        rc2, out2 = run6("unconfirmed", "add", "--summary", "命令行版的", "--from-file", str(_ucf))
        expect("d000110 正控④：同一字段两处都给 ⇒ 拒（静默取一个是本 CLI 的老病）",
               rc2 != 0 and "同时出现" in out2, out2[-90:])
        # 判据腿：**真实的 parser 树**是输入——每条收落盘长文本的子命令都得有 file 入口
        _viol = audit_shell_free_inputs()
        expect("d000110 判据：参数面自证当前合（每条收长文本的子命令都有不经 shell 的入口）",
               _viol == [], str(_viol))
        # 面边界：`confirm --answers` 不落盘（S5 运行时、不入盘）⇒ 自证**不该**要求它，
        # 否则判据会逼着给一个无从损坏的入口加一条无用 flag（扩大判定面＝新增误伤面）
        _cdests = dict(walk_parsers(build_parser()))["handoff confirm"]
        expect("d000110 面边界：answers 不在 LONG_TEXT_DESTS 内（不落盘的入口不强求 file 形）",
               "answers" in _cdests and "answers" not in LONG_TEXT_DESTS)
        # 判据腿（本轮实测出的**门禁偶发假红**）：维护态是「某个库」的属性，不是进程的属性。
        # 旧形把 `unseal` 记成进程级布尔 ⇒ 夹具在临时库上跑一次 unseal，外层真库的 finally 就
        # 以为「本次留门」不回封 ⇒ 下一班接手跑 `handoff check` 必红一次、再跑才自愈。
        # 正控必须用**子进程**跑：夹具里的 `run()` 带着 `HANDOFF_SELFTEST_SUB=1`，嵌套命令本来
        # 就不回封（那是刻意的，免得夹具与自己打架），在本进程里判「回封没回封」恒为假。
        # 子进程里连做四步：建 A、建 B、对 B `unseal`、对 A 跑一条命令 ⇒ A 该被回封、B 该留门。
        _ys = tempfile.mkdtemp(prefix="handoff-seal.")
        _code = ("import sys; sys.path.insert(0, sys.argv[1]); import handoff as h; "
                 "h.main(['--store', sys.argv[2], 'init']); "
                 "h.main(['--store', sys.argv[3], 'init']); "
                 "h.main(['--store', sys.argv[3], 'unseal']); "
                 "h.main(['--store', sys.argv[2], 'index'])")
        import subprocess as _sp6                   # noqa: PLC0415 — 仅夹具用
        # **必须清掉 `HANDOFF_SELFTEST_SUB`**：夹具进程带着它（嵌套命令靠它跳过回封），
        # 子进程继承 env 就会连「回封」这条真实路径一起跳掉——第一版就是这么假失败的
        # （判据看着没牙，其实是夹具把被测行为关掉了）。
        _env6 = {k: v for k, v in os.environ.items() if k != "HANDOFF_SELFTEST_SUB"}
        # **`-B`：禁写字节码**。这两条腿把本脚本当模块 import（`import handoff as h`）——
        # 不加 `-B` 时解释器会在 **技能源目录** 写 `__pycache__/handoff.cpython-*.pyc`
        # （1MB），随后 rsync 分发到各项目拷贝 ⇒ 分发件里混进构建垃圾
        # （2026-10-28 实测：每次 full selftest 都把它写回来，删了又长）。
        _r6 = _sp6.run([sys.executable, "-B", "-c", _code, str(Path(__file__).resolve().parent),
                        f"{_ys}/A", f"{_ys}/B"], capture_output=True, text=True, timeout=120, env=_env6)
        expect("d000110 正控：对 B 库 unseal 之后，对 A 库跑命令**仍自动回封**（旧形在这儿会留下可写位，"
               "下一班接手必报一次 `sealed` 假红）",
               _r6.returncode == 0 and store_sealed(Path(_ys) / "A") and not store_sealed(Path(_ys) / "B"),
               f"rc={_r6.returncode} A回封={store_sealed(Path(_ys) / 'A')} B留门={not store_sealed(Path(_ys) / 'B')} "
               + (_r6.stderr or "")[-120:])
        # 变异自证：把外层库记进维护态（＝旧形的等效后果）⇒ 回封必须被跳过（证明那条绿真是路径判定在管）
        _outer = str(Path(cur_store[0]).resolve())
        _STAY_UNSEALED.add(_outer)
        try:
            run("index")
            _still_writable = not store_sealed(Path(cur_store[0]))
        finally:
            _STAY_UNSEALED.discard(_outer)
            seal_store(Path(cur_store[0]))
        expect("d000110 变异②：外层被记为维护态 ⇒ finally 跳过回封（旧形的后果，该腿有牙）", _still_writable)
        # 变异自证：从 parser 里摘掉 close 的 --from-file ⇒ 自证必须点名（证明那条绿不是恒绿）
        import argparse as _ap4                     # noqa: PLC0415 — 仅夹具用
        _ap = build_parser()
        _sp = next(x for x in _ap._actions if isinstance(x, _ap4._SubParsersAction))
        _sp.choices["close"]._remove_action(
            next(a for a in _sp.choices["close"]._actions if a.dest == "from_file"))
        _mv = audit_shell_free_inputs(_ap)
        expect("d000110 变异：摘掉 close 的 --from-file ⇒ 自证点名该子命令（该腿有牙）",
               any("handoff close" in v for v in _mv), str(_mv))
        shutil.rmtree(_xs, ignore_errors=True)

        # ---- v5.11.0 d000111：严重度词表消歧 ＋ 回填读宽判形 ----
        _vt = tempfile.mkdtemp(prefix="handoff-sev.")
        run7 = mk_runner(_vt)
        run7("init")
        # 正控①：`[高危]` 是**标注**、不是档位前缀 ⇒ 放行；裸档位词 `[中]` 仍拒。
        # 这一条钉的就是跨仓那 48 条的语义：一刀切「以档位词开头就拒」会把严重度一起删掉。
        rc2, out2 = run7("add", "pitfall", "--summary", "[高危] 外派席 rc=0 静默空回", "--domain", "sev")
        expect("d000111 正控①：pitfall 写 `[高危] …` 放行（与排序词表不相交）", rc2 == 0, out2[-80:])
        rc2, out2 = run7("add", "pitfall", "--summary", "[中] 想写严重度却用了档位词", "--domain", "sev")
        expect("d000111 正控①配套：裸档位词形仍拒，且报错把两条去路都指出来",
               rc2 != 0 and "--prio" in out2 and "高危" in out2, out2[-120:])
        # 造旧库形状（回填腿要的是**存量**，新写已经造不出这些形了）
        run7("unseal")
        (Path(_vt) / "actions" / "_global.jsonl").write_text(
            json.dumps({"id": "t000901", "created": "2026-01-01",
                        "summary": "[高·用户自持，勿催] CC 到期不续：有变化由用户通知"},
                       ensure_ascii=False) + "\n" +
            json.dumps({"id": "t000902", "created": "2026-01-02", "summary": "[低] 普通档位"},
                       ensure_ascii=False) + "\n", encoding="utf-8")
        (Path(_vt) / "pitfalls" / "sev.jsonl").write_text(
            (Path(_vt) / "pitfalls" / "sev.jsonl").read_text(encoding="utf-8").rstrip() + "\n" +
            json.dumps({"id": "p000901", "created": "2026-01-01", "summary": "[中] 网关按载荷形状拒收时别试 env 开关"},
                       ensure_ascii=False) + "\n" +
            json.dumps({"id": "p000902", "created": "2026-01-01", "summary": "[急] 这条没有严重度对应词"},
                       ensure_ascii=False) + "\n", encoding="utf-8")
        _before_a = (Path(_vt) / "actions" / "_global.jsonl").read_text(encoding="utf-8")
        rc2, out2 = run7("upgrade-prio")
        _before_p = (Path(_vt) / "pitfalls" / "sev.jsonl").read_text(encoding="utf-8")
        expect("d000111 判据：默认只出计划、**一个字节不写**（actions 与标注改写分开计数）",
               rc2 == 0 and "只出计划" in out2
               and (Path(_vt) / "actions" / "_global.jsonl").read_text(encoding="utf-8") == _before_a
               and _before_p == (Path(_vt) / "pitfalls" / "sev.jsonl").read_text(encoding="utf-8"),
               out2[-110:])
        rc2, out2 = run7("upgrade-prio", "--apply")
        _ar = [json.loads(l) for l in (Path(_vt) / "actions" / "_global.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
        _a1 = next(r for r in _ar if r["id"] == "t000901")
        # 正控②：**这一条就是 t000278 那一枪的回归**——上一版把 `[高·限定语]` 判「不可解析」，
        # 悄悄把作者标的高降成默认中；现在读宽判形，档位词进字段、限定语留在 summary。
        expect("d000111 正控②：`[高·用户自持，勿催]` ⇒ prio=高（**不静默降档**）且限定语留在 summary",
               _a1["prio"] == "高" and _a1["summary"].startswith("[用户自持，勿催]")
               and "勿催" in _a1["summary"], f"{_a1['prio']}｜{_a1['summary']}")
        _pr = [json.loads(l) for l in (Path(_vt) / "pitfalls" / "sev.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
        _p1 = next(r for r in _pr if r["id"] == "p000901")
        _p2 = next(r for r in _pr if r["id"] == "p000902")
        expect("d000111 正控③：pitfall 存量做**保义**改写 `[中]`→`[中危]`（不是剥掉）",
               _p1["summary"].startswith("[中危]"), _p1["summary"])
        expect("d000111 正控③配套：`[急]` 没有严重度对应词 ⇒ **不猜**、原文不动、点名",
               _p2["summary"].startswith("[急]") and "p000902" in out2, f"{_p2['summary']}｜{out2[-90:]}")
        expect("d000111 面边界：actions 有 prio、pitfall 无 prio 字段（改写只动 summary）",
               all("prio" in r for r in _ar) and "prio" not in _p1)
        rc2, out2 = run7("upgrade-prio")
        expect("d000111 幂等：改完再跑报「无待回填」（`[高危]` 不再是档位前缀）",
               rc2 == 0 and "无待回填" in out2, out2[-80:])
        rc2, out2 = run7("check", "--no-log")
        expect("d000111 判据·复绿：改写后 prio-source 与形状都不再点名", rc2 == 0 or "prio-source" not in out2,
               out2[-90:])
        # 面边界（判据不扩到非通道面）：pitfall 留着档位前缀**不该**让 check 红——它不是排序来源；
        # 收口靠 `upgrade-prio` 的计划输出，不靠把判据铺到没有通道的槽上。
        run7("unseal")
        _pf7 = Path(_vt) / "pitfalls" / "sev.jsonl"
        _pf7.write_text(_pf7.read_text(encoding="utf-8") + "\n" + json.dumps(
            {"id": "p000903", "created": "2026-01-01", "summary": "[低] 又一条旧形"}, ensure_ascii=False) + "\n",
            encoding="utf-8")
        rc2, out2 = run7("check", "--no-log")
        expect("d000111 面边界：pitfall 的档位前缀**不判红**（判据只管 live actions 的通道）",
               "prio-source" not in out2, out2[-90:])
        # 变异自证：把词元查表退回「以档位词开头」⇒ `[高危]` 会被当成档位前缀（正控①必须翻面）
        _ns7 = dict(globals())
        exec("def tier_head(summary):\n"
             "    m = _BRACKET_HEAD.match(summary or '')\n"
             "    if not m: return None\n"
             "    return m.groups() if re.match(r'^\\s*[\\[\\u3010]\\s*(急|高|中|低|缓)', summary or '') else None\n",
             _ns7)                                       # noqa: S102 — 自证：跑改过的实现
        # （`exec` 出来的实现读的是**自己那份** globals，所以这里调它自己的 `tier_head`；
        #  若调 `_ns7["is_tier_prefix"]`，那个函数对象的 `__globals__` 仍指着真模块＝变异不生效。）
        _mut_hit = _ns7["tier_head"]("[高危] 外派席 rc=0") is not None
        expect("d000111 变异：判法退回「括号以档位词开头」⇒ `[高危]` 被误判为档位前缀（该腿有牙）",
               _mut_hit and not is_tier_prefix("[高危] 外派席 rc=0"))
        shutil.rmtree(_vt, ignore_errors=True)

        # ---- v5.12.0 d000112：裁定件的 status 出口 ＋ 待追认判据 ＋ 裁定件进对账面 ----
        _dt = tempfile.mkdtemp(prefix="handoff-dec.")
        run8 = mk_runner(_dt)
        run8("init")
        _d1 = Path(_dt) / "decisions" / "d000001.md"
        run8("add", "decision", "--title", "待拍板的那条", "--body", "## Context\n正文 A",
             "--status", "proposed", "--topic", "d112")
        _dp = _d1.read_text(encoding="utf-8")
        rc2, out2 = run8("check", "--no-log")
        expect("d000112 正控①：`proposed` 裁定 ⇒ 红，且报错**自带一条命令的修法**",
               rc2 != 0 and "待所有者追认" in out2
               and "handoff decide d000001 --status" in out2, out2[-120:], dim="decision-pending")
        # 判据①：**只改 status 一行**——id／created／正文逐字不动。重登丢的正是前两样，
        # 而它们是「这条裁定是哪天定的」的唯一证据。
        rc2, out2 = run8("decide", "d000001", "--status", "accepted")
        _da = _d1.read_text(encoding="utf-8")
        _strip = lambda s: "\n".join(ln for ln in s.splitlines() if not ln.startswith("status:"))
        expect("d000112 判据①：decide 之后除 status 行外**逐字未动**（id／created／正文）",
               rc2 == 0 and _strip(_dp) == _strip(_da)
               and "status: accepted" in _da and "正文 A" in _da,
               _da.replace("\n", "⏎")[:120])
        rc2, out2 = run8("check", "--no-log")
        expect("d000112 判据①配套：追认后 `check` 复绿", rc2 == 0, out2[-100:])
        # 负控①：空转被拒（否则每次「追认」都会刷新写事件、造一条「动过」的痕迹）
        rc2, out2 = run8("decide", "d000001", "--status", "accepted")
        expect("d000112 负控①：同一状态重跑被拒（空转不许刷痕迹）",
               rc2 != 0 and "无事可做" in out2, out2[-80:])
        # 负控②：`decide` 只对 d 型；条目有自己那条路（edit／close），报错必须指出去
        run8("add", "action", "--summary", "不是裁定件的活", "--prio", "高")
        rc2, out2 = run8("decide", "t000001", "--status", "accepted")
        expect("d000112 负控②：非 d 型 id 被拒且指向 `edit`／`close`",
               rc2 != 0 and "edit" in out2 and "close" in out2, out2[-110:])
        # 判据②：**裁定件进写事件对账面**——此前手改 status 无闸可抓，`decide` 的
        # 「唯一写路径」只是声明。这一腿把它钉成事实：手改 ⇒ `writes` 维点名该文件。
        # **另起一个库**：手改会永久留一条 `pre_tamper` 记录（那是设计——补手续的痕迹
        # 追不回来），留在同一个库里会把后面所有「check 复绿」的腿一起染红。
        _dt2 = tempfile.mkdtemp(prefix="handoff-dec2.")
        run9 = mk_runner(_dt2)
        run9("init")
        run9("add", "decision", "--title", "对账面那件", "--body", "b", "--status", "accepted")
        _d2 = Path(_dt2) / "decisions" / "d000001.md"
        _d2a = _d2.read_text(encoding="utf-8")
        run9("unseal")
        _d2.write_text(_d2a.replace("status: accepted", "status: rejected"), encoding="utf-8")
        rc2, out2 = run9("check", "--no-log")
        expect("d000112 判据②：手改裁定件的 status ⇒ `writes` 维报「未经 CLI 记录的写入」",
               rc2 != 0 and "decisions/d000001.md" in out2 and "未经 CLI 记录的写入" in out2,
               out2[-130:])
        run9("decide", "d000001", "--status", "superseded")
        rc2, out2 = run9("check", "--no-log")
        expect("d000112 判据②配套：decide 之后**哈希**红消失（改写只经 CLI 写面；"
               "pre_tamper 那条按设计留着——补手续的时间窗追不回来）",
               "未经 CLI 记录的写入" not in out2 and "在 decide 写入**之前**" in out2, out2[-140:])
        shutil.rmtree(_dt2, ignore_errors=True)
        # 面边界：status 改了**不等于**被挡的条目自动回池——入池第三道谓词读的是
        # 「在册且未被别的裁定 supersedes」，不读 status。误以为会回池＝另一类假称。
        run8("edit", "t000001", "--blockedBy", "d000001")
        rc2, out2 = run8("decide", "d000001", "--status", "rejected")
        expect("d000112 面边界：改 status 时点名仍 blockedBy 的条目与正确解法",
               rc2 == 0 and "t000001" in out2 and "supersedes" in out2, out2[-140:])
        run8("close", "t000001", "--outcome", "夹具收尾")   # 别把未销账条目留给后面的复绿腿
        # 变异自证：谓词改成「任何 status 都算待追认」⇒ 已追认的件也被点名，
        # 证明那条红是**判 status** 得来的，不是「文件存在就红」。
        _real_dp = decision_pending
        try:
            globals()["decision_pending"] = lambda fm: True
            rc2, out2 = run8("check", "--no-log")
        finally:
            globals()["decision_pending"] = _real_dp
        expect("d000112 变异：谓词改成「一律待追认」⇒ 已 rejected 的件也被点名（该腿有牙）",
               rc2 != 0 and "待所有者追认" in out2, out2[-90:])
        rc2, out2 = run8("check", "--no-log")
        expect("d000112 变异还原：真谓词下 `check` 复绿", rc2 == 0, out2[-100:])
        shutil.rmtree(_dt, ignore_errors=True)

        # ---- t000313：decide --freezes（「冻结」的写入面） ----
        _dz = tempfile.mkdtemp(prefix="handoff-freeze.")
        runz = mk_runner(_dz)
        runz("init")
        runz("add", "decision", "--title", "冻结那条", "--body", "b", "--status", "proposed")
        runz("add", "action", "--summary", "甲", "--prio", "高", "--domain", "d")
        runz("add", "action", "--summary", "乙", "--prio", "高", "--domain", "d")
        rc2, out2 = runz("decide", "d000001", "--status", "accepted",
                         "--freezes", "t000001", "t000002")
        expect("t000313 正控：decide --freezes 同批写 blockedBy",
               rc2 == 0 and "t000001" in out2, out2[-100:])
        _rows = [json.loads(l) for l in
                 (Path(_dz) / "actions" / "d.jsonl").read_text(encoding="utf-8").splitlines()
                 if l.strip()]
        expect("t000313 正控：两条 action 的 blockedBy 指向本裁定",
               len(_rows) == 2 and all(r.get("blockedBy") == "d000001" for r in _rows),
               str([(r["id"], r.get("blockedBy")) for r in _rows]))
        rc2, out2 = runz("next", "--auto")
        expect("t000313 正控：冻结后补位池为空（不再把冻结条目顶到队首）",
               "已清空" in out2, out2[-100:])
        runz("add", "decision", "--title", "另一条", "--body", "b", "--status", "proposed")
        rc2, out2 = runz("decide", "d000002", "--status", "accepted",
                         "--freezes", "d000001")
        expect("t000313 负控：--freezes 点名非 action ⇒ 拒写",
               rc2 != 0 and "不是 live action" in out2, out2[-100:])
        runz("add", "decision", "--title", "第三条", "--body", "b", "--status", "proposed")
        rc2, out2 = runz("decide", "d000003", "--status", "rejected",
                         "--freezes", "t000001")
        expect("t000313 负控：--status 非 accepted 不得 --freezes",
               rc2 != 0 and "只能挂在 accepted" in out2, out2[-100:])
        shutil.rmtree(_dz, ignore_errors=True)

        # ---- t000376／d000123：decision-prose（凡落裁定必走裁定件） ----
        # 判据机制随件、形态表跟库：store 同级 handoff-ruling-forms.txt，五区字面串。
        _dp_base = Path(tempfile.mkdtemp(prefix="handoff-ruling."))
        run_dp = mk_runner(str(_dp_base / ".handoff"))
        run_dp("init")
        _dp_forms = _dp_base / "handoff-ruling-forms.txt"
        _dp_forms.write_text(
            "[topic]\n裁定\n裁决\n"
            "[pending]\n待裁定\n候裁\n"
            "[record]\n用户裁定\nowner 裁定\n裁定：\n已裁\n"
            "[skip]\n裁定件\n裁定文件\n"
            "[reference]\n照原裁定\n该裁定\n",
            encoding="utf-8")
        run_dp("add", "decision", "--title", "已立的那条", "--body", "b", "--status", "accepted")
        run_dp("set", "exit", inp="- 用户裁定：按 d000001 执行\n")
        rc2, out2 = run_dp("check", "--no-log")
        expect("t000376 正控：record 形态带在册 d 号 ⇒ 不报 decision-prose",
               "decision-prose" not in out2, out2[-120:])
        run_dp("set", "exit", "--force", inp="- 用户裁定：审计报告合规不属本仓门禁\n")
        rc2, out2 = run_dp("check", "--no-log")
        expect("t000376 正控：record 形态无 d 号 ⇒ decision-prose 红（10-19 只落散文的病根）",
               rc2 != 0 and "decision-prose" in out2, out2[-160:], dim="decision-prose")
        run_dp("set", "exit", "--force", inp=(
            "## 用户裁定退役（标题行不算记录）\n"
            "- 待裁定：这一条等拍板\n"
            "- 另见裁定件（复合名词）\n"
            "- 照原裁定不动（引用形态，只提示）\n"))
        rc2, out2 = run_dp("check", "--no-log")
        expect("t000376 负控：标题／待裁／复合名词／引用形态都不判红",
               rc2 == 0 and "decision-prose：" not in out2, out2[-160:])
        expect("t000376 负控配套：引用形态确实进了提示（不静默放过）",
               "引用" in out2 and "只报不拦" in out2, out2[-160:])
        _dp_forms.unlink()
        rc2, out2 = run_dp("check", "--no-log")
        expect("t000376 面边界：形态表不存在 ⇒ 本维不启用（病句也不红）",
               "decision-prose" not in out2, out2[-120:])
        _dp_forms.write_text("[topic]\n裁定\n[skip]\n待裁定\n", encoding="utf-8")
        rc2, out2 = run_dp("check", "--no-log")
        expect("t000376 配置负控：形态表缺 [record] 区 ⇒ 红（不静默失能）",
               rc2 != 0 and "decision-prose" in out2, out2[-140:])
        _dp_forms.write_text(
            "[topic]\n裁定\n[record]\n用户裁定\n[skip]\n裁定件\n"
            "[reference]\n照原裁定\n", encoding="utf-8")
        run_dp("set", "exit", "--force", inp="- 用户裁定：审计报告合规不属本仓门禁\n")
        _real_lrf = load_ruling_forms
        try:
            globals()["load_ruling_forms"] = lambda root: (
                {"topic": ["裁定"], "pending": [], "record": [], "skip": [], "reference": []},
                None)
            rc2, out2 = run_dp("check", "--no-log")
        finally:
            globals()["load_ruling_forms"] = _real_lrf
        expect("t000376 变异：摘掉 [record] 形态 ⇒ 同一病句转绿（该腿有牙）",
               rc2 == 0 and "decision-prose：" not in out2, out2[-120:])
        # t000378：裁决族与裁定族同一把尺——record 形态必须带号；分组标签入 skip。
        _dp_forms.write_text(
            "[topic]\n裁定\n裁决\n"
            "[pending]\n待裁定\n"
            "[record]\n用户裁定\n用户裁决\n"
            "[skip]\n裁定件\nowner 裁决另列\n"
            "[reference]\n照原裁定\n",
            encoding="utf-8")
        run_dp("set", "exit", "--force", inp="- owner 裁决另列：条目清单见下\n")
        rc2, out2 = run_dp("check", "--no-log")
        expect("t000378 负控：owner 裁决另列（分组标签）⇒ 不判红",
               rc2 == 0 and "decision-prose：" not in out2, out2[-160:])
        run_dp("set", "exit", "--force", inp="- 用户裁决：审计报告重出节奏按慢车道\n")
        rc2, out2 = run_dp("check", "--no-log")
        expect("t000378 正控：裁决族 record 形态无 d 号 ⇒ 红（换字不再能洗白）",
               rc2 != 0 and "decision-prose" in out2, out2[-160:])
        shutil.rmtree(_dp_base, ignore_errors=True)

        # ---- v5.12.0 d000113：长度闸必须吃「最终值」——三条写路各钉一双路腿 ----
        # 起因是**我自己踩出来的**：本会话用 `add pitfall --from-file` 写了 400 字的
        # summary，畅通无阻；而 SKILL.md 明写「条目 summary ≤120 字……超限即拒」。
        # 根因＝`guard_len` 跑在 `--from-file` 合并**之前**，于是「不经 shell 的入口」
        # 把闸整个绕开。同一形状在 `close`（空 outcome 也能从文件溜进来，p000051 那个洞
        # 在 from-file 面重开）、在 `unconfirmed`（**两条路都没闸**）上各有一份。
        _d3 = tempfile.mkdtemp(prefix="handoff-cap.")
        run10 = mk_runner(_d3)
        run10("init")
        _long = "长" * 300
        Path(_d3 + "/long.txt").write_text("summary=" + _long + "\n", encoding="utf-8")
        rc2, out2 = run10("add", "pitfall", "--from-file", _d3 + "/long.txt", "--domain", "cap")
        expect("d000113 正控①：--from-file 的超长 summary 必须**拒**（旧形畅通无阻＝假称）",
               rc2 != 0 and "120" in out2, out2[-100:])
        rc2, out2 = run10("add", "pitfall", "--summary", _long, "--domain", "cap")
        expect("d000113 正控②：argv 路径同样拒（回归基线，证明闸本身在）", rc2 != 0, out2[-80:])
        Path(_d3 + "/b120.txt").write_text("summary=" + "边" * SUMMARY_CAP + "\n", encoding="utf-8")
        Path(_d3 + "/b121.txt").write_text("summary=" + "边" * (SUMMARY_CAP + 1) + "\n", encoding="utf-8")
        rc2, _o = run10("add", "pitfall", "--from-file", _d3 + "/b120.txt", "--domain", "cap")
        rc3, o3 = run10("add", "pitfall", "--from-file", _d3 + "/b121.txt", "--domain", "cap")
        expect("d000113 边界腿：恰 120 过、121 拒（闸是活的，不是恒拒）",
               rc2 == 0 and rc3 != 0, f"120→rc{rc2}｜121→rc{rc3} {o3[-70:]}")
        # close：空与超长都从 --from-file 溜过去过
        run10("add", "action", "--summary", "待关的活", "--prio", "中", "--domain", "cap")
        _tid = json.loads((Path(_d3) / "actions" / "cap.jsonl").read_text(encoding="utf-8").splitlines()[0])["id"]
        Path(_d3 + "/empty.txt").write_text("outcome=\n", encoding="utf-8")
        rc2, out2 = run10("close", _tid, "--from-file", _d3 + "/empty.txt")
        expect("d000113 正控③：--from-file 的**空** outcome 必须拒（p000051 那个洞不许在文件面重开）",
               rc2 != 0, out2[-90:])
        Path(_d3 + "/o401.txt").write_text("outcome=" + "答" * (OUTCOME_CAP + 1) + "\n", encoding="utf-8")
        Path(_d3 + "/o400.txt").write_text("outcome=" + "答" * OUTCOME_CAP + "\n", encoding="utf-8")
        rc2, _o = run10("close", _tid, "--from-file", _d3 + "/o401.txt")
        expect("d000113 正控④：--from-file 的 outcome 超 400 字 ⇒ 拒", rc2 != 0, _o[-80:])
        rc2, out2 = run10("close", _tid, "--from-file", _d3 + "/o400.txt")
        expect("d000113 边界腿②：恰 400 字放行（同上，不许恒拒）", rc2 == 0, out2[-80:])
        # unconfirmed：此前两条路都不限长
        rc2, out2 = run10("unconfirmed", "add", "--summary", _long)
        expect("d000113 正控⑤：unconfirmed 的 summary 长度闸（这一槽原先**根本没有**）",
               rc2 != 0 and "120" in out2, out2[-90:])
        Path(_d3 + "/u_long.txt").write_text("summary=" + _long + "\n", encoding="utf-8")
        rc2, _o = run10("unconfirmed", "add", "--from-file", _d3 + "/u_long.txt")
        expect("d000113 正控⑥：unconfirmed 走 --from-file 同样拒", rc2 != 0, _o[-80:])
        # 变异自证：把 add 的 guard_len 摘掉 ⇒ from-file 超长必须转绿（证明那几条腿真有牙）
        _real_gl = globals()["guard_len"]
        try:
            globals()["guard_len"] = lambda *a, **k: None
            rc2, _o = run10("add", "pitfall", "--from-file", _d3 + "/long.txt", "--domain", "cap")
        finally:
            globals()["guard_len"] = _real_gl
        expect("d000113 变异：摘掉守卫 ⇒ 同一发 from-file 转绿（该腿有牙，非恒红）", rc2 == 0,
               f"rc={rc2}")
        shutil.rmtree(_d3, ignore_errors=True)

        # ---- shell 危险字符：提示 ＋ 写后回读 ＋ `--from-file`（4.7.7/4.7.9）----
        rc2, out2 = run("add", "pitfall", "--summary", "内联反引号", "--domain", "d",
                        "--detail", "见 `ls -la`")
        # **不再硬拒**：CLI 无法区分「双引号已被展开」与「单引号本就安全」——值到达
        # 时两者形态相同。硬拒必然误拒单引号，而该抓的那批值里已无反引号、也抓不到。
        expect("内联含反引号**不再硬拒**（单引号是安全写法，不该被误拒）", rc2 == 0,
               out2[-160:])
        expect("但会提示「若你用了双引号…」", "若你用了双引号" in out2)
        expect("写后**回读**显示落盘值（被吃掉当场可见，不靠猜）",
               "回读" in out2 and "ls -la" in out2)
        rc2, out2 = run("add", "pitfall", "--summary", "内联变量", "--domain", "d",
                        "--detail", "见 $HOME")
        expect("内联含 $ 同样不硬拒、且有提示", rc2 == 0 and "若你用了双引号" in out2)
        rc2, out2 = run("add", "pitfall", "--summary", "命令替换形态", "--domain", "d",
                        "--detail", "见 $(date) 与 `id`")
        expect("含 $( 的提示点名命令替换与 --from-file 正解（p000072 根治面）",
               rc2 == 0 and "命令替换" in out2 and "--from-file" in out2, out2[-200:])
        # 正常内容不该有任何提示噪声
        rc2, out2 = run("add", "pitfall", "--summary", "干净条目", "--domain", "d",
                        "--detail", "没有特殊字符的普通说明")
        expect("无特殊字符时零提示噪声（不误伤）",
               rc2 == 0 and "若你用了双引号" not in out2)
        # `--from-file` 来的内容不经 shell ⇒ 不该提示
        rc2, out2 = run("add", "pitfall", "--from-file", "-",
                         inp="summary=来自文件\ndetail=见 `ls -la` 与 $HOME\ndomain=d\n")
        expect("--from-file 写入成功（内容不经 shell）", rc2 == 0)
        expect("--from-file 来的内容**不提示**（它从未经过 shell，提示是噪声）",
               "若你用了双引号" not in out2)
        rc2, _o = run("add", "pitfall", "--summary", "正常", "--domain", "d",
                      "--detail", r"路径 C:\Users 不该被拦")
        expect("反斜杠**不拦**（只转义、且路径/Markdown 里常见）", rc2 == 0)
        rc2, _o = run("add", "pitfall", "--from-file", "-",
                      inp="summary=来自文件\ndetail=见 `ls -la` 与 $HOME\ndomain=d\n")
        expect("--from-file 写入成功（内容不经 shell）", rc2 == 0)
        ok_file = any("`ls -la`" in (r.get("detail") or "") and "$HOME" in (r.get("detail") or "")
                      for f in sorted((Path(cur_store[0]) / "pitfalls").glob("*.jsonl"))
                      for r in read_jsonl(f))
        expect("--from-file 的反引号/变量**原样落盘**（根治点）", ok_file)
        rc2, _o = run("add", "pitfall", "--from-file", "-",
                      inp="summary=替换样例\ndetail=见 $(date) 与 `id`\ndomain=d\n")
        subst_ok = any("$(date)" in (r.get("detail") or "") and "`id`" in (r.get("detail") or "")
                       for f in sorted((Path(cur_store[0]) / "pitfalls").glob("*.jsonl"))
                       for r in read_jsonl(f))
        expect("--from-file 的 $(...) 与反引号**逐字**入库（不经 shell，无展开面）", subst_ok)
        rc2, _o = run("add", "pitfall", "--from-file", "-",
                      inp="nosuch=1\nsummary=s\ndomain=d\n")
        expect("--from-file 字段不合法被拒", rc2 != 0)
        rc2, _o = run("add", "pitfall", "--from-file", "-", inp="\n# 只有注释\n")
        expect("--from-file 空内容被拒", rc2 != 0)
        rc2, _o = run("add", "pitfall", "--summary", "s1", "--domain", "d",
                      "--from-file", "-", inp="summary=s2\n")
        expect("--from-file 与 flag 同字段被拒（不静默取一个）", rc2 != 0)
        rc2, _o = run("add", "pitfall", "--from-file", "-",
                      inp="summary=多行\ndetail=第一行 \\\n第二行 $V\ndomain=d\n")
        expect("--from-file 多行续行（行尾 \\）可解析", rc2 == 0)
        # 续行标记是**分隔符**：判了续行就得削（t000241）。旧实现两处都只判不削 ⇒ 落盘值
        # 每行末挂一个用户从没写过的 `\`。上一条只断言 rc==0，正好放它过去——本块两条腿：
        # ① 值里不该有残留标记 ② 续行的真实内容（含空格与特殊字符）原样落盘。
        ml = [r for f in sorted((Path(cur_store[0]) / "pitfalls").glob("*.jsonl"))
              for r in read_jsonl(f) if r.get("summary") == "多行"]
        expect("--from-file 续行：行尾标记**已剔除**（值里不该残留 \\）",
               len(ml) == 1 and (ml[0].get("detail") or "") == "第一行 \n第二行 $V",
               f"落盘 detail={ (ml[0].get('detail') if ml else None)!r}")
        # 负控：末行也带标记（文件在此结束）⇒ 值按削过的取，且**告警**而非静默吞掉一个标记
        rc2, out2 = run("add", "pitfall", "--from-file", "-",
                        inp="summary=末行带标记\ndomain=d\ndetail=只有一行 \\\n")
        tail = [r for f in sorted((Path(cur_store[0]) / "pitfalls").glob("*.jsonl"))
                for r in read_jsonl(f) if r.get("summary") == "末行带标记"]
        expect("--from-file 末行也带标记：标记同样被剔除",
               rc2 == 0 and len(tail) == 1 and tail[0].get("detail") == "只有一行 ",
               f"rc={rc2} 落盘 detail={(tail[0].get('detail') if tail else None)!r}")
        expect("--from-file 续行到文件末而告警（不是静默按标记语义吞掉）",
               "续行标记结尾" in out2, out2[-160:])

        # ---- 大小写折叠重名（Windows/NTFS 实测带出的判据，Linux 上也判）----
        rc2, _o = run("add", "action", "--summary", "caseA", "--domain", "CaseTest")
        expect("造大小写折叠重名：add CaseTest 成功", rc2 == 0)
        rc2, _o = run("add", "action", "--summary", "caseB", "--domain", "casetest")
        expect("造大小写折叠重名：add casetest 成功", rc2 == 0)
        rc2, out2 = run("check", "--no-log")
        expect("check 报出仅大小写不同的分区名",
               rc2 != 0 and "仅大小写不同" in out2, f"rc={rc2} out={out2[:80]}", dim="partition-case")
        # 修掉一个后复绿（取实况 id，不硬编码——硬编码在前面造过多少条后会指向别的条目）
        # 分区名在**文件名**上，条目 JSON 里不存 `domain` 键——从文件名取
        # （第一版误从条目里读 `r.get("domain")`，恒为空集；与早前「现存分区名 0 个」
        # 是同一个坑）。
        adir = Path(cur_store[0]) / "actions"
        case_files = [f for f in adir.glob("*.jsonl") if f.stem.lower() == "casetest"]
        dup_ids = [r["id"] for f in case_files for r in read_jsonl(f) if r.get("id")]
        # 要改的是**小写那个文件**里的条目；改另一个不会消解冲突（第一版按 glob 顺序取
        # [1]，恰好改到 `CaseTest` 那条 ⇒ 冲突原封不动，断言红）。
        target = None
        for f in case_files:
            if f.stem == "casetest":
                target = next((r["id"] for r in read_jsonl(f) if r.get("id")), None)
                break
        expect("两条大小写冲突的条目都在册（证明不是丢条目而是命名冲突）", len(dup_ids) == 2,
               f"只找到 {dup_ids}（分区文件 {[f.name for f in case_files]}）")
        if len(dup_ids) == 2 and target:
            run("edit", target, "--domain", "casetest-fixed")
            # 这一组自己建了两条 open 条目（在上面的回写之后），队列段覆盖不到 ⇒
            # fresh-queue 会报。同理回写一次。
            _open_t4 = [r["id"] for r in rows("actions") if r.get("id", "").startswith("t")]
            run("set", "exit", inp="交接队列：\n" + "".join(f"- {i} 待办\n" for i in _open_t4))
            rc2, _o = run("check", "--no-log")
            expect("改掉冲突名后 check 除已记录的 tamper 外无其它问题",
               rc2 == 0 or not non_tamper(_o).strip(),
               (non_tamper(_o).strip()[-300:] if non_tamper(_o).strip() else f"rc={rc2}"))

        # ---- pre_tamper 不得把自己的写当外部改动（4.8.0 的真回归点）----
        # **这条是「能区分修没修好」的那条**：第一版修法把 pre_tamper 的快照从
        # write_index 挪到「每 Store 实例算一次」，可调用时机仍在**内容写完之后**
        # ——于是每次经 set/add/edit 写 status/exit 都被自己的判据误报，而原先
        # 那条「补手续」断言**期望的就是报出来**，修没修好都绿，夹具形同虚设。
        _saved_store = cur_store[0]
        _fresh = tempfile.mkdtemp(prefix="handoff-selftest-clean.")
        cur_store[0] = _fresh
        run("init")
        for _i in range(3):
            rc2, _o = run("set", "status", "--file", "-", inp=f"| 第 {_i} 次写入 |")
            expect(f"干净 store 上连写 status 第 {_i + 1} 次成功", rc2 == 0)
        rc2, out2 = run("check", "--no-log")
        expect("CLI 连写 3 次后 check **不得**报『写入之前发现被改动过』（自己的写不算外部改动）",
               rc2 == 0 or "写入**之前**发现" not in out2, out2.strip()[-160:])
        # 对照：干净 store 上**真手改**后跑一次写，必须被记下来
        # （否则上面那条可能是假绿——判据压根不报任何东西）
        (Path(_fresh) / "status").write_text("| 手改 |\n", encoding="utf-8")
        run("set", "status", "--file", "-", inp="| CLI 写 |\n")
        rc2, out2 = run("check", "--no-log")
        expect("对照：真手改后跑一次写，**必须**报出来（证明上一条不是假绿）",
               rc2 != 0 and "写入**之前**发现" in out2, out2.strip()[-120:])
        cur_store[0] = _saved_store
        shutil.rmtree(_fresh, ignore_errors=True)

        # ---- close 两阶段（p000069，4.8.1）：可预见的失败必须**零落盘** ----
        _fs = tempfile.mkdtemp(prefix="handoff-selftest-close.")
        cur_store[0] = _fs
        run("init")
        run("add", "action", "--summary", "甲", "--domain", "c")
        run("add", "action", "--summary", "乙", "--domain", "c")
        _cid = {}
        for _f in sorted(Path(_fs, "actions").glob("*.jsonl")):
            for _r in read_jsonl(_f):
                _cid[_r.get("summary")] = _r.get("id")
        run("next", _cid["甲"])
        _snap0 = {q.name: q.stat().st_size for q in sorted(Path(_fs).rglob("*")) if q.is_file()}
        rc2, out2 = run("close", "t999999", "--outcome", "关不存在的")
        _snap1 = {q.name: q.stat().st_size for q in sorted(Path(_fs).rglob("*")) if q.is_file()}
        expect("close 不存在的 id 非零退出", rc2 != 0)
        expect("且**一个字节都没写**（阶段 1 拦住，不是半写）", _snap0 == _snap1,
               f"变了: {set(_snap1) ^ set(_snap0)}")
        rc2, _o = run("close", _cid["甲"], "--outcome", "")
        _snap2 = {q.name: q.stat().st_size for q in sorted(Path(_fs).rglob("*")) if q.is_file()}
        expect("close 空 outcome 非零（p000051）", rc2 != 0)
        expect("且仍零落盘", _snap0 == _snap2, f"变了: {set(_snap2) ^ set(_snap0)}")
        # exclude：被关的条目不能把自己补成 next
        run("next", _cid["甲"])
        rc2, _o = run("close", _cid["甲"], "--outcome", "关甲")
        _nx = (Path(_fs) / "next").read_text(encoding="utf-8").strip()
        expect("补位**没选回被关的那条**（exclude 生效；否则关了立刻又成决策点）",
               rc2 == 0 and _nx != _cid["甲"], f"next={_nx!r}")
        expect("补位选到了乙（next 只写一次、最终值）", _nx == _cid["乙"], f"next={_nx!r}")
        # 这个组用的是**另一个 store 面**（崩溃兜底用的 `_fs`），它自建了 open 条目却
        # 没写 exit ⇒ fresh-queue 会报「exit 沉默」。真实使用方同样要回写，所以这里走一遍。
        _fs_open = [r["id"] for r in Store(Path(_fs)).load_live()
                    if r.get("_slot") == "actions" and r.get("id", "").startswith("t")]
        run("set", "exit", inp="交接队列：\n" + "".join(f"- {i} 待办\n" for i in _fs_open))
        expect("close 后 check 绿", run("check", "--no-log")[0] == 0)
        # B 兜底：崩溃后状态必须被抓到且**给出可执行修法**
        _act = sorted(Path(_fs, "actions").glob("*.jsonl"))[0]
        _rows = [l for l in _act.read_text(encoding="utf-8").splitlines() if l.strip()]
        _keep = [l for l in _rows if json.loads(l)["id"] != _cid["乙"]]
        _rb = next(l for l in _rows if json.loads(l)["id"] == _cid["乙"])
        _act.write_text("\n".join(_keep) + "\n", encoding="utf-8")
        with open(Path(_fs) / "closed" / "t.jsonl", "a", encoding="utf-8") as _fh:
            _fh.write(_rb + "\n")
        (Path(_fs) / "next").write_text(_cid["乙"] + "\n", encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("崩溃后状态被 check 抓到（不是静默假绿）", rc2 != 0)
        expect("并给出**可执行的修法** `next --auto`", "next --auto" in out2,
               out2.strip()[-120:])
        run("next", "--auto")
        _rc3, _out3 = run("check", "--no-log")
        # 只断言**next 那一维**复绿：上面是手工注入，还会带出「未经 CLI 写入」
        # 与「index 漂移」两维（那两条与 close 无关，别指望一条 next 命令能修）。
        expect("照指引执行后 next 那一维复绿（其余维是手工注入的，与 close 无关）",
               "next:" not in _out3, _out3.strip()[-120:])
        shutil.rmtree(_fs, ignore_errors=True)
        cur_store[0] = _saved_store

        # ---- 三项曾**零夹具**的能力（独立审计变异测试证明：改了它们 selftest 仍全绿）
        # ① `set --dry-run` 必须排在骤降守卫**之前**（排在后面 ⇒ 自己被守卫拦住，等于没有）
        _fp = tempfile.mkdtemp(prefix="handoff-selftest-dry.")
        cur_store[0] = _fp
        run("init")
        _sp = Path(_fp) / "status"
        _big = "| 域 | 状态 |\n|---|---|\n" + "\n".join(
            f"| 域{i} | 一段较长的状态描述{i} |" for i in range(12)) + "\n"
        _sp.write_text(_big, encoding="utf-8")
        rc2, out2 = run("set", "status", "--file", "-", "--dry-run", inp="| 域 | 状态 |\n")
        expect("--dry-run 不被骤降守卫拦住（rc=0）", rc2 == 0, out2.strip()[-100:])
        expect("--dry-run 报告了将减少的量", "减少" in out2, out2.strip()[-100:])
        expect("--dry-run 逐条列出将丢失的行", "将丢失行" in out2, out2.strip()[-100:])
        expect("--dry-run **确实没落盘**（文件仍是原内容）",
               _sp.read_text(encoding="utf-8") == _big)
        # ② `rebase` 必须**真丢弃**带旁证的事件（只追加标记 ⇒ 那些误报仍在，rebase 无效）
        _wp = Path(_fp) / "pitfalls"
        _wp.mkdir(exist_ok=True)
        (_wp / "d.jsonl").write_text(
            '{"id":"p800001","created":"2026-10-03","summary":"基线","status":"open"}\n',
            encoding="utf-8")
        run("add", "pitfall", "--summary", "制造旁证", "--domain", "d")
        _wf = _wp / "d.jsonl"
        _wf.write_text(_wf.read_text(encoding="utf-8") + '{"id":"p899999","created":"2026-10-03",'
                      '"summary":"手写注入","status":"open"}\n', encoding="utf-8")
        run("add", "pitfall", "--summary", "触发一次写", "--domain", "d")
        # 注入的 id 用 p899999：早先写 p800002 会与 `add` 分配的号**撞号**，
        # 于是报出来的是「id 重复」而不是手改那条，断言就测不到要测的东西。
        rc2, out2 = run("check", "--no-log")
        expect("手改被报出（哈希对不上 或 写前旁证，两者都算）",
               rc2 != 0 and ("未经 CLI 记录的写入" in out2 or "写入**之前**发现" in out2),
               out2.strip()[-120:])
        run("rebase", "--force")
        rc2, out2 = run("check", "--no-log")
        expect("rebase 后写事件那维消失（**真丢弃**，只追加标记的话这里仍红）",
               "未经 CLI 记录的写入" not in out2 and "写入**之前**发现" not in out2,
               out2.strip()[-120:])
        # ③ `next` 必须**只写一次**（旧形先清空再补位 ⇒ 中间窗口是事故现场）
        _fa = Path(_fp) / "actions"
        _fa.mkdir(exist_ok=True)
        run("add", "action", "--summary", "甲", "--domain", "n")
        run("add", "action", "--summary", "乙", "--domain", "n")
        _nid = {}
        for _f2 in sorted(_fa.glob("*.jsonl")):
            for _r2 in read_jsonl(_f2):
                _nid[_r2.get("summary")] = _r2.get("id")
        run("next", _nid["甲"])
        # M6「`next` 只写一次」**光看最终态测不出来**（两步写的最终值也是同一个）——
        # 必须 mock 住写入函数、数**调用次数**。这里 monkeypatch `Store.set_next`，
        # **不给生产代码加任何测试钩子**。
        _calls: list = []
        _orig_set_next = Store.set_next

        def _spy_set_next(self, value):        # noqa: N802 —— 保持与被替换者同名
            _calls.append(value)
            return _orig_set_next(self, value)

        Store.set_next = _spy_set_next
        try:
            run("close", _nid["甲"], "--outcome", "关甲")
        finally:
            Store.set_next = _orig_set_next
        _nx = (Path(_fp) / "next").read_text(encoding="utf-8").strip()
        expect("close 期间 `set_next` **恰好被调用 1 次**（mock 计数；两步写会是 2 次、"
               "且中间那次写的是空串⇒指针在两步之间失效）",
               len(_calls) == 1, f"观测到 {len(_calls)} 次：{_calls}")
        expect("且那一次写的**就是最终值**（不是空串）",
               _calls == [_nid["乙"]], f"观测到 {_calls}")
        expect("close 后 next 落在最终值", _nx == _nid["乙"], f"next={_nx!r}")
        shutil.rmtree(_fp, ignore_errors=True)
        cur_store[0] = _saved_store

        # ---- 独立审计第二批：覆盖面 / 回读 / 副作用边界（4.8.4）----
        _fb = tempfile.mkdtemp(prefix="handoff-selftest-b2.")
        cur_store[0] = _fb
        run("init")
        # ① 写事件覆盖面：unconfirmed.jsonl 也必须被对账（此前手改它 check 仍 rc=0）
        _uf = Path(_fb) / "unconfirmed.jsonl"
        run("unconfirmed", "add", "--ref", "a#b", "--summary", "待确认项")
        rc2, _o = run("check", "--no-log")
        expect("unconfirmed 正常态 check 绿", rc2 == 0)
        _uf.write_text('{"id":"u000900","ref":"x#y","summary":"手改注入",'
                       '"created":"2026-10-03"}\n', encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("手改 unconfirmed.jsonl 被抓到（**纯手改**即可复现）",
               rc2 != 0 and "unconfirmed.jsonl" in out2 and
               ("未经 CLI 记录的写入" in out2 or "写入**之前**发现" in out2),
               out2.strip()[-120:])
        # 通用回读键表：必须覆盖 live/closed 行里**最容易被 shell 吃掉**的字段
        rc2, out2 = run("add", "action", "--summary", "带详情", "--domain", "b2",
                        "--detail", "这里是最长的字段，最常被 shell 吃掉",
                        "--src", "src.md:12", "--topic", "话题Z")
        expect("live 行回读含 detail（通用键表漏了它 ⇒ 覆盖面出现洞）",
               "detail:" in out2 and "最常被 shell 吃掉" in out2, out2.strip()[-120:])
        expect("live 行回读含 src", "src:" in out2 and "src.md:12" in out2)
        expect("live 行回读含 topic", "topic:" in out2 and "话题Z" in out2)
        # ② scope 写分支也必须记写事件（否则之后任何写命令都把它当外部改动）
        run("scope", "add", "docs/**")
        run("add", "pitfall", "--summary", "触发一次写", "--domain", "b2")
        rc2, out2 = run("check", "--no-log")
        expect("scope add 后跑写命令**不得**报 pre_tamper（纯 CLI 可复现的误报）",
               "scope：在 write_index" not in out2, out2.strip()[-120:])
        # ③ echo_back 在 decisions 路径：必须回读、且不得把成功报成「异常」
        rc2, out2 = run("add", "decision", "--title", "决策标题",
                        "--body", "正文第一行\n正文第二行", "--topic", "主题X")
        expect("add decision 成功", rc2 == 0, out2.strip()[-100:])
        expect("decisions 路径也回读（body 也要在键表里，否则 4.7.9 的覆盖面是假陈述）",
               "body:" in out2 and "正文第一行" in out2, out2.strip()[-140:])
        expect("且**不**把成功报成『未找到…（异常）』", "异常" not in out2,
               out2.strip()[-100:])
        # ④ --from-file 同文件重复键必拒（静默后者覆盖＝静默丢弃）
        rc2, out2 = run("add", "pitfall", "--from-file", "-",
                        inp="summary=一\ndetail=x\nsummary=二\n")
        expect("--from-file 重复键被拒", rc2 != 0 and "重复出现" in out2,
               out2.strip()[-100:])
        # ⑤ --dry-run / 被拒的写入都不得在盘上留 prev/ 痕迹
        _sp = Path(_fb) / "status"
        _sp.write_text("| 域 | 状态 |\n|---|---|\n| 甲 | 一 |\n", encoding="utf-8")
        run("set", "status", "--file", "-", inp="| 域 | 状态 |\n|---|---|\n| 甲 | 一 |\n"
                         "| 乙 | 二 |\n| 丙 | 三 |\n")    # 成功写 ⇒ 应有 prev
        expect("成功写入后有 prev/（＝上一次成功写入的版本）",
               (Path(_fb) / "prev" / "status").is_file())
        if (Path(_fb) / "prev" / "status").is_file():
            (Path(_fb) / "prev" / "status").unlink()
        run("set", "status", "--file", "-", "--dry-run", inp="| X |\n")
        expect("--dry-run **不留 prev/**（它输出『未写入任何内容』就别改盘）",
               not (Path(_fb) / "prev" / "status").is_file())
        run("set", "status", "--file", "-", inp="| Y |\n")   # 骤降 ⇒ 被拒
        expect("被骤降守卫拒绝后也**不留 prev/**",
               not (Path(_fb) / "prev" / "status").is_file())
        # ⑦ agents-block --check 的**三分流**（4.9.0）：旧形把「块内有人手写条款」与
        # 「版本落后」混成一句「--install 覆盖」，而 --install 真的覆盖块内一切 ⇒
        # 人写内容被静默吃掉（旧形的 zip 还会在「只在块末追加一行」时零差异输出）。
        _bk = tempfile.mkdtemp(prefix="handoff-selftest-block.")
        _ab = Path(_bk) / "AGENTS.md"
        _ab.write_text("# t\n\n## 交接\n\n<!-- handoff:begin -->\n- x\n<!-- handoff:end -->\n",
                       encoding="utf-8")
        rc2, _o = run("agents-block", "--install", _bk)
        expect("agents-block --install 在带标记区的仓上可覆盖", rc2 == 0)
        _txt = _ab.read_text(encoding="utf-8")
        # A 只在**块末追加**一行（既是「人手写内容」也是旧 zip 截断 ⇒ 零差异的那处）：
        # 一条断言同时盯两件事——必须点名那行人写内容，且必须明说 install 会覆盖
        _ab.write_text(_txt.replace(END_MARK, "- 本仓专属：提交前先跑本仓 make check。\n" + END_MARK, 1),
                       encoding="utf-8")
        rc2, out2 = run("agents-block", "--check", _bk)
        expect("--check 点名人写条款、明说 install 会把它们**安置到块外**、且打出差异行"
               "（旧形：两句混成一句 ＋ zip 截断时零差异 ＋ 承诺「会覆盖」其实是删）",
               rc2 != 0 and "源里没有的内容" in out2 and "搬进块外" in out2
               and "make check" in out2 and "差异 行" in out2, out2.strip()[-160:])
        # B 缺一行标准条款 ⇒ 判「纯落后、补装不丢内容」
        # ⚠ 删哪一行**现场取**（取块内最后一条「- 」条款）⇒ 块文本随版本变时这条腿不会失效
        #   （旧形硬编码了某一行 ⇒ v5.32.0 删掉那条规则后，这条腿变成「什么都没删 ⇒ 恒绿」的废腿）
        _txt = _ab.read_text(encoding="utf-8")
        _lines = _txt.splitlines()
        # 删的那行必须是**标准条款**：拿标准源（`agents_block_text`）的条款集合去认，
        # 不能只找「- 」开头的行——仓专属区的行（人写的）与标准条款长得一样。
        _std_lines = {l for l in agents_block_text().splitlines() if l.startswith("- ")}
        _hit = [i for i, l in enumerate(_lines) if l in _std_lines]
        if _hit:
            _lines = [l for i, l in enumerate(_lines) if i != _hit[-1]]
        _ab.write_text("\n".join(_lines) + "\n", encoding="utf-8")
        rc2, out2 = run("agents-block", "--check", _bk)
        expect("--check 判「缺标准条款＝版本落后」且明说补装不丢内容",
               rc2 != 0 and "缺 1 行标准条款" in out2 and "不会丢你写的内容" in out2,
               out2.strip()[-160:])
        # 对照组：install 之后必须回到一致（分流文案不是免责声明，是要真能修）
        rc2, _o = run("agents-block", "--install", _bk)
        rc2, out2 = run("agents-block", "--check", _bk)
        expect("按判定的修法 install 后回到一致（三分流可执行、非空话）",
               rc2 == 0, out2.strip()[-120:])

        # ---- v5.34.0（批 E）交接块**内容闸**（V0）：合同句不得是机制现状 ----
        # 判据面＝`block_line_violation`（枚举形态）；两个档位都查（增强档那行也算合同）。
        _blk_lines: list[str] = []
        for _prof in ("basic", "freshness"):
            _blk_lines += [l for l in agents_block_text(_prof).splitlines() if l.startswith("- ")]
        _viol = [f"{block_line_violation(l)}｜{l[:50]}" for l in _blk_lines
                 if block_line_violation(l)]
        expect("v5.34.0 内容闸：标准块的每条合同句都不是机制现状（V0）",
               not _viol, "；".join(_viol[:4]))
        # **变异自证**：把一条**旧的机制陈述**塞进去 ⇒ 判定必须立刻红（该腿有牙）。
        expect("v5.34.0 内容闸·变异自证：机制陈述塞进去 ⇒ 判定立刻红（该腿有牙）",
               block_line_violation("- 旧的交接内容只归档不删：`close` 迁 `closed/`、"
                                    "`append`／`compact` 把热层旧班段挤进 `archive/` 冷档。")
               is not None,
               "分类器没认出机制陈述")

        # ---- v5.35.0（B2）＋v5.39.0（第二刀）出路律：**每条报错都得有当场可执行的下一步** ----
        # 判据（唯一源＝`exit_shape`；五形：命令／参数／用法／指令／无需动作）。
        # 判的是**用户实际看到的那段话**（原消息 ＋ 出路表命中的修法），不是源码片段——
        # 判据输入必须是用户看到的东西。
        import ast as _ast_e
        _src_e = Path(__file__).read_text(encoding="utf-8")
        _die_calls: list[tuple[int, str, str]] = []
        for _n in _ast_e.walk(_ast_e.parse(_src_e)):
            if (isinstance(_n, _ast_e.Call) and isinstance(_n.func, _ast_e.Name)
                    and _n.func.id == "die" and _n.args):
                _k = next((kw.value.value for kw in _n.keywords
                           if kw.arg == "key" and isinstance(kw.value, _ast_e.Constant)), "")
                _die_calls.append((_n.lineno, _ast_e.unparse(_n.args[0]), _k))
        _no_exit = [(l, m) for l, m, _k in _die_calls if not exit_shape(exit_text(m, _k))]
        expect("v5.39.0 出路闸：每条报错都给出**当场可执行**的下一步"
               "（五形：命令／参数／用法／指令／无需动作）",
               not _no_exit, "；".join(f"L{l}: {m[:60]}" for l, m in _no_exit[:5]))
        # 出路表自身也要成形（它是**共享**出路的唯一源 ⇒ 它自己不许是散文）
        _bad_rows = [(k, v) for k, v in DIE_FIXES.items() if not exit_shape(v)]
        expect("v5.39.0 出路闸：出路表每一行自身都成形（不许靠别的行兜底）",
               not _bad_rows, "；".join(f"{k}: {v[:50]}" for k, v in _bad_rows[:4]))
        # **负控①**：诊断式消息（只有诊断、没有下一步）必须判「没有出路」⇒ 这条腿不是恒绿。
        expect("v5.39.0 出路闸·负控①：诊断式消息（只有诊断、没有下一步）判「没有出路」（腿有牙）",
               exit_shape("add action: 写坏了") == ""
               and exit_shape("decide: 拒绝（不猜边界）") == "",
               "判据把『没有出路』的消息判成了有出路")
        # **负控②**：散文式但**有下一步**的消息仍算出路（不许把好文案判死——那是旧口径的反面）
        expect("v5.39.0 出路闸·负控②：散文式但有下一步的消息仍算出路（不许把好文案判死）",
               exit_shape("add action: 分区键不可用作文件名——别用设备名，改成单段普通词") == "指令",
               "判据过严，把诚实的散文出路判死了")
        # **变异自证①**：清空出路表 ⇒ 依赖它的那几条立刻变成「无出路」⇒ 出路表承重、腿有牙。
        _with = sum(1 for _l, m, _k in _die_calls if exit_shape(exit_text(m, _k)))
        _real_fixes = DIE_FIXES
        try:
            globals()["DIE_FIXES"] = {}
            _without = sum(1 for _l, m, _k in _die_calls if exit_shape(exit_text(m, _k)))
        finally:
            globals()["DIE_FIXES"] = _real_fixes
        expect("v5.39.0 出路闸·变异自证①：清空出路表 ⇒ 合规数立刻下降（出路表承重）",
               _without < _with, f"有表 {_with}／无表 {_without}")
        # **变异自证②**：把出路抽掉（去反引号片段＋去 flag）⇒ 合规数立刻下降 ⇒ 判据真的在看出路。
        _stripped = sum(1 for _l, m, _k in _die_calls
                         if exit_shape(re.sub(r"`[^`]+`", " ", EXIT_FLAG_RE.sub(" ", exit_text(m, _k)))))
        expect("v5.39.0 出路闸·变异自证②：抽掉出路（去反引号片段＋去 flag）⇒ 合规数立刻下降",
               _stripped < _with, f"有出路 {_with}／抽掉后 {_stripped}")
        # ---- v5.39.0（H3）：裁定件**在**库里，只是 `edit` 不改它 ⇒ 出路要指向 `decide` ----
        # 旧形（v5.38.0 及以前）：消息写「未找到条目 d000123（决策文档暂不支持 edit）」⇒
        # 命中泛化键「未找到」⇒ 出路给的是「找相近的／新开一条」＝**指错路**（用户照着查
        # 也查不出问题，因为那条明明在库里）。新形：两种「没有这一行」分开说。
        _dec_files = sorted((Path(cur_store[0]) / "decisions").glob("d*.md"))
        if _dec_files:
            _did = _dec_files[-1].stem
            rc2, out2 = run("edit", _did)
            expect("v5.39.0 H3：`edit` 撞**在库**的裁定件 ⇒ 出路指向 `handoff decide`"
                   "（不是泛化键的「找相近的」＝指错路）",
                   rc2 != 0 and "decide" in out2 and "找相近的" not in out2,
                   out2.strip()[-160:])
        # ---- v5.40.0（批 C-③ 的可机械那半）：**恒绿腿**闸 ----
        # 「宣称＝断言」的一般形态判不了（数字口径 60 处误判；记号口径量腿体就成恒真
        # ⇒ 第三次实测，t000437 判负）；但它的**退化形态**能机械判：**恒绿腿**
        # ——断言是常量 ⇒ 那条腿没断言任何东西（仓规「断言必须落在会坏的东西上」的机械化）。
        _const_legs = constant_leg_violations(_src_e)
        expect("v5.40.0 恒绿腿闸：`expect` 的断言不得是常量（恒绿腿＝没断言任何东西）",
               not _const_legs, "；".join(f"L{l}: {nm[:46]}" for l, nm in _const_legs[:5]))
        # **负控**：非常量分支里的常量是**报告层**（「检出缺陷 ⇒ 报一条失败的腿」）⇒ 豁免
        expect("v5.40.0 恒绿腿闸·负控：报告层（非常量分支里的常量）豁免／裸恒绿腿被点名",
               not constant_leg_violations("if probe:\n    expect('报告层', False)\n")
               and len(constant_leg_violations("expect('恒绿腿', True)\n")) == 1,
               "判据把报告层当成恒绿腿，或没认出裸恒绿腿")
        # **变异自证**：把一条**真腿**的断言换成常量 ⇒ 判据必须当场点名它（腿有牙）
        _mut_hit = None
        _tree_m = _ast_e.parse(_src_e)
        _mut_lines = _src_e.splitlines(keepends=True)
        for _n2 in _ast_e.walk(_tree_m):
            if not (isinstance(_n2, _ast_e.Call) and isinstance(_n2.func, _ast_e.Name)
                    and _n2.func.id == "expect" and len(_n2.args) > 1
                    and isinstance(_n2.args[1], (_ast_e.Compare, _ast_e.BoolOp))
                    and hasattr(_n2.args[1], "end_lineno")):
                continue
            _c = _n2.args[1]
            try:
                _s, _er = _c.lineno - 1, _c.end_lineno - 1
                _mut = ("".join(_mut_lines[:_s]) + _mut_lines[_s][:_c.col_offset] + "True"
                        + _mut_lines[_er][_c.end_col_offset:] + "".join(_mut_lines[_er + 1:]))
                _hits = constant_leg_violations(_mut)
            except SyntaxError:
                continue
            if any(l == _n2.lineno for l, _ in _hits):
                _mut_hit = (_n2.lineno, len(_hits))
                break
        expect("v5.40.0 恒绿腿闸·变异自证：把一条真腿的断言换成常量 ⇒ 判据当场点名（腿有牙）",
               _mut_hit is not None, "变异没被点名")
        # ---- v5.41.0：出路里点名的命令必须**真存在**（防 t000413 那族「照抄一条不存在的命令」）----
        _exit_texts = [(_l, exit_text(_m, _k)) for _l, _m, _k in _die_calls]
        _bad_cmd = exit_nonexistent_commands_violations([_t for _l, _t in _exit_texts])
        expect("v5.41.0 出路命令闸：出路里点名的 `handoff <命令>` 必须在 CLI 子命令表内（照抄能跑）",
               not _bad_cmd, "；".join(f"{i}: `{c}`" for i, c in _bad_cmd[:5]))
        # 出路表自身也查（它是**共享**出路的唯一源）
        _bad_rows_cmd = exit_nonexistent_commands_violations(list(DIE_FIXES.values()))
        expect("v5.41.0 出路命令闸：出路表每一行点名的命令也必须真存在",
               not _bad_rows_cmd, "；".join(f"{i}: `{c}`" for i, c in _bad_rows_cmd[:4]))
        # **负控**：不存在的命令必须被点名；真命令必须放过
        expect("v5.41.0 出路命令闸·负控：不存在的命令被点名／真命令被放过",
               len(exit_nonexistent_commands_violations(["修：`handoff nosuchcmd --x`"])) == 1
               and not exit_nonexistent_commands_violations(["修：`handoff check --no-log`"]),
               "闸没认出坏命令，或误伤了真命令")
        # **变异自证**：把一条**真出路**里的命令名改错 ⇒ 闸必须当场点名（腿有牙）
        _mut_cmd = None
        _verbs = cli_verbs()
        for _l, _t in _exit_texts:
            _hit = None
            for _inner in EXIT_TICK_RE.findall(_t):
                _w = _inner.strip().split()
                if len(_w) > 1 and _w[0] == "handoff" and _w[1] in _verbs:
                    _hit = _inner
                    break
            if _hit is None:
                continue
            _w2 = _hit.strip().split()
            if exit_nonexistent_commands_violations([_t.replace(_hit, _hit.replace(_w2[1], "nosuchcmd", 1))]):
                _mut_cmd = (_l, _hit)
                break
        expect("v5.41.0 出路命令闸·变异自证：把一条真出路里的命令名改错 ⇒ 闸当场点名（腿有牙）",
               _mut_cmd is not None, "变异没被点名")
        # ---- v5.66.0（t000471 · F-E／F-F／F-G）：出路合法性**统一到 parser 树** ----
        # F-F：`handoff --store X check` 是 argparse 的**唯一合法写法**（顶层参数在子命令前）
        #      ⇒ 旧形把它判成「命令不存在」＝假红 ⇒ 现在必须放过。
        expect("v5.66.0 出路闸·正控：全局参数在前的合法写法（`handoff --store X check`）**不红**"
               "（旧形这里是假红）",
               not exit_nonexistent_commands_violations(["修：`handoff --store .handoff check`"]),
               "合法写法被误判成「命令不存在」")
        # F-E：出路文案点名的 flag 必须真在 parser 树里
        expect("v5.66.0 出路闸·负控：出路点名**不存在的 flag** ⇒ 当场红",
               bool(exit_nonexistent_commands_violations(["修：`handoff check --nosuchflag`"])),
               "假 flag 没被认出")
        # F-G：第二层子命令（`add` 的 kind 面）也必须真存在
        expect("v5.66.0 出路闸·负控：出路点名**不存在的第二层子命令** ⇒ 当场红",
               bool(exit_nonexistent_commands_violations(["修：`handoff add nosuchkind`"])),
               "假 kind 没被认出")
        # 不误伤：外部命令的 flag **不核**（d000022 当年判负跨技能 flag 检查的理由之一）
        expect("v5.66.0 出路闸·正控：**外部命令**的 flag 不核（不误伤）",
               not exit_nonexistent_commands_violations(["修：`git diff --stat`"]),
               "外部命令的 flag 被误判")
        # ---- v5.62.0（t000466）：**子命令表单一源**闸（副本不许回来）----
        _verb_viol = cli_verb_source_violations(_src_e)
        expect("v5.62.0 子命令表单一源闸：CLI 子命令表**只许一个源**（parser 树派生）",
               not _verb_viol, "；".join(_verb_viol[:4]))
        # **负控**：把副本写回来 ⇒ 闸必须当场点名（v5.66.0 起判**形态**：
        #   「有个模块级常量，其字符串集合 == parser 子命令表的全集」⇒ 换写法/换名都抓得住）
        _full_verbs = ", ".join(f'"{v}"' for v in sorted(cli_verbs()))
        _vlist = sorted(cli_verbs())
        _half = len(_vlist) // 2
        _h1 = ", ".join(f'"{v}"' for v in _vlist[:_half])
        _h2 = ", ".join(f'"{v}"' for v in _vlist[_half:])
        _full_kv = ", ".join(f'"{v}": 1' for v in _vlist)
        _copy_forms = {
            "tuple字面量": f'CLI_VERBS = ({_full_verbs})',
            "list字面量": f'CLI_VERBS = [{_full_verbs}]',
            "tuple()调用": f'CLI_VERBS = tuple([{_full_verbs}])',
            "带类型注解": f'CLI_VERBS: tuple[str, ...] = ({_full_verbs})',
            "换名": f'VERBS = ({_full_verbs})',
            # ---- v5.68.0（t000475 · F-I3）新增：换**作用域**、**超集**、换**容器** ----
            "函数局部": f'def _f():\n    COPY = ({_full_verbs})',
            "类属性": f'class _C:\n    COPY = ({_full_verbs})',
            "全集+多余项": f'CLI_VERBS = ({_full_verbs}, "ghostcmd")',
            "dict键集": f'CLI_VERBS = {{{_full_kv}}}',
            "两段拼接": f'A = ({_h1})\nB = ({_h2})\nCLI_VERBS = A + B',
            "拼接+多余项": f'A = ({_full_verbs})\nCLI_VERBS = A + ("ghostcmd",)',
        }
        for _fname, _copy in _copy_forms.items():
            _cv = cli_verb_source_violations(_copy)
            expect(f"v5.66.0 子命令表单一源闸·负控：副本形态「{_fname}」⇒ 当场红"
                   "（判形态 ⇒ 换写法/换名都抓得住）",
                   any("手抄副本" in _x for _x in _cv),
                   f"副本形态没被认出（判定 {_cv[:2]}）")
        # **正控**：**部分**集合（白名单形态）**不红**（那类本就该合法）
        expect("v5.66.0 子命令表单一源闸·正控：只含部分命令的白名单常量**不红**（不误伤）",
               not cli_verb_source_violations('WHITELIST = ("check", "status")'),
               "部分集合被误判成副本")
        # v5.68.0 正控：新增的**名字解析**路径（`X = A` 引用型）不得把白名单的别名判成副本
        expect("v5.68.0 子命令表单一源闸·正控：白名单的**别名**（`X = WHITELIST`）**不红**"
               "（名字解析不得放宽判据 ⇒ 不误伤）",
               not cli_verb_source_violations('WHITELIST = ("check", "status")\nALIAS = WHITELIST'),
               "白名单别名被误判成副本")
        # **负控**：派生表与实表不一致 ⇒ 当场红（显式喂一个不一样的表，零副作用）
        _v2 = cli_verb_source_violations(_src_e, tuple(cli_verbs()) + ("nosuchverb",))
        expect("v5.62.0 子命令表单一源闸·负控：派生表与 parser 实表不一致 ⇒ 当场红",
               any("派生表 != parser 实表" in _v for _v in _v2),
               f"不一致没被认出（判定 {_v2[:2]}）")
        # **负控**：派生表为空 ⇒ 当场红（枚举口径坏了会让出路闸把所有命令判成不存在）
        _v3 = cli_verb_source_violations(_src_e, ())
        expect("v5.62.0 子命令表单一源闸·负控：派生表为空 ⇒ 当场红（枚举口径坏了）",
               any("派生子命令表为空" in _v for _v in _v3),
               f"空表没被认出（判定 {_v3[:2]}）")
        # ---- v5.68.0（t000475 · F-I1）：**跨库 import** 的出处维假红 ----
        # 病灶：import 还原了 void／trash 段（库级事实面）⇒ 那批 id 重新「在册」，
        #       而写事件台账只记条目面导入的 id ⇒ 目标库**已有基线**时 ⇒ 出处维判
        #       「来历不可追」⇒ import 报失败（内容其实完整落地）；目标库**还没有**
        #       基线时又恰好绿 ⇒ **同一份清单两种结论**，差的只是台账里少一条记录。
        _imp_dir = tempfile.mkdtemp(prefix="handoff-imp.")
        _keep_store = cur_store[0]
        try:
            _src_s = Path(_imp_dir) / "src"
            cur_store[0] = str(_src_s)
            run("init")
            run("add", "action", "--summary", "源库条目甲")
            run("add", "action", "--summary", "源库条目乙")
            run("rm", "t000002")              # 造一条已作废条目（→ trash/ ＋ void）
            _expf = Path(_imp_dir) / "exp.jsonl"
            run("export", "--out", str(_expf))
            # 目标库：**init 过** ⇒ 基线已建立 ⇒ 出处维**会判**（这正是触发条件）
            _dst_s = Path(_imp_dir) / "dst"
            cur_store[0] = str(_dst_s)
            run("init")
            rc2, out2 = run("import", str(_expf))
            expect("v5.68.0 跨库 import·正控：源库有过作废条目、目标库已有基线 ⇒ import 不红"
                   "（还原回来的作废 id 已认账 ⇒ 出处维不判「来历不可追」）",
                   rc2 == 0 and "来历不可追" not in out2, out2[-240:], dim="id-provenance")
            # **负控（变异自证）**：把台账里那批 id 的认账抹掉 ⇒ 出处维必须当场红
            _wl = _dst_s / "writes.jsonl"
            _evs = [json.loads(l) for l in _wl.read_text(encoding="utf-8").splitlines() if l.strip()]
            for _e in _evs:
                if _e.get("ids"):
                    _e["ids"] = [i for i in _e["ids"] if i != "t000002"]
            _wl.write_text("\n".join(json.dumps(_e, ensure_ascii=False) for _e in _evs) + "\n",
                           encoding="utf-8")
            rc2, out2 = run("check", "--no-log")
            expect("v5.68.0 跨库 import·负控：抹掉台账里那批认账 ⇒ 出处维当场红（腿有牙）",
                   rc2 != 0 and "来历不可追" in out2, out2[-240:], dim="id-provenance")
        finally:
            cur_store[0] = _keep_store
            shutil.rmtree(_imp_dir, ignore_errors=True)
        # ---- v5.68.0（t000475 · F-I2）：**封存维**在「本命令现建的库」上不判 ----
        # 病灶：封存维吃的是**进门前**的封存快照；而 import 会在一个（可能刚被 mkdir
        #       的）目录上**现建**这个库 ⇒ 那时「可写」是必然的初始态、不是任何人
        #       chmod 回来的 ⇒ 本维在那次调用里**没有判别对象** ⇒ 实测：目标目录已
        #       存在 ⇒ import 自带的 check 判「未封存」⇒ import 报失败，而内容完整
        #       落地、导入后零可写位、随后单独跑 check 是绿的。
        # 正控与负控都**必须用子进程**：夹具里的 `run()` 带着 `HANDOFF_SELFTEST_SUB=1`
        # ⇒ 封存维在子模式里整条跳过 ⇒ 在本进程里判它恒为假（同 d000110 那条腿的道理）。
        _seal_dir = tempfile.mkdtemp(prefix="handoff-sealimp.")
        _code7 = (
            "import sys, os\n"
            "sys.path.insert(0, sys.argv[1])\n"
            "import handoff as h\n"
            "src, dst, exp = sys.argv[2], sys.argv[3], sys.argv[4]\n"
            "def m(a):\n"
            "    try:\n"
            "        return h.main(a) or 0\n"
            "    except SystemExit as e:\n"
            "        return e.code if isinstance(e.code, int) else 1\n"
            "m(['--store', src, 'init'])\n"
            "m(['--store', src, 'add', 'action', '--summary', '甲'])\n"
            "m(['--store', src, 'add', 'action', '--summary', '乙'])\n"
            "m(['--store', src, 'rm', 't000002'])\n"
            "m(['--store', src, 'export', '--out', exp])\n"
            "os.makedirs(dst, exist_ok=True)\n"          # 目标目录**已存在**（空）
            "print('IMPORT_RC=' + str(m(['--store', dst, 'import', exp])))\n"
            "os.chmod(os.path.join(dst, 'status'), 0o644)\n"   # 把一个载体改回可写
            "print('----SEALED----')\n"
            "print('SEALED_RC=' + str(m(['--store', dst, 'check', '--no-log'])))\n"
        )
        import subprocess as _sp7                   # noqa: PLC0415 — 仅夹具用
        _env7 = {k: v for k, v in os.environ.items() if k != "HANDOFF_SELFTEST_SUB"}
        _r7 = _sp7.run([sys.executable, "-B", "-c", _code7, str(Path(__file__).resolve().parent),
                        f"{_seal_dir}/src", f"{_seal_dir}/dst", f"{_seal_dir}/exp.jsonl"],
                       capture_output=True, text=True, timeout=180, env=_env7)
        _o7 = _r7.stdout or ""
        # 分段断言：import 那一段与「故意改回可写后跑 check」那一段**必须分开看**
        # （后者本来就要红「未封存」⇒ 混在一起断言＝正控被自己的负控误伤）。
        _o7a = _o7.split("----SEALED----")[0]
        _o7b = _o7.split("----SEALED----")[1] if "----SEALED----" in _o7 else ""
        expect("v5.68.0 封存维·正控：目标目录**已存在**时 import 不得自判「未封存」"
               "（本命令现建的库，封存维没有判别对象 ⇒ 不判）",
               "IMPORT_RC=0" in _o7a and "未封存" not in _o7a,
               f"rc={_r7.returncode} out={_o7a[-200:]} err={(_r7.stderr or '')[-160:]}")
        expect("v5.68.0 封存维·负控：库**早就存在**且被改回可写 ⇒ 封存维仍须红"
               "（新排除只放行「本命令现建」那一种，不许放宽成不管）",
               "SEALED_RC=1" in _o7b and "未封存" in _o7b,
               f"rc={_r7.returncode} out={_o7[-300:]} err={(_r7.stderr or '')[-160:]}")
        shutil.rmtree(_seal_dir, ignore_errors=True)
        # ---- v5.63.0（d000161）：**纪律完整性**闸（F2 的可判那半）----
        # v5.65.0 起：声明表改成「机制 → 声明」单表（值形态互斥）＋ 分母从代码派生。
        _disc_viol = discipline_completeness_violations(_src_e)
        expect("v5.63.0 纪律完整性闸：每个机制**都被声明了**（有纪律 or 无纪律＋理由）",
               not _disc_viol, "；".join(_disc_viol[:4]))
        _real_decl = dict(DISCIPLINE_DECL)
        try:
            # **负控①**：某机制漏声明 ⇒ 当场红（集合差非空）
            globals()["DISCIPLINE_DECL"] = {k: v for k, v in _real_decl.items() if k != "void-reuse"}
            _d1 = discipline_completeness_violations(_src_e)
            # **负控②**：声明「无纪律」但理由为空 ⇒ 当场红（无痕免检口）
            globals()["DISCIPLINE_DECL"] = {**_real_decl, "void-reuse": "  "}
            _d2 = discipline_completeness_violations(_src_e)
            # **负控③**：登记指向不存在的机制 ⇒ 当场红（假登记）
            globals()["DISCIPLINE_DECL"] = {**_real_decl, "no-such-mechanism": "理由"}
            _d3 = discipline_completeness_violations(_src_e)
            # **负控④**：守护纪律 id 不在纪律清单里 ⇒ 当场红（假登记）
            globals()["DISCIPLINE_DECL"] = {**_real_decl, "writes": ("no-such-discipline",)}
            _d4 = discipline_completeness_violations(_src_e)
            # **负控⑤**：声明形态非法（既不是 tuple 也不是 str）⇒ 当场红
            globals()["DISCIPLINE_DECL"] = {**_real_decl, "writes": ["row-precise-write"]}
            _d5 = discipline_completeness_violations(_src_e)
            # **负控⑥**：在册纪律变成孤儿（没有任何机制声明它守护）⇒ 当场红
            globals()["DISCIPLINE_DECL"] = {
                k: (tuple(x for x in v if x != "carrier-in-ledger")
                    if isinstance(v, tuple) else v)
                for k, v in _real_decl.items()}
            _d6 = discipline_completeness_violations(_src_e)
        finally:
            globals()["DISCIPLINE_DECL"] = _real_decl
        expect("v5.63.0 纪律完整性闸·负控：机制漏声明 ⇒ 当场红（漏登记被抓）",
               any("没有任何纪律声明" in x for x in _d1),
               f"漏声明没被认出（判定 {_d1[:2]}）")
        expect("v5.63.0 纪律完整性闸·负控：「无纪律」理由为空 ⇒ 当场红（无痕免检口）",
               any("理由为空" in x for x in _d2),
               f"空理由没被认出（判定 {_d2[:2]}）")
        expect("v5.63.0 纪律完整性闸·负控：登记指向**不存在的机制** ⇒ 当场红（假登记）",
               any("不存在" in x for x in _d3),
               f"假登记没被认出（判定 {_d3[:2]}）")
        expect("v5.65.0 纪律完整性闸·负控：守护纪律 id 不在纪律清单里 ⇒ 当场红（假登记）",
               any("不在纪律清单" in x for x in _d4),
               f"假守护者没被认出（判定 {_d4[:2]}）")
        expect("v5.65.0 纪律完整性闸·负控：声明形态非法 ⇒ 当场红（形状闸有牙）",
               any("声明形态非法" in x for x in _d5),
               f"非法形态没被认出（判定 {_d5[:2]}）")
        expect("v5.65.0 纪律完整性闸·负控：在册纪律**没有任何机制声明它** ⇒ 当场红（孤儿纪律）",
               any("没有任何机制声明它守护" in x for x in _d6),
               f"孤儿纪律没被认出（判定 {_d6[:2]}）")
        # ---- v5.65.0（t000469 · F-B／F-C）：**分母从代码派生** ＋ **声明形态互斥** ----
        _gates_der = consumed_gates(_src_e)
        expect("v5.65.0 机制全集·分母换源：闸从**代码调用点**派生（不靠人工表）",
               len(_gates_der) >= 17 and "discipline_completeness_violations" in _gates_der,
               f"派生出 {len(_gates_der)} 个闸")
        expect("v5.65.0 机制全集·分母换源：v5.63.0 实测**漏网的那三个闸**现在都在全集里",
               set(_gates_der) >= {"exit_nonexistent_commands_violations",
                                    "fact_comment_exempt_violations",
                                    "id_provenance_violations"},
               f"缺＝{sorted({'exit_nonexistent_commands_violations', 'fact_comment_exempt_violations', 'id_provenance_violations'} - set(_gates_der))}")
        # **变异自证（F-C 的病根被治掉）**：删掉一条**守护关系** ⇒ 现在**必须红**
        #   （旧形两表可同时收同一机制 ⇒ 差集语义在交集上失效 ⇒ 删守护关系不红 ⇒
        #    守护关系可静默腐烂 ⇒ 实测「删守护关系仍绿」是 F-C 的实证。）
        try:
            globals()["DISCIPLINE_DECL"] = {
                k: (tuple(x for x in v if x != "output-volume-cap")
                    if isinstance(v, tuple) else v)
                for k, v in _real_decl.items()}
            _d7 = discipline_completeness_violations(_src_e)
        finally:
            globals()["DISCIPLINE_DECL"] = _real_decl
        expect("v5.65.0 纪律完整性闸·变异自证：删掉一条**守护关系** ⇒ 当场红"
               "（旧形下这一步是绿的 ⇒ 守护关系不再能静默腐烂）",
               any("没有任何机制声明它守护" in x for x in _d7),
               f"删守护关系没被认出（判定 {_d7[:2]}）")
        # **负控**：落点登记闭合（被消费的闸没登记 ⇒ 覆盖登记闸当场红）
        _real_ms = dict(MECHANISM_STRUCTURE)
        try:
            globals()["MECHANISM_STRUCTURE"] = {
                k: v for k, v in _real_ms.items() if k != "cli_verb_source_violations"}
            _mc_neg = mechanism_coverage_violations(_src_e, Path(__file__).resolve().parent.parent)
        finally:
            globals()["MECHANISM_STRUCTURE"] = _real_ms
        expect("v5.65.0 落点登记闭合闸·负控：把一个**被消费的闸**从落点登记里删掉 ⇒ 当场红"
               "（v5.63.0 实测有三个这样的闸）",
               any("没在落点登记里" in x for x in _mc_neg),
               f"漏登记的闸没被认出（判定 {[_x for _x in _mc_neg if '落点登记' in _x][:2]}）")
        # ---- v5.64.0（t000468）：**导出必须是全库往返**（库级事实面三段）----
        # 病灶：旧 export 只搬**条目面**⇒ 一次往返就把「id 永不复用」这条硬不变量
        # 弄丢（实测：导入库把源库已作废的 t000001 原样重新分配出去，无闸可抓）。
        with tempfile.TemporaryDirectory(prefix="handoff-selftest-export.") as _tdx:
            _prev_store = cur_store[0]
            cur_store[0] = str(Path(_tdx) / "src")
            run("init")
            run("add", "action", "--summary", "待作废那条", "--domain", "x")
            rc_x, out_x = run("rm", "t000001")
            _void_x = Path(cur_store[0]) / "void"
            expect("v5.64.0 导出往返·前置：rm 后已作废 id 进了 void 名单",
                   rc_x == 0 and _void_x.is_file()
                   and "t000001" in _void_x.read_text(encoding="utf-8"), out_x[-160:])
            # **正控**：现清单形状合规（三段齐 ＋ schema=2）
            _recs_x = export_records(Store(Path(cur_store[0])))
            _viol_x = export_roundtrip_violations(_recs_x)
            expect("v5.64.0 导出往返闸：现清单形状合规（三段齐 ＋ schema=2）",
                   not _viol_x, "；".join(_viol_x[:4]))
            # **负控①**：拿掉 void 段 ⇒ 闸必须红（丢的正是「id 永不复用」的依据）
            _no_void = [r for r in _recs_x
                        if not (isinstance(r, dict) and r.get("_kind") == "void")]
            _nv = export_roundtrip_violations(_no_void)
            expect("v5.64.0 导出往返闸·负控：拿掉 void 段 ⇒ 当场红",
                   any("void" in v for v in _nv), f"闸没报（判定 {_nv[:2]}）")
            # **负控②**：schema 1（旧形清单）⇒ 闸必须红
            _old = [dict(_recs_x[0], schema=1)] + _recs_x[1:]
            _ov = export_roundtrip_violations(_old)
            expect("v5.64.0 导出往返闸·负控：schema 1（旧形清单）⇒ 当场红",
                   any("schema" in v for v in _ov), f"闸没报（判定 {_ov[:2]}）")
            # **端到端**：导出 → 导入到**空库** ⇒ 已作废名单/trash 还原 ⇒ 新条目拿不到那个 id
            _man_x = Path(_tdx) / "m.jsonl"
            _man_x.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in _recs_x) + "\n",
                              encoding="utf-8")
            cur_store[0] = str(Path(_tdx) / "dst")
            rc_x, out_x = run("import", str(_man_x))
            expect("v5.64.0 导出往返·端到端：清单导入空库成功", rc_x == 0, out_x[-200:])
            _void_y = Path(cur_store[0]) / "void"
            expect("v5.64.0 导出往返·端到端：**已作废 id 名单**随往返还原（id 永不复用的依据）",
                   _void_y.is_file() and "t000001" in _void_y.read_text(encoding="utf-8"),
                   f"void ＝ {(_void_y.read_text(encoding='utf-8') if _void_y.is_file() else '<无>')}")
            expect("v5.64.0 导出往返·端到端：**trash 里那一份**随往返还原（unvoid --restore 的前提）",
                   (Path(cur_store[0]) / "trash" / "t000001.jsonl").is_file())
            rc_x, out_x = run("add", "action", "--summary", "导入库新建那条")
            expect("v5.64.0 导出往返·端到端：导入库**不会重新分配已作废 id**（不变量守住）",
                   "id=t000002" in out_x and "id=t000001" not in out_x, out_x[-160:])
            # **变异自证**：把清单里的 void 段删掉再导入 ⇒ 不变量**真的**破了（闸拦的不是摆设）
            _man_y = Path(_tdx) / "broken.jsonl"
            _man_y.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in _no_void) + "\n",
                              encoding="utf-8")
            cur_store[0] = str(Path(_tdx) / "dst2")
            rc_x, out_x = run("import", str(_man_y))
            rc_x2, out_x2 = run("add", "action", "--summary", "变异库新建那条")
            expect("v5.64.0 导出往返·变异自证：拿掉 void 段的清单 ⇒ 导入后**真的**复用了已作废 id"
                   "（⇒ 闸拦的不是摆设）",
                   "id=t000001" in out_x2, out_x2[-160:])
            cur_store[0] = _prev_store
        # 「没有标记区」这**另一支**也必须提前说清破坏性（4.9.1）：它在三态分流**之外**
        # （分流要先认得出标记区），而 install 走整节收敛会把该节非空内容顶掉。
        # 现实触发：标记行少个空格 / 多空格 / 带属性 ⇒ 认不出（实测三种都认不出）。
        _txt = _ab.read_text(encoding="utf-8")
        _ab.write_text(_txt.replace(BEGIN_MARK, "<!--handoff:begin-->")
                           .replace(END_MARK, "<!--handoff:end-->"), encoding="utf-8")
        rc2, out2 = run("agents-block", "--check", _bk)
        expect("认不出标记区且仓里有非空交接节 ⇒ 提前给出**内容级**对照："
               "手写副本几条、独有几条、独有你写的内容逐条列出"
               "（旧形只报一个总数，还得人自己逐条比哪些会丢）",
               rc2 != 0 and "整节收敛" in out2 and "手写副本" in out2
               and REPO_HOME in out2, out2.strip()[-200:])
        shutil.rmtree(_bk, ignore_errors=True)
        # ⑥ rebase 在**非库目录**必须拒（否则 `open("w")` 凭空造出 writes.jsonl）
        rc2, out2 = run("rebase", "--force")
        expect("在库里 rebase 正常（--force）", rc2 == 0, out2.strip()[-140:])
        _non = tempfile.mkdtemp(prefix="handoff-notastore.")
        _saved2 = cur_store[0]
        cur_store[0] = os.path.join(_non, ".handoff")
        os.makedirs(cur_store[0], exist_ok=True)
        rc2, out2 = run("rebase", "--force")
        expect("非库目录 rebase 被拒", rc2 != 0 and "不是交接存储" in out2,
               out2.strip()[-100:])
        expect("且**没有**凭空造出 writes.jsonl",
               not (Path(cur_store[0]) / "writes.jsonl").exists())
        cur_store[0] = _saved2
        shutil.rmtree(_fb, ignore_errors=True); shutil.rmtree(_non, ignore_errors=True)
        cur_store[0] = _saved_store

        # ---- `main()` 分发点的 note_pre_tamper（4.8.4 的根治点，此前**零夹具**）----
        # 独立审计实测：手改 `scope` → 跑 `scope add` ⇒ 原版 rc=1 报 pre_tamper，
        # 而**删掉分发点那个 hook 后 rc=0 永久静默**。它有真实鉴别力，只是没人测。
        # 注意：各写命令内仍有同名调用（幂等），所以**只删分发点这一处仍能过**——
        # 下面的对照组正是为此准备的。
        _fs2 = tempfile.mkdtemp(prefix="handoff-selftest-hook.")
        cur_store[0] = _fs2
        run("init")
        run("add", "pitfall", "--summary", "基线", "--domain", "h")
        _sp2 = Path(_fs2) / "scope"
        _sp2.write_text("docs/被手改过/**\n", encoding="utf-8")   # 绕过 CLI 手改 scope
        rc2, _o = run("scope", "add", "src/**")                   # 随后跑一个写命令
        # pre_tamper 是**记进写事件**的，报出发生在后续 `check`（不是当场）——
        # 第一版把期望写成「scope add 当场 rc≠0」⇒ 断言恒红。机制本身一直是对的。
        rc2, out2 = run("check", "--no-log")
        expect("手改 scope 后跑写命令，随后的 check 必须报 pre_tamper"
               "（分发点 hook 的承重不变量）",
               rc2 != 0 and "写入**之前**发现" in out2, out2.strip()[-140:])
        # 对照组：**只删分发点那一处**（命令内的仍在）⇒ 仍绿，说明这条断言测的是
        # 「整条链路上 hook 存在」，而**不是**「分发点那一处非有不可」。
        # （这条是**说明**、不是断言 ⇒ 写成注释；写成 `expect(..., True)` 就是**恒绿腿**
        #   ⇒ v5.40.0 的恒绿腿闸会把它点名。）
        shutil.rmtree(_fs2, ignore_errors=True)
        cur_store[0] = _saved_store

        # ---- 判据清单**单源化**的漂移检查（2026-10-03 试点）----
    # 这条是「代码维护 ＋ 生成 ＋ 漂移检查」三件套的第三件：前两件都做了，没有它
        # 就只是一次性同步，下次改 `CHECK_DIMENSIONS` 忘了重跑生成又会分叉——而那正是
        # 本会话反复栽的「只改了一半」。**没有第三件，单源化只是换了个地方漂移。**
        try:
            _skill_md = Path(__file__).resolve().parent.parent / "references" / "cli.md"
            _sk_text = _skill_md.read_text(encoding="utf-8")
            for _b, _e, _render, _label in ((CHECK_BEGIN, CHECK_END, render_check_dims, "判据清单"),
                                            (LANDINGS_BEGIN, LANDINGS_END, render_landings, "落点登记")):
                if _b not in _sk_text:
                    expect(f"references/cli.md 缺{_label}生成块（{_b[:24]}…）——"
                           f"跑 `handoff.py sync-dims` 把它生成进去", False, "标记未找到")
                elif _e not in _sk_text:
                    expect(f"references/cli.md {_label}生成块缺结束标记", False, _e[:24] + " 未找到")
                else:
                    _got = _sk_text.split(_b, 1)[1].split(_e, 1)[0]
                    _want = _render().split(_b, 1)[1].split(_e, 1)[0]
                    if _got.strip() == _want.strip():
                        expect(f"{_label}生成块与源同步（单源化漂移检查）", True)
                    else:
                        _gl = [l for l in _got.strip().splitlines() if l.strip()]
                        _wl = [l for l in _want.strip().splitlines() if l.strip()]
                        _diff = [f"生成物: {a[:60]}" for a, b in zip(_gl, _wl) if a != b][:3]
                        expect(f"{_label}生成块与源**不同步**"
                               "（改了判据要重跑生成，否则又是一次『只改了一半』）",
                               False, "; ".join(_diff) or f"行数 生成物 {len(_gl)} vs 源 {len(_wl)}")
        except OSError as _e:
            expect(f"读 SKILL.md 失败：{_e}", False)

        # ---- v5.42.0：落点登记补齐的**行为腿**（每条腿一个独立库）----
        # 为什么另起库：这些腿要**手写坏行**才能触发判据面（缺槽／未来日／未知字段…），
        # 而主夹具末尾有一条断言是「除已记录的 tamper 外无新问题」⇒ 坏行不能落进主库。
        @_contextlib.contextmanager
        def _leg_store():
            """一条腿一个**干净的独立库**：手写坏行不污染别的腿，也不碰主夹具。"""
            with tempfile.TemporaryDirectory(prefix="handoff-selftest-leg.") as _d:
                _saved = cur_store[0]
                cur_store[0] = str(Path(_d) / ".handoff")
                try:
                    run("init")
                    yield Path(cur_store[0])
                finally:
                    cur_store[0] = _saved

        def _write_row(store: Path, slot: str, row: dict) -> None:
            """往分区文件**手写**一行（绕过 CLI ⇒ 会被写事件对账维记下；
            本组腿只断言**自己那一维**的结论，不受那条红影响）。"""
            d = store / slot
            d.mkdir(parents=True, exist_ok=True)
            with (d / "_global.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

        # ① slots：删掉一个槽 ⇒ check 点名缺槽
        with _leg_store() as _ls:
            (_ls / "scope").unlink()
            rc2, out2 = run("check", "--no-log")
            expect("v5.42.0 落点登记·slots：缺槽 ⇒ check 报「缺槽」（库结构不齐当场可见）",
                   rc2 != 0 and "缺槽" in out2, out2[-200:], dim="slots")
        # ② dates：created 是未来日 ⇒ 红（时间轴这一维是结构性的，不靠散文）
        with _leg_store() as _ls:
            _write_row(_ls, "actions", {"id": "t900001", "summary": "未来日的条目",
                                        "created": "2999-01-01", "status": "open"})
            rc2, out2 = run("check", "--no-log")
            expect("v5.42.0 落点登记·dates：created 是未来日 ⇒ check 报红",
                   rc2 != 0 and "未来日" in out2, out2[-200:], dim="dates")
        # ③ text-dangling：散文点了一个不存在的 id ⇒ 红（文本槽的死指针）
        with _leg_store() as _ls:
            (_ls / "status").write_text("交接内容：t999999 这条还没销账。\n", encoding="utf-8")
            rc2, out2 = run("check", "--no-log")
            expect("v5.42.0 落点登记·text-dangling：散文点了不存在的 id ⇒ check 报红",
                   rc2 != 0 and "没有这个 id" in out2, out2[-200:], dim="text-dangling")
        # ④ decision：裁定件的 frontmatter id 与文件名不符 ⇒ 红（改号被抓）
        with _leg_store() as _ls:
            (_ls / "decisions").mkdir(parents=True, exist_ok=True)
            (_ls / "decisions" / "d000099.md").write_text(
                "---\nid: d000098\ncreated: 2026-10-01\nstatus: accepted\n---\n\n正文\n",
                encoding="utf-8")
            rc2, out2 = run("check", "--no-log")
            expect("v5.42.0 落点登记·decision：裁定件 id 与文件名不符 ⇒ check 报红",
                   rc2 != 0 and "与文件名" in out2, out2[-200:], dim="decision")
        # ⑤ fields：手写一行带未知字段 ⇒ 红（字段表是唯一源，不许静默吞字段）
        with _leg_store() as _ls:
            _write_row(_ls, "actions", {"id": "t900002", "summary": "带未知字段的条目",
                                        "created": "2026-10-01", "status": "open", "bogus": 1})
            rc2, out2 = run("check", "--no-log")
            expect("v5.42.0 落点登记·fields：未知字段 ⇒ check 报红",
                   rc2 != 0 and "未知字段" in out2, out2[-200:], dim="fields")
        # ⑥ scope：登记指向不存在的路径 ⇒ 红（登记必须可解析）
        with _leg_store() as _ls:
            rc2, _o = run("scope", "add", "no/such/dir/**")
            rc2, out2 = run("check", "--no-log")
            expect("v5.42.0 落点登记·scope：登记指向不存在的路径 ⇒ check 报红",
                   rc2 != 0 and "scope 登记不可解析" in out2, out2[-200:], dim="scope")
        # ⑦ index：计数与落盘对不上 ⇒ 红（index 是派生件，对不上就是漂了）
        with _leg_store() as _ls:
            _ip = _ls / "index"
            _idx = json.loads(_ip.read_text(encoding="utf-8"))
            _idx["slots"]["actions"]["count"] = 99
            _ip.write_text(json.dumps(_idx, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            rc2, out2 = run("check", "--no-log")
            expect("v5.42.0 落点登记·index：index 计数与落盘对不上 ⇒ check 报红",
                   rc2 != 0 and "index 漂移" in out2, out2[-200:], dim="index")
        # ⑧ sealed：库处于可写态 ⇒ 红（封存这一维判的是「进门前」的状态；
        #    走**子进程**跑：selftest 子模式按设计不回封、不判这一维 ⇒ 同一进程里看不到它）
        with _leg_store() as _ls:
            for _p in _ls.rglob("*"):
                try:
                    _p.chmod(_p.stat().st_mode | 0o200)
                except OSError:
                    pass
            _ls.chmod(_ls.stat().st_mode | 0o200)
            _env = {k: v for k, v in os.environ.items() if k != "HANDOFF_SELFTEST_SUB"}
            import subprocess as _sp_ld
            _r = _sp_ld.run([sys.executable, str(Path(__file__).resolve()), "--store", str(_ls),
                             "check", "--no-log"], capture_output=True, text=True,
                            timeout=120, env=_env)
            expect("v5.42.0 落点登记·sealed：库未封存 ⇒ check 报红",
                   _r.returncode != 0 and "未封存" in (_r.stdout + _r.stderr),
                   (_r.stdout + _r.stderr)[-200:], dim="sealed")
        # ⑨ archive：冷档里有一行畸形 JSON ⇒ 红（冷档不许手改）
        with _leg_store() as _ls:
            (_ls / "archive").mkdir(parents=True, exist_ok=True)
            (_ls / "archive" / "summary.jsonl").write_text("这一行不是 JSON\n", encoding="utf-8")
            rc2, out2 = run("check", "--no-log")
            expect("v5.42.0 落点登记·archive：冷档有畸形行 ⇒ check 报红",
                   rc2 != 0 and "畸形行" in out2, out2[-200:], dim="archive")
        # ⑩ block-installed：装过块、现在块不见了 ⇒ 红（装过的证据在库里）
        with _leg_store() as _ls:
            _agents = _ls.parent / "AGENTS.md"
            _agents.write_text("# 临时仓\n\n## 交接\n\n- 手写一条\n", encoding="utf-8")
            rc2, _o = run("agents-block", "--install", str(_ls.parent))
            _agents.write_text("# 临时仓\n", encoding="utf-8")
            rc2, out2 = run("check", "--no-log")
            expect("v5.42.0 落点登记·block-installed：装过块却整段消失 ⇒ check 报红",
                   rc2 != 0 and "装过" in out2, out2[-240:], dim="block-installed")

    # ---- 写事件对账（p000025，4.7.8）：手改与「补手续」从纪律变判据 ----
        run("add", "pitfall", "--summary", "写事件基线", "--domain", "wtest")
        # 收尾统一回写一次 `exit` 队列段（2026-10-03，fresh-queue 判据下沉后的夹具纪律）。
        # 前面各组陆续建了 open 条目，逐处补 `set exit` 会漏——**在收尾处统一按当前
        # 落盘事实重写一遍**，夹具面才与真实使用方式一致：真实使用方也是收尾时才对账，
        # 不是每加一条就改一次 exit。
        _open_t3 = [r["id"] for r in rows("actions") if r.get("id", "").startswith("t")]
        _exit_prev = (Path(cur_store[0]) / "exit")
        _kept = []
        if _exit_prev.is_file():
            _kept = [ln for ln in _exit_prev.read_text(encoding="utf-8").splitlines()
                     if "（已闭）" in ln]
        run("set", "exit", inp="交接队列：\n" + "\n".join(_kept + [f"- {i} 待办" for i in _open_t3]) + "\n")
        rc2, out2 = run("check", "--no-log")
        # 注意：不能断言 rc==0 —— 本夹具**前面的组**就是靠手工注入坏行来造脏件的
        # （不那样造就没有脏行可测），那些 tamper 都已在写事件里记下。判据是
        # 「除已记录的 tamper 外无新问题」。
        expect("纯 CLI 写后无**新**问题（前面的 tamper 已记录在案）",
               rc2 == 0 or not non_tamper(out2).strip(),
               out2.strip()[-200:] if non_tamper(out2).strip() else "")
        wf = Path(cur_store[0]) / "pitfalls" / "wtest.jsonl"
        wf.write_text(wf.read_text(encoding="utf-8") + '{"id":"p999998","summary":"手写注入",'
                      '"created":"2026-10-04","status":"open"}\n', encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("绕过 CLI 手改文件 → 报「未经 CLI 记录的写入」",
               rc2 != 0 and "未经 CLI 记录的写入" in out2, dim="writes")
        rc2, _o = run("add", "pitfall", "--summary", "手改后的一次写", "--domain", "wtest")
        rc2, out2 = run("check", "--no-log")
        expect("那次手改被写事件记下（写前旁证），不因后续 CLI 写而消失",
               rc2 != 0 and "写入**之前**发现" in out2)
        # 补手续：手改 status 写入**同样字节**，内容哈希不变、只有时间戳变
        sp = Path(cur_store[0]) / "status"
        sp.parent.mkdir(parents=True, exist_ok=True)
        same = "| 域 | 状态 |\n|---|---|\n| 甲 | 乙 |\n"
        run("set", "status", "--file", "-", inp=same)      # 先用 CLI 写一次打底
        sp.write_text(same, encoding="utf-8")              # 手改：同样字节
        run("set", "status", "--file", "-", inp=same)      # 再用 CLI 覆写同样字节
        rc2, out2 = run("check", "--no-log")
        expect("补手续（同字节覆写）被写前旁证抓到", rc2 != 0 and "写入**之前**发现" in out2)

        # ---- frontmatter 切分单源（停手条件②：自包含分发件认自己目录内 1 处）----
        # 为什么钉在 selftest：统一前三套走法对**同一个文件**给出不同结果——CRLF 的决策件在
        # `_frontmatter`（`view --id`／回读走它）里读成空、在 `_fm_fields`（`import` 预校验／
        # `supersedes` 扫描走它）里却读得到；开括号多一横的畸形件被后者**假解析出字段**。
        # 三套并成一套后，这两面各钉一条断言，另加一条「正文水平线不参与切分」的负控。
        _crlf = "---\r\nid: d1\nstatus: accepted\r\n---\r\n# t\r\n"
        expect("切分单源：CRLF 决策件读得出字段（旧正则那套在此返回空）",
               _fm_parse(_fm_split(_crlf)[0]).get("id") == "d1")
        _bad_open = "----\nid: d2\n---\nbody\n"
        expect("切分单源：开括号多一横＝不是 frontmatter（旧 find 那套会假解析出 id）",
               _fm_split(_bad_open)[2] is False and _fm_parse(_fm_split(_bad_open)[0]) == {})
        _ws_open = "  ---\nid: d4\n---\nbody\n"
        expect("切分单源：开括号带行首空格＝不是 frontmatter（与 frontmatter.py 同口径）",
               _fm_split(_ws_open)[2] is False)
        _tab_open = "\t---\nid: d5\n---\nbody\n"
        expect("切分单源：开括号带制表＝不是 frontmatter（与 frontmatter.py 同口径）",
               _fm_split(_tab_open)[2] is False)
        _hr = "---\nid: d3\n---\n# h\n\ntext\n\n---\n\nmore\n"
        _fm3, _bd3, _ok3 = _fm_split(_hr)
        expect("切分单源：正文里的水平线不参与切分（正文完整、字段照读）",
               _ok3 and _bd3.count("---") == 1 and _fm_parse(_fm3).get("id") == "d3")
        # ---- ⑧ 单写者锁（5.1.0，cloud-services 实战报回）----
        # 报单实测的两种损坏：`PermissionError`（别人的 finally 把树回封）与同 id 双份
        # （edit/close 交错）。夹具必须用**真子进程**——in-process 的 `run()` 与父进程同属
        # 一个进程，flock 测不出进程间争用，那样钉的是一条不存在的判据。
        import subprocess
        _lk = tempfile.mkdtemp(prefix="handoff-selftest-lock.")
        _env = dict(os.environ, HANDOFF_SELFTEST_SUB="1", HANDOFF_LOCK_WAIT_S="1")
        _cli = [sys.executable, str(Path(__file__).resolve()), "--store", _lk]
        _fd = acquire_store_lock(Store(Path(_lk)))
        _p = subprocess.run(_cli + ["view"], capture_output=True, text=True, env=_env)
        expect("锁被占 ⇒ 第二条命令明确报错、不静默不写盘（把锁摘掉这条必红＝有鉴别力）",
               _p.returncode != 0 and "占着本存储" in (_p.stdout + _p.stderr),
               (_p.stdout + _p.stderr)[-160:])
        release_store_lock(_fd)
        _p = subprocess.run(_cli + ["view"], capture_output=True, text=True, env=_env)
        expect("释放后同一条命令正常（上一条不是恒红）", _p.returncode == 0, _p.stderr[-120:])
        _ = subprocess.run(_cli + ["init"], capture_output=True, text=True, env=_env)
        _ps = [subprocess.Popen(_cli + ["add", "action", "--summary", f"c{n}", "--domain", "conc"],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, env=_env) for n in range(8)]
        _outs = [p.communicate()[0] for p in _ps]
        _ids = [r["id"] for f in sorted((Path(_lk) / "actions").glob("*.jsonl"))
                for r in read_jsonl(f)]
        expect("并行 8 条写全部生效（有界等待串行化，不丢任何一条的写意图）",
               all(p.returncode == 0 for p in _ps), f"{[p.returncode for p in _ps]}")
        expect("并行写零 PermissionError（旧形：别人的 finally 把树回封）",
               not any("PermissionError" in o for o in _outs),
               max(_outs, key=len)[-160:] if _outs else "")
        expect("并行写不产生重复 id", len(_ids) == 8 and len(set(_ids)) == 8,
               f"{len(_ids)} 行 / {len(set(_ids))} 唯一")
        shutil.rmtree(_lk, ignore_errors=True)

        # ---- ⑨ void 的出口（5.1.0）：rm 不把「在册」标成「已作废」，历史死角有 unvoid ----
        _vd = tempfile.mkdtemp(prefix="handoff-selftest-void.")
        cur_store[0] = _vd
        run("init")
        rc2, out2 = run("add", "action", "--summary", "待闭", "--domain", "v")
        _tid = out2.split("id=")[1].strip().split()[0]
        run("close", _tid, "--outcome", "已闭")
        _cl = (Path(_vd) / "closed" / "t.jsonl").read_text(encoding="utf-8")
        expect("close 后条目在 closed/（下面的夹具以此为前提）", _tid in _cl, _cl[:120])
        # 复现并发事故的现状：同 id 同时在 live 与 closed。**绕过 CLI 注入**是这批夹具唯一
        # 造得出该状态的办法 ⇒ 夹具自身的 tamper 理应被报，断言一律经 non_tamper 剔掉那行噪声。
        with (Path(_vd) / "actions" / "v.jsonl").open("a", encoding="utf-8") as _fh:
            _fh.write(json.dumps({"id": _tid, "created": today(), "summary": "重复的 live 副本"},
                                 ensure_ascii=False) + "\n")
        rc2, out2 = run("check", "--no-log")
        expect("现状复现：live＋closed 同 id ⇒ check 报 id 重复", "重复" in non_tamper(out2), out2[-160:], dim="id")
        rc2, out2 = run("rm", _tid)
        _void_txt = (Path(_vd) / "void").read_text(encoding="utf-8") if (Path(_vd) / "void").is_file() else ""
        expect("rm 只移 live 副本、**不记 void**（closed 仍在册；旧形记了 void 就把存储锁死）",
               rc2 == 0 and "不记 void" in out2 and _tid not in _void_txt, out2[-160:])
        rc2, out2 = run("check", "--no-log")
        expect("修完除夹具自身的 tamper 外无问题（这条路不需要 unvoid）",
               not non_tamper(out2).strip(), out2[-200:])
        # 历史死角形态（v5.0 的 rm 造出来的）：void 有该 id、closed 合法在册
        (Path(_vd) / "void").write_text(_tid + "\n", encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("死角复现：void 与 closed 并存 ⇒ check FAIL，且**报错自带出口**（点名 unvoid）",
               rc2 != 0 and "复用了已作废 id" in out2 and "unvoid" in out2, out2[-200:])
        rc2, out2 = run("unvoid", _tid)
        expect("unvoid 解除作废标记", rc2 == 0
               and _tid not in (Path(_vd) / "void").read_text(encoding="utf-8"), out2[-160:])
        rc2, out2 = run("check", "--no-log")
        expect("unvoid 后无新问题、条目仍留在 closed（对方验收口径）",
               not non_tamper(out2).strip()
               and _tid in (Path(_vd) / "closed" / "t.jsonl").read_text(encoding="utf-8"), out2[-200:])
        rc2, out2 = run("unvoid", _tid)
        expect("unvoid 对不在 void 的 id 硬拒（不误改盘）", rc2 != 0 and "不在 void" in out2, out2[-120:])
        # 反向出口：rm 误删的条目要能搬回来（全程走 CLI，不该留任何 tamper）
        rc2, out2 = run("add", "pitfall", "--summary", "误删的坑", "--domain", "v")
        _pid = out2.split("id=")[1].strip().split()[0]
        run("rm", _pid)
        rc2, out2 = run("unvoid", _pid, "--restore")
        _back = any(_pid in f.read_text(encoding="utf-8") for f in (Path(_vd) / "pitfalls").glob("*.jsonl"))
        expect("unvoid --restore 把条目搬回 live、trash 里那份清走、id 不重新分配",
               rc2 == 0 and _back and not (Path(_vd) / "trash" / f"{_pid}.jsonl").exists(), out2[-160:], dim="void-reuse")
        rc2, out2 = run("check", "--no-log")
        expect("纯 CLI 的 rm→unvoid --restore 回路不触发 tamper（前面那条除外）",
               "未经 CLI 记录的写入" not in out2.split(_pid)[-1][:400], out2[-200:])

        # ---- v5.50.0（t000444）：同 id 落**两个数据槽** ⇒ rm 的失败语义与半成品态 ----
        # 旧形的三处病（本仓实测复现）：① 移走一条后**另一槽那条仍在 live**，但 void 被
        # 照记 ⇒ 同一 id **既在册又已作废** ⇒ check 恒红、rm/edit 都被 void 守卫挡住；
        # ② 回读按「这个 id 不在 live」判 ⇒ 另一槽本就该在 live ⇒ 每次这样的 rm 都判死
        # ⇒ rc=1 而实际已移走成功 ⇒ 用户以为失败、实则库已变；③ 文案说「源文件没被抹掉？」
        # ——**归因错误**（真实原因是「另一槽还有同 id」），且说「可能已无处可寻」是未实测的猜测。
        _t2 = tempfile.mkdtemp(prefix="handoff-selftest-rm2slot.")
        cur_store[0] = _t2
        run("init")
        rc2, out2 = run("add", "action", "--summary", "双槽同 id 那条", "--domain", "v")
        _d2 = out2.split("id=")[1].strip().split()[0]
        # 造「同一 id 在另一个数据槽也在册」（绕过 CLI 注入是造得出该状态的唯一办法 ⇒
        # 夹具自身的 tamper 噪声一律经 non_tamper 剔掉）
        with (Path(_t2) / "pitfalls" / "v.jsonl").open("a", encoding="utf-8") as _fh:
            _fh.write(json.dumps({"id": _d2, "created": today(), "summary": "另一槽那份"},
                                 ensure_ascii=False) + "\n")
        rc2, out2 = run("rm", _d2)
        _void2 = (Path(_t2) / "void").read_text(encoding="utf-8") if (Path(_t2) / "void").is_file() else ""
        _left2 = any(_d2 in f.read_text(encoding="utf-8") for f in (Path(_t2) / "pitfalls").glob("*.jsonl"))
        expect("v5.50.0 同 id 落两槽：rm 成功（rc=0）且**不记 void**"
               "（另一槽那条仍在册 ⇒ 记 void＝同一 id 既在册又已作废 ⇒ 死角）",
               rc2 == 0 and "不记 void" in out2 and _d2 not in _void2 and _left2, out2[-200:])
        rc2, out2 = run("check", "--no-log")
        expect("v5.50.0 同 id 落两槽：rm 后库里**无「live 且已作废」**（旧形恒红）",
               "复用了已作废 id" not in non_tamper(out2), out2[-200:])
        # 负控：回读失败时**必须明说已落盘**（实测事实），不说「可能已无处可寻」——
        # 旧形那句是**未实测的猜测**：它把用户引去 trash/ 与 git 找一条其实还在册的条目。
        # 注入「追加进黑洞」⇒ 追加丢失 ⇒ 回读必失败（手法同既有夹具）。
        _t3 = tempfile.mkdtemp(prefix="handoff-selftest-rmblack.")
        cur_store[0] = _t3
        run("init")
        rc2, out2 = run("add", "pitfall", "--summary", "黑洞那条", "--domain", "v")
        _b3 = out2.split("id=")[1].strip().split()[0]
        (Path(_t3) / "trash").mkdir(exist_ok=True)
        (Path(_t3) / "trash" / f"{_b3}.jsonl").symlink_to(Path("/dev/null"))
        rc2, out2 = run("rm", _b3)
        expect("v5.50.0 rm 回读失败：**明说已落盘**（实测事实）且不含未实测的猜测"
               "（旧形那句「可能已无处可寻」把用户引去找一条其实还在册的条目）",
               rc2 != 0 and "回读不通过" in out2 and "已落盘" in out2
               and "可能已无处可寻" not in out2, out2[-240:])
        expect("v5.50.0 rm 回读失败：**报出仍在册的位置**（实测归因，不是一句「源文件没被抹掉？」）",
               "仍在册" in out2, out2[-240:])
        shutil.rmtree(_t3, ignore_errors=True)
        shutil.rmtree(_t2, ignore_errors=True)
        cur_store[0] = _vd          # ← 恢复原库（否则后续腿在已删的库上跑）
        # `u` 型走的是**单文件槽**（`unconfirmed.jsonl`，没有分区名）——这条腿钉的就是
        # 「落点分支的判定顺序」：先查 ENTRY_SLOTS 会让 u 型根本走不到 unconf_file()。
        rc2, out2 = run("unconfirmed", "add", "--ref", "docs/某件.md#段", "--summary", "一条候选")
        _uid = out2.split(":")[-1].strip()
        rc2, out2 = run("rm", _uid)
        rc2, out2 = run("unvoid", _uid, "--restore")
        expect("u 型条目 --restore 回 `unconfirmed.jsonl`（单文件槽那条分支可达）",
               rc2 == 0 and _uid in (Path(_vd) / "unconfirmed.jsonl").read_text(encoding="utf-8"),
               out2[-200:])
        # ---- v5.56.0（t000457）：同 id 落**同一文件** ⇒ rm 按**行**摘一条，不是整表过滤 ----
        # 旧形（实测复现）：同一文件里两条同 id ⇒ rm 把**两条**一起移走（备份两行、
        #   源文件里那条也没了）⇒ 用户没让删的那条被静默移走；事后 `unvoid --restore`
        #   又把两条一起搬回来 ⇒ 重复状态原样复活。
        _t4 = tempfile.mkdtemp(prefix="handoff-selftest-rm1file.")
        cur_store[0] = _t4
        run("init")
        rc2, out2 = run("add", "action", "--summary", "同文件那条", "--domain", "v")
        _d4 = out2.split("id=")[1].strip().split()[0]
        _f4 = Path(_t4) / "actions" / "v.jsonl"
        _row4 = json.loads(_f4.read_text(encoding="utf-8").splitlines()[0])
        _row4["summary"] = "同文件·副本"          # 造「同一文件里两条同 id」
        with _f4.open("a", encoding="utf-8") as _fh:
            _fh.write(json.dumps(_row4, ensure_ascii=False) + "\n")
        rc2, out2 = run("rm", _d4)
        _left4 = sum(1 for l in _f4.read_text(encoding="utf-8").splitlines() if _d4 in l)
        expect("v5.56.0 同 id 落同一文件：rm 只摘**那一条**（另一条同 id 留在原处）",
               rc2 == 0 and _left4 == 1, f"rc={rc2} 剩 {_left4} 条 {out2[-200:]}")
        _bak4 = Path(_t4) / "trash" / f"{_d4}.jsonl"
        _bakn4 = len(_bak4.read_text(encoding="utf-8").splitlines()) if _bak4.is_file() else 0
        expect("v5.56.0 同 id 落同一文件：备份**只有一行**（旧形写两行 ⇒ restore 会搬回两条）",
               _bakn4 == 1, f"备份 {_bakn4} 行")
        _void4 = (Path(_t4) / "void").read_text(encoding="utf-8") if (Path(_t4) / "void").is_file() else ""
        expect("v5.56.0 同 id 落同一文件：另一条仍在册 ⇒ **不记 void**（记了＝既在册又已作废）",
               _d4 not in _void4, f"void={_void4!r}")
        rc2, out2 = run("unvoid", _d4, "--restore")
        _left5 = sum(1 for l in _f4.read_text(encoding="utf-8").splitlines() if _d4 in l)
        expect("v5.56.0 同 id 落同一文件：移走的那条**捞得回来**（restore 不再被「不在 void」挡住）",
               rc2 == 0 and _left5 == 2, f"rc={rc2} 恢复后 {_left5} 条 {out2[-200:]}")
        shutil.rmtree(_t4, ignore_errors=True)
        cur_store[0] = _vd
        shutil.rmtree(_vd, ignore_errors=True)

        # ---- v5.57.0（t000461）：**裁定件载体**也要进写事件台账 ⇒ 手改正文当场红 ----
        # 病灶：d 型（decisions/<id>.md）此前不在受管面（`_write_targets()`）⇒ 导入来的
        # 裁定件**不进台账 `files`** ⇒ 内容哈希对账只对账台账里有的文件 ⇒ 手改其正文
        # 不被抓住（`decide` 路径是定点 `extra` 入账的，**导入**路径没有）。
        def _dec_fixture(tag):
            _td = tempfile.mkdtemp(prefix=f"handoff-selftest-{tag}.")
            _prev = cur_store[0]
            cur_store[0] = _td
            run("init")
            _mf = Path(tempfile.mkdtemp(prefix=f"handoff-selftest-{tag}-man.")) / "m.jsonl"
            _mf.write_text("\n".join([
                json.dumps({"_format": "handoff"}, ensure_ascii=False),
                json.dumps({"_kind": "doc", "_slot": "decisions", "_id": "d000001",
                            "content": "---\nid: d000001\ncreated: 2026-01-01\n"
                                       "status: accepted\n---\n# 导入的裁定\n\n正文。\n"},
                           ensure_ascii=False),
            ]) + "\n", encoding="utf-8")
            run("import", str(_mf))
            return _td, _prev
        _t5, _prev5 = _dec_fixture("dec")
        _dec5 = Path(_t5) / "decisions" / "d000001.md"
        _wl5 = Path(_t5) / "writes.jsonl"
        _in5 = "decisions/d000001.md" in (_wl5.read_text(encoding="utf-8") if _wl5.is_file() else "")
        expect("v5.57.0 裁定件载体：导入的裁定件**进写事件台账**（载体级对账面有了）",
               _dec5.is_file() and _in5, f"台账里没有该载体（writes.jsonl 无该文件）")
        _dec5.write_text(_dec5.read_text(encoding="utf-8").replace("正文。", "正文（手改）。"),
                         encoding="utf-8")
        rc5, out5 = run("check", "--no-log")
        expect("v5.57.0 裁定件载体：手改导入裁定件的正文 ⇒ 当场红（未经 CLI 记录的写入）",
               rc5 != 0 and "未经 CLI 记录的写入" in out5, f"rc={rc5} {out5[-240:]}")
        shutil.rmtree(_t5, ignore_errors=True)
        cur_store[0] = _prev5
        # 变异自证：把裁定件载体从受管面里摘掉（**旧形**）⇒ 手改正文不被抓 ⇒ 腿有牙
        _real_wt = Store._write_targets
        try:
            Store._write_targets = lambda self: [
                f for f in _real_wt(self)
                if not (str(f).endswith(".md") and "decisions" in str(f))]
            _t6, _prev6 = _dec_fixture("decold")
            _dec6 = Path(_t6) / "decisions" / "d000001.md"
            _dec6.write_text(_dec6.read_text(encoding="utf-8").replace("正文。", "正文（手改）。"),
                             encoding="utf-8")
            rc6, out6 = run("check", "--no-log")
            expect("v5.57.0 裁定件载体·变异自证：旧形（载体不在受管面）⇒ 手改正文**抓不到**"
                   "（正控那条腿有牙）",
                   rc6 == 0 and "未经 CLI 记录的写入" not in out6, f"rc={rc6} {out6[-240:]}")
            shutil.rmtree(_t6, ignore_errors=True)
            cur_store[0] = _prev6
        finally:
            Store._write_targets = _real_wt

        # ---- v5.58.0（t000463）：同 id 落同一文件 ⇒ close/edit 也按**行**定位 ----
        # 旧形（实测复现）：close 的 `rest = [x for x in read_jsonl(src) if x.get("id") != id]`
        #   把**两条一起**移走，而归档的只有一条 ⇒ 另一条既没归档也没进 trash ⇒ 静默丢数据；
        #   edit 的 `for r in rows: if r.get("id") == a.id: r[k] = v` 把同 id 的**两条都改**。
        _t7 = tempfile.mkdtemp(prefix="handoff-selftest-close1file.")
        _prev78 = cur_store[0]
        cur_store[0] = _t7
        run("init")
        rc7, out7 = run("add", "action", "--summary", "同文件那条", "--domain", "v")
        _d7 = out7.split("id=")[1].strip().split()[0]
        _f7 = Path(_t7) / "actions" / "v.jsonl"
        _row7 = json.loads(_f7.read_text(encoding="utf-8").splitlines()[0])
        _row7["summary"] = "同文件·副本"
        with _f7.open("a", encoding="utf-8") as _fh:
            _fh.write(json.dumps(_row7, ensure_ascii=False) + "\n")
        rc7, out7 = run("close", _d7, "--outcome", "关掉其中一条")
        _left7 = sum(1 for l in _f7.read_text(encoding="utf-8").splitlines() if _d7 in l)
        _cl7 = Path(_t7) / "closed" / "t.jsonl"
        _closed7 = (sum(1 for l in _cl7.read_text(encoding="utf-8").splitlines() if _d7 in l)
                    if _cl7.is_file() else 0)
        expect("v5.58.0 同 id 落同一文件：close 只摘**那一条**"
               "（另一条留在源文件——旧形把它静默丢了：既没归档也没进 trash）",
               rc7 == 0 and _left7 == 1 and _closed7 == 1,
               f"rc={rc7} 源剩 {_left7} 归档 {_closed7} {out7[-200:]}")
        shutil.rmtree(_t7, ignore_errors=True)
        _t8 = tempfile.mkdtemp(prefix="handoff-selftest-edit1file.")
        cur_store[0] = _t8
        run("init")
        rc8, out8 = run("add", "action", "--summary", "原样那条", "--domain", "v")
        _d8 = out8.split("id=")[1].strip().split()[0]
        _f8 = Path(_t8) / "actions" / "v.jsonl"
        _row8 = json.loads(_f8.read_text(encoding="utf-8").splitlines()[0])
        _row8["summary"] = "同文件·副本"
        with _f8.open("a", encoding="utf-8") as _fh:
            _fh.write(json.dumps(_row8, ensure_ascii=False) + "\n")
        rc8, out8 = run("edit", _d8, "--summary", "只改这一条")
        _sums8 = [json.loads(l).get("summary")
                  for l in _f8.read_text(encoding="utf-8").splitlines() if l.strip()]
        expect("v5.58.0 同 id 落同一文件：edit 只改**那一条**（另一条原样）",
               rc8 == 0 and _sums8.count("只改这一条") == 1 and "同文件·副本" in _sums8,
               f"rc={rc8} 现状 {_sums8} {out8[-200:]}")
        shutil.rmtree(_t8, ignore_errors=True)
        cur_store[0] = _prev78

        # ---- ⑩ agents-block 把人写内容**安置**到块外、不删（5.1.0，实测丢过 3 条约定）----
        # 副本行从标准块**当场取**，不手抄——手抄的夹具会随标准块措辞演进而失真。
        _sv = tempfile.mkdtemp(prefix="handoff-selftest-salvage.")
        _ab2 = Path(_sv) / "AGENTS.md"
        _dup = next(l for l in agents_block_text("basic").splitlines() if l.startswith("- "))
        _ab2.write_text("# t\n\n## 通用规则\n\n1. 别丢东西\n\n## 交接\n\n"
                        "- 接手入口三件：`handoff check`／`handoff view`／`handoff next --auto`。\n"
                        "- 旧版交接件只归档不删。\n"
                        "#### 注：本仓的 handoff view 快照不入库\n"      # 以 `#` 开头的人写行：
                        # 按前缀筛「标题」会在「读出→写回」这一圈里静默丢掉它（真 bug 过的地方）。
                        # ⚠ 必须用 `####`：`# 注` 是**一级标题**，按节的定义它会终止 `## 交接` 节，
                        # 那行就落在节外、根本进不了这次分流（夹具第一版就这么假失败过）。
                        f"{_dup}\n\n## 命令\n\n```\nmake go\n```\n", encoding="utf-8")
        rc2, out2 = run("agents-block", "--check", _sv)
        expect("--check 认不出标记区时给**内容级**对照（独有条款逐条列出，不再只报总数）",
               rc2 != 0 and "旧版交接件只归档不删" in out2 and "手写副本" in out2, out2[-200:])
        rc2, out2 = run("agents-block", "--install", _sv)
        _t2 = _ab2.read_text(encoding="utf-8")
        expect("--install 成功且标准块进标记区", rc2 == 0 and BEGIN_MARK in _t2, out2[-120:])
        expect("仓专属条款保留（旧形：整节收敛当场永久丢失，仓不入 git 无从找回）",
               "接手入口三件" in _t2 and "旧版交接件只归档不删" in _t2, _t2[-260:])
        expect("与标准块逐行相同的**手写副本**被收敛成一份（单源达成，不是靠删独有内容）",
               _t2.count(_dup) == 1, f"{_t2.count(_dup)} 份")
        expect("独有条款落在块外专区（标记成对，--check 不参与比对）",
               REPO_BEGIN in _t2 and REPO_END in _t2
               and _t2.index(REPO_BEGIN) > _t2.index(END_MARK), _t2[-200:])
        expect("块外的其它章节未动", "## 命令" in _t2 and "make go" in _t2)
        rc2, out2 = run("agents-block", "--check", _sv)
        expect("安置后 --check rc=0（块外区不算漂移——这是「独有内容有家」的前提）", rc2 == 0, out2[-160:])
        rc2, out2 = run("agents-block", "--install", _sv)
        _t3 = _ab2.read_text(encoding="utf-8")
        expect("连跑两次 --install **幂等**：不长第二个仓专属区、独有条款不翻倍",
               rc2 == 0 and _t3.count(REPO_BEGIN) == 1 and _t3.count("旧版交接件只归档不删") == 1,
               f"{_t3.count(REPO_BEGIN)} 区")
        expect("以 `#` 开头的人写行第二次安装后**仍在**（旧筛法按前缀剔标题，会把这种行静默丢掉）",
               "#### 注：本仓的 handoff view 快照不入库" in _t3, _t3[-260:])
        _ab2.write_text(_t3.replace(END_MARK, "- 本仓专属：提交前先跑 make check。\n" + END_MARK, 1),
                        encoding="utf-8")
        rc2, out2 = run("agents-block", "--install", _sv)
        _t4 = _ab2.read_text(encoding="utf-8")
        expect("块内被插的人写行也被**搬到块外**而不是覆盖（同一根因不只修一半）",
               rc2 == 0 and "本仓专属：提交前先跑 make check" in _t4
               and _t4.index("本仓专属：提交前先跑 make check") > _t4.index(END_MARK), _t4[-220:])
        rc2, out2 = run("agents-block", "--check", _sv)
        expect("安置后块与标准源仍一致 rc=0", rc2 == 0, out2[-160:])
        # 增强档标记必须**成对**落地（5.1.2：只拼 begin 曾让各仓拿到残缺区，
        # 而 --check 两边同源于同一个函数 ⇒ 残缺在两边同时为真，永远比不出红）
        rc2, out2 = run("agents-block", "--install", _sv, "--profile", "freshness")
        _t5 = _ab2.read_text(encoding="utf-8")
        expect("freshness 档装出来 begin／end **成对**且顺序正确",
               rc2 == 0 and _t5.count(FRESH_BEGIN) == 1 and _t5.count(FRESH_END) == 1
               and _t5.index(FRESH_BEGIN) < _t5.index(FRESH_END) < _t5.index(END_MARK),
               f"begin {_t5.count(FRESH_BEGIN)}／end {_t5.count(FRESH_END)}")
        rc2, out2 = run("agents-block", "--check", _sv)
        expect("装了 freshness 档后 --check 仍 rc=0（档位自动识别没被打坏）", rc2 == 0, out2[-160:])
        # t000379：未装新鲜度判据的仓走默认 basic 档 ⇒ 不产出 freshness 指令（可核对）
        _svb = tempfile.mkdtemp(prefix="handoff-selftest-basic.")
        (Path(_svb) / "AGENTS.md").write_text("# t\n", encoding="utf-8")
        rc2, out2 = run("agents-block", "--install", _svb)
        _tb = (Path(_svb) / "AGENTS.md").read_text(encoding="utf-8")
        expect("t000379 basic 档不含 freshness 标记（未装判据的仓拿到可执行纪律）",
               rc2 == 0 and FRESH_BEGIN not in _tb and FRESH_END not in _tb, _tb[-200:])
        rc2, out2 = run("agents-block", "--check", _svb)
        expect("t000379 basic 档 --check rc=0（档位自动识别落在 basic）", rc2 == 0, out2[-160:])
        shutil.rmtree(_svb, ignore_errors=True)

        # ---- ⑲ t000406：块档位的**独立证据**（降级即红／install 不静默改档／自愈）----
        # 病根：档位此前**只能从被检查的文件里推** ⇒ 期望值取自被检查物本身 ⇒
        # 一次**不带 `--profile`** 的 `--install`（缺省 basic）就能把增强档仓**静默降级**
        # （增强档条款被搬出比对区 ⇒ 成了无人看守的手抄副本），而**降级对所有闸不可见**
        # （本仓 2026-10-20 的批 A 提交 38814f8 就是这么降的，跟到 2026-10-23 才被外报抓出）。
        # 修法：档位落进「装过块」那条 d 型记录（**独立证据**）⇒ 判据拿它与文件现状对账。
        _p6 = tempfile.mkdtemp(prefix="handoff-selftest-prof.")
        _p6_agents = Path(_p6) / "AGENTS.md"
        _p6_agents.write_text("# t\n", encoding="utf-8")
        _saved_p6 = cur_store[0]
        cur_store[0] = str(Path(_p6) / ".handoff")
        run("init")
        run("agents-block", "--install", _p6, "--profile", "freshness")
        _p6_recs = list((Path(cur_store[0]) / "decisions").glob("*.md"))
        expect("t000406 前置：档位记进了「装过块」那条 d 型记录（独立证据）",
               any(BLOCK_PROFILE_MARK + " freshness" in f.read_text(encoding="utf-8")
                   for f in _p6_recs),
               str([f.name for f in _p6_recs]))
        # 腿①：一次**不带 --profile** 的 --install ⇒ **不得**把 freshness 仓降级
        run("agents-block", "--install", _p6)
        _p6_txt = _p6_agents.read_text(encoding="utf-8")
        expect("t000406 腿①：不带 --profile 的 --install **不静默降级**（档位按记录解析）",
               FRESH_BEGIN in _p6_txt, _p6_txt[-200:])
        # 腿②：**降级**（增强档整段被搬出比对区——38814f8 干的就是这件事）⇒ check 必须报红
        _pl = _p6_txt.splitlines()
        _bi = next(i for i, l in enumerate(_pl) if l.strip() == FRESH_BEGIN)
        _ei = next(i for i, l in enumerate(_pl) if l.strip() == FRESH_END)
        _fresh_seg = _pl[_bi:_ei + 1]              # 标记 + 条款 + 结束标记，三行一段
        _rest = _pl[:_bi] + _pl[_ei + 1:]          # 从比对区里整段摘掉
        _down = "\n".join(_rest) + "\n\n" + "\n".join(_fresh_seg) + "\n"
        _p6_agents.write_text(_down, encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("t000406 腿②：降级（条款被搬出比对区）⇒ check 报红（此前对所有闸不可见）",
               rc2 != 0 and "agents-block" in out2, out2[-220:])
        rc2, out2 = run("agents-block", "--check", _p6)
        expect("t000406 腿②配套：CLI --check 明说「档位被降了」并给自愈命令",
               rc2 != 0 and ("档位" in out2) and ("--install" in out2), out2[-220:])
        # 腿③：一次**不带 --profile** 的 --install ⇒ 把降级**修回来**（按记录里的档位装）
        run("agents-block", "--install", _p6)
        expect("t000406 腿③：--install（不带 --profile）把降级修回来（自愈）",
               FRESH_BEGIN in _p6_agents.read_text(encoding="utf-8"),
               _p6_agents.read_text(encoding="utf-8")[-200:])
        rc2, out2 = run("check", "--no-log")
        expect("t000406 腿③配套：自愈后 check 绿", rc2 == 0, out2[-160:])
        # 变异自证：把记录里的档位行删掉 ⇒ 期望值退回「文件自己说的档位」⇒
        #   降级重新变成不可见 ⇒ 腿② 必须转绿（否则腿没咬住）。
        _p6_recf = next((f for f in (Path(cur_store[0]) / "decisions").glob("*.md")
                          if BLOCK_PROFILE_MARK in f.read_text(encoding="utf-8")), None)
        if _p6_recf is not None:
            _p6_rt = _p6_recf.read_text(encoding="utf-8")
            _p6_recf.write_text("\n".join(ln for ln in _p6_rt.splitlines()
                                           if not ln.startswith(BLOCK_PROFILE_MARK)) + "\n",
                                encoding="utf-8")
            _p6_agents.write_text(_down, encoding="utf-8")
            rc2, out2 = run("check", "--no-log")
            expect("t000406 变异自证：记录里没有档位 ⇒ 降级重新不可见（腿有牙）",
                   rc2 == 0 or "agents-block" not in out2, out2[-200:])
        cur_store[0] = _saved_p6
        shutil.rmtree(_p6, ignore_errors=True)
        shutil.rmtree(_sv, ignore_errors=True)
        cur_store[0] = _saved_store

        # ---- ⑳ t000409：点名窗口的真相——**打包**才是出路，「约 41 条」是量法假象 ----
        # 上一轮实测记的是：「窗口约 41 条（exit 班段 12 行 ＋ summary 热层 30 行）⇒
        # 同日登记 45 条 ⇒ 4 条点不到 ⇒ **当天判据无解**」。本轮复量（2026-10-23）：
        # 那个 41 是**一行一个 id** 量出来的 ⇒ **打包**（一行写多个 id）后，45 条（4 行）
        # 与 200 条（17 行）点名 ⇒ check **全绿** ⇒ 真实约束是热层**字节**（exit／summary
        # 各 8192 ⇒ 千条量级），**不是「41 条」** ⇒ 「当天判据无解」这个结论**被推翻**。
        # ⇒ 判据**口径不动**（口径 R 不动：那三个候选方向——工具代劳／抬配额／扫冷档——
        #   一个都不必做；见裁定件 d000146）。要修的是**报错没告诉作者可以打包**：
        #   一行一 id ⇒ 撞 summary 热层 30 行 ⇒ 看起来「无合法出口」⇒ p000122 同族
        #   （闸报错只说矛盾不给出口 ⇒ 能把存储锁死在 FAIL）。
        # 下面两条腿把事实钉住：① 只点名 40 条 ⇒ **红**（牙还在）且报错**自带打包提示**
        #   （出路在场）；② 补齐剩下 5 条 ⇒ **绿**（窗口不是 41 ⇒ 45 条打包放得下）。
        _pw = tempfile.mkdtemp(prefix="handoff-selftest-pack.")
        _saved_pw = cur_store[0]
        cur_store[0] = str(Path(_pw) / ".handoff")
        run("init")
        _pw_ids: list[str] = []
        for _k in range(45):
            rc2, out2 = run("add", "action", "--summary", f"批量登记第 {_k + 1} 条",
                            "--domain", "bulk")
            if rc2 != 0:
                break
            _pw_ids.append(out2.split("id=")[1].strip().split()[0])
        expect("t000409 前置：45 条同班登记成功", len(_pw_ids) == 45, f"实得 {len(_pw_ids)}")
        # 腿①：只点名 40 条（**打包**写法）⇒ 必须红（牙还在），且报错**自带打包提示**
        # ⚠ 切片必须**钳到 40**：`ids[36:48]` 会被 Python 钳到列表尾（=45）⇒ 于是「只点名
        #   40 条」实际点满了 45 条 ⇒ 这条腿**空转**（空腿恒绿，是夹具自己骗自己）。
        _pw_pack = []
        for _k in range(0, 40, 12):
            _pw_pack.append("本班批量登记：" + "、".join(_pw_ids[_k:min(_k + 12, 40)]))
        run("append", "summary", "--file", "-", inp="\n".join(_pw_pack) + "\n")
        rc2, out2 = run("check", "--no-log")
        expect("t000409 腿①：45 条只点名 40 条 ⇒ **报红**（牙还在：没点名的仍被要求点名）",
               rc2 != 0 and "fresh-queue" in out2, out2[-220:])
        expect("t000409 腿①配套：报错**自带出路**——明说可以打包（一行写多个 id）",
               "打包" in out2 and "一行" in out2, out2[-260:])
        # 腿②：补齐剩下 5 条 ⇒ 必须绿 ⇒ **45 条打包放得下**（「窗口约 41 条」是量法假象）
        _pw_tail = "本班批量登记补齐：" + "、".join(_pw_ids[40:])
        run("append", "summary", "--file", "-", inp=_pw_tail + "\n")
        rc2, out2 = run("check", "--no-log")
        expect("t000409 腿②：补齐后 ⇒ check 绿（45 条**打包**点名放得下 ⇒ 窗口不是 41 条）",
               rc2 == 0 or "fresh-queue" not in non_tamper(out2), out2[-220:])
        cur_store[0] = _saved_pw
        shutil.rmtree(_pw, ignore_errors=True)

        # ---- ㉑ v5.29.0（d000147）：庚案四刀——**旧形会锁死**的那条路径 ----
        # 旧形：导入大批条目 ⇒ exit 涨到 O(导入量) ⇒ `append exit` 被拒 ⇒ 班段永久
        # 写不进（且无自救出口）⇒ 唯一的出路是把未销账条目关到 ~430 条以下。
        # 新形：导入存量**有界** ⇒ 班段写得进 ⇒ 销账也不误报。
        _dq = tempfile.mkdtemp(prefix="handoff-selftest-v529.")
        _saved_dq = cur_store[0]
        cur_store[0] = str(Path(_dq) / ".handoff")
        run("init")
        _dq_manifest = Path(_dq) / "manifest.jsonl"
        _dq_recs = [{"_format": "handoff", "schema": 1, "exported": "2026-10-23", "counts": {}}]
        for _k in range(500):
            _dq_recs.append({"_kind": "entry", "_slot": "actions", "_domain": "legacy",
                             "summary": f"历史遗留待办第 {_k + 1} 条", "created": "2026-10-20",
                             "status": "open", "prio": "中"})
        _dq_recs.append({"_kind": "doc", "_slot": "exit",
                         "content": "## 旧班段 · 迁移前\n\n- 迁移进来的旧散文。\n"})
        _dq_manifest.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in _dq_recs) + "\n",
                                encoding="utf-8")
        rc2, out2 = run("import", str(_dq_manifest))
        expect("v5.29.0⑪前置：500 条无 id 清单导入成功", rc2 == 0, out2[-160:])
        _dq_exit = Path(cur_store[0]) / "exit"
        _dq_bytes = len(_dq_exit.read_text(encoding="utf-8"))
        expect("v5.29.0⑪：导入后 exit **有界**（旧形：500 条 ⇒ 6138 字节 ⇒ 逼近 8192 上限）",
               _dq_bytes < 1024, f"实得 {_dq_bytes} 字节")
        rc2, out2 = run("check", "--no-log")
        expect("v5.29.0⑪配套：导入后 check 绿（导入存量**不算本班新增** ⇒ 不用逐条点名）",
               rc2 == 0 or "fresh-queue" not in non_tamper(out2), out2[-200:])
        run("append", "exit", "--file", "-", inp="## 10-23 班段 · 接手\n\n- 这一班做了一件事。\n")
        rc2, out2 = run("append", "exit", "--file", "-", inp="## 10-23 班段 · 第二班\n\n- 又做了一件事。\n")
        expect("v5.29.0⑫：**班段写得进**（旧形：500 条 ⇒ 新热层 9661 字符 > 8192 ⇒ append rc=1 ⇒ 永久锁死）",
               rc2 == 0, out2[-160:])
        rc2, out2 = run("check", "--no-log")
        expect("v5.29.0⑫配套：写完班段后 check 仍绿", rc2 == 0 or not non_tamper(out2).strip(), out2[-200:])
        # 导入条目销账 ⇒ 库里状态变了 ⇒ 判据仍绿。
        # ⚠ **v5.32.0**：这条**不再靠「fresh-stale 不报」来保证**——散文已不承担状态，
        #   判据面也不拿散文比库里活状态 ⇒ 这里断言的是「销账本身不引入新问题」。
        run("close", "t000001", "--outcome", "关一条试试")
        rc2, out2 = run("check", "--no-log")
        expect("v5.32.0：导入条目销账后 check 仍绿（散文不承担状态 ⇒ 无「状态副本」类误报）",
               rc2 == 0 or not non_tamper(out2).strip(), out2[-200:])
        cur_store[0] = _saved_dq
        shutil.rmtree(_dq, ignore_errors=True)

        # ---- ㉒ v5.29.0 刀 2：口径 R2 —— 推不动的条目**只有本班新增的**要点名 ----
        # 旧形（R 段①）要求推不动的条目**全部**逐条点名 ⇒ O(存量) 的散文义务 ⇒
        # 与「区落盘」同型的第二个死锁支（拐点按字节预算 ≈1800 条）。
        # 新形：parked 与 actionable 统一为「本班新增才要点名」；存量的推不动的条目
        # 由**读时现算的视图**承担（`view` 逐条列出，还带「等 owner」为什么推不动）。
        # ⚠ v5.31.0 壬-2：「点名」（散文）⇒「**声明**」（`--covers`，落进班次台账）。
        #   跨秒 `sleep` 也一并去掉：界碑改**班次序号**后不再有时钟粒度问题。
        _pk = tempfile.mkdtemp(prefix="handoff-selftest-v529p.")
        _saved_pk = cur_store[0]
        cur_store[0] = str(Path(_pk) / ".handoff")
        run("init")
        for _k in range(3):
            run("add", "action", "--summary", f"推不动的第 {_k + 1} 条", "--domain", "p",
                "--status", "blocked", "--waitingFor", "owner")
        rc2, out2 = run("check", "--no-log")
        expect("v5.29.0⑭：本班新增的推不动的条目 ⇒ **仍要点名**（牙没丢）",
               rc2 != 0 and "fresh-queue" in out2, out2[-200:])
        # v5.31.0：班段要**声明**它覆盖的条目 ⇒ 声明齐全 ⇒ 判据绿
        rc2, out2 = run("append", "exit", "--file", "-",
                        "--covers", "t000001,t000002,t000003",
                        inp="## 10-23 班段 · 接手\n\n- 这一班接手了三条推不动的活。\n")
        expect("v5.29.0⑭配套：声明齐全 ⇒ 写入面放行（牙在写入面，不靠事后红）",
               rc2 == 0, out2[-160:])
        rc2, out2 = run("check", "--no-log")
        expect("v5.29.0⑭配套：声明后 ⇒ 绿",
               rc2 == 0 or "fresh-queue" not in non_tamper(out2), out2[-200:])
        # 再写一班段 ⇒ 边界前移 ⇒ 它们不再算「本班新增」⇒ **不再要求声明**
        # （且上一班的声明已随旧节进冷档 ⇒ 这才是真正的「义务只与增量有关」）
        rc2, out2 = run("append", "exit", "--file", "-", inp="## 10-23 班段 · 第二班\n\n- 又做了一件事。\n")
        rc2, out2 = run("check", "--no-log")
        expect("v5.29.0⑮：跨班后推不动的存量条目**不再要求声明**（旧形永远要点名 ⇒ O(存量) 义务）",
               "fresh-queue" not in out2, out2[-200:])
        cur_store[0] = _saved_pk
        shutil.rmtree(_pk, ignore_errors=True)

        # ---- v5.30.0 刀 A：判据输入的**形状**（「一槽三职」的立即缓解） ----------------
        # `FIND_ID_RE` 原来用 `\bt\d{6}\b`，而 Python 的 `\b` 把**汉字当词字符** ⇒ id 紧跟汉字时
        # 不存在词边界 ⇒「修好了t000001这条」这类**最自然的中文写法扫不到** ⇒ 两个方向都伤：
        #   ① **误报**：作者确实点了名，fresh-queue 仍判「没点名」⇒ 红（2026-10-23 实测 rc=1）；
        #   ② **漏报**：同一模式喂 fresh-stale/fresh-false ⇒ 紧跟汉字的 id **根本进不了检查**
        #      ⇒「把活的说成死的」能写进散文且不被报（**写时守卫也扫不到**）⇒ 错写落库。
        # ⇒ v5.30.0：改「非 ASCII 字母数字边界」＋**大小写不敏感**（捕获后统一小写再查库）。
        # ⚠ **v5.31.0 壬-2 之后这个正则换了岗位**：fresh-queue 的判据输入已经是**结构化声明**
        #   ⇒ 散文里的 id 形状**不再影响** fresh-queue；正则只剩两个用处：
        #     · **老班段**（v5.31.0 之前写的班段）⇒ 判据退回扫散文 ⇒ 形状仍然要紧；
        #     · **写时守卫**（fresh-false／d000105：把活的说成死的）⇒ 形状仍然要紧。
        #   ⇒ 这组腿因此拆成两半：**A-新**（散文形状与判定无关）＋ **A-老**（形状仍然要紧）。
        # 用**独立临时库**跑：自己造「本班新增且必须声明」的最严场景（没写过班段时边界为空 ⇒
        # 一切能推的条目都算本班新增），不碰共享夹具的时序。
        _qa = tempfile.mkdtemp(prefix="handoff-selftest-v530a.")
        _saved_qa = cur_store[0]
        cur_store[0] = str(Path(_qa) / ".handoff")
        run("init")
        _, _qa_o = run("add", "action", "--summary", "刀A 腿：id 紧跟汉字的写法")
        _qa_id = next(iter(re.findall(r"id=(t\d+)", _qa_o)), "")
        _qa_exit = Path(cur_store[0]) / "exit"
        # A-新①：散文里 id **紧跟汉字**（最自然的中文写法）＋ 声明齐全 ⇒ 判据**照样绿**
        #   （证明 fresh-queue 已不解析散文：散文的形状与判定**无关**）
        run("append", "exit", "--file", "-", "--covers", _qa_id,
            inp=f"## 10-23 刀A 班段一\n\n- 修好了{_qa_id}这条\n")
        rc2, out2 = run("check", "--no-log")
        expect("v5.31.0 A-新①：散文里的 id **紧跟汉字** ⇒ 判据照样绿（判据不再解析散文）",
               "fresh-queue" not in out2, out2[-200:])
        # A-新②：**散文里一个 id 都没有**（只有声明）⇒ 同样绿 ⇒ 散文回归纯叙述
        _, _qa_o2 = run("add", "action", "--summary", "刀A 腿：只有声明没有散文 id")
        _qa_id2 = next(iter(re.findall(r"id=(t\d+)", _qa_o2)), "")
        run("append", "exit", "--file", "-", "--covers", _qa_id2,
            inp="## 10-23 刀A 班段二\n\n- 这一班推进了两件事。\n")
        rc2, out2 = run("check", "--no-log")
        expect("v5.31.0 A-新②：散文里**一个 id 都没有** ⇒ 判据照样绿（散文纯叙述、声明才是输入）",
               "fresh-queue" not in out2, out2[-200:])
        # A-新③ 变异自证：把判据切回**扫散文** ⇒ A-新② 的绿必须转红 ⇒ 证明那个绿真是
        #   「按声明判」带来的（不是「判据压根不报」的空腿）。
        _orig_cov = _shift_covered
        try:
            globals()["_shift_covered"] = lambda st: (None, True)   # ⇒ 退回旧口径（扫散文）
            rc2, out2 = run("check", "--no-log")
        finally:
            globals()["_shift_covered"] = _orig_cov
        expect("v5.31.0 A-新③ 变异自证：判据切回扫散文 ⇒ 转红（证明绿来自「按声明判」）",
               "fresh-queue" in out2 and _qa_id2 in out2, out2[-200:])
        rc2, out2 = run("check", "--no-log")
        expect("v5.31.0 A-新③·还原：还原后回到绿（变异没留下痕迹）",
               "fresh-queue" not in out2, out2[-200:])
        # A-新④（**v5.32.0 改写**）：把**活着的**条目写成「已闭」⇒ **不再拒写**
        #   （写面不因状态拒写）⇒ 但**括号型标记被规范化掉** ⇒ 错写不进散文
        #   ⇒ 读者看的是渲染出来的**真状态**（〔在册〕）。
        #   （旧形靠写时守卫拒写；新形靠**规范化 ＋ 渲染**⇒ 用可见性换拦截力。）
        rc2, out2 = run("append", "exit", "--file", "-", "--covers", _qa_id,
            inp=f"## 10-23 刀A 班段三\n\n- 已处理{_qa_id}（已闭）这条\n")
        _qa_txt = _qa_exit.read_text(encoding="utf-8")
        expect("v5.32.0 A-新④：活着的条目被写成「已闭」⇒ 放行但**标记被规范化掉**（错写不进散文）",
               rc2 == 0 and "（已闭）" not in _qa_txt,
               f"rc={rc2} {out2[-160:]}")
        cur_store[0] = _saved_qa
        shutil.rmtree(_qa, ignore_errors=True)

        # ---- v5.31.0 壬-2：**老班段兼容**（判据退回旧口径扫散文） --------------------
        # 老库（v5.31.0 之前写的班段）⇒ 最近班段**没有** `covers` 字段 ⇒ 判据退回**旧口径**
        # （扫散文，逐字与升级前一致）⇒ 迁移不误伤。这一组把**旧口径仍然要紧的东西**钉住：
        # 散文里 id 的**形状**（汉字紧邻算／ASCII 粘连不算／大写算）＋ **界碑**取法。
        # ⚠ 「老班段」怎么造：`make_legacy_shift()` 把最近一条班次记录的 `covers` 字段抹掉
        #   （＝模拟 v5.31.0 之前写的库）——代价：写事件对账维会报「未经 CLI 记录的写入」
        #   ⇒ 这组腿一律用 `non_tamper()` 过滤（只断言 fresh-queue 维的结论）。
        _ql = tempfile.mkdtemp(prefix="handoff-selftest-v531legacy.")
        _saved_ql = cur_store[0]
        cur_store[0] = str(Path(_ql) / ".handoff")
        _ql_exit = Path(cur_store[0]) / "exit"

        def _ql_write_exit(text: str) -> None:
            """直写 exit 散文（绕过 CLI）——老口径组的散文变体就靠它造。"""
            _ql_exit.write_text(text, encoding="utf-8")

        run("init")
        _, _ql_o1 = run("add", "action", "--summary", "老口径腿：存量条目 F")
        _ql_f = next(iter(re.findall(r"id=(t\d+)", _ql_o1)), "")
        run("append", "exit", "--file", "-", "--covers", _ql_f,
            inp=f"## 老班段一\n\n- 这一班处理了{_ql_f}。\n")
        _, _ql_o2 = run("add", "action", "--summary", "老口径腿：本班新增条目 E")
        _ql_e = next(iter(re.findall(r"id=(t\d+)", _ql_o2)), "")
        run("append", "exit", "--file", "-", "--covers", f"{_ql_f},{_ql_e}",
            inp=f"## 老班段二\n\n- 这一班处理了{_ql_e}。\n")
        make_legacy_shift()          # ⇒ 最近班段**没有** covers ⇒ 判据走**老口径**
        # 老①：老班段 ⇒ 判据退回扫散文 ⇒ 散文点了名 ⇒ **绿**（迁移不误伤）
        rc2, out2 = run("check", "--no-log")
        expect("v5.31.0 老①：老班段（无 covers）⇒ 判据退回旧口径扫散文 ⇒ 散文点了名 ⇒ 绿",
               "fresh-queue" not in non_tamper(out2), out2[-200:])
        # 老②：老班段 ⇒ 散文**没点名** ⇒ **红**（牙仍在：老口径不是摆设）
        _ql_write_exit("## 老班段二\n\n- 这一班做了一件事。\n")
        rc2, out2 = run("check", "--no-log")
        expect("v5.31.0 老②：老班段 ⇒ 散文没点名 ⇒ 报红并点名它（老口径的牙仍在）",
               rc2 != 0 and "fresh-queue" in out2 and _ql_e in out2, out2[-200:])
        # 老③（v5.30.0 A① 的老口径形态）：id **紧跟汉字** ⇒ 算数 ⇒ 绿
        #   （旧正则 `\b` 把汉字当词字符 ⇒ 作者点了名仍 rc=1）
        _ql_write_exit(f"## 老班段二\n\n- 修好了{_ql_e}这条\n")
        rc2, out2 = run("check", "--no-log")
        expect("v5.31.0 老③：id **紧跟汉字**的写法也算点名 ⇒ 老口径下不误报（v5.30.0 A① 的老形态）",
               "fresh-queue" not in non_tamper(out2), out2[-200:])
        # 老④（v5.30.0 A④ 的老口径形态）：id 与 ASCII 字母**粘连** ⇒ **不算数** ⇒ 红
        _ql_write_exit(f"## 老班段二\n\n- 修好了x{_ql_e}这条\n")
        rc2, out2 = run("check", "--no-log")
        expect("v5.31.0 老④：id 与 ASCII 字母粘连 ⇒ **不算提及** ⇒ 老口径下仍报红（闸没改瞎）",
               "fresh-queue" in out2 and _ql_e in out2, out2[-200:])
        # 老⑤（v5.30.0 A⑤ 的老口径形态）：散文里写**大写** id 也算提及
        _ql_write_exit(f"## 老班段二\n\n- 修好了{_ql_e.upper()}这条\n")
        rc2, out2 = run("check", "--no-log")
        expect("v5.31.0 老⑤：散文里的**大写** id 也算提及（免得因大小写判作者「没点名」）",
               "fresh-queue" not in non_tamper(out2), out2[-200:])
        # 老⑥（t000407 变异自证 M2 的老口径形态）：把界碑退回「**最后一次**散文写入」
        #   ⇒ 牙没了、转绿（证明老口径下界碑取法仍然要紧）
        _ql_write_exit("## 老班段二\n\n- 这一班做了一件事。\n")
        rc2, out2 = run("check", "--no-log")
        expect("v5.31.0 老⑥前置：老口径下散文没点名 ⇒ 红",
               "fresh-queue" in out2 and _ql_e in out2, out2[-200:])
        _orig_cut_l = _shift_boundary
        try:
            globals()["_shift_boundary"] = lambda st, offset=-1: _orig_cut_l(st, -1)
            rc_m2, out_m2 = run("check", "--no-log")
        finally:
            globals()["_shift_boundary"] = _orig_cut_l
        expect("v5.31.0 老⑥：界碑退回「最后一次散文写入」⇒ 牙没了、转绿（该腿有牙）",
               rc_m2 == 0 or "fresh-queue" not in non_tamper(out_m2),
               f"rc={rc_m2} {out_m2[-200:]}")
        rc2, out2 = run("check", "--no-log")
        expect("v5.31.0 老⑥·还原：界碑还原 ⇒ 牙回来、转红（变异没留下痕迹）",
               "fresh-queue" in out2 and _ql_e in out2, out2[-200:])
        # 老⑦（t000407 变异自证 M1 的老口径形态）：比较退回**日粒度** ⇒ 存量条目 F
        #   又被要求点名 ⇒ 转红（散文只点名了 E ⇒ 缺 F ⇒ 红）
        _ql_write_exit(f"## 老班段二\n\n- 这一班处理了{_ql_e}。\n")
        rc2, out2 = run("check", "--no-log")
        expect("v5.31.0 老⑦前置：老口径下散文点名了 E ⇒ 绿",
               "fresh-queue" not in non_tamper(out2), out2[-200:])
        _orig_isn_l = _is_shift_new

        def _isn_day_l(r: dict, b: dict) -> bool:
            try:
                _c = _entry_created_dt(r)
                _t = b.get("ts")
                if _c is None or not _t:
                    return True
                return _as_aware(_c).date() >= _as_aware(datetime.fromisoformat(str(_t))).date()
            except (TypeError, ValueError):
                return True
        try:
            globals()["_is_shift_new"] = _isn_day_l
            rc_m1, out_m1 = run("check", "--no-log")
        finally:
            globals()["_is_shift_new"] = _orig_isn_l
        expect("v5.31.0 老⑦：比较退回日粒度 ⇒ 存量又被要求点名、转红（该腿有牙）",
               rc_m1 != 0 and "fresh-queue" in out_m1 and _ql_f in out_m1,
               f"rc={rc_m1} {out_m1[-200:]}")
        rc2, out2 = run("check", "--no-log")
        expect("v5.31.0 老⑦·还原：还原后回到绿（变异没留下痕迹）",
               "fresh-queue" not in non_tamper(out2), out2[-200:])
        cur_store[0] = _saved_ql
        shutil.rmtree(_ql, ignore_errors=True)

        # ---- v5.31.0 壬-2：结构化**覆盖声明**（`--covers`）——专项组 ------------------
        # 这一组钉住壬-2 的**全部**新机制（独立临时库，状态逐条可控）：
        #   ① 声明齐全 ⇒ 绿（散文可以**完全不提 id**）
        #   ② 缺声明 ⇒ **写入即拒**（报错点名要声明的 id＋给出现成写法）
        #   ③ 声明不全 ⇒ 写入即拒
        #   ④ 声明了库里查不到的 id ⇒ 写入即拒（写错 id 声明了等于没声明）
        #   ⑤ 「先 close 再声明」这条自然动线**不被拒死**（已闭 id 允许声明）
        #   ⑥ 散文里写了 id 但没声明 ⇒ **判据照样红**（判据输入是声明，不是散文）
        _qn = tempfile.mkdtemp(prefix="handoff-selftest-v531n2.")
        _saved_qn = cur_store[0]
        cur_store[0] = str(Path(_qn) / ".handoff")
        run("init")
        _, _qn_o1 = run("add", "action", "--summary", "壬-2 腿：条目一")
        _qn_e1 = next(iter(re.findall(r"id=(t\d+)", _qn_o1)), "")
        # ① 声明齐全 ＋ **散文里一个 id 都没有** ⇒ 绿（判据输入＝声明）
        rc2, out2 = run("append", "exit", "--file", "-", "--covers", _qn_e1,
                         inp="## 壬-2 班段一\n\n- 这一班推进了一件事。\n")
        expect("壬-2①：声明齐全 ⇒ 写入放行", rc2 == 0, out2[-160:])
        rc2, out2 = run("check", "--no-log")
        expect("壬-2①：声明齐全 ＋ 散文**不提 id** ⇒ 判据绿（散文回归纯叙述）",
               "fresh-queue" not in non_tamper(out2), out2[-200:])
        # ② 登记新条目后**不声明** ⇒ 写入即拒（牙前移到写入面，d000149）
        _, _qn_o2 = run("add", "action", "--summary", "壬-2 腿：条目二")
        _qn_e2 = next(iter(re.findall(r"id=(t\d+)", _qn_o2)), "")
        rc2, out2 = run("append", "exit", "--file", "-", inp="## 壬-2 班段二\n\n- 又做了一件事。\n",
                         covers=False)
        expect("壬-2②：没点名也没声明 ⇒ **写入即拒**，且报错点名要点名的 id ＋ 给出现成写法",
               rc2 != 0 and "必须点名覆盖" in out2 and _qn_e2 in out2 and "--covers" in out2,
               f"rc={rc2} {out2[-220:]}")
        # ③ 声明**不全**（少了新登记那条）⇒ 写入即拒
        rc2, out2 = run("append", "exit", "--file", "-", "--covers", _qn_e1,
                         inp="## 壬-2 班段二\n\n- 又做了一件事。\n", covers=[_qn_e1])
        expect("壬-2③：声明不全 ＋ 散文也没点名 ⇒ **写入即拒**（少一条都不放行）",
               rc2 != 0 and "必须点名覆盖" in out2 and _qn_e2 in out2,
               f"rc={rc2} {out2[-220:]}")
        # ④ 声明了库里**查不到**的 id ⇒ 写入即拒（写错 id 声明了等于没声明）
        rc2, out2 = run("append", "exit", "--file", "-", "--covers", f"{_qn_e1},t999999",
                         inp="## 壬-2 班段二\n\n- 又做了一件事。\n")
        expect("壬-2④：声明了库里查不到的 id ⇒ 写入即拒（不猜、不静默）",
               rc2 != 0 and "--covers" in out2, f"rc={rc2} {out2[-200:]}")
        rc2, out2 = run("append", "exit", "--file", "-", "--covers", "不是id",
                         inp="## 壬-2 班段二\n\n- 又做了一件事。\n")
        expect("壬-2④配套：声明的 id 形态不对 ⇒ 写入即拒", rc2 != 0, f"rc={rc2} {out2[-160:]}")
        # ⑤ 「先 close 再声明」这条自然动线**不被拒死**（本班刚办完的条目正是要交代的）
        rc2, _ = run("close", _qn_e2, "--outcome", "壬-2 腿：条目二已办完")
        rc2, out2 = run("append", "exit", "--file", "-", "--covers", f"{_qn_e1},{_qn_e2}",
                         inp="## 壬-2 班段二\n\n- 这一班把条目二办完了。\n")
        expect("壬-2⑤：close 之后**仍可声明**它（自然动线不被拒死）",
               rc2 == 0, f"rc={rc2} {out2[-200:]}")
        rc2, out2 = run("check", "--no-log")
        expect("壬-2⑤配套：声明齐全 ⇒ 判据绿", "fresh-queue" not in non_tamper(out2), out2[-200:])
        # ⑥ **散文里写了 id、但没声明** ⇒ 判据照样红（判据输入是声明，不是散文）
        _, _qn_o3 = run("add", "action", "--summary", "壬-2 腿：条目三")
        _qn_e3 = next(iter(re.findall(r"id=(t\d+)", _qn_o3)), "")
        _qn_exit = Path(cur_store[0]) / "exit"
        _qn_exit.write_text(f"## 直写\n\n- 修好了{_qn_e3}这条\n", encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("壬-2⑥：散文里**写了 id**、但没声明 ⇒ 判据照样红（判据不解析散文）",
               rc2 != 0 and "fresh-queue" in out2 and _qn_e3 in out2, out2[-200:])
        cur_store[0] = _saved_qn
        shutil.rmtree(_qn, ignore_errors=True)
        shutil.rmtree(_ql, ignore_errors=True)

        # ---- v5.30.0 刀 C：热层写入**唯一漏斗**（约束只有一个施加点） -----------------
        # 旧形：热层字节闸 `HOT_CAPS` 有**三处调用点实现**（`cmd_append`／`cmd_set`／
        # `sync_counts`），而 `cmd_import` **直写文件、绕过全部** ⇒ 实测：导入可写出 exit
        # **16220** 字节（上限 8192）而 `check` 仍绿（判据面没有这一维）⇒ 违规库被**合法
        # 写者**造出来、且无人知；随后 `set exit` 一直被拒、整槽覆写这条路死掉。
        # ⇒ v5.30.0：所有热层槽的落盘都经 `_write_slot()`（剥渲染块 → 字节闸 → prev 快照
        #    → 落盘 → 写事件台账）⇒ 闸只有一个施加点 ⇒ 「写点清单」这类复发机制消失。
        # 结构腿：源码里 `HOT_CAPS` 的**代码引用**必须**只有一处**——多一处就是「第二处
        #   实现」的复发苗头。用 **AST 计数**（只认 `Load` 上下文的 `Name` 节点）⇒ 注释、
        #   文档字符串、本腿自己的正则字面量都不算 ⇒ 判据不脆。
        import ast as _ast_c
        _src_c = Path(__file__).read_text(encoding="utf-8")
        _cap_refs = [n for n in _ast_c and _ast_c.walk(_ast_c.parse(_src_c))
                     if isinstance(n, _ast_c.Name) and n.id == "HOT_CAPS"
                     and isinstance(n.ctx, _ast_c.Load)]
        expect("v5.30.0 C③结构腿：热层字节闸在源码里**只有一个施加点**"
               "（`HOT_CAPS` 的代码引用恰好 1 处；多一处＝分叉的起点）",
               len(_cap_refs) == 1, f"实得 {len(_cap_refs)} 处")
        # ---- v5.36.0（批 C）合同—腿对齐 ①：**取值点唯一** ----
        # C③ 只数了「**读** `HOT_CAPS`」的处数（施加点唯一）；「**写**」若在两处定义，
        # 两个漏斗会各有一份上限值 ⇒ 闸会分叉 ⇒ 补一条数**定义**的腿（取值点唯一）。
        _cap_defs = [n for n in _ast_c.walk(_ast_c.parse(_src_c))
                     if isinstance(n, _ast_c.Name) and n.id == "HOT_CAPS"
                     and isinstance(n.ctx, _ast_c.Store)]
        expect("v5.36.0 C-取值点腿：热层字节闸的**取值点**在源码里恰好 1 处"
               "（上限值只有一份 ⇒ 闸不会分叉）",
               len(_cap_defs) == 1, f"实得 {len(_cap_defs)} 处")
        # ---- v5.36.0（批 C）合同—腿对齐 ②：**零落盘腿补 exit/set** ----
        # v5.31.0 的 C⑤ 只覆盖 `append summary` 的「拒写零落盘」⇒ `set exit`／`set summary`
        # 被拒时是否零落盘**没有腿** ⇒ 整槽覆写这条路若留下半写，事后没人知道。
        _qc3 = tempfile.mkdtemp(prefix="handoff-selftest-v536c.")
        _saved_qc3 = cur_store[0]
        cur_store[0] = str(Path(_qc3) / ".handoff")
        run("init")
        run("append", "exit", "--file", "-", inp="## 原有班段\n\n- 原有内容\n")
        _big536 = "超长散文。" * 2000          # ≫ 热层上限（**自备变量**：`_big` 在下面才被重定义）
        _qc3_exit = Path(cur_store[0]) / "exit"
        _qc3_before = _qc3_exit.read_text(encoding="utf-8") if _qc3_exit.is_file() else ""
        rc2, out2 = run("set", "exit", inp=_big536)
        _qc3_after = _qc3_exit.read_text(encoding="utf-8") if _qc3_exit.is_file() else ""
        expect("v5.36.0 C-零落盘①：`set exit` 超上限被拒 ⇒ **盘上原内容不变**（拒写零落盘）",
               rc2 != 0 and _qc3_before == _qc3_after, f"rc={rc2} {out2[-120:]}")
        rc2, out2 = run("set", "summary", inp=_big536)
        _qc3_sum = Path(cur_store[0]) / "summary"
        expect("v5.36.0 C-零落盘②：`set summary` 超上限被拒 ⇒ **盘上没有半写的 summary**",
               rc2 != 0 and (not _qc3_sum.is_file()
                             or not _qc3_sum.read_text(encoding="utf-8").strip()),
               f"rc={rc2} {out2[-120:]}")
        cur_store[0] = _saved_qc3
        shutil.rmtree(_qc3, ignore_errors=True)

        # ---- v5.37.0（覆盖实测轮）五批**验收线补齐**：三条腿 --------------------
        # ① `append summary` 与 `set summary` **同口径**：v5.32.0 的状态规范化挂在
        #    `set`（散文槽）与 `append exit` 上，**漏了 `append summary`** ⇒ 同一个槽
        #    两条写路产出不同 ⇒ 状态副本仍能从这条路产生 ⇒ 验收线 A4「新写不再产生
        #    状态副本」未真正达成（覆盖实测轮实算发现）。
        #    **独立临时库**：共享库里 summary 槽有前面各组留下的内容 ⇒ 断言会互相干扰。
        _q537 = tempfile.mkdtemp(prefix="handoff-selftest-v537.")
        _saved_q537 = cur_store[0]
        cur_store[0] = str(Path(_q537) / ".handoff")
        run("init")
        run("set", "summary", inp="t000001（已闭）\n")
        _q537_sum = Path(cur_store[0]) / "summary"
        _q537_set = _q537_sum.read_text(encoding="utf-8") if _q537_sum.is_file() else ""
        run("append", "summary", "--file", "-", inp="t000002（已闭）\n")
        _q537_app = _q537_sum.read_text(encoding="utf-8") if _q537_sum.is_file() else ""
        expect("v5.37.0 ①：`append summary` 与 `set summary` **同口径**"
               "（两条写路都规范化掉括号状态标记 ⇒ 新写不再产生状态副本）",
               "（已闭）" not in _q537_set and "（已闭）" not in _q537_app,
               f"set={_q537_set.strip()!r}／append={_q537_app.strip()!r}")
        # 变异自证：摘掉规范化 ⇒ ①必须转红（该腿有牙）
        _real_norm537 = normalize_state_claims
        try:
            globals()["normalize_state_claims"] = lambda text: (text, [])
            run("append", "summary", "--file", "-", inp="t000003（已闭）\n")
            _mut537 = _q537_sum.read_text(encoding="utf-8") if _q537_sum.is_file() else ""
            expect("v5.37.0 ①·变异：摘掉规范化 ⇒ ①转红（该腿有牙）",
                   "（已闭）" in _mut537, _mut537.strip()[:80])
        finally:
            globals()["normalize_state_claims"] = _real_norm537
        cur_store[0] = _saved_q537
        shutil.rmtree(_q537, ignore_errors=True)
        # ② **判据文案里不许出现「新鲜度维的计数」**：那条数会随作废/新增维度变
        #    （v5.32.0 作废两维后，旧文案仍写「三道新鲜度维」⇒ 权威件假称）。
        #    按「会变的数字只允许有一个产生源」⇒ **数不出现在文案里**，只由维表本身产生。
        _FRESH_CNT_RE = re.compile(r"[一二三四五六七八九十两\d]+\s*道新鲜度维")

        def _no_fresh_count(_texts) -> list:
            return [(d[0], m.group(0)) for d in _texts for m in [_FRESH_CNT_RE.search(d[1])] if m]

        _fresh_bad = _no_fresh_count(CHECK_DIMENSIONS)
        _fresh_n = len([d for d in CHECK_DIMENSIONS if d[0].startswith("fresh-")])
        expect("v5.37.0 ②：判据文案里**不出现新鲜度维的计数**"
               f"（实际 {_fresh_n} 道；文案里数出来的 {len(_fresh_bad)} 处）",
               not _fresh_bad, f"文案里数了：{_fresh_bad}")
        # 变异自证：把计数塞回文案 ⇒ ②必须转红（该腿有牙）
        _mut_fresh = [("decision-pending", "也不被三道新鲜度维点名")]
        expect("v5.37.0 ②·变异：文案里写死计数 ⇒ ②转红（该腿有牙）",
               bool(_no_fresh_count(_mut_fresh)),
               f"检查器没认出「三道新鲜度维」")
        # ③ **块内容闸抓中文数字＋量词的具体计数**（旧形只收「X条」与「数字＋量词」
        #    ⇒ 中文数字＋其它量词全漏，连它自己 docstring 举的例句都抓不到）。
        _cnt_forms = ["三条规则", "三道新鲜度闸", "两项纪律", "三步流程", "四次写入", "3 条"]
        _cnt_missed = [f for f in _cnt_forms if not BLOCK_COUNT_RE.search(f)]
        expect("v5.37.0 ③：内容闸抓**中文数字＋量词**的具体计数（旧形全漏这几种）",
               not _cnt_missed, f"没抓到：{_cnt_missed}")
        expect("v5.37.0 ③·变异：中文数字＋量词塞进块里 ⇒ 判定立刻红（该腿有牙）",
               block_line_violation("- 本块共三道新鲜度闸，逐条检查。") is not None,
               "分类器没认出具体计数")

        # ---- v5.38.0：判据的**面**从「行级」升到「载体 × 行 × 引用」 -----------
        # ① **引用不改写**：code span（反引号）里的窄形态是**引文**（证据、举例、
        #    旧形示范），不是状态断言 ⇒ 规范化不得改写它（v5.32.0 的旧形会把证据改坏：
        #    实测 `旧形要求写成 `t000417（已闭）`` 落盘成 `` `t000417` `` ⇒ 证据被抹掉）。
        _q538 = tempfile.mkdtemp(prefix="handoff-selftest-v538.")
        _saved_q538 = cur_store[0]
        cur_store[0] = str(Path(_q538) / ".handoff")
        run("init")
        run("set", "exit", inp="## 引文\n- 旧形要求写成 `t000001（已闭）`，这是证据。\n")
        _q538_exit = Path(cur_store[0]) / "exit"
        _q538_disk = _q538_exit.read_text(encoding="utf-8") if _q538_exit.is_file() else ""
        expect("v5.38.0 ①：**引文不被改写**（code span 里的窄形态原样保留 ⇒ 证据不丢）",
               "`t000001（已闭）`" in _q538_disk, _q538_disk.strip()[:160])
        # 变异自证：把「跳过 code span」摘掉 ⇒ ①必须转红（该腿有牙）
        _real_spans538 = _code_spans
        try:
            globals()["_code_spans"] = lambda line: []
            run("set", "exit", inp="## 引文\n- 旧形要求写成 `t000001（已闭）`，这是证据。\n")
            _mut538 = _q538_exit.read_text(encoding="utf-8") if _q538_exit.is_file() else ""
            expect("v5.38.0 ①·变异：不跳过 code span ⇒ ①转红（该腿有牙）",
                   "`t000001（已闭）`" not in _mut538, _mut538.strip()[:120])
        finally:
            globals()["_code_spans"] = _real_spans538
        # ② **读面：标注落在引用外边**（引用不被污染，真状态仍然给出）——v5.37.0 的
        #    H2（标注插进反引号内）由此一并解决：同一口径「引用不改写，真状态在旁给」。
        _rc538, _o538 = run("add", "action", "--summary", "引文腿：被点名的一条")
        _q538_id = next(iter(re.findall(r"id=(t\d+)", _o538)), "")
        run("close", _q538_id, "--outcome", "收口")
        run("set", "exit", inp=f"## 引文\n- 旧形要求写成 `{_q538_id}（已闭）`，这是证据。\n")
        _rc538, _v538 = run("view")
        _v538_txt = _v538 or ""
        _quoted_ok = (f"`{_q538_id}（已闭）`" in _v538_txt
                      and f"`{_q538_id}（已闭）`〔已闭 " in _v538_txt)
        expect("v5.38.0 ②：`view` 的标注落在**引用外边**（引用完整 ＋ 真状态仍给出）",
               _quoted_ok, [l for l in _v538_txt.splitlines() if "〔" in l][:1])
        # ③ **面**：现况叙述面（槽级散文）与**条目级载体**（live 归档 裁定）不相交
        #    ——历史面（归档行／裁定正文）不在面内：工具不裁决历史文档。
        _entry_carriers = tuple(ENTRY_SLOTS) + STATE_HISTORY_CARRIERS
        _overlap = [s for s in PROSE_SLOTS if s in _entry_carriers]
        expect("v5.38.0 ③：现况叙述面**不含任何条目级载体**"
               f"（归档行／裁定件不在面内 ⇒ 将来扩面也不会静默改写历史）",
               not _overlap, f"面里混进了条目级载体：{_overlap}")
        # 变异自证：把归档行塞进现况面 ⇒ ③必须转红（该腿有牙）
        _mut_slots = PROSE_SLOTS + ("closed",)
        expect("v5.38.0 ③·变异：把归档行塞进现况面 ⇒ ③转红（该腿有牙）",
               [s for s in _mut_slots if s in _entry_carriers] == ["closed"],
               "检查器没认出载体越界")
        cur_store[0] = _saved_q538
        shutil.rmtree(_q538, ignore_errors=True)
        # 行为腿：三条写路径（set／append／import）**都**过同一道闸
        _qc = tempfile.mkdtemp(prefix="handoff-selftest-v530c.")
        _saved_qc = cur_store[0]
        cur_store[0] = str(Path(_qc) / ".handoff")
        run("init")
        _big = "超长散文。" * 2000          # ≫ 8192
        rc2, out2 = run("set", "exit", inp=_big)
        expect("v5.30.0 C④①：`set exit` 超上限 ⇒ 拒（闸在漏斗里）",
               rc2 != 0 and "超热层上限" in out2, out2[-140:])
        # 班段**行数**闸（12 行）在前 ⇒ 要超字节闸就得「行少、字多」：12 行 × 1000 字
        rc2, out2 = run("append", "exit", "--file", "-",
                        inp="## 超长班段\n" + "".join(f"{i:04d}" + "长" * 1000 + "\n" for i in range(11)))
        expect("v5.30.0 C④②：`append exit` 超上限 ⇒ 拒（行数没超、字节超）",
               rc2 != 0 and "超热层上限" in out2, out2[-140:])
        rc2, out2 = run("set", "summary", inp=_big)
        expect("v5.30.0 C④③：`set summary` 超上限 ⇒ 拒", rc2 != 0 and "超热层上限" in out2, out2[-140:])
        rc2, out2 = run("append", "summary", "--file", "-", inp=_big)
        expect("v5.30.0 C④④：`append summary` 超上限 ⇒ 拒（旧形这条路**根本没有闸**）",
               rc2 != 0 and "超热层上限" in out2, out2[-140:])
        # v5.31.0：**拒写零落盘**（本版收口时实测撞到的既有缺陷，2026-10-23）
        #   `append summary` 超上限被字节闸拒 ⇒ 旧形**归档已经写过了**（`_archive_append`
        #   排在写槽之前）⇒ 落盘留痕、写事件台账没记 ⇒ `check` 报「未经 CLI 记录的写入」
        #   ⇒ 一次**被正确拒绝**的写把库弄红了。
        #   腿钉住「被拒之后**归档字节不变**」：内容要够多行（>30 行）才会产生溢出行，
        #   否则旧形根本没东西可归档 ⇒ 腿会恒绿（空腿）。
        _qc_big_lines = "".join(f"第{i}行。" + "字" * 300 + "\n" for i in range(40))
        _qc_arc = Path(cur_store[0]) / "archive" / "summary.jsonl"
        _qc_arc_before = (_qc_arc.read_bytes() if _qc_arc.is_file() else b"")
        rc2, out2 = run("append", "summary", "--file", "-", inp=_qc_big_lines)
        _qc_arc_after = (_qc_arc.read_bytes() if _qc_arc.is_file() else b"")
        expect("v5.31.0 C⑤：`append summary` 被拒 ⇒ **归档字节不变**（拒写零落盘）",
               rc2 != 0 and "超热层上限" in out2 and _qc_arc_before == _qc_arc_after,
               f"rc={rc2} 归档 {len(_qc_arc_before)}→{len(_qc_arc_after)} 字节 {out2[-120:]}")
        # C⑥：--force 仍可强写（维护态不堵死）
        rc2, out2 = run("set", "exit", "--force", inp=_big)
        expect("v5.30.0 C⑥：`--force` 仍可强写超上限内容（维护态不堵死）",
               rc2 == 0, out2[-140:])
        # C①：**import** 走同一道闸 ⇒ 超上限清单在**写入前**被拒（不留半写存储）
        _qc_man = Path(_qc) / "manifest.jsonl"
        _qc_man.write_text("\n".join([
            json.dumps({"_format": "handoff", "schema": 1}, ensure_ascii=False),
            json.dumps({"_kind": "doc", "_slot": "exit", "content": "## 清单里的超长旧班段\n\n" + _big},
                       ensure_ascii=False),
        ]) + "\n", encoding="utf-8")
        _qc2 = tempfile.mkdtemp(prefix="handoff-selftest-v530c2.")
        _saved_qc2 = cur_store[0]
        cur_store[0] = str(Path(_qc2) / ".handoff")
        run("init")
        rc2, out2 = run("import", str(_qc_man))
        _qc2_exit = Path(cur_store[0]) / "exit"
        expect("v5.30.0 C①：import 的热层超上限 ⇒ **写入前**被拒（不留半写存储）",
               rc2 != 0 and "超热层上限" in out2
               and (not _qc2_exit.is_file() or not _qc2_exit.read_text(encoding="utf-8").strip()),
               f"rc={rc2} {out2[-160:]}")
        cur_store[0] = _saved_qc2
        shutil.rmtree(_qc2, ignore_errors=True)
        cur_store[0] = _saved_qc
        shutil.rmtree(_qc, ignore_errors=True)

        # ---- v5.30.0 刀 E：文案里的命令**必须真能跑**（参数级校验）------------------
        # 族 E 的假称形态：**命令名对、参数组合非法**（旧形那句「先 `handoff compact status`
        # 再写」——`compact` 只支持 exit／summary ⇒ 实测 rc=1）⇒ 按命令名扫根本查不出来。
        # ⇒ ① 参数域只此一份（`CMD_SLOT_DOMAIN`）：**校验**与**文案**共用；
        #    ② 机械自检：扫全部**字符串常量**里的 `handoff <cmd> [<槽位>]` 提及 ⇒
        #       命令须在 argparse 面内、槽位须在该命令的域内 ⇒ 假称当场红（提交前拦住）。
        import ast as _ast_e
        _src_e = Path(__file__).read_text(encoding="utf-8")
        _tree_e = _ast_e.parse(_src_e)
        _subcmds = set()
        for _n in _ast_e.walk(_tree_e):
            if (isinstance(_n, _ast_e.Call) and isinstance(_n.func, _ast_e.Attribute)
                    and _n.func.attr == "add_parser" and _n.args
                    and isinstance(_n.args[0], _ast_e.Constant)
                    and isinstance(_n.args[0].value, str)):
                _subcmds.add(_n.args[0].value)
        _bad_e = []
        # 作用域＝**用户会照抄的文案**（die／print 里的字符串）⇒ **docstring 排除**
        # （docstring 是给维护者看的，引用一句历史假称做举例是正常的；把它判红＝误报）。
        _docnodes = set()
        for _n in _ast_e.walk(_tree_e):
            if isinstance(_n, (_ast_e.Module, _ast_e.FunctionDef, _ast_e.AsyncFunctionDef,
                                _ast_e.ClassDef)) and _n.body:
                _b0 = _n.body[0]
                if (isinstance(_b0, _ast_e.Expr) and isinstance(_b0.value, _ast_e.Constant)
                        and isinstance(_b0.value.value, str)):
                    _docnodes.add(id(_b0.value))
        for _n in _ast_e.walk(_tree_e):
            if not (isinstance(_n, _ast_e.Constant) and isinstance(_n.value, str)):
                continue
            if id(_n) in _docnodes:
                continue
            for _m in re.finditer(r"`handoff\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?`",
                                  _n.value):
                _cmd, _arg = _m.group(1), _m.group(2)
                if _cmd not in _subcmds:
                    _bad_e.append(f"命令不存在：`handoff {_cmd}`")
                elif _arg in SLOT_VOCAB and _cmd in CMD_SLOT_DOMAIN:
                    if _arg not in CMD_SLOT_DOMAIN[_cmd]:
                        _bad_e.append(f"参数组合非法：`handoff {_cmd} {_arg}`"
                                      f"（该命令只收 {'／'.join(CMD_SLOT_DOMAIN[_cmd])}）")
        expect("v5.30.0 E①：文案里的 `handoff <命令> [<槽位>]` **都能真跑**"
               "（命令存在 ＋ 槽位在该命令的域内 ⇒ 假称当场红）",
               not _bad_e, "；".join(_bad_e[:6]) or f"扫了 {len(_subcmds)} 个子命令")

        # ---- v5.30.0 刀 D：派生视图**唯一渲染器**（两条读面同源）--------------------
        # 旧形：`view` 现算队列区、`read exit` 只给散文原文 ⇒ **同一事实两条读面两个答案**，
        # 读者拿到哪一份取决于他敲了哪条命令（族 D）。⇒ 现在 `render_derived()` 是唯一渲染器，
        # `view` 与 `read --derived` 都从它取 ⇒ 口径不可能不齐。
        _qd = tempfile.mkdtemp(prefix="handoff-selftest-v530d.")
        _saved_qd = cur_store[0]
        cur_store[0] = str(Path(_qd) / ".handoff")
        run("init")
        _, _qd_o = run("add", "action", "--summary", "刀D 腿：读面同源")
        _qd_id = next(iter(re.findall(r"id=(t\d+)", _qd_o)), "")
        run("append", "exit", "--file", "-", inp=f"## 刀D 班段\n\n- 处理了{_qd_id}这条\n")
        _rd_plain = run("read", "exit")[1]
        expect("v5.30.0 D①：默认 `read exit` 只给**散文原文**（不含现算区；读面边界写进 docstring）",
               "队列现态" not in _rd_plain, _rd_plain[-120:])
        _rd_der = run("read", "exit", "--derived")[1]
        expect("v5.30.0 D②：`read exit --derived` 含现算派生视图",
               "队列现态" in _rd_der and "现态计数" in _rd_der, _rd_der[-160:])
        _vd = run("view")[1]
        _q_read = _rd_der.split("## 队列现态", 1)[1].split("## 现态计数", 1)[0].strip()
        _q_view = _vd.split("## 队列现态（现算 · 不落盘）", 1)[1].split("## 现态计数", 1)[0].strip()
        expect("v5.30.0 D③：`read --derived` 与 `view` 的队列现态段**逐字相同**"
               "（同一渲染器 ⇒ 两条读面口径不可能不齐）",
               _q_read == _q_view and bool(_q_read), f"read={_q_read[:80]!r} view={_q_view[:80]!r}")
        cur_store[0] = _saved_qd
        shutil.rmtree(_qd, ignore_errors=True)

        # ---- v5.30.0 刀 F：界碑＝**班次序号**（显式、单调、与时钟无关）----------------
        # 旧形：界碑＝「散文写入时刻」（写事件台账里**秒级**截断的 ts），条目侧是**微秒**
        # ⇒ 同一秒内创建的条目**必然 ≥ 界碑** ⇒ 下一班仍算「本班新增」⇒ **要点两次名**
        # （作者负担），且夹具得靠 `sleep` 跨秒才不被掩盖（**同秒掩盖**＝盲区）。
        # ⇒ v5.30.0：散文写入记**班次序号**（`shifts.jsonl`，单调、不折叠），
        #   条目登记时记 `bornShift`（整数）⇒ 判定用**整数比较** ⇒ 无并列、与时钟无关。
        #   老条目（无 `bornShift`）仍按**时刻**兜底 ⇒ 牙不放松。
        _qf = tempfile.mkdtemp(prefix="handoff-selftest-v530f.")
        _saved_qf = cur_store[0]
        cur_store[0] = str(Path(_qf) / ".handoff")
        run("init")
        _, _qf_o1 = run("add", "action", "--summary", "刀F 腿：E1")
        _qf_e1 = next(iter(re.findall(r"id=(t\d+)", _qf_o1)), "")
        # F②：E1 在**班段一**被声明；E2 在**班段一之后**登记（与 E1 落在**同一秒**——
        #   刻意不 sleep：界碑按**班次序号** ⇒ 同秒不再有歧义，这正是 v5.30.0 刀 F 的收益；
        #   旧形按秒级时刻界碑 ⇒ 同一秒内登记的条目下一班仍算「本班新增」⇒ 要声明两次）。
        run("append", "exit", "--file", "-", "--covers", _qf_e1,
            inp=f"## 刀F 班段一\n\n- 只处理了{_qf_e1}这条\n")
        _, _qf_o2 = run("add", "action", "--summary", "刀F 腿：E2（与 E1 同一秒）")
        _qf_e2 = next(iter(re.findall(r"id=(t\d+)", _qf_o2)), "")
        _qf_rows = {r["id"]: r for r in rows("actions") if r.get("id") in (_qf_e1, _qf_e2)}
        expect("v5.30.0 F①：条目带 `bornShift`（整数·班次序号）",
               isinstance(_qf_rows.get(_qf_e1, {}).get("bornShift"), int)
               and isinstance(_qf_rows.get(_qf_e2, {}).get("bornShift"), int),
               f"E1={_qf_rows.get(_qf_e1, {}).get('bornShift')!r}")
        expect("v5.30.0 F①配套：E1 与 E2 的 `bornShift` **不同**（序号 ⇒ 同秒也分得开）",
               _qf_rows.get(_qf_e1, {}).get("bornShift")
               != _qf_rows.get(_qf_e2, {}).get("bornShift"),
               f"E1={_qf_rows.get(_qf_e1, {}).get('bornShift')!r} "
               f"E2={_qf_rows.get(_qf_e2, {}).get('bornShift')!r}")
        # F②前半：E2 登记后没被声明 ⇒ 判据红（**牙在**）
        rc2, out2 = run("check", "--no-log")
        expect("v5.30.0 F②前半：E2 登记后没被声明 ⇒ 报红（牙在）",
               rc2 != 0 and "fresh-queue" in out2 and _qf_e2 in out2, out2[-180:])
        # F②中段：声明它 ⇒ 绿
        run("append", "exit", "--file", "-", "--covers", _qf_e2,
            inp=f"## 刀F 班段二\n\n- 这班处理了{_qf_e2}这条\n")
        rc2, out2 = run("check", "--no-log")
        expect("v5.30.0 F②中段：声明之后 ⇒ 绿", rc2 == 0 or "fresh-queue" not in non_tamper(out2),
               out2[-180:])
        # F②：再写一班（**不声明**它）⇒ 仍然不报红 ⇒ 同一秒登记的条目**不必声明两次**
        run("append", "exit", "--file", "-", inp="## 刀F 班段三\n\n- 这班没再提它\n")
        rc2, out2 = run("check", "--no-log")
        expect("v5.30.0 F②：**同秒不再留一班**（界碑＝序号 ⇒ 下一班不必再声明）"
               "（旧形：秒级界碑 ⇒ 仍算「本班新增」⇒ 要声明两次）",
               "fresh-queue" not in non_tamper(out2), out2[-200:])
        # F② 变异自证：把判定退回**旧的秒级时刻口径** ⇒ 上一条必须转红 ⇒ 证明它真依赖新界碑
        # ⚠ **先把「同秒」这个前置条件钉死**（第一版靠**墙上时钟**恰好落在同一秒：
        #   夹具六步实测 0.63 秒 ⇒ 机器一慢就跨秒 ⇒ 旧口径的结论从「红」翻成「绿」
        #   ⇒ 这条腿**间歇红**（2026-10-24 实测到一次：同代码两次跑，一次红两次绿））。
        #   ⇒ 现在把条目的 `createdAt` 钉到**边界那次班次写入的那一秒**（边界＝上上次散文
        #   写入，与判据取的是同一个）⇒ 「同秒」由夹具保证 ⇒ 墙上时钟不再决定结论。
        _qf_st = Store(Path(cur_store[0]))
        _bnd_ts = (_shift_boundary(_qf_st, offset=-2) or {}).get("ts")
        if _bnd_ts:
            _pin = str(_bnd_ts)[:19]
            for _f in sorted((_qf_st.d / "actions").glob("*.jsonl")):
                _new = []
                for _l in _f.read_text(encoding="utf-8").splitlines():
                    if not _l.strip():
                        continue
                    _r = json.loads(_l)
                    if _r.get("id") in (_qf_e1, _qf_e2):
                        _r["createdAt"] = _pin
                    _new.append(json.dumps(_r, ensure_ascii=False))
                _f.write_text("\n".join(_new) + "\n", encoding="utf-8")
        _orig_isn_f = _is_shift_new

        def _isn_legacy_f(r: dict, b: dict) -> bool:
            try:
                _c = _entry_created_dt(r)
                _t = b.get("ts")
                if _c is None or not _t:
                    return True
                _cut = datetime.fromisoformat(str(_t)).replace(microsecond=0)
                return _as_aware(_c) >= _as_aware(_cut)
            except (TypeError, ValueError):
                return True
        try:
            globals()["_is_shift_new"] = _isn_legacy_f
            rc2, out2 = run("check", "--no-log")
        finally:
            globals()["_is_shift_new"] = _orig_isn_f
        expect("v5.30.0 F②变异自证：退回**秒级时刻口径** ⇒ 又要求点名、转红"
               "（证明 F② 的绿真是新界碑带来的，不是空腿）",
               "fresh-queue" in out2 and _qf_e2 in out2, out2[-200:])
        cur_store[0] = _saved_qf
        shutil.rmtree(_qf, ignore_errors=True)

        # ---- v5.30.0：补回 **compact 正控腿**（v5.29.0 改写夹具时丢的那条，t000415）----
        # 旧 d000106 正控腿「compact 挤出后区仍在」随夹具簇改写被一起带走 ⇒
        # 「compact 之后 check 仍绿／不注入区」没有腿证明。⇒ 现在补（独立临时库，造两个班段）：
        #   ① compact 挤出旧节后，exit 热层里**没有**队列区（不注入）；
        #   ② `check` 仍绿（compact 不制造矛盾）；
        #   ③ 冷档里挤出的旧节**逐字保留**（compact 只搬不删）。
        _qk = tempfile.mkdtemp(prefix="handoff-selftest-compact.")
        _saved_qk = cur_store[0]
        cur_store[0] = str(Path(_qk) / ".handoff")
        run("init")
        run("append", "exit", "--file", "-", inp="## 甲班段\n\n- 甲的内容\n")
        run("append", "exit", "--file", "-", inp="## 乙班段\n\n- 乙的内容\n")
        rc2, out2 = run("compact", "exit")
        _qk_exit = Path(cur_store[0]) / "exit"
        expect("v5.30.0 compact 正控①：compact 之后 exit 热层里**没有**队列区（不注入）",
               rc2 == 0 and QUEUE_BEGIN not in _qk_exit.read_text(encoding="utf-8"), out2[-120:])
        rc2, out2 = run("check", "--no-log")
        expect("v5.30.0 compact 正控②：compact 之后 `check` 仍绿（compact 不制造矛盾）",
               rc2 == 0 or not non_tamper(out2).strip(), out2[-160:])
        _qk_arc = read_jsonl(Path(cur_store[0]) / ARCHIVE_DIR / "exit.jsonl")
        expect("v5.30.0 compact 正控③：挤出的旧节**逐字进冷档**（compact 只搬不删）",
               any("甲班段" in (a.get("text") or "") for a in _qk_arc),
               f"冷档 {len(_qk_arc)} 行")
        cur_store[0] = _saved_qk
        shutil.rmtree(_qk, ignore_errors=True)

        # ---- ㉓ v5.29.0 刀 4：容量账本说真话 ----
        # 旧文案：150 条 ⇒「约 13 行 … exit 班段 12 行都放得下」——13 > 12，那条建议
        # **字面上做不到**；同时它又过于悲观（按 40 个/行只要 4 行）。
        _cap = tempfile.mkdtemp(prefix="handoff-selftest-v529c.")
        _saved_cap = cur_store[0]
        cur_store[0] = str(Path(_cap) / ".handoff")
        run("init")
        for _k in range(150):
            run("add", "action", "--summary", f"新增活 {_k + 1}", "--domain", "v")
        rc2, out2 = run("check", "--no-log")
        expect("v5.29.0⑯：150 条时容量账本按**真实预算**算（约 4 行 ⇒ exit 班段放得下）",
               "约 4 行" in out2 and "放得下" in out2 and "12 行都放得下" not in out2, out2[-260:])
        cur_store[0] = _saved_cap
        shutil.rmtree(_cap, ignore_errors=True)


        # ---- ⑯ check 内置 agents-block 漂移维（v5.16.0；v5.18.0 起**判据与修复分离**）----
        # 判据只对「已有标记区」的仓启用：无块仓必须零误伤（多数仓未装块）。
        # v5.18.0（A′）：**check 默认只报不改**——门禁不改使用方的文件（否则退出码不承载
        # 「我改过你的文件」⇒ CI 判绿）；修复走显式 `handoff check --repair`，痕迹落事件流。
        # 每条腿都先钉「**报红且文件不变**」（负控：门禁不该有副作用），再钉「--repair 才修」。
        _cb = tempfile.mkdtemp(prefix="handoff-selftest-checkblock.")
        _cb_agents = Path(_cb) / "AGENTS.md"
        _cb_agents.write_text("# t\n", encoding="utf-8")
        _saved_cb = cur_store[0]
        cur_store[0] = str(Path(_cb) / ".handoff")
        rc2, out2 = run("init")
        expect("check 内置块维·前置：init 在已有 AGENTS.md 上自动装块",
               rc2 == 0 and BEGIN_MARK in _cb_agents.read_text(encoding="utf-8"), out2[-160:])
        rc2, out2 = run("check", "--no-log")
        expect("check 内置块维：块与标准源一致 ⇒ 绿", rc2 == 0, out2[-200:], dim="agents-block")
        _cb_text = _cb_agents.read_text(encoding="utf-8")
        _std_line = next(l for l in agents_block_text("basic").splitlines() if l.startswith("- "))
        # 少一行标准条款 ⇒ 报红且**文件不变**
        _cb_agents.write_text(_cb_text.replace(_std_line + "\n", "", 1), encoding="utf-8")
        _cb_before = _cb_agents.read_text(encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("check 内置块维：少一行标准条款 ⇒ 报红且**文件不变**（判据不改使用方的文件）",
               rc2 != 0 and "check --repair" in out2
               and _cb_agents.read_text(encoding="utf-8") == _cb_before, out2[-240:])
        rc2, out2 = run("check", "--no-log", "--repair")
        _cb_now = _cb_agents.read_text(encoding="utf-8")
        expect("check --repair：少一行标准条款 ⇒ 按唯一源重装并回绿",
               rc2 == 0 and _std_line in _cb_now, out2[-240:])
        # 块内人写行 ⇒ 报红且文件不变；--repair ⇒ 重装且人写行**搬到块外**（内容不丢）
        _cb_agents.write_text(_cb_now.replace(
            END_MARK, "- 本仓专属：块内手写行。\n" + END_MARK, 1), encoding="utf-8")
        _cb_before2 = _cb_agents.read_text(encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("check 内置块维：块内人写行 ⇒ 报红且**文件不变**",
               rc2 != 0 and _cb_agents.read_text(encoding="utf-8") == _cb_before2, out2[-240:])
        rc2, out2 = run("check", "--no-log", "--repair")
        _cb_after = _cb_agents.read_text(encoding="utf-8")
        expect("check --repair：块内人写行 ⇒ 重装、人写行搬到块外、回绿",
               rc2 == 0 and "本仓专属：块内手写行" in _cb_after
               and _cb_after.index("本仓专属：块内手写行") > _cb_after.index(END_MARK),
               out2[-240:])
        # 痕迹落事件流（机器可读，`handoff log` 可见）
        _lg = (Path(cur_store[0]) / "log.jsonl")
        expect("check --repair 的痕迹落 store 事件流（agents-block:repaired）",
               _lg.is_file() and "agents-block:repaired" in _lg.read_text(encoding="utf-8"),
               "log.jsonl 无该事件")
        # 标记残缺 ⇒ 红且要求先解决（不自动猜修，--repair 也不行）
        _cb_agents.write_text(_cb_after.replace(END_MARK + "\n", "", 1), encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("check 内置块维：标记残缺 ⇒ 红且要求先解决（不自动猜修）",
               rc2 != 0 and "残缺" in out2 and "必须先解决" in out2, out2[-240:])
        # 多份标记区 ⇒ 报红且文件不变；--repair ⇒ 收敛为一份
        _cb_agents.write_text(_cb_after.replace(
            END_MARK, END_MARK + "\n\n" + BEGIN_MARK + "\n- dup\n" + END_MARK, 1),
            encoding="utf-8")
        _cb_before3 = _cb_agents.read_text(encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("check 内置块维：多份标记区 ⇒ 报红且**文件不变**",
               rc2 != 0 and _cb_agents.read_text(encoding="utf-8") == _cb_before3, out2[-240:])
        rc2, out2 = run("check", "--no-log", "--repair")
        _cb_dup = _cb_agents.read_text(encoding="utf-8")
        expect("check --repair：多份标记区 ⇒ 收敛为一份并回绿",
               rc2 == 0 and _cb_dup.count(BEGIN_MARK) == 1
               and _cb_dup.count(END_MARK) == 1, out2[-240:])
        shutil.rmtree(_cb, ignore_errors=True)
        _cb3 = tempfile.mkdtemp(prefix="handoff-selftest-checkblock-fresh.")
        _cb3_agents = Path(_cb3) / "AGENTS.md"
        _cb3_agents.write_text("# t\n", encoding="utf-8")
        cur_store[0] = str(Path(_cb3) / ".handoff")
        rc2, _o = run("init")
        rc2, _o = run("agents-block", "--install", _cb3, "--profile", "freshness")
        _fresh = _cb3_agents.read_text(encoding="utf-8")
        _fresh_line = next(l for l in agents_block_text("freshness").splitlines()
                           if l.startswith("- "))
        _cb3_agents.write_text(_fresh.replace(_fresh_line + "\n", "", 1), encoding="utf-8")
        _fresh_before = _cb3_agents.read_text(encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("check 内置块维：增强档漂移 ⇒ 报红且**文件不变**",
               rc2 != 0 and _cb3_agents.read_text(encoding="utf-8") == _fresh_before, out2[-240:])
        rc2, out2 = run("check", "--no-log", "--repair")
        _fresh_after = _cb3_agents.read_text(encoding="utf-8")
        _fresh_got = _fresh_after.split(BEGIN_MARK, 1)[1].split(END_MARK, 1)[0]
        expect("check --repair：增强档漂移按原档位重装（不降级为 basic）",
               rc2 == 0 and FRESH_BEGIN in _fresh_got and FRESH_END in _fresh_got,
               out2[-240:])
        shutil.rmtree(_cb3, ignore_errors=True)
        _cb2 = tempfile.mkdtemp(prefix="handoff-selftest-checkblock-off.")
        cur_store[0] = str(Path(_cb2) / ".handoff")
        rc2, _o = run("init")
        rc2, out2 = run("check", "--no-log")
        expect("check 内置块维：无 AGENTS.md ⇒ 不启用（绿）", rc2 == 0, out2[-200:])
        (Path(_cb2) / "AGENTS.md").write_text("# t\n", encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("check 内置块维：有 AGENTS.md 但无标记区 ⇒ 不启用（绿）",
               rc2 == 0, out2[-200:])
        shutil.rmtree(_cb2, ignore_errors=True)
        cur_store[0] = _saved_cb

        # ---- ⑳ v5.18.0 各条改动的回归腿（每条改动都要有腿，**负控在内**）----
        _v5 = tempfile.mkdtemp(prefix="handoff-selftest-v518.")
        (Path(_v5) / "AGENTS.md").write_text("# t\n", encoding="utf-8")
        cur_store[0] = str(Path(_v5) / ".handoff")   # store＝仓根下的 .handoff ⇒ root_dir＝仓根
        run("init")
        # 造一条 d 型裁定（带标题）与一条 u 型未确认
        rc2, out2 = run("add", "decision", "--title", "裁定标题甲",
                        "--body", "正文一行。", "--topic", "测试")
        expect("C′ 前置：add decision 成功落件", rc2 == 0, out2[-160:])
        rc2, out2 = run("unconfirmed", "add", "--summary", "未能确认的事实甲", "--ref", "src://x")
        expect("C′ 前置：unconfirmed 落一条", rc2 == 0, out2[-160:])
        rc2, out2 = run("confirm", "--seed", "1")
        expect("C′：confirm 题面含裁定标题问（d 型入题）",
               rc2 == 0 and "这条裁定的标题" in out2, out2[-300:])
        expect("C′：confirm 题面含未确认台账问（u 型入题）",
               "unconfirmed（未能确认）台账里的 id" in out2, out2[-300:])
        # 负控：答错 ⇒ 红（题目不是摆设）
        _af = Path(tempfile.mkdtemp(prefix="handoff-selftest-ans.")) / "a.json"
        _af.write_text(json.dumps({"Q1": "瞎答"}), encoding="utf-8")
        rc2, out2 = run("confirm", "--seed", "1", "--answers", str(_af))
        expect("C′ 负控：答错 ⇒ 红（read-back 是可判的转交证据）",
               rc2 != 0 and "FAIL" in out2, out2[-200:])
        # D′：view 的裁定节带标题 ＋ 标出正在挡路的记录
        rc2, out2 = run("view")
        expect("D′：view 的裁定节带标题（认得出）",
               rc2 == 0 and "裁定标题甲" in out2, out2[-300:])
        rc2, out2 = run("add", "action", "--summary", "被挡的活甲",
                        "--blockedBy", "d000001")
        expect("D′ 前置：造一条被裁定挡住的活", rc2 == 0, out2[-160:])
        rc2, out2 = run("view")
        expect("D′：view 标出正在挡路的记录（哪条现在管我）",
               rc2 == 0 and "生效中" in out2, out2[-400:])
        # E′：写事件只记实际被写的文件（不是全量快照）
        _wl = Path(_v5) / ".handoff" / "writes.jsonl"
        _rows = read_jsonl(_wl) if _wl.is_file() else []
        _last_files = list((_rows[-1].get("files") or {}).keys()) if _rows else []
        expect("E′：写事件只记实际被写的文件（末条 ≤6 件，不是全量快照）",
               bool(_rows) and len(_last_files) <= 6, f"末条 {len(_last_files)} 件：{_last_files}")
        # F′：装块 ⇒ 库内有「装过块」记录；块被删 ⇒ check 红
        expect("F′：装块后库内有「装过块」的事实登记",
               _block_install_record(Store(Path(cur_store[0]))) is not None, "无该记录")
        # **负控（上一版这条腿只验了「记录在不在」⇒ 维没实现也照样绿）：**
        # 装块 → 把标记区整段删掉 ⇒ `block-installed` 维**必须红**；装回 ⇒ 绿。
        _fb = Path(cur_store[0]).parent / "AGENTS.md"
        if _fb.is_file():
            run("agents-block", "--install", str(_fb.parent))
            _fb_orig = _fb.read_text(encoding="utf-8")   # 存**装好之后**的内容（还原用）
            _fb.write_text("# t\n", encoding="utf-8")
            rc2, out2 = run("check", "--no-log")
            expect("F′ 负控：装过块却整段消失 ⇒ `block-installed` 维**必须红**",
                   rc2 != 0 and "装过" in out2, out2[-240:])
            _fb.write_text(_fb_orig, encoding="utf-8")
            rc2, out2 = run("check", "--no-log")
            # 断言的是**这一维的红消失**（夹具库里另有条目没写进 exit ⇒ fresh-queue 会红，
            # 那与本维无关）——所以只查「装过」这个理由在不在。
            expect("F′ 负控：块装回 ⇒ `block-installed` 维的红消失",
                   "装过" not in out2, out2[-240:])
        # G′：blocked 却没记「在等什么」⇒ 红；补其一 ⇒ 绿
        rc2, out2 = run("add", "action", "--summary", "等所有者的活甲", "--status", "blocked")
        _m = re.search(r"\bid=(t\d{6})", out2)     # add 的回读行：`... ok（slot=actions） id=tNNNNNN`
        _gid = _m.group(1) if _m else ""
        expect("G′ 前置：add --status blocked 成功", rc2 == 0 and _gid, out2[-160:])
        rc2, out2 = run("check", "--no-log")
        expect("G′：blocked 且既无 blockedBy 也无 waitingFor ⇒ 红（修法可满足）",
               rc2 != 0 and "没记在等什么" in out2, out2[-300:], dim="blocked-owner")
        rc2, out2 = run("edit", _gid, "--waitingFor", "owner")
        expect("G′：edit --waitingFor owner 落字段", rc2 == 0, out2[-200:])
        rc2, out2 = run("check", "--no-log")
        expect("G′：补上 waitingFor ⇒ 该红消", "没记在等什么" not in out2, out2[-300:])
        # 负控：waitingFor 值域非法 ⇒ 写入面拒（不留到 check 事后红）
        rc2, out2 = run("edit", _gid, "--waitingFor", "瞎写")
        expect("G′ 负控：waitingFor 非法值在写入面就被拒",
               rc2 != 0 and "waitingFor 值域非法" in out2, out2[-200:])
        # 池谓词：waitingFor 非空 ⇒ 不入池；等太久 ⇒ 独立点名
        rc2, out2 = run("next", "--auto")
        expect("G′：waitingFor 非空 ⇒ 不入补位池",
               _gid not in out2, out2[-200:])
        _af2 = Path(_v5) / ".handoff" / "actions" / "_global.jsonl"
        _rows2 = read_jsonl(_af2)
        for _r in _rows2:
            if _r.get("id") == _gid:
                _r["created"] = "2026-01-01"          # 手工造「等了很久」
        _af2.write_text("".join(json.dumps(_r, ensure_ascii=False) + "\n" for _r in _rows2),
                        encoding="utf-8")
        rc2, out2 = run("next", "--auto")
        expect("G′：等太久的 waitingFor 条目被独立点名（不靠改排序喊）",
               "等太久" in out2 and _gid in out2, out2[-300:])
        shutil.rmtree(_v5, ignore_errors=True)
        cur_store[0] = _saved_cb
        # B′ 代码侧：非 POSIX 上「没有封存这道闸」要显式提示（不静默跳过）
        _seal_save = globals().get("SEAL_OK")
        try:
            globals()["SEAL_OK"] = False
            _v5b = tempfile.mkdtemp(prefix="handoff-selftest-seal.")
            cur_store[0] = _v5b
            run("init")
            _sub = os.environ.pop("HANDOFF_SELFTEST_SUB", None)   # 该子模式会屏蔽封存提示
            try:
                rc2, out2 = run("check", "--no-log")
            finally:
                if _sub is not None:
                    os.environ["HANDOFF_SELFTEST_SUB"] = _sub
            expect("B′：非 POSIX 上给出「无封存保护」的提示（不静默跳过）",
                   "无封存保护" in out2, out2[-300:])
            shutil.rmtree(_v5b, ignore_errors=True)
        finally:
            globals()["SEAL_OK"] = _seal_save
            cur_store[0] = _saved_cb
        # K′：init 不再自动改全局目录（负控：跑 init 前后 ~/.local/bin 不变）
        _shim = Path.home() / ".local" / "bin" / "handoff"
        _shim_before = (_shim.read_bytes(), _shim.stat().st_mtime_ns) if _shim.is_file() else None
        _v5c = tempfile.mkdtemp(prefix="handoff-selftest-init.")
        cur_store[0] = _v5c
        run("init")
        _shim_after = (_shim.read_bytes(), _shim.stat().st_mtime_ns) if _shim.is_file() else None
        expect("K′：init 不再自动装全局 shim（项目级动作不越界改机器级状态）",
               _shim_before == _shim_after, "shim 被 init 改了")
        shutil.rmtree(_v5c, ignore_errors=True)
        cur_store[0] = _saved_cb
        _selftest_shim(expect)
        # I′：模块 docstring 不复制子命令清单（复制即第二份源，将来必漂）
        _doc = globals().get("__doc__") or ""
        expect("I′：docstring 指向 SKILL.md 而非复制子命令清单",

               "SKILL.md" in _doc and "unconfirmed scope confirm filter view export import" not in _doc,
               _doc[:160])
        # ---- ⑳ 之补一之补：v5.21.1 `blockedBy` 写面守卫的负控 ----
        # 悬空 blocker（指向不存在的 id）此前被**接受**⇒ 池谓词③只认「活着的 blocker」⇒
        # 那行照样入池（被当成可推的活派出去），而条目行会显示「等 t999999」⇒ 接班人拿到
        # 一条**指向幽灵的指令**。写面现在当场拒。
        _bb = tempfile.mkdtemp(prefix="handoff-selftest-blockedby.")
        cur_store[0] = str(Path(_bb) / ".handoff")
        run("init")
        rc2, out2 = run("add", "action", "--summary", "指向幽灵的活", "--blockedBy", "t999999")
        expect("v5.21 ⑤：--blockedBy 指向不存在的 id ⇒ 写入面当场拒（不留指向幽灵的指令）",
               rc2 != 0 and "不在册" in out2, out2[-240:])
        rc2, out2 = run("add", "action", "--summary", "指向真人的活")
        rc2, out2 = run("edit", "t000001", "--blockedBy", "t000001")
        expect("v5.21 ⑤：指向**在册**的 id ⇒ 放行",
               rc2 == 0, out2[-200:])
        shutil.rmtree(_bb, ignore_errors=True)
        cur_store[0] = _saved_cb

        # ---- ⑳ 之补一之补二：v5.22.1 `summary` 单行写面守卫的负控 ----
        # 此前只有 `single-line` 维（**事后**）⇒ tab/换行能进账、还占 120 字预算、还把 view
        # 的一行渲染断成两行 ⇒ 违反「垃圾进不了账，而不是事后清」。写面现在当场拒。
        _sl = tempfile.mkdtemp(prefix="handoff-selftest-oneline.")
        cur_store[0] = str(Path(_sl) / ".handoff")
        run("init")
        rc2, out2 = run("add", "action", "--summary", "带\ttab的活")
        expect("v5.22 ⑥：`summary` 含制表 ⇒ 写入面当场拒（不是事后维才红）",
               rc2 != 0 and "单行" in out2, out2[-240:], dim="single-line")
        rc2, out2 = run("add", "action", "--summary", "正常单行")
        expect("v5.22 ⑥：单行 summary 照常放行", rc2 == 0, out2[-160:])
        shutil.rmtree(_sl, ignore_errors=True)
        cur_store[0] = _saved_cb

        # ---- ⑳ 之补二：v5.21.1 **迁移路径**的回归腿（最复杂、最少被测的一条路）----
        # 迁移＝「清单（export 格式）→ migrate.sh → 导入＋校验→check→归档旧件」。
        # v5.21.1 实测出两个真问题：① 清单里的 exit 是旧模型散文、**不可能提前知道这次新分配
        # 的 id** ⇒ `fresh-queue` 结构上不可能满足 ⇒ import 后 check 必红 ⇒ migrate.sh 中止
        # ⇒ **有旧 HANDOFF.md 的用户根本迁不过来**（已改：import 分配完 id 当场替人点名）；
        # ② 归档步骤要在**已封存**的存储里 mkdir ⇒ EACCES（已改：归档窗口先解锁、收尾回封）。
        _mg = tempfile.mkdtemp(prefix="handoff-selftest-migrate.")
        _mg_root = Path(_mg)
        (_mg_root / "AGENTS.md").write_text("# 项目\n", encoding="utf-8")
        _mg_old = _mg_root / "HANDOFF.md"
        _mg_old.write_text("# 旧交接\n\n## 未决\n- [ ] 活甲\n", encoding="utf-8")
        _mg_inv = _mg_root / "inv.jsonl"
        _mg_recs = [
            {"_format": "handoff", "schema": 1, "exported": "2026-07-22", "counts": {}},
            {"_kind": "entry", "_slot": "actions", "_domain": "_global",
             "summary": "活甲", "prio": "中", "status": "open"},
            {"_kind": "entry", "_slot": "pitfalls", "_domain": "_global", "summary": "旧坑乙"},
            {"_kind": "doc", "_slot": "status", "content": "在推\n"},
            {"_kind": "doc", "_slot": "summary", "content": "从旧模型迁来\n"},
            {"_kind": "doc", "_slot": "exit", "content": "## 迁入\n\n- 旧件已迁入。\n"},
        ]
        _mg_inv.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in _mg_recs),
                           encoding="utf-8")
        _mig_sh = Path(__file__).resolve().parent / "migrate.sh"
        _sp = subprocess.run(["sh", str(_mig_sh), "--store", str(_mg_root / ".handoff"),
                              "--archive", str(_mg_old), str(_mg_inv)],
                             capture_output=True, text=True)
        expect("v5.21 ④：迁移路径端到端跑通（migrate.sh rc=0）",
               _sp.returncode == 0, (_sp.stdout + _sp.stderr)[-300:])
        _mg_leg = list((_mg_root / ".handoff" / "legacy").rglob("HANDOFF.md")) \
            if (_mg_root / ".handoff" / "legacy").is_dir() else []
        expect("v5.21 ④：旧件被归档到 .handoff/legacy/（内容保留、原位不再留）",
               bool(_mg_leg), "没找到归档件")
        cur_store[0] = str(_mg_root / ".handoff")
        rc2, out2 = run("check", "--no-log")
        expect("v5.21 ④：迁移后 check 绿（fresh-queue 不再锁死迁移）",
               rc2 == 0, out2[-300:])
        cur_store[0] = _saved_cb
        shutil.rmtree(_mg, ignore_errors=True)

        # ---- ⑳ t000402 之补：v5.21.0 三处实测修复的负控 ----
        # ① 块事实**按仓路径作用域化**：从别的路径导入的「装过块」记录对新仓不成立
        _pv = tempfile.mkdtemp(prefix="handoff-selftest-port.")
        _pv_home = Path(_pv) / "home"
        _pv_home.mkdir(parents=True)
        (_pv_home / "AGENTS.md").write_text("# 甲\n", encoding="utf-8")
        _saved_pv = cur_store[0]
        cur_store[0] = str(_pv_home / ".handoff")
        run("init")
        run("agents-block", "--install", str(_pv_home))
        _exp = Path(_pv) / "exp.json"
        run("export", "--out", str(_exp))
        _pv2 = Path(_pv) / "other"
        _pv2.mkdir(parents=True)
        (_pv2 / "AGENTS.md").write_text("# 乙\n", encoding="utf-8")
        cur_store[0] = str(_pv2 / ".handoff")
        rc2, out2 = run("import", str(_exp))
        expect("v5.21 ①：导入到**别的路径** ⇒ check 不因「装过块」永久红",
               "装过" not in out2, out2[-240:])
        shutil.rmtree(_pv, ignore_errors=True)
        cur_store[0] = _saved_pv
        # ② agents-block --check 与判据同口径：未装块 ⇒ 「不适用」＋ rc=0
        _nc = tempfile.mkdtemp(prefix="handoff-selftest-noblock.")
        (Path(_nc) / "AGENTS.md").write_text("# 无块\n", encoding="utf-8")
        rc2, out2 = run("agents-block", "--check", _nc)
        expect("v5.21 ②：未装块的仓 `agents-block --check` ⇒ 不适用（rc=0，与判据同口径）",
               rc2 == 0 and "不适用" in out2, out2[-200:])
        shutil.rmtree(_nc, ignore_errors=True)
        # ③ 报错要点名自然解法 `append`（整槽喂回是最贵的那条路）
        _ap = tempfile.mkdtemp(prefix="handoff-selftest-append.")
        cur_store[0] = str(Path(_ap) / ".handoff")
        run("init")
        _long = "## 班次\n\n" + "".join(f"- 第 {i} 行。\n" for i in range(10))
        run("set", "exit", "--file", "-", inp=_long)
        rc2, out2 = run("set", "exit", "--file", "-", inp="## 短\n")
        expect("v5.21 ③：骤降报错点名 `append`（自然解法）",
               rc2 != 0 and "append" in out2, out2[-240:])
        shutil.rmtree(_ap, ignore_errors=True)
        cur_store[0] = _saved_pv

        # ---- ⑳ t000402：收窗（compact-writes）——**判定必须不变** ----
        _cw = tempfile.mkdtemp(prefix="handoff-selftest-compact.")
        cur_store[0] = str(Path(_cw) / ".handoff")
        run("init")
        run("add", "action", "--summary", "收窗夹具活甲")
        run("add", "action", "--summary", "收窗夹具活乙")
        run("add", "action", "--summary", "收窗夹具活丙")
        # 造一条**带旁证**的事件：CLI 写过的文件被手改，再由 CLI 写一次 ⇒ 该事件带 pre_tamper
        _cw_status = Path(_cw) / ".handoff" / "status"
        _cw_status.write_text("手改过\n", encoding="utf-8")
        run("set", "status", "--file", "-", inp="CLI 写回来的\n")
        _cwl = Path(_cw) / ".handoff" / "writes.jsonl"
        _cwevs = read_jsonl(_cwl)
        _tainted = [e for e in _cwevs if e.get("pre_tamper")]
        expect("t000402 前置：夹具里造出了带旁证的事件", bool(_tainted), f"{len(_cwevs)} 条事件")
        _before_bytes = _cwl.stat().st_size
        rc2, out2 = run("compact-writes", "--keep", "1")
        _after_bytes = _cwl.stat().st_size
        expect("t000402：收窗执行成功", rc2 == 0, out2[-200:])
        expect("t000402：收窗后事件数 ≤ 保留数 ＋ 基线 ＋ 带旁证事件",
               len(read_jsonl(_cwl)) <= 1 + 1 + len(_tainted), f"{len(read_jsonl(_cwl))} 条")
        expect("t000402：**带旁证的事件不被折叠**（结案仍归 rebase）",
               all(any(f in (e.get("pre_tamper") or []) for e in read_jsonl(_cwl)) for f in
                   [f for e in _tainted for f in (e.get("pre_tamper") or [])]),
               "带旁证的事件被折掉了")
        # 负控①：手改存储（**把行改坏**：缺 id）⇒ 收窗前后**都**红，且**不崩栈**
        _cw_slot = Path(_cw) / ".handoff" / "actions" / "_global.jsonl"
        _cw_slot.write_text(_cw_slot.read_text(encoding="utf-8") + '{"x":1}\n', encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        _red_after = rc2 != 0
        _crash_after = "Traceback" in out2
        run("compact-writes", "--keep", "1")
        rc2b, out2b = run("check", "--no-log")
        expect("t000402 负控①：手改存储（改坏行）⇒ 收窗后**仍红**且**不崩栈**（判定未被收窗抹掉）",
               _red_after and rc2b != 0 and not _crash_after and "Traceback" not in out2b,
               f"收窗前 rc={rc2}／收窗后 rc={rc2b}／崩栈={_crash_after}")
        # 幂等：再收一次不增长
        _s1 = _cwl.stat().st_size
        run("compact-writes", "--keep", "1")
        _s2 = _cwl.stat().st_size
        expect("t000402：收窗幂等（再收一次不增长）", _s2 <= _s1, f"{_s1} → {_s2}")
        shutil.rmtree(_cw, ignore_errors=True)
        cur_store[0] = _saved_cb

        # ---- ⑮ 补位池的第三道谓词（t000242）：blockedBy 指向还活着的 id ⇒ 不当决策点
        # 病根不是「指针选错」，是**入池判据看不见阻塞**：`blockedBy` 早就在 schema 里，
        # 但除 rm 的引用守卫外无人读它。于是「唯一剩余条件已被所有者封死」的条目照样排第一，
        # 每班第一眼撞上一个推不动的活（本仓 t000196 × 两班）。下面这组夹具必须同时证明
        # ① 挡得住 ② 挡的是真阻塞 ③ 条件一消失立刻回池——少任何一面都判不出这个 bug。
        _bp = tempfile.mkdtemp(prefix="handoff-selftest-blockedby.")
        cur_store[0] = _bp
        run("init")
        # ── `add decision` 重复标题守卫（t000263）──
        # 负控：body 首行与 title 不同 ⇒ 照旧成功（守卫不得误伤正常写法）
        rc2, out2 = run("add", "decision", "--title", "标题甲",
                        "--body", "正文乙。\n\n## 小节\n内容。")
        expect("负控：body 首行与 title 不同 ⇒ add decision 照旧成功",
               rc2 == 0 and "id=" in out2, out2[-160:])
        # 正控：body 首行**逐字重复** title（d000097／d000102 的真实形态）⇒ 硬失败
        rc2, out2 = run("add", "decision", "--title", "标题甲",
                        "--body", "标题甲\n\n## 小节\n内容。")
        expect("正控：body 首行逐字重复 title ⇒ 硬失败（d000097/d000102 真实形态）",
               rc2 != 0 and "与 --title 完全相同" in non_tamper(out2), out2[-200:])
        # 正控变体：重复行带 `## ` 前缀（d000097 形态是带 `# `）⇒ 同样拦
        rc2, out2 = run("add", "decision", "--title", "标题甲",
                        "--body", "# 标题甲\n\n## 小节\n内容。")
        expect("正控变体：重复行带 `# ` 前缀 ⇒ 同样拦下",
               rc2 != 0 and "与 --title 完全相同" in non_tamper(out2), out2[-200:])
        # **变异自证**：守卫源码里那个比较条件去掉 ⇒ 正控转绿，证明夹具有牙
        # （防「守卫其实压根没被这段夹具走到」的空转）。`inspect` 按需载入，
        # 与本模块其余延迟导入同一写法——不为一条 selftest 把依赖提到模块面。
        import inspect as _insp          # noqa: PLC0415 — 仅 selftest 用
        _g_src = _insp.getsource(cmd_add)
        _g_mut = _g_src.replace("if _first and _first == f[\"title\"].strip():",
                                "if False:  # 变异：去掉重复标题守卫")
        _g_ns = dict(globals())
        exec(compile(_g_mut, "<mut>", "exec"), _g_ns)
        _g_store = Store(Path(_bp))
        try:
            _g_mut_c = _g_ns["cmd_add"](_g_store, "decision",
                                       {"title": "标题甲", "body": "标题甲\n\n内容。"})
        except SystemExit as _e:
            _g_mut_c = _e.code
        expect("变异自证：去掉守卫比较 ⇒ 同一调用转绿（该夹具有牙）",
               _g_mut_c == 0, f"rc={_g_mut_c}")

        rc2, out2 = run("add", "decision", "--title", "冻结", "--body", "解冻条件：改造轮完成")
        _did = out2.split("id=")[1].strip().split()[0]
        rc2, out2 = run("add", "action", "--summary", "卡在冻结上的活", "--domain", "v")
        _bl = out2.split("id=")[1].strip().split()[0]
        rc2, out2 = run("add", "action", "--summary", "推得动的活", "--domain", "v")
        _free = out2.split("id=")[1].strip().split()[0]
        run("edit", _bl, "--blockedBy", _did)
        rc2, out2 = run("next", "--auto")
        expect("正例：blockedBy 指向**还活着**的 decision ⇒ 该条目不进池，指针落到能推的活上",
               rc2 == 0 and _free in out2 and _bl not in out2.split("handoff next:")[1].split("｜")[0],
               out2[-160:])
        rc2, out2 = run("next", _bl)
        rc2, out2 = run("check", "--no-log")
        expect("人手把 next 钉回被挡条目 ⇒ check 红（补位池跳过了，手钉这条路也得拦）",
               rc2 != 0 and "卡在" in non_tamper(out2), out2[-200:], dim="next")
        # 变异自证：条件消失（decision 被 superseded 而非删除）必须**立刻回池**，
        # 否则本改动就造了个新的永久阻塞——比原病更坏。
        rc2, out2 = run("add", "decision", "--title", "解冻", "--body", "改造轮完成",
                        "--supersedes", _did)
        # t000405：supersede 这条写点必须**当场**复渲染队列区——被释放的条目立刻出现在区里，
        #   不必等下一条无关的写命令。缺这一步 ⇒ 区停在旧快照 ⇒ `queue-stale` 恒红，
        #   而那条红与「谁造成的」之间隔着一次无关操作，没人查得到因果。
        # t000405：supersede 之后，被释放的条目必须**当场回到补位池**——读者看 view 即见，
        #   不必等下一条无关的写命令。缺这一步 ⇒ 条目停在「被挡」状态 ⇒ 没人看得到它。
        # ⚠ v5.29.0：原来的断言是「队列区当场复渲染」——区改为**读时现算、不落盘** ⇒
        #   那条义务改写成「当场回池」：**没有存储态快照 ⇒ 不可能有陈旧的区** ⇒
        #   「每次改池都得记得复渲染」的写点清单整条消失（它历史上漏接过三次）。
        _pool405 = [r["id"] for _k, r, *_ in refill_pool(Store(Path(cur_store[0])))[0]]
        _reg405 = run("view")[1]
        _qseg405 = (_reg405.split(QUEUE_BEGIN, 1)[1].split(QUEUE_END, 1)[0]
                    if QUEUE_BEGIN in _reg405 else "")
        expect("t000405：supersede 后被释放的条目**立刻回池**（现算的区里当场可见）",
               _bl in _pool405 and _bl in _qseg405, _reg405[-200:])
        # 与 blockedBy 无关）必然报「未销账条目没在 exit 里出现」。拿整段 rc 判会把
        # 一条与本改动无关的红算成自己的——夹具自己造的噪音必须剔掉，否则下次真出事
        # 时这条断言已经不具鉴别力了。
        # ⚠ 2026-10-23（t000405 落地）收紧：原断言只要求「不因 blockedBy 报红」，于是
        #   **队列区陈旧**（queue-stale）这条真红被夹具的宽松放过了——缺陷就藏在这条
        #   断言的余量里。现在额外要求 queue-stale 不报（区的当场复渲染）。
        expect("回池后 check 不因 blockedBy 报红，且**没有残留区**"
               "（v5.29.0：区不落盘 ⇒ 没有陈旧的区可陈旧；fresh-queue 是既有闸，"
               "夹具自身 exit 无散文）",
               "卡在" not in non_tamper(out2) and "blockedBy" not in non_tamper(out2)
               and "queue-legacy" not in non_tamper(out2), out2[-200:])
        # 会永久踢掉一条本可推进的活（比原病更隐蔽：症状是「有条目永远轮不到」）。
        rc2, out2 = run("add", "action", "--summary", "挡路 id 写错一条", "--domain", "v")
        _typo = out2.split("id=")[1].strip().split()[0]
        run("edit", _typo, "--blockedBy", "d999999")
        rc2, out2 = run("next", "--auto")
        # 负控验的是**它进了池**，不是它恰好排第一——三条同档（都吃默认「中」）时按 (created, id) 全序，
        # 指针给谁由排序决定，拿单一目标当断言测的是排序不是阻塞（这条断言一度就是这么错的）。
        _pool_n = int(out2.split("池 ")[1].split(" 条")[0])
        expect("负控：blockedBy 指向查不到的 id ⇒ 不算阻塞、回池（写错 id 不该永久踢掉活）",
               rc2 == 0 and _pool_n == 3, out2[-160:])
        rc2, out2 = run("check", "--no-log")
        expect("负控下 check 不因 blockedBy 报红", rc2 == 0 or "blockedBy" not in non_tamper(out2),
               out2[-200:])
        shutil.rmtree(_bp, ignore_errors=True)
        cur_store[0] = _saved_store

        # ---- ⑲ blocked-stale（t000255）：status=blocked 指着已不再生效的 blocker ⇒ 红
        # 这条闸存在的理由是**它保护的是「可见性」**：谓词③说没被挡、入池谓词②说被挡，
        # 两头一夹 ⇒ 条目无人接手也无人看得见（本仓 t000155 等 t000152，t000152 已闭）。
        # 夹具必须同时钉住两面，否则这闸没有鉴别力：
        #   正例（该红） ② 负控一：blocker 仍活着 ⇒ 绿 ③ 负控二：blocked 却没写 blockedBy ⇒ 绿
        _sp2 = tempfile.mkdtemp(prefix="handoff-selftest-blockstale.")
        cur_store[0] = _sp2
        run("init")
        rc2, out2 = run("add", "action", "--summary", "等 X 的活", "--domain", "v")
        _waiter = out2.split("id=")[1].strip().split()[0]
        rc2, out2 = run("add", "action", "--summary", "X", "--domain", "v")
        _x = out2.split("id=")[1].strip().split()[0]
        run("edit", _waiter, "--status", "blocked", "--blockedBy", _x)
        rc2, out2 = run("check", "--no-log")
        # 负控一：blocker 还活着 ⇒ 这不是矛盾，不该红（否则每次正常等待都被拦）
        expect("负控一：status=blocked 而 blocker **仍活着** ⇒ 不报红",
               rc2 == 0 or "已不再生效" not in non_tamper(out2), out2[-200:])
        # 变异：把 blocker 关掉（= 它要办的事有结论了）⇒ 矛盾成立
        run("close", _x, "--outcome", "X 有了结论")
        rc2, out2 = run("check", "--no-log")
        expect("正例：blocker 被 close 后 status=blocked 留在原处 ⇒ 红并给出三种修法",
               rc2 != 0 and "已不再生效" in non_tamper(out2) and "edit " in non_tamper(out2),
               out2[-260:], dim="blocked-stale")
        # 负控二：**新立一条**从没写过 blockedBy 的 blocked 条目——「没记指向」不是
        # 自相矛盾。不能拿上面那条清空 blockedBy 来测：写入类参数有非空守卫、清不掉，
        # 硬塞一个空 blocker 等于在测「空值怎么处理」，不是「没指向该不该红」。
        # 先按修法把上面那条清干净——**否则它在同一个存储里持续报红**，负控就会被
        # 自己的正例污染（这正是本条断言第一次跑就红的原因，不是判据错）。
        run("edit", _waiter, "--status", "open")
        rc2, out2 = run("add", "action", "--summary", "只说被挡、没记挡在谁身上", "--domain", "v")
        _nobb = out2.split("id=")[1].strip().split()[0]
        run("edit", _nobb, "--status", "blocked")
        rc2, out2 = run("check", "--no-log")
        expect("负控二：status=blocked 却**没写** blockedBy ⇒ 不报红（没记指向 ≠ 矛盾）",
               rc2 == 0 or "已不再生效" not in non_tamper(out2), out2[-200:])
        # 修法自证：闸的红能被它自己印出来的修法消掉（闸不是死路）
        run("edit", _waiter, "--status", "blocked")   # 重新制造矛盾
        rc2, out2 = run("check", "--no-log")
        expect("重新制造矛盾 ⇒ 红确实回来（不是上一条断言把闸测钝了）",
               rc2 != 0 and "已不再生效" in non_tamper(out2), out2[-260:])
        run("edit", _waiter, "--status", "open")
        rc2, out2 = run("check", "--no-log")
        expect("按修法改判 open ⇒ blocked-stale 红消",
               rc2 == 0 or "已不再生效" not in non_tamper(out2), out2[-200:])
        shutil.rmtree(_sp2, ignore_errors=True)
        cur_store[0] = _saved_store

    # ---- v5.43.0：文档面事实闸（唯一源＝`doc_fact_violations`）----
    # 这一维治的是**族 E**：文档里枚举工具事实的地方（槽清单／id 形态／status 闭集／
    # prio 闭集／写面上限／写入类命令），那串事实归代码所有 ⇒ 手抄进文档就是第二份抄件
    # ⇒ 抄件会漂 ⇒ 文档慢慢变成假称。⇒ 事实只存一份（在代码里），文档里只留渲染区。
    _pkg_root = Path(__file__).resolve().parent.parent
    _fv = doc_fact_violations(_pkg_root)
    expect("v5.43.0 文档事实闸：每个渲染区与代码派生的值逐字一致（手改渲染物 ⇒ 红）",
           not _fv, "；".join(_fv[:4]))
    # 负控①：手改渲染物 ⇒ 点名
    _fneg = doc_fact_text_violations(
        "<!--fact:slots-->9 槽（status／summary／scope／exit）<!--/fact-->", "内控.md")
    expect("v5.43.0 文档事实闸·负控①：渲染物被手改 ⇒ 当场点名",
           any("不一致" in x for x in _fneg), f"违例 {_fneg[:2]}")
    # 负控②：引用不存在的事实 ⇒ 点名
    _fneg2 = doc_fact_text_violations("<!--fact:no-such-fact-->x<!--/fact-->", "内控.md")
    expect("v5.43.0 文档事实闸·负控②：引用不存在的事实 ⇒ 当场点名",
           any("不存在" in x for x in _fneg2), f"违例 {_fneg2[:2]}")
    # 变异自证：把一个事实的值改掉 ⇒ 闸门当场红（闸不是恒绿）
    _real_facts = DOC_FACTS
    try:
        globals()["DOC_FACTS"] = {**_real_facts, "slots": (lambda: "槽清单（被人改过了）")}
        _fmut = doc_fact_violations(_pkg_root)
    finally:
        globals()["DOC_FACTS"] = _real_facts
    expect("v5.43.0 文档事实闸·变异自证：事实的值被改 ⇒ 闸门当场红（闸有牙）",
           any("slots" in x for x in _fmut), f"违例 {_fmut[:2]}")

    # ---- v5.44.0：重述点闸（唯一源＝`rewrite_gate_violations`）----
    # 这一维治的是**终极律 L9**：同一事实的第二份陈述＝重述点 ⇒ 抄件会漂 ⇒ 纪律被违反时静默。
    # ⇒ 机制面（代码与随件文档）逐类实算，**只许待在豁免名单里**，名单与实算双向对账。
    _rw0 = rewrite_gate_violations(_pkg_root)
    expect("v5.44.0 重述点闸：机制面重述点实算与豁免名单**双向对得上**（不多不少）",
           not _rw0, "；".join(_rw0[:3]))
    _real_ex = REWRITE_EXEMPT
    # 负控①：豁免过期（基线比实算多）⇒ 红
    try:
        globals()["REWRITE_EXEMPT"] = [{**e, "count": int(e.get("count", 0)) + 1} for e in _real_ex]
        _rw1 = rewrite_gate_violations(_pkg_root)
    finally:
        globals()["REWRITE_EXEMPT"] = _real_ex
    expect("v5.44.0 重述点闸·负控①：豁免过期（基线比实算多）⇒ 当场红",
           any("豁免**过期**" in x for x in _rw1), f"违例 {_rw1[:2]}")
    # 负控②：豁免指向不存在的类 ⇒ 红
    try:
        globals()["REWRITE_EXEMPT"] = [*_real_ex, {"cls": "no-such-cls", "count": 1,
                                                  "why": "内控", "dead": "内控", "dead_when": "内控"}]
        _rw2 = rewrite_gate_violations(_pkg_root)
    finally:
        globals()["REWRITE_EXEMPT"] = _real_ex
    expect("v5.44.0 重述点闸·负控②：豁免指向不存在的类 ⇒ 当场红",
           any("不在实算表里" in x for x in _rw2), f"违例 {_rw2[:2]}")
    # 负控③：豁免没写死期条件 ⇒ 红（豁免＝先欠着、到期必须还）
    try:
        globals()["REWRITE_EXEMPT"] = [{k: v for k, v in e.items() if k != "dead_when"}
                                      for e in _real_ex]
        _rw3 = rewrite_gate_violations(_pkg_root)
    finally:
        globals()["REWRITE_EXEMPT"] = _real_ex
    expect("v5.44.0 重述点闸·负控③：豁免没写死期条件 ⇒ 当场红",
           any("缺 `dead_when`" in x for x in _rw3), f"违例 {_rw3[:2]}")
    # 行为腿：**真跑 check**——机制面重述点超出豁免 ⇒ `rewrite-points` 维报红
    with _leg_store() as _ls:
        try:
            globals()["REWRITE_EXEMPT"] = [{**e, "count": 0} for e in _real_ex]
            rc2, out2 = run("check", "--no-log")
        finally:
            globals()["REWRITE_EXEMPT"] = _real_ex
        expect("v5.44.0 重述点闸：机制面重述点超出豁免 ⇒ check 报红（新增即红）",
               rc2 != 0 and "rewrite-points" in out2, out2[-240:], dim="rewrite-points")

    # ---- v5.52.0：机制面纪律**必现**闸（唯一源＝`discipline_present_violations`）----
    # 这一维治的是「纪律只进了闸、没进文档」⇒ 改包文档的人（或 agent）不知道有它 ⇒
    # 只靠闸兜 ⇒ 纪律**事实上没落地**（t000446）。
    _dp0 = discipline_present_violations(_pkg_root)
    expect("v5.52.0 纪律必现闸：登记的纪律**都写在随件文档里**（纪律进闸也进文档）",
           not _dp0, "；".join(_dp0[:3]), dim="discipline-present")
    # 负控①：纪律的锚点从随件文档里消失 ⇒ 红（纪律被删／被改写 ⇒ 没人知道有它了）
    _real_dp = DISCIPLINE_PRESENT
    try:
        globals()["DISCIPLINE_PRESENT"] = {
            did: "这句锚点谁都没写进随件文档" for did in _real_dp}
        _dp1 = discipline_present_violations(_pkg_root)
    finally:
        globals()["DISCIPLINE_PRESENT"] = _real_dp
    expect("v5.52.0 纪律必现闸·负控①：纪律没写在随件文档里 ⇒ 当场红",
           any("没写在随件文档里" in x for x in _dp1), f"违例 {_dp1[:2]}",
           dim="discipline-present")
    # 负控②：纪律清单里塞一条**没写进文档**的纪律 ⇒ 红（新纪律必须同批写进文档）
    try:
        globals()["DISCIPLINE_PRESENT"] = {
            **_real_dp, "brand-new-discipline": "这句锚点谁都没写进文档"}
        _dp2 = discipline_present_violations(_pkg_root)
    finally:
        globals()["DISCIPLINE_PRESENT"] = _real_dp
    expect("v5.52.0 纪律必现闸·负控②：新增纪律没同批写进随件文档 ⇒ 当场红",
           any("brand-new-discipline" in x for x in _dp2), f"违例 {_dp2[:2]}",
           dim="discipline-present")
    # 负控③：随件文档整个读不到 ⇒ 红（不是「沉默地跳过」）
    _real_dd = DISCIPLINE_DOCS
    try:
        globals()["DISCIPLINE_DOCS"] = ("references/does-not-exist.md",)
        _dp3 = discipline_present_violations(_pkg_root)
    finally:
        globals()["DISCIPLINE_DOCS"] = _real_dd
    expect("v5.52.0 纪律必现闸·负控③：随件文档不存在 ⇒ 当场红（不沉默跳过）",
           any("不存在" in x for x in _dp3), f"违例 {_dp3[:2]}", dim="discipline-present")
    # 行为腿：**真跑 check**——纪律没进随件文档 ⇒ `discipline-present` 维报红
    with _leg_store() as _ls:
        try:
            globals()["DISCIPLINE_PRESENT"] = {
                did: "这句锚点谁都没写进随件文档" for did in _real_dp}
            rc2, out2 = run("check", "--no-log")
        finally:
            globals()["DISCIPLINE_PRESENT"] = _real_dp
        expect("v5.52.0 纪律必现闸：纪律没进随件文档 ⇒ check 报红（纪律事实上没落地）",
               rc2 != 0 and "discipline-present" in out2, out2[-240:], dim="discipline-present")

    # ---- v5.53.0：**凭空出现的 id**（出处台账；唯一源＝`id_provenance_violations`）----
    # 病灶（t000448）：手加一条**完全合法**的条目到**新文件**里 ⇒ 写事件维只对账
    # 台账里有的文件 ⇒ 看不见它 ⇒ 跑一次 `handoff index` 重建索引后 ⇒ **彻底隐形**。
    # ⇒ 治法：写事件记下 CLI **分配**的 id ⇒ 在册 id 必须有分配记录
    # （台账只追加 ⇒ `index` 重建改不了分配记录 ⇒ 洗不掉）。
    with _leg_store() as _ls:
        run("add", "pitfall", "--summary", "出处维：正常条目", "--domain", "prov")
        rc2, out2 = run("check", "--no-log")
        expect("v5.53.0 出处维·负控：正常写的条目**不红**（判据不是恒红）",
               rc2 == 0 and "来历不可追" not in out2, out2[-200:], dim="id-provenance")
        # 手加一个**新文件**，里面一条完全合法的条目（t000448 原样复现）
        (_ls / "pitfalls").mkdir(exist_ok=True)
        (_ls / "pitfalls" / "manual.jsonl").write_text(
            json.dumps({"id": "p000901", "created": "2026-10-24", "status": "open",
                        "summary": "人手加的一条完全合法的条目"}, ensure_ascii=False) + "\n",
            encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("v5.53.0 出处维·正控：手加的**新文件**里的条目 ⇒ check 报红且点名它",
               rc2 != 0 and "来历不可追" in out2 and "p000901" in out2, out2[-240:],
               dim="id-provenance")
        # **核心那条**：重建索引之后**仍然红**（旧形正是「重建后彻底隐形」）
        run("index")
        rc2, out2 = run("check", "--no-log")
        expect("v5.53.0 出处维·耐洗：重建 `index` 之后**仍然红**（分配记录洗不掉）",
               rc2 != 0 and "来历不可追" in out2 and "p000901" in out2, out2[-240:],
               dim="id-provenance")
    # 老库不误伤：台账里**没有分配记录、也没建基线**（老版本写的库）⇒ 存量 id **不判**
    # （来历不可追 ⇒ 判了必误伤）⇒ 但**不判 ≠ 闸缺席** ⇒ 另出一条**可执行**红项。
    with _leg_store() as _ls:
        run("add", "pitfall", "--summary", "老库条目", "--domain", "old")
        _wl = _ls / "writes.jsonl"
        _evs: list[str] = []
        for _l in _wl.read_text(encoding="utf-8").splitlines():
            if not _l.strip():
                continue
            _e = json.loads(_l)
            for _k in ("prov", "ids", "id_base"):
                _e.pop(_k, None)
            _evs.append(json.dumps(_e, ensure_ascii=False))
        _wl.write_text("\n".join(_evs) + "\n", encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("v5.53.0 出处维·负控：老库（无分配记录无基线）的存量 id **不误伤**",
               "来历不可追" not in out2, out2[-240:], dim="id-provenance")
        expect("v5.53.0 出处维·老库：基线还没建立 ⇒ 出一条**可执行**红项（不是静默不判）",
               rc2 != 0 and "id 出处基线" in out2, out2[-240:], dim="id-provenance")
        # 认账一次（跑一次 CLI 写 ⇒ 自动落基线＝那一刻在册 id 的快照）⇒ 存量 id 认账
        run("index")
        rc2, out2 = run("check", "--no-log")
        expect("v5.53.0 出处维·老库认账后：存量 id 认账 ⇒ 该维转绿（不误伤）",
               rc2 == 0 and "来历不可追" not in out2 and "id 出处基线" not in out2,
               out2[-240:], dim="id-provenance")
        # 老库认账后 + 手加新文件 ⇒ **只**点名外来那个（存量 id 一个都不许误报）
        (_ls / "pitfalls").mkdir(exist_ok=True)
        (_ls / "pitfalls" / "manual.jsonl").write_text(
            json.dumps({"id": "p000777", "created": "2026-10-24", "status": "open",
                        "summary": "老库里手加的一条"}, ensure_ascii=False) + "\n",
            encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        expect("v5.53.0 出处维：老库认账后 + 手加新文件 ⇒ 只点名**外来那个**（存量 id 不误报）",
               rc2 != 0 and "p000777" in out2 and "来历不可追" in out2 and "p000001" not in out2,
               out2[-240:], dim="id-provenance")
    # 变异自证：把**分配记录**摘掉 ⇒ 连正常写的条目也被判红（证明这条腿有牙、不是恒绿）
    with _leg_store() as _ls:
        _real_log_write = log_write
        try:
            globals()["log_write"] = (
                lambda st, op, targets, pre_tamper=None, removed=None, ids=None:
                _real_log_write(st, op, targets, pre_tamper, removed, None))
            run("add", "pitfall", "--summary", "变异：分配记录被摘掉", "--domain", "mut")
        finally:
            globals()["log_write"] = _real_log_write
        rc2, out2 = run("check", "--no-log")
        expect("v5.53.0 出处维·变异自证：摘掉**分配记录** ⇒ 正常写的条目也被判红（腿有牙）",
               rc2 != 0 and "来历不可追" in out2, out2[-240:], dim="id-provenance")

    # ---- t000486：收窗（compact-writes）**不毁出处基线** ----
    # 病灶：折叠基线只带 files/removed/pre_tamper/ops ⇒ 把唯一那条 id_base 事件与
    # 全部 ids 分配记录一并折掉 ⇒ 收窗后 check 恒红；且 `_prov_live` 只看尾部窗口
    # （保留事件带 prov）⇒ 永不补基线 ⇒ index 无法自愈，唯一出口 rebase --force。
    with _leg_store() as _ls:
        def _errs(out: str) -> list[str]:
            return [l for l in out.splitlines() if l.startswith("  - ")]

        run("add", "pitfall", "--summary", "收窗出处：甲", "--domain", "prov")
        run("add", "pitfall", "--summary", "收窗出处：乙", "--domain", "prov")
        run("rebase", "--force")          # 显式建基线（id_base 落盘）
        run("add", "pitfall", "--summary", "基线之后才分配", "--domain", "prov")
        rc2, out2 = run("check", "--no-log")
        expect("t000486 前置：收窗前 check 绿", rc2 == 0, out2[-240:], dim="id-provenance")
        run("compact-writes", "--keep", "0")
        rc2, out2 = run("check", "--no-log")
        expect("t000486 负控（--keep 0）：收窗后 check 仍绿（id_base 与 ids 一并保活）",
               rc2 == 0 and "id 出处基线" not in out2 and "来历不可追" not in out2,
               out2[-240:], dim="id-provenance")
        _cw_evs = read_jsonl(_ls / "writes.jsonl")
        expect("t000486：keep 0 后唯一基线事件带 prov 键，且 id_base／ids 键都在"
               "（空集也保留键 ⇒ 新库不被打成老库）",
               len(_cw_evs) == 1 and _cw_evs[0].get("prov") == PROV_VERSION
               and "id_base" in _cw_evs[0] and "ids" in _cw_evs[0],
               f"{len(_cw_evs)} 条：{sorted(_cw_evs[0]) if _cw_evs else None}")
        # 幂等：再收一次（这次折的是上一条基线）⇒ 并集继续并进来、判定仍绿
        run("compact-writes", "--keep", "0")
        rc2, out2 = run("check", "--no-log")
        _cw_evs = read_jsonl(_ls / "writes.jsonl")
        expect("t000486：二次收窗幂等——基线不丢、并集仍在（check 仍绿）",
               rc2 == 0 and len(_cw_evs) == 1
               and {"p000001", "p000002"} <= set(_cw_evs[0].get("ids") or []),
               out2[-240:], dim="id-provenance")
        # 红方向同样要「判定逐项一致」：手加外来 id ⇒ 收窗前后都必须点名它
        (_ls / "pitfalls").mkdir(exist_ok=True)
        (_ls / "pitfalls" / "manual.jsonl").write_text(
            json.dumps({"id": "p000902", "created": "2026-10-28", "status": "open",
                        "summary": "收窗夹具：手加的外来条目"}, ensure_ascii=False) + "\n",
            encoding="utf-8")
        rc2, out2 = run("check", "--no-log")
        _red_before = _errs(out2)
        expect("t000486 正控前置：手加外来 id ⇒ 收窗前红且点名它",
               rc2 != 0 and "p000902" in out2, out2[-240:], dim="id-provenance")
        run("compact-writes", "--keep", "0")
        rc2, out2 = run("check", "--no-log")
        expect("t000486 正控：收窗后**仍然**点名同一个外来 id，且错误项逐项一致"
               "（判定不变也含红方向）",
               rc2 != 0 and "p000902" in out2 and _errs(out2) == _red_before,
               out2[-240:], dim="id-provenance")
    # 默认 keep（200）：事件数超过保留额才真折叠——用合成事件把折叠段撑到
    # 「含 id_base 事件 ＋ 含 ids 事件」的位置，验默认参数同样保活。
    with _leg_store() as _ls:
        run("add", "pitfall", "--summary", "默认收窗：甲", "--domain", "prov")
        run("add", "pitfall", "--summary", "默认收窗：乙", "--domain", "prov")
        _wl = _ls / "writes.jsonl"
        with open(_wl, "a", encoding="utf-8") as f:
            for _i in range(201):
                f.write(json.dumps({"ts": "2026-10-28T00:00:00+08:00", "op": "synthetic",
                                    "prov": PROV_VERSION, "pre_tamper": [],
                                    "removed": [], "files": {}, "ids": []}) + "\n")
        rc2, out2 = run("check", "--no-log")
        expect("t000486 默认 keep（200）前置：合成事件后 check 绿",
               rc2 == 0, out2[-240:], dim="id-provenance")
        run("compact-writes")             # 默认 --keep 200 ⇒ 头 4 条折进基线
        _base = [e for e in read_jsonl(_wl) if e.get("op") == "__compact__"]
        rc2, out2 = run("check", "--no-log")
        expect("t000486 默认 keep（200）：折叠段含 id_base／ids 事件 ⇒ 收窗后仍绿",
               rc2 == 0 and len(_base) == 1 and int(_base[0].get("folded") or 0) > 0
               and {"p000001", "p000002"} <= set(_base[0].get("ids") or [])
               and "id_base" in _base[0],
               f"{len(_base)} 条基线／{out2[-160:]}", dim="id-provenance")

    # ---- v5.45.0：refs 化（班段散文里**点到 id** 即算覆盖）----
    # 这一版治的是**B 类重述点**：覆盖事实的**原件**是散文（作者写的那段话），
    # 声明只是它的**第二份陈述** ⇒ 声明一漂就静默。⇒ 改成：写时把散文里的 id 提取成
    # `refs` 落进班次台账（落盘证据）⇒ 判据读 refs ⇒ 作者成本 0（提到就覆盖），
    # `--covers` 降级为**例外出口**（几十条 id 提不动时打包）。
    with _leg_store() as _ls:
        _, _o1 = run("add", "action", "--summary", "refs 腿：条目一")
        _e1 = next(iter(re.findall(r"id=(t\d+)", _o1)), "")
        # ① 变异自证：refs 提取关掉 ⇒ 写入被拒（证明放行来自 refs，不是判据压根不报）
        _orig_ex = _extract_refs
        try:
            globals()["_extract_refs"] = lambda text: []
            rc2, out2 = run("append", "exit", "--file", "-",
                            inp=f"## refs 班段\n\n- 这一班修好了{_e1}。\n", covers=False)
        finally:
            globals()["_extract_refs"] = _orig_ex
        expect("v5.45.0 refs 化·变异自证：refs 提取关掉 ⇒ 写入被拒（证明放行来自 refs）",
               rc2 != 0 and "必须点名覆盖" in out2, out2[-200:])
        # ② 还原 ⇒ 散文里点到 id ⇒ 写入放行（作者成本 0：不必另写一份声明）
        rc2, out2 = run("append", "exit", "--file", "-",
                        inp=f"## refs 班段\n\n- 这一班修好了{_e1}。\n", covers=False)
        expect("v5.45.0 refs 化：班段散文里点到 id ⇒ 写入放行（不必另写声明）",
               rc2 == 0, out2[-200:])
        # ③ 判据也绿（覆盖集合＝refs ∪ 声明）
        rc2, out2 = run("check", "--no-log")
        expect("v5.45.0 refs 化：点名过的条目 ⇒ 判据绿（覆盖集合＝refs）",
               "fresh-queue" not in non_tamper(out2), out2[-200:])
        # ④ refs 落在**班次台账**里（落盘证据，不是散文里的形状）
        _recs = [json.loads(l) for l in (Path(cur_store[0]) / "shifts.jsonl")
                 .read_text(encoding="utf-8").splitlines() if l.strip()]
        expect("v5.45.0 refs 化：点名结果落在班次台账的 `refs` 字段里（落盘证据）",
               bool(_recs) and _e1 in (_recs[-1].get("refs") or []),
               f"末条 refs={_recs[-1].get('refs') if _recs else None}")

    _selftest_static_mechanism_gates(expect)
    # 行为腿（独立库）：红项**自带**当场可执行的下一步（写面早就有，读面此前没有）
    with _leg_store() as _ls:
        (_ls / "scope").unlink()
        rc2, out2 = run("check", "--no-log")
        _line = next((x for x in out2.splitlines() if "缺槽" in x), "")
        expect("v5.47.0 读面出路·行为腿：check 的红项自带当场可执行的下一步",
               rc2 != 0 and "修：" in _line and "handoff init" in _line,
               _line or out2[-200:])

    # ---- v5.42.0：落点登记的对账闸（唯一源＝`landing_registry_violations`）----
    # 放在**所有腿跑完之后**才算：腿覆盖那一项要的是「这条腿真跑过」——
    # 静态标注只说明「有这么一条腿」，不说明它承重（落在没走到的分支里的腿不承重）。
    _pkg_root = Path(__file__).resolve().parent.parent
    _src_ld = Path(__file__).read_text(encoding="utf-8")
    _viol = landing_registry_violations(_src_ld, _pkg_root, _leg_dims)
    expect("v5.42.0 落点登记：每条判据维都有落点·契约·作废条件，且落点真实可达",
           not _viol, "；".join(_viol[:4]))
    _real_ld = FACT_LANDINGS
    # 负控：登记里多一行**表外的维** ⇒ 红（登记自己漂了也要红）
    try:
        globals()["FACT_LANDINGS"] = {**_real_ld, "no-such-dim": _real_ld["slots"]}
        _neg1 = landing_registry_violations(_src_ld, _pkg_root, _leg_dims)
    finally:
        globals()["FACT_LANDINGS"] = _real_ld
    expect("v5.42.0 落点登记·负控：登记里多一行表外的维 ⇒ 当场红",
           any("不是判据维" in x for x in _neg1), f"违例 {_neg1[:2]}")
    # 变异自证①：删掉一行登记 ⇒ 覆盖闸当场红
    try:
        globals()["FACT_LANDINGS"] = {k: v for k, v in _real_ld.items() if k != "slots"}
        _mut1 = landing_registry_violations(_src_ld, _pkg_root, _leg_dims)
    finally:
        globals()["FACT_LANDINGS"] = _real_ld
    expect("v5.42.0 落点登记·变异自证①：删掉一行登记 ⇒ 覆盖闸当场红（腿有牙）",
           any("slots" in x for x in _mut1), f"违例 {_mut1[:2]}")
    # 变异自证②：落点锚点写错 ⇒ 落点闸当场红
    # （锚点字符串**运行时拼**出来：写成字面量的话，它自己就在源文件里 ⇒ 闸查不到「找不到」）
    _bad_anchor = "落点锚点自证" + chr(0x2603)
    try:
        globals()["FACT_LANDINGS"] = {**_real_ld, "slots": {**_real_ld["slots"], "landing":
                                     ("scripts/handoff.py", _bad_anchor)}}
        _mut2 = landing_registry_violations(_src_ld, _pkg_root, _leg_dims)
    finally:
        globals()["FACT_LANDINGS"] = _real_ld
    expect("v5.42.0 落点登记·变异自证②：落点锚点写错 ⇒ 落点闸当场红（腿有牙）",
           any("落点锚点" in x for x in _mut2), f"违例 {_mut2[:2]}")
    # 变异自证③：腿标注指向不存在的维 ⇒ 当场红
    _mut3 = landing_registry_violations(_src_ld.replace('dim="slots"', 'dim="no-such-dim"', 1),
                                        _pkg_root, _leg_dims)
    expect("v5.42.0 落点登记·变异自证③：腿标注指向不存在的维 ⇒ 当场红（腿有牙）",
           any("不存在的判据维" in x for x in _mut3), f"违例 {_mut3[:2]}")
    # 变异自证④：把「腿真跑过」清空 ⇒ 当场红（静态标注不承重）
    _mut4 = landing_registry_violations(_src_ld, _pkg_root, {k: [] for k in _leg_dims})
    expect("v5.42.0 落点登记·变异自证④：腿没真跑过 ⇒ 当场红（静态标注不承重）",
           any("一条都没跑过" in x for x in _mut4), f"违例 {_mut4[:2]}")

    # ---- v5.49.0（B 批）：机制覆盖登记的对账闸（唯一源＝`mechanism_coverage_violations`）----
    # 这一维治的是**元根因**（族 E）：「机制只覆盖它自己那一片，漏掉的那一片没人管」
    # ＋「机制宣称覆盖却没覆盖」＋「机制造好却不跑」三族复发。
    # ⇒ 判据输入是**落盘证据**（文件树枚举出的面全集 ＋ AST 推导出的实扫面），
    #   不读 docstring（独立席 Q2：**不许拿 docstring 当实扫面的证据**——v5.48.0 当代
    #   那处「声称面 E 含注释、实扫只扫 AST 字符串」的假称，正是本项要抓的）。
    _src_mc = Path(__file__).read_text(encoding="utf-8")
    _mc = mechanism_coverage_violations(_src_mc, _pkg_root)
    expect("v5.49.0 机制覆盖登记：每个面都有人管（或显式登记为不管面），"
           "声称的覆盖面＝代码真扫的面，机制真在自动面里",
           not _mc, "；".join(_mc[:4]))
    _real_mc = MECHANISM_COVERAGE
    _real_ms = MECHANISM_STRUCTURE
    # 负控①：把某机制挪进「不管面」而无人接 ⇒ 覆盖闭合红（真有人管的面变成没人管）
    try:
        globals()["MECHANISM_COVERAGE"] = {
            **_real_mc,
            "fact_copy_violations": {
                **_real_mc["fact_copy_violations"],
                "覆盖面": (),          # 声称面全撤 ⇒ 这些面没人管
            },
        }
        _mc1 = mechanism_coverage_violations(_src_mc, _pkg_root)
    finally:
        globals()["MECHANISM_COVERAGE"] = _real_mc
    expect("v5.49.0 机制覆盖登记·负控①：撤掉某机制的覆盖面 ⇒ 覆盖闭合当场红",
           any("没人管" in x for x in _mc1), f"违例 {_mc1[:2]}")
    # 负控②：登记一个不存在的机制名 ⇒ 声明可达红
    try:
        globals()["MECHANISM_COVERAGE"] = {
            **_real_mc, "no_such_mechanism": {
                "落点": ("scripts/handoff.py", "def no_such_mechanism("),
                "族": "事实存在性", "覆盖面": (), "实扫面": (), "不管面": {},
                "执行面": ("scripts/handoff.py", "cmd_selftest"),
            }}
        _mc2 = mechanism_coverage_violations(_src_mc, _pkg_root)
    finally:
        globals()["MECHANISM_COVERAGE"] = _real_mc
    expect("v5.49.0 机制覆盖登记·负控②：登记不存在的机制名 ⇒ 声明可达当场红",
           any("在代码里不存在" in x for x in _mc2), f"违例 {_mc2[:2]}")
    # 负控③：落点锚点写错 ⇒ 落点可达红
    try:
        globals()["MECHANISM_COVERAGE"] = {
            **_real_mc,
            "fact_copy_violations": {
                **_real_mc["fact_copy_violations"],
                # 故意写错的锚点：**运行时拼出来**（写死会出现在本文件里 ⇒
                # 「锚点找不到」这条永远不成立 ⇒ 负控自证失效）
                "落点": ("scripts/handoff.py", "def fact_copy_violations_" + chr(0x2603) + "("),
            },
        }
        _mc3 = mechanism_coverage_violations(_src_mc, _pkg_root)
    finally:
        globals()["MECHANISM_COVERAGE"] = _real_mc
    expect("v5.49.0 机制覆盖登记·负控③：落点锚点写错 ⇒ 落点可达当场红",
           any("落点锚点" in x for x in _mc3), f"违例 {_mc3[:2]}")
    # 负控④：归属指向不存在的机制 ⇒ 归属真实红
    try:
        globals()["MECHANISM_COVERAGE"] = {
            **_real_mc,
            "fact_copy_violations": {
                **_real_mc["fact_copy_violations"],
                "不管面": {"prose:references/rules.md": "no_such_owner"},
            },
        }
        _mc4 = mechanism_coverage_violations(_src_mc, _pkg_root)
    finally:
        globals()["MECHANISM_COVERAGE"] = _real_mc
    expect("v5.49.0 机制覆盖登记·负控④：归属指向不存在的机制 ⇒ 归属真实当场红",
           any("假归属" in x for x in _mc4), f"违例 {_mc4[:2]}")
    # ── v5.54.0（t000456）：永久豁免形态 ＋ 「待建」免检口关闭 ──
    # 正控：面登记成**永久豁免（带理由）** ⇒ 该面**有人管**（不报「没人管」）
    _faces_now = _surface_faces(_pkg_root)
    _exempt_faces = set()
    for _r in _real_mc.values():
        for _f, _o in (_r.get("不管面") or {}).items():
            if isinstance(_o, str) and _o.startswith(EXEMPT_PREFIX):
                _exempt_faces.add(_f)
    _mc_ok = mechanism_coverage_violations(_src_mc, _pkg_root)
    expect("v5.54.0 覆盖登记·正控：永久豁免（带理由）的面**有人管** ⇒ 不报「没人管」",
           bool(_exempt_faces) and not any("没人管" in x for x in _mc_ok)
           and all(f in _faces_now for f in _exempt_faces),
           f"豁免面 {sorted(_exempt_faces)}｜违例 {_mc_ok[:2]}")
    # 负控⑦：永久豁免**没写理由** ⇒ 当场红（否则豁免＝无痕免检口）
    try:
        globals()["MECHANISM_COVERAGE"] = {
            **_real_mc,
            "fact_copy_violations": {
                **_real_mc["fact_copy_violations"],
                "不管面": {"prose:DESCRIPTION-AUDIT.md": EXEMPT_PREFIX},
            },
        }
        _mc7 = mechanism_coverage_violations(_src_mc, _pkg_root)
    finally:
        globals()["MECHANISM_COVERAGE"] = _real_mc
    expect("v5.54.0 覆盖登记·负控⑦：永久豁免**没写理由** ⇒ 当场红（豁免≠无痕免检口）",
           any("没写理由" in x for x in _mc7), f"违例 {_mc7[:2]}")
    # 负控⑧：把面挂给**已废的「待建:」形态**（或不存在的机制）⇒ 假归属当场红
    # （这条就是「免检口关闭」的实证：待建形态曾让一个面既没人扫又永远绿）
    try:
        globals()["MECHANISM_COVERAGE"] = {
            **_real_mc,
            "fact_copy_violations": {
                **_real_mc["fact_copy_violations"],
                "不管面": {"prose:DESCRIPTION-AUDIT.md": "待建:pkg_doc_closure"},
            },
        }
        _mc8 = mechanism_coverage_violations(_src_mc, _pkg_root)
    finally:
        globals()["MECHANISM_COVERAGE"] = _real_mc
    expect("v5.54.0 覆盖登记·负控⑧：挂「待建:」形态 ⇒ 假归属当场红（免检口已关闭）",
           any("假归属" in x for x in _mc8), f"违例 {_mc8[:2]}")
    # 负控⑤（★关键）：把某机制从自动面里摘掉 ⇒ 执行面在跑红
    # **这一条是探针⑤那族病的专治腿**（机制存在却不在任何自动面 ⇒ 闸造好却不跑）。
    try:
        globals()["MECHANISM_STRUCTURE"] = {
            **_real_ms, "exit_key_violations": (_real_ms["exit_key_violations"][0],
                                                 ("scripts/handoff.py", "cmd_no_such_entry")),
        }
        _mc5 = mechanism_coverage_violations(_src_mc, _pkg_root)
    finally:
        globals()["MECHANISM_STRUCTURE"] = _real_ms
    expect("v5.49.0 机制覆盖登记·负控⑤：机制不在任何自动面里 ⇒ 执行面在跑当场红",
           any("没有调用" in x or "里不存在" in x for x in _mc5), f"违例 {_mc5[:2]}")
    # 负控⑥（★独立席 Q7.1）：把某机制的覆盖面写宽（多声称一个面）⇒ 声称面 ↔ 实扫面红
    # **这正是 v5.48.0 当代那处「声称面 E 含注释、实扫只扫 AST 字符串」的病**：
    # 若登记跟着散文声称多写一个面 ⇒ 本项立刻抓住（而不是等到人肉发现）。
    # ⚠ v5.51.0：原负控多声称的是「注释面」——但那批**已经把注释面真扫了**
    #   （代码面真扫面含它）⇒ 多声称它不再构成「声称 > 实扫」⇒ 负控会恒绿。
    #   ⇒ 改多声称**全集里存在、但该机制闭包没扫**的面（包根随件文档那张）⇒ 负控恢复鉴别力。
    try:
        globals()["MECHANISM_COVERAGE"] = {
            **_real_mc,
            "fact_copy_violations": {
                **_real_mc["fact_copy_violations"],
                "覆盖面": (*_real_mc["fact_copy_violations"]["覆盖面"], "prose:DESCRIPTION-AUDIT.md"),
            },
        }
        _mc6 = mechanism_coverage_violations(_src_mc, _pkg_root)
    finally:
        globals()["MECHANISM_COVERAGE"] = _real_mc
    expect("v5.49.0 机制覆盖登记·负控⑥：声称覆盖面比代码真扫的多一个面 ⇒ 当场红"
           "（独立席 Q7.1 的活样本：声称的面比真扫的多 ⇒ 立刻抓住）",
           any("没真扫" in x for x in _mc6), f"违例 {_mc6[:2]}")
    # 变异自证：把第 1 项的差集逻辑反过来（用**交集**）⇒ 负控①必须翻面（否则判据恒绿）
    #
    # **怎么判「翻面」**：同一个坏登记（撤掉覆盖面 ⇒ 有面没人管），
    #   · 差集语义（本闸的真实语义）⇒ **报**「没人管」；
    #   · 交集语义（变异体）⇒ **不报**（交集＝「既被覆盖又不管」，坏登记反而自洽）。
    # ⇒ 变异体下「没人管」条数必须为 0 ⇒ 证明负控①的红**确实**来自差集那一步，
    #   而不是「反正都会红」（恒绿腿的病）。
    try:
        globals()["MECHANISM_COVERAGE"] = {
            **_real_mc,
            "fact_copy_violations": {
                **_real_mc["fact_copy_violations"],
                "覆盖面": (),
            },
        }
        _mc_mut = mechanism_coverage_violations(_src_mc, _pkg_root)
        # 变异体：把「没人管」的**差集**语义换成**交集**语义
        #   差集（真实）：没人管的 ＝ 全集 － 覆盖 － 不管
        #   交集（变异）：没人管的 ＝ 全集 ∩（覆盖 ∩ 不管）＝ ∅
        #     （交集会认为「既被覆盖又登记为不管」才算没人管 ⇒ 坏登记反而自洽 ⇒ 不报）
        _mut_faces = _surface_faces(_pkg_root)
        _mut_cov: set[str] = set()
        _mut_unm: set[str] = set()
        for _n, _r in _real_mc.items():
            if _n == "fact_copy_violations":
                continue                    # ← 坏登记：撤掉它的覆盖面
            _mut_cov |= _mc_expand(_r.get("覆盖面", ()), _mut_faces)
            _mut_unm |= set(_r.get("不管面") or {})
        _mut_diff = set(_mut_faces) - _mut_cov - _mut_unm            # ← 差集语义（真实）
        _mut_intersect = set(_mut_faces) & _mut_cov & _mut_unm      # ← 交集语义（变异体）
    finally:
        globals()["MECHANISM_COVERAGE"] = _real_mc
    expect("v5.49.0 机制覆盖登记·变异自证：撤掉覆盖面 ⇒ 差集语义报「没人管」而"
           "同一输入在交集语义下不报（判据有牙，不是恒绿）",
           any("没人管" in x for x in _mc_mut) and bool(_mut_diff) and not _mut_intersect,
           f"违例 {_mc_mut[:2]}")

    # ---- v5.69.0（t000475）：三条真修的腿（负控 ＋ 正控 ＋ 变异自证）----
    # ① 出路闸的 flag 覆盖面：**短 flag 也核**（旧形只认 `--` ⇒ 短 flag 天然放行）
    expect("v5.69.0 出路闸·负控：出路点名**不存在的短 flag** ⇒ 当场红（旧形这里放行）",
           bool(exit_nonexistent_commands_violations(["修：`handoff check -Z`"])),
           "不存在的短 flag 没被认出")
    expect("v5.69.0 出路闸·正控：真 flag 与非 flag 词（`-`＝stdin）不误伤",
           not exit_nonexistent_commands_violations(["修：`handoff check --no-log`"])
           and not exit_nonexistent_commands_violations(["修：`handoff import -`"]),
           "真写法被误判成「flag 不存在」")
    _real_flag_tok = globals().get("_is_flag_token")
    try:
        globals()["_is_flag_token"] = lambda w: w.startswith("--")
        _mut_flag_green = not exit_nonexistent_commands_violations(["修：`handoff check -Z`"])
    finally:
        globals()["_is_flag_token"] = _real_flag_tok
    expect("v5.69.0 出路闸·变异自证：换回旧形（只认 `--`）⇒ 短 flag 负控转绿（腿有牙）",
           _mut_flag_green, "换回旧形后负控仍红 ⇒ 这条腿没测到 flag 覆盖面")
    # ② 封存维的排除信号：老库**被删掉 `index`** 也仍是老库（仍须判封存）
    with _leg_store() as _ls2:
        (_ls2 / "index").unlink(missing_ok=True)
        _real_pre = globals().get("store_preexisting")
        try:
            globals()["store_preexisting"] = lambda d: (d / "index").is_file()
            _mut_pre = store_preexisting(_ls2)
        finally:
            globals()["store_preexisting"] = _real_pre
        _new_pre = store_preexisting(_ls2)
        expect("v5.69.0 封存维·变异自证：换回旧代理（只看 `index`）⇒ 同一目录判成「现建」"
               "⇒ 负控失效（腿有牙）",
               _mut_pre is False and _new_pre is True,
               f"旧代理={_mut_pre} 新代理={_new_pre}")
        for _p in _ls2.rglob("*"):
            try:
                _p.chmod(_p.stat().st_mode | 0o200)
            except OSError:
                pass
        _ls2.chmod(_ls2.stat().st_mode | 0o200)
        _env2 = {k: v for k, v in os.environ.items() if k != "HANDOFF_SELFTEST_SUB"}
        import subprocess as _sp_ld2
        _r2 = _sp_ld2.run([sys.executable, str(Path(__file__).resolve()), "--store", str(_ls2),
                            "check", "--no-log"], capture_output=True, text=True,
                           timeout=120, env=_env2)
        expect("v5.69.0 封存维·负控：老库删掉 `index` 且被改回可写 ⇒ check 仍报红"
               "（旧形把它当现建 ⇒ 漏判一次）",
               _r2.returncode != 0 and "未封存" in (_r2.stdout + _r2.stderr),
               (_r2.stdout + _r2.stderr)[-200:], dim="sealed")
    # ③ import 后 check 未过 ⇒ **三类原因**分列（纯函数：输入＝check 原文）
    _m_scope = import_check_failure_message(
        "handoff check: FAIL（1 处）\n  - scope 不可解析：scope 登记不可解析：x")
    _m_dang = import_check_failure_message(
        "handoff check: FAIL（1 处）\n  - 文本槽点名了一个没有这个 id 的条目")
    _m_writes = import_check_failure_message(
        "handoff check: FAIL（1 处）\n  - 写事件对账：内容哈希对不上")
    expect("v5.69.0 import 报错·三类原因：命中 scope 不可解析 ⇒ 点名该类并带可执行出路",
           "① scope 不可解析" in _m_scope and "handoff scope rm" in _m_scope,
           _m_scope[-160:])
    expect("v5.69.0 import 报错·三类原因：命中文本悬空 ⇒ 点名该类",
           "② 文本悬空" in _m_dang, _m_dang[-160:])
    expect("v5.69.0 import 报错·三类原因：命中写事件对账 ⇒ 点名该类",
           "③ 写事件重导" in _m_writes, _m_writes[-160:])
    expect("v5.69.0 import 报错·三类原因：一类都没命中 ⇒ 如实说「不属于这三类」（不硬塞）",
           "不属于" in import_check_failure_message(
               "handoff check: FAIL（1 处）\n  - 别的维：x"),
           "未知形状被硬塞进三类")
    expect("v5.69.0 import 报错·变异自证：换输入 ⇒ 消息跟着换类（腿有牙）",
           "① scope 不可解析" not in _m_dang and "② 文本悬空" in _m_dang,
           "消息与输入无关")

    # ---- v5.70.0（t000482）：`--from-file` 的**续行语义写死** ＋ 写面**告警**（不拦）----
    # 病：docstring 写「每行 `字段=值`」＋「值可跨行续写」⇒ 两句连读成「每行都带字段名」，
    # 而实现只认**首行** ⇒ 续行里的 `字段=` 被**原样拼进值里**、**不报错**
    # （本班就这样污染过两份权威件：t000474 的 detail 与 d000167 的正文）。
    # 修：① 三处文档副本（docstring／`FROM_FILE_HELP`／`references/handoff.md`）写死续行语义；
    #     ② 写面**告警**（只定位、不拦——正文举例「detail=…」是合法内容，硬拒会误伤 ⇒
    #        机器消费另须零误报）。
    def _ff_load(payload: str, allowed=None):
        import tempfile as _tf
        _allowed = allowed if allowed is not None else {"summary", "detail", "prio", "domain"}
        with _tf.TemporaryDirectory() as _td:
            _p = Path(_td) / "payload.txt"
            _p.write_text(payload, encoding="utf-8")
            _buf = io.StringIO()
            with _contextlib.redirect_stderr(_buf):
                _vals = load_from_file("edit actions", str(_p), _allowed)
        return _vals, _buf.getvalue()

    _v_ok, _e_ok = _ff_load("detail=第一行\\\n第二行\n")
    expect("v5.70.0 载荷续行·正控：字段名只写首行 ⇒ 落盘值是裸正文、无前缀、无告警",
           _v_ok.get("detail") == "第一行\n第二行" and "⚠" not in _e_ok,
           f"值={_v_ok.get('detail')!r} stderr={_e_ok[-140:]!r}")
    _v_bad, _e_bad = _ff_load("detail=第一行\\\ndetail=第二行\n")
    expect("v5.70.0 载荷续行·现状钉：续行带字段名 ⇒ 落盘值含该字面串（行为被钉住）",
           "detail=第二行" in (_v_bad.get("detail") or ""),
           f"值={_v_bad.get('detail')!r}")
    expect("v5.70.0 载荷续行·告警：写面对「续行带字段名」出声（**不拦**、只提示）",
           "字段名只写首行" in _e_bad and "detail" in _e_bad,
           f"stderr={_e_bad[-160:]!r}")
    _real_ffp = globals().get("from_file_value_field_prefix_lines")
    try:
        globals()["from_file_value_field_prefix_lines"] = lambda v, a: []
        _v_mut, _e_mut = _ff_load("detail=第一行\\\ndetail=第二行\n")
    finally:
        globals()["from_file_value_field_prefix_lines"] = _real_ffp
    expect("v5.70.0 载荷续行·变异自证：换掉定位函数 ⇒ 告警消失（腿有牙）",
           "字段名只写首行" not in _e_mut,
           f"stderr={_e_mut[-160:]!r}")

    # ---- v5.71.0（t000483）：结案不再销毁证据 ＋ 结案可撤销 ----
    # 旧形：`rebase --force` 把带 pre_tamper 的历史事件**真丢弃** ⇒ 输出只能印「这些结论
    # 已不可追回」⇒ 真手改被一并结案时证据**永久消失**（与本 CLI 别处「删除可撤销」的
    # 惯例不一致：`rm` 走 trash ＋ `unvoid --restore`）。
    # 新形：旁证事件**搬进侧档**（`__rebase__` 标记记路径）⇒ `rebase --undo` 能搬回。
    def _seed_tainted(store: Path) -> None:
        """往台账里塞一条带 pre_tamper 的历史事件（＝判据缺陷留下的历史误报）。"""
        _wl = store / "writes.jsonl"
        _evs: list[dict] = []
        if _wl.is_file():
            _evs = [json.loads(_l) for _l in _wl.read_text(encoding="utf-8").splitlines() if _l.strip()]
        _evs.append({"ts": "2020-01-01T00:00:00+08:00", "op": "旧版本判据",
                     "pre_tamper": ["scope"], "removed": [], "prov": PROV_VERSION, "files": {}})
        _wl.write_text("\n".join(json.dumps(_e, ensure_ascii=False) for _e in _evs) + "\n",
                       encoding="utf-8")

    with _leg_store() as _ls7:
        _seed_tainted(_ls7)
        rc7, out7 = run("check", "--no-log")
        expect("v5.71.0 结案·负控：旁证事件在台账里 ⇒ 对账维报出那条历史旁证",
               rc7 != 0 and "已被 CLI 之外改动过" in out7, out7[-200:], dim="writes")
        rc7, out7 = run("rebase", "--force")
        _arch7 = sorted(p.name for p in _ls7.glob("writes-rebased-*.jsonl"))
        expect("v5.71.0 结案·正控：旁证事件**搬进侧档**（没有销毁）＋ 输出给出撤销出路",
               rc7 == 0 and len(_arch7) == 1 and "没有销毁" in out7 and "rebase --undo" in out7,
               f"rc={rc7} 侧档={_arch7} out={out7[-200:]}", dim="writes")
        expect("v5.71.0 结案·知情面：输出写明**第二项后果**（认账全部在册 id 不可撤销）",
               "认账" in out7 and "不回退" in out7, out7[-200:], dim="writes")
        _txt7 = (_ls7 / "writes.jsonl").read_text(encoding="utf-8")
        rc7b, out7b = run("check", "--no-log")
        expect("v5.71.0 结案·正控：台账里已没有那条旁证事件 ⇒ 那条历史旁证不再被报",
               "旧版本判据" not in _txt7 and "已被 CLI 之外改动过" not in out7b,
               f"out={out7b[-200:]}", dim="writes")
        rc7, out7 = run("rebase", "--undo")
        _txt7 = (_ls7 / "writes.jsonl").read_text(encoding="utf-8")
        rc7c, out7c = run("check", "--no-log")
        expect("v5.71.0 撤销·正控：`rebase --undo` 把旁证事件搬回 ⇒ 历史旁证**重新被报出来**",
               rc7 == 0 and "旧版本判据" in _txt7 and "已被 CLI 之外改动过" in out7c,
               f"out7={out7[-160:]} out7c={out7c[-200:]}", dim="writes")
        rc7, out7 = run("rebase", "--undo")
        expect("v5.71.0 撤销·负控：没有可撤销的结案 ⇒ 当场拒并给出可执行出路",
               rc7 != 0 and "没有可撤销的结案" in out7 and "rebase --force" in out7,
               out7[-200:], dim="writes")
    # 变异自证：换回旧形（直接丢弃、不写侧档）⇒ 侧档不存在 ⇒ 正控腿失效（腿有牙）
    with _leg_store() as _ls7m:
        _seed_tainted(_ls7m)
        _real_arch = globals().get("_write_rebased_archive")
        try:
            globals()["_write_rebased_archive"] = lambda st, tainted: ""
            _rc7m, _out7m = run("rebase", "--force")
        finally:
            globals()["_write_rebased_archive"] = _real_arch
        expect("v5.71.0 结案·变异自证：换回旧形（直接丢弃、不写侧档）⇒ 侧档不存在（腿有牙）",
               not list(_ls7m.glob("writes-rebased-*.jsonl"))
               and "rebased_to" not in (_ls7m / "writes.jsonl").read_text(encoding="utf-8"),
               f"侧档={list(_ls7m.glob('writes-rebased-*.jsonl'))}", dim="writes")

    # ---- v5.72.0：exit 班段标题可改（retitle）＋ 坑可消解（resolve） ----
    _rt = tempfile.mkdtemp(prefix="handoff-retitle.")
    run8 = mk_runner(_rt)
    run8("init")
    rc8, out8 = run8("set", "exit", "--file", "-", inp="## 旧标题\n正文第一行\n正文第二行\n")
    expect("v5.72.0 retitle·前置：写一段带标题的 exit", rc8 == 0, out8[-160:])
    _before8 = (Path(_rt) / "exit").read_text(encoding="utf-8")
    rc8, out8 = run8("retitle", "exit", "--at", "1", "--title", "新标题")
    _after8 = (Path(_rt) / "exit").read_text(encoding="utf-8")
    expect("v5.72.0 retitle·正控：只改 ## 行、正文逐字不动",
           rc8 == 0 and _after8.startswith("## 新标题")
           and "正文第一行" in _after8 and "正文第二行" in _after8
           and "旧标题" not in _after8
           and _after8 == _before8.replace("## 旧标题", "## 新标题", 1),
           out8[-160:])
    rc8, out8 = run8("retitle", "exit", "--match", "新标题", "--title", "再改")
    expect("v5.72.0 retitle·match 定位：唯一子串命中即可改",
           rc8 == 0 and "## 再改" in (Path(_rt) / "exit").read_text(encoding="utf-8"), out8[-160:])
    _tf8 = Path(_rt) / "title.txt"
    _tf8.write_text("title=从文件来的\n", encoding="utf-8")
    rc8, out8 = run8("retitle", "exit", "--at", "1", "--from-file", str(_tf8))
    expect("v5.72.0 retitle·from-file：标题可不经 shell 传入",
           rc8 == 0 and "## 从文件来的" in (Path(_rt) / "exit").read_text(encoding="utf-8"), out8[-160:])
    rc8, out8 = run8("retitle", "exit", "--at", "9", "--title", "越界")
    expect("v5.72.0 retitle·负控：--at 越界 ⇒ 拒（不静默改错段）",
           rc8 != 0 and "超出范围" in out8, out8[-160:])
    rc8, out8 = run8("retitle", "exit", "--at", "1", "--match", "从文件来的", "--title", "x")
    expect("v5.72.0 retitle·负控：--at 与 --match 同时给 ⇒ 拒",
           rc8 != 0, out8[-160:])
    rc8, out8 = run8("retitle", "summary", "--at", "1", "--title", "x")
    expect("v5.72.0 retitle·负控：非 exit 槽 ⇒ 拒", rc8 != 0, out8[-160:])

    rc8, out8 = run8("add", "pitfall", "--summary", "待消解的坑", "--domain", "rt")
    expect("v5.72.0 resolve·前置：登记一条坑", rc8 == 0, out8[-120:])
    _pid8 = re.search(r"p\d{6}", out8).group(0)
    rc8, out8 = run8("resolve", _pid8, "--outcome", "根因已治＋守卫在册")
    _closed8 = [json.loads(l) for l in (Path(_rt) / "closed" / "p.jsonl")
                .read_text(encoding="utf-8").splitlines() if l.strip()]
    _live8 = [json.loads(l) for f in (Path(_rt) / "pitfalls").glob("*.jsonl")
              for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
    expect("v5.72.0 resolve·正控：坑移出 live、进 closed/p.jsonl 并留 outcome",
           rc8 == 0 and not any(r["id"] == _pid8 for r in _live8)
           and any(r["id"] == _pid8 and r.get("outcome") == "根因已治＋守卫在册" for r in _closed8),
           out8[-160:])
    rc8, out8 = run8("resolve", _pid8, "--outcome", "重复消解")
    expect("v5.72.0 resolve·负控：已归档的坑再消解 ⇒ 拒（未找到 live 条目）",
           rc8 != 0, out8[-160:])
    rc8, out8 = run8("add", "action", "--summary", "不是坑")
    _tid8 = re.search(r"t\d{6}", out8).group(0)
    rc8, out8 = run8("resolve", _tid8, "--outcome", "错型")
    expect("v5.72.0 resolve·负控：非 p 型条目 ⇒ 拒并指向 close",
           rc8 != 0 and "只消解坑" in out8 and "handoff close" in out8, out8[-160:])
    rc8, out8 = run8("add", "pitfall", "--summary", "无结论的坑", "--domain", "rt")
    _pid8b = re.search(r"p\d{6}", out8).group(0)
    rc8, out8 = run8("resolve", _pid8b)
    expect("v5.72.0 resolve·负控：不给 --outcome ⇒ 拒（销账必须留结论）",
           rc8 != 0 and "--outcome" in out8, out8[-160:])
    shutil.rmtree(_rt, ignore_errors=True)

    return finish()


FROM_FILE_HELP = ("从文件/stdin 读字段（**字段名只写首行** `字段=值`；值可用行尾 \\ 续行，"
                  "该 \\ 是标记、解析时会被剔除，**续行是原样正文**）——内容不经 shell，"
                  "推荐用于长文本/代码片段")


def add_from_file(p) -> None:
    """给一条**会落盘自由文本**的子命令挂 `--from-file`（d000110）。

    为什么这事值得一个函数加一条自检：`require_text` 的反引号告警只能抓「值里还带反引号字面量」，
    而 **已被 shell 展开掉的**值到达 CLI 时已经无反引号可查——它按设计抓不到自己最该抓的那一类。
    所以兜底不能靠「记得用单引号」，只能靠**每条落盘文本入口都有一道不经 shell 的路**（本 CLI 实证：
    p000041 同族第五犯，就是把带反引号的 `close --outcome` 交给双引号，两个标识符凭空蒸发且零报错）。
    """
    p.add_argument("--from-file", metavar="PATH", dest="from_file", default=None,
                   help=FROM_FILE_HELP)


# ── d000110：参数面的自身一致性——「落盘自由文本必须有不经 shell 的入口」──────────
# 为什么这条要钉进代码而不是写进纪律：`require_text` 的反引号告警**按设计抓不到已被 shell
# 展开的值**（值到达时反引号已经没了），所以「记得用单引号」是唯一防线＝没有防线。本仓实证
# 五次（p000041 同族第五犯就是 `close --outcome` 被吞掉两个标识符、零报错、静默入库）。
# 判据输入＝**真实的 parser 树**（落盘证据，不是谁的记性）：新增子命令若收长文本却没挂
# `--from-file`／`--file`，任何一条 `handoff` 命令一跑就当场报错——与 main 分发点上
# 「写前旁证集中取一次」「add flag 面 ⇄ ADD_KINDS 比对」是同一种收口法。
LONG_TEXT_DESTS = {"outcome", "summary", "detail", "body", "title", "ref"}    # 会落盘的自由文本字段
SHELL_FREE_DESTS = {"from_file", "file"}          # 不经 shell 的两种既有形态（--from-file / --file）


def walk_parsers(parser, name: str = "handoff") -> list[tuple[str, set]]:
    """深度走子命令树，产出 (子命令形, 该层可收的 dest 集)。add 的按型子命令也在树里。"""
    out: list[tuple[str, set]] = []
    dests: set = set()
    for act in parser._actions:
        if isinstance(act, argparse._SubParsersAction):
            for sub_name, sub_p in sorted(act.choices.items()):
                out += walk_parsers(sub_p, f"{name} {sub_name}")
        elif act.dest != "help":
            dests.add(act.dest)
    out.append((name, dests))
    return out


def audit_shell_free_inputs(ap=None) -> list[str]:
    """返回违规清单（空＝合）。不判「用户这次有没有用单引号」——那只对单条命令成立；
    这里判的是**这条命令有没有给出不用猜的入口**。"""
    bad: list[str] = []
    for name, dests in walk_parsers(ap or build_parser()):
        text_dests = dests & LONG_TEXT_DESTS
        if text_dests and not (dests & SHELL_FREE_DESTS):
            bad.append(f"{name.strip()}：收 {sorted(text_dests)}（会落盘的自由文本）"
                       f"却没有 --from-file／--file 入口")
    return bad


def build_parser() -> argparse.ArgumentParser:
    """参数面的**唯一构造口**（d000110）。

    为什么单独成函数：`audit_shell_free_inputs` 要拿**真实的 parser** 比「落盘自由文本字段
    是否都有不经 shell 的入口」——那份不变言若靠人读代码维持，就还是 p000016／「靠人记得
    逐个加」那个病（main 的分发点注释里已经记过一次同源）。有了它，parser 树自己就是判据的输入。
    """
    ap = argparse.ArgumentParser(prog="handoff", description="项目交接存储 CLI")
    ap.add_argument("--store", default=".handoff")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("index")
    p = sub.add_parser("compact-writes", help="收窗写事件台账（折叠历史 ＋ 保留最近 N 条；**不改变判定**）")
    p.add_argument("--keep", type=int, default=200, help="保留最近多少条事件（缺省 200）")
    p = sub.add_parser("rebase", help="重建写事件基线（判据误报结案用；--force 确认；--undo 撤销上次结案）")
    p.add_argument("--force", action="store_true", help="确认搬走带旁证的历史事件并认账当前 id 空间")
    p.add_argument("--undo", action="store_true",
                   help="撤销上一次结案：把搬进侧档的旁证事件搬回（结案可撤销）")
    p = sub.add_parser("check")
    p.add_argument("--no-log", action="store_true")
    p.add_argument("--repair", action="store_true",
                   help="按唯一源重装交接块（默认只报不改）——判据不该改使用方的文件")
    p = sub.add_parser("selftest", help="双向夹具：机制闸自证（默认 full；--quick 走核心闭环 ＋ 静态机制闸）")
    _sm = p.add_mutually_exclusive_group()
    _sm.add_argument("--quick", action="store_true",
                     help="核心命令闭环 ＋ 静态机制闸（约 1-2s；全库门禁每轮跑，源指纹变化时升级 full）")
    _sm.add_argument("--full", action="store_true", help="全部腿（默认；显式写只是让调用点自解释）")
    p = sub.add_parser("log"); p.add_argument("--stats", action="store_true"); p.add_argument("--tail", type=int, default=0)
    p = sub.add_parser("init")
    p.add_argument("--force", action="store_true")
    p.add_argument("--with-shim", action="store_true",
                   help="同时装 PATH shim（默认不装——init 不再改全局目录）")

    p = sub.add_parser("add", help="登记条目（参数面按型分列，见 add --help）")
    kinds = p.add_subparsers(dest="kind", required=True, metavar="action|pitfall|command|decision")
    for kind, spec in ADD_KINDS.items():          # 声明与消费同源：flag 面即 ADD_KINDS["fields"]
        kp = kinds.add_parser(kind, help=f"→ {spec['slot']}")
        for fld in spec["fields"]:
            kp.add_argument(f"--{fld}")
        add_from_file(kp)
    for kind, kp in kinds._name_parser_map.items():   # 构建期自检：型加了 flag 却没人消费 → 当场报错
        decl = {x.dest for x in kp._actions if x.dest not in ("help", "from_file")}
        if decl != set(ADD_KINDS[kind]["fields"]):
            die(f"内部不一致：add {kind} flag 面 {sorted(decl)} ≠ ADD_KINDS {sorted(ADD_KINDS[kind]['fields'])}", 2)

    p = sub.add_parser("close"); p.add_argument("id"); p.add_argument("--outcome")
    p.add_argument("--no-refill", action="store_true")
    add_from_file(p)          # d000110：outcome 是本 CLI 最长的自由文本之一，必须有不经 shell 的入口
    p = sub.add_parser("resolve", help="消解一条坑（p 型）：销账归档到 closed/（等价 close --outcome）")
    p.add_argument("id"); p.add_argument("--outcome")
    add_from_file(p)
    p = sub.add_parser("next"); p.add_argument("id", nargs="?"); p.add_argument("--clear", action="store_true"); p.add_argument("--auto", action="store_true")

    p = sub.add_parser("unconfirmed")
    p.add_argument("action", choices=["add", "resolve"])
    p.add_argument("id", nargs="?"); p.add_argument("--ref"); p.add_argument("--summary"); p.add_argument("--detail")
    p.add_argument("--as", dest="as_slot", choices=["action", "pitfall", "decision"]); p.add_argument("--domain")
    p.add_argument("--dismiss", action="store_true"); p.add_argument("--no-refill", action="store_true")
    p.add_argument("--outcome")
    add_from_file(p)          # d000110：同 close——summary/detail/outcome 都落盘

    p = sub.add_parser("set"); p.add_argument("slot"); p.add_argument("--file", default="-")
    p.add_argument("--covers", default=None,
                   help="v5.31.0：声明本次班段**覆盖**的条目 id（逗号分隔）——"
                        "自上一班以来新增的条目必须全部列上；散文只写叙述")
    p.add_argument("--allow-empty", action="store_true"); p.add_argument("--force", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("append", help="v5.0：追加写入口——exit 按班段／summary 按行，旧内容自动搬冷档")
    p.add_argument("slot"); p.add_argument("--file", default="-")
    p.add_argument("--covers", default=None,
                   help="v5.31.0：声明本次班段**覆盖**的条目 id（逗号分隔）——"
                        "自上一班以来新增的条目必须全部列上；散文只写叙述")
    p = sub.add_parser("retitle", help="改 exit 热层某一班段的标题（只动 ## 行；正文逐字不动）")
    p.add_argument("slot", choices=["exit"])
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--at", type=int, help="班段序号（1＝最新，按 view 的 exit 节顺序）")
    g.add_argument("--match", help="按当前标题唯一子串定位（多命中改用 --at）")
    p.add_argument("--title")
    add_from_file(p)
    p = sub.add_parser("compact", help="v5.0：热层裁剪——超出保留额的历史搬进 archive/ 冷档")
    p.add_argument("slot"); p.add_argument("--keep", type=int, default=0)
    p = sub.add_parser("read", help="v5.0：热＋冷按需读（默认只读热层；--tail/--at/--grep 取历史）")
    p.add_argument("slot"); p.add_argument("--tail", type=int, default=0)
    p.add_argument("--at", default=None); p.add_argument("--grep", default=None)
    p.add_argument("--all", action="store_true", dest="all")
    p.add_argument("--derived", action="store_true",
                   help="同时给出**现算**派生视图（队列现态／现态计数；不落盘、与库一致）")
    p = sub.add_parser("seal", help="v5.0：封存存储（全树只读；任意命令跑完自动维持）")
    p = sub.add_parser("unseal", help="v5.0：解锁存储（维护态；本次结束不回封）")
    p = sub.add_parser("install-shim", help="v5.73.1：把 `handoff` 命令装进 ~/.local/bin（解析式：项目副本优先；幂等，不动 PATH/rc）")
    p.add_argument("--dir", help="装到哪（缺省 ~/.local/bin）")
    # 注：`--allow-empty/--force/--dry-run` 原先误挂在 **install-shim** 下（`set` 另有一份）——
    # v5.18.0 修：这三条是**单文件槽覆写**的语义，与装 shim 无关；留着会让 `install-shim
    # --force` 静默吞掉一个它根本不认识的参数。
    p = sub.add_parser("rm"); p.add_argument("id")
    p = sub.add_parser("unvoid", help="v5.1：void 的出口——解除 id 的作废标记（--restore 另把条目搬回原槽）")
    p.add_argument("id")
    p.add_argument("--restore", action="store_true",
                   help="把 .handoff/trash/ 里的那份条目一并恢复回 live 槽")
    p = sub.add_parser("edit"); p.add_argument("id")
    add_from_file(p)
    for f in ("--" + k for k in EDIT_KEYS):        # flag 面＝各槽可承载键的并集（同源，见 editable_fields）
        p.add_argument(f)

    p = sub.add_parser("sync-queue", help="v5.29.0：队列区专用命令——默认剥掉旧库残留的区"
                                          "（queue-legacy 报红的修法）；--print 现算打印队列区（不落盘）")
    p.add_argument("--print", action="store_true", help="现算打印队列区（不落盘）")
    p = sub.add_parser("upgrade-prio", help="d000108／d000111：actions 的旧档位前缀 → prio 字段；pitfall／command 的 → 高危/中危/低危（默认只出计划，--apply 才写）")
    p.add_argument("--apply", action="store_true", help="真的写盘（写前把受影响文件拷进 prev/upgrade-prio/）")

    p = sub.add_parser("decide", help="d000112：裁定件 status 的唯一改写路径（原地改一行，不换 id、不改 created）")
    p.add_argument("id", help="裁定件 id（d000001）")
    p.add_argument("--status", required=True, choices=list(DECISION_STATUSES),
                   help=f"新状态（闭集 {'/'.join(DECISION_STATUSES)}）")
    p.add_argument("--freezes", nargs="+", metavar="TID", default=None,
                   help="t000313：本裁定冻结的 action id（写它们的 blockedBy；与 status 同批落）")

    p = sub.add_parser("scope")
    p.add_argument("action", choices=["list", "add", "remove", "prune", "scan"])
    p.add_argument("path", nargs="?")

    p = sub.add_parser("confirm")
    p.add_argument("--answers"); p.add_argument("--n", type=int, default=5); p.add_argument("--seed", type=int)

    p = sub.add_parser("filter")
    p.add_argument("--id"); p.add_argument("--topic"); p.add_argument("--domain"); p.add_argument("--status"); p.add_argument("--json", action="store_true")

    p = sub.add_parser("view"); p.add_argument("--id"); p.add_argument("--save", action="store_true"); p.add_argument("--out")

    p = sub.add_parser("agents-block",
                       help="AGENTS.md 交接块：--print / --install <仓根> / --check <仓根>")
    p.add_argument("--print", dest="print_only", action="store_true")
    p.add_argument("--install", metavar="REPO", help="写入/更新该仓 AGENTS.md 交接块（块外不动）")
    p.add_argument("--check", metavar="REPO", help="校验该仓交接块与标准源一致（漂移 rc=1）")
    p.add_argument("--profile", choices=("basic", "freshness"), default=None,
                   help="块档位：basic＝通用交接纪律；freshness＝本仓装了新鲜度判据时用。"
                        "**缺省＝按独立证据解析**（库内「装过块」那条记录里记的档位 ⇒ 文件现状 ⇒ basic）："
                        "缺省一律 basic 会让一次不带参数的 --install 把增强档仓静默降级（t000406）")
    p = sub.add_parser("sync-dims", help="把 CHECK_DIMENSIONS 生成的判据清单写回 SKILL.md")
    p.add_argument("--check", action="store_true", help="只验不同步（rc=1），不写")
    p = sub.add_parser("export", help="导出整库清单（JSONL；带库级事实面三段 ⇒ 可原样导回）")
    p.add_argument("--out")
    p = sub.add_parser("import", help="按清单导入（自建骨架＋单一写路径＋校验；导入后 check 不过即中止）")
    p.add_argument("file"); p.add_argument("--force", action="store_true")

    return ap


def main(argv=None) -> int:
    _reject_legacy_form(list(sys.argv[1:] if argv is None else argv))
    ap = build_parser()
    # 参数面自证（d000110）：违规不是「这次侥幸没踩」，是任何命令都拒绝启动——
    # 半途报错的写命令比拒启动难查得多。
    if _bad := audit_shell_free_inputs(ap):
        die("内部不一致（参数面）：" + "；".join(_bad)
            + "　——落盘自由文本必须有不经 shell 的入口，见 add_from_file 的 docstring", 2)

    a = ap.parse_args(argv)
    st = Store(Path(a.store))

    # ---- v5.1 单写者锁：整段「解锁 → 写 → 回封」都在锁内 ----
    # 取锁在 `unseal_store` **之前**：权限位只在持有锁时被动过，别的进程既不会在你的
    # 写途中回封（现象 ①），也不会两个 read-modify-write 同时跑（现象 ②）。
    _lock_fd = acquire_store_lock(st)

    # ---- v5.0 sealed store（t000196①）：写权限只归本 CLI ----
    # 进程开始先记录封存态（check 的 `sealed` 判据吃这个**进门前**的快照）并整体
    # 解锁；命令结束时回封（该库被 `unseal` 点过名才跳过——维护态按存储路径记，见 _STAY_UNSEALED）。
    # chmod 只动权限位不动 mtime，写前旁证对账不受影响。selftest 的递归调用经
    # HANDOFF_SELFTEST_SUB=1 跳过回封（夹具要手工写临时文件）。
    st._was_sealed = store_sealed(st.d)
    # v5.68.0（t000475 · F-I2）：**「进门前这个库在不在」**——封存维吃的是进门前快照，
    # 而 `import` 会在一个（可能刚被 mkdir 的）目录上**现建**这个库 ⇒ 那时「可写」是
    # 必然的初始态、不是任何人 chmod 回来的 ⇒ 本维在那次调用里**没有判别对象**
    # （实测：目标目录已存在 ⇒ import 自带的 check 判「未封存」⇒ import 报失败，
    #  而内容完整落地、导入后零可写位、随后单独跑 check 是绿的）。
    # v5.69.0（t000475·②）：代理信号换成**实物**——旧形只看 `index` 在不在 ⇒ 被删了
    # `index` 的**老库**被当现建 ⇒ 那一瞬间不判封存（漏判）。新形按库里有没有本 CLI
    # 的产物判 ⇒ 老库没了 index 仍是老库；空目录仍算现建（v5.68.0 那条假红不回归）。
    st._store_preexisting = store_preexisting(st.d)
    unseal_store(st.d)
    _sub = os.environ.get("HANDOFF_SELFTEST_SUB") == "1"
    try:
        # 条目写入类命令**不建库**：旧行为下 `add` 会 mkdir 槽目录＋写 index，造出缺单槽的非法半库，
        # 还把 `init`（index 已存在即拒）堵死——一个技能正文里的步骤即可越权建库，且 `check` 当场判非法。
        # 建库只走 init（须用户显式调用）/ import（migrate 流程）；scope 登记先行不受影响（不建 index）。
        if a.cmd in WRITER_CMDS and not (st.d / "index").exists():
            die(f"{a.cmd}: 无交接存储（缺 {st.d}/index）——新项目由用户显式调用 `handoff init`，"
                f"旧模型走 `references/migrate.md`；本命令不建库", 2)

        # **写前旁证快照在这里统一取一次**（幂等，`note_pre_tamper` 每实例只算一次）。
        # 原先靠逐个写命令自己调 ⇒ 漏了 `cmd_scope`/`cmd_unconfirmed` 等就会自误报：
        # `scope add` 改了文件却不记写事件，之后**任何**写命令都把它当成「CLI 之外的改动」
        # （独立审计实测，纯 CLI 即可复现）。逐个加是「靠人记得逐个加」的老毛病——
        # 与 p000016「新增 flag 忘了同步」同源。集中到分发点，零遗漏。
        st.note_pre_tamper()
        rc = {
        "index": lambda: (st.write_index(), print(f"handoff index: ok（生成 {st.d / 'index'}）"), 0)[2],
        "rebase": lambda: cmd_rebase(st, a),
        "compact-writes": lambda: cmd_compact_writes(st, a),
        "init": lambda: cmd_init(st, a),
        "check": lambda: cmd_check(st, a.no_log, getattr(a, "repair", False)),
        "selftest": lambda: cmd_selftest(st, a),
        "log": lambda: cmd_log(st, a),
        "add": lambda: cmd_add(st, a.kind, {**{k: getattr(a, k) for k in
                                              ADD_KINDS[a.kind]["fields"]},
                                             "_from_file": getattr(a, "from_file", None)}),
        "set": lambda: cmd_set(st, a),
        "append": lambda: cmd_append(st, a),
        "retitle": lambda: cmd_retitle(st, a),
        "sync-queue": lambda: cmd_sync_queue(st, a),
        "upgrade-prio": lambda: cmd_upgrade_prio(st, a),
        "decide": lambda: cmd_decide(st, a),
        "compact": lambda: cmd_compact(st, a),
        "read": lambda: cmd_read(st, a),
        "seal": lambda: cmd_seal(st, a),
        "unseal": lambda: cmd_unseal(st, a),
        "install-shim": lambda: cmd_install_shim(st, a),
        "rm": lambda: cmd_rm(st, a),
        "unvoid": lambda: cmd_unvoid(st, a),
        "edit": lambda: cmd_edit(st, a),   # cmd_edit 内部自行合并 --from-file
        "close": lambda: cmd_close(st, a.id, a.outcome, a.no_refill,
                                   getattr(a, "from_file", None)),
        "resolve": lambda: cmd_resolve(st, a),
        "next": lambda: cmd_next(st, a),
        "unconfirmed": lambda: cmd_unconfirmed(st, a),
        "scope": lambda: cmd_scope(st, a),
        "confirm": lambda: cmd_confirm(st, a),
        "filter": lambda: cmd_filter(st, a),
        "view": lambda: cmd_view(st, a),
        "export": lambda: cmd_export(st, a),
        "agents-block": lambda: cmd_agents_block(st, a),
        "sync-dims": lambda: cmd_sync_dims(a.check),
        "import": lambda: cmd_import(st, a),
        }[a.cmd]()
        return rc
    finally:
        if not _sub and str(st.d.resolve()) not in _STAY_UNSEALED:
            seal_store(st.d)
        release_store_lock(_lock_fd)     # 回封在释放**之前**：下一个写者进来时树已封好


if __name__ == "__main__":
    raise SystemExit(main())
