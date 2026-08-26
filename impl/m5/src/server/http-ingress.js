// HTTP 统一入口（L5 内测形态）：JWT 认证 → 意图编排 → 审批解析 → 运行时执行，全链 JSON API
// 依据：产品0-1计划 §5 L5（统一入口+mTLS+WebAuthn+高危审批+全量审计）；ADAPTER-CONTRACTS §1 authPort
// 边界：
//  - 零依赖 node:http；TLS 终结归反向代理（部署侧），本层只做应用语义
//  - 认证：仅 JWT Bearer（WebAuthn/mTLS 经 authenticateAsync/TLS 层接入为部署扩展点）
//  - actorId 一律取自认证身份，不接受客户端自报（RQ-811 claim 白名单同源原则）
//  - fail-closed：任何异常 → JSON 错误 + 正确状态码，不泄漏内部栈
// 已知硬化待办（recorded）：votes 目前信任请求体投票人清单——生产须逐票验签（WebAuthn）；
//  审批单存内存（进程重启丢失）——持久化归部署侧后续迭代

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const { MAX_INTENT_LENGTH } = require('../integration/domain.js');

const MAX_BODY_BYTES = 64 * 1024;
const MAX_VOTES = 8;
const MAX_PENDING_APPROVALS = 1000;         // 审批单内存上限（防认证用户刷单内存放大）
const PENDING_TTL_MS = 30 * 60 * 1000;      // 与领域审批超时同窗——超时条目懒清扫

function json(res, status, obj) {
  if (res._access) { res._access.status = status; res._access.obj = obj; }
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/** 读请求体（JSON；限长；超限返回 null 并已响应 413——先停读等响应 flush 再断连，审计修复 P2 竞态） */
function readJsonBody(req, res) {
  return new Promise((resolve) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        req.pause();
        req.removeAllListeners('data');
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'payload_too_large' }), () => req.destroy()); // 等 413 flush 完再断
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null);
      } catch (e) {
        json(res, 400, { error: 'malformed_json' });
        resolve(null);
      }
    });
    req.on('error', () => { if (!aborted) resolve(null); });
  });
}

/**
 * HTTP 入口服务工厂
 * @param {object} opts
 *  - app: compose(mode:'real'|'mock') 结果（services/adapters/handleAsync/runJob）
 *  - auth: createAuthAdapter 结果（authenticate 同步契约——JWT/桩 WebAuthn 形态）
 *  - port/host: 监听地址（默认 127.0.0.1:8787——默认只听回环，公网暴露经反代）
 *  - shadowMode: true 时审批解析恒拒（影子运行：观察意图/建单，不执行）——部署侧 VOYAGE_INTENT_ONLY=1 映射
 *  - accessLogFile: 访问日志 JSONL 路径（可选）——影子运行指标数据源：每请求一行
 *    {at, actorId, path, status, kind?, degraded?, latencyMs, approvalId?}（不含 intent 明文防泄漏）
 */
function createHttpIngress({ app, auth, port = 8787, host = '127.0.0.1', shadowMode = false, accessLogFile = null } = {}) {
  if (!app || !app.services || !app.services.integration) throw new Error('createHttpIngress: app 必填（compose 结果）');
  if (!auth || typeof auth.authenticate !== 'function') throw new Error('createHttpIngress: auth 必填（authAdapter）');

  const _pending = new Map(); // approval.id → { approval, params }

  /** 访问日志（JSONL 追加；影子指标数据源——不含 intent 明文，防敏感内容入日志） */
  function accessLog(entry) {
    if (!accessLogFile) return;
    try { fs.appendFileSync(accessLogFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); }
    catch (e) { /* 日志失败不拦请求 */ }
  }

  /** Bearer JWT 认证；失败已写响应并返回 null */
  function requireAuth(req, res) {
    const token = bearerToken(req);
    if (!token) { json(res, 401, { error: 'missing_bearer_token' }); return null; }
    const r = auth.authenticate({ type: 'jwt', token });
    if (!r.ok) { json(res, 401, { error: 'auth_failed', reason: r.reason }); return null; }
    if (res._access) res._access.actorId = r.identity.id;
    return r.identity;
  }

  async function handleIntent(req, res) {
    const identity = requireAuth(req, res);
    if (!identity) return;
    const body = await readJsonBody(req, res);
    if (body === null) return;
    if (typeof body.intent !== 'string' || body.intent.length === 0 || body.intent.length > MAX_INTENT_LENGTH) {
      return json(res, 400, { error: 'invalid_intent' });
    }
    let r;
    try {
      r = await app.handleAsync({ actorId: identity.id, from: 'http', intent: body.intent });
    } catch (e) {
      return json(res, 500, { error: 'orchestration_failed' }); // 不泄漏内部错误细节
    }
    if (r && r.status === 'NEED_REVIEW' && r.approval) {
      // 审计修复（P2）：容量上限 + 懒清扫过期条目——防认证用户刷 NEED_REVIEW 内存放大
      const now = Date.now();
      for (const [k, v] of _pending) {
        if (now - v.createdAt > PENDING_TTL_MS) _pending.delete(k);
      }
      if (_pending.size >= MAX_PENDING_APPROVALS) {
        const oldest = _pending.keys().next().value; // Map 保持插入序：淘汰最旧
        _pending.delete(oldest);
      }
      _pending.set(r.approval.id, { approval: r.approval, params: r.params || {}, operatorId: identity.id, createdAt: now });
    }
    const out = {
      status: r.status, reason: r.reason, kind: r.kind, needApproval: !!r.needApproval,
      intentId: r.intentId, capability: r.capability, confidence: r.confidence,
      degraded: !!r.degraded,
    };
    if (r.status === 'NEED_REVIEW' && r.approval) {
      out.approvalId = r.approval.id;
      out.resolversHint = undefined; // 投票人清单不下发（防枚举）
    }
    return json(res, 200, out);
  }

  async function handleResolve(req, res) {
    const identity = requireAuth(req, res);
    if (!identity) return;
    // 影子运行门禁：观察期只建审批单不执行（部署侧 VOYAGE_INTENT_ONLY=1）
    if (shadowMode) return json(res, 403, { error: 'shadow_mode_resolve_disabled' });
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const entry = _pending.get(body.approvalId);
    if (!entry) return json(res, 404, { error: 'approval_not_found_or_expired' });
    // 审计修复（P1）：解析授权面收紧——仅审批单属主（意图发起人）可提交决定，
    // rejectBy 一律取认证身份（拒绝归因不可伪造）；跨身份解析他人审批单 → 403
    if (identity.id !== entry.operatorId) return json(res, 403, { error: 'not_approval_owner' });
    const votes = Array.isArray(body.votes)
      ? [...new Set(body.votes.filter(v => typeof v === 'string'))] // 去重：重复票在领域层会抛错成 500，这里归一为合法集合
      : [];
    if (votes.length > MAX_VOTES) return json(res, 400, { error: 'too_many_votes' });
    let r;
    try {
      r = app.services.integration.resolveApproval({
        approval: entry.approval,
        votes,
        rejectBy: null,
        now: new Date(),
        actorId: identity.id,
        params: entry.params, // G2 同参单源透传
      });
    } catch (e) {
      return json(res, 500, { error: 'resolve_failed' });
    }
    // 终态移除；ERROR（如 audit_failed）保留条目——可重试语义，TTL 兜底清扫
    if (r.status === 'approved' || r.status === 'REJECTED') _pending.delete(body.approvalId);

    const out = { status: r.status, reason: r.reason, deferred: !!r.deferred };
    // 审计修复（P2）：Outbox deferred 形态下作业未建——不得立即 runJob 误报 execution ERROR
    if (r.status === 'approved' && r.grant && !r.deferred) {
      const jobId = `job-${r.grant.jobRef || r.grant.id}`;
      out.jobId = jobId;
      try {
        const run = await app.runJob({ jobId });
        out.execution = { status: run.status, reason: run.reason };
      } catch (e) {
        out.execution = { status: 'ERROR', reason: 'runner_failed' };
      }
    }
    return json(res, r.status === 'REJECTED' ? 403 : 200, out);
  }

  function handleJob(req, res, id) {
    const identity = requireAuth(req, res);
    if (!identity) return;
    const repo = app.services.exec.jobRepo;
    const job = typeof repo.findById === 'function' ? repo.findById(id) : null;
    if (!job) return json(res, 404, { error: 'job_not_found' });
    // 审计修复（P2）：作业投影属主校验——仅 creator 可查自己发起的作业（fail-closed 最小暴露面）
    if (job.creator !== identity.id) return json(res, 403, { error: 'not_job_owner' });
    return json(res, 200, {
      id: job.id, target: job.target, template: job.template, status: job.status,
      creator: job.creator, grantRef: job.grantRef,
      result: job.result ? { exitCode: job.result.exitCode } : undefined,
      failReason: job.failReason,
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const t0 = Date.now();
    res._access = {};
    Promise.resolve()
      .then(async () => {
        if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true });
        if (req.method === 'POST' && path === '/v1/intent') return handleIntent(req, res);
        if (req.method === 'POST' && path === '/v1/approvals/resolve') return handleResolve(req, res);
        const jobMatch = /^\/v1\/jobs\/(.+)$/.exec(path);
        if (req.method === 'GET' && jobMatch) {
          let id = jobMatch[1];
          try { id = decodeURIComponent(id); } catch (e) { /* 原样使用 */ }
          return handleJob(req, res, id);
        }
        return json(res, 404, { error: 'not_found' });
      })
      .catch(() => {
        if (!res.headersSent) json(res, 500, { error: 'internal_error' });
      })
      .finally(() => {
        if (!accessLogFile || path === '/healthz') return;
        const a = res._access || {};
        accessLog({
          actorId: a.actorId || null,
          path,
          status: a.status || (res.headersSent ? 'unknown' : 500),
          kind: a.obj ? a.obj.kind : undefined,
          degraded: a.obj ? !!a.obj.degraded : undefined,
          hasApproval: a.obj ? !!a.obj.approvalId : undefined,
          latencyMs: Date.now() - t0,
        });
      });
  });

  return {
    /** 启动监听。返回实际端口 */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    /** 观测（运维用；不含审批内容） */
    stats() { return { pendingApprovals: _pending.size }; },
  };
}

module.exports = { createHttpIngress };
