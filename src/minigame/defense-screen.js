// 小游戏防守那一屏（§12.5 / §2.6）：**战场复用 render.js 的 drawDefense，外面这圈是 Canvas 重画的**。
//
// 与 TD 那屏的三处不同，正是防守模式的三条设计约束：
//   ① 相机**跟着人物**走（`drawDefense` 自己 setCamera，我们只把 `scale` 传进去）；
//   ② 操作是**虚拟摇杆**（§1.9.1：固定左下 45%，可切浮动跟手）而不是点选建造；
//   ③ HUD 换成轮次 / 城堡血 / 预警倒计时（TD 那套波次条在这里没有意义，§115 的口径）。
// 这一层仍然是纯函数四件套（布局 / 绘制 / 命中 / 摇杆向量），所以能在 Node 里测、也能出样张。
import { FORTS } from '../data.js';
import { skillKeys } from './battle.js';
import { zoneLabel } from '../hud-model.js';
import { zoneAt } from '../defense.js';

export const DESIGN = { w: 667, h: 375 };
export const CAPSULE = { w: 96, h: 32 };
/**
 * §2.6 / §14.3 稿 5 的小地图：**跟随相机下唯一的全局视图**（我在哪、怪从哪来、基地还剩多少），
 * 点它回城（与「回城」按钮共用 30 秒冷却）。位置挑在右侧那排按钮的左边、倍速/暂停下面那块空地。
 */
export const MINIMAP = { x: 405, y: 60, w: 150, h: 112 };
/**
 * 技能/复活那一排（§1.9.1 的「右下技能」）：底部中间偏右，手指够得着、又不压摇杆。
 * 76×48、间距 24（§1.9.2 的热区与按钮间距下限），三个技能正好 260..536。
 */
export const SKILL_BAR = { x: 260, y: 315, w: 76, h: 48, gap: 24 };
/** §7.6 快速复活的价格（与内核 `reviveNow` 同一个数） */
export const REVIVE_LUMBER = 50;
export const STICK = {
  radius: 64,        // 摇杆推满的半径（§1.9.1 的 60-72pt，取中）
  deadZone: 0.25,    // 死区：小于它算没推（与 defense.js 的 steerGoal 门槛同源）
  zoneW: 0.45,       // 固定模式下有效区 = 左半屏的 45%（§1.9.1、§10.1）
  floatW: 0.5,       // 浮动模式下有效区 = 左半屏（§1.9.2：底座跟手，所以放宽到一半）
  lowerY: 0.45,      // 两种模式都只吃下半屏（上半屏是地图与 HUD）
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

/** 这一下该归摇杆还是归 HUD：左下那片有效区且不在 HUD 按钮上算摇杆（§1.9.1 / §1.9.2 的有效区） */
export function inStickZone(L, x, y, floating = false) {
  if (y < L.h * STICK.lowerY) return false;
  if (x > L.w * (floating ? STICK.floatW : STICK.zoneW)) return false;
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
  /**
   * §131 / §190：守住 4 轮之后转**无尽**（城堡剩余血量排行，§12.5）。结算面板弹出来时，
   * 那一局其实还在跑（内核只是 `m.over` 之后不再推进）——所以这时要有一个「继续（无尽）」的出口，
   * 不然玩家只能眼睁睁看面板、无尽根本玩不到。放在底排（防守本来没有底排），
   * 它在摇杆区里但摇杆的 `inStickZone` 会跳过 HUD 键（下面那一条同一处代码）。
   */
  if (model.endlessExit) {
    items.push(item('endless', 20, 315, 200, 48, '继续（无尽）', { type: 'endless' }));
  }
  /**
   * 小地图那一格：**键本身不画东西**（label 是空串，底下那层面板底会被小地图盖住），
   * 它只负责两件事——命中测试（点它 = 回城，与「回城」按钮同一个动作）与给绘制层一个矩形。
   */
  items.push(item('minimap', MINIMAP.x, MINIMAP.y, MINIMAP.w, MINIMAP.h, '',
    { type: 'teleport' }, { disabled: m.hero?.teleportCd > 0 || m.hero?.dead }));
  /**
   * §1.9.1 的「右下技能」：防守的主操作是摇杆，但英雄的主动技照样要能放（浏览器版底部右侧那一排）。
   * 小游戏这一屏以前**一颗技能键都没有**——于是防守局里技能是死的（买了技能书更看不出区别）。
   * 阵亡时换成一颗「快速复活 · 50 木」（§7.6）：那时本来也放不了技能，而复活是唯一想做的事。
   */
  if (m.hero?.dead) {
    const wood = m.lumber?.[0] ?? 0;
    items.push(item('revive', SKILL_BAR.x, SKILL_BAR.y, SKILL_BAR.w * 3 + SKILL_BAR.gap * 2, SKILL_BAR.h,
      `快速复活 · ${REVIVE_LUMBER} 木`, { type: 'revive' }, { disabled: wood < REVIVE_LUMBER }));
  } else {
    skillKeys(m).forEach((sk, i) => {
      items.push(item(`skill-${i}`, SKILL_BAR.x + i * (SKILL_BAR.w + SKILL_BAR.gap), SKILL_BAR.y, SKILL_BAR.w, SKILL_BAR.h,
        sk.name ?? `技能 ${i + 1}`, { type: 'skill', index: i },
        { disabled: !!sk.locked || sk.cd > 0, sub: sk.cd > 0 ? `${Math.ceil(sk.cd)}s` : (sk.lv ? `Lv${sk.lv}` : '') }));
    });
  }
  return {
    w: DESIGN.w, h: DESIGN.h,
    capsule: { x: DESIGN.w - CAPSULE.w - 8, y: 6, w: CAPSULE.w, h: CAPSULE.h },
    top: { x: 12, y: 8, w: 356, h: 30 },
    minimap: MINIMAP,
    // 英雄那一格（等级 / 阵亡倒计时）：顶栏已经挤满（轮次 + 预警 + 金 + 木 + 城堡），
    // 所以它写在顶栏下面那一行的左边——右边留给小地图（405 起）
    heroLine: { x: 22, y: 48 },
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
   * 英雄那一格（§14.3 稿 6 的英雄面板压缩成一行）：等级 + 状态。
   *
   * 状态与浏览器版**同一套**（`ui.js` 那三行）：**阵亡写倒计时**（玩家最想知道的就是还有几秒回来）、
   * 否则人在野外区里就报「区名 + 等级段 + 掉落加成」（§2.6 / §12.8：这也是那三个字段的读取方），
   * 没进区才回落到「移动中 / 待命」。写在顶栏下面那一行：顶栏里轮次 + 预警 + 金 + 木 + 城堡已经占满，
   * 硬塞会跟「城堡 x/y」叠字（第一版就是这么叠上去的，样张里看得见）。
   */
  const dead = !!m.hero?.dead;
  const state = dead ? `阵亡 ${Math.ceil(m.hero.reviveTimer ?? 0)}s`
    : (zoneLabel(zoneAt(m.def, m.hero?.cell)) || (m.hero?.moving ? '移动中' : '待命'));
  text(ctx, `英雄 Lv${m.hero?.level ?? 1} · ${state}`, L.heroLine.x, L.heroLine.y,
    { size: 11, color: dead ? COLORS.danger : COLORS.dim });
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
    // 有副标就两行写（技能键的「名字 + Lv/冷却秒数」），没有副标的键与以前一模一样
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    text(ctx, it.label, cx, it.sub ? cy - 9 : cy, {
      size: it.label.length > 6 ? 11 : 12, align: 'center',
      color: it.disabled ? COLORS.dim : COLORS.ink, weight: 'bold',
    });
    if (it.sub) text(ctx, it.sub, cx, cy + 11, { size: 10, align: 'center', color: COLORS.dim });
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
  /**
   * 提示那一行写在**底部中间**（y=300）：上半屏那条中线被两样东西占着——`drawDefense` 自己画的
   * 「城堡 x/y + 血条」（城堡多半就在屏幕中上部）与小地图（y=60 起）。以前写在这两者中间，
   * 样张里一眼就能看见半句话被切掉。底部这一带是空的（右排按钮在 x=579 往右，工事/回城都不在这）。
   */
  if (message) text(ctx, message, L.w / 2, 300, { size: 12, align: 'center', color: COLORS.gold });
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
