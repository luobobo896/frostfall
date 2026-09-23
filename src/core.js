// 内核：确定性随机、等距投影、路径生成、伤害公式。
// 这一层不依赖 DOM / Canvas，可在 node 里跑自校验（见 tools/selfplay.mjs 与 tests/）。

import { DAMAGE_MATRIX, GRID, STAT_CAPS } from './data.js';

/* ---------- 确定性随机（§7.3：seed = matchId + tick + entityId） ---------- */

export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  const next = function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  // 存档要能续上随机流，否则读档后的掉落与伤害浮动会从头再来（§10.3 的「状态无漂移」）
  next.getState = () => s;
  next.setState = (v) => { s = v >>> 0 || 1; };
  return next;
}

/* ---------- 等距 2:1 投影（§14.1） ---------- */

export function project(gx, gy, z = 0, tileW = GRID.tileW, tileH = GRID.tileH) {
  return {
    x: (gx - gy) * (tileW / 2),
    y: (gx + gy) * (tileH / 2) - z * tileH,
  };
}

/* ---------- 伤害（§7.2） ---------- */

export function armorReduction(armor) {
  return armor >= 0
    ? 1 - (0.06 * armor) / (1 + 0.06 * armor)
    : 1 + 0.06 * Math.abs(armor);
}

export function typeMultiplier(attackType, armorType) {
  const row = DAMAGE_MATRIX[attackType];
  if (!row || !(armorType in row)) throw new Error(`未知攻击/护甲类型: ${attackType} / ${armorType}`);
  return row[armorType];
}

/**
 * §7.2 完整伤害公式。
 * base    = atk × 克制系数[攻击类型][护甲类型]
 * 暴击    = rng < critRate ? base × (1 + critDmg) : base
 * 护甲    = armor × (1 - 穿透)        // §7.3：穿透 = 「无视 X% 护甲」，上限 60%
 * 最终    = 暴击 × 护甲减免(上面那个护甲) × (1 + 增伤) × (1 - 受击减伤) × 浮动(0.95~1.05)
 *
 * 注意：穿透是**削目标护甲**，不是给自己乘一个 (1-穿透) 的减伤。
 * 之前这里照抄了文档 §7.2 那一行 `× (1 - 护甲穿透)`，结果「穿透 +40%」的奥术冲击
 * 反而比不带穿透少打 40% 的伤害，武器上的「护甲穿透」词条等于自残（见验证记录 §58）。
 */
export function computeDamage({
  atk, attackType, armor, armorType,
  critRate = 0, critDmg = 0.5, armorPierce = 0,
  bonus = 0, targetReduce = 0, rng = Math.random,
}) {
  // §7.3 的上限：所有伤害都从这里过，夹在这一个地方就够（暴击率 75%、护甲穿透 60%）
  critRate = Math.min(STAT_CAPS.critRate, critRate);
  armorPierce = Math.min(STAT_CAPS.armorPierce, armorPierce);
  const mult = typeMultiplier(attackType, armorType);
  const base = atk * mult;
  const crit = rng() < critRate;
  const afterCrit = crit ? base * (1 + critDmg) : base;
  const afterArmor = afterCrit * armorReduction(armor * (1 - armorPierce));
  const afterBonus = afterArmor * (1 + bonus) * (1 - targetReduce);
  const swung = afterBonus * (0.95 + rng() * 0.10);
  return { damage: Math.max(1, Math.floor(swung)), crit, multiplier: mult };
}

/**
 * §7.1 范围伤害的距离衰减：落点 100% → 半径边缘 50%（线性）。
 * 三个溅射点（塔的弹道、英雄的法杖、技能的落点）此前各写了一个**固定的 0.75**，
 * 也就是「半径内的怪一律吃 75%」——既不区分远近，也和 §7.1 那句对不上（验证记录 §83）。
 *
 * ponytail: 距离用的是全项目统一的 `gridDist`（曼哈顿），所以 radius=1.5 时实际只会取到
 * d=0（100%）与 d=1（66.7%）两个采样点。要真圆盘就把这里换成欧氏距离，一处改完两个调用点都跟着变。
 */
export function splashScale(dist, radius) {
  const r = Number(radius);
  if (!(r > 0)) return 1;
  return 1 - 0.5 * Math.min(1, Math.max(0, Number(dist) / r));
}

/* ---------- 地图与路径（§2.2 / §2.5 / §14.1） ---------- */

const key = (x, y) => `${x},${y}`;

/**
 * 蛇形路径：横向走到边界后换行，直到指定长度。
 * `stepY` 可以给负数：从地图下半部出发的路径必须往上走，否则第一步就撞边界（
 * 之前的版本固定往下，导致 map_06 从 y=21 出发的两条路只生成了一小段）。
 */
function serpentine(len, { x, y, dir = 1, stepY = 2, band }, g = GRID) {
  const cells = [{ x, y }];
  let cx = x, cy = y, d = dir, s = stepY;
  while (cells.length < len) {
    const nx = cx + d;
    if (nx >= 1 && nx <= g.w - 2) {
      cx = nx; cells.push({ x: cx, y: cy });
      continue;
    }
    let ny = cy + s;
    // 分带时到带边就掉头，蛇形只在自己那条横带里往返（见 buildMap 里的带宽注释）
    if (band && (ny < band.top || ny > band.bot)) { s = -s; ny = cy + s; }
    if (ny >= 1 && ny <= g.h - 2) {
      cy = ny; cells.push({ x: cx, y: cy });
      d = -d;
      continue;
    }
    break; // 地图放不下更多格子
  }
  return cells;
}

/** 从 last 走到 core 的曼哈顿连线（不含起点）。 */
function connector(last, core) {
  const out = [];
  let { x, y } = last;
  while (x !== core.x) { x += Math.sign(core.x - x); out.push({ x, y }); }
  while (y !== core.y) { y += Math.sign(core.y - y); out.push({ x, y }); }
  return out;
}

/** 把连线拉长到指定格数：在接近核心处插入折返段（monster 多走两格）。 */
function padRoute(route, pad) {
  if (pad <= 0) return route;
  const out = [...route];
  const at = Math.max(0, out.length - 2);
  const anchor = out[at] ?? { x: 1, y: 1 };
  const spur = [];
  let added = 0;
  while (added + 2 <= pad) {
    spur.push({ x: Math.min(GRID.w - 2, anchor.x + 1), y: anchor.y });
    spur.push({ x: anchor.x, y: anchor.y });
    added += 2;
  }
  if (added < pad) spur.push({ x: Math.max(1, anchor.x - 1), y: anchor.y });
  out.splice(at, 0, ...spur);
  return out;
}

/**
 * 生成一张地图的运行时数据：1-2 条地面路径 + 可选空中航线 + 显式塔位。
 * 路径总格数严格等于 mapDef.pathLength（§2.2）。
 */
export function buildMap(mapDef) {
  const g = mapDef.grid ?? GRID;   // 4★ 起的大图用更大的画布（§2.2 的长局图）
  const core = mapDef.core;
  const paths = [];
  const spawns = mapDef.spawn;
  // 双核心地图：路径按顺序对半分给两个核心，每条路要走到自己那个核心（不能都走到第一个）
  const coreCells = mapDef.cores ?? [core];
  const perCore = Math.ceil(Math.max(1, mapDef.pathCount) / coreCells.length);
  const coreForPath = (i) => coreCells[Math.min(coreCells.length - 1, Math.floor(i / perCore))];
  const laneCount = Math.max(1, mapDef.pathCount);

  for (let i = 0; i < Math.max(1, mapDef.pathCount); i++) {
    const spawn = spawns[i] ?? spawns[0];
    // 每条路分到自己的「扫描带」：按行均分地图高度，蛇形只在本带内往返。
    // 只错开起点是不够的——蛇形每换行 ±2 会走遍全图，相邻两条路的行互相交错，
    // 塔位全被判给序号靠前的那条（map_06 实测第 4 条路 0 个塔位）。
    const bandH = Math.max(3, Math.floor((g.h - 2) / laneCount));
    const bandTop = Math.min(g.h - 3, 1 + i * bandH);
    const band = { top: bandTop, bot: Math.min(g.h - 2, bandTop + bandH - 1) };
    const dir = spawn.x > g.w / 2 ? -1 : 1;
    const clampX = (v) => Math.min(g.w - 2, Math.max(1, v));
    const xOffset = i % 2 === 0 ? 0 : 6;
    const startX = clampX(dir > 0 ? 1 + xOffset : g.w - 2 - xOffset);
    const y = band.top;
    const stepY = 2;
    const target = coreForPath(i);
    // 出生点 → 扫描带起点 的入场段（出生点通常在地图边缘）
    const entry = connector(spawn, { x: startX, y });
    // 最终 cells = [spawn, ...entry, ...body]，所以要扣掉 spawn 自己那一格
    const bodyTarget = Math.max(12, mapDef.pathLength - entry.length - 1);
    // 先取长蛇形，再挑一个「与核心同列」的截断点，使 蛇形 + 竖直连线 == 目标长度（精确命中）。
    const full = serpentine(Math.max(bodyTarget + 40, 120), { x: startX, y, dir, stepY, band }, g);
    let cells = null;
    let best = null;
    for (let i = 0; i < full.length; i++) {
      const c = full[i];
      if (c.x !== target.x) continue;
      const conn = connector(c, target);
      const total = i + 1 + conn.length;
      if (total > bodyTarget) continue;
      const pad = bodyTarget - total;
      const candidate = [...full.slice(0, i + 1), ...padRoute(conn, pad)];
      if (pad === 0) { cells = candidate; break; }
      // 优先让蛇形走得更长（塔位沿路两侧分布更像经典 TD 图），pad 只作为次级判据
      if (!best || i + 1 > best.cover || (i + 1 === best.cover && pad < best.pad)) {
        best = { pad, cover: i + 1, cells: candidate };
      }
    }
    if (!cells && !best) {
      // 兜底：退化蛇形也要连到该路径的核心，否则怪的终点就错了
      const body = serpentine(Math.max(8, bodyTarget - 20), { x: startX, y, dir, stepY, band }, g);
      const conn = connector(body[body.length - 1], target);
      cells = [...body, ...conn];
      if (cells.length > bodyTarget) cells = [...body.slice(0, Math.max(1, bodyTarget - conn.length)), ...conn];
    }
    cells = cells ?? best?.cells;
    cells = [spawn, ...entry.filter((c, idx) => idx > 0 || c.x !== spawn.x || c.y !== spawn.y), ...cells];
    paths.push({ index: i, spawn, cells, lengthTiles: cells.length, coreIndex: Math.min(coreCells.length - 1, Math.floor(i / perCore)), core: target });
  }

  // 空中航线：从空中出生点直连核心（§2.3）
  if (mapDef.airPath) {
    const spawn = { x: 0, y: 12 };
    const cells = [spawn, ...connector(spawn, core)];
    paths.push({ index: paths.length, spawn, cells, lengthTiles: cells.length, air: true });
  }

  const blocked = new Set();
  for (const p of paths) for (const c of p.cells) blocked.add(key(c.x, c.y));

  const swamp = new Set();
  const lava = new Set();
  const highland = new Set();
  for (const t of mapDef.terrain ?? []) {
    for (const r of t.rects) {
      for (let x = r.x; x < r.x + r.w; x++) {
        for (let y = r.y; y < r.y + r.h; y++) {
          if (t.type === 'swamp') swamp.add(key(x, y));
          else if (t.type === 'lava') lava.add(key(x, y));   // 岩浆：不可建造，且阻挡投射物（§2.3）
          else if (t.type === 'highland') highland.add(key(x, y));   // 高地：可建造，塔吃加成（§2.3）
        }
      }
    }
  }

  /**
   * 塔位：紧邻路径的空地，**按路径轮流分配**。
   * 之前是把所有路的候选按 (x+y) 排序后取前 N 个，结果塔位全落在前两条路附近：
   * map_04 实测三路的覆盖是 19/8/**3**，第三条路等于裸奔。改成轮流分配后每条路都拿得到位置。
   */
  const perPath = paths.filter((p) => !p.air).map((p) => {
    const list = [];
    const seen = new Set();
    for (const c of p.cells) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const x = c.x + dx, y = c.y + dy;
        if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
        if (blocked.has(key(x, y)) || lava.has(key(x, y))) continue;   // 岩浆上不能建塔
        if (seen.has(key(x, y))) continue;
        seen.add(key(x, y));
        list.push({ x, y });
      }
    }
    return list;
  });

  const slots = [];
  const taken = new Set();
  const cursor = perPath.map(() => 0);
  for (const spacing of [2, 1]) {
    let progressed = true;
    while (slots.length < mapDef.towerSlots && progressed) {
      progressed = false;
      for (let pi = 0; pi < perPath.length && slots.length < mapDef.towerSlots; pi++) {
        while (cursor[pi] < perPath[pi].length) {
          const c = perPath[pi][cursor[pi]++];
          if (taken.has(key(c.x, c.y))) continue;
          if (slots.some((s) => Math.abs(s.x - c.x) + Math.abs(s.y - c.y) < spacing)) continue;
          slots.push(c);
          taken.add(key(c.x, c.y));
          progressed = true;
          break;
        }
      }
    }
    if (slots.length >= mapDef.towerSlots) break;
  }

  return { def: mapDef, grid: g, paths, core, cores: coreCells, slots, swamp, lava, highland, blocked };
}

/** 投射物是否被岩浆挡住（§2.3：炮塔不能跨岩浆）。 */
export function blockedByLava(map, from, to) {
  if (!map.lava?.size) return false;
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  if (steps === 0) return false;
  for (let i = 1; i < steps; i++) {
    const x = Math.round(from.x + (to.x - from.x) * (i / steps));
    const y = Math.round(from.y + (to.y - from.y) * (i / steps));
    if (map.lava.has(`${x},${y}`)) return true;
  }
  return false;
}

/** 按行进距离（世界单位）求当前格坐标。 */
export function cellAt(path, distUnits) {
  const perTile = GRID.unitPerTile;
  const idx = Math.min(path.cells.length - 1, Math.floor(distUnits / perTile));
  return path.cells[idx];
}

/**
 * §10.3「客户端渲染插值」在原型里的形态：**用内核本来就有的亚格数据渲染**，不再把位置塌回整数格。
 *
 * 怪物的 `dist` 一直是连续量（快照里也按 1/8 格量化下发：`DIST_Q = 16`），
 * 但渲染与相机此前都只用 `cell`——一格 64px，怪每走完一格才动一次（300 速 = 每 0.4 秒跳一格），
 * 单机与联机都看得见这个「跳格」。整格判定（射程 / 仇恨 / 寻路）**继续用 `cell`，不动**，
 * 这里只提供一个给渲染用的小数位置。
 */
export function posAt(path, distUnits) {
  const perTile = GRID.unitPerTile;
  const idx = Math.min(path.cells.length - 1, Math.max(0, Math.floor(distUnits / perTile)));
  const from = path.cells[idx];
  const to = path.cells[Math.min(path.cells.length - 1, idx + 1)];
  return lerpCell(from, to, Math.min(1, Math.max(0, (distUnits - idx * perTile) / perTile)));
}

/** 两格之间按进度插值（`t` 夹在 0-1）。 */
export const lerpCell = (from, to, t) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });

/**
 * 人物的小数格位置：`cell` + 沿「正在走向的那一格」的进度 `carry`（防守模式才有）。
 * 相机也跟着它走——否则人物平滑了、镜头还在跳格，反而更明显。
 */
export const heroPos = (h) => (h.path?.length ? lerpCell(h.cell, h.path[0], Math.min(1, Math.max(0, h.carry ?? 0))) : h.cell);

export const pathTotalUnits = (path) => path.cells.length * GRID.unitPerTile;

/** 格坐标的曼哈顿距离（射程 / 仇恨判定用）。 */
export const gridDist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/* ---------- 寻路（防守模式：人物/怪要在地图上跑，TD 的固定路径不适用） ---------- */

const octile = (dx, dy) => (dx > dy ? dx - dy + 1.41421 * dy : dy - dx + 1.41421 * dx);

/**
 * A* 八方向寻路，禁止穿墙角。返回不含起点的格列表；无路返回 null。
 * 地图规模（64×48）下足够快，且只需要在指令/换目标时算一次。
 */
export function findPath(w, h, start, goal, isBlocked, maxNodes = 8000) {
  const keyOf = (x, y) => y * w + x;
  const startK = keyOf(start.x, start.y);
  const goalK = keyOf(goal.x, goal.y);
  if (startK === goalK) return [];
  if (isBlocked(goal.x, goal.y)) return null;   // 目标本身不可通行（比如围墙上没门的格子）
  const open = [{ x: start.x, y: start.y, g: 0, f: octile(Math.abs(goal.x - start.x), Math.abs(goal.y - start.y)) }];
  const came = new Map();
  const gScore = new Map([[startK, 0]]);
  const closed = new Set();
  let expanded = 0;

  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, 1.41421], [1, -1, 1.41421], [-1, 1, 1.41421], [-1, -1, 1.41421]];

  while (open.length) {
    // 小规模地图：线性取最小 f 就够，省掉堆实现
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bestIdx].f) bestIdx = i;
    const cur = open.splice(bestIdx, 1)[0];
    const curK = keyOf(cur.x, cur.y);
    if (curK === goalK) {
      const path = [];
      let k = curK;
      while (k !== startK) {
        path.push({ x: k % w, y: Math.floor(k / w) });
        k = came.get(k);
        if (k === undefined) break;
      }
      return path.reverse();
    }
    if (closed.has(curK)) continue;
    closed.add(curK);
    if (++expanded > maxNodes) return null;

    for (const [dx, dy, cost] of DIRS) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (isBlocked(nx, ny)) continue;
      // 斜向不允许穿墙角（否则怪会从围墙缝里挤过去）
      if (dx && dy && (isBlocked(cur.x + dx, cur.y) || isBlocked(cur.x, cur.y + dy))) continue;
      const nk = keyOf(nx, ny);
      if (closed.has(nk)) continue;
      const g = cur.g + cost;
      if (g < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, g);
        came.set(nk, curK);
        open.push({ x: nx, y: ny, g, f: g + octile(Math.abs(goal.x - nx), Math.abs(goal.y - ny)) });
      }
    }
  }
  return null;
}
