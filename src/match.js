// 单局模拟：波次、怪物、塔、英雄、经济、商店、装备合成。
// 纯逻辑、无 DOM 依赖，可无头运行（tools/selfplay.mjs）并接受单元测试（tests/）。

import {
  CHEST_EVERY_WAVES, DIFFICULTY, DROP_TABLE, ECONOMY, ELITE_DROP_CHANCE, EQUIP_CRAFT, EQUIP_ILLVL_MAX, EQUIP_SLOTS,
  GRID, HEROES, HERO_LEVEL_GAIN, HERO_MAX_LEVEL, HERO_REGEN, HERO_REVIVE, MAPS, MONSTERS, NORMAL_MOB_DROP_PITY,
  QUALITY, QUALITY_ORDER, POTION_BAG_SLOTS, SHOP_ITEMS, TICK_STEP, TIMING, TOWERS, TARGET_PRIORITIES,
  SHOP_CAST_SEC, STAT_CAPS, HERO_DODGE_BASE, EQUIP_SELL_REFUND, EQUIP_SELL_BONUS_LUMBER,
  playerScaleOf, WEAPONS, WEAPON_IDS,
  TOWER_ATK_SPEED_CAP, TOWER_LEVEL_GAIN, TOWER_MAX_LEVEL, TOWER_SELL_REFUND,
  SKILL_MAX_LEVEL, TOWER_UPGRADE_COST, WAVES, expToNext, ilvlForWave, skillLevelOf,
} from './data.js';
import { LONG_RUN, LONG_RUN_BOSS_HP, WAVES_LONG } from './data.js';
import { buildMap, cellAt, computeDamage, gridDist, makeRng, pathTotalUnits, project, splashScale } from './core.js';

/* ---------- 静态计算（UI 与测试共用同一份来源） ---------- */

export function towerStats(towerId, level = 1) {
  const t = TOWERS[towerId];
  const g = TOWER_LEVEL_GAIN;
  return {
    damage: t.damage * (1 + g.damage) ** (level - 1),
    range: t.range * (1 + g.range) ** (level - 1),
    atkSpeed: Math.min(TOWER_ATK_SPEED_CAP, t.atkSpeed * (1 + g.atkSpeed) ** (level - 1)),
    attackType: t.attackType,
    hitsAir: t.hitsAir,
    special: t.special,
  };
}

/**
 * §2.3 地形对**建在这块地上的塔**的影响：
 * - 沼泽：射程 -1（怪走沼泽 -10% 移速那条在 monsterStep 里）
 * - 高地：射程 +1.5、攻击 +10%
 * 走同一个出口：建塔与升级都调它，客户端面板与寻敌读的是同一份 `t.stats`，不存在「面板一套、实战一套」。
 * 注意现状：**六张首发图的塔位没有一个落在沼泽/高地上**（实测），所以这条现在是潜在规则——
 * 一旦有地图把塔位放到这两种地形上就会生效，见验证记录 §69。
 */
export function towerStatsAt(map, cell, towerId, level = 1) {
  const base = towerStats(towerId, level);
  const onSwamp = map?.swamp?.has(`${cell.x},${cell.y}`);
  const onHighland = map?.highland?.has(`${cell.x},${cell.y}`);
  const range = base.range + (onSwamp ? -1 : 0) + (onHighland ? 1.5 : 0);
  const damage = base.damage * (onHighland ? 1.10 : 1);
  return { ...base, range: Math.max(0.5, range), damage, onSwamp: !!onSwamp, onHighland: !!onHighland };
}

export const upgradeCost = (towerId, level) =>
  level >= TOWER_MAX_LEVEL ? null : Math.round(TOWERS[towerId].cost * TOWER_UPGRADE_COST[level - 1]);

export const investedOf = (towerId, level) => {
  let sum = TOWERS[towerId].cost;
  for (let l = 1; l < level; l++) sum += upgradeCost(towerId, l);
  return sum;
};

export const towerDps = (towerId, level = 1) => {
  const s = towerStats(towerId, level);
  return s.damage * s.atkSpeed;
};

/**
 * §3.3 / §3.5 天赋取值：没到解锁等级就是 0。
 * 唯一读取点——`maxHp` / `atkSpeed` / `critRate` / `critDmg` 走它，`lowHpReduce` /
 * `spellDmg` / `killHealPct` 也走它（这三个以前**一个读取方都没有**：数据表里有、
 * 效果为零，见验证记录 §54）。
 */
export const talentValue = (hero, type) => {
  const t = hero.def.talents.find((x) => x.type === type);
  return t && hero.level >= t.unlockLevel ? t.value ?? 0 : 0;
};

/**
 * §5.2 / §5.4：把三件装备的主属性与词条合成一份加成表——**战斗只认这一份**。
 * （以前 `m.equipped` 只被用来算「哪件更强」和显示品质色，一件属性都没进过伤害公式：见验证记录 §58。）
 */
export function equipBonus(equipped) {
  const b = { attack: 0, def: 0, maxHp: 0, critRate: 0, critDmg: 0, armorPierce: 0, dmgReduce: 0, hpRegen: 0, goldFind: 0, atkSpeed: 0 };
  for (const item of Object.values(equipped ?? {})) {
    if (!item) continue;
    // §4.3 / §5.4：强化只放大**主属性**（`finalAtk = baseAtk × 品质 × (1 + 0.06 × 强化等级)`），
    // 词条按文档「在伤害结算阶段叠加」，不跟着强化涨；强化 +3/+5 的奖励是**多一条词条**。
    const mul = 1 + ENHANCE.step * (item.plus ?? 0);
    for (const [k, v] of Object.entries(item.baseAttrs ?? {})) b[k] = (b[k] ?? 0) + v * mul;
    for (const a of item.affixes ?? []) b[a.id] = (b[a.id] ?? 0) + a.value;
  }
  return b;
}

export const heroMaxHp = (hero) =>
  hero.def.hp * (1 + HERO_LEVEL_GAIN.hp * (hero.level - 1)) * (1 + talentValue(hero, 'maxHp'))
  + equipBonus(hero.equipped).maxHp;

/** §3.3 钢铁意志：生命 < 30% 时减伤 +15%（与守护结界这类技能减伤叠加）。 */
export const heroDamageReduce = (m) =>
  (m.hero.reduceBuff ?? 0)
  + equipBonus(m.hero.equipped ?? m.equipped).dmgReduce       // §5.2 词条「减伤」
  + (m.hero.hp < heroMaxHp(m.hero) * 0.3 ? talentValue(m.hero, 'lowHpReduce') : 0);

/**
 * §7.3：英雄基础闪避 3%，加上疾风步这类 buff，上限 75%。
 * 只有英雄会闪避（怪物与塔不闪避），所以这个值只在这两处受击路径上用：
 * TD 的 `monsterStep` 与防守的 `stepMonsters`——以前防守那边**一条闪避判定都没有**。
 */
export const heroDodge = (m) =>
  Math.min(STAT_CAPS.dodge, HERO_DODGE_BASE + (m.hero.windBuff?.dodgePct ?? 0));

/**
 * §144：疾行药剂（`type: 'elixir'` 的 `atkSpeedPct`）的攻速加成。
 * 它以前只写在 TD 的 `heroStep()` 里（`1 / (stats.atkSpeed * (1 + elixir.atkSpeedPct))`），
 * 而防守的普攻是 `1 / st.atkSpeed`——于是 **150 金的疾行药剂在防守模式里一点用都没有**
 * （与 §134 的疾风步是同一类：加成写进 buff 了，但没有一个共用出口去读）。
 * 现在并进 `heroStats()`——§58 的口径「战斗只认这一份」，两个模式与界面走同一个数。
 */
const elixirSpeed = (hero) => (hero.buffs ?? []).reduce((mx, b) => Math.max(mx, b.atkSpeedPct ?? 0), 0);

export function heroStats(hero) {
  const g = HERO_LEVEL_GAIN;
  const eq = equipBonus(hero.equipped);
  // §4.1：拿着武器时，攻击档（类型 / 射程 / 攻速）从武器来；赤手空拳才用职业的裸值
  const weapon = WEAPONS[hero.equipped?.weapon?.weaponId] ?? null;
  return {
    attack: hero.def.attack * (1 + g.attack * (hero.level - 1)) * (1 + hero.attackBuff) + eq.attack,
    atkSpeed: (weapon?.atkSpeed ?? hero.def.atkSpeed) * (1 + talentValue(hero, 'atkSpeed')) * (1 + eq.atkSpeed)
      * (1 + elixirSpeed(hero)),
    def: hero.def.def + g.def * (hero.level - 1) + eq.def,
    critRate: Math.min(STAT_CAPS.critRate, 0.05 + talentValue(hero, 'critRate') + eq.critRate),
    critDmg: 0.5 + talentValue(hero, 'critDmg') + eq.critDmg,
    armorPierce: Math.min(STAT_CAPS.armorPierce, eq.armorPierce),
    hpRegen: eq.hpRegen,
    goldFind: eq.goldFind,
    maxHp: heroMaxHp(hero),
    // TD 模式的驻守射程下限：英雄站在核心旁不动，近战英雄（射程 1.2）否则在 TD 里等于不存在。
    // 自走棋实测：map_02 / map_03（双路图）下，无此下限时近战英雄必败。
    // 待 M0.5 与设计确认：是给「驻守射程」还是把 TD 英雄改成纯光环型（§3.7 的定位是辅助）。
    range: Math.max(weapon?.range ?? hero.def.range, TD_HERO_RANGE_FLOOR),
    attackType: weapon?.attackType ?? hero.def.attackType,
    weapon,   // 特性（溅射 / 减速 / 对空加成 / 扇形）在 heroAttack 里用
  };
}

export const TD_HERO_RANGE_FLOOR = 4.0;

/** §7.7：「脱离范围 1 秒后继续前进」——离开仇恨范围后还会被追打这么久，防止「进退风筝」。 */
export const AGGRO_HOLD_SEC = 1;

export const cumulativeExp = (level) => {
  // Σ_{l=1..level-1} expToNext(l) = 40(level-1) + 15(level-1)(level-2)
  // 文档 v0.7 的这张表原来在 8/10/15/20 级用了 40N+15N(N-1)，那等于把**本级**的 expToNext(N) 也算进去，
  // 比「到达 N 级」应有的口径多一级（而满级那一行 9240 用的又是本式，同一张表两种算法）。
  // 判定按定义走：expToNext 是「从 lv 升到 lv+1 的经验」，到达 N 只能是前 N−1 级之和——所以 §84 改的是文档。
  // 验收标准是「4 人局到达等级 17-21」，本式落在 20 级，见 tests/rules.test.js 的 §3.2 用例（逐节点钉住）。
  const n = level - 1;
  return 40 * n + 15 * n * (n - 1);
};

/* ---------- 建局 ---------- */

export function createMatch({
  mapId = 'map_01', difficulty = 'normal', heroId = 'hero_warrior',
  players = 1, seed = 20260922, rngState = null, startGold = ECONOMY.startGold,
  reviveMul = 1,   // §3.6：人物等级带来的复活加速（1 = 没加成）
  length = 'short',   // short = 12 波（首发默认）；long = 30 波长局（§6.4 第 7 条）
} = {}) {
  const mapDef = MAPS[mapId];
  if (!mapDef) throw new Error(`未知地图: ${mapId}`);
  if (!HEROES[heroId]) throw new Error(`未知英雄: ${heroId}`);
  const map = buildMap(mapDef);
  const heroDef = HEROES[heroId];
  // 双守护目标（§2.2 map_06）：cores[0] 就是 m.core，老代码（HUD / 存档 / 结算）不用改
  const cores = (mapDef.cores ?? [map.core]).map((cell) => ({ cell: { ...cell }, hp: mapDef.coreHp, maxHp: mapDef.coreHp }));

  const rng = makeRng(seed);
  if (rngState != null) rng.setState(rngState);
  const state = {
    seed, rng, mapId, difficulty, heroId, players,
    startGold,
    reviveMul,      // §3.6：复活时间倍率（人物等级越高越小）
    length,
    waves: length === 'long' ? WAVES_LONG : WAVES,
    bountyMul: length === 'long' ? LONG_RUN.bountyMul : ECONOMY.bountyMul,
    spawnCounter: 0,   // 怪物 uid 的递增源：必须初始化，否则 uid 全是 NaN（联机端会把所有怪当成同一只）
    diff: DIFFICULTY[difficulty],
    map,
    time: 0,
    gold: startGold,   // §3.6：人物等级 +1%/级（由局外档案传入，内核不关心它从哪来）
    lumber: Array.from({ length: Math.max(1, players) }, () => 0),
    cores,
    core: cores[0],
    towers: [],
    monsters: [],
    projectiles: [],
    wave: { index: 0, phase: 'prep', timer: TIMING.prepBeforeFirst, spawned: 0, total: 0, queue: [] },
    hero: {
      def: heroDef,
      level: 1,
      exp: 0,
      hp: heroDef.hp,
      cell: { ...map.core },
      cooldown: 0,
      skillCd: [0, 0, 0],
      skillUnlocked: [true, false, false],
      buffs: [],
      attackBuff: 0,
      reduceBuff: 0,
      dead: false,
      reviveTimer: 0,
      invulnUntil: 0,   // §7.6 复活保护：复活后 3 秒无敌
      fastUntil: 0,     // §7.6 赶路补偿：复活后移速 +50%，持续 10 秒（防守模式用得到）
    },
    bag: {},
    scrolls: 0,        // §5.5.1：回城卷轴（不是药品，不占背包 3 格；防守模式里用来绕过 30s 回城冷却）
    /**
     * §5.5.1：本模式不卖的商品（内核只说「登记过就不卖」，具体原因由模式自己写）。
     *
     * STATUS §3.1 #20（已拍板）：**群体治疗符撤柜**。它 200 金回 300、CD 45 秒、限购 2，
     * 而大药 120 金回 500、不限购——**严格被支配**（§92.1 量的）。它的卖点是「全队治疗」，
     * 而「联机每人一个英雄」还没做（§3.1 #13 推迟到 M3），现在「全队」只有你自己，
     * 摆着它只会让人花更多钱买到更少的治疗。等 M3 那件事落地再上架。
     */
    shopBlocked: {
      scroll_town: '塔防里人物不下防线，回城卷轴用不上',
      pot_group: '全队治疗要等「每人一个英雄」；现在它严格不如大药（200 金回 300 vs 120 金回 500）',
    },
    shopCast: null,    // §5.5：波次进行中的补给读条（备战期买东西不走这里）
    potionCd: {},
    shopBought: {},
    bookLevelBonus: 0,
    inventory: [],
    equipped: { weapon: null, armor: null, trinket: null },
    // rolls：掉落判定的**次数**（按档位）。§5.2 的「橙装 5-8 局一次」是概率口径，
    // 用 10 局样本去数橙装件数是在赌运气（见验证记录 §57）；有这张表就能把期望值直接算出来。
    stats: { kills: 0, leaks: 0, normalKills: 0, damage: {}, goldEarned: 0, drops: 0, crafts: 0, rolls: { normal: 0, elite: 0, boss: 0, chest: 0 } },
    result: null,
    events: [],
  };
  // §5.2 / §5.4：英雄属性要读身上的三件装备。给英雄一个指向 `m.equipped` 的**同一个对象**，
  // 这样 `heroStats(hero)` / `heroMaxHp(hero)` 不用到处加参数，换装（autoEquip / 读档 / 联机快照）
  // 只要改 `m.equipped` 里的槽位就自动生效。
  state.hero.equipped = state.equipped;
  applyPlayerScale(state, players);   // §1.6：怪物数量 / 生命 / 金币按人数缩放（塔位不随人数变）
  return state;
}

/**
 * §1.6：把人数缩放应用到已建的局。
 * 单独抽出来的原因：联机房的 `players = 人数上限`，而 §1.5 要求「人数不足按 §1.6 缩放」——
 * 房间要在**第一波出怪之前**按真实名册重算一次（出怪之后不再改，免得半局换难度）。
 */
export function applyPlayerScale(m, players) {
  m.scale = playerScaleOf(players);
  m.bountyMul = (m.length === 'long' ? LONG_RUN.bountyMul : ECONOMY.bountyMul) * m.scale.gold;
  return m.scale;
}

export const addLog = (m, text, kind = 'info') => { m.events.push({ t: +m.time.toFixed(1), text, kind }); };

// 金币是共享池（§1.2）；木材按玩家记账，单人局用 0 号位代表本机玩家。
// `playerIndex` 必须由调用方给对：联机时它是**发起指令的那个人的槽位**，
// 否则「谁买技能书 / 谁快速复活」会花房主的木材（§36 之后同一类问题的第三处）。
function spend(m, gold, lumber = 0, playerIndex = 0) {
  if (m.gold < gold) return false;
  if (lumber > 0 && (m.lumber[playerIndex] ?? 0) < lumber) return false;
  m.gold -= gold;
  if (lumber > 0) m.lumber[playerIndex] -= lumber;
  return true;
}

/* ---------- 建造 / 升级 / 出售（§8.2） ---------- */

export const towerAtSlot = (m, slotIndex) => m.towers.find((t) => t.slot === slotIndex) ?? null;

export function buildTower(m, slotIndex, towerId, owner = 0) {
  const def = TOWERS[towerId];
  // §123：**必须是整数下标**。以前这里只比了 `slotIndex < 0 / >= length`——而字符串 `'abc'`
  // 跟数字比大小永远是 false，两道关都过得去，于是 `m.map.slots['abc']` 是 undefined，
  // 下一行 `towerStatsAt(map, undefined)` 读 `cell.x` 抛 TypeError；那条指令从 WS 进来、
  // 抛在消息回调里没人接，**整个服务器进程当场退出**（验证记录 §123 的现场）。
  if (!def || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= m.map.slots.length) return false;
  if (towerAtSlot(m, slotIndex)) return false;
  if (!spend(m, def.cost)) return false;
  const cell = m.map.slots[slotIndex];
  const stats = towerStatsAt(m.map, cell, towerId, 1);
  m.towers.push({
    uid: m.towers.length + 1, towerId, slot: slotIndex, cell,
    level: 1, cooldown: 0, priority: 'front', invested: def.cost,
    stats,
    maxHp: towerMaxHp(1), hp: towerMaxHp(1),   // §7.4：5★/6★ 图里攻城怪会拆塔
    owner,   // 哪个玩家建的：联机用来上队伍色（§14.4）
  });
  addLog(m, `建造 ${def.name}`);
  return true;
}

export function upgradeTower(m, slotIndex) {
  const t = towerAtSlot(m, slotIndex);
  if (!t) return false;
  const cost = upgradeCost(t.towerId, t.level);
  if (cost == null || !spend(m, cost)) return false;
  t.level += 1;
  t.invested += cost;
  t.stats = towerStatsAt(m.map, t.cell, t.towerId, t.level);
  t.maxHp = towerMaxHp(t.level);
  t.hp = t.maxHp;   // 升级顺带修满（省一次点击）
  addLog(m, `${TOWERS[t.towerId].name} 升到 ${t.level} 级`);
  return true;
}

/** §7.4：塔 HP 400（随等级 ×1.4/级）。 */
export const towerMaxHp = (level) => Math.round(400 * 1.4 ** (level - 1));
/**
 * §155：攻城图上「修塔」的价钱（§7.4）。以前它是 `repairTower()` 里的一个字面量 60，
 * 而 UI 那颗按钮写死了同一句「修塔 60 金」——两处各写一份，改价就会对不上。现在只在这里定。
 */
export const TOWER_REPAIR_GOLD = 60;

/** 花 60 金币把塔修满（§7.4 的「瞬间满血」档）。 */
export function repairTower(m, slotIndex) {
  const t = towerAtSlot(m, slotIndex);
  if (!t || !m.map.def.siege) return false;
  if (t.hp >= t.maxHp || m.gold < TOWER_REPAIR_GOLD) return false;
  m.gold -= TOWER_REPAIR_GOLD;
  t.hp = t.maxHp;
  addLog(m, `${TOWERS[t.towerId].name} 已修复`);
  return true;
}

export function sellTower(m, slotIndex) {
  const i = m.towers.findIndex((t) => t.slot === slotIndex);
  if (i < 0) return false;
  const refund = Math.floor(m.towers[i].invested * TOWER_SELL_REFUND);
  m.gold += refund;
  addLog(m, `出售 ${TOWERS[m.towers[i].towerId].name}，返还 ${refund} 金`);
  m.towers.splice(i, 1);
  return true;
}

export function setPriority(m, slotIndex, priority) {
  const t = towerAtSlot(m, slotIndex);
  if (!t || !TARGET_PRIORITIES.includes(priority)) return false;
  t.priority = priority;
  return true;
}

/* ---------- 波次（§6.4） ---------- */

export function waveQueue(waveIndex, waves = WAVES, countMul = 1, speedMul = 1) {
  const def = waves[waveIndex - 1];
  if (!def) return [];
  const entries = [];
  def.groups.forEach((g, gi) => {
    // §1.6：出怪量按人数缩放（单人 ×0.60、4 人 ×1.00）。Boss 那种 count=1 的组至少留 1 只。
    const n = Math.max(1, Math.round(g.count * countMul));
    // §2.4：出怪**速度**按难度缩放（困难 ×1.10、噩梦 ×1.20 → 间隔更短）。
    // 这一列以前定义了从来没被读过：困难/噩梦的怪来得跟普通一样快。
    for (let i = 0; i < n; i++) entries.push({ mobId: g.mobId, at: (i * g.interval + gi * 0.35) / (speedMul || 1) });
  });
  return entries.sort((a, b) => a.at - b.at);
}

export function startWaveEarly(m, playerIndex = 0) {
  if (m.wave.phase !== 'prep' || m.wave.index >= (m.waves ?? WAVES).length) return false;
  m.lumber[playerIndex] += ECONOMY.earlyWaveLumber;   // 木材是个人资源：奖励归按下按钮的那个人
  m.wave.timer = 0;
  addLog(m, '提前开波（+3 木材）');
  return true;
}

function beginWave(m) {
  const next = m.wave.index + 1;
  const queue = waveQueue(next, m.waves ?? WAVES, m.scale?.count ?? 1, m.diff?.spawn ?? 1);
  if (!queue.length) return;
  m.wave = { index: next, phase: 'spawning', timer: 0, spawned: 0, total: queue.length, queue };
  addLog(m, `第 ${next} 波开始（${queue.length} 只）`);
}

function finishWave(m) {
  const w = m.wave.index;
  const gold = ECONOMY.waveGold(w);
  const lumber = ECONOMY.waveLumber(w);
  m.gold += gold;
  m.stats.goldEarned += gold;
  for (let i = 0; i < m.lumber.length; i++) m.lumber[i] += lumber;
  addLog(m, `第 ${w} 波清场：+${gold} 金 / +${lumber} 木材（每人）`);
  // §5.2 的波次宝箱：每 4 波一件（12 波局共 3 件，算进「一局 10-14 件」）
  if (w % CHEST_EVERY_WAVES === 0) {
    countRoll(m, 'chest');
    dropFor(m, 'chest');
    addLog(m, `第 ${w} 波宝箱：+1 件装备`);
  }
  if (w >= (m.waves ?? WAVES).length) {
    m.result = 'win';
    addLog(m, `${(m.waves ?? WAVES).length} 波全部清场，胜利`);
    return;
  }
  // 长局用自己的间隔（§6.4 第 7 条 + 附录 B 的 25-40 分钟），短局仍是 12 秒
  const prep = m.length === 'long' ? LONG_RUN.prepTime : TIMING.prepTime;
  m.wave = { index: w, phase: 'prep', timer: prep, spawned: 0, total: 0, queue: [] };
}

/* ---------- 怪物（§6） ---------- */

function spawnMonster(m, mobId, pathIndex) {
  const def = MONSTERS[mobId];
  const path = m.map.paths[pathIndex];
  // 长局模式下 Boss 用 §6.3 的长局血量列（12 波局用短局列）
  const baseHp = (m.length === 'long' ? LONG_RUN_BOSS_HP[mobId] : undefined) ?? def.hp;
  // §1.6：怪物生命按人数缩放（单人 ×0.85、4 人 ×1.00）
  const hp = baseHp * m.diff.hp * (m.scale?.hp ?? 1);
  const mon = {
    uid: ++m.spawnCounter,
    mobId, def, pathIndex, dist: 0, cell: { ...path.spawn },
    hp, maxHp: hp, armor: def.armor, armorType: def.armorType,
    speed: def.speed, attack: def.attack * m.diff.atk, atkSpeed: def.atkSpeed,
    cooldown: 0, isAir: !!def.isAir, effects: [], dead: false, attacking: false,
    coreIndex: path.coreIndex ?? 0,   // 双核心地图：这只怪往哪个核心走
  };
  m.monsters.push(mon);
  return mon;
}

// 怪物自带 cell 就用它（防守模式的怪没有路径，只有当前位置）；TD 的怪每帧也会刷新 cell
const monsterCell = (m, mon) => mon.cell ?? cellAt(m.map.paths[mon.pathIndex], mon.dist);

function applySlow(mon, pct, until) {
  pct = Math.min(STAT_CAPS.slow, pct);   // §7.3：减速上限 60%
  const e = mon.effects.find((x) => x.type === 'slow');
  if (e) { e.pct = Math.max(e.pct, pct); e.until = Math.max(e.until, until); return; }
  mon.effects.push({ type: 'slow', pct, until });
}

export function damageMonster(m, mon, amount, source = 'tower') {
  if (mon.dead) return;
  const dealt = Math.max(0, Math.min(mon.hp, amount));
  mon.hp -= dealt;
  m.stats.damage[source] = (m.stats.damage[source] ?? 0) + dealt;
  if (mon.hp > 0) return;
  mon.dead = true;
  m.stats.kills += 1;
  // §3.5 法力涌动：英雄自己的击杀回复 2% 最大生命（塔杀的功劳不算在英雄头上）
  const killHeal = m.hero ? talentValue(m.hero, 'killHealPct') : 0;
  if (killHeal > 0 && source === 'hero' && !m.hero.dead) {
    const max = heroMaxHp(m.hero);
    m.hero.hp = Math.min(max, m.hero.hp + max * killHeal);
  }
  // 模式插件缝：防守模式有自己的赏金/经验/掉落规则（野外怪经验 ×1.5、保底 8 只），
  // 由外部提供 onMonsterKilled 接手；TD 模式不提供，走下面的默认结算。
  if (typeof m.onMonsterKilled === 'function') { m.onMonsterKilled(mon); return; }
  // §5.2 词条「金币掉落 +5%」：只作用于击杀赏金（波次奖励是固定节奏，不跟着涨）
  const goldFind = 1 + equipBonus(m.hero?.equipped ?? m.equipped).goldFind;
  const bounty = Math.round(mon.def.bounty * (m.bountyMul ?? ECONOMY.bountyMul) * goldFind);
  m.gold += bounty;
  m.stats.goldEarned += bounty;
  for (let i = 0; i < m.lumber.length; i++) m.lumber[i] += mon.def.lumber;
  grantExp(m, mon.def.level * 8);
  if (mon.def.tier === 'normal') { m.stats.normalKills += 1; rollNormalDrop(m); }
  else rollDrop(m, mon, mon.def.tier === 'boss' && mon.def.bossTier === 'minor' ? 'elite' : mon.def.tier);
  if (mon.def.onDeath?.splitInto && m.map) {
    for (let i = 0; i < mon.def.onDeath.count; i++) {
      const child = spawnMonster(m, mon.def.onDeath.splitInto, mon.pathIndex);
      child.dist = Math.max(0, mon.dist - GRID.unitPerTile);
    }
  }
}

export function grantExp(m, amount) {
  const h = m.hero;
  h.exp += amount;
  while (h.level < HERO_MAX_LEVEL && h.exp >= cumulativeExp(h.level + 1)) h.level += 1;
  h.def.skills.forEach((s, i) => { if (h.level >= s.unlockLevel) h.skillUnlocked[i] = true; });
  h.hp = Math.min(h.hp, heroMaxHp(h));
}

/** 掉落判定（防守模式的野外怪也用同一套表与保底）。 */
// 普通怪：每 25 只保底 1 件（§5.2，确定性、可测）
function rollNormalDrop(m) {
  if (m.stats.normalKills % NORMAL_MOB_DROP_PITY !== 0) return;
  countRoll(m, 'normal');
  dropFor(m, 'normal');
}

function rollDrop(m, mon, tier) {
  // 精英按概率掉（§5.2 只给了品质表）；Boss 必掉——它是唯一的橙装来源
  const chance = tier === 'boss' ? 1 : ELITE_DROP_CHANCE;
  if (m.rng() > chance * (m.diff.drop ?? 1)) return;
  countRoll(m, tier);
  dropFor(m, tier);
}

/** 记一笔「这个档位真的做了一次品质判定」（= 这个档位掉了几件），§5.2 的期望值靠它算。 */
function countRoll(m, tier) {
  m.stats.rolls = m.stats.rolls ?? {};
  m.stats.rolls[tier] = (m.stats.rolls[tier] ?? 0) + 1;
}

function dropFor(m, tier) {
  const table = DROP_TABLE[tier] ?? DROP_TABLE.normal;
  const roll = m.rng();
  let acc = 0, quality = 'white';
  for (const q of QUALITY_ORDER) {
    acc += table[q] ?? 0;
    if (roll <= acc) { quality = q; break; }
  }
  const slotIds = Object.keys(EQUIP_SLOTS);
  const slot = slotIds[Math.floor(m.rng() * slotIds.length)];
  const item = makeEquipment(m, slot, quality, ilvlForWave(Math.max(1, m.wave.index)));
  m.inventory.push(item);
  m.stats.drops += 1;
  autoEquipIfBetter(m, item);
  return item;
}

/* ---------- 装备（§5.1-§5.4.1） ---------- */

const AFFIX_BASE = { critRate: 0.03, critDmg: 0.15, armorPierce: 0.05, maxHp: 40, dmgReduce: 0.04, hpRegen: 2, attack: 6, goldFind: 0.05 };
// §4.2 的词条数是**按品质写死的**（白 0 / 蓝 2 / 紫 3 / 橙 4），首发的裁剪只说了「去掉绿档」，
// 没有说把剩下的四档重新编号——所以蓝仍然是 2 条，不是 1 条（原来写成了 0/1/2/3，等于把阶梯整体压了一档）。
const affixCountFor = (q) => (q === 'white' ? 0 : q === 'blue' ? 2 : q === 'purple' ? 3 : 4);

/** 掷一条词条（品质决定条数，强化 +3/+5 各再解锁一条，都走这里） */
const rollAffix = (m, slot, ilvl) => {
  const id = EQUIP_SLOTS[slot].affixPool[Math.floor(m.rng() * EQUIP_SLOTS[slot].affixPool.length)];
  return { id, value: +(AFFIX_BASE[id] * (1 + 0.05 * (ilvl - 1))).toFixed(3) };
};

export function makeEquipment(m, slot, quality, ilvl) {
  const affixes = Array.from({ length: affixCountFor(quality) }, () => rollAffix(m, slot, ilvl));
  const baseAttrs = {};
  for (const [k, v] of Object.entries(EQUIP_SLOTS[slot].base)) {
    baseAttrs[k] = +(v * QUALITY[quality].mul * (1 + 0.08 * (ilvl - 1))).toFixed(2);
  }
  const item = {
    uid: `it_${m.stats.drops}_${m.inventory.length}_${Math.floor(m.rng() * 9999)}`,
    slot, quality, ilvl, baseAttrs, affixes, plus: 0, invested: 0,   // §4.4：强化等级与「投入金币」（出售按它返还）
  };
  // §4.1 首发 4 类武器：掉落时就定类型，它决定英雄的攻击档（不是随机词条那种「数值微调」）
  if (slot === 'weapon') item.weaponId = WEAPON_IDS[Math.floor(m.rng() * WEAPON_IDS.length)];
  return item;
}

export const itemScore = (item) =>
  item.ilvl * QUALITY[item.quality].mul + item.affixes.reduce((s, a) => s + a.value * 10, 0);

function autoEquipIfBetter(m, item) {
  const cur = m.equipped[item.slot];
  if (!cur || itemScore(item) > itemScore(cur)) m.equipped[item.slot] = item;
}

export function craftEquipment(m, slot, quality) {
  const idx = QUALITY_ORDER.indexOf(quality);
  if (idx < 0 || idx >= QUALITY_ORDER.length - 1) return false;
  const matches = m.inventory.filter((i) => i.slot === slot && i.quality === quality);
  if (matches.length < EQUIP_CRAFT.need) return false;
  const used = matches.slice(0, EQUIP_CRAFT.need);
  m.inventory = m.inventory.filter((i) => !used.includes(i));
  const ilvl = Math.min(EQUIP_ILLVL_MAX, Math.max(...used.map((i) => i.ilvl)) + EQUIP_CRAFT.ilvlBonus);
  const out = makeEquipment(m, slot, QUALITY_ORDER[idx + 1], ilvl);
  // §4.4：合成「保留最高强化等级 −2」（投入金币不继承——合成是把三件换一件，不是强化）
  out.plus = Math.max(0, Math.max(...used.map((i) => i.plus ?? 0)) - EQUIP_CRAFT.plusKeepPenalty);
  m.inventory.push(out);
  autoEquipIfBetter(m, out);
  m.stats.crafts += 1;
  addLog(m, `合成：3 件${QUALITY[quality].name}${EQUIP_SLOTS[slot].name} → 1 件${QUALITY[out.quality].name}（ilvl ${out.ilvl}${out.plus ? ` +${out.plus}` : ''}）`);
  return true;
}

/* ---------- 强化 / 穿戴 / 出售（§4.4 / §5.4） ---------- */

/**
 * §3.8 / §5.4 首发强化：+1..+5，每级属性 +6%，+3 与 +5 各解锁 1 条额外词条。
 * （完整方案按 §4.2 分品质给上限 白+3/蓝+7/紫+9/橙+10，首发统一 +5。）
 */
export const ENHANCE = { max: 5, step: 0.06, affixAt: [3, 5] };

/** §4.4：强化成本 `60 × n^1.6`（n = 目标等级）——+1 60 金、+3 348、+5 788；无失败，线性必成。 */
export function enhanceCostOf(item) {
  const n = (item?.plus ?? 0) + 1;
  return n > ENHANCE.max ? null : Math.round(60 * n ** 1.6);
}

/** 在背包或身上按 uid 找一件装备 */
const itemByUid = (m, uid) => {
  for (const slot of Object.keys(m.equipped ?? {})) if (m.equipped[slot]?.uid === uid) return m.equipped[slot];
  return m.inventory.find((it) => it.uid === uid) ?? null;
};

export function enhanceItem(m, uid) {
  const item = itemByUid(m, uid);
  const cost = enhanceCostOf(item);
  // 脏数据兜底（存档 / 服务端快照都可能带未知部位或品质）：不许在这里抛异常，
  // 否则点一下背包就把指令处理打断（§21.1 的「坏档不该把界面带崩」同一条）
  if (!item || !EQUIP_SLOTS[item.slot] || !QUALITY[item.quality] || cost == null || m.gold < cost) return false;
  m.gold -= cost;
  item.invested = (item.invested ?? 0) + cost;
  item.plus = (item.plus ?? 0) + 1;
  if (ENHANCE.affixAt.includes(item.plus)) item.affixes.push(rollAffix(m, item.slot, item.ilvl));
  addLog(m, `强化 ${QUALITY[item.quality].name}${EQUIP_SLOTS[item.slot].name} +${item.plus}（-${cost} 金${ENHANCE.affixAt.includes(item.plus) ? '，解锁 1 条词条' : ''}）`);
  return true;
}

/** §5.4：局内可自由换装（无消耗）——换下来的那件回背包。 */
export function equipItem(m, uid) {
  const i = m.inventory.findIndex((it) => it.uid === uid);
  if (i < 0) return false;
  const incoming = m.inventory[i];
  if (!EQUIP_SLOTS[incoming.slot]) return false;
  const outgoing = m.equipped[incoming.slot] ?? null;
  m.inventory.splice(i, 1);
  m.equipped[incoming.slot] = incoming;
  if (outgoing) m.inventory.push(outgoing);
  addLog(m, `换上 ${QUALITY[incoming.quality]?.name ?? ''}${EQUIP_SLOTS[incoming.slot].name} ilvl${incoming.ilvl}${incoming.plus ? ` +${incoming.plus}` : ''}`);
  return true;
}

/** §4.4 / §5.4：出售返还**投入金币 ×0.7**（没强化过的掉落就是 0 金）；紫 / 橙额外返还木材 30，木材记在发起人名下。 */
export function sellItem(m, uid, playerIndex = 0) {
  const slot = Object.keys(m.equipped ?? {}).find((s) => m.equipped[s]?.uid === uid);
  const item = slot ? m.equipped[slot] : m.inventory.find((it) => it.uid === uid);
  if (!item) return false;
  const refund = Math.floor((item.invested ?? 0) * EQUIP_SELL_REFUND);
  const lumber = QUALITY_ORDER.indexOf(item.quality) >= QUALITY_ORDER.indexOf('purple') ? EQUIP_SELL_BONUS_LUMBER : 0;
  m.gold += refund;
  if (lumber) m.lumber[playerIndex] = (m.lumber[playerIndex] ?? 0) + lumber;
  if (slot) m.equipped[slot] = null;
  else m.inventory = m.inventory.filter((it) => it.uid !== uid);
  addLog(m, `出售 ${QUALITY[item.quality]?.name ?? item.quality ?? '?'}${EQUIP_SLOTS[item.slot]?.name ?? item.slot ?? '装备'}：+${refund} 金${lumber ? ` / +${lumber} 木材` : ''}`);
  return true;
}

export function craftableSlots(m) {
  const out = [];
  for (const slot of Object.keys(EQUIP_SLOTS)) {
    for (const q of QUALITY_ORDER) {
      if (q === 'orange') continue;
      const n = m.inventory.filter((i) => i.slot === slot && i.quality === q).length;
      if (n >= EQUIP_CRAFT.need) out.push({ slot, quality: q, count: n });
    }
  }
  return out;
}

/* ---------- 英雄技能（§3.3 / §3.5） ---------- */

/**
 * §132：技能的**实际等级** = 按英雄等级算出来的那一档 + 精研技能书的加成（§3.2 的「加速器」）。
 * 以前这里写的是 `skillLevelOf(...) + (h.def.skills.includes(def) ? 0 : 0)`——那半截 `0 : 0`
 * 就是「本来要加书本加成」的位置留下的占位；于是 `m.bookLevelBonus`（300 金一本、限购 2）
 * **买了没有任何效果**。客户端技能行也有一份内联的同样公式，两边必须走这一个出口。
 *
 * STATUS §3.1 #26（已拍板）：**本代技能只有 2 档**（`SKILL_MAX_LEVEL`），所以这里封的是 2——
 * 精研技能书（+1）就等于「把一档拉满」，第二本没有意义，商店的限购也从 2 改成 1。
 */
export const skillLevel = (m, def) =>
  Math.min(SKILL_MAX_LEVEL, skillLevelOf(m.hero.level, def.unlockLevel) + (m.bookLevelBonus ?? 0));

export function castSkill(m, index) {
  const h = m.hero;
  if (h.dead || !h.skillUnlocked[index] || h.skillCd[index] > 0) return false;
  const def = index < 2 ? h.def.skills[index] : h.def.thirdSkill;
  if (!def) return false;
  const lv = skillLevel(m, def);
  const pick = (arr) => (arr ? arr[Math.max(0, Math.min(arr.length - 1, lv - 1))] : 0);
  // §3.5 咒术精通：技能伤害 +10%。只乘伤害——治疗（圣光术）、减伤（守护结界）、
  // 减速（时间扭曲）、印记这类数值不是「技能伤害」，不跟着涨。
  const spellMul = 1 + talentValue(h, 'spellDmg');
  const hit = (v) => Math.max(1, Math.floor(v * spellMul));
  const nearby = (radius, airOk = true) => m.monsters
    .filter((mo) => !mo.dead && (airOk || !mo.isAir) && gridDist(monsterCell(m, mo), h.cell) <= radius)
    .sort((a, b) => b.dist - a.dist);

  switch (def.id) {
    case 'sk_whirl':
      for (const t of nearby(def.radius, false).slice(0, def.maxTargets)) damageMonster(m, t, hit(pick(def.dmg)), 'hero');
      break;
    case 'sk_warcry':
      // §133：加成**记在 buff 上**、由 heroStep 每 tick 从还活着的 buff 里重算（以前是「直接写
      // attackBuff + 塞一个不带到数值的 buff」，而到期清理只认 `type === 'atk'`——见下）
      h.buffs.push({ type: 'atk', until: m.time + def.duration, atkPct: pick(def.atkPct) });
      break;
    case 'sk_sunder': {
      const t = nearby(6)[0];
      if (!t) return false;
      const br = pick(def.armorBreak);
      t.armor += br;
      t.effects.push({ type: 'armorBreak', until: m.time + def.duration, value: br });
      damageMonster(m, t, hit(pick(def.dmg)), 'hero');
      break;
    }
    case 'sk_blizzard': {
      const anchor = nearby(def.radius + 2)[0];
      if (!anchor) return false;
      const cell = monsterCell(m, anchor);
      for (const t of m.monsters.filter((mo) => !mo.dead && gridDist(monsterCell(m, mo), cell) <= def.radius)) {
        t.effects.push({ type: 'dot', until: m.time + def.duration, dps: hit(pick(def.hps)), tickAt: m.time });
        damageMonster(m, t, hit(pick(def.hps)), 'hero');
      }
      break;
    }
    case 'sk_arcanebolt': {
      const t = nearby(8)[0];
      if (!t) return false;
      const bonus = t.armorType === 'fortified' ? def.fortifiedBonus : 0;
      damageMonster(m, t, computeDamage({
        atk: hit(pick(def.dmg)), attackType: 'magic', armor: t.armor, armorType: t.armorType,
        armorPierce: def.armorPierce, bonus, rng: m.rng,
      }).damage, 'hero');
      break;
    }
    case 'sk_multishot':
      for (const t of nearby(def.spread + 5).slice(0, pick(def.arrows))) damageMonster(m, t, hit(pick(def.dmg)), 'hero');
      break;
    case 'sk_mark': {
      const t = nearby(8)[0];
      if (!t) return false;
      t.effects.push({ type: 'mark', until: m.time + def.duration, value: pick(def.dmgTakenPct) });
      break;
    }
    case 'sk_holy':
      h.hp = Math.min(heroMaxHp(h), h.hp + pick(def.heal));
      break;
    case 'sk_barrier':
      h.buffs.push({ type: 'reduce', until: m.time + def.duration, reducePct: pick(def.reducePct) });
      break;
    case 'sk_timelock':
      for (const t of nearby(def.radius)) applySlow(t, def.slowPct, m.time + def.duration);
      break;
    case 'sk_windwalk':
      h.buffs.push({ type: 'wind', until: m.time + def.duration, speedPct: def.speedPct, dodgePct: def.dodgePct });
      break;
    case 'sk_hammer': {
      const t = nearby(6)[0];
      if (!t) return false;
      // §3.5：制裁之锤的眩晕「对 Boss 减半为 0.75s」——不变身成 1.5 秒的原因是 §7.7 的眩晕上限就是 1.5s，
      // 让 Boss 也吃满 1.5 秒等于把「控制 Boss」做成了主要战术
      const stun = t.def?.tier === 'boss' ? def.stun / 2 : def.stun;
      t.effects.push({ type: 'stun', until: m.time + stun });
      damageMonster(m, t, hit(pick(def.dmg)), 'hero');
      break;
    }
    default: return false;
  }
  const cdr = Math.min(HERO_LEVEL_GAIN.cdrCap, HERO_LEVEL_GAIN.cdr * (h.level - 1));
  h.skillCd[index] = def.cooldown * (1 - cdr);
  addLog(m, `释放 ${def.name}`);
  return true;
}

/**
 * §7.6 快速复活的价格（木材）。**导出成常量**：界面要照着它决定按钮灰不灰、写多少木，
 * 以前这个数只写在函数体里，界面只能各抄一份——抄错一次就是「按钮说 40、内核扣 50」。
 */
export const REVIVE_LUMBER = 50;

export function reviveNow(m, playerIndex = 0) {
  if (!m.hero.dead || (m.lumber[playerIndex] ?? 0) < REVIVE_LUMBER) return false;
  m.lumber[playerIndex] -= REVIVE_LUMBER;
  m.hero.dead = false;
  m.hero.reviveTimer = 0;
  m.hero.hp = heroMaxHp(m.hero);
  m.hero.invulnUntil = m.time + HERO_REVIVE.invulnSec;   // 快速复活同样吃 §7.6 的复活保护
  m.hero.fastUntil = m.time + HERO_REVIVE.fastSec;
  addLog(m, `快速复活（-${REVIVE_LUMBER} 木材）`);
  return true;
}

/* ---------- 商店与消耗品（§5.5） ---------- */

export function shopPriceOf(m, itemId) {
  const item = SHOP_ITEMS.find((i) => i.id === itemId);
  if (!item) return null;
  const bought = m.shopBought[itemId] ?? 0;
  if (item.limit != null && bought >= item.limit) return null;
  return {
    gold: Math.round(item.priceGold * (1 + (item.priceStepPct ?? 0) * bought)),
    lumber: item.priceLumber ?? 0,
  };
}

export function buyItem(m, itemId, playerIndex = 0) {
  const item = SHOP_ITEMS.find((i) => i.id === itemId);
  const price = shopPriceOf(m, itemId);
  // §5.5.3：药品共 3 格——不能囤成「移动血库」（价格递增挡不住无脑囤药，这条才是硬约束）
  if (item?.type === 'potion' && potionCount(m) >= (item.bagSlots ?? POTION_BAG_SLOTS)) return false;
  // §5.5.1：回城卷轴是防守模式的玩意儿（塔防里人物不下防线、商店就在核心旁），别让塔防白花 80 金
  // 注意：内核不许按模式分支（§12.1 有静态检查），模式自己往 m.shopBlocked 里登记要禁售的商品
  if (m.shopBlocked?.[itemId]) return false;
  /**
   * STATUS §3.1 #14（已拍板）：**商店在基地里**——防守模式的商店不是随身商店，人得走回去才能买
   * （§5.5 原话就是「基地内」）。内核依旧不认模式：它只认模式登记的 `m.shopNear = {x, y, r}`
   * （防守模式在 `createDefenseMatch` 里填基地中心与半径），塔防没有这个字段、照旧随处可买。
   */
  if (m.shopNear && gridDist(m.hero?.cell ?? m.shopNear, m.shopNear) > m.shopNear.r) return false;
  if (m.shopCast) return false;   // 一次只读一条，读条中不能再下单（也别重复扣钱）
  if (!item || !price || !spend(m, price.gold, price.lumber, playerIndex)) return false;
  m.shopBought[itemId] = (m.shopBought[itemId] ?? 0) + 1;
  // §5.5.3 药品平衡的第二个读数口：药品花掉的钱是**从塔的预算里抠的**，
  // 只统计「花了多少」看不出问题，要和「这些钱本来能造什么」一起看（工具里换算成箭塔数）
  if (item.type === 'potion') m.stats.potionGold = (m.stats.potionGold ?? 0) + (price.gold ?? 0);
  // §5.5「补给有代价」：波次进行中下单要读条 3 秒（备战期是秒到）。钱先扣、货 3 秒后到——
  // 「波次里临时补一口」从此是一次要付 3 秒的决策，而不是随手点一下。
  if (m.wave && m.wave.phase !== 'prep') {
    m.shopCast = { itemId, until: m.time + SHOP_CAST_SEC };
    addLog(m, `${item.name}：波次中补给，读条 ${SHOP_CAST_SEC} 秒`);
    return true;
  }
  grantItem(m, item);
  return true;
}

/** 把买到的东西真正给到玩家（备战期买完就给；波次中是读条结束那一下给）。 */
function grantItem(m, item) {
  if (item.type === 'potion') m.bag[item.id] = (m.bag[item.id] ?? 0) + 1;
  else if (item.effect === 'unlock_third') { m.hero.skillUnlocked[2] = true; addLog(m, '秘传技能书：解锁第 3 个主动技能'); }
  else if (item.effect === 'level_up') { m.bookLevelBonus += 1; addLog(m, '精研技能书：技能等级 +1'); }
  else if (item.type === 'elixir') {
    // §133：攻击加成也要**记进 buff**（以前这里只写 attackBuff，而到期清理只认 `type === 'atk'`，
    // 于是狂战药剂加的那 25% 攻击在**下一个 tick** 就被抹掉——150 金买了个日志行）
    m.hero.buffs.push({
      type: 'elixir', until: m.time + item.duration,
      atkPct: item.atkPct ?? 0, atkSpeedPct: item.atkSpeedPct ?? 0,
    });
    addLog(m, `使用 ${item.name}`);
  }
  // §5.5.1 回城卷轴：以前只写一行日志，钱花了东西没进包（验证记录 §55）。
  // 它不是药品，不占 §5.5.3 的 3 格，单独记个数。
  else if (item.type === 'scroll') {
    m.scrolls = (m.scrolls ?? 0) + 1;
    addLog(m, `回城卷轴 ×${m.scrolls} 已入包`);
  }
}

/** 身上一共有几瓶药（§5.5.3 的「药品共 3 格」按总数算，不按种类）。 */
export const potionCount = (m) =>
  Object.entries(m.bag ?? {}).reduce((n, [id, count]) => (isPotion(id) ? n + count : n), 0);
const isPotion = (id) => SHOP_ITEMS.find((i) => i.id === id)?.type === 'potion';

/**
 * §134：英雄 buff 的到期与派生值（`attackBuff` / `reduceBuff` / `windBuff`）。
 * **两个模式的英雄都要跑这一遍**——它原来只写在 TD 的 `heroStep()` 里，防守那边（自己的
 * `stepHero()`）漏了：buff 永不失效、派生值从不更新；§133 把加成的口径改成「从 buff 重算」之后，
 * 防守模式的战吼 / 药剂 / 守护结界就**全都不生效**了（守誓的结界、游侠的疾风步恰恰在防守里才常用）。
 */
export function updateHeroBuffs(h, now) {
  h.buffs = h.buffs.filter((b) => b.until > now);
  h.attackBuff = h.buffs.reduce((mx, b) => Math.max(mx, b.atkPct ?? 0), 0);
  h.reduceBuff = h.buffs.reduce((mx, b) => Math.max(mx, b.reducePct ?? 0), 0);
  h.windBuff = h.buffs.find((b) => b.type === 'wind') ?? null;
}

/**
 * §137：**怪物身上的状态效果**——DoT（暴风雪）、破甲回滚、到期清理，并返回这一帧的
 * 眩晕 / 减速系数（移动与攻击都要用它）。
 * 这一段原来只写在 TD 的 `monsterStep()` 里；防守的 `stepMonsters()` 从头到尾没读过
 * `mon.effects`——于是防守模式里**减速（冰塔 / 冰霜之触 / 图腾）、眩晕（制裁之锤）、
 * 暴风雪 DoT 全都是空的**，`effects` 还会一直堆着不清理。两个模式各写一份怪物的 tick，
 * 这就是它的共用出口（§134/§135 的同类教训）。
 */
export function stepMonsterEffects(m, mon) {
  for (const e of mon.effects) {
    if (e.type === 'dot' && e.until > m.time && m.time - (e.tickAt ?? 0) >= 1) {
      e.tickAt = m.time;
      damageMonster(m, mon, Math.max(1, Math.floor(e.dps)), 'hero');
    }
    if (e.type === 'armorBreak' && e.until <= m.time) mon.armor -= e.value;
  }
  mon.effects = mon.effects.filter((e) => e.until > m.time);
  const stunned = mon.effects.some((e) => e.type === 'stun' && e.until > m.time);
  const slow = mon.effects.reduce((acc, e) => (e.type === 'slow' && e.until > m.time ? Math.max(acc, e.pct) : acc), 0);
  return { stunned, slow };
}

export function usePotion(m, itemId) {
  const item = SHOP_ITEMS.find((i) => i.id === itemId);
  if (!item || !(m.bag[itemId] > 0) || (m.potionCd[itemId] ?? 0) > 0) return false;
  m.bag[itemId] -= 1;
  // §5.5「药品平衡」的验收要看「单局消耗几次」——这是那条线唯一的读数口（结算面板 / 工具都用它）
  m.stats.potions = (m.stats.potions ?? 0) + 1;
  const heal = item.heal ?? 0;
  m.hero.hp = Math.min(heroMaxHp(m.hero), m.hero.hp + heal);
  m.potionCd[itemId] = item.cooldown ?? 0;
  addLog(m, `使用 ${item.name}（+${heal} 生命）`);
  return true;
}

/* ---------- 战斗推进 ---------- */

/**
 * 英雄的一次普攻（§4.1 的武器特性在这里生效）。TD 与防守共用这一个出口，别各写一套。
 * - 法杖：命中点半径 1.5 溅射，按 §7.1 的距离衰减（落点 100% → 边缘 50%，与炮塔同口径）
 * - 图腾：命中附带 2 秒 20% 减速，可叠 2 层（叠满 40%）
 * - 长弓：对空中单位 +25%
 * - 剑/刃：最多打 3 个目标。原型里英雄没有「朝向」这个概念，所以用「射程内最近的 3 个」代替
 *   §4.1 写的「前方扇形」（验证记录 §62 记了这条简化）
 */
export function heroAttack(m, target) {
  const st = heroStats(m.hero);
  const w = st.weapon;
  const dmgTo = (mo, atk) => damageMonster(m, mo, computeDamage({
    atk, attackType: st.attackType, armor: mo.armor, armorType: mo.armorType,
    critRate: st.critRate, critDmg: st.critDmg, armorPierce: st.armorPierce,
    // §3.5 猎人印记：「目标受到伤害 +20%/35%」是对**所有**来源生效的 debuff，
    // 塔的弹道在 projectileHit 里已经算过它了；英雄自己的普攻也得算，否则「印记只帮塔、不帮自己」。
    bonus: (w?.special?.vsAir && mo.isAir ? w.special.vsAir : 0)
      + (mo.effects?.find((e) => e.type === 'mark' && e.until > m.time)?.value ?? 0),
    rng: m.rng,
  }).damage, 'hero');

  dmgTo(target, st.attack);
  if (w?.special?.splashRadius) {
    const cell = monsterCell(m, target);
    for (const mo of m.monsters) {
      if (mo.dead || mo === target) continue;
      const d = gridDist(monsterCell(m, mo), cell);
      // §7.1：按距离衰减 100% → 50%（以前是一律 75%）
      if (d <= w.special.splashRadius) dmgTo(mo, st.attack * splashScale(d, w.special.splashRadius));
    }
  }
  if (w?.special?.sector) {
    const extra = m.monsters
      .filter((mo) => !mo.dead && mo !== target && gridDist(monsterCell(m, mo), m.hero.cell) <= st.range)
      .sort((a, b) => gridDist(monsterCell(m, a), m.hero.cell) - gridDist(monsterCell(m, b), m.hero.cell))
      .slice(0, w.special.sector - 1);
    for (const mo of extra) dmgTo(mo, st.attack);
  }
  if (w?.special?.slowPct) {
    const e = target.effects.find((x) => x.type === 'slow' && x.from === 'hero');
    const stacks = Math.min(w.special.slowStacks ?? 1, (e?.stacks ?? 0) + 1);
    const until = m.time + w.special.slowSec;
    if (e) { e.stacks = stacks; e.pct = w.special.slowPct * stacks; e.until = until; }
    else target.effects.push({ type: 'slow', pct: w.special.slowPct, until, stacks: 1, from: 'hero' });
  }
}

function pickTarget(m, tower) {
  const inRange = m.monsters.filter((mo) => !mo.dead
    && !(mo.isAir && !tower.stats.hitsAir)
    && gridDist(monsterCell(m, mo), tower.cell) <= tower.stats.range);
  if (!inRange.length) return null;
  switch (tower.priority) {
    case 'strongest': return inRange.reduce((a, b) => (b.hp > a.hp ? b : a));
    case 'weakest': return inRange.reduce((a, b) => (b.hp < a.hp ? b : a));
    case 'air_first': return inRange.find((c) => c.isAir) ?? inRange.reduce((a, b) => (b.dist > a.dist ? b : a));
    default: return inRange.reduce((a, b) => (b.dist > a.dist ? b : a));
  }
}

function towerFire(m, tower) {
  const target = pickTarget(m, tower);
  if (!target) return;
  tower.cooldown = 1 / tower.stats.atkSpeed;
  m.projectiles.push({
    from: project(tower.cell.x, tower.cell.y, 1.1),
    target, stats: tower.stats, damage: tower.stats.damage,
    towerId: tower.towerId, slot: tower.slot, progress: 0, life: 2,
  });
}

function projectileHit(m, p) {
  const target = p.target;
  if (!target || target.dead) return;
  const s = p.stats;
  const mark = target.effects.find((e) => e.type === 'mark');
  const dealt = computeDamage({
    atk: p.damage, attackType: s.attackType, armor: target.armor, armorType: target.armorType,
    targetReduce: -(mark?.value ?? 0), rng: m.rng,
  }).damage;
  const landing = monsterCell(m, target);
  damageMonster(m, target, dealt, p.towerId);
  if (s.special?.splashRadius) {
    for (const mo of m.monsters.filter((x) => !x.dead && x !== target && !x.isAir
      && gridDist(monsterCell(m, x), landing) <= s.special.splashRadius)) {
      const d = gridDist(monsterCell(m, mo), landing);
      damageMonster(m, mo, computeDamage({
        atk: p.damage * splashScale(d, s.special.splashRadius),
        attackType: s.attackType, armor: mo.armor, armorType: mo.armorType, rng: m.rng,
      }).damage, p.towerId);
    }
  }
  if (s.special?.slowPct) applySlow(target, s.special.slowPct, m.time + s.special.slowSec);
  if (s.special?.chainCount) {
    let src = target, dmg = dealt * (1 - s.special.chainDecay);
    const hit = new Set([target.uid]);
    for (let i = 1; i < s.special.chainCount; i++) {
      const next = m.monsters.find((mo) => !mo.dead && !hit.has(mo.uid)
        && gridDist(monsterCell(m, mo), monsterCell(m, src)) <= s.special.chainRange);
      if (!next) break;
      damageMonster(m, next, Math.max(1, Math.floor(dmg)), p.towerId);
      hit.add(next.uid);
      src = next;
      dmg *= (1 - s.special.chainDecay);
    }
  }
}

function heroStep(m, dt) {
  const h = m.hero;
  const stats = heroStats(h);
  if (h.dead) {
    h.reviveTimer -= dt;
    if (h.reviveTimer <= 0) {
      h.dead = false;
      h.hp = stats.maxHp;
      h.invulnUntil = m.time + HERO_REVIVE.invulnSec;   // §7.6：复活后 3 秒无敌
      h.fastUntil = m.time + HERO_REVIVE.fastSec;       // §7.6：赶路补偿 +50% 移速，10 秒
      addLog(m, '英雄复活（3 秒无敌、10 秒加速）');
    }
    return;
  }
  for (let i = 0; i < h.skillCd.length; i++) h.skillCd[i] = Math.max(0, h.skillCd[i] - dt);
  for (const k of Object.keys(m.potionCd)) m.potionCd[k] = Math.max(0, m.potionCd[k] - dt);
  h.buffs = h.buffs.filter((b) => b.until > m.time);
  // §133/§134：到期与派生值走**一个共用出口**（防守那边也要跑同一遍，见 updateHeroBuffs）
  updateHeroBuffs(h, m.time);

  const engaged = m.monsters.some((mo) => !mo.dead && gridDist(monsterCell(m, mo), h.cell) <= 2);
  // §3.7：战斗中 0.5%/s；**脱战 3 秒后**才回到 2%/s（不是一离开怪就回满速）
  if (engaged) h.engagedUntil = m.time + HERO_REGEN.outOfCombatSec;
  const regenPct = m.time >= (h.engagedUntil ?? 0) ? HERO_REGEN.idlePct : HERO_REGEN.combatPct;
  // §5.2 词条「每秒回血」是固定值，和百分比回复叠着走
  h.hp = Math.min(stats.maxHp, h.hp + (stats.maxHp * regenPct + stats.hpRegen) * dt);

  h.cooldown = Math.max(0, h.cooldown - dt);
  if (h.cooldown > 0) return;
  const target = m.monsters
    .filter((mo) => !mo.dead && gridDist(monsterCell(m, mo), h.cell) <= stats.range)
    .sort((a, b) => b.dist - a.dist)[0];
  if (!target) return;
  // §144：药剂攻速已经并进 heroStats（`elixirSpeed`），这里别再单独读一次 buff
  h.cooldown = 1 / stats.atkSpeed;
  heroAttack(m, target);   // §4.1：武器特性（溅射 / 减速 / 对空 / 扇形）都在里面
}

/**
 * §117：怪物光环（`def.aura`）按 `radius` 作用到半径内的同伴，**含携带者自己**。
 *
 * 以前这里只读了 `atkSpeedPct`，而且是在「自己开火」那一支里读的——等于「Boss 自带 15% 攻速」，
 * `radius` 写在那里**从来没人读**；mob_12（亡灵巫师）那条 `aura: { id:'heal', radius:3, hps:20 }`
 * 更是整条没有实现：资料表写着「精英·治疗光环」，实际它一只都不治（验证记录 §117）。
 * 现在两种光环都按同一个口径结算（半径内的怪，含携带者），治疗按秒结算。
 */
export function auraFrom(carriers, mon, bossAurasOn = true) {
  let atkSpeedPct = 0, healHps = 0;
  for (const src of carriers) {
    const aura = src.def.aura;
    // §118：§2.2 的地图表把「**Boss 带光环**」写成 map_06（冰封王座）的独有地形特性，
    // 数据里也躺着 `map_06.bossAura: true`——但此前没有任何读取方，于是**每张图的 Boss 都自带光环**
    // （§117 把光环按半径接上之后就更明显了）。非 Boss 的光环（mob_12 的治疗）不受地图开关影响。
    if (src.def.tier === 'boss' && !bossAurasOn) continue;
    if (src !== mon && gridDist(src.cell, mon.cell) > (aura.radius ?? 0)) continue;
    atkSpeedPct = Math.max(atkSpeedPct, aura.atkSpeedPct ?? 0);
    healHps += aura.hps ?? 0;
  }
  return { atkSpeedPct, healHps };
}

/**
 * 光环携带者（每帧挑一次就够）。**别让每只怪都去遍历全场**：第一版就是那样写的，
 * `npm run bench` 当场从 2050k 掉到 547k 实体·帧/秒（200 实体下 O(n²)）——见 §118.3。
 * 现在按「这一帧用得到吗」分两处调用：治疗只有场上有治疗者时才结算，攻速只在**开火那一刻**读。
 * ponytail: 仍是 O(怪数 × 携带者数)，没做空间索引；等真的出现「携带者几十个 × 场上几百只」
 * 再把携带者按格分桶。现在 200 实体下是 1300k 实体·帧/秒，离 §10.2 的口径还差两个数量级。
 */
export const auraCarriers = (m) => m.monsters.filter((x) => !x.dead && x.def?.aura);

/** 没有携带者时的零开销结果（别每只怪都 new 一个对象） */
const NO_AURA = { atkSpeedPct: 0, healHps: 0 };

/** 测试/调试入口：现挑携带者再结算。 */
export const auraAt = (m, mon) => auraFrom(auraCarriers(m), mon, !!m.map?.def?.bossAura);

function monsterStep(m, dt) {
  const carriers = auraCarriers(m);
  const bossAurasOn = !!m.map?.def?.bossAura;
  const heals = carriers.some((c) => (c.def.aura.hps ?? 0) > 0);
  for (const mon of m.monsters) {
    if (mon.dead) continue;
    // 注意：这里必须按 dist 重新算格子，不能用 monsterCell（它优先读 mon.cell）。
    // 用 monsterCell 会变成「自己读自己」，怪物的 cell 永远停在出生点，塔全部打空。
    const cell = cellAt(m.map.paths[mon.pathIndex], mon.dist);
    mon.cell = cell;
    // §117：光环先结算（下面要按半径找同伴，所以 cell 必须先刷新）
    // 满血的怪不用算治疗（回血封顶 maxHp，算了也是浪费）——压力测试里 200 只怪全是满血，
    // 这一句直接把这个成本抹掉（见 §118.3 的 bench 数字）
    if (heals && mon.hp < mon.maxHp) {
      const { healHps } = auraFrom(carriers, mon, bossAurasOn);
      if (healHps > 0) mon.hp = Math.min(mon.maxHp, mon.hp + healHps * dt);
    }
    // §137：DoT / 破甲回滚 / 到期清理 + 眩晕与减速系数，走共用出口（防守那边也调它）
    const { stunned, slow } = stepMonsterEffects(m, mon);
    const swamp = !mon.isAir && m.map.swamp.has(`${cell.x},${cell.y}`);

    // §7.7 的仇恨范围：Boss 6 格、普通怪 2 格（「远程怪 4 格」这一档在怪物表里没有字段，
    // 见验证记录 §91.3——没有「谁是远程」的数据，实现不出来）
    const aggro = mon.def.tier === 'boss' ? 6 : 2;
    const heroDist = gridDist(cell, m.hero.cell);
    const inAggro = !m.hero.dead && heroDist <= aggro;
    // §7.7：「脱离范围 **1 秒后**继续前进」——脱离仇恨不是立刻停手，还要再追打 1 秒。
    // 没有这 1 秒，玩家可以「进一格挨打、退一格无伤」反复风筝，怪一点脾气都没有。
    if (inAggro) mon.aggroUntil = m.time + AGGRO_HOLD_SEC;
    if (m.hero.dead) mon.aggroUntil = 0;   // 英雄死了就立刻停手（否则会反复重置复活倒计时）
    mon.attacking = inAggro || (!m.hero.dead && m.time < (mon.aggroUntil ?? 0));

    if (mon.attacking) {
      mon.cooldown -= dt;
      if (mon.cooldown <= 0) {
        const aura = carriers.length ? auraFrom(carriers, mon, bossAurasOn) : NO_AURA;
        mon.cooldown = 1 / (mon.atkSpeed * (1 + aura.atkSpeedPct));
        const dodge = heroDodge(m);
        // §7.6 复活保护：复活后 3 秒无敌，刚站起来不该立刻再被打死
        if (m.time < (m.hero.invulnUntil ?? 0)) {
          // 无敌中：这一击不掉血
        } else if (m.rng() >= dodge) {
          const stats = heroStats(m.hero);
          m.hero.hp -= computeDamage({
            atk: mon.attack, attackType: mon.def.attackType, armor: stats.def, armorType: 'heavy',
            targetReduce: heroDamageReduce(m), rng: m.rng,
          }).damage;
          if (m.hero.hp <= 0) {
            m.hero.hp = 0;
            m.hero.dead = true;
            // §7.6 的 15 秒 × §3.6 的人物等级加成（满级快 8.7%）
            m.hero.reviveTimer = HERO_REVIVE.sec * (m.reviveMul ?? 1);
            addLog(m, `英雄阵亡（${m.hero.reviveTimer.toFixed(1)} 秒后复活）`, 'warn');
          }
        }
      }
    }
    /**
     * 只有**贴脸**（≤2 格）才停下来打。更远的仇恨距离上「边走边打」——
     * 否则会出现死锁：Boss 在 6 格外打英雄（它自己咬不到）、英雄射程只有 4 格、
     * 塔又够不着，于是怪停在那儿、这一波永远清不掉（实测圣徒单局卡 1 小时不结束）。
     * §7.7 的原话也是「不打转圈战，避免怪物被卡在图里」。
     */
    const meleeStop = mon.attacking && heroDist <= 2;
    if (!meleeStop && !stunned) {
      // 攻城怪（§7.4，仅 5★/6★ 图）：路径 3 格内若有塔就停下来拆
      const siege = m.map.def.siege && mon.def.siege;
      const target = siege ? m.towers.find((t) => gridDist(t.cell, cell) <= 3) : null;
      if (target) {
        mon.attacking = true;
        mon.cooldown -= dt;
        if (mon.cooldown <= 0) {
          mon.cooldown = 1 / mon.atkSpeed;
          target.hp -= mon.attack;
          if (target.hp <= 0) {
            const refund = Math.floor(target.invested * 0.5);   // §7.4：被摧毁退还 50%
            m.gold += refund;
            m.towers = m.towers.filter((x) => x !== target);
            addLog(m, `${TOWERS[target.towerId].name} 被 ${mon.def.name} 拆毁（返还 ${refund} 金）`, 'warn');
          }
        }
      } else {
        mon.dist += mon.speed * (1 - slow) * (swamp ? 0.9 : 1) * dt;
      }
    }

    if (mon.dist >= pathTotalUnits(m.map.paths[mon.pathIndex]) - GRID.unitPerTile * 0.5) {
      mon.dead = true;
      m.stats.leaks += 1;
      const core = m.cores?.[mon.coreIndex ?? 0] ?? m.core;
      core.hp -= mon.def.coreDamage;
      const which = (m.cores?.length ?? 1) > 1 ? `核心${(mon.coreIndex ?? 0) + 1}` : '核心';
      addLog(m, `${mon.def.name} 突破防线，${which} -${mon.def.coreDamage}`, 'warn');
      if (core.hp <= 0) {
        core.hp = 0;
        m.result = 'lose';
        addLog(m, `${which}被摧毁，失败`, 'warn');
      }
    }
  }
  m.monsters = m.monsters.filter((x) => !x.dead);
}

export function update(m, dtRaw) {
  if (m.result) return m;
  const dt = Math.min(TICK_STEP, Math.max(0, dtRaw));
  m.time += dt;

  // §5.5：波次中下的单，读条走完才发货
  if (m.shopCast && m.time >= m.shopCast.until) {
    const item = SHOP_ITEMS.find((i) => i.id === m.shopCast.itemId);
    m.shopCast = null;
    if (item) { grantItem(m, item); addLog(m, `${item.name} 补给完成`); }
  }

  const w = m.wave;
  if (w.phase === 'prep') {
    w.timer -= dt;
    if (w.timer <= 0) beginWave(m);
  } else if (w.phase === 'spawning') {
    w.timer += dt;
    while (w.spawned < w.total && w.timer >= w.queue[w.spawned].at) {
      const { mobId } = w.queue[w.spawned];
      const airPath = m.map.paths.findIndex((p) => p.air);
      const groundPaths = m.map.paths.map((p, i) => (p.air ? -1 : i)).filter((i) => i >= 0);
      const pathIndex = MONSTERS[mobId].isAir && airPath >= 0 ? airPath : groundPaths[w.spawned % groundPaths.length];
      spawnMonster(m, mobId, pathIndex);
      w.spawned += 1;
    }
    if (w.spawned >= w.total && (m.monsters.length === 0 || w.timer >= TIMING.spawnWindow)) {
      if (m.monsters.length === 0) finishWave(m);
      else w.phase = 'clearing';
    }
  } else if (w.phase === 'clearing' && m.monsters.length === 0) {
    finishWave(m);
  }

  for (const t of m.towers) {
    t.cooldown = Math.max(0, t.cooldown - dt);
    if (t.cooldown <= 0) towerFire(m, t);
  }
  for (const p of m.projectiles) {
    p.life -= dt;
    p.progress = (p.progress ?? 0) + dt * 4.5;
    if (!p.target || p.target.dead) { p.life = 0; continue; }
    if (p.progress >= 1) { projectileHit(m, p); p.life = 0; }
  }
  m.projectiles = m.projectiles.filter((p) => p.life > 0);

  monsterStep(m, dt);
  heroStep(m, dt);
  return m;
}

export function describe(m) {
  return {
    time: +m.time.toFixed(1),
    wave: m.wave.index,
    phase: m.wave.phase,
    gold: Math.round(m.gold),
    lumber: m.lumber[0],
    core: Math.round(m.core.hp),
    monsters: m.monsters.length,
    towers: m.towers.length,
    heroLevel: m.hero.level,
    kills: m.stats.kills,
    leaks: m.stats.leaks,
    drops: m.stats.drops,
    potions: m.stats.potions ?? 0,   // §5.5「单局药品消耗 ≤ 6 次」的读数口
    potionGold: Math.round(m.stats.potionGold ?? 0),
    result: m.result,
  };
}
