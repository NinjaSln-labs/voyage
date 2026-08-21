// 云服务器台账 → 资产仓储 投影契约测试
// 验证：hardened:true 服务器投影为 Asset{id, active}、域名/在途 Oracle 不进入执行面（fail-closed）、
//      非法 id/未加固排除可追溯、台账文件读取投影、投影种子可直接喂 createAssetRepo（M4 isActive 语义）

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectCloudAssets, createCloudAssetSeed } = require('../src/repo/repo-cloud-services.js');
const { createAssetRepoMemory } = require('../src/repo/repo-asset.js');

// 模拟 cloud-services.json 台账结构（与真实台账同构）
function sampleLedger(over = {}) {
  return {
    assets: {
      servers: [
        { name: 'ali-ecs-99', public_ip: '123.57.237.239', hardened: true },
        { name: 'jd-light', public_ip: '117.72.186.97', hardened: true, role: 'oracle-grabber-host' },
        { name: 'oracle-arm-free', public_ip: null, hardened: false, status: 'pending-grab' },
      ],
      domain: { name: 'ninja-sin.tech', status: 'dns-not-configured' },
    },
    ...over,
  };
}

test('C1 投影：仅 hardened:true 服务器进入执行面（Asset{id, active}）', () => {
  const { assets, excluded } = projectCloudAssets(sampleLedger());
  assert.strictEqual(assets.length, 2, '2 台已加固服务器');
  const ids = assets.map(a => a.id).sort();
  assert.deepStrictEqual(ids, ['ali-ecs-99', 'jd-light']);
  for (const a of assets) {
    assert.strictEqual(a.status, 'active');
    assert.strictEqual(a.isActive(), true, '投影资产 M4 isActive=true');
  }
});

test('C2 排除：在途 Oracle / 域名不进入执行面（fail-closed，不静默纳入）', () => {
  const { assets, excluded } = projectCloudAssets(sampleLedger());
  const excludedIds = excluded.map(e => e.id);
  assert.ok(excludedIds.includes('oracle-arm-free'), '在途 Oracle 被排除');
  assert.ok(excludedIds.includes('ninja-sin.tech'), '域名被排除');
  assert.ok(excluded.every(e => e.reason), '排除项附原因（可追溯）');
  const oracle = excluded.find(e => e.id === 'oracle-arm-free');
  assert.match(oracle.reason, /not_hardened_or_pending/, '排除原因说明未加固/在途');
});

test('C3 非法资产 id：不静默纳入（排除可追溯）', () => {
  const ledger = sampleLedger();
  ledger.assets.servers.push({ name: 'bad;id', hardened: true });
  const { assets, excluded } = projectCloudAssets(ledger);
  assert.strictEqual(assets.length, 2, '非法 id 不进入执行面');
  const bad = excluded.find(e => e.id === 'bad;id');
  assert.ok(bad, '非法 id 在排除列表');
  assert.strictEqual(bad.reason, 'invalid_asset_id');
});

test('C4 台账文件读取投影：createCloudAssetSeed 解析真实台账结构', () => {
  const file = path.join(os.tmpdir(), `cloud-ledger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify(sampleLedger()), 'utf8');
  const { assets, excluded } = createCloudAssetSeed({ file });
  assert.strictEqual(assets.length, 2);
  assert.strictEqual(excluded.length, 2, '域名 + 在途 Oracle');
  fs.unlinkSync(file);
});

test('C5 投影种子直接喂 createAssetRepo：M4 isActive 语义贯通', () => {
  const { assets } = projectCloudAssets(sampleLedger());
  const repo = createAssetRepoMemory(assets);
  assert.strictEqual(repo.isActive('ali-ecs-99'), true);
  assert.strictEqual(repo.isActive('jd-light'), true);
  assert.strictEqual(repo.isActive('oracle-arm-free'), false, '在途 Oracle 未纳管 → fail-closed false');
  assert.strictEqual(repo.isActive('ninja-sin.tech'), false, '域名非执行目标 → false');
});

test('C6 台账文件损坏：fail-fast（不静默降级）', () => {
  const file = path.join(os.tmpdir(), `cloud-bad-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(file, '{not-json', 'utf8');
  assert.throws(() => createCloudAssetSeed({ file }), /台账读取失败/);
  fs.unlinkSync(file);
});
