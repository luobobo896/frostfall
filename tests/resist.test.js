// 霜壳：物理通道在攻击×护甲之后再乘 0.25，魔法仍走重甲表。预告和剪影提前说清。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFENSE_MAPS, DEFENSE_RULES, GRID, MONSTERS, TICK_STEP, TOWERS, WAVES, WAVES_LONG } from '../src/data.js';
import { computeDamage, resistMultiplier } from '../src/core.js';
import {
  buildTower, createMatch, invisPhase, isTargetable, sprintState, towerStats, update, upgradeTower,
} from '../src/match.js';
import {
  assaultResistCount, assaultStealthCount, createDefenseMatch, upcomingAssaultGroups, updateDefense,
} from '../src/defense.js';
import { creepRoles, roleGlyph, wavePreview } from '../src/hud-model.js';
import { createRenderer, mobSilhouette } from '../src/render.js';
import { drawDefenseHud, hitTestDefense, layoutDefense, MINIMAP } from '../src/minigame/defense-screen.js';

globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };

const flat = () => 0.5;

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
      hp: 800, maxHp: 800, armor: def.armor, armorType: def.armorType,
      speed: 0, attack: 0, atkSpeed: def.atkSpeed,
      cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
    },
  };
}

function tick(m, n) {
  for (let i = 0; i < n; i++) update(m, TICK_STEP);
}

test('霜壳只削写明的物理通道，魔法与没有壳的怪不变', () => {
  const shell = MONSTERS.mob_13;
  assert.equal(shell.name, '霜壳尸');
  assert.equal(shell.armorType, 'heavy');
  assert.equal(resistMultiplier('normal', null), 1);
  assert.equal(resistMultiplier('magic', shell.resist), 1);
  assert.equal(resistMultiplier('chaos', shell.resist), 1);
  assert.equal(resistMultiplier('normal', shell.resist), 0.25);
  assert.equal(resistMultiplier('pierce', shell.resist), 0.25);
  assert.equal(resistMultiplier('siege', shell.resist), 0.25);
  assert.equal(resistMultiplier('normal', { normal: 4 }), 1, '这层不能拿来增伤');

  const hit = (attackType, resist) => computeDamage({
    atk: 100, attackType, armor: shell.armor, armorType: shell.armorType, resist, rng: flat,
  }).damage;
  const magic = hit('magic', shell.resist);
  const arrow = hit('normal', shell.resist);
  const cannon = hit('siege', shell.resist);
  assert.ok(magic > arrow * 4, `魔法 ${magic} 应明显压过普通 ${arrow}`);
  assert.ok(magic > cannon * 4, `魔法 ${magic} 应明显压过攻城 ${cannon}`);
  assert.equal(magic, hit('magic', null), '没写的魔法通道不吃霜壳');
  assert.equal(MONSTERS.mob_10.resist, undefined);
  assert.equal(
    computeDamage({
      atk: 40, attackType: 'siege', armor: MONSTERS.mob_10.armor, armorType: MONSTERS.mob_10.armorType, rng: flat,
    }).damage,
    computeDamage({
      atk: 40, attackType: 'siege', armor: MONSTERS.mob_10.armor, armorType: MONSTERS.mob_10.armorType,
      resist: MONSTERS.mob_10.resist, rng: flat,
    }).damage,
  );
});

test('箭塔打霜壳尸远轻于冰塔，寒霜祭坛仍能减速并刮魔法', () => {
  const dealt = (towerId, shots) => {
    const m = createMatch({ mapId: 'map_01', seed: 2 });
    freeze(m);
    m.gold = 99999;
    const range = TOWERS[towerId].range;
    const slot = slotWithin(m, range);
    assert.ok(slot >= 0);
    assert.equal(buildTower(m, slot, towerId), true);
    const parked = creep(m, slot, 'mob_13');
    assert.ok(parked.gap <= range);
    m.monsters = [parked.mon];
    m.towers[0].cooldown = 0;
    tick(m, shots);
    return 800 - parked.mon.hp;
  };
  const arrow = dealt('tw_arrow', 40);
  const frost = dealt('tw_frost', 40);
  assert.ok(arrow > 0, '箭塔仍然打得到');
  assert.ok(frost > arrow * 1.5, `冰塔 ${frost} 应明显高于箭塔 ${arrow}`);

  const m = createMatch({ mapId: 'map_01', seed: 3 });
  freeze(m);
  m.gold = 99999;
  const slot = slotWithin(m, TOWERS.tw_frost.range);
  assert.equal(buildTower(m, slot, 'tw_frost'), true);
  while (m.towers[0].level < 3) assert.equal(upgradeTower(m, slot), true);
  assert.equal(upgradeTower(m, slot), true);
  assert.equal(m.towers[0].spec, 'frost_shrine');
  const parked = creep(m, slot, 'mob_13');
  assert.ok(parked.gap <= m.towers[0].stats.special.aura.radius);
  m.monsters = [parked.mon];
  m.towers[0].cooldown = 99;
  tick(m, 40);
  assert.ok(parked.mon.hp < 800, '祭坛刮伤要落到霜壳上');
  assert.ok(parked.mon.effects.some((e) => e.type === 'slow'), '霜壳不挡寒霜减速');
  assert.equal(isTargetable(m, parked.mon, true), true);
  assert.equal(sprintState(MONSTERS.mob_02, 0).on, true);
  assert.equal(invisPhase(MONSTERS.mob_11, 0).stealthed, true);
  assert.equal(towerStats('tw_frost', 3, 'frost_shrine').special.detectRadius, 6);
});

test('第 8 波和第 3 轮预告霜壳，第 1 波不放，隐身波仍要侦测', () => {
  assert.equal(wavePreview(1).needsMagic, false);
  assert.doesNotMatch(wavePreview(1).text, /霜壳|需要魔法/);
  const w8 = wavePreview(8);
  assert.ok(w8.chips.some((c) => c.id === 'resist' && c.label === '霜壳' && c.count === 2));
  assert.ok(w8.chips.some((c) => c.id === 'siege'));
  assert.ok(w8.chips.some((c) => c.id === 'air'));
  assert.match(w8.text, /霜壳尸/);
  assert.match(w8.text, /需要魔法/);
  assert.equal(w8.needsMagic, true);
  assert.equal(w8.total, 22);
  assert.deepEqual(creepRoles(MONSTERS.mob_13), ['resist']);
  assert.ok(roleGlyph('resist').some((p) => p.stroke), '霜壳图标要有外圈描边');
  assert.ok(roleGlyph('resist').some((p) => !p.stroke && (p.ellipse || p.d)), '霜壳图标要有填色块，不能只剩线');

  const w3 = wavePreview(3);
  assert.match(w3.text, /冲刺/);
  assert.match(w3.text, /寒霜祭坛可减速冲刺/);
  assert.equal(w3.needsMagic, false);
  const w9 = wavePreview(9);
  assert.match(w9.text, /需要侦测/);
  assert.equal(w9.needsMagic, false);
  assert.ok(wavePreview(17, 3, WAVES_LONG).chips.some((c) => c.id === 'resist' && c.count === 2));
  assert.equal(WAVES[7].groups.reduce((s, g) => s + g.count, 0), 22);

  for (const id of ['def_01']) {
    const round = DEFENSE_MAPS[id].rounds[2];
    assert.equal(round.round, 3);
    assert.ok(round.groups.some((g) => g.mobId === 'mob_13' && g.count === 2));
  }
  const warn = createDefenseMatch({ seed: 4 });
  assert.equal(assaultResistCount(warn), 0, '第一轮没有霜壳');
  assert.equal(assaultStealthCount(warn), 0);
  warn.assault.round = 2;
  assert.equal(assaultResistCount(warn), 2);
  assert.equal(assaultStealthCount(warn), 0);
  assert.ok(upcomingAssaultGroups(warn).some((g) => g.mobId === 'mob_13'));
  warn.assault.timer = DEFENSE_RULES.assaultWarnSec + 0.05;
  warn.assault.warning = false;
  updateDefense(warn, 0.1);
  assert.ok(warn.events.some((e) => e.text.includes('有霜壳') && e.text.includes('需要魔法')));
  assert.ok(!warn.events.some((e) => e.text.includes('有隐身')));

  const invis = createDefenseMatch({ seed: 4 });
  invis.assault.round = 3;
  invis.assault.timer = DEFENSE_RULES.assaultWarnSec + 0.05;
  invis.assault.warning = false;
  updateDefense(invis, 0.1);
  assert.ok(invis.events.some((e) => e.text.includes('有隐身') && e.text.includes('需要侦测')));
  assert.equal(assaultResistCount(invis), 0);

  const L = layoutDefense(warn, { resistAlert: { count: 2 }, rate: 1 });
  assert.equal(L.resistChip.h, 44);
  assert.equal(L.resistChip.y, 70);
  assert.ok(L.resistChip.x + L.resistChip.w <= MINIMAP.x);
  assert.equal(hitTestDefense(L, L.resistChip.x + 8, L.resistChip.y + 8), null);
  const both = layoutDefense(warn, { stealthAlert: { count: 2 }, resistAlert: { count: 2 }, rate: 1 });
  assert.equal(both.stealthChip.y, 70);
  assert.ok(both.resistChip.y >= both.stealthChip.y + both.stealthChip.h);
  const texts = [];
  const ctx = new Proxy({}, {
    get(_t, p) {
      if (p === 'measureText') return () => ({ width: 24 });
      return (...args) => { if (p === 'fillText') texts.push(String(args[0])); };
    },
    set() { return true; },
  });
  drawDefenseHud(ctx, warn, L, {});
  assert.ok(texts.includes('霜壳'));
  assert.ok(texts.includes('需要魔法'));
});

test('霜壳剪影是实线圈，不是隐身虚线，也不是加强甲方块', () => {
  const spec = mobSilhouette(MONSTERS.mob_13);
  assert.equal(spec.shape, 'ward');
  assert.ok(spec.parts.every((p) => !p.points || p.role === 'crystal'));
  const fort = mobSilhouette(MONSTERS.mob_10);
  assert.notEqual(spec.shape, fort.shape);

  const ctxCalls = [];
  const state = { strokeStyle: '', fillStyle: '' };
  const rec = (name) => (...args) => {
    ctxCalls.push({ name, args, strokeStyle: state.strokeStyle, fillStyle: state.fillStyle });
  };
  const ctx = {
    setTransform() {}, fillRect() {}, fillText: rec('fillText'), beginPath() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill: rec('fill'), stroke: rec('stroke'),
    ellipse() {}, arc() {}, save() {}, restore() {}, setLineDash: rec('setLineDash'),
    translate() {}, scale() {}, transform() {}, measureText: () => ({ width: 12 }),
    canvas: {},
  };
  for (const key of ['strokeStyle', 'fillStyle', 'lineWidth', 'globalAlpha', 'font', 'textAlign', 'textBaseline']) {
    Object.defineProperty(ctx, key, {
      set(v) { state[key] = v; },
      get() { return state[key]; },
    });
  }
  const canvas = { clientWidth: 800, clientHeight: 450, width: 0, height: 0, getContext: () => ctx };
  const r = createRenderer(canvas);
  const m = createMatch({ mapId: 'map_01', seed: 1 });
  freeze(m);
  const def = MONSTERS.mob_13;
  m.monsters = [{
    uid: 1, mobId: def.id, def, pathIndex: 0, dist: 0,
    cell: { ...m.map.paths[0].spawn }, hp: def.hp, maxHp: def.hp,
    armorType: def.armorType, isAir: false, attacking: false, dead: false,
  }];
  m.towers = [];
  r.draw({ m, selectedSlot: null, selectedTower: null, now: 0 });
  assert.ok(ctxCalls.some((c) => c.name === 'fillText' && c.args[0] === '壳'));
  assert.ok(ctxCalls.some((c) => c.name === 'stroke' && c.strokeStyle === '#e7edf4'));
  assert.ok(!ctxCalls.some((c) => c.name === 'fill' && c.fillStyle === '#a8b2be'), '霜壳是实心剪影，不是隐身那层灰');
});
