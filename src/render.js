// 等距 2:1 渲染（§14.1）。全部是占位图：色块 + 文字标签（§14.6），接口与正式资源一致。

import { DEFENSE_MAPS, GRID, MAPS, MONSTERS, QUALITY, TEAM_COLORS, TOWERS } from './data.js';
import { buildMap, heroPos, posAt, project } from './core.js';
import { heroMaxHp } from './match.js';
import { isLowHp } from './hud-model.js';
import { viewport } from './platform.js';   // §平台适配：像素比在两个环境里的取法不同

const COLORS = {
  bg: '#070c14',
  tileA: '#16243a',
  tileB: '#131f31',
  path: '#3d4a5c',
  swamp: '#1d3a2c',
  core: '#7fd4ff',
  tower: { tw_arrow: '#dbe6f2', tw_cannon: '#e0a15c', tw_frost: '#79c8ee', tw_static: '#b98ce6' },
  hero: '#8ee08a',
  mob: { normal: '#c9d6e6', elite: '#e8a33d', boss: '#d1503f' },
  air: '#9ad8ff',
};

/**
 * §116：新手引导的塔位高亮透明度。`pulses:false`（低特效档）时**不再随时间变化**——
 * 设置面板对玩家的原话是「低特效档会关掉伤害飘字与塔位脉冲」，飘字那半早就生效了，
 * 脉冲这半一直没人读 `renderOptions().showPulses`，于是低特效下它照样闪。
 * 抽成纯函数是为了能直接断「两个时刻的取值一样 / 不一样」，不必去读 canvas 像素。
 */
export const hintPulseAlpha = (now, pulses = true) => (pulses ? 0.35 + 0.35 * Math.sin(now * 4) : 0.7);

export function createRenderer(canvas, { size = null } = {}) {
  const ctx = canvas.getContext('2d');
  let view = { scale: 1, ox: 0, oy: 0, w: 0, h: 0 };
  let sized = '';   // 「画布尺寸 + 地图尺寸」指纹：没变就不要重算，否则每帧都会把玩家的视角弹回去

  function sizeCanvas() {
    const dpr = Math.min(2, viewport().dpr || 1);   // §平台适配：小游戏没有 window，用 wx.getWindowInfo
    /**
     * §平台适配（小游戏移植）：小游戏的 canvas **没有 `clientWidth/clientHeight`**（那不是 DOM），
     * 所以允许调用方传一个 `size()` 告诉渲染器画布的逻辑尺寸；浏览器不传，行为与以前完全一致。
     */
    const measured = size ? size() : null;
    const w = measured ? measured.w : canvas.clientWidth;
    const h = measured ? measured.h : canvas.clientHeight;
    const pw = Math.floor(w * dpr), ph = Math.floor(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    view.w = w; view.h = h;
  }

  /** 地图在投影平面上的包围盒（`fitTo` 与 `clampView` 共用一份，别各算一套）。 */
  function mapBounds(grid = GRID) {
    const halfW = GRID.tileW / 2, halfH = GRID.tileH / 2;
    return {
      minX: -(grid.h - 1) * halfW - halfW,
      maxX: (grid.w - 1) * halfW + halfW,
      minY: -halfH,
      maxY: ((grid.w - 1) + (grid.h - 1)) * halfH + halfH,
    };
  }

  /** 整图可见（§2.5 的 0.74×）：按地图包围盒算缩放并把整图居中。 */
  function fitTo(grid) {
    const { minX, maxX, minY, maxY } = mapBounds(grid);
    const scale = Math.min(view.w / (maxX - minX), view.h / (maxY - minY)) * 0.98;
    view.scale = scale;
    view.ox = view.w / 2 - ((minX + maxX) / 2) * scale;
    view.oy = view.h / 2 - ((minY + maxY) / 2) * scale;
  }

  /**
   * §143：拖动 / 缩放之后，**地图不许整个滑出屏幕**——至少留 72px 在视口里。
   * 以前 `panBy()` 是无限制的：手机上误拖两下就能把战场推出屏幕，玩家只看到一片空画布，
   * 而且没有任何提示（冒烟截图里就撞见过一次：拖了 180px 之后半屏是空的）。
   */
  function clampView() {
    const g = view.grid ?? GRID;
    // 用**四角投影出来的屏幕包围盒**（而不是 `mapBounds` 那套平面公式）：夹取要跟渲染/点击
    // 用的是同一个投影，差一点点就会「看着还在、判定已经出屏」（第一版就差了 20 多像素）。
    const corners = [[0, 0], [g.w - 1, 0], [0, g.h - 1], [g.w - 1, g.h - 1]].map(([x, y]) => toScreen(x, y));
    const left = Math.min(...corners.map((p) => p.x));
    const right = Math.max(...corners.map((p) => p.x));
    const top = Math.min(...corners.map((p) => p.y));
    const bottom = Math.max(...corners.map((p) => p.y));
    const keep = 72;
    if (right < keep) view.ox += keep - right;
    if (left > view.w - keep) view.ox -= left - (view.w - keep);
    if (bottom < keep) view.oy += keep - bottom;
    if (top > view.h - keep) view.oy -= top - (view.h - keep);
  }

  /** 画布/地图尺寸变了才重算相机（draw 每帧都会调，所以这里必须幂等）。 */
  function resize(grid = GRID) {
    sizeCanvas();
    view.grid = { w: grid.w, h: grid.h };
    const key = `${view.w}x${view.h}x${grid.w}x${grid.h}`;
    if (key === sized) return;
    sized = key;
    fitTo(grid);
  }

  /** 强制回到整图可见（设置里「TD 整图可见」、切图、切模式时用）。 */
  function fit(grid = GRID) {
    sizeCanvas();
    view.grid = { w: grid.w, h: grid.h };
    sized = `${view.w}x${view.h}x${grid.w}x${grid.h}`;
    fitTo(grid);
    clampView();
  }

  const toScreen = (gx, gy, z = 0) => {
    const p = project(gx, gy, z);
    return { x: view.ox + p.x * view.scale, y: view.oy + p.y * view.scale };
  };

  /** 跟随相机：把某个格子放到屏幕中心（防守模式用）。 */
  function setCamera(gx, gy, scale = 1.5) {
    const p = project(gx, gy);
    view.scale = scale;
    view.ox = view.w / 2 - p.x * scale;
    view.oy = view.h / 2 - p.y * scale;
  }

  /** 单指拖空白处平移（§1.9）：按屏幕像素位移移动相机。 */
  function panBy(dx, dy) { view.ox += dx; view.oy += dy; clampView(); }

  /** 缩放并保持某个屏幕点不动（滚轮 / 双指放大到 1.0× 看局部，§2.5）。 */
  function zoomAt(scale, sx, sy) {
    const g = toGrid(sx, sy);          // 必须先按旧缩放反投影，再改 scale
    const p = project(g.x, g.y);
    view.scale = scale;
    view.ox = sx - p.x * scale;
    view.oy = sy - p.y * scale;
    clampView();
  }

  /**
   * 视口裁剪（§10.1 把「视口裁剪」列为防守模式的必需品）：
   * 把屏幕四角反投影回格坐标，得到一个带余量的格子包围盒，只画盒内的东西。
   */
  function visibleGrid(gridW = GRID.w, gridH = GRID.h) {
    const corners = [[0, 0], [view.w, 0], [0, view.h], [view.w, view.h]].map(([sx, sy]) => toGrid(sx, sy));
    const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
    const pad = 3;
    return {
      x0: Math.max(0, Math.min(...xs) - pad), x1: Math.min(gridW - 1, Math.max(...xs) + pad),
      y0: Math.max(0, Math.min(...ys) - pad), y1: Math.min(gridH - 1, Math.max(...ys) + pad),
    };
  }

  /** 画一个格坐标矩形（等距四边形），用来标野外区与营地范围。 */
  function drawGridRect(r, fill, stroke) {
    const hw = (GRID.tileW / 2) * view.scale, hh = (GRID.tileH / 2) * view.scale;
    const top = toScreen(r.x, r.y);
    const right = toScreen(r.x + r.w - 1, r.y);
    const bottom = toScreen(r.x + r.w - 1, r.y + r.h - 1);
    const left = toScreen(r.x, r.y + r.h - 1);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y - hh);
    ctx.lineTo(right.x + hw, right.y);
    ctx.lineTo(bottom.x, bottom.y + hh);
    ctx.lineTo(left.x - hw, left.y);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  }

  /** 屏幕点 → 最近格坐标（§2.5：取最近塔位，不要求点得准）。 */
  function toGrid(sx, sy) {
    const x = (sx - view.ox) / view.scale;
    const y = (sy - view.oy) / view.scale;
    const gx = (x / (GRID.tileW / 2) + y / (GRID.tileH / 2)) / 2;
    const gy = (y / (GRID.tileH / 2) - x / (GRID.tileW / 2)) / 2;
    return { x: Math.round(gx), y: Math.round(gy) };
  }

  function tilePath(gx, gy) {
    const c = toScreen(gx, gy);
    const w = (GRID.tileW / 2) * view.scale, h = (GRID.tileH / 2) * view.scale;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y - h);
    ctx.lineTo(c.x + w, c.y);
    ctx.lineTo(c.x, c.y + h);
    ctx.lineTo(c.x - w, c.y);
    ctx.closePath();
  }

  function label(text, x, y, color = '#e8eef7', size = 11, align = 'center') {
    ctx.font = `${size}px "PingFang SC", system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  function bar(x, y, w, h, pct, color) {
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(x - w / 2, y, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x - w / 2, y, w * Math.max(0, Math.min(1, pct)), h);
  }

  function drawTiles(m) {
    const g = m.map?.grid ?? GRID;
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        const onPath = m.map.blocked.has(`${x},${y}`);
        const swamp = m.map.swamp.has(`${x},${y}`);
        const lava = m.map.lava?.has(`${x},${y}`);
        const c = toScreen(x, y);
        tilePath(x, y);
        ctx.fillStyle = lava ? '#5a2b1f' : onPath ? COLORS.path : swamp ? COLORS.swamp : ((x + y) % 2 ? COLORS.tileA : COLORS.tileB);
        ctx.fill();
        ctx.strokeStyle = 'rgba(90,140,200,.10)';
        ctx.stroke();
        if (onPath && (x + y) % 3 === 0) label('·', c.x, c.y, 'rgba(200,220,240,.25)', 14);
      }
    }
  }

  function drawSlots(m, selectedSlot) {
    m.map.slots.forEach((s, i) => {
      const occupied = m.towers.some((t) => t.slot === i);
      const c = toScreen(s.x, s.y);
      tilePath(s.x, s.y);
      if (occupied) {
        if (selectedSlot === i) { ctx.strokeStyle = '#8ee08a'; ctx.lineWidth = 2.5; ctx.stroke(); ctx.lineWidth = 1; }
        return;
      }
      ctx.fillStyle = 'rgba(90,169,230,.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(140,200,255,.45)';
      ctx.stroke();
      label('+', c.x, c.y - 2 * view.scale, 'rgba(180,220,255,.7)', Math.max(9, 13 * view.scale));
    });
  }

  /** 引导高亮：前 N 个空塔位脉冲发光，告诉新手「点这里」（§14.3 稿 11）。 */
  function drawHintSlots(m, count, now, pulses = true) {
    if (!count) return;
    const pulse = hintPulseAlpha(now, pulses);
    let shown = 0;
    for (let i = 0; i < m.map.slots.length && shown < count; i++) {
      if (m.towers.some((t) => t.slot === i)) continue;
      const s = m.map.slots[i];
      const c = toScreen(s.x, s.y);
      tilePath(s.x, s.y);
      ctx.strokeStyle = `rgba(255, 214, 130, ${pulse.toFixed(2)})`;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.lineWidth = 1;
      label('建这里', c.x, c.y - 14 * view.scale, '#ffd68a', Math.max(10, 12 * view.scale));
      shown += 1;
    }
  }

  function drawCore(m) {
    // 双守护目标（map_06）：两个核心都画，任一被破即失败
    const cores = m.cores?.length ? m.cores : [m.core];
    cores.forEach((core, i) => {
      const c = toScreen(core.cell.x, core.cell.y, 1.4);
      const r = 22 * view.scale + 8;
      ctx.save();
      ctx.shadowColor = 'rgba(127,212,255,.7)';
      ctx.shadowBlur = 18;
      ctx.fillStyle = COLORS.core;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y - r); ctx.lineTo(c.x + r * 0.6, c.y); ctx.lineTo(c.x, c.y + r); ctx.lineTo(c.x - r * 0.6, c.y);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      bar(c.x, c.y + r + 2, 60 * view.scale + 16, 5, core.hp / core.maxHp, '#63d0ff');
      label(cores.length > 1 ? `核心 ${i + 1}` : '寒冰核心', c.x, c.y + r + 16, '#bfe6ff', 11);
    });
  }

  function drawTower(m, t, selected, localSlot) {
    const c = toScreen(t.cell.x, t.cell.y, 0.9);
    const color = COLORS.tower[t.towerId] ?? '#dbe6f2';
    const size = (16 + t.level * 3) * view.scale + 7;
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath(); ctx.ellipse(c.x, c.y + size * 0.5, size * 0.9, size * 0.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y - size); ctx.lineTo(c.x + size * 0.8, c.y); ctx.lineTo(c.x, c.y + size * 0.6);
    ctx.lineTo(c.x - size * 0.8, c.y); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = selected ? '#8ee08a' : 'rgba(10,20,30,.6)';
    ctx.lineWidth = selected ? 2.5 : 1;
    ctx.stroke();
    ctx.lineWidth = 1;
    label(`${t.level}`, c.x, c.y - size * 0.15, '#0b1420', 12);
    // 5★/6★ 图会被攻城怪拆：塔血不满时显示血条
    if (t.maxHp && t.hp < t.maxHp) {
      bar(c.x, c.y - size - 10, size * 1.8, 4, t.hp / t.maxHp, t.hp / t.maxHp < 0.35 ? '#d1503f' : '#8ee08a');
    }
    // 队伍色（§14.4）：底座按建造者上色，自己的塔一圈更粗——联机时一眼分得清谁的塔
    ctx.strokeStyle = TEAM_COLORS[(t.owner ?? 0) % TEAM_COLORS.length];
    ctx.lineWidth = (t.owner ?? 0) === localSlot ? 3 : 1.5;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y + size * 0.42, size * 0.92, size * 0.40, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    if (selected) {
      ctx.beginPath();
      ctx.ellipse(c.x, c.y + size * 0.5, t.stats.range * (GRID.tileW / 2) * view.scale, t.stats.range * (GRID.tileH / 2) * view.scale, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(142,224,138,.35)';
      ctx.stroke();
    }
  }

  function drawMonster(m, mo) {
    const z = mo.isAir ? 1.6 : 0;
    // §10.3：用亚格位置画（`dist` 是内核本来就有的连续量），逻辑判定仍走 mo.cell
    const p = monPos(m, mo);
    const c = toScreen(p.x, p.y, z);
    const tier = mo.def.tier;
    const r = (tier === 'boss' ? 18 : tier === 'elite' ? 13 : 9) * view.scale + 5;
    if (z) {
      const g = toScreen(p.x, p.y, 0);
      ctx.fillStyle = 'rgba(0,0,0,.30)';
      ctx.beginPath(); ctx.ellipse(g.x, g.y, r * 0.8, r * 0.35, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = mo.isAir ? COLORS.air : COLORS.mob[tier] ?? '#c9d6e6';
    ctx.beginPath(); ctx.ellipse(c.x, c.y, r, r * 0.82, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(8,14,22,.75)';
    ctx.stroke();
    bar(c.x, c.y - r - 8, r * 2.2, 4, mo.hp / mo.maxHp, tier === 'boss' ? '#d1503f' : '#8ee08a');
    if (mo.def.armorType === 'fortified') label('盾', c.x, c.y + r + 8, '#ffd08a', 10);
    if (mo.attacking) label('!', c.x + r, c.y - r, '#ffb4a0', 12);
  }

  /** 怪物的小数格位置：有 `pathIndex` + `dist`（TD 与防守的怪都有）就用亚格位置，否则退回整数格。 */
  const monPos = (m, mo) => (mo.pathIndex != null && Number.isFinite(mo.dist) && m.map.paths[mo.pathIndex])
    ? posAt(m.map.paths[mo.pathIndex], mo.dist) : mo.cell;

  function drawHero(m, localSlot) {
    const h = m.hero;
    // 人物同样按小数位置画：防守里 `carry` 就是「走向下一格的进度」（相机也用它，见 drawDefense）
    const hp = heroPos(h);
    const c = toScreen(hp.x, hp.y, 1.0);
    const r = 12 * view.scale + 6;
    ctx.fillStyle = h.dead ? '#5a6474' : (TEAM_COLORS[localSlot % TEAM_COLORS.length] ?? COLORS.hero);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 3 * i - Math.PI / 6;
      const px = c.x + Math.cos(a) * r, py = c.y + Math.sin(a) * r;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(8,14,22,.7)'; ctx.stroke();
    const max = Math.max(1, h.def.hp);
    bar(c.x, c.y - r - 8, r * 2.4, 4, h.hp / max, '#8ee08a');
    label(h.dead ? `复活 ${Math.ceil(h.reviveTimer)}s` : `Lv${h.level}`, c.x, c.y + r + 10, '#dff5dd', 11);
  }

  /** 伤害飘字：0.6 秒内上浮淡出（单机与联机同一套，数值来自两帧血量差）。 */
  function drawFloaters(list, now) {
    for (const f of list) {
      const life = Math.max(0, (f.until - now) / 0.6);
      if (life <= 0) continue;
      const c = toScreen(f.cell.x, f.cell.y, 1.4 + (1 - life) * 1.4);
      ctx.globalAlpha = Math.min(1, life * 1.6);
      label(f.text, c.x, c.y, f.kind === 'big' ? '#ffd08a' : '#ffe9c9', f.kind === 'big' ? 18 : 14);
      ctx.globalAlpha = 1;
    }
  }

  function drawProjectiles(m) {
    for (const p of m.projectiles) {
      const to = toScreen(p.target.cell?.x ?? m.map.core.x, p.target.cell?.y ?? m.map.core.y, 0.8);
      const x = p.from.x * 1 + (to.x - p.from.x) * 0 + 0; // from 已是本地 iso px，再转到屏幕
      const fromScreen = {
        x: view.ox + p.from.x * view.scale,
        y: view.oy + p.from.y * view.scale,
      };
      const t = Math.min(1, p.progress);
      const px = fromScreen.x + (to.x - fromScreen.x) * t;
      const py = fromScreen.y + (to.y - fromScreen.y) * t;
      ctx.strokeStyle = p.stats.attackType === 'siege' ? '#e0a15c' : '#dbe6f2';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px - 5, py - 3);
      ctx.lineTo(px + 5, py + 3);
      ctx.stroke();
      ctx.lineWidth = 1;
      void x;
    }
  }

  function draw(isoView) {
    if (isoView.m?.mode === 'defense') return drawDefense(isoView);
    const { m, selectedSlot, selectedTower, floaters = [], pending = [], hintSlots = 0, localSlot = 0, now = 0, pulses = true } = isoView;
    const grid = m.map?.grid ?? GRID;
    if (grid.w !== GRID.w || grid.h !== GRID.h) resize(grid);   // 4★ 起的大图按自己的尺寸适配镜头
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, view.w, view.h);
    drawTiles(m);
    drawSlots(m, selectedSlot);
    drawHintSlots(m, hintSlots, now, pulses);
    // 预测中的塔：半透明鬼影 + 省略号，等服务端快照确认后由真实塔替换（§10.3）
    for (const p of pending) {
      const cell = m.map.slots[p.slot];
      if (!cell) continue;
      const c = toScreen(cell.x, cell.y, 0.9);
      const size = 22 * view.scale + 7;
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = COLORS.tower[p.towerId] ?? '#dbe6f2';
      ctx.beginPath();
      ctx.moveTo(c.x, c.y - size); ctx.lineTo(c.x + size * 0.8, c.y); ctx.lineTo(c.x, c.y + size * 0.6);
      ctx.lineTo(c.x - size * 0.8, c.y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.globalAlpha = 1;
      label('…', c.x, c.y - size * 0.15, '#0b1420', 12);
    }
    drawCore(m);

    // 深度排序：tiles 之后，单位按 gx+gy（§14.1）
    const drawables = [
      ...m.towers.map((t) => ({ depth: t.cell.x + t.cell.y, draw: () => drawTower(m, t, selectedTower === t.slot, localSlot) })),
      ...m.monsters.map((mo) => {
        const p = monPos(m, mo);
        return { depth: p.x + p.y + (mo.isAir ? 4 : 0), draw: () => drawMonster(m, mo) };
      }),
      { depth: (() => { const p = heroPos(m.hero); return p.x + p.y + 0.5; })(), draw: () => drawHero(m, localSlot) },
    ].sort((a, b) => a.depth - b.depth);
    for (const d of drawables) d.draw();
    drawProjectiles(m);
    drawFloaters(floaters, now);
  }

  /* ---------- 防守模式：跟随相机 + 野外区 + 基地（§12.5 / §2.6） ---------- */

  function drawDefense(v) {
    const { m, floaters = [], now = 0, selectedFortSlot = null } = v;
    // 相机跟着**小数位置**走：只平滑人物、镜头还在一格一格跳，反而更扎眼（§10.3）
    const camP = heroPos(m.hero);
    setCamera(camP.x, camP.y, v.scale ?? 1.5);
    const bounds = visibleGrid(m.grid.w, m.grid.h);

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, view.w, view.h);

    // 野外区染色：一眼看出「这片能刷怪」
    for (const z of m.def.zones) {
      const hostile = z.lvMin >= 5;
      drawGridRect(z, hostile ? 'rgba(176,125,224,.10)' : 'rgba(142,224,138,.10)',
        hostile ? 'rgba(176,125,224,.35)' : 'rgba(142,224,138,.35)');
    }

    // 地面（只画视口内的格子）
    for (let y = bounds.y0; y <= bounds.y1; y++) {
      for (let x = bounds.x0; x <= bounds.x1; x++) {
        const c = toScreen(x, y);
        tilePath(x, y);
        ctx.fillStyle = (x + y) % 2 ? COLORS.tileA : COLORS.tileB;
        ctx.fill();
        ctx.strokeStyle = 'rgba(90,140,200,.08)';
        ctx.stroke();
        void c;
      }
    }

    // 基地围墙
    for (const k of m.walls) {
      const [x, y] = k.split(',').map(Number);
      if (x < bounds.x0 - 1 || x > bounds.x1 + 1 || y < bounds.y0 - 1 || y > bounds.y1 + 1) continue;
      const c = toScreen(x, y, 0.6);
      const s = 15 * view.scale + 5;
      ctx.fillStyle = '#5b6b80';
      ctx.beginPath();
      ctx.moveTo(c.x, c.y - s); ctx.lineTo(c.x + s * 0.8, c.y); ctx.lineTo(c.x, c.y + s * 0.6);
      ctx.lineTo(c.x - s * 0.8, c.y); ctx.closePath(); ctx.fill();
    }

    // 城堡
    const cc = toScreen(m.castle.cell.x, m.castle.cell.y, 1.4);
    const cr = 26 * view.scale + 8;
    ctx.save();
    ctx.shadowColor = 'rgba(127,212,255,.7)'; ctx.shadowBlur = 20;
    ctx.fillStyle = COLORS.core;
    ctx.beginPath();
    ctx.moveTo(cc.x, cc.y - cr); ctx.lineTo(cc.x + cr * 0.7, cc.y); ctx.lineTo(cc.x, cc.y + cr);
    ctx.lineTo(cc.x - cr * 0.7, cc.y); ctx.closePath(); ctx.fill();
    ctx.restore();
    bar(cc.x, cc.y - cr - 16, 72 * view.scale + 20, 7, m.castle.hp / m.castle.maxHp, '#63d0ff');
    label(`城堡 ${Math.round(m.castle.hp)}/${m.castle.maxHp}`, cc.x, cc.y - cr - 26, '#bfe6ff', 12);

    // 工事位与已建工事
    m.def.fortSlots.forEach((s, i) => {
      const built = m.forts.find((f) => f.slot === i);
      const c = toScreen(s.x, s.y, built ? 0.8 : 0);
      if (built) {
        const isWall = !built.stats;
        const size = (isWall ? 14 : 18) * view.scale + 6;
        ctx.fillStyle = isWall ? '#6b7a90' : '#dbe6f2';
        ctx.beginPath();
        ctx.moveTo(c.x, c.y - size); ctx.lineTo(c.x + size * 0.8, c.y); ctx.lineTo(c.x, c.y + size * 0.6);
        ctx.lineTo(c.x - size * 0.8, c.y); ctx.closePath(); ctx.fill();
        if (!isWall) bar(c.x, c.y + size * 0.7, size * 1.8, 4, 1, '#8ee08a');
      } else {
        tilePath(s.x, s.y);
        ctx.fillStyle = selectedFortSlot === i ? 'rgba(255,214,130,.35)' : 'rgba(90,169,230,.18)';
        ctx.fill();
        ctx.strokeStyle = selectedFortSlot === i ? '#ffd68a' : 'rgba(140,200,255,.45)';
        ctx.stroke();
        label('修', c.x, c.y - 8 * view.scale, 'rgba(200,225,255,.75)', Math.max(10, 12 * view.scale));
      }
    });

    // 营地：显示囤了几只
    for (const camp of m.camps) {
      const c = toScreen(camp.x, camp.y);
      const alive = m.monsters.filter((x) => !x.dead && x.camp === camp).length;
      ctx.strokeStyle = alive ? 'rgba(255,140,120,.8)' : 'rgba(160,180,200,.4)';
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 18 * view.scale + 4, 9 * view.scale + 3, 0, 0, Math.PI * 2);
      ctx.stroke();
      label(alive ? `营地 ${alive}` : '营地', c.x, c.y + 16 * view.scale, alive ? '#ffb4a0' : '#9fb2c8', 11);
    }

    // 地面掉落物（品质色，走到脚下自动拾取）
    for (const it of m.groundItems) {
      const c = toScreen(it.cell.x, it.cell.y, 0.35);
      const s = 7 * view.scale + 3;
      ctx.fillStyle = QUALITY[it.quality]?.color ?? '#d8dee9';
      ctx.fillRect(c.x - s / 2, c.y - s / 2, s, s);
      ctx.strokeStyle = 'rgba(0,0,0,.5)';
      ctx.strokeRect(c.x - s / 2, c.y - s / 2, s, s);
    }

    // 深度排序画单位
    const drawables = [
      ...m.monsters.filter((x) => !x.dead).map((mo) => {
        const p = monPos(m, mo);
        return { depth: p.x + p.y, draw: () => drawMonster(m, mo) };
      }),
      { depth: (() => { const p = heroPos(m.hero); return p.x + p.y + 0.5; })(), draw: () => drawHero(m, v.localSlot ?? 0) },
    ].sort((a, b) => a.depth - b.depth);
    for (const d of drawables) d.draw();

    // 行进路径提示 + 进攻方向预警
    if (m.hero.path?.length) {
      ctx.strokeStyle = 'rgba(142,224,138,.55)';
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      const p0 = toScreen(m.hero.cell.x, m.hero.cell.y);
      ctx.moveTo(p0.x, p0.y);
      for (const step of m.hero.path.slice(0, 24)) {
        const p = toScreen(step.x, step.y);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (m.assault.warning) {
      const spawn = m.def.assaultSpawns[0];
      const c = toScreen(spawn.x + 2, spawn.y);
      label('⚠ 进攻方向', c.x, c.y - 20, '#ffb4a0', 14);
    }

    drawFloaters(floaters, now);
  }

  resize();
  return { draw, resize, fit, toScreen, toGrid, setCamera, panBy, zoomAt, visibleGrid, get scale() { return view.scale; } };
}

/**
 * 防守模式的右上小地图（§2.6 / §14.3 稿 5）：跟随相机下看不见基地与进攻方向，
 * 这张俯视平面图是「我在哪、怪从哪来、基地还剩多少」的唯一全局视图；点它回城（冷却 30s）。
 */
export function createMinimap(canvas, { size = null } = {}) {
  const ctx = canvas.getContext('2d');
  const PAD = 5;
  const view = { s: 1, ox: PAD, oy: PAD, w: 0, h: 0 };

  function layoutFor(m) {
    const dpr = Math.min(2, viewport().dpr || 1);
    /**
     * §平台适配（小游戏移植）：小游戏那张是**离屏 canvas**，同样没有 `clientWidth/clientHeight`，
     * 所以和 `createRenderer` 一样允许传一个 `size()`；浏览器不传，行为与以前一模一样。
     */
    const measured = size ? size() : null;
    const w = measured ? measured.w : (canvas.clientWidth || canvas.width || 200);
    const h = measured ? measured.h : (canvas.clientHeight || canvas.height || 150);
    const pw = Math.floor(w * dpr), ph = Math.floor(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    view.w = w; view.h = h;
    view.s = Math.min((w - PAD * 2) / m.grid.w, (h - PAD * 2) / m.grid.h);
    view.ox = (w - m.grid.w * view.s) / 2;
    view.oy = (h - m.grid.h * view.s) / 2;
  }

  /** 格坐标 → 小地图像素（点击判定与用例都靠它）。 */
  const toMinimap = (x, y) => ({ x: view.ox + (x + 0.5) * view.s, y: view.oy + (y + 0.5) * view.s });

  function draw(m) {
    layoutFor(m);
    const dot = (x, y, r, fill) => {
      const p = toMinimap(x, y);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    ctx.fillStyle = 'rgba(9,15,24,.9)';
    ctx.fillRect(0, 0, view.w, view.h);
    // 野区（近郊绿 / 腐化紫）：一眼看出「哪块地能刷、刷的是几级怪」
    for (const z of m.def.zones) {
      const p = toMinimap(z.x, z.y);
      ctx.fillStyle = z.lvMin >= 5 ? 'rgba(176,125,224,.28)' : 'rgba(142,224,138,.22)';
      ctx.fillRect(p.x - view.s / 2, p.y - view.s / 2, z.w * view.s, z.h * view.s);
    }
    // 围墙与自建围墙：一张图上就能看出「门在哪、哪条路被堵了」
    ctx.fillStyle = 'rgba(120,140,170,.55)';
    for (let y = 0; y < m.grid.h; y++) {
      for (let x = 0; x < m.grid.w; x++) {
        if (!m.isBlocked(x, y)) continue;
        const p = toMinimap(x, y);
        ctx.fillRect(p.x - view.s / 2, p.y - view.s / 2, Math.max(1, view.s), Math.max(1, view.s));
      }
    }
    for (const c of m.camps) dot(c.x, c.y, 2, c.alive ? '#b98ce6' : 'rgba(185,140,230,.45)');
    for (const t of m.def.teleports) dot(t.x, t.y, 1.6, '#7fd4ff');
    for (const f of m.forts) dot(f.cell.x, f.cell.y, 2, f.fortId === 'fort_wall' ? '#8ea0b8' : '#ffd479');
    for (const mo of m.monsters) dot(mo.cell.x, mo.cell.y, mo.tier === 'boss' ? 3 : 1.8, mo.isAir ? '#9ad8ff' : '#e06a5c');
    dot(m.castle.cell.x, m.castle.cell.y, 3.2, '#7fd4ff');
    // §3.7 低血提示：生命 < 20% 时小地图上的英雄点变红并加一圈环（让辅助一眼看到该奶谁）
    const h = m.hero;
    const low = isLowHp(h.hp, heroMaxHp(h));
    dot(h.cell.x, h.cell.y, low ? 3.4 : 2.6, low ? '#ff8a6a' : '#8ee08a');
    if (low) {
      const p = toMinimap(h.cell.x, h.cell.y);
      ctx.strokeStyle = 'rgba(255,120,90,.95)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(120,140,170,.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(view.ox, view.oy, m.grid.w * view.s, m.grid.h * view.s);
    // 回防预警：整张图闪一圈橙边（§2.6「小地图闪烁」）
    if (m.assault.warning) {
      ctx.strokeStyle = 'rgba(255,160,90,.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, view.w - 2, view.h - 2);
    }
  }

  return { draw, toMinimap, get size() { return { w: view.w, h: view.h, scale: view.s }; } };
}

export function qualityColor(q) {
  return QUALITY[q]?.color ?? '#d8dee9';
}

export function towerName(id) {
  return TOWERS[id]?.name ?? id;
}

/**
 * 大厅地图卡面的缩略图（§2.7：缩略图、星级、路线数、通关率）。
 * 缩略图用俯视平面——等距缩到 180px 宽只会糊成一团，而这张图要回答的是
 * 「几条路 / 路怎么走 / 核心在哪」，俯视最省事也最清楚。
 */
export function drawMapThumb(canvas, mode, mapId, surface = null) {
  /**
   * `surface` 是给**小游戏大厅**用的（移植第 3 步）：那边没有 `<canvas>` 元素、也没有 DOM 尺寸，
   * 只有一个主 canvas 和一个 2D 上下文，所以传 `{ ctx, w, h }` 就按**逻辑单位**直接画进指定位置，
   * 不做尺寸设置与 dpr 变换（调用方自己 translate/clip）。不传 surface 时行为与以前完全一致。
   */
  const ctx = surface?.ctx ?? canvas.getContext('2d');
  const dpr = surface ? 1 : Math.min(2, viewport().dpr || 1);
  const w = surface?.w ?? (canvas.clientWidth || canvas.width || 176);
  const h = surface?.h ?? (canvas.clientHeight || canvas.height || 99);
  if (!surface) {
    const pw = Math.floor(w * dpr), ph = Math.floor(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const def = mode === 'defense' ? DEFENSE_MAPS[mapId] : MAPS[mapId];
  if (!def) return;
  const grid = def.grid ?? GRID;
  const pad = 4;
  const s = Math.min((w - pad * 2) / grid.w, (h - pad * 2) / grid.h);
  const ox = (w - grid.w * s) / 2, oy = (h - grid.h * s) / 2;
  const at = (x, y) => ({ x: ox + (x + 0.5) * s, y: oy + (y + 0.5) * s });
  const cell = (x, y, fill, size = s) => {
    const p = at(x, y);
    ctx.fillStyle = fill;
    ctx.fillRect(p.x - size / 2, p.y - size / 2, Math.max(1, size), Math.max(1, size));
  };
  const dot = (x, y, r, fill) => {
    const p = at(x, y);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  ctx.fillStyle = 'rgba(12,20,32,.9)';
  ctx.fillRect(0, 0, w, h);

  if (mode === 'defense') {
    for (const z of def.zones) {
      const p = at(z.x, z.y);
      ctx.fillStyle = z.lvMin >= 5 ? 'rgba(176,125,224,.30)' : 'rgba(142,224,138,.24)';
      ctx.fillRect(p.x - s / 2, p.y - s / 2, z.w * s, z.h * s);
    }
    const b = def.base;
    for (let x = b.x; x < b.x + b.w; x++) for (let y = b.y; y < b.y + b.h; y++) {
      const edge = x === b.x || y === b.y || x === b.x + b.w - 1 || y === b.y + b.h - 1;
      const gate = x === b.gate.x && y === b.gate.y;
      if (edge && !gate) cell(x, y, 'rgba(120,140,170,.75)');
    }
    for (const c of def.camps) dot(c.x, c.y, 1.8, '#b98ce6');
    for (const t of def.teleports) dot(t.x, t.y, 1.5, '#7fd4ff');
    dot(def.castle.x, def.castle.y, 3, '#7fd4ff');
    return;
  }

  const m = buildMap(def);
  for (const t of def.terrain ?? []) {
    for (const r of t.rects) {
      const p = at(r.x, r.y);
      ctx.fillStyle = t.type === 'lava' ? 'rgba(216,106,74,.55)' : 'rgba(60,120,80,.45)';
      ctx.fillRect(p.x - s / 2, p.y - s / 2, r.w * s, r.h * s);
    }
  }
  for (const p of m.paths) for (const c of p.cells) cell(c.x, c.y, p.air ? 'rgba(154,216,255,.55)' : 'rgba(120,140,170,.75)');
  for (const sl of m.slots) cell(sl.x, sl.y, 'rgba(220,235,255,.5)', Math.max(1, s * 0.6));
  for (const p of m.paths) dot(p.spawn.x, p.spawn.y, 2.4, '#e06a5c');
  for (const c of m.cores) dot(c.x, c.y, 3.2, '#7fd4ff');
}
