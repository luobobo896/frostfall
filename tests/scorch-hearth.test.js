// 燎野炮台（炮塔满级专精）。不是第 4 级伤害：炮弹曲线不动，焦土按攻城灼烧。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORT_WATCH, GRID, MONSTERS, TICK_STEP, TOWERS, TOWER_SELL_REFUND, TOWER_SPEC, WAVES_LONG,
} from '../src/data.js';
import { gridDist } from '../src/core.js';
import { autoPlay } from '../src/ai.js';
import {
  buildTower, createMatch, isTargetable, nextUpgrade, sellTower, towerDps, towerStats, upgradeCost, upgradeTower, update,
} from '../src/match.js';
import { buildFort, createDefenseMatch, upgradeFort } from '../src/defense.js';
import { towerRoleNote, wavePreview } from '../src/hud-model.js';
import { AURA_RING, SCORCH_RING, createRenderer, towerSilhouette } from '../src/render.js';
import { clearSprites, registerSprite, towerSpriteKey } from '../src/assets.js';
import { layoutSheet } from '../src/minigame/battle.js';
import { deserializeMatch, serializeMatch } from '../src/save.js';
import { applyShared, createSnapshotter } from '../src/protocol.js';

globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };

const HEARTH = TOWER_SPEC.tw_cannon;
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

function tick(m, n) {
  for (let i = 0; i < n; i++) update(m, TICK_STEP);
}

function span(spec, axis) {
  const values = [];
  for (const part of spec.parts) {
    for (const pt of part.points ?? []) values.push(pt[axis]);
  }
  return Math.max(...values) - Math.min(...values);
}

function barrelGirth(spec) {
  let best = 0;
  for (const part of spec.parts) {
    if (part.role !== 'barrel') continue;
    const ys = part.points.map((pt) => pt[1]);
    best = Math.max(best, Math.max(...ys) - Math.min(...ys));
  }
  return best;
}

function muzzle(spec) {
  const xs = spec.parts.filter((p) => p.role === 'barrel').flatMap((p) => p.points.map((pt) => pt[0]));
  return Math.max(...xs);
}

function raiseCannon(m, slot) {
  assert.equal(buildTower(m, slot, 'tw_cannon'), true);
  assert.equal(upgradeTower(m, slot), true);
  assert.equal(upgradeTower(m, slot), true);
  return m.towers.find((t) => t.slot === slot);
}

function park(m, slot, mobId, index, { armor = null, hp = 5000, air = null } = {}) {
  const cell = m.map.paths[0].cells[index];
  const def = MONSTERS[mobId];
  return {
    gap: gridDist(cell, m.map.slots[slot]),
    mon: {
      uid: ++m.spawnCounter, mobId, def, pathIndex: 0,
      dist: index * GRID.unitPerTile, cell: { ...cell },
      hp, maxHp: hp, armor: armor ?? def.armor, armorType: def.armorType,
      speed: 0, attack: def.attack, atkSpeed: def.atkSpeed,
      cooldown: 0, isAir: air ?? !!def.isAir, effects: [], dead: false, attacking: false,
    },
  };
}

function farIndex(m, slot, radius) {
  const tower = m.map.slots[slot];
  const cells = m.map.paths[0].cells;
  for (let i = 0; i < cells.length; i++) {
    if (gridDist(cells[i], tower) > radius) return i;
  }
  return -1;
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
    transform: rec('transform'), drawImage: rec('drawImage'), measureText: () => ({ width: 12 }),
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

function drawMatch(m, extra = {}) {
  const ctx = ink();
  const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
  createRenderer(canvas).draw({ m, selectedSlot: null, selectedTower: null, now: 0, ...extra });
  return ctx;
}

function ringOf(ctx, color) {
  return {
    strokes: ctx.calls.filter((c) => c.name === 'stroke' && c.strokeStyle === color),
    fills: ctx.calls.filter((c) => c.name === 'fill' && c.fillStyle === color),
    images: ctx.calls.filter((c) => c.name === 'drawImage').length,
  };
}

test('燎野炮台：满级才开，价钱与炮弹曲线分开，卖掉按投入返还', () => {
  const shared = TOWERS.tw_cannon.special;
  assert.equal(Math.round(TOWERS.tw_cannon.cost * HEARTH.costMul), 288);
  assert.equal(upgradeCost('tw_cannon', 3), null);
  assert.equal(upgradeCost('tw_static', 3), null);
  assert.equal(TOWER_SPEC.tw_arrow, undefined);
  assert.notEqual(TOWER_SPEC.tw_static?.id, HEARTH.id);

  const plain = towerStats('tw_cannon', 3);
  const grown = towerStats('tw_cannon', 3, HEARTH.id);
  assert.equal(plain.special, shared, '没专精时仍用共享 special');
  assert.notEqual(grown.special, shared);
  assert.deepEqual(shared, { splashRadius: 1.5 });
  assert.equal(grown.damage, plain.damage);
  assert.equal(grown.range, plain.range);
  assert.equal(grown.atkSpeed, plain.atkSpeed);
  assert.equal(grown.attackType, 'siege');
  assert.equal(grown.hitsAir, false);
  assert.equal(grown.special.splashRadius, 1.5);
  assert.equal(grown.special.aura, undefined);
  assert.equal(grown.special.detectRadius, undefined);
  assert.deepEqual(grown.special.scorch, { radius: 2.8, dps: 8, vsSiege: 0.5 });
  assert.equal(towerDps('tw_cannon', 3), grown.damage * grown.atkSpeed);

  const frostPlain = towerStats('tw_frost', 3);
  const frostGrown = towerStats('tw_frost', 3, SHRINE.id);
  assert.equal(frostPlain.special, TOWERS.tw_frost.special);
  assert.deepEqual(frostGrown.special.aura, { radius: 3.2, slowPct: 0.22, chip: 4 });
  assert.equal(frostGrown.special.scorch, undefined);
  assert.equal(frostGrown.damage, frostPlain.damage);

  const broke = createMatch({ mapId: 'map_01', seed: 2 });
  freeze(broke);
  broke.gold = 150 + 180 + 330;
  const slot = 0;
  const tower = raiseCannon(broke, slot);
  assert.equal(tower.level, 3);
  assert.equal(broke.gold, 0);
  assert.equal(nextUpgrade(tower).kind, 'spec');
  assert.equal(nextUpgrade(tower).cost, 288);
  assert.equal(upgradeTower(broke, slot), false);
  assert.equal(tower.spec, undefined);

  const m = createMatch({ mapId: 'map_01', seed: 2 });
  freeze(m);
  m.gold = 9999;
  const staticSlot = 1;
  assert.equal(buildTower(m, staticSlot, 'tw_static'), true);
  assert.equal(upgradeTower(m, staticSlot), true);
  assert.equal(upgradeTower(m, staticSlot), true);
  assert.equal(upgradeTower(m, staticSlot), true);
  const staticTower = m.towers.find((t) => t.slot === staticSlot);
  assert.equal(staticTower.level, 3);
  assert.notEqual(staticTower.spec, HEARTH.id, '静电塔的专精不是燎野炮台');
  assert.equal(staticTower.stats.special.scorch, undefined);
  assert.equal(staticTower.stats.attackType, 'magic');

  const cannon = raiseCannon(m, slot);
  assert.equal(nextUpgrade(cannon).id, HEARTH.id);
  cannon.hp = 10;
  const before = m.gold;
  assert.equal(upgradeTower(m, slot), true);
  assert.equal(cannon.spec, HEARTH.id);
  assert.equal(cannon.level, 3);
  assert.equal(cannon.hp, 10, '专精不把塔修满');
  assert.equal(m.gold, before - 288);
  assert.equal(cannon.invested, 150 + 180 + 330 + 288);
  assert.equal(cannon.stats.special.scorch.dps, 8);
  assert.equal(cannon.stats.damage, plain.damage);
  assert.equal(upgradeTower(m, slot), false);
  assert.equal(nextUpgrade(cannon), null);

  const refund = Math.floor(cannon.invested * TOWER_SELL_REFUND);
  assert.equal(refund, 568);
  assert.equal(sellTower(m, slot), true);
  assert.equal(m.gold, before - 288 + refund);
  assert.deepEqual(TOWERS.tw_cannon.special, { splashRadius: 1.5 });
  assert.deepEqual(TOWERS.tw_frost.special, { slowPct: 0.30, slowSec: 2, detectRadius: 6 });
});

test('焦土每秒灼烧一次；成团一起吃，空中、圈外和潜行碰不到；攻城更疼，霜壳仍削攻城', () => {
  const m = createMatch({ mapId: 'map_01', seed: 3 });
  freeze(m);
  m.gold = 9999;
  const slot = slotWithin(m, HEARTH.scorch.radius);
  assert.ok(slot >= 0, '路径旁要有一座能罩住焦土的塔位');
  const tower = raiseCannon(m, slot);
  assert.equal(upgradeTower(m, slot), true);
  tower.cooldown = 999;
  const here = nearest(m, slot).index;
  const away = farIndex(m, slot, HEARTH.scorch.radius);
  assert.ok(away >= 0);

  const a = park(m, slot, 'mob_01', here, { armor: 0 });
  const b = park(m, slot, 'mob_01', here, { armor: 0 });
  const c = park(m, slot, 'mob_01', here, { armor: 0 });
  const air = park(m, slot, 'mob_03', here);
  const far = park(m, slot, 'mob_01', away);
  const siege = park(m, slot, 'mob_10', here, { armor: 0 });
  const shell = park(m, slot, 'mob_13', here, { armor: 2 });
  const troll = park(m, slot, 'mob_04', here, { armor: 2 });
  assert.ok(a.gap <= HEARTH.scorch.radius);
  assert.ok(far.gap > HEARTH.scorch.radius);
  m.monsters = [a.mon, b.mon, c.mon, air.mon, far.mon, siege.mon, shell.mon, troll.mon];

  tick(m, 1);
  assert.equal(a.mon.hp, 5000, '不到一秒不该灼烧');
  tick(m, 19);
  const drop = (mon) => 5000 - mon.hp;
  assert.ok(drop(a.mon) >= 3 && drop(a.mon) <= 4);
  assert.equal(drop(b.mon), drop(a.mon));
  assert.equal(drop(c.mon), drop(a.mon));
  assert.ok(drop(a.mon) + drop(b.mon) + drop(c.mon) > drop(a.mon), '成团的每只都吃到焦土');
  assert.equal(air.mon.hp, 5000, '焦土不对空');
  assert.equal(far.mon.hp, 5000, '圈外不烧');
  assert.ok(drop(siege.mon) >= 17, '攻城单位在加强甲系数之外再吃一截');
  assert.ok(drop(siege.mon) > drop(a.mon) * 3);
  assert.equal(drop(shell.mon), 1, '霜壳仍把攻城削到很轻');
  assert.ok(drop(troll.mon) >= 6, '同甲重甲没有霜壳，焦土打得动');
  assert.ok(drop(shell.mon) < drop(troll.mon));
  assert.equal(a.mon.effects.some((e) => e.type === 'slow'), false, '焦土不减速');
  assert.equal(siege.mon.effects.some((e) => e.type === 'slow'), false);
  assert.ok((m.stats.damage.tw_cannon ?? 0) > 0);
  assert.equal(tower.stats.damage, towerStats('tw_cannon', 3).damage);
  assert.equal(TOWERS.tw_cannon.special.splashRadius, 1.5);

  const once = a.mon.hp;
  tick(m, 20);
  const second = once - a.mon.hp;
  assert.ok(second >= 3 && second <= 4, '再过一秒才烧第二次，不是每帧');

  const bare = createMatch({ mapId: 'map_01', seed: 3 });
  freeze(bare);
  bare.gold = 9999;
  const plain = raiseCannon(bare, slot);
  plain.cooldown = 999;
  const parked = park(bare, slot, 'mob_01', here);
  bare.monsters = [parked.mon];
  tick(bare, 20);
  assert.equal(parked.mon.hp, 5000, '没专精的炮塔不铺焦土');

  const hidden = createMatch({ mapId: 'map_01', seed: 4 });
  freeze(hidden);
  hidden.gold = 9999;
  const hearth = raiseCannon(hidden, slot);
  assert.equal(upgradeTower(hidden, slot), true);
  hearth.cooldown = 999;
  const queen = park(hidden, slot, 'mob_11', here);
  hidden.time = 0;
  hidden.monsters = [queen.mon];
  tick(hidden, 20);
  assert.equal(queen.mon.revealed, false);
  assert.equal(isTargetable(hidden, queen.mon, false), false);
  assert.equal(queen.mon.hp, 5000, '焦土自己不揭开潜行');
  assert.equal(hearth.stats.special.detectRadius, undefined);
});

test('燎野炮台比炮塔更宽，炮管加粗但不加长；专精不套 Lv3 静帧', () => {
  const plain = towerSilhouette('tw_cannon', 3);
  const hearth = towerSilhouette('tw_cannon', 3, HEARTH.id);
  assert.ok(span(hearth, 0) > span(plain, 0), '石炉要比炮墩宽');
  assert.ok(barrelGirth(hearth) > barrelGirth(plain), '炮管要加粗');
  assert.equal(muzzle(hearth), muzzle(plain), '炮口不再往前伸');
  assert.ok(hearth.parts.some((p) => p.role === 'hearth' && p.closed));
  assert.equal(hearth.parts.filter((p) => p.role === 'vent' && p.closed).length, 2);
  const roles = new Set(hearth.parts.map((p) => p.role));
  assert.equal(roles.has('head'), false);
  assert.equal(roles.has('weapon'), false);
  assert.equal(towerSilhouette('tw_frost', 3, SHRINE.id).parts.some((p) => p.role === 'plinth'), true);

  const m = createMatch({ mapId: 'map_01', seed: 5 });
  freeze(m);
  m.gold = 9999;
  m.monsters = [];
  const tower = raiseCannon(m, 0);
  assert.equal(upgradeTower(m, 0), true);
  try {
    registerSprite(towerSpriteKey('tw_cannon', 3), { width: 192, height: 192 });
    const specDraw = drawMatch(m);
    assert.equal(ringOf(specDraw, SCORCH_RING.stroke).images, 0, '专精阶不画 Lv3 静帧');
    assert.ok(specDraw.calls.some((c) => c.name === 'lineTo'), '石炉要画出来');
    tower.spec = null;
    tower.stats = towerStats('tw_cannon', 3);
    const lv3 = drawMatch(m);
    assert.ok(ringOf(lv3, SCORCH_RING.stroke).images >= 1, '普通 Lv3 仍用自己的静帧');
  } finally {
    clearSprites();
  }
});

test('焦土圈一直画实线暖圈；低特效不呼吸；没专精的炮塔不加圈', () => {
  const m = createMatch({ mapId: 'map_01', seed: 5 });
  freeze(m);
  m.gold = 9999;
  const tower = raiseCannon(m, 0);
  assert.equal(upgradeTower(m, 0), true);
  const idle = drawMatch(m);
  const plain = ringOf(idle, SCORCH_RING.stroke);
  assert.ok(plain.strokes.length >= 2, '外圈加内圈，没选中也要看见焦土');
  assert.ok(plain.strokes.every((c) => c.lineWidth === SCORCH_RING.lineWidth));
  assert.equal(ringOf(idle, SCORCH_RING.fill).fills.length, 0, '没选中不填色');
  assert.equal(ringOf(idle, AURA_RING.stroke).strokes.length, 0, '炮台不画寒霜圈');

  const pickedCtx = drawMatch(m, { selectedTower: tower.slot });
  const picked = ringOf(pickedCtx, SCORCH_RING.stroke);
  assert.ok(ringOf(pickedCtx, SCORCH_RING.fill).fills.length >= 1);
  assert.ok(picked.strokes.some((c) => c.globalAlpha === 1 && c.lineWidth === SCORCH_RING.lineWidth + 1));

  const stillA = ringOf(drawMatch(m, { fx: 'low', now: 0 }), SCORCH_RING.stroke);
  const stillB = ringOf(drawMatch(m, { fx: 'low', now: Math.PI / 6 }), SCORCH_RING.stroke);
  assert.equal(stillA.strokes[0].globalAlpha, 0.92);
  assert.equal(stillB.strokes[0].globalAlpha, 0.92);
  assert.equal(ringOf(drawMatch(m, { pulses: false, now: Math.PI / 2 }), SCORCH_RING.stroke).strokes[0].globalAlpha, 0.92);

  const breatheA = ringOf(drawMatch(m, { fx: 'high', pulses: true, now: 0 }), SCORCH_RING.stroke);
  const breatheB = ringOf(drawMatch(m, { fx: 'high', pulses: true, now: Math.PI / 6 }), SCORCH_RING.stroke);
  assert.ok(Math.abs(breatheA.strokes[0].globalAlpha - breatheB.strokes[0].globalAlpha) > 0.05);

  const bare = createMatch({ mapId: 'map_01', seed: 5 });
  bare.gold = 9999;
  assert.equal(buildTower(bare, 0, 'tw_cannon'), true);
  const rings = ringOf(drawMatch(bare, { selectedTower: 0 }), SCORCH_RING.stroke);
  assert.equal(rings.strokes.length, 0, '普通炮塔只有射程，没有焦土圈');
});

test('波次预告和建造面板写出焦土身份，寒霜那句还在', () => {
  assert.doesNotMatch(wavePreview(1).text, /燎野炮台/);
  const sprint = wavePreview(3);
  assert.match(sprint.text, /寒霜祭坛可减速冲刺/);
  assert.doesNotMatch(sprint.text, /燎野炮台/, '一只攻城不够，不跟冲刺预告抢一句');
  assert.doesNotMatch(wavePreview(6).text, /燎野炮台/);
  const clump = wavePreview(8);
  assert.match(clump.text, /需要魔法/);
  assert.match(clump.text, /燎野炮台可灼烧攻城/);
  const stealth = wavePreview(9);
  assert.match(stealth.text, /寒霜祭坛可减速冲刺/);
  assert.match(stealth.text, /需要侦测/);
  assert.doesNotMatch(stealth.text, /燎野炮台/);
  assert.match(wavePreview(11).text, /燎野炮台可灼烧攻城/);
  assert.match(wavePreview(15, 3, WAVES_LONG).text, /燎野炮台可灼烧攻城/);

  const m = createMatch({ mapId: 'map_01', seed: 6 });
  m.gold = 9999;
  const slot = 0;
  const tower = raiseCannon(m, slot);
  const offer = layoutSheet(m, { panelSlot: slot });
  assert.equal(offer.byId.upgrade.label, '燎野炮台');
  assert.equal(offer.byId.upgrade.sub, '288 金');
  assert.equal(offer.byId.upgrade.disabled, false);
  assert.ok(offer.byId.upgrade.h >= 44);
  assert.match(offer.hint, /可升燎野炮台/);
  assert.equal(towerRoleNote(tower), ` · 可升${HEARTH.name}（${HEARTH.hint}）`);

  m.gold = 287;
  assert.equal(layoutSheet(m, { panelSlot: slot }).byId.upgrade.disabled, true);
  m.gold = 9999;
  assert.equal(upgradeTower(m, slot), true);
  const done = layoutSheet(m, { panelSlot: slot });
  assert.equal(done.title, '燎野炮台');
  assert.equal(done.byId.upgrade.label, '已满级');
  assert.equal(done.byId.upgrade.disabled, true);
  assert.match(done.hint, /焦土/);

  const build = layoutSheet(m, { selectedSlot: 1 });
  assert.match(build.byId['build-tw_cannon'].sub, /满级焦土/);
  assert.match(build.byId['build-tw_frost'].sub, /满级支援/);
  assert.doesNotMatch(build.byId['build-tw_arrow'].sub, /满级/);
  assert.match(build.byId['build-tw_static'].sub, /满级雷暴/);
  assert.ok(build.byId['build-tw_cannon'].h >= 44);
  const preview = layoutSheet(m, { selectedSlot: 1, placingTowerId: 'tw_cannon' });
  assert.match(preview.hint, /焦土/);
});

test('参考打法不买专精；围墙不能升，哨楼射程还是 6', () => {
  const m = createMatch({ mapId: 'map_01', seed: 7 });
  freeze(m);
  m.gold = 99999;
  for (let i = 0; i < m.map.slots.length; i++) {
    const id = i === 0 ? 'tw_cannon' : i === 1 ? 'tw_frost' : 'tw_arrow';
    assert.equal(buildTower(m, i, id), true);
    assert.equal(upgradeTower(m, i), true);
    assert.equal(upgradeTower(m, i), true);
    assert.equal(m.towers.find((t) => t.slot === i).level, 3);
  }
  autoPlay(m, { maxSeconds: 1.2 });
  assert.ok(m.towers.every((t) => !t.spec), 'AI 不买寒霜祭坛，也不买燎野炮台');
  assert.ok(m.towers.every((t) => t.level === 3));

  const dm = createDefenseMatch({ seed: 7 });
  dm.gold = 500;
  assert.equal(buildFort(dm, 0, 'fort_arrow'), true);
  assert.equal(buildFort(dm, 1, 'fort_wall'), true);
  assert.equal(upgradeFort(dm, 1), false);
  assert.equal(upgradeFort(dm, 0), true);
  const watch = dm.forts.find((f) => f.slot === 0);
  assert.equal(watch.tier, 1);
  assert.equal(watch.stats.range, 6);
  assert.equal(watch.maxHp, FORT_WATCH.hp);
  assert.equal(upgradeFort(dm, 0), false);
});

test('存档和快照带着燎野炮台，旧行没有专精就当没有，寒霜祭坛仍按冰塔读', () => {
  const td = createMatch({ mapId: 'map_01', seed: 9 });
  td.gold = 9999;
  raiseCannon(td, 0);
  assert.equal(upgradeTower(td, 0), true);
  assert.equal(buildTower(td, 1, 'tw_frost'), true);
  assert.equal(upgradeTower(td, 1), true);
  assert.equal(upgradeTower(td, 1), true);
  assert.equal(upgradeTower(td, 1), true);

  const back = deserializeMatch(JSON.parse(JSON.stringify(serializeMatch(td))));
  assert.equal(back.towers[0].spec, HEARTH.id);
  assert.equal(back.towers[0].stats.special.scorch.radius, 2.8);
  assert.equal(back.towers[0].stats.special.splashRadius, 1.5);
  assert.equal(back.towers[1].spec, SHRINE.id);
  assert.equal(back.towers[1].stats.special.aura.chip, 4);
  const legacySave = JSON.parse(JSON.stringify(serializeMatch(td)));
  delete legacySave.towers[0].spec;
  const legacyTd = deserializeMatch(legacySave);
  assert.equal(legacyTd.towers[0].spec, null);
  assert.equal(legacyTd.towers[0].stats.special.scorch, undefined);

  const snap = createSnapshotter()(td, { full: true });
  assert.equal(snap.tw[0][6], 1);
  assert.equal(snap.tw[1][6], 1);
  const mirror = createMatch({ mapId: 'map_01', seed: 9 });
  applyShared(mirror, snap);
  assert.equal(mirror.towers[0].spec, HEARTH.id);
  assert.equal(mirror.towers[0].stats.special.scorch.vsSiege, 0.5);
  assert.equal(mirror.towers[1].spec, SHRINE.id);
  assert.equal(mirror.towers[1].stats.special.aura.slowPct, 0.22);
  const oldRow = snap.tw[0].slice(0, 6);
  const oldMirror = createMatch({ mapId: 'map_01', seed: 9 });
  applyShared(oldMirror, { ...snap, tw: [oldRow] });
  assert.equal(oldMirror.towers[0].spec, null);
  assert.equal(oldMirror.towers[0].stats.special.scorch, undefined);
});
