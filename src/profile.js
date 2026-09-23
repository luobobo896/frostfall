// 局外档案（§3.6 / §2.2 / M3）：人物等级、声望、每图战绩与解锁。
// 单人局存 localStorage；联机模式下由服务端按 uid 记账（M3 之后再接）。
// §平台适配（小游戏移植）：存储走 platform 的适配层——浏览器里还是 localStorage，小游戏里是 wx storage。
import { storage } from './platform.js';
import { COMMANDER, DEFENSE_MAPS, MAPS, REPUTATION } from './data.js';

export const PROFILE_VERSION = 1;
const KEY = 'frostfall:profile';

/**
 * §1.7.3「免费期必须做的三处低成本预留」之一：`unlock_source` 字段。
 * 值域三选一——免费 / 成就 / 付费；`paid` 现在一条都没有，但**枚举先立着**：
 * 将来加付费解锁时改的是数据表（某个 unlockCond 的 source），不是解锁判断的代码。
 */
export const UNLOCK_SOURCES = ['free', 'achievement', 'paid'];
export const UNLOCK_SOURCE_LABEL = { free: '免费', achievement: '成就', paid: '付费' };
/** 这张图靠什么解锁：没有 unlockCond 的就是免费内容（如 map_01 / def_01）。 */
export const unlockSourceOf = (mapId) =>
  (MAPS[mapId] ?? DEFENSE_MAPS[mapId])?.unlockCond?.source ?? 'free';

/**
 * §1.7.3 之二：货币流水账。正式形态是 `currency_ledger` 表（§9.1），原型先在局外档案里记：
 * **每一次声望增减与每一次解锁都带来源**，将来接付费要「对账 / 回滚 / 查灰产」时有据可查。
 * ponytail: 原型只留最近 50 条（够覆盖最近几十局的排查）；真账本在 DB 里，不裁剪不分页。
 */
export const LEDGER_MAX = 50;
const ledgerAdd = (ledger, entry) => [...(ledger ?? []), entry].slice(-LEDGER_MAX);

export function emptyProfile() {
  // lastChoice：§2.1「支持上次配置一键开局」——记下上次开局用的模式/地图/难度/英雄/局内档
  return {
    v: PROFILE_VERSION, reputation: 0, exp: 0, commanderLevel: 1, clears: {}, playCount: 0,
    tutorialDone: false, lastChoice: null, ledger: [],
  };
}

/**
 * §153：**引导只问「做过没有」**。原来这里是 `!tutorialDone && playCount === 0`——那个 `playCount === 0`
 * （本意是防老档案突然弹引导）带来两个真问题：
 *  ① 新手第一局打的是**防守**：引导挂在 TD 的步骤上、永远推不动（防守的建工事不走 `onTowerBuilt`），
 *     而这一局结束时 `playCount` 变成 1 → 他之后打 TD **再也看不到引导**（§1.8 那条 90 秒验收就此失效）；
 *  ② 设置里「重看新手引导」只把 `tutorialDone` 置回 false，对**任何打完过一局**的玩家都不生效
 *     （按钮上写着「下次开局会重新显示引导」）——冒烟当时只查了 `tutorialDone === false` 这个中间态，
 *     所以这条一直是绿的。
 * 门槛只留 `tutorialDone`：「重看」= 把这个标记置回 false（收尾时 `markTutorialDone` 再置回 true），
 * 一条状态两个方向，不需要再加一个「想看一遍」的字段。
 * 代价：万一有「v1 老档案 + 没有 tutorialDone 字段」，他会看一次引导——原型阶段没有这种真实用户。
 */
export const isFirstRun = (profile) => !profile.tutorialDone;

export const markTutorialDone = (profile) => ({ ...profile, tutorialDone: true });

export const commanderLevelOf = (exp) => {
  let level = 1, rest = exp;
  while (level < COMMANDER.maxLevel && rest >= COMMANDER.expToNext(level)) {
    rest -= COMMANDER.expToNext(level);
    level += 1;
  }
  return level;
};

/** §3.6：人物等级只影响解锁与便利，不碰战力。 */
export const startGoldOf = (profile) =>
  Math.round(200 * (1 + COMMANDER.goldPctPerLevel * (profile.commanderLevel - 1)));

/**
 * §3.6：复活时间 -0.3%/级（满级 30 → 快 8.7%）。这是「便利」那一半的另一项——
 * `COMMANDER.reviveSpeedPctPerLevel` 此前**定义了没人读**，复活时间一直是写死的 15 / 20 秒。
 */
export const reviveMulOf = (profile) =>
  Math.max(0.5, 1 - COMMANDER.reviveSpeedPctPerLevel * ((profile?.commanderLevel ?? 1) - 1));

export function mapLocked(profile, mapId) {
  const def = MAPS[mapId] ?? DEFENSE_MAPS[mapId];
  const cond = def?.unlockCond;
  if (!cond) return null;
  // §1.7.3：解锁来源跟着锁一起返回，UI 与将来的付费入口读同一个字段
  const source = cond.source ?? 'free';
  if (cond.clearMap && !(profile.clears[cond.clearMap]?.wins > 0)) {
    const need = MAPS[cond.clearMap] ?? DEFENSE_MAPS[cond.clearMap];
    return { reason: 'clear', text: `通关「${need?.name ?? cond.clearMap}」`, need: cond.clearMap, source };
  }
  if (cond.reputation && profile.reputation < cond.reputation) {
    return { reason: 'reputation', text: `声望 ${profile.reputation} / ${cond.reputation}`, need: cond.reputation, source };
  }
  if (cond.commanderLevel && profile.commanderLevel < cond.commanderLevel) {
    return { reason: 'commander', text: `人物等级 ${profile.commanderLevel} / ${cond.commanderLevel}`, need: cond.commanderLevel, source };
  }
  return null;
}

/** §1.7.3 之三：内容解锁统一从表里读（`player_unlock` 表在原型里的形态），不在逻辑里硬编码。 */
export const unlocksOf = (profile, mode = 'td') => {
  const table = mode === 'defense' ? DEFENSE_MAPS : MAPS;
  return Object.keys(table).map((id) => ({
    id, source: unlockSourceOf(id), unlocked: !mapLocked(profile, id),
  }));
};

/** 某模式下已解锁的地图（两种模式的地图表分开）。 */
export const unlockedMaps = (profile, mode = 'td') => {
  const table = mode === 'defense' ? DEFENSE_MAPS : MAPS;
  return Object.keys(table).filter((id) => !mapLocked(profile, id));
};

/**
 * STATUS §3.1 #29（已拍板）：**深链进锁着的图要按档案归一化**。
 * 大厅那条路本来就卡得住（锁着的卡面点不动），绕过去的是深链：`?map=map_06`、
 * 尤其是 `?skipstart=1`（`setupStartScreen()` 直接 return，连大厅的归一化都不跑）——
 * 玩家能开局玩到没解锁的内容，结束还照样记档、照样涨声望。
 * 返回 `{ mapId, notice }`：`mapId` 一定是本模式下已解锁的图；换了图就带一句话给玩家。
 */
export function unlockedFallback(profile, mode = 'td', mapId = null) {
  const pool = unlockedMaps(profile, mode);
  if (mapId && pool.includes(mapId)) return { mapId, notice: null };
  const fallback = pool[0] ?? (mode === 'defense' ? 'def_01' : 'map_01');
  const name = (id) => (MAPS[id] ?? DEFENSE_MAPS[id])?.name ?? id;
  const lock = mapId ? mapLocked(profile, mapId) : null;
  return {
    mapId: fallback,
    notice: `「${name(mapId ?? fallback)}」还没解锁${lock ? `（需要 ${lock.text}）` : ''}，已换成「${name(fallback)}」`,
  };
}

/** 一局结束后记档：声望、人物经验、每图战绩（最快通关 / 最高核心残血 / 漏怪）。 */
export function recordResult(profile, { mapId, difficulty, result, timeSec, coreHp, leaks, roundsCleared = 0, commanderBonus = 0 }) {
  const next = { ...profile, clears: { ...profile.clears } };
  next.playCount = (profile.playCount ?? 0) + 1;
  const base = result === 'win' ? (REPUTATION.win[difficulty] ?? REPUTATION.win.normal) : REPUTATION.lose;
  const gain = Math.round(base + commanderBonus);
  next.reputation += gain;
  next.exp += gain;
  const before = profile.commanderLevel;
  next.commanderLevel = commanderLevelOf(next.exp);
  const rec = { ...(next.clears[mapId] ?? { clears: 0, wins: 0, bestTimeSec: null, bestCoreHp: 0, leaks: 0 }) };
  rec.clears += 1;
  if (result === 'win') {
    rec.wins += 1;
    rec.bestTimeSec = rec.bestTimeSec == null ? Math.round(timeSec) : Math.min(rec.bestTimeSec, Math.round(timeSec));
  }
  rec.bestCoreHp = Math.max(rec.bestCoreHp, Math.round(coreHp));
  // §12.3 / §12.6：防守模式的成绩是「守住几轮 + 城堡剩多少」，不是「多快通关」——
  // 两个模式的榜不可比，各记各的指标（`resultSummary` 一直在给这个数，以前只是被丢掉了）
  rec.bestRounds = Math.max(rec.bestRounds ?? 0, roundsCleared);
  rec.leaks = leaks;
  next.clears[mapId] = rec;

  // §1.7.3：两笔流水——本次声望从哪来、这次打完又解锁了哪些内容（都带 source）
  const at = Date.now();
  next.ledger = ledgerAdd(next.ledger, {
    t: at, kind: 'reputation', delta: gain, source: result === 'win' ? 'match_win' : 'match_lose', mapId, difficulty,
  });
  for (const mode of ['td', 'defense']) {
    for (const u of unlocksOf(next, mode)) {
      if (!u.unlocked || unlocksOf(profile, mode).find((x) => x.id === u.id)?.unlocked) continue;
      next.ledger = ledgerAdd(next.ledger, { t: at, kind: 'unlock', id: u.id, source: u.source });
    }
  }
  return { profile: next, gain, leveledUp: next.commanderLevel > before, reputationGain: gain };
}

/* ---------- 存储 ---------- */

/**
 * §205：**档案也要过一遍形状**（`settings.js` 早就这么做了，档案这一半一直裸着）。
 *
 * 档案是**跨界数据**：它从 `localStorage` 来——玩家能改、也要跨版本留着（和 §204 那张
 * 「版本号对、内容读不出来」的存档是同一类）。字段形状一坏，大厅就直接白屏：实测
 * `clears: null` → 模块顶层 `TypeError: Cannot read properties of null (reading 'map_01')`，
 * 页面只剩 static HTML、按钮一个都没接线（§177 那个形状，但触发源是档案而不是 URL）。
 *
 * 只归一化**形状**：数字要有限、`clears` 要对象且每条记录也是对象（六个数值字段各自兜底）、
 * `ledger` 要数组、`lastChoice` 要对象或 null。**不认识的多余字段原样留着**——前向兼容，
 * 别把以后版本加的东西吃掉（`...raw` 在最后展开之前、只覆盖这几个已知字段）。
 */
export function normalizeProfile(raw) {
  const base = emptyProfile();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const clears = {};
  if (raw.clears && typeof raw.clears === 'object' && !Array.isArray(raw.clears)) {
    for (const [id, rec] of Object.entries(raw.clears)) {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;   // 坏记录直接丢，别让它进 UI
      clears[id] = {
        clears: num(rec.clears, 0), wins: num(rec.wins, 0),
        bestTimeSec: Number.isFinite(rec.bestTimeSec) ? rec.bestTimeSec : null,
        bestCoreHp: num(rec.bestCoreHp, 0), leaks: num(rec.leaks, 0), bestRounds: num(rec.bestRounds, 0),
      };
    }
  }
  return {
    ...base, ...raw,
    reputation: num(raw.reputation, 0),
    exp: num(raw.exp, 0),
    commanderLevel: Math.max(1, Math.round(num(raw.commanderLevel, 1))),
    playCount: num(raw.playCount, 0),
    tutorialDone: raw.tutorialDone === true,
    clears,
    ledger: Array.isArray(raw.ledger) ? raw.ledger : [],
    lastChoice: raw.lastChoice && typeof raw.lastChoice === 'object' ? raw.lastChoice : null,
  };
}

export function loadProfile() {
  try {
    const raw = storage.get(KEY);      // §平台适配：小游戏走 wx.getStorageSync，浏览器仍是 localStorage
    if (!raw) return emptyProfile();
    const parsed = JSON.parse(raw);
    return parsed?.v === PROFILE_VERSION ? normalizeProfile(parsed) : emptyProfile();
  } catch { return emptyProfile(); }
}

export function saveProfile(profile) {
  try { return storage.set(KEY, JSON.stringify(profile)); } catch { return false; }
}

export function clearProfile() {
  try { storage.remove(KEY); } catch { /* 忽略 */ }
}
