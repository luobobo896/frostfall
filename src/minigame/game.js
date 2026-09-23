// 微信小游戏入口（移植第 2 步：整包能装起来、内核能在 wx 环境里跑）。
//
// **这一步还不能玩**：小游戏没有 DOM，而我们的界面（大厅 / HUD / 结算 / 商店…）现在是
// `index.html` + `styles.css` + `ui.js` 那套 DOM+CSS。这一步做的是把**平台差异**与**打包**解决掉，
// 并把不依赖 DOM 的那一大半（内核、数据表、存档、联机协议、平台适配）先在小游戏里跑通。
// 界面换 Canvas 是第 3 步，见 docs/minigame-port.md。
import { TICK_STEP } from '../data.js';
import { DEFENSE_MAPS, MAPS } from '../data.js';
import {
  buildTower, buyItem, castSkill, craftEquipment, createMatch, describe as describeMatch, equipItem,
  enhanceItem, potionCount, repairTower, sellItem, sellTower, setPriority, startWaveEarly,
  towerAtSlot, update, upgradeTower, usePotion,
} from '../match.js';
import { createDefenseMatch, describeDefense, updateDefense } from '../defense.js';
import { isMiniGame, onTouch, storage, viewport } from '../platform.js';
import {
  loadProfile, mapLocked, recordResult, reviveMulOf, saveProfile, startGoldOf, unlockedMaps,
} from '../profile.js';
import { resultSummary } from '../result.js';
import { createRenderer } from '../render.js';
import { applyLobbyAction, drawLobby, hitTestLobby, layoutLobby } from './lobby.js';
import {
  drawBattleHud, drawResult, drawSheet, hitTestBattle, hitTestSheet,
  layoutBattle, layoutResult, layoutSheet,
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
    canStart: true,
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

  /** 进局：按大厅里选的那套配置开一局（联机/多人缩放先按单人；多人是后面的事） */
  const startMatch = () => {
    if (lobby.model.mode === 'defense') {
      // 防守战场（跟随相机 + 摇杆 + 另一套 HUD）还没搬，这里**说清原因**而不是开出一局 TD 糊弄
      lobby.model = { ...lobby.model, hint: '防守模式的战场还没接过来（下一步）：先玩 TD 塔防。' };
      lobby.layout = layoutLobby(size.width, size.height, lobby.model);
      return null;
    }
    const m = createMatch({
      mapId: lobby.model.map, difficulty: lobby.model.difficulty, heroId: lobby.model.hero,
      seed: Date.now() % 1e6 || 7, players: 1, length: lobby.model.length ?? 'short',
      // §3.6：人物等级的便利（初始金币 + 复活加速）在浏览器版里是这么传进来的，小游戏这边同样接上——
      // 以前 mini-game 里这两项**根本没生效**（开局永远是裸的 200 金、复活永远 15 秒）
      startGold: startGoldOf(lobby.model.profile), reviveMul: reviveMulOf(lobby.model.profile),
    });
    const renderer = createRenderer(canvas, { size: () => ({ w: size.width, h: size.height }) });
    renderer.fit(m.map.grid);
    const b = {
      m, renderer, selectedTower: 'tw_arrow', message: null, until: 0, layout: null,
      ui: { selectedSlot: null, panelSlot: null, sellArmed: false },
      extra: null,     // 结算那一下记档的收获（声望 / 升级），画面板用
    };
    b.model = () => ({
      ...describeBattleModel(m), selectedTower: b.selectedTower,
      ui: b.ui, sheet: layoutSheet(m, b.ui),
    });
    b.layout = layoutBattle(b.model());
    battle = b;
    return b;
  };

  const backToLobby = () => {
    battle = null;
    lobby = { model: { ...createLobbyModel(), ...pickLobbyKeys(lobby.model) }, layout: null };
    lobby.layout = layoutLobby(size.width, size.height, lobby.model);
  };

  const note = (b, text, seconds = 1.6) => { b.message = text; b.until = b.m.time + seconds; };

  /** 一次「点」：弹层 → HUD → 战场（翻成最近的塔位） */
  const tapBattle = (b, x, y) => {
    // 弹层开着时它最优先（关掉 / 选塔 / 升级 / 买东西 / 换装 …）
    if (b.ui.sheetKind || b.ui.selectedSlot != null || b.ui.panelSlot != null) {
      const action = hitTestSheet(layoutSheet(b.m, b.ui), x, y);
      return applySheetAction(b, action);
    }
    const action = hitTestBattle(b.layout, x, y);
    if (action) {
      switch (action.type) {
        case 'shop': b.ui = { sheetKind: 'shop' }; return action;
        case 'bag': b.ui = { sheetKind: 'bag' }; return action;
        case 'potion': {
          const id = b.m.bag.pot_small ? 'pot_small' : (b.m.bag.pot_large ? 'pot_large' : null);
          const ok = id ? usePotion(b.m, id) : false;
          note(b, ok ? '用药' : '药品冷却中或没有药');
          return action;
        }
        case 'early': {
          const ok = startWaveEarly(b.m, 0);
          note(b, ok ? '提前开波' : '现在开不了（正在交战）');
          return action;
        }
        case 'skill': {
          const ok = castSkill(b.m, action.index);
          note(b, ok ? '技能已放' : '技能冷却中或还没解锁');
          return action;
        }
        case 'lobby': backToLobby(); return action;
        case 'restart': startMatch(); return action;
        default: return action;
      }
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
  const applySheetAction = (b, action) => {
    if (!action) return null;
    const slot = b.ui.panelSlot ?? b.ui.selectedSlot;
    switch (action.type) {
      case 'close':
        b.ui = { selectedSlot: null, panelSlot: null, sellArmed: false };
        return action;
      case 'build': {
        const ok = buildTower(b.m, action.slot, action.towerId, 0);
        note(b, ok ? `建了 ${action.towerId}` : '金币不足或这里不能建');
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
        note(b, ok ? `优先级：${action.value}` : '设置失败');
        return action;
      }
      case 'repair': {
        const ok = repairTower(b.m, action.slot);
        note(b, ok ? '塔已修复' : '金币不足或无需修复');
        return action;
      }
      // ---- 商店 / 背包 / 物品 ----
      case 'buy': {
        const ok = buyItem(b.m, action.itemId, 0);
        const item = b.model().sheet?.byId?.[`buy-${action.itemId}`];
        note(b, ok ? `买了 ${item?.label ?? action.itemId}` : '买不了（金币不足 / 已买满 / 药品格已满）');
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
      default: return action;
    }
  };

  /** 一次「点」（大厅）：应用选择，并在「单人开局」上真的进局 */
  const tapLobby = (x, y) => {
    const action = hitTestLobby(lobby.layout, x, y);
    const next = stepLobby(lobby.model, action);
    if (next !== lobby.model) lobby.model = next;
    lobby.layout = layoutLobby(size.width, size.height, lobby.model);
    if (action?.type === 'start' && lobby.model.canStart !== false) startMatch();
    return action;
  };

  onTouch((t) => {
    if (t.type !== 'down') return;     // 这一版只要「点」；拖动/双指缩放留给后面
    if (!battle) {
      tapLobby(t.x, t.y);
      drawFrame();
      return;
    }
    tapBattle(battle, t.x, t.y);
    drawFrame();
  });

  const drawFrame = () => {
    const { width, height } = viewport();
    if (`${width}x${height}` !== lastSize) resize();
    if (!battle) { drawLobby(ctx, lobby.model, lobby.layout); return; }
    const b = battle;
    b.layout = layoutBattle(b.model());
    b.renderer.draw({ m: b.m, selectedSlot: null, selectedTower: null, localSlot: 0, now: b.m.time, pulses: false });
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);   // renderer 可能重设过变换，这里再对齐一次
    drawBattleHud(ctx, b.m, b.layout, {
      selectedTower: b.selectedTower,
      message: b.m.time < b.until ? b.message : null,
    });
    // 结算面板：内核出结果之后盖上来（内容是浏览器版那个 resultPanelModel，一份模型两个渲染器）
    recordIfFinished(b);
    if (b.m.result) drawResult(ctx, layoutResult(b.m, b.extra ?? {}));
    // 弹层画在最后（压住 HUD 与战场）：正在建塔 / 看塔面板时，它就是焦点
    drawSheet(ctx, b.model().sheet);
  };

  /** 推进内核（小游戏里由帧循环按真实时间驱动；本地验收里手动调它） */
  const tick = (seconds) => {
    if (!battle) return 0;
    const steps = Math.round(seconds / TICK_STEP);
    for (let i = 0; i < steps && !battle.m.result; i += 1) update(battle.m, TICK_STEP);
    recordIfFinished(battle);
    return steps;
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
    try { saveProfile(next); } catch { /* 存不了就只在这一次生效（§183 的提示在浏览器版那边） */ }
  };

  let last = 0;
  const frame = (ts = 0) => {
    if (battle) {
      const dt = last ? Math.min(0.25, (ts - last) / 1000) : 0;
      if (dt > 0) tick(dt);
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
  canEarly: m.wave.phase === 'prep' && m.wave.timer > 0,
  skills: m.hero.skillUnlocked,
  // 底部那排要显示的数量：药品格数（§5.5.3：共 3 格）与背包件数
  potionCount: potionCount(m),
  bagCount: m.inventory?.length ?? 0,
});

/** 回大厅时保留玩家刚选的模式/地图/难度/英雄（大厅的状态在进局那一刻被 Battle 接管了） */
const pickLobbyKeys = (model) => ({
  mode: model.mode, map: model.map, difficulty: model.difficulty, length: model.length, hero: model.hero,
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
