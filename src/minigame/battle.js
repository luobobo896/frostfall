// 小游戏战场那一屏（移植第 3 步的第二屏）：**战场用现成的 render.js，外面这一圈 HUD 用 Canvas 重画**。
//
// 与 lobby.js 同一套写法（布局 / 绘制 / 命中 / 状态四件套，纯函数、零 DOM），
// 区别是战场那边直接复用浏览器版已经验过的等距渲染：`createRenderer(canvas, { size })`。
//
// 这一屏的交互是**简化版**：点塔位 = 用当前选中的塔种建塔（已有塔则升级），点「开波」提前开波，
// 点技能键放技能，点「回大厅」退回去。浏览器版那一套「点塔位 → 轮盘选塔 → 塔面板（升级/出售/优先级）」
// 还没搬过来——真机手感确认之后再决定照搬还是换成更适合拇指的两步式（见 docs/minigame-port.md §5.2）。
import {
  EQUIP_SELL_BONUS_LUMBER, EQUIP_SELL_REFUND, EQUIP_SLOTS, QUALITY, QUALITY_ORDER,
  SHOP_ITEMS, TARGET_PRIORITIES, TOWERS, TOWER_SELL_REFUND,
} from '../data.js';
import { attackHint } from '../hud-model.js';
import {
  TOWER_REPAIR_GOLD, craftableSlots, enhanceCostOf, potionCount, shopPriceOf, towerStatsAt, upgradeCost,
} from '../match.js';

export const DESIGN = { w: 667, h: 375 };
/** 右上角胶囊按钮的禁区（和 lobby 同一条要求） */
export const CAPSULE = { w: 96, h: 32 };
export const TOWER_ORDER = ['tw_arrow', 'tw_cannon', 'tw_frost', 'tw_static'];
export const PRIORITY_LABEL = { front: '最靠前', strongest: '最强', weakest: '最弱', air_first: '空中优先' };
export const POTION_BAG_SLOTS = 3;   // §5.5.3：药品共 3 格（与内核同一个数）
const QUALITY_NAME = Object.fromEntries(Object.entries(QUALITY).map(([k, v]) => [k, v.name ?? k]));
const NEXT_QUALITY = { white: 'blue', blue: 'purple', purple: 'orange' };

const COLORS = {
  panel: 'rgba(12, 20, 34, 0.86)',
  panelLine: 'rgba(120, 170, 230, 0.25)',
  ink: '#e8eef7',
  dim: '#93a4bd',
  accent: '#5aa9e6',
  gold: '#e8c15a',
  wood: '#7fc08a',
  danger: '#d1503f',
};

const roundRect = (ctx, x, y, w, h, r) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
};

const text = (ctx, str, x, y, { size = 12, color = COLORS.ink, weight = '', align = 'left' } = {}) => {
  ctx.fillStyle = color;
  ctx.font = `${weight ? `${weight} ` : ''}${size}px "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(str, x, y);
};

const item = (id, x, y, w, h, label, action, extra = {}) => ({ id, x, y, w, h, label, action, ...extra });

/**
 * 战场 HUD 的布局（设计单位 667×375）。战场本身占满整屏，HUD 是压在上面的浮层：
 * 顶部一条状态栏、底部一排行（塔种 / 开波 / 技能 / 回大厅）。
 */
export function layoutBattle(model = {}) {
  const items = [];
  /**
   * 底部一排（从左到右）：商店 / 背包 / 药品 / 开波（结算时变「再开一局」）/ 技能 1 / 技能 2 / 回大厅。
   * 上一版这里是四个塔种快捷键——建塔改成「点塔位弹面板」之后它们就没用了（同一个决定两个入口），
   * 于是让位给局内真正缺的三个入口。
   */
  items.push(item('shop', 12, 315, 74, 48, '商店', { type: 'shop' }));
  items.push(item('bag', 94, 315, 74, 48, `背包${model.bagCount ? `(${model.bagCount})` : ''}`, { type: 'bag' }));
  items.push(item('potion', 176, 315, 74, 48, `药品 ${model.potionCount ?? 0}/${POTION_BAG_SLOTS}`,
    { type: 'potion' }, { disabled: !model.potionCount }));
  items.push(model.result
    ? item('restart', 258, 315, 92, 48, '再开一局', { type: 'restart' })
    : item('early', 258, 315, 92, 48, '开波', { type: 'early' }, { disabled: !model.canEarly }));
  for (let i = 0; i < 2; i += 1) {
    items.push(item(`skill-${i}`, 358 + i * 66, 315, 58, 48, i === 0 ? '技能 1' : '技能 2',
      { type: 'skill', index: i }, { disabled: !(model.skills?.[i] ?? i === 0) }));
  }
  items.push(item('lobby', 588, 315, 67, 48, '回大厅', { type: 'lobby' }));
  return {
    w: DESIGN.w, h: DESIGN.h,
    capsule: { x: DESIGN.w - CAPSULE.w - 8, y: 6, w: CAPSULE.w, h: CAPSULE.h },
    top: { x: 12, y: 8, w: 380, h: 30 },
    result: { x: 173, y: 120, w: 320, h: 130 },
    items,
    byId: Object.fromEntries(items.map((it) => [it.id, it])),
  };
}

/** 触点 → HUD 动作（返回 null 表示点在战场空白处，交给调用方翻成「点塔位」） */
export function hitTestBattle(L, x, y) {
  for (const it of L.items) {
    // 只有真正可点的才接：灰按钮（买不起的塔 / 还没解锁的技能）点下去要有反馈，所以仍然命中
    if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return it.action;
  }
  return null;
}

/** 画 HUD（战场本身由 render.js 画，这里只画压在上面的那一圈） */
export function drawBattleHud(ctx, m, L, { selectedTower = 'tw_arrow', message = null } = {}) {
  const waveLabel = m.length === 'long' ? `${m.wave.index} / 30 波` : `${m.wave.index} / 12 波`;
  const core = `${Math.round(m.core.hp)}/${m.core.maxHp}`;
  const phase = m.wave.phase === 'prep' ? `备战 ${Math.ceil(m.wave.timer)}s` : '交战中';

  ctx.fillStyle = COLORS.panel;
  roundRect(ctx, L.top.x, L.top.y, L.top.w, L.top.h, 8);
  ctx.fill();
  ctx.strokeStyle = COLORS.panelLine;
  ctx.lineWidth = 1;
  ctx.stroke();
  text(ctx, `第 ${waveLabel}`, L.top.x + 10, L.top.y + 15, { size: 13, weight: 'bold' });
  text(ctx, phase, L.top.x + 106, L.top.y + 15, { size: 11, color: COLORS.dim });
  text(ctx, `金 ${Math.round(m.gold)}`, L.top.x + 186, L.top.y + 15, { size: 12, color: COLORS.gold });
  text(ctx, `木 ${Math.round(m.lumber?.[0] ?? 0)}`, L.top.x + 252, L.top.y + 15, { size: 12, color: COLORS.wood });
  text(ctx, `核心 ${core}`, L.top.x + 312, L.top.y + 15, { size: 12, color: m.core.hp / m.core.maxHp < 0.35 ? COLORS.danger : COLORS.ink });

  for (const it of L.items) {
    const on = !!it.on;
    ctx.fillStyle = on ? 'rgba(90,169,230,0.24)' : COLORS.panel;
    roundRect(ctx, it.x, it.y, it.w, it.h, 8);
    ctx.fill();
    ctx.strokeStyle = on ? COLORS.accent : COLORS.panelLine;
    ctx.lineWidth = on ? 2 : 1;
    ctx.stroke();
    text(ctx, it.label, it.x + it.w / 2, it.y + it.h / 2, {
      size: 13, align: 'center', color: it.disabled ? COLORS.dim : COLORS.ink, weight: 'bold',
    });
  }

  if (message) {
    text(ctx, message, L.w / 2, 60, { size: 12, align: 'center', color: COLORS.gold });
  }

  // 结算：内核出结果之后盖一块面板（这一版只有「再开一局 / 回大厅」两个出口）
  if (m.result) {
    const r = L.result;
    ctx.fillStyle = 'rgba(5,8,14,0.86)';
    roundRect(ctx, r.x - 12, r.y - 12, r.w + 24, r.h + 24, 12);
    ctx.fill();
    ctx.strokeStyle = COLORS.panelLine;
    ctx.stroke();
    text(ctx, m.result === 'win' ? '守住了！' : '核心被摧毁', r.x + r.w / 2, r.y + 26,
      { size: 20, weight: 'bold', align: 'center', color: m.result === 'win' ? COLORS.gold : COLORS.danger });
    text(ctx, `单局时长 ${(m.time / 60).toFixed(1)} 分钟 · 漏怪 ${m.stats.leaks}`, r.x + r.w / 2, r.y + 54,
      { size: 12, align: 'center', color: COLORS.dim });
    text(ctx, '（这一版的出口在下面：回大厅 / 再开一局）', r.x + r.w / 2, r.y + 78,
      { size: 10, align: 'center', color: COLORS.dim });
  }
  return L;
}

/* ---------- 弹层：建造选塔 / 塔面板 ---------- */

/**
 * 点塔位之后弹出来的那张**底部面板**（两种：空地→选塔种，已有塔→塔面板）。
 *
 * 为什么不用浏览器版那个**轮盘**：轮盘要绕触点画一圈、拇指得精确瞄准，而小游戏的屏幕更小、
 * 手指更粗。这里先给「两步式」——点塔位 → 面板里选/操作，行高 44pt（§1.9.2）。
 * 真机手感确认之后如果轮盘更顺手，再换（换的时候这一层的四件套不用动）。
 */
export function layoutSheet(m, ui = {}) {
  if (ui?.sheetKind === 'shop') return layoutShop(m, ui);
  if (ui?.sheetKind === 'bag') return layoutBag(m, ui);
  if (ui?.sheetKind === 'item') return layoutItem(m, ui);
  const slot = ui.panelSlot ?? ui.selectedSlot ?? null;
  if (slot == null) return null;
  const t = m.towers.find((x) => x.slot === slot) ?? null;
  const cell = m.map.slots[slot];
  const rows = [];

  if (!t) {
    // 建造：4 种塔两列排（比单列省一半高度）
    TOWER_ORDER.forEach((id, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      rows.push({
        id: `build-${id}`, label: TOWERS[id].name, sub: `${TOWERS[id].cost} 金`,
        x: 20 + col * 314, y: 96 + row * 50, w: 300, h: 44,
        disabled: m.gold < TOWERS[id].cost,
        action: { type: 'build', slot, towerId: id },
      });
    });
    rows.push({
      id: 'cancel', label: '取消', x: 20, y: 200, w: 614, h: 44, action: { type: 'close' },
    });
    return {
      kind: 'build',
      title: `在这里建塔（第 ${slot + 1} 号塔位 · 金币 ${Math.round(m.gold)}）`,
      hint: cell ? `格 ${cell.x},${cell.y}` : '',
      box: { x: 12, y: 62, w: 643, h: 194 },
      rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])),
    };
  }

  // 塔面板：读数 + 升级 / 出售（两步）/ 优先级 / 修塔（只在攻城图）/ 关闭
  const s = t.stats ?? towerStatsAt(m.map, t.cell, t.towerId, t.level);
  const cost = upgradeCost(t.towerId, t.level);
  const refund = Math.floor(t.invested * TOWER_SELL_REFUND);   // 与内核同一个常数，别手写比例
  const canRepair = !!m.map.def.siege && t.maxHp && t.hp < t.maxHp;
  const info = `Lv${t.level} · 伤害 ${s.damage.toFixed(1)} · 攻速 ${s.atkSpeed.toFixed(2)} · 射程 ${s.range.toFixed(1)}`
    + (s.hitsAir ? ' · 对空' : ' · 不对空') + ` · ${attackHint(s.attackType)}`;

  rows.push({
    id: 'upgrade', label: cost == null ? '已满级' : `升级 → Lv${t.level + 1}`, sub: cost == null ? '' : `${cost} 金`,
    x: 20, y: 96, w: 300, h: 44, disabled: cost == null || m.gold < cost,
    action: { type: 'upgrade', slot },
  });
  rows.push({
    id: 'sell', label: ui.sellArmed ? '确认出售' : '出售', sub: `返还 ${refund} 金`,
    x: 334, y: 96, w: 300, h: 44, danger: !!ui.sellArmed,
    action: { type: 'sell', slot },
  });
  // 竖直节奏跟着「有没有修塔那一行」走：没有它就往上收，不留一条空带（第一版固定坐标，样张里一眼看得出来）
  const prioY = canRepair ? 196 : 146;
  const closeY = canRepair ? 246 : 196;
  if (canRepair) {
    rows.push({
      id: 'repair', label: '修塔', sub: `${TOWER_REPAIR_GOLD} 金`,
      x: 20, y: 146, w: 300, h: 44, disabled: m.gold < TOWER_REPAIR_GOLD,
      action: { type: 'repair', slot },
    });
  }
  TARGET_PRIORITIES.forEach((p, i) => {
    rows.push({
      id: `prio-${p}`, label: PRIORITY_LABEL[p], x: 20 + i * 157, y: prioY, w: 148, h: 44,
      on: t.priority === p, action: { type: 'priority', slot, value: p },
    });
  });
  rows.push({
    id: 'close', label: '关闭', x: 20, y: closeY, w: 614, h: 44,
    action: { type: 'close' },
  });
  return {
    kind: 'tower',
    title: `${TOWERS[t.towerId].name} · Lv${t.level}`,
    hint: info,
    box: { x: 12, y: 62, w: 643, h: canRepair ? 240 : 190 },
    rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}

/* ---------- 商店 / 背包 / 物品详情 ---------- */

const itemLabel = (it) =>
  `${QUALITY_NAME[it.quality] ?? it.quality}${EQUIP_SLOTS[it.slot]?.name ?? it.slot} ilvl${it.ilvl}${it.plus ? ` +${it.plus}` : ''}`;

/**
 * 商店（§5.5）：药品 3 格、技能书；**禁售与买满的写在行上**（§3.1 #20 的口径：撤柜也要说清为什么）。
 * 波次中下单会走 3 秒读条（§5.5）——读条进度写在标题里，玩家不用猜为什么按钮点不动。
 */
export function layoutShop(m, ui = {}) {
  const rows = [];
  SHOP_ITEMS.forEach((it, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const price = shopPriceOf(m, it.id) ?? { gold: it.priceGold, lumber: it.priceLumber ?? 0 };
    const blocked = m.shopBlocked?.[it.id];
    const bought = m.shopBought?.[it.id] ?? 0;
    const maxed = it.limit != null && bought >= it.limit;
    const bagFull = it.type === 'potion' && potionCount(m) >= POTION_BAG_SLOTS;
    const sub = blocked ? '已撤柜'
      : maxed ? '已买满'
        : bagFull ? '药品格已满'
          : `${price.gold} 金${price.lumber ? ` + ${price.lumber} 木` : ''}`;
    rows.push({
      id: `buy-${it.id}`, label: it.name, sub,
      x: 20 + col * 314, y: 96 + row * 50, w: 300, h: 44,
      disabled: !!blocked || maxed || bagFull || m.gold < price.gold,
      action: { type: 'buy', itemId: it.id },
    });
  });
  const closeY = 96 + Math.ceil(SHOP_ITEMS.length / 2) * 50;
  rows.push({ id: 'close', label: '关闭', x: 20, y: closeY, w: 614, h: 44, action: { type: 'close' } });
  const cast = m.shopCast ? ` · 读条中 ${Math.max(0, (m.shopCast.until ?? 0) - m.time).toFixed(1)}s` : '';
  return {
    kind: 'shop',
    title: `商店 · 金币 ${Math.round(m.gold)}${cast}`,
    hint: `药品 ${potionCount(m)}/${POTION_BAG_SLOTS} 格 · 波次中下单读条 3 秒`,
    box: { x: 12, y: 62, w: 643, h: closeY - 6 },
    rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}

/**
 * 背包（§5.2/§5.4）：已装备 3 格 + 最近掉落的几件；点一件进「物品详情」。
 * 一屏放得下的件数有限（小游戏屏幕就这么大），所以只列最近的，剩下的在提示行里写清总数。
 */
export function layoutBag(m, ui = {}) {
  const rows = [];
  const equipped = Object.keys(EQUIP_SLOTS).map((s) => m.equipped?.[s]).filter(Boolean);
  const inv = [...(m.inventory ?? [])].reverse();
  const shown = [...equipped.map((it) => ({ it, equipped: true })), ...inv.map((it) => ({ it, equipped: false }))].slice(0, 6);
  shown.forEach(({ it, equipped: isEq }, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    rows.push({
      id: `item-${it.uid}`, label: itemLabel(it), sub: isEq ? '已装备' : `${(it.affixes ?? []).length} 词条`,
      x: 20 + col * 314, y: 96 + row * 50, w: 300, h: 44, on: isEq,
      action: { type: 'item', uid: it.uid },
    });
  });
  if (!shown.length) {
    rows.push({ id: 'empty', label: '还没有掉落', x: 20, y: 96, w: 614, h: 44, disabled: true, action: null });
  }
  const craft = craftableSlots(m)[0];
  const rowY = 96 + Math.max(1, Math.ceil(shown.length / 2)) * 50;
  if (craft) {
    rows.push({
      id: 'craft', label: ui.craftArmed ? '确认合成？' : '一键合成',
      sub: `3 件${QUALITY_NAME[craft.quality]}${EQUIP_SLOTS[craft.slot].name} → 1 件${QUALITY_NAME[NEXT_QUALITY[craft.quality]]}`,
      x: 20, y: rowY, w: 300, h: 44, danger: !!ui.craftArmed,
      action: { type: 'craft', slot: craft.slot, quality: craft.quality },
    });
    rows.push({ id: 'close', label: '关闭', x: 334, y: rowY, w: 300, h: 44, action: { type: 'close' } });
  } else {
    rows.push({ id: 'close', label: '关闭', x: 20, y: rowY, w: 614, h: 44, action: { type: 'close' } });
  }
  return {
    kind: 'bag',
    title: `背包 · ${m.inventory?.length ?? 0} 件（显示最近 ${Math.min(6, shown.length)} 件）`,
    hint: craft ? '' : '攒够 3 件同部位同品质即可一键合成',
    box: { x: 12, y: 62, w: 643, h: rowY + 44 + 12 - 62 },
    rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}

/** 物品详情（§5.4 的三个动作：穿上 / 强化 / 出售）——与浏览器版 `actionsRow` 同一套动作 */
export function layoutItem(m, ui = {}) {
  const uid = ui.itemUid;
  const inBag = (m.inventory ?? []).find((x) => x.uid === uid) ?? null;
  const it = inBag ?? Object.values(m.equipped ?? {}).find((x) => x?.uid === uid) ?? null;
  if (!it) return null;
  const rows = [];
  if (inBag) {
    rows.push({
      id: 'equip', label: '穿上', sub: '', x: 20, y: 96, w: 614, h: 44,
      action: { type: 'equip', uid },
    });
  }
  const cost = enhanceCostOf(it);
  // 返还比例与「紫装以上多给木材」都取内核那两个常数（§5.4），别在这里手写一份
  const refund = Math.floor((it.invested ?? 0) * EQUIP_SELL_REFUND);
  const bonus = QUALITY_ORDER.indexOf(it.quality) >= QUALITY_ORDER.indexOf('purple')
    ? ` + ${EQUIP_SELL_BONUS_LUMBER} 木` : '';
  rows.push({
    id: 'enhance', label: cost == null ? '强化已满级' : `强化 +${(it.plus ?? 0) + 1}`,
    sub: cost == null ? '' : `${cost} 金`,
    x: 20, y: inBag ? 146 : 96, w: 300, h: 44, disabled: cost == null || m.gold < cost,
    action: { type: 'enhance', uid },
  });
  rows.push({
    id: 'sell', label: ui.sellArmed ? '确认出售' : '出售', sub: `返还 ${refund} 金${bonus}`,
    x: 334, y: inBag ? 146 : 96, w: 300, h: 44, danger: !!ui.sellArmed,
    action: { type: 'sellItem', uid },
  });
  rows.push({ id: 'close', label: '关闭', x: 20, y: inBag ? 196 : 146, w: 614, h: 44, action: { type: 'close' } });
  const closeBox = inBag ? 196 : 146;
  return {
    kind: 'item',
    title: itemLabel(it),
    hint: `词条 ${(it.affixes ?? []).length}`,
    box: { x: 12, y: 62, w: 643, h: closeBox + 44 + 12 - 62 },
    rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}

/** 弹层上的命中测试（弹层开着时，触点先问它） */
export function hitTestSheet(sheet, x, y) {
  if (!sheet) return null;
  for (const r of sheet.rows) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.action;
  }
  return { type: 'close' };   // 点弹层空白处 = 关掉（比"必须点准关闭"友好）
}

/** 画弹层 */
export function drawSheet(ctx, sheet) {
  if (!sheet) return;
  const b = sheet.box;
  ctx.fillStyle = 'rgba(6,10,18,0.94)';
  roundRect(ctx, b.x, b.y, b.w, b.h, 12);
  ctx.fill();
  ctx.strokeStyle = COLORS.panelLine;
  ctx.lineWidth = 1;
  ctx.stroke();
  text(ctx, sheet.title, b.x + 12, b.y + 18, { size: 13, weight: 'bold' });
  if (sheet.hint) text(ctx, sheet.hint, b.x + b.w - 12, b.y + 18, { size: 11, color: COLORS.dim, align: 'right' });
  for (const r of sheet.rows) {
    ctx.fillStyle = r.on ? 'rgba(90,169,230,0.24)' : (r.danger ? 'rgba(209,80,63,0.28)' : 'rgba(18,28,44,0.92)');
    roundRect(ctx, r.x, r.y, r.w, r.h, 8);
    ctx.fill();
    ctx.strokeStyle = r.on ? COLORS.accent : (r.danger ? COLORS.danger : COLORS.panelLine);
    ctx.lineWidth = r.on || r.danger ? 2 : 1;
    ctx.stroke();
    const dim = r.disabled ? COLORS.dim : (r.danger ? COLORS.danger : COLORS.ink);
    if (r.sub) {
      text(ctx, r.label, r.x + 12, r.y + r.h / 2, { size: 13, color: dim });
      text(ctx, r.sub, r.x + r.w - 12, r.y + r.h / 2, { size: 11, color: r.disabled ? COLORS.dim : COLORS.gold, align: 'right' });
    } else {
      text(ctx, r.label, r.x + r.w / 2, r.y + r.h / 2, { size: 13, color: dim, align: 'center' });
    }
  }
}
