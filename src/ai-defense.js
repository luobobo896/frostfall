// 防守模式的参考打法（工具与客户端调试共用一份，避免两处策略走偏）。
// 策略刻意做成「一个听话的新手」：先填满工事 → 预警回防并修城 → 空闲打野 → 血少嗑药。

import { buildFort, orderMove, repairCastle, updateDefense } from './defense.js';
import { buyItem, castSkill, usePotion } from './match.js';
import { gridDist } from './core.js';
import { TICK_STEP } from './data.js';

export function autoPlayDefense(m, { maxSeconds = 1200, dt = TICK_STEP, onTick = null } = {}) {
  let nextDecision = 0;
  let goal = 'farm';

  while (!m.over && m.time < maxSeconds) {
    updateDefense(m, dt);

    if (m.monsters.some((x) => !x.dead && gridDist(x.cell, m.hero.cell) <= 3)) castSkill(m, 0);
    if (m.monsters.some((x) => !x.dead && gridDist(x.cell, m.hero.cell) <= 4)) castSkill(m, 1);
    onTick?.(m);
    if (m.time < nextDecision) continue;
    nextDecision = m.time + 1.5;

    const danger = m.assault.warning
      || m.monsters.some((x) => !x.dead && x.kind === 'assault' && gridDist(x.cell, m.castle.cell) <= 6);
    if (danger) {
      if (goal !== 'defend') {
        goal = 'defend';
        orderMove(m, { x: m.castle.cell.x - 3, y: m.castle.cell.y });
      }
      // 回防期间只要城堡不满就修：攒钱不修等于没回
      if (m.castle.hp < m.castle.maxHp * 0.85 && m.gold >= 200) repairCastle(m);
      continue;
    }

    if (m.hero.hp < m.hero.def.hp * 0.6) {
      // §3.1 #14：商店在基地里——只有回到基地才买得进来（买不到就先用背包里的）
      if (!m.bag.pot_small && (!m.shopNear || gridDist(m.hero.cell, m.shopNear) <= m.shopNear.r)) {
        buyItem(m, 'pot_small');
      }
      usePotion(m, 'pot_small');
    }
    // 工事优先：守住基地靠塔阵，不是靠英雄一个人
    const freeSlot = m.def.fortSlots.findIndex((_, i) => !m.forts.some((f) => f.slot === i));
    if (freeSlot >= 0 && m.gold >= 60) buildFort(m, freeSlot, freeSlot % 4 === 3 ? 'fort_wall' : 'fort_arrow');
    else if (m.castle.hp < m.castle.maxHp * 0.5 && m.gold >= 200) repairCastle(m);

    if (goal !== 'farm' || !m.hero.path.length) {
      goal = 'farm';
      const camp = m.camps.map((c) => ({ c, d: gridDist(c, m.hero.cell) })).sort((a, b) => a.d - b.d)[0].c;
      orderMove(m, { x: camp.x, y: camp.y });
    }
  }
  return m;
}
