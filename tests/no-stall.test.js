// 「每一局都必须能结束」——这条不变量是用血换来的：
// §41 那个死锁让圣徒单局卡满 1 小时（Boss 停在 6 格外打英雄，谁也打不死谁），
// 而当时的用例只验了「指定英雄能赢」，没人验过「所有英雄都能打完」。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMatch } from '../src/match.js';
import { autoPlay } from '../src/ai.js';
import { autoPlayDefense } from '../src/ai-defense.js';
import { createDefenseMatch } from '../src/defense.js';
import { DEFENSE_MAPS, HEROES } from '../src/data.js';

const TD_CAP = 1800;      // 30 分钟模拟上限：12 波局正常 8-15 分钟，卡住才会顶到这个数
const DEF_CAP = 1800;

test('TD：4 英雄 × 3 图（1★/3★/6★），每一局都要在 30 分钟内分出胜负', () => {
  const stalled = [];
  for (const mapId of ['map_01', 'map_03', 'map_06']) {
    for (const heroId of Object.keys(HEROES)) {
      const m = createMatch({ mapId, difficulty: 'normal', heroId, seed: 7 });
      autoPlay(m, { maxSeconds: TD_CAP });
      if (!m.result) stalled.push(`${mapId}/${heroId}（第 ${m.wave.index} 波 ${m.wave.phase}，场上 ${m.monsters.length} 只）`);
    }
  }
  assert.deepEqual(stalled, [], `这些组合没打完（卡住了？）：${stalled.join('、')}`);
});

test('防守：4 英雄 × 三张图都要在 30 分钟内分出胜负（输也算有结果）', () => {
  const stalled = [];
  for (const mapId of Object.keys(DEFENSE_MAPS)) {
    for (const heroId of Object.keys(HEROES)) {
      const m = createDefenseMatch({ mapId, heroId, seed: 7 });
      autoPlayDefense(m, { maxSeconds: DEF_CAP });
      if (!m.result) stalled.push(`${mapId}/${heroId}（第 ${m.assault.round} 轮，城堡 ${Math.round(m.castle.hp)}）`);
    }
  }
  assert.deepEqual(stalled, [], `这些防守图没打完（卡住了？）：${stalled.join('、')}`);
});
