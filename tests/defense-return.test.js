// 回防闭环：传送点 / 回城，以及附录 B 那条「30 秒预警够不够跑回基地」的实测。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFENSE_MAPS, DEFENSE_RULES, TICK_STEP } from '../src/data.js';
import { createDefenseMatch, orderMove, secondsToWalkHome, teleportHome, updateDefense } from '../src/defense.js';
import { gridDist } from '../src/core.js';
import { buyItem, createMatch } from '../src/match.js';

const advance = (m, seconds) => { for (let i = 0; i < Math.round(seconds / TICK_STEP); i++) updateDefense(m, TICK_STEP); };

test('回城：立刻落到基地门前，冷却 30 秒内不能再按', () => {
  const m = createDefenseMatch({ seed: 3 });
  orderMove(m, { x: m.camps[0].x, y: m.camps[0].y });
  advance(m, 12);
  assert.ok(gridDist(m.hero.cell, m.castle.cell) > 5, '前置：英雄应已远离基地');

  assert.equal(teleportHome(m), true);
  assert.ok(gridDist(m.hero.cell, m.castle.cell) <= 3, `回城后应贴着基地，实际距离 ${gridDist(m.hero.cell, m.castle.cell)}`);
  assert.equal(m.hero.path.length, 0, '回城要清掉原来的行进路径');
  assert.equal(m.hero.teleportCd, DEFENSE_RULES.teleportCooldownSec);

  assert.equal(teleportHome(m), false, '冷却中不能连按');
  advance(m, DEFENSE_RULES.teleportCooldownSec + 1);
  assert.equal(m.hero.teleportCd, 0);
  assert.equal(teleportHome(m), true, '冷却结束后可以再用');
});

test('阵亡时不能回城（得等复活）', () => {
  const m = createDefenseMatch({ seed: 4 });
  m.hero.dead = true;
  m.hero.reviveTimer = 10;
  assert.equal(teleportHome(m), false);
});

test('§5.5.1 回城卷轴：冷却中也能回基地，消耗 1 张，且不会把 30 秒冷却清掉', () => {
  const m = createDefenseMatch({ seed: 3 });
  m.gold = 1000;
  // §3.1#14：商店在基地里——先在基地门口把卷轴买好，再出城
  assert.ok(gridDist(m.hero.cell, m.shopNear) <= m.shopNear.r, '前置：英雄出生在基地里');
  const goldBefore = m.gold;
  assert.equal(buyItem(m, 'scroll_town'), true);
  assert.equal(m.scrolls, 1);
  assert.equal(goldBefore - m.gold, 80, '80 金一张');

  orderMove(m, { x: m.camps[0].x, y: m.camps[0].y });
  advance(m, 12);
  assert.ok(gridDist(m.hero.cell, m.castle.cell) > 5, '前置：英雄已出城');
  assert.equal(teleportHome(m), true, '第一次：免费回城（不该顺手吃掉卷轴）');
  assert.equal(m.scrolls, 1, '冷却外的免费回城不该消耗卷轴');
  const cd = m.hero.teleportCd;
  assert.ok(cd > 0);

  assert.equal(teleportHome(m), true, '冷却中：花 1 张卷轴也能回去');
  assert.equal(m.scrolls, 0, '消耗 1 张');
  assert.ok(gridDist(m.hero.cell, m.castle.cell) <= 3);
  assert.ok(m.hero.teleportCd > 0 && m.hero.teleportCd <= cd, '卷轴只负责送人，不清冷却（否则 3 张 = 3 次免费回城）');

  assert.equal(teleportHome(m), false, '卷轴用完了，冷却中还是按不动');
});

test('§3.1#14 防守商店在基地里：野外买不到（也不扣钱），回基地就能买', () => {
  const m = createDefenseMatch({ seed: 3 });
  m.gold = 1000;
  orderMove(m, { x: m.camps[0].x, y: m.camps[0].y });
  advance(m, 12);
  assert.ok(gridDist(m.hero.cell, m.shopNear) > m.shopNear.r, '前置：英雄已经出城');

  const goldBefore = m.gold;   // 出城路上打野会涨钱，比「没扣钱」只能看前后差
  assert.equal(buyItem(m, 'pot_small'), false, '野外买不到');
  assert.equal(m.gold, goldBefore, '买不到就不能扣钱');
  assert.equal(m.bag.pot_small ?? 0, 0, '也不能发货');

  assert.equal(teleportHome(m), true);
  assert.equal(buyItem(m, 'pot_small'), true, '回到基地就能买');
  assert.equal(m.bag.pot_small, 1);

  // 塔防没有这个字段（商店就在核心旁）：内核只认模式登记的 shopNear，不许按模式分支
  assert.equal(createMatch({ seed: 3 }).shopNear, undefined);
});

test('附录 B 实测：从最远野外区用走的回基地要多久（对照 30 秒预警）', () => {
  const rows = [];
  for (const def of Object.values(DEFENSE_MAPS)) {
    for (const heroId of ['hero_paladin', 'hero_ranger']) {   // 最慢 310 与最快 330，看两端
      const m = createDefenseMatch({ mapId: def.id, heroId, seed: 5 });
      // 走到最远的那个营地（离城堡最远），再算走回去要多久
      const farthest = m.camps.map((c) => ({ c, d: gridDist(c, m.castle.cell) })).sort((a, b) => b.d - a.d)[0].c;
      m.hero.cell = { x: farthest.x, y: farthest.y };
      rows.push({ mapId: def.id, heroId, tiles: gridDist(m.hero.cell, m.castle.cell), seconds: secondsToWalkHome(m) });
    }
  }
  for (const r of rows) {
    console.log(`  ${r.mapId} / ${r.heroId}：直线 ${r.tiles} 格 · 走回来约 ${r.seconds.toFixed(1)} 秒`);
  }
  const worst = Math.max(...rows.map((r) => r.seconds));
  // 结论有两种可能：跑得回来，或者必须靠回城。这里断言「至少要有一条路成立」——
  // 回城存在（30 秒冷却）就永远能在预警内到位，这条验收才真正闭环。
  const teleportOk = DEFENSE_RULES.teleportCooldownSec <= DEFENSE_RULES.assaultWarnSec;
  assert.ok(worst <= DEFENSE_RULES.assaultWarnSec || teleportOk,
    `最坏情况走回来要 ${worst.toFixed(1)} 秒 > 预警 ${DEFENSE_RULES.assaultWarnSec} 秒，且回城也没法覆盖`);
  if (worst > DEFENSE_RULES.assaultWarnSec) {
    console.log(`  → 最坏 ${worst.toFixed(1)} 秒 > 30 秒预警：必须靠回城（冷却 ${DEFENSE_RULES.teleportCooldownSec}s，即时到位）`);
  } else {
    console.log(`  → 最坏 ${worst.toFixed(1)} 秒 ≤ 30 秒预警：光靠走也来得及`);
  }
});
