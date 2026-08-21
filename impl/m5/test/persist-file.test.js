// 文件 JSONL 持久化契约测试（真实部署过渡：auditStoragePort 落地）
// 验证：append-only 追加、启动重建链、写失败 fail-closed（INV-U1）、跨实例持久

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppendOnlyAuditChain, AuditEntry } = require('../src/audit/domain.js');
const { createFilePersist } = require('../src/audit/persist-file.js');

function tmpFile() {
  const p = path.join(os.tmpdir(), `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  return p;
}
function e(over = {}) {
  return new AuditEntry({ who: 'u1', from: 'cli', when: new Date('2026-01-01T00:00:00Z'), action: { intent: 'query', capability: 'query', target: 'svc1', paramsSchemaOk: true }, result: 'success', ...over });
}

test('F1 追加写入：entries 落盘为 JSONL 行（append-only）', () => {
  const file = tmpFile();
  const persist = createFilePersist({ file });
  const chain = new AppendOnlyAuditChain({ persist });
  chain.append(e());
  chain.append(e({ who: 'u2' }));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2, '2 条 entry = 2 行');
  const parsed = lines.map(l => JSON.parse(l));
  assert.strictEqual(parsed[0].seq, 1);
  assert.strictEqual(parsed[1].seq, 2);
  assert.ok(parsed[1].chainHash, '链哈希落盘');
  fs.unlinkSync(file);
});

test('F2 重建：新实例 load() 恢复链且 verify 通过（持久化跨重启）', () => {
  const file = tmpFile();
  const persist1 = createFilePersist({ file });
  const c1 = new AppendOnlyAuditChain({ persist: persist1 });
  c1.append(e());
  c1.append(e({ who: 'u2' }));
  c1.append(e({ who: 'u3' }));
  // 新实例（模拟重启）load 重建
  const persist2 = createFilePersist({ file });
  const c2 = new AppendOnlyAuditChain({ persist: persist2 });
  assert.strictEqual(c2.length, 3, '重建 3 条');
  assert.strictEqual(c2.verify().ok, true, '重建链哈希校验通过');
  assert.strictEqual(c2.tailHash, c1.tailHash, '链尾哈希一致');
  fs.unlinkSync(file);
});

test('F3 增量追加：save 只追加新增行，不重写历史（防覆写面）', () => {
  const file = tmpFile();
  const persist = createFilePersist({ file });
  const chain = new AppendOnlyAuditChain({ persist });
  chain.append(e());
  const lines1 = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines1.length, 1);
  chain.append(e({ who: 'u2' }));
  const lines2 = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines2.length, 2, '只追加一行');
  assert.strictEqual(lines2[0], lines1[0], '第一行未被重写（append-only）');
  fs.unlinkSync(file);
});

test('F4 写失败 → fail-closed（INV-U1：存储错误抛错，不静默）', () => {
  const file = path.join(os.tmpdir(), 'no-such-dir-' + Date.now(), 'audit.jsonl'); // 不存在的目录 → 写失败
  const persist = createFilePersist({ file });
  const chain = new AppendOnlyAuditChain({ persist });
  assert.throws(() => chain.append(e()), /fail-closed|写入失败/, '写失败必须抛错（fail-closed）');
});

test('F5 空文件/不存在 → load 返回 null（空链）', () => {
  const file = tmpFile();
  const persist = createFilePersist({ file });
  const chain = new AppendOnlyAuditChain({ persist });
  assert.strictEqual(chain.length, 0);
  assert.strictEqual(chain.tailHash, null);
  if (fs.existsSync(file)) fs.unlinkSync(file); // 空链可能未创建文件
});