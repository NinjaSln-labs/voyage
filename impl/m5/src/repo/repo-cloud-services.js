// 云服务器台账 → 资产仓储 投影转换适配器（真实部署过渡：执行面只关心「这台还能不能执行操作」）
// 依据：cloud-services.json 台账（~/Documents/cloud-services/，单源）+ ADAPTER-CONTRACTS.md §5（assetRepoPort）
//      M4 exec.assetPort 契约定型：{ isActive(target) → boolean }（INV-AS2 作业受理校验退役状态）
// 原则：台账单源——本模块只读台账并投影，不复制资产事实；执行面最小契约——仅 hardened:true 的服务器
//      投影为 Asset{id, status: active}；域名/在途 Oracle/未加固资产不进入执行面（fail-closed，不静默纳入）；
//      name 不满足资产 ID schema → excluded（不静默纳入非法 id）；连接信息（ssh/key）不进入 Asset（脱敏，契约无此字段）
// 替换条件：真实部署时从 CMDB 导入 → 仍可用本项目做「台账 → 执行面种子」投影

'use strict';

const fs = require('node:fs');
const { Asset, isValidAssetId } = require('./repo-asset.js');

/**
 * 台账 → 资产种子投影（纯函数，无副作用）
 * @param {object} ledger - cloud-services.json 解析后的对象
 * @returns {{ assets: Asset[], excluded: Array<{id, reason}> }}
 *  - assets: 仅 hardened:true 的服务器投影为 Asset{id: name, status: active}
 *  - excluded: 未进入执行面的条目（域名/在途/未加固/非法 id），附原因（fail-closed 可追溯）
 */
function projectCloudAssets(ledger) {
  if (!ledger || typeof ledger !== 'object') throw new Error('projectCloudAssets: 台账对象必填');
  const servers = ledger.assets && Array.isArray(ledger.assets.servers) ? ledger.assets.servers : [];
  const assets = [];
  const excluded = [];

  for (const s of servers) {
    const id = s && s.name;
    if (!isValidAssetId(id)) {
      excluded.push({ id: id || '(unnamed)', reason: 'invalid_asset_id' });
      continue;
    }
    if (s.hardened !== true) {
      // 未加固/在途（如 oracle-arm-free pending-grab）不进入执行面——isActive 会判定 false（fail-closed）
      excluded.push({ id, reason: `not_hardened_or_pending (hardened=${s.hardened}, status=${s.status || 'n/a'})` });
      continue;
    }
    assets.push(new Asset({ id, status: 'active' }));
  }

  // 域名不进入执行面（assetRepoPort 只管辖执行目标；域名台账仍留在 cloud-services.json 单源）
  if (ledger.assets && ledger.assets.domain) {
    excluded.push({ id: ledger.assets.domain.name || '(domain)', reason: 'domain_not_exec_target' });
  }

  return { assets, excluded };
}

/**
 * 从台账文件读取并投影（供 createAssetRepo({ assets }) 种子初始化）
 * @param {string} file - cloud-services.json 路径
 * @returns {{ assets: Asset[], excluded: Array<{id, reason}> }}
 */
function createCloudAssetSeed({ file }) {
  if (!file || typeof file !== 'string' || file.length === 0) {
    throw new Error('createCloudAssetSeed: file 必填（cloud-services.json 路径）');
  }
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`createCloudAssetSeed: 台账读取失败（${file}）——${e.message}`);
  }
  return projectCloudAssets(ledger);
}

module.exports = { projectCloudAssets, createCloudAssetSeed };
