// 小游戏弹层的**几何底线**（一条用例管全部面板）：每一行 ≥44、在画布内、在自己的面板框里、互不重叠。
//
// 为什么要来这么一条：单块面板各自有用例（建造 / 商店 / 暂停…），但每加一种新面板就漏一块
// （塔面板、背包、物品详情、工事、防守那套暂停行都还没量过），而 §1.9.2 的热区线与「不许出界」
// 是**所有**面板共同的门槛。一条通用的扫法比给每块面板抄一遍更不容易漏。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DESIGN, layoutBag, layoutBattle, layoutItem, layoutPause, layoutShop, layoutSheet,
} from '../src/minigame/battle.js';
import { MINIMAP, layoutDefense } from '../src/minigame/defense-screen.js';
import { layoutFortSheet as fortSheet } from '../src/minigame/defense-screen.js';
import { createMatch, buildTower, makeEquipment } from '../src/match.js';
import { createDefenseMatch } from '../src/defense.js';

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 一种面板的全部底线 */
const checkSheet = (sheet, label) => {
  assert.ok(sheet, `${label}：没布局出来`);
  const box = sheet.box;
  if (box) {
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= DESIGN.w && box.y + box.h <= DESIGN.h,
      `${label}：面板框出界 ${JSON.stringify(box)}`);
  }
  for (const r of sheet.rows) {
    assert.ok(r.w >= 44 && r.h >= 44, `${label}/${r.id}：热区 ${r.w}×${r.h} 小于 44×44`);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= DESIGN.w && r.y + r.h <= DESIGN.h,
      `${label}/${r.id}：出界 ${JSON.stringify({ x: r.x, y: r.y, w: r.w, h: r.h })}`);
    if (box) {
      assert.ok(r.x >= box.x && r.y >= box.y && r.x + r.w <= box.x + box.w && r.y + r.h <= box.y + box.h,
        `${label}/${r.id}：超出面板框`);
    }
  }
  for (let i = 0; i < sheet.rows.length; i += 1) {
    for (let j = i + 1; j < sheet.rows.length; j += 1) {
      assert.ok(!overlap(sheet.rows[i], sheet.rows[j]),
        `${label}：${sheet.rows[i].id} 与 ${sheet.rows[j].id} 压在一起`);
    }
  }
};

test('小游戏弹层几何：每一种面板的每一行都 ≥44、在画布内、在面板框里、互不重叠', () => {
  const td = createMatch({ seed: 5 });
  td.gold = 5000;
  const dm = createDefenseMatch({ seed: 5 });
  dm.gold = 5000;

  // 建造 / 塔面板 / 商店（两种模式）/ 暂停（两种模式 × 是否处于「再点一次确认」）
  checkSheet(layoutSheet(td, { selectedSlot: 0 }), '建造面板');
  buildTower(td, 0, 'tw_arrow');
  checkSheet(layoutSheet(td, { panelSlot: 0 }), '塔面板');
  checkSheet(layoutShop(td, {}), '商店（TD）');
  checkSheet(layoutShop(dm, {}), '商店（防守）');
  checkSheet(layoutPause(td, { rate: 2, settings: { tdFitAll: false, sfx: false, effects: 'low', showWavePreview: false } }), '暂停（TD）');
  checkSheet(layoutPause(td, { settings: {}, resetArmed: true }), '暂停（重置确认中）');
  checkSheet(layoutPause(dm, { rate: 1, settings: { stick: 'floating', autoPickup: false, sfx: true, effects: 'high' } }), '暂停（防守）');
  // 工事（两种：有空位 / 没空位时行是一样的，取一份就够）
  checkSheet(fortSheet(dm, { freeSlots: 2, stickFloating: false }), '工事面板');

  // 背包：空 / 有货 / 可合成（多出一行「一键合成」）
  checkSheet(layoutBag(td, {}), '背包（空）');
  const items = [makeEquipment(td, 'weapon', 'blue', 6), makeEquipment(td, 'armor', 'blue', 6)];
  td.inventory.push(...items);
  checkSheet(layoutBag(td, {}), '背包（有货）');
  td.inventory.push(makeEquipment(td, 'weapon', 'blue', 6));
  checkSheet(layoutBag(td, { craftArmed: true }), '背包（可合成 · 确认中）');

  // 物品详情：背包里的（多一行「穿上」）与已装备的
  const inBag = items[0];
  checkSheet(layoutItem(td, { itemUid: inBag.uid }), '物品详情（背包里）');
  const equipped = Object.values(td.equipped).find(Boolean) ?? items[1];
  checkSheet(layoutItem(td, { itemUid: equipped.uid }), '物品详情（已装备）');
});

/**
 * HUD 上那几块**同时出现**的东西（顶栏 / 提示行 / 预告 / 英雄读数 / 面板 / 各种键）不许压在一起。
 * 单块各自有用例（热区、避开胶囊…），但「两块浮层叠在一块儿」这种错只有**跨块**看才看得见——
 * 浏览器那边 §145 就是这么查的（十一个面逐一量）。
 */
test('小游戏 HUD 互不重叠：同一帧里同时出现的那几块（含「结算面板 + 底排」这种组合）', () => {
  const box = (r) => ({ x: r.x, y: r.y, w: r.w, h: r.h });
  const line = (x, y, w) => ({ x, y: y - 7, w, h: 14 });   // 一行字大约 14 高
  const clash = (label, blocks) => {
    // 这两对是**有意套在一起**的：引导条里画着它自己的「跳过」键、小地图那一格就是小地图本身
    // （键只负责命中，图由绘制层贴上去）。除去这两对，其余两两不许压。
    const intentional = new Set(['引导条|tutorialSkip', 'tutorialSkip|引导条', '小地图|minimap', 'minimap|小地图']);
    for (let i = 0; i < blocks.length; i += 1) {
      for (let j = i + 1; j < blocks.length; j += 1) {
        const [na, a] = blocks[i], [nb, b] = blocks[j];
        if (intentional.has(`${na}|${nb}`)) continue;
        assert.ok(!overlap(a, b), `${label}：${na} 与 ${nb} 压在一起`);
      }
    }
  };

  // TD：第一局那一帧（有引导条、没结算面板）
  const td = createMatch({ seed: 5 });
  const model = { wave: 3, phase: 'prep', timer: 9, gold: 200, core: 2400, coreMax: 2400, result: null,
    length: 'short', canEarly: true, skills: [{ name: '旋风斩', lv: 1 }, { name: '战吼', locked: true }],
    potionCount: 1, potionReady: true, bagCount: 0, hero: { level: 1, dead: false, reviveIn: 0 }, lumber: 0,
    tutorial: '点亮的塔位可以建塔 —— 点一个，选「箭塔」', rate: 1, paused: false };
  const L1 = layoutBattle(model);
  clash('TD（第一局）', [['顶栏', box(L1.top)], ['胶囊区', box(L1.capsule)],
    ['下一波预告', line(L1.preview.x, L1.preview.y, L1.preview.w)],
    ['英雄读数', line(L1.heroLine.x - 80, L1.heroLine.y, 80)],
    ['引导条', box(L1.tutorial)], ...L1.items.map((it) => [it.id, box(it)])]);

  // TD：结算那一帧（面板 + 底排 + 右上的两个键）
  const L2 = layoutBattle({ ...model, result: 'win', tutorial: null });
  clash('TD（结算）', [['顶栏', box(L2.top)], ['胶囊区', box(L2.capsule)], ['结算面板', box(L2.result)],
    ['英雄读数', line(L2.heroLine.x - 80, L2.heroLine.y, 80)], ...L2.items.map((it) => [it.id, box(it)])]);

  // 防守：整局中途那一帧（顶栏 / 小地图 / 英雄读数 + 击杀 / 竖排键 / 技能排）
  const dm = createDefenseMatch({ seed: 5 });
  const DL = layoutDefense(dm, { rate: 1, paused: false, potionCount: 1, potionReady: true });
  clash('防守', [['顶栏', box(DL.top)], ['胶囊区', box(DL.capsule)], ['小地图', box(DL.minimap)],
    ['英雄读数', line(DL.heroLine.x, DL.heroLine.y, 200)],
    ['击杀/工事', line(DL.statsLine.right - 130, DL.statsLine.y, 130)],
    ['提示行', line(300, 300, 200)],
    ...DL.items.map((it) => [it.id, box(it)])]);
});
