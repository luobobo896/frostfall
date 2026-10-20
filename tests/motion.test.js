// P2：动作是纯函数；画到画布上时，静止帧不改剪影，动起来靠形状而不是只靠颜色。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMatch, buildTower } from '../src/match.js';
import { createRenderer } from '../src/render.js';
import { HEROES, MONSTERS, TOWERS } from '../src/data.js';
import { project } from '../src/core.js';
import {
  FX_LIMITS, attackPulse, chargePulse, fxBudget, heroMotion, impactGlyphs, mobMotion,
  poseClip, poseFrame, shotGlyphs, shotKind, slowShards, towerMarks, towerNudge,
} from '../src/motion.js';

globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };

const glyphSig = (glyphs) => JSON.stringify(glyphs.map((g) => ({
  closed: !!g.closed,
  ellipse: g.ellipse ? 'ellipse' : '',
  n: g.points?.length ?? 0,
})));

test('静止姿势没有偏移，开火才有后坐和蓄力', () => {
  assert.equal(mobMotion({ now: 0, uid: 3, cooldown: 0, atkSpeed: 1 }).dy, 0);
  assert.notEqual(mobMotion({ now: 0.4, uid: 3, cooldown: 0, atkSpeed: 1 }).dy, 0);
  assert.ok(Math.abs(mobMotion({ now: 0.01, isAir: true }).bob) > Math.abs(mobMotion({ now: 0.01, isAir: false }).bob));
  assert.equal(attackPulse(0, 1.5), 0);
  assert.ok(attackPulse(1 / 1.5, 1.5) > 0.9);
  assert.equal(chargePulse(0, 1), 0);
  assert.ok(chargePulse(0.05, 1) > 0);
  assert.deepEqual(towerNudge('tw_arrow', 0), { dx: 0, dy: 0 });
  assert.ok(towerNudge('tw_cannon', 1).dx > towerNudge('tw_arrow', 1).dx);
  assert.equal(heroMotion({ now: 0, cooldown: 0, atkSpeed: 1 }).dx, 0);
  assert.equal(heroMotion({ dead: true }).dissolve, true);
  assert.equal(poseClip({ moving: true }), 'walk');
  assert.equal(poseClip({ pulse: 1, moving: true }), 'attack');
  assert.equal(poseClip({ dead: true, pulse: 1 }), 'death');
  assert.equal(poseFrame('walk', { now: 0 }), 0, 'now===0 停在休息帧');
  assert.ok(poseFrame('walk', { now: 0.2 }) >= 1);
  assert.equal(poseFrame('attack', { pulse: 0 }), 0);
  assert.equal(poseFrame('attack', { pulse: 0.9 }), 1);
  assert.equal(poseFrame('death', { deathT: 0 }), 1);
  assert.equal(poseFrame('death', { deathT: 0.8 }), 2);
  for (const id of Object.keys(TOWERS)) assert.equal(towerMarks(id, 0, 0).length, 0);
});

test('四种弹道和命中的形状互不相同，减速是菱形不是圆', () => {
  const kinds = ['chevron', 'shell', 'shard', 'bolt'];
  assert.deepEqual(['tw_arrow', 'tw_cannon', 'tw_frost', 'tw_static'].map(shotKind), kinds);
  const shots = kinds.map((k) => glyphSig(shotGlyphs(k, 0, 0, 1, 0, 10)));
  assert.equal(new Set(shots).size, 4, '四种弹道的拓扑必须不同');
  assert.equal(shotGlyphs('shell', 0, 0, 1, 0, 10)[0].closed, true);
  assert.equal(shotGlyphs('chevron', 0, 0, 1, 0, 10)[0].closed, false);
  assert.ok(shotGlyphs('bolt', 0, 0, 1, 0, 10)[0].points.length >= 4);
  const impacts = kinds.map((k) => glyphSig(impactGlyphs(k, 0, 0, 10)));
  assert.equal(new Set(impacts).size, 4);
  assert.ok(impactGlyphs('shell', 0, 0, 10)[0].ellipse);
  assert.ok(!impactGlyphs('chevron', 0, 0, 10).some((g) => g.ellipse));
  const shards = slowShards(0.3);
  assert.equal(shards.length, 3);
  for (const s of shards) assert.equal(s.length, 4, '减速印记是菱形');
  assert.equal(fxBudget('low').trail, FX_LIMITS.low.trail);
  assert.ok(FX_LIMITS.low.trail < FX_LIMITS.high.trail);
  assert.ok(FX_LIMITS.low.impacts < FX_LIMITS.high.impacts);
  assert.ok(FX_LIMITS.low.corpses <= 12);
});

function fakeContext() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push({ name, args }); };
  return {
    calls,
    setTransform: rec('setTransform'), fillRect: rec('fillRect'), fillText: rec('fillText'),
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    closePath: rec('closePath'), fill: rec('fill'), stroke: rec('stroke'),
    ellipse: rec('ellipse'), save: rec('save'), restore: rec('restore'),
    setLineDash: rec('setLineDash'),
    drawImage: rec('drawImage'),
  };
}

const lines = (ctx) => ctx.calls.filter((c) => c.name === 'lineTo').length;
const closed = (ctx) => ctx.calls.filter((c) => c.name === 'closePath').length;

function scene() {
  const ctx = fakeContext();
  const canvas = { clientWidth: 800, clientHeight: 450, width: 0, height: 0, getContext: () => ctx };
  const r = createRenderer(canvas);
  const m = createMatch({ mapId: 'map_01', seed: 2 });
  m.gold = 9999;
  m.towers = [];
  m.monsters = [];
  m.projectiles = [];
  return { ctx, r, m };
}

const mob = (def, extra = {}) => ({
  uid: extra.uid ?? 7, mobId: def.id, def, pathIndex: 0, dist: 0,
  cell: { x: 4, y: 4 }, hp: extra.hp ?? def.hp, maxHp: def.hp,
  armorType: def.armorType, isAir: !!def.isAir, attacking: false, dead: false,
  cooldown: 0, atkSpeed: 1, effects: extra.effects ?? [],
});

test('减速、受击、死亡淡出、炮塔后坐会多出笔画，静止帧不会', () => {
  const plain = scene();
  plain.m.monsters = [mob(MONSTERS.mob_01)];
  plain.r.draw({ m: plain.m, now: 0 });
  const icy = scene();
  icy.m.monsters = [mob(MONSTERS.mob_01, { effects: [{ type: 'slow', pct: 0.3, until: 5 }] })];
  icy.m.time = 1;
  icy.r.draw({ m: icy.m, now: 0.2 });
  assert.ok(closed(icy.ctx) >= closed(plain.ctx) + 3, '减速要多出三颗封闭菱形');

  const hit = scene();
  const mo = mob(MONSTERS.mob_02, { hp: 70 });
  hit.m.monsters = [mo];
  hit.r.draw({ m: hit.m, now: 1 });
  const before = lines(hit.ctx);
  mo.hp = 20;
  hit.ctx.calls.length = 0;
  hit.r.draw({ m: hit.m, now: 1 });
  assert.ok(lines(hit.ctx) > before, '掉血下一帧要画出受击斜线');

  const death = scene();
  death.m.monsters = [mob(MONSTERS.mob_01, { uid: 9 })];
  death.r.draw({ m: death.m, now: 0 });
  death.m.monsters = [];
  death.ctx.calls.length = 0;
  death.r.draw({ m: death.m, now: 0 });
  const faded = lines(death.ctx);
  const empty = scene();
  empty.r.draw({ m: empty.m, now: 0 });
  assert.ok(faded > lines(empty.ctx), '怪消失后这一帧还留着淡出残影');

  const idle = scene();
  assert.ok(buildTower(idle.m, 0, 'tw_cannon'));
  idle.m.towers[0].cooldown = 0;
  idle.r.draw({ m: idle.m, now: 0 });
  const kick = scene();
  assert.ok(buildTower(kick.m, 0, 'tw_cannon'));
  kick.m.towers[0].cooldown = 1 / kick.m.towers[0].stats.atkSpeed;
  kick.r.draw({ m: kick.m, now: 0 });
  assert.ok(lines(kick.ctx) > lines(idle.ctx), '炮塔刚开火要多出后坐的笔画');
});

test('弹道按塔种换形状，低档拖尾更短，命中残留有上限', () => {
  const shoot = (towerId, fx) => {
    const s = scene();
    const cell = s.m.map.slots[0];
    s.m.projectiles = [{
      from: project(cell.x, cell.y, 1.1),
      target: { cell: { x: cell.x + 4, y: cell.y }, dead: false },
      stats: TOWERS[towerId],
      towerId,
      progress: 0.5,
      life: 1,
    }];
    s.r.draw({ m: s.m, now: 0.2, fx });
    return s;
  };
  const arrow = shoot('tw_arrow', 'high');
  const cannon = shoot('tw_cannon', 'high');
  assert.ok(closed(cannon.ctx) > closed(arrow.ctx), '炮弹是封闭形，箭是开口箭头');
  const low = shoot('tw_arrow', 'low');
  assert.ok(lines(arrow.ctx) > lines(low.ctx), '低档拖尾段数更少');

  const burst = scene();
  const cell = burst.m.map.slots[0];
  const shots = [];
  for (let i = 0; i < 20; i++) {
    shots.push({
      from: project(cell.x, cell.y, 1.1),
      target: { cell: { x: cell.x + 2, y: cell.y }, dead: false },
      stats: TOWERS.tw_cannon,
      towerId: 'tw_cannon',
      progress: 0.5,
      life: 1,
    });
  }
  burst.m.projectiles = shots;
  burst.r.draw({ m: burst.m, now: 0, fx: 'high' });
  burst.m.projectiles = [];
  burst.ctx.calls.length = 0;
  burst.r.draw({ m: burst.m, now: 0.05, fx: 'high' });
  const ellipses = burst.ctx.calls.filter((c) => c.name === 'ellipse').length;
  const quiet = scene();
  quiet.r.draw({ m: quiet.m, now: 0.05, fx: 'high' });
  const extra = ellipses - quiet.ctx.calls.filter((c) => c.name === 'ellipse').length;
  assert.ok(extra <= FX_LIMITS.high.impacts, `命中残留 ${extra} 超过上限 ${FX_LIMITS.high.impacts}`);
  assert.ok(extra >= 1, '消失的炮弹要留下命中');
});

test('一整帧的动作开销有上限', () => {
  const s = scene();
  s.m.gold = 99999;
  for (let i = 0; i < 4; i++) buildTower(s.m, i, i % 2 ? 'tw_frost' : 'tw_arrow');
  s.m.monsters = Object.values(MONSTERS).slice(0, 8).map((def, i) => mob(def, {
    uid: 100 + i,
    effects: i % 2 ? [{ type: 'slow', pct: 0.3, until: 9 }] : [],
  }));
  s.m.time = 1;
  const cell = s.m.map.slots[0];
  s.m.projectiles = [0, 1, 2, 3].map((i) => ({
    from: project(cell.x, cell.y, 1.1),
    target: { cell: { x: cell.x + 3, y: cell.y + i }, dead: false },
    stats: TOWERS.tw_static,
    towerId: 'tw_static',
    progress: 0.4 + i * 0.1,
    life: 1,
  }));
  // 选中圣徒：多画一圈技能虚线和驻守标记，仍要落在同一帧预算里
  s.m.hero.def = HEROES.hero_paladin;
  s.m.hero.level = 5;
  s.m.hero.skillUnlocked = [true, false, false];
  const t0 = performance.now();
  for (let i = 0; i < 30; i++) s.r.draw({ m: s.m, now: i / 10, fx: 'high', heroSelected: true });
  const ms = performance.now() - t0;
  assert.ok(ms < 800, `30 帧画完应低于 800ms（实际 ${ms.toFixed(1)}ms）`);
  console.log(`motion frame budget: ${(ms / 30).toFixed(2)} ms/frame`);
});
