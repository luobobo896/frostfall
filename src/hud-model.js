// HUD 的纯计算部分：波次预告、伤害飘字、队伍色。
// 独立成模块是为了能直接测：这些逻辑在单机与联机下都要对。

import { ARMOR_LABEL, ARMOR_TYPES, ATTACK_LABEL, DAMAGE_MATRIX, DEFENSE_MAPS, FORTS, MONSTERS, TEAM_COLORS, WAVES } from './data.js';
import { EQUIP_SLOTS, HEROES, POTION_BAG_SLOTS, QUALITY, SHOP_ITEMS, TOWERS } from './data.js';
import { potionCount } from './match.js';
import { gridDist } from './core.js';

/** 队伍色（§14.4 换色通道）：自己那一档会额外加亮，方便一眼找到自己的塔。 */
export const teamColor = (owner = 0) => TEAM_COLORS[owner % TEAM_COLORS.length];

/**
 * §3.8 / §6.2 要求「**UI 要给克制提示**」——五种攻击 × 五种护甲是这套游戏的博弈面，
 * 而玩家在界面上此前看不到任何一条（验证记录 §90）。
 *
 * 提示**从克制表本身算出来**，不手写第二份：调矩阵的时候提示会跟着变，
 * 不会出现「表里 ×1.5、界面上还写着 ×1.2」。
 */
export function counterTable() {
  return Object.keys(DAMAGE_MATRIX).map((atk) => ({
    atk,
    label: ATTACK_LABEL[atk] ?? atk,
    best: ARMOR_TYPES.map((ar) => ({ ar, mul: DAMAGE_MATRIX[atk][ar] ?? 1 }))
      .sort((a, b) => b.mul - a.mul)[0],
  }));
}

/**
 * 某种攻击类型「克谁」：`攻城 · 克无甲/加强甲 ×1.50`、`混乱 · 无明显克制（×1.00）`。
 * 并列取到的一起列出（攻城对无甲与加强甲都是 ×1.5，只报一个等于漏信息）；
 * 最高倍率 ≤1 就不硬说「克」——混乱对谁都 ×1.00，那是**没有克制**而不是克制。
 */
export function attackHint(attackType) {
  const row = counterTable().find((x) => x.atk === attackType);
  if (!row) return '';
  const bestMul = row.best.mul;
  if (bestMul <= 1) return `${row.label} · 无明显克制（×${bestMul.toFixed(2)}）`;
  const ties = ARMOR_TYPES.filter((ar) => (DAMAGE_MATRIX[attackType][ar] ?? 1) === bestMul);
  const names = ties.slice(0, 2).map((ar) => ARMOR_LABEL[ar] ?? ar).join('/') + (ties.length > 2 ? ' 等' : '');
  return `${row.label} · 克${names} ×${bestMul.toFixed(2)}`;
}

/** 某种护甲「怕什么」：`加强甲：攻城 ×1.50 / 魔法 ×0.35`（下一波预告用它提醒该补哪种塔）。 */
export function armorHint(armorType) {
  const rows = Object.keys(DAMAGE_MATRIX)
    .map((atk) => ({ atk, mul: DAMAGE_MATRIX[atk][armorType] ?? 1 }))
    .sort((a, b) => b.mul - a.mul);
  const best = rows[0], worst = rows[rows.length - 1];
  return `${ARMOR_LABEL[armorType] ?? armorType} 怕 ${ATTACK_LABEL[best.atk] ?? best.atk} ×${best.mul.toFixed(2)}`
    + `（${ATTACK_LABEL[worst.atk] ?? worst.atk} 只有 ×${worst.mul.toFixed(2)}）`;
}

/**
 * 野外区的 HUD 文案：`腐化荒地 Lv5-10 · 掉落 ×1.25`。
 * 掉落加成必须写出来——§2.6 说「越远收益越高」，不写玩家就永远学不到这件事
 * （实现见 §87：`dropBonus` 换算成保底条数）。免费区（×1.0）不写，免得满屏都是 ×1。
 */
export function zoneLabel(zone) {
  if (!zone) return '';
  const bonus = zone.dropBonus ?? 1;
  return `${zone.name} Lv${zone.lvMin}-${zone.lvMax}` + (bonus > 1 ? ` · 掉落 ×${bonus}` : '');
}

const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec) % 60).padStart(2, '0')}`;

/**
 * 档案里一条战绩该怎么写。
 * §12.3 / §12.6：**两个模式的成绩不可比**——TD 是「多快通关」，防守是「守住几轮 + 城堡剩多少」。
 * 以前两种图都用 TD 的口径写成「最快 mm:ss」，防守图那张卡于是写着一个没有意义的数
 * （通关时刻由轮次表决定，几乎每局都是 12.7 分钟），而 §12.3 指定的「通过波次」根本没露出来。
 */
export function recordLabel(mapId, rec) {
  if (!rec || !rec.clears) return '还没通关';
  if (DEFENSE_MAPS[mapId]) {
    return `守住 ${rec.bestRounds ?? 0} 轮 · 城堡 ${rec.bestCoreHp ?? 0}`;
  }
  return rec.bestTimeSec == null ? '还没通关' : `最快 ${mmss(rec.bestTimeSec)}`;
}

/**
 * §3.7 低血提示：生命 < 20% 时要高亮（小地图 / 血条都要看得出来），
 * 让队友知道该来奶一口。抽成纯函数是为了能直接测边界。
 */
export const isLowHp = (hp, maxHp, pct = 0.2) => maxHp > 0 && hp / maxHp < pct;

/**
 * 下一波预告（§8.3 的 UI 部分）：把当前波次表翻译成「4×沼泽巨魔 + 1×霜嚎巨兽」。
 * 客户端本地就能算——波次表是静态数据，不需要服务端下发。
 */
export function wavePreview(waveIndex, maxGroups = 3, waves = WAVES) {
  const def = waves[waveIndex - 1];
  if (!def) return null;
  const groups = def.groups.map((g) => ({
    mobId: g.mobId,
    name: MONSTERS[g.mobId].name,
    count: g.count,
    tier: MONSTERS[g.mobId].tier,
    isAir: !!MONSTERS[g.mobId].isAir,
    armorType: MONSTERS[g.mobId].armorType,
    armorLabel: ARMOR_LABEL[MONSTERS[g.mobId].armorType] ?? MONSTERS[g.mobId].armorType,
  }));
  const total = groups.reduce((s, g) => s + g.count, 0);
  return {
    wave: waveIndex,
    groups: groups.slice(0, maxGroups),
    rest: Math.max(0, groups.length - maxGroups),
    total,
    isElite: !!def.isElite,
    isMinorBoss: !!def.isMinorBoss,
    isBoss: !!def.isBoss,
    tag: def.isBoss ? '最终 Boss' : def.isMinorBoss ? '小 Boss' : def.isElite ? '精英波' : '',
    // 护甲类型写进预告：玩家在**开波之前**就能决定这一波该补哪种塔（§6.2 的克制博弈）
    text: groups.map((g) => `${g.count}×${g.name}（${g.armorLabel}${g.isAir ? '·空中' : ''}）`).join(' + ')
      + (groups.length > maxGroups ? ` 等 ${total} 只` : ''),
  };
}

/**
 * 伤害飘字：比较两帧的怪物血量，谁掉了血就在谁的格子上飘一个数字。
 * 单机与联机都走这条路——联机下血量本来就在增量快照里。
 */
export function damageFloaters(before, after, { minDamage = 1, maxItems = 12 } = {}) {
  const prev = new Map(before.map((x) => [x.uid, x]));
  const out = [];
  for (const now of after) {
    const was = prev.get(now.uid);
    if (!was) continue;
    const dealt = Math.round(was.hp - now.hp);
    if (dealt < minDamage) continue;
    out.push({ uid: now.uid, cell: now.cell, text: String(dealt), kind: dealt >= 100 ? 'big' : 'hit' });
  }
  return out.sort((a, b) => Number(b.text) - Number(a.text)).slice(0, maxItems);
}

/** 玩家面板：4 格，带队伍色与在线状态（联机时服务端会给 online 标记）。 */
export function playerPanel(players = [], localSlot = 0, maxPlayers = 4) {
  const bySlot = new Map(players.map((p, i) => [p.slot ?? i, p]));
  return Array.from({ length: maxPlayers }, (_, slot) => {
    const p = bySlot.get(slot) ?? null;
    return {
      slot,
      name: p?.name ?? (slot === localSlot ? '我' : '空位'),
      online: p ? p.online !== false : false,
      isSelf: slot === localSlot,
      color: teamColor(slot),
      connected: !!p,
    };
  });
}

/* ---------- 英雄选择卡片（§14.3 稿 3：4 职业卡片 + 技能预览） ---------- */

const ROLE_TEXT = {
  hero_warrior: '前排 / 清小怪 / 抗精英',
  hero_mage: '群体爆发 / 破重甲',
  hero_ranger: '单体最高 DPS / 打空中',
  hero_paladin: '光环 / 治疗 / 减速辅助',
};

/** 把英雄表翻成卡片视图模型：属性 + 两个主动技 + 两个天赋 + 一句话定位。 */
export function heroCard(heroId) {
  const h = HEROES[heroId];
  if (!h) return null;
  return {
    id: h.id,
    name: h.name,
    role: ROLE_TEXT[heroId] ?? '',
    stats: [
      { label: '生命', value: h.hp },
      { label: '攻击', value: h.attack },
      { label: '防御', value: h.def },
      { label: '攻速', value: h.atkSpeed.toFixed(2) },
      { label: '射程', value: h.range.toFixed(1) },
      { label: '移速', value: h.moveSpeed },
    ],
    // 首发只放 Lv1 + Lv8 两个主动（§3.8），第三个靠技能书解锁，所以这里只展示前两个
    skills: h.skills.map((s) => ({ name: s.name, unlockLevel: s.unlockLevel, cooldown: s.cooldown })),
    talents: h.talents.map((t) => ({ name: t.name, unlockLevel: t.unlockLevel })),
    secret: h.thirdSkill ? { name: h.thirdSkill.name, unlockLevel: h.thirdSkill.unlockLevel, via: '技能书·秘传' } : null,
  };
}

export const heroCards = () => Object.keys(HEROES).map(heroCard);

/* ---------- 结算面板（§14.3 稿 8：伤害占比 / 漏怪数 / 掉落与合成结果） ---------- */

/** 伤害占比：按来源（塔 id / hero）分摊，返回降序百分比。 */
export function damageShare(stats = {}) {
  const map = stats.damage ?? {};
  const total = Object.values(map).reduce((a, b) => a + b, 0);
  const rows = Object.entries(map)
    .map(([source, value]) => ({
      source,
      // §149：防守模式的伤害来源是**工事 id**（`fort_arrow`），它不在 TOWERS 表里——
      // 只查 TOWERS 的话，防守的结算面板会直接印出「fort_arrow」这个内部 id（单机也一样）。
      label: source === 'hero' ? '英雄' : (TOWERS[source]?.name ?? FORTS[source]?.name ?? source),
      value: Math.round(value),
      pct: total > 0 ? value / total : 0,
    }))
    .sort((a, b) => b.value - a.value);
  return { total: Math.round(total), rows };
}

/** 掉落与合成：按部位/品质汇总（品质顺序固定，便于 UI 稳定排版）。 */
export function lootSummary(m) {
  const byQuality = new Map();
  for (const it of m.inventory ?? []) byQuality.set(it.quality, (byQuality.get(it.quality) ?? 0) + 1);
  for (const it of m.groundItems ?? []) byQuality.set(it.quality, (byQuality.get(it.quality) ?? 0) + 1);
  const equipped = Object.entries(m.equipped ?? {}).filter(([, v]) => v);
  return {
    drops: m.stats?.drops ?? 0,
    crafts: m.stats?.crafts ?? 0,
    // §151：名字在这一层翻好（视图模型的活）。以前结算面板直接印 `slot` / `quality` 两个内部 id，
    // 那一行写出来是「weapon blue15」（背包面板早就翻成「稀有 武器 ilvl5」了，同一个面板两种写法）。
    byQuality: ['white', 'blue', 'purple', 'orange'].map((q) => ({
      quality: q, count: byQuality.get(q) ?? 0, name: QUALITY[q]?.name ?? q,
    })),
    equipped: equipped.map(([slot, it]) => ({
      slot, quality: it.quality, ilvl: it.ilvl,
      slotName: EQUIP_SLOTS[slot]?.name ?? slot,
      qualityName: QUALITY[it.quality]?.name ?? String(it.quality ?? '?'),
    })),
  };
}

/** 结算面板的完整视图模型：两种模式各自取对数。 */
export function resultPanelModel(m, extra = {}) {
  if (!m?.result) return null;
  const defense = m.mode === 'defense';
  const minutes = (m.time / 60).toFixed(1);
  /**
   * §190：**「继续（无尽）」只在还能继续时给**。城堡已经陷落（`m.over`）之后那一局就结束了——
   * 内核 `updateDefense()` 在 `m.over` 时直接 return，时间不再走——再摆一个「继续」就是假出口：
   * 点下去只是把面板让开，露出一个城堡 0 血、25 只怪站着不动的死场。§131 那个胜局照样保留
   * （`m.result` 还是 `win`），只是不再说「无尽中」。
   */
  const canContinue = !!m.assault?.endless && !m.over;
  const rows = defense
    ? [
      { label: '单局时长', value: `${minutes} 分钟` },
      { label: '守住轮次', value: `${m.stats.roundsCleared} / 4${canContinue ? '（无尽中）' : ''}` },
      { label: '城堡剩余', value: `${Math.round(m.castle.hp)} / ${m.castle.maxHp}` },
      { label: '野外击杀', value: `${m.stats.fieldKills}` },
      { label: '城堡挨打', value: `${m.stats.castleHits} 次` },
      { label: '英雄等级', value: `Lv${m.hero.level}` },
    ]
    : [
      { label: '单局时长', value: `${minutes} 分钟` },
      { label: '漏怪', value: `${m.stats.leaks} 只` },
      { label: '核心剩余', value: `${Math.round(m.core.hp)} / ${m.core.maxHp}` },
      { label: '击杀', value: `${m.stats.kills}` },
      { label: '英雄等级', value: `Lv${m.hero.level}` },
      { label: '结算时刻', value: `第 ${m.wave.index} 波` },
    ];
  return {
    mode: defense ? 'defense' : 'td',
    win: m.result === 'win',
    title: m.result === 'win' ? (defense ? '守住了！' : '通关！') : (defense ? '城堡陷落' : '核心被摧毁'),
    rows,
    damage: damageShare(m.stats),
    loot: lootSummary(m),
    reputationGain: extra.gain ?? 0,
    leveledUp: !!extra.leveledUp,
    commanderLevel: extra.commanderLevel ?? null,
    // §131：防守守住第 4 轮后转无尽（§12.5）——面板要因此多给一个「继续（无尽）」出口
    //（§190：只在还能继续时给，见上面 `canContinue`）
    endless: canContinue,
  };
}

/** 补给清单（商店面板用）：把商品表翻成「名字 / 效果 / 价格」三列。 */
export function shopRows(m, priceOf) {
  return SHOP_ITEMS.map((item) => {
    const price = priceOf(item.id);
    return {
      id: item.id,
      name: item.name,
      bought: m.shopBought?.[item.id] ?? 0,
      limit: item.limit && item.limit !== Infinity ? item.limit : null,
      price,
      affordable: !!price && m.gold >= price.gold && (m.lumber?.[0] ?? 0) >= (price.lumber ?? 0),
      soldOut: !price,
      // §5.5.3：药品共 3 格——满了就把按钮禁掉并说明原因，别让玩家点了才发现
      bagFull: item.type === 'potion' && potionCount(m) >= (item.bagSlots ?? POTION_BAG_SLOTS),
      // §5.5.1 有些商品在本模式里没有作用（塔防里的回城卷轴）：内核只认 m.shopBlocked，
      // 谁登记的就由谁写原因，界面把原因原样显示出来——别让玩家点了才发现白扔 80 金。
      blockedReason: m.shopBlocked?.[item.id] ?? null,
      // §3.1 #14：商店在基地里——离得太远时按钮要**禁掉并说明**（不是让玩家点了才发现不回血）
      tooFar: !!m.shopNear && gridDist(m.hero?.cell ?? m.shopNear, m.shopNear) > m.shopNear.r,
      effect: item.heal ? `回复 ${item.heal}`
        : item.atkPct ? `攻击 +${item.atkPct * 100}%`
          : item.atkSpeedPct ? `攻速 +${item.atkSpeedPct * 100}%`
            : item.effect === 'unlock_third' ? '解锁第 3 技能'
              : item.effect === 'level_up' ? '技能等级 +1' : '回城',
    };
  });
}
