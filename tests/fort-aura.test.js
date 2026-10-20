// 寒霜祭坛（冰塔满级专精）与哨楼（箭塔工事升阶）。
// 专精不是第 4 级伤害：攻击曲线不动，光环自己不侦测。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORTS, FORT_WATCH, GRID, MONSTERS, TICK_STEP, TOWERS, TOWER_SELL_REFUND, TOWER_SPEC, fortStatsOf,
} from '../src/data.js';
import { gridDist } from '../src/core.js';
import {
  buildTower, createMatch, isTargetable, sellTower, towerDps, towerStats, upgradeCost, upgradeTower, update,
} from '../src/match.js';
import {
  buildFort, createDefenseMatch, fortTapTarget, updateDefense, upgradeFort,
} from '../src/defense.js';
import { towerRoleNote, wavePreview } from '../src/hud-model.js';
import { AURA_RING, createRenderer, fortSilhouette, towerSilhouette } from '../src/render.js';
import { layoutSheet } from '../src/minigame/battle.js';
import { layoutFortSheet } from '../src/minigame/defense-screen.js';
import { deserializeMatch, serializeMatch } from '../src/save.js';
import {
  applyDefenseShared, applyShared, createDefenseSnapshotter, createSnapshotter,
} from '../src/protocol.js';

globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };

const SHRINE = TOWER_SPEC.tw_frost;

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
      hp: 500, maxHp: 500, armor: def.armor, armorType: def.armorType,
      speed: 0, attack: def.attack, atkSpeed: def.atkSpeed,
      cooldown: 0, isAir: !!def.isAir, effects: [], dead: false, attacking: false,
    },
  };
}

function tick(m, n, step = update) {
  for (let i = 0; i < n; i++) step(m, TICK_STEP);
}

function span(spec, axis) {
  const values = [];
  for (const part of spec.parts) {
    for (const pt of part.points ?? []) values.push(pt[axis]);
  }
  return Math.max(...values) - Math.min(...values);
}

function raiseFrost(m, slot) {
  assert.equal(buildTower(m, slot, 'tw_frost'), true);
  assert.equal(upgradeTower(m, slot), true);
  assert.equal(upgradeTower(m, slot), true);
  return m.towers.find((t) => t.slot === slot);
}

function ink() {
  const calls = [];
  const state = { strokeStyle: '', fillStyle: '', lineWidth: 1, globalAlpha: 1 };
  const rec = (name) => (...args) => {
    calls.push({
      name, args,
      strokeStyle: state.strokeStyle, fillStyle: state.fillStyle,
      lineWidth: state.lineWidth, globalAlpha: state.globalAlpha,
    });
  };
  const ctx = {
    calls,
    setTransform: rec('setTransform'), fillRect: rec('fillRect'), fillText: rec('fillText'),
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    closePath: rec('closePath'), fill: rec('fill'), stroke: rec('stroke'),
    ellipse: rec('ellipse'), arc: rec('arc'), save: rec('save'), restore: rec('restore'),
    setLineDash: rec('setLineDash'), translate: rec('translate'), scale: rec('scale'),
    transform: rec('transform'), measureText: () => ({ width: 12 }),
    rect: rec('rect'), clip: rec('clip'),
  };
  for (const key of ['strokeStyle', 'fillStyle', 'lineWidth', 'globalAlpha', 'font', 'textAlign']) {
    Object.defineProperty(ctx, key, {
      set(v) { state[key] = v; },
      get() { return state[key]; },
    });
  }
  return ctx;
}

function auraStrokes(m, extra = {}) {
  const ctx = ink();
  const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
  createRenderer(canvas).draw({ m, selectedSlot: null, selectedTower: null, now: 0, ...extra });
  return {
    strokes: ctx.calls.filter((c) => c.name === 'stroke' && c.strokeStyle === AURA_RING.stroke),
    fills: ctx.calls.filter((c) => c.name === 'fill' && c.fillStyle === AURA_RING.fill),
  };
}

test('寒霜祭坛：满级才开，价钱与攻击曲线分开，卖掉按投入返还', () => {
  const shared = TOWERS.tw_frost.special;
  assert.equal(Math.round(TOWERS.tw_frost.cost * SHRINE.costMul), 288);
  assert.equal(upgradeCost('tw_arrow', 3), null);
  assert.equal(upgradeCost('tw_frost', 3), null);

  const plain = towerStats('tw_frost', 3);
  const grown = towerStats('tw_frost', 3, SHRINE.id);
  assert.equal(plain.special, shared, '没专精时仍用共享 special');
  assert.notEqual(grown.special, shared);
  assert.deepEqual(shared, { slowPct: 0.30, slowSec: 2, detectRadius: 6 });
  assert.equal(grown.damage, plain.damage);
  assert.equal(grown.range, plain.range);
  assert.equal(grown.atkSpeed, plain.atkSpeed);
  assert.equal(grown.attackType, 'magic');
  assert.equal(grown.special.detectRadius, 6);
  assert.equal(grown.special.aura.detectRadius, undefined);
  assert.deepEqual(grown.special.aura, { radius: 3.2, slowPct: 0.22, chip: 4 });
  assert.equal(towerDps('tw_frost', 3), grown.damage * grown.atkSpeed);

  const broke = createMatch({ mapId: 'map_01', seed: 2 });
  freeze(broke);
  broke.gold = 120 + 144 + 264;
  const slot = 0;
  const tower = raiseFrost(broke, slot);
  assert.equal(tower.level, 3);
  assert.equal(broke.gold, 0);
  assert.equal(upgradeTower(broke, slot), false);
  assert.equal(tower.spec, undefined);

  const m = createMatch({ mapId: 'map_01', seed: 2 });
  freeze(m);
  m.gold = 9999;
  const arrowSlot = 1;
  assert.equal(buildTower(m, arrowSlot, 'tw_arrow'), true);
  assert.equal(upgradeTower(m, arrowSlot), true);
  assert.equal(upgradeTower(m, arrowSlot), true);
  assert.equal(upgradeTower(m, arrowSlot), true);
  const arrow = m.towers.find((t) => t.slot === arrowSlot);
  assert.equal(arrow.spec, TOWER_SPEC.tw_arrow.id);
  assert.equal(arrow.level, 3);
  assert.equal(arrow.stats.special.aura, undefined, '穿云箭楼不挂寒霜光环');
  assert.equal(arrow.stats.attackType, 'normal');

  const frost = raiseFrost(m, slot);
  frost.hp = 10;
  const before = m.gold;
  assert.equal(upgradeTower(m, slot), true);
  assert.equal(frost.spec, SHRINE.id);
  assert.equal(frost.level, 3);
  assert.equal(frost.hp, 10, '专精不把塔修满');
  assert.equal(m.gold, before - 288);
  assert.equal(frost.invested, 120 + 144 + 264 + 288);
  assert.equal(frost.stats.special.aura.slowPct, 0.22);
  assert.equal(upgradeTower(m, slot), false);
  assert.equal(m.gold, before - 288);

  const refund = Math.floor(frost.invested * TOWER_SELL_REFUND);
  assert.equal(refund, 489);
  assert.equal(sellTower(m, slot), true);
  assert.equal(m.gold, before - 288 + refund);
  assert.deepEqual(TOWERS.tw_frost.special, { slowPct: 0.30, slowSec: 2, detectRadius: 6 });
});

test('寒霜光环减速并每秒刮一下；关掉侦测之后碰不到潜行怪', () => {
  const m = createMatch({ mapId: 'map_01', seed: 3 });
  freeze(m);
  m.gold = 9999;
  const slot = slotWithin(m, SHRINE.aura.radius);
  assert.ok(slot >= 0, '路径旁要有一座能罩住光环的塔位');
  const tower = raiseFrost(m, slot);
  assert.equal(upgradeTower(m, slot), true);
  tower.cooldown = 999;
  const parked = creep(m, slot, 'mob_01');
  assert.ok(parked.gap <= SHRINE.aura.radius);
  m.monsters = [parked.mon];
  tick(m, 1);
  const slow = parked.mon.effects.find((e) => e.type === 'slow');
  assert.equal(slow?.pct, 0.22);
  assert.equal(parked.mon.hp, 500, '不到一秒不该刮血');
  tick(m, 19);
  assert.ok(parked.mon.hp < 500);
  assert.ok(parked.mon.hp >= 500 - 6, '一秒只刮一下，不是每帧 1 点');
  assert.ok((m.stats.damage.tw_frost ?? 0) > 0);
  assert.equal(parked.mon.effects.find((e) => e.type === 'slow')?.pct, 0.22);
  assert.equal(parked.mon.revealed, true);

  const hidden = createMatch({ mapId: 'map_01', seed: 3 });
  freeze(hidden);
  hidden.gold = 9999;
  const shrine = raiseFrost(hidden, slot);
  assert.equal(upgradeTower(hidden, slot), true);
  shrine.cooldown = 999;
  shrine.stats.special = { ...shrine.stats.special, detectRadius: 0 };
  const queen = creep(hidden, slot, 'mob_11');
  hidden.time = 0;
  hidden.monsters = [queen.mon];
  tick(hidden, 20);
  assert.equal(queen.mon.revealed, false);
  assert.equal(isTargetable(hidden, queen.mon), false);
  assert.equal(queen.mon.effects.some((e) => e.type === 'slow'), false);
  assert.equal(queen.mon.hp, 500, '光环自己不揭开潜行');
  assert.equal(TOWERS.tw_frost.special.detectRadius, 6);

  const seen = createMatch({ mapId: 'map_01', seed: 4 });
  freeze(seen);
  seen.gold = 9999;
  const watch = raiseFrost(seen, slot);
  assert.equal(upgradeTower(seen, slot), true);
  watch.cooldown = 999;
  const revealed = creep(seen, slot, 'mob_11');
  seen.monsters = [revealed.mon];
  tick(seen, 1);
  assert.equal(revealed.mon.revealed, true, '既有侦测仍揭开，不是光环新加的');
  assert.equal(revealed.mon.effects.find((e) => e.type === 'slow')?.pct, 0.22);
});

test('寒霜祭坛比冰塔更宽，哨楼比门楼更高更宽，仍矮于箭塔', () => {
  const frost = towerSilhouette('tw_frost', 3);
  const shrine = towerSilhouette('tw_frost', 3, SHRINE.id);
  assert.ok(span(shrine, 0) > span(frost, 0), '石环要比水晶簇宽');
  assert.ok(shrine.parts.some((p) => p.role === 'plinth' && p.closed));
  assert.equal(shrine.parts.filter((p) => p.role === 'menhir' && p.closed).length, 2);
  const roles = new Set(shrine.parts.map((p) => p.role));
  assert.equal(roles.has('head'), false);
  assert.equal(roles.has('weapon'), false);

  const gate = fortSilhouette('fort_arrow', 0);
  const watch = fortSilhouette('fort_arrow', 1);
  assert.equal(watch.tier, 1);
  assert.ok(span(watch, 1) > span(gate, 1));
  assert.ok(span(watch, 0) > span(gate, 0));
  assert.equal(watch.parts.filter((p) => p.role === 'watch' && p.closed).length, 3);
  assert.ok(span(watch, 1) < span(towerSilhouette('tw_arrow', 1), 1), '哨楼仍矮于 TD 箭塔');
});

test('寒霜光环一直画实线冷圈；低特效不呼吸；没专精的冰塔不加圈', () => {
  const m = createMatch({ mapId: 'map_01', seed: 5 });
  freeze(m);
  m.gold = 9999;
  const slot = 0;
  const tower = raiseFrost(m, slot);
  assert.equal(upgradeTower(m, slot), true);
  const plain = auraStrokes(m);
  assert.ok(plain.strokes.length >= 1, '没选中也要看见光环');
  assert.ok(plain.strokes.every((c) => c.lineWidth === AURA_RING.lineWidth));
  assert.equal(plain.fills.length, 0);

  const picked = auraStrokes(m, { selectedTower: tower.slot });
  assert.ok(picked.fills.length >= 1);
  assert.ok(picked.strokes.some((c) => c.globalAlpha === 1 && c.lineWidth === AURA_RING.lineWidth + 1));

  const stillA = auraStrokes(m, { fx: 'low', now: 0 });
  const stillB = auraStrokes(m, { fx: 'low', now: Math.PI / 6 });
  assert.equal(stillA.strokes[0].globalAlpha, 0.92);
  assert.equal(stillB.strokes[0].globalAlpha, 0.92);
  const quiet = auraStrokes(m, { pulses: false, now: Math.PI / 2 });
  assert.equal(quiet.strokes[0].globalAlpha, 0.92);

  const breatheA = auraStrokes(m, { fx: 'high', pulses: true, now: 0 });
  const breatheB = auraStrokes(m, { fx: 'high', pulses: true, now: Math.PI / 6 });
  assert.ok(Math.abs(breatheA.strokes[0].globalAlpha - breatheB.strokes[0].globalAlpha) > 0.05);

  const bare = createMatch({ mapId: 'map_01', seed: 5 });
  bare.gold = 9999;
  assert.equal(buildTower(bare, 0, 'tw_frost'), true);
  const rings = auraStrokes(bare, { selectedTower: 0 });
  assert.equal(rings.strokes.length, 0, '普通冰塔只有射程和侦测，没有光环');
});

test('波次预告和建造面板写出支援身份', () => {
  const sprint = wavePreview(3);
  assert.match(sprint.text, /冲刺/);
  assert.match(sprint.text, /寒霜祭坛可减速冲刺/);
  assert.doesNotMatch(wavePreview(1).text, /寒霜祭坛/);
  const both = wavePreview(9);
  assert.match(both.text, /需要侦测/);
  assert.match(both.text, /寒霜祭坛可减速冲刺/);

  const m = createMatch({ mapId: 'map_01', seed: 6 });
  m.gold = 9999;
  const slot = 0;
  const tower = raiseFrost(m, slot);
  const offer = layoutSheet(m, { panelSlot: slot });
  assert.equal(offer.byId.upgrade.label, '寒霜祭坛');
  assert.equal(offer.byId.upgrade.sub, '288 金');
  assert.equal(offer.byId.upgrade.disabled, false);
  assert.ok(offer.byId.upgrade.h >= 44);
  assert.match(offer.hint, /可升寒霜祭坛/);
  assert.equal(towerRoleNote(tower), ` · 可升${SHRINE.name}（${SHRINE.hint}）`);

  m.gold = 287;
  assert.equal(layoutSheet(m, { panelSlot: slot }).byId.upgrade.disabled, true);
  m.gold = 9999;
  assert.equal(upgradeTower(m, slot), true);
  const done = layoutSheet(m, { panelSlot: slot });
  assert.equal(done.title, '寒霜祭坛');
  assert.equal(done.byId.upgrade.label, '已满级');
  assert.equal(done.byId.upgrade.disabled, true);
  assert.match(done.hint, /寒霜光环/);

  const build = layoutSheet(m, { selectedSlot: 1 });
  assert.match(build.byId['build-tw_frost'].sub, /满级支援/);
  assert.ok(build.byId['build-tw_frost'].h >= 44);
  const preview = layoutSheet(m, { selectedSlot: 1, placingTowerId: 'tw_frost' });
  assert.match(preview.hint, /支援/);
});

test('哨楼：多一格射程，剪影变厚，围墙不能升', () => {
  const m = createDefenseMatch({ seed: 7 });
  m.gold = 1000;
  for (const c of m.camps) c.timer = 9999;
  m.assault.timer = 9999;
  m.hero.dead = true;
  m.hero.reviveTimer = 999;
  assert.equal(buildFort(m, 0, 'fort_arrow'), true);
  assert.equal(buildFort(m, 1, 'fort_wall'), true);
  const fort = m.forts.find((f) => f.slot === 0);
  fort.hp = 40;
  const cell = fort.cell;
  const mon = {
    uid: 4, mobId: 'mob_01', def: MONSTERS.mob_01, kind: 'field',
    cell: { x: cell.x + 6, y: cell.y }, hp: 5000, maxHp: 5000,
    armor: 1, armorType: 'medium', attack: 1, atkSpeed: 1, speed: 0,
    cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
    active: false, path: [], pathAt: -1,
  };
  assert.equal(gridDist(mon.cell, cell), 6);
  m.monsters = [mon];
  tick(m, 30, updateDefense);
  assert.equal(mon.hp, 5000, '门楼射程 5，打不到 6 格外');

  assert.equal(upgradeFort(m, 1), false);
  m.gold = FORT_WATCH.cost - 1;
  assert.equal(upgradeFort(m, 0), false);
  assert.equal(fort.tier, 0);
  m.gold = 500;
  const gold = m.gold;
  assert.equal(upgradeFort(m, 0), true);
  assert.equal(m.gold, gold - FORT_WATCH.cost);
  assert.equal(fort.tier, 1);
  assert.equal(fort.stats.range, 6);
  assert.equal(fort.stats.damage, FORTS.fort_arrow.damage);
  assert.equal(fort.stats.detectRadius, FORTS.fort_arrow.detectRadius);
  assert.equal(fort.hp, FORT_WATCH.hp);
  assert.equal(fort.maxHp, FORT_WATCH.hp);
  assert.equal(upgradeFort(m, 0), false);
  assert.equal(fortTapTarget(m, cell), null, '升完不再弹出升级');
  assert.deepEqual(fortTapTarget(m, m.def.fortSlots[2]), { slot: 2, d: 0, kind: 'build' });

  const fresh = createDefenseMatch({ seed: 7 });
  fresh.gold = 500;
  assert.equal(buildFort(fresh, 0, 'fort_arrow'), true);
  assert.deepEqual(fortTapTarget(fresh, fresh.forts[0].cell), { slot: 0, d: 0, kind: 'upgrade' });

  m.monsters = [mon];
  mon.hp = 5000;
  tick(m, 30, updateDefense);
  assert.ok(mon.hp < 5000, '哨楼射程 6，这一格打得到');

  const sheet = layoutFortSheet(m, { upgradeSlot: 0 });
  assert.equal(sheet.byId['fort-upgrade'].label, '哨楼');
  assert.equal(sheet.byId['fort-upgrade'].disabled, true, '已经是哨楼就点不了');
  assert.equal(sheet.byId['fort-upgrade'].action.type, 'upgradeFort');
  assert.ok(sheet.byId['fort-upgrade'].h >= 44);
  assert.equal(sheet.byId.cancel.action.type, 'close');

  const poor = createDefenseMatch({ seed: 8 });
  poor.gold = 200;
  assert.equal(buildFort(poor, 0, 'fort_arrow'), true);
  poor.gold = 10;
  const ask = layoutFortSheet(poor, { upgradeSlot: 0 });
  assert.equal(ask.byId['fort-upgrade'].disabled, true);
  assert.match(ask.byId['fort-upgrade'].sub, /80 金/);

  const list = layoutFortSheet(poor, { freeSlots: 3 });
  assert.equal(list.rows.length, Object.keys(FORTS).length + 1);
  assert.equal(list.rows.some((r) => r.action.type === 'upgradeFort'), false);
  assert.equal(fortStatsOf('fort_wall', 1), null);
});

test('存档和快照带着专精与哨楼，旧行没有这两位就当没有', () => {
  const td = createMatch({ mapId: 'map_01', seed: 9 });
  td.gold = 9999;
  raiseFrost(td, 0);
  assert.equal(upgradeTower(td, 0), true);
  const back = deserializeMatch(JSON.parse(JSON.stringify(serializeMatch(td))));
  assert.equal(back.towers[0].spec, SHRINE.id);
  assert.equal(back.towers[0].level, 3);
  assert.equal(back.towers[0].stats.special.aura.radius, 3.2);
  const legacySave = JSON.parse(JSON.stringify(serializeMatch(td)));
  delete legacySave.towers[0].spec;
  const legacyTd = deserializeMatch(legacySave);
  assert.equal(legacyTd.towers[0].spec, null);
  assert.equal(legacyTd.towers[0].stats.special.aura, undefined);

  const snap = createSnapshotter()(td, { full: true });
  assert.equal(snap.tw[0][6], 1);
  const mirror = createMatch({ mapId: 'map_01', seed: 9 });
  applyShared(mirror, snap);
  assert.equal(mirror.towers[0].spec, SHRINE.id);
  assert.equal(mirror.towers[0].stats.special.aura.chip, 4);
  const oldRow = snap.tw[0].slice(0, 6);
  const oldMirror = createMatch({ mapId: 'map_01', seed: 9 });
  applyShared(oldMirror, { ...snap, tw: [oldRow] });
  assert.equal(oldMirror.towers[0].spec, null);
  assert.equal(oldMirror.towers[0].stats.special.aura, undefined);

  const dm = createDefenseMatch({ seed: 9 });
  dm.gold = 500;
  assert.equal(buildFort(dm, 0, 'fort_arrow'), true);
  assert.equal(upgradeFort(dm, 0), true);
  const dback = deserializeMatch(JSON.parse(JSON.stringify(serializeMatch(dm))));
  assert.equal(dback.forts[0].tier, 1);
  assert.equal(dback.forts[0].stats.range, 6);
  assert.equal(dback.forts[0].maxHp, FORT_WATCH.hp);
  const oldFort = JSON.parse(JSON.stringify(serializeMatch(dm)));
  delete oldFort.forts[0].tier;
  const plainFort = deserializeMatch(oldFort);
  assert.equal(plainFort.forts[0].tier, 0);
  assert.equal(plainFort.forts[0].stats.range, FORTS.fort_arrow.range);

  const dsnap = createDefenseSnapshotter()(dm, { full: true });
  assert.equal(dsnap.forts[0][3], 1);
  const dmirror = createDefenseMatch({ seed: 9 });
  applyDefenseShared(dmirror, dsnap);
  assert.equal(dmirror.forts[0].tier, 1);
  assert.equal(dmirror.forts[0].stats.range, 6);
  const short = dsnap.forts[0].slice(0, 3);
  const dold = createDefenseMatch({ seed: 9 });
  applyDefenseShared(dold, { ...dsnap, forts: [short] });
  assert.equal(dold.forts[0].tier, 0);
  assert.equal(dold.forts[0].stats.range, 5);
});
