// 身份/资产真实仓储契约测试（真实部署过渡：identityRepoPort/assetRepoPort 落地）
// 验证：JSON 文件持久化（原子覆写/重建）、角色→能力投影（§4.2 矩阵单源）、资产生命周期（单向退役）、
//      fail-closed（写失败抛错/未知资产/停用身份）、命名 schema（拒绝 shell 元字符）、M4 assetPort 语义对齐

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Identity, ROLE_CAPABILITIES, isValidRole, createIdentityRepo, createIdentityRepoMemory } = require('../src/repo/repo-identity.js');
const { Asset, isValidAssetId, createAssetRepo, createAssetRepoMemory } = require('../src/repo/repo-asset.js');

function tmpFile(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
}

// ============ 身份仓储 ============

test('I1 角色→能力投影：角色派生能力（单源 §4.2 矩阵），不可自报', () => {
  const sre = new Identity({ id: 'u-sre', role: 'sre' });
  assert.ok(sre.hasCapability('restart'), 'SRE 可重启');
  assert.ok(sre.hasCapability('approve'), 'SRE 可审批');
  assert.ok(sre.hasCapability('audit_query'), 'SRE 可查审计');
  const dev = new Identity({ id: 'u-dev', role: 'dev' });
  assert.ok(dev.hasCapability('restart'), '研发可重启（自己服务）');
  assert.ok(!dev.hasCapability('approve'), '研发不可审批');
  assert.ok(!dev.hasCapability('audit_query'), '研发不可查全部审计');
  const test = new Identity({ id: 'u-test', role: 'test' });
  assert.ok(test.hasCapability('query_log'), '测试可查日志（相关服务只读）');
  assert.ok(!test.hasCapability('restart'), '测试不可重启');
  const mgr = new Identity({ id: 'u-mgr', role: 'manager' });
  assert.ok(mgr.hasCapability('query_metric'), '管理者可查指标大盘');
  assert.ok(!mgr.hasCapability('restart'), '管理者不可执行');
  assert.ok(!mgr.hasCapability('query_log'), '管理者不可查日志');
});

test('I2 角色合法性：未知角色/伪造角色拒绝（fail-fast，INV-I1）', () => {
  assert.throws(() => new Identity({ id: 'u1', role: 'hacker' }), /角色非法/);
  assert.throws(() => new Identity({ id: 'u1', role: '' }), /角色非法/);
  assert.throws(() => new Identity({ id: 'u1', role: 'admin' }), /角色非法/, 'admin 不在受管角色（§4.2 四角色）');
  assert.strictEqual(isValidRole('sre'), true);
  assert.strictEqual(isValidRole('root'), false);
});

test('I3 停用身份 fail-closed：active=false 不参与任何能力判定（INV-I2 吊销即时生效）', () => {
  const u = new Identity({ id: 'u-off', role: 'sre', active: false });
  assert.ok(!u.hasCapability('restart'), '停用 SRE 不可执行');
  assert.ok(!u.hasCapability('query_status'), '停用 SRE 不可查询');
  const repo = createIdentityRepoMemory([u]);
  assert.deepStrictEqual(repo.findByRole('sre'), [], '按角色查询不含停用身份');
  assert.strictEqual(repo.findById('u-off'), u, 'findById 仍可见（判定侧可见吊销状态）');
});

test('I4 文件持久化：写入 → 重建恢复（原子覆写 + 跨实例持久）', () => {
  const file = tmpFile('ident');
  const repo1 = createIdentityRepo({ file });
  repo1.upsert({ id: 'u1', role: 'sre' });
  repo1.upsert({ id: 'u2', role: 'dev' });
  // 新实例（模拟重启）load 重建
  const repo2 = createIdentityRepo({ file });
  assert.strictEqual(repo2.count(), 2);
  assert.strictEqual(repo2.findById('u1').role, 'sre');
  assert.ok(repo2.findById('u2').hasCapability('restart'));
  fs.unlinkSync(file);
});

test('I5 角色变更即时生效（INV-I2 最迟下轮交互）：upsert 后 findByRole 反映新角色', () => {
  const repo = createIdentityRepoMemory();
  repo.upsert({ id: 'u1', role: 'dev' });
  assert.deepStrictEqual(repo.findByRole('sre'), []);
  repo.upsert({ id: 'u1', role: 'sre' });
  assert.strictEqual(repo.findByRole('sre').length, 1);
  assert.strictEqual(repo.findById('u1').role, 'sre');
});

test('I6 未知角色查询 fail-closed：findByRole 未知角色返回空（不抛错）', () => {
  const repo = createIdentityRepoMemory([new Identity({ id: 'u1', role: 'dev' })]);
  assert.deepStrictEqual(repo.findByRole('root'), []);
});

// ============ 资产仓储 ============

test('A1 命名 schema：拒绝 shell 元字符/编码变体（INV-AS1）', () => {
  assert.strictEqual(isValidAssetId('svc-api-prod-01'), true);
  assert.strictEqual(isValidAssetId('svc.api/1'), false, '斜杠拒绝');
  assert.strictEqual(isValidAssetId('svc;rm'), false, 'shell 元字符拒绝');
  assert.strictEqual(isValidAssetId('svc api'), false, '空格拒绝');
  assert.strictEqual(isValidAssetId(''), false, '空拒绝');
  assert.throws(() => new Asset({ id: 'svc;rm' }), /id 非法/);
});

test('A2 M4 assetPort 语义对齐：isActive 仅 active 为 true，未知/退役 false（fail-closed）', () => {
  const repo = createAssetRepoMemory([new Asset({ id: 'svc-a' })]);
  assert.strictEqual(repo.isActive('svc-a'), true);
  assert.strictEqual(repo.isActive('svc-unknown'), false, '未知资产 false（fail-closed）');
  repo.retire('svc-a', new Date('2026-01-01T00:00:00Z'));
  assert.strictEqual(repo.isActive('svc-a'), false, '退役后 false');
});

test('A3 退役生命周期单向：retired 后不可回退；retiredAt 记录时间', () => {
  const repo = createAssetRepoMemory();
  repo.upsert({ id: 'svc-a' });
  const now = new Date('2026-01-01T00:00:00Z');
  const r1 = repo.retire('svc-a', now);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.asset.status, 'retired');
  assert.strictEqual(r1.asset.retiredAt.toISOString(), '2026-01-01T00:00:00.000Z');
  // 幂等：已退役再次退役
  const r2 = repo.retire('svc-a', new Date('2026-01-02T00:00:00Z'));
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.already, true);
  assert.strictEqual(r2.asset.retiredAt.toISOString(), '2026-01-01T00:00:00.000Z', '退役时间不回退');
});

test('A4 文件持久化：写入 → 重建恢复 + 退役状态保留', () => {
  const file = tmpFile('asset');
  const repo1 = createAssetRepo({ file });
  repo1.upsert({ id: 'svc-a' });
  repo1.upsert({ id: 'svc-b' });
  repo1.retire('svc-b', new Date('2026-01-01T00:00:00Z'));
  // 新实例重建
  const repo2 = createAssetRepo({ file });
  assert.strictEqual(repo2.count(), 2);
  assert.strictEqual(repo2.isActive('svc-a'), true);
  assert.strictEqual(repo2.isActive('svc-b'), false);
  assert.strictEqual(repo2.findById('svc-b').retiredAt.toISOString(), '2026-01-01T00:00:00.000Z');
  fs.unlinkSync(file);
});

test('A5 退役未知资产：asset_not_found（不静默成功）', () => {
  const repo = createAssetRepoMemory();
  const r = repo.retire('svc-ghost');
  assert.deepStrictEqual(r, { ok: false, reason: 'asset_not_found' });
});

// ============ 跨实例/种子初始化 ============

test('P1 首次启动种子初始化：identities/assets 写入文件', () => {
  const file = tmpFile('seed');
  const idRepo = createIdentityRepo({ file, identities: [{ id: 'u1', role: 'dev' }] });
  assert.strictEqual(idRepo.count(), 1);
  assert.ok(fs.existsSync(file), '种子已写盘');
  const asRepo = createAssetRepo({ file: `${file}-a`, assets: [{ id: 'svc-1' }] });
  assert.strictEqual(asRepo.count(), 1);
  assert.ok(fs.existsSync(`${file}-a`), '资产种子已写盘');
  fs.unlinkSync(file);
  fs.unlinkSync(`${file}-a`);
});

test('P2 损坏文件 fail-fast：构造即拒绝（fail-closed，不静默降级）', () => {
  const file = tmpFile('corrupt');
  fs.writeFileSync(file, '{not-json', 'utf8');
  assert.throws(() => createIdentityRepo({ file }), /加载失败|JSON/);
  assert.throws(() => createAssetRepo({ file }), /加载失败|JSON/);
  fs.unlinkSync(file);
});
