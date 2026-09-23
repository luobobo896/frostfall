// 微信小游戏入口（移植第 2 步：整包能装起来、内核能在 wx 环境里跑）。
//
// **这一步还不能玩**：小游戏没有 DOM，而我们的界面（大厅 / HUD / 结算 / 商店…）现在是
// `index.html` + `styles.css` + `ui.js` 那套 DOM+CSS。这一步做的是把**平台差异**与**打包**解决掉，
// 并把不依赖 DOM 的那一大半（内核、数据表、存档、联机协议、平台适配）先在小游戏里跑通。
// 界面换 Canvas 是第 3 步，见 docs/minigame-port.md。
import {
  DEFENSE_MAPS, FORTS, MAPS, SHOP_ITEMS, TICK_STEP, TOWERS, WAVES, normalizeChoice,
} from '../data.js';
import {
  buildTower, buyItem, castSkill, craftEquipment, createMatch, describe as describeMatch, equipItem,
  enhanceItem, potionCount, repairTower, reviveNow, sellItem, sellTower, setPriority, skillLevel,
  startWaveEarly, towerAtSlot, update, upgradeTower, usePotion,
} from '../match.js';
import {
  isMiniGame, keepScreenOn, onHide, onMemoryWarning, onShow, onTouch, storage, viewport,
} from '../platform.js';
import { clearSave, hasSave, loadFromStorage, saveToStorage } from '../save.js';
import {
  clearProfile, isFirstRun, loadProfile, mapLocked, markTutorialDone, recordResult, reviveMulOf, saveProfile,
  startGoldOf, unlockedMaps,
} from '../profile.js';
import { resultSummary } from '../result.js';
// 新手引导：**状态机与浏览器版是同一份**（`src/tutorial.js` 里没有 DOM），只有那条提示条是 Canvas 重画的
import { createTutorial, tutorialPasses } from '../tutorial.js';
import { gridDist } from '../core.js';
import { loadSettings, saveSettings } from '../settings.js';
import { createHaptics } from '../feedback.js';
import { createCue } from '../audio.js';
import { createMinimap, createRenderer } from '../render.js';
import { wavePreview } from '../hud-model.js';
import {
  buildFort, createDefenseMatch, describeDefense, orderMove, repairCastle, steerGoal, teleportHome, updateDefense,
} from '../defense.js';
import {
  MINIMAP, drawDefenseHud, hitTestDefense, inStickZone, layoutDefense, layoutFortSheet, stickBase, stickVector,
} from './defense-screen.js';
import { applyLobbyAction, drawLobby, hitTestLobby, layoutLobby } from './lobby.js';
import {
  DESIGN, PRIORITY_LABEL, drawBattleHud, drawResult, drawSheet, hitTestBattle, hitTestSheet,
  layoutBattle, layoutResult, layoutSheet, skillKeys,
} from './battle.js';

export const version = '0.1.0';

/**
 * 大厅的模型（第 3 步的第一屏）：模式 / 难度 / 时长 / 英雄 / 地图 + 档案（解锁与战绩）。
 * `canStart` 现在**打开**了：战场已经接上（点塔位建塔 / 开波 / 技能 / 回大厅），
 * 也就是大厅那颗「单人开局」是真能进局的。
 */
export function createLobbyModel(profile = loadProfile()) {
  const unlockedTd = unlockedMaps(profile, 'td');
  const unlockedDef = unlockedMaps(profile, 'defense');
  const locked = {};
  for (const id of [...Object.keys(MAPS), ...Object.keys(DEFENSE_MAPS)]) {
    const lock = mapLocked(profile, id);
    if (lock) locked[id] = lock.text;
  }
  /**
   * §2.1「上次配置一键开局」：档案里存着上一局用过的模式 / 地图 / 难度 / 英雄 / 时长，就照它选。
   * 过一遍 `normalizeChoice`（`data.js` 那一份归一化）——跨版本的脏值不许把大厅带崩（§177 的同一道边界）。
   * 上次那张图要**这会儿还解锁着**才用：档案被重置过、或者版本换了锁法时落回该模式的第一张。
   */
  const last = normalizeChoice(profile.lastChoice ?? {});
  const mode = last.mode;
  const pool = mode === 'defense' ? unlockedDef : unlockedTd;
  return {
    mode,
    map: pool.includes(last.map) ? last.map : (pool[0] ?? (mode === 'defense' ? 'def_01' : 'map_01')),
    difficulty: last.difficulty,
    length: last.length,
    hero: last.hero,
    profile,
    unlocked: [...unlockedTd, ...unlockedDef],
    locked,
    lockedReason: locked,
    unlockedCount: new Set([...unlockedTd, ...unlockedDef]).size,
    canStart: true,
    // §10.3「随时能停」：有存档就多给一个「继续上局」入口（浏览器版 576 行那条同源）
    canContinue: hasSave(),
    continueLabel: '继续上局',
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
/**
 * 起小游戏：大厅 ⇄ 战场两个屏，共用一个 canvas 与一条触摸通道。
 *
 * 这是「先接战场」那一步：大厅的「单人开局」现在真的能进局——战场用现成的 `render.js` 画
 * （它本来就是纯 Canvas），外面这一圈 HUD 由 `battle.js` 用 Canvas 重画。
 * 交互是**简化版**：点塔位建塔/升级、点「开波」提前开波、点技能键放技能、点「回大厅」退回去；
 * 浏览器版那一套轮盘/塔面板（出售、优先级、看数值）还没搬（见 docs/minigame-port.md §5.2）。
 */
export function startMinigame({ requestAnimationFrame: raf = globalThis.requestAnimationFrame } = {}) {
  if (!isMiniGame()) return null;
  const wx = globalThis.wx;
  const canvas = wx.createCanvas();
  const ctx = canvas.getContext('2d');
  // 小游戏里 `requestAnimationFrame` 挂在 canvas 上（新基础库也有全局）；Node/预览页两者都没有，
  // 那就**只画一帧**——本地验收要验的是「画得出来、点得动」，不需要真跑循环（`tick()` 可以手动推进）。
  const rafFn = raf ?? canvas.requestAnimationFrame?.bind(canvas) ?? null;

  let size = { width: 0, height: 0, dpr: 1 };
  let lobby = { model: createLobbyModel(), layout: null };
  let battle = null;
  let lastSize = '';
  let settings = loadSettings();
  // §1.9.2 的短震动：小游戏这次真的接上了（浏览器版靠 DOM 点击事件，这边按 touch 手动触发）
  const tap = createHaptics({ enabled: () => settings.sfx !== false });
  /**
   * §2.6 的回防预警提示音：`audio.js` 那一层本来就只认平台适配层（浏览器 `new AudioContext()`、
   * 小游戏 `wx.createWebAudioContext()`），所以这边**一份代码照用**——小游戏以前一个音都不放。
   * 同一个 `settings.sfx` 开关管着它和震动（浏览器版那颗开关的标签就是「音效/震动」）。
   */
  const cue = createCue({ enabled: () => settings.sfx !== false });
  /**
   * 玩的时候别让屏幕自己熄掉：一局 TD 十几分钟，盯塔的时候可能一直不碰屏幕，
   * 系统按默认超时锁屏比任何 bug 都劝退（小游戏里是 `wx.setKeepScreenOn`）。
   */
  keepScreenOn(true);
  // 官方文档：`setKeepScreenOn` 只在当前小程序生效、离开就失效——切出去接个电话回来要再申请一次
  onShow(() => keepScreenOn(true));
  /**
   * §10.7 的内存告警：微信在内存吃紧时抛 `wx.onMemoryWarning`，接了才有机会主动降级——
   * 与浏览器版**同一套设置**（`settings.effects = 'low'`：关掉脉冲那类装饰，保住帧率），
   * 并且提示一句，别让玩家以为画面坏了。
   */
  onMemoryWarning(() => {
    const before = settings.effects;
    settings = { ...settings, effects: 'low' };
    try { saveSettings(settings); } catch { /* 存不了就只在这一次生效 */ }
    if (before !== 'low' && battle) note(battle, '内存告警：已切到低特效（可在暂停面板里改回）', 3);
  });

  /** 镜头设置（§2.5）：整图可见 = `renderer.fit()`；放大 = 以核心为中心用 `settings.zoom` */
  const applyCamera = (b) => {
    // 防守局的 `grid` 是状态自己的字段（`m.map` 只有 TD 有）——两处都要兜住
    const grid = b?.m?.map?.grid ?? b?.m?.grid;
    if (!grid) return;
    if (settings.tdFitAll === false) {
      const core = b.m.core?.cell ?? { x: grid.w / 2, y: grid.h / 2 };
      b.renderer.setCamera(core.x, core.y, settings.zoom ?? 1.5);
    } else {
      b.renderer.fit(grid);
    }
  };

  const resize = () => {
    size = viewport();
    const pw = Math.floor(size.width * size.dpr), ph = Math.floor(size.height * size.dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);   // 之后一律按逻辑像素画
    lobby.layout = layoutLobby(size.width, size.height, lobby.model);
    if (battle) battle.layout = layoutBattle(battle.model());
    lastSize = `${size.width}x${size.height}`;
  };
  resize();

  /**
   * 视口门槛（STATUS §3.1 #33 拍板的最小支持视口 = 667×375，浏览器侧是同两条 `@media`）。
   * 小游戏端虽然能在后台锁横屏，但开发者工具与部分机型仍会给出竖屏尺寸——**画一堆挤在一起的面板
   * 比直接说清楚更糟**，所以和浏览器版一样：竖屏一句「请横屏」、太小一句「屏幕太小」，期间不接任何触摸。
   */
  const viewportNotice = () => {
    if (size.height > size.width) return '请横屏玩：本作是横屏游戏（手机转一下）';
    if (size.width < 640 || size.height < 359) return '屏幕太小：本作按 667×375 pt 以上设计（iPhone SE 2 代及以上）';
    return null;
  };

  /** 那条说明（按宽度折行——竖屏时一句话比屏幕还宽，不折就画到屏幕外面去了） */
  const drawNotice = (text) => {
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.fillStyle = '#05080e';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.font = '16px "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif';
    ctx.fillStyle = '#e8eef7';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const maxW = size.width - 48;
    const lines = [];
    let cur = '';
    for (const ch of text) {
      if (cur && ctx.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; } else cur += ch;
    }
    if (cur) lines.push(cur);
    lines.forEach((line, i) => ctx.fillText(line, size.width / 2, size.height / 2 + (i - (lines.length - 1) / 2) * 24));
  };

  /**
   * 战场 HUD 是**设计单位**（667×375）画的，屏幕更大时把它居中（只平移不缩放：
   * 缩放会把 §1.9.2 那批 44pt 热区一起改小）。
   */
  const hudOffset = () => ({
    x: Math.max(0, (size.width - DESIGN.w) / 2),
    y: Math.max(0, (size.height - DESIGN.h) / 2),
  });

  /**
   * 下一波预告那一行（§8.3 / §6.2）：文案取浏览器版那份 `wavePreview`（一份两处用），
   * 只在设置里关掉时说「已在设置里关闭」——不是把这一行悄悄藏起来，
   * 玩家得能分清「我关了」和「这波没有预告」。
   */
  const nextWaveHint = (m) => {
    if (settings.showWavePreview === false) return '下一波：（已在设置里关闭）';
    const p = wavePreview(m.wave.index + 1, 3, m.waves);
    if (!p) return '下一波：—';
    return `下一波：${p.tag ? `【${p.tag}】` : ''}${p.text}`;
  };

  /** 进局：按大厅里选的那套配置开一局（联机/多人缩放先按单人；多人是后面的事） */
  const startMatch = () => {
    const seed = Date.now() % 1e6 || 7;
    const m = lobby.model.mode === 'defense'
      ? createDefenseMatch({
        mapId: lobby.model.map.startsWith('def_') ? lobby.model.map : 'def_01',
        difficulty: lobby.model.difficulty, heroId: lobby.model.hero, seed,
        reviveMul: reviveMulOf(lobby.model.profile),   // §3.6：防守也有复活加速
      })
      : createMatch({
        mapId: lobby.model.map, difficulty: lobby.model.difficulty, heroId: lobby.model.hero,
        seed, players: 1, length: lobby.model.length ?? 'short',
        // §3.6：人物等级的便利（初始金币 + 复活加速）在浏览器版里是这么传进来的，小游戏这边同样接上——
        // 以前 mini-game 里这两项**根本没生效**（开局永远是裸的 200 金、复活永远 15 秒）
        startGold: startGoldOf(lobby.model.profile), reviveMul: reviveMulOf(lobby.model.profile),
      });
    if (m.mode === 'defense') m.autoPickup = settings.autoPickup !== false;   // §12.5：走到掉落物上自动捡
    /**
     * 新手引导（§14.3 稿 11）：**只在第一局的 TD 上挂**——那四步全是塔防的（建塔 → 提前开波 → 旋风斩 →
     * 撑住一波），防守局挂上去就是驴唇不对马嘴。与浏览器版是同一条控制流（那边防守在 `startMatch`
     * 开头就 return 了，所以「防守不挂引导」不需要额外写判断）。
     */
    const tutorial = m.mode === 'defense' || !isFirstRun(lobby.model.profile)
      ? null
      : createTutorial({ startedAt: 0 });
    /**
     * §2.1「上次配置一键开局」：把这一局用的那套配置记进档案（浏览器版 `main.js` 在 `startMatch`
     * 里同一处干这件事）。下次打开大厅就照着选——小游戏以前从来不记，所以「上次选了噩梦难度」
     * 每次重开都回到普通。存不了不影响这一局（与记档同一套写法）。
     */
    lobby.model = {
      ...lobby.model,
      profile: { ...lobby.model.profile, lastChoice: { ...pickLobbyKeys(lobby.model) } },
    };
    try { saveProfile(lobby.model.profile); } catch { /* 存不了就只在这一次生效 */ }
    return buildBattle(m, { tutorial });
  };

  /**
   * 把一局装进「战场」这套状态（**开局与「继续上局」共用这一处**）。
   *
   * 以前这两条路各写了一遍，于是副本里少了两样东西，两样都会崩：
   * ① 存档里是**防守局**时，「继续上局」按 TD 的形状读 `m.wave`——防守没有 `wave`；
   * ② 副本没有 `sheetOf`，于是续档之后**点开任何面板、再点一下里面**就是
   *    `b.sheetOf is not a function`。这类「同一件事写两遍、副本落后于正本」的账，
   * 合并成一个构建口是最省事的修法。
   */
  const buildBattle = (m, over = {}) => {
    const renderer = createRenderer(canvas, { size: () => ({ w: size.width, h: size.height }) });
    renderer.fit(m.map?.grid ?? m.grid);
    const b = {
      m, renderer, selectedTower: 'tw_arrow', message: null, until: 0, layout: null,
      ui: { selectedSlot: null, panelSlot: null, sellArmed: false },
      extra: null,     // 结算那一下记档的收获（声望 / 升级），画面板用
      paused: false, rate: 1,
      saveClock: 0,    // §10.3 单人局自动存档：每 5 秒一次 + 切后台补一次
      resultDismissed: false,   // §131：防守转无尽之后玩家关掉结算面板（那一局继续跑）
      tutorial: null,  // 新手引导状态机（null = 这一局不挂）
      waveSeen: 0,     // 引导要的「上一波是第几波」——开波/清波两个事件由它算出来
      // 防守：摇杆状态（浮动模式下底座跟手指）+ 正在建的那个工事位
      stick: { active: false, id: null, origin: null, dir: { x: 0, y: 0, mag: 0 }, start: null },
      fortSlot: null,
      /**
       * 防守的小地图（§2.6）。小游戏里**第二张 `wx.createCanvas()` 就是离屏画布**：
       * 用小地图那套现成的绘制（`render.js` 的 `createMinimap`，与浏览器版共用一份）画在它上面，
       * 再整块贴到主画布上——省得在两处各画一遍「哪块地能刷、门在哪、怪从哪来」。
       */
      minimap: m.mode === 'defense' ? (() => {
        const c = wx.createCanvas();
        return { canvas: c, api: createMinimap(c, { size: () => ({ w: MINIMAP.w, h: MINIMAP.h }) }) };
      })() : null,
      ...over,
    };
    applyCamera(b);
    /**
     * 当前该显示哪张弹层。**读数从闭包里的活状态取**（`rate` / `settings`）——以前这里是
     * `layoutSheet(m, b.ui)` 直接传 `b.ui`，而 `b.ui` 只有 `{ sheetKind: 'pause' }`，
     * 于是暂停面板永远显示默认值（跑着 2× 的面板写着 1×、关了震动写着开）。§151 那条
     * 「一个面板不能两种说法」在读数上同样成立。
     */
    b.sheetOf = () => (b.ui.sheetKind === 'fort'
      ? layoutFortSheet(m, {
        freeSlots: m.def.fortSlots.filter((_, i) => !m.forts.some((f) => f.slot === i)).length,
        stickFloating: settings.stick === 'floating',
      })
      : layoutSheet(m, { ...b.ui, rate: b.rate, settings }));
    b.model = () => (m.mode === 'defense'
      ? { ...defModel(b), sheet: b.sheetOf() }
      : {
        ...describeBattleModel(m), selectedTower: b.selectedTower, paused: b.paused, rate: b.rate,
        // 结算面板一出来就收掉提示条（浏览器版 `view.tutorial` 同源）
        tutorial: m.result ? null : (b.tutorial?.current()?.text ?? null),
        /**
         * 下一波预告（§8.3：把波次表翻成人话，含空中与 Boss 提示）——文案取浏览器版那份 `wavePreview`，
         * 设置里关掉时照浏览器版写一句「已在设置里关闭」（不是把这一行悄悄藏起来，
         * 玩家得知道是「我关了」而不是「这波没有预告」）。
         */
        preview: m.result ? null : nextWaveHint(m),
        ui: b.ui, sheet: b.sheetOf(),
      });
    b.layout = m.mode === 'defense' ? layoutDefense(m, defModel(b)) : layoutBattle(b.model());
    battle = b;
    return b;
  };

  const backToLobby = () => {
    battle = null;
    clearSave();   // 回大厅 = 主动放弃这一局（与浏览器版同一个口径：大厅不会出现「继续上局」）
    lobby = { model: { ...createLobbyModel(), ...pickLobbyKeys(lobby.model) }, layout: null };
    lobby.layout = layoutLobby(size.width, size.height, lobby.model);
  };

  const note = (b, text, seconds = 1.6) => { b.message = text; b.until = b.m.time + seconds; };

  /**
   * 引导收尾（§153）：**只由这一处**把「已看过」写进档案——收尾条件只看 `tutorial.done`，
   * 「档案里已经记过」不是「这一段不用跑」的理由。存档失败不该把这一局弄崩（与记档同一套写法）。
   */
  const saveTutorialDone = () => {
    lobby.model = { ...lobby.model, profile: markTutorialDone(lobby.model.profile) };
    try { saveProfile(lobby.model.profile); } catch { /* 存不了就只在这一次生效 */ }
  };

  /** 一次「点」：弹层 → HUD → 战场（翻成最近的塔位） */
  const tapBattle = (b, x, y) => {
    // 弹层开着时它最优先（关掉 / 选塔 / 升级 / 买东西 / 换装 …）
    if (b.ui.sheetKind || b.ui.selectedSlot != null || b.ui.panelSlot != null) {
      // 走 `b.sheetOf()`：工事那张是防守专有的——直接调 layoutSheet 会返回 null，
      // 于是点哪儿都算「关掉弹层」（第一版就是这么建不出工事的）
      const action = hitTestSheet(b.sheetOf(), x, y);
      return applyAction(b, action);
    }
    // 防守模式：右侧那排 HUD 之外的点 = **点地移动 / 点工事位**（与浏览器版 defenseTap 同一套语义）
    if (b.m.mode === 'defense') {
      const hit = hitTestDefense(b.layout, x, y);
      if (hit) { tap('light'); return applyAction(b, hit); }
      return tapDefenseField(b, x, y);
    }
    const action = hitTestBattle(b.layout, x, y);
    if (action) {
      tap('light');   // §1.9.2：按下就震一下（开关在暂停面板里，关掉就静默）
      return applyAction(b, action);
    }
    // 战场：屏幕点 → 最近格 → 最近的塔位（§2.5「不要求点得准」）
    const g = b.renderer.toGrid(x, y);
    const slots = b.m.map.slots;
    let best = -1, bestD = Infinity;
    slots.forEach((s, i) => {
      const d = (s.x - g.x) ** 2 + (s.y - g.y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0 || bestD > 4) { note(b, '这一格不是塔位'); return null; }
    const existing = towerAtSlot(b.m, best);
    if (existing) {
      b.ui = { selectedSlot: null, panelSlot: best, sellArmed: false };
      return { type: 'openTower', slot: best };
    }
    b.ui = { selectedSlot: best, panelSlot: null, sellArmed: false };
    return { type: 'openBuild', slot: best };
  };

  /** 弹层上的动作 → 内核调用 */
  /**
   * **唯一的动作出口**：HUD 上的键、弹层里的行、防守那排按钮，全走这一处。
   * （第一版把 HUD 动作写在 `tapBattle` 的 switch 里、弹层动作写在另一个函数里，
   * 于是防守那屏把 HUD 命中接到「弹层动作」上——暂停点了没反应。一个出口就没有这种错配。）
   */
  const applyAction = (b, action) => {
    if (!action) return null;
    const slot = b.ui.panelSlot ?? b.ui.selectedSlot;
    switch (action.type) {
      // ---- HUD 上的通用键 ----
      case 'shop': b.ui = { sheetKind: 'shop' }; return action;
      case 'bag': b.ui = { sheetKind: 'bag' }; return action;
      case 'speed': b.rate = b.rate === 2 ? 1 : 2; return action;
      case 'pause': {
        // 单机局真暂停（联机才不谈暂停，§114）；暂停时顺手把面板摊开——玩家按暂停多半是想看点东西
        b.paused = !b.paused;
        b.ui = b.paused ? { sheetKind: 'pause' } : { selectedSlot: null, panelSlot: null, sellArmed: false };
        return action;
      }
      case 'potion': {
        /**
         * 与浏览器版同一条（`ui.js` 的 `btn.onclick`）：**按包里的顺序挨个试**，第一个放得出来的就用。
         * 以前这边写死了「先小药、没有才大药」——小药在冷却、大药明明能用时会被小药挡住
         * （玩家只能干等，而包里躺着一瓶没进冷却的大药）。
         */
        const ids = Object.keys(b.m.bag ?? {}).filter((k) => b.m.bag[k] > 0);
        const used = ids.find((id) => usePotion(b.m, id)) ?? null;
        const name = SHOP_ITEMS.find((s) => s.id === used)?.name;
        note(b, used ? `用了 ${name ?? '药品'}` : '药品冷却中或没有药');
        return action;
      }
      case 'early': {
        const ok = startWaveEarly(b.m, 0);
        note(b, ok ? '提前开波' : '现在开不了（正在交战）');
        return action;
      }
      case 'skill': {
        const ok = castSkill(b.m, action.index);
        if (ok) b.tutorial?.onSkillCast();   // 引导第三步靠「真的放了技能」推进
        note(b, ok ? '技能已放' : '技能冷却中或还没解锁');
        return action;
      }
      case 'tutorialSkip': {
        b.tutorial?.skip();
        b.tutorial = null;
        saveTutorialDone();
        note(b, '引导已跳过 · 暂停面板里可以重看', 2);
        return action;
      }
      case 'replayTutorial':
        // §153 的「重看」= 只把「已看过」那一个标记置回 false（门槛现在只看它），下一局再挂上
        lobby.model = { ...lobby.model, profile: { ...lobby.model.profile, tutorialDone: false } };
        try { saveProfile(lobby.model.profile); } catch { /* 存不了就只在这一次生效 */ }
        note(b, '下次开局会重新显示引导', 2);
        return action;
      case 'resetProgress': {
        /**
         * 「重置进度」（浏览器版在设置面板里，带一个 confirm）：清空声望 / 人物等级 / 解锁。
         * 不可逆，所以走两步确认（与出售 / 合成同一个习惯，§1.9.2）——第一次点只把这一行变成
         * 「再点一次确认重置」。清完之后大厅那行档案立刻按新档案算（这一局本身照打，不影响正在玩的人）。
         */
        if (!b.ui.resetArmed) {
          b.ui = { ...b.ui, resetArmed: true };
          note(b, '再点一次确认重置（清空声望 / 人物等级 / 解锁）', 2.4);
          return action;
        }
        clearProfile();
        lobby.model = { ...createLobbyModel(), ...pickLobbyKeys(lobby.model) };
        lobby.layout = layoutLobby(size.width, size.height, lobby.model);
        b.ui = { selectedSlot: null, panelSlot: null, sellArmed: false };
        note(b, '进度已清空（回大厅之后按新档案算）', 2.4);
        return action;
      }
      case 'lobby': backToLobby(); return action;
      case 'restart': startMatch(); return action;
      case 'endless': {
        /**
         * §131 / §190：守住 4 轮转无尽——结算面板收起来，那一局接着跑（内核在 `m.over` 之后
         * 才真的停）。浏览器版是 `view.resultDismissed = true` + 帧循环里那条 `canPlayOn`，同一件事。
         */
        b.resultDismissed = true;
        note(b, '进入无尽：按城堡剩余血量排行', 3);
        return action;
      }
      case 'close':
        b.ui = { selectedSlot: null, panelSlot: null, sellArmed: false };
        return action;
      case 'build': {
        const ok = buildTower(b.m, action.slot, action.towerId, 0);
        if (ok) b.tutorial?.onTowerBuilt(b.m.time);   // 引导第一步/第二步靠「真的建了塔」推进
        // 提示里写**玩家认得的名字**，不是 `tw_arrow` 这种内部 id（出门的版本里不该出现 id）
        note(b, ok ? `建了 ${TOWERS[action.towerId]?.name ?? '塔'}` : '金币不足或这里不能建');
        if (ok) b.ui = { selectedSlot: null, panelSlot: action.slot, sellArmed: false };
        return action;
      }
      case 'upgrade': {
        const ok = upgradeTower(b.m, action.slot);
        note(b, ok ? '升级完成' : '金币不足或已满级');
        return action;
      }
      case 'sell': {
        // 不可逆操作要两步（§1.9.2）：先变「确认出售」，再点一次才真卖
        if (!b.ui.sellArmed) { b.ui = { ...b.ui, sellArmed: true }; note(b, '再点一次确认出售', 2); return action; }
        const ok = sellTower(b.m, action.slot);
        note(b, ok ? '已出售' : '这座塔已经没了');
        b.ui = { selectedSlot: null, panelSlot: null, sellArmed: false };
        return action;
      }
      case 'priority': {
        const ok = setPriority(b.m, action.slot, action.value);
        note(b, ok ? `优先级：${PRIORITY_LABEL[action.value] ?? action.value}` : '设置失败');
        return action;
      }
      case 'repair': {
        const ok = repairTower(b.m, action.slot);
        note(b, ok ? '塔已修复' : '金币不足或无需修复');
        return action;
      }
      // ---- 防守专有 ----
      case 'teleport': {
        const ok = teleportHome(b.m);
        note(b, ok ? '已回城' : '冷却中或阵亡中');
        return action;
      }
      case 'repairCastle': {
        const ok = repairCastle(b.m);
        note(b, ok ? '城堡已修复' : '金币不足或城堡已满血');
        return action;
      }
      case 'revive': {
        // §7.6 快速复活（50 木材）：浏览器版这条只有键盘 `r`（手机上根本够不着），小游戏补了按钮
        const ok = reviveNow(b.m);
        note(b, ok ? '快速复活' : '木材不够或没阵亡', 1.6);
        return action;
      }
      case 'fort':
        b.fortSlot = null;          // 从面板进 = 还没选位置，先在战场上点一个工事位
        b.ui = { sheetKind: 'fort' };
        return action;
      case 'buildFort': {
        const slot = b.fortSlot;
        const ok = slot == null ? false : buildFort(b.m, slot, action.fortId);
        note(b, ok ? `建了 ${FORTS[action.fortId]?.name ?? '工事'}`
          : (slot == null ? '先在战场上点一个工事位（‘修’字）' : '金币不足或这里已经建过'), 2);
        if (ok) b.fortSlot = null;
        if (ok || slot == null) b.ui = { selectedSlot: null, panelSlot: null, sellArmed: false };
        return action;
      }
      // ---- 商店 / 背包 / 物品 ----
      case 'buy': {
        const ok = buyItem(b.m, action.itemId, 0);
        const row = b.model().sheet?.byId?.[`buy-${action.itemId}`];
        /**
         * 买不了时说**真正**那条原因：行上那句就已经是它（已撤柜 / 已买满 / 药品格已满 / 回基地再买），
         * 没有原因就只剩「钱（或木材）不够」（§3.1 #20：说清为什么）。以前这里是一律列一遍
         * 「金币不足 / 已买满 / 药品格已满」——防守局的商店在基地里（§3.1 #14），
         * 人走远了点购买明明是「先回基地」，却被说成没钱。
         */
        note(b, ok ? `买了 ${row?.label ?? action.itemId}` : (row?.reason ?? '资源不足'));
        return action;
      }
      case 'item':
        b.ui = { sheetKind: 'item', itemUid: action.uid };
        return action;
      case 'equip': {
        const ok = equipItem(b.m, action.uid);
        note(b, ok ? '已换上' : '换装失败');
        b.ui = { sheetKind: 'bag' };   // 回到背包，能直接看到变化
        return action;
      }
      case 'enhance': {
        const ok = enhanceItem(b.m, action.uid);
        note(b, ok ? '强化完成' : '金币不足或已满级');
        return action;
      }
      case 'sellItem': {
        if (!b.ui.sellArmed) { b.ui = { ...b.ui, sellArmed: true }; note(b, '再点一次确认出售', 2); return action; }
        const ok = sellItem(b.m, action.uid, 0);
        note(b, ok ? '已出售' : '出售失败');
        b.ui = { sheetKind: 'bag' };
        return action;
      }
      case 'craft': {
        // 合成不可逆（§5.4.1）：和出售一样两步确认
        if (!b.ui.craftArmed) { b.ui = { ...b.ui, craftArmed: true }; note(b, '再点一次确认合成', 2); return action; }
        const ok = craftEquipment(b.m, action.slot, action.quality);
        note(b, ok ? '合成成功' : '合成失败');
        b.ui = { sheetKind: 'bag' };
        return action;
      }
      // ---- 暂停面板上的四个动作 ----
      case 'resume':
        b.paused = false;
        b.ui = { selectedSlot: null, panelSlot: null, sellArmed: false };
        return action;
      case 'camera': {
        settings = { ...settings, tdFitAll: settings.tdFitAll === false };
        saveSettings(settings);
        applyCamera(b);
        note(b, settings.tdFitAll ? '镜头：整图可见' : '镜头：放大', 1.4);
        return action;
      }
      case 'stick': {
        // §1.9.3 的「固定 / 浮动」——只影响防守；下一次按下摇杆时按新档位算底座
        settings = { ...settings, stick: settings.stick === 'floating' ? 'fixed' : 'floating' };
        saveSettings(settings);
        note(b, settings.stick === 'floating' ? '摇杆：浮动（跟手）' : '摇杆：固定（左下）', 1.4);
        return action;
      }
      case 'wavePreview': {
        // §8.3：开波前那行预告（防：关了就说一句「已在设置里关闭」，不是把那一行藏起来）
        settings = { ...settings, showWavePreview: settings.showWavePreview === false };
        saveSettings(settings);
        note(b, settings.showWavePreview ? '波次预告已开' : '波次预告已关', 1.4);
        return action;
      }
      case 'effects': {
        // §116 的低特效档：关掉脉冲那类装饰（保帧率）。§10.7 的内存告警也会把它自动切过来
        settings = { ...settings, effects: settings.effects === 'low' ? 'high' : 'low' };
        saveSettings(settings);
        note(b, settings.effects === 'low' ? '特效：低（关脉冲）' : '特效：高', 1.4);
        return action;
      }
      case 'autoPickup': {
        // §12.5：防守走到掉落物上自动捡。内核读的是 `m.autoPickup`，所以改了要**立刻**写进去
        settings = { ...settings, autoPickup: settings.autoPickup === false };
        saveSettings(settings);
        b.m.autoPickup = settings.autoPickup;
        note(b, settings.autoPickup ? '自动拾取已开' : '自动拾取已关', 1.4);
        return action;
      }
      case 'sfx': {
        settings = { ...settings, sfx: settings.sfx === false };
        saveSettings(settings);
        // 这一格管着提示音与震动两样，提示语要跟着说全（否则关了音效还以为只是关了震动）
        note(b, settings.sfx === false ? '音效与震动已关' : '音效与震动已开', 1.4);
        return action;
      }
      default: return action;
    }
  };

  /** 防守：点战场 = 走过去；点空工事位 = 开工事面板（浏览器版 `defenseTap` 的同一套语义） */
  const tapDefenseField = (b, x, y) => {
    const cell = b.renderer.toGrid(x, y);
    const slot = b.m.def.fortSlots.findIndex((s, i) => gridDist(s, cell) <= 1 && !b.m.forts.some((f) => f.slot === i));
    if (slot >= 0) {
      b.fortSlot = slot;
      b.ui = { sheetKind: 'fort' };
      return { type: 'openFort', slot };
    }
    const ok = orderMove(b.m, cell);
    note(b, ok ? '走过去' : '走不过去', 1.2);
    return { type: 'move', cell };
  };

  /**
   * §2.5 / §171 的镜头操作：**单指拖空白处平移、双指缩放、双击回核心**。
   * 三条都只对 TD 生效——防守是跟随相机（每帧被 `drawDefense` 覆盖），这是浏览器版同一个判据。
   */
  const pointers = new Map();   // 触点 id → 当前屏幕点（小游戏只能从 down/move/up 自己攒）
  let drag = null;              // 拖动中的上一个屏幕点
  let dragMoved = false;        // 这一下真的拖动了吗（「点空白处」也会武装 drag，不能拿它当判据）
  let pinchDist = null;         // 上一帧的双指间距（null = 没在缩放）
  let lastEmptyTap = null;      // 上一次「点空白处」的落点与时间（双击回核心用）

  /** 这一下是不是「点空白处」（不在任何塔位的判定半径里）——双击回核心只认这种落点 */
  const emptyTapAt = (b, x, y) => {
    if (b.m.mode === 'defense') return false;
    const cell = b.renderer.toGrid(x, y);
    const g = b.m.map?.grid ?? { w: 32, h: 24 };
    if (cell.x < 0 || cell.y < 0 || cell.x >= g.w || cell.y >= g.h) return false;
    return !(b.m.map.slots ?? []).some((s) => gridDist(s, cell) <= 2);
  };

  /** §2.5 的「双击回核心」：整图档下本来就是整图可见（再点一次不动），放大档下回核心并记住这个档 */
  const backToCore = (b) => {
    if (b.m.mode === 'defense' || b.paused || b.m.result) return;
    const grid = b.m.map.grid;
    const core = b.m.core?.cell ?? b.m.cores?.[0]?.cell ?? { x: grid.w / 2, y: grid.h / 2 };
    if (settings.tdFitAll && b.renderer.scale <= (settings.zoom ?? 1.5)) { b.renderer.fit(grid); return; }
    settings = { ...settings, tdFitAll: false };
    saveSettings(settings);
    b.renderer.setCamera(core.x, core.y, settings.zoom ?? 1.5);
  };

  /** 一次「点」（大厅）：应用选择，并在「单人开局」上真的进局 */
  const tapLobby = (x, y) => {
    const action = hitTestLobby(lobby.layout, x, y);
    const next = stepLobby(lobby.model, action);
    if (next !== lobby.model) lobby.model = next;
    lobby.layout = layoutLobby(size.width, size.height, lobby.model);
    if (action?.type === 'start' && lobby.model.canStart !== false) startMatch();
    if (action?.type === 'continue') continueSaved();
    return action;
  };

  /**
   * 「继续上局」：把存档读回来装进战场（§10.3 单人局无限期可恢复）。
   * 读不出来（键在但版本/形状不对）时**不留一个点了没反应的按钮**——清掉它并说一句（§204 的口径）。
   */
  const continueSaved = () => {
    const restored = loadFromStorage();
    if (!restored) {
      clearSave();
      lobby.model = { ...lobby.model, canContinue: false, hint: '上一局的存档读不出来（版本或形状对不上），已清掉' };
      lobby.layout = layoutLobby(size.width, size.height, lobby.model);
      return null;
    }
    // 与「开一局」走同一个构建口：存档里是防守局时它也按防守那套装（以前的副本按 TD 读 `m.wave`）
    return buildBattle(restored, {
      message: '继续上一局', until: restored.time + 2,
      extra: restored.result ? {} : null,
    });
  };

  onTouch((e) => {
    // §178：音频只能在**用户手势里**解锁（真机上第一次预警才响得出来）——每一次按下都顺手解一下
    cue.warm();
    if (!battle) {
      // 大厅那一屏自己按视口缩放布局（`layoutLobby`），所以它的坐标就是画布坐标
      if (e.type === 'down' && !viewportNotice()) tapLobby(e.x, e.y);
      drawFrame();
      return;
    }
    const b = battle;
    // 战场 HUD 是设计单位居中摆的：触摸坐标减掉同一个偏移，后面一律按设计单位算
    const o = hudOffset();
    const t = { ...e, x: e.x - o.x, y: e.y - o.y };
    const sheetOpen = !!b.ui.sheetKind || b.ui.selectedSlot != null || b.ui.panelSlot != null;
    /**
     * 触点登记：小游戏只给 changedTouches，所以「现在有几根手指、都在哪」得自己攒。
     * `tapped` 记的是「这一下的『按下』已经当成一次点击处理过了」——松手时不能再点一次，
     * 否则一次点击会连点两下（第一版就没有这个标记：点塔位会「开面板 + 立刻点到面板里那一行」）。
     */
    let upTapped = false;
    let upPinched = false;
    if (t.type === 'up') {
      const entry = pointers.get(t.id);
      upTapped = !!entry?.tapped;
      upPinched = !!entry?.pinched;
      pointers.delete(t.id);
      if (pointers.size < 2) pinchDist = null;
    }
    /**
     * 防守多一层：**左侧 45% 的拖动 = 摇杆**（§1.9.1），松手时若几乎没动就补一次「点地移动」
     * （浏览器版 `stick.owns()` 那套的同一件事）。其余地方仍然是「点」。
     */
    if (b.m.mode === 'defense' && !sheetOpen) {
      /**
       * §1.9.3：摇杆可切「固定 / 浮动」。固定 = 左下那个底座不动；浮动 = 手指按哪儿底座跟到哪儿
       * （与浏览器版 `joystick.js` 同一条规则：只是**底座**跟着走，方向仍然从按下的那一点算）。
       */
      const floating = settings.stick === 'floating';
      if (t.type === 'down' && inStickZone(b.layout, t.x, t.y, floating)) {
        // 底座按**设计单位**摆（左下的 16% / 78%），触摸坐标上面已经换算成设计单位了
        const home = stickBase(defModel(b));
        const origin = floating ? { x: t.x, y: t.y, r: home.r, floating: true } : home;
        b.stick = { active: true, id: t.id, origin, start: { x: t.x, y: t.y }, dir: { x: 0, y: 0, mag: 0 } };
        drawFrame();
        return;
      }
      if (t.type === 'move' && b.stick.active && t.id === b.stick.id) {
        b.stick.dir = stickVector(b.stick.origin, t.x, t.y);
        drawFrame();
        return;
      }
      if (t.type === 'up' && b.stick.active && t.id === b.stick.id) {
        const moved = Math.hypot(t.x - b.stick.start.x, t.y - b.stick.start.y);
        b.stick = { active: false, id: null, origin: null, start: null, dir: { x: 0, y: 0, mag: 0 } };
        if (moved < 12) tapBattle(b, t.x, t.y);   // 轻点：走那一步 / 点工事位
        drawFrame();
        return;
      }
    }
    /** TD 的镜头操作（§2.5 / §171）：单指拖空白处平移、双指缩放、双击回核心。暂停 / 已结算时不接管。 */
    const camBase = b.m.mode !== 'defense' && !b.paused && !b.m.result;
    if (camBase) {
      if (t.type === 'down') pointers.set(t.id, { x: t.x, y: t.y, tapped: false });
      // 移动只更新坐标：**别换一个新对象**，`tapped` / `pinched` 这两个标记要留着
      // （第一版这里写的是 `set(id, {x,y})`，于是拖一下就把「按下已经点过」的标记丢了——
      //  松手会再点一次，表现为「拖完地图顺手弹出一张建造面板」）
      else if (t.type === 'move' && pointers.has(t.id)) {
        const p = pointers.get(t.id);
        p.x = t.x; p.y = t.y;
      }
      if (pointers.size >= 2) {
        // 两根手指 = 缩放（以两指中点为锚点，和桌面滚轮走同一个 `zoomAt` 出口）
        const [a, c] = [...pointers.values()];
        const dist = Math.hypot(a.x - c.x, a.y - c.y);
        if (t.type === 'down') {
          // 两根手指一起抬起时**不要**再补一次「点」：不然缩放完松手会顺手开出一张面板
          for (const p of pointers.values()) p.pinched = true;
          drag = null;
          b.ui = { selectedSlot: null, panelSlot: null, sellArmed: false };
        }
        if (pinchDist && dist > 40) {
          if (settings.tdFitAll) { settings = { ...settings, tdFitAll: false }; saveSettings(settings); }
          const next = Math.min(2.2, Math.max(0.4, b.renderer.scale * (dist / pinchDist)));
          b.renderer.zoomAt(next, (a.x + c.x) / 2, (a.y + c.y) / 2);
        }
        pinchDist = dist;
        drawFrame();
        return;
      }
    }
    /**
     * 拖动与「点」：弹层开着时那几下仍然要归弹层（这条不能跟双指缩放共用判据——
     * 缩放要能在面板开着时也能用，玩家可能一边看面板一边把镜头拉远）。
     */
    if (camBase && !sheetOpen) {
      // 放大档下的空白处：这一下先当「拖地图」，松手没动才算点（整图档本来就没有可拖的余地）
      if (t.type === 'down' && settings.tdFitAll === false && emptyTapAt(b, t.x, t.y)) {
        drag = { x: t.x, y: t.y };
        dragMoved = false;
        drawFrame();
        return;
      }
      if (t.type === 'move' && drag) {
        if (Math.hypot(t.x - drag.x, t.y - drag.y) > 4) dragMoved = true;
        b.renderer.panBy(t.x - drag.x, t.y - drag.y);
        drag = { x: t.x, y: t.y };
        drawFrame();
        return;
      }
      if (t.type === 'up') {
        const wasDrag = dragMoved;
        drag = null;
        dragMoved = false;
        // 拖过 / 按下那一下已经点过（塔位、摇杆）/ 这一下本来是双指缩放：松手都不再补点
        if (wasDrag || upTapped || upPinched) { drawFrame(); return; }
        if (emptyTapAt(b, t.x, t.y)) {
          const now = Date.now();
          if (lastEmptyTap && now - lastEmptyTap.t < 300 && Math.hypot(t.x - lastEmptyTap.x, t.y - lastEmptyTap.y) < 30) {
            lastEmptyTap = null;
            backToCore(b);
            drawFrame();
            return;
          }
          lastEmptyTap = { t: now, x: t.x, y: t.y };
        }
        tapBattle(b, t.x, t.y);
        drawFrame();
        return;
      }
      if (t.type === 'down') {
        const p = pointers.get(t.id);
        if (p) p.tapped = true;
        tapBattle(b, t.x, t.y);   // 塔位 / HUD 上的那一下照旧按下就响应
        drawFrame();
        return;
      }
    }
    if (t.type !== 'down') return;     // 其余情况这一版只要「点」
    // 「按下即点击」：这一下标记过之后，松手那一笔不会再点一次（见上面 `upTapped` 那段）
    const entry = pointers.get(t.id);
    if (entry) entry.tapped = true;
    tapBattle(b, t.x, t.y);
    drawFrame();
  });
  // 切后台 / 退出时补一笔存档（§10.3 的「随时能停」：小游戏是 wx.onHide）
  onHide(() => { if (battle && !battle.m.result) saveToStorage(battle.m); });

  const drawFrame = () => {
    const { width, height } = viewport();
    if (`${width}x${height}` !== lastSize) resize();
    // 竖屏 / 屏幕太小：只画那一句说明（右上角胶囊那种细节在这里毫无意义），触摸也不接
    const notice = viewportNotice();
    if (notice) { drawNotice(notice); return; }
    if (!battle) { drawLobby(ctx, lobby.model, lobby.layout); return; }
    const b = battle;
    const message = b.m.time < b.until ? b.message : null;
    if (b.m.mode === 'defense') {
      b.layout = layoutDefense(b.m, defModel(b));
      // 跟随相机由 drawDefense 自己算（它拿 `scale`）；我们只把缩放档递进去
      b.renderer.draw({ m: b.m, scale: settings.zoom ?? 1.5, now: b.m.time });
      const o = hudOffset();
      ctx.setTransform(size.dpr, 0, 0, size.dpr, size.dpr * o.x, size.dpr * o.y);
      drawDefenseHud(ctx, b.m, b.layout, { message, stick: b.stick.active ? { base: b.stick.origin, dir: b.stick.dir } : { base: b.layout.stick, dir: { x: 0, y: 0, mag: 0 } } });
      // 小地图画在 HUD 之后：它那一格在 `items` 里（负责命中），底下的面板底由这张图盖住
      if (b.minimap) {
        b.minimap.api.draw(b.m);
        ctx.drawImage(b.minimap.canvas, MINIMAP.x, MINIMAP.y, MINIMAP.w, MINIMAP.h);
      }
    } else {
      const model = b.model();
      b.layout = layoutBattle(model);
      // `hintSlots`：引导第一步/第二步在战场上圈出「建这里」（render.js 本来就有这段，直接复用）
      b.renderer.draw({
        // §116：低特效档关掉脉冲（新手引导塔位高亮那层呼吸）；高档才让它随时间变化
        m: b.m, selectedSlot: null, selectedTower: null, localSlot: 0, now: b.m.time,
        pulses: settings.effects !== 'low',
        hintSlots: b.tutorial?.hintSlotCount() ?? 0,
      });
      // renderer 可能重设过变换，这里再对齐一次（并按大屏把 HUD 居中）
      const o = hudOffset();
      ctx.setTransform(size.dpr, 0, 0, size.dpr, size.dpr * o.x, size.dpr * o.y);
      drawBattleHud(ctx, b.m, b.layout, { selectedTower: b.selectedTower, message, preview: model.preview });
    }
    // 结算面板：内核出结果之后盖上来（内容是浏览器版那个 resultPanelModel，一份模型两个渲染器）
    recordIfFinished(b);
    /**
     * 结算面板盖上来。转无尽时底部那颗「继续（无尽）」在 y=315（面板底边 302），两者不重叠，
     * 所以画的先后无所谓；它是 `L.items` 里的一项，命中测试照样能拿到（§131）。
     * `resultDismissed` = 玩家已经点了「继续（无尽）」，面板收起来、那一局接着跑。
     */
    if (b.m.result && !b.resultDismissed) drawResult(ctx, layoutResult(b.m, b.extra ?? {}));
    // 弹层画在最后（压住 HUD 与战场）：正在建塔 / 看塔面板时，它就是焦点
    drawSheet(ctx, b.model().sheet);
  };

  /** 推进内核（小游戏里由帧循环按真实时间驱动；本地验收里手动调它） */
  const tick = (seconds) => {
    if (!battle) return 0;
    /**
     * 真暂停：内核一步都不走。**但结算面板不等于停表**——防守守住 4 轮转无尽之后那一局还要继续跑
     * （浏览器版帧循环里的 `canPlayOn = !match.result || !!match.assault?.endless` 就是这条；
     * 「城堡陷落」那种彻底结束由内核自己 `m.over` 挡住）。
     */
    if (battle.paused || (battle.m.result && !battle.m.assault?.endless)) return 0;
    const steps = Math.round(seconds / TICK_STEP);
    const step = battle.m.mode === 'defense' ? updateDefense : update;
    for (let i = 0; i < steps; i += 1) {
      if (battle.m.result && !battle.m.assault?.endless) break;   // 同上：无尽里 `result` 不再等于「停下」
      // 防守：摇杆推着走 = 每帧重发同一条移动指令（换格时才重发，别每帧重算 A*，与浏览器版同源）
      if (battle.m.mode === 'defense' && battle.stick.dir.mag > 0) {
        const goal = steerGoal(battle.m, battle.stick.dir);
        const last = battle.stickGoal;
        if (goal && (!last || goal.x !== last.x || goal.y !== last.y)) {
          battle.stickGoal = goal;
          orderMove(battle.m, goal);
        }
      } else if (battle.m.mode === 'defense') {
        battle.stickGoal = null;
      }
      step(battle.m, TICK_STEP);
    }
    // 引导要喂两个事件：开波 / 清波（浏览器版 main.js 里那一段同源，`waveSeen` 就是 `lastWaveSeen`）
    if (battle.tutorial && battle.m.mode !== 'defense') {
      if (battle.m.wave.index !== battle.waveSeen) {
        const cleared = battle.waveSeen;
        battle.waveSeen = battle.m.wave.index;
        if (battle.m.wave.index > 0) battle.tutorial.onWaveStarted(battle.m.wave.index, battle.m.time);
        if (cleared > 0) battle.tutorial.onWaveCleared(cleared, battle.m.time);
        if (battle.tutorial.done) {
          const s = battle.tutorial.summary();
          const v = tutorialPasses(s);
          note(battle, `引导完成：建塔 ${s.secondsToFirstTower ?? '—'}s · 首波 ${s.secondsToWaveCleared ?? '—'}s`
            + `（目标 ≤90 / ≤180，${v.firstTowerOk && v.firstWaveOk ? '达标' : '超标'}）`, 4);
          battle.tutorial = null;
          saveTutorialDone();
        }
      }
    }
    maybeAutosave(battle, seconds);
    recordIfFinished(battle);
    /**
     * §2.6：预警**响的那一下**放一声（只认边沿，不是每帧都播）——与浏览器版帧循环里那句
     * `if (warning && !lastWarning) cue('warning')` 同一件事。
     */
    const warning = !!battle.m.assault?.warning;
    if (warning && !battle.lastWarning) cue('warning');
    battle.lastWarning = warning;
    return steps;
  };

  /** 自动存档（§10.3）：每 5 秒一次；已经在结算的那一局不存（§113：完结的局不该再出现「继续上局」） */
  const maybeAutosave = (b, dt) => {
    if (!b || b.m.result) return false;
    b.saveClock = (b.saveClock ?? 0) + dt;
    if (b.saveClock < 5) return false;
    b.saveClock = 0;
    return saveToStorage(b.m);
  };

  /**
   * 一局结束 → **记档一次**（§188 的教训：只在「回大厅」复位那个闸，连打两局第二局就不记了）。
   * 小游戏这边以前压根没记档：打完一局声望与解锁纹丝不动，而大厅那行「人物 Lv / 声望 / 可玩地图」
   * 又是从档案读的——一个永远不动的数字摆在那儿比不摆更糟。
   */
  const recordIfFinished = (b) => {
    if (!b || b.extra || !b.m.result) return;
    const summary = resultSummary(b.m);
    const { profile: next, gain, leveledUp } = recordResult(lobby.model.profile, summary);
    lobby.model = { ...lobby.model, profile: next };
    b.extra = { gain, leveledUp, commanderLevel: next.commanderLevel };
    lobby.model = {
      ...lobby.model,
      unlocked: [...unlockedMaps(next, 'td'), ...unlockedMaps(next, 'defense')],
      unlockedCount: new Set([...unlockedMaps(next, 'td'), ...unlockedMaps(next, 'defense')]).size,
    };
    clearSave();   // 一局结束就收掉存档：大厅不该再出现「继续上局」（浏览器版同源，main.js 的 maybeRecordResult）
    try { saveProfile(next); } catch { /* 存不了就只在这一次生效（§183 的提示在浏览器版那边） */ }
  };

  let last = 0;
  const frame = (ts = 0) => {
    if (battle) {
      const dt = last ? Math.min(0.25, (ts - last) / 1000) : 0;
      if (dt > 0) tick(dt * (battle.rate ?? 1));   // 倍速就是「这一帧推两步」（内核步长仍是 1/20 秒）
    }
    last = ts;
    drawFrame();
    if (rafFn) rafFn(frame);
  };
  if (rafFn) rafFn(frame); else drawFrame();

  const handle = {
    canvas,
    screen: () => (battle ? 'battle' : 'lobby'),
    getModel: () => (battle ? battle.model() : lobby.model),
    layout: () => (battle ? battle.layout : lobby.layout),
    match: () => battle?.m ?? null,
    /** 调试/验收用：屏幕坐标 ↔ 格坐标的换算（点塔位那一步要用） */
    renderer: () => battle?.renderer ?? null,
    /** 调试/验收用：防守的小地图（离屏画布 + `render.js` 那套绘制）——离线验收要断言它真的画了 */
    minimap: () => battle?.minimap ?? null,
    tap: (x, y) => (battle ? tapBattle(battle, x, y) : tapLobby(x, y)),
    startMatch,
    backToLobby,
    tick,
    drawFrame,
  };
  // 调试/本地验收用：小游戏里也能从控制台摸到这一屏的状态（`__frostfallLobby.getModel()`）
  globalThis.__frostfallLobby = handle;
  globalThis.__frostfallMinigame = { ...(globalThis.__frostfallMinigame ?? {}), app: handle };
  return handle;
}

/** HUD 需要的那点战场状态（不给整局对象，免得 HUD 顺手读不该读的东西） */
const describeBattleModel = (m) => ({
  wave: m.wave.index, phase: m.wave.phase, timer: m.wave.timer,
  gold: Math.round(m.gold), core: m.core.hp, coreMax: m.core.maxHp,
  result: m.result, length: m.length,
  /**
   * 「开波」能不能点，用**内核那条判据**（`startWaveEarly` 的第一行：
   * `wave.phase === 'prep' && wave.index < waves.length`）——以前这边写的是 `timer > 0`，
   * 于是「最后一波的备战期」这种边角状态下按钮亮着、点了却被内核拒绝（提示说「正在交战」，更让人糊涂）。
   */
  canEarly: m.wave.phase === 'prep' && m.wave.index < (m.waves ?? WAVES).length,
  // 英雄读数与木材：阵亡时要给「快速复活 · 50 木」并判断灰不灰（§7.6），数字从内核取
  hero: { level: m.hero.level, dead: !!m.hero.dead, reviveIn: m.hero.reviveTimer ?? 0 },
  lumber: m.lumber?.[0] ?? 0,
  // 底部那排要显示的数量：药品格数（§5.5.3：共 3 格）与背包件数
  potionCount: potionCount(m),
  bagCount: m.inventory?.length ?? 0,
  // 技能键：名字 / 等级 / 冷却（`battle.js` 的 `skillKeys`，TD 与防守共用一份来源，§231）
  skills: skillKeys(m),
});

/** 回大厅时保留玩家刚选的模式/地图/难度/英雄（大厅的状态在进局那一刻被 Battle 接管了） */
const pickLobbyKeys = (model) => ({
  mode: model.mode, map: model.map, difficulty: model.difficulty, length: model.length, hero: model.hero,
});

/** 防守那屏的模型（HUD 只读这些，别顺手读整局对象） */
const defModel = (b) => ({
  paused: b.paused, rate: b.rate, potionCount: potionCount(b.m),
  round: b.m.assault?.round ?? 0, warning: !!b.m.assault?.warning,
  // §131：守住 4 轮转无尽之后，玩家还得能接着玩——**结算面板还在时**才给那颗「继续（无尽）」
  // （点了它就 `resultDismissed`，面板收起来、那一局接着跑）
  // §190：**城堡已经陷落就不给这个出口**（`m.over`）——那种「继续」是假出口：点下去只是把面板让开，
  // 露出一个城堡 0 血、怪站着不动的死场（浏览器版 `resultPanelModel` 的 `canContinue` 就是这么判的）
  endlessExit: !!b.m.assault?.endless && !b.m.over && !b.resultDismissed,
  stickFloating: (b.stickFloating ?? false),
  stickOrigin: b.stick.active ? b.stick.origin : null,
  stick: b.stick,   // 调试/验收用：能断言「推着走了没有」
  ui: b.ui,
});

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
  // 大厅 ⇄ 战场：两个屏都在 Canvas 上，战场复用浏览器版验过的 render.js
  startMinigame();
}
