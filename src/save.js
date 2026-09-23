// 单人局存档（§10.3：杀进程重开后进度不丢）。
// 只序列化「变化的状态」，定义表从 data.js 现取；半空中的弹道直接丢掉（重开后自然重发）。

import { FORTS, MONSTERS } from './data.js';
import { createMatch, towerStatsAt } from './match.js';
import { createDefenseMatch, onMonsterKilled } from './defense.js';
import { storage } from './platform.js';   // §平台适配：存档走适配层（小游戏 = wx storage）

export const SAVE_VERSION = 1;

/** 统一入口：按模式分派（防守模式的状态形状完全不同，硬塞进一份结构只会两边都别扭）。 */
export const serializeMatch = (m) => (m.mode === 'defense' ? serializeDefense(m) : serializeTd(m));
export const deserializeMatch = (save) => (save?.mode === 'defense' ? deserializeDefense(save) : deserializeTd(save));

export function serializeTd(m) {
  return {
    v: SAVE_VERSION,
    mode: 'td',
    savedAt: Date.now(),
    mapId: m.mapId,
    difficulty: m.difficulty,
    heroId: m.hero.def.id,
    players: m.players,
    seed: m.seed,
    length: m.length ?? 'short',
    startGold: m.startGold ?? null,
    reviveMul: m.reviveMul ?? 1,          // §3.6：人物等级的复活加速
    scrolls: m.scrolls ?? 0,              // §5.5.1：回城卷轴
    shopCast: m.shopCast ?? null,         // §5.5：波次中那 3 秒读条（存下来才不会读档白扣钱）
    rng: m.rng.getState?.() ?? 0,
    spawnCounter: m.spawnCounter ?? 0,
    time: m.time,   // 不要四舍五入：读档后与未中断那一局逐帧对比时，这点误差会放大成漂移
    gold: m.gold,
    lumber: m.lumber.slice(),
    core: { hp: m.core.hp, maxHp: m.core.maxHp },
    cores: (m.cores ?? [m.core]).map((c) => ({ hp: c.hp, maxHp: c.maxHp })),   // map_06 双守护目标
    wave: { index: m.wave.index, phase: m.wave.phase, timer: m.wave.timer, spawned: m.wave.spawned, total: m.wave.total, queue: m.wave.queue },
    hero: {
      level: m.hero.level, exp: m.hero.exp, hp: m.hero.hp, skillCd: m.hero.skillCd.slice(),
      skillUnlocked: m.hero.skillUnlocked.slice(), dead: m.hero.dead, reviveTimer: m.hero.reviveTimer,
      buffs: m.hero.buffs.map((b) => ({ ...b })),
      attackBuff: m.hero.attackBuff, reduceBuff: m.hero.reduceBuff,
    },
    towers: m.towers.map((t) => ({
      towerId: t.towerId, slot: t.slot, level: t.level, cooldown: t.cooldown,
      priority: t.priority, invested: t.invested,
    })),
    monsters: m.monsters.filter((x) => !x.dead).map((x) => ({
      uid: x.uid, mobId: x.mobId, pathIndex: x.pathIndex, dist: x.dist, hp: x.hp,
      armor: x.armor, attacking: x.attacking, aggroUntil: x.aggroUntil ?? 0,
      effects: x.effects.map((e) => ({ ...e })),
    })),
    bag: { ...m.bag },
    potionCd: { ...m.potionCd },
    shopBought: { ...m.shopBought },
    bookLevelBonus: m.bookLevelBonus,
    inventory: m.inventory,
    equipped: m.equipped,
    stats: { ...m.stats, damage: { ...m.stats.damage } },
    result: m.result,
    over: m.over ?? false,
    events: m.events.slice(-12),
  };
}

export function deserializeTd(save) {
  if (!save || save.v !== SAVE_VERSION) return null;
  const m = createMatch({
    mapId: save.mapId, difficulty: save.difficulty, heroId: save.heroId,
    players: save.players, seed: save.seed, rngState: save.rng,
    startGold: save.startGold ?? undefined,
    length: save.length ?? 'short',
    reviveMul: save.reviveMul ?? 1,
  });
  m.spawnCounter = save.spawnCounter;
  m.time = save.time;
  m.gold = save.gold;
  m.lumber = save.lumber.slice();
  m.core.hp = save.core.hp;
  m.core.maxHp = save.core.maxHp;
  // 双核心地图（map_06）：第二个守护目标的血量也要跟着回来，否则读档会把「另一个核心」治满
  (save.cores ?? []).forEach((c, i) => { if (m.cores[i]) { m.cores[i].hp = c.hp; m.cores[i].maxHp = c.maxHp; } });
  m.scrolls = save.scrolls ?? 0;
  m.shopCast = save.shopCast ?? null;
  m.wave = { ...save.wave };
  Object.assign(m.hero, {
    level: save.hero.level, exp: save.hero.exp, hp: save.hero.hp,
    skillCd: save.hero.skillCd.slice(), skillUnlocked: save.hero.skillUnlocked.slice(),
    dead: save.hero.dead, reviveTimer: save.hero.reviveTimer,
    buffs: save.hero.buffs.map((b) => ({ ...b })),
    attackBuff: save.hero.attackBuff, reduceBuff: save.hero.reduceBuff,
  });
  m.towers = save.towers.map((t) => {
    const cell = m.map.slots[t.slot];
    return {
      uid: t.slot + 1, towerId: t.towerId, slot: t.slot, cell,
      level: t.level, cooldown: t.cooldown, priority: t.priority, invested: t.invested,
      // §2.3：塔的射程/伤害要跟着**它站的那块地**算（沼泽 -1 射程、高地 +1.5 射程 +10% 攻击），
      // 读档时如果只按等级重算，地形加成会「读一次少一次」（存档链上的同一类坑，见验证记录 §69）
      stats: towerStatsAt(m.map, cell, t.towerId, t.level),
    };
  });
  m.monsters = save.monsters.map((x) => {
    const def = MONSTERS[x.mobId];
    const path = m.map.paths[x.pathIndex] ?? m.map.paths[0];
    const cellIndex = Math.min(path.cells.length - 1, Math.floor(x.dist / 128));
    return {
      uid: x.uid, mobId: x.mobId, def, pathIndex: x.pathIndex, dist: x.dist,
      cell: path.cells[cellIndex], hp: x.hp, maxHp: def.hp * (m.diff.hp ?? 1),
      armor: x.armor, armorType: def.armorType, speed: def.speed,
      attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0,
      isAir: !!def.isAir, effects: x.effects.map((e) => ({ ...e })), dead: false, attacking: !!x.attacking,
      aggroUntil: x.aggroUntil ?? 0,
    };
  });
  m.projectiles = [];
  m.bag = { ...save.bag };
  m.potionCd = { ...save.potionCd };
  m.shopBought = { ...save.shopBought };
  m.bookLevelBonus = save.bookLevelBonus;
  m.inventory = save.inventory;
  m.equipped = save.equipped;
  m.hero.equipped = m.equipped;   // §5.2：英雄属性读装备，读档后要把这条引用接回去
  m.stats = { ...save.stats, damage: { ...save.stats.damage } };
  m.result = save.result;
  m.events = save.events ?? [];
  return m;
}

/* ---------- 浏览器存取（单人局专用） ---------- */

/* ---------- 防守模式存档（§12.5：基地 + 野外 + 回防调度） ---------- */

export function serializeDefense(m) {
  return {
    v: SAVE_VERSION,
    mode: 'defense',
    savedAt: Date.now(),
    mapId: m.mapId,
    difficulty: m.difficulty,
    heroId: m.hero.def.id,
    players: m.players,
    seed: m.seed,
    reviveMul: m.reviveMul ?? 1,   // §3.6：人物等级的复活加速
    scrolls: m.scrolls ?? 0,       // §5.5.1：回城卷轴
    rng: m.rng.getState?.() ?? 0,
    spawnCounter: m.spawnCounter ?? 0,
    time: m.time,
    gold: m.gold,
    lumber: m.lumber.slice(),
    castle: { hp: m.castle.hp, maxHp: m.castle.maxHp },
    hero: {
      level: m.hero.level, exp: m.hero.exp, hp: m.hero.hp, cell: { ...m.hero.cell },
      path: (m.hero.path ?? []).map((c) => ({ ...c })), goal: m.hero.goal ? { ...m.hero.goal } : null,
      cooldown: m.hero.cooldown ?? 0, skillCd: m.hero.skillCd.slice(),
      // §147：回城那 30 秒冷却也要存。它是**有代价的能力**（§2.6：冷却中只认回城卷轴），
      // 不进存档的话「存档 → 刷新」就是一次免费回城——而且可以反复刷，
      // 等于把 §2.6「3 张卷轴 = 3 次回城」那套设计绕过（同一类坑：§69 的「读一次少一次」。
      teleportCd: m.hero.teleportCd ?? 0,
      skillUnlocked: m.hero.skillUnlocked.slice(), buffs: m.hero.buffs.map((b) => ({ ...b })),
      dead: m.hero.dead, reviveTimer: m.hero.reviveTimer, attackBuff: m.hero.attackBuff, reduceBuff: m.hero.reduceBuff,
    },
    forts: m.forts.map((f) => ({ slot: f.slot, fortId: f.fortId, hp: f.hp, cooldown: f.cooldown ?? 0 })),
    monsters: m.monsters.filter((x) => !x.dead).map((x) => ({
      uid: x.uid, mobId: x.mobId, kind: x.kind, camp: x.camp ? m.camps.indexOf(x.camp) : -1,
      cell: { ...x.cell }, hp: x.hp, armor: x.armor, attacking: !!x.attacking, active: !!x.active,
      path: (x.path ?? []).slice(0, 40).map((c) => ({ ...c })),
    })),
    camps: m.camps.map((c) => ({ timer: c.timer })),
    assault: { ...m.assault },
    groundItems: m.groundItems.map((it) => ({ ...it, cell: { ...it.cell } })),
    bag: { ...m.bag },
    potionCd: { ...m.potionCd },
    shopBought: { ...m.shopBought },
    bookLevelBonus: m.bookLevelBonus,
    inventory: m.inventory,
    equipped: m.equipped,
    stats: { ...m.stats, damage: { ...m.stats.damage } },
    result: m.result,
    over: m.over ?? false,   // 防守：城堡陷落 = 这一局结束（读档时要保持「不再推进」）
    events: m.events.slice(-12),
  };
}

export function deserializeDefense(save) {
  if (!save || save.v !== SAVE_VERSION) return null;
  const m = createDefenseMatch({
    mapId: save.mapId, difficulty: save.difficulty, heroId: save.heroId,
    players: save.players, seed: save.seed, reviveMul: save.reviveMul ?? 1,
  });
  m.scrolls = save.scrolls ?? 0;
  m.rng.setState(save.rng);
  m.spawnCounter = save.spawnCounter;
  m.time = save.time;
  m.gold = save.gold;
  m.lumber = save.lumber.slice();
  m.castle.hp = save.castle.hp;
  m.castle.maxHp = save.castle.maxHp;
  Object.assign(m.hero, {
    level: save.hero.level, exp: save.hero.exp, hp: save.hero.hp, cell: { ...save.hero.cell },
    path: save.hero.path.map((c) => ({ ...c })), goal: save.hero.goal,
    cooldown: save.hero.cooldown, skillCd: save.hero.skillCd.slice(),
    teleportCd: save.hero.teleportCd ?? 0,   // §147：冷却不还回来，读档就等于白送一次回城
    skillUnlocked: save.hero.skillUnlocked.slice(), buffs: save.hero.buffs.map((b) => ({ ...b })),
    dead: save.hero.dead, reviveTimer: save.hero.reviveTimer,
    attackBuff: save.hero.attackBuff, reduceBuff: save.hero.reduceBuff,
  });
  // 工事：静态围墙由 createDefenseMatch 放好，这里只补玩家自建的（并恢复阻挡）
  m.forts = save.forts.map((f) => {
    const fort = FORTS[f.fortId];
    const cell = m.def.fortSlots[f.slot];
    if (fort.blocks) m.walls.add(`${cell.x},${cell.y}`);
    return {
      slot: f.slot, cell: { ...cell }, fortId: f.fortId, hp: f.hp, maxHp: fort.hp,
      cooldown: f.cooldown ?? 0, stats: fort.blocks ? null : { ...fort },
    };
  });
  m.monsters = save.monsters.map((x) => {
    const def = MONSTERS[x.mobId];
    return {
      uid: x.uid, mobId: x.mobId, def, kind: x.kind, camp: m.camps[x.camp] ?? null,
      cell: { ...x.cell }, hp: x.hp, maxHp: def.hp * (m.diff.hp ?? 1), armor: x.armor,
      armorType: def.armorType, speed: def.speed, attack: def.attack, atkSpeed: def.atkSpeed,
      cooldown: 0, isAir: !!def.isAir, effects: [], dead: false,
      attacking: x.attacking, active: x.active, path: x.path.map((c) => ({ ...c })), pathAt: 0,
    };
  });
  m.camps.forEach((c, i) => { if (save.camps[i]) c.timer = save.camps[i].timer; });
  m.assault = { ...save.assault };
  m.groundItems = save.groundItems.map((it) => ({ ...it, cell: { ...it.cell } }));
  m.bag = { ...save.bag };
  m.potionCd = { ...save.potionCd };
  m.shopBought = { ...save.shopBought };
  m.bookLevelBonus = save.bookLevelBonus;
  m.inventory = save.inventory;
  m.equipped = save.equipped;
  m.hero.equipped = m.equipped;   // §5.2：英雄属性读装备，读档后要把这条引用接回去
  m.stats = { ...save.stats, damage: { ...save.stats.damage } };
  m.result = save.result;
  m.events = save.events ?? [];
  m.over = save.over ?? false;
  m.onMonsterKilled = (mon) => onMonsterKilled(m, mon);   // 重建回调（函数不进存档）
  return m;
}

const KEY = 'frostfall:save';

export function saveToStorage(m) {
  // §113：联机镜像（`m.online`）**不进本地存档**——那一局的权威在服务端，存下来只会在大厅多出
  // 一个「继续上局」，点进去是没有服务端的鬼局。守卫放在这里而不是逐个调用方，
  // 是因为「谁会把镜像写进存档」是调用方随时会变的事（这轮就是新加的一条离开路径撞上的）。
  if (m?.online) return false;
  try { return storage.set(KEY, JSON.stringify(serializeMatch(m))); } catch { return false; }
}

export function loadFromStorage() {
  try {
    const raw = storage.get(KEY);
    if (!raw) return null;
    return deserializeMatch(JSON.parse(raw));
  } catch { return null; }
}

export function hasSave() {
  /**
   * §139 + §204：**「能读的才算有」**。
   *
   * §139 把「键在不在」改成了「版本号对不对」，但**只堵住了版本那一半**：版本号对、**内容**读不出来的
   * 存档（改版后地图/怪物 id 变了、字段缺了、存档半截…）照样弹「继续上局」——点下去
   * `loadFromStorage()` 返回 null、只能 `startMatch()` 开一局新的，玩家以为那局还在（实测过 §204）。
   *
   * 现在直接以「读得出来」为准：反序列化一局是毫秒级，而大厅渲染只在没有这个按钮时调它一次。
   */
  return loadFromStorage() !== null;
}

export function clearSave() {
  try { storage.remove(KEY); } catch { /* 忽略 */ }
}
