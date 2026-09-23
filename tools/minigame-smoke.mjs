// 小游戏包的本地验收：**没有微信开发者工具时能验的那一半**。
//
// 它验三件事：
//   ① 打包产物能加载：在假 `wx` 下 require(dist/minigame/game.js)，入口自检认得出小游戏环境、存储往返成功；
//   ② **打包没打包坏**：同一局（同种子同秒数）用 bundle 跑与用 ESM 源码跑，`describe()` 逐字段相同；
//   ③ 主包里不许出现 DOM：`document.` / `window.` 一次都不许有——界面那层（ui.js/main.js 的 DOM 部分）
//      在小游戏里跑不了，它属于第 3 步（Canvas 重画），**绝不能悄悄混进主包**。
//
// 用法：npm run minigame        （先 build 再 smoke）
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installFakeWx } from './fake-wx.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUNDLE = `${ROOT}dist/minigame/game.js`;
const fails = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(label);
};

const fake = installFakeWx({ onVibrate: () => {} });
try {
  // ① 加载产物（假 wx 必须在 require 之前装好：入口在模块加载时就会自检）
  const require = createRequire(import.meta.url);
  const entry = require(BUNDLE);
  const api = globalThis.__frostfallMiniGame ?? entry;
  const info = api.selfCheck();
  check(info.miniGame === true && info.storage === true,
    '假 wx 下入口认出小游戏环境、存储往返成功',
    JSON.stringify(info));

  // ② 等价性：bundle 的内核 === ESM 源码的内核
  const { createMatch, describe, update } = await import('../src/match.js');
  const { TICK_STEP } = await import('../src/data.js');
  const m = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 7, players: 4 });
  for (let i = 0; i < Math.round(120 / TICK_STEP); i += 1) update(m, TICK_STEP);
  const esm = describe(m);
  const bundled = api.bootSession({ mode: 'td', mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seconds: 120, seed: 7, players: 4 });
  const same = JSON.stringify(esm) === JSON.stringify(bundled);
  check(same, '打包后的内核与源码逐字段一致（120 秒 / 种子 7）',
    same ? `时间 ${bundled.time.toFixed(1)}s · 波次 ${bundled.wave} · 结果 ${bundled.result ?? '进行中'}` : `源码 ${JSON.stringify(esm).slice(0, 90)} vs 包 ${JSON.stringify(bundled).slice(0, 90)}`);

  /**
   * ③ 主包里不许混进界面那层。两种查法互补：
   *   ① 看**模块清单**——`ui.js` / `main.js` / `render.js` / `hud-model.js` 这些是 DOM+CSS 的界面，
   *      它们进主包就说明「哪条 import 链把界面拖进来了」（这是移植第 3 步之前最该守住的一条线）；
   *   ② 看**是不是出现了只有界面才会用的 DOM 调用**。
   *   （`g.document.addEventListener` 这种**特性探测**是允许的——那正是 platform.js 的浏览器分支，
   *   我们靠它一份代码跑两个环境；所以这里查的是 `getElementById` 这类不会有别的用法的调用。）
   */
  const text = await readFile(BUNDLE, 'utf8');
  const mods = [...text.matchAll(/__def\("([^"]+)"/g)].map((m) => m[1]);
  // `render.js` / `hud-model.js` **允许**进主包：它们是纯 Canvas 与纯逻辑（大厅缩略图就复用 render.js）。
  // 真正进不去的是 DOM 那一层：`ui.js`（getElementById 全套）与 `main.js`（整页启动流程）。
  const uiMods = mods.filter((id) => /(^|\/)(ui|main|joystick|tutorial)\.js$/.test(id));
  check(uiMods.length === 0, '主包里没有 DOM 界面模块（ui/main/joystick/tutorial）',
    uiMods.length ? `混进了 ${uiMods.join('、')}` : `装了 ${mods.length} 个模块：${mods.map((m) => m.replace('src/', '')).join('、')}`);
  const domCalls = ['getElementById', 'querySelector', 'createElement', 'innerHTML', 'classList'].filter((k) => text.includes(k));
  check(domCalls.length === 0, '主包里没有界面专用的 DOM 调用', domCalls.length ? `命中 ${domCalls.join('/')}` : `${(text.length / 1024).toFixed(0)} KB`);

  // ④ 大厅那一屏（移植第 3 步）：真的画出来了、点得动
  const lobby = globalThis.__frostfallLobby;
  const drawn = lobby?.canvas?.record ?? { calls: [], texts: [] };
  const drewLobby = drawn.calls.length > 300 && drawn.texts.includes('冰封之地') && drawn.texts.some((t) => t.startsWith('霜原哨站'));
  check(!!lobby && drewLobby, '大厅一屏真的画出来了（标题 + 地图卡都在这一帧里）',
    `ctx 调用 ${drawn.calls.length} 次 · 文字 ${drawn.texts.length} 条`);

  const L = lobby.layout();
  const defBtn = L.byId['mode-def'];
  fake.fireTouch(defBtn.x + defBtn.w / 2, defBtn.y + defBtn.h / 2);   // 点「防守生存」
  const afterTap = lobby.getModel();
  check(afterTap.mode === 'defense' && afterTap.map === 'def_01',
    '全局触摸能选中（点「防守生存」→ 模式切了、地图落回已解锁的 def_01）',
    `模式 ${afterTap.mode} · 地图 ${afterTap.map} · 可玩 ${afterTap.unlockedCount} 张`);

  // ⑤ 点「单人开局」真的进局（战场那屏接上了）
  // 注意先切回 TD：上一格把模式切成了防守，而防守战场还没搬（大厅会明写「还没接过来」）
  const tdBtn = lobby.layout().byId['mode-td'];
  lobby.tap(tdBtn.x + tdBtn.w / 2, tdBtn.y + tdBtn.h / 2);
  const L2 = lobby.layout();
  const startBtn = L2.byId.start;
  lobby.tap(startBtn.x + startBtn.w / 2, startBtn.y + startBtn.h / 2);
  const inBattle = lobby.screen() === 'battle';
  lobby.tick(90);
  lobby.drawFrame();   // 手动 tick 之后要自己画一帧，HUD 才会落在这份记录里
  const battleMatch = lobby.match();
  check(inBattle && battleMatch.wave.index >= 2 && lobby.canvas.record.texts.some((t) => /金 \d+/.test(t)),
    '大厅点「单人开局」进局，跑 90 秒后波次推进且战场 HUD 画在这一帧里',
    `${lobby.screen()} · 第 ${battleMatch.wave.index} 波 · 击杀 ${battleMatch.stats.kills} · 核心 ${Math.round(battleMatch.core.hp)}`);
} finally {
  fake.uninstall();
}

console.log(fails.length ? `\n❌ ${fails.length} 项没过：${fails.join('、')}` : '\n✅ 小游戏包本地验收全过（能验的那一半；真机/开发者工具仍要你那边过一遍）');
process.exit(fails.length ? 1 : 0);
