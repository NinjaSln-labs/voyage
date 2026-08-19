// obs 限界上下文 · 观测域（C7）领域模型
// 依据：M0-D DDD 设计 §1（obs BC）/§2.11（INV-O1）/INV-AS2（资产引用）/INV-K2（数据-指令分层）
// 原则：零外部依赖、纯领域逻辑、数据非指令（INV-O1）、密级/敏感级 fail-closed（INV-K1/M3 同构）

'use strict';

// ---------- 指标名契约（G9：健康评估/告警依赖的标准指标名；采集端适配器须映射到标准名） ----------
const METRIC_NAMES = Object.freeze({
  CPU_USAGE: 'cpu_usage',
  DISK_USAGE: 'disk_usage',
  // M1 仅定义健康评估所需最小集；M3+ 扩展（内存/网络/IO 等）走契约扩展
});

// 单条日志 message 长度上限（严格审计：防单条超大日志内存/审计放大；目标值实测校准）
const MAX_LOG_MESSAGE_LENGTH = 64 * 1024; // 64KB
// 实体 ID 长度上限（第 62 波：对齐 M2 MAX_ID_LENGTH——防超长引用内存滥用）
const MAX_ID_LENGTH = 256;

/** 深冻结（严格审计：快照/事件载荷不可变，对齐 M2/M3 基线） */
function deepFreeze(obj) {
  Object.freeze(obj);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return obj;
}

// ---------- 值对象 ----------

/** 资产引用：跨 BC 唯一引用键（INV-AS2：观测只持 ID 与快照，不持执行权） */
class AssetRef {
  constructor(id, name) {
    if (!id || typeof id !== 'string' || id.length === 0) throw new Error('AssetRef: id 必填');
    if (id.length > MAX_ID_LENGTH) throw new Error(`AssetRef: id 超长（${id.length} > ${MAX_ID_LENGTH}）`); // 第 62 波：防超长引用
    if (['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf'].includes(id)) {
      throw new Error(`AssetRef: id 为原型链保留键（${id}），拒绝`); // 第 62 波：对齐 MetricSample name 校验
    }
    this.id = id;
    this.name = name || null;
  }
}

/** 指标样本：只回真实观测（R8/INV-O1），数值 + 单位 + 时间戳 */
class MetricSample {
  constructor(assetId, name, value, unit, at) {
    if (!assetId) throw new Error('MetricSample: assetId 必填');
    if (typeof name !== 'string' || name.length === 0) throw new Error('MetricSample: name 必填（空指标名污染聚合）'); // 严格审计修复
    if (['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf'].includes(name)) {
      throw new Error(`MetricSample: name 为原型链保留键（${name}），拒绝（防快照原型污染）`); // 第 12 波
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('MetricSample: value 必须为有限数值（Infinity/NaN 拒绝）'); // 严格审计：Infinity 污染快照/健康判定
    const d = at instanceof Date ? at : new Date(at ?? Date.now());
    if (Number.isNaN(d.getTime())) throw new Error('MetricSample: 时间戳非法（Invalid Date）'); // 完美收官：非法日期拒绝，防 toISOString 延迟崩溃
    this._assetId = assetId;
    this._name = name;
    this._value = value;
    this._unit = unit || '';
    this._at = d;
  }

  // 只读字段（第 39 波：值对象不可变——防快照字段被外部改写）
  get assetId() { return this._assetId; }
  get name() { return this._name; }
  get value() { return this._value; }
  get unit() { return this._unit; }
  get at() { return this._at; }
}

/** 日志条目：内容为数据、不作为指令源（INV-O1/RQ-312）——数据-指令分层标记 */
class LogEntry {
  constructor(assetId, level, message, at, { source = 'asset', trustLevel = 'sandbox' } = {}) {
    if (!assetId) throw new Error('LogEntry: assetId 必填');
    if (typeof message !== 'string') throw new Error('LogEntry: message 必须为字符串');
    if (message.length > MAX_LOG_MESSAGE_LENGTH) {
      const err = new Error(`LogEntry: message 超长（${message.length} > ${MAX_LOG_MESSAGE_LENGTH}，防洪泛/防审计膨胀）`);
      err.code = 'LOG_MESSAGE_TOO_LONG';
      throw err;
    } // 严格审计：单条日志无长度上限 → 10MB 单条可致内存/审计放大
    if (!['info', 'warn', 'error', 'critical'].includes(level)) throw new Error(`LogEntry: level 非法（${level}）`); // K1a 枚举校验
    if (!['trusted', 'restricted', 'sandbox'].includes(trustLevel)) {
      throw new Error(`LogEntry: trustLevel 非法（${trustLevel}，须 trusted/restricted/sandbox）`); // 第 58 波：可信级枚举（INV-K1 三级）
    }
    const d = at instanceof Date ? at : new Date(at ?? Date.now());
    if (Number.isNaN(d.getTime())) throw new Error('LogEntry: 时间戳非法（Invalid Date）'); // 完美收官：非法日期拒绝
    this.assetId = assetId;
    this.level = level;
    this.message = message;
    this.at = d;
    this.source = source;              // 数据来源：asset（被管机）/ platform（平台自身）
    this._trustLevel = trustLevel;     // 内部可信级（第 39 波：防外部篡改密级提升）
    this.isDataNotInstruction = true;  // 硬标记：日志内容永远是数据，不是指令（INV-O1）
  }

  /** 只读可信级（第 39 波 Critical：sandbox→trusted 密级提升防护） */
  get trustLevel() { return this._trustLevel; }
}

// ---------- 聚合：资产观测状态 ----------

/**
 * 资产观测聚合：一个资产的观测状态（指标快照 + 日志流 + 健康报告）
 * 不变量：
 *  - INV-O1：观测只回真实观测；日志为数据非指令
 *  - INV-AS2：只持资产 ID 与快照，不持执行能力
 *  - INV-K1 同构：密级/敏感级缺失默认最高（fail-closed）
 */
class AssetObservation {
  constructor({ assetRef, securityLabel = null }) {
    this.assetRef = assetRef;
    // 密级/敏感级 fail-closed（INV-K1/M3 同构）：缺失默认最高
    this.securityLabel = securityLabel || 'highest';
    this._metrics = new Map();   // name -> MetricSample[]（内部，第 27 波封装修复）
    this._logs = [];             // LogEntry[]（内部，第 27 波封装修复）
    this.health = 'unknown';    // healthy / degraded / down / unknown
    this.version = 0;           // 事件版本号（INV-AS3 防乱序）
  }

  get id() { return this.assetRef.id; }
  get isSensitive() { return this.securityLabel !== 'public'; }
  /** 只读视图：指标 Map 拷贝（防外部 set 注入伪造观测——第 27 波 B1 修复） */
  get metrics() { return new Map(this._metrics); }
  /** 只读视图：日志数组拷贝（防外部 push 注入——第 27 波 B2 修复） */
  get logs() { return [...this._logs]; }

  /** 记录指标样本（真实观测，R8）；securityLabel 从资产注册处继承；同名指标单位一致性校验（严格审计修复：防语义污染） */
  recordMetric(sample, { maxMetricKinds = 1000, maxSamplesPerMetricName = 10000 } = {}) {
    if (!sample || sample.assetId !== this.id) throw new Error('recordMetric: 样本资产不匹配');
    if (typeof sample.unit !== 'string') throw new Error('recordMetric: 单位必须为字符串'); // G8：unit 类型校验
    const existing = this._metrics.get(sample.name);
    if (existing && existing.length && existing[0].unit !== sample.unit) {
      throw new Error(`recordMetric: 同名指标单位不一致（${sample.name}: ${existing[0].unit} vs ${sample.unit}）`);
    }
    if (!this._metrics.has(sample.name)) {
      // G10：指标种类上限——被管机上报任意指标名 = Map 无限增长内存 DoS
      if (this._metrics.size >= maxMetricKinds) {
        const err = new Error(`指标种类达上限（${maxMetricKinds} 种/资产），拒绝新指标名（防洪泛）`);
        err.code = 'METRIC_KIND_LIMIT';
        throw err;
      }
      this._metrics.set(sample.name, []);
    }
    const arr = this._metrics.get(sample.name);
    // G5：时间乱序防护——新样本时间必须 ≥ 当前最新样本（防旧数据覆盖新数据）
    if (arr.length && sample.at < arr[arr.length - 1].at) {
      throw new Error('recordMetric: 样本时间乱序（旧时间后到），拒绝写入');
    }
    // H4：单指标样本上限——同一指标无限样本 = 数组无限增长内存 DoS（与日志 maxLogs 对称）
    if (arr.length >= maxSamplesPerMetricName) {
      const err = new Error(`指标「${sample.name}」样本数达上限（${maxSamplesPerMetricName} 条），拒绝写入（防洪泛）`);
      err.code = 'METRIC_SAMPLE_LIMIT';
      throw err;
    }
    arr.push(sample);
    this.version += 1;
    return this.version;
  }

  /** 记录日志：永远作为数据（INV-O1 数据-指令分层），trustLevel 传递来源可信级；容量受限防洪泛（INV-U4 背压同构） */
  recordLog(entry, { maxLogs = 10000 } = {}) {
    if (!entry || entry.assetId !== this.id) throw new Error('recordLog: 日志资产不匹配');
    if (this._logs.length >= maxLogs) {
      const err = new Error(`日志容量达上限（${maxLogs} 条/资产），拒绝写入（防洪泛）`);
      err.code = 'LOG_CAPACITY_EXCEEDED';
      throw err;
    }
    // G5：日志同样防乱序（保证事件流时间序，INV-AS3 版本语义）
    if (this._logs.length && entry.at < this._logs[this._logs.length - 1].at) {
      throw new Error('recordLog: 日志时间乱序（旧时间后到），拒绝写入');
    }
    this._logs.push(entry);
    this.version += 1;
    return this.version;
  }

  /** 健康评估：由真实观测推导（R8：不编造）；阈值由外部策略注入（INV-O1 告警阈值可配置）；策略异常视为评估失败→unknown（不编造不崩溃）；
   *  G6：时间窗口——过期指标（超过 freshnessMs）不参与当前健康判定（防用 8 个月前数据判现在） */
  evaluateHealth({ cpuThreshold = 0.9, diskThreshold = 0.9, downIf = (log) => log.level === 'critical', freshnessMs = 5 * 60 * 1000, now = new Date() } = {}) {
    let cpu = null, disk = null;
    try {
      cpu = this.latestMetric(METRIC_NAMES.CPU_USAGE);
      disk = this.latestMetric(METRIC_NAMES.DISK_USAGE);
      const fresh = (m) => m && (now.getTime() - m.at.getTime()) <= freshnessMs;
      if (fresh(cpu) && cpu.value >= cpuThreshold) this.health = 'degraded';
      if (fresh(disk) && disk.value >= diskThreshold) this.health = 'degraded';
      if (this._logs.some(downIf)) this.health = 'down';
      // 严格审计修复（健康状态粘滞）：每次评估从干净态重算，观测恢复后健康须回升
      //  - down 由 downIf 日志主导：无 critical 日志且新鲜指标正常 → 回升 healthy
      //  - degraded 由超阈指标主导：新鲜指标低于阈值 → 回升 healthy
      //  - 无任何新鲜观测 → unknown（不编造健康）
      const anyFresh = fresh(cpu) || fresh(disk);
      if (anyFresh && !this._logs.some(downIf)) {
        const anyHigh = (fresh(cpu) && cpu.value >= cpuThreshold) || (fresh(disk) && disk.value >= diskThreshold);
        this.health = anyHigh ? 'degraded' : 'healthy';
      } else if (!anyFresh && !this._logs.some(downIf)) {
        this.health = 'unknown';
      }
    } catch (err) {
      // 策略（downIf/阈值）异常：评估失败 → unknown（R8 不编造健康状态），由告警通道标记策略异常
      this.health = 'unknown';
      this.lastEvalError = err.message;
    }
    return this.health;
  }

  latestMetric(name) {
    const arr = this._metrics.get(name);
    if (!arr || !arr.length) return null;
    const m = arr[arr.length - 1];
    // 第 27 波：返回冻结快照（读接口不得暴露内部可变引用——防 latest.value=999 篡改污染健康判定）
    return deepFreeze({ assetId: m.assetId, name: m.name, value: m.value, unit: m.unit, at: m.at });
  }

  /** 对外只读快照（观测不暴露执行面，INV-AS2）；includeLogs=true 含日志明细（仅限受限级/trusted）；
   *  H1：指标样本默认截断（maxSamplesPerMetric=100，防大数组全量拷贝性能风险），count 字段保留总数
   *  严格审计：快照深冻结（防消费方/适配器篡改观测数据，对齐 M2/M3 事件载荷冻结基线） */
  snapshot({ includeLogs = false, maxSamplesPerMetric = 100 } = {}) {
    const snap = {
      assetId: this.id,
      securityLabel: this.securityLabel,
      health: this.health,
      metrics: Object.fromEntries([...this._metrics.entries()].map(([k, v]) => [k, {
        count: v.length,
        samples: v.slice(-maxSamplesPerMetric).map(m => ({ value: m.value, unit: m.unit, at: m.at.toISOString() })),
      }])),
      logCount: this._logs.length,
      version: this.version,
    };
    if (includeLogs) {
      // 日志明细按可信级过滤：受限源日志标注 trustLevel（INV-K1 同构）；内容永远为数据（INV-O1）
      snap.logs = this._logs.map(l => ({ level: l.level, message: l.message, at: l.at.toISOString(), source: l.source, trustLevel: l.trustLevel }));
    }
    return deepFreeze(snap);
  }

  /** 按密级过滤后的可读快照（检索级 ACL 同构：低权限角色不可见敏感项，INV-K2）；
   *  trusted/受限角色可见日志明细（M2「查日志」用例），public 仅计数 */
  snapshotFor(requesterLabel = 'public', opts = {}) {
    if (this.isSensitive && requesterLabel !== 'trusted') {
      return deepFreeze({ assetId: this.id, securityLabel: this.securityLabel, denied: true }); // 第 27 波：denied 快照冻结
    }
    return this.snapshot({ includeLogs: requesterLabel !== 'public', ...opts });
  }
}

// ---------- 领域事件（obs 发布；订阅方：conv/exec/metric） ----------
// 事件协议对齐 M2/M3（第 11 波）：schemaVersion + eventId（幂等键）+ 深冻结载荷——跨 BC 订阅方可去重/演进

let obsEventSeq = 0;
function nextObsEventId() {
  obsEventSeq += 1;
  return `${Date.now().toString(36)}-${obsEventSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 指标采集事件 */
class MetricRecorded {
  constructor(sample, version) {
    if (!sample || typeof sample !== 'object') throw new Error('MetricRecorded: sample 必填'); // 第 22 波：防 null 原生 TypeError
    this.type = 'MetricRecorded';
    this.schemaVersion = 1;
    this.eventId = nextObsEventId();
    this.sample = deepFreeze({ assetId: sample.assetId, name: sample.name, value: sample.value, unit: sample.unit, at: sample.at.toISOString() });
    this.version = version;
  }
}
/** 日志采集事件（数据非指令标记随行） */
class LogRecorded {
  constructor(entry, version) {
    if (!entry || typeof entry !== 'object') throw new Error('LogRecorded: entry 必填'); // 第 22 波
    this.type = 'LogRecorded';
    this.schemaVersion = 1;
    this.eventId = nextObsEventId();
    this.entry = deepFreeze({ assetId: entry.assetId, level: entry.level, message: entry.message, at: entry.at.toISOString(), source: entry.source, trustLevel: entry.trustLevel, isDataNotInstruction: true });
    this.version = version;
  }
}
/** 健康变更事件（触发告警通知，INV-N2 关键告警不可静默） */
class HealthChanged {
  constructor(assetId, from, to, version) {
    this.type = 'HealthChanged';
    this.schemaVersion = 1;
    this.eventId = nextObsEventId();
    this.assetId = assetId;
    this.from = from;
    this.to = to;
    this.version = version;
  }
}

// ---------- 仓储接口（依赖倒置：实现由适配器提供，契约测试用内存实现） ----------

/**
 * 资产观测仓储接口（I/O 边界，跨 BC 依赖规则：obs 依赖 asset 的 ID，不反向）
 * 实现方（适配器）须满足：findById / save 幂等、版本号防乱序（INV-AS3）
 */
class AssetObservationRepository {
  async findById(assetId) { throw new Error('未实现：findById'); }
  async save(obs) { throw new Error('未实现：save'); }
}

module.exports = {
  AssetRef, MetricSample, LogEntry, AssetObservation,
  MetricRecorded, LogRecorded, HealthChanged,
  AssetObservationRepository, METRIC_NAMES, MAX_LOG_MESSAGE_LENGTH,
};
