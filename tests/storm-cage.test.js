// 风暴电笼（静电塔满级专精）。不是第 4 级伤害：链式那一发停在 Lv3，雷场按魔法轻击。
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
import { AURA_RING, SCORCH_RING, STORM_RING, createRenderer, towerSilhouette } from '../src/render.js';
import { clearSprites, registerSprite, towerSpriteKey } from '../src/assets.js';
import { layoutSheet } from '../src/minigame/battle.js';
import { deserializeMatch, serializeMatch } from '../src/save.js';
import { applyShared, createSnapshotter } from '../src/protocol.js';

globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };

const CAGE = TOWER_SPEC.tw_static;
const HEARTH = TOWER_SPEC.tw_cannon;
const SHRINE = TOWER_SPEC.tw_frost;
const CHAIN = { chainCount: 3, chainDecay: 0.2, chainRange: 3 };

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

function raiseStatic(m, slot) {
  assert.equal(buildTower(m, slot, 'tw_static'), true);
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
    arcs: ctx.calls.filter((c) => c.name === 'arc' && c.strokeStyle === color),
    images: ctx.calls.filter((c) => c.name === 'drawImage').length,
  };
}

test('风暴电笼：满级才开，价钱与链式曲线分开，卖掉按投入返还', () => {
  const shared = TOWERS.tw_static.special;
  assert.equal(Math.round(TOWERS.tw_static.cost * CAGE.costMul), 288);
  assert.equal(upgradeCost('tw_static', 3), null);
  assert.equal(upgradeCost('tw_arrow', 3), null);
  assert.notEqual(TOWER_SPEC.tw_arrow?.id, CAGE.id);
  assert.equal(towerStats('tw_arrow', 3).special.storm, undefined);

  const plain = towerStats('tw_static', 3);
  const grown = towerStats('tw_static', 3, CAGE.id);
  assert.equal(plain.special, shared, '没专精时仍用共享 special');
  assert.notEqual(grown.special, shared);
  assert.deepEqual(shared, CHAIN);
  assert.equal(grown.damage, plain.damage);
  assert.equal(grown.range, plain.range);
  assert.equal(grown.atkSpeed, plain.atkSpeed);
  assert.equal(grown.attackType, 'magic');
  assert.equal(grown.hitsAir, true);
  assert.deepEqual(
    { chainCount: grown.special.chainCount, chainDecay: grown.special.chainDecay, chainRange: grown.special.chainRange },
    CHAIN,
  );
  assert.equal(grown.special.aura, undefined);
  assert.equal(grown.special.scorch, undefined);
  assert.equal(grown.special.detectRadius, undefined);
  assert.equal(grown.special.storm.detectRadius, undefined);
  assert.deepEqual(grown.special.storm, { radius: 3.0, chip: 5 });
  assert.equal(towerDps('tw_static', 3), grown.damage * grown.atkSpeed);

  const frostPlain = towerStats('tw_frost', 3);
  const frostGrown = towerStats('tw_frost', 3, SHRINE.id);
  assert.equal(frostPlain.special, TOWERS.tw_frost.special);
  assert.deepEqual(frostGrown.special.aura, { radius: 3.2, slowPct: 0.22, chip: 4 });
  assert.equal(frostGrown.special.storm, undefined);
  assert.equal(frostGrown.damage, frostPlain.damage);
  const cannonGrown = towerStats('tw_cannon', 3, HEARTH.id);
  assert.deepEqual(cannonGrown.special.scorch, { radius: 2.8, dps: 8, vsSiege: 0.5 });
  assert.equal(cannonGrown.special.storm, undefined);
  assert.equal(cannonGrown.damage, towerStats('tw_cannon', 3).damage);

  const broke = createMatch({ mapId: 'map_01', seed: 2 });
  freeze(broke);
  broke.gold = 260 + 312 + 572;
  const slot = 0;
  const tower = raiseStatic(broke, slot);
  assert.equal(tower.level, 3);
  assert.equal(broke.gold, 0);
  assert.equal(nextUpgrade(tower).kind, 'spec');
  assert.equal(nextUpgrade(tower).cost, 288);
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
  assert.equal(arrow.stats.special.storm, undefined, '穿云箭楼不铺雷场');
  assert.equal(arrow.stats.damage, towerStats('tw_arrow', 3).damage);
  assert.equal(nextUpgrade(arrow), null);

  const cage = raiseStatic(m, slot);
  assert.equal(nextUpgrade(cage).id, CAGE.id);
  cage.hp = 10;
  const before = m.gold;
  assert.equal(upgradeTower(m, slot), true);
  assert.equal(cage.spec, CAGE.id);
  assert.equal(cage.level, 3);
  assert.equal(cage.hp, 10, '专精不把塔修满');
  assert.equal(m.gold, before - 288);
  assert.equal(cage.invested, 260 + 312 + 572 + 288);
  assert.equal(cage.stats.special.storm.chip, 5);
  assert.equal(cage.stats.damage, plain.damage);
  assert.deepEqual(
    { chainCount: cage.stats.special.chainCount, chainDecay: cage.stats.special.chainDecay, chainRange: cage.stats.special.chainRange },
    CHAIN,
  );
  assert.equal(upgradeTower(m, slot), false);
  assert.equal(nextUpgrade(cage), null);

  const refund = Math.floor(cage.invested * TOWER_SELL_REFUND);
  assert.equal(refund, 859);
  assert.equal(sellTower(m, slot), true);
  assert.equal(m.gold, before - 288 + refund);
  assert.deepEqual(TOWERS.tw_static.special, CHAIN);
  assert.deepEqual(TOWERS.tw_frost.special, { slowPct: 0.30, slowSec: 2, detectRadius: 6 });
  assert.deepEqual(TOWERS.tw_cannon.special, { splashRadius: 1.5 });
});

test('雷场每秒刮一次；空中和地面成团一起吃，圈外和潜行碰不到；霜壳仍吃得到魔法', () => {
  const m = createMatch({ mapId: 'map_01', seed: 3 });
  freeze(m);
  m.gold = 9999;
  const slot = slotWithin(m, CAGE.storm.radius);
  assert.ok(slot >= 0, '路径旁要有一座能罩住雷场的塔位');
  const tower = raiseStatic(m, slot);
  assert.equal(upgradeTower(m, slot), true);
  tower.cooldown = 999;
  const here = nearest(m, slot).index;
  const away = farIndex(m, slot, CAGE.storm.radius);
  assert.ok(away >= 0);

  const a = park(m, slot, 'mob_01', here, { armor: 0 });
  const b = park(m, slot, 'mob_01', here, { armor: 0 });
  const c = park(m, slot, 'mob_01', here, { armor: 0 });
  const air = park(m, slot, 'mob_03', here);
  const far = park(m, slot, 'mob_01', away);
  const shell = park(m, slot, 'mob_13', here, { armor: 2 });
  const troll = park(m, slot, 'mob_04', here, { armor: 2 });
  assert.ok(a.gap <= CAGE.storm.radius);
  assert.ok(air.gap <= CAGE.storm.radius);
  assert.ok(far.gap > CAGE.storm.radius);
  m.monsters = [a.mon, b.mon, c.mon, air.mon, far.mon, shell.mon, troll.mon];

  tick(m, 1);
  assert.equal(a.mon.hp, 5000, '不到一秒不该刮');
  tick(m, 19);
  const drop = (mon) => 5000 - mon.hp;
  assert.equal(drop(a.mon), 3);
  assert.equal(drop(b.mon), 3);
  assert.equal(drop(c.mon), 3);
  assert.ok(drop(a.mon) + drop(b.mon) + drop(c.mon) > drop(a.mon), '成团的每只都吃到雷场');
  assert.equal(drop(air.mon), 3, '雷场对空');
  assert.equal(far.mon.hp, 5000, '圈外不刮');
  assert.ok(drop(shell.mon) >= 8 && drop(shell.mon) <= 9, '霜壳不削魔法');
  assert.ok(drop(troll.mon) >= 8 && drop(troll.mon) <= 9, '同甲重甲没有霜壳，魔法一样打得动');
  assert.ok(drop(shell.mon) > drop(a.mon), '重甲上的魔法刮伤重于中甲');
  assert.equal(a.mon.effects.some((e) => e.type === 'slow'), false, '雷场不减速');
  assert.equal(air.mon.effects.some((e) => e.type === 'slow'), false);
  assert.equal(shell.mon.effects.some((e) => e.type === 'stun'), false, '雷场不眩晕');
  assert.ok((m.stats.damage.tw_static ?? 0) > 0);
  assert.equal(tower.stats.damage, towerStats('tw_static', 3).damage);
  assert.deepEqual(
    { chainCount: tower.stats.special.chainCount, chainDecay: tower.stats.special.chainDecay, chainRange: tower.stats.special.chainRange },
    CHAIN,
  );
  assert.equal(TOWERS.tw_static.special.storm, undefined);

  const once = a.mon.hp;
  tick(m, 20);
  assert.equal(once - a.mon.hp, 3, '再过一秒才刮第二次，不是每帧');

  const bare = createMatch({ mapId: 'map_01', seed: 3 });
  freeze(bare);
  bare.gold = 9999;
  const plain = raiseStatic(bare, slot);
  plain.cooldown = 999;
  const parked = park(bare, slot, 'mob_01', here, { armor: 0 });
  const parkedAir = park(bare, slot, 'mob_03', here);
  bare.monsters = [parked.mon, parkedAir.mon];
  tick(bare, 20);
  assert.equal(parked.mon.hp, 5000, '没专精的静电塔不铺雷场');
  assert.equal(parkedAir.mon.hp, 5000);

  const hidden = createMatch({ mapId: 'map_01', seed: 4 });
  freeze(hidden);
  hidden.gold = 9999;
  const cage = raiseStatic(hidden, slot);
  assert.equal(upgradeTower(hidden, slot), true);
  cage.cooldown = 999;
  const queen = park(hidden, slot, 'mob_11', here);
  hidden.time = 0;
  hidden.monsters = [queen.mon];
  tick(hidden, 20);
  assert.equal(queen.mon.revealed, false);
  assert.equal(isTargetable(hidden, queen.mon, true), false);
  assert.equal(queen.mon.hp, 5000, '雷场自己不揭开潜行');
  assert.equal(cage.stats.special.detectRadius, undefined);
  assert.equal(cage.stats.special.storm.detectRadius, undefined);
});

test('专精不把链加长：同一格四只里只有前三只吃到跳跃', () => {
  const fire = (spec) => {
    const m = createMatch({ mapId: 'map_01', seed: 8 });
    freeze(m);
    m.gold = 9999;
    const slot = slotWithin(m, 3);
    const tower = raiseStatic(m, slot);
    if (spec) assert.equal(upgradeTower(m, slot), true);
    tower.cooldown = 0;
    const here = nearest(m, slot).index;
    const group = [0, 1, 2, 3].map(() => park(m, slot, 'mob_01', here, { armor: 0 }));
    m.monsters = group.map((g) => g.mon);
    tick(m, 5);
    return group.map((g) => 5000 - g.mon.hp);
  };
  for (const drops of [fire(false), fire(true)]) {
    assert.ok(drops[0] > 20, '主目标吃到 Lv3 那一发');
    assert.ok(drops[1] > 10 && drops[2] > 5, '链还是再跳两下');
    assert.equal(drops[3], 0, '第 4 只不在 3 段链里');
  }
});

test('风暴电笼比静电塔更宽，两侧有线圈塔尖和更开的电弧；专精不套 Lv3 静帧', () => {
  const plain = towerSilhouette('tw_static', 3);
  const cage = towerSilhouette('tw_static', 3, CAGE.id);
  assert.ok(span(cage, 0) > span(plain, 0) + 0.8, '电笼要比电杆宽');
  const plainTop = Math.min(...plain.parts.filter((p) => p.role === 'rod').flatMap((p) => p.points.map((pt) => pt[1])));
  const spires = cage.parts.filter((p) => p.role === 'spire' && p.closed);
  assert.equal(spires.length, 2);
  assert.ok(Math.min(...spires.flatMap((p) => p.points.map((pt) => pt[1]))) < plainTop, '线圈塔尖要比 Lv3 电杆更高');
  const wideArcs = cage.parts.filter((p) => p.role === 'arc' && !p.closed
    && p.points.some((pt) => Math.abs(pt[0]) > 1.2));
  assert.equal(wideArcs.length, 2, '左右各一道更开的电弧');
  assert.ok(cage.parts.filter((p) => p.role === 'cage' && p.closed).length >= 3, '笼架是闭合的建筑体量');
  const roles = new Set(cage.parts.map((p) => p.role));
  assert.equal(roles.has('head'), false);
  assert.equal(roles.has('weapon'), false);
  assert.equal(towerSilhouette('tw_static', 3).parts.some((p) => p.role === 'cage'), false, '普通 Lv3 仍是线圈，不是电笼');
  assert.equal(towerSilhouette('tw_frost', 3, SHRINE.id).parts.some((p) => p.role === 'plinth'), true);
  assert.equal(towerSilhouette('tw_cannon', 3, HEARTH.id).parts.some((p) => p.role === 'hearth'), true);

  const m = createMatch({ mapId: 'map_01', seed: 5 });
  freeze(m);
  m.gold = 9999;
  m.monsters = [];
  const tower = raiseStatic(m, 0);
  assert.equal(upgradeTower(m, 0), true);
  try {
    registerSprite(towerSpriteKey('tw_static', 3), { width: 192, height: 192 });
    const specDraw = drawMatch(m);
    assert.equal(ringOf(specDraw, STORM_RING.stroke).images, 0, '专精阶不画 Lv3 静帧');
    assert.ok(specDraw.calls.some((c) => c.name === 'lineTo'), '电笼要画出来');
    tower.spec = null;
    tower.stats = towerStats('tw_static', 3);
    const lv3 = drawMatch(m);
    assert.ok(ringOf(lv3, STORM_RING.stroke).images >= 1, '普通 Lv3 仍用自己的静帧');
  } finally {
    clearSprites();
  }
});

test('雷场圈一直画实线紫圈和两道弧；低特效不呼吸；没专精的静电塔不加圈', () => {
  const m = createMatch({ mapId: 'map_01', seed: 5 });
  freeze(m);
  m.gold = 9999;
  const tower = raiseStatic(m, 0);
  assert.equal(upgradeTower(m, 0), true);
  const idle = drawMatch(m);
  const plain = ringOf(idle, STORM_RING.stroke);
  assert.ok(plain.strokes.length >= 3, '外圈加左右两道弧，没选中也要看见雷场');
  assert.ok(plain.arcs.length >= 2, '两道弧不是焦土那种内圈椭圆');
  assert.ok(plain.strokes.every((c) => c.lineWidth === STORM_RING.lineWidth));
  assert.equal(ringOf(idle, STORM_RING.fill).fills.length, 0, '没选中不填色');
  assert.equal(ringOf(idle, AURA_RING.stroke).strokes.length, 0, '电笼不画寒霜圈');
  assert.equal(ringOf(idle, SCORCH_RING.stroke).strokes.length, 0, '电笼不画焦土圈');

  const pickedCtx = drawMatch(m, { selectedTower: tower.slot });
  const picked = ringOf(pickedCtx, STORM_RING.stroke);
  assert.ok(ringOf(pickedCtx, STORM_RING.fill).fills.length >= 1);
  assert.ok(picked.strokes.some((c) => c.globalAlpha === 1 && c.lineWidth === STORM_RING.lineWidth + 1));

  const stillA = ringOf(drawMatch(m, { fx: 'low', now: 0 }), STORM_RING.stroke);
  const stillB = ringOf(drawMatch(m, { fx: 'low', now: Math.PI / 6 }), STORM_RING.stroke);
  assert.equal(stillA.strokes[0].globalAlpha, 0.92);
  assert.equal(stillB.strokes[0].globalAlpha, 0.92);
  assert.equal(ringOf(drawMatch(m, { pulses: false, now: Math.PI / 2 }), STORM_RING.stroke).strokes[0].globalAlpha, 0.92);

  const breatheA = ringOf(drawMatch(m, { fx: 'high', pulses: true, now: 0 }), STORM_RING.stroke);
  const breatheB = ringOf(drawMatch(m, { fx: 'high', pulses: true, now: Math.PI / 6 }), STORM_RING.stroke);
  assert.ok(Math.abs(breatheA.strokes[0].globalAlpha - breatheB.strokes[0].globalAlpha) > 0.05);

  const bare = createMatch({ mapId: 'map_01', seed: 5 });
  bare.gold = 9999;
  assert.equal(buildTower(bare, 0, 'tw_static'), true);
  const rings = ringOf(drawMatch(bare, { selectedTower: 0 }), STORM_RING.stroke);
  assert.equal(rings.strokes.length, 0, '普通静电塔只有射程，没有雷场圈');
  assert.equal(rings.arcs.length, 0);
});

test('波次预告和建造面板写出雷暴身份，寒霜和焦土那两句还在', () => {
  assert.doesNotMatch(wavePreview(1).text, /风暴电笼/);
  assert.doesNotMatch(wavePreview(2).text, /风暴电笼/, '三只石像鬼不算成团');
  assert.doesNotMatch(wavePreview(3).text, /风暴电笼/);
  assert.match(wavePreview(3).text, /寒霜祭坛可减速冲刺/);
  assert.doesNotMatch(wavePreview(7).text, /风暴电笼/);
  const mixed = wavePreview(8);
  assert.match(mixed.text, /需要魔法/);
  assert.match(mixed.text, /燎野炮台可灼烧攻城/);
  assert.doesNotMatch(mixed.text, /风暴电笼/, '十只空中还没到成团那一档');
  const stealth = wavePreview(9);
  assert.match(stealth.text, /寒霜祭坛可减速冲刺/);
  assert.match(stealth.text, /需要侦测/);
  assert.doesNotMatch(stealth.text, /风暴电笼/);
  const clump = wavePreview(10);
  assert.match(clump.text, /空中/);
  assert.match(clump.text, /风暴电笼可刮空中成团/);
  assert.doesNotMatch(clump.text, /寒霜祭坛/);
  assert.doesNotMatch(clump.text, /燎野炮台/);
  const both = wavePreview(11);
  assert.match(both.text, /风暴电笼可刮空中成团/);
  assert.match(both.text, /燎野炮台可灼烧攻城/);
  assert.doesNotMatch(wavePreview(12).text, /风暴电笼/, '最终 Boss 那波空中没到成团，不跟 Boss 抢一句');
  assert.doesNotMatch(wavePreview(4, 3, WAVES_LONG).text, /风暴电笼/);
  assert.doesNotMatch(wavePreview(9, 3, WAVES_LONG).text, /风暴电笼/);
  assert.match(wavePreview(16, 3, WAVES_LONG).text, /风暴电笼可刮空中成团/);

  const m = createMatch({ mapId: 'map_01', seed: 6 });
  m.gold = 9999;
  const slot = 0;
  const tower = raiseStatic(m, slot);
  const offer = layoutSheet(m, { panelSlot: slot });
  assert.equal(offer.byId.upgrade.label, '风暴电笼');
  assert.equal(offer.byId.upgrade.sub, '288 金');
  assert.equal(offer.byId.upgrade.disabled, false);
  assert.ok(offer.byId.upgrade.h >= 44);
  assert.match(offer.hint, /可升风暴电笼/);
  assert.equal(towerRoleNote(tower), ` · 可升${CAGE.name}（${CAGE.hint}）`);

  m.gold = 287;
  assert.equal(layoutSheet(m, { panelSlot: slot }).byId.upgrade.disabled, true);
  m.gold = 9999;
  assert.equal(upgradeTower(m, slot), true);
  const done = layoutSheet(m, { panelSlot: slot });
  assert.equal(done.title, '风暴电笼');
  assert.equal(done.byId.upgrade.label, '已满级');
  assert.equal(done.byId.upgrade.disabled, true);
  assert.match(done.hint, /雷场/);

  const build = layoutSheet(m, { selectedSlot: 1 });
  assert.match(build.byId['build-tw_static'].sub, /满级雷暴/);
  assert.match(build.byId['build-tw_frost'].sub, /满级支援/);
  assert.match(build.byId['build-tw_cannon'].sub, /满级焦土/);
  assert.match(build.byId['build-tw_arrow'].sub, /满级穿刺/);
  assert.doesNotMatch(build.byId['build-tw_arrow'].sub, /雷暴/);
  assert.ok(build.byId['build-tw_static'].h >= 44);
  const preview = layoutSheet(m, { selectedSlot: 1, placingTowerId: 'tw_static' });
  assert.match(preview.hint, /雷暴/);
});

test('参考打法不买专精；围墙不能升，哨楼射程还是 6', () => {
  const m = createMatch({ mapId: 'map_01', seed: 7 });
  freeze(m);
  m.gold = 99999;
  for (let i = 0; i < m.map.slots.length; i++) {
    const id = i === 0 ? 'tw_static' : i === 1 ? 'tw_frost' : i === 2 ? 'tw_cannon' : 'tw_arrow';
    assert.equal(buildTower(m, i, id), true);
    assert.equal(upgradeTower(m, i), true);
    assert.equal(upgradeTower(m, i), true);
    assert.equal(m.towers.find((t) => t.slot === i).level, 3);
    assert.equal(m.towers.find((t) => t.slot === i).spec, undefined);
  }
  autoPlay(m, { maxSeconds: 1.2 });
  assert.ok(m.towers.every((t) => !t.spec), 'AI 不买寒霜祭坛、燎野炮台，也不买风暴电笼');
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

test('存档和快照带着风暴电笼，旧行没有专精就当没有，寒霜和焦土仍按原塔读', () => {
  const td = createMatch({ mapId: 'map_01', seed: 9 });
  td.gold = 9999;
  raiseStatic(td, 0);
  assert.equal(upgradeTower(td, 0), true);
  assert.equal(buildTower(td, 1, 'tw_frost'), true);
  assert.equal(upgradeTower(td, 1), true);
  assert.equal(upgradeTower(td, 1), true);
  assert.equal(upgradeTower(td, 1), true);
  assert.equal(buildTower(td, 2, 'tw_cannon'), true);
  assert.equal(upgradeTower(td, 2), true);
  assert.equal(upgradeTower(td, 2), true);
  assert.equal(upgradeTower(td, 2), true);

  const back = deserializeMatch(JSON.parse(JSON.stringify(serializeMatch(td))));
  assert.equal(back.towers[0].spec, CAGE.id);
  assert.equal(back.towers[0].stats.special.storm.radius, 3);
  assert.equal(back.towers[0].stats.special.chainCount, 3);
  assert.equal(back.towers[0].stats.special.detectRadius, undefined);
  assert.equal(back.towers[1].spec, SHRINE.id);
  assert.equal(back.towers[1].stats.special.aura.chip, 4);
  assert.equal(back.towers[1].stats.special.storm, undefined);
  assert.equal(back.towers[2].spec, HEARTH.id);
  assert.equal(back.towers[2].stats.special.scorch.dps, 8);
  assert.equal(back.towers[2].stats.special.storm, undefined);
  const legacySave = JSON.parse(JSON.stringify(serializeMatch(td)));
  delete legacySave.towers[0].spec;
  const legacyTd = deserializeMatch(legacySave);
  assert.equal(legacyTd.towers[0].spec, null);
  assert.equal(legacyTd.towers[0].stats.special.storm, undefined);
  assert.equal(legacyTd.towers[0].stats.special.chainCount, 3);

  const snap = createSnapshotter()(td, { full: true });
  assert.equal(snap.tw[0][6], 1);
  assert.equal(snap.tw[1][6], 1);
  assert.equal(snap.tw[2][6], 1);
  const mirror = createMatch({ mapId: 'map_01', seed: 9 });
  applyShared(mirror, snap);
  assert.equal(mirror.towers[0].spec, CAGE.id);
  assert.equal(mirror.towers[0].stats.special.storm.chip, 5);
  assert.equal(mirror.towers[0].stats.special.chainRange, 3);
  assert.equal(mirror.towers[1].spec, SHRINE.id);
  assert.equal(mirror.towers[1].stats.special.aura.slowPct, 0.22);
  assert.equal(mirror.towers[2].spec, HEARTH.id);
  assert.equal(mirror.towers[2].stats.special.scorch.vsSiege, 0.5);
  const oldRow = snap.tw[0].slice(0, 6);
  const oldMirror = createMatch({ mapId: 'map_01', seed: 9 });
  applyShared(oldMirror, { ...snap, tw: [oldRow] });
  assert.equal(oldMirror.towers[0].spec, null);
  assert.equal(oldMirror.towers[0].stats.special.storm, undefined);
});
