// 微信小游戏入口（移植第 2 步：整包能装起来、内核能在 wx 环境里跑）。
//
// **这一步还不能玩**：小游戏没有 DOM，而我们的界面（大厅 / HUD / 结算 / 商店…）现在是
// `index.html` + `styles.css` + `ui.js` 那套 DOM+CSS。这一步做的是把**平台差异**与**打包**解决掉，
// 并把不依赖 DOM 的那一大半（内核、数据表、存档、联机协议、平台适配）先在小游戏里跑通。
// 界面换 Canvas 是第 3 步，见 docs/minigame-port.md。
import { TICK_STEP } from '../data.js';
import { DEFENSE_MAPS, MAPS } from '../data.js';
import { createMatch, describe as describeMatch, update } from '../match.js';
import { createDefenseMatch, describeDefense, updateDefense } from '../defense.js';
import { isMiniGame, onTouch, storage, viewport } from '../platform.js';
import { loadProfile, mapLocked, unlockedMaps } from '../profile.js';
import { applyLobbyAction, drawLobby, hitTestLobby, layoutLobby } from './lobby.js';

export const version = '0.1.0';

/**
 * 大厅的模型（第 3 步的第一屏）：模式 / 难度 / 时长 / 英雄 / 地图 + 档案（解锁与战绩）。
 * `canStart` 现在是 **false** —— 战斗渲染还没接到这块 canvas 上（第 4 步），
 * 大厅里那颗按钮会写明这件事，而不是给你一个点了没反应的假按钮。
 */
export function createLobbyModel(profile = loadProfile()) {
  const unlockedTd = unlockedMaps(profile, 'td');
  const unlockedDef = unlockedMaps(profile, 'defense');
  const locked = {};
  for (const id of [...Object.keys(MAPS), ...Object.keys(DEFENSE_MAPS)]) {
    const lock = mapLocked(profile, id);
    if (lock) locked[id] = lock.text;
  }
  const mode = 'td';
  const pool = mode === 'defense' ? unlockedDef : unlockedTd;
  return {
    mode,
    map: pool[0] ?? 'map_01',
    difficulty: 'normal',
    length: 'short',
    hero: 'hero_warrior',
    profile,
    unlocked: [...unlockedTd, ...unlockedDef],
    locked,
    lockedReason: locked,
    unlockedCount: new Set([...unlockedTd, ...unlockedDef]).size,
    canStart: false,
    hint: null,
  };
}

/** 点一下 → 新模型（纯函数；解锁校验也在这里） */
export const stepLobby = (model, tap) =>
  applyLobbyAction(model, tap, { unlocked: model.unlocked ?? [], lockedReason: model.lockedReason ?? {} });

/**
 * 起大厅（小游戏里真跑）：创建主 canvas、接全局触摸、按帧重画。
 * 小游戏里 `wx.createCanvas()` 的**第一次调用**拿到的就是上屏 canvas。
 */
export function startLobby({ requestAnimationFrame: raf = globalThis.requestAnimationFrame } = {}) {
  if (!isMiniGame()) return null;
  const wx = globalThis.wx;
  const canvas = wx.createCanvas();
  const ctx = canvas.getContext('2d');
  // 小游戏里 `requestAnimationFrame` 挂在 canvas 上（新基础库也有全局）；Node/预览页两者都没有，
  // 那就**只画一帧**——本地验收要验的是「这一屏画得出来、点得动」，不需要真跑循环。
  const rafFn = raf ?? canvas.requestAnimationFrame?.bind(canvas) ?? null;
  let model = createLobbyModel();
  let layout = null;
  let lastSize = '';

  const resize = () => {
    const { width, height, dpr } = viewport();
    const pw = Math.floor(width * dpr), ph = Math.floor(height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 之后一律按逻辑像素画
    layout = layoutLobby(width, height, model);
    lastSize = `${width}x${height}`;
  };
  resize();

  onTouch((t) => {
    if (t.type !== 'down') return;     // 第 3 步只需要「点」；拖动/缩放留给第 4 步的战场
    const action = hitTestLobby(layout, t.x, t.y);
    const next = stepLobby(model, action);
    if (next !== model) model = next;
    if (action) drawLobby(ctx, model, layout);   // 立刻重画一帧，不等下一帧
  });

  const frame = () => {
    const { width, height } = viewport();
    if (`${width}x${height}` !== lastSize) resize();
    drawLobby(ctx, model, layout);
    if (rafFn) rafFn(frame);
  };
  if (rafFn) rafFn(frame); else frame();
  const handle = { canvas, getModel: () => model, layout: () => layout, frame };
  // 调试/本地验收用：小游戏里也能从控制台摸到这一屏的状态（`__frostfallLobby.getModel()`）
  globalThis.__frostfallLobby = handle;
  return handle;
}

/**
 * 无头跑一局内核（联机/自检/第 3 步的渲染循环都会用同一条路）。
 * 返回 `describe()` 的结果，所以本地可以拿它和浏览器/Node 的同一局逐字段对比——
 * 这是「打包没打包坏」最直接的证据（见 tests/minigame-bundle.test.js）。
 */
export function bootSession({ mode = 'td', seconds = 0, seed = 7, mapId, difficulty, heroId, players = 1 } = {}) {
  const m = mode === 'defense'
    ? createDefenseMatch({ mapId: mapId ?? 'def_01', difficulty, heroId, seed })
    : createMatch({ mapId: mapId ?? 'map_01', difficulty, heroId, seed, players });
  const step = mode === 'defense' ? updateDefense : update;
  for (let i = 0; i < Math.round(seconds / TICK_STEP); i += 1) step(m, TICK_STEP);
  return mode === 'defense' ? describeDefense(m) : describeMatch(m);
}

/**
 * 环境自检：小游戏里最先跑的就是它。**只读 + 一次存储往返**，不做重活——
 * 真机上的第一帧不该被自检拖慢。
 */
export function selfCheck() {
  const info = { miniGame: isMiniGame(), view: viewport(), storage: false };
  try {
    storage.set('frostfall:selftest', 'ok');
    info.storage = storage.get('frostfall:selftest') === 'ok';
    storage.remove('frostfall:selftest');
  } catch { info.storage = false; }
  return info;
}

if (isMiniGame()) {
  const info = selfCheck();
  console.log('[frostfall] 小游戏入口已加载', JSON.stringify(info));
  // 第 3 步的大厅一屏：Canvas 绘制 + 全局触摸（战斗渲染是第 4 步）
  startLobby();
}
