// 自动打局：用于自校验与回归测试，也当作「如果玩家像 §8.6 基准那样打」的参考策略。
// 策略刻意简单：按顺序铺塔 → 铺满后升级 → 有钱就合成 → 技能一好就放。

import {
  buildTower, buyItem, castSkill, craftEquipment, craftableSlots, shopPriceOf,
  towerAtSlot, update, upgradeTower, usePotion, setPriority,
} from './match.js';
import { TICK_STEP, TOWERS, WAVES } from './data.js';
import { gridDist } from './core.js';

// §8.6 的基准配置：6 座箭塔 + 2 座炮塔（第 6 波前），之后补冰塔与静电塔
// §8.6 的基准配置：6 座箭塔 + 2 座炮塔（第 6 波前），之后补冰塔 / 静电塔 / 继续铺塔
export const BUILD_ORDER = [
  'tw_arrow', 'tw_arrow', 'tw_arrow', 'tw_arrow', 'tw_arrow', 'tw_arrow',
  'tw_cannon', 'tw_cannon',
  'tw_frost', 'tw_static', 'tw_arrow', 'tw_arrow', 'tw_cannon', 'tw_static',
];

/**
 * 长局的建造顺序要换一套：30 波里有 3 个 Boss，而 Boss 是加强甲——
 * 按 §6.2 的克制表，只有攻城（炮塔）与普通（箭塔）打得动，魔法与穿刺只有 0.35。
 * 短局用上面那套通用序够用，长局必须提高炮塔占比，否则最终 Boss 就是打不动。
 */
export const LONG_BUILD_ORDER = [
  'tw_arrow', 'tw_cannon', 'tw_frost', 'tw_cannon', 'tw_arrow', 'tw_static',
  'tw_cannon', 'tw_arrow', 'tw_frost', 'tw_cannon', 'tw_arrow', 'tw_static',
  'tw_cannon', 'tw_arrow', 'tw_frost', 'tw_cannon', 'tw_arrow', 'tw_static',
  'tw_cannon', 'tw_arrow', 'tw_frost', 'tw_cannon', 'tw_arrow', 'tw_static',
  'tw_cannon', 'tw_arrow', 'tw_frost', 'tw_cannon', 'tw_arrow', 'tw_static',
  'tw_cannon', 'tw_arrow',
];

/** 塔位评分：能覆盖多少路径格 + 能否同时覆盖多条路径（双路图的关键）。 */
export function slotCoverage(m, slotIndex, range = 5.0) {
  const cell = m.map.slots[slotIndex];
  let cells = 0, lanes = 0;
  for (const path of m.map.paths) {
    let hit = false;
    for (const c of path.cells) if (gridDist(cell, c) <= range) { cells += 1; hit = true; }
    if (hit) lanes += 1;
  }
  return cells + lanes * 4;
}

function bestFreeSlot(m) {
  /**
   * 按「还没被任何塔覆盖的路段」选塔位。
   * 之前按总覆盖率选，塔会全堆在路最密的一侧：map_04 实测三条路的覆盖是 19/9/**3**，
   * 第三条路几乎裸奔，最终 Boss 恰好走那条路、全程只挨了 517 点伤害就走了过去。
   */
  let best = -1, bestScore = -1;
  for (let i = 0; i < m.map.slots.length; i++) {
    if (towerAtSlot(m, i)) continue;
    const cell = m.map.slots[i];
    let gapCells = 0, lanes = 0;
    for (const p of m.map.paths) {
      let hit = false;
      for (const c of p.cells) {
        if (gridDist(cell, c) > 5.0) continue;   // 基准射程内才算能打到
        hit = true;
        if (!m.towers.some((t) => gridDist(t.cell, c) <= t.stats.range)) gapCells += 1;
      }
      if (hit) lanes += 1;
    }
    const score = gapCells + lanes * 2;          // 顺带偏好能同时照顾多条路的塔位
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/**
 * `potions: false` 关掉「买药 + 嗑药」这两段（§5.5 的药品平衡要靠这个对照组量：
 * 用药与不用药的胜率差、以及单局到底用了几次）。
 */
export function autoPlay(m, { untilWave = null, maxSeconds = 1800, dt = TICK_STEP, onTick = null, potions = true } = {}) {
  const lastWave = untilWave ?? (m.waves?.length ?? WAVES.length);
  const order = m.length === 'long' ? LONG_BUILD_ORDER : BUILD_ORDER;
  let buildIndex = 0;
  let fallbacks = 0;   // 用便宜箭塔「顶替」的次数上限：顶太多就没有塔位留给炮塔了
  let actionClock = 0;
  while (!m.result && m.time < maxSeconds && m.wave.index <= lastWave) {
    update(m, dt);
    actionClock += dt;
    if (actionClock < 0.4) { onTick?.(m); continue; }
    actionClock = 0;

    // 技能：能用就用（冷却由 match 内部管理）
    for (let i = 0; i < 3; i++) castSkill(m, i);

    // 目标优先级：场上有 Boss 就全体切「最强」集火，其余时候回「最靠前」。
    // 这是 §8.3 专门为打 Boss 留的杠杆，之前参考打法一直没用——长局的最终 Boss
    // 就是因为塔一直在打小怪、Boss 走完全程而漏掉的。
    const bossOnField = m.monsters.some((x) => !x.dead && x.def.tier === 'boss');
    const wantedPriority = bossOnField ? 'strongest' : 'front';
    for (const t of m.towers) {
      if (t.priority !== wantedPriority) setPriority(m, t.slot, wantedPriority);
    }

    // 合成：有可合成组合就合
    for (const c of craftableSlots(m)) craftEquipment(m, c.slot, c.quality);

    // 建造：按顺序铺塔，塔位挑「覆盖路径最多」的那个（双路图靠这条才守得住）
    const wanted = order[buildIndex] ?? 'tw_arrow';
    // 钱不够时用箭塔顶一下，但**不吃掉这个位置**——否则长局里买不起的炮塔会被箭塔顶替掉，
    // 最后攒出一整排箭塔，打不动加强甲 Boss（实测就是这样卡在长局第 30 波）
    let next = wanted;
    const freeSlots = m.map.slots.filter((_, i) => !towerAtSlot(m, i)).length;
    // 而且顶替要限量 + 留出塔位：否则塔位会被箭塔占满，长局里攒不出一排炮塔
    const maxFallbacks = m.length === 'long' ? 6 : 99;
    if (m.gold < TOWERS[wanted].cost && next !== 'tw_arrow') {
      if (freeSlots > 4 && fallbacks < maxFallbacks) { next = 'tw_arrow'; fallbacks += 1; }
    }
    const slot = bestFreeSlot(m);
    const reserve = 60; // 留一点余钱给下一座塔，避免「升级吃光新塔的钱」
    const built = slot >= 0 && m.gold >= TOWERS[next].cost + reserve && buildTower(m, slot, next);
    if (built && next === wanted) buildIndex += 1;
    // 正在攒钱等「计划中的那座塔」时不要顺手升级，否则钱永远攒不够；
    // 塔位满了（slot < 0）或只是顶替箭塔时，才把余钱投进升级
    // 大图（≥28 塔位）要更早开始升级：塔位多、光铺 1 级塔守不住四路（map_06 实测被打穿）
    const upgradeGate = (m.map.slots.length >= 28 ? 1.5 : 2) * TOWERS[next].cost + 200;
    if (!built && (slot < 0 || m.gold >= upgradeGate)) {
      // 塔位铺满或钱不够新塔：升级已有塔（优先低等级的，收益最大）
      const upgradable = m.towers
        .filter((t) => t.level < 3)
        .sort((a, b) => a.level - b.level || slotCoverage(m, b.slot) - slotCoverage(m, a.slot))[0];
      if (upgradable) upgradeTower(m, upgradable.slot);
    }

    /**
     * 补给：血量低于 50% 时买药；木材够就买秘传技能书。
     *
     * STATUS §3.1 #17 的余波（验证记录 §207）：**消耗品只能花「余钱」**——先把下一座计划的塔
     * 的钱留出来（和上面升级的 `upgradeGate` 同一个思路）。以前的写法是「钱够药价就买」，
     * 于是价格一便宜，参考打法就多买药、少建塔，矩阵数字反而变差 ✗——那说明**是模型在乱花钱**，
     * 不是「药品不划算」（§85 那条结论有一部分是 AI 的预算政策造成的）。
     */
    const towerReserve = TOWERS[next]?.cost ?? 0;            // 下一座计划塔的造价（没铺满时要留出来）
    const spare = m.gold - (built ? 0 : towerReserve);       // 余钱 = 扣掉塔钱之后剩下的
    if (potions && m.hero.hp < m.hero.def.hp * 0.5 && spare >= (shopPriceOf(m, 'pot_small')?.gold ?? Infinity)) {
      buyItem(m, 'pot_small');
    }
    if (m.wave.phase === 'prep' && m.wave.index >= 4 && spare > 0) {
      // 秘传优先（解锁整个第 3 技能），买完再看精研（§3.1 #26：精研 = 把一档拉满）。
      // 两条都只看**余钱**：以前只写了秘传，于是精研书的购买率恒为 0（不是价格问题，是模型没这条策略）。
      if (m.lumber[0] >= 20 && !m.hero.skillUnlocked[2] && spare >= (shopPriceOf(m, 'book_secret')?.gold ?? Infinity)) {
        buyItem(m, 'book_secret');
      } else if (spare >= (shopPriceOf(m, 'book_up')?.gold ?? Infinity)) {
        buyItem(m, 'book_up');
      }
    }
    // 治疗：血量低且背包有药时立刻用
    if (potions) for (const k of Object.keys(m.bag)) if (m.bag[k] > 0 && m.hero.hp < m.hero.def.hp * 0.6) usePotion(m, k);
    onTick?.(m);
  }
  return m;
}
