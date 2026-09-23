// 小游戏弹层的**几何底线**（一条用例管全部面板）：每一行 ≥44、在画布内、在自己的面板框里、互不重叠。
//
// 为什么要来这么一条：单块面板各自有用例（建造 / 商店 / 暂停…），但每加一种新面板就漏一块
// （塔面板、背包、物品详情、工事、防守那套暂停行都还没量过），而 §1.9.2 的热区线与「不许出界」
// 是**所有**面板共同的门槛。一条通用的扫法比给每块面板抄一遍更不容易漏。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DESIGN, layoutBag, layoutItem, layoutPause, layoutShop, layoutSheet } from '../src/minigame/battle.js';
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
