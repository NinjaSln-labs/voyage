// SSH 被管机执行适配器（execAdapterPort 落地）——真实部署过渡，零 npm 依赖（走系统 ssh 二进制）
// 依据：ADAPTER-CONTRACTS.md §2（execAdapterPort：execute(target, template, params) → { ok, result }）
//      RQ-411（无 Agent：SSH 直连，凭据经保险库引用不入模型上下文）
//      RQ-511（参数化调用不 shell 拼接——模板渲染产物整体校验）
//      RQ-512（资产 ID 唯一引用；执行只持 ID 与快照）
// 安全模型：
//  - 远端执行器为固定受控脚本（不含用户数据），经 ssh argv 传入；用户参数经 stdin 传 JSON 载荷
//  - 参数作为远端 subprocess 的独立 argv 元素（无 shell 拼接、无 shlex 拼接面）
//  - 凭据经 keyVaultPort 注入：私钥路径由调用方提供，适配器不落盘不持久化密钥明文
//  - 失败语义对齐契约：connection_failed / timeout / permission_denied / unknown_host / execution_failed
//  - 执行结果结构对齐 ADAPTER-CONTRACTS §2：{ stdout?, stderr?, exitCode?, nodeEffects[] }

'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

/** 简易字符串哈希（模拟目标失败变体种子；非安全用途） */
function hash32(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (Math.imul(31, h) + str.charCodeAt(i)) | 0; }
  return h;
}
const { TEMPLATE_COMMANDS, RESERVED_PROTO_KEYS } = require('../shared-capabilities.js');

// ---------- 命令模板映射：单源在 ../shared-capabilities.js（审计修复 P1-3，消除 JS/Python 双源） ----------
// 远端白名单脚本（REMOTE_EXEC_B64 内嵌 WHITELIST）由本模块从 TEMPLATE_COMMANDS 生成（见下），不再手写第二份

/** 远端执行器脚本（固定受控，不含用户数据；载荷经 stdin 传入 JSON）
 *  以 base64 编码传递（远端 shell 单行解析无引号/空格冲突）
 *  WHITELIST 由 TEMPLATE_COMMANDS 单源生成（审计修复 P1-3：消除 JS/Python 双源漂移） */
const REMOTE_WHITELIST_LINES = Object.entries(TEMPLATE_COMMANDS)
  .map(([tmpl, cmd]) => `  ${JSON.stringify(tmpl)}: ${JSON.stringify(cmd)},`)
  .join('\n');
const REMOTE_EXEC_B64 = Buffer.from([
  'import sys, json, subprocess',
  'try:',
  '    d = json.load(sys.stdin)',
  'except Exception:',
  '    print(json.dumps({"ok": False, "reason": "bad_payload"}), file=sys.stderr); sys.exit(2)',
  'template = d.get("template"); params = d.get("params") or {}',
  'WHITELIST = {',
  REMOTE_WHITELIST_LINES,
  '}',
  'cmd = WHITELIST.get(template)',
  'if not cmd:',
  '    print(json.dumps({"ok": False, "reason": "unsupported_template"}), file=sys.stderr); sys.exit(2)',
  'argv = list(cmd)',
  'if template == "restart_service" and params.get("service"):',
  '    argv.append(str(params["service"]))',
  'if template == "clean_logs" and params.get("path"):',
  '    argv.append(str(params["path"]))',
  'if template == "scale_replicas":',
  '    if params.get("service"): argv.append(str(params["service"]))',
  '    if params.get("replicas"): argv.append("--replicas=" + str(params["replicas"]))',
  'if template == "change_config" and params.get("file") and params.get("expr"):',
  '    argv.append(str(params["file"]))',
  '    argv.append(str(params["expr"]))',
  'if template == "switch_env" and params.get("compose_file"):',
  '    argv.append("-f"); argv.append(str(params["compose_file"]))',
  'try:',
  '    r = subprocess.run(argv, capture_output=True, text=True, timeout=25)',
  '    print(json.dumps({"ok": r.returncode == 0, "stdout": r.stdout, "stderr": r.stderr, "exitCode": r.returncode}))',
  'except subprocess.TimeoutExpired:',
  '    print(json.dumps({"ok": False, "reason": "timeout"}), file=sys.stderr); sys.exit(1)',
  'except FileNotFoundError:',
  '    print(json.dumps({"ok": False, "reason": "command_not_found"}), file=sys.stderr); sys.exit(1)',
].join('\n')).toString('base64');

/** 远端执行 shell 行（base64 解码执行——远端 shell 单行解析，无引号/空格冲突） */
const REMOTE_EXEC_SHELL = `python3 -c "import base64;exec(base64.b64decode('${REMOTE_EXEC_B64}'))"`;

/** 原型链保留键拒绝（质量基调第 12 波：以字符串为键的领域数据一律拒绝） */

/** 参数载荷渲染（结构安全；值仅 string/number/boolean，长度上限；JSON 编码传递）
 *  第 12 波对齐：参数键命中原型链保留键 → 显式拒绝（不静默丢参） */
function renderRemoteCommand(template, params) {
  if (!TEMPLATE_COMMANDS[template]) return { ok: false, reason: 'unsupported_template' };
  const safe = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (RESERVED_PROTO_KEYS.includes(k)) return { ok: false, reason: 'reserved_proto_key', key: k }; // 第 12 波
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      return { ok: false, reason: 'invalid_param_type', key: k };
    }
    if (typeof v === 'string' && v.length > 512) return { ok: false, reason: 'param_too_long', key: k };
    safe[k] = v;
  }
  return { ok: true, remote: JSON.stringify({ template, params: safe }) };
}

/** 生成一次执行会话 ID（审计关联） */
function sessionId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * SSH 执行适配器（execAdapterPort）
 * @param {object} opts
 *  - sshCmd: ssh 二进制路径（默认 'ssh'）
 *  - keyVaultPort: { resolve(target) → { user, host, port, keyPath } | null }——凭据经此注入（RQ-411 保险库）
 *  - connectTimeoutMs: 连接超时（默认 6000）
 *  - commandTimeoutMs: 命令执行超时（默认 30000）
 */
function createSshExecAdapter({ sshCmd = 'ssh', keyVaultPort = null, connectTimeoutMs = 6000, commandTimeoutMs = 30000 } = {}) {
  if (!keyVaultPort || typeof keyVaultPort.resolve !== 'function') {
    throw new Error('createSshExecAdapter: keyVaultPort 必填（{ resolve(target) → { user, host, port, keyPath } }）');
  }
  if (typeof sshCmd !== 'string' || sshCmd.length === 0) throw new Error('createSshExecAdapter: sshCmd 必填');
  // 第 11 波对齐：数值构造参数「正有限+显式类型」校验（NaN → '-o ConnectTimeout=NaN' 静默下发是静默错误源）
  for (const [name, val] of Object.entries({ connectTimeoutMs, commandTimeoutMs })) {
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
      throw new Error(`createSshExecAdapter: ${name} 必须为正有限数值（${val}）`);
    }
  }

  function _classifyFailure(code, stderr, signal) {
    // 失败语义对齐 ADAPTER-CONTRACTS §2：timeout / permission_denied / connection_failed
    if (signal === 'SIGTERM' || signal === 'SIGKILL') return 'timeout';
    if (code === 255) {
      const err = stderr || '';
      if (/Permission denied/i.test(err)) return 'permission_denied';
      if (/Could not resolve hostname|Connection (refused|timed out)|No route to host|Network is unreachable/i.test(err)) return 'connection_failed';
      if (/Host key verification failed/i.test(err)) return 'unknown_host';
      return 'connection_failed';
    }
    if (code === 1) {
      // 远端脚本错误（timeout/command_not_found）
      if (/timeout/i.test(stderr || '')) return 'timeout';
      return 'execution_failed';
    }
    return 'execution_failed';
  }

  /**
   * 执行：execute(target, template, params)
   * @returns Promise<{ ok, result?: { stdout?, stderr?, exitCode?, nodeEffects[], sessionId? }, reason? }>
   */
  function execute(target, template, params) {
    return new Promise((resolve) => {
      if (!target || typeof target !== 'string' || target.length === 0) return resolve({ ok: false, reason: 'invalid_target' });
      if (!TEMPLATE_COMMANDS[template]) return resolve({ ok: false, reason: 'unsupported_template' });

      const rendered = renderRemoteCommand(template, params);
      if (!rendered.ok) return resolve({ ok: false, reason: rendered.reason });

      const conn = keyVaultPort.resolve(target);
      if (!conn || !conn.host || !conn.user) return resolve({ ok: false, reason: 'target_not_resolved' });

      // 模拟目标（keyVault 返回 simulated:true）——合成结果不发起 SSH。
      // 用途：假服务舰队（内测影子/演示）——执行链全真（审批/审计/作业状态机），后果合成。
      // 结果含 deterministic 变体：约 12% 概率模拟失败（execution_failed），为成功率指标提供真实分布样本
      if (conn.simulated === true) {
        const fail = Math.abs(hash32(`${target}:${template}:${Math.floor(Date.now() / 60000)}`)) % 100 < 12;
        const stdout = JSON.stringify({ ok: !fail, template, target, simulated: true });
        return resolve(fail
          ? { ok: false, reason: 'execution_failed' }
          : { ok: true, result: { stdout, stderr: '', exitCode: 0, nodeEffects: [] } });
      }

      if (!conn.keyPath || typeof conn.keyPath !== 'string' || conn.keyPath.length === 0) {
        return resolve({ ok: false, reason: 'no_credential' });
      }

      const sid = sessionId();
      // 非交互 + 禁止密码回退 + 超时；远端脚本经 argv（固定受控），载荷经 stdin（参数不泄漏进程列表）
      const args = [
        '-i', conn.keyPath,
        '-p', String(conn.port || 22),
        '-o', 'BatchMode=yes',                    // 非交互（凭据仅密钥，禁密码回退）
        '-o', 'StrictHostKeyChecking=accept-new', // 首连自动接受（防未知主机交互挂起）
        '-o', 'ConnectTimeout=' + Math.max(1, Math.floor(connectTimeoutMs / 1000)),
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        `${conn.user}@${conn.host}`,
        REMOTE_EXEC_SHELL,
      ];

      const proc = spawn(sshCmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: commandTimeoutMs,
        env: { ...process.env, LC_ALL: 'C' }, // 固定 locale 防解析漂移
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, reason: err.code === 'ENOENT' ? 'ssh_not_available' : 'spawn_failed', message: err.message });
      });
      proc.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          const reason = _classifyFailure(code, stderr, signal);
          return resolve({ ok: false, reason, stderr, exitCode: code });
        }
        // 解析远端结果 JSON（末行）
        const lines = stdout.trim().split('\n');
        let remote = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          try { remote = JSON.parse(lines[i]); break; } catch (e) { /* 跳过非 JSON 行 */ }
        }
        if (!remote || typeof remote !== 'object' || typeof remote.ok !== 'boolean') {
          return resolve({ ok: false, reason: 'malformed_remote_result', stdout });
        }
        if (!remote.ok) {
          return resolve({ ok: false, reason: remote.reason || 'execution_failed', stderr: remote.stderr || stderr, exitCode: remote.exitCode });
        }
        resolve({
          ok: true,
          result: {
            stdout: remote.stdout || '',
            stderr: remote.stderr || '',
            exitCode: remote.exitCode || 0,
            nodeEffects: [{ nodeId: target, status: 'completed', sessionId: sid }],
          },
        });
      });
      // 载荷经 stdin 发送（对齐 RQ-511：参数化调用不 shell 拼接；不经 argv 防泄漏）
      proc.stdin.write(rendered.remote + '\n');
      proc.stdin.end();
    });
  }

  return { execute };
}

/**
 * 内存 fake（契约测试/开发用；与真实适配器同契，不连网络）
 *  - registerResult(target, template, result)
 *  - registerFailure(target, template, reason)
 */
function createSshExecAdapterMemory() {
  const results = new Map();   // `${target}|${template}` → result
  const failures = new Map();  // `${target}|${template}` → reason
  const calls = [];            // 调用记录（审计/测试断言）

  function key(t, tmpl) { return `${t}|${tmpl}`; }

  function execute(target, template, params) {
    return Promise.resolve().then(() => {
      calls.push({ target, template, params: JSON.parse(JSON.stringify(params || {})) });
      if (failures.has(key(target, template))) {
        return { ok: false, reason: failures.get(key(target, template)) };
      }
      const res = results.get(key(target, template));
      if (!res) return { ok: false, reason: 'target_not_resolved' };
      return { ok: true, result: res };
    });
  }

  return {
    execute,
    registerResult(t, tmpl, res) { results.set(key(t, tmpl), res); },
    registerFailure(t, tmpl, reason) { failures.set(key(t, tmpl), reason); },
    calls,
  };
}

module.exports = { createSshExecAdapter, createSshExecAdapterMemory, renderRemoteCommand, TEMPLATE_COMMANDS };
