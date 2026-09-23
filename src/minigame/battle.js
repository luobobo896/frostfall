// 小游戏战场那一屏（移植第 3 步的第二屏）：**战场用现成的 render.js，外面这一圈 HUD 用 Canvas 重画**。
//
// 与 lobby.js 同一套写法（布局 / 绘制 / 命中 / 状态四件套，纯函数、零 DOM），
// 区别是战场那边直接复用浏览器版已经验过的等距渲染：`createRenderer(canvas, { size })`。
//
// 这一屏的交互是**简化版**：点塔位 = 用当前选中的塔种建塔（已有塔则升级），点「开波」提前开波，
// 点技能键放技能，点「回大厅」退回去。浏览器版那一套「点塔位 → 轮盘选塔 → 塔面板（升级/出售/优先级）」
// 还没搬过来——真机手感确认之后再决定照搬还是换成更适合拇指的两步式（见 docs/minigame-port.md §5.2）。
import { TOWERS } from '../data.js';

export const DESIGN = { w: 667, h: 375 };
/** 右上角胶囊按钮的禁区（和 lobby 同一条要求） */
export const CAPSULE = { w: 96, h: 32 };
export const TOWER_ORDER = ['tw_arrow', 'tw_cannon', 'tw_frost', 'tw_static'];

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
  TOWER_ORDER.forEach((id, i) => {
    items.push(item(`tower-${id}`, 12 + i * 62, 315, 58, 48, TOWERS[id].name.replace('塔', ''),
      { type: 'tower', value: id },
      { on: (model.selectedTower ?? 'tw_arrow') === id, cost: TOWERS[id].cost }));
  });
  items.push(model.result
    ? item('restart', 276, 315, 92, 48, '再开一局', { type: 'restart' })
    : item('early', 276, 315, 92, 48, '开波', { type: 'early' }, { disabled: !model.canEarly }));
  for (let i = 0; i < 2; i += 1) {
    items.push(item(`skill-${i}`, 376 + i * 62, 315, 58, 48, i === 0 ? '技能 1' : '技能 2',
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
    const isTower = it.id.startsWith('tower-');
    text(ctx, it.label, it.x + it.w / 2, it.y + (isTower ? 16 : 24), {
      size: isTower ? 11 : 13, align: 'center', color: it.disabled ? COLORS.dim : COLORS.ink,
      weight: isTower ? '' : 'bold',
    });
    if (isTower) {
      const afford = m.gold >= it.cost;
      text(ctx, `${it.cost} 金`, it.x + it.w / 2, it.y + 34, {
        size: 10, align: 'center', color: afford ? COLORS.gold : COLORS.danger,
      });
    }
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
