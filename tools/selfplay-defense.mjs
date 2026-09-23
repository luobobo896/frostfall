// 防守模式无头自走（策略在 src/ai-defense.js，与客户端调试共用一份）。
// 用法： node tools/selfplay-defense.mjs [seed] [mapId]
import { autoPlayDefense } from '../src/ai-defense.js';
import { createDefenseMatch, describeDefense } from '../src/defense.js';

const seed = Number(process.argv[2] ?? 7);
const mapId = process.argv[3] ?? 'def_01';
const m = createDefenseMatch({ mapId, heroId: 'hero_warrior', seed });
const marks = [];
let lastRound = 0;
let winAt = null;

autoPlayDefense(m, {
  onTick: (mm) => {
    if (mm.assault.round !== lastRound) {
      lastRound = mm.assault.round;
      marks.push(`第 ${lastRound} 轮 @ ${mm.time.toFixed(0)}s（城堡 ${Math.round(mm.castle.hp)}）`);
    }
    if (mm.result === 'win' && winAt == null) winAt = mm.time;
  },
});

const d = describeDefense(m);
console.log(`防守模式自走（${mapId} · seed ${seed}）`);
for (const k of marks) console.log(`  ${k}`);
console.log(`结算：${JSON.stringify(d)}`);
console.log(`通关时刻：${winAt == null ? '未通关' : `${(winAt / 60).toFixed(1)} 分钟`}（守护 4 轮的耗时；之后转无尽继续打）`);
console.log(`细节：野外击杀 ${m.stats.fieldKills} · 工事 ${m.forts.length} 座 · 城堡挨打 ${m.stats.castleHits} 次 · 背包 ${m.inventory.length} 件`);
const minutes = (winAt ?? d.time) / 60;
const ok = d.result === 'win' && minutes >= 9 && minutes <= 15.5;
console.log(ok ? '✅ 通过' : '⚠️ 需要标定');
process.exit(ok ? 0 : 1);
