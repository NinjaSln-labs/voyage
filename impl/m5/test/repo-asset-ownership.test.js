// 资产归属仓储契约测试（ADR-006 范围维度数据源：owned/related）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AssetOwnership, isValidSubjectId, createAssetOwnershipRepo, createAssetOwnershipRepoMemory } = require('../src/repo/repo-asset-ownership.js');

const SEED = [
  { assetId: 'jd-light', owners: ['sre-alice'], related: ['dev-bob'] },
  { assetId: 'ali-ecs-99', owners: ['sre-b'], related: ['qa-zhang'] },
];

test('O1 归属投影：ownersOf/relatedOf/isOwnedBy/isRelatedTo/listOwnedBy（未知资产 → 空/false）', () => {
  const repo = createAssetOwnershipRepoMemory(SEED);
  assert.deepStrictEqual(repo.ownersOf('jd-light'), ['sre-alice']);
  assert.deepStrictEqual(repo.relatedOf('jd-light'), ['dev-bob']);
  assert.strictEqual(repo.isOwnedBy('sre-alice', 'jd-light'), true);
  assert.strictEqual(repo.isOwnedBy('sre-b', 'jd-light'), false, '非负责主体 → false');
  assert.strictEqual(repo.isRelatedTo('dev-bob', 'jd-light'), true);
  assert.strictEqual(repo.isRelatedTo('sre-alice', 'jd-light'), false, '负责 ≠ 相关');
  assert.deepStrictEqual(repo.listOwnedBy('sre-alice'), ['jd-light']);
  // 未知资产 fail-closed
  assert.deepStrictEqual(repo.ownersOf('nope'), []);
  assert.strictEqual(repo.isOwnedBy('sre-alice', 'nope'), false);
  assert.strictEqual(repo.count(), 2);
});

test('O2 值对象校验：非法 assetId/主体 id → 抛错；去重保序；快照拷贝', () => {
  assert.throws(() => new AssetOwnership({ assetId: 'bad id' }), /assetId 非法/);
  assert.throws(() => new AssetOwnership({ assetId: '__proto__' }), /assetId 非法/, '原型链保留键拒绝');
  assert.throws(() => new AssetOwnership({ assetId: 'a', owners: ['ok', 'bad id'] }), /非法主体/);
  assert.throws(() => new AssetOwnership({ assetId: 'a', owners: 'notarray' }), /须为数组/);
  const r = new AssetOwnership({ assetId: 'a', owners: ['u1', 'u1', 'u2'] });
  assert.deepStrictEqual(r.owners, ['u1', 'u2'], '去重保序');
  const snap = r.snapshot();
  snap.owners.push('hacked');
  assert.deepStrictEqual(r.owners, ['u1', 'u2'], '快照为拷贝，不污染内部');
  assert.strictEqual(isValidSubjectId('sre-alice'), true);
  assert.strictEqual(isValidSubjectId('bad id'), false);
  assert.strictEqual(isValidSubjectId(''), false);
});

test('O3 文件持久化：种子初始化落盘 → 重建恢复；损坏文件 fail-fast', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-own-'));
  try {
    const file = path.join(dir, 'ownership.json');
    createAssetOwnershipRepo({ file, ownership: SEED }); // 首次落盘
    assert.ok(fs.existsSync(file));
    const repo2 = createAssetOwnershipRepo({ file }); // 重建
    assert.strictEqual(repo2.isOwnedBy('sre-alice', 'jd-light'), true);
    assert.strictEqual(repo2.count(), 2);
    // 损坏 → fail-fast
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{"ownership": "nope"}');
    assert.throws(() => createAssetOwnershipRepo({ file: bad }), /结构非法/);
    const bad2 = path.join(dir, 'bad2.json');
    fs.writeFileSync(bad2, '{ not json');
    assert.throws(() => createAssetOwnershipRepo({ file: bad2 }), /SyntaxError/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
