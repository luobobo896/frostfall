// 防守模式的参考打法矩阵：3 张图 × 3 难度 × 4 英雄（§12.5 的「守住 4 轮 ≈ 12 分钟」逐格看）。
// 与 tools/balance-matrix.mjs（TD 那一半）对称——那一半有矩阵，防守这边此前只有 def_01 一局
// （`npm run defense`），于是「3 图 × 3 难度 × 4 英雄 都能玩」这句话没有任何逐格证据（验证记录 §195）。
// 门槛（STATUS §3.1 #5 已拍板）：**def_01 / def_02 在普通难度下 4/4 守住**——这两格是验收线，
// 掉出去就 exit 1；其余格子（含 def_03）只报数：def_03 已改标「后期 / 多人内容」（§3.1 #28），
// 单人守不住它是设计结论，不是欠债。
// 单跑一个种子只能看「这一种子下谁输了」——**败者是随种子变的**（§195 跨 4 个种子量过），
// 要看稳定性就多跑几个：`for s in 1 3 7 11; do node tools/defense-matrix.mjs $s; done`
import { autoPlayDefense } from '../src/ai-defense.js';
import { createDefenseMatch } from '../src/defense.js';
import { DEFENSE_MAPS, DIFFICULTY, HEROES } from '../src/data.js';

const seed = Number(process.argv[2] ?? 7);
const maps = Object.keys(DEFENSE_MAPS);
const diffs = Object.keys(DIFFICULTY);
const heroes = Object.keys(HEROES);

console.log(`防守参考打法矩阵 · seed ${seed} · ${maps.length} 图 × ${diffs.length} 难度 × ${heroes.length} 英雄`);
console.log(`目标：守住 4 轮（§12.5 写的是约 12 分钟）· 列 = 英雄 · 行 = 地图 × 难度\n`);

const rows = [];
for (const mapId of maps) {
  for (const diff of diffs) {
    const cells = heroes.map((heroId) => {
      const m = createDefenseMatch({ mapId, difficulty: diff, heroId, seed });
      let winAt = null;
      autoPlayDefense(m, { maxSeconds: 2400, onTick: (mm) => { if (mm.result === 'win' && winAt == null) winAt = mm.time; } });
      const win = m.result === 'win';
      return { hero: heroId.replace('hero_', ''), win, minutes: +((winAt ?? m.time) / 60).toFixed(1),
        rounds: m.stats.roundsCleared, castle: Math.round(m.castle.hp), lv: m.hero.level };
    });
    rows.push({ mapId, diff, cells });
    console.log(`${DEFENSE_MAPS[mapId].name}（${mapId}） ${diff.padEnd(10)} ` + cells.map((c) =>
      `${c.hero}:${c.win ? `${c.minutes}分` : '负'}/${c.rounds}轮`).join('  '));
  }
}

const all = rows.flatMap((r) => r.cells);
const wins = all.filter((c) => c.win);
console.log(`\n合计 ${all.length} 局：守住 4 轮 ${wins.length} · 未守住 ${all.length - wins.length}`);
if (wins.length) {
  const mins = wins.map((c) => c.minutes);
  console.log(`守住 4 轮的时长 ${Math.min(...mins).toFixed(1)} - ${Math.max(...mins).toFixed(1)} 分钟（目标带 ≈12 分钟）`);
}
for (const mapId of maps) {
  const cells = rows.filter((r) => r.mapId === mapId).flatMap((r) => r.cells);
  const lost = cells.filter((c) => !c.win);
  console.log(`${mapId}：${cells.length - lost.length}/${cells.length} 守住` + (lost.length
    ? ` —— 未守住：${lost.map((c) => `${c.hero}(${c.rounds}轮)`).join(' · ')}` : ''));
}
// 门槛：def_01 / def_02 的普通难度必须 4/4（§3.1 #5）。这两格成立过，所以它是回归闸，
// 不是「没达标就得改代码」的野心线。
const gated = rows.filter((r) => (r.mapId === 'def_01' || r.mapId === 'def_02') && r.diff === 'normal');
const gateFails = gated.flatMap((r) => r.cells.filter((c) => !c.win).map((c) => `${r.mapId} 普通 · ${c.hero}：只守到 ${c.rounds} 轮`));
console.log('\n验收检查（def_01 / def_02 · 普通难度 · 4 人英雄各一局）：必须 4/4 守住');
console.log(gateFails.length ? '❌ 有格子掉出线：' : '✅ 8 格全守住');
for (const f of gateFails) console.log(`   - ${f}`);
console.log('（其余格子只报数：def_03 是后期 / 多人内容，高难下每 12 局约输 1-4 局且败者随种子变）');
if (gateFails.length) process.exit(1);
