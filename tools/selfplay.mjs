// 无头自走棋检验：让 AI 按 §8.6 的基准打法打完整局，输出可用于平衡标定的实测数据。
// 用法： node tools/selfplay.mjs [map_01] [normal] [hero_warrior] [seed] [short|long]
// 人数：默认 **4**——§8.5 的经济口径与 §3.2 的等级期望都写明是「4 人局基准」（§6.4.2 的 229 只 = §1.6 的 ×1.00 行）。
//       单人档： FF_PLAYERS=1 node tools/selfplay.mjs（§1.6：单人怪量 ×0.60、生命 ×0.85、金币 ×0.80）

import { autoPlay } from '../src/ai.js';
import { createMatch, describe, towerStats } from '../src/match.js';
import { WAVES } from '../src/data.js';

const [mapId = 'map_01', difficulty = 'normal', heroId = 'hero_warrior', seedArg = '20260922', length = 'short'] = process.argv.slice(2);
const seed = Number(seedArg);
const players = Number(process.env.FF_PLAYERS ?? 4);

const m = createMatch({ mapId, difficulty, heroId, seed, length, players });
const marks = [];
let lastWave = 0;

autoPlay(m, {
  maxSeconds: length === 'long' ? 3600 : 1800,   // 长局单局 25-40 分钟，30 分钟不够
  onTick: (mm) => {
    if (mm.wave.index !== lastWave) {
      lastWave = mm.wave.index;
      marks.push({ wave: lastWave, t: +mm.time.toFixed(1), core: Math.round(mm.core.hp), gold: Math.round(mm.gold), towers: mm.towers.length, lv: mm.hero.level });
    }
  },
});

const d = describe(m);
console.log(`地图 ${mapId} · 难度 ${difficulty} · 英雄 ${heroId} · seed ${seed} · ${length === 'long' ? '长局 30 波' : '12 波'} · ${players} 人基准（§1.6）`);
console.log('波次推进：');
for (const k of marks) console.log(`  第 ${k.wave} 波 @ ${k.t}s  核心 ${k.core}  金币 ${k.gold}  塔 ${k.towers}  英雄 Lv${k.lv}`);
console.log('结算：', JSON.stringify(d, null, 0));
console.log('塔配置：', m.towers.map((t) => `${t.towerId}${t.level}`).join(' '));
console.log('掉落：', m.stats.drops, '件；合成：', m.stats.crafts, '次；装备：',
  Object.entries(m.equipped).map(([k, v]) => `${k}=${v ? v.quality + v.ilvl : '无'}`).join(' '));
const target = length === 'long' ? '25-40' : '8-12';
// §142：**等级带只对「4 人局 + 12 波」成立**。以前这行无条件写「英雄 N 级（目标 17-21）」——
// 长局（30 波）自然练到满级 25（§3.2 那条本来就是按 12 波算的），单人档是 15（设计自己也记了），
// 于是这两个模式一跑就把「目标」印在一个不适用的数旁边（§111 的同一类：印了目标却不检查/不适用）。
const band = (players === 4 && length === 'short') ? [17, 21] : null;
const bandNote = band ? `（目标 ${band[0]}-${band[1]}，§3.2 的 4 人局口径）`
  : length === 'long' ? '（长局没有等级带：30 波自然到满级 25；§3.2 那条按 12 波算）'
    : `（${players} 人档没有等级带：§3.2 只给了 4 人局口径）`;
console.log(`验收：时长 ${(d.time / 60).toFixed(1)} 分钟（目标 ${target}）· 结果 ${d.result ?? '未结束'} · 漏怪 ${d.leaks} · 英雄 ${d.heroLevel} 级${bandNote}`);

const minutes = d.time / 60;
// 时长口径按附录 B：短局 8-12 分钟；长局 25-40 分钟。
// 这条曾经被放宽成 20-42，好让 24.1 分钟的长局「通过」——那是改验收线，不是改实现（见验证记录 §29）。
const timeOk = length === 'long'
  ? d.result === 'win' && minutes >= 25 && minutes <= 40
  : d.result === 'win' && minutes >= 7.5 && minutes <= 12.5;
const levelOk = !band || (d.heroLevel >= band[0] && d.heroLevel <= band[1]);
const ok = timeOk && levelOk;
console.log(ok ? '✅ 通过：在目标时长内通关'
  : `⚠️ 需要标定：${[!timeOk && '结果或时长不在目标区间', !levelOk && `4 人局等级掉出 ${band[0]}-${band[1]}（§3.2）`].filter(Boolean).join('；')}`);
process.exitCode = ok ? 0 : 1;
