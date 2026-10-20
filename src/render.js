// 等距 2:1 渲染（§14.1）。静帧按 docs/art/DIRECTION.md 热替换；缺图或没加载完就画 P0 剪影。

import { DEFENSE_MAPS, GRID, HERO_REVIVE, MAPS, MONSTERS, QUALITY, TEAM_COLORS, TOWERS } from './data.js';
import { buildMap, heroPos, posAt, project } from './core.js';
import { heroAbilityRange, heroMaxHp, holdCells, revivePoint, sprintState, towerStatsAt } from './match.js';
import { isLowHp } from './hud-model.js';
import { viewport } from './platform.js';   // §平台适配：像素比在两个环境里的取法不同
import { heroSpriteKey, mobSpriteKey, resolveSprite, tileSpriteKey, towerSpriteKey } from './assets.js';
import {
  DEATH_SEC, attackPulse, chargePulse, fxBudget, heroMotion, hitSlash, impactGlyphs, leanParts, mobMotion,
  poseClip, poseFrame, shotGlyphs, shotKind, slowShards, sprintStreaks, towerMarks, towerNudge,
} from './motion.js';

/**
 * 身体像素高（再乘 view.scale）。Boss > Hero > Elite > Creep。
 * 英雄不低于精英。塔是建筑体量，随等级加高，不是又一个兵。
 */
export const BODY_PX = Object.freeze({
  creep: 42,
  elite: 56,
  hero: 70,
  boss: 96,
  tower: Object.freeze([60, 76, 92]),
});

const BODY_DIV = { creep: 2.5, elite: 2.5, boss: 2.5, hero: 2.6, tower: 2.4 };

/** 剪影用的单位半径。精灵高度 = 半径 × 对应档的除数 = BODY_PX × scale。 */
export function bodyRadius(kind, scale = 1, level = 1) {
  const lv = Math.min(3, Math.max(1, Math.round(Number(level) || 1)));
  const px = kind === 'tower' ? BODY_PX.tower[lv - 1] : BODY_PX[kind];
  return (px * (Number(scale) || 0)) / BODY_DIV[kind];
}

const mobKind = (tier) => (tier === 'boss' ? 'boss' : tier === 'elite' ? 'elite' : 'creep');

/**
 * 地形填色。路径要比可建地亮一档并带深色描边，否则整张图是同一块深蓝灰。
 * 岩浆保持原来的 `#5a2b1f`，只加一圈亮边；沼泽绿不变。
 */
export function terrainPaint(kind) {
  switch (kind) {
    case 'path': return { fill: '#6a7a90', stroke: '#141c28', lineWidth: 2.5 };
    case 'lava': return { fill: '#5a2b1f', stroke: '#e0a15c', lineWidth: 1.25 };
    case 'swamp': return { fill: '#1d3a2c', stroke: 'rgba(90,140,200,.10)', lineWidth: 1 };
    case 'tileB': return { fill: '#0c1522', stroke: 'rgba(90,140,200,.10)', lineWidth: 1 };
    case 'tileA':
    default: return { fill: '#10192a', stroke: 'rgba(90,140,200,.10)', lineWidth: 1 };
  }
}

const r3 = (n) => Math.round(n * 1000) / 1000;

/** 暖色轮廓只画在英雄身上。塔用队伍色底座环，怪的光环是另一色。 */
export const HERO_GLOW = { stroke: '#ffd68a', lineWidth: 3, halo: 'rgba(255, 214, 138, .35)', haloWidth: 7, haloScale: 1.42 };
/** 英雄技能圈：虚线、冷色、不填奶油底，和塔的射程圈分开。 */
export const HERO_SKILL_RING = { stroke: '#7ec8ff', lineWidth: 1.5, dash: [5, 4] };
/** 点英雄的半径下限（直径约 44px）。视觉半径更大时跟视觉走。 */
export const HERO_HIT_PX = 44;

export function pointHitsHero(screen, scale, sx, sy) {
  const r = Math.max(HERO_HIT_PX / 2, 16 * (scale || 1) + 8);
  const dx = sx - (screen?.x ?? 0);
  const dy = sy - (screen?.y ?? 0);
  return dx * dx + dy * dy <= r * r;
}

/** 尖刺星。外半径 1，调用方用自己的 `r` 去缩放（Boss 的 r 本来就比普通怪大约一倍）。 */
function starPoints(spikes, outer, inner, squash = 0.78) {
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / spikes;
    const rad = i % 2 === 0 ? outer : inner;
    pts.push([r3(Math.cos(a) * rad), r3(Math.sin(a) * rad * squash)]);
  }
  return pts;
}

const towerLevel = (level) => Math.min(3, Math.max(1, Math.round(Number(level) || 1)));

/**
 * 塔的剪影（单位坐标，y 向下）。四种塔不再共用一颗菱形：
 * 箭塔 = 细柱 + 三角顶，炮塔 = 矮墩 + 横炮管，冰塔 = 尖晶簇，电塔 = 细杆 + 两侧电弧。
 * Lv2/Lv3 加构件，升级不只是把同一颗菱形放大。
 */
export function towerSilhouette(towerId, level = 1) {
  const lv = towerLevel(level);
  let parts;
  if (towerId === 'tw_cannon') {
    const reach = [0.92, 1.16, 1.4][lv - 1];
    parts = [
      { role: 'base', points: [[-0.7, 0.55], [0.7, 0.55], [0.7, -0.08], [-0.7, -0.08]], closed: true },
      { role: 'barrel', points: [[0.1, -0.02], [reach, -0.02], [reach, -0.36], [0.1, -0.36]], closed: true },
    ];
    if (lv >= 3) {
      parts.push({ role: 'barrel', points: [[0.1, -0.42], [reach - 0.18, -0.42], [reach - 0.18, -0.68], [0.1, -0.68]], closed: true });
      // 炮尾在炮管后方，不把炮口再往前伸（barrelReach 仍看第一根炮管）
      parts.push({ role: 'breech', points: [[-0.92, 0.22], [-0.18, 0.16], [-0.18, -0.62], [-0.92, -0.5]], closed: true });
    }
  } else if (towerId === 'tw_frost') {
    const tip = [-1.15, -1.31, -1.47][lv - 1];
    const side = lv > 1 ? 0.14 : 0;
    parts = [
      { role: 'crystal', points: [[0, tip], [-0.3, 0.48], [0.3, 0.48]], closed: true },
      { role: 'crystal', points: [[-0.62, r3(-0.42 - side)], [-0.9, 0.42], [-0.22, 0.28]], closed: true },
      { role: 'crystal', points: [[0.58, r3(-0.55 - side)], [0.92, 0.38], [0.2, 0.22]], closed: true },
    ];
    if (lv >= 3) parts.push({ role: 'spike', points: [[0, -1.98], [-0.34, 0.08], [0.34, 0.08]], closed: true });
  } else if (towerId === 'tw_static') {
    const top = [-1.02, -1.14, -1.26][lv - 1];
    parts = [
      { role: 'rod', points: [[-0.08, 0.55], [0.08, 0.55], [0.08, top], [-0.08, top]], closed: true },
      { role: 'arc', points: [[0, -0.62], [-0.38, -0.38], [-0.16, -0.12], [-0.62, 0.12]], closed: false },
      { role: 'arc', points: [[0, -0.48], [0.42, -0.22], [0.18, 0.02], [0.66, 0.22]], closed: false },
      { role: 'knob', ellipse: [0, r3(top - 0.1), 0.14, 0.12] },
    ];
    if (lv >= 3) {
      parts.push(
        { role: 'coil', points: [[-0.28, -0.58], [0.28, -0.74], [0.28, -0.5], [-0.28, -0.34]], closed: true },
        { role: 'coil', points: [[-0.32, -0.16], [0.32, -0.32], [0.32, -0.06], [-0.32, 0.1]], closed: true },
      );
    }
  } else {
    // 箭塔，以及未知 id：退回箭塔而不是旧的四顶点菱形
    parts = [
      { role: 'pillar', points: [[-0.16, 0.55], [0.16, 0.55], [0.16, -0.32], [-0.16, -0.32]], closed: true },
      { role: 'roof', points: [[-0.64, -0.26], [0, -1.12], [0.64, -0.26]], closed: true },
    ];
    if (lv >= 2) parts.push({ role: 'brace', points: [[-0.28, -0.05], [0.28, -0.05], [0.28, 0.08], [-0.28, 0.08]], closed: true });
    if (lv >= 3) {
      // 女墙比 Lv1 屋顶（±0.64）更宽，三块垛口是建筑体量，不是英雄的头或武器
      parts.push(
        { role: 'battlement', points: [[-0.88, -0.22], [0.88, -0.22], [0.88, -0.42], [-0.88, -0.42]], closed: true },
        { role: 'battlement', points: [[-0.82, -0.42], [-0.5, -0.42], [-0.5, -0.78], [-0.82, -0.78]], closed: true },
        { role: 'battlement', points: [[-0.16, -0.42], [0.16, -0.42], [0.16, -0.84], [-0.16, -0.84]], closed: true },
        { role: 'battlement', points: [[0.5, -0.42], [0.82, -0.42], [0.82, -0.78], [0.5, -0.78]], closed: true },
      );
    }
  }
  return { id: towerId, level: lv, parts };
}

/**
 * 怪的剪影按特性，不按「再画一颗椭圆」。
 * 优先级：Boss 星形 > 空中（菱形身 + 翼，翼宽过身，不靠抬高认）> 死亡分裂双圆 > 重甲/攻城方块 > 地面带角的身体。
 * `aura` 是叠加上去的外环，不把 Boss 或地面怪改成另一种身体。
 */
export function mobSilhouette(def = {}) {
  const boss = def.tier === 'boss' || !!def.bossTier;
  const air = !!def.isAir;
  const split = !!def.onDeath;
  const fortified = def.armorType === 'fortified' || !!def.siege;
  const aura = !!def.aura;
  let shape = 'ground';
  if (boss) shape = 'boss';
  else if (air) shape = 'air';
  else if (split) shape = 'split';
  else if (fortified) shape = 'fortified';
  let parts;
  if (shape === 'boss') {
    parts = [{ role: 'body', points: starPoints(8, 1, 0.46), closed: true }];
  } else if (shape === 'air') {
    parts = [
      { role: 'body', points: [[0, -0.92], [0.42, 0.05], [0, 0.62], [-0.42, 0.05]], closed: true },
      { role: 'wing', points: [[-0.18, -0.05], [-1.28, -0.62], [-0.28, 0.32]], closed: true },
      { role: 'wing', points: [[0.18, -0.05], [1.28, -0.62], [0.28, 0.32]], closed: true },
    ];
  } else if (shape === 'split') {
    parts = [
      { role: 'body', ellipse: [-0.46, 0.04, 0.5, 0.44] },
      { role: 'body', ellipse: [0.46, -0.02, 0.42, 0.38] },
    ];
  } else if (shape === 'fortified') {
    parts = [
      { role: 'body', points: [[-0.78, -0.42], [-0.42, -0.72], [0.42, -0.72], [0.78, -0.42], [0.78, 0.48], [0.42, 0.72], [-0.42, 0.72], [-0.78, 0.48]], closed: true },
      { role: 'plate', points: [[-0.28, -0.15], [0, -0.42], [0.28, -0.15], [0, 0.22]], closed: true },
    ];
  } else {
    parts = [
      { role: 'body', ellipse: [0, 0, 0.74, 0.58] },
      { role: 'horn', points: [[-0.28, -0.42], [-0.58, -1.05], [-0.05, -0.5]], closed: true },
      { role: 'horn', points: [[0.28, -0.42], [0.58, -1.05], [0.05, -0.5]], closed: true },
    ];
  }
  if (aura) parts.push({ role: 'aura', ellipse: [0, 0, 1.35, 1.05], strokeOnly: true });
  return { shape, aura, parts };
}

/** 英雄：圆头 + 梯形身 + 一把短武器。四职业只差武器那一笔。 */
export function heroSilhouette(heroId = 'hero_warrior') {
  const weapon = heroId === 'hero_mage' ? 'staff'
    : heroId === 'hero_ranger' ? 'bow'
      : heroId === 'hero_paladin' ? 'hammer'
        : 'blade';
  const parts = [
    { role: 'head', ellipse: [0, -0.62, 0.32, 0.28] },
    { role: 'body', points: [[-0.4, 0.62], [-0.24, -0.34], [0.24, -0.34], [0.4, 0.62]], closed: true },
  ];
  if (weapon === 'staff') {
    parts.push({ role: 'weapon', points: [[0.4, 0.58], [0.4, -1.05]], closed: false });
    parts.push({ role: 'weapon', ellipse: [0.4, -1.14, 0.12, 0.12] });
  } else if (weapon === 'bow') {
    parts.push({ role: 'weapon', points: [[0.48, -0.72], [0.92, -0.08], [0.48, 0.52]], closed: false });
    parts.push({ role: 'weapon', points: [[0.48, -0.72], [0.48, 0.52]], closed: false });
  } else if (weapon === 'hammer') {
    parts.push({ role: 'weapon', points: [[0.36, 0.5], [0.36, -0.55]], closed: false });
    parts.push({ role: 'weapon', points: [[0.08, -0.72], [0.66, -0.72], [0.66, -0.42], [0.08, -0.42]], closed: true });
  } else {
    parts.push({ role: 'weapon', points: [[0.16, 0.08], [0.98, -0.78]], closed: false });
  }
  return { heroId, weapon, parts };
}

/** 防守围墙。`run` 是直段垛口，`corner` 多一块角垛，`gate` 是门洞（两根门垛 + 门梁，中间留空）。 */
export function wallSilhouette(kind = 'run') {
  if (kind === 'gate') {
    return {
      kind: 'gate',
      parts: [
        { role: 'jamb', points: [[-0.9, 0.42], [-0.28, 0.42], [-0.28, -0.06], [-0.9, -0.06]], closed: true },
        { role: 'jamb', points: [[0.28, 0.42], [0.9, 0.42], [0.9, -0.06], [0.28, -0.06]], closed: true },
        { role: 'lintel', points: [[-0.9, -0.06], [0.9, -0.06], [0.9, -0.28], [-0.9, -0.28]], closed: true },
        { role: 'post', points: [[-0.9, -0.28], [-0.58, -0.28], [-0.58, -0.68], [-0.9, -0.68]], closed: true },
        { role: 'post', points: [[0.58, -0.28], [0.9, -0.28], [0.9, -0.68], [0.58, -0.68]], closed: true },
      ],
    };
  }
  const run = {
    role: 'wall',
    points: [
      [-0.9, 0.42], [0.9, 0.42], [0.9, -0.08],
      [0.55, -0.08], [0.55, -0.48], [0.2, -0.48], [0.2, -0.08],
      [-0.2, -0.08], [-0.2, -0.48], [-0.55, -0.48], [-0.55, -0.08],
      [-0.9, -0.08],
    ],
    closed: true,
  };
  if (kind === 'corner') {
    return {
      kind: 'corner',
      parts: [
        run,
        { role: 'buttress', points: [[-0.9, 0.42], [-0.38, 0.42], [-0.38, 0.92], [-0.9, 0.92]], closed: true },
      ],
    };
  }
  return { kind: 'run', parts: [run] };
}

/** 横竖相邻都是墙，才是转角；直段只有一个方向的邻居。 */
export function wallKindAt(walls, x, y) {
  const has = (dx, dy) => !!walls?.has?.(`${x + dx},${y + dy}`);
  const horizontal = has(-1, 0) || has(1, 0);
  const vertical = has(0, -1) || has(0, 1);
  return horizontal && vertical ? 'corner' : 'run';
}

/**
 * 工事比 TD 塔矮。箭塔工事是带门洞的门楼，不是把 TD 箭塔缩小一圈。
 * 单位高度约 0.98，TD 箭塔 Lv1（柱底到顶尖）约 1.67。
 */
export function fortSilhouette(fortId = 'fort_arrow') {
  if (fortId === 'fort_wall') return wallSilhouette('gate');
  return {
    id: 'fort_arrow',
    parts: [
      { role: 'pier', points: [[-0.78, 0.28], [-0.34, 0.28], [-0.34, -0.18], [-0.78, -0.18]], closed: true },
      { role: 'pier', points: [[0.34, 0.28], [0.78, 0.28], [0.78, -0.18], [0.34, -0.18]], closed: true },
      { role: 'lintel', points: [[-0.84, -0.18], [0.84, -0.18], [0.84, -0.36], [-0.84, -0.36]], closed: true },
      { role: 'merlon', points: [[-0.74, -0.36], [-0.46, -0.36], [-0.46, -0.62], [-0.74, -0.62]], closed: true },
      { role: 'merlon', points: [[0.46, -0.36], [0.74, -0.36], [0.74, -0.62], [0.46, -0.62]], closed: true },
      { role: 'roof', points: [[-0.4, -0.56], [0, -0.7], [0.4, -0.56]], closed: true },
    ],
  };
}

/** 工事屏幕半径。严格小于同缩放下的 TD 塔（含 Lv1）。 */
export function fortDrawSize(scale = 1) {
  return bodyRadius('tower', scale, 1) * 0.72;
}

/** 围墙 / 门洞比工事再矮一截，仍然低于 TD 塔。 */
export function wallDrawSize(scale = 1) {
  return bodyRadius('tower', scale, 1) * 0.58;
}

/** 把 `*Silhouette()` 的单位坐标画到锚点上。封闭块填色，开口折线（电弧、武器）用 accent 描。 */
function paintSilhouette(ctx, cx, cy, size, spec, style = {}) {
  const fill = style.fill ?? '#dbe6f2';
  const outline = style.stroke ?? 'rgba(8,14,22,.78)';
  const outlineW = style.lineWidth ?? 1;
  const accent = style.accent ?? fill;
  const s = size;
  for (const part of spec.parts) {
    ctx.beginPath();
    if (part.ellipse) {
      const [x, y, rx, ry] = part.ellipse;
      ctx.ellipse(
        cx + x * s, cy + y * s,
        Math.max(0.5, Math.abs(rx) * s), Math.max(0.5, Math.abs(ry) * s),
        0, 0, Math.PI * 2,
      );
      if (part.strokeOnly) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = Math.max(1.25, s * 0.08);
        ctx.stroke();
      } else {
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = outline;
        ctx.lineWidth = outlineW;
        ctx.stroke();
      }
      continue;
    }
    const pts = part.points ?? [];
    if (!pts.length) continue;
    pts.forEach(([x, y], i) => {
      const px = cx + x * s;
      const py = cy + y * s;
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    if (part.closed) {
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = outline;
      ctx.lineWidth = outlineW;
      ctx.stroke();
    } else {
      ctx.strokeStyle = accent;
      ctx.lineWidth = Math.max(1.5, s * (part.weight ?? 0.1));
      ctx.stroke();
    }
  }
  ctx.lineWidth = 1;
}

const COLORS = {
  bg: '#070c14',
  tileA: terrainPaint('tileA').fill,
  tileB: terrainPaint('tileB').fill,
  path: terrainPaint('path').fill,
  swamp: terrainPaint('swamp').fill,
  core: '#7fd4ff',
  tower: { tw_arrow: '#dbe6f2', tw_cannon: '#e0a15c', tw_frost: '#79c8ee', tw_static: '#b98ce6' },
  hero: '#8ee08a',
  mob: { normal: '#c9d6e6', elite: '#e8a33d', boss: '#d1503f' },
  air: '#9ad8ff',
  // 怪的法术圈。不要用英雄光的 #ffd68a。
  aura: '#7f9e92',
};

/**
 * §116：新手引导的塔位高亮透明度。`pulses:false`（低特效档）时**不再随时间变化**——
 * 设置面板对玩家的原话是「低特效档会关掉伤害飘字与塔位脉冲」，飘字那半早就生效了，
 * 脉冲这半一直没人读 `renderOptions().showPulses`，于是低特效下它照样闪。
 * 抽成纯函数是为了能直接断「两个时刻的取值一样 / 不一样」，不必去读 canvas 像素。
 */
export const hintPulseAlpha = (now, pulses = true) => (pulses ? 0.35 + 0.35 * Math.sin(now * 4) : 0.7);

/**
 * 把一句话裁到给定宽度（不够就加省略号）：小游戏没有 CSS 的 `text-overflow`，
 * 而这几处文案的长度取决于**数据表**（怪物名、护甲标签、地图名）。量一量再画比「估字数」靠谱。
 * 假 ctx（Node 用例）的 `measureText` 按字数估宽，行为与真机一致。
 */
export const fitText = (ctx, str, maxW) => {
  if (ctx.measureText(str).width <= maxW) return str;
  let cut = str;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxW) cut = cut.slice(0, -1);
  return `${cut}…`;
};

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

  /** 单位图的锚点是底边中点。高度按剪影原来占的屏幕尺寸，不按 PNG 的原始像素画。 */
  function drawSprite(frame, cx, groundY, height) {
    if (!frame?.image || !frame.w || !frame.h || !height) return false;
    const dh = height;
    const dw = dh * (frame.w / frame.h);
    ctx.drawImage(frame.image, cx - dw / 2, groundY - dh, dw, dh);
    return true;
  }

  /** 地块图中心对齐格子。没有这张图就返回 false，调用方继续填色。 */
  function paintCell(x, y, kind) {
    const frame = resolveSprite(tileSpriteKey(kind), 'idle', 0);
    if (!frame) return false;
    const c = toScreen(x, y);
    const tw = GRID.tileW * view.scale;
    const th = GRID.tileH * view.scale;
    ctx.drawImage(frame.image, c.x - tw / 2, c.y - th / 2, tw, th);
    return true;
  }

  let frameNow = 0;
  let frameFx = fxBudget('high');
  let sprintLeft = frameFx.sprint ?? 0;
  const poses = new Map();
  const flashes = new Map();
  const corpses = [];
  const shotSeen = new Map();
  const impacts = [];

  function beginFrame(isoView) {
    frameNow = isoView.now ?? 0;
    frameFx = fxBudget(isoView.fx);
    sprintLeft = frameFx.sprint ?? 0;
  }

  function drawGlyphs(glyphs, color, width = 1.5) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (const g of glyphs) {
      if (g.ellipse) {
        ctx.beginPath();
        ctx.ellipse(g.ellipse[0], g.ellipse[1], Math.abs(g.ellipse[2]), Math.abs(g.ellipse[3]), 0, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }
      const pts = g.points;
      if (!pts?.length) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      if (g.closed) ctx.closePath();
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  function placeGlyphs(glyphs, ox, oy, scale) {
    return glyphs.map((g) => {
      if (g.ellipse) {
        return { ellipse: [ox + g.ellipse[0] * scale, oy + g.ellipse[1] * scale, g.ellipse[2] * scale, g.ellipse[3] * scale] };
      }
      return {
        closed: g.closed,
        points: g.points.map(([x, y]) => [ox + x * scale, oy + y * scale]),
      };
    });
  }

  /** 记下还活着的怪。下一帧不见了的，留一具最多 0.42 秒的残影。 */
  function trackMonsters(list, m) {
    const live = new Set();
    for (const mo of list) {
      if (mo.dead) continue;
      live.add(mo.uid);
      const p = monPos(m, mo);
      const prev = poses.get(mo.uid);
      if (prev && mo.hp < prev.hp - 0.01) flashes.set(mo.uid, frameNow + 0.14);
      poses.set(mo.uid, {
        hp: mo.hp, x: p.x, y: p.y, isAir: !!mo.isAir, def: mo.def, mobId: mo.def?.id,
      });
    }
    for (const [uid, pose] of poses) {
      if (live.has(uid)) continue;
      if (corpses.length < frameFx.corpses) corpses.push({ ...pose, until: frameNow + DEATH_SEC });
      poses.delete(uid);
      flashes.delete(uid);
    }
    while (corpses.length > frameFx.corpses) corpses.shift();
  }

  function drawCorpses() {
    for (let i = corpses.length - 1; i >= 0; i--) {
      const corpse = corpses[i];
      const life = (corpse.until - frameNow) / DEATH_SEC;
      if (life <= 0) { corpses.splice(i, 1); continue; }
      const c = toScreen(corpse.x, corpse.y, corpse.isAir ? 1.6 : 0);
      const tier = corpse.def?.tier;
      const r = bodyRadius(mobKind(tier), view.scale) * (0.55 + 0.45 * life);
      const deathT = 1 - life;
      const frame = resolveSprite(mobSpriteKey(corpse.mobId ?? corpse.def?.id), 'death', poseFrame('death', { deathT }));
      ctx.globalAlpha = Math.max(0, Math.min(1, life));
      if (!(frame && drawSprite(frame, c.x, c.y + r * 0.62, r * 2.5))) {
        paintSilhouette(ctx, c.x, c.y + (1 - life) * 6, r, mobSilhouette({ ...corpse.def, isAir: corpse.isAir }), {
          fill: '#8b95a3',
          accent: '#c5ced6',
        });
        ctx.beginPath();
        ctx.moveTo(c.x - r, c.y);
        ctx.lineTo(c.x + r, c.y);
        ctx.strokeStyle = '#d5dde6';
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawTowerBody(towerId, level, cx, cy, size, style, frame) {
    const sprite = frame === undefined
      ? resolveSprite(towerSpriteKey(towerId, level), 'idle', 0)
      : frame;
    if (sprite && drawSprite(sprite, cx, cy + size * 0.5, size * 2.4)) return;
    paintSilhouette(ctx, cx, cy, size, towerSilhouette(towerId, level), style);
  }

  function drawTiles(m) {
    const g = m.map?.grid ?? GRID;
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        const onPath = m.map.blocked.has(`${x},${y}`);
        const swamp = m.map.swamp.has(`${x},${y}`);
        const lava = m.map.lava?.has(`${x},${y}`);
        const c = toScreen(x, y);
        const kind = lava ? 'lava' : onPath ? 'path' : swamp ? 'swamp' : ((x + y) % 2 ? 'tileA' : 'tileB');
        const paint = terrainPaint(kind);
        if (!paintCell(x, y, kind)) {
          tilePath(x, y);
          ctx.fillStyle = paint.fill;
          ctx.fill();
          // 沼泽加两粒固定位置的噪点（别用随机，否则每帧都在闪）。图里已经有噪点，就不重复画。
          if (swamp && !onPath && !lava && (x * 3 + y) % 2 === 0) {
            ctx.fillStyle = 'rgba(168,214,176,.55)';
            const s = Math.max(1, 1.6 * view.scale);
            ctx.fillRect(c.x - 3 * view.scale, c.y - s, s, s);
            ctx.fillRect(c.x + 4 * view.scale, c.y + 2 * view.scale, s, s);
          }
        }
        // 边是程序描的，不交给贴图。路径是硬边；可建地和装饰块用自己的软边，不能画成能走的路。
        tilePath(x, y);
        ctx.strokeStyle = paint.stroke;
        ctx.lineWidth = paint.lineWidth;
        ctx.stroke();
        ctx.lineWidth = 1;
        if (onPath && (x + y) % 3 === 0) label('·', c.x, c.y, 'rgba(12,18,28,.45)', 14);
      }
    }
  }

  /** 出生格一根小旗：进场方向不用靠记忆。空中航线用天蓝色旗。 */
  function drawSpawns(m) {
    const seen = new Set();
    for (const p of m.map?.paths ?? []) {
      const s = p.spawn;
      if (!s) continue;
      const key = `${s.x},${s.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const c = toScreen(s.x, s.y, 0);
      const h = 16 * view.scale + 6;
      ctx.strokeStyle = '#e6d7b4';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y + 2);
      ctx.lineTo(c.x, c.y - h);
      ctx.stroke();
      ctx.fillStyle = p.air ? COLORS.air : '#e06a5c';
      ctx.beginPath();
      ctx.moveTo(c.x, c.y - h);
      ctx.lineTo(c.x + 10 * view.scale + 4, c.y - h + 4 * view.scale);
      ctx.lineTo(c.x, c.y - h + 8 * view.scale);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1;
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
      // 核心脚下铺一格浅冰蓝，远看先找到「要守的点」
      const g = toScreen(core.cell.x, core.cell.y, 0);
      ctx.beginPath();
      ctx.ellipse(
        g.x, g.y,
        (GRID.tileW / 2) * view.scale * 0.92,
        (GRID.tileH / 2) * view.scale * 0.92,
        0, 0, Math.PI * 2,
      );
      ctx.fillStyle = 'rgba(127,212,255,.20)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(190,232,255,.8)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;
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
    const size = bodyRadius('tower', view.scale, t.level);
    const pulse = attackPulse(t.cooldown, t.stats?.atkSpeed);
    const charge = chargePulse(t.cooldown, t.stats?.atkSpeed);
    const clip = poseClip({ pulse, dead: t.hp <= 0 });
    const index = poseFrame(clip, { now: frameNow, pulse, uid: t.uid ?? 0 });
    const base = towerSpriteKey(t.towerId, t.level);
    const frame = resolveSprite(base, clip, index);
    const posed = !!(frame && frame.key !== base);
    const nudge = posed ? { dx: 0, dy: 0 } : towerNudge(t.towerId, pulse);
    const bx = c.x + nudge.dx * view.scale;
    const by = c.y + nudge.dy * view.scale;
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath(); ctx.ellipse(c.x, c.y + size * 0.5, size * 0.9, size * 0.4, 0, 0, Math.PI * 2); ctx.fill();
    drawTowerBody(t.towerId, t.level, bx, by, size, {
      fill: color,
      accent: color,
      stroke: selected ? '#8ee08a' : 'rgba(10,20,30,.6)',
      lineWidth: selected ? 2.5 : 1,
    }, frame);
    const marks = posed ? [] : towerMarks(t.towerId, pulse, charge);
    if (marks.length) drawGlyphs(placeGlyphs(marks, bx, by - size * 0.2, view.scale), color, 1.5);
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
  }

  /**
   * 射程圈画在地面上（等距椭圆）。深色底 + 浅色边，在路径和可建地上都读得到。
   * 选中已建塔、预测放置、轮盘悬停某个塔种时才画。
   */
  function drawRangeRing(cell, range) {
    if (!cell || !(Number(range) > 0)) return;
    const c = toScreen(cell.x, cell.y, 0);
    const rx = range * (GRID.tileW / 2) * view.scale;
    const ry = range * (GRID.tileH / 2) * view.scale;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 244, 210, .14)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(8, 12, 18, .92)';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = '#fff4d2';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  /** 英雄技能圈：虚线冷色，不铺塔那种奶油填充。四个刻度再和实线圈拉开。 */
  function drawHeroSkillRing(cell, range) {
    if (!cell || !(Number(range) > 0)) return;
    const c = toScreen(cell.x, cell.y, 0);
    const rx = range * (GRID.tileW / 2) * view.scale;
    const ry = range * (GRID.tileH / 2) * view.scale;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.setLineDash(HERO_SKILL_RING.dash);
    ctx.strokeStyle = HERO_SKILL_RING.stroke;
    ctx.lineWidth = HERO_SKILL_RING.lineWidth;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    const ticks = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    ctx.beginPath();
    for (const [tx, ty] of ticks) {
      ctx.moveTo(c.x + tx * rx * 0.92, c.y + ty * ry * 0.92);
      ctx.lineTo(c.x + tx * rx * 1.08, c.y + ty * ry * 1.08);
    }
    ctx.strokeStyle = HERO_SKILL_RING.stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  /** 选中英雄时标出能站住的格子。小菱形，不是塔位椭圆。低特效也画：这是操作信息，不是粒子。 */
  function drawHoldMarks(m) {
    const goal = m.hero?.hold;
    const here = m.hero?.cell;
    for (const c of holdCells(m)) {
      const p = toScreen(c.x, c.y, 0);
      const strong = !!(goal && goal.x === c.x && goal.y === c.y && !(here && here.x === c.x && here.y === c.y));
      const s = (strong ? 6 : 3.5) * Math.max(0.65, view.scale);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - s);
      ctx.lineTo(p.x + s * 0.72, p.y);
      ctx.lineTo(p.x, p.y + s);
      ctx.lineTo(p.x - s * 0.72, p.y);
      ctx.closePath();
      ctx.strokeStyle = strong ? '#f0d59a' : '#c9a36a';
      ctx.lineWidth = strong ? 2 : 1;
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  function drawMonster(m, mo) {
    const z = mo.isAir ? 1.6 : 0;
    // §10.3：用亚格位置画（`dist` 是内核本来就有的连续量），逻辑判定仍走 mo.cell
    const p = monPos(m, mo);
    const c0 = toScreen(p.x, p.y, z);
    const pulse = attackPulse(mo.cooldown, mo.atkSpeed);
    const moving = mo.pathIndex != null ? !mo.attacking : !!(mo.path?.length) && !mo.attacking;
    const clip = poseClip({ now: frameNow, pulse, attacking: !!mo.attacking, moving });
    const index = poseFrame(clip, { now: frameNow, pulse, uid: mo.uid ?? 0 });
    const base = mobSpriteKey(mo.def?.id);
    const frame = resolveSprite(base, clip, index);
    const posed = !!(frame && frame.key !== base);
    const motion = posed
      ? { dy: 0, pulse, bob: 0 }
      : mobMotion({
        now: frameNow, uid: mo.uid, attacking: !!mo.attacking, isAir: !!mo.isAir,
        cooldown: mo.cooldown, atkSpeed: mo.atkSpeed,
      });
    const c = { x: c0.x, y: c0.y + motion.dy * view.scale };
    const tier = mo.def.tier;
    const r = bodyRadius(mobKind(tier), view.scale);
    if (z) {
      const g = toScreen(p.x, p.y, 0);
      ctx.fillStyle = 'rgba(0,0,0,.30)';
      ctx.beginPath(); ctx.ellipse(g.x, g.y, r * 0.8, r * 0.35, 0, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(0,0,0,.28)';
      ctx.beginPath(); ctx.ellipse(c.x, c.y + r * 0.72, r * 0.7, r * 0.28, 0, 0, Math.PI * 2); ctx.fill();
    }
    const fill = mo.isAir ? COLORS.air : COLORS.mob[tier] ?? '#c9d6e6';
    const spec = mobSilhouette({ ...mo.def, isAir: mo.isAir || mo.def.isAir });
    // 冲刺：前倾。有 transform 就剪整个身体（含静帧）；假画布没有 transform 时改剪影点。
    // 攻击中不倾，受击斜线那一笔才对得上。速度线在还原之后画，保持水平。
    const sprinting = sprintState(mo.def, m.time).on && !mo.attacking;
    const canShear = sprinting && typeof ctx.transform === 'function';
    const bodySpec = sprinting && !canShear ? { ...spec, parts: leanParts(spec.parts, 0.35) } : spec;
    if (canShear) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.transform(1, 0, -0.35, 1, 0, 0);
      ctx.translate(-c.x, -c.y);
    }
    if (frame && drawSprite(frame, c.x, c.y + r * 0.62, r * 2.5)) {
      // 光环是怪的法术圈，不是英雄光。英雄光只属于英雄。
      if (spec.aura) {
        ctx.strokeStyle = COLORS.aura;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, r * 1.35, r * 1.05, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    } else {
      paintSilhouette(ctx, c.x, c.y, r, bodySpec, {
        fill,
        accent: spec.aura ? COLORS.aura : fill,
      });
    }
    if (canShear) ctx.restore();
    if (sprinting && sprintLeft > 0) {
      const n = Math.min(3, sprintLeft);
      sprintLeft -= n;
      drawGlyphs(sprintStreaks(n).map((g) => ({
        closed: false,
        points: g.points.map(([x, y]) => [c.x + x * r, c.y + y * r]),
      })), '#e7edf4', 1.5);
    }
    const slowed = mo.effects?.some((e) => e.type === 'slow' && !(e.until <= (m.time ?? 0)));
    if (slowed) {
      for (const shard of slowShards(frameNow)) {
        drawGlyphs([{
          closed: true,
          points: shard.map(([x, y]) => [c.x + x * r, c.y + y * r]),
        }], '#bfe9ff', 1.5);
      }
    }
    if ((flashes.get(mo.uid) ?? 0) > frameNow) {
      drawGlyphs(placeGlyphs(hitSlash(1), c.x, c.y, r * 0.85), '#fffaf0', 2);
    }
    bar(c.x, c.y - r - 8, r * 2.2, 4, mo.hp / mo.maxHp, tier === 'boss' ? '#d1503f' : '#8ee08a');
    if (mo.def.armorType === 'fortified') label('盾', c.x, c.y + r + 8, '#c5d0dc', 10);
    if (mo.attacking) label('!', c.x + r, c.y - r, '#ffb4a0', 12);
  }

  /** 怪物的小数格位置：有 `pathIndex` + `dist`（TD 与防守的怪都有）就用亚格位置，否则退回整数格。 */
  const monPos = (m, mo) => (mo.pathIndex != null && Number.isFinite(mo.dist) && m.map.paths[mo.pathIndex])
    ? posAt(m.map.paths[mo.pathIndex], mo.dist) : mo.cell;

  /**
   * 地面上的复活点：石色菱形 + 秒数。不描金、不走技能虚线、不走塔的奶油圈。
   * 只描边，不放粒子，60 与 120 同一条路径。
   */
  function drawReviveMark(m) {
    const pt = revivePoint(m);
    if (!pt) return;
    const c = toScreen(pt.x, pt.y, 0.15);
    const rx = Math.max(14, 16 * view.scale);
    const ry = rx * 0.5;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y - ry);
    ctx.lineTo(c.x + rx, c.y);
    ctx.lineTo(c.x, c.y + ry);
    ctx.lineTo(c.x - rx, c.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(90, 100, 116, .55)';
    ctx.fill();
    ctx.strokeStyle = '#d7e2ec';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = '#8b95a3';
    ctx.lineWidth = 1.5;
    ctx.moveTo(c.x - rx * 0.45, c.y);
    ctx.lineTo(c.x + rx * 0.45, c.y);
    ctx.moveTo(c.x, c.y - ry * 0.55);
    ctx.lineTo(c.x, c.y + ry * 0.55);
    ctx.stroke();
    ctx.lineWidth = 1;
    label(`${Math.ceil(m.hero.reviveTimer ?? 0)}s`, c.x, c.y - ry - 10, '#d7e2ec', 13);
  }

  function drawHero(m, localSlot) {
    const h = m.hero;
    // 人物同样按小数位置画：防守里 `carry` 就是「走向下一格的进度」（相机也用它，见 drawDefense）
    const hp = heroPos(h);
    const c0 = toScreen(hp.x, hp.y, 1.0);
    const pulse = attackPulse(h.cooldown, h.def?.atkSpeed);
    const dead = !!h.dead;
    const moving = !dead && !!(h.path?.length);
    const reviveMax = HERO_REVIVE.sec * (m.reviveMul ?? 1);
    const deathT = dead ? Math.min(1, Math.max(0, (reviveMax - (h.reviveTimer ?? reviveMax)) / DEATH_SEC)) : 0;
    const clip = dead ? 'death' : poseClip({ pulse, attacking: !!h.attacking, moving });
    const index = poseFrame(clip, { now: frameNow, pulse, uid: 1, deathT });
    const base = heroSpriteKey(h.def?.id);
    const frame = resolveSprite(base, clip, index);
    const posed = !!(frame && frame.key !== base);
    const motion = posed
      ? { dx: 0, dy: 0, dissolve: false, pulse }
      : heroMotion({
        now: frameNow, dead, cooldown: h.cooldown, atkSpeed: h.def?.atkSpeed, uid: 1,
      });
    const face = h.facing === 1 ? 1 : -1;
    const c = { x: c0.x + motion.dx * view.scale * face, y: c0.y + motion.dy * view.scale };
    // 英雄是冠军单位，高于精英。倒下时收一截。暖色轮廓只有活着的英雄有。
    const r = bodyRadius('hero', view.scale) * (dead ? 0.82 : 1);
    const fill = dead ? '#5a6474' : (TEAM_COLORS[localSlot % TEAM_COLORS.length] ?? COLORS.hero);
    if (frame && drawSprite(frame, c.x, c.y + r * 0.62, r * 2.6)) {
      ctx.strokeStyle = TEAM_COLORS[localSlot % TEAM_COLORS.length] ?? COLORS.hero;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y + r * 0.55, r * 0.95, r * 0.36, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    } else {
      paintSilhouette(ctx, c.x, c.y, r, heroSilhouette(h.def?.id), {
        fill,
        accent: h.dead ? '#c5ced6' : '#f7fbff',
        stroke: 'rgba(8,14,22,.7)',
      });
    }
    // 暖色轮廓只有英雄有。塔的队伍色在底座环上，不走这一圈。倒下之后光晕也收掉。
    if (!dead) {
      ctx.strokeStyle = HERO_GLOW.halo;
      ctx.lineWidth = HERO_GLOW.haloWidth;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y - r * 0.05, r * HERO_GLOW.haloScale, r * HERO_GLOW.haloScale * 0.78, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = dead ? '#8b95a3' : HERO_GLOW.stroke;
    ctx.lineWidth = HERO_GLOW.lineWidth;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y - r * 0.05, r * 1.05, r * 0.82, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    if (motion.dissolve && !posed) {
      ctx.beginPath();
      ctx.moveTo(c.x - r, c.y);
      ctx.lineTo(c.x + r, c.y);
      ctx.strokeStyle = '#d5dde6';
      ctx.stroke();
    }
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
    const live = new Set(m.projectiles);
    for (const [obj, last] of shotSeen) {
      if (live.has(obj)) continue;
      if (last && impacts.length < frameFx.impacts) impacts.push({ ...last, until: frameNow + 0.26 });
      shotSeen.delete(obj);
    }
    for (let i = impacts.length - 1; i >= 0; i--) {
      if (impacts[i].until <= frameNow) impacts.splice(i, 1);
    }
    const trail = frameFx.trail;
    for (const p of m.projectiles) {
      const cell = p.target?.cell ?? m.map?.core;
      if (!cell) continue;
      const to = toScreen(cell.x, cell.y, 0.8);
      const fromScreen = {
        x: view.ox + p.from.x * view.scale,
        y: view.oy + p.from.y * view.scale,
      };
      const t = Math.min(1, p.progress ?? 0);
      const px = fromScreen.x + (to.x - fromScreen.x) * t;
      const py = fromScreen.y + (to.y - fromScreen.y) * t;
      const kind = shotKind(p.towerId);
      const color = COLORS.tower[p.towerId] ?? (p.stats?.attackType === 'siege' ? '#e0a15c' : '#dbe6f2');
      let dx = px - fromScreen.x;
      let dy = py - fromScreen.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      for (let i = 0; i < trail; i++) {
        const back = i * 9;
        ctx.globalAlpha = 1 - i * 0.28;
        drawGlyphs(shotGlyphs(kind, px - ux * back, py - uy * back, ux, uy, 7 - i), color, kind === 'shell' ? 2.25 : 1.5);
      }
      ctx.globalAlpha = 1;
      if (t >= 0.82) {
        const at = toScreen(cell.x, cell.y, 0.3);
        drawGlyphs(impactGlyphs(kind, at.x, at.y, 11), color, 1.75);
      }
      shotSeen.set(p, { kind, x: cell.x, y: cell.y, color });
    }
    for (const hit of impacts) {
      const at = toScreen(hit.x, hit.y, 0.3);
      const life = Math.max(0, (hit.until - frameNow) / 0.26);
      ctx.globalAlpha = life;
      drawGlyphs(impactGlyphs(hit.kind, at.x, at.y, 8 + (1 - life) * 6), hit.color ?? '#fff4d2', 1.5);
      ctx.globalAlpha = 1;
    }
  }

  function draw(isoView) {
    if (isoView.m?.mode === 'defense') return drawDefense(isoView);
    beginFrame(isoView);
    const { m, selectedSlot, selectedTower, floaters = [], pending = [], hintSlots = 0, localSlot = 0, now = 0, pulses = true, placingTowerId = null } = isoView;
    const grid = m.map?.grid ?? GRID;
    if (grid.w !== GRID.w || grid.h !== GRID.h) resize(grid);   // 4★ 起的大图按自己的尺寸适配镜头
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, view.w, view.h);
    drawTiles(m);
    drawSpawns(m);
    drawSlots(m, selectedSlot);
    drawHintSlots(m, hintSlots, now, pulses);
    // 预测中的塔：半透明鬼影 + 省略号，等服务端快照确认后由真实塔替换（§10.3）
    for (const p of pending) {
      const cell = m.map.slots[p.slot];
      if (!cell) continue;
      const c = toScreen(cell.x, cell.y, 0.9);
      const size = bodyRadius('tower', view.scale, 1);
      ctx.globalAlpha = 0.5;
      drawTowerBody(p.towerId, 1, c.x, c.y, size, {
        fill: COLORS.tower[p.towerId] ?? '#dbe6f2',
        accent: COLORS.tower[p.towerId] ?? '#dbe6f2',
        stroke: '#ffffff',
        lineWidth: 1.5,
      });
      ctx.globalAlpha = 1;
      label('…', c.x, c.y - size * 0.15, '#0b1420', 12);
    }
    drawCore(m);
    trackMonsters(m.monsters, m);
    drawCorpses();

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
    for (const t of m.towers) {
      if (selectedTower === t.slot) drawRangeRing(t.cell, t.stats?.range);
    }
    for (const p of pending) {
      const cell = m.map.slots[p.slot];
      if (cell && TOWERS[p.towerId]) drawRangeRing(cell, towerStatsAt(m.map, cell, p.towerId, 1).range);
    }
    if (placingTowerId && TOWERS[placingTowerId] && selectedSlot != null && !m.towers.some((t) => t.slot === selectedSlot)) {
      const cell = m.map.slots[selectedSlot];
      if (cell) drawRangeRing(cell, towerStatsAt(m.map, cell, placingTowerId, 1).range);
    }
    // 点选英雄之后才给驻守预览和技能圈（和塔的悬停圈同一规矩：先点中，再看范围）。
    if (isoView.heroSelected && !m.hero.dead) {
      drawHoldMarks(m);
      const ability = heroAbilityRange(m.hero);
      if (ability > 0) drawHeroSkillRing(heroPos(m.hero), ability);
    }
    drawReviveMark(m);
    drawFloaters(floaters, now);
  }

  /* ---------- 防守模式：跟随相机 + 野外区 + 基地（§12.5 / §2.6） ---------- */

  function drawDefense(v) {
    beginFrame(v);
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
        const kind = (x + y) % 2 ? 'tileA' : 'tileB';
        if (!paintCell(x, y, kind)) {
          tilePath(x, y);
          ctx.fillStyle = (x + y) % 2 ? COLORS.tileA : COLORS.tileB;
          ctx.fill();
          ctx.strokeStyle = 'rgba(90,140,200,.08)';
          ctx.stroke();
        }
      }
    }

    // 基地围墙。玩家砌的围墙工事单独画成门段，不在这里再盖一层直墙。
    const builtWalls = new Set(
      (m.forts ?? []).filter((f) => f.fortId === 'fort_wall' || !f.stats).map((f) => `${f.cell.x},${f.cell.y}`),
    );
    const wallSize = wallDrawSize(view.scale);
    for (const k of m.walls) {
      if (builtWalls.has(k)) continue;
      const [x, y] = k.split(',').map(Number);
      if (x < bounds.x0 - 1 || x > bounds.x1 + 1 || y < bounds.y0 - 1 || y > bounds.y1 + 1) continue;
      const c = toScreen(x, y, 0.6);
      paintSilhouette(ctx, c.x, c.y, wallSize, wallSilhouette(wallKindAt(m.walls, x, y)), {
        fill: '#5b6b80', stroke: 'rgba(8,14,22,.65)',
      });
    }
    for (const g of [m.def?.base?.gate, m.def?.base?.gate2].filter(Boolean)) {
      if (g.x < bounds.x0 - 1 || g.x > bounds.x1 + 1 || g.y < bounds.y0 - 1 || g.y > bounds.y1 + 1) continue;
      const c = toScreen(g.x, g.y, 0.6);
      paintSilhouette(ctx, c.x, c.y, wallSize, wallSilhouette('gate'), {
        fill: '#6a7c90', stroke: 'rgba(8,14,22,.75)',
      });
    }

    // 城堡
    const cg = toScreen(m.castle.cell.x, m.castle.cell.y, 0);
    ctx.beginPath();
    ctx.ellipse(cg.x, cg.y, (GRID.tileW / 2) * view.scale * 0.92, (GRID.tileH / 2) * view.scale * 0.92, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(127,212,255,.20)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(190,232,255,.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineWidth = 1;
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
        const isWall = built.fortId === 'fort_wall' || !built.stats;
        const size = isWall ? wallDrawSize(view.scale) : fortDrawSize(view.scale);
        if (isWall) {
          paintSilhouette(ctx, c.x, c.y, size, wallSilhouette('gate'), {
            fill: '#6b7a90',
            accent: '#dbe6f2',
            stroke: 'rgba(8,14,22,.65)',
          });
        } else {
          paintSilhouette(ctx, c.x, c.y, size, fortSilhouette('fort_arrow'), {
            fill: '#c5d0dc',
            accent: '#dbe6f2',
            stroke: 'rgba(8,14,22,.65)',
          });
        }
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

    trackMonsters(m.monsters, m);
    drawCorpses();

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

    drawReviveMark(m);
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
