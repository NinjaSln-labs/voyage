// conv 限界上下文 · 对话编排域（C1–C4）领域模型
// 依据：M0-D §1（conv BC）/INV-C3（服务端重分类+置信度）/INV-K4（术语表受管+歧义确认）
//      INV-C1/C2（会话归属+摘要安全保留）/INV-C4 不涉及（聚合在 trust）
// 原则：模型仅辅助，规则表为准（R10）；数据不指令；零外部依赖

'use strict';

// ---------- 常量：执行面动词（服务端强制重分类，INV-C3） ----------
const EXECUTION_VERBS = ['重启', '清理', '删除', '扩容', '缩容', '切换', '终止', '停止', '启动', '执行', '部署', '回滚', '杀掉'];
// 英文执行动词（对抗 Unicode/变体绕过：restart/RESTART 等）
const EXECUTION_VERBS_EN = ['restart', 'clean', 'delete', 'remove', 'stop', 'start', 'deploy', 'rollback', 'kill', 'exec', 'reboot', 'scale'];
// 异体字/同形字归一化表（对抗「重啓」「重啟」等绕过）
const CJK_VARIANT_MAP = { '啓': '启', '啟': '启', '刪': '删', '擴': '扩', '縮': '缩', '徹': '彻', '換': '换', '轉': '转', '執': '执', '迴': '回', '滾': '滚', '殺': '杀', '佈': '部', '術': '术', '語': '语' };

/**
 * 输入归一化（对抗性输入防线）：
 *  - 去除全角/半角空白与制表符（防「重 启」「重\t启」）
 *  - 去除标点（防「重启，然后」干扰匹配）
 *  - 异体字映射（防「重啓」）
 *  - 转小写（英文动词匹配）
 *  - Unicode 空格族/零宽/软连字符移除（严格审计：防「重\u200C启」「重\u00AD启」「重\u2060启」绕过）
 */
const UNICODE_JOINER_SPACE_RE = /[\u200B-\u200F\u2060\u2061\u00AD\u2028\u2029]/g; // 零宽/软连字符/行分隔
const UNICODE_SPACE_FAMILY_RE = /[\u2000-\u200A\u202F\u205F\u3000]/g; // 空格族（EN/EM/THIN/HAIR/IDEOGRAPHIC…）

function normalizeForVerbMatch(text) {
  let s = String(text).toLowerCase();
  s = s.replace(/[\s\u3000\t\n\r\u200B\uFEFF\u00A0]/g, '');  // 空白（含全角空格/零宽/不换行/零宽不换行）
  s = s.replace(UNICODE_JOINER_SPACE_RE, ''); // 零宽连接/软连字符/行分隔（严格审计新增）
  s = s.replace(UNICODE_SPACE_FAMILY_RE, ''); // 空格族（严格审计新增）
  s = s.replace(/[，。！？、；：,.!?;:()（）"'“”‘’\[\]【】]/g, ''); // 标点
  s = s.replace(/[\uFF21-\uFF3A]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)); // 全角大写→半角
  s = s.replace(/[\uFF41-\uFF5A]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)); // 全角小写→半角
  s = [...s].map(ch => CJK_VARIANT_MAP[ch] || ch).join(''); // 异体字归一
  return s;
}

/**
 * 疑问句检测（严格审计修复，第 9/10 波精确化）——在归一化视图上判定（输入已无空格/标点/零宽/全角/异体字）：
 *  - 「么」不作为独立疑问词（那么/多么/怎么/什么 均为非疑问语境，漏「重启么」罕见输入换取不误伤真实执行）
 *  - 「吗」独立语气词判定：动词后跟 吗 且后非「啡」（排除 吗啡）；或句尾 吗/呢 且前面有执行语义
 *  - 明确疑问句式：要不要/是不是/能不能/可不可以/可否/该不该/需不需要/为什么/为何/怎么/了吗/了没/没有
 *  - 安全侧优先：疑问即查询，永不重分类为执行（INV-C3）
 */
function isInterrogative(normalized) {
  if (/(要不要|是不是|能不能|可不可以|可否|该不该|需不需要|为什么|为何|怎么|了吗|了没|没有)/.test(normalized)) return true;
  for (const v of EXECUTION_VERBS) {
    if (new RegExp(v + '吗([^啡]|$)').test(normalized)) return true;
  }
  if (/[吗呢]$/.test(normalized) &&
      /(重启|清理|删除|扩容|缩容|切换|终止|停止|启动|执行|部署|回滚|杀掉|restart|clean|delete|stop|start|deploy|rollback|kill|reboot|scale)/.test(normalized)) return true;
  return false;
}

/**
 * 否定语义检测（第 9/10 波修复）——在归一化视图上判定（don't→dont、do not→donot）：
 *  - 中文否定词表：不要/别/禁止/切勿/请勿/勿/不许/不能/不得/严禁/不想/不愿/不肯/拒绝
 *  - 「不/别」+执行动词（排除 不断/不停/不管 等非否定组合词）
 *  - 英文否定：dont/donot/never/no+动词
 */
function isNegation(normalized) {
  return /不要|别要|千万别|别|禁止|切勿|请勿|勿|不许|不能|不得|严禁|务必不要|不想|不愿|不肯|拒绝/.test(normalized) ||
    /(^|[^断停管])不(重启|清理|删除|扩容|缩容|切换|终止|停止|启动|执行|部署|回滚|杀掉)/.test(normalized) ||
    /(dont|donot|never|no(restart|clean|delete|stop|start|deploy|rollback|kill))/.test(normalized);
}

// （查询面动词清单：若 M3 需要查询伪装辅助判定，从此处扩展——当前执行动词命中为唯一判据，YAGNI 不保留死代码）

// ---------- 值对象 ----------

/** 意图：服务端定稿的可执行语义对象（INV-C3） */
class Intent {
  constructor({ type, confidence, reclassified = false, raw = '', sessionId = null, actor = null }) {
    if (type !== 'query' && type !== 'exec') throw new Error('Intent: type 必须为 query/exec');
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('Intent: confidence 必须为 0~1 的有限数值');
    }
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_INPUT_LENGTH) {
      throw new Error(`Intent: raw 长度非法（须 1~${MAX_INPUT_LENGTH} 字符）`); // G12：直接构造绕过防线
    }
    if (sessionId && (typeof sessionId !== 'string' || sessionId.length > MAX_ID_LENGTH)) {
      throw new Error(`Intent: sessionId 非法（须 1~${MAX_ID_LENGTH} 字符）`); // 第 11 波：防超长
    }
    if (actor && (typeof actor !== 'string' || actor.length > MAX_ID_LENGTH)) {
      throw new Error(`Intent: actor 非法（须 1~${MAX_ID_LENGTH} 字符）`); // 第 40 波：防超长主体标识放大事件
    }
    this.type = type;            // query / exec（服务端重分类后的定稿类型）
    this.confidence = confidence;
    this.reclassified = reclassified; // 是否被服务端从查询重分类为执行（INV-C3）
    this.raw = raw;
    this.sessionId = sessionId;
    this.actor = actor;
  }
  get needsConfirmation() { return this.type === 'exec' && this.confidence < CONFIRMATION_THRESHOLD; }
}

/** 术语条目：受管配置（INV-K4：双人审阅/歧义确认/变更触发评测门禁） */
class TermEntry {
  constructor({ oral, standard, status = 'pending', reviewedBy = null, reviewedAt = null, version = 1 }) {
    if (!['pending', 'approved', 'deprecated'].includes(status)) throw new Error(`TermEntry: status 非法（${status}）`); // K1b 枚举校验
    if (!oral || typeof oral !== 'string' || oral.length === 0 || oral.length > MAX_ID_LENGTH) {
      throw new Error(`TermEntry: oral 必填且限 ${MAX_ID_LENGTH} 字符`); // 第 11 波
    }
    if (['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf'].includes(oral)) {
      throw new Error(`TermEntry: oral 为原型链保留键（${oral}），拒绝（防查找污染）`); // 第 12 波
    }
    if (oral !== oral.trim() || /[\n\r\t]/.test(oral)) {
      throw new Error('TermEntry: oral 不得含首尾空白/换行（防查找错配）'); // 第 43 波
    }
    if (!standard || typeof standard !== 'string' || standard.length === 0 || standard.length > MAX_INPUT_LENGTH) {
      throw new Error(`TermEntry: standard 必填且限 ${MAX_INPUT_LENGTH} 字符`); // 第 11 波
    }
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new Error(`TermEntry: version 必须为正整数（${version}）`); // 第 11 波
    }
    this.oral = oral;
    this.standard = standard;
    this.status = status;      // pending / approved / deprecated
    this.reviewedBy = reviewedBy;
    this.reviewedAt = reviewedAt;
    this.version = version;
  }
}

// ---------- 聚合：会话 ----------

/**
 * 会话聚合：归属单一主体+绑定设备（INV-C1）；摘要保留安全关键信息且不新增授权语义（INV-C2）
 * 压缩产物视为新输入，重新执行意图分类与信任预检（RQ-131）
 */
class Session {
  constructor({ id, actor, deviceBinding, summary = null }) {
    if (!id || typeof id !== 'string') throw new Error('Session: id 必填');
    if (id.length > MAX_ID_LENGTH) throw new Error(`Session: id 超长（${id.length} > ${MAX_ID_LENGTH}）`); // 第 11 波：防超长 ID
    if (!actor || typeof actor !== 'string') throw new Error('Session: actor 必填');      // G11
    if (!deviceBinding || typeof deviceBinding !== 'string') throw new Error('Session: deviceBinding 必填'); // G11
    this.id = id;
    this.actor = actor;
    this.deviceBinding = deviceBinding;   // WebAuthn+设备指纹（INV-C1）
    this._summary = summary;              // 内部摘要（第 27 波封装修复：防外部替换）
    this._turns = 0;                      // 内部轮次（第 27 波：防外部篡改绕过上限）
    this._rotated = false;                // 内部轮换标志（第 27 波）
    this._rotatedAt = null;               // 轮换时间戳（第 53 波）
  }

  /** 只读轮次 */
  get turns() { return this._turns; }
  /** 只读轮换标志 */
  get rotated() { return this._rotated; }

  /** 只读摘要（防外部替换为伪造摘要——C1 修复；rotate 后返回 null） */
  get summary() { return this._summary; }

  recordTurn({ maxTurns = 50 } = {}) {
    if (this._rotated) throw new Error('Session: 已轮换（rotate 为终态），不得再记录轮次'); // 第 10 波：终态拒绝
    if (this._turns >= maxTurns) {
      const err = new Error(`会话轮次达上限（${maxTurns}），须压缩或切换会话`);
      err.code = 'SESSION_TURN_LIMIT';
      throw err; // 触发摘要压缩（RQ-131），防多轮无界增长
    }
    this._turns += 1;
  }

  /**
   * 摘要压缩（RQ-131/INV-C2）：
   *  - 必须保留安全关键信息（trustedGate 预检结论 / grantStatus 审批状态 / highRisk 高危面判定）
   *  - 不新增授权语义：摘要仅记录"发生过"，不承载"现在有效"
   *  - 压缩产物视为新输入：返回需重新预检标记
   */
  compress({ trustedGate, grantStatus, highRisk }) {
    if (this._rotated) throw new Error('Session: 已轮换（rotate 为终态），不得再写入摘要'); // K6 状态机
    this._summary = deepFreeze({
      trustedGate,            // 预检结论（线索，非授权依据）
      grantStatus,            // 审批/Grant 状态（线索）
      highRisk,               // 高危面判定（线索）
      needsRecheck: true,     // 压缩产物必须重新执行意图分类与信任预检（RQ-131）
    });
    this._turns = 0; // 严格审计修复：压缩后轮次计数重置——否则达上限后压缩成功但会话仍无法继续
    return this.summary;
  }

  /** 会话切换：旧上下文不可见、旧 Grant 失效（INV-C1）；rotate 为终态，幂等拒绝二次轮换（第 10 波） */
  rotate(newDeviceBinding) {
    if (this._rotated) throw new Error('Session: 已轮换（rotate 为终态），不可重复轮换');
    this._rotated = true;
    this._rotatedAt = new Date();  // 第 53 波：轮换时间戳（M0-D rotatedAt——审计追溯旧 Grant 失效时刻）
    this.deviceBinding = newDeviceBinding;
    this._summary = null;      // 旧摘要作废（INV-C2：切换后旧上下文不可见）
    return true;
  }

  /** 只读轮换时间戳（M0-D rotatedAt） */
  get rotatedAt() { return this._rotatedAt || null; }
}

// ---------- 服务：意图识别（意图理解端口，供适配器实现模型部分） ----------

/**
 * 意图识别服务：
 *  - 端口 intentModel.interpret(口语) → { type, confidence }（模型仅辅助）
 *  - 服务端强制重分类：执行面动词命中 → type=exec 且 reclassified=true（INV-C3，模型置信仅辅助）
 *  - 置信度 <0.8 的执行类意图 → needsConfirmation（降级确认/审批）
 */
const CONFIRMATION_THRESHOLD = 0.8;
const MAX_INPUT_LENGTH = 4096; // 输入长度上限（输入防护不变量：防洪泛/注入/评测塑形）
const MAX_ID_LENGTH = 256;     // 会话/实体 ID 长度上限（第 11 波：防超长 ID 内存滥用）

class IntentRecognitionService {
  constructor(intentModel, eventBus = null, terminologyService = null) {
    this.model = intentModel; // 端口：{ interpret(text) -> {type, confidence} }
    this.eventBus = eventBus; // 端口：{ publish(event) }（conv→trust/know 事件流）
    this.terminologyService = terminologyService; // R10：执行类意图须经术语翻译后才可进入拆解（第 5 波修复：强制链接）
  }

  recognize(text, { sessionId = null, actor = null } = {}) {
    // 输入防护（严格审计落地）：超长输入一律拒绝，不交模型
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_INPUT_LENGTH) {
      throw new Error(`输入长度非法（须 1~${MAX_INPUT_LENGTH} 字符）`);
    }
    const raw = this.model.interpret(text);           // 模型初判（可被重分类覆盖）
    let type = raw.type;
    let reclassified = false;

    // 归一化匹配（对抗性输入防线：空格/标点/异体字/英文变体绕过）——先算动词命中，供 R10 强制链接判断
    const normalized = normalizeForVerbMatch(text);
    const isExecVerbHit = EXECUTION_VERBS.some(v => normalized.includes(v)) ||
                          EXECUTION_VERBS_EN.some(v => normalized.includes(v));

    // R10 强制链接（严格审计修复）：执行意图识别必须携带术语服务，缺失即拒绝——防适配器忘注入绕过翻译链。
    // 仅在 exec 意图要求（查询面不受术语服务故障阻断，R11 读面语义）；exec 由服务端重分类定稿后才强制。
    if (!this.terminologyService && (raw.type === 'exec' || isExecVerbHit)) {
      throw new Error('recognize: 执行意图必须注入 terminologyService（R10 术语翻译强制链接，缺失拒绝）');
    }

    // 疑问/否定判定统一在归一化视图上做（第 10 波修复）：与动词匹配同一视图，消除双视图不一致——
    // 原实现疑问/否定用原始串，「重\u200C启吗」（零宽+疑问）、「ｄｏｎ'ｔ ｒｅｓｔａｒｔ」（全角英文否定）组合绕过。
    const interrogative = isInterrogative(normalized);
    const negation = isNegation(normalized);

    // 服务端动词重分类（INV-C3）：执行面动词命中且非疑问句且非否定句 → 执行类，模型置信仅辅助
    if (!interrogative && !negation && isExecVerbHit) {
      type = 'exec';
      reclassified = raw.type !== 'exec';
    }
    if (interrogative || negation) type = 'query'; // 疑问/否定一律查询（即使含执行动词，防误伤）

    // R10 强制链接：执行类意图必须完成术语翻译（表为准）后才能进入拆解/后续链
    let terminology = null;
    if (type === 'exec') {
      terminology = this.terminologyService.translate(text);
      // 结构校验（第 9 波修复）：端口返回 undefined/畸形 → 明确领域错误 fail-fast（防原生 TypeError 泄露内部属性名）
      if (!terminology || typeof terminology !== 'object' ||
          typeof terminology.needsConfirm !== 'boolean' ||
          typeof terminology.needsTargetConfirm !== 'boolean') {
        throw new Error('recognize: 术语服务返回结构非法（须 { standard, needsConfirm, needsTargetConfirm }）');
      }
      if (terminology.needsConfirm || terminology.needsTargetConfirm) {
        // 术语/目标歧义：执行意图降级为待确认（不直接进拆解）
        type = 'query';
        reclassified = true;
      }
    }
    const intent = new Intent({
      type,
      confidence: raw.confidence,
      reclassified,
      raw: text,
      sessionId,
      actor,
    });

    // 发布领域事件（conv→trust/know）：trust.evaluate 以 IntentRecognized/Reclassified 为输入
    if (this.eventBus) {
      this.eventBus.publish(reclassified ? new IntentReclassified(intent) : new IntentRecognized(intent));
    }
    return intent;
  }
}

// ---------- 服务：术语翻译（表为准，R10/INV-K4） ----------

/**
 * 术语翻译服务：
 *  - 表为准：口语→标准术语查找 TermEntry（仅 approved 生效）
 *  - 模型仅辅助：未命中表项时模型可建议，但必须经歧义确认流程
 *  - 歧义确认（INV-K4）：多候选目标 → 先确认目标资产再执行
 */
class TerminologyService {
  constructor(termRepo) { this.repo = termRepo; } // 端口：{ findApproved(oral) -> TermEntry|null }

  translate(oral) {
    const entry = this.repo.findApproved(oral);
    if (entry) {
      // 结构校验（完美收官：端口返回必须为有效 TermEntry，fail-fast 防静默 undefined）
      if (typeof entry.standard !== 'string' || entry.standard.length === 0) {
        throw new Error(`术语表条目结构非法：standard 缺失（${String(entry?.standard)}）`);
      }
      // 状态语义（第 21 波修复）：仅 approved 生效——deprecated/pending 条目是「未生效/已废弃」状态，
      // 返回歧义待确认（安全侧降级 query），而非抛「结构非法」异常（原实现让 recognize exec 路径异常传播到调用方崩溃）
      if (entry.status !== 'approved') {
        return { standard: null, source: 'inactive', ambiguous: true, needsConfirm: true, needsTargetConfirm: true };
      }
      // 目标资产歧义（严格审计修复）：术语命中≠目标确定——「清理」表命中「清理日志」但清理哪个资产仍需确认（INV-K4）
      return { standard: entry.standard, source: 'table', ambiguous: false, targetAmbiguous: true, needsTargetConfirm: true };
    }
    // 表未命中：返回歧义待确认（模型建议不直接生效，R10 表为准）
    return { standard: null, source: 'missing', ambiguous: true, needsConfirm: true, needsTargetConfirm: true };
  }
}

// ---------- 领域事件（conv 发布；订阅：trust/exec/know） ----------
// 事件完整性：载荷在构造时冻结为不可变快照（严格审计修复——防跨 BC 篡改，INV-AS2 只持快照语义）

/** 冻结意图载荷为不可变快照（防事件订阅方/调用链污染）；null 拒绝（第 22 波：防原生 TypeError） */
function freezeIntent(intent) {
  if (!intent || typeof intent !== 'object') throw new Error('Intent 事件: intent 必填');
  return Object.freeze({
    type: intent.type,
    confidence: intent.confidence,
    reclassified: intent.reclassified,
    raw: intent.raw,
    sessionId: intent.sessionId,
    actor: intent.actor,
  });
}

/** 深冻结（完美收官：防嵌套对象篡改） */
function deepFreeze(obj) {
  Object.freeze(obj);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return obj;
}

/** 事件 ID 生成（幂等键，严格审计修复：防事件流 at-least-once 重投导致重复消费） */
let eventSeq = 0;
function nextEventId() {
  eventSeq += 1;
  return `${Date.now().toString(36)}-${eventSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class IntentRecognized {
  constructor(intent) {
    this.type = 'IntentRecognized';
    this.schemaVersion = 1;         // 事件协议版本（严格审计修复：跨 BC 演进兼容）
    this.eventId = nextEventId();   // 幂等键：消费者以此去重（RQ-822 幂等投递）
    this.intent = freezeIntent(intent); // 不可变快照
  }
}
class IntentReclassified {
  constructor(intent) {
    this.type = 'IntentReclassified';
    this.schemaVersion = 1;         // 事件协议版本（严格审计修复）
    this.eventId = nextEventId();   // 幂等键
    this.intent = freezeIntent(intent); // 查询伪装→执行类（红蓝 R2-01 防线）
  }
}

/**
 * C2 任务拆解事件（发布 conv→编排层，编排层消费后写审计五元组）
 * 载荷：原始意图 + 子任务摘要（节点数/ID分布/能力分布），不含完整 params
 */
class TaskDecomposed {
  constructor({ intent, task, actor } = {}) {
    if (!intent || !task) throw new Error('TaskDecomposed: intent/task 必填');
    this.type = 'TaskDecomposed';
    this.schemaVersion = 1;
    this.eventId = nextEventId();
    this.actor = actor || null;
    this.intent = Object.freeze({
      actionClass: intent.actionClass || null,
      capability: intent.capability || null,
      target: intent.target || null,
    });
    const nodes = task.nodes || [];
    this.taskSummary = Object.freeze({
      id: task.id,
      nodeCount: nodes.length,
      nodeIds: Object.freeze(nodes.map(n => n.id)),
      capabilities: Object.freeze([...new Set(nodes.map(n => n.capability))]),
      targets: Object.freeze([...new Set(nodes.map(n => n.target))]),
    });
    this.createdAt = task.createdAt ? task.createdAt.toISOString() : new Date().toISOString();
    deepFreeze(this);
  }
}
class SummaryCompressed {
  constructor(sessionId, summary) {
    this.type = 'SummaryCompressed';
    this.schemaVersion = 1;         // 第 52 波：协议对齐（M2 事件唯一缺 schemaVersion）
    this.eventId = nextEventId();   // 幂等键
    this.sessionId = sessionId;
    this.summary = deepFreeze({ ...summary }); // 不可变快照（深冻结，完美收官）
  }
}
class SessionRotated {
  constructor(sessionId) {
    this.type = 'SessionRotated';
    this.schemaVersion = 1;         // 第 52 波：协议对齐
    this.eventId = nextEventId();   // 幂等键
    this.sessionId = sessionId;
  }
}

// ---------- 能力白名单（C2 拆解合法性校验） ----------
const C2_CAPABILITIES = Object.freeze([
  'query_status', 'query_health', 'query_metric', 'query_log',
  'restart', 'clean', 'scale', 'config_change', 'env_switch',
  'egress_send', 'egress_download', 'egress_mail',
]);

const C2_VALID_STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed', 'skipped']);

const C2_STATUS_TRANSITIONS = Object.freeze({
  queued: ['running', 'skipped'],  // skipped 用于依赖失败时跳过下游节点（防死锁）
  running: ['completed', 'failed', 'skipped'],
  completed: [],
  failed: [],
  skipped: [],
});

const TASK_VALID_STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed']);

/**
 * 子任务节点（C2 拆解产物——DAG 中的最小执行单元）
 * 每个节点代表一个原子操作（单目标×单能力）
 * 依赖关系由 dependsOn[] 表达，形成 DAG
 */
class DAGNode {
  constructor({ id, capability, target, params = {}, dependsOn = [], status = 'queued', description = '' } = {}) {
    if (!id || typeof id !== 'string' || id.length > 128) throw new Error('DAGNode: id 必填且 ≤128');
    if (!C2_CAPABILITIES.includes(capability)) throw new Error(`DAGNode: capability 非法（${capability}）`);
    if (!target || typeof target !== 'string' || target.length > 128) throw new Error('DAGNode: target 必填且 ≤128');
    if (params !== null && (typeof params !== 'object' || Array.isArray(params))) throw new Error('DAGNode: params 必须为对象');
    if (!Array.isArray(dependsOn)) throw new Error('DAGNode: dependsOn 必须为数组');
    if (!C2_VALID_STATUSES.includes(status)) throw new Error(`DAGNode: status 非法（${status}）`);
    this._id = id;
    this._capability = capability;
    this._target = target;
    this._params = deepFreeze(Object.assign({}, params));
    this._dependsOn = Object.freeze([...dependsOn]);
    this._status = status;
    this._description = typeof description === 'string' ? description.slice(0, 256) : '';
  }

  get id() { return this._id; }
  get capability() { return this._capability; }
  get target() { return this._target; }
  get params() { return deepFreeze(Object.assign({}, this._params)); }
  get dependsOn() { return [...this._dependsOn]; }
  get status() { return this._status; }
  get description() { return this._description; }

  /** 更新状态（合法流转检查） */
  updateStatus(newStatus) {
    if (!C2_VALID_STATUSES.includes(newStatus)) throw new Error(`DAGNode: status 非法（${newStatus}）`);
    const allowed = C2_STATUS_TRANSITIONS[this._status] || [];
    if (!allowed.includes(newStatus)) return false;
    this._status = newStatus;
    return true;
  }

  /** 只读快照 */
  snapshot() {
    return deepFreeze({
      id: this._id, capability: this._capability, target: this._target,
      params: Object.assign({}, this._params), dependsOn: [...this._dependsOn],
      status: this._status, description: this._description,
    });
  }
}

/**
 * 任务（C2 拆解产物——DAG 子任务集合）
 * 状态：queued → running → completed | failed
 * 节点流转：DAGNode 各自独立，依赖满足后由编排层 getReadyNodes 调度
 */
class Task {
  constructor({ id, nodes = [], status = 'queued', createdAt = new Date() } = {}) {
    if (!id || typeof id !== 'string' || id.length > 128) throw new Error('Task: id 必填且 ≤128');
    if (!TASK_VALID_STATUSES.includes(status)) throw new Error(`Task: status 非法（${status}）`);
    if (typeof createdAt === 'string' || (createdAt instanceof Date && Number.isNaN(createdAt.getTime()))) {
      throw new Error('Task: createdAt 必须为有效 Date 实例');
    }
    this._id = id;
    this._nodes = Object.freeze(nodes.map(n => n instanceof DAGNode ? n : new DAGNode(n)));
    this._status = status;
    this._result = null;
    this._createdAt = createdAt;
  }

  get id() { return this._id; }
  get nodes() { return this._nodes.map(n => new DAGNode(n.snapshot())); }
  get status() { return this._status; }
  get result() { return this._result; }
  get createdAt() { return new Date(this._createdAt.getTime()); }
  get terminal() { return ['completed', 'failed'].includes(this._status); }

  /** 更新整体任务状态（私有——编排层通过 TaskService 间接控制） */
  _updateStatus(newStatus) {
    if (!TASK_VALID_STATUSES.includes(newStatus)) throw new Error(`Task: status 非法（${newStatus}）`);
    if (this.terminal) return false;
    this._status = newStatus;
    return true;
  }

  /** 启动任务（queued → running）；终态返回 false，状态非法抛错（对齐 M4 Job.start） */
  start(now = new Date()) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('Task: start 时间必须为有效 Date');
    if (this.terminal) return false;
    if (this._status !== 'queued') throw new Error(`Task: 当前 ${this._status}，仅 queued 可启动`);
    this._status = 'running';
    return true;
  }

  /** 完成（running → completed）；终态幂等返回 false */
  complete() {
    if (this._status !== 'running') return false;
    this._status = 'completed';
    return true;
  }

  /** 失败（running → failed 或 queued → failed）；终态幂等返回 false */
  fail(reason) {
    if (this.terminal) return false;
    if (this._status === 'completed') return false;
    this._status = 'failed';
    this._result = reason || 'failed';
    return true;
  }

  /**
   * 更新某节点状态（内部访问 _nodes，不经过副本 getter）
   * 由 TaskService.updateNodeStatus 在依赖校验通过后调用
   */
  updateNodeStatus(nodeId, status) {
    const node = this._nodes.find(n => n.id === nodeId);
    if (!node) return { ok: false, reason: 'node_not_found' };
    const r = node.updateStatus(status);
    if (r !== true) return { ok: false, reason: 'invalid_transition' };
    return { ok: true };
  }

  /** 快照 */
  snapshot() {
    return deepFreeze({
      id: this._id,
      nodes: this._nodes.map(n => n.snapshot()),
      status: this._status,
      createdAt: this._createdAt.toISOString(),
    });
  }
}

// ---------- C2 任务拆解服务 ----------

/**
 * 多目标分隔符正则（逗号/中文分隔/空格）
 */
const TARGET_SEPARATORS = /[,，、和与及\s]+/;

/**
 * 任务拆解服务（C2）：
 * 将复杂意图规则化拆解为 DAG 子任务，保证无环。
 * 拆解规则（确定性，非 LLM）：
 * 1. 单目标单能力 → 1 个 DAGNode
 * 2. 多目标 → 每个目标 1 个并行 DAGNode
 * 3. egress 类 → prepare(clean) → send（依赖链）
 * 4. 无法拆解 → 退化为单步
 */
class TaskService {
  constructor({ timeSource = () => new Date(), eventBus = null } = {}) {
    this._timeSource = timeSource;
    this._eventBus = eventBus; // 端口：{ publish(event) }——conv→编排层事件流，编排层消费后写审计
  }

  /**
   * 拆解意图为 DAG 子任务
   * @param {object} intent - { actionClass, capability, target, params, subject }
   * @returns {{ task: Task, nodes: DAGNode[] }}
   */
  decompose(intent = {}) {
    const { actionClass, capability, target = '', params = {}, subject, trustPrechecked } = intent;
    // 前置类型校验：capability 必须为 string（防 `.startsWith` 抛 TypeError）
    if (typeof capability !== 'string') throw new Error('TaskService: capability 必填且为字符串');
    // INV-E1 防御性校验：非 read 类意图必须先过信任预检
    // fail-closed：actionClass 不明确为 'read' 即视为需要预检（含 undefined/null）
    // 信任预检由编排层（M5）在调用 decompose 前完成；领域层做防御性校验确保不绕过
    if (actionClass !== 'read' && trustPrechecked !== true) {
      throw new Error('TaskService: write/egress/authorize 类意图须先过信任预检（INV-E1）');
    }
    const targets = this._resolveTargets(target, subject);
    const nodes = [];

    if (actionClass === 'egress' && capability.startsWith('egress_')) {
      // egress 模式：每个目标生成 prepare(clean) → send 依赖链
      // 注意：clean 是 write 类能力，本身需要 Grant 和审批。当前 decompose 只做拆解，
      // 不签发授权——clean 节点的授权由编排层（M5）在消费 TaskDecomposed 事件后，
      // 经信任预检（INV-E1）和 exec 层 Grant 校验完成。领域层不承载授权逻辑。
      const effectiveTargets = targets.length ? targets : [target || subject || 'unknown'];
      for (const t of effectiveTargets) {
        const prepId = `n-${nodes.length}`;
        nodes.push(new DAGNode({
          id: prepId,
          capability: 'clean',
          target: t,
          params: { path: params.path || '/var/log/' },
          dependsOn: [],
          description: `准备 ${t} 的数据`,
        }));
        nodes.push(new DAGNode({
          id: `n-${nodes.length}`,
          capability,
          target: t,
          params,
          dependsOn: [prepId],
          description: `${capability === 'egress_send' ? '发送' : capability === 'egress_download' ? '下载' : '邮件发送'} ${t} 的数据`,
        }));
      }
    } else if (targets.length > 1) {
      // 多目标并行
      for (const t of targets) {
        nodes.push(new DAGNode({
          id: `n-${nodes.length}`,
          capability,
          target: t,
          params,
          dependsOn: [],
          description: `${capability} ${t}`,
        }));
      }
    } else {
      // 单目标单能力
      const singleTarget = targets[0] || target || subject || 'unknown';
      nodes.push(new DAGNode({
        id: 'n-0',
        capability,
        target: singleTarget,
        params,
        dependsOn: [],
        description: `${capability} ${singleTarget}`,
      }));
    }

    const task = new Task({
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      nodes,
      status: 'queued',
      createdAt: this._timeSource(),
    });

    // 防御性校验：拆解产物必须合法无环（RQ-121 保证无环）
    const validation = this.validate(task);
    if (!validation.ok) throw new Error(`TaskService: decompose 产生非法 DAG（${validation.reason}）`);

    // 发布 TaskDecomposed 事件（编排层消费后写审计五元组）
    this._publish(new TaskDecomposed({ intent, task, actor: intent.actor }));

    return { task, nodes };
  }

  /** 发布事件（总线为空时静默，兼容纯领域调用） */
  _publish(event) { if (this._eventBus) this._eventBus.publish(event); }

  /**
   * 验证 DAG 合法性
   * @returns {{ ok: boolean, reason?: string }}
   */
  validate(task) {
    if (!(task instanceof Task)) return { ok: false, reason: 'not_a_task' };
    const nodes = task.snapshot().nodes;
    if (!nodes.length) return { ok: false, reason: 'no_nodes' };
    const allIds = new Set(nodes.map(n => n.id));
    for (const n of nodes) {
      for (const dep of n.dependsOn) {
        if (!allIds.has(dep)) return { ok: false, reason: `dependsOn ${dep} 不存在` };
      }
    }
    // 环检测：DFS 拓扑排序
    const visited = new Set();
    const inStack = new Set();
    const nodeMap = {};
    for (const n of nodes) nodeMap[n.id] = n;

    function dfs(id) {
      if (inStack.has(id)) return false; // 有环
      if (visited.has(id)) return true;
      visited.add(id);
      inStack.add(id);
      const node = nodeMap[id];
      for (const dep of node.dependsOn) {
        if (!dfs(dep)) return false;
      }
      inStack.delete(id);
      return true;
    }

    for (const n of nodes) {
      if (!dfs(n.id)) return { ok: false, reason: 'cycle_detected' };
    }
    return { ok: true };
  }

  /**
   * 获取可执行的节点（所有依赖已满足、自身为 queued）
   * @returns {DAGNode[]}
   */
  getReadyNodes(task) {
    return task.nodes.filter(n => {
      if (n.status !== 'queued') return false;
      return n.dependsOn.every(depId => {
        const dep = task.nodes.find(d => d.id === depId);
        return dep && dep.status === 'completed';
      });
    });
  }

  /**
   * 校验并更新节点状态
   * 先校验依赖约束，通过后调用 Task.updateNodeStatus 实际更新内部 _nodes 状态
   * @returns {{ ok: boolean, reason?: string }}
   */
  updateNodeStatus(task, nodeId, status) {
    const node = task.nodes.find(n => n.id === nodeId);
    if (!node) return { ok: false, reason: 'node_not_found' };
    if (!C2_VALID_STATUSES.includes(status)) {
      return { ok: false, reason: 'invalid_status' };
    }
    // 检查依赖是否都已满足（仅当从 queued 变为 running/completed 时）
    if ((status === 'running' || status === 'completed') && node.status === 'queued') {
      if (!this._depsSatisfied(task, node)) {
        return { ok: false, reason: 'dependencies_not_satisfied' };
      }
    }
    // 通过校验后，调用 Task.updateNodeStatus 实际更新内部 _nodes 状态
    return task.updateNodeStatus(nodeId, status);
  }

  /**
   * 检查节点所有依赖是否已完成
   * @private
   */
  _depsSatisfied(task, node) {
    return node.dependsOn.every(depId => {
      const dep = task.nodes.find(d => d.id === depId);
      return dep && dep.status === 'completed';
    });
  }

  /**
   * 跳过依赖失败节点的下游——当某节点 failed 时，标记所有直接或间接依赖该节点的
   * queued 节点为 skipped，防止死锁。返回跳过的节点数。
   */
  skipDownstream(task, failedNodeId) {
    const toSkip = new Set();
    // 遍历所有节点，找到依赖链中包含 failedNodeId 的 queued 节点
    function findDownstream(nodeId) {
      for (const n of task.nodes) {
        if (n.status !== 'queued') continue;
        if (n.dependsOn.includes(nodeId) && !toSkip.has(n.id)) {
          toSkip.add(n.id);
          findDownstream(n.id); // 递归查找下游的下游
        }
      }
    }
    findDownstream(failedNodeId);
    for (const id of toSkip) {
      task.updateNodeStatus(id, 'skipped');
    }
    return toSkip.size;
  }

  /**
   * 检查任务是否全部完成
   */
  isTaskDone(task) {
    const terminal = ['completed', 'failed', 'skipped'];
    return task.nodes.every(n => terminal.includes(n.status));
  }

  /**
   * 解析目标列表
   * @private
   */
  _resolveTargets(target, subject) {
    const raw = (target || subject || '').trim();
    if (!raw) return [];
    const parts = raw.split(TARGET_SEPARATORS).map(s => s.trim()).filter(Boolean);
    // 去重
    return [...new Set(parts)];
  }
}

module.exports = {
  EXECUTION_VERBS, CONFIRMATION_THRESHOLD,
  Intent, TermEntry, Session, Task, DAGNode, TaskService,
  IntentRecognitionService, TerminologyService,
  IntentRecognized, IntentReclassified, TaskDecomposed, SummaryCompressed, SessionRotated,
};
