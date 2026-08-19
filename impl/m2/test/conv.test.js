// conv 对话编排域 契约测试（happy / error / edge）
// 依据：M0-D INV-C3（服务端重分类+置信度）、INV-K4（术语表+歧义）、INV-C1/C2（会话/摘要）、RQ-131（压缩重预检）
// 运行：node --test impl/m2/test/conv.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Intent, TermEntry, Session,
  IntentRecognitionService, TerminologyService, CONFIRMATION_THRESHOLD,
  IntentRecognized, IntentReclassified,
} = require('../src/conv/domain');
const { InMemoryObservationQuery } = require('../src/conv/obs-query');

// ---------- 公共术语服务（严格审计：R10 强制链接后 exec 用例须注入） ----------
const termOk = { translate: () => ({ standard: '重启', ambiguous: false, needsConfirm: false, needsTargetConfirm: false }) };
const termClean = { translate: () => ({ standard: '清理日志', ambiguous: false, needsConfirm: false, needsTargetConfirm: false }) };


// ---------- 服务端重分类（INV-C3）----------

test('H1 执行面动词命中 → 服务端定稿为执行类（模型说查询也被覆盖）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termOk);
  const intent = svc.recognize('帮我重启订单服务', { sessionId: 's1', actor: 'dev' });
  assert.equal(intent.type, 'exec');
  assert.equal(intent.reclassified, true, '查询伪装→执行类（红蓝 R2-01 防线）');
});

test('H2 纯查询不重分类', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.85 }) });
  const intent = svc.recognize('看看订单服务的状态', { sessionId: 's1' });
  assert.equal(intent.type, 'query');
  assert.equal(intent.reclassified, false);
});

test('H3 置信度 <0.8 的执行类意图 → 需确认/审批（不直接执行）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'exec', confidence: 0.6 }) }, null, termOk);
  const intent = svc.recognize('清理一下日志', { sessionId: 's1' });
  assert.equal(intent.type, 'exec');
  assert.equal(intent.needsConfirmation, true, '低置信度降级确认/审批');
  assert.equal(CONFIRMATION_THRESHOLD, 0.8);
});

test('H4 高置信度执行意图直接放行到下一环（still 需 trust 聚合判定）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'exec', confidence: 0.95 }) }, null, termOk);
  const intent = svc.recognize('重启订单服务', { sessionId: 's1' });
  assert.equal(intent.needsConfirmation, false);
});

// ---------- 术语翻译（R10/INV-K4 表为准） ----------

test('H5 表为准：命中的口语映射到标准术语', () => {
  const svc = new TerminologyService({
    findApproved: (oral) => oral === '卡了' ? new TermEntry({ oral: '卡了', standard: '响应延迟', status: 'approved' }) : null,
  });
  const r = svc.translate('卡了');
  assert.equal(r.standard, '响应延迟');
  assert.equal(r.source, 'table');
  assert.equal(r.ambiguous, false);
  assert.equal(r.needsTargetConfirm, true, '术语命中仍需目标资产确认（新契约）');
});

test('E1 表未命中 → 歧义待确认（模型建议不直接生效）', () => {
  const svc = new TerminologyService({ findApproved: () => null });
  const r = svc.translate('帮忙看看咋回事');
  assert.equal(r.ambiguous, true);
  assert.equal(r.needsConfirm, true, '歧义意图先确认再执行（INV-K4）');
});

test('E2 未审阅的术语条目不生效（仅 approved 可翻译）', () => {
  const svc = new TerminologyService({
    findApproved: (oral) => {
      const e = new TermEntry({ oral, standard: '删除全部数据', status: 'pending' }); // 投毒条目仍在 pending
      return e.status === 'approved' ? e : null;
    },
  });
  const r = svc.translate('清理');
  assert.equal(r.standard, null, 'pending 条目不可用，防术语表投毒');
});

// ---------- 会话与摘要（INV-C1/C2/RQ-131） ----------

test('H6 摘要压缩保留安全关键信息且标记需重预检', () => {
  const s = new Session({ id: 's1', actor: 'dev', deviceBinding: 'fp-1' });
  const summary = s.compress({ trustedGate: true, grantStatus: 'granted', highRisk: false });
  assert.equal(summary.trustedGate, true);
  assert.equal(summary.grantStatus, 'granted');
  assert.equal(summary.needsRecheck, true, '压缩产物视为新输入，重新预检（RQ-131）');
});

test('E3 会话切换：旧上下文不可见、旧摘要作废（INV-C1）', () => {
  const s = new Session({ id: 's1', actor: 'dev', deviceBinding: 'fp-1' });
  s.compress({ trustedGate: true, grantStatus: 'granted', highRisk: false });
  s.rotate('fp-2');
  assert.equal(s.rotated, true);
  assert.equal(s.summary, null, '切换后旧上下文不可见');
});

test('G1 摘要仅作线索不新增授权（INV-C2）：needsRecheck 恒真，授权以 trust 存储为准', () => {
  const s = new Session({ id: 's1', actor: 'dev', deviceBinding: 'fp-1' });
  const summary = s.compress({ trustedGate: true, grantStatus: 'granted', highRisk: false });
  assert.equal(summary.needsRecheck, true, '摘要永不承载"现在有效"，必须重算');
});

// ---------- obs 快照查询对接（M2 读 C7，密级 fail-closed） ----------

test('H7 查状态：普通用户可读 public 资产', async () => {
  const port = new InMemoryObservationQuery(new Map([
    ['svc-1', { securityLabel: 'public', metrics: { cpu_usage: [0.45] }, health: 'healthy' }],
  ]));
  const r = await port.query('svc-1', 'public');
  assert.equal(r.denied, false);
  assert.equal(r.health, 'healthy');
});

test('G2 敏感资产：低权限 denied，trusted 可见（INV-K2 密级 fail-closed）', async () => {
  const port = new InMemoryObservationQuery(new Map([
    ['db-1', { securityLabel: 'confidential', metrics: {}, health: 'degraded' }],
  ]));
  assert.equal((await port.query('db-1', 'public')).denied, true);
  assert.equal((await port.query('db-1', 'trusted')).denied, false);
});

test('E4 不存在资产：found=false，不编造观测（R8）', async () => {
  const port = new InMemoryObservationQuery(new Map());
  const r = await port.query('ghost-9', 'public');
  assert.equal(r.found, false);
});

// ---------- 严格审计回归（事件发布 + 动词误伤） ----------

test('S1 服务发布事件：重分类时发布 IntentReclassified，普通时 IntentRecognized', () => {
  const published = [];
  const bus = { publish: (e) => published.push(e) };
  const svc = new IntentRecognitionService(
    { interpret: () => ({ type: 'query', confidence: 0.9 }) }, bus, termOk);
  svc.recognize('帮我重启订单服务', { sessionId: 's1' }); // 重分类
  svc.recognize('看看状态', { sessionId: 's1' });          // 普通
  assert.equal(published[0] instanceof IntentReclassified, true, '查询伪装→执行类发 Reclassified');
  assert.equal(published[1] instanceof IntentRecognized, true);
  assert.equal(published.length, 2, '每个意图都发布事件（conv→trust 事件流）');
});

test('S2 无事件总线时静默（兼容纯领域调用）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) });
  const intent = svc.recognize('看看状态');
  assert.equal(intent.type, 'query');
});

test('S3 「恢复」不误伤纯查询（严格审计修复：从执行动词移除）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.8 }) }, null, termOk);
  for (const t of ['服务恢复了吗', '恢复正常了没有', '帮我看看服务恢复了没']) {
    assert.equal(svc.recognize(t).type, 'query', `「${t}」应为查询`);
  }
  // 真执行恢复动作应显式含执行动词
  assert.equal(svc.recognize('帮我恢复服务（重启）').type, 'exec');
});

test('S4 事件载荷不可变：发布后外部篡改意图不污染事件（严格审计修复）', () => {
  const published = [];
  const bus = { publish: (e) => published.push(e) };
  const svc = new IntentRecognitionService(
    { interpret: () => ({ type: 'query', confidence: 0.9 }) }, bus, termOk);
  const intent = svc.recognize('帮我重启订单服务');
  intent.type = 'query'; // 外部篡改尝试
  intent.confidence = 0.1;
  assert.equal(published[0].intent.type, 'exec', '事件载荷不受外部篡改影响');
  assert.equal(published[0].intent.confidence, 0.9);
  assert.equal(Object.isFrozen(published[0].intent), true, '载荷已冻结');
});

test('S5 输入防护：空串/超长输入拒绝（严格审计落地）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) });
  assert.throws(() => svc.recognize(''), /输入长度非法/);
  assert.throws(() => svc.recognize('x'.repeat(5000)), /输入长度非法/);
  assert.doesNotThrow(() => svc.recognize('看看状态'));
});

test('S6 疑问句不重分类：「启动了吗/重启了吗」为查询（严格审计修复）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.8 }) }, null, termOk);
  for (const t of ['启动了吗', '重启了吗', '服务停止了没有', '部署了吗']) {
    assert.equal(svc.recognize(t).type, 'query', `「${t}」疑问句应为查询`);
  }
  // 明确祈使仍执行
  assert.equal(svc.recognize('帮我启动订单服务').type, 'exec');
});

test('S7 置信度异常值拒绝（NaN/Infinity/越界，严格审计修复）', () => {
  for (const bad of [NaN, Infinity, -0.1, 1.5]) {
    const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: bad }) });
    assert.throws(() => svc.recognize('看看'), /confidence/, `confidence=${bad} 应拒绝`);
  }
});

test('S8 对抗性输入：Unicode/空格/标点/英文变体绕过执行动词检测（完美收官修复）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termOk);
  for (const t of ['重 启', '重\t启', '重啓', '重启，然后删除', 'restart', 'RESTART', '帮我reboot一下', '重新启动']) {
    assert.equal(svc.recognize(t).type, 'exec', `「${t}」应识别为执行类（归一化后动词命中）`);
  }
  // 纯查询仍不误伤
  assert.equal(svc.recognize('看看状态').type, 'query');
  assert.equal(svc.recognize('服务恢复了吗').type, 'query');
});

test('S9 全角/混合字母变体绕过（完美收官修复）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termOk);
  for (const t of ['ｒｅｓｔａｒｔ', 'ＲＥＳＴＡＲＴ', 'RｅSｔＡｒＴ', 'ｄｅｌｅｔｅ']) {
    assert.equal(svc.recognize(t).type, 'exec', `「${t}」全角/混合字母应识别为执行类`);
  }
});

test('S10 会话轮次上限：触发压缩防无界增长（完美收官修复）', () => {
  const s = new Session({ id: 's1', actor: 'dev', deviceBinding: 'fp' });
  for (let i = 0; i < 50; i++) s.recordTurn();
  assert.throws(() => s.recordTurn(), (e) => e.code === 'SESSION_TURN_LIMIT');
});

test('S11 摘要深冻结：嵌套对象不可篡改（完美收官修复）', () => {
  const s = new Session({ id: 's1', actor: 'dev', deviceBinding: 'fp' });
  const summary = s.compress({ trustedGate: { ok: true, level: 1 }, grantStatus: 'granted', highRisk: false });
  assert.throws(() => { summary.trustedGate.ok = false; }, TypeError, '严格模式下写入只读属性抛错');
  assert.equal(s.summary.trustedGate.ok, true, '嵌套对象已冻结');
  assert.equal(Object.isFrozen(s.summary.trustedGate), true);
});

test('S12 术语表端口结构校验：非法条目 fail-fast，未生效条目安全降级（完美收官修复+第21波）', () => {
  const bad = new TerminologyService({ findApproved: () => ({ standard: undefined, status: 'approved' }) });
  assert.throws(() => bad.translate('x'), /结构非法/);
  // 第 21 波：pending/deprecated 是「未生效」状态——返回歧义待确认（安全侧降级），不抛异常
  const pending = new TerminologyService({ findApproved: () => ({ standard: '删除全部数据', status: 'pending' }) });
  const r = pending.translate('清理');
  assert.equal(r.ambiguous, true, 'pending 条目 → 歧义待确认');
  assert.equal(r.needsConfirm, true);
  assert.equal(r.standard, null, 'pending 条目不生效');
  const deprecated = new TerminologyService({ findApproved: () => ({ standard: '响应延迟', status: 'deprecated' }) });
  assert.equal(deprecated.translate('卡了').ambiguous, true, 'deprecated 条目 → 歧义待确认');
});

test('S13 事件幂等键：每个事件有唯一 eventId（严格审计修复：防 at-least-once 重投重复消费）', () => {
  const pub = [];
  const svc = new IntentRecognitionService(
    { interpret: () => ({ type: 'query', confidence: 0.9 }) }, { publish: (e) => pub.push(e) }, termOk);
  svc.recognize('重启服务');
  svc.recognize('看看状态');
  assert.equal(pub.length, 2);
  assert.notEqual(pub[0].eventId, pub[1].eventId, '事件 ID 唯一');
  assert.ok(pub[0].eventId && pub[0].eventId.length > 10, '幂等键存在');
  assert.equal(Object.isFrozen(pub[0]), false, '事件本身可变（eventId 由流系统管理），载荷不可变');
});

test('S14 目标资产歧义确认：术语命中仍需确认目标资产（严格审计修复）', () => {
  const svc = new TerminologyService({
    findApproved: (o) => o === '清理' ? new TermEntry({ oral: o, standard: '清理日志', status: 'approved' }) : null,
  });
  const r = svc.translate('清理');
  assert.equal(r.standard, '清理日志');
  assert.equal(r.needsTargetConfirm, true, '术语命中≠目标确定，须确认目标资产（INV-K4）');
});

test('S15 事件消费去重：同 eventId 重投只消费一次（幂等投递 RQ-822）', () => {
  const pub = [];
  const svc = new IntentRecognitionService(
    { interpret: () => ({ type: 'query', confidence: 0.9 }) }, { publish: (e) => pub.push(e) }, termOk);
  svc.recognize('重启服务');
  const ev = pub[0];
  // 消费者侧幂等（模拟 at-least-once 重投）
  const consumed = new Set();
  function consume(e) {
    if (consumed.has(e.eventId)) return 'dup-skipped';
    consumed.add(e.eventId);
    return `processed-${e.intent.type}`;
  }
  assert.equal(consume(ev), 'processed-exec');
  assert.equal(consume(ev), 'dup-skipped', '重投被幂等键去重');
});

test('S16 事件协议版本字段（严格审计修复：跨 BC 演进兼容）', () => {
  const pub = [];
  const svc = new IntentRecognitionService(
    { interpret: () => ({ type: 'query', confidence: 0.9 }) }, { publish: (e) => pub.push(e) }, termOk);
  svc.recognize('重启服务');
  assert.equal(pub[0].schemaVersion, 1);
  assert.equal(pub[0].intent.type, 'exec');
});

test('S17 否定句不执行为：不要/别/禁止/切勿开头一律查询（第 4 波修复）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termOk);
  for (const t of ['不要重启', '别重启', '千万别清理', '禁止删除', '不要帮我重启', '切勿执行清理', '不许扩容']) {
    assert.equal(svc.recognize(t).type, 'query', `「${t}」否定句应为查询/拒绝语义`);
  }
  // 正常祈使仍执行
  assert.equal(svc.recognize('帮我重启订单服务').type, 'exec');
});

test('S18 会话字段校验：actor/deviceBinding 必填（第 4 波修复）', () => {
  assert.throws(() => new Session({ id: 's1', actor: null, deviceBinding: 'fp' }), /actor 必填/);
  assert.throws(() => new Session({ id: 's1', actor: 'dev', deviceBinding: '' }), /deviceBinding 必填/);
});

test('S19 Intent 直接构造绕过长度校验被拒（第 4 波修复）', () => {
  assert.throws(() => new Intent({ type: 'exec', confidence: 0.9, raw: 'x'.repeat(99999) }), /长度非法/);
});

test('S20 句中否定词拦截（第 5 波修复）：确保不要/注意别/请勿/警告禁止 → 查询', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termOk);
  for (const t of ['请确保不要重启', '注意千万别清理', '警告：禁止删除', '请勿执行清理操作', '严禁删除数据']) {
    assert.equal(svc.recognize(t).type, 'query', `「${t}」句中否定应查询`);
  }
  // 疑问性否定与正常祈使不误伤
  assert.equal(svc.recognize('要不要重启服务').type, 'query');
  assert.equal(svc.recognize('帮我重启服务').type, 'exec');
});

test('S21 requesterLabel 防伪造：非法值拒绝（第 5 波修复，防调用方自称 trusted）', async () => {
  const port = new (require('../src/conv/obs-query')).InMemoryObservationQuery(new Map());
  await assert.rejects(port.query('svc-1', 'superadmin'), /requesterLabel 非法/);
  await assert.rejects(port.query('svc-1', 'trusted '), /requesterLabel 非法/);
});

test('S22 执行意图强制术语翻译：术语/目标歧义 → 降级待确认不直接执行（第 5 波修复 R10）', () => {
  const termSvc = { translate: () => ({ standard: null, ambiguous: true, needsConfirm: true, needsTargetConfirm: true }) };
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termSvc);
  const intent = svc.recognize('清理一下');
  assert.equal(intent.type, 'query', '术语歧义 → 执行降级为待确认');
  assert.equal(intent.reclassified, true);
  // 术语表命中且目标明确 → 保持执行
  const termOk = { translate: () => ({ standard: '清理日志', ambiguous: false, needsConfirm: false, needsTargetConfirm: false }) };
  const svc2 = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termOk);
  assert.equal(svc2.recognize('清理日志').type, 'exec');
});

test('S23 IdentityPort 端口存在且调用方不可自报（第 6 波 K7 修复覆盖）', async () => {
  const { IdentityPort } = require('../src/conv/obs-query');
  const port = new IdentityPort();
  await assert.rejects(port.resolveRequesterLabel('dev', 's1'), /未实现/); // 端口契约：生产实现来自身份 BC
});

// ---------- 严格审计第 7 波回归（Unicode 零宽 / 疑问标点 / R10 强制 / 压缩重置） ----------

test('S24 Unicode 零宽/软连字符/空格族绕过执行动词 → 一律执行类（严格审计修复）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termOk);
  const bypasses = [
    '重\u200B启',        // ZERO WIDTH SPACE
    '重\u200C启',        // ZERO WIDTH NON-JOINER
    '重\u200D启',        // ZERO WIDTH JOINER
    '重\u200E启',        // LEFT-TO-RIGHT MARK
    '重\u200F启',        // RIGHT-TO-LEFT MARK
    '重\u2060启',        // WORD JOINER
    '重\u00AD启',        // SOFT HYPHEN
    '重\u2002启',        // EN SPACE
    '重\u2003启',        // EM SPACE
    '重\u2009启',        // THIN SPACE
    '重\u200A启',        // HAIR SPACE
    '重\u202F启',        // NARROW NO-BREAK SPACE
    '重\u205F启',        // MEDIUM MATHEMATICAL SPACE
    '重\u3000启',        // IDEOGRAPHIC SPACE
  ];
  for (const t of bypasses) {
    assert.equal(svc.recognize(t).type, 'exec', `「${JSON.stringify(t)}」应识别为执行类（归一化移除后动词命中）`);
  }
});

test('S25 疑问句带标点不绕过：「重启吗？」等为查询（严格审计修复：先剥标点再判定）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.8 }) }, null, termOk);
  for (const t of ['重启吗？', '重启吗?', '重启了吗？', '重启吗！！！', '要不要重启？', '重启了吗！！']) {
    assert.equal(svc.recognize(t).type, 'query', `「${t}」疑问句应为查询（含尾部标点）`);
  }
  // 明确祈使仍执行
  assert.equal(svc.recognize('帮我重启订单服务').type, 'exec');
});

test('S26 R10 强制链接：未注入术语服务的 exec 意图被拒绝（严格审计修复）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.99 }) });
  assert.throws(() => svc.recognize('清理日志'), /terminologyService/, 'exec 无术语服务 → 拒绝（防适配器忘注入绕过翻译链）');
  assert.throws(() => svc.recognize('帮我重启服务'), /terminologyService/);
  // 纯查询不受影响（R11 读面语义）
  assert.doesNotThrow(() => svc.recognize('看看状态'));
  assert.equal(svc.recognize('看看状态').type, 'query');
});

test('S27 压缩后 turns 重置：达上限压缩后可继续会话（严格审计修复）', () => {
  const s = new Session({ id: 's1', actor: 'dev', deviceBinding: 'fp' });
  for (let i = 0; i < 50; i++) s.recordTurn();
  assert.throws(() => s.recordTurn(), (e) => e.code === 'SESSION_TURN_LIMIT');
  s.compress({ trustedGate: true, grantStatus: 'granted', highRisk: false });
  assert.equal(s.turns, 0, '压缩后轮次重置');
  assert.doesNotThrow(() => s.recordTurn(), '压缩后可继续会话');
  assert.equal(s.turns, 1);
});

test('S28 疑问词缀绕过闭合：疑问词出现即 query（严格审计第8波：原锚定尾部可被任意字符/词缀绕过）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termOk);
  for (const t of ['重启吗x', '重启吗1', '重启吗a', '重启吗啦', '重启吗。', '重启吗…', '重启了吗？', '重启了没有啊', '重启了没有？', '要不要重启吧']) {
    assert.equal(svc.recognize(t).type, 'query', `「${t}」疑问句应为查询（含尾部字符/词缀）`);
  }
  // 真实祈使不误伤
  for (const t of ['重启服务', '帮我重启服务', '重启服务吧', '重启服务啊', '重启服务！']) {
    assert.equal(svc.recognize(t).type, 'exec', `「${t}」祈使应为执行`);
  }
});

test('S29 否定词面补强：不想/不愿/不肯/拒绝 + 英文否定 → 查询（严格审计第9波）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termOk);
  for (const t of ['不想重启', '不愿重启', '不重启', '拒绝重启', '我不重启服务', '不想删除数据', '不肯执行清理', "don't restart", 'do not restart', 'never restart', "please don't restart the service", 'dont restart']) {
    assert.equal(svc.recognize(t).type, 'query', `「${t}」否定应为查询`);
  }
  // 非否定含不/别 不误伤（不断/不停=执行语义）
  for (const t of ['不断重启服务', '不停重启', '不管怎样重启']) {
    assert.equal(svc.recognize(t).type, 'exec', `「${t}」非否定应执行`);
  }
});

test('S30 疑问词精确化：吗啡/那么/多么 不误伤，疑问词缀仍拦截（严格审计第9波）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termOk);
  // 非疑问含 吗/么 → 执行（吗啡/那么/多么/什么 是组合词）
  for (const t of ['重启吗啡相关', '那么重启服务', '多么重要重启', '什么重启服务']) {
    assert.equal(svc.recognize(t).type, 'exec', `「${t}」非疑问应执行`);
  }
  // 疑问词缀仍拦截
  for (const t of ['重启吗x', '重启吗1', '重启吗啦', '重启吗。', '重启吗！！！', '重启了没有啊', '重启了吗']) {
    assert.equal(svc.recognize(t).type, 'query', `「${t}」疑问应查询`);
  }
  // 真实祈使不误伤
  for (const t of ['帮我重启服务', '重启服务吧', '赶紧重启服务', '重启服务啊']) {
    assert.equal(svc.recognize(t).type, 'exec', `「${t}」祈使应执行`);
  }
});

test('S31 术语服务返回结构非法 → 明确领域错误（严格审计第9波：防原生 TypeError 泄露）', () => {
  const bad = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, { translate: () => undefined });
  assert.throws(() => bad.recognize('清理日志'), /结构非法/, 'undefined 返回 → 领域错误');
  const bad2 = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, { translate: () => ({ standard: 'x' }) });
  assert.throws(() => bad2.recognize('清理日志'), /结构非法/, '缺布尔字段 → 领域错误');
});

test('S32 组合利用链闭合：零宽+疑问/全角英文否定/异体字+否定 全拦截（严格审计第10波：统一归一化视图）', () => {
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termOk);
  const combos = [
    '重\u200C启吗',                // 零宽+疑问
    'ｄｏｎ\u2019ｔ ｒｅｓｔａｒｔ', // 全角英文否定
    '重\u200B启\u200B吗\u200B',     // 零宽+疑问+零宽
    '不要重\u200B启',              // 否定+零宽
    '不想\u200B重\u200D启',        // 否定+双零宽
    'ｄｏｎｔ ｒｅｓｔａｒｔ',      // 英文否定
    '請勿重啓',                    // 异体字+否定
    '不要ｒｅｓｔａｒｔ',          // 否定+全角英文
    '千万别\u200B清理',            // 否定+零宽
  ];
  for (const t of combos) {
    assert.equal(svc.recognize(t).type, 'query', `「${JSON.stringify(t)}」组合攻击应为查询（否定/疑问语义优先）`);
  }
  // 真实祈使+零宽 不误伤
  for (const t of ['重\u200B启服务', '帮我重\u200D启服务', '赶紧清\u200B理日志']) {
    assert.equal(svc.recognize(t).type, 'exec', `「${JSON.stringify(t)}」祈使应执行`);
  }
});

test('S33 Session 终态穷尽：rotate 后 recordTurn/compress/二次 rotate 全拒绝（严格审计第10波）', () => {
  const s = new Session({ id: 's1', actor: 'dev', deviceBinding: 'fp' });
  s.rotate('fp2');
  assert.throws(() => s.recordTurn(), /已轮换/, 'rotate 后不得记录轮次');
  assert.throws(() => s.compress({ trustedGate: true, grantStatus: 'g', highRisk: false }), /已轮换/, 'rotate 后不得写摘要');
  assert.throws(() => s.rotate('fp3'), /不可重复轮换/, 'rotate 幂等拒绝二次轮换');
});

test('S34 Session id 长度上限（严格审计第11波：防超长 ID 内存滥用）', () => {
  assert.throws(() => new Session({ id: 'x'.repeat(100000), actor: 'dev', deviceBinding: 'fp' }), /超长/);
  assert.doesNotThrow(() => new Session({ id: 's1', actor: 'dev', deviceBinding: 'fp' }));
});

test('S35 TermEntry/Intent 字段校验：空/超长/负版本拒绝（严格审计第11波）', () => {
  assert.throws(() => new TermEntry({ oral: '', standard: 'x' }), /oral 必填/);
  assert.throws(() => new TermEntry({ oral: 'x', standard: '' }), /standard 必填/);
  assert.throws(() => new TermEntry({ oral: 'x'.repeat(100000), standard: 'x' }), /oral 必填/);
  assert.throws(() => new TermEntry({ oral: 'x', standard: 'x', version: -1 }), /version 必须为正/);
  assert.throws(() => new TermEntry({ oral: 'x', standard: 'x', version: 1.5 }), /version 必须为正/);
  assert.throws(() => new Intent({ type: 'exec', confidence: 0.9, raw: '重启', sessionId: 'x'.repeat(100000) }), /sessionId/);
  assert.doesNotThrow(() => new TermEntry({ oral: '卡了', standard: '响应延迟' }));
});

test('S36 TermEntry oral 原型链保留键拒绝（严格审计第12波：防查找污染）', () => {
  for (const bad of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.throws(() => new TermEntry({ oral: bad, standard: 'x' }), /原型链保留键/, `「${bad}」应拒绝`);
  }
});

test('S37 未生效术语不崩溃：exec 意图遇 deprecated/pending 术语 → 安全降级 query（第21波：原实现异常传播崩溃）', () => {
  // deprecated 术语：recognize 不应抛异常，应降级 query
  const termDeprecated = { translate: () => ({ standard: null, source: 'inactive', ambiguous: true, needsConfirm: true, needsTargetConfirm: true }) };
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termDeprecated);
  const intent = svc.recognize('清理日志');
  assert.equal(intent.type, 'query', '术语未生效 → 降级 query 不崩溃');
  assert.equal(intent.reclassified, true);
  // pending 同样
  const termPending = { translate: () => ({ standard: null, source: 'inactive', ambiguous: true, needsConfirm: true, needsTargetConfirm: true }) };
  const svc2 = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termPending);
  assert.equal(svc2.recognize('清理日志').type, 'query');
});

test('S38 事件构造 null 防护（严格审计第22波）', () => {
  assert.throws(() => new IntentRecognized(null), /intent 必填/);
});

test('S39 Session 封装修复：summary/turns/rotated 只读，外部不可替换篡改（第27波）', () => {
  const s = new Session({ id: 's1', actor: 'dev', deviceBinding: 'fp' });
  s.compress({ trustedGate: true, grantStatus: 'granted', highRisk: false });
  assert.throws(() => { s.summary = { hacked: true }; }, TypeError, 'summary 不可替换');
  assert.equal(s.summary.needsRecheck, true, '摘要保持原值');
  assert.throws(() => { s.turns = 1000000; }, TypeError, 'turns 不可篡改');
  assert.throws(() => { s.rotated = true; }, TypeError, 'rotated 不可篡改');
});

test('S40 Intent actor 长度校验（第40波：防超长主体标识放大事件/审计）', () => {
  const termOk = { translate: () => ({ standard: '重启', ambiguous: false, needsConfirm: false, needsTargetConfirm: false }) };
  const svc = new IntentRecognitionService({ interpret: () => ({ type: 'query', confidence: 0.9 }) }, null, termOk);
  assert.throws(() => svc.recognize('帮我重启服务', { actor: 'x'.repeat(100000) }), /actor 非法/);
  assert.doesNotThrow(() => svc.recognize('帮我重启服务', { actor: 'dev-1' }));
});

test('S41 TermEntry oral 规范化：首尾空白/换行拒绝（第43波：防查找错配）', () => {
  assert.throws(() => new TermEntry({ oral: ' 卡了 ', standard: 'x' }), /首尾空白/);
  assert.throws(() => new TermEntry({ oral: '卡\n了', standard: 'x' }), /首尾空白/);
  assert.doesNotThrow(() => new TermEntry({ oral: '卡了', standard: '响应延迟' }));
});

test('S42 事件类导出存在性（第52波：覆盖缺口补全）', () => {
  const m = require('../src/conv/domain');
  assert.equal(typeof m.SummaryCompressed, 'function');
  assert.equal(typeof m.SessionRotated, 'function');
  assert.ok(m.EXECUTION_VERBS.includes('重启'));
  const sc = new m.SummaryCompressed('s1', { trustedGate: true });
  assert.equal(sc.schemaVersion, 1);
  assert.ok(sc.eventId);
  const sr = new m.SessionRotated('s1');
  assert.equal(sr.type, 'SessionRotated');
});

test('S43 Session rotatedAt 时间戳（第53波：M0-D 字段对齐，审计追溯轮换时刻）', () => {
  const s = new Session({ id: 's1', actor: 'dev', deviceBinding: 'fp' });
  assert.equal(s.rotatedAt, null, '未轮换时 null');
  s.rotate('fp2');
  assert.ok(s.rotatedAt instanceof Date, '轮换后记录时间戳');
  assert.ok(s.rotatedAt.getTime() <= Date.now(), '时间戳合理');
});
