// §177：开局参数归一化。URL 与档案里的 lastChoice 都是玩家能改的 / 会过期的，非法值不许往内核传。
import test from 'node:test';
import assert from 'node:assert/strict';

import { choiceFrom, normalizeChoice } from '../src/data.js';
import { createMatch } from '../src/match.js';
import { createDefenseMatch } from '../src/defense.js';

const DEFAULTS = { mode: 'td', map: 'map_01', difficulty: 'normal', hero: 'hero_warrior', length: 'short' };

test('§177 归一化：非法值一律落回默认（这正是白屏的反面）', () => {
  const bad = { mode: 'bogus', map: 'bogus', difficulty: 'bogus', hero: 'bogus', length: 'bogus' };
  assert.deepEqual(normalizeChoice(bad), DEFAULTS);
  assert.deepEqual(normalizeChoice(), DEFAULTS);            // 档案里没有 lastChoice 时的形状
  assert.deepEqual(normalizeChoice({ hero: undefined }), DEFAULTS);
});

test('§177 归一化：防守图不带 mode 时按地图推模式，地图必须与模式相符', () => {
  assert.deepEqual(normalizeChoice({ map: 'def_02' }), { ...DEFAULTS, mode: 'defense', map: 'def_02' });
  // 模式与地图不符 → 落回该模式的默认图（与服务端 roomOptions 同一条规则，§121）
  assert.equal(normalizeChoice({ mode: 'td', map: 'def_02' }).map, 'map_01');
  assert.equal(normalizeChoice({ mode: 'defense', map: 'map_03' }).map, 'def_01');
  // 合法值原样通过（别把玩家真选的那套洗掉）
  assert.deepEqual(
    normalizeChoice({ mode: 'defense', map: 'def_03', difficulty: 'nightmare', hero: 'hero_ranger', length: 'long' }),
    { mode: 'defense', map: 'def_03', difficulty: 'nightmare', hero: 'hero_ranger', length: 'long' });
});

test('§177 归一化后的值一定能建局（非法值进 createMatch 会抛在模块顶层 → 整页白屏）', () => {
  const cases = [{}, { map: 'bogus' }, { mode: 'bogus', hero: 'bogus' }, { map: 'def_01' },
    { mode: 'defense', map: 'map_01' }, { hero: 'hero_ghost', length: 'long' }];
  for (const raw of cases) {
    const c = normalizeChoice(raw);
    const build = c.mode === 'defense'
      ? () => createDefenseMatch({ mapId: c.map, heroId: c.hero, difficulty: c.difficulty })
      : () => createMatch({ mapId: c.map, heroId: c.hero, difficulty: c.difficulty, length: c.length });
    assert.doesNotThrow(build, `${JSON.stringify(raw)} → ${JSON.stringify(c)}`);
  }
});

test('§177 URL 与档案合成：URL 优先；URL 给了地图时模式由地图决定', () => {
  const q = (s) => new URLSearchParams(s);
  // 上一局打过 TD（档案 mode=td）+ 一条防守图深链 → 客户端与服务端都得是「防守 def_03」
  assert.deepEqual(choiceFrom(q('map=def_03'), { mode: 'td', map: 'map_01' }),
    { mode: 'defense', map: 'def_03', difficulty: 'normal', hero: 'hero_warrior', length: 'short' });
  // 只给了模式（README 的 `?mode=defense`）+ 档案里是 TD 图 → 模式优先，地图落回 def_01
  assert.deepEqual(choiceFrom(q('mode=defense'), { mode: 'td', map: 'map_03' }),
    { mode: 'defense', map: 'def_01', difficulty: 'normal', hero: 'hero_warrior', length: 'short' });
  // URL 的每一项都压过档案
  assert.deepEqual(choiceFrom(q('map=map_02&difficulty=hard&hero=hero_mage&length=long'),
    { mode: 'defense', map: 'def_01', difficulty: 'normal', hero: 'hero_warrior', length: 'short' }),
  { mode: 'td', map: 'map_02', difficulty: 'hard', hero: 'hero_mage', length: 'long' });
  // 什么都没有：全默认（`?? lastChoice.hero` 那条链断掉时也一样）
  assert.deepEqual(choiceFrom(q(''), {}), DEFAULTS);
});
