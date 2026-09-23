// 长局模式（30 波，§6.4 第 7 条）：波次结构、赏金系数、Boss 血量列、存档保留。
import test from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMY, LONG_RUN, LONG_RUN_BOSS_HP, MONSTERS, TICK_STEP, WAVES, WAVES_LONG } from '../src/data.js';
import { createMatch, update, waveQueue } from '../src/match.js';
import { deserializeMatch, serializeMatch } from '../src/save.js';

test('30 波结构：第 5/15/25 波精英、第 10/20/30 波 Boss（§6.4 第 7 条）', () => {
  assert.equal(WAVES_LONG.length, 30);
  const elite = WAVES_LONG.filter((w) => w.isElite).map((w) => w.wave);
  const boss = WAVES_LONG.filter((w) => w.isBoss).map((w) => w.wave);
  assert.deepEqual(elite, [5, 15, 25]);
  assert.deepEqual(boss, [10, 20, 30]);
  for (const w of WAVES_LONG) {
    assert.ok(waveQueue(w.wave, WAVES_LONG).length > 0, `第 ${w.wave} 波要有出怪`);
    for (const g of w.groups) assert.ok(MONSTERS[g.mobId], `第 ${w.wave} 波的 ${g.mobId} 必须在怪物表里`);
  }
  // 长局总怪量应明显多于短局，但不是简单翻倍（后面几波加压更狠）
  const total = WAVES_LONG.reduce((s, w) => s + w.groups.reduce((a, g) => a + g.count, 0), 0);
  const short = WAVES.reduce((s, w) => s + w.groups.reduce((a, g) => a + g.count, 0), 0);
  assert.ok(total > short * 2, `长局总怪量 ${total} 应远多于短局 ${short}`);
});

test('赏金系数：短局 ×0.5、长局 ×1.0（§6.4）', () => {
  // 4 人基准（§1.6 ×1.00）：赏金系数表（§6.4）写的是基准口径，人数缩放另算
  const short = createMatch({ mapId: 'map_01', players: 4 });
  const long = createMatch({ mapId: 'map_01', length: 'long', players: 4 });
  assert.equal(short.bountyMul, ECONOMY.bountyMul);
  assert.equal(long.bountyMul, LONG_RUN.bountyMul);
  assert.equal(long.waves.length, 30);
  assert.equal(short.waves.length, 12);
});

test('长局 Boss 用 §6.3 的长局血量列（12 波局用短局列）', () => {
  const mk = (length) => {
    const m = createMatch({ mapId: 'map_01', length, seed: 3, difficulty: 'normal', players: 4 });
    m.wave = { index: 9, phase: 'prep', timer: 0, spawned: 0, total: 0, queue: [] };
    // 直接推进到第 10 波（长局第 10 波 = 第一个 Boss 波）
    for (let i = 0; i < Math.round(60 / TICK_STEP) && !m.monsters.some((x) => x.def.tier === 'boss'); i++) update(m, TICK_STEP);
    return m.monsters.find((x) => x.def.tier === 'boss');
  };
  const longBoss = mk('long');
  assert.equal(longBoss.mobId, 'boss_01');
  assert.equal(longBoss.maxHp, LONG_RUN_BOSS_HP.boss_01, '长局用 12000');
  assert.equal(MONSTERS.boss_01.hp, 3600, '短局仍是 3600（表里不动，靠覆盖）');
});

test('长局也能存档续玩（length 要跟着存）', () => {
  const m = createMatch({ mapId: 'map_02', length: 'long', seed: 11, players: 4 });
  m.wave.timer = 0;
  for (let i = 0; i < Math.round(90 / TICK_STEP); i++) update(m, TICK_STEP);
  const save = JSON.parse(JSON.stringify(serializeMatch(m)));
  assert.equal(save.length, 'long');
  const b = deserializeMatch(save);
  assert.equal(b.length, 'long');
  assert.equal(b.waves.length, 30, '读档后仍是 30 波的结构');
  assert.equal(b.bountyMul, LONG_RUN.bountyMul);
  assert.equal(b.wave.index, m.wave.index);
});

test('最终 Boss 的漏怪即判负（§6.3 的「直接失败」）', () => {
  const m = createMatch({ mapId: 'map_01', length: 'long', seed: 5, players: 4 });
  m.core.hp = 4200;
  m.wave = { index: 29, phase: 'prep', timer: 0, spawned: 0, total: 0, queue: [] };
  let boss = null;
  for (let i = 0; i < Math.round(120 / TICK_STEP) && !boss; i++) {
    update(m, TICK_STEP);
    boss = m.monsters.find((x) => x.mobId === 'boss_03');
  }
  assert.ok(boss, '第 30 波应出冰封主宰');
  assert.equal(boss.maxHp, LONG_RUN_BOSS_HP.boss_03);
  boss.dist = 10 ** 6;                       // 直接把它送到核心
  update(m, TICK_STEP);
  assert.equal(m.core.hp, 0, '最终 Boss 漏怪应直接打空核心');
  assert.equal(m.result, 'lose');
});
