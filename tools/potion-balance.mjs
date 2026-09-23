// §5.5 药品平衡的实测口径（附录 B 那条一直没勾的）：
//   「嗑满冷却与大药也无法硬扛过一个 Boss 波的全程 → 单局药品消耗 ≤ 6 次且胜率不明显上升」
//
// 做法：同一批种子跑**两组**参考打法——一组照常买药嗑药，一组完全不用药（`autoPlay({potions:false})`）。
// 比三个数：单局用药次数、胜率差、以及「用药最多的一局」。
// 这是**测量**不是断言：数字给出来，够不够格是设计决定（胜负率差多少算「不明显上升」得有人拍）。
// 用法： node tools/potion-balance.mjs [局数]     （默认 12 局 × 6 组配置）
import { createMatch, describe } from '../src/match.js';
import { autoPlay } from '../src/ai.js';
import { HEROES, MAPS } from '../src/data.js';

const seeds = Number(process.argv[2] ?? 12);
const players = Number(process.env.FF_PLAYERS ?? 4);
/** 覆盖三类图：小路单核（01）/ 双路（02）/ 四路大图（04，塔位多、Boss 最难顶） */
const CONFIGS = [
  { mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior' },
  { mapId: 'map_02', difficulty: 'normal', heroId: 'hero_ranger' },
  { mapId: 'map_04', difficulty: 'normal', heroId: 'hero_warrior' },
  { mapId: 'map_04', difficulty: 'hard', heroId: 'hero_mage' },
  { mapId: 'map_03', difficulty: 'hard', heroId: 'hero_paladin' },
  { mapId: 'map_02', difficulty: 'nightmare', heroId: 'hero_ranger' },
];

const run = (cfg, seed, potions) => {
  const m = createMatch({ ...cfg, seed, players });
  autoPlay(m, { potions, maxSeconds: 1800 });
  const d = describe(m);
  return { win: d.result === 'win', potions: d.potions, gold: d.potionGold, minutes: +(d.time / 60).toFixed(1), leaks: d.leaks };
};

const rows = [];
for (const cfg of CONFIGS) {
  for (let s = 1; s <= seeds; s += 1) {
    const on = run(cfg, s, true);
    const off = run(cfg, s, false);
    rows.push({ cfg, seed: s, on, off });
  }
}

const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`;
const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
const winsOn = rows.filter((r) => r.on.win).length;
const winsOff = rows.filter((r) => r.off.win).length;
const used = rows.map((r) => r.on.potions);
const maxRow = rows.reduce((a, r) => (r.on.potions > a.on.potions ? r : a), rows[0]);
const avg = sum(used, (x) => x) / used.length;

console.log(`药品平衡实测（${rows.length} 局 = ${CONFIGS.length} 组配置 × ${seeds} 个种子 · ${players} 人基准）\n`);
console.log(`用药组：胜 ${winsOn}/${rows.length}（${pct(winsOn, rows.length)}）· 平均用药 ${avg.toFixed(2)} 次/局`)
console.log(`对照组：胜 ${winsOff}/${rows.length}（${pct(winsOff, rows.length)}）· 完全不买不用药`);
console.log(`胜率差：${(((winsOn - winsOff) / rows.length) * 100).toFixed(1)} 个百分点`);
console.log(`单局用药次数：中位 ${[...used].sort((a, b) => a - b)[Math.floor(used.length / 2)]} · 最多 ${maxRow.on.potions} 次`
  + `（${maxRow.cfg.mapId} / ${maxRow.cfg.difficulty} / 种子 ${maxRow.seed}）· 一局都没用的 ${used.filter((x) => x === 0).length} 局`);
// 药品的钱是从塔的预算里抠的：同一局的钱要么买药要么造塔，这是「负收益」最可能的机制
const goldAvg = sum(rows, (r) => r.on.gold) / rows.length;
console.log(`药品花掉的金币：平均 ${goldAvg.toFixed(0)} 金/局 ≈ ${(goldAvg / 60).toFixed(1)} 座箭塔（60 金/座，§8.5）`
  + ` · 最多 ${Math.max(...rows.map((r) => r.on.gold))} 金`);
console.log('\n附录 B 的两条口径（第一列是设计写的线）：');
console.log(`  单局消耗 ≤ 6 次：平均 ${avg.toFixed(2)}、最多 ${maxRow.on.potions} → ${maxRow.on.potions <= 6 ? '达标' : '超标'}`);
console.log(`  胜率不明显上升：${(((winsOn - winsOff) / rows.length) * 100).toFixed(1)} 个百分点 → 需人工判断（设计没给阈值）`);
console.log('\n按配置拆（用药组 / 对照组）：');
for (const cfg of CONFIGS) {
  const list = rows.filter((r) => r.cfg === cfg);
  const hero = HEROES[cfg.heroId].name;
  console.log(`  ${cfg.mapId}（${MAPS[cfg.mapId].name}）· ${cfg.difficulty} · ${hero}：`
    + `胜 ${list.filter((r) => r.on.win).length}/${list.length} vs ${list.filter((r) => r.off.win).length}/${list.length}`
    + ` · 用药 ${sum(list, (r) => r.on.potions)} 次`);
}

// 本工具**只报数、不作为门槛**：超标与否得设计拍板（§85 已论证这是等口径的数），
// 一行红线会让「药品暂时超标」伪装成「代码坏了」，反倒把改动引到错的方向。
console.log('\n（本工具只报数、不作为门槛：达标与否等设计拍板，永远 exit 0）');
process.exit(0);
