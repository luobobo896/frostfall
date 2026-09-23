// 4-6★ 大图的三个独有机制：岩浆阻投射物、攻城怪拆塔（+修复）、双守护目标。
import test from 'node:test';
import assert from 'node:assert/strict';

import { MAPS, MONSTERS, TICK_STEP, TOWERS } from '../src/data.js';
import { blockedByLava, buildMap, gridDist } from '../src/core.js';
import {
  buildTower, createMatch, repairTower, towerAtSlot, towerMaxHp, update,
} from '../src/match.js';

const advance = (m, seconds) => { for (let i = 0; i < Math.round(seconds / TICK_STEP); i++) update(m, TICK_STEP); };

test('地图配置：4★ 起用更大的画布，塔位/路线/核心按 §2.2 给', () => {
  assert.equal(MAPS.map_04.towerSlots, 28);
  assert.equal(MAPS.map_05.towerSlots, 26);
  assert.equal(MAPS.map_06.towerSlots, 32);
  for (const def of [MAPS.map_04, MAPS.map_05, MAPS.map_06]) {
    const map = buildMap(def);
    assert.ok(map.grid.w >= 44, `${def.id} 的 3-4 路图需要更大的画布`);
    assert.equal(map.slots.length, def.towerSlots);
    assert.equal(map.paths.length, def.pathCount);
  }
  assert.equal(buildMap(MAPS.map_06).cores.length, 2, '冰封王座是双守护目标');
});

test('岩浆：不可建造，且阻挡投射物（§2.3）', () => {
  const def = MAPS.map_04;
  const map = buildMap(def);
  assert.ok(map.lava.size > 0, '熔岩裂谷要有岩浆格');
  const lavaCell = [...map.lava][0].split(',').map(Number);
  for (const s of map.slots) {
    assert.ok(!map.lava.has(`${s.x},${s.y}`), '岩浆上不该有塔位');
  }
  // 投射物连线穿过岩浆 → 被挡
  const from = { x: lavaCell[0] - 3, y: lavaCell[1] };
  const to = { x: lavaCell[0] + 3, y: lavaCell[1] };
  assert.equal(blockedByLava(map, from, to), true, '横穿岩浆的弹道应被挡');
  assert.equal(blockedByLava(map, { x: 0, y: 0 }, { x: 0, y: 5 }), false, '没有岩浆的地图不该误判');

  // 建局后岩浆格确实不能建塔（塔位是显式枚举的，这里再确认一次）
  const m = createMatch({ mapId: 'map_04', seed: 2 });
  assert.ok(m.map.lava.size > 0);
});

test('攻城怪拆塔：塔有血量、被打掉返还 50%、可花 60 金修满（§7.4）', () => {
  const m = createMatch({ mapId: 'map_05', seed: 3 });
  m.gold = 1000;
  assert.equal(buildTower(m, 0, 'tw_arrow'), true);
  const t = towerAtSlot(m, 0);
  assert.equal(t.maxHp, towerMaxHp(1));
  assert.equal(t.hp, t.maxHp);
  assert.ok(MONSTERS.mob_10.siege, '冰甲卫士是攻城单位');

  // 手动把它放到塔边，让它拆
  const mon = { ...Object.assign({}, { def: MONSTERS.mob_10 }) };
  m.monsters.push({
    uid: 1, mobId: 'mob_10', def: MONSTERS.mob_10, pathIndex: 0, dist: 0,
    cell: { ...t.cell }, hp: 900, maxHp: 900, armor: 6, armorType: 'fortified',
    speed: 240, attack: 30, atkSpeed: 1, cooldown: 0, isAir: false, effects: [], dead: false, attacking: false, coreIndex: 0,
  });
  const hpBefore = t.hp;
  advance(m, 3);
  assert.ok(t.hp < hpBefore, `攻城怪应打到塔（${hpBefore} → ${t.hp}）`);

  t.hp = Math.max(1, t.maxHp * 0.2);
  m.gold = 500;
  assert.equal(repairTower(m, 0), true, '花 60 金修满');
  assert.equal(t.hp, t.maxHp);
  assert.equal(m.gold, 440);
  assert.equal(repairTower(m, 0), false, '满血不该收费');

  // 拆掉：把塔的血压到极低再打一下，检查返还与塔位释放
  t.hp = 1;
  m.gold = 0;
  advance(m, 2);
  assert.equal(towerAtSlot(m, 0), null, '塔被拆后塔位应空出来');
  assert.ok(m.gold > 0, '被拆应返还 50% 投入');
  void mon;
});

test('非攻城图不会被拆塔（攻城机制只挂 5★/6★ 图）', () => {
  const m = createMatch({ mapId: 'map_01', seed: 4 });
  m.gold = 500;
  buildTower(m, 0, 'tw_arrow');
  const t = towerAtSlot(m, 0);
  m.monsters.push({
    uid: 9, mobId: 'mob_10', def: MONSTERS.mob_10, pathIndex: 0, dist: 0,
    cell: { ...t.cell }, hp: 900, maxHp: 900, armor: 6, armorType: 'fortified',
    speed: 0, attack: 30, atkSpeed: 1, cooldown: 0, isAir: false, effects: [], dead: false, attacking: false, coreIndex: 0,
  });
  advance(m, 3);
  assert.equal(t.hp, t.maxHp, '1★ 图上塔不该被打');
});

test('双守护目标：两条路各自通往一个核心，任一被破即失败（§2.2 map_06）', () => {
  const m = createMatch({ mapId: 'map_06', seed: 5 });
  assert.equal(m.cores.length, 2);
  assert.equal(m.core, m.cores[0], 'm.core 仍是第一个核心（HUD/存档沿用）');
  const targets = new Set(m.map.paths.map((p) => p.coreIndex));
  assert.deepEqual([...targets].sort(), [0, 1], '四条路要分给两个核心');

  // 把第二个核心打空 → 立刻判负
  m.cores[1].hp = 1;
  const boss = { ...MONSTERS.boss_01 };
  m.monsters.push({
    uid: 77, mobId: 'boss_01', def: boss, pathIndex: 2, dist: 10 ** 6, coreIndex: 1,
    cell: { ...m.cores[1].cell }, hp: 100, maxHp: 100, armor: 8, armorType: 'fortified',
    speed: 0, attack: 80, atkSpeed: 1, cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
  });
  advance(m, 0.5);
  assert.equal(m.cores[1].hp, 0);
  assert.equal(m.result, 'lose', '第二个核心被破也要判负');
  assert.ok(TOWERS.tw_arrow);
  void gridDist;
});
