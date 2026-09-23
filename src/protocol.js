// 客户端 ↔ 服务端协议（§10.2：开发期 JSON，上线再换 Protobuf）。
// 原则：客户端只发「指令」，服务端是唯一权威（§10.3）。

export const PROTOCOL_VERSION = 1;
import { HEROES, MONSTERS, TARGET_PRIORITIES, TIMING, TOWERS } from './data.js';
import { FORTS, EQUIP_SLOTS, QUALITY_ORDER } from './data.js';
import { project } from './core.js';
import { towerStatsAt } from './match.js';
export const TICK_RATE = TIMING.tickRate;   // 逻辑帧（§119：只从 data.js 取，别再写一份 20）
export const SNAPSHOT_RATE = 10;    // 广播频率：10Hz（§10.2 的增量方案先简化为结构化全量）
export const MAX_COMMANDS_PER_SEC = 20; // 指令频率限制（防作弊，§12.7 的同款约束）

/** 指令类型 → mode.js 里的动作。新增指令必须同时加服务端校验。 */
/**
 * 客户端能发的全部指令。这张表以前**没有任何读取方**（写在这里、没人校验），
 * 而且漏了防守模式的四条与只读的两条——`tests/net.test.js` 现在按它做双向对齐检查：
 * 每条都要有服务端分支（`server/room.js` 的 `case`）和客户端发送方（`net.js` 的 `t:`）。
 */
export const COMMANDS = [
  'build', 'upgrade', 'sell', 'priority', 'cast',
  'buy', 'potion', 'craft',
  'equip', 'enhance', 'sellitem',          // §5.4：穿戴（自由换装）/ 强化 / 出售装备
  'early', 'revive', 'ping',
  'move', 'fort', 'repair', 'teleport', 'repairTower',
  'resync',                                // §10.3：客户端发现序号跳跃 → 要一份全量快照
  /**
   * STATUS §3.1 #23（已拍板）：**主动退房**要与「掉线」分开。
   * 以前客户端点「回大厅」只是把连接关掉，服务端按 §10.3 把座位**保留 5 分钟**（那是给掉线重连的），
   * 于是那位玩家的位子在服务端还占着：3 人在玩 + 1 个刚离开 = `isFull()` 满员，第 4 个朋友进不来，
   * 第一波出怪前的怪量也还按 4 人缩放（验证记录 §113 量的）。这条指令只做一件事：
   * 把**自己**那个座位立刻释放，别人马上能补进来。
   */
  'leave',
];


export function decode(text) {
  const msg = JSON.parse(text);
  if (typeof msg?.t !== 'string') throw new Error('缺少消息类型 t');
  return msg;
}

/** 房间码：6 位大写字母数字，去掉易混字符（0/O/1/I）。 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const makeRoomCode = (rng = Math.random) =>
  Array.from({ length: 6 }, () => ALPHABET[Math.floor(rng() * ALPHABET.length)]).join('');

/* ---------- 服务端 → 客户端 ---------- */

export const msg = {
  // config：房间的**配置**（模式 / 地图 / 难度）。客户端进房时按它对齐自己的镜像——
  // 不带这个的话，一个「上一局打防守」的玩家用房间码进 TD 房，客户端镜像就是防守形状，
  // 收到第一份 TD 快照直接抛异常（验证记录 §102）。
  hello: (roomCode, playerId, playerCount, shared, me, slot = 0, profile = null, config = null) => ({
    t: 'hello', v: PROTOCOL_VERSION, roomCode, playerId, playerCount, slot, s: shared, me, profile, config,
  }),
  error: (text, code = 'error') => ({ t: 'error', code, text }),
  // §149：`extra` 是「一局结束时只在服务端算得出来的账本」——目前是伤害占比（客户端是纯镜像，
  // 自己不跑模拟，`stats.damage` 永远是空的，结算面板会写「本局没有记录到伤害」）。
  // 一次性随这条消息发（不进 10Hz 快照：那等于挂机在结算页时每秒白发几百字节，§10.1 的带宽预算）。
  profile: (profile, gain = 0, leveledUp = false, extra = null) => ({ t: 'profile', profile, gain, leveledUp, extra }),
  snap: (shared, me) => (me ? { t: 'snap', s: shared, me } : { t: 'snap', s: shared }),
  events: (list) => ({ t: 'ev', e: list }),
  joined: (playerId, players) => ({ t: 'joined', playerId, players }),
  left: (playerId, players) => ({ t: 'left', playerId, players }),
  // §174：这里原来还有一条 `chat`——**全项目零发送方、零处理方**（设计文档里也没有聊天/快捷短语这项），
  // 和 §？删掉的那条 `price` 查询是同一种东西。删掉，并加一条检查盯着「每个消息类型两边都要有人用」。
};

/* ---------- 快照：索引化 + 增量（§10.1 的 15KB/s 预算） ---------- */

/* ---------- 防守模式的快照（§12.5：同一套编码思路，字段按这个模式的需要裁剪） ---------- */

export function createDefenseSnapshotter() {
  let prevMonsters = new Map();
  let rev = 0;

  return function build(m, { full = false, peek = false } = {}) {
    const saved = prevMonsters;
    // rev 是**广播流的序号**：只有真正广播出去的那一份才 +1。
    // peek 是「给某个玩家单独补一份」的私有快照，它也 +1 的话，其他人的序号就会出现
    // 无法解释的跳跃——§10.3 的「序号跳跃 ⇒ 请求全量」也就没法实现（见验证记录 §64）。
    if (!peek) rev += 1;
    const monsters = [];
    const removed = [];
    const rows = new Map();
    const seen = new Set();
    for (const x of m.monsters) {
      if (x.dead) continue;
      const row = [
        x.uid, MOB_IDS.indexOf(x.mobId), KIND_IDS.indexOf(x.kind ?? 'field'),
        x.cell.x, x.cell.y, Math.round(x.hp),
        (x.isAir ? 1 : 0) | (x.attacking ? 2 : 0) | (x.active ? 4 : 0),
        Math.round(x.maxHp),   // §165：血条的分母（服务端按难度/人数缩放过，镜像不能自己算）
      ];
      rows.set(x.uid, row);
      seen.add(x.uid);
      const k = row.join(',');
      if (full || prevMonsters.get(x.uid) !== k) monsters.push(row);
    }
    if (!full) for (const uid of prevMonsters.keys()) if (!seen.has(uid)) removed.push(uid);
    prevMonsters = rows;

    const s = {
      rev,
      t: +m.time.toFixed(1),
      mode: 'defense',
      gold: Math.round(m.gold),
      castle: [Math.round(m.castle.hp), m.castle.maxHp],
      hero: [
        HERO_IDS.indexOf(m.hero.def.id), m.hero.level, Math.round(m.hero.exp), Math.round(m.hero.hp),
        m.hero.dead ? 1 : 0, +m.hero.reviveTimer.toFixed(1),
        m.hero.cell.x, m.hero.cell.y,
        (m.hero.path ?? []).slice(0, 24).map((c) => [c.x, c.y]),
        m.hero.skillCd.map((x) => +x.toFixed(1)), m.hero.skillUnlocked.map((b) => (b ? 1 : 0)),
        +((m.hero.teleportCd ?? 0).toFixed(1)),
      ],
      forts: m.forts.map((f) => [f.slot, FORT_IDS.indexOf(f.fortId), Math.round(f.hp)]),
      items: m.groundItems.slice(0, 40).map((it) => [
        it.cell.x, it.cell.y, Object.keys(EQUIP_SLOTS).indexOf(it.slot),
        QUALITY_ORDER.indexOf(it.quality), it.ilvl,
      ]),
      camps: m.camps.map((c) => [c.x, c.y, m.monsters.filter((x) => !x.dead && x.camp === c).length]),
      assault: [m.assault.round, Math.round(m.assault.timer), m.assault.warning ? 1 : 0, m.assault.endless ? 1 : 0],
      st: [m.stats.fieldKills, m.stats.drops, m.stats.castleHits, m.stats.roundsCleared],
      result: m.result ?? 0,
      mon: monsters,
      rm: removed,
    };
    if (full) s.full = 1;
    if (peek) prevMonsters = saved;
    return s;
  };
}

/** 用防守快照覆盖客户端镜像（不跑模拟，只渲染）。 */
export function applyDefenseShared(m, s) {
  m.time = s.t;
  m.gold = s.gold;
  m.castle.hp = s.castle[0];
  m.castle.maxHp = s.castle[1];
  const h = s.hero;
  m.hero.level = h[1];
  m.hero.exp = h[2];
  m.hero.hp = h[3];
  m.hero.dead = !!h[4];
  m.hero.reviveTimer = h[5];
  m.hero.cell = { x: h[6], y: h[7] };
  m.hero.path = h[8].map(([x, y]) => ({ x, y }));
  m.hero.skillCd = h[9].slice();
  m.hero.skillUnlocked = h[10].map((x) => !!x);
  m.hero.teleportCd = h[11] ?? 0;
  m.forts = s.forts.map((row) => {
    const fort = FORTS[FORT_IDS[row[1]]];
    return {
      slot: row[0], fortId: fort.id, hp: row[2], maxHp: fort.hp,
      cell: m.def.fortSlots[row[0]], stats: fort.blocks ? null : { ...fort },
    };
  });
  m.groundItems = s.items.map((row) => ({
    slot: Object.keys(EQUIP_SLOTS)[row[2]], quality: QUALITY_ORDER[row[3]], ilvl: row[4],
    cell: { x: row[0], y: row[1] }, baseAttrs: {}, affixes: [], uid: `${row[0]},${row[1]}`,
  }));
  m.camps = s.camps.map((row) => ({ x: row[0], y: row[1], alive: row[2], timer: 0 }));
  m.assault = { round: s.assault[0], timer: s.assault[1], warning: !!s.assault[2], endless: !!s.assault[3] };
  m.stats.fieldKills = s.st[0];
  m.stats.drops = s.st[1];
  m.stats.castleHits = s.st[2];
  m.stats.roundsCleared = s.st[3];
  m.result = s.result || null;

  const byId = new Map(m.monsters.map((x) => [x.uid, x]));
  if (s.full) byId.clear();
  if (s.rm) for (const uid of s.rm) byId.delete(uid);
  for (const row of s.mon) {
    const def = MONSTERS[MOB_IDS[row[1]]];
    byId.set(row[0], {
      uid: row[0], mobId: def.id, def, kind: KIND_IDS[row[2]] ?? 'field',
      cell: { x: row[3], y: row[4] }, hp: row[5], maxHp: row[7] ?? def.hp,   // §165：分母由服务端给
      armor: def.armor, armorType: def.armorType, isAir: !!(row[6] & 1),
      attacking: !!(row[6] & 2), active: !!(row[6] & 4), effects: [], dead: false, path: [],
    });
  }
  m.monsters = [...byId.values()];
  return m;
}

// 客户端与服务端共用同一份 data.js，所以「索引 ↔ id」不需要额外传输
export const MOB_IDS = Object.keys(MONSTERS);
export const TOWER_IDS = Object.keys(TOWERS);
export const HERO_IDS = Object.keys(HEROES);
export const PRIORITY_IDS = TARGET_PRIORITIES;
export const FORT_IDS = Object.keys(FORTS);
export const KIND_IDS = ['field', 'assault'];

const DIST_Q = 16;   // 位置量化：1/8 格（128/8）
const HP_Q = 1;

/**
 * 共享快照（所有人一样）：字段用数组 + 索引，怪物只发变化的部分。
 * 不含背包 / 装备 —— 那些走 per-player 的 me 消息，避免把每个人的背包广播给所有人。
 */
export function createSnapshotter() {
  let prevMonsters = new Map(); // uid → 行数组的签名
  let prevTowerSig = '';
  let rev = 0;

  /**
   * peek=true 时只算不「记账」：用于「给某个玩家单独补一份全量」的场景，
   * 否则那条私有消息会把增量标记吃掉，广播里的变化对其他人就永远丢了。
   */
  return function build(m, { full = false, peek = false } = {}) {
    const savedMonsters = prevMonsters;
    const savedTowerSig = prevTowerSig;
    if (!peek) rev += 1;   // 同上：私有补发的快照不该顶掉广播流的序号
    const monsters = [];
    const removed = [];
    const seen = new Set();
    const rows = new Map();

    for (const x of m.monsters) {
      if (x.dead) continue;
      const flags = (x.isAir ? 1 : 0) | (x.attacking ? 2 : 0);
      // §165：**把 maxHp 一起发**。血条画的是 `hp / maxHp`，而服务端的 maxHp 是
      // `baseHp × 难度 × 人数缩放`（长局 Boss 还另有血量表）——镜像以前只能拿 `def.hp` 当分母，
      // 于是噩梦 2 人房里那只 154 血的怪，血条按 154/90 = **171%** 画（实测，见验证记录 §165）。
      const row = [x.uid, MOB_IDS.indexOf(x.mobId), x.pathIndex, Math.round(x.dist / DIST_Q),
        Math.round(x.hp / HP_Q), flags, Math.round(x.maxHp)];
      rows.set(x.uid, row);
      seen.add(x.uid);
      const key = row.join(',');
      if (full || prevMonsters.get(x.uid) !== key) monsters.push(row);
    }
    if (!full) for (const uid of prevMonsters.keys()) if (!seen.has(uid)) removed.push(uid);
    prevMonsters = rows;

    const towerSig = m.towers.map((t) => `${t.slot}:${t.towerId}:${t.level}:${t.priority}:${t.invested}`).join('|');
    const towersChanged = full || towerSig !== prevTowerSig;
    prevTowerSig = towerSig;

    const shared = {
      rev,
      t: +m.time.toFixed(1),
      w: [m.wave.index, PHASE_ID[m.wave.phase], +m.wave.timer.toFixed(1), m.wave.spawned, m.wave.total],
      core: [Math.round(m.core.hp), m.core.maxHp],
      hero: [HERO_IDS.indexOf(m.hero.def.id), m.hero.level, Math.round(m.hero.exp), Math.round(m.hero.hp),
        m.hero.dead ? 1 : 0, +m.hero.reviveTimer.toFixed(1),
        m.hero.skillCd.map((x) => +x.toFixed(1)), m.hero.skillUnlocked.map((b) => (b ? 1 : 0))],
      gold: Math.round(m.gold),
      st: [m.stats.kills, m.stats.leaks],
      result: m.result ?? 0,
      mon: monsters,
      rm: removed,
    };
    if (full) shared.full = 1;
    // 弹道：寿命只有 0.2 秒左右、数量少（上限 40），每帧全发比做增量更简单也更省事
    if (m.projectiles.length) {
      shared.pr = m.projectiles.slice(-40).map((p) => [p.slot ?? -1, p.target?.uid ?? 0, +((p.progress ?? 0) * 20).toFixed(0)]);
    }
    if (towersChanged) {
      shared.tw = m.towers.map((t) => [t.slot, TOWER_IDS.indexOf(t.towerId), t.level, PRIORITY_IDS.indexOf(t.priority), t.invested, t.owner ?? 0]);
    }
    // 双守护目标（§2.2 map_06）：客户端会画**每一个**核心的血条，只发 core[0] 的话第二个永远是满血
    if ((m.cores ?? []).length > 1) shared.cores = m.cores.map((c) => [Math.round(c.hp), c.maxHp]);
    if (peek) { prevMonsters = savedMonsters; prevTowerSig = savedTowerSig; }
    return shared;
  };
}

const PHASE_ID = { prep: 0, spawning: 1, clearing: 2 };
const PHASE_NAME = ['prep', 'spawning', 'clearing'];

/** 每位玩家自己的那部分（金币共享、木材与背包私人）。 */
export function privateSnapshot(m, playerIndex = 0) {
  return {
    lumber: m.lumber[playerIndex] ?? m.lumber[0] ?? 0,
    bag: m.bag,
    potionCd: m.potionCd,
    shopBought: m.shopBought,
    shopCast: m.shopCast ?? null,   // §5.5：波次中的补给读条（客户端要画进度）
    scrolls: m.scrolls ?? 0,        // §5.5.1：回城卷轴（防守的「冷却中也能回城」按钮靠它点亮）
    bookBonus: m.bookLevelBonus,
    equipped: m.equipped,
    inventory: m.inventory.slice(-12),
    crafts: m.stats.crafts,
    drops: m.stats.drops,
  };
}

/** 把共享快照写进本地镜像（客户端不跑模拟，只渲染）。 */
export function applyShared(m, s) {
  m.time = s.t;
  m.wave = { index: s.w[0], phase: PHASE_NAME[s.w[1]] ?? 'prep', timer: s.w[2], spawned: s.w[3], total: s.w[4], queue: [] };
  m.core.hp = s.core[0];
  m.core.maxHp = s.core[1];
  if (s.cores) s.cores.forEach((c, i) => { if (m.cores[i]) { m.cores[i].hp = c[0]; m.cores[i].maxHp = c[1]; } });
  m.gold = s.gold;
  m.stats.kills = s.st[0];
  m.stats.leaks = s.st[1];
  m.result = s.result || null;
  m.hero.level = s.hero[1];
  m.hero.exp = s.hero[2];
  m.hero.hp = s.hero[3];
  m.hero.dead = !!s.hero[4];
  m.hero.reviveTimer = s.hero[5];
  m.hero.skillCd = s.hero[6].slice();
  m.hero.skillUnlocked = s.hero[7].map((x) => !!x);

  if (s.tw) {
    m.towers = s.tw.map((row) => {
      const cell = m.map.slots[row[0]];
      const towerId = TOWER_IDS[row[1]];
      return {
        uid: row[0] + 1, towerId, slot: row[0], level: row[2],
        priority: PRIORITY_IDS[row[3]], invested: row[4], owner: row[5] ?? 0, cooldown: 0,
        cell,
        // §2.3 / §69：镜像的塔也要带**自己的**统计（含地形加成），而且**结算/本地续玩要用它**——
        // 漏掉的话，「掉线后转单人继续」时塔开火会去读 undefined.range（验证记录 §104）
        stats: towerStatsAt(m.map, cell, towerId, row[2]),
      };
    });
  }
  const byId = new Map(m.monsters.map((x) => [x.uid, x]));
  if (s.full) for (const x of m.monsters) byId.delete(x.uid);
  if (s.rm) for (const uid of s.rm) byId.delete(uid);
  for (const row of s.mon) {
    const [uid, mi, pathIndex, dq, hp] = row;
    const def = MONSTERS[MOB_IDS[mi]];
    const path = m.map.paths[pathIndex] ?? m.map.paths[0];
    const dist = dq * DIST_Q;
    const cell = path.cells[Math.min(path.cells.length - 1, Math.floor(dist / 128))];
    byId.set(uid, {
      uid, mobId: def.id, def, pathIndex, dist, cell,
      hp, maxHp: row[6] ?? def.hp, armor: def.armor, armorType: def.armorType,   // §165：分母由服务端给
      isAir: !!(row[5] & 1), attacking: !!(row[5] & 2), effects: [], dead: false,
    });
  }
  m.monsters = [...byId.values()];
  m.projectiles = (s.pr ?? []).map((row) => {
    const tower = row[0] >= 0 ? m.towers.find((t) => t.slot === row[0]) : null;
    return {
      towerId: tower?.towerId ?? 'hero', slot: row[0], progress: row[2] / 20,
      from: tower ? project(tower.cell.x, tower.cell.y, 1.1) : { x: 0, y: 0 },
      target: m.monsters.find((x) => x.uid === row[1]) ?? null,
      stats: { attackType: 'normal' }, damage: 0, life: 1,
    };
  });
  return m;
}

export function applyPrivate(m, me) {
  m.lumber[0] = me.lumber;
  m.bag = { ...me.bag };
  m.potionCd = { ...me.potionCd };
  m.shopBought = { ...me.shopBought };
  m.shopCast = me.shopCast ?? null;
  m.scrolls = me.scrolls ?? 0;
  m.bookLevelBonus = me.bookBonus;
  m.equipped = me.equipped;
  m.hero.equipped = m.equipped;   // §5.2：英雄属性读装备，快照落地后要把这条引用接回去
  m.inventory = me.inventory;
  m.stats.crafts = me.crafts;
  m.stats.drops = me.drops;
  return m;
}

/** 旧的整包快照（建房时给一次全量，避免逐条补）。 */
export const snapshot = (m, rev) => ({ ...createSnapshotter()(m, { full: true }), rev });
