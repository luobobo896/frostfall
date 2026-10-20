// 出征英雄：朝向、收招、升级光环、辅助脚底圈。不改伤害和驻守半径。
import test from 'node:test';
import assert from 'node:assert/strict';

import { MONSTERS, TICK_STEP } from '../src/data.js';
import { createDefenseMatch, updateDefense } from '../src/defense.js';
import {
  ATTACK_COMMIT_SEC, LEVEL_FLOURISH_SEC, createMatch, cumulativeExp, defenseLook, grantExp, supportAuraRange,
} from '../src/match.js';
import { HERO_SKILL_RING, createRenderer } from '../src/render.js';

const mob = (x, y) => ({
  uid: 1, mobId: 'mob_01', def: MONSTERS.mob_01, kind: 'field',
  cell: { x, y }, hp: 9999, maxHp: 9999, armor: 0, armorType: 'light',
  attack: 0, atkSpeed: 1, speed: 0, cooldown: 0, isAir: false, effects: [],
  dead: false, attacking: false, active: false, path: [], pathAt: -1,
});

test('出征朝向：先看射程里的怪，没有才看下一步', () => {
  const m = createDefenseMatch({ seed: 1 });
  const x = m.hero.cell.x;
  const y = m.hero.cell.y;
  m.monsters = [];
  m.hero.path = [{ x: x + 3, y }];
  assert.equal(defenseLook(m, 3).facing, 1, '路往右就朝右');
  m.hero.path = [{ x: x - 2, y }];
  assert.equal(defenseLook(m, 3).facing, -1, '路往左就朝左');
  m.monsters = [mob(x + 1, y)];
  const fight = defenseLook(m, 3);
  assert.equal(fight.facing, 1, '左边有路、右边有怪：朝怪');
  assert.equal(fight.target.cell.x, x + 1);
  m.monsters = [mob(x + 12, y)];
  assert.equal(defenseLook(m, 3).facing, -1, '怪在射程外，继续朝路');
  assert.equal(defenseLook(m, 3).target, null);
});

test('出征交战会改朝向，收招只留一小段', () => {
  const m = createDefenseMatch({ seed: 2, heroId: 'hero_warrior' });
  const x = m.hero.cell.x;
  const y = m.hero.cell.y;
  m.hero.path = [];
  m.monsters = [mob(x - 1, y)];
  updateDefense(m, TICK_STEP);
  assert.equal(m.hero.facing, -1);
  assert.equal(m.hero.attacking, true);
  assert.ok(m.hero.cooldown > 0);
  assert.ok(m.hero.attackCommitUntil - m.time <= ATTACK_COMMIT_SEC + 0.001);
  m.monsters = [];
  updateDefense(m, TICK_STEP);
  assert.equal(m.hero.attacking, true, '怪没了，收招窗口里还保持出手姿势');
  m.hero.attackCommitUntil = m.time - 1;
  m.hero.cooldown = 1;
  updateDefense(m, TICK_STEP);
  assert.equal(m.hero.attacking, false, '窗口过了就回到走路姿势');
});

test('防守升级写一行日志并点亮光环；塔防升级不写这句', () => {
  const m = createDefenseMatch({ seed: 3 });
  m.hero.exp = cumulativeExp(2) - 1;
  const before = m.events.length;
  grantExp(m, 1);
  assert.equal(m.hero.level, 2);
  assert.ok(m.hero.levelPulseUntil - m.time <= LEVEL_FLOURISH_SEC + 0.001);
  assert.ok(m.events.slice(before).some((e) => e.text === '出征英雄升到 Lv2'));
  grantExp(m, 1);
  assert.equal(m.events.filter((e) => e.text.includes('升到')).length, 1, '没升级就不再写');

  const td = createMatch({ seed: 3 });
  grantExp(td, 500);
  assert.ok(td.hero.level > 1);
  assert.ok(!(td.hero.levelPulseUntil > 0));
  assert.ok(!td.events.some((e) => String(e.text).includes('升到')));
});

test('只有带光环天赋的英雄有脚底圈，圣徒的半径跟技能预览同一套', () => {
  const warrior = createMatch({ heroId: 'hero_warrior' }).hero;
  const pal = createDefenseMatch({ heroId: 'hero_paladin' }).hero;
  assert.equal(supportAuraRange(warrior), 0);
  assert.equal(supportAuraRange(pal), 3);
  pal.level = 5;
  assert.equal(supportAuraRange(pal), 5);

  const ctx = {
    calls: [],
    setTransform() {}, fillRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {},
    closePath() {}, fill() {}, stroke() {}, ellipse() {}, arc() {}, save() {}, restore() {},
    translate() {}, scale() {}, setLineDash(...args) { this.calls.push(args); },
    measureText: () => ({ width: 12 }),
    canvas: {},
  };
  const canvas = { clientWidth: 800, clientHeight: 450, width: 0, height: 0, getContext: () => ctx };
  const r = createRenderer(canvas);
  const def = createDefenseMatch({ seed: 1, heroId: 'hero_paladin' });
  def.monsters = [];
  r.draw({ m: def, now: 0, fx: 'low' });
  assert.ok(ctx.calls.some((args) => JSON.stringify(args[0]) === JSON.stringify(HERO_SKILL_RING.dash)),
    '圣徒脚底是技能虚线，不是塔的实线圈');

  ctx.calls.length = 0;
  const plain = createDefenseMatch({ seed: 1, heroId: 'hero_warrior' });
  plain.monsters = [];
  r.draw({ m: plain, now: 0, fx: 'low' });
  assert.ok(!ctx.calls.some((args) => JSON.stringify(args[0]) === JSON.stringify(HERO_SKILL_RING.dash)),
    '武者没有辅助光环，不画这一圈');
});
