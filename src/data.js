// 配置表：逐条对应 docs/game-design.md v0.7。
// 只放「首发 v1.0」范围（§3.8）：4 塔 / 4 英雄 / 9 怪 / 3 图 / 12 波 / 3 部位装备。

export const ATTACK_TYPES = ['normal', 'pierce', 'siege', 'magic', 'chaos'];
export const ARMOR_TYPES = ['unarmored', 'light', 'medium', 'heavy', 'fortified'];
// §6.2 那张表的行列名（UI 的克制提示用；别在界面里再手写一份中文，改表时容易漏）
export const ATTACK_LABEL = { normal: '普通', pierce: '穿刺', siege: '攻城', magic: '魔法', chaos: '混乱' };
export const ARMOR_LABEL = { unarmored: '无甲', light: '轻甲', medium: '中甲', heavy: '重甲', fortified: '加强甲' };

// §6.2 攻击类型 × 护甲类型 伤害系数表
export const DAMAGE_MATRIX = {
  normal: { unarmored: 1.0, light: 1.0, medium: 1.5, heavy: 1.0, fortified: 1.0 },
  pierce: { unarmored: 1.5, light: 2.0, medium: 0.75, heavy: 1.0, fortified: 0.35 },
  siege: { unarmored: 1.5, light: 1.0, medium: 0.5, heavy: 1.0, fortified: 1.5 },
  magic: { unarmored: 1.0, light: 1.25, medium: 0.75, heavy: 2.0, fortified: 0.35 },
  chaos: { unarmored: 1.0, light: 1.0, medium: 1.0, heavy: 1.0, fortified: 1.0 },
};

// §2.4 难度倍率
export const DIFFICULTY = {
  // §2.4：怪物生命 / 怪物攻击 / 出怪速度 / 掉落。
  // （「额外奖励：声望 ×1.5 / ×2」不走这里——它在 `REPUTATION.win` 里已经给了绝对值 120/180/240，
  //   原来 DIFFICULTY 里那份重复的 `reputation` 字段没有任何读取方，已删，免得两处打架。）
  normal: { hp: 1.0, atk: 1.0, spawn: 1.0, drop: 1.0 },
  hard: { hp: 1.35, atk: 1.25, spawn: 1.1, drop: 1.25 },
  nightmare: { hp: 1.8, atk: 1.55, spawn: 1.2, drop: 1.5 },
};

// §6.3 怪物数值（首发 12 波口径）。level 供 §3.2 经验公式使用。
// 攻击类型表里未逐只给出，按定位补：近战普通、远程/法师魔法、空中穿刺。
export const MONSTERS = {
  mob_01: { id: 'mob_01', name: '冰霜食尸鬼', tier: 'normal', level: 1, hp: 90, armor: 1, armorType: 'medium', attack: 8, atkSpeed: 1.0, speed: 300, bounty: 12, lumber: 0, coreDamage: 60, attackType: 'normal' },
  // 对核心伤害 60（v0.7 修正：原 55 比第 1 波的 mob_01 还低，且让容错率掉出附录 B 的 30-50）
  mob_02: { id: 'mob_02', name: '霜狼', tier: 'normal', level: 2, hp: 70, armor: 0, armorType: 'light', attack: 6, atkSpeed: 1.3, speed: 380, bounty: 14, lumber: 0, coreDamage: 60, attackType: 'normal' },
  mob_03: { id: 'mob_03', name: '石像鬼', tier: 'normal', level: 3, hp: 110, armor: 2, armorType: 'medium', attack: 10, atkSpeed: 1.1, speed: 330, bounty: 20, lumber: 0, coreDamage: 70, attackType: 'pierce', isAir: true },
  mob_04: { id: 'mob_04', name: '沼泽巨魔', tier: 'normal', level: 4, hp: 220, armor: 3, armorType: 'heavy', attack: 16, atkSpeed: 0.8, speed: 260, bounty: 26, lumber: 0, coreDamage: 90, attackType: 'normal' },
  mob_10: { id: 'mob_10', name: '冰甲卫士', tier: 'elite', level: 7, hp: 900, armor: 6, armorType: 'fortified', attack: 30, atkSpeed: 1.0, speed: 240, bounty: 120, lumber: 2, coreDamage: 220, attackType: 'normal', siege: true },
  mob_11: { id: 'mob_11', name: '亡语蛛后', tier: 'elite', level: 7, hp: 700, armor: 2, armorType: 'medium', attack: 22, atkSpeed: 1.2, speed: 300, bounty: 130, lumber: 2, coreDamage: 200, attackType: 'normal', onDeath: { splitInto: 'mob_01', count: 2 } },
  mob_12: { id: 'mob_12', name: '亡灵巫师', tier: 'elite', level: 8, hp: 650, armor: 1, armorType: 'unarmored', attack: 18, atkSpeed: 1.0, speed: 280, bounty: 140, lumber: 2, coreDamage: 210, attackType: 'magic', aura: { id: 'heal', radius: 3, hps: 20 } },
  boss_01: { id: 'boss_01', name: '霜嚎巨兽', tier: 'boss', level: 12, hp: 3600, armor: 8, armorType: 'fortified', attack: 80, atkSpeed: 1.0, speed: 220, bounty: 800, lumber: 10, coreDamage: 600, attackType: 'normal', bossTier: 'minor', siege: true },
  boss_02: { id: 'boss_02', name: '巫妖侍从', tier: 'boss', level: 15, hp: 8000, armor: 10, armorType: 'fortified', attack: 110, atkSpeed: 1.2, speed: 240, bounty: 1500, lumber: 15, coreDamage: 900, attackType: 'magic', bossTier: 'final', aura: { id: 'haste', radius: 3, atkSpeedPct: 0.15 }, siege: true },
  // 长局专属（§6.3）：短局不出，血量在 LONG_RUN_BOSS_HP 里覆盖为 40000
  boss_03: { id: 'boss_03', name: '冰封主宰', tier: 'boss', level: 20, hp: 40000, armor: 12, armorType: 'fortified', attack: 160, atkSpeed: 1.3, speed: 240, bounty: 3000, lumber: 30, coreDamage: 9999, attackType: 'chaos', bossTier: 'long', aura: { id: 'haste', radius: 4, atkSpeedPct: 0.2 }, siege: true },
};

/**
 * §1.6 人数缩放（塔位不随人数变化——塔位是地图设计的一部分）。
 * 下标 = 人数 - 1。**波次表（§6.4.2 的 229 只）是 ×1.00 那一档**：
 * §8.5 的经济计算口径写明「4 人局共享池 … 出怪量按 §6.4.2」，所以 4 人是基准，单人往下缩。
 */
export const PLAYER_SCALE = [
  { count: 0.60, hp: 0.85, gold: 0.80 },   // 1 人
  { count: 0.80, hp: 0.95, gold: 0.90 },   // 2 人
  { count: 0.90, hp: 1.00, gold: 0.95 },   // 3 人
  { count: 1.00, hp: 1.00, gold: 1.00 },   // 4 人（基准）
  { count: 1.15, hp: 1.05, gold: 1.05 },   // 5 人
  { count: 1.25, hp: 1.10, gold: 1.10 },   // 6 人
  { count: 1.35, hp: 1.15, gold: 1.15 },   // 7 人
  { count: 1.45, hp: 1.20, gold: 1.20 },   // 8 人
];
/** 取某一档的人数系数（越界一律夹到 1-8 人） */
export const playerScaleOf = (players = 1) =>
  PLAYER_SCALE[Math.min(PLAYER_SCALE.length, Math.max(1, Math.round(players))) - 1];

// §6.4.2 12 波出怪量（合计 229，4 人基准）
export const WAVES = [
  { wave: 1, groups: [{ mobId: 'mob_01', count: 8, interval: 3.0 }] },
  { wave: 2, groups: [{ mobId: 'mob_01', count: 7, interval: 3.0 }, { mobId: 'mob_03', count: 3, interval: 3.5 }] },
  { wave: 3, groups: [{ mobId: 'mob_02', count: 11, interval: 2.2 }, { mobId: 'mob_10', count: 1, interval: 1 }], isElite: true },
  { wave: 4, groups: [{ mobId: 'mob_01', count: 5, interval: 2.4 }, { mobId: 'mob_02', count: 5, interval: 2.4 }, { mobId: 'mob_03', count: 4, interval: 3.0 }] },
  { wave: 5, groups: [{ mobId: 'mob_04', count: 16, interval: 1.6 }] },
  { wave: 6, groups: [{ mobId: 'mob_04', count: 6, interval: 2.0 }, { mobId: 'mob_02', count: 4, interval: 2.0 }, { mobId: 'boss_01', count: 1, interval: 1 }], isMinorBoss: true },
  { wave: 7, groups: [{ mobId: 'mob_02', count: 6, interval: 1.5 }, { mobId: 'mob_03', count: 6, interval: 1.8 }, { mobId: 'mob_04', count: 6, interval: 1.8 }] },
  { wave: 8, groups: [{ mobId: 'mob_04', count: 10, interval: 1.4 }, { mobId: 'mob_10', count: 2, interval: 2.0 }, { mobId: 'mob_03', count: 10, interval: 1.6 }] },
  { wave: 9, groups: [{ mobId: 'mob_02', count: 12, interval: 1.2 }, { mobId: 'mob_03', count: 12, interval: 1.4 }, { mobId: 'mob_11', count: 2, interval: 2.0 }], isElite: true },
  { wave: 10, groups: [{ mobId: 'mob_03', count: 15, interval: 1.2 }, { mobId: 'mob_04', count: 15, interval: 1.3 }] },
  { wave: 11, groups: [{ mobId: 'mob_04', count: 16, interval: 1.2 }, { mobId: 'mob_03', count: 16, interval: 1.3 }, { mobId: 'mob_10', count: 2, interval: 2.0 }] },
  { wave: 12, groups: [{ mobId: 'mob_04', count: 14, interval: 1.2 }, { mobId: 'mob_03', count: 13, interval: 1.3 }, { mobId: 'boss_02', count: 1, interval: 1 }], isBoss: true },
];

/**
 * 长局模式（30 波，自定义房可选，§6.4 第 7 条）：
 * 沿用「第 5/15/25 波精英、第 10/20/30 波 Boss」的经典结构，赏金系数 ×1.0（不再打折）。
 * 单局 25-40 分钟（附录 B），给愿意坐下来的玩家。
 */
export const WAVES_LONG = [
  { wave: 1, groups: [{ mobId: 'mob_01', count: 8, interval: 2.6 }] },
  { wave: 2, groups: [{ mobId: 'mob_01', count: 8, interval: 2.4 }, { mobId: 'mob_02', count: 4, interval: 2.4 }] },
  { wave: 3, groups: [{ mobId: 'mob_02', count: 10, interval: 2.2 }, { mobId: 'mob_03', count: 3, interval: 3.0 }] },
  { wave: 4, groups: [{ mobId: 'mob_03', count: 10, interval: 2.0 }, { mobId: 'mob_01', count: 8, interval: 2.0 }] },
  { wave: 5, groups: [{ mobId: 'mob_02', count: 12, interval: 1.8 }, { mobId: 'mob_10', count: 1, interval: 1 }], isElite: true },
  { wave: 6, groups: [{ mobId: 'mob_04', count: 12, interval: 1.8 }] },
  { wave: 7, groups: [{ mobId: 'mob_04', count: 12, interval: 1.6 }, { mobId: 'mob_03', count: 8, interval: 1.8 }] },
  { wave: 8, groups: [{ mobId: 'mob_04', count: 14, interval: 1.5 }, { mobId: 'mob_10', count: 1, interval: 1.5 }] },
  { wave: 9, groups: [{ mobId: 'mob_03', count: 14, interval: 1.4 }, { mobId: 'mob_11', count: 2, interval: 2.0 }] },
  { wave: 10, groups: [{ mobId: 'mob_04', count: 12, interval: 1.6 }, { mobId: 'boss_01', count: 1, interval: 1 }], isBoss: true },
  { wave: 11, groups: [{ mobId: 'mob_03', count: 16, interval: 1.3 }, { mobId: 'mob_02', count: 10, interval: 1.3 }] },
  { wave: 12, groups: [{ mobId: 'mob_04', count: 16, interval: 1.3 }, { mobId: 'mob_10', count: 2, interval: 2.0 }] },
  { wave: 13, groups: [{ mobId: 'mob_03', count: 18, interval: 1.2 }, { mobId: 'mob_12', count: 2, interval: 2.0 }] },
  { wave: 14, groups: [{ mobId: 'mob_04', count: 18, interval: 1.2 }, { mobId: 'mob_11', count: 3, interval: 1.8 }] },
  { wave: 15, groups: [{ mobId: 'mob_10', count: 4, interval: 2.0 }, { mobId: 'mob_04', count: 14, interval: 1.3 }], isElite: true },
  { wave: 16, groups: [{ mobId: 'mob_03', count: 20, interval: 1.1 }, { mobId: 'mob_12', count: 3, interval: 2.0 }] },
  { wave: 17, groups: [{ mobId: 'mob_04', count: 20, interval: 1.1 }, { mobId: 'mob_10', count: 3, interval: 1.8 }] },
  { wave: 18, groups: [{ mobId: 'mob_11', count: 5, interval: 1.6 }, { mobId: 'mob_03', count: 16, interval: 1.2 }] },
  { wave: 19, groups: [{ mobId: 'mob_10', count: 4, interval: 1.8 }, { mobId: 'mob_12', count: 4, interval: 1.8 }] },
  { wave: 20, groups: [{ mobId: 'mob_04', count: 16, interval: 1.2 }, { mobId: 'boss_02', count: 1, interval: 1 }], isBoss: true },
  { wave: 21, groups: [{ mobId: 'mob_03', count: 22, interval: 1.0 }, { mobId: 'mob_10', count: 4, interval: 1.6 }] },
  { wave: 22, groups: [{ mobId: 'mob_04', count: 22, interval: 1.0 }, { mobId: 'mob_11', count: 5, interval: 1.6 }] },
  { wave: 23, groups: [{ mobId: 'mob_12', count: 5, interval: 1.6 }, { mobId: 'mob_10', count: 5, interval: 1.6 }] },
  { wave: 24, groups: [{ mobId: 'mob_04', count: 24, interval: 0.9 }, { mobId: 'mob_03', count: 18, interval: 1.0 }] },
  { wave: 25, groups: [{ mobId: 'mob_10', count: 6, interval: 1.5 }, { mobId: 'mob_11', count: 6, interval: 1.5 }], isElite: true },
  { wave: 26, groups: [{ mobId: 'mob_04', count: 24, interval: 0.9 }, { mobId: 'mob_12', count: 6, interval: 1.5 }] },
  { wave: 27, groups: [{ mobId: 'mob_03', count: 26, interval: 0.9 }, { mobId: 'mob_10', count: 6, interval: 1.5 }] },
  { wave: 28, groups: [{ mobId: 'mob_11', count: 8, interval: 1.4 }, { mobId: 'mob_04', count: 20, interval: 1.0 }] },
  { wave: 29, groups: [{ mobId: 'mob_10', count: 8, interval: 1.4 }, { mobId: 'mob_12', count: 8, interval: 1.4 }] },
  { wave: 30, groups: [{ mobId: 'mob_04', count: 20, interval: 1.0 }, { mobId: 'mob_11', count: 6, interval: 1.4 }, { mobId: 'boss_03', count: 1, interval: 1 }], isBoss: true },
];

/** §6.3 的长局 Boss 血量（12 波局用短局列，见 §6.3 的两列对照）。 */
export const LONG_RUN_BOSS_HP = { boss_01: 12000, boss_02: 20000, boss_03: 40000 };
/**
 * 长局（§6.4 第 7 条）。`prepTime` 比短局长一截：附录 B 要求 30 波落在 25-40 分钟，
 * 而 §6.4 的短局间距（出怪 25s + 清场 + 间隔 12s ≈ 37s/波）乘 30 波只有 18.5 分钟——
 * 短局间距根本推不出这个时长，长局必须有自己的节奏（也给「攒够了慢慢想买什么」留时间）。
 */
export const LONG_RUN = { waves: 30, bountyMul: 1.0, label: '长局（30 波）', prepTime: 30 };

// §8.1 防御塔（首发 4 种）；§8.2 升级：伤害 +35%、射程 +5%、攻速 +10% 每级
export const TOWERS = {
  tw_arrow: { id: 'tw_arrow', name: '箭塔', cost: 60, attackType: 'normal', damage: 18, atkSpeed: 1.5, range: 5.0, hitsAir: true, special: {} },
  tw_cannon: { id: 'tw_cannon', name: '炮塔', cost: 150, attackType: 'siege', damage: 40, atkSpeed: 0.8, range: 6.0, hitsAir: false, special: { splashRadius: 1.5 } },
  tw_frost: { id: 'tw_frost', name: '冰塔', cost: 120, attackType: 'magic', damage: 8, atkSpeed: 1.0, range: 4.5, hitsAir: true, special: { slowPct: 0.30, slowSec: 2 } },
  tw_static: { id: 'tw_static', name: '静电塔', cost: 260, attackType: 'magic', damage: 30, atkSpeed: 1.0, range: 5.5, hitsAir: true, special: { chainCount: 3, chainDecay: 0.2, chainRange: 3 } },
};
export const TOWER_MAX_LEVEL = 3;
export const TOWER_LEVEL_GAIN = { damage: 0.35, range: 0.05, atkSpeed: 0.10 };
export const TOWER_UPGRADE_COST = [1.2, 2.2]; // 1→2、2→3 的造价倍数
export const TOWER_SELL_REFUND = 0.6;
export const TOWER_ATK_SPEED_CAP = 4.0;

// §8.3 攻击优先级
export const TARGET_PRIORITIES = ['front', 'strongest', 'weakest', 'air_first'];

// §3.1 / §3.3 / §3.5 英雄（首发只启用 Lv1、Lv8 主动与 Lv5、Lv10 天赋）
export const HEROES = {
  hero_warrior: {
    id: 'hero_warrior', name: '霜刃武者', hp: 900, attack: 32, def: 4, atkSpeed: 1.10, moveSpeed: 320, range: 1.2, attackType: 'normal',
    skills: [
      { id: 'sk_whirl', name: '旋风斩', unlockLevel: 1, cooldown: 12, radius: 2.5, maxTargets: 6, dmg: [60, 140] },
      { id: 'sk_warcry', name: '战吼', unlockLevel: 8, cooldown: 25, duration: 10, atkPct: [0.10, 0.25] },
    ],
    thirdSkill: { id: 'sk_sunder', name: '破甲突刺', unlockLevel: 15, cooldown: 20, dmg: [120, 300], armorBreak: [-3, -8], duration: 8 },
    talents: [
      { id: 'tal_ironwill', name: '钢铁意志', unlockLevel: 5, type: 'lowHpReduce', value: 0.15 },
      { id: 'tal_ruthless', name: '无情', unlockLevel: 10, type: 'critRate', value: 0.05 },
    ],
  },
  hero_mage: {
    id: 'hero_mage', name: '秘法导引者', hp: 520, attack: 18, def: 1, atkSpeed: 0.90, moveSpeed: 300, range: 6.0, attackType: 'magic',
    skills: [
      { id: 'sk_blizzard', name: '暴风雪', unlockLevel: 1, cooldown: 15, radius: 3, duration: 4, hps: [25, 60] },
      { id: 'sk_arcanebolt', name: '奥术冲击', unlockLevel: 8, cooldown: 12, armorPierce: 0.4, fortifiedBonus: 0.3, dmg: [90, 220] },
    ],
    thirdSkill: { id: 'sk_timelock', name: '时间扭曲', unlockLevel: 15, cooldown: 40, radius: 5, slowPct: 0.35, duration: 6 },
    talents: [
      { id: 'tal_spellmastery', name: '咒术精通', unlockLevel: 5, type: 'spellDmg', value: 0.10 },
      { id: 'tal_manawell', name: '法力涌动', unlockLevel: 10, type: 'killHealPct', value: 0.02 },
    ],
  },
  hero_ranger: {
    id: 'hero_ranger', name: '逐风游侠', hp: 620, attack: 26, def: 2, atkSpeed: 1.60, moveSpeed: 330, range: 7.5, attackType: 'pierce',
    skills: [
      { id: 'sk_multishot', name: '多重射击', unlockLevel: 1, cooldown: 10, arrows: [5, 9], dmg: [40, 95], spread: 3.0 },
      { id: 'sk_mark', name: '猎人印记', unlockLevel: 8, cooldown: 18, duration: 8, dmgTakenPct: [0.20, 0.35] },
    ],
    thirdSkill: { id: 'sk_windwalk', name: '疾风步', unlockLevel: 15, cooldown: 25, duration: 6, speedPct: 0.5, dodgePct: 0.25 },
    talents: [
      { id: 'tal_precision', name: '精准', unlockLevel: 5, type: 'atkSpeed', value: 0.08 },
      { id: 'tal_deadly', name: '致命一击', unlockLevel: 10, type: 'critDmg', value: 0.25 },
    ],
  },
  hero_paladin: {
    id: 'hero_paladin', name: '守誓圣徒', hp: 800, attack: 20, def: 5, atkSpeed: 1.00, moveSpeed: 310, range: 3.0, attackType: 'normal',
    skills: [
      { id: 'sk_holy', name: '圣光术', unlockLevel: 1, cooldown: 10, heal: [200, 500] },
      { id: 'sk_barrier', name: '守护结界', unlockLevel: 8, cooldown: 22, radius: 4, duration: 8, reducePct: [0.20, 0.35] },
    ],
    thirdSkill: { id: 'sk_hammer', name: '制裁之锤', unlockLevel: 15, cooldown: 20, dmg: [80, 200], stun: 1.5 },
    talents: [
      { id: 'tal_devotion', name: '虔诚', unlockLevel: 5, type: 'auraRange', value: 2 },
      { id: 'tal_toughness', name: '坚韧', unlockLevel: 10, type: 'maxHp', value: 0.12 },
    ],
  },
};

// §3.2 升级曲线：expToNext(lv) = 40 + (lv-1)×30
export const expToNext = (lv) => 40 + (lv - 1) * 30;
export const HERO_MAX_LEVEL = 25;
export const HERO_LEVEL_GAIN = { hp: 0.06, attack: 0.08, def: 0.15, cdr: 0.005, cdrCap: 0.15 };
/** §7.6：阵亡 15 秒后复活；复活保护（3 秒无敌）与赶路补偿（+50% 移速、10 秒）——两个模式共用 */
export const HERO_REVIVE = { sec: 15, invulnSec: 3, fastSec: 10, fastPct: 0.5 };
/** §3.7：战斗中 0.5%/s、脱战 3 秒后 2%/s 的最大生命回复 */
export const HERO_REGEN = { combatPct: 0.005, idlePct: 0.02, outOfCombatSec: 3 };
/**
 * §7.3 概率机制表里的「上限」列。一处定义、多处引用：`computeDamage` 夹暴击率与护甲穿透，
 * `applySlow` 夹减速，`heroDodge` 夹闪避。这些上限现在离得很远（最高也就 28%），
 * 但表里写了就得真夹——不然将来加一件「+30% 暴击」的装备就没人拦。
 */
export const STAT_CAPS = { critRate: 0.75, dodge: 0.75, armorPierce: 0.60, slow: 0.60 };
/** §7.3：英雄基础闪避 3%（仅英雄；怪物与塔不闪避）。 */
export const HERO_DODGE_BASE = 0.03;
/**
 * §3.3 技能等级随英雄等级自动提升。
 *
 * STATUS §3.1 #26（已拍板）：**本代只有 2 档**——§3.5 那几张技能表每种技能只给了两个数
 * （「1 级 / 5 级满」是旧表头），实现按第 1、2 档取值，于是 Lv3-5 的数值根本不存在。
 * 与其偷偷让 Lv2 就吃到「满级数」（旧行为），不如把口径写成它本来的样子：**上限 2 档**，
 * 表头也改成了「1 级 / 2 级满」。精研技能书 = 「把一档拉满」（见 `BOOK_UP_LIMIT` 的说明）。
 */
export const SKILL_MAX_LEVEL = 2;
export const skillLevelOf = (heroLevel, unlockLevel) =>
  Math.min(SKILL_MAX_LEVEL, 1 + Math.floor(Math.max(0, heroLevel - unlockLevel) / 5));

// §5.2 品质（首发 4 档）
export const QUALITY = {
  white: { id: 'white', name: '普通', mul: 1.0, color: '#d8dee9' },
  blue: { id: 'blue', name: '稀有', mul: 1.7, color: '#5aa9e6' },
  purple: { id: 'purple', name: '史诗', mul: 2.2, color: '#b07de0' },
  orange: { id: 'orange', name: '传说', mul: 3.0, color: '#e8a33d' },
};
export const QUALITY_ORDER = ['white', 'blue', 'purple', 'orange'];
export const EQUIP_SLOTS = {
  weapon: { id: 'weapon', name: '武器', base: { attack: 10 }, affixPool: ['critRate', 'critDmg', 'armorPierce'] },
  armor: { id: 'armor', name: '护甲', base: { def: 3 }, affixPool: ['maxHp', 'dmgReduce', 'hpRegen'] },
  trinket: { id: 'trinket', name: '饰品', base: { critRate: 0.03 }, affixPool: ['attack', 'armorPierce', 'goldFind'] },
};
/**
 * §4.1 武器分类（首发 4 类；`wp_crossbow` 重弩与 `wp_shield` 战盾按 §3.8 延后）。
 * 一件武器**决定英雄的攻击档**：攻击类型 / 射程 / 攻速 / 特性都从它来，没拿武器才用职业的裸值。
 * 文档没给每类武器的基础攻击值（§4.3 只举了一例 rare 长弓），所以攻击仍走 `EQUIP_SLOTS.weapon` 的主属性，
 * 这一层只把「单体 / 群伤 / 减速 / 对空」四种需求分开。
 */
export const WEAPONS = {
  wp_sword: { id: 'wp_sword', name: '剑/刃', attackType: 'normal', range: 1.2, atkSpeed: 1.1, special: { sector: 3 }, fit: ['hero_warrior'] },
  wp_bow: { id: 'wp_bow', name: '长弓', attackType: 'pierce', range: 7.5, atkSpeed: 1.4, special: { vsAir: 0.25 }, fit: ['hero_ranger'] },
  wp_staff: { id: 'wp_staff', name: '法杖', attackType: 'magic', range: 6.0, atkSpeed: 0.9, special: { splashRadius: 1.5 }, fit: ['hero_mage'] },
  wp_totem: { id: 'wp_totem', name: '图腾', attackType: 'magic', range: 5.0, atkSpeed: 1.0, special: { slowPct: 0.2, slowSec: 2, slowStacks: 2 }, fit: ['hero_paladin', 'hero_mage'] },
};
export const WEAPON_IDS = Object.keys(WEAPONS);
/** §5.4.1：3 件同部位同品质 → 1 件高一档；ilvl 取最高 +1；§4.4：强化等级「保留最高 −2」 */
export const EQUIP_CRAFT = { need: 3, ilvlBonus: 1, plusKeepPenalty: 2 };
/** §4.4 / §5.4：出售返还投入金币 ×0.7；紫 / 橙额外返还木材 30 */
export const EQUIP_SELL_REFUND = 0.7;
export const EQUIP_SELL_BONUS_LUMBER = 30;
export const EQUIP_ILLVL_MAX = 15;
export const ilvlForWave = (wave) => Math.min(EQUIP_ILLVL_MAX, Math.max(1, Math.ceil((wave * EQUIP_ILLVL_MAX) / 12)));

// §5.2 掉落概率（首发 12 波口径）
export const DROP_TABLE = {
  normal: { white: 0.70, blue: 0.26, purple: 0.04, orange: 0 },
  // STATUS §3.1 #2（已拍板）：精英的橙率 0.05 → **0.08**（紫相应 0.30 → **0.27**，总和不变）。
  // 为什么不动 Boss 那 15%：实测把 boss_02 从 8000 血砍到 3000，参考打法的结果**逐字相同**
  // （Boss 掉落判定恒为 0.05 次/局）——它漏过去是**射程覆盖**决定的，不是血量。
  // 所以橙装就靠「精英 + 合成」这两个真能发生的源头补到设计要的 5-8 局一次。
  elite: { white: 0.20, blue: 0.45, purple: 0.27, orange: 0.08 },
  boss: { white: 0, blue: 0.20, purple: 0.65, orange: 0.15 },
  chest: { white: 0.30, blue: 0.50, purple: 0.20, orange: 0 },   // 波次宝箱（每 4 波）
};
export const NORMAL_MOB_DROP_PITY = 25; // 每 25 只普通怪保底 1 件
/** §5.5.3：药品背包共 3 格（按总数算，不按种类）——不能囤成移动血库 */
export const POTION_BAG_SLOTS = 3;
/**
 * 精英怪（含第 6 波小 Boss）的**掉落概率**。§5.2 只给了它们的品质分布、没给概率；
 * 这个值是让整局落进附录 B 的「一局 10-14 件」反推出来的——第一版把它们做成「必掉」，
 * 实测 15 件、紫装 3.3 件/局、橙装每 2 局一件，三项全部超标（见验证记录 §27）。
 */
export const ELITE_DROP_CHANCE = 0.15;
export const CHEST_EVERY_WAVES = 4;     // §5.2 波次宝箱

// §5.5.1 商店（首发 8 件）
/**
 * §5.5「补给有代价」：**波次进行中**买东西要读条 3 秒（备战期是秒到）。
 * 这一条不是手感装饰——它让「什么时候补给」变成决策，而不是「血少了随手点一下」。
 */
export const SHOP_CAST_SEC = 3;
export const SHOP_ITEMS = [
  // STATUS §3.1 #17（已拍板）：**药品降价**（小 40→30、大 120→80）。原来的价目让「买药」在参考打法里
  // 是负收益（药钱 ≈ 6.3 座箭塔，对照组胜率反而更高，§85）——药的作用是「救命」，不该和塔抢钱。
  { id: 'pot_small', name: '小治疗药剂', type: 'potion', priceGold: 30, priceStepPct: 0.2, heal: 200, cooldown: 8, limit: Infinity, bagSlots: 3 },
  { id: 'pot_large', name: '大治疗药剂', type: 'potion', priceGold: 80, priceStepPct: 0.2, heal: 500, cooldown: 20, limit: Infinity, bagSlots: 3 },
  // §155：§5.5 的「同种涨价：每次 +20%」对**所有药品**成立（商店面板也是这么写的），
  // 这一条以前漏了 `priceStepPct` → 它永远不涨价（连买两次都是 200）。
  { id: 'pot_group', name: '群体治疗符', type: 'potion', priceGold: 200, priceStepPct: 0.2, heal: 300, radius: 3, cooldown: 45, limit: 2, bagSlots: 3 },
  { id: 'scroll_town', name: '回城卷轴', type: 'scroll', priceGold: 80, limit: 3 },
  { id: 'elixir_atk', name: '狂战药剂', type: 'elixir', priceGold: 150, atkPct: 0.25, duration: 30, limit: 2 },
  { id: 'elixir_haste', name: '疾行药剂', type: 'elixir', priceGold: 150, atkSpeedPct: 0.30, duration: 30, limit: 2 },
  // §3.1 #26 已决：技能**承认只有 2 档**，精研书 = 「把一档拉满」，所以它是那个便宜的小件；
  // 价格 300 → 200（与秘传同价：两本都是「一次买断的强化」，别让哪一本变成顺手就买）。
  // §3.1 #26：只有 2 档 → 一本就拉满，所以限购是 1（第二本没有意义）
  { id: 'book_up', name: '技能书·精研', type: 'book', priceGold: 200, effect: 'level_up', limit: 1 },
  // STATUS §3.1 #25（已拍板）：秘传书 **600 → 250**。参考打法 72 局里一本都没买过——不是没看到
  // （AI 里有这条策略），是凑不齐钱：一局金币峰值平均 389，600 等于不可能（§129）。
  // 实测购买率（附录清单那条线是 ≥30%）：600 → 0% · 300 → 25% · 250 → 21%* · **200 → 38.9%**。
  // （* 补上「消耗品只花余钱」的预算政策之后重测的数：参考打法先保塔钱，再拿余钱买书。）
  { id: 'book_secret', name: '技能书·秘传', type: 'book', priceGold: 200, priceLumber: 20, effect: 'unlock_third', limit: 1 },
];

// §2.2 首发 3 张地图（路径长度、塔位、核心 HP）
export const MAPS = {
  map_01: {
    id: 'map_01', name: '霜原哨站', stars: 1, pathCount: 1, pathLength: 58, towerSlots: 18, coreHp: 2400,
    spawn: [{ x: 0, y: 4 }], core: { x: 16, y: 12 }, terrain: [], unlockCond: null,
  },
  map_02: {
    id: 'map_02', name: '双峰隘口', stars: 2, pathCount: 2, pathLength: 62, towerSlots: 22, coreHp: 3000,
    spawn: [{ x: 0, y: 4 }, { x: 0, y: 20 }], core: { x: 16, y: 12 }, terrain: [],
    unlockCond: { clearMap: 'map_01', source: 'achievement' },
  },
  map_03: {
    id: 'map_03', name: '迷雾沼泽', stars: 3, pathCount: 2, pathLength: 68, towerSlots: 24, coreHp: 3000,
    spawn: [{ x: 0, y: 4 }, { x: 0, y: 20 }], core: { x: 16, y: 12 },
    terrain: [{ type: 'swamp', rects: [{ x: 6, y: 6, w: 6, h: 4 }, { x: 20, y: 14, w: 6, h: 4 }] }],
    airPath: true, unlockCond: { clearMap: 'map_02', reputation: 500, source: 'achievement' },
  },
  // 下面三张是长局地图（§2.2 备注：map_04-06 走 30 波长局），塔位更多、各带一个独有机制
  map_04: {
    id: 'map_04', name: '熔岩裂谷', stars: 4, pathCount: 3, pathLength: 96, towerSlots: 28, coreHp: 3600,
    grid: { w: 44, h: 28 },   // 4★ 起用更大的画布：三条长路塞进 32×24 会互相重叠，塔位不够
    spawn: [{ x: 0, y: 3 }, { x: 0, y: 12 }, { x: 0, y: 21 }], core: { x: 16, y: 12 },
    terrain: [{ type: 'lava', rects: [{ x: 6, y: 6, w: 5, h: 12 }, { x: 20, y: 6, w: 5, h: 12 }] }],
    unlockCond: { clearMap: 'map_03', reputation: 800, source: 'achievement' },
  },
  map_05: {
    id: 'map_05', name: '亡者之径', stars: 5, pathCount: 3, pathLength: 88, towerSlots: 26, coreHp: 4200,
    grid: { w: 44, h: 28 },
    spawn: [{ x: 0, y: 2 }, { x: 0, y: 22 }, { x: 0, y: 12 }], core: { x: 16, y: 12 },
    // 攻城怪会攻击路径 3 格内的塔（§7.4）：塔有血量、会被拆、能花金币修
    siege: true,
    terrain: [],
    unlockCond: { clearMap: 'map_04', source: 'achievement' },
  },
  map_06: {
    id: 'map_06', name: '冰封王座', stars: 6, pathCount: 4, pathLength: 100, towerSlots: 32, coreHp: 4200,
    grid: { w: 52, h: 34 },   // 四路图要更大的画布，否则两条路会没有可用塔位
    spawn: [{ x: 0, y: 3 }, { x: 0, y: 21 }, { x: 32, y: 3 }, { x: 32, y: 21 }],
    // 双守护目标：两条路守一个核心，任一被破即失败
    cores: [{ x: 10, y: 12 }, { x: 22, y: 12 }],
    core: { x: 10, y: 12 },
    siege: true, bossAura: true,
    terrain: [{ type: 'lava', rects: [{ x: 15, y: 10, w: 2, h: 4 }] }],
    unlockCond: { clearMap: 'map_05', reputation: 1500, source: 'achievement' },
  },
};

// §3.6 人物等级（局外，首发 1-30）：只给「解锁 + 便利」，不给战力
export const COMMANDER = {
  maxLevel: 30,
  expToNext: (lv) => 200 + (lv - 1) * 120,        // 满级累计约 5.6 万，约 60-80 局
  goldPctPerLevel: 0.01,                          // 初始金币 +1%/级（满级 +29%）
  reviveSpeedPctPerLevel: 0.003,                  // 复活时间 -0.3%/级（满级 -8.7%）
};

// §1.7.1 局外声望：通关给声望，失败给少量（不让「输」毫无价值）
export const REPUTATION = { win: { normal: 120, hard: 180, nightmare: 240 }, lose: 30 };

/* ---------- 防守模式（§12.5 / §2.6） ---------- */

export const DEFENSE_RULES = {
  campIntervalSec: 30,        // 营地每 30 秒刷一波
  campCapPerCamp: 6,          // 每个营地最多囤这么多（不刷成无限）
  campActivateRadius: 6,      // 玩家靠近才激活（避免全局常驻 AI）
  assaultIntervalSec: 180,    // 每 3 分钟一波进攻
  assaultWarnSec: 30,         // 提前 30 秒预警
  roundsToWin: 4,             // 守住第 4 轮即通关，之后转无尽
  /**
   * STATUS §3.1 #27 的第二段（2026-09-23，实测回填）：**守满 4 轮时基地回一口血**。
   * 实测（验证记录 §213）：高难下守满 4 轮的局，城堡中位只剩 56%（困难）/ 28%（噩梦），
   * 而无尽第一波的强度是「第 4 轮 × 1.15 × 难度」——一上来就比刚刚勉强守住的那波更硬，
   * 于是中位 1 波就陷落，无尽在高难等于不存在（排行榜的「通过轮次」那一位没有区分度）。
   * 25% 是按「让高难也有 2-4 波」标出来的，不动任何一条已有验收线（它在通关**之后**才发生）。
   */
  milestoneHealPct: 0.25,
  heroReviveSec: 20,          // 死亡后回城复活
  teleportCooldownSec: 30,    // 回城冷却（§2.6：点击小地图回城，冷却 30 秒）
  heroDeathGoldLoss: 0.3,     // 死亡掉 30% 金币
  repairGold: 200,            // 修城堡
  repairPct: 0.10,            // 每次回 10%
  fieldExpMul: 1.5,           // 野外击杀经验 ×1.5（§12.5：升得比 TD 快）
  campDensityPerPlayer: 1.2,  // 每多一个人，营地密度 ×1.2
  castleDamageMul: 0.1,       // 进攻怪打城堡：取 TD「漏怪伤害」的 1/10
};

// 基地工事（§12.5：比 TD 的 6 种少，只有 2 种）
export const FORTS = {
  fort_arrow: { id: 'fort_arrow', name: '箭塔', cost: 60, damage: 20, atkSpeed: 1.4, range: 5.0, hitsAir: true, attackType: 'normal', hp: 400 },
  fort_wall: { id: 'fort_wall', name: '围墙', cost: 40, hp: 800, blocks: true },
};

export const DEFENSE_MAPS = {
  def_01: {
    id: 'def_01', name: '边陲小镇', stars: 1, unlockCond: null,
    grid: { w: 64, h: 48 },
    castle: { x: 32, y: 24 }, castleHp: 4000,
    base: { x: 28, y: 20, w: 9, h: 9, gate: { x: 28, y: 24 } },   // 基地围墙，左边留门
    // 工事位必须在围墙「里面」：压在墙格上会变成墙里长出一座塔（用例会拦这个）
    fortSlots: [{ x: 29, y: 21 }, { x: 31, y: 21 }, { x: 33, y: 21 }, { x: 35, y: 21 },
      { x: 29, y: 27 }, { x: 31, y: 27 }, { x: 33, y: 27 }, { x: 35, y: 27 }],
    zones: [
      // §2.6「难度分区递增，**越远收益越高**」+ §12.8 的 field_zone 表：每区带 dropBonus
      // （离基地越远、等级越高，同样 8 只怪掉得越多；实现在 defense.js 的 rollFieldDrop）
      { id: 'za', name: '近郊林地', x: 4, y: 8, w: 16, h: 14, lvMin: 1, lvMax: 5, dropBonus: 1.0, mobs: ['mob_01', 'mob_02'] },
      { id: 'zb', name: '腐化荒地', x: 44, y: 26, w: 16, h: 16, lvMin: 5, lvMax: 10, dropBonus: 1.25, mobs: ['mob_03', 'mob_04'] },
    ],
    camps: [
      { zone: 'za', x: 8, y: 12 }, { zone: 'za', x: 16, y: 18 },
      { zone: 'zb', x: 48, y: 30 }, { zone: 'zb', x: 56, y: 38 },
    ],
    teleports: [{ x: 27, y: 24 }, { x: 44, y: 26 }],
    assaultSpawns: [{ x: 0, y: 24 }],
    rounds: [
      { round: 1, groups: [{ mobId: 'mob_01', count: 8 }, { mobId: 'mob_02', count: 4 }] },
      { round: 2, groups: [{ mobId: 'mob_02', count: 10 }, { mobId: 'mob_03', count: 4 }, { mobId: 'mob_04', count: 2 }] },
      { round: 3, groups: [{ mobId: 'mob_04', count: 8 }, { mobId: 'mob_03', count: 6 }, { mobId: 'mob_10', count: 1 }] },
      // 通关线（4 轮）以内不放 3600 血的 TD 大 Boss：那一波由「无尽阶段」承担（§12.5 通关后再转无尽）
      { round: 4, groups: [{ mobId: 'mob_04', count: 10 }, { mobId: 'mob_11', count: 2 }, { mobId: 'mob_10', count: 2 }] },
    ],
  },
  def_02: {
    id: 'def_02', name: '黑石要塞', stars: 3,
    unlockCond: { clearMap: 'def_01', source: 'achievement' },
    grid: { w: 64, h: 48 },
    castle: { x: 32, y: 24 }, castleHp: 6000,
    base: { x: 27, y: 19, w: 11, h: 11, gate: { x: 27, y: 24 } },
    fortSlots: [
      { x: 28, y: 20 }, { x: 32, y: 20 }, { x: 36, y: 20 }, { x: 28, y: 28 }, { x: 32, y: 28 },
      { x: 36, y: 28 }, { x: 28, y: 22 }, { x: 28, y: 26 }, { x: 36, y: 22 }, { x: 36, y: 26 },
    ],
    zones: [
      { id: 'za', name: '黑石矿脉', x: 3, y: 6, w: 16, h: 14, lvMin: 1, lvMax: 5, dropBonus: 1.0, mobs: ['mob_01', 'mob_02'] },
      { id: 'zb', name: '焦土坡', x: 44, y: 8, w: 16, h: 14, lvMin: 5, lvMax: 10, dropBonus: 1.25, mobs: ['mob_03', 'mob_04'] },
      { id: 'zc', name: '要塞地窖', x: 22, y: 36, w: 20, h: 10, lvMin: 8, lvMax: 12, dropBonus: 1.5, mobs: ['mob_04', 'mob_10'] },
    ],
    camps: [
      { zone: 'za', x: 7, y: 10 }, { zone: 'za', x: 15, y: 16 },
      { zone: 'zb', x: 48, y: 12 }, { zone: 'zb', x: 56, y: 18 },
      { zone: 'zc', x: 28, y: 40 }, { zone: 'zc', x: 38, y: 41 },
    ],
    teleports: [{ x: 26, y: 24 }, { x: 44, y: 8 }, { x: 22, y: 36 }],
    assaultSpawns: [{ x: 0, y: 24 }, { x: 63, y: 24 }],
    rounds: [
      { round: 1, groups: [{ mobId: 'mob_01', count: 10 }, { mobId: 'mob_02', count: 6 }] },
      { round: 2, groups: [{ mobId: 'mob_02', count: 12 }, { mobId: 'mob_03', count: 6 }, { mobId: 'mob_04', count: 4 }] },
      { round: 3, groups: [{ mobId: 'mob_04', count: 12 }, { mobId: 'mob_03', count: 8 }, { mobId: 'mob_10', count: 2 }] },
      { round: 4, groups: [{ mobId: 'mob_04', count: 14 }, { mobId: 'mob_11', count: 3 }, { mobId: 'mob_10', count: 3 }] },
    ],
  },
  def_03: {
    id: 'def_03', name: '永冬之城', stars: 5,
    // STATUS §3.1 #28（已拍板）：门槛从「守住 def_02 + **人物等级 20**」改成「守住 def_02 + **声望 1500**」。
    // Lv20 要累计 24320 声望 ≈ 203 局普通通关（§159 量的），免费期里这张图等于进不去；
    // 声望 1500 与 map_06 同量级（≈13 局），既保住「后期内容」的定位，又真的够得到。
    unlockCond: { clearMap: 'def_02', reputation: 1500, source: 'achievement' },
    grid: { w: 64, h: 48 },
    castle: { x: 32, y: 24 }, castleHp: 8000,
    base: { x: 26, y: 18, w: 13, h: 13, gate: { x: 26, y: 24 }, gate2: { x: 38, y: 24 } },
    fortSlots: [
      { x: 27, y: 19 }, { x: 32, y: 19 }, { x: 37, y: 19 }, { x: 27, y: 29 }, { x: 32, y: 29 }, { x: 37, y: 29 },
      { x: 27, y: 21 }, { x: 27, y: 27 }, { x: 37, y: 21 }, { x: 37, y: 27 }, { x: 29, y: 23 }, { x: 35, y: 25 },
    ],
    zones: [
      { id: 'za', name: '冰封哨站', x: 3, y: 4, w: 14, h: 12, lvMin: 1, lvMax: 5, dropBonus: 1.0, mobs: ['mob_01', 'mob_02'] },
      { id: 'zb', name: '冻土荒野', x: 46, y: 4, w: 15, h: 12, lvMin: 5, lvMax: 10, dropBonus: 1.25, mobs: ['mob_03', 'mob_04'] },
      { id: 'zc', name: '亡者冰窟', x: 3, y: 32, w: 15, h: 12, lvMin: 8, lvMax: 12, dropBonus: 1.5, mobs: ['mob_04', 'mob_10'] },
      { id: 'zd', name: '王座前庭', x: 46, y: 32, w: 15, h: 12, lvMin: 10, lvMax: 15, dropBonus: 1.75, mobs: ['mob_10', 'mob_11'] },
    ],
    camps: [
      { zone: 'za', x: 7, y: 8 }, { zone: 'za', x: 13, y: 13 },
      { zone: 'zb', x: 50, y: 8 }, { zone: 'zb', x: 57, y: 13 },
      { zone: 'zc', x: 7, y: 36 }, { zone: 'zc', x: 14, y: 41 },
      { zone: 'zd', x: 50, y: 36 }, { zone: 'zd', x: 57, y: 41 },
    ],
    teleports: [{ x: 25, y: 24 }, { x: 39, y: 24 }, { x: 18, y: 16 }],
    assaultSpawns: [{ x: 0, y: 24 }, { x: 63, y: 24 }, { x: 32, y: 0 }],
    rounds: [
      { round: 1, groups: [{ mobId: 'mob_02', count: 12 }, { mobId: 'mob_03', count: 6 }] },
      { round: 2, groups: [{ mobId: 'mob_03', count: 12 }, { mobId: 'mob_04', count: 8 }] },
      { round: 3, groups: [{ mobId: 'mob_04', count: 16 }, { mobId: 'mob_10', count: 3 }, { mobId: 'mob_11', count: 2 }] },
      { round: 4, groups: [{ mobId: 'mob_10', count: 5 }, { mobId: 'mob_11', count: 4 }, { mobId: 'mob_04', count: 12 }] },
    ],
  },
};

export const GRID = { w: 32, h: 24, tileW: 64, tileH: 32, unitPerTile: 128 };
/**
 * §177：**开局参数归一化**（模式 / 地图 / 难度 / 英雄 / 时长）。
 *
 * 这五个值有两个来源，两个都是「玩家能改的」：URL（`?hero=bogus`、被改过的分享链接）
 * 与档案里的 `lastChoice`（上一局存下来的，跨版本就是过期的 id）。以前它们不做校验、
 * 一路传到 `createMatch`，于是「未知英雄 / 未知地图」抛在**模块顶层**：整个页面白屏
 * （大厅都出不来，只剩 index.html 里那 6 个没接线的静态按钮）；更糟的是 `startMatch()`
 * **先写档案再建局**，脏值被存进 `lastChoice` 之后**每次打开都白屏**（验证记录 §177）。
 *
 * 规则与服务端那条同一个边界（§121 的 `roomOptions`）收成一份：
 * ① 给了合法 mode 就用它，没给就按地图推（`def_*` 是防守图，README 的 `?mode=defense` 是正式入口）；
 * ② 地图必须与模式相符，否则落回该模式的默认图；③ 其余非法值落回默认。
 * 永远不会抛——调用方拿到的一定是能建局的一组值。
 */
export function normalizeChoice(raw = {}) {
  const mode = raw.mode === 'defense' || raw.mode === 'td'
    ? raw.mode
    : (DEFENSE_MAPS[raw.map] ? 'defense' : 'td');
  return {
    mode,
    map: mode === 'defense'
      ? (DEFENSE_MAPS[raw.map] ? raw.map : 'def_01')
      : (MAPS[raw.map] ? raw.map : 'map_01'),
    difficulty: DIFFICULTY[raw.difficulty] ? raw.difficulty : 'normal',
    hero: HEROES[raw.hero] ? raw.hero : 'hero_warrior',
    length: raw.length === 'long' ? 'long' : 'short',
  };
}

/**
 * §177：把「进页面时那两个来源」合成一份合法配置——**URL 的字段优先，档案里的只补空格**。
 *
 * 一句话的例外：**URL 里给了地图时，模式就由那张图决定**（服务端 §121 的 `roomOptions` 就是这么推的：
 * `?map=def_03` 是一张防守图，那就是防守局）。不然会出两种都很难解释的局面：上一局打过 TD
 * （档案里 `lastChoice.mode = 'td'`）+ 一条 `?map=def_03` 的深链 → 客户端按 TD 建局、
 * 服务端按防守建局，两边说的不是一局（§102 那一类）；反过来 `?mode=defense` 配一张档案里的 TD 图时，
 * 模式（URL 给的）优先、地图落回 `def_01`。
 */
export function choiceFrom(url, last = {}) {
  const urlMap = url.get('map');
  return normalizeChoice({
    mode: url.get('mode') ?? (urlMap ? undefined : last.mode),
    map: urlMap ?? last.map,
    difficulty: url.get('difficulty') ?? last.difficulty,
    hero: url.get('hero') ?? last.hero,
    length: url.get('length') ?? last.length,
  });
}
// 队伍色（§14.4：用换色区分玩家，不画 4 份素材）
export const TEAM_COLORS = ['#5aa9e6', '#8ee08a', '#e8a33d', '#b07de0'];
export const ECONOMY = {
  startGold: 200,
  waveGold: (w) => 20 + w * 10,
  waveLumber: (w) => 4 + Math.floor(w / 3),
  bountyMul: 0.5,       // §8.5 击杀赏金系数（待 M0.5 实测标定）
  earlyWaveLumber: 3,   // §6.4 手动提前开波奖励
};
// §1.3 那条「每波结束后 3 秒无怪过场的保护窗」由这里的准备期保证：上一波不清完不会开下一波，
// 两波之间还隔着 prepTime（12s / 长局 30s），所以不需要单独的常量（原来那个从未被读过）。
export const TIMING = { spawnWindow: 25, prepTime: 12, tickRate: 20, prepBeforeFirst: 30 };
/**
 * §119：**逻辑帧步长只有这一个定义**（§10.2「逻辑 20Hz」）。
 * 这个数以前散在 6 处：这里、`protocol.js` 的 `TICK_RATE`、客户端主循环里写死的 50ms 步长、
 * 两个参考 AI 的默认 `dt`、内核两处 `Math.min(0.05, …)` 的步长上限（工具与用例里还有 76 处，
 * 见 §119 的第二轮）。改一处漏一处的话，
 * **验证工具会按与服务器不同的步长模拟**，那些数字就不再是这一局的数字了。
 */
export const TICK_STEP = 1 / TIMING.tickRate;
