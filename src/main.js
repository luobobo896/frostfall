// 客户端入口：把内核、等距渲染与 HUD 接起来，做成能玩的 M0.5 原型。

import { DEFENSE_MAPS, MAPS, TICK_STEP, TOWERS, choiceFrom } from './data.js';
import { createMatch, buildTower, buyItem, castSkill, craftEquipment, describe,
  enhanceItem, enhanceCostOf, equipItem, heroStats, sellItem, sellTower, setPriority, shopPriceOf, startWaveEarly, towerAtSlot, update,
  upgradeTower, usePotion, reviveNow, repairTower } from './match.js';
import { createMinimap, createRenderer, drawMapThumb } from './render.js';
import { createUI } from './ui.js';
import { gridDist } from './core.js';
import { autoPlay } from './ai.js';
import { applyRemoteMessage, connect, identity } from './net.js';
import { clearSave, hasSave, loadFromStorage, saveToStorage as saveMatch } from './save.js';
import { UNLOCK_SOURCE_LABEL, clearProfile, isFirstRun, loadProfile, mapLocked, markTutorialDone, recordResult, reviveMulOf, saveProfile as saveProfileRaw, startGoldOf, unlockedFallback, unlockedMaps } from './profile.js';
import { damageFloaters, recordLabel } from './hud-model.js';
import { pendingBuild, reconcilePending, rejectLastPending } from './predict.js';
import { createTutorial, tutorialPasses } from './tutorial.js';
import {
  buildFort, createDefenseMatch, defenseHeroStats, describeDefense, orderMove, repairCastle,
  steerGoal, teleportHome, updateDefense,
} from './defense.js';
import { FORTS } from './data.js';
import { autoPlayDefense } from './ai-defense.js';
import { mapDefOf, resultSummary } from './result.js';
import { loadSettings, renderOptions, resetSettings, saveSettings } from './settings.js';
import { createCue } from './audio.js';
import { createHaptics } from './feedback.js';
import { createJoystick } from './joystick.js';

const canvas = document.getElementById('game');
const renderer = createRenderer(canvas);
const minimap = createMinimap(document.getElementById('minimap'));

/**
 * §183：**本机写不进存储**（隐私模式 / 站点禁用了存储 / 配额满）时，至少要让玩家知道一声——
 * 不然他打完一局、刷新回来什么都没有，只会以为游戏坏了（`saveProfile` / `saveToStorage`
 * 本来就返回成败，只是全项目没人看过这个返回值）。
 *
 * 两个存档出口在这里收成一处（调用点有 11 个，逐个加判断既啰嗦又容易漏）。写失败只**记一笔**：
 * `startMatch()` 在模块初始化时就跑过一遍，那会儿 `ui` 还没建好（TDZ），不能在原地弹提示——
 * 由帧循环统一说一次（帧循环启动时一切就绪）。
 */
let saveBlocked = false;    // 写失败了、还没说
let saveTold = false;       // 已经说过一次（不然自动存档每 5 秒失败一次 = 每 5 秒弹一条）
const saveFailed = (ok) => { if (ok === false && !saveTold) saveBlocked = true; return ok; };
const saveProfile = (p) => saveFailed(saveProfileRaw(p));
const saveToStorage = (m) => saveFailed(saveMatch(m));

const params = new URLSearchParams(location.search);
// §3.1 #29：`skipstart` 只跳过**这一页开头**那一次大厅（见 setupStartScreen 的注释）
let skipStart = params.has('skipstart');
const view = { paused: false, rate: 1, selectedSlot: null, selectedTower: null, localSlot: 0, floaters: [] };
let pendingTowers = [];   // 客户端预测的待确认塔（§10.3：只预测放塔）
let lastMonsters = [];   // 上一帧的怪物血量快照，用来算伤害飘字
let profile = loadProfile();
// §2.1「支持上次配置一键开局」：URL 参数 > 上次开局用的配置 > 默认值
// §177：两个来源都要过 `choiceFrom`（`data.js` 里那一份归一化规则）——URL 是玩家能改的，
// `lastChoice` 是上一局存下来的（跨版本就是过期 id），任何一个带着非法值进 `createMatch` 都是
// **整页白屏**，而且脏值还会被写回档案、之后每次打开都白屏（验证记录 §177）。
const lastChoice = profile.lastChoice ?? {};
const choice = choiceFrom(params, lastChoice);
/**
 * STATUS §3.1 #29（已拍板）：**深链进锁着的图要按档案归一化**。
 * 大厅那条路本来就会把锁着的图卡住（`mapLocked` → `locked` 卡面 + 点不动），可深链能绕过去：
 * `?map=map_06`（更彻底的是 `?skipstart=1`）直接开局，还照样记档——玩家能玩到没解锁的内容、
 * 拿到本该靠进度换的声望与解锁。这里把「归一化」提到**进局之前**，大厅与深链走同一条规则。
 */
const unlockedFix = unlockedFallback(profile, choice.mode, choice.map);
let lockNotice = unlockedFix.notice;
choice.map = unlockedFix.mapId;
let settings = loadSettings();
let tutorial = null;   // 首次进入时挂上引导层（§14.3 稿 11）
let lastWaveSeen = 0;

/** 档案条：人物等级 / 声望 / 初始金币 / 各图最快通关。 */
function renderProfileBar() {
  const bar = document.getElementById('profileBar');
  if (!bar) return;
  const clears = Object.entries(profile.clears)
    .filter(([, r]) => r.wins > 0)
    // 地图名要两张表都查：档案是按 mapId 记的，防守图（def_*）不在 MAPS 里
    // 成绩文案也分模式（§12.6：通关时间 vs 守住轮次，不可比）
    .map(([id, r]) => `${mapDefOf(id)?.name ?? id} ${recordLabel(id, r)}`)
    .join(' · ');
  bar.textContent = `人物 Lv${profile.commanderLevel} · 声望 ${profile.reputation} · 初始金币 ${startGoldOf(profile)}`
    + (clears ? ` · 战绩：${clears}` : '');
}

let match = startMatch();

/**
 * §141：`?sim=300` = 「先无头快进 300 秒再开始渲染」（截图 / 联调用），两种模式各用各的参考打法。
 * 它同时是个**能给玩家占便宜的钩子**：分享链接改一个参数就能让 AI 先把前 10 分钟打完再交给自己
 * （单机局的战绩与声望是本地记的）。所以按 §126 对服务端调试钩子定的规矩，**默认关**：
 * 要显式带上 `?debug=1` 才生效。`?autoresume=1` 那种「只读档」的钩子不受影响（没有可占的便宜）。
 *
 * §197：**但 `?debug=1` 也是 URL 参数，玩家照样能加**——§126 对服务端同款钩子（`?wave=`）的结论是
 * 「必须用**非 URL** 的开关」，这一条现在补齐：`sim` 只在**本机**（localhost / 127.0.0.1 / ::1）生效。
 * 开发照旧（冒烟、截图都跑在 127.0.0.1），部署出去的副本里这个后门自然失效——§189 的探针实测过
 * 它原来能白送声望 +120 与地图解锁。
 */
const SIM_HOOK_OK = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
if (params.get('sim') && params.has('debug') && SIM_HOOK_OK) {
  if (match.mode === 'defense') autoPlayDefense(match, { maxSeconds: Number(params.get('sim')) });
  else autoPlay(match, { maxSeconds: Number(params.get('sim')) });
}
// 调试：?autoresume=1 直接读档进局（无头验证存档用，省去点按钮）
if (params.has('autoresume')) {
  const restored = loadFromStorage();
  if (restored) match = restored;
}

function startMatch() {
  view.paused = false;
  view.selectedSlot = null;
  view.selectedTower = null;
  view.resultDismissed = false;   // §131：新的一局，「继续（无尽）」收起面板的标记要清掉
  view.resultExtra = null;
  // §2.1：记下「上次配置」，下次进大厅直接沿用（URL 参数仍然优先）
  profile = { ...profile, lastChoice: { ...choice } };
  saveProfile(profile);
  if (choice.mode === 'defense') {
    tutorial = null; view.tutorial = null;
    view.localSlot = 0;
    const dm = createDefenseMatch({
      mapId: choice.map.startsWith('def_') ? choice.map : 'def_01',
      difficulty: choice.difficulty, heroId: choice.hero, seed: Number(params.get('seed') ?? 20260922),
      reviveMul: reviveMulOf(profile),   // §3.6：人物等级的复活加速
    });
    dm.autoPickup = settings.autoPickup;
    return dm;
  }
  const m = createMatch({
    mapId: choice.map,
    difficulty: choice.difficulty,
    heroId: choice.hero,
    seed: Number(params.get('seed') ?? 20260922),
    startGold: startGoldOf(profile),   // §3.6：人物等级的初始金币加成
    reviveMul: reviveMulOf(profile),   // §3.6：人物等级的复活加速（满级快 8.7%）
    length: choice.length,
  });
  // 首次进入自动开引导：同一局游戏上叠一层提示，不是单独模式。
  // §153：引导的四步全是塔防的（建塔 → 提前开波 → 旋风斩 → 撑住一波），所以**它只在 TD 挂**——
  // 这一条不需要额外写判断：防守在函数开头就 `return dm` 了，根本走不到这一段。
  // （我一度在这里加了 `m.mode !== 'defense' &&`，结果探针证明那是死代码；见验证记录 §153.3。）
  // 冒烟里那条「新手第一局打防守时不挂引导」钉的就是这条控制流：谁把引导挪到 return 之前就会红。
  if (isFirstRun(profile) && !params.has('notutorial')) {
    tutorial = createTutorial({ startedAt: 0 });
    lastWaveSeen = 0;
    view.tutorial = tutorial;
  } else { tutorial = null; view.tutorial = null; }
  return m;
}

const stage = document.getElementById('stage');
const setLobby = (on) => { view.inLobby = on; stage.classList.toggle('lobby', on); };

/** 相机（§2.5）：TD 默认整图可见（0.74×）；关掉「整图可见」后按镜头档位放大到局部，可拖动/滚轮。 */
function applyCamera() {
  const grid = match?.map?.grid ?? { w: 32, h: 24 };
  renderer.fit(grid);
  if (match?.mode !== 'defense' && !settings.tdFitAll) renderer.setCamera(grid.w / 2, grid.h / 2, settings.zoom);
}

/** 设置生效：渲染选项（特效/缩放）+ 防守模式的自动拾取。 */
function applySettings() {
  view.render = renderOptions(settings);
  if (match?.mode === 'defense') match.autoPickup = settings.autoPickup;
  applyCamera();
}
applySettings();

/**
 * §10.7「内存告警下自动降级特效且不崩」。
 * 微信那边是 `wx.onMemoryWarning`；这里接到同一套设置上：告警来了就把特效切「低」
 * （关飘字与脉冲，见 settings.js 的 renderOptions）并提示一句——玩家不用自己翻设置，也不会因为一次告警崩掉。
 * 浏览器里没有这个事件，所以留了 `__frostfall.simulateMemoryWarning()` 给冒烟验整条路径
 * （真机的内存压力仍然只能真机验）。
 */
function degradeOnMemoryWarning(source = 'wx') {
  const before = settings.effects;
  settings = { ...settings, effects: 'low' };
  saveSettings(settings);
  applySettings();
  if (before !== 'low') ui.toast('内存告警：已自动切到低特效（可在设置里改回）');
  return { from: before, to: settings.effects, source };
}

globalThis.wx?.onMemoryWarning?.(() => degradeOnMemoryWarning('wx'));

/** 一局结束后记档：声望、人物等级、每图战绩（单人局；联机由服务端记账，M3 之后再接）。 */
let recorded = false;
function maybeRecordResult() {
  if (net || !match.result || recorded) return;
  recorded = true;
  const r = recordResult(profile, {
    ...resultSummary(match),
  });
  profile = r.profile;
  saveProfile(profile);
  clearSave();
  view.resultExtra = { gain: r.gain, leveledUp: r.leveledUp, commanderLevel: profile.commanderLevel };
  ui.toast(`声望 +${r.gain}${r.leveledUp ? ` · 人物等级提升到 ${profile.commanderLevel}` : ''}`);
  renderProfileBar();
}

/** 单人局自动存档：每 5 秒一次 + 切后台/关页面时补一次（§10.3 的「随时能停」）。 */
let saveClock = 0;
function maybeAutosave(dt) {
  if (net || match.result) return;
  saveClock += dt;
  if (saveClock < 5) return;
  saveClock = 0;
  saveToStorage(match);
}

document.addEventListener('visibilitychange', () => {
  if (net || match.result) return;
  if (document.visibilityState === 'hidden') saveToStorage(match);
});
window.addEventListener('pagehide', () => { if (!net && !match.result) saveToStorage(match); });

// 这份 handlers 同时给 createUI 与键盘快捷键用：**同一个出口**，联机分支只有一处
const handlers = {
  build: (slot, id) => {
    if (!net) {
      const ok = buildTower(match, slot, id);
      if (ok) tutorial?.onTowerBuilt(match.time);
      return ok;
    }
    const sent = net.build(slot, id);
    if (sent) {
      pendingTowers = pendingBuild(pendingTowers, slot, id, performance.now());
      tutorial?.onTowerBuilt(match.time);
    }
    return sent;
  },
  buildFort: (slot, id) => (net ? net.fort(slot, id) : buildFort(match, slot, id)),
  repair: () => (net ? net.repair() : repairCastle(match)),
  teleport: () => (net ? net.teleport() : teleportHome(match)),
  repairTower: (slot) => (net ? net.repairTower(slot) : repairTower(match, slot)),
  getSettings: () => settings,
  // §154：设置面板要按**当前模式**决定摆哪几行——「自动拾取 / 摇杆」是防守专用，
  // 「波次预告 / TD 整图可见」是 TD 专用，摆在另一边就是个按了没反应的假选项（§115 的同类）。
  isDefense: () => match?.mode === 'defense',
  // §3.1 #31：设置面板靠它决定要不要摆「离开房间」（联机才有这一格）
  isOnline: () => !!net,
  // 联机掉线时指令发不出去，界面要说「掉线了」而不是「金币不足」（两者都会让 handlers 返回 false）
  isOffline: () => !!net && !net.state.connected,
  updateSetting: (key, value) => {
    settings = { ...settings, [key]: value };
    saveSettings(settings);
    applySettings();
  },
  resetSettings: () => { settings = resetSettings(); applySettings(); },
  replayTutorial: () => {
    // §153：清掉「已看过」这一个标记就够了（门槛现在只看它）。以前这里也是这么写的，
    // 但门槛里还有一条 `playCount === 0`，于是对打完过一局的玩家**什么都不会发生**——
    // 修的是门槛，不是这一行。
    profile = { ...profile, tutorialDone: false };
    saveProfile(profile);
  },
  upgrade: (slot) => (net ? net.upgrade(slot) : upgradeTower(match, slot)),
  sell: (slot) => {
    const ok = net ? net.sell(slot) : sellTower(match, slot);
    if (ok) view.selectedTower = null;
    return ok;
  },
  setPriority: (slot, p) => (net ? net.priority(slot, p) : setPriority(match, slot, p)),
  castSkill: (i) => {
    const ok = net ? net.cast(i) : castSkill(match, i);
    if (ok) tutorial?.onSkillCast();
    return ok;
  },
  buy: (id) => (net ? net.buy(id) : buyItem(match, id)),
  usePotion: (id) => (net ? net.potion(id) : usePotion(match, id)),
  craft: (slot, q) => (net ? net.craft(slot, q) : craftEquipment(match, slot, q)),
  // §5.4：装备的穿戴 / 强化 / 出售（联机走指令，服务端权威）
  equipItem: (uid) => (net ? net.equip(uid) : equipItem(match, uid)),
  enhanceItem: (uid) => (net ? net.enhance(uid) : enhanceItem(match, uid)),
  sellItem: (uid) => (net ? net.sellItem(uid) : sellItem(match, uid, view.localSlot ?? 0)),
  // §7.6 快速复活：联机下必须走指令（服务端权威）——`net.revive` 早就在协议里了，
  // 但键盘快捷键是直接调内核的（见下），于是联机按 r 只改本地镜像、下一份快照又打回原样
  revive: () => (net ? net.revive() : reviveNow(match)),
  early: () => (net ? net.early() : startWaveEarly(match)),
  resume: () => { view.paused = false; },
  // §131：结局面板上的「继续（无尽）」——只在防守通关转无尽之后出现
  endless: () => { view.resultDismissed = true; },
  // 「再开一局」/「回大厅」都要先把上一局开着的那几个浮层收掉：
  // 塔面板/建造轮盘是**页面级**的 DOM，`startMatch()` 只清 `view.selectedSlot`，收不掉它们。
  // 不清的后果：核心被打爆的那一刻面板还开着 → 新局开局时它还挂在屏幕上，而且写着上一局的数值
  // （点「升级/出售」会打到新局的同号塔位，见验证记录 §95）。
  // §113：联机局里这两条都**不能只重置本地镜像**——服务端那一局才是权威的，下一份快照（10Hz）
  // 立刻把状态推回来：「再开一局」点了没反应（实测本地 time 归 0，1.5 秒后又变回 3 秒）；
  // 「回大厅」更绝：`setupStartScreen` 见到 `online` 直接 return、`#startScreen` 一直 hidden，
  // 结算面板又被 `view.inLobby` 藏掉 —— 最后是**一块冻住的战场、一个可点的按钮都没有**。
  restart: () => {
    if (net && leaveRoom({ online: '1' })) return;   // 联机：离房 → 同一套配置新开一间
    /**
     * §188：**「再开一局」也要把记档开关复位**。`recorded`（一局只记一次的闸）以前只在「回大厅」
     * 那条路上复位，于是连打两局时**第二局的战绩与声望全都不记**——实测：第一局输，声望 30 / 战绩 1 局；
     * 点「再开一局」打完第二局，档案纹丝不动（声望还是 30、战绩还是 1 局），回大厅再打一局才又涨到 60/2。
     * 玩家看到的是「结算面板照样弹、声望那个 toast 照样弹，但档案没动」。
     */
    recorded = false;
    clearSave(); saveClock = 0; ui.closeWheel(); ui.closeTower(); match = startMatch();
  },
  // 同上：回大厅也收一次（玩家可能是在面板开着时被结算弹窗盖住的）
  lobby: () => {
    if (net && leaveRoom()) return;                  // 联机：离房 → 回到真正的大厅
    // 回大厅：清掉本局状态并重新显示开始界面（模式/地图/英雄保留上次选择）
    clearSave();
    recorded = false;
    view.paused = false;
    view.floaters = [];
    pendingTowers = [];
    ui.closeWheel();
    ui.closeTower();
    match = startMatch();
    view.paused = true;                     // 先冻住，等玩家在大厅点开局
    setLobby(true);
    ui.el.overlay.classList.add('hidden');
    setupStartScreen();
  },
};

const ui = createUI(handlers);

/* ---------- 联机模式（§10.2）：?room=CODE 或 ?online=1 时，一切以服务端为准 ---------- */

// 断线/刷新自动回到上次的房间（§10.3 的 5 分钟保留窗口）
const autoRoom = !params.has('room') && params.has('rejoin') ? identity.lastRoom : null;
// §1.5：`?match=1` 也走联机——它没有房间码，房间是服务端排队时给的
const online = params.has('room') || params.has('online') || params.has('match') || !!autoRoom;
let net = null;
// `view.net` 与网络层的 `state` 是**同一个对象**：`onStatus` 被调用时 `state.connected` 已经是新值了，
// 所以「上一刻还连着吗」必须自己记一个变量（第一版就是去读 `view.net.connected`，于是掉线提示从不触发）。
let netWasConnected = false;

/**
 * §10.3：进不去房间时**转为单人继续**（文档原话：「以当前波次进度 + 个人资产重建单机态继续」）。
 * 客户端镜像本来就是全量快照搭出来的，所以这里只要把它「接回本地模拟」：
 * - 清掉弹道（镜像里的弹道只有渲染用的进度，交给本地 `update` 会算坏）；
 * - TD 回到**备战期**再开下一波（本波已经出了一半，重放会多刷怪——「当前波次进度」取保守解释）；
 * - 防守把下一波进攻的时间往后推，先给一段喘息。
 * 塔的 `stats` 由 `applyShared` 一起补好（否则本地开火会读 undefined.range）。
 */
function continueSolo(reason) {
  if (!net) return;
  try { net.close?.(); } catch { /* 服务端可能已经关了 */ }
  net = null;
  view.net = null;
  match.online = false;                 // 现在真的是一局单机局了：该存的存档照存（§113）
  document.getElementById('netBadge')?.classList.add('hidden');   // 已经是单机局了，别再显示「连接中…」
  match.projectiles = [];
  if (match.mode === 'defense') {
    match.assault = { ...match.assault, timer: Math.max(30, match.assault?.timer ?? 0) };
  } else {
    match.wave = { ...match.wave, phase: 'prep', timer: 12, spawned: 0, total: 0, queue: [] };
  }
  ui.toast(`连接已断开（${reason}）：已转为单人继续，当前波次与你的资产都保留`);
}

/**
 * §113：**离开联机房**——「再开一局」与「回大厅」都要先走这里。
 * 光关连接不够：`online` 是进页面时按 URL 定死的常量，`setupStartScreen()` 见到它就 return，
 * 所以大厅界面永远不会出现（实测点回大厅之后：网络仍连着、`#startScreen` 仍 hidden、
 * 页面上零个可点按钮，只能自己刷新）。重载成一条不带房间码的 URL 是让页面回到干净状态的
 * 最省做法——创建房间 / 快速匹配 / 进房本来就都是重载（`location.href`）。
 * `next` 传 `{ online: '1' }` 就是「用同一套配置新开一间」（大厅则不带任何在线参数）。
 */
function leaveRoom(next = {}) {
  if (!net) return false;
  // §3.1 #23：走 `leave()` 而不是 `close()`——前者先告诉服务端「我是自己走的」，
  // 座位立刻释放（`close()` 在服务端与掉线无法区分，会留下 5 分钟的座位）。
  try { (net.leave ?? net.close)(); } catch { /* 服务端可能已经关了 */ }
  net = null;
  view.net = null;                       // 免得离房那一瞬间的旧状态再把徽标刷出来
  const q = new URLSearchParams(params);
  for (const k of ['room', 'match', 'aligned', 'online']) q.delete(k);
  for (const [k, v] of Object.entries(next)) q.set(k, v);
  location.replace(`?${q}`);
  return true;
}

if (online) {
  net = connect({
    room: params.get('room') ?? autoRoom ?? undefined,
    match: params.has('match'),
    name: params.get('name') ?? `玩家${Math.floor(Math.random() * 90 + 10)}`,
    // §177：握手里报的配置与**本机镜像**用的是同一份 `choice`（归一化过的那份）。
    // 以前这里手抄了一遍默认值：镜像按 `lastChoice` 建、握手却报 map_01/td，两边说的不是一局
    // （§102 那个「防守镜像进 TD 房」的场面就是这么来的）；非法值也不会再从这里漏出去。
    mapId: choice.map,
    mode: choice.mode,
    length: choice.length,
    difficulty: choice.difficulty,
    heroId: choice.hero,
    seed: params.get('seed') ?? undefined,
    onSnapshot: (shared, me) => applyRemoteMessage(match, shared, me),
    onEvents: (events) => {
      const last = events[events.length - 1];
      if (last) ui.toast(last.text);
    },
    onProfile: (serverProfile, gain, leveledUp, extra) => {
      // 联机结算以服务端为准；本地档案只是缓存（下次进大厅就用它显示等级与解锁）
      profile = serverProfile;
      saveProfile(profile);
      renderProfileBar();
      // §149：结算面板的「伤害占比」读的是镜像里的 `stats.damage`，而镜像自己不算伤害——
      // 服务端在结算时把这一局的账本一起推过来，这里补进镜像（不然面板会写「本局没有记录到伤害」）。
      if (extra?.damage && match) match.stats.damage = { ...extra.damage };
      // §130：结局面板要显示「声望 +N / 人物等级提升到 N」——单机那半由 maybeRecordResult 写
      // `view.resultExtra`，联机这半以前只弹了个 toast，面板里**没有这一行**（同一个面板两种口径）。
      view.resultExtra = { gain, leveledUp, commanderLevel: serverProfile.commanderLevel };
      ui.toast(`声望 +${gain}${leveledUp ? ` · 人物等级提升到 ${profile.commanderLevel}` : ''}`);
    },
    onError: (message) => {
      // 服务端拒绝 → 撤掉最近一条预测，别留鬼影
      const { list, rejected } = rejectLastPending(pendingTowers);
      pendingTowers = list;
      if (rejected) ui.toast('建造被拒绝');
      // §10.3：进不去房间（过期中途加入窗口 / 房间满）时**转为单人继续**——
      // 文档原话是「以当前波次进度 + 个人资产重建单机态继续」。不做的话玩家只剩一块冻住的画面。
      if (message?.code === 'in_progress' || message?.code === 'room_full') continueSolo(message.text ?? message.code);
    },
    // §1.5：房间码输错/过期时服务端另起了一间——把这件事说给玩家听（一次）
    onNotice: (text) => ui.toast(text),
    /**
     * §1.5：**房间配置以服务端为准**。客户端镜像（`match`）是按自己「上次配置」建的，
     * 一个刚打完防守的玩家用房间码进 TD 房，镜像就是防守形状——收到第一份 TD 快照时
     * `applyShared` 会去写不存在的 `m.core.hp`，整页抛异常（验证记录 §102）。
     * 对齐方式：带着服务端给的配置**重载一次**（进房瞬间、还没开局，代价可接受），
     * 用 `aligned=1` 防止配置再对不上时无限重载。
     */
    onHello: (message) => {
      const cfg = message.config;
      if (!cfg || params.has('aligned')) return false;
      const wantMode = cfg.mode === 'defense' ? 'defense' : 'td';
      const haveMode = match.mode === 'defense' ? 'defense' : 'td';
      // §163：`length` 也要对——它决定镜像用哪张波次表（12 波 / 长局 30 波）。少了这一项，
      // 加入长局房的人 HUD 一直写「/ 12 波」，第 13 波起的「下一波预告」全是「—」。
      const wantLength = wantMode === 'defense' ? null : (cfg.length ?? 'short');
      if (wantMode === haveMode && cfg.mapId === match.mapId
        && (wantLength === null || wantLength === (match.length ?? 'short'))
        // §166：英雄职业也要对——它是「一房一个英雄」，加入者按自己大厅选的职业建镜像就会看到
        // 别人的技能名与属性（服务端跑的是房主那个英雄）。
        && (!cfg.heroId || cfg.heroId === match.hero?.def?.id)) return false;
      const next = new URLSearchParams(params);
      next.set('mode', wantMode);
      next.set('map', cfg.mapId);
      next.set('difficulty', cfg.difficulty ?? 'normal');
      if (wantLength) next.set('length', wantLength);
      if (cfg.heroId) next.set('hero', cfg.heroId);
      next.set('aligned', '1');
      location.replace(`?${next}`);
      return true;   // 告诉网络层：这份快照先别用（镜像形状还没对齐，套上去会抛异常）
    },
    onStatus: (state) => {
      if (!net) return;   // 已经「转单人继续」了：旧连接的状态不许再刷界面（否则徽标又冒出来）
      const wasOnline = netWasConnected;
      netWasConnected = !!state.connected;
      view.net = state;
      view.localSlot = state.slot ?? 0;
      // §114：掉线那一刻说一句（之后长期挂着的是上面那条徽标文案）
      if (wasOnline && !state.connected) ui.toast('连接已中断，正在重连：5 分钟内可用同一身份回到原座');
      if (state.error) ui.toast(state.error);
      renderNetBadge(state);
    },
    onPlayerList: (players) => renderNetBadge({ ...view.net, players }),
  });
  // §113：镜像打上「这是联机局」的标记——**联机局不落本地存档**（服务端才是权威）。
  // 少了它，任何「先断连接再离开页面」的路径都会让 `pagehide` 把镜像写进 `frostfall:save`：
  // 回大厅之后大厅会多出一个「继续上局」，点进去是一局没有服务端的鬼局。
  // `continueSolo()` 会把这个标记摘掉（那时它真的变回单机局了，该存）。
  match.online = true;
}

/* ---------- 开始界面（§14.3 稿 1-3） ---------- */

function setupStartScreen() {
  const screen = document.getElementById('startScreen');
  if (online) return;
  /**
   * §3.1 #29：`skipstart` 是**一次性**的——它只跳过这一页开头那次大厅（深链、截图、冒烟用）。
   * 以前它是永久生效：深链页上点「回大厅」时这个函数又一次直接 return，`#startScreen` 一直 hidden，
   * 页面上一个可点的按钮都没有（§113 那个场面的另一半）。这里消费掉，之后照常摆大厅。
   */
  if (skipStart) { skipStart = false; return; }
  screen.classList.remove('hidden');
  setLobby(true);

  // 地图清单随模式变。深链（如 ?mode=defense，README 里是正式入口）进来时 choice.map
  // 可能还是另一模式的图 id 或被锁着，先归一化——否则大厅里一张地图都不会高亮。
  const pool = unlockedMaps(profile, choice.mode === 'defense' ? 'defense' : 'td');
  if (!pool.includes(choice.map)) choice.map = pool[0] ?? (choice.mode === 'defense' ? 'def_01' : 'map_01');

  /**
   * §158：**地图清单从数据表生成**。以前这里是手抄的三张：
   *   `? { def_01: '边陲小镇 ★', def_02: …, def_03: … } : { map_01: '霜原哨站 ★', map_02: …, map_03: … }`
   * 两个后果：① 4★-6★ 的长局图（map_04/05/06，§2.2 单独一组的内容）**解锁了在大厅里也点不到**，
   * 只能手改 `?map=map_04`（冒烟就是这么进的——所以这个洞一直没被 UI 用例照到）；
   * ② 星级是手抄的字符串，和数据里的 `stars` 各写一份（§155 那类「一个数字两个定义」）。
   */
  const mapTable = choice.mode === 'defense' ? DEFENSE_MAPS : MAPS;
  const mapOptions = Object.fromEntries(Object.values(mapTable).map((d) => [d.id, `${d.name} ${'★'.repeat(d.stars ?? 1)}`]));
  const groups = [
    ['optMode', 'mode', { td: 'TD 塔防', defense: '防守生存' }],
    ['optMap', 'map', mapOptions],
    ['optDiff', 'difficulty', { normal: '普通', hard: '困难', nightmare: '噩梦' }],
    // 长局是给「2-4 人 / 大图」的内容：单人 18 塔位在数值上打不过最终 Boss（见验证记录 §23.2）
    ['optLength', 'length', { short: '12 波（约 10 分钟）', long: '长局 30 波（约 30 分钟，推荐 2-4 人）' }],
  ];
  for (const [id, key, options] of groups) {
    const box = document.getElementById(id);
    box.innerHTML = '';
    // §115：防守模式**没有「局内时长」**——`createDefenseMatch` 根本不收 `length`，它按轮次无尽推进。
    // 以前这排按钮在防守下照样是可选项：玩家选「长局 30 波」开局，防守局不会因此变成 30 波（假选项）。
    if (key === 'length' && choice.mode === 'defense') {
      const hint = document.createElement('span');
      hint.className = 'muted small';
      hint.textContent = '按轮次无尽（守住越多轮越好）';
      box.appendChild(hint);
      continue;
    }
    for (const [value, label] of Object.entries(options)) {
      const b = document.createElement('button');
      const lock = key === 'map' ? mapLocked(profile, value) : null;
      if (key === 'map') {
        // 地图卡面（§2.7）：缩略图 + 星级 + 路线数 + 你的通关率 / 最快通关
        const rec = profile.clears[value] ?? { clears: 0, wins: 0, bestTimeSec: null };
        const lanes = choice.mode === 'defense'
          ? `${DEFENSE_MAPS[value].assaultSpawns.length} 条进攻路线`
          // §156：空中航线要写出来——§2.2 的地图表写的是「2 + 1 空中」，`buildMap()` 也真的多生成一条
          // `air: true` 的路（飞行怪只走它），而卡面以前只印 `pathCount`（迷雾沼泽写「2 条路」，实际 3 条）。
          : `${MAPS[value].pathCount} 条路${MAPS[value].airPath ? ' + 1 条空中航线' : ''}`;
        const best = recordLabel(value, rec);   // TD 写最快通关、防守写守住轮次（§12.6）
        const rate = rec.clears ? `通关 ${rec.wins}/${rec.clears}（${Math.round(rec.wins / rec.clears * 100)}%）· ` : '';
        b.className = `map-card${choice[key] === value ? ' on' : ''}${lock ? ' locked' : ''}`;
        b.innerHTML = `<canvas class="thumb"></canvas><div class="mname">${label}${lock ? ' 🔒' : ''}</div>
          <div class="mmeta">${lanes} · ${rate}${best}</div>`;
        box.appendChild(b);
        drawMapThumb(b.querySelector('canvas'), choice.mode, value);
      } else {
        b.textContent = lock ? `${label} 🔒` : label;
        b.className = choice[key] === value ? 'on' : '';
      }
      if (lock) {
        // §1.7.3：解锁来源（免费 / 成就 / 付费）要读给玩家看——不写出来，这个字段就是没人读的死数据
        const how = `${lock.text}（${UNLOCK_SOURCE_LABEL[lock.source ?? 'free']}解锁）`;
        b.title = `未解锁：${how}`;
        b.onclick = () => { document.getElementById('startHint').textContent = `地图未解锁：${how}`; };
      } else {
        b.onclick = () => {
          choice[key] = value;
          [...box.children].forEach((c) => c.classList.remove('on'));
          b.classList.add('on');
          // 切模式要换地图清单：TD 用 MAPS，防守用 DEFENSE_MAPS
          if (key === 'mode') {
            choice.map = value === 'defense'
              ? (unlockedMaps(profile, 'defense')[0] ?? 'def_01')
              : (unlockedMaps(profile)[0] ?? 'map_01');
            setupStartScreen();
          }
        };
      }
      if (key !== 'map') box.appendChild(b);
    }
  }
  // 英雄改成卡片 + 技能预览（§14.3 稿 3），单独渲染，不走通用的按钮行
  ui.renderHeroCards(choice.hero, (id) => { choice.hero = id; setupStartScreen(); });
  renderProfileBar();

  document.getElementById('btnSolo').onclick = () => {
    screen.classList.add('hidden');
    setLobby(false);
    match = startMatch();
  };
  // 有存档时多给一个「继续上局」入口（§10.3：杀进程重开进度不丢）
  if (hasSave() && !document.getElementById('btnResumeSave')) {
    const resume = document.createElement('button');
    resume.id = 'btnResumeSave';
    resume.className = 'btn';
    resume.textContent = '继续上局';
    resume.onclick = () => {
      const restored = loadFromStorage();
      screen.classList.add('hidden');
      setLobby(false);
      if (restored) {
        match = restored;
        choice.mode = restored.mode ?? (restored.mapId?.startsWith('def_') ? 'defense' : 'td');
        choice.map = restored.mapId;
        choice.difficulty = restored.difficulty;
        choice.hero = restored.hero.def.id;
      } else match = startMatch();
    };
    document.getElementById('btnSolo').before(resume);
    document.getElementById('startHint').textContent = '检测到未完成的一局，可点「继续上局」。联机最多 4 人；创建后会得到一个 6 位房间码。';
  }
  document.getElementById('btnCreateRoom').onclick = async () => {
    const hint = document.getElementById('startHint');
    hint.textContent = '正在创建房间…';
    // 开局参数一次算好：建房请求与跳转 URL 用同一份，别再靠手拼（漏掉 mode 时
    // 服务端会按「没给模式」建一局 TD，防守图就成了「未知地图 def_01」）
    const roomParams = {
      map: choice.map, mode: choice.mode, difficulty: choice.difficulty,
      hero: choice.hero, length: choice.length,
    };
    try {
      const res = await fetch(`/create?${new URLSearchParams(roomParams)}`);
      if (!res.ok) throw new Error('服务端未开启');
      const info = await res.json();
      // 保留入口上的其它参数（notutorial / seed 等），只覆盖进房需要的
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries({ ...roomParams, room: info.code })) next.set(k, v);
      location.href = `?${next}`;
    } catch (e) {
      hint.textContent = `创建失败：${e.message}。联机需要先运行 npm run server（单机用「单人开局」）。`;
    }
  };
  // §1.5 快速匹配：交给服务端队列按「模式 + 地图 + 难度」分桶（45 秒未满员即开局，人数不足按 §1.6 缩放）。
  // 与「创建联机房间」的差别只是 URL 上多一个 match=1——进房之后的路径完全一样。
  document.getElementById('btnMatch').onclick = () => {
    const hint = document.getElementById('startHint');
    hint.textContent = '正在匹配…（45 秒内没凑满就按当前人数开局）';
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({
      match: '1', map: choice.map, mode: choice.mode,
      difficulty: choice.difficulty, hero: choice.hero, length: choice.length,
    })) next.set(k, v);
    next.delete('room');   // 匹配不带头房间码，交给服务端分桶
    location.href = `?${next}`;
  };
  document.getElementById('btnJoinRoom').onclick = () => {
    const code = (prompt('输入 6 位房间码') ?? '').trim().toUpperCase();
    if (!code) return;
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({
      room: code, map: choice.map, mode: choice.mode,
      difficulty: choice.difficulty, hero: choice.hero, length: choice.length,
    })) next.set(k, v);
    location.href = `?${next}`;
  };
  document.getElementById('btnResetProfile').onclick = () => {
    if (!confirm('清空声望、人物等级与解锁进度？')) return;
    clearProfile();
    profile = loadProfile();
    choice.map = unlockedMaps(profile)[0];
    renderProfileBar();
    setupStartScreen();
  };
  document.getElementById('btnTutorialSkip').onclick = () => {
    tutorial?.skip();
    view.tutorial = null;
    profile = markTutorialDone(profile);
    saveProfile(profile);
    document.getElementById('tutorialBar').classList.add('hidden');
  };
}

setupStartScreen();
// 调试：?settings=1 直接打开设置面板（必须放在 createUI 之后，否则按钮还没接线）
if (params.has('settings')) document.getElementById('btnSettings').click();

/**
 * §152：**排队中**的判定。快速匹配（`?match=1`）的房间要先等最多 45 秒才开打（§1.5），
 * 服务端在这段时间里对排队房间**一份快照都不发**（`Room.tick()` 开头就 return），
 * 所以「镜像的对局时间还停在 0」就等于「还没开打」——不用为此加协议字段。
 * 以前这段时间玩家看到的是一块**冻住的战场**（对局时间 0、备战倒计时不动），
 * 徽标只写「房间 XXX · 1 人 · 0ms」，一句「在等什么、还要等多久」都没有。
 */
const inQueue = () => !!net && params.has('match') && !match?.result && !(match?.time > 0);

function renderNetBadge(state) {
  const el = document.getElementById('netBadge');
  if (!el) return;
  const names = (state.players ?? []).map((p) => p.name).join('、');
  el.classList.remove('hidden');
  if (state.connected) {
    el.textContent = `${inQueue() ? '匹配中…（最多 45 秒，凑满即开） · ' : ''}房间 ${state.roomCode ?? '…'}`
      + ` · ${state.players?.length ?? 1} 人（${names || '我'}） · ${state.ping}ms`;
    return;
  }
  // §114（§14.3 稿 10 要的第二种文案）：多人局断线只有 5 分钟，别只写一句「连接中…」——
  // 玩家要能一眼看出「我还有多久能回来」，而不是以为这局没了。
  el.textContent = net?.reconnectInfo?.().stopped
    ? '已断开连接'   // 主动关闭：产品路径上只有「转单人继续」（那时 net 已置空、徽标直接收起），这里是兜底
    : '重连中：5 分钟内可用同一身份回到原座';
}

/* ---------- 输入：点塔位建塔 / 点塔开面板（§1.9.1，不做拖拽放置） ---------- */

/** 防守模式的一次「点地」：点空工事位开工事轮盘，否则走过去。
 *  摇杆轻点也走这里——§10.1 的摇杆与点地移动共用同一条移动指令。 */
function defenseTap(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const cell = renderer.toGrid(clientX - rect.left, clientY - rect.top);
  const slot = match.def.fortSlots.findIndex((s, i) => gridDist(s, cell) <= 1
    && !match.forts.some((f) => f.slot === i));
  if (slot >= 0) {
    const s = match.def.fortSlots[slot];
    view.selectedFortSlot = slot;
    ui.openFortWheel(match, slot, renderer.toScreen(s.x, s.y), FORTS);
    return;
  }
  ui.closeWheel();
  const ok = net ? net.move(cell.x, cell.y) : orderMove(match, cell);
  if (!ok) ui.toast('走不过去');
}

// 防守模式的虚拟摇杆（§1.9.1 / §10.1 / §1.9.2 / §1.9.3）。TD 没有摇杆，所以 enabled 只认防守。
const stick = createJoystick({
  base: document.getElementById('stickBase'),
  knob: document.getElementById('stickKnob'),
  canvas,
  enabled: () => match.mode === 'defense' && !view.paused && !match.result && !view.inLobby,
  floating: () => settings.stick === 'floating',
  onTap: (x, y) => defenseTap(x, y),
});

let drag = null;   // 拖动平移中的上一个屏幕点（null = 没在拖）
let dragMoved = false;   // §171：这一下**真的拖动了**吗（「点空白处」也会武装 drag，不能拿它当判据）
/**
 * §171：§2.5 / §296 的镜头操作写的是「单指拖空白处平移、**双指缩放**、**双击回核心**」。
 * 以前只有第一条 + 桌面滚轮——那条注释甚至写着「滚轮缩放 = 桌面上的双指缩放」，可手机没有滚轮：
 * 真机上**既不能缩放、也不能一键回核心**（两条设计都实现不了）。这里把后两条补上：
 * - 第二根手指落下 → 取消这次选择（别把轮盘/塔面板留在屏幕上），进入双指缩放（以两指中点为锚点）；
 * - 「点空白处」轻点两下（300ms / 30px 内）→ 镜头回到核心（§2.5 的「双击回核心」）。
 * 防守模式是跟随相机（每帧被 setCamera 覆盖），所以两条都只对 TD 生效——和滚轮那条同一个判据。
 */
const pointers = new Map();   // pointerId → 当前按在画布上的点
let pinchDist = null;         // 上一帧的双指间距（null = 没在缩放）
let lastEmptyTap = null;      // 上一次「点空白处」的落点与时间
const canvasPoint = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
const pinchZoomOk = () => match.mode !== 'defense' && !view.paused && !match.result && !view.inLobby;
const backToCore = () => {
  if (match.mode === 'defense' || view.paused || match.result) return;
  const core = match.core?.cell ?? match.cores?.[0]?.cell;
  if (settings.tdFitAll && renderer.scale <= (settings.zoom ?? 1.5)) { renderer.fit(match.map.grid); return; }
  settings = { ...settings, tdFitAll: false }; saveSettings(settings);
  renderer.setCamera(core?.x ?? match.map.grid.w / 2, core?.y ?? match.map.grid.h / 2, settings.zoom);
};

canvas.addEventListener('pointerdown', (e) => {
  if (view.paused || match.result) return;
  pointers.set(e.pointerId, canvasPoint(e));
  dragMoved = false;
  if (pointers.size === 2 && pinchZoomOk()) {
    // 第二根手指：这次手势改成缩放，把第一根手指可能已经打开的选择收掉
    drag = null;
    ui.closeWheel(); ui.closeTower(); view.selectedSlot = null; view.selectedTower = null;
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const cell = renderer.toGrid(p.x, p.y);

  // 防守模式：点地面 = 走过去；点空工事位 = 开工事轮盘
  if (match.mode === 'defense') {
    if (stick.owns(e.pointerId)) return;   // 摇杆接管的这次手势：轻点会在松手时补回来
    defenseTap(e.clientX, e.clientY);
    return;
  }

  const g = match.map?.grid ?? { w: 32, h: 24 };
  if (cell.x < 0 || cell.y < 0 || cell.x >= g.w || cell.y >= g.h) return;

  // 取最近的塔位（§2.5：热区重叠时按距离判定，而不是「点在哪个格就是哪个格」）
  let best = -1, bestD = Infinity;
  match.map.slots.forEach((s, i) => {
    const d = gridDist(s, cell);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best < 0 || bestD > 2) {
    ui.closeWheel(); ui.closeTower(); view.selectedSlot = null;
    // §14.3 稿 4 要求「标出『点击取最近塔位』的判定规则（§2.5）」。
    // 默认档（整图可见）下点空地原本**什么都不发生**——玩家分不清「没响应」和「这儿没塔位」，
    // 于是这条提示同时干两件事：给反馈 + 把判定规则说给玩家听（toast 自带 1.6s 自动消失）
    if (settings.tdFitAll) ui.toast('这里没有塔位 · 点塔位建塔（按距离取最近的塔位）');
    // 空地上按下 = 拖动地图（§1.9 单指拖空白处平移）；只有放大到局部（整图可见=关）时才让它动
    if (!settings.tdFitAll) {
      drag = p;
      // 抓住指针（pointer capture）：手指滑到 HUD 上方时事件不该断（不然拖一半就停）
      // §171：`setPointerCapture` 对「已经不在了的 pointerId」会抛 NotFoundError（合成事件、设备异常），
      // 一次抛错会顺着 pointerdown 冒到全局——抓住失败就退化成普通拖动，别把这一下弄崩。
      try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 抓不住就算了，拖动照常 */ }
    }
    return;
  }

  const slotCell = match.map.slots[best];
  const screen = renderer.toScreen(slotCell.x, slotCell.y);
  view.selectedSlot = best;
  ui.closeTower();
  if (towerAtSlot(match, best)) {
    view.selectedTower = best;
    ui.closeWheel();
    ui.openTower(match, best, screen);
  } else {
    view.selectedTower = null;
    ui.openWheel(match, best, screen);
  }
});

// 拖动平移（松手即停）
canvas.addEventListener('pointermove', (e) => {
  // §171：两根手指 = 双指缩放（以两指中点为锚点，和滚轮同一个 renderer.zoomAt 出口）
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, canvasPoint(e));
  if (pointers.size >= 2 && pinchZoomOk()) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist && dist > 40) {
      if (settings.tdFitAll) { settings = { ...settings, tdFitAll: false }; saveSettings(settings); }
      const next = Math.min(2.2, Math.max(0.4, renderer.scale * (dist / pinchDist)));
      renderer.zoomAt(next, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    pinchDist = dist;
    drag = null;
    return;
  }
  if (!drag) return;
  const rect = canvas.getBoundingClientRect();
  const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  if (Math.hypot(p.x - drag.x, p.y - drag.y) > 4) dragMoved = true;
  renderer.panBy(p.x - drag.x, p.y - drag.y);
  drag = p;
});
for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, (e) => {
  const wasDrag = dragMoved;   // §171：只有**移动过**才算拖动（点一下空白处不该被当成拖动）
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchDist = null;
  drag = null;
  if (wasDrag) { dragMoved = false; return; }
  dragMoved = false;
  // §171「双击回核心」：两次「点空白处」在 300ms / 30px 内。用空白落点当判据，
  // 免得玩家双击塔位时既开轮盘又跳镜头（塔位那一下在 pointerdown 里已经处理过了）。
  if (ev !== 'pointerup' || match.mode === 'defense' || view.paused || match.result) return;
  const p = canvasPoint(e);
  const now = performance.now();
  const isDouble = lastEmptyTap && now - lastEmptyTap.t < 300
    && Math.hypot(p.x - lastEmptyTap.x, p.y - lastEmptyTap.y) < 30;
  if (isDouble) { lastEmptyTap = null; backToCore(); }
  else if (emptyTapAt(p)) lastEmptyTap = { t: now, x: p.x, y: p.y };
});
/** 这一下是不是「点空白处」（不在任何塔位的判定半径里）——双击回核心只认这种落点。 */
function emptyTapAt(p) {
  if (match.mode === 'defense') return false;
  const cell = renderer.toGrid(p.x, p.y);
  const g = match.map?.grid ?? { w: 32, h: 24 };
  if (cell.x < 0 || cell.y < 0 || cell.x >= g.w || cell.y >= g.h) return false;
  return !(match.map.slots ?? []).some((s) => gridDist(s, cell) <= 2);
}

// 滚轮缩放 = 桌面上的双指缩放（§2.5「双指放大到 1.0× 查看局部」）。
// 防守模式是跟随相机（每帧被 setCamera 覆盖），所以只对 TD 生效。
canvas.addEventListener('wheel', (e) => {
  if (match.mode === 'defense' || view.paused || match.result) return;
  e.preventDefault();
  if (settings.tdFitAll) { settings = { ...settings, tdFitAll: false }; saveSettings(settings); }
  const rect = canvas.getBoundingClientRect();
  const next = Math.min(2.2, Math.max(0.4, renderer.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  renderer.zoomAt(next, e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

window.addEventListener('resize', () => applyCamera());

// 小地图点一下 = 回城（§2.6），与按钮共用同一套冷却与服务端权威校验
document.getElementById('minimap').addEventListener('pointerdown', () => {
  if (match.mode !== 'defense' || view.paused || match.result) return;
  const ok = net ? net.teleport() : teleportHome(match);
  ui.toast(ok ? '已回城（小地图）' : '冷却中或阵亡中');
});

/* ---------- HUD 按钮 ---------- */

document.getElementById('btnEarly').onclick = () => {
  // §10.1：联机下必须走指令（服务端权威）——直接调内核只会改本地镜像，下一份快照又打回原样
  const ok = handlers.early();
  ui.toast(ok ? '提前开波：+3 木材' : '当前不能提前开波');
};
/**
 * §114：联机局**没有暂停，也没有本地加速**——权威在服务端。
 * 以前这两颗按钮在联机下照常改本地 `view`：暂停会弹一块写着「塔与波次都已冻结」的遮罩
 * （§1.8 的单人措辞），把整块屏幕也挡住 —— 玩家一边读着「已冻结」，一边看着核心被推掉；
 * 而 `view.rate` 唯一的读取方是本地 `update` 循环（联机下整段跳过），所以 2×/3× 只是标签变了。
 * §1.8/§10.3 对多人局的措辞是「挂机 60 秒不判负、**塔继续自动攻击**」，那就不该假装冻得住。
 */
const MP_NO_LOCAL = (what) => `多人局没有${what}：战斗由服务端继续（挂机不判负，塔照打）`;
function togglePause() {
  if (net) return ui.toast(MP_NO_LOCAL('暂停'));
  view.paused = !view.paused;
}
document.getElementById('btnSpeed').onclick = () => {
  if (net) return ui.toast(MP_NO_LOCAL('加速'));
  view.rate = view.rate === 1 ? 2 : view.rate === 2 ? 3 : 1;
};
document.getElementById('btnPause').onclick = () => togglePause();

window.addEventListener('keydown', (e) => {
  if (e.key === ' ') { togglePause(); e.preventDefault(); }   // 键盘与按钮同一条路（§106 的教训）
  if (e.key === 'b') document.getElementById('btnBag').click();
  if (e.key === 'n') document.getElementById('btnShop').click();
  if (e.key === 'e') document.getElementById('btnEarly').click();
  // 键盘也要走和按钮同一条路（`handlers` 里有联机分支）——直接调内核在联机下等于只改本地镜像
  if (e.key === '1') handlers.castSkill(0);
  if (e.key === '2') handlers.castSkill(1);
  if (e.key === '3') handlers.castSkill(2);
  if (e.key === 'r') { if (!handlers.revive()) ui.toast('现在不能复活（木材不够或没阵亡）'); }
});

/* ---------- 主循环 ---------- */

let last = performance.now();
let acc = 0;
let lastCamKey = '';
let lastEventCount = 0;
let lastQueued = false;   // §152：排队状态的上升/下降沿（徽标只在翻转时重画一次，不每帧写 DOM）
/** §2.6：「提前 30 秒预警」= 小地图闪烁（render.js）+ 提示音（这里）。只在预警**上升沿**响一次。 */
const cue = createCue({ enabled: () => settings.sfx !== false });
let lastWarning = false;

// §1.9.2「反馈：按下缩放 0.95 + 短震动」：缩放是 CSS（.btn:active），震动走这里。
// 用一条**委托**监听覆盖所有按钮（含建造轮盘里现建的、以后新加的），不必逐个接线。
const tap = createHaptics({ enabled: () => settings.sfx !== false });
document.addEventListener('pointerdown', (e) => {
  cue.warm();   // §178：音频只能在**用户手势里**解锁（真机上第一次预警才响得出来）
  if (e.target instanceof Element && e.target.closest('button')) tap('light');
}, { passive: true });

let stickGoal = null;   // 上一次发给服务端/内核的摇杆目标格（只在换格时才重发，别每帧刷指令）

function frameBody(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  // 换图/换模式（4★ 大图与防守图尺寸不同）时重算相机，别让上一局的视角留在新图上
  const camKey = `${match.map?.grid?.w ?? 0}x${match.map?.grid?.h ?? 0}`;
  if (camKey !== lastCamKey) { lastCamKey = camKey; applyCamera(); }
  // §152：排队状态在**没有状态事件**的情况下也会变（服务端开打 → 第一份快照把 time 推上去），
  // 所以徽标不能只靠 onStatus 重画——这里补一个上升/下降沿（只在翻转那帧写一次 DOM）。
  // 注意 `view.net` 也要判：离房那一下 `view.net` 会被置成 null，而 `net` 还在
  // （第一版只判了 `net`，于是那几帧里 `renderNetBadge(undefined)` → 帧循环里
  //  `Cannot read properties of undefined (reading 'players')`，冒烟的「零未捕获异常」当场抓到）。
  if (net && view.net && inQueue() !== lastQueued) { lastQueued = inQueue(); renderNetBadge(view.net); }
  // §131：防守「守住 4 轮 → 转无尽」（§12.5）后还要继续跑模拟——只看 `match.result` 会让
  // 单机局在通关那一刻**停表**，无尽阶段根本跑不起来（联机那边服务端会继续跑，但玩家的界面同样被面板挡住）。
  const canPlayOn = !match.result || !!match.assault?.endless;
  // §184：**大厅里不跑模拟**。以前只判 `view.paused`，而「点回大厅」那条路会顺手 `view.paused = true`、
  // 首次进页面这条初始化路径**没有**——于是停在大厅（还没点开局）时那一局已经在后台打：3 秒里对局
  // 时间走 3 秒、第 1 波真的会出怪、漏怪会判负并**记进档案**（实测 `clears: {map_01: {clears:1, wins:0}}`
  // + 声望 30），而玩家看到的只是一块大厅——连结算面板都不出现（`showOverlay` 在大厅下不弹）。
  if (!net && !view.paused && !view.inLobby && canPlayOn) {
    acc += dt * view.rate;
    const step = TICK_STEP;
    let guard = 0;
    while (acc >= step && guard < 40) {
      if (match.mode === 'defense') updateDefense(match, step); else update(match, step);
      acc -= step;
      guard += 1;
    }
    maybeAutosave(dt);
  }
  // §10.1：摇杆推着走 = 每帧重发**同一条**移动指令（目标格随人物前滑，于是是连续移动）。
  // 只在换格时重发，免得每帧都发一条网络指令 / 重算一次 A*。
  if (stick.dir.mag > 0 && !view.paused && !match.result && match.mode === 'defense') {
    const goal = steerGoal(match, stick.dir);
    if (goal && (!stickGoal || goal.x !== stickGoal.x || goal.y !== stickGoal.y)) {
      stickGoal = goal;
      if (net) net.move(goal.x, goal.y); else orderMove(match, goal);
    }
  } else if (stick.dir.mag === 0) stickGoal = null;
  // 伤害飘字：单机与联机都靠「两帧血量差」，不用各自的伤害事件（联机也没下发伤害事件）
  const monsters = match.monsters.map((x) => ({ uid: x.uid, hp: x.hp, cell: x.cell }));
  // §2.6 回防预警的提示音：进入预警那一刻响一次（小地图那圈橙边由 render.js 画）
  const warning = match.mode === 'defense' && !!match.assault?.warning;
  if (warning && !lastWarning) cue('warning');
  lastWarning = warning;
  if (lastMonsters.length || monsters.length) {
    for (const f of damageFloaters(lastMonsters, monsters)) {
      view.floaters.push({ ...f, until: now / 1000 + 0.6 });
    }
  }
  lastMonsters = monsters;
  const floatNow = now / 1000;
  view.floaters = view.floaters.filter((f) => f.until > floatNow).slice(-24);
  if (net && pendingTowers.length) pendingTowers = reconcilePending(pendingTowers, match.towers, now);
  renderer.draw({
    m: match, selectedSlot: view.selectedSlot, selectedTower: view.selectedTower,
    floaters: view.render?.showFloaters === false ? [] : view.floaters,
    pending: pendingTowers, localSlot: view.localSlot, now: floatNow,
    hintSlots: tutorial?.hintSlotCount?.() ?? 0,
    pulses: view.render?.showPulses !== false,   // §116：低特效档连引导塔位的脉冲一起关（设置面板是这么写的）
    selectedFortSlot: view.selectedFortSlot,
    scale: match.mode === 'defense' ? (view.render?.defenseScale ?? 1.5) : undefined,
  });
  // 小地图只在防守模式出现（跟随相机下它是唯一的全局视图）
  // 注意 `!view.inLobby` 在联机入口下是 undefined（联机不走大厅那套），
  // classList.toggle 的 force 参数收到 undefined 会退化成「每帧翻转」——必须显式转成布尔
  const showMini = match.mode === 'defense' && !view.inLobby;
  document.getElementById('minimapBox').classList.toggle('hidden', !showMini);
  if (showMini) minimap.draw(match);
  // §1.9.1：TD 没有摇杆，只有防守有（同一个条件，别写第二遍）
  document.getElementById('stickBase').classList.toggle('hidden', !showMini);
  // §14.3 稿 4：右侧日志面板在防守模式下要让位（样式表里 `#stage.defense .hud-right` 说了算）。
  // 每帧 toggle 一个类名是幂等的——不会像以前那样把 hidden 永久留在元素上
  stage.classList.toggle('defense', match.mode === 'defense');
  // §183：写不进存储这件事只在第一次说一次（初始化期 `ui` 还没建好，所以拖到这里统一弹）
  if (saveBlocked) { saveBlocked = false; saveTold = true; ui.toast('本机存不了档（隐私模式或存储被禁用）：这一局的进度不会保留'); }
  // §3.1 #29：深链进锁着的图 → 已经按档案换成了能玩的图，这件事必须说出来（否则玩家以为自己在玩 map_06）
  if (lockNotice) { ui.toast(lockNotice); lockNotice = null; }
  ui.render(match, view);
  ui.showOverlay(match, view);
  // 调试：把状态塞进标题，便于无头检查（--dump-dom 能读到）
  if (params.has('debug')) {
    if (match.mode === 'defense') {
      const d = describeDefense(match);
      document.title = `FF-DEF ${d.time}s 第${d.round}轮 gold${d.gold} castle${d.castle} lv${d.heroLevel}`
        + ` 怪${d.monsters} 掉落${d.drops} result${d.result ?? '-'}`;
    } else {
      const d = describe(match);
      document.title = `FF ${d.time}s w${d.wave} gold${d.gold} towers${d.towers} core${d.core} lv${d.heroLevel}`
        + ` | rep${profile.reputation} cmd${profile.commanderLevel} result${d.result ?? '-'}`;
    }
  }
  maybeRecordResult();
  // 引导：喂「开波 / 清波」两个事件，并在完成时把验收数据打出来
  if (tutorial) {
    if (match.wave.index !== lastWaveSeen) {
      const cleared = lastWaveSeen;
      lastWaveSeen = match.wave.index;
      if (match.wave.index > 0) tutorial.onWaveStarted(match.wave.index, match.time);
      if (cleared > 0) tutorial.onWaveCleared(cleared, match.time);
      // §153：收尾只看 `tutorial.done`——「档案里已经记过」不是「这一段不用跑」的理由
      // （原来还挂了 `&& !profile.tutorialDone`：在那个中间版本里它让重看的玩家收尾整段不执行），
      // 收尾由 `markTutorialDone` 唯一负责，`tutorial = null` 保证这段只跑一次。
      if (tutorial.done) {
        profile = markTutorialDone(profile);
        saveProfile(profile);
        const s = tutorial.summary();
        const verdict = tutorialPasses(s);
        ui.toast(`引导完成：建塔 ${s.secondsToFirstTower}s · 首波 ${s.secondsToWaveCleared}s`
          + `（目标 ≤90 / ≤180，${verdict.firstTowerOk && verdict.firstWaveOk ? '达标' : '超标'}）`);
        tutorial = null; view.tutorial = null;
      }
    }
  }
  // 把最近的事件弹成 toast
  // §184：大厅里**不弹**战斗事件——那一局玩家还没开始打（防守局建局时就写一条「出城打野…」的日志，
  // 于是它以前会直接弹在大厅上）。顺手把计数对齐，出大厅时不会补弹一堆旧事件。
  if (view.inLobby) lastEventCount = match.events.length;
  else if (match.events.length !== lastEventCount) {
    const lastEvent = match.events[match.events.length - 1];
    if (lastEvent && match.time - lastEvent.t < 0.4) ui.toast(lastEvent.text);
    lastEventCount = match.events.length;
  }
}

/**
 * 一帧里抛异常不该弄死整局。
 * 之前 frame() 是「画完这一帧再 requestAnimationFrame」，中间任何一处抛异常（例如某处查表没兜底）
 * 都会让下一帧永远排不上——玩家的游戏就冻在那一帧上（§38 的 `MAPS['def_01']`、§44 的脏装备
 * 都是这么死的，而且后面几步会跟着一起坏）。这里包一层：照常报到控制台（冒烟把它当失败抓出来），
 * 但把循环保住——坏掉的最多只是那一帧。
 */
const frameErrors = new Set();
function frame(now) {
  try {
    frameBody(now);
  } catch (err) {
    const key = String((err && err.message) ?? err);
    if (!frameErrors.has(key)) {
      frameErrors.add(key);
      console.error('[frame] ' + key);
    }
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// 调试出口：__frostfall.describe() 可直接在控制台看结算数据
window.__frostfall = {
  get match() { return match; }, describe: () => describe(match), view, renderer, TOWERS, MAPS, heroStats,
  get net() { return net; },   // 调试/冒烟用：看联机状态、也能手动断线
  simulateMemoryWarning: () => degradeOnMemoryWarning('simulated'),   // §10.7：冒烟用它验「告警 → 自动降级」
  cue,   // §2.6：提示音（cue.log 记了每次「响了什么」，headless 里也能验）
  tap,   // §1.9.2：短震动（tap.log 记了每次「震没震、为什么没震」，同上）
  stick,   // §1.9.1：防守的虚拟摇杆（stick.state() / stick.dir / stick.owns 给冒烟验）
  ui,      // 调试/冒烟用：能直接开面板（塔面板的可见性检查不必先「点得到」那座塔）
  renderNetBadge,   // 调试/冒烟用：断线的两种文案不必去抢那 300ms 的重连窗口，直接喂状态即可
};
