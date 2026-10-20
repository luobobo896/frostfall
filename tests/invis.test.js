// 隐身 + 侦测：完全潜行锁不住，侦测半径揭开，预告和圈都提前告诉玩家。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFENSE_RULES, FORTS, GRID, HEROES, MONSTERS, TICK_STEP, TOWERS } from '../src/data.js';
import { gridDist } from '../src/core.js';
import {
  buildTower, castSkill, createMatch, heroDetectRadius, invisPhase, isTargetable,
  stealthView, towerStats, update,
} from '../src/match.js';
import {
  assaultStealthCount, buildFort, createDefenseMatch, upcomingAssaultGroups, updateDefense,
} from '../src/defense.js';
import { detectNote } from '../src/hud-model.js';
import { createRenderer, DETECT_RING } from '../src/render.js';
import { drawDefenseHud, hitTestDefense, layoutDefense, layoutFortSheet, MINIMAP } from '../src/minigame/defense-screen.js';

globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };

function freeze(m) {
  m.wave.phase = 'prep';
  m.wave.timer = 9999;
  m.hero.dead = true;
  m.hero.reviveTimer = 999;
}

function nearest(m, slot) {
  const tower = m.map.slots[slot];
  const path = m.map.paths[0];
  let bestI = 0;
  let bestD = Infinity;
  path.cells.forEach((c, i) => {
    const d = Math.abs(c.x - tower.x) + Math.abs(c.y - tower.y);
    if (d < bestD) { bestD = d; bestI = i; }
  });
  return { index: bestI, gap: bestD, cell: path.cells[bestI] };
}

function slotWithin(m, range) {
  for (let i = 0; i < m.map.slots.length; i++) {
    if (nearest(m, i).gap <= range) return i;
  }
  return -1;
}

function creep(m, slot, mobId) {
  const spot = nearest(m, slot);
  const def = MONSTERS[mobId];
  return {
    gap: spot.gap,
    mon: {
      uid: ++m.spawnCounter, mobId, def, pathIndex: 0,
      dist: spot.index * GRID.unitPerTile, cell: { ...spot.cell },
      hp: def.hp, maxHp: def.hp, armor: def.armor, armorType: def.armorType,
      speed: 0, attack: def.attack, atkSpeed: def.atkSpeed,
      cooldown: 0, isAir: !!def.isAir, effects: [], dead: false, attacking: false,
    },
  };
}

function tick(m, n, step = update) {
  for (let i = 0; i < n; i++) step(m, TICK_STEP);
}

function ink() {
  const calls = [];
  const state = { strokeStyle: '', fillStyle: '', lineWidth: 1 };
  const rec = (name) => (...args) => {
    calls.push({
      name, args,
      strokeStyle: state.strokeStyle, fillStyle: state.fillStyle, lineWidth: state.lineWidth,
    });
  };
  const ctx = {
    calls,
    setTransform: rec('setTransform'), fillRect: rec('fillRect'), fillText: rec('fillText'),
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    closePath: rec('closePath'), fill: rec('fill'), stroke: rec('stroke'),
    ellipse: rec('ellipse'), arc: rec('arc'), save: rec('save'), restore: rec('restore'),
    setLineDash: rec('setLineDash'), translate: rec('translate'), scale: rec('scale'),
    transform: rec('transform'),
  };
  for (const key of ['strokeStyle', 'fillStyle', 'lineWidth', 'globalAlpha']) {
    Object.defineProperty(ctx, key, {
      set(v) { state[key] = v; },
      get() { return state[key]; },
    });
  }
  return ctx;
}

test('隐身相位：完全潜行、将显形、显形三段，普通怪不潜行', () => {
  const queen = MONSTERS.mob_11;
  assert.deepEqual(invisPhase(queen, 0), { stealthed: true, faint: false });
  assert.deepEqual(invisPhase(queen, 2.5), { stealthed: true, faint: true });
  assert.equal(invisPhase(queen, 4).stealthed, false);
  assert.equal(invisPhase(MONSTERS.mob_01, 1).stealthed, false);
  assert.ok(TOWERS.tw_frost.special.detectRadius > TOWERS.tw_frost.range);
  assert.ok(FORTS.fort_arrow.detectRadius > FORTS.fort_arrow.range);
  const barrier = HEROES.hero_paladin.skills.find((s) => s.id === 'sk_barrier');
  assert.ok(barrier.detectRadius > barrier.radius);
  const grown = towerStats('tw_frost', 3);
  assert.equal(grown.special.detectRadius, 6, '侦测半径不随等级变');
  assert.ok(grown.range > TOWERS.tw_frost.range);
  assert.equal(detectNote(grown), ' · 侦测 6.0');
  assert.equal(detectNote(towerStats('tw_arrow', 1)), '');
});

test('完全潜行时箭塔打不中；冰塔的侦测半径内打得中', () => {
  const quiet = createMatch({ mapId: 'map_01', seed: 3 });
  freeze(quiet);
  quiet.gold = 9999;
  const slot = slotWithin(quiet, TOWERS.tw_frost.range);
  assert.ok(slot >= 0, '路径附近要有一座塔位');
  assert.ok(buildTower(quiet, slot, 'tw_arrow'));
  const parked = creep(quiet, slot, 'mob_11');
  assert.ok(parked.gap <= quiet.towers[0].stats.range);
  quiet.monsters = [parked.mon];
  const hp = parked.mon.hp;
  tick(quiet, 20);
  assert.equal(parked.mon.hp, hp, '潜行中箭塔不该掉血');
  assert.equal(isTargetable(quiet, parked.mon), false);
  assert.equal(stealthView(quiet, parked.mon), 'ghost');

  const seen = createMatch({ mapId: 'map_01', seed: 3 });
  freeze(seen);
  seen.gold = 9999;
  assert.ok(buildTower(seen, slot, 'tw_frost'));
  const queen = creep(seen, slot, 'mob_11');
  seen.monsters = [queen.mon];
  tick(seen, 20);
  assert.ok(queen.mon.hp < queen.mon.maxHp || queen.mon.dead, '侦测范围内冰塔要打得中');
  assert.equal(isTargetable(seen, queen.mon), true);
  assert.equal(stealthView(seen, queen.mon), 'revealed');
});

test('侦测塔离开之后，射程里的箭塔重新锁不住；溅射打不到旁边的潜行怪', () => {
  const m = createMatch({ mapId: 'map_01', seed: 4 });
  freeze(m);
  m.gold = 9999;
  const slot = slotWithin(m, TOWERS.tw_arrow.range);
  const other = m.map.slots.findIndex((_, i) => i !== slot);
  assert.ok(buildTower(m, slot, 'tw_arrow'));
  assert.ok(buildTower(m, other, 'tw_frost'));
  const frost = m.towers.find((t) => t.towerId === 'tw_frost');
  const parked = creep(m, slot, 'mob_11');
  frost.cell = [{ x: 0, y: 0 }, { x: 31, y: 0 }, { x: 0, y: 23 }, { x: 31, y: 23 }]
    .find((c) => gridDist(parked.mon.cell, c) > TOWERS.tw_frost.special.detectRadius);
  assert.ok(parked.gap <= m.towers.find((t) => t.towerId === 'tw_arrow').stats.range);
  assert.ok(frost.cell, '地图角上要有一格在侦测半径外');
  m.monsters = [parked.mon];
  const hp = parked.mon.hp;
  tick(m, 20);
  assert.equal(parked.mon.hp, hp);
  assert.equal(isTargetable(m, parked.mon), false);

  const splash = createMatch({ mapId: 'map_01', seed: 5 });
  freeze(splash);
  splash.gold = 9999;
  const cannonSlot = slotWithin(splash, TOWERS.tw_cannon.range);
  assert.ok(buildTower(splash, cannonSlot, 'tw_cannon'));
  const bait = creep(splash, cannonSlot, 'mob_01');
  const hidden = creep(splash, cannonSlot, 'mob_11');
  hidden.mon.uid = bait.mon.uid + 1;
  hidden.mon.cell = { ...bait.mon.cell };
  hidden.mon.dist = bait.mon.dist;
  splash.monsters = [bait.mon, hidden.mon];
  tick(splash, 12);
  assert.ok(bait.mon.hp < bait.mon.maxHp || bait.mon.dead, '炮塔要打中看得见的怪');
  assert.equal(hidden.mon.hp, hidden.mon.maxHp, '溅射不该波及潜行怪');
});

test('守护结界在技能半径之外仍能揭开隐身', () => {
  const m = createMatch({ mapId: 'map_01', heroId: 'hero_paladin', seed: 6 });
  m.wave.phase = 'prep';
  m.wave.timer = 9999;
  m.hero.level = 8;
  m.hero.skillUnlocked[1] = true;
  const def = MONSTERS.mob_11;
  const mon = {
    uid: 9, mobId: def.id, def, pathIndex: 0, dist: 0,
    cell: { ...m.map.paths[0].spawn },
    hp: def.hp, maxHp: def.hp, armor: def.armor, armorType: def.armorType,
    speed: 0, attack: def.attack, atkSpeed: def.atkSpeed,
    cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
  };
  m.monsters = [mon];
  update(m, TICK_STEP);
  m.hero.cell = { x: mon.cell.x + 6, y: mon.cell.y };
  m.hero.path = [];
  assert.equal(gridDist(m.hero.cell, mon.cell), 6);
  assert.ok(6 > HEROES.hero_paladin.skills[1].radius);
  assert.ok(6 <= HEROES.hero_paladin.skills[1].detectRadius);
  update(m, TICK_STEP);
  assert.equal(isTargetable(m, mon), false);
  assert.equal(castSkill(m, 1), true);
  assert.equal(heroDetectRadius(m), 7.2);
  update(m, TICK_STEP);
  assert.equal(isTargetable(m, mon), true);
  assert.equal(stealthView(m, mon), 'revealed');
});

test('防守：没侦测的箭塔不打潜行，开了侦测就打；预警和芯片提前说需要侦测', () => {
  const m = createDefenseMatch({ seed: 8 });
  m.gold = 1000;
  for (const c of m.camps) c.timer = 9999;
  m.assault.timer = 9999;
  assert.ok(buildFort(m, 0, 'fort_arrow'));
  const fort = m.forts[0];
  assert.equal(fort.stats.detectRadius, 6.5);
  const def = MONSTERS.mob_11;
  const mon = {
    uid: 3, mobId: def.id, def, kind: 'assault',
    cell: { ...fort.cell }, hp: def.hp, maxHp: def.hp,
    armor: def.armor, armorType: def.armorType,
    attack: def.attack, atkSpeed: def.atkSpeed, speed: 0,
    cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
    active: true, path: [], pathAt: -1,
  };
  m.monsters = [mon];
  m.hero.dead = true;
  m.hero.reviveTimer = 999;
  fort.stats.detectRadius = 0;
  tick(m, 30, updateDefense);
  assert.equal(mon.hp, def.hp, '关掉侦测之后工事不该打潜行怪');
  fort.stats.detectRadius = 6.5;
  tick(m, 30, updateDefense);
  assert.ok(mon.hp < def.hp || mon.dead, '侦测范围内工事要打得中');

  const warn = createDefenseMatch({ seed: 9 });
  assert.equal(assaultStealthCount(warn), 0, '第一波没有隐身');
  warn.assault.round = 3;
  assert.equal(assaultStealthCount(warn), 2);
  assert.ok(upcomingAssaultGroups(warn).some((g) => g.mobId === 'mob_11'));
  warn.assault.timer = DEFENSE_RULES.assaultWarnSec + 0.05;
  warn.assault.warning = false;
  updateDefense(warn, 0.1);
  assert.ok(warn.events.some((e) => e.text.includes('有隐身') && e.text.includes('需要侦测')));

  const L = layoutDefense(warn, { stealthAlert: { count: 2 }, rate: 1 });
  assert.equal(L.stealthChip.h, 44);
  assert.equal(L.stealthChip.w, 228);
  assert.ok(L.stealthChip.x + L.stealthChip.w <= MINIMAP.x, '芯片不能压住小地图');
  assert.ok(L.stealthChip.y >= 62, '芯片让开顶栏那一行');
  assert.equal(hitTestDefense(L, L.stealthChip.x + 8, L.stealthChip.y + 8), null, '芯片不是按键');
  const texts = [];
  const ctx = new Proxy({}, {
    get(_t, p) {
      if (p === 'measureText') return () => ({ width: 24 });
      return (...args) => { if (p === 'fillText') texts.push(String(args[0])); };
    },
    set() { return true; },
  });
  drawDefenseHud(ctx, warn, L, {});
  assert.ok(texts.includes('隐身'));
  assert.ok(texts.includes('需要侦测'));
  assert.match(layoutFortSheet(warn, { freeSlots: 2 }).byId['fort-fort_arrow'].sub, /侦测 6\.5/);
});

test('潜行怪是灰阶虚线，冰塔同时画出射程圈和更大的侦测圈', () => {
  const draw = (setup, extra = {}) => {
    const ctx = ink();
    const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
    const r = createRenderer(canvas);
    const m = createMatch({ mapId: 'map_01', seed: 1 });
    m.gold = 9999;
    setup(m);
    r.draw({ m, selectedSlot: null, selectedTower: null, now: m.time, ...extra });
    return { ctx, r, m };
  };

  const ghost = draw((m) => {
    m.towers = [];
    m.time = 0;
    const def = MONSTERS.mob_11;
    m.monsters = [{
      uid: 1, mobId: def.id, def, pathIndex: 0, dist: 0,
      cell: { ...m.map.paths[0].spawn }, hp: def.hp, maxHp: def.hp,
      armorType: def.armorType, isAir: false, attacking: false, dead: false,
    }];
  });
  assert.equal(stealthView(ghost.m, ghost.m.monsters[0]), 'ghost');
  assert.ok(ghost.ctx.calls.some((c) => c.name === 'fill' && c.fillStyle === '#a8b2be'));
  assert.ok(ghost.ctx.calls.some((c) => c.name === 'setLineDash' && c.args[0]?.[0] === 3 && c.args[0]?.[1] === 3));

  const faint = draw((m) => {
    m.towers = [];
    m.time = 2.5;
    const def = MONSTERS.mob_11;
    m.monsters = [{
      uid: 1, mobId: def.id, def, pathIndex: 0, dist: 0,
      cell: { ...m.map.paths[0].spawn }, hp: def.hp, maxHp: def.hp,
      armorType: def.armorType, isAir: false, attacking: false, dead: false, stealth: invisPhase(def, 2.5),
    }];
  });
  assert.equal(stealthView(faint.m, faint.m.monsters[0]), 'faint');
  assert.ok(faint.ctx.calls.some((c) => c.name === 'fill' && c.fillStyle === '#a8b2be'));

  const frost = draw((m) => {
    assert.ok(buildTower(m, 0, 'tw_frost'));
    m.monsters = [];
  }, { selectedTower: 0 });
  const tower = frost.m.towers[0];
  const at = frost.r.toScreen(tower.cell.x, tower.cell.y, 0);
  const scale = frost.r.scale;
  const ring = (range) => frost.ctx.calls.find((c) => c.name === 'ellipse'
    && Math.abs(c.args[0] - at.x) < 1 && Math.abs(c.args[1] - at.y) < 1
    && Math.abs(c.args[2] - range * (GRID.tileW / 2) * scale) < 1);
  assert.ok(ring(tower.stats.range), '选中冰塔仍有射程圈');
  assert.ok(ring(tower.stats.special.detectRadius), '侦测圈按侦测半径画，比射程大');
  assert.ok(tower.stats.special.detectRadius > tower.stats.range);
  const cream = frost.ctx.calls.filter((c) => c.name === 'stroke' && c.strokeStyle === '#fff4d2' && c.lineWidth === 2);
  assert.equal(cream.length, 1, '射程圈仍是那一圈奶油实线');
  assert.ok(frost.ctx.calls.some((c) => c.name === 'setLineDash'
    && c.args[0]?.[0] === DETECT_RING.dash[0] && c.args[0]?.[1] === DETECT_RING.dash[1]));
  assert.ok(frost.ctx.calls.some((c) => c.name === 'stroke' && c.strokeStyle === DETECT_RING.stroke && c.lineWidth === DETECT_RING.lineWidth));
});
