// 新手引导的验收实测：按「新手会怎么做」跑一遍（先建塔、再开波、用技能），
// 输出「首次建塔」与「打赢第一波」两条时延，对照 §1.8 的 ≤90s / ≤180s。
import { buildTower, castSkill, createMatch, startWaveEarly, update } from '../src/match.js';
import { TICK_STEP } from '../src/data.js';
import { createTutorial, tutorialPasses } from '../src/tutorial.js';

/** @param {object} p 新手节奏：firstTowerDelay（多久才建第一座）/ waveDelay（多久才开波）/ towerGap（之后每隔多久补一座） */
function run(p, label) {
  const m = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 11, startGold: 200 });
  const t = createTutorial({ startedAt: 0 });
  const DT = TICK_STEP;
  let built = 0, ai = 1;
  for (let i = 0; i < Math.round(400 / TICK_STEP) && !t.done; i++) {
    update(m, DT);
    const wantTowers = m.time > p.firstTowerDelay + built * p.towerGap ? built + 1 : 0;
    if (built < 3 && built < wantTowers) {
      if (buildTower(m, ai++, 'tw_arrow')) { built += 1; t.onTowerBuilt(m.time); }
    }
    if (built >= 1 && m.wave.index === 0 && m.time > p.waveDelay) startWaveEarly(m);
    if (m.wave.index > 0) {
      if (m.monsters.length > 0 && m.time % 3 < DT) castSkill(m, 0);
      if (m.gold > 200 && m.map.slots.length > ai) buildTower(m, ai++, 'tw_arrow');
    }
    if (m.wave.index > 0) t.onWaveStarted(m.wave.index, m.time);
    if (m.wave.index > 1 || m.result) t.onWaveCleared(1, m.time);
  }
  const s = t.summary();
  const v = tutorialPasses(s);
  console.log(`${label}`);
  console.log(`  首座塔 ${s.secondsToFirstTower}s / 开波 ${s.secondsToWaveStart}s / 首波清场 ${s.secondsToWaveCleared}s`
    + `  → ≤90s ${v.firstTowerOk ? '✅' : '❌'} · ≤180s ${v.firstWaveOk ? '✅' : '❌'}（建塔 ${s.towersBuilt} 座，技能 ${s.skillsCast} 次）`);
  return v.firstTowerOk && v.firstWaveOk;
}

let allOk = true;
allOk = run({ firstTowerDelay: 2, towerGap: 8, waveDelay: 25 }, '熟练新手：2 秒建塔、25 秒开波') && allOk;
allOk = run({ firstTowerDelay: 20, towerGap: 12, waveDelay: 60 }, '慢热新手：20 秒才建第一座、60 秒才开波') && allOk;
allOk = run({ firstTowerDelay: 75, towerGap: 15, waveDelay: 120 }, '极限：75 秒建塔、120 秒开波') && allOk;
console.log(allOk ? '✅ 三种新手节奏都落在 §1.8 的验收区间内' : '⚠️ 有场景超出验收区间');
process.exit(allOk ? 0 : 1);
