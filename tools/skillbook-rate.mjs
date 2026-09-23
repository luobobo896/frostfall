// 附录清单里那条一直没勾的：「**技能书购买率 ≥ 30%**（若过低说明贵或没被看见；过高说明难度逼着人人必须买）」。
//
// 这条本质上是**产品指标**（要靠埋点看真人），但参考打法能给出一个**代理口径**：
// 同一批配置跑参考 AI，数它买了几本技能书、什么时候买得起却不买、一本书占一局收入多少。
// 这样至少能把「贵不贵 / 看不看得见」这件事量化，真人口径等 M3 的埋点。
//
// 这是**测量**不是断言：数字给出来，够不够格是设计/产品决定（同 §85 的药品工具）。
// 用法： node tools/skillbook-rate.mjs [局数]        （默认 12 局 × 6 组配置）
import { createMatch, describe, shopPriceOf } from '../src/match.js';
import { autoPlay } from '../src/ai.js';
import { HEROES, MAPS, SHOP_ITEMS } from '../src/data.js';

const seeds = Number(process.argv[2] ?? 12);
const players = Number(process.env.FF_PLAYERS ?? 4);
/** 覆盖：首发三图普通 + 4★ 长局图 + 高难（技能书在难局里更该被想起） */
const CONFIGS = [
  { mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior' },
  { mapId: 'map_02', difficulty: 'normal', heroId: 'hero_ranger' },
  { mapId: 'map_03', difficulty: 'normal', heroId: 'hero_mage' },
  { mapId: 'map_04', difficulty: 'normal', heroId: 'hero_warrior' },
  { mapId: 'map_03', difficulty: 'hard', heroId: 'hero_paladin' },
  { mapId: 'map_02', difficulty: 'nightmare', heroId: 'hero_ranger' },
];

const SECRET = SHOP_ITEMS.find((i) => i.id === 'book_secret');
const UP = SHOP_ITEMS.find((i) => i.id === 'book_up');

const rows = [];
for (const cfg of CONFIGS) {
  for (let s = 1; s <= seeds; s += 1) {
    const m = createMatch({ ...cfg, seed: s, players });
    // 光看「结算那一刻」买不买得起是不够的（钱都被塔吃掉了）：按 tick 记「这一局里有没有出现过
    // 买得起、而且是备战期第 4 波之后」——那才是参考打法唯一会下单的时机
    let affordableTicks = 0, rightMomentTicks = 0, maxGold = 0, maxLumber = 0;
    autoPlay(m, {
      maxSeconds: 1800,
      onTick: (mm) => {
        const g = mm.gold, l = mm.lumber[0] ?? 0;
        if (g > maxGold) maxGold = Math.round(g);
        if (l > maxLumber) maxLumber = l;
        if (g >= SECRET.priceGold && l >= SECRET.priceLumber) affordableTicks += 1;
        if (mm.wave.phase === 'prep' && mm.wave.index >= 4 && g >= SECRET.priceGold && l >= SECRET.priceLumber) rightMomentTicks += 1;
      },
    });
    const d = describe(m);
    // 「买得起却没买」：门槛直接读表（§3.1 #25 把秘传书降到 300 金之后，这里以前写死的 600 就成了假话）
    const affordable = d.gold >= SECRET.priceGold && d.lumber >= SECRET.priceLumber;
    rows.push({
      cfg, seed: s, win: d.result === 'win', minutes: +(d.time / 60).toFixed(1),
      secret: m.shopBought.book_secret ?? 0, up: m.shopBought.book_up ?? 0,
      potionBuys: m.stats.potions ?? 0,   // 对照组：同一个 AI 买得起药，却很少买得起书
      unlocked3: !!m.hero.skillUnlocked[2], lumberLeft: d.lumber, goldLeft: d.gold,
      affordableNoBuy: affordable && !(m.shopBought.book_secret ?? 0) && !m.hero.skillUnlocked[2],
      affordableTicks, rightMomentTicks, maxGold, maxLumber,
      bookGold: (m.shopBought.book_secret ?? 0) * SECRET.priceGold + (m.shopBought.book_up ?? 0) * UP.priceGold,
    });
  }
}

const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`;
const withAny = rows.filter((r) => r.secret + r.up > 0).length;
const withSecret = rows.filter((r) => r.secret > 0).length;
const withUp = rows.filter((r) => r.up > 0).length;
const noBuyButAfford = rows.filter((r) => r.affordableNoBuy).length;
const goldAvg = rows.reduce((a, r) => a + r.bookGold, 0) / rows.length;
const everAffordable = rows.filter((r) => r.affordableTicks > 0).length;
const everRightMoment = rows.filter((r) => r.rightMomentTicks > 0).length;
const maxGoldAvg = rows.reduce((a, r) => a + r.maxGold, 0) / rows.length;
const maxLumberAvg = rows.reduce((a, r) => a + r.maxLumber, 0) / rows.length;

console.log(`技能书购买率实测（${rows.length} 局 = ${CONFIGS.length} 组配置 × ${seeds} 个种子 · ${players} 人基准）\n`);
console.log(`购买率（代理口径＝参考打法买了至少一本技能书的局数占比）：${pct(withAny, rows.length)}（${withAny}/${rows.length}）`);
console.log(`  其中 秘传技能书（${SECRET.priceGold} 金 + ${SECRET.priceLumber ?? 0} 木，限购 ${SECRET.limit}）：${pct(withSecret, rows.length)}（${withSecret} 局）`);
console.log(`  其中 技能书·精研（${UP.priceGold} 金，限购 ${UP.limit}）：${pct(withUp, rows.length)}（${withUp} 局）`);
console.log(`  第 3 技能最终解锁的局数：${rows.filter((r) => r.unlocked3).length}/${rows.length}`);
console.log(`\n「买得起却没买」的局（金币 ≥${SECRET.priceGold} 且木材 ≥${SECRET.priceLumber}、3 技能还没解锁）：${noBuyButAfford} 局`
  + `${noBuyButAfford ? '（参考打法只在备战期且第 4 波之后才会下单，所以这多半是「打完了也没到那个时机」）' : ''}`);
console.log(`这一局里**有没有出现过**买得起的时刻（金币 ≥${SECRET.priceGold} 且木材 ≥${SECRET.priceLumber}）：${pct(everAffordable, rows.length)}（${everAffordable}/${rows.length} 局）`);
console.log(`其中「时机也对」（备战期 + 第 4 波之后 + 买得起）：${pct(everRightMoment, rows.length)}（${everRightMoment}/${rows.length} 局）`);
console.log(`全程峰值：金币平均 ${maxGoldAvg.toFixed(0)}（书要 ${SECRET.priceGold}）· 木材平均 ${maxLumberAvg.toFixed(1)}（书要 ${SECRET.priceLumber}）`);
const potionGames = rows.filter((r) => r.potionBuys > 0).length;
console.log(`对照：同一个参考打法里，买过药（30/80 金）的局数 ${potionGames}/${rows.length}`
  + `——它买得起便宜货，说明瓶颈是价格/现金流，不是「没被看见」`);
console.log(`书钱占一局的金币收入：平均 ${goldAvg.toFixed(0)} 金/局 ≈ ${(goldAvg / 60).toFixed(2)} 座箭塔（60 金/座，§8.5）`);
console.log(`\n附录清单那条线是「≥30%」；**这只是参考 AI 的代理口径**——真人看不看得见、贵不贵要靠埋点（§1.7.1），本工具只报数。`);
console.log('\n按配置拆：');
for (const cfg of CONFIGS) {
  const list = rows.filter((r) => r.cfg === cfg);
  console.log(`  ${cfg.mapId}（${MAPS[cfg.mapId].name}）· ${cfg.difficulty} · ${HEROES[cfg.heroId].name}：`
    + `胜 ${list.filter((r) => r.win).length}/${list.length}`
    + ` · 买了书 ${list.filter((r) => r.secret + r.up > 0).length}/${list.length}`
    + ` · 平均 ${(list.reduce((a, r) => a + r.secret + r.up, 0) / list.length).toFixed(2)} 本/局`);
}

// §112 的口径：测量工具只报数、不作为门槛（超不超标是设计/产品的事）
console.log('\n（本工具只报数、不作为门槛：达标与否等埋点/拍板，永远 exit 0）');
process.exit(0);
