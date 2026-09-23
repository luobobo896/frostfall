// 内核规则自校验：逐条对应 docs/game-design.md v0.7 的数值与附录 B 的验收项。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARMOR_TYPES, ATTACK_TYPES, DAMAGE_MATRIX, DEFENSE_MAPS, DIFFICULTY, DROP_TABLE, ECONOMY, EQUIP_SLOTS, FORTS, GRID, HEROES, MAPS, MONSTERS, QUALITY, QUALITY_ORDER, SKILL_MAX_LEVEL, WAVES_LONG,
  SHOP_ITEMS, STAT_CAPS, TICK_STEP, TOWERS, WAVES, WEAPONS, WEAPON_IDS, HERO_DODGE_BASE, ilvlForWave, skillLevelOf, expToNext,
} from '../src/data.js';
import { armorReduction, buildMap, computeDamage, pathTotalUnits, splashScale, typeMultiplier, makeRng } from '../src/core.js';
import { emptyProfile, reviveMulOf, startGoldOf } from '../src/profile.js';
import {
  buyItem, craftEquipment, cumulativeExp, investedOf, makeEquipment, potionCount, shopPriceOf, usePotion,
  buildTower, castSkill, createMatch, damageMonster, describe as describeMatch, heroAttack, heroDamageReduce, heroDodge, heroStats, startWaveEarly, towerDps, towerStats, update, upgradeCost, upgradeTower, waveQueue,
  enhanceCostOf, enhanceItem, equipBonus, equipItem, sellItem, auraAt, skillLevel,
} from '../src/match.js';
import { createDefenseMatch } from '../src/defense.js';

const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test('§7.2 护甲减免公式', () => {
  // 文档示例：护甲 6 → 26.5%；护甲 8 → 32.4% 有效；护甲 3 → 84.75% 有效
  near(armorReduction(6), 1 - 0.36 / 1.36);
  near(armorReduction(8), 0.3243, 0.001);
  near(armorReduction(3), 0.8475, 0.001);
  // 负护甲：每点 +6% 受伤
  near(armorReduction(-2), 1.12, 0.001);
});

test('§6.2 克制表关键格子', () => {
  assert.equal(typeMultiplier('normal', 'fortified'), 1.0);
  assert.equal(typeMultiplier('siege', 'fortified'), 1.5);
  assert.equal(typeMultiplier('magic', 'fortified'), 0.35);
  assert.equal(typeMultiplier('pierce', 'fortified'), 0.35);
  assert.equal(typeMultiplier('magic', 'heavy'), 2.0);
  for (const at of Object.keys(DAMAGE_MATRIX)) {
    for (const ar of ARMOR_TYPES) assert.ok(DAMAGE_MATRIX[at][ar] > 0, `${at}/${ar}`);
  }
});

test('§7.2 伤害下限与暴击', () => {
  const flat = () => 0.5; // 固定随机数：不暴击、浮动为 1.0
  const weak = computeDamage({ atk: 1, attackType: 'pierce', armor: 20, armorType: 'fortified', rng: flat });
  assert.equal(weak.damage, 1);
  const crit = computeDamage({ atk: 100, attackType: 'chaos', armor: 0, armorType: 'unarmored', critRate: 1, critDmg: 0.5, rng: flat });
  assert.equal(crit.crit, true);
  assert.equal(crit.damage, 150);
});

test('§7.3 概率上限（暴击 75% / 穿透 60% / 减速 60% / 闪避 75%）与英雄基础闪避 3%', () => {
  // 上限表就是文档那一列（写错了这条会红）
  assert.deepEqual(STAT_CAPS, { critRate: 0.75, dodge: 0.75, armorPierce: 0.6, slow: 0.6 });
  assert.equal(HERO_DODGE_BASE, 0.03);

  // 暴击率给到 100% 也只按 75% 算：固定 rng 0.8 → 0.8 > 0.75，这一下不该暴击
  const eighty = () => 0.8;
  assert.equal(computeDamage({ atk: 100, attackType: 'chaos', armor: 0, armorType: 'unarmored', critRate: 1, rng: eighty }).crit, false);
  // 而 74% 时 0.8 也打不中，用 0.7 反证「夹紧之后仍然能暴击」
  const seventy = () => 0.7;
  assert.equal(computeDamage({ atk: 100, attackType: 'chaos', armor: 0, armorType: 'unarmored', critRate: 0.74, rng: seventy }).crit, true);

  // 穿透 = 削目标护甲（§7.3「无视 X% 护甲」）：对穿甲目标伤害要**更高**，而且 100% 与 60% 同一个数
  const pierce = (v) => computeDamage({ atk: 100, attackType: 'normal', armor: 20, armorType: 'medium', armorPierce: v, rng: () => 0.5 }).damage;
  assert.equal(pierce(1), pierce(0.6), '上限 60%：给到 100% 也只能按 60% 算');
  assert.ok(pierce(0.6) > pierce(0), `穿透要打得更多，不是更少（0% → ${pierce(0)}，60% → ${pierce(0.6)}）`);
  // 无甲目标：穿透没有任何意义（没有护甲可削），两边应该一样
  const vsUnarmored = (v) => computeDamage({ atk: 100, attackType: 'normal', armor: 0, armorType: 'unarmored', armorPierce: v, rng: () => 0.5 }).damage;
  assert.equal(vsUnarmored(0.6), vsUnarmored(0));

  // 闪避：基础 3% + 疾风步 25% = 28%；给到 500% 也只算 75%
  const m = createMatch({ mapId: 'map_01', heroId: 'hero_ranger' });
  assert.equal(heroDodge(m), 0.03, '英雄基础闪避 3%（§7.3）');
  m.hero.windBuff = { dodgePct: 0.25 };
  assert.equal(heroDodge(m), 0.28);
  m.hero.windBuff = { dodgePct: 5 };
  assert.equal(heroDodge(m), 0.75);

  // 减速上限 60%：临时把冰塔的减速改成 90%，怪物身上记下来的必须是 60%
  const frost = TOWERS.tw_frost.special;
  const origSlow = frost.slowPct;
  frost.slowPct = 0.9;
  try {
    const m2 = createMatch({ mapId: 'map_01', seed: 4 });
    m2.gold = 1000;
    assert.equal(buildTower(m2, 0, 'tw_frost'), true);
    const tower = m2.map.slots[0];
    const path = m2.map.paths[0];
    let dist = null;
    for (let d = 0; d < path.lengthTiles * 128; d += 32) {
      const c = path.cells[Math.min(path.cells.length - 1, Math.floor(d / 128))];
      if (Math.max(Math.abs(c.x - tower.x), Math.abs(c.y - tower.y)) <= 3) { dist = d; break; }
    }
    assert.ok(dist != null, '前置：路径上应当有一段经过 0 号塔位附近');
    const def = MONSTERS.mob_04;
    m2.monsters.push({
      uid: 1, mobId: 'mob_04', def, pathIndex: 0, dist,
      cell: path.cells[Math.min(path.cells.length - 1, Math.floor(dist / 128))],
      hp: 1e9, maxHp: 1e9, armor: def.armor, armorType: def.armorType, speed: def.speed,
      attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
    });
    for (let i = 0; i < 60; i++) update(m2, TICK_STEP);
    const slow = m2.monsters[0]?.effects.find((e) => e.type === 'slow');
    assert.ok(slow, '冰塔该给这只怪挂上减速');
    assert.equal(slow.pct, 0.6, `减速 90% 要被夹到 60%，实际 ${slow.pct}`);
  } finally {
    frost.slowPct = origSlow;
  }
});

test('§8.1/§8.2 塔的 DPS、升级与出售口径', () => {
  near(towerDps('tw_arrow', 2), 40.1, 0.01);          // 文档 §8.6：24.3 × 1.65
  near(towerDps('tw_cannon', 1), 32.0, 0.01);
  near(towerStats('tw_arrow', 3).damage, 18 * 1.35 ** 2, 0.01);
  assert.equal(upgradeCost('tw_arrow', 1), 72);        // 60 × 1.2
  assert.equal(upgradeCost('tw_arrow', 2), 132);       // 60 × 2.2
  assert.equal(investedOf('tw_arrow', 2), 132);        // 文档 §8.6 的「6 × 132」
  assert.equal(upgradeCost('tw_arrow', 3), null);      // 首发 3 级封顶
  assert.ok(towerStats('tw_arrow', 3).atkSpeed <= 4.0);
});

test('§8.6 复算：WC3 护甲公式下第 6 波余量（文档 +8% 是把减伤率当倍率）', () => {
  const arrowDps = towerDps('tw_arrow', 2) * 6;
  const cannonDps = towerDps('tw_cannon', 1) * 2;
  near(arrowDps, 240.6, 0.01);
  near(cannonDps, 64.0, 0.01);

  // WC3 规则（§7.2 正文）：护甲 8 → 减伤 32.4%，伤害倍率 0.676；护甲 3 → 减伤 15.25%，倍率 0.8475
  near(armorReduction(8), 0.676, 0.01);
  near(1 - armorReduction(8), 0.324, 0.01);
  near(armorReduction(3), 0.8475, 0.01);

  const vsBoss = {
    arrow: typeMultiplier('normal', 'fortified') * armorReduction(8),
    cannon: typeMultiplier('siege', 'fortified') * armorReduction(8),
  };
  near(vsBoss.arrow, 0.676, 0.01);
  near(vsBoss.cannon, 1.014, 0.01);

  const bossHp = MONSTERS.boss_01.hp;
  const cannonToBoss = cannonDps * 40 * vsBoss.cannon;
  const bossLeft = bossHp - cannonToBoss;
  const arrowPanelForBoss = bossLeft / vsBoss.arrow;
  const arrowPanelTotal = arrowDps * 40;
  const arrowPanelLeft = arrowPanelTotal - arrowPanelForBoss;
  // 小怪的「有效面板血量」= HP /(克制系数 × 护甲减免)：mob_04 1,320/0.8475 + mob_02 280/1.0
  const smallEffectivePanel =
    (MONSTERS.mob_04.hp * 6) / (typeMultiplier('normal', 'heavy') * armorReduction(3)) +
    (MONSTERS.mob_02.hp * 4) / (typeMultiplier('normal', 'light') * armorReduction(0));
  const margin = arrowPanelLeft / smallEffectivePanel;
  assert.ok(margin > 1.0, `40 秒窗口必须能清场，实际余量 ${margin.toFixed(3)}`);
  // 文档结论 +8% 有两处算术问题：① 把「减伤率 32.4%」当成「伤害倍率 0.324」；② 最后一步混用面板伤害与有效血量。
  // 按 WC3 公式重算后余量远大于 1，说明第 6 波在当前数值下没有压力 —— 这条差异记录在 docs/testing/，
  // 由 tools/selfplay.mjs 的整局实测决定是否上调 Boss 与怪量。
  assert.ok(margin > 2, `按文档数值，第 6 波余量应远大于 1（实测 ${margin.toFixed(2)}）`);
});

test('§6.4.2 波次表总量与构成', () => {
  const counts = WAVES.map((w) => w.groups.reduce((s, g) => s + g.count, 0));
  assert.equal(counts.reduce((a, b) => a + b, 0), 229);
  assert.deepEqual(counts, [8, 10, 12, 14, 16, 11, 18, 22, 26, 30, 34, 28]);
  const w6 = WAVES[5].groups.map((g) => `${g.mobId}×${g.count}`).join('+');
  assert.equal(w6, 'mob_04×6+mob_02×4+boss_01×1');
  assert.ok(WAVES[11].groups.some((g) => g.mobId === 'boss_02'));
  for (const w of WAVES) assert.ok(waveQueue(w.wave).length === counts[w.wave - 1]);
});

test('§8.5 经济：第 6 波与第 12 波累计金币落在验收区间', () => {
  let gold = ECONOMY.startGold;
  const cum = [];
  for (const w of WAVES) {
    const bounty = w.groups.reduce((s, g) => s + MONSTERS[g.mobId].bounty * g.count, 0) * ECONOMY.bountyMul;
    gold += bounty + ECONOMY.waveGold(w.wave);
    cum.push(gold);
  }
  assert.ok(cum[5] >= 1400 && cum[5] <= 1700, `第 6 波累计 ${cum[5]}`);
  assert.ok(cum[11] >= 4700 && cum[11] <= 5600, `第 12 波累计 ${cum[11]}`);
});

test('§8.5 木材：单人一局 95-120，够复活 2 次', () => {
  let lumber = 0;
  for (const w of WAVES) lumber += ECONOMY.waveLumber(w.wave);
  for (const w of WAVES) for (const g of w.groups) lumber += MONSTERS[g.mobId].lumber * g.count;
  assert.ok(lumber >= 95 && lumber <= 120, `木材总收入 ${lumber}`);
  assert.ok(lumber >= 100, '至少够两次快速复活（50×2）');
});

test('§3.2 经验曲线：4 人局期望到达 17-21 级', () => {
  // §3.2 那张「到达等级 / 累计经验」表逐行对（改前文档的公式与表格差一项，§84 已把文档改成与实现同一口径）
  const NODES = [[8, 910], [10, 1440], [15, 3290], [20, 5890], [25, 9240]];
  for (const [lv, need] of NODES) assert.equal(cumulativeExp(lv), need, `到达 ${lv} 级需要 ${need}`);
  // 定义式：累计到 N 级 = Σ_{l=1..N−1} expToNext(l)。表里的 8/10/15/20 曾按 Σ_{l=1..N} 写，多算了本级那一档
  for (const [lv] of NODES) {
    let sum = 0;
    for (let l = 1; l < lv; l += 1) sum += expToNext(l);
    assert.equal(cumulativeExp(lv), sum, `累计到 ${lv} 级 = 前 ${lv - 1} 级之和`);
  }
  const totalExp = WAVES.reduce((sum, w) =>
    sum + w.groups.reduce((s, g) => s + MONSTERS[g.mobId].level * 8 * g.count, 0), 0);
  let level = 1;
  while (level < 25 && totalExp >= cumulativeExp(level + 1)) level += 1;
  assert.ok(level >= 17 && level <= 21, `期望到达等级 ${level}`);
  assert.ok(expToNext(1) === 40 && expToNext(5) === 160);
});

// STATUS §3.1 #26（已拍板）：本代技能**只有 2 档**（表里每种技能只给了两个数），所以等级封在 2。
test('§3.3 技能等级随英雄等级自动提升（本代封顶 2 档，§3.1 #26）', () => {
  assert.equal(skillLevelOf(1, 1), 1);
  assert.equal(skillLevelOf(19, 1), 2, '19 级也只到第 2 档（旧口径会算出 4，但表里没有第 3-5 档的数）');
  assert.equal(skillLevelOf(19, 8), 2);
  assert.equal(skillLevelOf(19, 15), 1);
  assert.equal(skillLevelOf(99, 1), 2, '再高也是 2 档');
});

// §3.1 #26 的对账：技能表里每种技能**正好给 SKILL_MAX_LEVEL 个数**。加第 3 个数时这条会红，
// 提醒你把 `SKILL_MAX_LEVEL` 一起放开——否则新数值永远取不到（这正是「表头写 5 级满、实现只到 2 档」
// 那一类不一致的守门人）。
test('§3.1 #26 技能数值的档数与 SKILL_MAX_LEVEL 对账（加数值就要放开上限）', () => {
  const KEYS = ['dmg', 'heals', 'hps', 'atkPct', 'armorBreak', 'dmgTakenPct', 'arrows', 'slowPct', 'armorPierce'];
  let checked = 0;
  for (const [hid, h] of Object.entries(HEROES)) {
    for (const def of [...h.skills, h.thirdSkill].filter(Boolean)) {
      for (const key of KEYS) {
        if (!Array.isArray(def[key])) continue;
        checked += 1;
        assert.equal(def[key].length, SKILL_MAX_LEVEL,
          `${hid}.${def.id}.${key} 给了 ${def[key].length} 档，而上限是 ${SKILL_MAX_LEVEL}`);
      }
    }
  }
  assert.ok(checked >= 8, `应该对到十几个技能数值数组（现在 ${checked} 个）`);
});

test('§2.2/§2.5 地图路径长度、塔位数与核心位置', () => {
  // 顺带把 §2.3 的地形规则一并验掉（同一段：地图 → 塔位 → 地形）
  {
    const m = createMatch({ mapId: 'map_01', difficulty: 'normal', seed: 3 });
    m.gold = 5000;
    const [s0, s1, s2] = m.map.slots;
    m.map.swamp.add(`${s0.x},${s0.y}`);        // 手工把 0 号塔位标成沼泽
    m.map.highland.add(`${s1.x},${s1.y}`);     // 1 号标成高地
    assert.equal(buildTower(m, 0, 'tw_arrow'), true);
    assert.equal(buildTower(m, 1, 'tw_arrow'), true);
    assert.equal(buildTower(m, 2, 'tw_arrow'), true);
    const [swamp, high, plain] = m.towers;
    assert.equal(plain.stats.range, TOWERS.tw_arrow.range, '平地就是基准射程');
    assert.equal(swamp.stats.range, TOWERS.tw_arrow.range - 1, '§2.3：沼泽上的塔射程 -1');
    assert.equal(high.stats.range, TOWERS.tw_arrow.range + 1.5, '§2.3：高地上的塔射程 +1.5');
    assert.ok(Math.abs(high.stats.damage / plain.stats.damage - 1.10) < 1e-9, '§2.3：高地攻击 +10%');
    assert.equal(high.stats.onHighland, true);
    assert.equal(plain.stats.onHighland, false, '平地不带地形标记');
    // 升级也要吃地形（否则升一级就把加成洗掉了）
    assert.equal(upgradeTower(m, 1), true);
    assert.ok(Math.abs(m.towers[1].stats.range - (TOWERS.tw_arrow.range * 1.05 + 1.5)) < 1e-9, '升级后仍是「等级基准 + 地形」');
    // 面板读的是塔自己那份（含地形），不是纯等级基准
    assert.equal(m.towers[0].stats.range, swamp.stats.range);
  }
  for (const def of Object.values(MAPS)) {
    const map = buildMap(def);
    for (const p of map.paths) {
      if (p.air) continue;
      assert.equal(p.cells.length, def.pathLength, `${def.id} 路径长度`);
      const last = p.cells[p.cells.length - 1];
      // 双核心地图（map_06）：每条路走到「自己那个核心」，不是都走到第一个
      assert.deepEqual(last, p.core ?? def.core, `${def.id} 终点应是该路径对应的核心`);
    }
    assert.equal(map.slots.length, def.towerSlots, `${def.id} 塔位数`);
    const seen = new Set(map.slots.map((s) => `${s.x},${s.y}`));
    assert.equal(seen.size, map.slots.length, '塔位不重复');
    for (const s of map.slots) assert.ok(!map.blocked.has(`${s.x},${s.y}`), '塔位不压在路径上');
  }
});

test('§5.2 装备：品质、ilvl 与属性公式', () => {
  const m = { rng: makeRng(7), inventory: [], stats: { drops: 0 }, equipped: {} };
  const item = makeEquipment(m, 'armor', 'blue', 6);
  near(item.baseAttrs.def, 3 * 1.7 * 1.4, 0.01);
  assert.equal(item.ilvl, 6);
  // §4.2 的词条数是按品质写死的：白 0 / 蓝 2 / 紫 3 / 橙 4（首发的裁剪只说了「去掉绿档」）。
  // 另一种读法是「把剩下四档重新编号」（0/1/2/3，即整体压一档）——两种都说得通，
  // 这里按文档的字面数字实现，并留了这条注释；要改成阶梯口径就是 affixCountFor 那一行。
  assert.equal(item.affixes.length, 2, '蓝装 2 条词条（§4.2）');
  assert.equal(ilvlForWave(1), 2);
  assert.equal(ilvlForWave(12), 15);
  assert.equal(QUALITY_ORDER.length, 4);
});

test('§5.4.1 一键合成：3 件同部位同品质 → 1 件高一档，ilvl 取最高 +1', () => {
  const m = { rng: makeRng(11), inventory: [], stats: { drops: 0, crafts: 0 }, equipped: {}, events: [], time: 0 };
  for (const ilvl of [3, 5, 4]) m.inventory.push(makeEquipment(m, 'weapon', 'white', ilvl));
  assert.equal(craftEquipment(m, 'weapon', 'white'), true);
  assert.equal(m.inventory.length, 1);
  assert.equal(m.inventory[0].quality, 'blue');
  assert.equal(m.inventory[0].ilvl, 6);
  assert.equal(craftEquipment(m, 'weapon', 'white'), false);
  assert.equal(craftEquipment(m, 'weapon', 'orange'), false, '橙装封顶不可再合');
});

test('§4.4 / §5.4 强化：+1..+5 无失败、成本 60×n^1.6、+3/+5 各解锁 1 条词条、主属性 +6%/级', () => {
  const m = createMatch({ mapId: 'map_01', heroId: 'hero_warrior', seed: 3 });
  m.gold = 5000;
  const it = makeEquipment(m, 'weapon', 'white', 1);   // 白装本身 0 词条，正好用来验「强化解锁词条」
  m.inventory.push(it);
  const baseAtk = it.baseAttrs.attack;
  assert.equal(it.plus, 0);
  assert.equal(it.affixes.length, 0);
  assert.equal(enhanceCostOf(it), 60, '§4.4：60 × 1^1.6 = 60');

  assert.equal(enhanceItem(m, it.uid), true);
  assert.equal(it.plus, 1);
  assert.equal(it.invested, 60);
  assert.equal(m.gold, 5000 - 60);
  assert.equal(it.affixes.length, 0, '+1 还不解锁词条');

  assert.equal(enhanceItem(m, it.uid), true);   // +2 = round(60×2^1.6) = 182
  assert.equal(enhanceItem(m, it.uid), true);   // +3 = 348
  assert.equal(it.plus, 3);
  assert.equal(it.affixes.length, 1, '§5.4：+3 解锁 1 条额外词条');
  assert.equal(enhanceItem(m, it.uid), true);   // +4
  assert.equal(enhanceItem(m, it.uid), true);   // +5
  assert.equal(it.plus, 5);
  assert.equal(it.affixes.length, 2, '§5.4：+5 再解锁 1 条');
  assert.equal(enhanceItem(m, it.uid), false, '首发 +5 封顶（§3.8）');
  assert.equal(enhanceCostOf(it), null);
  // 逐级成本：60 / 182 / 348 / 551 / 788（§4.4 的公式算出来，文档只给了 +1/+3/+5 的取整值）
  assert.equal(it.invested, 60 + 182 + 348 + 551 + 788, '每一级的投入金币都要记账（出售按它返还）');

  // 主属性 ×(1 + 0.06×5) = ×1.30；词条不跟着涨（§4.3：词条在结算阶段叠加）
  const bonus = equipBonus({ weapon: it });
  assert.ok(Math.abs(bonus.attack - baseAtk * 1.3) < 0.01, `+5 主属性应是 1.30 倍（${bonus.attack} vs ${baseAtk * 1.3}）`);

  // 金币不足：一律拒绝
  const poor = createMatch({ mapId: 'map_01', seed: 4 });
  poor.gold = 10;
  const it2 = makeEquipment(poor, 'armor', 'blue', 5);
  poor.inventory.push(it2);
  assert.equal(enhanceItem(poor, it2.uid), false);
  assert.equal(it2.plus, 0);
});

test('§5.4 穿戴与出售：自由换装（更差的也能换）、出售返还投入 70%、紫/橙额外 30 木材', () => {
  const m = createMatch({ mapId: 'map_01', heroId: 'hero_warrior', seed: 4 });
  m.gold = 5000;
  const purple = makeEquipment(m, 'weapon', 'purple', 10);
  purple.invested = 1000;                       // 假装强化过 1000 金
  const blue = makeEquipment(m, 'weapon', 'blue', 3);
  m.inventory.push(purple, blue);

  assert.equal(equipItem(m, purple.uid), true);
  assert.equal(m.equipped.weapon, purple);
  assert.equal(m.inventory.includes(purple), false);
  assert.equal(equipItem(m, blue.uid), true, '§5.4 局内自由换装：更差的也要能换');
  assert.equal(m.equipped.weapon, blue);
  assert.ok(m.inventory.includes(purple), '换下来的那件要回背包');

  const gold0 = m.gold;
  const lum0 = m.lumber[0];
  assert.equal(sellItem(m, purple.uid), true);
  assert.equal(m.gold - gold0, 700, '§4.4：投入 1000 × 0.7');
  assert.equal(m.lumber[0] - lum0, 30, '§5.4：紫 / 橙额外返还木材 30');
  assert.equal(m.inventory.includes(purple), false);

  // 卖掉**身上那件**：槽位要空出来
  assert.equal(sellItem(m, blue.uid), true);
  assert.equal(m.equipped.weapon, null);

  // 白装没强化过 → 返还 0 金 0 木材（文档口径就是「投入金币 ×0.7」）
  const white = makeEquipment(m, 'armor', 'white', 2);
  m.inventory.push(white);
  const gold1 = m.gold;
  const lum1 = m.lumber[0];
  assert.equal(sellItem(m, white.uid), true);
  assert.equal(m.gold, gold1);
  assert.equal(m.lumber[0], lum1);

  assert.equal(sellItem(m, 'not-exist'), false);

  // 脏数据（未知部位/品质）三个动作都不许抛异常，也不许改状态
  const dirty = { uid: 'dirty-1', slot: 'unknown-slot', quality: 'legendary', ilvl: 3, baseAttrs: {}, affixes: [] };
  m.inventory.push(dirty);
  m.gold = 5000;
  assert.equal(enhanceItem(m, dirty.uid), false);
  assert.equal(equipItem(m, dirty.uid), false);
  assert.equal(Object.keys(m.equipped).includes('unknown-slot'), false);
  assert.equal(m.gold, 5000);
  assert.equal(sellItem(m, dirty.uid), true, '卖得掉（但返还 0）');
  assert.equal(m.inventory.includes(dirty), false);
});

test('§4.4 合成保留「最高强化等级 −2」', () => {
  const m = createMatch({ mapId: 'map_01', heroId: 'hero_warrior', seed: 6 });
  m.gold = 5000;
  const items = [5, 1, 0].map((plus) => {
    const it = makeEquipment(m, 'weapon', 'white', 4);
    it.plus = plus;
    return it;
  });
  m.inventory.push(...items);
  assert.equal(craftEquipment(m, 'weapon', 'white'), true);
  const out = m.inventory.find((i) => i.quality === 'blue');
  assert.ok(out, '应该合出一件蓝武');
  assert.equal(out.plus, 3, '输入最高 +5 → 输出 +3');
});

test('§5.5 商店：价格递增、限购与技能书', () => {
  const m = {
    gold: 5000, lumber: [100], shopBought: {}, bag: {}, events: [], time: 0, potionCd: {}, bookLevelBonus: 0,
    stats: { kills: 0, leaks: 0, drops: 0, damage: {} },   // 真局一定有 stats（createMatch 建），这一段要读药品计数
    hero: { def: { hp: 900, talents: [] }, level: 1, hp: 100, skillUnlocked: [true, false, false], buffs: [], attackBuff: 0 },
    shopBlocked: { scroll_town: '塔防里人物不下防线，回城卷轴用不上' },   // createMatch 给塔防登记的禁售表
  };
  // STATUS §3.1 #17（已拍板）：小药基准价 40 → 30（大药 120 → 80）
  assert.equal(shopPriceOf(m, 'pot_small').gold, 30);
  assert.equal(buyItem(m, 'pot_small'), true);
  assert.equal(shopPriceOf(m, 'pot_small').gold, 36);
  assert.equal(buyItem(m, 'pot_small'), true);
  assert.equal(shopPriceOf(m, 'pot_small').gold, 42); // 基准价 +20%/次（线性，不叠乘）
  assert.equal(buyItem(m, 'pot_group'), true);
  // §5.5.3：药品共 3 格 —— 已经 3 瓶了，第 4 瓶必须买不进来（价格递增挡不住囤药，这条才是硬约束）
  assert.equal(potionCount(m), 3);
  assert.equal(buyItem(m, 'pot_group'), false, '背包满了还能买第 4 瓶？');
  // 用掉一瓶就有空位了
  m.potionCd = {};
  assert.equal(usePotion(m, 'pot_small'), true);
  assert.equal(potionCount(m), 2);
  assert.equal(buyItem(m, 'pot_group'), true, '腾出空位就该买得进来');
  m.potionCd = {};
  usePotion(m, 'pot_small');
  m.potionCd = {};
  usePotion(m, 'pot_group');
  assert.equal(shopPriceOf(m, 'pot_group'), null, '限购 2 个后下架');

  // §5.5 药品平衡的两个读数口（`npm run potions` 全靠它们）：用了几次、药钱花了多少。
  // 只统计次数看不出问题——药品的钱是从塔的预算里抠的，所以「花了多少金」必须一起记
  assert.equal(m.stats.potions, 3, '这一节用了 3 瓶（2 小 + 1 群疗）');
  // 小药 30 → 36（同种涨价 +20%，**§3.1 #17 已把基准价从 40 降到 30**），
  // 群疗符 200 → 240（§155 补上它漏掉的 priceStepPct）→ 30+36+200+240。
  // 这一段的 `m` 是手搭的、`shopBlocked` 里只有回城卷轴，所以群疗符在这儿买得进来——
  // 真实局里它两个模式都禁售（§3.1 #20，下面另有一条用例），这里保留它只是为了钉住 §155 的涨价修复。
  assert.equal(m.stats.potionGold, 506, '药钱按**实际成交价**累计');
  assert.equal(buyItem(m, 'book_secret'), true);
  assert.equal(m.hero.skillUnlocked[2], true);
  assert.equal(buyItem(m, 'book_secret'), false, '秘传限购 1 本');
  // §5.5.1 回城卷轴：塔防里人物不下防线、商店就在核心旁，买了纯属白扔 80 金 → 内核直接拒绝
  const goldBefore = m.gold;
  assert.equal(buyItem(m, 'scroll_town'), false, '塔防里不该能买回城卷轴');
  assert.equal(m.gold, goldBefore, '拒了就不该扣钱');
  delete m.shopBlocked;                  // 防守模式没这张表 → 卖，而且要到手（以前只写一行日志，钱花了东西没进包）
  assert.equal(buyItem(m, 'scroll_town'), true);
  assert.equal(m.scrolls, 1, '买到的卷轴要真的进包');
  assert.equal(SHOP_ITEMS.length, 8);
});

test('§5.5 药品统计：买一次、用一次，都记在真局的 m.stats 里（`npm run potions` 的读数口）', () => {
  // 用真局而不是手搭的对象：上面那个商店用例是手工 stub，`describe()` 要读 m.wave / m.core，
  // 把 stub 越补越胖只会离真局越来越远（补到最后测的是 stub 不是实现）
  const m = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 3 });
  m.gold = 5000;
  assert.deepEqual([describeMatch(m).potions, describeMatch(m).potionGold], [0, 0], '开局两个计数都是 0');
  assert.equal(buyItem(m, 'pot_small'), true, '备战期买药是秒到');
  m.potionCd = {};
  assert.equal(usePotion(m, 'pot_small'), true);
  assert.equal(describeMatch(m).potions, 1, '用一次记一次');
  assert.equal(describeMatch(m).potionGold, 30, '药钱按成交价记（从塔的预算里抠的钱；§3.1 #17 把小药基准价降到 30）');
});

test('§5.5 补给有代价：波次进行中买东西要读条 3 秒，备战期是秒到', () => {
  const m = createMatch({ mapId: 'map_01', heroId: 'hero_warrior', seed: 5 });
  m.gold = 1000;
  // 备战期：钱货两清，立刻到手
  assert.equal(buyItem(m, 'pot_small'), true);
  assert.equal(m.bag.pot_small, 1);
  assert.equal(m.shopCast, null);

  // 开波之后再买：钱先扣、货要等读条走完（这就是「什么时候补给」的决策成本）
  assert.equal(startWaveEarly(m), true);
  update(m, TICK_STEP);
  assert.equal(m.wave.phase, 'spawning', '前置：波次已经在跑');
  const goldBefore = m.gold;
  assert.equal(buyItem(m, 'pot_small'), true);
  assert.equal(goldBefore - m.gold, 36, '第二次买 = 30 × 1.2，钱先扣（§3.1 #17 降价后）');
  assert.equal(m.bag.pot_small, 1, '读条没走完不能到手');
  assert.ok(m.shopCast && Math.abs(m.shopCast.until - (m.time + 3)) < 1e-6, '读条 3 秒');
  assert.equal(buyItem(m, 'pot_large'), false, '读条中不能再下单（也别重复扣钱）');

  for (let i = 0; i < 58; i++) update(m, TICK_STEP);      // 2.9 秒
  assert.equal(m.bag.pot_small, 1, '2.9 秒时还没到');
  for (let i = 0; i < 4; i++) update(m, TICK_STEP);       // 再 0.2 秒 → 过 3 秒
  assert.equal(m.bag.pot_small, 2, '读条走完才到手');
  assert.equal(m.shopCast, null);
});

test('§5.2 / §5.4 装备真的进战斗数值（以前它只进「哪件更强」和界面的品质色）', () => {
  const m = createMatch({ mapId: 'map_01', heroId: 'hero_warrior', seed: 3 });
  const base = heroStats(m.hero);
  // 三件手工装备：主属性 + 词条各来几条（数值都是文档里的原型：主属性 10、词条 3-6%）
  m.equipped.weapon = { uid: 't1', slot: 'weapon', quality: 'purple', ilvl: 10, baseAttrs: { attack: 22 }, affixes: [{ id: 'critRate', value: 0.05 }, { id: 'armorPierce', value: 0.12 }] };
  m.equipped.armor = { uid: 't2', slot: 'armor', quality: 'blue', ilvl: 8, baseAttrs: { def: 7 }, affixes: [{ id: 'maxHp', value: 60 }, { id: 'dmgReduce', value: 0.05 }, { id: 'hpRegen', value: 3 }] };
  m.equipped.trinket = { uid: 't3', slot: 'trinket', quality: 'blue', ilvl: 6, baseAttrs: { critRate: 0.05 }, affixes: [{ id: 'goldFind', value: 0.10 }, { id: 'attack', value: 8 }] };
  const geared = heroStats(m.hero);

  assert.equal(geared.attack, base.attack + 22 + 8, '武器/饰品的攻击是**加法**（§5.1 主属性「攻击 +10」）');
  assert.equal(geared.def, base.def + 7, '护甲的主属性进防御');
  assert.equal(geared.maxHp, base.maxHp + 60, '「生命 +60」是上限里的固定值');
  assert.ok(Math.abs(geared.critRate - (base.critRate + 0.05 + 0.05)) < 1e-9, '饰品主属性 + 词条的暴击率都要进');
  assert.equal(geared.armorPierce, 0.12);
  assert.equal(geared.goldFind, 0.10);
  assert.ok(heroDamageReduce(m) >= 0.05, '「减伤」词条要进受击减伤');

  // 赏金：+10% 金币掉落只作用在击杀赏金上
  const def = MONSTERS.mob_01;
  const mon = {
    uid: 1, mobId: 'mob_01', def, pathIndex: 0, dist: 0, cell: { x: 0, y: 4 },
    hp: 10, maxHp: def.hp, armor: def.armor, armorType: def.armorType, speed: 0,
    attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
  };
  m.monsters.push(mon);
  const gold0 = m.gold;
  damageMonster(m, mon, 9999, 'tw_arrow');
  assert.equal(m.gold - gold0, Math.round(def.bounty * m.bountyMul * 1.10), '击杀赏金按 +10% 金币掉落结算');

  // 反证：把装备全摘了，一切回到裸装数值
  m.equipped.weapon = null; m.equipped.armor = null; m.equipped.trinket = null;
  assert.deepEqual(heroStats(m.hero), base, '摘光装备就该回到裸装（说明这些数确实是从装备来的）');
});

test('§4.1 武器分类：4 类武器的攻击档与特性都真的生效', () => {
  // §3.5 的两个技能细节（都写在技能表里、此前没实现）
  {
    const mk = (mobId, heroId = 'hero_paladin') => {
      const m = createMatch({ mapId: 'map_01', heroId, seed: 3 });
      m.rng = () => 0.5;
      const def = MONSTERS[mobId];
      const mon = {
        uid: 1, mobId, def, pathIndex: 0, dist: 0, cell: { ...m.hero.cell }, hp: 1e9, maxHp: 1e9,
        armor: def.armor, armorType: def.armorType, speed: 0, attack: def.attack, atkSpeed: def.atkSpeed,
        cooldown: 0, isAir: !!def.isAir, effects: [], dead: false, attacking: false,
      };
      m.monsters.push(mon);
      return { m, mon };
    };
    // 制裁之锤：普通怪 1.5s，Boss 减半 0.75s（§3.5）
    const stunOf = (mobId) => {
      const { m, mon } = mk(mobId);
      m.hero.level = 15;
      m.hero.skillUnlocked = [true, true, true];
      assert.equal(castSkill(m, 2), true, '制裁之锤该放得出来');
      const e = mon.effects.find((x) => x.type === 'stun');
      assert.ok(e, `${mobId} 该被眩晕`);
      return +(e.until - m.time).toFixed(2);
    };
    assert.equal(stunOf('mob_04'), 1.5, '普通/精英怪吃满 1.5 秒');
    assert.equal(stunOf('boss_01'), 0.75, '§3.5：对 Boss 眩晕减半为 0.75 秒');

    // 猎人印记：「目标受到伤害 +20%/35%」要对**所有来源**生效——塔的弹道早就算它了，英雄自己的普攻以前不算
    const hitWith = (mark) => {
      const { m, mon } = mk('mob_04', 'hero_ranger');
      if (mark) mon.effects.push({ type: 'mark', until: m.time + 5, value: mark });
      const before = mon.hp;
      heroAttack(m, mon);
      return before - mon.hp;
    };
    const plain = hitWith(0);
    const marked = hitWith(0.2);
    assert.ok(Math.abs(marked / plain - 1.2) < 0.05, `带印记该 +20%（无印记 ${plain} → 带印记 ${marked}）`);
  }
  // 表就是文档 §4.1 那张（首发 4 类；wp_crossbow / wp_shield 按 §3.8 延后）
  assert.deepEqual(WEAPON_IDS, ['wp_sword', 'wp_bow', 'wp_staff', 'wp_totem']);
  const expect = {
    wp_sword: ['normal', 1.2, 1.1], wp_bow: ['pierce', 7.5, 1.4], wp_staff: ['magic', 6.0, 0.9], wp_totem: ['magic', 5.0, 1.0],
  };
  for (const [id, [type, range, speed]] of Object.entries(expect)) {
    assert.equal(WEAPONS[id].attackType, type, `${id} 攻击类型`);
    assert.equal(WEAPONS[id].range, range, `${id} 射程`);
    assert.equal(WEAPONS[id].atkSpeed, speed, `${id} 攻速`);
  }
  assert.deepEqual(WEAPONS.wp_bow.special, { vsAir: 0.25 });
  assert.equal(WEAPONS.wp_staff.special.splashRadius, 1.5);
  assert.equal(WEAPONS.wp_totem.special.slowPct, 0.2);
  assert.equal(WEAPONS.wp_totem.special.slowStacks, 2);
  assert.equal(WEAPONS.wp_sword.special.sector, 3);

  // 掉落必带类型（护甲不带），40 件里 4 类都该出现过
  const m = createMatch({ mapId: 'map_01', heroId: 'hero_warrior', seed: 5 });
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(makeEquipment(m, 'weapon', 'blue', 5).weaponId);
  assert.equal(seen.size, 4, `40 件武器里 4 类都该出现，实际 ${[...seen].join('/')}`);
  assert.equal(makeEquipment(m, 'armor', 'blue', 5).weaponId, undefined, '护甲没有武器类型');

  // 赤手空拳用职业档（§3.1），拿起武器就用武器档（§4.1）——以前这两者完全一样
  const ranger = createMatch({ mapId: 'map_01', heroId: 'hero_ranger', seed: 6 });
  assert.equal(heroStats(ranger.hero).attackType, 'pierce', '裸装游侠是穿刺');
  const bow = makeEquipment(ranger, 'weapon', 'purple', 10); bow.weaponId = 'wp_bow';
  ranger.equipped.weapon = bow;
  const bs = heroStats(ranger.hero);
  assert.deepEqual([bs.attackType, bs.range, bs.atkSpeed], ['pierce', 7.5, 1.4]);
  const staff = makeEquipment(ranger, 'weapon', 'purple', 10); staff.weaponId = 'wp_staff';
  ranger.equipped.weapon = staff;
  assert.equal(heroStats(ranger.hero).attackType, 'magic', '换成法杖就是魔法伤害');
  assert.equal(heroStats(ranger.hero).range, 6);
});

test('§4.1 武器特性：长弓对空 +25% / 法杖溅射 / 图腾减速叠 2 层 / 剑打 3 个', () => {
  /** 建一局，英雄拿指定类型、把武器主属性清零（只量特性），再把若干只怪摆在英雄身边 */
  const setup = (weaponId, mobs) => {
    const m = createMatch({ mapId: 'map_01', heroId: 'hero_warrior', seed: 7 });
    const w = makeEquipment(m, 'weapon', 'white', 1);
    w.weaponId = weaponId;
    w.baseAttrs = { attack: 0 };
    w.affixes = [];
    m.equipped.weapon = w;
    m.rng = () => 0.5;                     // 不暴击、浮动 1.0 → 伤害是定值
    const placed = mobs.map((mobId, i) => {
      const def = MONSTERS[mobId];
      const mon = {
        uid: i + 1, mobId, def, pathIndex: 0, dist: 0, cell: { x: m.hero.cell.x + (i % 2), y: m.hero.cell.y },
        hp: 1e9, maxHp: 1e9, armor: def.armor, armorType: def.armorType, speed: 0,
        attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir: !!def.isAir, effects: [], dead: false, attacking: false,
      };
      m.monsters.push(mon);
      return mon;
    });
    return { m, placed };
  };
  const loss = (mon) => mon.maxHp - mon.hp;

  // 长弓：对空 +25%。两只怪必须**护甲值与护甲类型都一样**（mob_03 空中 / mob_11 地面，都是护甲 2 中甲），
  // 否则比出来的是护甲差而不是对空加成（第一版就写歪了：0.75 倍率下 26/22 = 1.18）
  const air = setup('wp_bow', ['mob_03', 'mob_11']);
  heroAttack(air.m, air.placed[0]);
  heroAttack(air.m, air.placed[1]);
  const [airLoss, groundLoss] = [loss(air.placed[0]), loss(air.placed[1])];
  assert.ok(Math.abs(airLoss / groundLoss - 1.25) < 0.05,
    `长弓打空中该 +25%（空中 ${airLoss} vs 地面 ${groundLoss}）`);

  // 法杖：命中点半径 1.5 格内**按距离衰减**（§7.1：落点 100% → 边缘 50%）。
  // 两只怪相隔 1 格（曼哈顿）→ 衰减系数 = 1 − 0.5×(1/1.5) = 66.7%。
  // 改前这里一律乘 0.75，而这条断言的容差写的是 0.15——**刚好把改成衰减后的 66.7% 也放过去了**（§83.3），
  // 所以容差收到 0.03，并把「越远越低」的形状单独测一条（下一条用例）。
  const staff = setup('wp_staff', ['mob_04', 'mob_04']);
  heroAttack(staff.m, staff.placed[0]);
  const [main, side] = [loss(staff.placed[0]), loss(staff.placed[1])];
  assert.ok(main > 0 && side > 0, `法杖该溅射到旁边的怪（主 ${main} / 副 ${side}）`);
  assert.ok(Math.abs(side / main - (1 - 0.5 / 1.5)) < 0.03,
    `半径 1.5、距离 1 → 66.7%（主 ${main} / 副 ${side}）`);

  // 剑/刃：一次打 3 个（原型没有朝向，用「最近的 3 个」代替扇形）
  const sword = setup('wp_sword', ['mob_01', 'mob_01', 'mob_01', 'mob_01']);
  heroAttack(sword.m, sword.placed[0]);
  const hit = sword.placed.filter((x) => loss(x) > 0).length;
  assert.equal(hit, 3, `剑/刃该打 3 个目标，实际 ${hit} 个`);

  // 图腾：命中挂 2 秒 20% 减速，第二下叠到 40%（可叠 2 层），不无限叠
  const totem = setup('wp_totem', ['mob_04']);
  const target = totem.placed[0];
  heroAttack(totem.m, target);
  assert.equal(target.effects.find((e) => e.type === 'slow')?.pct, 0.2, '第一下 20%');
  heroAttack(totem.m, target);
  assert.equal(target.effects.find((e) => e.type === 'slow')?.pct, 0.4, '第二下叠到 40%');
  heroAttack(totem.m, target);
  assert.equal(target.effects.find((e) => e.type === 'slow')?.pct, 0.4, '第三下仍封顶 40%');
});

test('§7.1 溅射的距离衰减：越远越低，落点 100%、半径边缘正好 50%', () => {
  // 纯函数的形状（三处溅射共用这一个函数，改坏了它三处一起坏）
  assert.equal(splashScale(0, 1.5), 1, '落点满伤');
  assert.equal(splashScale(0.75, 1.5), 0.75, '中点 75%');
  assert.equal(splashScale(1.5, 1.5), 0.5, '半径边缘 50%');
  assert.equal(splashScale(9, 1.5), 0.5, '超出半径按边缘算（不会变成减伤）');
  assert.equal(splashScale(1, 0), 1, '没有半径就是单体，不受影响');

  // 行为：半径放到 3 格，摆两只怪在 1 格与 3 格处——距离差要真的体现在伤害上
  const m = createMatch({ mapId: 'map_01', heroId: 'hero_warrior', seed: 7 });
  const w = makeEquipment(m, 'weapon', 'white', 1);
  w.weaponId = 'wp_staff';
  w.baseAttrs = { attack: 0 };
  w.affixes = [];
  m.equipped.weapon = w;
  m.rng = () => 0.5;                                   // 不暴击、浮动 1.0 → 伤害是定值
  const spawn = (dx, dy) => {
    const def = MONSTERS.mob_04;
    const mon = {
      uid: m.monsters.length + 1, mobId: 'mob_04', def, pathIndex: 0, dist: 0,
      cell: { x: m.hero.cell.x + dx, y: m.hero.cell.y + dy },
      hp: 1e9, maxHp: 1e9, armor: def.armor, armorType: def.armorType, speed: 0,
      attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir: !!def.isAir,
      effects: [], dead: false, attacking: false,
    };
    m.monsters.push(mon);
    return mon;
  };
  // 半径 6：三只怪分别在曼哈顿距离 0 / 2 / 6 → 衰减 100% / 83.3% / 50%
  // （特性来自**配置表**而不是装备实例：`heroStats` 是 `WEAPONS[weaponId]` 查出来的，所以要临时改表）
  const main = spawn(0, 0), near = spawn(1, 1), far = spawn(3, 3);
  const originalSpecial = WEAPONS.wp_staff.special;
  WEAPONS.wp_staff.special = { splashRadius: 6 };
  try {
    heroAttack(m, main);
  } finally {
    WEAPONS.wp_staff.special = originalSpecial;
  }
  const loss = (x) => x.maxHp - x.hp;
  const [a, b, c] = [loss(main), loss(near), loss(far)];
  assert.ok(a > b && b > c, `越远打得越少：落点 ${a} / 2 格 ${b} / 6 格 ${c}`);
  assert.ok(Math.abs(b / a - (1 - 2 / 12)) < 0.03, `2 格处 = 83.3%（落点 ${a} / ${b}）`);
  assert.ok(Math.abs(c / a - 0.5) < 0.03, `半径边缘 = 50%（落点 ${a} / ${c}）`);
});

test('塔造价的合法性（首发 4 种）', () => {
  assert.deepEqual(Object.keys(TOWERS).sort(), ['tw_arrow', 'tw_cannon', 'tw_frost', 'tw_static']);
  assert.equal(Object.keys(EQUIP_SLOTS).length, 3);
});

test('§5.2 掉落来源：精英按概率掉、Boss 必掉、第 6 波小 Boss 走精英表、宝箱表', () => {
  const mon = (id) => ({ def: MONSTERS[id], hp: 1, dead: false, pathIndex: 0, dist: 0, cell: { x: 1, y: 1 } });
  /** 把 rng 钉成固定序列：掉落判定与品质判定各取一次（不跑 update，就不会有别的消耗） */
  const rolls = (m, vals) => { let i = 0; m.rng = () => vals[Math.min(i++, vals.length - 1)]; };

  // 精英：0.9 > ELITE_DROP_CHANCE(0.15) → 不掉（第一版是「必掉」，实测三项超标的根因）
  const a = createMatch({ mapId: 'map_01', seed: 1 });
  rolls(a, [0.9]);
  damageMonster(a, mon('mob_10'), 1e6);
  assert.equal(a.stats.drops, 0, '精英该「按概率掉」，不是必掉');

  // 精英：0.1 ≤ 0.15 → 掉，且吃精英品质表（第一档是白 20%）
  const b = createMatch({ mapId: 'map_01', seed: 1 });
  rolls(b, [0.1, 0.1]);
  damageMonster(b, mon('mob_10'), 1e6);
  assert.equal(b.stats.drops, 1);
  assert.equal(b.inventory.at(-1).quality, 'white', '精英表：0.1 落在白（20%）');

  // 第 6 波小 Boss（boss_01 / bossTier minor）：§5.2 把它算在精英怪那一行
  const c = createMatch({ mapId: 'map_01', seed: 1 });
  rolls(c, [0.1, 0.3]);
  damageMonster(c, mon('boss_01'), 1e6);
  assert.equal(c.inventory.at(-1).quality, 'blue',
    '小 Boss 走精英表（0.3 → 蓝）；若误用 Boss 表，0.3 会落在紫（65%）');

  // 最终 Boss（boss_02）：必掉，哪怕判定值是 0.9
  const d = createMatch({ mapId: 'map_01', seed: 1 });
  rolls(d, [0.9, 0.9]);
  damageMonster(d, mon('boss_02'), 1e6);
  assert.equal(d.stats.drops, 1, '最终 Boss 必掉——它是唯一的橙装来源');
  assert.equal(d.inventory.at(-1).quality, 'orange', 'Boss 表：0.9 落在橙（15%）');

  // 波次宝箱（§5.2）：白 30 / 蓝 50 / 紫 20
  assert.deepEqual(DROP_TABLE.chest, { white: 0.30, blue: 0.50, purple: 0.20, orange: 0 });
});

// §6.2 的克制表是「5 攻击 × 5 护甲」的矩阵。两个枚举（`ATTACK_TYPES` / `ARMOR_TYPES`）里
// 之前只有护甲那个被读到过——攻击那个是**没有读取方的导出**（验证记录 §109）。
// 现在让它们当矩阵的坐标：加一种攻击类型却忘了补矩阵，这条就红。
test('§6.2 克制表与攻击/护甲枚举一一对应（枚举不许有孤儿，矩阵不许缺格）', () => {
  assert.deepEqual(Object.keys(DAMAGE_MATRIX), ATTACK_TYPES, '矩阵的行 = 攻击类型枚举');
  for (const atk of ATTACK_TYPES) {
    assert.deepEqual(Object.keys(DAMAGE_MATRIX[atk]), ARMOR_TYPES, `${atk} 这一行的列 = 护甲类型枚举`);
    for (const ar of ARMOR_TYPES) {
      assert.ok(typeof DAMAGE_MATRIX[atk][ar] === 'number', `${atk} × ${ar} 必须是数字`);
    }
  }
});

test('§10.7 配置表 schema：畸形数据不许上线（缺字段 / 类型错 / 引用不存在）', () => {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const pos = (v) => num(v) && v > 0;

  for (const [id, t] of Object.entries(TOWERS)) {
    assert.equal(t.id, id, `塔 ${id}：id 字段和键不一致`);
    assert.ok(t.name && pos(t.cost), `塔 ${id}：缺名字或造价非正数`);
    assert.ok(pos(t.damage) || t.damage === 0, `塔 ${id}：伤害必须是数字`);
    assert.ok(pos(t.atkSpeed) && pos(t.range), `塔 ${id}：攻速/射程必须是正数`);
    assert.ok(DAMAGE_MATRIX[t.attackType], `塔 ${id}：攻击类型 ${t.attackType} 不在克制表里`);
  }

  for (const [id, mo] of Object.entries(MONSTERS)) {
    assert.equal(mo.id, id, `怪物 ${id}：id 字段和键不一致`);
    assert.ok(['normal', 'elite', 'boss'].includes(mo.tier), `怪物 ${id}：tier 非法`);
    assert.ok(pos(mo.hp) && mo.armor >= 0 && pos(mo.speed), `怪物 ${id}：血量/护甲/移速非法`);
    assert.ok(pos(mo.coreDamage), `怪物 ${id}：对核心伤害必须 > 0`);
    assert.ok(ARMOR_TYPES.includes(mo.armorType), `怪物 ${id}：护甲类型 ${mo.armorType} 不在表里`);
    assert.ok(pos(mo.level), `怪物 ${id}：缺 level（§3.2 的经验公式要用）`);
  }

  for (const [id, def] of Object.entries(MAPS)) {
    assert.equal(def.id, id);
    const g = def.grid ?? { w: 32, h: 24 };
    assert.ok(pos(g.w) && pos(g.h), `地图 ${id}：画布尺寸非法`);
    for (const p of [...def.spawn, def.core, ...(def.cores ?? [])]) {
      assert.ok(p.x >= 0 && p.y >= 0 && p.x < g.w && p.y < g.h, `地图 ${id}：出生点/核心 (${p.x},${p.y}) 在画布外`);
    }
    assert.ok(pos(def.pathCount) && pos(def.coreHp) && pos(def.towerSlots), `地图 ${id}：路线/核心/塔位非法`);
    /**
     * §156：**地图表与「生成出来的图」对账**。`pathCount` / `towerSlots` 是给卡面与算平衡的人看的，
     * 真正跑的是 `buildMap()`——两边一旦不一致，卡面就在说假话（迷雾沼泽就是这样：
     * §2.2 写「2 + 1 空中」、`buildMap()` 真的多生成一条 `air: true` 的路，而卡面只印了 `pathCount`）。
     * `tests/maps-4star.test.js` 有一条 `paths.length === pathCount`，但它只跑 4★ 以上的图（那几张都没有
     * 空中航线），所以漏掉了这一张——这条把空中航线算进去，六张图全过。
     */
    const built = buildMap(def);
    const air = built.paths.filter((p) => p.air).length;
    assert.equal(air, def.airPath ? 1 : 0, `地图 ${id}：airPath=${!!def.airPath}，但生成出 ${air} 条空中航线`);
    assert.equal(built.paths.length, def.pathCount + air,
      `地图 ${id}：数据写 ${def.pathCount} 条路（+${air} 空中），生成出 ${built.paths.length} 条`);
    assert.equal(built.slots.length, def.towerSlots, `地图 ${id}：数据写 ${def.towerSlots} 个塔位，生成出 ${built.slots.length} 个`);
  }
  // §156：§2.2 的地图表里迷雾沼泽写的是「2 + 1 空中」——这条把「那张表说的机制」钉进数据，
  // 谁把空中航线删掉就会红（卡面与生成器都跟着它走）。
  assert.equal(MAPS.map_03.airPath, true, '§2.2：迷雾沼泽有空中航线（2 + 1 空中）');

  for (const [label, waves] of [['短局', WAVES], ['长局', WAVES_LONG]]) {
    waves.forEach((w, i) => {
      assert.equal(w.wave, i + 1, `${label}第 ${i + 1} 个波次的 wave 字段应该是 ${i + 1}`);
      assert.ok(w.groups.length > 0, `${label} 第 ${w.wave} 波没有出怪组`);
      for (const grp of w.groups) {
        assert.ok(MONSTERS[grp.mobId], `${label} 第 ${w.wave} 波引用了不存在的怪物 ${grp.mobId}`);
        assert.ok(pos(grp.count) && pos(grp.interval), `${label} 第 ${w.wave} 波的 ${grp.mobId}：数量/间隔必须是正数`);
      }
    });
  }

  for (const item of SHOP_ITEMS) {
    assert.ok(item.id && item.name && pos(item.priceGold), `商店 ${item.id}：缺名字或价格非正数`);
    assert.ok(QUALITY[item.quality ?? 'white'], `商店 ${item.id}：品质非法`);
    // §155：§5.5 的「同种涨价：每次 +20%」写的是**药品**，商店面板的提示也是这么说的——
    // 群体治疗符曾经漏了这个字段，于是它永远不涨价（提示与实际不符）。
    // ponytail: 只给药品种类要求；符/卷轴/技能书不在 §5.5 那条规则里。
    if (item.type === 'potion') {
      assert.ok(pos(item.priceStepPct), `商店 ${item.id}：药品必须给 priceStepPct（§5.5 的同种涨价）`);
    }
  }
  for (const [id, f] of Object.entries(FORTS)) {
    assert.ok(f.id === id && pos(f.cost) && pos(f.hp), `工事 ${id}：造价/血量非法`);
  }
  for (const [id, h] of Object.entries(HEROES)) {
    assert.ok(h.id === id && pos(h.hp) && pos(h.attack) && pos(h.moveSpeed), `英雄 ${id}：基础面板非法`);
    assert.equal(h.skills.length, 2, `英雄 ${id}：首发是 2 个主动技（§3.8）`);
    assert.ok(h.thirdSkill?.name, `英雄 ${id}：缺秘传第 3 技`);
    assert.equal(h.talents.length, 2, `英雄 ${id}：首发是 2 个天赋（§3.8）`);
    for (const s of [...h.skills, h.thirdSkill]) assert.ok(pos(s.cooldown) && pos(s.unlockLevel), `英雄 ${id} 的技能 ${s.name}：冷却/解锁等级非法`);
  }
  for (const [id, def] of Object.entries(DEFENSE_MAPS)) {
    assert.ok(def.id === id && pos(def.castleHp) && pos(def.grid.w), `防守图 ${id}：城堡血量/画布非法`);
    assert.ok(def.zones.length > 0 && def.fortSlots.length >= 8, `防守图 ${id}：野区或工事位不足`);
    assert.ok(def.assaultSpawns.length >= 1 && def.rounds.length >= 4, `防守图 ${id}：进攻路线或轮次不足`);
  }
});

/**
 * §169：**§2.2 的地图表逐列对账**。塔位/核心血量/路线数这些「一眼能对」的列钉住；
 * 「分道长度」那一列实现里对不上（生成器把每条道造成等长），已知偏差按下表钉住——
 * 谁把偏差修好了（或改坏了），这条会红，提醒去更新 STATUS 第 30 条与那张表。
 */
test('§169 §2.2 地图表：路线/出生点/塔位/核心血量对账，分道长度是已知偏差', () => {
  const DOC = {
    map_01: { lanes: 1, spawns: 1, slots: 18, coreHp: 2400, grounds: [58] },
    map_02: { lanes: 2, spawns: 2, slots: 22, coreHp: 3000, grounds: [62, 62] },
    map_03: { lanes: 2, air: 1, spawns: 3, slots: 24, coreHp: 3000, grounds: [68, 68], airLen: 34 },
    map_04: { lanes: 3, spawns: 3, slots: 28, coreHp: 3600, grounds: [76, 96, 112] },
    map_05: { lanes: 3, spawns: 4, slots: 26, coreHp: 4200, grounds: [88, 88, 64] },
    map_06: { lanes: 4, spawns: 4, slots: 32, coreHp: 4200, cores: 2, grounds: [100, 100, 100, 100] },
  };
  const len = (p) => Math.round(pathTotalUnits(p) / GRID.unitPerTile);
  for (const [id, want] of Object.entries(DOC)) {
    const def = MAPS[id];
    const built = buildMap(def);
    const ground = built.paths.filter((p) => !p.air);
    const air = built.paths.filter((p) => p.air);
    assert.equal(ground.length, want.lanes, `${id}：地面路线数（§2.2 写 ${want.lanes}）`);
    assert.equal(air.length, want.air ?? 0, `${id}：空中航线数（§2.2 写 ${want.air ?? 0}）`);
    assert.equal(def.towerSlots, want.slots, `${id}：塔位数（§2.2 写 ${want.slots}）`);
    assert.equal(def.coreHp, want.coreHp, `${id}：核心血量（§2.2 写 ${want.coreHp}）`);
    assert.equal(def.cores?.length ?? 1, want.cores ?? 1, `${id}：守护目标数（§2.2 写 ${want.cores ?? 1}）`);
    // 出生点 = 「有几条路就有几个入口」（`buildMap` 给空中航线也配一个入口，所以数生成出来的路）
    // map_05 是已知偏差（§2.2 写 4，实际 3——缺的那条是「背刺路」的入口，见 STATUS 第 30 条）
    if (id !== 'map_05') assert.equal(built.paths.length, want.spawns, `${id}：出生点/入口数（§2.2 写 ${want.spawns}）`);
    else assert.notEqual(built.paths.length, want.spawns, '§2.2 的 map_05「4 个出生点」是已知偏差（实际 3）');
    // 主道长度要**落在 §2.2 列出的那几个值里**（map_04 的表给了 76/96/112 三条道，实现取的是 96）
    const lens = ground.map(len);
    assert.ok(want.grounds.includes(lens[0]),
      `${id}：生成的主路 ${lens[0]} 格不在 §2.2 列出的长度里（${want.grounds.join('/')}）`);
    const exact = lens.join('/') === want.grounds.join('/');
    if (id === 'map_03') {
      assert.notEqual(len(air[0]), want.airLen, `§2.2 的空中 ${want.airLen} 格是已知偏差（实现 ${len(air[0])} 格）`);
    } else if (id === 'map_04' || id === 'map_05') {
      // §2.2 里这两张图的几条道**不一样长**（熔岩 76/96/112、亡者 88×2+背刺 64），实现是等长的
      assert.ok(!exact, `${id} 的分道长度是已知偏差（§2.2 写 ${want.grounds.join('/')}，实现 ${lens.join('/')}）`);
    } else {
      assert.ok(exact, `${id}：分道长度要与 §2.2 一致（写 ${want.grounds.join('/')}，实现 ${lens.join('/')}）`);
    }
  }
});

/**
 * §170：**其余数值表逐列对账**（§2.4 难度 / §3.1 英雄 / §4.1 武器 / §8.1 塔 / §6.x 怪物）。
 * §169 只对了地图表；这一条把剩下几张「设计文档说是多少、实现就该是多少」的表一起钉住——
 * 数值改了但文档没改（或反过来）都会红。**只钉「不是待拍板项」的那些行**：
 * Boss 血量正在等 §8.6 拍板（STATUS 第 1/2 条），所以怪表里跳过三个 Boss。
 */
test('§170 数值表与设计文档逐列对账（难度 / 英雄 / 武器 / 塔 / 小怪）', () => {
  // §2.4 难度倍率（出怪速度那列见验证记录 §70）
  const DIFF = { normal: [1, 1, 1, 1], hard: [1.35, 1.25, 1.1, 1.25], nightmare: [1.8, 1.55, 1.2, 1.5] };
  for (const [id, want] of Object.entries(DIFF)) {
    assert.deepEqual([DIFFICULTY[id].hp, DIFFICULTY[id].atk, DIFFICULTY[id].spawn, DIFFICULTY[id].drop], want,
      `§2.4：${id} 的 生命/攻击/出怪/掉落 倍率`);
  }
  // §3.1 职业与基础属性（1 级裸装）
  const HERO = {
    hero_warrior: [900, 32, 4, 1.1, 320, 1.2, 'normal'],
    hero_mage: [520, 18, 1, 0.9, 300, 6.0, 'magic'],
    hero_ranger: [620, 26, 2, 1.6, 330, 7.5, 'pierce'],
    hero_paladin: [800, 20, 5, 1.0, 310, 3.0, 'normal'],
  };
  for (const [id, want] of Object.entries(HERO)) {
    const h = HEROES[id];
    assert.deepEqual([h.hp, h.attack, h.def, h.atkSpeed, h.moveSpeed, h.range, h.attackType], want,
      `§3.1：${id} 的 生命/攻击/防御/攻速/移速/射程/攻击类型`);
  }
  // §4.1 武器（首发 4 类；攻速列见 §3.1 的「游侠 1.6」注——那是待拍板项）
  const WEAPON = {
    wp_sword: ['normal', 1.2, 1.1], wp_bow: ['pierce', 7.5, 1.4],
    wp_staff: ['magic', 6.0, 0.9], wp_totem: ['magic', 5.0, 1.0],
  };
  assert.deepEqual(Object.keys(WEAPONS), Object.keys(WEAPON), '§4.1：首发就这 4 类武器（重弩/战盾延后）');
  for (const [id, want] of Object.entries(WEAPON)) {
    const w = WEAPONS[id];
    assert.deepEqual([w.attackType, w.range, w.atkSpeed], want, `§4.1：${id} 的 攻击类型/射程/攻速`);
  }
  // §8.1 塔（首发 4 类 + 特性数值）
  const TOWER = {
    tw_arrow: [60, 'normal', 18, 1.5, 5.0, true],
    tw_cannon: [150, 'siege', 40, 0.8, 6.0, false],
    tw_frost: [120, 'magic', 8, 1.0, 4.5, true],
    tw_static: [260, 'magic', 30, 1.0, 5.5, true],
  };
  assert.deepEqual(Object.keys(TOWERS), Object.keys(TOWER), '§8.1：首发就这 4 种塔（火焰塔/光环塔延后）');
  for (const [id, want] of Object.entries(TOWER)) {
    const t = TOWERS[id];
    assert.deepEqual([t.cost, t.attackType, t.damage, t.atkSpeed, t.range, !!t.hitsAir], want,
      `§8.1：${id} 的 造价/攻击类型/伤害/攻速/射程/对空`);
  }
  assert.deepEqual(TOWERS.tw_cannon.special, { splashRadius: 1.5 }, '§8.1：炮塔溅射 1.5 格');
  assert.deepEqual(TOWERS.tw_frost.special, { slowPct: 0.3, slowSec: 2 }, '§8.1：冰塔减速 30% / 2 秒');
  assert.deepEqual(TOWERS.tw_static.special, { chainCount: 3, chainDecay: 0.2, chainRange: 3 }, '§8.1：静电塔链 3 目标、每跳 −20%');
  // §6.x 怪物表（跳过三个 Boss：它们的血量正等 §8.6 拍板）
  const MOB = {
    mob_01: [1, 90, 1, 'medium', 8, 1.0, 300, 12, 0, 60],
    mob_02: [2, 70, 0, 'light', 6, 1.3, 380, 14, 0, 60],
    mob_03: [3, 110, 2, 'medium', 10, 1.1, 330, 20, 0, 70],
    mob_04: [4, 220, 3, 'heavy', 16, 0.8, 260, 26, 0, 90],
    mob_10: [7, 900, 6, 'fortified', 30, 1.0, 240, 120, 2, 220],
    mob_11: [7, 700, 2, 'medium', 22, 1.2, 300, 130, 2, 200],
    mob_12: [8, 650, 1, 'unarmored', 18, 1.0, 280, 140, 2, 210],
  };
  for (const [id, want] of Object.entries(MOB)) {
    const mo = MONSTERS[id];
    assert.deepEqual([mo.level, mo.hp, mo.armor, mo.armorType, mo.attack, mo.atkSpeed, mo.speed, mo.bounty, mo.lumber, mo.coreDamage],
      want, `§6.x：${id} 的 等级/血量/护甲/护甲类型/攻击/攻速/移速/赏金/木材/核心伤害`);
  }
});

test('§8.6 / 附录 B：Lv20 英雄的单体 DPS ≤ 1 座 3 级静电塔的 2.5 倍（英雄不能顶掉塔）', () => {
  const limit = towerDps('tw_static', 3) * 2.5;
  for (const id of Object.keys(HEROES)) {
    const hero = createMatch({ mapId: 'map_01', heroId: id, seed: 1 }).hero;
    hero.level = 20;
    const s = heroStats(hero);
    const dps = s.attack * s.atkSpeed;
    assert.ok(dps <= limit, `${id} Lv20 单体 DPS ${dps.toFixed(1)} 超过上限 ${limit.toFixed(1)}（3 级静电塔 ${towerDps('tw_static', 3).toFixed(1)} × 2.5）`);
  }
});

test('§3.1 #3：DPS 线按**满装口径**——Lv20 + 一套紫 ilvl15 三件套 ≤ 4 座 3 级静电塔', () => {
  // 上一条是**裸装**口径（≤2.5 座），这条是拍板后的正式口径（§3.1 #3：不压装备数值，把线按满装改写）。
  // 一套紫 ilvl15 三件套 = 一局真能拿到的水平（§5.2 的掉落节奏：一局 12.3 件、紫 2.0 件）。
  const set = {
    weapon: { uid: 'w', slot: 'weapon', quality: 'purple', ilvl: 15, baseAttrs: { attack: 33 }, affixes: [{ id: 'critRate', value: 0.05 }, { id: 'critDmg', value: 0.3 }] },
    armor: { uid: 'a', slot: 'armor', quality: 'purple', ilvl: 15, baseAttrs: { def: 12, hp: 120 }, affixes: [{ id: 'atkSpeed', value: 0.1 }, { id: 'hpRegen', value: 2 }] },
    trinket: { uid: 't', slot: 'trinket', quality: 'purple', ilvl: 15, baseAttrs: { attack: 10 }, affixes: [{ id: 'critRate', value: 0.05 }, { id: 'goldFind', value: 0.1 }] },
  };
  const limit = towerDps('tw_static', 3) * 4;
  const dps = {};
  for (const id of Object.keys(HEROES)) {
    const hero = createMatch({ mapId: 'map_01', heroId: id, seed: 1 }).hero;
    hero.level = 20;
    hero.equipped = { weapon: set.weapon, armor: set.armor, trinket: set.trinket };
    const s = heroStats(hero);
    dps[id] = s.attack * s.atkSpeed;
    assert.ok(dps[id] <= limit,
      `${id} 满装 DPS ${dps[id].toFixed(1)} 超过 ${limit.toFixed(1)}（4 座 3 级静电塔）`);
  }
  // 反向自查：这条线得**有阻力**——把武器换成橙 ilvl15 的同部位就该压不住（否则它是句空断言）
  const hero = createMatch({ mapId: 'map_01', heroId: 'hero_ranger', seed: 1 }).hero;
  hero.level = 20;
  hero.equipped = { ...set, weapon: { ...set.weapon, quality: 'orange', baseAttrs: { attack: 99 }, affixes: [] } };
  const s = heroStats(hero);
  assert.ok(s.attack * s.atkSpeed > limit,
    `把武器换成一击 99 的橙装应当越线（实测 ${(s.attack * s.atkSpeed).toFixed(1)} vs ${limit.toFixed(1)}）`);
});

test('§8.5 / 附录 B：最贵的塔 3 波内就攒得出来（否则没人造）', () => {
  const priciest = Math.max(...Object.values(TOWERS).map((t) => t.cost));
  let gold = 0;
  for (const w of WAVES.slice(0, 3)) {
    gold += w.groups.reduce((s, g) => s + MONSTERS[g.mobId].bounty * g.count, 0) * ECONOMY.bountyMul
      + ECONOMY.waveGold(w.wave);
  }
  assert.ok(gold >= priciest, `前 3 波总收入 ${Math.round(gold)} 应该买得下最贵的塔（${priciest} 金）`);
});

test('§12.1 内核不许知道「模式」：core.js / match.js 里不能出现按模式分支的代码', async () => {
  const { readFile } = await import('node:fs/promises');
  // 自查一下正则本身有效（免得哪天它写得连自己都匹配不到，变成一句空断言）
  const pattern = /\.mode\s*[!=]==?\s*['"]defense['"]|['"]defense['"]\s*[!=]==?\s*[a-zA-Z_$][\w$.]*\.mode/;
  assert.ok(pattern.test("if (m.mode === 'defense') return;"), '正则要能认出真正的模式分支');

  const offenders = [];
  for (const file of ['../src/core.js', '../src/match.js']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (pattern.test(line)) offenders.push(`${file}:${i + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    `内核里出现了按模式分支的代码（§12.1 铁律：模式差异要走插件缝，别塞进内核）：\n${offenders.join('\n')}`);
});

// §117：怪物光环按 `radius` 作用到半径内的同伴（含携带者）。
// 以前内核只读了 `atkSpeedPct`，而且是「谁开火谁加」——等于 Boss 自带攻速，`radius` 没人读；
// mob_12（亡灵巫师）的 `aura: { id:'heal', radius:3, hps:20 }` 整条没实现（资料表写着「精英·治疗光环」）。
test('§117 光环按半径结算：治疗光环真的治人，攻速光环只作用在半径内（含自己）', () => {
  const m = createMatch({ mapId: 'map_06', seed: 11 });   // Boss 光环只在 map_06 生效（§118）
  m.hero.dead = true;                      // 让怪不打架、英雄不开火：这一局只观测光环
  m.hero.reviveTimer = 999;
  const path = m.map.paths[0];
  const put = (mobId, cellIndex, hp) => {
    const def = MONSTERS[mobId];
    const mon = {
      uid: 900 + cellIndex, mobId, def, pathIndex: 0, dist: cellIndex * GRID.unitPerTile + 1,
      cell: path.cells[cellIndex], hp, maxHp: def.hp, armor: def.armor, armorType: def.armorType,
      speed: 0, attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir: !!def.isAir,
      effects: [], dead: false, attacking: false,
    };
    m.monsters.push(mon);
    return mon;
  };
  // 位置要按**几何距离**挑，不能按路径下标猜：路径是绕来绕去的，下标差 10 的两点可能是隔壁格。
  const cellOf = (i) => path.cells[i];
  const gap = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const pick = (from, lo, hi) => path.cells.findIndex((c) => { const d = gap(c, from); return d >= lo && d <= hi; });
  const healerIdx = 2;
  const bossIdx = Math.min(40, path.cells.length - 1);
  const healer = put('mob_12', healerIdx, MONSTERS.mob_12.hp);
  const near = put('mob_01', pick(cellOf(healerIdx), 1, 3), 10);        // 巫师半径 3 内
  const boss = put('boss_02', bossIdx, MONSTERS.boss_02.hp);
  const nearBoss = put('mob_01', pick(cellOf(bossIdx), 1, 3), 10);      // Boss 半径 3 内
  let farIdx = 0, farGap = -1;
  path.cells.forEach((c, i) => {
    const d = Math.min(gap(c, cellOf(healerIdx)), gap(c, cellOf(bossIdx)));
    if (d > farGap) { farGap = d; farIdx = i; }
  });
  assert.ok(farGap > 6, `地图上要有一个离两个光环都足够远（> 两者半径）的格子（实际最远 ${farGap}）`);
  const far = put('mob_01', farIdx, 10);

  assert.equal(auraAt(m, near).atkSpeedPct, 0, '半径内只有巫师（治疗），没有攻速光环');
  assert.equal(auraAt(m, nearBoss).atkSpeedPct, MONSTERS.boss_02.aura.atkSpeedPct, '半径内的怪吃到 Boss 攻速光环');
  assert.equal(auraAt(m, boss).atkSpeedPct, MONSTERS.boss_02.aura.atkSpeedPct, '携带者自己也算在光环里');
  assert.equal(auraAt(m, far).atkSpeedPct, 0, '半径外吃不到（radius 以前根本没人读）');

  const hps = MONSTERS.mob_12.aura.hps;     // 20 生命/秒
  const before = { near: near.hp, far: far.hp, healer: healer.hp };
  for (let i = 0; i < 20; i += 1) update(m, 0.05);   // 整整 1 秒
  assert.ok(Math.abs((near.hp - before.near) - hps) < 0.5,
    `半径内的怪 1 秒该回 ${hps} 点血，实际 ${(near.hp - before.near).toFixed(1)}`);
  assert.equal(far.hp, before.far, '半径外一滴都不该回');
  assert.equal(healer.hp, before.healer, '巫师自己满血，治疗不该溢出上限');
});

// §118：§2.2 的地图表把「Boss 带光环」写成 map_06 的独有地形特性（数据里就是 `bossAura: true`），
// 但这个字段以前一处读取方都没有——于是每张图的 Boss 都自带光环。
test('§118 Boss 光环按地图开关：只有 map_06 的 Boss 带光环，精英怪的治疗光环不受影响', () => {
  const setup = (mapId) => {
    const m = createMatch({ mapId, seed: 7 });
    m.hero.dead = true;
    m.hero.reviveTimer = 999;
    const path = m.map.paths[0];
    const put = (mobId, cellIndex, hp) => {
      const def = MONSTERS[mobId];
      const mon = {
        uid: 800 + cellIndex, mobId, def, pathIndex: 0, dist: cellIndex * GRID.unitPerTile + 1,
        cell: path.cells[cellIndex], hp, maxHp: def.hp, armor: def.armor, armorType: def.armorType,
        speed: 0, attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir: !!def.isAir,
        effects: [], dead: false, attacking: false,
      };
      m.monsters.push(mon);
      return mon;
    };
    return { m, path, put };
  };

  for (const [mapId, expectBossAura] of [['map_01', false], ['map_06', true]]) {
    const { m, path, put } = setup(mapId);
    const gap = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    const bossIdx = Math.min(40, path.cells.length - 1);
    const boss = put('boss_02', bossIdx, MONSTERS.boss_02.hp);
    const mateIdx = path.cells.findIndex((c) => gap(c, path.cells[bossIdx]) >= 1 && gap(c, path.cells[bossIdx]) <= 3);
    const mate = put('mob_01', mateIdx, 10);
    assert.equal(auraAt(m, boss).atkSpeedPct, expectBossAura ? MONSTERS.boss_02.aura.atkSpeedPct : 0,
      `${mapId}：Boss 自己${expectBossAura ? '该' : '不该'}吃到光环`);
    assert.equal(auraAt(m, mate).atkSpeedPct, expectBossAura ? MONSTERS.boss_02.aura.atkSpeedPct : 0,
      `${mapId}：Boss 旁边的怪${expectBossAura ? '该' : '不该'}被加速`);
  }

  // 非 Boss 的光环与地图无关：map_01（没有 bossAura）上，亡灵巫师照样治人
  const { m, path, put } = setup('map_01');
  const healerIdx = 2;
  const healer = put('mob_12', healerIdx, MONSTERS.mob_12.hp);
  const gap = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const nearIdx = path.cells.findIndex((c) => gap(c, path.cells[healerIdx]) >= 1 && gap(c, path.cells[healerIdx]) <= 3);
  const near = put('mob_01', nearIdx, 10);
  for (let i = 0; i < 20; i += 1) update(m, 0.05);
  assert.ok(Math.abs((near.hp - 10) - MONSTERS.mob_12.aura.hps) < 0.5,
    `精英怪的治疗光环不该被地图开关关掉（实际回了 ${(near.hp - 10).toFixed(1)}）`);
});

// §132：精研技能书（300 金、限购 2）写的是「技能等级 +1」。以前 `castSkill` 里那半截
// `+ (h.def.skills.includes(def) ? 0 : 0)` 是占位符，`m.bookLevelBonus` 根本没被读过——
// 买了没有任何效果（客户端技能行还有一份内联的同样公式，也一样不认它）。
// 这条用**圣光术**量（治疗量没有护甲/克制干扰）：Lv1 = 200，Lv2 = 500（§3.5 的「1 级 / 5 级满」表）。
// STATUS §3.1 #26（已拍板）：精研书 = 「把一档拉满」（本代只有 2 档），所以限购从 2 改成 **1**：
// 再买一本不会有任何变化（以前那第二本卖 300 金却什么都不加，是同一个「陷阱商品」形状）。
test('§132 精研技能书真的 +1 档：治疗量从 Lv1 跳到 Lv2（=满档），限购 1', () => {
  const m = createMatch({ mapId: 'map_01', heroId: 'hero_paladin', seed: 3 });
  const h = m.hero;
  const def = h.def.skills[0];                       // 圣光术
  h.skillUnlocked = [true, true, true];
  const healOnce = () => {
    h.hp = 1;                                        // 压到 1 血，好量治疗量
    h.skillCd = [0, 0, 0];
    assert.equal(castSkill(m, 0), true, '圣光术该放得出来');
    return Math.round(h.hp - 1);
  };

  assert.equal(skillLevel(m, def), 1, '1 级英雄：技能 1 级');
  assert.equal(healOnce(), 200, 'Lv1 圣光术 = 200');

  m.gold = 1000;
  assert.equal(buyItem(m, 'book_up'), true, '第一本精研书该买得到');
  assert.equal(m.bookLevelBonus, 1);
  assert.equal(skillLevel(m, def), 2, '精研书 +1 档');
  assert.equal(healOnce(), 500, 'Lv2 圣光术 = 500（这就是书的实际效果）');

  assert.equal(buyItem(m, 'book_up'), false, '第二本该被限购拦下（只有 2 档，一本就拉满）');
  assert.equal(m.bookLevelBonus, 1, '买不进就不该再涨');

  // 封顶 2 档：满级英雄也超不过表里的第 2 档
  h.level = 25;
  assert.equal(skillLevel(m, def), 2, '本代只有 2 档（§3.1 #26）');
});

// §133：加成要**从还活着的 buff 重算**，而不是「按 buff 类型清零」。
// 以前 heroStep 里只认 `type === 'atk' / 'reduce'`（战吼 / 守护结界），于是狂战药剂那种
// `type: 'elixir'` 的 +25% 攻击在**下一个 tick** 就被抹掉——150 金买了个日志行（实测：32 → 40 → 3 tick 后 32）。
test('§133 狂战药剂的 +25% 攻击要持续 30 秒（以前下一 tick 就被抹掉）', () => {
  const m = createMatch({ mapId: 'map_01', heroId: 'hero_warrior', seed: 3 });
  m.gold = 5000;
  const atk = () => Math.round(heroStats(m.hero).attack);
  const base = atk();

  assert.equal(buyItem(m, 'elixir_atk'), true, '买得到');
  assert.equal(m.hero.buffs.filter((b) => b.type === 'elixir').length, 1, 'buff 里要有这一条');
  for (let i = 0; i < Math.round(1 / TICK_STEP); i += 1) update(m, TICK_STEP);      // 跑 1 秒
  assert.equal(atk(), Math.round(base * 1.25), `1 秒后攻击该还是 +25%（基线 ${base}）`);
  assert.equal(m.hero.attackBuff, 0.25);

  for (let i = 0; i < Math.round(30 / TICK_STEP); i += 1) update(m, TICK_STEP);  // 跑过 30 秒
  assert.equal(atk(), base, '30 秒到期后要掉回基线');

  // 对照组：战吼（技能）也必须照旧生效并到期
  const w = createMatch({ mapId: 'map_01', heroId: 'hero_warrior', seed: 4 });
  w.hero.level = 10;
  w.hero.skillUnlocked = [true, true, true];
  const base2 = Math.round(heroStats(w.hero).attack);
  assert.equal(castSkill(w, 1), true, '战吼该放得出来');
  update(w, TICK_STEP);
  assert.ok(Math.round(heroStats(w.hero).attack) > base2, '战吼要涨攻击');
  for (let i = 0; i < 20 * 11; i += 1) update(w, TICK_STEP);   // 战吼持续 10 秒
  assert.equal(Math.round(heroStats(w.hero).attack), base2, '战吼到期也要掉回基线');
});

// §144 的 TD 一侧（防守那一半在 `tests/defense.test.js`）：疾行药剂的 +30% 攻速以前是**内联写在 TD
// 的 `heroStep()` 里**读 buff 的——那正是「防守漏读」的根源。现在它并进 `heroStats()`，这条钉住
// TD 侧没有在重构里丢掉它（量真实普攻间隔，不是查字符串）。
test('§144 疾行药剂的 +30% 攻速在 TD 里照旧生效（口径已并进 heroStats）', () => {
  const interval = (useHaste) => {
    const m = createMatch({ mapId: 'map_01', heroId: 'hero_warrior', seed: 22 });
    m.gold = 5000;
    if (useHaste) assert.equal(buyItem(m, 'elixir_haste'), true, '买得到疾行药剂');
    const def = MONSTERS.mob_01;
    // 怪要贴在英雄身边，但 TD 的 `monsterStep()` 每帧按 `pathIndex + dist` 重算格子（然后按格判定漏怪），
    // 所以位置只能由「路径上几乎走到底」表达——地图路径的末端就是核心，英雄正站在那里。
    const path = m.map.paths[0];
    m.monsters.push({
      uid: 1, mobId: 'mob_01', def, cell: { ...m.hero.cell },
      hp: 1e6, maxHp: 1e6, armor: 0, armorType: def.armorType, attack: 0, atkSpeed: 1, speed: 0,
      // 停在**倒数第二格**（`monsterStep` 里「dist ≥ 末端 − 半格」就算突破防线），也就是核心旁边、英雄射程内
      dist: pathTotalUnits(path) - GRID.unitPerTile * 0.5 - 1, pathIndex: 0, cooldown: 0, isAir: false,
      effects: [], dead: false,
    });
    m.hero.cooldown = 0;
    update(m, TICK_STEP);
    return m.hero.cooldown;
  };
  const plain = interval(false);
  const haste = interval(true);
  assert.ok(plain > 0, `基线要真的打出一次普攻（实际间隔 ${plain}）`);
  assert.ok(Math.abs(plain / haste - 1.3) < 0.02, `TD 侧也该是 +30%：${plain}s → ${haste}s（比值 ${(plain / haste).toFixed(3)}）`);
});

// §135：**两个模式的英雄 tick 必须跑同一组「每 tick 该做的事」**。
// 这是 §134 那次的教训——英雄的 tick 在两个模式里各写一份（`match.js` 的 `heroStep()` /
// `defense.js` 的 `stepHero()`），而 `castSkill` / `grantItem` 是共用的，所以「一边漏了一件事」
// 看起来完全正常：当时防守模式漏了 buff 的到期与派生值，`npm test` / `soak` / `defense` 全绿，
// 但防守里的战吼 / 药剂 / 结界其实全哑了。
// 这条按**职责清单**逐项检查两边都在（新加一项共享职责时，把它加进这张表即可）。
test('§135 两个模式的英雄 tick 跑同一组职责（漏一边就是静默坏掉）', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');
  /** 取一个顶层函数的正文：从它的声明行到下一个顶格的 `}`。 */
  const bodyOf = (text, decl) => {
    const start = text.indexOf(decl);
    assert.ok(start > 0, `找不到 ${decl}`);
    const end = text.indexOf('\n}', start);
    assert.ok(end > start, `找不到 ${decl} 的结尾`);
    return text.slice(start, end);
  };
  const td = bodyOf(await read('../src/match.js'), 'function heroStep(');
  // 防守那边英雄的三件事分散在两处：移动在 `stepHero()`，冷却/回复/普攻在 `updateDefense()` 里
  // 一段标了「英雄：…」的内联块——这条检查要看的是**后面这一段**（它才是 TD heroStep 的对应物）
  const defText = await read('../src/defense.js');
  const defStart = defText.indexOf('// 英雄：技能冷却');
  const defEnd = defText.indexOf('// 清场与结算', defStart);
  assert.ok(defStart > 0 && defEnd > defStart, '找不到防守的「英雄」那一段');
  const def = defText.slice(defStart, defEnd) + bodyOf(defText, 'function stepHero(');

  // 只列**英雄 tick 里该做的事**：复活/无敌那段在防守侧写在 `updateDefense` 的主循环里
  // （不在 `stepHero`），所以不放进这张表——表里的每一项都必须在两侧的 tick 里出现。
  const DUTIES = [
    ['技能冷却递减', /skillCd\[i\] = Math\.max/],
    ['药品冷却递减', /potionCd\[k\] = Math\.max/],
    ['buff 到期与派生值（加成口径的唯一出口）', /updateHeroBuffs\(/],
    ['脱战回复', /HERO_REGEN/],
    ['普攻出口', /heroAttack\(/],
  ];
  for (const [name, re] of DUTIES) {
    assert.ok(re.test(td), `TD 的 heroStep 少了「${name}」`);
    assert.ok(re.test(def), `防守的 stepHero 少了「${name}」——两个模式各写一份 tick，漏一边不会红但会静默失效（§134）`);
  }
});

// STATUS §3.1 #20（已拍板）：**群体治疗符两个模式都禁售**。
// 它 200 金回 300、CD 45 秒、限购 2，而大药 120 金回 500、不限购——**严格被支配**（§92.1 量的）。
// 卖点是「全队治疗」，而「联机每人一个英雄」还没做（#13 推迟到 M3），现在「全队」只有你自己。
// 禁售不是静默下架：`shopBlocked` 里的理由会被商店面板原样显示（§5.5.1 的既有机制）。
test('§3.1 #20 群体治疗符两个模式都禁售，而且给得出理由（不是静默下架）', () => {
  const td = createMatch({ mapId: 'map_01', heroId: 'hero_warrior', seed: 3 });
  const def = createDefenseMatch({ mapId: 'def_01', heroId: 'hero_warrior', seed: 3 });
  for (const [label, m] of [['TD', td], ['防守', def]]) {
    m.gold = 5000;
    assert.ok(m.shopBlocked?.pot_group, `${label}：该登记禁售理由（面板要显示它）`);
    assert.equal(buyItem(m, 'pot_group'), false, `${label}：不该买得到`);
    assert.equal(m.gold, 5000, `${label}：拒了就不该扣钱`);
  }
  // 大药仍然卖（别把药品一起关掉）
  assert.equal(buyItem(td, 'pot_large'), true, '大药是正常商品');
});
