// 防守生存模式（§12.5 / §2.6）：基地 + 野外区，人物出城打怪掉装备、回防守城堡。
// 复用 TD 内核的伤害 / 技能 / 装备 / 掉落 / 英雄成长；新增的是移动寻路、营地刷怪、回防调度、基地工事。

import {
  DEFENSE_MAPS, DEFENSE_RULES, DIFFICULTY, DROP_TABLE, EQUIP_SLOTS, FORTS, GRID, HEROES, HERO_REGEN, HERO_REVIVE,
  MONSTERS, QUALITY_ORDER, TICK_STEP,
} from './data.js';
import { computeDamage, findPath, gridDist, makeRng, project } from './core.js';
import { damageMonster, grantExp, heroAttack, heroDamageReduce, heroDodge, heroMaxHp, heroStats, makeEquipment, stepMonsterEffects, updateHeroBuffs } from './match.js';

const key = (x, y) => `${x},${y}`;

/* ---------- 建局 ---------- */

export function createDefenseMatch({
  mapId = 'def_01', difficulty = 'normal', heroId = 'hero_warrior',
  players = 1, seed = 20260922, reviveMul = 1,   // §3.6：人物等级的复活加速
} = {}) {
  const def = DEFENSE_MAPS[mapId];
  if (!def) throw new Error(`未知防守地图: ${mapId}`);
  if (!HEROES[heroId]) throw new Error(`未知英雄: ${heroId}`);
  const rng = makeRng(seed);
  const { w, h } = def.grid;

  // 基地围墙：基地矩形边框去掉门那一格，其余算阻挡（寻路与怪都得绕门）
  const walls = new Set();
  const b = def.base;
  const gates = [b.gate, b.gate2].filter(Boolean).map((g) => key(g.x, g.y));
  for (let x = b.x; x < b.x + b.w; x++) {
    for (let y = b.y; y < b.y + b.h; y++) {
      const onEdge = x === b.x || x === b.x + b.w - 1 || y === b.y || y === b.y + b.h - 1;
      if (onEdge && !gates.includes(key(x, y))) walls.add(key(x, y));
    }
  }
  // 已建的围墙工事会往 walls 里加；这里先放静态墙
  const isBlocked = (x, y) => walls.has(key(x, y));

  const m = {
    mode: 'defense',
    def, mapId, difficulty, heroId, players,
    reviveMul,   // §3.6：复活时间倍率（人物等级越高越小）
    diff: DIFFICULTY[difficulty],
    rng,
    seed,
    spawnCounter: 0,
    time: 0,
    grid: def.grid,
    walls,
    isBlocked,
    gold: 300,
    lumber: Array.from({ length: Math.max(1, players) }, () => 0),
    castle: { hp: def.castleHp, maxHp: def.castleHp, cell: { ...def.castle } },
    hero: {
      def: HEROES[heroId],
      level: 1, exp: 0, hp: HEROES[heroId].hp,
      cell: { x: def.castle.x, y: def.castle.y },
      path: [], goal: null, cooldown: 0, skillCd: [0, 0, 0],
      skillUnlocked: [true, false, false], buffs: [],
      attackBuff: 0, reduceBuff: 0, dead: false, reviveTimer: 0, moving: false,
      teleportCd: 0,   // 回城冷却（§2.6）
    },
    monsters: [],          // 野外怪 + 进攻怪
    forts: [],             // 基地工事（箭塔 / 围墙）
    projectiles: [],
    groundItems: [],       // 地上未拾取的装备
    camps: def.camps.map((c) => ({ ...c, timer: DEFENSE_RULES.campIntervalSec * rng(), alive: 0 })),
    assault: { round: 0, timer: DEFENSE_RULES.assaultIntervalSec, warning: false, endless: false },
    bag: {}, scrolls: 0, potionCd: {}, shopBought: {}, bookLevelBonus: 0,
    // STATUS §3.1 #20（已拍板）：群体治疗符撤柜——「全队治疗」要等「每人一个英雄」（#13，M3），
    // 现在它严格不如大药（200 金回 300 vs 120 金回 500）。防守这边同样登记禁售。
    shopBlocked: { pot_group: '全队治疗要等「每人一个英雄」；现在它严格不如大药（200 金回 300 vs 120 金回 500）' },
    /**
     * STATUS §3.1 #14（已拍板）：**商店在基地里**（§5.5 原话是「基地内」）。内核不认模式，
     * 只认这个字段：`{x, y, r}` = 「商店在这儿」。半径取基地外接圆再放大 25%——「基地内 + 门口
     * 那一圈」都算，免得玩家贴在墙边却买不了。
     */
    shopNear: (() => {
      const b = def.base;
      const cx = b.x + (b.w - 1) / 2, cy = b.y + (b.h - 1) / 2;
      return { x: cx, y: cy, r: Math.max(b.w, b.h) * 0.75 };
    })(),
    inventory: [], equipped: { weapon: null, armor: null, trinket: null },
    stats: { kills: 0, fieldKills: 0, normalKills: 0, goldEarned: 0, drops: 0, crafts: 0, castleHits: 0, roundsCleared: 0, damage: {} },
    result: null,
    events: [],
  };
  addLog(m, '出城打野、升级换装；预警响起就回防城堡');
  m.hero.equipped = m.equipped;   // §5.2 / §5.4：英雄属性读身上的装备（与 TD 同一个约定）
  m.onMonsterKilled = (mon) => onMonsterKilled(m, mon);   // 接到内核的击杀回调（§12.5 的掉落/经验规则）
  return m;
}

export const addLog = (m, text, kind = 'info') => { m.events.push({ t: +m.time.toFixed(1), text, kind }); };

export function defenseHeroStats(m) { return heroStats(m.hero); }

/* ---------- 移动 ---------- */

/** 点地移动：算出路径后沿路径走；重复点击直接换目标。 */
export function orderMove(m, goal) {
  const { w, h } = m.grid;
  if (goal.x < 0 || goal.y < 0 || goal.x >= w || goal.y >= h) return false;
  if (m.isBlocked(goal.x, goal.y)) return false;
  const from = m.hero.cell;
  if (from.x === goal.x && from.y === goal.y) { m.hero.path = []; m.hero.goal = null; return true; }
  const path = findPath(w, h, from, goal, m.isBlocked);
  if (!path) return false;
  m.hero.path = path;
  m.hero.goal = { ...goal };
  return true;
}

/**
 * 摇杆方向 → 目标格（§10.1：摇杆与点地移动下发**同一条**移动指令，所以这里只算那个格子，
 * 交给调用方走 orderMove / net.move —— 与「点地移动」是同一个出口）。
 * 调用方每帧用**当前格**做原点重发，目标格随之前滑，于是「按住一个方向」是连续移动，不是走两步就停。
 * 贴上墙时别原地卡死：斜着撞墙就退化成只走主轴（推着摇杆沿墙滑）。
 */
export function steerGoal(m, dir, tiles = 2) {
  if (!dir || dir.mag < 0.25) return null;
  const from = m.hero.cell;
  const at = (dx, dy) => {
    const g = { x: from.x + dx, y: from.y + dy };
    if (g.x < 0 || g.y < 0 || g.x >= m.grid.w || g.y >= m.grid.h) return null;
    return m.isBlocked(g.x, g.y) ? null : g;
  };
  const gx = Math.round(dir.x * tiles), gy = Math.round(dir.y * tiles);
  return at(gx, gy) ?? at(gx, 0) ?? at(0, gy);
}

export const UNITS_PER_TILE = GRID.unitPerTile;
const TILE_SPEED = (moveSpeed) => moveSpeed / UNITS_PER_TILE;   // 移速 → 格/秒

function stepHero(m, dt) {
  const h = m.hero;
  // §147：**别在这里扣回城冷却**——`updateDefense()` 的「英雄：技能冷却 / 回血 / 自动普攻」那一段
  // 已经扣过一次了（跟 skillCd / potionCd 排在一起）。两处都扣 = 冷却走得是两倍快：
  // §2.6 写的是 30 秒，实测 15 秒就能再回城一次（§135 那张职责表查的是「两边漏没漏」，
  // 查不出「两边各做了一遍」——那次是漏，这次是重）。
  // §134：buff 的到期与派生值（attackBuff / reduceBuff / windBuff）走和 TD 同一个出口——
  // 防守这边以前漏了这一遍：buff 永不失效，而且 §133 之后加成的重算也不会发生（战吼/药剂/结界全哑）
  updateHeroBuffs(h, m.time);
  if (h.dead || !h.path.length) { h.moving = false; return; }
  // §7.6 赶路补偿：复活后 10 秒内移速 +50%（防守模式的人物真的在跑图，这个补偿才有意义）
  const fast = (h.fastUntil ?? 0) > m.time ? 1 + HERO_REVIVE.fastPct : 1;
  // §134：疾风步的「移速 +50%」以前**从来没有被读过**（`speedPct` 只写进 buff 就没人管）——
  // 而这个技能恰恰是在防守模式里用的（人物要跑图）
  const wind = 1 + (h.windBuff?.speedPct ?? 0);
  const speed = TILE_SPEED(h.def.moveSpeed) * fast * wind * dt;
  h.carry = (h.carry ?? 0) + speed;
  while (h.carry >= 1 && h.path.length) {
    h.carry -= 1;
    h.cell = h.path.shift();
  }
  h.moving = h.path.length > 0;
  if (!h.path.length) h.goal = null;
}

/**
 * 回城（§2.6）：点击小地图回基地，冷却 30 秒。
 * 这是「出城打野 → 回防」闭环的必需品：预警只有 30 秒，靠两条腿从最远野外区跑回来是不够的。
 */
export function teleportHome(m) {
  const h = m.hero;
  if (h.dead) return false;
  const onCooldown = (h.teleportCd ?? 0) > 0;
  // §5.5.1 回城卷轴：冷却中也能走，但它只负责「把你送回去」，不会把 30 秒冷却清零
  // （否则 3 张卷轴 = 3 次免费回城，等于把 §2.6 的冷却设计删了）。
  if (onCooldown) {
    if (!(m.scrolls > 0)) return false;
    m.scrolls -= 1;
  }
  h.cell = { x: m.castle.cell.x - 2, y: m.castle.cell.y };   // 落在基地门前，不压城堡格
  h.path = [];
  h.goal = null;
  h.moving = false;
  if (!onCooldown) h.teleportCd = DEFENSE_RULES.teleportCooldownSec;
  addLog(m, onCooldown ? `用回城卷轴回基地（剩 ${m.scrolls}）` : '回城');
  return true;
}

/**
 * §2.6 的**实体传送点**：地图上那 2-3 个「野外 ↔ 基地」的传送点，走上去就回基地。
 * 以前它们只是 `render.js` 画的一个小圆点——数据与渲染都在，走上去什么也不会发生。
 * 两条设计取舍：
 *  1. **不占回城的 30 秒冷却**：传送点的代价是「先跑过去」，那不是按钮；
 *  2. 落地后**锁住落点那个传送点**，直到英雄离开它——否则站上去就会被来回传送。
 */
function stepTeleports(m) {
  const h = m.hero;
  if (h.dead) return;
  // **必须站定才算**：只是路过（还有路要走）不触发。
  // 原因很实际：传送点就铺在去野外营地的路上，走过去就传送会让「出城打野」变得莫名其妙
  // （第一版就是这么写的，三条营地用例当场红）。想用就把它设成目的地，走过去。
  if (h.moving || (h.path ?? []).length) return;
  const pads = m.def.teleports ?? [];
  const on = pads.findIndex((p) => p.x === h.cell.x && p.y === h.cell.y);
  if (on < 0) { h.padLock = null; return; }        // 离开传送点 → 解锁
  if (h.padLock === on) return;                    // 就是刚落到的那一个：别自己传自己
  const to = m.castle.cell;
  h.cell = { x: to.x, y: to.y };
  h.path = [];
  h.goal = null;
  h.moving = false;
  h.padLock = pads.findIndex((p) => p.x === to.x && p.y === to.y);   // 落点若也是传送点，同样锁住
  addLog(m, `踩上传送点（${on + 1}/${pads.length}），回到基地`);
}

/** 用走的从当前位置回城堡要多少秒（验收「30 秒预警够不够」用）。 */
export function secondsToWalkHome(m) {
  const path = findPath(m.grid.w, m.grid.h, m.hero.cell, m.castle.cell, m.isBlocked);
  if (!path) return Infinity;
  const tiles = path.length || 1;
  return tiles / TILE_SPEED(m.hero.def.moveSpeed);
}

/* ---------- 野外营地（§2.6：每 30 秒刷一波，玩家靠近才激活） ---------- */

/**
 * 把出怪坐标夹进地图。
 * 为什么必须夹：出怪位会沿 ±1 格散开（避免所有怪叠在同一格），而防守图的出怪点有的
 * **就在边界上**（def_02 / def_03 的 `x = 63`、def_03 的 `y = 0`），再加 1-2 格就跑出图了。
 * 出图之后 `findPath` 直接返回 null → `mon.path = []` → 那只怪永远站在地图外，
 * 于是「本轮进攻清空」永远不成立、轮次永远不涨（浸泡验证 §65 抓到过 (65,23) 这种坐标）。
 */
const clampCell = (m, x, y) => ({
  x: Math.max(0, Math.min(m.grid.w - 1, x)),
  y: Math.max(0, Math.min(m.grid.h - 1, y)),
});

export function spawnFieldMonster(m, mobId, camp) {
  const def = MONSTERS[mobId];
  const hp = def.hp * m.diff.hp;
  const mon = {
    uid: ++m.spawnCounter, mobId, def, kind: 'field', camp,
    cell: clampCell(m, camp.x + Math.floor(m.rng() * 3) - 1, camp.y + Math.floor(m.rng() * 3) - 1),
    hp, maxHp: hp, armor: def.armor, armorType: def.armorType,
    attack: def.attack * m.diff.atk, atkSpeed: def.atkSpeed, speed: def.speed,
    cooldown: 0, isAir: !!def.isAir, effects: [], dead: false, attacking: false,
    active: false, path: [], pathAt: -1,
  };
  m.monsters.push(mon);
  camp.alive = (camp.alive ?? 0) + 1;
  return mon;
}

function stepCamps(m, dt) {
  const density = DEFENSE_RULES.campDensityPerPlayer ** (m.players - 1);
  for (const camp of m.camps) {
    camp.timer -= dt;
    if (camp.timer > 0) continue;
    camp.timer = DEFENSE_RULES.campIntervalSec / density;
    const alive = m.monsters.filter((x) => !x.dead && x.camp === camp).length;
    if (alive >= DEFENSE_RULES.campCapPerCamp) continue;
    const zone = m.def.zones.find((z) => z.id === camp.zone);
    const mobId = zone.mobs[Math.floor(m.rng() * zone.mobs.length)];
    spawnFieldMonster(m, mobId, camp);
  }
}

/* ---------- 回防（每 3 分钟一波，提前 30 秒预警） ---------- */

export function spawnAssaultWave(m) {
  const rounds = m.def.rounds;
  /**
   * 通关线以内按 rounds 表；进入无尽后每一波都在上一波基础上加血，并混入 Boss。
   *
   * STATUS §3.1 #27（已拍板）：原来的倍率是 **1.25ⁿ**——实测无尽只撑 1-2 波（15.4-18.8 分钟就结束），
   * 而 §12.5 把无尽写成**排行榜口径**（城堡剩余血量 → 通过轮次），1-2 波的区分度近乎二元。
   * 改成 **1.15ⁿ** 之后无尽能跑 4-6 波（见验证记录 §207.5），排行才有区分度。
   */
  const ENDLESS_HP_GROWTH = 1.15;
  /**
   * 开场波也收了一点：原来**每一波**都塞 12×mob_04 + 2×mob_11 + **1 个 Boss**，而 4 轮打完后
   * 城堡通常只剩一两千血——于是「无尽」在多数对局里只撑 1-2 波就陷落（§140 量的），
   * 排行榜（§12.5 按城堡剩余血量 → 通过轮次）几乎没有区分度。现在 Boss **隔波出现**。
   */
  const endlessWave = m.assault.round - rounds.length;   // 第几波无尽（从 1 起）
  const endlessRound = m.assault.endless ? { groups: [
    { mobId: 'mob_04', count: 12 }, { mobId: 'mob_11', count: 2 },
    ...(endlessWave % 2 === 1 ? [{ mobId: 'boss_01', count: 1 }] : []),
  ] } : null;
  const roundDef = endlessRound ?? rounds[Math.min(m.assault.round, rounds.length - 1)];
  let spawned = 0;
  let n = 0;
  for (const g of roundDef.groups) {
    for (let i = 0; i < g.count; i++) {
      const def = MONSTERS[g.mobId];
      /**
       * STATUS §3.1 #27 的第二段（2026-09-23，实测回填）：**无尽第 1 波的强度 = 刚刚守住的那一波**
       * （指数从 `n` 改成 `n-1`，即第 1 波 ×1.00、第 2 波 ×1.15…）。
       *
       * 原来的第 1 波直接就是 ×1.15×难度——**比刚刚勉强守住的那一波更硬**，于是高难下守满 4 轮之后
       * 中位只有 1 波就陷落（验证记录 §213 的实测表）。「无尽」本该是「守住之后再往上爬」，
       * 不该是「一上来就比你刚过关的那波更狠」。
       */
      const hp = def.hp * m.diff.hp * (m.assault.endless ? ENDLESS_HP_GROWTH ** (m.assault.round - rounds.length) : 1);
      // 多路地图：出怪在几条进攻路线之间轮流，逼玩家分兵（§2.6 的「进攻路线」列）
      const spawn = m.def.assaultSpawns[n % m.def.assaultSpawns.length];
      n += 1;
      const mon = {
        uid: ++m.spawnCounter, mobId: g.mobId, def, kind: 'assault',
        cell: clampCell(m, spawn.x + (n % 3), spawn.y + Math.floor(n / 3) - 1),
        hp, maxHp: hp, armor: def.armor, armorType: def.armorType,
        attack: def.attack * m.diff.atk, atkSpeed: def.atkSpeed, speed: def.speed,
        cooldown: 0, isAir: !!def.isAir, effects: [], dead: false, attacking: false,
        active: true, path: [], pathAt: -1,
      };
      mon.path = findPath(m.grid.w, m.grid.h, mon.cell, m.castle.cell, m.isBlocked) ?? [];
      m.monsters.push(mon);
      spawned += 1;
    }
  }
  m.assault.round += 1;
  const label = m.assault.endless ? `无尽第 ${m.assault.round - rounds.length} 波` : `第 ${m.assault.round} 轮进攻`;
  addLog(m, `${label}：${spawned} 只直扑城堡`, 'warn');
  return spawned;
}

function stepAssault(m, dt) {
  const a = m.assault;
  a.timer -= dt;
  if (!a.warning && a.timer <= DEFENSE_RULES.assaultWarnSec) {
    a.warning = true;
    addLog(m, '⚠ 进攻预警：30 秒后抵达，回防！', 'warn');
  }
  if (a.timer <= 0) {
    // 上一轮挺到下一波开打、城堡还活着 = 这一轮守住了。
    // 只按「全清」判定的话，多路图上怪会跨轮叠加（新一波已出、老一波还在），
    // 场上永远没有「零进攻怪」的时刻，轮次就永远不涨——def_02 实测跑了 25 分钟仍是 0 轮。
    if (a.round > 0 && m.castle.hp > 0) m.stats.roundsCleared = Math.max(m.stats.roundsCleared, a.round);
    a.timer = DEFENSE_RULES.assaultIntervalSec;
    a.warning = false;
    spawnAssaultWave(m);
    checkDefenseWin(m);
  }
}

/** 守住 4 轮 → 通关（之后仍继续，转无尽）。 */
export function checkDefenseWin(m) {
  if (m.assault.endless || m.stats.roundsCleared < DEFENSE_RULES.roundsToWin) return false;
  m.assault.endless = true;
  if (!m.result) m.result = 'win';
  addLog(m, '通关！进入无尽，按城堡剩余血量排行');
  /**
   * STATUS §3.1 #27 的第二段：**通关那一刻基地回一口血**（`milestoneHealPct`，实测标定，见验证记录 §213）。
   * 为什么需要它：高难下守满 4 轮时城堡中位只剩 56%（困难）/ 28%（噩梦），而无尽第一波
   * 比刚刚勉强守住的那一波更硬（×1.15 × 难度）——中位 1 波就陷落，「无尽」在高难等于不存在。
   * 这一口血是**通关奖励**，只发生在 `result` 已经记了之后，所以它不可能改变任何一局的胜负或已有验收线。
   */
  const heal = Math.round(m.castle.maxHp * DEFENSE_RULES.milestoneHealPct);
  if (m.castle.hp > 0 && m.castle.hp < m.castle.maxHp) {
    m.castle.hp = Math.min(m.castle.maxHp, m.castle.hp + heal);
    addLog(m, `基地抢修：城堡 +${heal}（无尽第 1 波前）`);
  }
  return true;
}

/* ---------- 基地工事 ---------- */

export function buildFort(m, slotIndex, fortId) {
  const slot = m.def.fortSlots[slotIndex];
  const fort = FORTS[fortId];
  if (!slot || !fort) return false;
  if (m.forts.some((f) => f.slot === slotIndex)) return false;
  if (m.gold < fort.cost) return false;
  m.gold -= fort.cost;
  const rec = {
    slot: slotIndex, cell: { ...slot }, fortId, hp: fort.hp, maxHp: fort.hp,
    cooldown: 0, stats: fort.blocks ? null : { ...fort, attackType: fort.attackType },
  };
  m.forts.push(rec);
  if (fort.blocks) m.walls.add(key(slot.x, slot.y));   // 围墙加入阻挡，怪得绕路
  addLog(m, `建造 ${fort.name}`);
  return true;
}

export function repairCastle(m) {
  if (m.castle.hp >= m.castle.maxHp) return false;
  if (m.gold < DEFENSE_RULES.repairGold) return false;
  m.gold -= DEFENSE_RULES.repairGold;
  m.castle.hp = Math.min(m.castle.maxHp, m.castle.hp + m.castle.maxHp * DEFENSE_RULES.repairPct);
  addLog(m, `修复城堡 +${Math.round(m.castle.maxHp * DEFENSE_RULES.repairPct)}`);
  return true;
}

function stepForts(m, dt) {
  for (const f of m.forts) {
    if (!f.stats) continue;
    // §167：冷却要**夹在 0**（和 TD 的塔一样：`t.cooldown = Math.max(0, t.cooldown - dt)`）。
    // 以前这里不夹：没目标时 `f.cooldown` 一路减成负数——浸泡的不变量第一次跑就抓到 **-98.5 秒**。
    // 玩法上「负数」等于「随时能开火」，看不出区别；但它是个坏状态：任何读冷却的地方（以后要做
    // 「工事冷却读条」、存档、联机对账）都会看到一个莫名其妙的大负数。
    f.cooldown = Math.max(0, f.cooldown - dt);
    if (f.cooldown > 0) continue;
    const target = m.monsters
      .filter((x) => !x.dead && gridDist(x.cell, f.cell) <= f.stats.range)
      .sort((a, b) => (a.kind === 'assault' ? -1 : 1) - (b.kind === 'assault' ? -1 : 1))[0];
    if (!target) continue;
    f.cooldown = 1 / f.stats.atkSpeed;
    m.projectiles.push({
      from: project(f.cell.x, f.cell.y, 1.1), target, progress: 0, life: 2,
      stats: { attackType: f.stats.attackType }, damage: f.stats.damage, towerId: f.fortId,
    });
  }
  // 弹道结算
  for (const p of m.projectiles) {
    p.life -= dt;
    p.progress += dt * 4.5;
    if (!p.target || p.target.dead) { p.life = 0; continue; }
    if (p.progress >= 1) {
      damageMonster(m, p.target, computeDamage({
        atk: p.damage, attackType: p.stats.attackType, armor: p.target.armor,
        armorType: p.target.armorType, rng: m.rng,
      }).damage, p.towerId);
      p.life = 0;
    }
  }
  m.projectiles = m.projectiles.filter((p) => p.life > 0);
}

/* ---------- 怪物 AI：野外怪追人、进攻怪打城堡 ---------- */

function repath(m, mon, goal) {
  mon.path = findPath(m.grid.w, m.grid.h, mon.cell, goal, m.isBlocked) ?? [];
  mon.pathAt = m.time;
}

function stepMonsters(m, dt) {
  const hero = m.hero;
  for (const mon of m.monsters) {
    if (mon.dead) continue;
    // §137：眩晕 / 减速 / DoT 全走共用出口（防守这边以前一条都没读 `mon.effects`——
    // 冰塔、冰霜之触、图腾的减速，制裁之锤的眩晕，暴风雪的 DoT，在这个模式里全是空的）
    const { stunned, slow } = stepMonsterEffects(m, mon);
    if (mon.dead) continue;   // DoT 可能刚好把它打死

    if (mon.kind === 'field') {
      // 玩家靠近才激活；激活后追人打
      if (!mon.active && !hero.dead && gridDist(mon.cell, hero.cell) <= DEFENSE_RULES.campActivateRadius) {
        mon.active = true;
        addLog(m, `${mon.def.name} 发现了你`, 'warn');
      }
      if (!mon.active) continue;
    }

    const heroInReach = !stunned && !hero.dead && gridDist(mon.cell, hero.cell) <= 1;
    if (heroInReach) {
      mon.attacking = true;
      mon.cooldown -= dt;
      if (mon.cooldown <= 0) {
        mon.cooldown = 1 / mon.atkSpeed;
        const st = heroStats(hero);
        // §7.6 复活保护：刚复活那 3 秒不掉血；§7.3：英雄基础 3% 闪避（防守这条路上以前没有闪避判定）
        if (m.time >= (hero.invulnUntil ?? 0) && m.rng() >= heroDodge(m)) {
          hero.hp -= computeDamage({
            atk: mon.attack, attackType: mon.def.attackType, armor: st.def,
            armorType: 'heavy', targetReduce: heroDamageReduce(m), rng: m.rng,
          }).damage;
        }
        if (hero.hp <= 0) killHero(m);
      }
      continue;
    }

    mon.attacking = false;
    const goal = mon.kind === 'assault' ? m.castle.cell : hero.cell;
    const reached = mon.kind === 'assault' ? gridDist(mon.cell, m.castle.cell) <= 1 : gridDist(mon.cell, hero.cell) <= 1;
    if (reached) {
      if (mon.kind === 'assault') {
        // 到城堡：拆城墙 / 打城堡
        const wall = m.forts.find((f) => f.stats === null && gridDist(f.cell, mon.cell) <= 1);
        if (wall) {
          wall.hp -= mon.attack * dt * 2;
          if (wall.hp <= 0) { m.walls.delete(key(wall.cell.x, wall.cell.y)); m.forts = m.forts.filter((f) => f !== wall); addLog(m, '围墙被拆', 'warn'); }
          continue;
        }
        mon.cooldown -= dt;
        if (mon.cooldown <= 0) {
          mon.cooldown = 1 / mon.atkSpeed;
          // 进攻怪打城堡的伤害：取 TD「漏怪伤害」的 1/10，否则 4000 血的城堡几秒就没了
          const hit = Math.max(1, Math.round(mon.def.coreDamage * DEFENSE_RULES.castleDamageMul));
          m.castle.hp -= hit;
          m.stats.castleHits += 1;
          addLog(m, `城堡被 ${mon.def.name} 攻击 -${hit}`, 'warn');
          if (m.castle.hp <= 0) { m.castle.hp = 0; m.result = m.result === 'win' ? 'win' : 'lose'; m.over = true; addLog(m, '城堡陷落', 'warn'); }
        }
        continue;
      }
    }

    // 沿路径移动（每 1 秒最多重算一次，省算力）
    if (!mon.path.length || m.time - (mon.pathAt ?? -9) > 1) repath(m, mon, goal);
    if (!mon.path.length) continue;
    if (stunned) continue;                      // 被眩晕：这一帧不动
    const speed = TILE_SPEED(mon.speed) * (1 - slow) * dt;
    mon.carry = (mon.carry ?? 0) + speed;
    while (mon.carry >= 1 && mon.path.length) {
      mon.carry -= 1;
      mon.cell = mon.path.shift();
    }
  }
}

function killHero(m) {
  const hero = m.hero;
  hero.hp = 0;
  hero.dead = true;
  // §12.5 的 20 秒 × §3.6 的人物等级加成
  hero.reviveTimer = DEFENSE_RULES.heroReviveSec * (m.reviveMul ?? 1);
  const lost = Math.floor(m.gold * DEFENSE_RULES.heroDeathGoldLoss);
  m.gold -= lost;
  addLog(m, `英雄阵亡：掉 ${lost} 金，${hero.reviveTimer.toFixed(1)} 秒后回城`, 'warn');
}

/* ---------- 掉落与拾取 ---------- */

/**
 * 英雄（或任意格点）落在哪个野外区。§2.6 / §12.8 的 `field_zone`：HUD 用它显示
 * 「腐化荒地 Lv5-10」，掉落用它取 `dropBonus`——不然 lvMin/lvMax/dropBonus 就是死数据。
 */
export function zoneAt(def, cell) {
  if (!def?.zones || !cell) return null;
  return def.zones.find((z) => cell.x >= z.x && cell.x < z.x + z.w
    && cell.y >= z.y && cell.y < z.y + z.h) ?? null;
}

/**
 * 野外怪必掉一点：走 §5.2 的表，但保底按「每 8 只」而不是 25（野外是主要装备来源）。
 * §2.6 的「越远收益越高」在这里落地：**同样的 8 只怪，远处那一区掉得更多**
 * （dropBonus 1.0 / 1.25 / 1.5 / 1.75 → 保底 8 / 6 / 5 / 5 只一件）。
 */
function rollFieldDrop(m, mon) {
  m.stats.normalKills += 1;
  const bonus = zoneAt(m.def, mon.cell)?.dropBonus ?? 1;
  const pity = mon.def.tier === 'normal' ? Math.max(1, Math.round(8 / bonus)) : 1;
  if (m.stats.normalKills % pity !== 0) return;
  const slots = Object.keys(EQUIP_SLOTS);
  const item = makeEquipment(m, slots[Math.floor(m.rng() * slots.length)],
    pickQuality(m, DROP_TABLE.normal), Math.max(1, Math.min(15, m.hero.level)));
  m.groundItems.push({ ...item, cell: { ...mon.cell }, at: m.time });
  m.stats.drops += 1;
}

function pickQuality(m, table) {
  const roll = m.rng();
  let acc = 0;
  for (const q of QUALITY_ORDER) {
    acc += table[q] ?? 0;
    if (roll <= acc) return q;
  }
  return 'white';
}

/** 走到掉落物上自动拾取（碎片场景里不该再多一步操作）。 */
export function stepPickups(m) {
  if (m.autoPickup === false) return;   // 设置里可以关掉自动拾取（§14.3 稿 9）
  const hero = m.hero;
  if (hero.dead) return;
  const near = m.groundItems.filter((it) => gridDist(it.cell, hero.cell) <= 1);
  if (!near.length) return;
  for (const it of near) {
    m.inventory.push(it);
    const cur = m.equipped[it.slot];
    const score = (x) => x.ilvl * (QUALITY_ORDER.indexOf(x.quality) + 1);
    if (!cur || score(it) > score(cur)) m.equipped[it.slot] = it;
  }
  m.groundItems = m.groundItems.filter((it) => !near.includes(it));
  addLog(m, `拾取 ${near.length} 件装备`);
}

/* ---------- 主循环 ---------- */

export function updateDefense(m, dtRaw) {
  if (m.over) return m;
  const dt = Math.min(TICK_STEP, Math.max(0, dtRaw));
  m.time += dt;

  stepHero(m, dt);
  stepTeleports(m);
  stepCamps(m, dt);
  stepAssault(m, dt);
  stepMonsters(m, dt);
  stepForts(m, dt);
  stepPickups(m);

  // 英雄：技能冷却 / 回血 / 自动普攻
  const hero = m.hero;
  for (let i = 0; i < hero.skillCd.length; i++) hero.skillCd[i] = Math.max(0, hero.skillCd[i] - dt);
  hero.teleportCd = Math.max(0, (hero.teleportCd ?? 0) - dt);
  for (const k of Object.keys(m.potionCd)) m.potionCd[k] = Math.max(0, m.potionCd[k] - dt);
  if (hero.dead) {
    hero.reviveTimer -= dt;
    if (hero.reviveTimer <= 0) {
      hero.dead = false;
      hero.hp = heroMaxHp(hero);
      hero.cell = { ...m.castle.cell };
      hero.path = [];
      hero.invulnUntil = m.time + HERO_REVIVE.invulnSec;   // §7.6：3 秒无敌
      hero.fastUntil = m.time + HERO_REVIVE.fastSec;       // §7.6：10 秒赶路补偿
      addLog(m, '英雄在城堡复活（3 秒无敌、10 秒加速）');
    }
  } else {
    const st = heroStats(hero);
    // §3.7 的回复口径与 TD 一致：战斗中 0.5%/s，脱战 3 秒后 2%/s
    const inCombat = m.monsters.some((x) => !x.dead && x.active && gridDist(x.cell, hero.cell) <= 2);
    if (inCombat) hero.engagedUntil = m.time + HERO_REGEN.outOfCombatSec;
    const regenPct = m.time >= (hero.engagedUntil ?? 0) ? HERO_REGEN.idlePct : HERO_REGEN.combatPct;
    hero.hp = Math.min(st.maxHp, hero.hp + (st.maxHp * regenPct + st.hpRegen) * dt);   // §5.2 词条「每秒回血」
    hero.cooldown = Math.max(0, (hero.cooldown ?? 0) - dt);
    if (hero.cooldown <= 0) {
      const target = m.monsters
        .filter((x) => !x.dead && gridDist(x.cell, hero.cell) <= st.range)
        .sort((a, b) => gridDist(a.cell, hero.cell) - gridDist(b.cell, hero.cell))[0];
      if (target) {
        hero.cooldown = 1 / st.atkSpeed;
        heroAttack(m, target);   // §4.1：与 TD 共用同一个普攻出口（武器特性在这里生效）
      }
    }
  }

  // 清场与结算
  m.monsters = m.monsters.filter((x) => !x.dead);
  m.groundItems = m.groundItems.filter((it) => m.time - it.at < 60);   // 掉落 60 秒后消失

  // 进攻波清空 → 计一轮；守住第 4 轮 → 通关，之后转无尽
  const assaultAlive = m.monsters.some((x) => x.kind === 'assault');
  if (!assaultAlive && m.assault.round > 0 && m.stats.roundsCleared < m.assault.round) {
    m.stats.roundsCleared = m.assault.round;
    addLog(m, `第 ${m.assault.round} 轮守住了`);
    checkDefenseWin(m);
  }
  return m;
}

/** 击杀结算：野外怪给双倍经验与掉落，进攻怪只给赏金。 */
export function onMonsterKilled(m, mon) {
  const bounty = Math.round(mon.def.bounty * 0.5);
  m.gold += bounty;
  m.stats.goldEarned += bounty;
  grantExp(m, Math.round(mon.def.level * 8 * (mon.kind === 'field' ? DEFENSE_RULES.fieldExpMul : 1)));
  if (mon.kind === 'field') {
    m.stats.fieldKills += 1;
    rollFieldDrop(m, mon);
  }
  spawnSplit(m, mon);   // §136：亡语分裂（TD 那半写在 killMonster 里，防守这半以前漏了）
}

/**
 * §136：**亡语分裂**（§6.3 的 `onDeath.splitInto`：亡语蛛后 mob_11 死后分裂出 2 只小怪）。
 * TD 那半写在 `match.js` 的 `killMonster()` 里（沿路径生成），防守这边从来没实现——
 * 而 mob_11 恰恰在防守的三张图的第 3/4 轮里都出现（def_01 第 4 轮 2 只、def_03 第 3 轮 2 只…），
 * 等于「精英·分裂」这个身份在它最主要的战场上是空的。
 * 分裂出来的怪**跟着父本的类型走**：野外怪继续算野外怪（掉了经验/掉落照旧），进攻怪继续扑城堡。
 */
function spawnSplit(m, parent) {
  const split = parent.def?.onDeath;
  if (!split?.splitInto) return;
  for (let i = 0; i < (split.count ?? 1); i += 1) {
    const def = MONSTERS[split.splitInto];
    if (!def) continue;
    const hp = def.hp * m.diff.hp;
    const cell = clampCell(m, parent.cell.x, parent.cell.y);
    const child = {
      uid: ++m.spawnCounter, mobId: def.id, def, kind: parent.kind, camp: parent.camp,
      cell, hp, maxHp: hp, armor: def.armor, armorType: def.armorType,
      attack: def.attack * m.diff.atk, atkSpeed: def.atkSpeed, speed: def.speed,
      cooldown: 0, isAir: !!def.isAir, effects: [], dead: false, attacking: false,
      active: parent.kind !== 'field', path: [], pathAt: -1,
    };
    if (parent.kind !== 'field') {
      child.path = findPath(m.grid.w, m.grid.h, child.cell, m.castle.cell, m.isBlocked) ?? [];
    }
    m.monsters.push(child);
    if (child.camp) child.camp.alive = (child.camp.alive ?? 0) + 1;
  }
  addLog(m, `${parent.def.name} 亡语：分裂出 ${split.count ?? 1} 只`);
}

export function describeDefense(m) {
  return {
    time: +m.time.toFixed(1),
    gold: Math.round(m.gold),
    castle: Math.round(m.castle.hp),
    heroLevel: m.hero.level,
    heroHp: Math.round(m.hero.hp),
    monsters: m.monsters.length,
    assaultAlive: m.monsters.filter((x) => x.kind === 'assault').length,
    round: m.assault.round,
    roundsCleared: m.stats.roundsCleared,
    nextAssaultIn: Math.max(0, Math.round(m.assault.timer)),
    warning: m.assault.warning,
    teleportCd: Math.round(m.hero.teleportCd ?? 0),
    drops: m.stats.drops,
    ground: m.groundItems.length,
    result: m.result,
  };
}
