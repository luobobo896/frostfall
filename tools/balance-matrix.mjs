// 全图 × 难度 × 英雄的参考打法矩阵：一眼看出哪张图、哪个难度、哪个英雄过不了。
// 用途：改数值/改 AI 之后跑一遍，对比上一版（§8.6 家族那些「纸面 vs 实测」争论的数据源）。
// 用法： node tools/balance-matrix.mjs [短局|长局] [difficulty ...]
import { createMatch, describe } from '../src/match.js';
import { autoPlay } from '../src/ai.js';
import { DIFFICULTY, HEROES, MAPS, WAVES, WAVES_LONG } from '../src/data.js';

const args = process.argv.slice(2);
const length = args[0] === '长局' || args[0] === 'long' ? 'long' : 'short';
const diffs = args.filter((a) => DIFFICULTY[a]).length ? args.filter((a) => DIFFICULTY[a]) : Object.keys(DIFFICULTY);
const waves = length === 'long' ? WAVES_LONG.length : WAVES.length;
// 种子默认 7（历次记录用的就是它）；换种子跑一遍能看出「某某组合必败/超时」是不是种子运气——
// §195 在防守那边踩过这个坑（seed 7 的败者换种子就换了人）。
const seed = Number(process.env.FF_SEED ?? 7);
const players = Number(process.env.FF_PLAYERS ?? 4);   // §8.5/§3.2 的验收口径是 4 人基准（§1.6）

const cell = (r) => {
  if (!r.result) return '未结束';
  const mark = r.result === 'win' ? '胜' : '负';
  return `${mark} ${r.minutes}分`;
};

console.log(`参考打法矩阵 · ${length === 'long' ? '长局 30 波' : '12 波'} · seed ${seed}`);
for (const diff of diffs) {
  console.log(`\n【${diff}】列 = 英雄，行 = 地图`);
  const heroes = Object.keys(HEROES);
  console.log(`| 地图 | ${heroes.map((h) => HEROES[h].name).join(' | ')} |`);
  console.log(`|---|${heroes.map(() => '---').join('|')}|`);
  for (const mapId of Object.keys(MAPS)) {
    const row = [];
    for (const heroId of heroes) {
      const m = createMatch({ mapId, difficulty: diff, heroId, seed, length, players });
      autoPlay(m, { maxSeconds: length === 'long' ? 3600 : 1800 });
      const d = describe(m);
      row.push(cell({ result: d.result, minutes: (d.time / 60).toFixed(1) }));
    }
    console.log(`| ${MAPS[mapId].name}（${MAPS[mapId].stars}★ ${MAPS[mapId].towerSlots} 塔位） | ${row.join(' | ')} |`);
  }
}

// 细节表：只有「赢」的局才看得到时长/漏怪，所以单独列一遍，方便和验收区间对
console.log(`\n细节（${seed} 号种子，目标：短局 8-12 分钟 / 长局 25-40 分钟）`);
for (const diff of diffs) {
  for (const mapId of Object.keys(MAPS)) {
    const cells = [];
    for (const heroId of Object.keys(HEROES)) {
      const m = createMatch({ mapId, difficulty: diff, heroId, seed, length, players });
      autoPlay(m, { maxSeconds: length === 'long' ? 3600 : 1800 });
      const d = describe(m);
      cells.push(`${HEROES[heroId].name.slice(0, 2)}:${d.result === 'win' ? (d.time / 60).toFixed(1) : '负'}分/${d.leaks}漏`);
    }
    console.log(`${diff} ${MAPS[mapId].id}（${waves} 波） ${cells.join('  ')}`);
  }
}

// 上面那行「目标：短局 8-12 分钟」只是给眼睛一个参照，本工具**不检查**它（§111 已说明它现在会红）。
/**
 * STATUS §3.1 #22（已拍板）：时长线明确成「**三张首发图（1-3★）+ 普通难度 + 4 人基准：8-12 分钟**」，
 * 而且**这个工具要真的检查它**（以前只在细节表头上印一句「目标 8-12」，谁也没拦）。
 *
 * 为什么带上「辅助英雄 15 分钟」这条附注：实测（4 个种子 × 12 格，§208.2）唯一的系统性例外是
 * 守誓圣徒——它扛得住但打不动，Boss 会在核心前跟它贴脸磨 4 分钟（`heroDist <= 2` 就停手，§7.7），
 * 塔慢慢磨死 3600 血。它的单刷时长是 8.7-14.2 分钟，另外三个英雄全在 8.1-9.6。
 * 所以设计带对**辅助型英雄**放宽到 15 分钟，其余三个必须落在 8-12——放宽是按英雄分档写的，
 * 不是把所有人的线一起放宽（附录 B 有这条的实测回填）。
 */
const FIRST_MAPS = ['map_01', 'map_02', 'map_03'];   // 首发三图 = 1-3★
const SUPPORT_HEROES = new Set(['hero_paladin']);     // 辅助型（§4 的英雄定位表）
const gated = length === 'short' && players === 4 && diffs.includes('normal');
const fails = [];

if (gated) {
  console.log('\n验收检查（首发三图 · 普通难度 · 4 人基准）：每格必须「胜」且时长在带内');
  for (const mapId of FIRST_MAPS) {
    for (const heroId of Object.keys(HEROES)) {
      const band = SUPPORT_HEROES.has(heroId) ? [8, 15] : [8, 12];
      const m = createMatch({ mapId, difficulty: 'normal', heroId, seed, length, players });
      autoPlay(m, { maxSeconds: 1800 });
      const d = describe(m);
      const min = d.time / 60;
      const why = d.result !== 'win' ? `未通关（${d.result ?? '未结束'}）`
        : min < band[0] ? `${min.toFixed(1)} 分 < ${band[0]}`
          : min > band[1] ? `${min.toFixed(1)} 分 > ${band[1]}`
            : null;
      if (why) fails.push(`${mapId} · ${HEROES[heroId].name}：${why}`);
    }
  }
  console.log(fails.length ? '❌ 有格子掉出带：' : '✅ 12 格全在带内（8-12；辅助英雄守誓 8-15）');
  for (const f of fails) console.log(`   - ${f}`);
} else {
  console.log(`\n（本次跑的是 ${length === 'long' ? '长局' : `${players} 人档`}/${diffs.join('/')}：`
    + '验收线只管「短局 · 4 人 · 普通 · 首发三图」，这次不做检查）');
}

// 带宽：不检查的格子（4-6★ 与高难）单列一行区间，方便改数值后对比漂移。
console.log('\n带宽（只报数，不在验收线内）：');
for (const diff of diffs) {
  for (const mapId of Object.keys(MAPS)) {
    const mins = Object.keys(HEROES).map((heroId) => {
      const m = createMatch({ mapId, difficulty: diff, heroId, seed, length, players });
      autoPlay(m, { maxSeconds: length === 'long' ? 3600 : 1800 });
      const d = describe(m);
      return d.result === 'win' ? d.time / 60 : null;
    });
    const won = mins.filter((x) => x != null);
    const tag = FIRST_MAPS.includes(mapId) && diff === 'normal' && gated ? '（验收线内）' : '';
    console.log(`  ${diff} ${mapId}${tag}：胜 ${won.length}/4`
      + (won.length ? ` · ${Math.min(...won).toFixed(1)}-${Math.max(...won).toFixed(1)} 分` : ''));
  }
}

if (gated && fails.length) process.exit(1);
console.log('\n✅ 通过');
process.exit(0);
