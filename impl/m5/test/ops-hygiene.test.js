// 运维卫生静态闸（2026-11-22 立项，根治「同类操作坑反复复发」）。
//
// 这几条坑的共同点：**都源于「操作入口不唯一 / 写法不设防」**，写文档挡不住第二次犯。
// 因此把它们变成机器可判的断言：
//   p000005 禁 `source voyage.env`（env 文件含非 export 行，source 静默丢弃变量）；
//   p000006 禁裸 systemd-run（漏 --property=User=ubuntu ⇒ 产物属主错位 → 后续写入 EACCES）；
//   p000065 禁脚本从本机 shell 旧环境变量取凭据（探针必须走 jinteng 注入）；
//   p000060 禁把「脚本」与「值」同走一条 stdin 通道（值通道与脚本通道必须分离）；
//   AGENTS 规则 1 禁凭据明文进仓（长 base64/sk-/coa_ 形态的串）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '../../..');
const SCRIPT_DIR = path.join(__dirname, '../scripts');
const scriptFiles = fs.readdirSync(SCRIPT_DIR).filter((f) => f.endsWith('.js') || f.endsWith('.sh'));
const sources = Object.fromEntries(scriptFiles.map((f) => [f, fs.readFileSync(path.join(SCRIPT_DIR, f), 'utf8')]));

function codeLines(file) {
  return sources[file]
    .split('\n')
    .filter((l) => !/^\s*(\/\/|#)/.test(l))
    .join('\n');
}

test('OPS-1 禁 source voyage.env（p000005：非 export 行被静默丢弃）', () => {
  const offenders = scriptFiles.filter((f) => /(^|\s|;)(source|\.)\s+[^\n]*voyage\.env/.test(codeLines(f)));
  assert.deepStrictEqual(offenders, [], '取值一律用 grep/awk，勿 source env 文件');
});

test('OPS-2 systemd-run 必须带 --property=User（p000006：产物属主错位）', () => {
  for (const f of scriptFiles) {
    const code = codeLines(f);
    if (!code.includes('systemd-run')) continue;
    assert.match(code, /--property=User=/, `${f} 的 systemd-run 缺 --property=User=`);
  }
});

test('OPS-3 凭据只从环境变量读，不从本机旧 shell 变量兜底（p000065）', () => {
  // 允许 process.env.X 读取；禁 `|| <另一个同名变量>` 形态的兜底取旧值。
  const offenders = scriptFiles.filter((f) => /process\.env\.[A-Z_]+\s*\|\|\s*\$\{?[A-Z_]/.test(codeLines(f)));
  assert.deepStrictEqual(offenders, [], '凭据缺失应直接失败，不得回退到另一个同名变量');
});

test('OPS-4 轮换类脚本的值通道与脚本通道必须分离（p000060）', () => {
  const f = 'rotate-provider-key.sh';
  if (!sources[f]) return; // 脚本尚未存在时本条不适用
  const code = codeLines(f);
  assert.match(code, /(ssh|\$\{SSH\[@\]\})[\s\S]*< ["']?\$\{tmp\}["']?/, '值须经独立 stdin 通道送入');
  assert.match(code, /sha256sum/, '须做指纹对拍（c000007 口径）');
});

test('OPS-5 仓内不得出现凭据明文（AGENTS 规则 1）', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(js|sh|md|json|yaml|yml|toml)$/.test(name)) files.push(full);
    }
  };
  walk(path.join(REPO, 'impl'));
  walk(path.join(REPO, 'docs'));
  const keyLike = /(sk-[A-Za-z0-9_\-]{24,}|coa_[0-9a-f]{24,}|Bearer\s+[A-Za-z0-9_\-]{32,})/;
  const offenders = files.filter((f) => keyLike.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(offenders, [], '疑似凭据明文不得进仓');
});

test('OPS-6 探针脚本不得打印凭据（p000065）', () => {
  const f = 'probe-model.js';
  if (!sources[f]) return;
  const code = codeLines(f);
  assert.ok(!/process\.stdout\.write\([^)]*apiKey/.test(code), '探针输出不得包含 key');
  assert.ok(!/console\.log\([^)]*apiKey/.test(code), '探针输出不得包含 key');
  assert.match(code, /process\.env\[args\.keyEnv\]/, 'key 只能从环境变量读');
});
