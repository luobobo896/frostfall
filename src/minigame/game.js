// 微信小游戏入口（移植第 2 步：整包能装起来、内核能在 wx 环境里跑）。
//
// **这一步还不能玩**：小游戏没有 DOM，而我们的界面（大厅 / HUD / 结算 / 商店…）现在是
// `index.html` + `styles.css` + `ui.js` 那套 DOM+CSS。这一步做的是把**平台差异**与**打包**解决掉，
// 并把不依赖 DOM 的那一大半（内核、数据表、存档、联机协议、平台适配）先在小游戏里跑通。
// 界面换 Canvas 是第 3 步，见 docs/minigame-port.md。
import { TICK_STEP } from '../data.js';
import { createMatch, describe as describeMatch, update } from '../match.js';
import { createDefenseMatch, describeDefense, updateDefense } from '../defense.js';
import { isMiniGame, storage, viewport } from '../platform.js';

export const version = '0.1.0';

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
  // 第 3 步：在这里创建主 canvas（wx.createCanvas()）、起渲染循环、接 wx.onTouchStart。
}
