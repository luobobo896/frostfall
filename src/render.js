// 等距 2:1 渲染（§14.1）。静帧按 docs/art/DIRECTION.md 热替换；缺图或没加载完就画 P0 剪影。

import { DEFENSE_MAPS, FORTS, GRID, HERO_REVIVE, MAPS, MONSTERS, QUALITY, TEAM_COLORS, TOWERS } from './data.js';
import { buildMap, heroPos, posAt, project } from './core.js';
import { defenseLook, heroAbilityRange, heroDetectRadius, heroMaxHp, heroStats, holdCells, LEVEL_FLOURISH_SEC, revivePoint, sprintState, stealthView, supportAuraRange, towerStatsAt } from './match.js';
import { isLowHp } from './hud-model.js';
import { viewport } from './platform.js';   // §平台适配：像素比在两个环境里的取法不同
import { heroSpriteKey, mobSpriteKey, resolveSprite, tileSpriteKey, towerSpriteKey } from './assets.js';
import {
  DEATH_SEC, attackPulse, chargePulse, fxBudget, heroMotion, hitSlash, impactGlyphs, leanParts, mobMotion,
  levelFlourish, poseClip, poseFrame, shotGlyphs, shotKind, slowShards, sprintStreaks, stealthGlyphs, towerMarks, towerNudge,
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

/**
 * 路径层的明度带：出生暗、终点亮。关掉装饰贴图之后车道仍能读出走向。
 * 两端是固定色，中间才插值，测试可以对准端点。
 */
const PATH_BAND = {
  ground: ['#2a3442', '#d5dee8'],
  air: ['#1c3344', '#c5e4f2'],
};

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export function colorLuma(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function pathBandColor(t, kind = 'ground') {
  const pair = PATH_BAND[kind] ?? PATH_BAND.ground;
  const u = Math.max(0, Math.min(1, Number(t) || 0));
  if (u <= 0) return pair[0];
  if (u >= 1) return pair[1];
  const a = hexToRgb(pair[0]);
  const b = hexToRgb(pair[1]);
  const rgb = a.map((v, i) => Math.round(v + (b[i] - v) * u));
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 每格走到终点的比例。地面路径盖过空中（同一格两条线时车道以地面为准）。 */
export function pathProgressOf(map) {
  const prog = new Map();
  const ground = new Set();
  const air = new Set();
  for (const p of map?.paths ?? []) {
    const cells = p.cells ?? [];
    const n = Math.max(1, cells.length - 1);
    cells.forEach((c, i) => {
      const k = `${c.x},${c.y}`;
      const t = cells.length <= 1 ? 1 : i / n;
      const prev = prog.get(k);
      if (prev == null || t > prev) prog.set(k, t);
      if (p.air) air.add(k);
      else ground.add(k);
    });
  }
  return { prog, ground, air };
}

const bandCache = new WeakMap();
function cachedBands(map) {
  if (!map) return pathProgressOf(null);
  let hit = bandCache.get(map);
  if (!hit) {
    hit = pathProgressOf(map);
    bandCache.set(map, hit);
  }
  return hit;
}

/**
 * 入口是门洞（两根柱 + 门楣 + 中间空着），出口是实心石台。
 * 空中入口是一根杆加一个环。三者轮廓不同，不靠换色。
 */
export function lanePropSilhouette(kind = 'entrance') {
  if (kind === 'exit') {
    return {
      id: 'exit',
      parts: [
        { role: 'step', points: [[-1.05, 0.55], [1.05, 0.55], [1.05, 0.28], [-1.05, 0.28]], closed: true },
        { role: 'step', points: [[-0.72, 0.28], [0.72, 0.28], [0.72, 0.02], [-0.72, 0.02]], closed: true },
        { role: 'stone', points: [[-0.34, 0.02], [0.34, 0.02], [0.2, -1.45], [-0.2, -1.45]], closed: true },
        { role: 'cap', points: [[-0.48, -1.45], [0.48, -1.45], [0.48, -1.68], [-0.48, -1.68]], closed: true },
      ],
    };
  }
  if (kind === 'air') {
    return {
      id: 'air',
      parts: [
        { role: 'post', points: [[-0.1, 0.5], [0.1, 0.5], [0.1, -0.7], [-0.1, -0.7]], closed: true },
        { role: 'ring', ellipse: [0, -1.15, 0.55, 0.38], strokeOnly: true },
      ],
    };
  }
  return {
    id: 'entrance',
    parts: [
      { role: 'pier', points: [[-0.95, 0.5], [-0.52, 0.5], [-0.52, -0.85], [-0.95, -0.85]], closed: true },
      { role: 'pier', points: [[0.52, 0.5], [0.95, 0.5], [0.95, -0.85], [0.52, -0.85]], closed: true },
      { role: 'lintel', points: [[-1.08, -0.85], [1.08, -0.85], [1.08, -1.18], [-1.08, -1.18]], closed: true },
      { role: 'banner', points: [[-0.16, -0.85], [0.16, -0.85], [0.12, -0.35], [0, -0.22], [-0.12, -0.35]], closed: true },
    ],
  };
}

/**
 * 等距里，前排身体盖住后一格单位的比例（0..1）。
 * 脚在屏幕上隔半格（tileH/2）。只给 Lv3 塔和 Boss 用：超过约四成才把身体画透、塔再压低一档。
 */
export const OCCLUSION_LIMIT = 0.4;
export const OCCLUSION_ALPHA = 0.58;

export function isoOcclusionRatio(frontPx, backPx, tileH = GRID.tileH) {
  const gap = tileH / 2;
  const overlap = Math.max(0, Math.min(0, -gap) - Math.max(-frontPx, -gap - backPx));
  return backPx > 0 ? overlap / backPx : 0;
}

export function shouldEaseOcclusion(frontKind, frontLevel = 1, backKind = 'creep') {
  const tall = frontKind === 'boss' || (frontKind === 'tower' && frontLevel >= 3);
  if (!tall) return false;
  const frontPx = frontKind === 'tower'
    ? BODY_PX.tower[Math.min(3, Math.max(1, Math.round(frontLevel))) - 1]
    : BODY_PX.boss;
  const backPx = BODY_PX[backKind] ?? BODY_PX.creep;
  return isoOcclusionRatio(frontPx, backPx) > OCCLUSION_LIMIT;
}

/** 小地图上要画的英雄点。多人在线不在这批里；有 `heroes` 就多画几个点。 */
export function laneHeroes(m) {
  const list = [];
  if (m?.hero) list.push(m.hero);
  for (const h of m?.heroes ?? []) {
    if (h && h !== m.hero) list.push(h);
  }
  return list;
}

/**
 * 下一波从哪个入口进来。清场、打完、没有地面路时不画箭头。
 * 出怪中指向「下一只」要用的那条路，而不是永远指第一条。
 */
export function nextInvasion(m) {
  if (!m?.map || m.result) return null;
  const phase = m.wave?.phase;
  const index = m.wave?.index ?? 0;
  const totalWaves = m.waves?.length ?? 0;
  if (phase === 'clearing' || phase == null) return null;
  if (phase === 'prep' && index >= totalWaves) return null;
  if (phase === 'spawning' && (m.wave.spawned ?? 0) >= (m.wave.total ?? 0)) return null;
  const paths = (m.map.paths ?? []).filter((p) => !p.air && p.spawn && p.cells?.length);
  if (!paths.length) return null;
  const spawned = phase === 'spawning' ? (m.wave.spawned ?? 0) : 0;
  const path = paths[spawned % paths.length];
  const spawn = path.spawn;
  const next = path.cells[Math.min(path.cells.length - 1, 1)];
  return { spawn, next, pathIndex: path.index, urgent: !!path.urgent };
}

/** 同一支入侵箭头。备战期多路各画一支，出怪中只留「下一只」那条。 */
export function invasionArrows(m) {
  const one = nextInvasion(m);
  if (!one) return [];
  if (m.wave?.phase !== 'prep') return [one];
  const paths = (m.map.paths ?? []).filter((p) => !p.air && p.spawn && p.cells?.length);
  if (paths.length <= 1) return [one];
  return paths.slice(0, LANE_MINI_BUDGET.maxPaths).map((path) => ({
    spawn: path.spawn,
    next: path.cells[Math.min(path.cells.length - 1, 1)],
    pathIndex: path.index,
    urgent: !!path.urgent,
  }));
}

/** 折线抽点。小地图不逐格填矩形。 */
export const LANE_MINI_BUDGET = Object.freeze({
  maxPaths: 8,
  maxPoints: 40,
  stroke: 5,
  heroR: 6,
  arrow: 16,
  creeps: 24,
  towers: 48,
});

export function decimateCells(cells, maxPoints = LANE_MINI_BUDGET.maxPoints) {
  if (!cells?.length) return [];
  if (cells.length <= maxPoints) return cells;
  const out = [];
  const step = (cells.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) out.push(cells[Math.round(i * step)]);
  return out;
}

const r3 = (n) => Math.round(n * 1000) / 1000;

/** 暖色轮廓只画在英雄身上。塔用队伍色底座环，怪的光环是另一色。 */
export const HERO_GLOW = { stroke: '#ffd68a', lineWidth: 3, halo: 'rgba(255, 214, 138, .35)', haloWidth: 7, haloScale: 1.42 };
/** 英雄技能圈：虚线、冷色、不填奶油底，和塔的射程圈分开。 */
export const HERO_SKILL_RING = { stroke: '#7ec8ff', lineWidth: 1.5, dash: [5, 4] };
/** 侦测圈：灰白虚线加四角括号，不填奶油底，和射程实线圈、技能冷色圈都分开。 */
export const DETECT_RING = { stroke: '#d5dde8', lineWidth: 1.75, dash: [2, 6] };
/** 寒霜光环：实线冷蓝，不虚线、不填奶油。低特效只停呼吸，圈本身还在。 */
export const AURA_RING = { stroke: '#9fd4ff', lineWidth: 2.5, fill: 'rgba(159, 212, 255, .14)' };
/** 燎野焦土：实线暖褐，内圈收成地面一块。低特效只停呼吸，圈本身还在。 */
export const SCORCH_RING = { stroke: '#e7a15a', lineWidth: 2.5, fill: 'rgba(231, 161, 90, .16)' };
/** 风暴电笼：实线浅紫，外圈加左右两道弧。低特效只停呼吸，圈本身还在。 */
export const STORM_RING = { stroke: '#d7b3ff', lineWidth: 2.5, fill: 'rgba(215, 179, 255, .16)' };
/** 穿云箭楼：两条风线加两端风标，不是圆圈。低特效只停呼吸，线本身还在。 */
export const WIND_RING = { stroke: '#b6f3d4', lineWidth: 2.5, fill: 'rgba(182, 243, 212, .16)' };
/** 急路：暖色折线、暖色箭头、一个「急」字。不是按钮。 */
export const URGENT_LANE = '#e7a15a';
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
export function towerSilhouette(towerId, level = 1, spec = null) {
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
    // 燎野炮台：石炉比炮墩更宽，炮管加粗，两侧排烟口。不是把炮口再伸长一截。
    if (spec === 'scorch_hearth') {
      parts.push(
        { role: 'hearth', points: [[-1.62, 0.82], [1.22, 0.82], [1.05, 0.48], [-1.45, 0.48]], closed: true },
        { role: 'vent', points: [[-1.48, 0.48], [-1.16, 0.48], [-1.2, -0.38], [-1.52, -0.24]], closed: true },
        { role: 'vent', points: [[0.82, 0.48], [1.16, 0.48], [1.1, -0.16], [0.76, -0.02]], closed: true },
        { role: 'barrel', points: [[0.04, 0.14], [1.26, 0.14], [1.26, -0.52], [0.04, -0.52]], closed: true },
      );
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
    // 寒霜祭坛：石环比水晶簇更宽，两侧立石是建筑体量，不是换一个图标
    if (spec === 'frost_shrine') {
      parts.push(
        { role: 'plinth', points: [[-1.35, 0.62], [1.35, 0.62], [1.15, 0.28], [-1.15, 0.28]], closed: true },
        { role: 'menhir', points: [[-1.28, 0.28], [-0.96, 0.28], [-1.02, -0.62], [-1.22, -0.48]], closed: true },
        { role: 'menhir', points: [[0.96, 0.28], [1.28, 0.28], [1.22, -0.48], [1.02, -0.62]], closed: true },
      );
    }
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
    // 风暴电笼：笼架比电杆更宽，两侧线圈塔尖，再加一对更开的电弧。不是把杆再拔高一截。
    if (spec === 'storm_cage') {
      parts.push(
        { role: 'cage', points: [[-1.42, 0.72], [1.42, 0.72], [1.18, 0.42], [-1.18, 0.42]], closed: true },
        { role: 'cage', points: [[-1.22, 0.42], [-0.96, 0.42], [-1.02, -1.35], [-1.22, -1.18]], closed: true },
        { role: 'cage', points: [[0.96, 0.42], [1.22, 0.42], [1.22, -1.18], [1.02, -1.35]], closed: true },
        { role: 'cage', points: [[-1.08, -1.52], [-1.22, -1.28], [1.22, -1.28], [1.08, -1.52]], closed: true },
        { role: 'spire', points: [[-0.82, 0.28], [-0.52, 0.28], [-0.58, -1.72], [-0.86, -1.48]], closed: true },
        { role: 'spire', points: [[0.52, 0.28], [0.82, 0.28], [0.86, -1.48], [0.58, -1.72]], closed: true },
        { role: 'arc', points: [[-0.2, -0.9], [-0.95, -0.35], [-0.55, 0.15], [-1.35, 0.42]], closed: false },
        { role: 'arc', points: [[0.2, -0.78], [0.98, -0.22], [0.58, 0.22], [1.38, 0.48]], closed: false },
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
    // 穿云箭楼：女墙再拔高，中间两道射孔，左右风标高出屋顶。不是把 Lv3 垛口再放大一圈。
    if (spec === 'cloud_keep') {
      parts.push(
        { role: 'battlement', points: [[-1.12, -0.42], [-0.72, -0.42], [-0.72, -1.52], [-1.12, -1.52]], closed: true },
        { role: 'battlement', points: [[0.72, -0.42], [1.12, -0.42], [1.12, -1.52], [0.72, -1.52]], closed: true },
        { role: 'slit', points: [[-0.42, -0.5], [-0.28, -0.5], [-0.28, -1.22], [-0.42, -1.22]], closed: true },
        { role: 'slit', points: [[0.28, -0.5], [0.42, -0.5], [0.42, -1.22], [0.28, -1.22]], closed: true },
        { role: 'vane', points: [[-0.95, -1.42], [-0.7, -1.42], [-1.22, -1.98], [-1.38, -1.78]], closed: true },
        { role: 'vane', points: [[0.7, -1.42], [0.95, -1.42], [1.38, -1.78], [1.22, -1.98]], closed: true },
      );
    }
  }
  return { id: towerId, level: lv, parts };
}

/**
 * 怪的剪影按特性，不按「再画一颗椭圆」。
 * 优先级：Boss 星形 > 空中（菱形身 + 翼，翼宽过身，不靠抬高认）> 死亡分裂双圆 > 霜壳（圆块 + 外圈）> 重甲/攻城方块 > 地面带角的身体。
 * `aura` 是叠加上去的外环，不把 Boss 或地面怪改成另一种身体。
 */
export function mobSilhouette(def = {}) {
  const boss = def.tier === 'boss' || !!def.bossTier;
  const air = !!def.isAir;
  const split = !!def.onDeath;
  const ward = ['normal', 'pierce', 'siege'].some((k) => {
    const n = Number(def.resist?.[k]);
    return n > 0 && n < 1;
  });
  const fortified = def.armorType === 'fortified' || !!def.siege;
  const aura = !!def.aura;
  let shape = 'ground';
  if (boss) shape = 'boss';
  else if (air) shape = 'air';
  else if (split) shape = 'split';
  else if (ward) shape = 'ward';
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
  } else if (shape === 'ward') {
    parts = [
      { role: 'body', ellipse: [0, 0.02, 0.42, 0.55] },
      { role: 'rim', ellipse: [0, 0.02, 0.62, 0.82], strokeOnly: true },
      { role: 'crystal', points: [[0.08, -1.05], [-0.16, -0.18], [0.28, -0.12]], closed: true },
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
export function fortSilhouette(fortId = 'fort_arrow', tier = 0) {
  if (fortId === 'fort_wall') return wallSilhouette('gate');
  const parts = [
    { role: 'pier', points: [[-0.78, 0.28], [-0.34, 0.28], [-0.34, -0.18], [-0.78, -0.18]], closed: true },
    { role: 'pier', points: [[0.34, 0.28], [0.78, 0.28], [0.78, -0.18], [0.34, -0.18]], closed: true },
    { role: 'lintel', points: [[-0.84, -0.18], [0.84, -0.18], [0.84, -0.36], [-0.84, -0.36]], closed: true },
    { role: 'merlon', points: [[-0.74, -0.36], [-0.46, -0.36], [-0.46, -0.62], [-0.74, -0.62]], closed: true },
    { role: 'merlon', points: [[0.46, -0.36], [0.74, -0.36], [0.74, -0.62], [0.46, -0.62]], closed: true },
    { role: 'roof', points: [[-0.4, -0.56], [0, -0.7], [0.4, -0.56]], closed: true },
  ];
  if ((tier | 0) >= 1) {
    // 哨楼：两侧望柱比门楼更宽更高，中间一根尖垛。仍然矮于 TD 箭塔。
    parts.push(
      { role: 'watch', points: [[-1.12, 0.42], [-0.82, 0.42], [-0.82, -0.95], [-1.12, -0.95]], closed: true },
      { role: 'watch', points: [[0.82, 0.42], [1.12, 0.42], [1.12, -0.95], [0.82, -0.95]], closed: true },
      { role: 'watch', points: [[-0.16, -0.62], [0.16, -0.62], [0.16, -1.05], [-0.16, -1.05]], closed: true },
    );
  }
  return { id: 'fort_arrow', tier: (tier | 0) >= 1 ? 1 : 0, parts };
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
  let frameLow = false;
  let flourishLevel = null;
  let frameFx = fxBudget('high');
  let sprintLeft = frameFx.sprint ?? 0;
  let invisLeft = frameFx.invis ?? 0;
  const poses = new Map();
  const flashes = new Map();
  const corpses = [];
  const shotSeen = new Map();
  const impacts = [];

  /** 镜像端不跑 grantExp。等级往上跳的那一帧补上同一段光环。 */
  function noteChampionLevel(m) {
    if (m?.mode !== 'defense' || !m.hero) return;
    const lv = m.hero.level ?? 1;
    if (flourishLevel != null && lv > flourishLevel) {
      const until = (m.time ?? 0) + LEVEL_FLOURISH_SEC;
      if ((m.hero.levelPulseUntil ?? 0) < until) m.hero.levelPulseUntil = until;
    }
    flourishLevel = lv;
  }

  function beginFrame(isoView) {
    frameNow = isoView.now ?? 0;
    frameLow = isoView.fx === 'low' || isoView.pulses === false;
    frameFx = fxBudget(isoView.fx);
    sprintLeft = frameFx.sprint ?? 0;
    invisLeft = frameFx.invis ?? 0;
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

  function drawTowerBody(towerId, level, cx, cy, size, style, frame, spec = null) {
    // 专精阶没有自己的静帧。用 Lv3 那张图会把加宽的石环、石炉盖掉，所以这一阶只画剪影。
    if (!spec) {
      const sprite = frame === undefined
        ? resolveSprite(towerSpriteKey(towerId, level), 'idle', 0)
        : frame;
      if (sprite && drawSprite(sprite, cx, cy + size * 0.5, size * 2.4)) return;
    }
    paintSilhouette(ctx, cx, cy, size, towerSilhouette(towerId, level, spec), style);
  }

  function drawTiles(m, decor) {
    const g = m.map?.grid ?? GRID;
    const bands = cachedBands(m.map);
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        const key = `${x},${y}`;
        const onPath = m.map.blocked.has(key);
        const swamp = m.map.swamp.has(key);
        const lava = m.map.lava?.has(key);
        const c = toScreen(x, y);
        if (onPath) {
          // 路径层永远是出生→终点的明度带。装饰贴图只能淡淡盖一层，关装饰时这层还在。
          const lane = bands.ground.has(key) ? 'ground' : 'air';
          const edge = terrainPaint('path');
          tilePath(x, y);
          ctx.fillStyle = pathBandColor(bands.prog.get(key) ?? 0, lane);
          ctx.fill();
          if (decor) {
            const frame = resolveSprite(tileSpriteKey('path'), 'idle', 0);
            if (frame?.image) {
              ctx.globalAlpha = 0.18;
              const tw = GRID.tileW * view.scale;
              const th = GRID.tileH * view.scale;
              ctx.drawImage(frame.image, c.x - tw / 2, c.y - th / 2, tw, th);
              ctx.globalAlpha = 1;
            }
          }
          tilePath(x, y);
          ctx.strokeStyle = edge.stroke;
          ctx.lineWidth = edge.lineWidth;
          ctx.stroke();
          ctx.lineWidth = 1;
          if (decor && (x + y) % 3 === 0) label('·', c.x, c.y, 'rgba(12,18,28,.45)', 14);
          continue;
        }
        const kind = lava ? 'lava' : swamp ? 'swamp' : ((x + y) % 2 ? 'tileA' : 'tileB');
        const paint = terrainPaint(kind);
        if (!(decor && paintCell(x, y, kind))) {
          tilePath(x, y);
          ctx.fillStyle = paint.fill;
          ctx.fill();
          // 沼泽噪点是装饰。低档不画，免得和车道抢明度。
          if (decor && swamp && !lava && (x * 3 + y) % 2 === 0) {
            ctx.fillStyle = 'rgba(168,214,176,.55)';
            const s = Math.max(1, 1.6 * view.scale);
            ctx.fillRect(c.x - 3 * view.scale, c.y - s, s, s);
            ctx.fillRect(c.x + 4 * view.scale, c.y + 2 * view.scale, s, s);
          }
        }
        tilePath(x, y);
        ctx.strokeStyle = paint.stroke;
        ctx.lineWidth = paint.lineWidth;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
  }

  /** 入口门洞、出口石台。关装饰也画：这是路标，不是地块花纹。 */
  function drawLaneProps(m) {
    const seen = new Set();
    const size = Math.max(16, 22 * view.scale);
    for (const p of m.map?.paths ?? []) {
      const s = p.spawn;
      if (!s) continue;
      const key = `${s.x},${s.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const c = toScreen(s.x, s.y, 0.15);
      const air = !!p.air;
      paintSilhouette(ctx, c.x, c.y, size, lanePropSilhouette(air ? 'air' : 'entrance'), air
        ? { fill: '#3c4a5a', accent: '#9ad8ff', stroke: '#141c28', lineWidth: 1.5 }
        : { fill: '#6b5340', accent: '#c4b49a', stroke: '#1c140e', lineWidth: 1.5 });
      if (p.urgent && !air) label('急路', c.x, c.y - size * 1.15, URGENT_LANE, Math.max(11, Math.round(12 * view.scale)));
    }
    const cores = m.cores?.length ? m.cores : (m.core ? [m.core] : []);
    for (const core of cores) {
      const cell = core.cell ?? core;
      if (cell?.x == null) continue;
      const c = toScreen(cell.x, cell.y, 0);
      paintSilhouette(ctx, c.x, c.y, size * 1.08, lanePropSilhouette('exit'), {
        fill: '#c5ced6', accent: '#24303c', stroke: '#24303c', lineWidth: 1.5,
      });
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

  /** 这一帧站在格子上的单位。后一格有人，高塔/Boss 才变透。 */
  const stood = new Set();
  const coversBehind = (cell) => {
    if (!cell) return false;
    const x = Math.round(cell.x);
    const y = Math.round(cell.y);
    return stood.has(`${x - 1},${y}`) || stood.has(`${x},${y - 1}`);
  };

  function drawTower(m, t, selected, localSlot) {
    const ghost = t.level >= 3 && coversBehind(t.cell) && shouldEaseOcclusion('tower', t.level, 'creep');
    // 挡住后一格时把塔压低（少抬一截），身体再透一点。血条和队伍环保持不透。
    const c = toScreen(t.cell.x, t.cell.y, ghost ? 0.15 : 0.9);
    const color = COLORS.tower[t.towerId] ?? '#dbe6f2';
    const size = bodyRadius('tower', view.scale, t.level);
    const pulse = attackPulse(t.cooldown, t.stats?.atkSpeed);
    const charge = chargePulse(t.cooldown, t.stats?.atkSpeed);
    const clip = poseClip({ pulse, dead: t.hp <= 0 });
    const index = poseFrame(clip, { now: frameNow, pulse, uid: t.uid ?? 0 });
    const specId = t.spec || null;
    const base = towerSpriteKey(t.towerId, t.level);
    const frame = specId ? null : resolveSprite(base, clip, index);
    const posed = !!(frame && frame.key !== base);
    const nudge = posed ? { dx: 0, dy: 0 } : towerNudge(t.towerId, pulse);
    const bx = c.x + nudge.dx * view.scale;
    const by = c.y + nudge.dy * view.scale;
    if (ghost) ctx.globalAlpha = OCCLUSION_ALPHA;
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath(); ctx.ellipse(c.x, c.y + size * 0.5, size * 0.9, size * 0.4, 0, 0, Math.PI * 2); ctx.fill();
    drawTowerBody(t.towerId, t.level, bx, by, size, {
      fill: color,
      accent: color,
      stroke: selected ? '#8ee08a' : 'rgba(10,20,30,.6)',
      lineWidth: selected ? 2.5 : 1,
    }, frame, specId);
    const marks = posed ? [] : towerMarks(t.towerId, pulse, charge);
    if (marks.length) drawGlyphs(placeGlyphs(marks, bx, by - size * 0.2, view.scale), color, 1.5);
    if (ghost) ctx.globalAlpha = 1;
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

  /** 侦测圈比射程大一圈：虚线外环、实线内环、四角括号。低特效也画，这是操作信息。 */
  function drawDetectRing(cell, range) {
    if (!cell || !(Number(range) > 0)) return;
    const c = toScreen(cell.x, cell.y, 0);
    const rx = range * (GRID.tileW / 2) * view.scale;
    const ry = range * (GRID.tileH / 2) * view.scale;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.setLineDash(DETECT_RING.dash);
    ctx.strokeStyle = DETECT_RING.stroke;
    ctx.lineWidth = DETECT_RING.lineWidth;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, rx * 0.82, ry * 0.82, 0, 0, Math.PI * 2);
    ctx.strokeStyle = DETECT_RING.stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
    const brackets = [
      [[-1, -0.72], [-1, -1], [-0.72, -1]],
      [[0.72, -1], [1, -1], [1, -0.72]],
      [[1, 0.72], [1, 1], [0.72, 1]],
      [[-0.72, 1], [-1, 1], [-1, 0.72]],
    ];
    ctx.beginPath();
    for (const b of brackets) {
      ctx.moveTo(c.x + b[0][0] * rx, c.y + b[0][1] * ry);
      ctx.lineTo(c.x + b[1][0] * rx, c.y + b[1][1] * ry);
      ctx.lineTo(c.x + b[2][0] * rx, c.y + b[2][1] * ry);
    }
    ctx.strokeStyle = DETECT_RING.stroke;
    ctx.lineWidth = DETECT_RING.lineWidth;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  /** 寒霜光环：实线冷蓝椭圆。选中时加一层淡填充。低特效不呼吸，圈仍在。 */
  function drawAuraRing(cell, range, { selected = false, alpha = 0.92 } = {}) {
    if (!cell || !(Number(range) > 0)) return;
    const c = toScreen(cell.x, cell.y, 0);
    const rx = range * (GRID.tileW / 2) * view.scale;
    const ry = range * (GRID.tileH / 2) * view.scale;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
    if (selected) {
      ctx.fillStyle = AURA_RING.fill;
      ctx.fill();
    }
    ctx.globalAlpha = selected ? 1 : alpha;
    ctx.setLineDash([]);
    ctx.strokeStyle = AURA_RING.stroke;
    ctx.lineWidth = selected ? AURA_RING.lineWidth + 1 : AURA_RING.lineWidth;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }

  /** 焦土：实线暖褐，里面再收一圈，读成地面一块。选中时加淡填充。低特效不呼吸。 */
  function drawScorchRing(cell, range, { selected = false, alpha = 0.92 } = {}) {
    if (!cell || !(Number(range) > 0)) return;
    const c = toScreen(cell.x, cell.y, 0);
    const rx = range * (GRID.tileW / 2) * view.scale;
    const ry = range * (GRID.tileH / 2) * view.scale;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
    if (selected) {
      ctx.fillStyle = SCORCH_RING.fill;
      ctx.fill();
    }
    ctx.globalAlpha = selected ? 1 : alpha;
    ctx.setLineDash([]);
    ctx.strokeStyle = SCORCH_RING.stroke;
    ctx.lineWidth = selected ? SCORCH_RING.lineWidth + 1 : SCORCH_RING.lineWidth;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, rx * 0.58, ry * 0.58, 0, 0, Math.PI * 2);
    ctx.lineWidth = SCORCH_RING.lineWidth;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }

  /** 雷场：实线浅紫外圈，左右两道弧。选中时外圈加淡填充。低特效不呼吸。 */
  function drawStormRing(cell, range, { selected = false, alpha = 0.92 } = {}) {
    if (!cell || !(Number(range) > 0)) return;
    const c = toScreen(cell.x, cell.y, 0);
    const rx = range * (GRID.tileW / 2) * view.scale;
    const ry = range * (GRID.tileH / 2) * view.scale;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
    if (selected) {
      ctx.fillStyle = STORM_RING.fill;
      ctx.fill();
    }
    ctx.globalAlpha = selected ? 1 : alpha;
    ctx.setLineDash([]);
    ctx.strokeStyle = STORM_RING.stroke;
    ctx.lineWidth = selected ? STORM_RING.lineWidth + 1 : STORM_RING.lineWidth;
    ctx.stroke();
    const bow = Math.min(rx, ry) * 0.72;
    ctx.lineWidth = STORM_RING.lineWidth;
    ctx.beginPath();
    ctx.arc(c.x, c.y, bow, Math.PI * 0.85, Math.PI * 1.55);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c.x, c.y, bow, -Math.PI * 0.15, Math.PI * 0.55);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }

  /** 风线：两条平行实线，两端各一道风标。选中时中间加一层淡填。低特效不呼吸。 */
  function drawWindLine(cell, reach, { selected = false, alpha = 0.92 } = {}) {
    if (!cell || !(Number(reach) > 0)) return;
    const c = toScreen(cell.x, cell.y, 0);
    const rx = reach * (GRID.tileW / 2) * view.scale;
    const gap = Math.max(3, Math.min(rx, reach * (GRID.tileH / 2) * view.scale) * 0.16);
    ctx.setLineDash([]);
    ctx.strokeStyle = WIND_RING.stroke;
    ctx.globalAlpha = selected ? 1 : alpha;
    if (selected) {
      ctx.beginPath();
      ctx.moveTo(c.x - rx, c.y);
      ctx.lineTo(c.x, c.y - gap * 1.6);
      ctx.lineTo(c.x + rx, c.y);
      ctx.lineTo(c.x, c.y + gap * 1.6);
      ctx.closePath();
      ctx.fillStyle = WIND_RING.fill;
      ctx.fill();
    }
    ctx.lineWidth = selected ? WIND_RING.lineWidth + 1 : WIND_RING.lineWidth;
    ctx.beginPath();
    ctx.moveTo(c.x - rx, c.y - gap);
    ctx.lineTo(c.x + rx, c.y - gap);
    ctx.moveTo(c.x - rx, c.y + gap);
    ctx.lineTo(c.x + rx, c.y + gap);
    ctx.stroke();
    ctx.lineWidth = WIND_RING.lineWidth;
    ctx.beginPath();
    ctx.moveTo(c.x - rx, c.y - gap * 2.4);
    ctx.lineTo(c.x - rx + gap * 1.4, c.y);
    ctx.lineTo(c.x - rx, c.y + gap * 2.4);
    ctx.moveTo(c.x + rx, c.y - gap * 2.4);
    ctx.lineTo(c.x + rx - gap * 1.4, c.y);
    ctx.lineTo(c.x + rx, c.y + gap * 2.4);
    ctx.stroke();
    ctx.globalAlpha = 1;
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
    const veil = stealthView(m, mo);
    const veiled = veil === 'ghost' || veil === 'faint';
    const fill = veiled ? '#a8b2be' : (mo.isAir ? COLORS.air : COLORS.mob[tier] ?? '#c9d6e6');
    const spec = mobSilhouette({ ...mo.def, isAir: mo.isAir || mo.def.isAir });
    const ghost = tier === 'boss' && !mo.isAir && coversBehind(p) && shouldEaseOcclusion('boss', 1, 'creep');
    if (ghost) ctx.globalAlpha = OCCLUSION_ALPHA;
    if (veiled) ctx.globalAlpha = veil === 'ghost' ? 0.45 : 0.72;
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
    if (!veiled && frame && drawSprite(frame, c.x, c.y + r * 0.62, r * 2.5)) {
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
        accent: veiled || spec.shape === 'ward' ? '#e7edf4' : (spec.aura ? COLORS.aura : fill),
        stroke: veiled ? '#e7edf4' : undefined,
      });
    }
    if (canShear) ctx.restore();
    if (ghost || veiled) ctx.globalAlpha = 1;
    if (veil !== 'none' && invisLeft > 0) {
      const glyphs = stealthGlyphs(veil, invisLeft);
      invisLeft -= glyphs.length;
      if (glyphs.length) {
        drawGlyphs(glyphs.map((g) => ({
          closed: false,
          points: g.points.map(([x, y]) => [c.x + x * r, c.y + y * r]),
        })), '#e7edf4', 1.5);
      }
    }
    if (veiled) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#e7edf4';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, r * 1.08, r * 0.82, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }
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
    bar(c.x, c.y - r - 8, r * 2.2, 4, mo.hp / mo.maxHp, veiled ? '#d5dde8' : (tier === 'boss' ? '#d1503f' : '#8ee08a'));
    if (mo.def.armorType === 'fortified') label('盾', c.x, c.y + r + 8, '#c5d0dc', 10);
    if (spec.shape === 'ward') label('壳', c.x, c.y + r + 8, '#e7edf4', 10);
    if (mo.attacking) label('!', c.x + r, c.y - r, '#ffb4a0', 12);
  }

  /** 怪物的小数格位置：有 `pathIndex` + `dist`（TD 与防守的怪都有）就用亚格位置，否则退回整数格。 */
  const monPos = (m, mo) => (mo.pathIndex != null && Number.isFinite(mo.dist) && m.map.paths[mo.pathIndex])
    ? posAt(m.map.paths[mo.pathIndex], mo.dist) : mo.cell;

  function noteUnits(m) {
    stood.clear();
    for (const mo of m.monsters ?? []) {
      if (mo.dead) continue;
      const p = monPos(m, mo);
      stood.add(`${Math.round(p.x)},${Math.round(p.y)}`);
    }
    for (const h of laneHeroes(m)) {
      if (!h || h.dead || !h.cell) continue;
      const p = heroPos(h);
      stood.add(`${Math.round(p.x)},${Math.round(p.y)}`);
    }
  }

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
    const look = m.mode === 'defense' && !dead ? defenseLook(m, heroStats(h).range) : null;
    const moving = !dead && !!(h.path?.length);
    const reviveMax = HERO_REVIVE.sec * (m.reviveMul ?? 1);
    const deathT = dead ? Math.min(1, Math.max(0, (reviveMax - (h.reviveTimer ?? reviveMax)) / DEATH_SEC)) : 0;
    const clip = dead ? 'death' : poseClip({ pulse, attacking: !!h.attacking || !!look?.target, moving });
    const index = poseFrame(clip, { now: frameNow, pulse, uid: 1, deathT });
    const base = heroSpriteKey(h.def?.id);
    const frame = resolveSprite(base, clip, index);
    const posed = !!(frame && frame.key !== base);
    const motion = posed
      ? { dx: 0, dy: 0, dissolve: false, pulse }
      : heroMotion({
        now: frameNow, dead, cooldown: h.cooldown, atkSpeed: h.def?.atkSpeed, uid: 1,
      });
    const face = look ? look.facing : (h.facing === 1 ? 1 : -1);
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
    const flourish = !dead && m.mode === 'defense'
      ? levelFlourish(h.levelPulseUntil, m.time ?? 0, { low: frameLow, sec: LEVEL_FLOURISH_SEC })
      : null;
    if (flourish) {
      ctx.save();
      ctx.globalAlpha = flourish.alpha;
      ctx.strokeStyle = '#e7edf4';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y + r * 0.35, r * flourish.scale, r * flourish.scale * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      ctx.lineWidth = 1;
    }
    if (motion.dissolve && !posed) {
      ctx.beginPath();
      ctx.moveTo(c.x - r, c.y);
      ctx.lineTo(c.x + r, c.y);
      ctx.strokeStyle = '#d5dde6';
      ctx.stroke();
    }
    const max = Math.max(1, heroMaxHp(h));
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
    const decor = isoView.decor !== false && isoView.fx !== 'low';
    drawTiles(m, decor);
    drawLaneProps(m);
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
    noteUnits(m);

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
      if (selectedTower === t.slot) {
        drawRangeRing(t.cell, t.stats?.range);
        const detect = t.stats?.special?.detectRadius;
        if (detect > 0) drawDetectRing(t.cell, detect);
      }
    }
    for (const p of pending) {
      const cell = m.map.slots[p.slot];
      if (cell && TOWERS[p.towerId]) {
        const stats = towerStatsAt(m.map, cell, p.towerId, 1);
        drawRangeRing(cell, stats.range);
        if (stats.special?.detectRadius > 0) drawDetectRing(cell, stats.special.detectRadius);
      }
    }
    if (placingTowerId && TOWERS[placingTowerId] && selectedSlot != null && !m.towers.some((t) => t.slot === selectedSlot)) {
      const cell = m.map.slots[selectedSlot];
      if (cell) {
        const stats = towerStatsAt(m.map, cell, placingTowerId, 1);
        drawRangeRing(cell, stats.range);
        if (stats.special?.detectRadius > 0) drawDetectRing(cell, stats.special.detectRadius);
      }
    }
    // 点选英雄之后才给驻守预览和技能圈（和塔的悬停圈同一规矩：先点中，再看范围）。
    // 圣徒的脚底光环就是这一圈：点中才画。没点中不另铺一圈，免得和「先点中再看范围」打架。
    if (isoView.heroSelected && !m.hero.dead) {
      drawHoldMarks(m);
      const ability = heroAbilityRange(m.hero);
      if (ability > 0) drawHeroSkillRing(heroPos(m.hero), ability);
    }
    const heroDetect = heroDetectRadius(m);
    if (heroDetect > 0) drawDetectRing(heroPos(m.hero), heroDetect);
    const ringStill = isoView.fx === 'low' || pulses === false;
    for (const t of m.towers) {
      const aura = t.stats?.special?.aura;
      if (!(aura?.radius > 0)) continue;
      const alpha = ringStill ? 0.92 : (0.78 + 0.18 * Math.sin((now || 0) * 3));
      drawAuraRing(t.cell, aura.radius, { selected: selectedTower === t.slot, alpha });
    }
    for (const t of m.towers) {
      const scorch = t.stats?.special?.scorch;
      if (!(scorch?.radius > 0)) continue;
      const alpha = ringStill ? 0.92 : (0.78 + 0.18 * Math.sin((now || 0) * 3));
      drawScorchRing(t.cell, scorch.radius, { selected: selectedTower === t.slot, alpha });
    }
    for (const t of m.towers) {
      const storm = t.stats?.special?.storm;
      if (!(storm?.radius > 0)) continue;
      const alpha = ringStill ? 0.92 : (0.78 + 0.18 * Math.sin((now || 0) * 3));
      drawStormRing(t.cell, storm.radius, { selected: selectedTower === t.slot, alpha });
    }
    for (const t of m.towers) {
      const wind = t.stats?.special?.wind;
      if (!(wind?.reach > 0)) continue;
      const alpha = ringStill ? 0.92 : (0.78 + 0.18 * Math.sin((now || 0) * 3));
      const reach = t.stats?.range > 0 ? Math.min(wind.reach, t.stats.range) : wind.reach;
      drawWindLine(t.cell, reach, { selected: selectedTower === t.slot, alpha });
    }
    drawReviveMark(m);
    drawFloaters(floaters, now);
  }

  /* ---------- 防守模式：跟随相机 + 野外区 + 基地（§12.5 / §2.6） ---------- */

  function drawDefense(v) {
    beginFrame(v);
    const { m, floaters = [], now = 0, selectedFortSlot = null } = v;
    noteChampionLevel(m);
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
        const decor = v.decor !== false && v.fx !== 'low';
        if (!(decor && paintCell(x, y, kind))) {
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
          paintSilhouette(ctx, c.x, c.y, size, fortSilhouette('fort_arrow', built.tier ?? 0), {
            fill: '#c5d0dc',
            accent: '#dbe6f2',
            stroke: selectedFortSlot === i ? '#ffd68a' : 'rgba(8,14,22,.65)',
            lineWidth: selectedFortSlot === i ? 2.5 : 1,
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
    noteUnits(m);

    if (!m.hero.dead) {
      const aura = supportAuraRange(m.hero);
      if (aura > 0) drawHeroSkillRing(heroPos(m.hero), aura);
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
    for (const f of m.forts ?? []) {
      if (f.stats?.detectRadius > 0) drawDetectRing(f.cell, f.stats.detectRadius);
    }
    if (selectedFortSlot != null && !m.forts.some((f) => f.slot === selectedFortSlot)) {
      const slot = m.def.fortSlots[selectedFortSlot];
      const preview = FORTS.fort_arrow?.detectRadius;
      if (slot && preview > 0) drawDetectRing(slot, preview);
    }
    const heroDetect = heroDetectRadius(m);
    if (heroDetect > 0) drawDetectRing(heroPos(m.hero), heroDetect);

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
    for (const mo of m.monsters) {
      const kind = mo.dead ? 'none' : stealthView(m, mo);
      if (kind === 'ghost' || kind === 'faint') {
        const p = toMinimap(mo.cell.x, mo.cell.y);
        ctx.beginPath();
        ctx.strokeStyle = '#d5dde8';
        ctx.lineWidth = 1;
        if (kind === 'ghost') ctx.setLineDash([1.5, 1.5]);
        ctx.arc(p.x, p.y, mo.tier === 'boss' ? 3 : 1.8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        dot(mo.cell.x, mo.cell.y, mo.tier === 'boss' ? 3 : 1.8, mo.isAir ? '#9ad8ff' : '#e06a5c');
        if (mo.def?.resist) {
          const p = toMinimap(mo.cell.x, mo.cell.y);
          ctx.beginPath();
          ctx.strokeStyle = '#e7edf4';
          ctx.lineWidth = 1.25;
          ctx.arc(p.x, p.y, (mo.tier === 'boss' ? 3 : 1.8) + 1.6, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
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

/**
 * TD 小地图：路径折线、英雄点、下一波入口箭头。
 * 不扫整张格子。折线按地图缓存，每帧只描这几条线和几个圆。60 与 120 同一条函数。
 */
export function createLaneMinimap(canvas, { size = null } = {}) {
  const ctx = canvas.getContext('2d');
  const PAD = 8;
  const view = { s: 1, ox: PAD, oy: PAD, w: 0, h: 0 };
  let cacheKey = '';
  let cached = [];

  function layoutFor(m) {
    const dpr = Math.min(2, viewport().dpr || 1);
    const measured = size ? size() : null;
    const grid = m.map?.grid ?? GRID;
    const w = measured ? measured.w : (canvas.clientWidth || canvas.width || 168);
    const h = measured ? measured.h : (canvas.clientHeight || canvas.height || 122);
    const pw = Math.floor(w * dpr);
    const ph = Math.floor(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    view.w = w;
    view.h = h;
    view.s = Math.min((w - PAD * 2) / grid.w, (h - PAD * 2) / grid.h);
    view.ox = (w - grid.w * view.s) / 2;
    view.oy = (h - grid.h * view.s) / 2;
  }

  const toMini = (x, y) => ({ x: view.ox + (x + 0.5) * view.s, y: view.oy + (y + 0.5) * view.s });

  function linesFor(m) {
    const paths = m.map?.paths ?? [];
    const key = paths.map((p) => `${p.index}:${p.cells?.length ?? 0}:${p.air ? 1 : 0}:${p.urgent ? 1 : 0}`).join(',');
    if (key === cacheKey) return cached;
    cacheKey = key;
    cached = [];
    for (let i = 0; i < paths.length && cached.length < LANE_MINI_BUDGET.maxPaths; i++) {
      const p = paths[i];
      if (!p.cells?.length) continue;
      cached.push({ air: !!p.air, urgent: !!p.urgent, pts: decimateCells(p.cells) });
    }
    return cached;
  }

  function cellAt(sx, sy, m) {
    if (m) layoutFor(m);
    const grid = m?.map?.grid ?? GRID;
    const x = Math.round((sx - view.ox) / view.s - 0.5);
    const y = Math.round((sy - view.oy) / view.s - 0.5);
    return {
      x: Math.max(0, Math.min(grid.w - 1, x)),
      y: Math.max(0, Math.min(grid.h - 1, y)),
    };
  }

  const dot = (x, y, r, fill) => {
    const p = toMini(x, y);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  const ring = (x, y, r, stroke) => {
    const p = toMini(x, y);
    ctx.beginPath();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.25;
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
  };

  /** 和下一波箭头同一套三角，不另做一种标记。 */
  const drawArrow = (cue) => {
    const head = toMini(cue.spawn.x, cue.spawn.y);
    const nxt = toMini(cue.next.x, cue.next.y);
    let dx = nxt.x - head.x;
    let dy = nxt.y - head.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const size = LANE_MINI_BUDGET.arrow;
    const tailX = head.x - dx * size;
    const tailY = head.y - dy * size;
    const wing = size * 0.42;
    ctx.fillStyle = cue.urgent ? URGENT_LANE : '#e7edf4';
    ctx.beginPath();
    ctx.moveTo(head.x, head.y);
    ctx.lineTo(tailX + -dy * wing, tailY + dx * wing);
    ctx.lineTo(tailX - -dy * wing, tailY - dx * wing);
    ctx.closePath();
    ctx.fill();
  };

  function draw(m, opts = {}) {
    layoutFor(m);
    ctx.fillStyle = 'rgba(9,15,24,.92)';
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const line of linesFor(m)) {
      const pts = line.pts;
      if (pts.length < 2) continue;
      ctx.beginPath();
      const p0 = toMini(pts[0].x, pts[0].y);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i++) {
        const p = toMini(pts[i].x, pts[i].y);
        ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = line.air ? '#9ad8ff' : (line.urgent ? URGENT_LANE : '#d5dee8');
      ctx.lineWidth = line.air ? 2.5 : LANE_MINI_BUDGET.stroke;
      if (line.air) ctx.setLineDash([3, 3]);
      ctx.stroke();
      if (line.air) ctx.setLineDash([]);
    }
    ctx.lineWidth = 1;
    for (const path of (m.map?.paths ?? []).slice(0, LANE_MINI_BUDGET.maxPaths)) {
      if (!path.spawn) continue;
      ring(path.spawn.x, path.spawn.y, 4.5, path.air ? '#9ad8ff' : (path.urgent ? URGENT_LANE : '#e7edf4'));
    }
    const cores = m.cores?.length ? m.cores : (m.core ? [m.core] : []);
    for (const core of cores) {
      const cell = core.cell ?? core;
      if (cell?.x == null) continue;
      dot(cell.x, cell.y, 4.2, '#7fd4ff');
    }
    const towers = m.towers ?? [];
    for (let i = 0; i < towers.length && i < LANE_MINI_BUDGET.towers; i++) {
      const t = towers[i];
      if (!t?.cell) continue;
      dot(t.cell.x, t.cell.y, 2.2, TEAM_COLORS[(t.owner ?? 0) % TEAM_COLORS.length]);
    }
    const low = opts.fx === 'low';
    const creeps = low ? [] : (m.monsters ?? []).filter((mo) => mo && !mo.dead && mo.cell);
    const cap = LANE_MINI_BUDGET.creeps;
    const step = Math.max(1, Math.ceil(creeps.length / cap));
    for (let i = 0, drawn = 0; i < creeps.length && drawn < cap; i += step) {
      const mo = creeps[i];
      if (mo.def?.invis) continue;
      dot(mo.cell.x, mo.cell.y, mo.def?.tier === 'boss' ? 2.4 : 1.3, mo.isAir ? '#9ad8ff' : '#e06a5c');
      drawn += 1;
    }
    let stealthMarks = 0;
    for (const mo of m.monsters ?? []) {
      if (stealthMarks >= 12 || mo.dead || !mo.cell) continue;
      const kind = stealthView(m, mo);
      if (kind !== 'ghost' && kind !== 'faint' && kind !== 'revealed') continue;
      const at = toMini(mo.cell.x, mo.cell.y);
      ctx.beginPath();
      ctx.strokeStyle = '#e7edf4';
      ctx.lineWidth = 1;
      if (kind === 'ghost') ctx.setLineDash([2, 2]);
      ctx.arc(at.x, at.y, 2.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      stealthMarks += 1;
    }
    let wardMarks = 0;
    for (const mo of m.monsters ?? []) {
      if (wardMarks >= 12 || mo.dead || !mo.cell || !mo.def?.resist) continue;
      const at = toMini(mo.cell.x, mo.cell.y);
      ctx.beginPath();
      ctx.strokeStyle = '#e7edf4';
      ctx.lineWidth = 1.25;
      ctx.arc(at.x, at.y, 3.1, 0, Math.PI * 2);
      ctx.stroke();
      wardMarks += 1;
    }
    for (const cue of invasionArrows(m)) drawArrow(cue);
    ctx.fillStyle = URGENT_LANE;
    ctx.font = '600 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (const path of (m.map?.paths ?? []).slice(0, LANE_MINI_BUDGET.maxPaths)) {
      if (!path.urgent || !path.spawn) continue;
      const at = toMini(path.spawn.x, path.spawn.y);
      ctx.fillText('急', at.x + 8, at.y - 2);
    }
    const heroes = laneHeroes(m);
    heroes.forEach((h, i) => {
      if (!h) return;
      const hold = h.hold;
      const here = h.cell ? heroPos(h) : null;
      if (hold && here && (hold.x !== here.x || hold.y !== here.y)) {
        const at = toMini(hold.x, hold.y);
        const s = 4;
        ctx.beginPath();
        ctx.moveTo(at.x, at.y - s);
        ctx.lineTo(at.x + s, at.y);
        ctx.lineTo(at.x, at.y + s);
        ctx.lineTo(at.x - s, at.y);
        ctx.closePath();
        ctx.strokeStyle = '#f0d59a';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (!here) return;
      const at = toMini(here.x, here.y);
      ctx.fillStyle = h.dead ? '#8b95a3' : (TEAM_COLORS[i % TEAM_COLORS.length] ?? '#8ee08a');
      ctx.beginPath();
      ctx.arc(at.x, at.y, h.dead ? 4 : LANE_MINI_BUDGET.heroR, 0, Math.PI * 2);
      ctx.fill();
    });
    const grid = m.map?.grid ?? GRID;
    ctx.strokeStyle = 'rgba(120,140,170,.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(view.ox, view.oy, grid.w * view.s, grid.h * view.s);
  }

  return {
    draw,
    cellAt,
    toMini,
    get size() { return { w: view.w, h: view.h, scale: view.s }; },
  };
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
