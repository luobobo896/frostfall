// 穿云箭楼（箭塔满级专精）。不是第 4 级伤害：普通射击停在 Lv3，风线按穿刺贯穿成团。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORT_WATCH, GRID, MONSTERS, TICK_STEP, TOWERS, TOWER_SELL_REFUND, TOWER_SPEC, WAVES_LONG,
} from '../src/data.js';
import { gridDist } from '../src/core.js';
import { autoPlay } from '../src/ai.js';
import {
  buildTower, createMatch, isTargetable, nextUpgrade, sellTower, sprintState, towerDps, towerStats, upgradeCost, upgradeTower, update,
} from '../src/match.js';
import { buildFort, createDefenseMatch, upgradeFort } from '../src/defense.js';
import { towerRoleNote, wavePreview } from '../src/hud-model.js';
import { AURA_RING, SCORCH_RING, STORM_RING, WIND_RING, createRenderer, fortSilhouette, towerSilhouette } from '../src/render.js';
import { clearSprites, registerSprite, towerSpriteKey } from '../src/assets.js';
import { layoutSheet } from '../src/minigame/battle.js';
import { deserializeMatch, serializeMatch } from '../src/save.js';
import { applyShared, createSnapshotter } from '../src/protocol.js';

globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };

const KEEP = TOWER_SPEC.tw_arrow;
const SHRINE = TOWER_SPEC.tw_frost;
const HEARTH = TOWER_SPEC.tw_cannon;
const CAGE = TOWER_SPEC.tw_static;

function freeze(m) {
  m.wave.phase = 'prep';
  m.wave.timer = 9999;
  m.hero.dead = true;
  m.hero.reviveTimer = 999;
}

function tick(m, n) {
  for (let i = 0; i < n; i++) update(m, TICK_STEP);
}

function raiseArrow(m, slot) {
  assert.equal(buildTower(m, slot, 'tw_arrow'), true);
  assert.equal(upgradeTower(m, slot), true);
  assert.equal(upgradeTower(m, slot), true);
  return m.towers.find((t) => t.slot === slot);
}

function park(m, index, mobId, { armor = null, hp = 5000, air = null, pathIndex = 0 } = {}) {
  const cell = m.map.paths[pathIndex].cells[index];
  const def = MONSTERS[mobId];
  return {
    uid: ++m.spawnCounter, mobId, def, pathIndex,
    dist: index * GRID.unitPerTile, cell: { ...cell },
    hp, maxHp: hp, armor: armor ?? def.armor, armorType: def.armorType,
    speed: 0, attack: def.attack, atkSpeed: def.atkSpeed,
    cooldown: 0, isAir: air ?? !!def.isAir, effects: [], dead: false, attacking: false,
  };
}

function topOf(spec, role) {
  const parts = role ? spec.parts.filter((p) => p.role === role) : spec.parts;
  return Math.min(...parts.flatMap((p) => (p.points ?? []).map((pt) => pt[1])));
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
    arcs: ctx.calls.filter((c) => c.name === 'arc' && c.strokeStyle === color),
    ellipses: ctx.calls.filter((c) => c.name === 'ellipse' && c.strokeStyle === color),
    images: ctx.calls.filter((c) => c.name === 'drawImage').length,
  };
}

test('穿云箭楼：满级才开，价钱与普通射击分开，卖掉按投入返还', () => {
  const shared = TOWERS.tw_arrow.special;
  assert.equal(Math.round(TOWERS.tw_arrow.cost * KEEP.costMul), 288);
  assert.equal(upgradeCost('tw_arrow', 3), null);
  assert.equal(KEEP.id, 'cloud_keep');
  assert.notEqual(KEEP.id, SHRINE.id);
  assert.notEqual(KEEP.id, HEARTH.id);
  assert.notEqual(KEEP.id, CAGE.id);

  const plain = towerStats('tw_arrow', 3);
  const grown = towerStats('tw_arrow', 3, KEEP.id);
  assert.equal(plain.special, shared, '没专精时仍用共享 special');
  assert.notEqual(grown.special, shared);
  assert.deepEqual(shared, {});
  assert.equal(grown.damage, plain.damage);
  assert.equal(grown.range, plain.range);
  assert.equal(grown.atkSpeed, plain.atkSpeed);
  assert.equal(grown.attackType, 'normal');
  assert.equal(grown.hitsAir, true);
  assert.equal(grown.special.aura, undefined);
  assert.equal(grown.special.scorch, undefined);
  assert.equal(grown.special.storm, undefined);
  assert.equal(grown.special.detectRadius, undefined);
  assert.deepEqual(grown.special.wind, { reach: 5.5, span: 2, chip: 5, vsAir: 1 });
  assert.equal(towerDps('tw_arrow', 3), grown.damage * grown.atkSpeed);
  assert.equal(towerStats('tw_frost', 3, SHRINE.id).special.wind, undefined);
  assert.equal(towerStats('tw_cannon', 3, HEARTH.id).special.wind, undefined);
  assert.equal(towerStats('tw_static', 3, CAGE.id).special.wind, undefined);
  assert.equal(towerStats('tw_arrow', 3, SHRINE.id).special.wind, undefined, '别人的专精 id 挂不到箭塔上');

  const broke = createMatch({ mapId: 'map_01', seed: 2 });
  freeze(broke);
  broke.gold = 60 + 72 + 132;
  const slot = 0;
  const tower = raiseArrow(broke, slot);
  assert.equal(tower.level, 3);
  assert.equal(broke.gold, 0);
  assert.equal(nextUpgrade(tower).kind, 'spec');
  assert.equal(nextUpgrade(tower).cost, 288);
  assert.equal(nextUpgrade(tower).label, '穿云箭楼');
  assert.equal(upgradeTower(broke, slot), false);
  assert.equal(tower.spec, undefined);

  const m = createMatch({ mapId: 'map_01', seed: 2 });
  freeze(m);
  m.gold = 9999;
  const keep = raiseArrow(m, slot);
  assert.equal(nextUpgrade(keep).id, KEEP.id);
  keep.hp = 10;
  const before = m.gold;
  assert.equal(upgradeTower(m, slot), true);
  assert.equal(keep.spec, KEEP.id);
  assert.equal(keep.level, 3);
  assert.equal(keep.hp, 10, '专精不把塔修满');
  assert.equal(m.gold, before - 288);
  assert.equal(keep.invested, 60 + 72 + 132 + 288);
  assert.equal(keep.stats.special.wind.chip, 5);
  assert.equal(keep.stats.damage, plain.damage);
  assert.equal(keep.stats.attackType, 'normal');
  assert.equal(upgradeTower(m, slot), false);
  assert.equal(nextUpgrade(keep), null);

  const refund = Math.floor(keep.invested * TOWER_SELL_REFUND);
  assert.equal(refund, 331);
  assert.equal(sellTower(m, slot), true);
  assert.equal(m.gold, before - 288 + refund);
  assert.deepEqual(TOWERS.tw_arrow.special, {});
  assert.deepEqual(TOWERS.tw_frost.special, { slowPct: 0.30, slowSec: 2, detectRadius: 6 });
  assert.deepEqual(TOWERS.tw_cannon.special, { splashRadius: 1.5 });
});

test('风线每秒贯穿一次；空中更重，线上成团一起吃，圈外和潜行碰不到；霜壳仍削穿刺', () => {
  const m = createMatch({ mapId: 'map_01', seed: 3 });
  freeze(m);
  m.gold = 9999;
  const slot = 0;
  const towerCell = m.map.slots[slot];
  const cells = m.map.paths[0].cells;
  assert.ok(gridDist(cells[0], towerCell) <= 5.5);
  assert.ok(gridDist(cells[1], towerCell) <= 5.5);
  assert.ok(gridDist(cells[3], towerCell) <= 5.5);
  assert.ok(gridDist(cells[7], towerCell) <= 5.5, '射程内但离开风线的那一格');
  assert.ok(gridDist(cells[8], towerCell) > 5.5, '射程外');
  const tower = raiseArrow(m, slot);
  assert.equal(upgradeTower(m, slot), true);
  tower.cooldown = 999;

  const air = park(m, 3, 'mob_03', { armor: 0 });
  const along = park(m, 1, 'mob_01', { armor: 0 });
  const clump = park(m, 3, 'mob_01', { armor: 0 });
  const nearer = park(m, 0, 'mob_01', { armor: 0 });
  const inRange = park(m, 7, 'mob_01', { armor: 0 });
  const far = park(m, 8, 'mob_01', { armor: 0 });
  const shell = park(m, 3, 'mob_13', { armor: 2 });
  const troll = park(m, 3, 'mob_04', { armor: 2 });
  m.monsters = [air, along, clump, nearer, inRange, far, shell, troll];

  tick(m, 1);
  assert.equal(clump.hp, 5000, '不到一秒不该打出风线');
  tick(m, 19);
  const drop = (mon) => 5000 - mon.hp;
  assert.equal(drop(air), 7, '空中吃到穿刺加成');
  assert.equal(drop(clump), 3, '同一格的地面也吃到穿刺');
  assert.equal(drop(along), 3, '焦点前后两格内的成团一起吃');
  assert.ok(drop(air) > drop(clump), '对空更重，不是把普通射击抬高');
  assert.equal(nearer.hp, 5000, '更靠近塔、但不在风线上的怪吃不到');
  assert.equal(inRange.hp, 5000, '还在射程里、但离开焦点两格的怪吃不到');
  assert.equal(far.hp, 5000, '射程外不打');
  assert.equal(drop(shell), 1, '霜壳照削穿刺');
  assert.equal(drop(troll), 4, '同甲重甲没有霜壳，穿刺照常');
  assert.ok(drop(shell) < drop(troll));
  assert.equal(air.effects.some((e) => e.type === 'slow'), false, '风线不减速');
  assert.equal(clump.effects.some((e) => e.type === 'stun'), false);
  assert.ok((m.stats.damage.tw_arrow ?? 0) > 0);
  assert.equal(tower.stats.damage, towerStats('tw_arrow', 3).damage);
  assert.equal(tower.stats.attackType, 'normal');
  assert.equal(tower.stats.special.detectRadius, undefined);
  assert.equal(TOWERS.tw_arrow.special.wind, undefined);

  const once = clump.hp;
  tick(m, 20);
  assert.equal(once - clump.hp, 3, '再过一秒才打第二次，不是每帧');

  const bare = createMatch({ mapId: 'map_01', seed: 3 });
  freeze(bare);
  bare.gold = 9999;
  const plain = raiseArrow(bare, slot);
  plain.cooldown = 999;
  const parked = park(bare, 3, 'mob_01', { armor: 0 });
  const parkedAir = park(bare, 3, 'mob_03', { armor: 0 });
  bare.monsters = [parked, parkedAir];
  tick(bare, 20);
  assert.equal(parked.hp, 5000, '没专精的箭塔不打风线');
  assert.equal(parkedAir.hp, 5000);

  const hidden = createMatch({ mapId: 'map_01', seed: 4 });
  freeze(hidden);
  hidden.gold = 9999;
  const keep = raiseArrow(hidden, slot);
  assert.equal(upgradeTower(hidden, slot), true);
  keep.cooldown = 999;
  const queen = park(hidden, 3, 'mob_11');
  const bait = park(hidden, 3, 'mob_01', { armor: 0 });
  hidden.time = 0;
  hidden.monsters = [queen, bait];
  tick(hidden, 20);
  assert.equal(queen.revealed, false);
  assert.equal(isTargetable(hidden, queen, true), false);
  assert.equal(queen.hp, 5000, '风线自己不揭开潜行');
  assert.ok(bait.hp < 5000, '旁边已经显形的怪仍吃得到');
  assert.equal(keep.stats.special.detectRadius, undefined);

  const wolf = park(m, 3, 'mob_02', { armor: 0 });
  assert.equal(wolf.effects.some((e) => e.type === 'slow'), false);
  assert.ok(sprintState(wolf.def, 0).mul > 1, '霜狼的冲刺表还在');
});

test('普通射击不因专精变重，也不改成穿刺', () => {
  const fire = (spec) => {
    const m = createMatch({ mapId: 'map_01', seed: 8 });
    freeze(m);
    m.gold = 9999;
    const tower = raiseArrow(m, 0);
    if (spec) assert.equal(upgradeTower(m, 0), true);
    tower.cooldown = 0;
    const mon = park(m, 0, 'mob_01', { armor: 0 });
    m.monsters = [mon];
    tick(m, 5);
    return { drop: 5000 - mon.hp, attackType: tower.stats.attackType, damage: tower.stats.damage };
  };
  const plain = fire(false);
  const grown = fire(true);
  assert.ok(plain.drop > 20, 'Lv3 那一发要打中');
  assert.equal(grown.drop, plain.drop, '专精不改这一发的伤害');
  assert.equal(grown.attackType, 'normal');
  assert.equal(grown.damage, plain.damage);
});

test('穿云箭楼比箭塔更高，有双射孔和风标；专精不套 Lv3 静帧', () => {
  const plain = towerSilhouette('tw_arrow', 3);
  const keep = towerSilhouette('tw_arrow', 3, KEEP.id);
  assert.ok(topOf(keep) < topOf(plain), '风标要比 Lv3 屋顶更高');
  assert.ok(topOf(keep, 'battlement') < topOf(plain, 'battlement'), '女墙要比 Lv3 垛口更高');
  assert.equal(keep.parts.filter((p) => p.role === 'slit').length, 2);
  assert.equal(keep.parts.filter((p) => p.role === 'vane').length, 2);
  assert.ok(topOf(keep, 'vane') < topOf(plain), '风标高出原塔');
  const roles = new Set(keep.parts.map((p) => p.role));
  assert.equal(roles.has('head'), false);
  assert.equal(roles.has('weapon'), false);
  assert.equal(plain.parts.some((p) => p.role === 'vane' || p.role === 'slit'), false, '普通 Lv3 仍是垛口，不是箭楼');
  const watch = fortSilhouette('fort_arrow', 1);
  assert.ok(topOf(keep) < topOf(watch), '穿云箭楼高于哨楼，两套工事不混');
  assert.equal(watch.parts.some((p) => p.role === 'vane' || p.role === 'slit'), false);

  const m = createMatch({ mapId: 'map_01', seed: 5 });
  freeze(m);
  m.gold = 9999;
  m.monsters = [];
  const tower = raiseArrow(m, 0);
  assert.equal(upgradeTower(m, 0), true);
  try {
    registerSprite(towerSpriteKey('tw_arrow', 3), { width: 192, height: 192 });
    const specDraw = drawMatch(m);
    assert.equal(ringOf(specDraw, WIND_RING.stroke).images, 0, '专精阶不画 Lv3 静帧');
    assert.ok(specDraw.calls.some((c) => c.name === 'lineTo'), '箭楼要画出来');
    tower.spec = null;
    tower.stats = towerStats('tw_arrow', 3);
    const lv3 = drawMatch(m);
    assert.ok(ringOf(lv3, WIND_RING.stroke).images >= 1, '普通 Lv3 仍用自己的静帧');
  } finally {
    clearSprites();
  }
});

test('风线一直画两条实线和风标；低特效不呼吸；没专精的箭塔不加线', () => {
  const m = createMatch({ mapId: 'map_01', seed: 5 });
  freeze(m);
  m.gold = 9999;
  const tower = raiseArrow(m, 0);
  assert.equal(upgradeTower(m, 0), true);
  const idle = drawMatch(m);
  const plain = ringOf(idle, WIND_RING.stroke);
  assert.ok(plain.strokes.length >= 2, '没选中也要看见两条风线和风标');
  assert.equal(plain.arcs.length, 0, '风线不是雷场那种弧');
  assert.equal(plain.ellipses.length, 0, '风线不是光环那种圆');
  assert.ok(plain.strokes.every((c) => c.lineWidth === WIND_RING.lineWidth));
  assert.equal(ringOf(idle, WIND_RING.fill).fills.length, 0, '没选中不填色');
  assert.equal(ringOf(idle, AURA_RING.stroke).strokes.length, 0);
  assert.equal(ringOf(idle, SCORCH_RING.stroke).strokes.length, 0);
  assert.equal(ringOf(idle, STORM_RING.stroke).strokes.length, 0);

  const pickedCtx = drawMatch(m, { selectedTower: tower.slot });
  const picked = ringOf(pickedCtx, WIND_RING.stroke);
  assert.ok(ringOf(pickedCtx, WIND_RING.fill).fills.length >= 1, '选中才填一层');
  assert.ok(picked.strokes.some((c) => c.globalAlpha === 1 && c.lineWidth === WIND_RING.lineWidth + 1));

  const stillA = ringOf(drawMatch(m, { fx: 'low', now: 0 }), WIND_RING.stroke);
  const stillB = ringOf(drawMatch(m, { fx: 'low', now: Math.PI / 6 }), WIND_RING.stroke);
  assert.equal(stillA.strokes[0].globalAlpha, 0.92);
  assert.equal(stillB.strokes[0].globalAlpha, 0.92);
  assert.equal(ringOf(drawMatch(m, { pulses: false, now: Math.PI / 2 }), WIND_RING.stroke).strokes[0].globalAlpha, 0.92);

  const breatheA = ringOf(drawMatch(m, { fx: 'high', pulses: true, now: 0 }), WIND_RING.stroke);
  const breatheB = ringOf(drawMatch(m, { fx: 'high', pulses: true, now: Math.PI / 6 }), WIND_RING.stroke);
  assert.ok(Math.abs(breatheA.strokes[0].globalAlpha - breatheB.strokes[0].globalAlpha) > 0.05);

  const bare = createMatch({ mapId: 'map_01', seed: 5 });
  bare.gold = 9999;
  assert.equal(buildTower(bare, 0, 'tw_arrow'), true);
  const rings = ringOf(drawMatch(bare, { selectedTower: 0 }), WIND_RING.stroke);
  assert.equal(rings.strokes.length, 0, '普通箭塔只有射程，没有风线');
  assert.equal(rings.arcs.length, 0);
});

test('波次预告和建造面板写出穿刺身份，只在重空中才提一句', () => {
  assert.doesNotMatch(wavePreview(1).text, /穿云箭楼/);
  assert.doesNotMatch(wavePreview(2).text, /穿云箭楼/, '三只石像鬼不算重空中');
  assert.doesNotMatch(wavePreview(3).text, /穿云箭楼/);
  assert.match(wavePreview(3).text, /寒霜祭坛可减速冲刺/);
  assert.doesNotMatch(wavePreview(8).text, /穿云箭楼/);
  assert.match(wavePreview(8).text, /燎野炮台可灼烧攻城/);
  const firstAir = wavePreview(10);
  assert.match(firstAir.text, /风暴电笼可刮空中成团/);
  assert.doesNotMatch(firstAir.text, /穿云箭楼/, '十五只空中是风暴电笼那一档，不再加一句');
  const heavy = wavePreview(11);
  assert.match(heavy.text, /穿云箭楼可贯穿重空中/);
  assert.match(heavy.text, /风暴电笼可刮空中成团/);
  assert.match(heavy.text, /燎野炮台可灼烧攻城/);
  assert.doesNotMatch(wavePreview(12).text, /穿云箭楼/, '最终 Boss 那波空中没到这一档');
  assert.doesNotMatch(wavePreview(4, 3, WAVES_LONG).text, /穿云箭楼/);
  assert.doesNotMatch(wavePreview(9, 3, WAVES_LONG).text, /穿云箭楼/);
  assert.match(wavePreview(16, 3, WAVES_LONG).text, /穿云箭楼可贯穿重空中/);

  const m = createMatch({ mapId: 'map_01', seed: 6 });
  m.gold = 9999;
  const slot = 0;
  const tower = raiseArrow(m, slot);
  const offer = layoutSheet(m, { panelSlot: slot });
  assert.equal(offer.byId.upgrade.label, '穿云箭楼');
  assert.equal(offer.byId.upgrade.sub, '288 金');
  assert.equal(offer.byId.upgrade.disabled, false);
  assert.ok(offer.byId.upgrade.h >= 44);
  assert.match(offer.hint, /可升穿云箭楼/);
  assert.equal(towerRoleNote(tower), ` · 可升${KEEP.name}（${KEEP.hint}）`);

  m.gold = 287;
  assert.equal(layoutSheet(m, { panelSlot: slot }).byId.upgrade.disabled, true);
  m.gold = 9999;
  assert.equal(upgradeTower(m, slot), true);
  const done = layoutSheet(m, { panelSlot: slot });
  assert.equal(done.title, '穿云箭楼');
  assert.equal(done.byId.upgrade.label, '已满级');
  assert.equal(done.byId.upgrade.disabled, true);
  assert.match(done.hint, /风线/);

  const build = layoutSheet(m, { selectedSlot: 1 });
  assert.match(build.byId['build-tw_arrow'].sub, /满级穿刺/);
  assert.match(build.byId['build-tw_frost'].sub, /满级支援/);
  assert.match(build.byId['build-tw_cannon'].sub, /满级焦土/);
  assert.match(build.byId['build-tw_static'].sub, /满级雷暴/);
  assert.ok(build.byId['build-tw_arrow'].h >= 44);
  const preview = layoutSheet(m, { selectedSlot: 1, placingTowerId: 'tw_arrow' });
  assert.match(preview.hint, /穿刺/);
});

test('参考打法不买穿云箭楼；哨楼和双峰隘口的路长不动', () => {
  const m = createMatch({ mapId: 'map_01', seed: 7 });
  freeze(m);
  m.gold = 99999;
  for (let i = 0; i < m.map.slots.length; i++) {
    const id = i === 0 ? 'tw_arrow' : i === 1 ? 'tw_frost' : i === 2 ? 'tw_cannon' : 'tw_static';
    assert.equal(buildTower(m, i, id), true);
    assert.equal(upgradeTower(m, i), true);
    assert.equal(upgradeTower(m, i), true);
    assert.equal(m.towers.find((t) => t.slot === i).level, 3);
    assert.equal(m.towers.find((t) => t.slot === i).spec, undefined);
  }
  autoPlay(m, { maxSeconds: 1.2 });
  assert.ok(m.towers.every((t) => !t.spec), 'AI 不买穿云箭楼，也不买另外三座专精');
  assert.ok(m.towers.every((t) => t.level === 3));

  const dm = createDefenseMatch({ seed: 7 });
  dm.gold = 500;
  assert.equal(buildFort(dm, 0, 'fort_arrow'), true);
  assert.equal(buildFort(dm, 1, 'fort_wall'), true);
  assert.equal(upgradeFort(dm, 1), false);
  assert.equal(upgradeFort(dm, 0), true);
  const watch = dm.forts.find((f) => f.slot === 0);
  assert.equal(watch.tier, 1);
  assert.equal(watch.stats.name, '哨楼');
  assert.equal(watch.stats.range, 6);
  assert.equal(watch.maxHp, FORT_WATCH.hp);
  assert.equal(upgradeFort(dm, 0), false);

  const peaks = createMatch({ mapId: 'map_02', seed: 4 });
  const lens = peaks.map.paths.map((p) => p.cells.length);
  assert.notEqual(lens[0], lens[1], '双峰隘口两条路本来就不等长');
  freeze(peaks);
  peaks.gold = 9999;
  const built = raiseArrow(peaks, 0);
  assert.equal(upgradeTower(peaks, 0), true);
  assert.equal(built.spec, KEEP.id);
  tick(peaks, 40);
  assert.deepEqual(peaks.map.paths.map((p) => p.cells.length), lens);
});

test('存档和快照带着穿云箭楼，旧行没有专精就当没有', () => {
  const td = createMatch({ mapId: 'map_01', seed: 9 });
  td.gold = 9999;
  raiseArrow(td, 0);
  assert.equal(upgradeTower(td, 0), true);
  assert.equal(buildTower(td, 1, 'tw_frost'), true);
  assert.equal(upgradeTower(td, 1), true);
  assert.equal(upgradeTower(td, 1), true);
  assert.equal(upgradeTower(td, 1), true);

  const back = deserializeMatch(JSON.parse(JSON.stringify(serializeMatch(td))));
  assert.equal(back.towers[0].spec, KEEP.id);
  assert.equal(back.towers[0].stats.special.wind.span, 2);
  assert.equal(back.towers[0].stats.attackType, 'normal');
  assert.equal(back.towers[0].stats.special.detectRadius, undefined);
  assert.equal(back.towers[1].spec, SHRINE.id);
  assert.equal(back.towers[1].stats.special.aura.chip, 4);
  assert.equal(back.towers[1].stats.special.wind, undefined);
  const legacySave = JSON.parse(JSON.stringify(serializeMatch(td)));
  delete legacySave.towers[0].spec;
  const legacyTd = deserializeMatch(legacySave);
  assert.equal(legacyTd.towers[0].spec, null);
  assert.equal(legacyTd.towers[0].stats.special.wind, undefined);
  assert.equal(legacyTd.towers[0].stats.attackType, 'normal');

  const snap = createSnapshotter()(td, { full: true });
  assert.equal(snap.tw[0][6], 1);
  assert.equal(snap.tw[1][6], 1);
  const mirror = createMatch({ mapId: 'map_01', seed: 9 });
  applyShared(mirror, snap);
  assert.equal(mirror.towers[0].spec, KEEP.id);
  assert.equal(mirror.towers[0].stats.special.wind.vsAir, 1);
  assert.equal(mirror.towers[0].stats.damage, towerStats('tw_arrow', 3).damage);
  assert.equal(mirror.towers[1].spec, SHRINE.id);
  const oldRow = snap.tw[0].slice(0, 6);
  const oldMirror = createMatch({ mapId: 'map_01', seed: 9 });
  applyShared(oldMirror, { ...snap, tw: [oldRow] });
  assert.equal(oldMirror.towers[0].spec, null);
  assert.equal(oldMirror.towers[0].stats.special.wind, undefined);
});
