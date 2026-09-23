// 小游戏防守那一屏（§12.5 / §2.6）：**战场复用 render.js 的 drawDefense，外面这圈是 Canvas 重画的**。
//
// 与 TD 那屏的三处不同，正是防守模式的三条设计约束：
//   ① 相机**跟着人物**走（`drawDefense` 自己 setCamera，我们只把 `scale` 传进去）；
//   ② 操作是**虚拟摇杆**（§1.9.1：固定左下 45%，可切浮动跟手）而不是点选建造；
//   ③ HUD 换成轮次 / 城堡血 / 预警倒计时（TD 那套波次条在这里没有意义，§115 的口径）。
// 这一层仍然是纯函数四件套（布局 / 绘制 / 命中 / 摇杆向量），所以能在 Node 里测、也能出样张。
import { FORTS } from '../data.js';

export const DESIGN = { w: 667, h: 375 };
export const CAPSULE = { w: 96, h: 32 };
export const STICK = {
  radius: 64,        // 摇杆推满的半径（§1.9.1 的 60-72pt，取中）
  deadZone: 0.25,    // 死区：小于它算没推（与 defense.js 的 steerGoal 门槛同源）
  zoneW: 0.45,       // 固定模式下有效区 = 左半屏的 45%（§1.9.1、§10.1）
};

const COLORS = {
  panel: 'rgba(12, 20, 34, 0.86)',
  panelLine: 'rgba(120, 170, 230, 0.25)',
  ink: '#e8eef7',
  dim: '#93a4bd',
  accent: '#5aa9e6',
  gold: '#e8c15a',
  wood: '#7fc08a',
  danger: '#d1503f',
  stick: 'rgba(90,169,230,0.22)',
  stickLine: 'rgba(150,200,255,0.45)',
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

/** 摇杆底座位置：固定模式钉在左下角；浮动模式跟手指（`stick.origin`） */
export function stickBase(model = {}, size = DESIGN) {
  const radius = STICK.radius;
  const origin = model.stickOrigin ?? { x: Math.round(size.w * 0.16), y: Math.round(size.h * 0.78) };
  return { x: origin.x, y: origin.y, r: radius, floating: !!model.stickFloating };
}

/** 这一下该归摇杆还是归 HUD：左侧 45% 且不在 HUD 按钮上算摇杆（§1.9.1 的有效区） */
export function inStickZone(L, x, y) {
  if (x > L.w * STICK.zoneW) return false;
  for (const it of L.items) {
    if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return false;
  }
  return true;
}

/**
 * 触点 → 摇杆向量（纯数学，与 joystick.js 同一套规则）：
 * 死区内算没推；超出半径按半径夹紧；方向单位化后乘力度（0-1）。
 */
export function stickVector(base, x, y) {
  const dx = x - base.x, dy = y - base.y;
  const len = Math.hypot(dx, dy);
  if (!len) return { x: 0, y: 0, mag: 0 };
  const mag = Math.min(1, len / base.r);
  if (mag < STICK.deadZone) return { x: 0, y: 0, mag: 0 };
  return { x: dx / len, y: dy / len, mag };
}

/** 防守 HUD 的布局（设计单位 667×375；屏幕更宽时由调用方等比缩放，与另外两屏一致） */
export function layoutDefense(m, model = {}) {
  const items = [];
  // 顶栏右侧两个键（与 TD 那屏同一个位置约定：避开右上角胶囊区）
  items.push(item('speed', 380, 8, 84, 44, model.rate === 2 ? '倍速 2×' : '倍速 1×', { type: 'speed' }, { on: model.rate === 2 }));
  items.push(item('pause', 470, 8, 84, 44, model.paused ? '继续' : '暂停', { type: 'pause' }, { on: !!model.paused }));
  // 右侧竖排：回城 / 修城 / 工事 / 商店 / 背包 / 药品
  const col = 579;
  const rows = [
    ['teleport', '回城', { type: 'teleport' }, m.hero?.teleportCd > 0 || m.hero?.dead],
    ['repair', '修城', { type: 'repairCastle' }, m.castle.hp >= m.castle.maxHp],
    ['fort', '工事', { type: 'fort' }, false],
    ['shop', '商店', { type: 'shop' }, false],
    ['bag', `背包${(m.inventory?.length ?? 0) ? `(${m.inventory.length})` : ''}`, { type: 'bag' }, false],
    ['potion', `药品 ${model.potionCount ?? 0}/3`, { type: 'potion' }, !model.potionCount],
  ];
  rows.forEach(([id, label, action, disabled], i) => {
    items.push(item(id, col, 60 + i * 52, 80, 44, label, action, { disabled: !!disabled, small: true }));
  });
  return {
    w: DESIGN.w, h: DESIGN.h,
    capsule: { x: DESIGN.w - CAPSULE.w - 8, y: 6, w: CAPSULE.w, h: CAPSULE.h },
    top: { x: 12, y: 8, w: 356, h: 30 },
    items,
    byId: Object.fromEntries(items.map((it) => [it.id, it])),
    stick: stickBase(model),
  };
}

/** HUD 的命中测试（摇杆归 `inStickZone`，两边不重叠） */
export function hitTestDefense(L, x, y) {
  for (const it of L.items) {
    if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return it.action;
  }
  return null;
}

/** 画 HUD：轮次 / 城堡血 / 资源 / 预警 + 右侧那排键 + 摇杆底座 */
export function drawDefenseHud(ctx, m, L, { message = null, stick = null } = {}) {
  const castlePct = m.castle.hp / m.castle.maxHp;
  ctx.fillStyle = COLORS.panel;
  roundRect(ctx, L.top.x, L.top.y, L.top.w, L.top.h, 8);
  ctx.fill();
  ctx.strokeStyle = COLORS.panelLine;
  ctx.lineWidth = 1;
  ctx.stroke();
  const warn = m.assault?.warning ? `⚠ ${Math.max(0, Math.ceil(m.assault.timer))}s 后抵达` : '暂无预警';
  text(ctx, `第 ${m.assault.round} 轮`, L.top.x + 10, L.top.y + 15, { size: 13, weight: 'bold' });
  text(ctx, warn, L.top.x + 78, L.top.y + 15, { size: 11, color: m.assault?.warning ? COLORS.danger : COLORS.dim });
  text(ctx, `金 ${Math.round(m.gold)}`, L.top.x + 156, L.top.y + 15, { size: 12, color: COLORS.gold });
  text(ctx, `木 ${Math.round(m.lumber?.[0] ?? 0)}`, L.top.x + 210, L.top.y + 15, { size: 12, color: COLORS.wood });
  /**
   * 城堡血量**只写在顶栏这一行里**，不再单独占一条：`render.js` 的 drawDefense 本来就会在城堡上方
   * 画「城堡 x/y + 血条」，而相机跟人时城堡多半就在屏幕中上部——单独占一行会跟那条**正好叠在一起**
   * （样张里一眼可见）。顶栏这一行则是固定的，人跑多远都看得见。
   */
  text(ctx, `城堡 ${Math.round(m.castle.hp)}/${m.castle.maxHp}`, L.top.x + L.top.w - 10, L.top.y + 15,
    { size: 11, align: 'right', color: castlePct < 0.35 ? COLORS.danger : COLORS.ink });

  for (const it of L.items) {
    const on = !!it.on;
    ctx.fillStyle = on ? 'rgba(90,169,230,0.24)' : COLORS.panel;
    roundRect(ctx, it.x, it.y, it.w, it.h, 8);
    ctx.fill();
    ctx.strokeStyle = on ? COLORS.accent : COLORS.panelLine;
    ctx.lineWidth = on ? 2 : 1;
    ctx.stroke();
    text(ctx, it.label, it.x + it.w / 2, it.y + it.h / 2, {
      size: it.label.length > 6 ? 11 : 12, align: 'center',
      color: it.disabled ? COLORS.dim : COLORS.ink, weight: 'bold',
    });
  }

  // 摇杆：底座 + 推杆（浮动模式底座就在手指落点，所以位置由调用方给）
  if (stick) {
    ctx.fillStyle = COLORS.stick;
    ctx.beginPath();
    ctx.arc(stick.base.x, stick.base.y, stick.base.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.stickLine;
    ctx.lineWidth = 2;
    ctx.stroke();
    const kx = stick.base.x + (stick.dir.x * stick.dir.mag) * stick.base.r * 0.72;
    const ky = stick.base.y + (stick.dir.y * stick.dir.mag) * stick.base.r * 0.72;
    ctx.fillStyle = 'rgba(190,225,255,0.85)';
    ctx.beginPath();
    ctx.arc(kx, ky, 26, 0, Math.PI * 2);
    ctx.fill();
  }
  if (message) text(ctx, message, L.w / 2, 66, { size: 12, align: 'center', color: COLORS.gold });
  return L;
}

/** 工事建造面板（防守只有两种工事，§12.5） */
export function layoutFortSheet(m, model = {}) {
  const rows = [];
  Object.values(FORTS).forEach((f, i) => {
    rows.push({
      id: `fort-${f.id}`, label: f.name, sub: `${f.cost} 金`,
      x: 20, y: 96, w: 614, h: 44, disabled: m.gold < f.cost,
      action: { type: 'buildFort', fortId: f.id },
    });
  });
  rows.push({ id: 'cancel', label: '取消', x: 20, y: 96 + Object.keys(FORTS).length * 50, w: 614, h: 44, action: { type: 'close' } });
  return {
    kind: 'fort',
    title: `建工事 · 金币 ${Math.round(m.gold)} · 空位 ${model.freeSlots ?? 0}`,
    hint: '点战场上的工事位（“修”字）即可放',
    box: { x: 12, y: 62, w: 643, h: 96 + Object.keys(FORTS).length * 50 + 44 - 62 + 12 },
    rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}
