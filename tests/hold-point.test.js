// TD 驻守点：只能站在核心附近的路径旁，命令和迈步都出不了这圈。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefenseMatch } from '../src/defense.js';
import { gridDist } from '../src/core.js';
import { TICK_STEP } from '../src/data.js';
import {
  TD_HOLD_RADIUS, clampHoldPoint, createMatch, heroAbilityRange, holdCells, homeCore, isHoldCell,
  orderHold, resolveHoldOrder, update,
} from '../src/match.js';
import { applyShared } from '../src/protocol.js';
import { pointHitsHero } from '../src/render.js';
import { deserializeMatch, serializeMatch } from '../src/save.js';

test('驻守半径把远处的点钳回核心，命令出圈会被拒', () => {
  const m = createMatch({ mapId: 'map_01', seed: 1 });
  const core = homeCore(m);
  const far = { x: core.x + 9, y: core.y };
  const clamped = clampHoldPoint(far, core);
  assert.ok(gridDist(clamped, core) <= TD_HOLD_RADIUS);
  assert.equal(gridDist(clamped, core), TD_HOLD_RADIUS);
  assert.equal(orderHold(m, far), false, '偏出 1 格以上的空地点不能下驻守');
  assert.deepEqual(m.hero.cell, core, '拒掉的命令不许挪人');
  assert.equal(m.hero.path.length, 0);
});

test('路径旁 1 格内的点偏会落到最近的驻守格，人走过去仍在圈内', () => {
  const m = createMatch({ mapId: 'map_01', seed: 1 });
  const core = homeCore(m);
  const cells = holdCells(m);
  assert.ok(cells.some((c) => c.x === core.x && c.y === core.y), '核心本身永远能站');
  for (const c of cells) {
    assert.ok(gridDist(c, core) <= TD_HOLD_RADIUS, `驻守格 (${c.x},${c.y}) 超出半径`);
    assert.ok(isHoldCell(m, c));
  }
  let miss = null;
  for (const c of cells) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: c.x + dx, y: c.y + dy };
      if (isHoldCell(m, n)) continue;
      if (gridDist(n, core) > TD_HOLD_RADIUS + 1) continue;
      miss = n;
      break;
    }
    if (miss) break;
  }
  assert.ok(miss, '圈边应该有一格点偏能被原谅');
  assert.equal(orderHold(m, miss), true);
  assert.ok(gridDist(m.hero.hold, miss) <= 1);
  assert.ok(isHoldCell(m, m.hero.hold));
  const goal = { ...m.hero.hold };
  for (let i = 0; i < 100 && (m.hero.cell.x !== goal.x || m.hero.cell.y !== goal.y); i++) {
    update(m, TICK_STEP);
    assert.ok(isHoldCell(m, m.hero.cell), `迈步走出驻守区 (${m.hero.cell.x},${m.hero.cell.y})`);
    assert.ok(gridDist(m.hero.cell, core) <= TD_HOLD_RADIUS);
  }
  assert.deepEqual(m.hero.cell, goal);
});

test('没下命令时，测试或战斗把人放到圈外不会被每帧吸回核心', () => {
  const m = createMatch({ mapId: 'map_01', seed: 1 });
  const parked = { x: m.map.grid.w - 1, y: m.map.grid.h - 1 };
  m.hero.cell = { ...parked };
  m.hero.path = [{ x: 0, y: 0 }];
  if (isHoldCell(m, m.hero.path[0])) m.hero.path = [{ x: parked.x, y: parked.y - 1 }];
  assert.equal(isHoldCell(m, m.hero.path[0]), false);
  update(m, TICK_STEP);
  assert.deepEqual(m.hero.cell, parked, '非法的下一步要丢掉，人留在原地');
  assert.equal(m.hero.path.length, 0);
  m.hero.path = [];
  for (let i = 0; i < 20; i++) update(m, TICK_STEP);
  assert.deepEqual(m.hero.cell, parked);
});

test('防守局不能下驻守；技能圈和点选半径按职业分开', () => {
  const defense = createDefenseMatch({ seed: 1 });
  const before = { ...defense.hero.cell };
  assert.equal(orderHold(defense, defense.hero.cell), false);
  assert.deepEqual(defense.hero.cell, before);
  assert.equal(resolveHoldOrder(defense, defense.hero.cell), null);

  const warrior = createMatch({ heroId: 'hero_warrior' }).hero;
  assert.equal(heroAbilityRange(warrior), 2.5);
  const ranger = createMatch({ heroId: 'hero_ranger' }).hero;
  assert.equal(heroAbilityRange(ranger), 0);
  const mage = createMatch({ heroId: 'hero_mage' }).hero;
  assert.equal(heroAbilityRange(mage), 3);

  const pal = createMatch({ heroId: 'hero_paladin' }).hero;
  assert.equal(heroAbilityRange(pal), 3, '1 级虔诚还没开，预览是 3 格底');
  pal.level = 5;
  assert.equal(heroAbilityRange(pal), 5, '5 级结界仍锁着，3 + 天赋 2');
  pal.level = 8;
  pal.skillUnlocked = [true, true, false];
  assert.equal(heroAbilityRange(pal), 6, '结界 4 + 虔诚 2');

  const scale = 1;
  const r = Math.max(22, 16 * scale + 8);
  assert.equal(pointHitsHero({ x: 0, y: 0 }, scale, r - 1, 0), true);
  assert.equal(pointHitsHero({ x: 0, y: 0 }, scale, r + 2, 0), false);
});

test('存档和老快照：驻守点能回来，8 项的旧英雄数组不会改格子', () => {
  const m = createMatch({ mapId: 'map_01', seed: 3 });
  const goal = holdCells(m).find((c) => c.x !== m.hero.cell.x || c.y !== m.hero.cell.y);
  assert.equal(orderHold(m, goal), true);
  for (let i = 0; i < 100 && m.hero.path.length; i++) update(m, TICK_STEP);
  const back = deserializeMatch(serializeMatch(m));
  assert.deepEqual(back.hero.cell, m.hero.cell);
  assert.deepEqual(back.hero.hold, m.hero.hold);

  const mirror = createMatch({ mapId: 'map_01', seed: 3 });
  const parked = { x: 1, y: 1 };
  mirror.hero.cell = { ...parked };
  applyShared(mirror, {
    t: 0, w: [0, 0, 0, 0, 12], core: [mirror.core.hp, mirror.core.maxHp],
    hero: [0, 1, 0, mirror.hero.hp, 0, 0, [0, 0, 0], [1, 0, 0]],
    gold: mirror.gold, st: [0, 0], result: 0, mon: [],
  });
  assert.deepEqual(mirror.hero.cell, parked, '老快照没有格子字段，不要把人拽走');
});
