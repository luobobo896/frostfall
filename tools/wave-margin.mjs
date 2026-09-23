// 逐波余量实测：按 §8.5「该时间点能做的事」的下限口径摆塔，逐波单独跑一遍，看每波到底有多少压力。
// 为什么需要它：§8.6 的纸面表假设「所有塔全程在射程内」，那是上界；真实地图上塔沿路分布，
// 每只怪只在每座塔的射程里待几秒。这个工具给的是实测那一侧。
// 用法： node tools/wave-margin.mjs [map_01] [normal]
// 人数：默认 4（§8.5 的下限口径是 4 人基准，§6.4.2 的怪量表就是 ×1.00 行）；单人档用 FF_PLAYERS=1
import { buildTower, createMatch, investedOf, towerAtSlot, update, upgradeTower } from '../src/match.js';
import { slotCoverage } from '../src/ai.js';
import { ECONOMY, MONSTERS, TIMING, WAVES } from '../src/data.js';

const [mapId = 'map_01', difficulty = 'normal'] = process.argv.slice(2);
const players = Number(process.env.FF_PLAYERS ?? 4);
const TICK = 1 / TIMING.tickRate;

/**
 * 每波「设计基准玩家」的配置：取 §8.5 表里「该时间点能做的事」的**下限**（保守口径），
 * 中间波按前后两档线性补。箭塔先铺、第 5 波起掺炮塔，等级按表里写的档位。
 */
const CONFIG = {
  1: { arrows: 2, level: 1, cannons: 0 },
  2: { arrows: 3, level: 1, cannons: 0 },
  3: { arrows: 5, level: 1, cannons: 0 },
  4: { arrows: 6, level: 1, cannons: 0 },
  5: { arrows: 6, level: 1, cannons: 1 },
  6: { arrows: 6, level: 2, cannons: 2 },   // §8.6 的基准配置
  7: { arrows: 8, level: 2, cannons: 2 },
  8: { arrows: 9, level: 2, cannons: 3 },
  9: { arrows: 10, level: 2, cannons: 3 },
  10: { arrows: 10, level: 3, cannons: 2 },
  11: { arrows: 11, level: 3, cannons: 3 },
  12: { arrows: 13, level: 3, cannons: 5 },  // §8.5：18 塔位填不满，必须取舍
};

/** 按覆盖率从好到差排塔位：这是「基准玩家的合理摆法」，不是最优解。 */
const slotsByCoverage = (m) =>
  m.map.slots.map((_, i) => i).sort((a, b) => slotCoverage(m, b) - slotCoverage(m, a));

function buildBaseline(m, wave) {
  const cfg = CONFIG[wave];
  const order = slotsByCoverage(m);
  let cursor = 0;
  m.gold = 1e9;
  for (let i = 0; i < cfg.arrows; i++) buildTower(m, order[cursor++], 'tw_arrow');
  for (let i = 0; i < cfg.cannons; i++) buildTower(m, order[cursor++], 'tw_cannon');
  for (const slot of order.slice(0, cfg.arrows)) {
    while ((towerAtSlot(m, slot)?.level ?? 99) < cfg.level) upgradeTower(m, slot);
  }
  m.gold = 0;
}

/** 跑一波：从 prep 直接进第 wave 波，跑到清场或超时。 */
function runWave(wave) {
  const m = createMatch({ mapId, difficulty, heroId: 'hero_warrior', seed: 7, players });
  buildBaseline(m, wave);
  for (const c of m.cores ?? [m.core]) c.hp = c.maxHp;   // 只看这一波自己掉多少（map_06 是两个核心）
  m.stats.leaks = 0;
  m.gold = 0;
  m.wave = { index: wave - 1, phase: 'prep', timer: 0.05, spawned: 0, total: 0, queue: [] };
  const t0 = m.time;
  let started = false;
  while (!m.result && m.time - t0 < 180) {
    update(m, TICK);
    if (m.wave.index === wave && m.wave.phase !== 'prep') started = true;
    if (started && m.wave.index === wave && m.wave.phase === 'prep') break;   // finishWave 会把 index 留在本波、phase 回到 prep
    if (m.wave.index > wave) break;
  }
  return {
    wave,
    towers: m.towers.length,
    damage: Math.round((m.cores ?? [m.core]).reduce((s, c) => s + (c.maxHp - c.hp), 0)),
    leaks: m.stats.leaks,
    cleared: started,
    seconds: +(m.time - t0).toFixed(1),
    queue: WAVES[wave - 1].groups.reduce((s, g) => s + g.count, 0),
  };
}

/** §8.5 的累计金币（同一套算式：击杀赏金 ×0.5 + 波次奖励），用来核「这套配置买得起吗」 */
function cumulativeGold(wave) {
  let g = ECONOMY.startGold;
  for (let i = 0; i < wave; i++) {
    const w = WAVES[i];
    g += w.groups.reduce((s, grp) => s + MONSTERS[grp.mobId].bounty * grp.count, 0) * ECONOMY.bountyMul
      + ECONOMY.waveGold(w.wave);
  }
  return Math.round(g);
}
const configCost = (cfg) => cfg.arrows * investedOf('tw_arrow', cfg.level) + cfg.cannons * investedOf('tw_cannon', 1);

console.log(`逐波余量实测 · ${mapId} · ${difficulty} · 配置取 §8.5 的下限口径（seed 7 · ${players} 人基准 · §1.6）`);
const broke = WAVES.map((x) => x.wave).filter((w) => configCost(CONFIG[w]) > cumulativeGold(w));
console.log(`配置预算自检：${broke.length ? `⚠️ 第 ${broke.join('/')} 波的配置超出当时的累计金币（基准玩家买不起）` : '✅ 每波配置都在当时的累计金币之内'}`);
console.log('波 | 配置 | 怪量 | 清场 | 用时 | 核心掉血 | 漏怪');
const failed = [];
for (const w of WAVES.map((x) => x.wave)) {
  const r = runWave(w);
  const cfg = CONFIG[w];
  console.log(`${String(r.wave).padStart(2)} | ${cfg.arrows}箭L${cfg.level}+${cfg.cannons}炮 | ${String(r.queue).padStart(3)} | `
    + `${r.cleared ? '✅' : '❌'} | ${r.seconds.toFixed(1).padStart(5)}s | ${String(r.damage).padStart(4)} | ${r.leaks}`);
  if (!r.cleared) failed.push(`第 ${r.wave} 波没清掉`);
}
/**
 * 这份表是**验收证据**，所以它必须有结论（§110/§111 的教训：只印 ✅/❌ 不给出口码的工具，
 * 红了也会被 `npm run waves && …` 当成通过）。两类都算红：某波没清掉、或基准玩家买不起那一波的配置。
 */
if (failed.length || broke.length) {
  if (broke.length) failed.push(`配置预算：第 ${broke.join('/')} 波超出当时累计金币`);
  console.error(`❌ 逐波余量不达标：${failed.join('；')}`);
  process.exit(1);
}
console.log(`✅ 12 波全部按 §8.5 的下限配置清掉，且每波配置都买得起`);
