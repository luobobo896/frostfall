// 长局最终 Boss 的数值核算（§8.6 那种手算表的思路）：单人 18 塔位能不能打死 40000 血的冰封主宰。
import test from 'node:test';
import assert from 'node:assert/strict';

import { GRID, LONG_RUN_BOSS_HP, MAPS, MONSTERS, TOWERS } from '../src/data.js';
import { armorReduction, typeMultiplier } from '../src/core.js';
import { towerDps } from '../src/match.js';

/** 一座满级塔对某个目标的实际 DPS：面板 DPS × 克制系数 × 护甲减免。 */
function effectiveDps(towerId, target, level = 3) {
  const t = TOWERS[towerId];
  return towerDps(towerId, level) * typeMultiplier(t.attackType, target.armorType) * armorReduction(target.armor);
}

/** 从塔位到路径的“平均覆盖”：保守起见只算射程内、且不在两端的塔（这里用「全部塔都在射程内」作上限）。 */
function buildDps(loadout, target) {
  return loadout.reduce((sum, id) => sum + effectiveDps(id, target), 0);
}

test('长局最终 Boss 的数值核算：单人 18 塔位的上限打不动它（这是设计结论，不是 bug）', () => {
  const boss = MONSTERS.boss_03;
  const bossHp = LONG_RUN_BOSS_HP.boss_03 * 0.85;        // §1.6 单人系数：怪物生命 ×0.85
  const pathTiles = MAPS.map_01.pathLength;
  const secondsOnPath = pathTiles / (boss.speed / GRID.unitPerTile);

  // 满级混搭塔阵（长局 AI 打出来的那种）：6 炮塔 + 8 箭塔 + 3 冰塔 + 1 静电塔 = 18 个塔位全满
  const full = [
    ...Array(6).fill('tw_cannon'), ...Array(8).fill('tw_arrow'),
    ...Array(3).fill('tw_frost'), ...Array(1).fill('tw_static'),
  ];
  const maxDps = buildDps(full, boss);
  const dealt = maxDps * secondsOnPath;
  const need = bossHp / secondsOnPath;

  console.log(`  冰封主宰：${bossHp} 血 · 护甲 ${boss.armor}（减伤 ${((1 - armorReduction(boss.armor)) * 100).toFixed(1)}%）`);
  console.log(`  map_01 路径 ${pathTiles} 格 → 它在场上 ${secondsOnPath.toFixed(1)} 秒`);
  console.log(`  18 塔位满级混搭（全部都在射程内的上限）：${maxDps.toFixed(0)} DPS → 总输出 ${dealt.toFixed(0)}`);
  console.log(`  要打死它需要：${need.toFixed(0)} DPS（缺口 ${((1 - maxDps / need) * 100).toFixed(0)}%）`);

  assert.ok(maxDps < need, '单人 18 塔位打不动长局最终 Boss——这正是「长局要 2-4 人 / 大图」的量化依据');
  assert.ok(boss.coreDamage > MAPS.map_01.coreHp, '最终 Boss 漏一只即判负（§6.3 的「直接失败」）');
});

test('对照：同样的塔阵在 32 塔位的大图上就够了（map_04-06 的量级）', () => {
  const boss = MONSTERS.boss_03;
  const bossHp = LONG_RUN_BOSS_HP.boss_03 * 0.85;
  const secondsOnPath = MAPS.map_04?.pathLength ? MAPS.map_04.pathLength / (boss.speed / GRID.unitPerTile) : 41;
  // 大图按 32 塔位、同样的混搭比例（约 1/3 炮塔）
  const big = [
    ...Array(11).fill('tw_cannon'), ...Array(14).fill('tw_arrow'),
    ...Array(5).fill('tw_frost'), ...Array(2).fill('tw_static'),
  ];
  const dps = buildDps(big, boss);
  assert.ok(dps > bossHp / secondsOnPath, `32 塔位的上限 ${dps.toFixed(0)} DPS 应足以打死它`);
});
