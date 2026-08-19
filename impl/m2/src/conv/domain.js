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
    this.summary = summary;               // 压缩摘要（安全关键信息：预检结论/审批状态/高危面判定）
    this.turns = 0;
    this.rotated = false;
  }

  recordTurn({ maxTurns = 50 } = {}) {
    if (this.rotated) throw new Error('Session: 已轮换（rotate 为终态），不得再记录轮次'); // 第 10 波：终态拒绝
    if (this.turns >= maxTurns) {
      const err = new Error(`会话轮次达上限（${maxTurns}），须压缩或切换会话`);
      err.code = 'SESSION_TURN_LIMIT';
      throw err; // 触发摘要压缩（RQ-131），防多轮无界增长
    }
    this.turns += 1;
  }

  /**
   * 摘要压缩（RQ-131/INV-C2）：
   *  - 必须保留安全关键信息（trustedGate 预检结论 / grantStatus 审批状态 / highRisk 高危面判定）
   *  - 不新增授权语义：摘要仅记录"发生过"，不承载"现在有效"
   *  - 压缩产物视为新输入：返回需重新预检标记
   */
  compress({ trustedGate, grantStatus, highRisk }) {
    if (this.rotated) throw new Error('Session: 已轮换（rotate 为终态），不得再写入摘要'); // K6 状态机
    this.summary = deepFreeze({
      trustedGate,            // 预检结论（线索，非授权依据）
      grantStatus,            // 审批/Grant 状态（线索）
      highRisk,               // 高危面判定（线索）
      needsRecheck: true,     // 压缩产物必须重新执行意图分类与信任预检（RQ-131）
    });
    this.turns = 0; // 严格审计修复：压缩后轮次计数重置——否则达上限后压缩成功但会话仍无法继续
    return this.summary;
  }

  /** 会话切换：旧上下文不可见、旧 Grant 失效（INV-C1）；rotate 为终态，幂等拒绝二次轮换（第 10 波） */
  rotate(newDeviceBinding) {
    if (this.rotated) throw new Error('Session: 已轮换（rotate 为终态），不可重复轮换');
    this.rotated = true;
    this.deviceBinding = newDeviceBinding;
    this.summary = null;       // 旧摘要作废（INV-C2：切换后旧上下文不可见）
    return true;
  }
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
class SummaryCompressed {
  constructor(sessionId, summary) {
    this.type = 'SummaryCompressed';
    this.eventId = nextEventId();   // 幂等键
    this.sessionId = sessionId;
    this.summary = deepFreeze({ ...summary }); // 不可变快照（深冻结，完美收官）
  }
}
class SessionRotated {
  constructor(sessionId) {
    this.type = 'SessionRotated';
    this.eventId = nextEventId();   // 幂等键
    this.sessionId = sessionId;
  }
}

module.exports = {
  EXECUTION_VERBS, CONFIRMATION_THRESHOLD,
  Intent, TermEntry, Session,
  IntentRecognitionService, TerminologyService,
  IntentRecognized, IntentReclassified, SummaryCompressed, SessionRotated,
};
