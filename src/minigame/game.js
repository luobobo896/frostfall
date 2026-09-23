// 微信小游戏入口（移植第 2 步：整包能装起来、内核能在 wx 环境里跑）。
//
// **这一步还不能玩**：小游戏没有 DOM，而我们的界面（大厅 / HUD / 结算 / 商店…）现在是
// `index.html` + `styles.css` + `ui.js` 那套 DOM+CSS。这一步做的是把**平台差异**与**打包**解决掉，
// 并把不依赖 DOM 的那一大半（内核、数据表、存档、联机协议、平台适配）先在小游戏里跑通。
// 界面换 Canvas 是第 3 步，见 docs/minigame-port.md。
import { TICK_STEP } from '../data.js';
import { DEFENSE_MAPS, MAPS } from '../data.js';
import { buildTower, castSkill, createMatch, describe as describeMatch, startWaveEarly, towerAtSlot, update, upgradeTower } from '../match.js';
import { createDefenseMatch, describeDefense, updateDefense } from '../defense.js';
import { isMiniGame, onTouch, storage, viewport } from '../platform.js';
import { loadProfile, mapLocked, unlockedMaps } from '../profile.js';
import { createRenderer } from '../render.js';
import { applyLobbyAction, drawLobby, hitTestLobby, layoutLobby } from './lobby.js';
import { drawBattleHud, hitTestBattle, layoutBattle } from './battle.js';

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
    });
    const renderer = createRenderer(canvas, { size: () => ({ w: size.width, h: size.height }) });
    renderer.fit(m.map.grid);
    const b = { m, renderer, selectedTower: 'tw_arrow', message: null, until: 0, layout: null };
    b.model = () => ({ ...describeBattleModel(m), selectedTower: b.selectedTower });
    b.layout = layoutBattle(b.model());
    battle = b;
    return b;
  };

  const backToLobby = () => {
    battle = null;
    lobby = { model: { ...createLobbyModel(), ...pickLobbyKeys(lobby.model) }, layout: null };
    lobby.layout = layoutLobby(size.width, size.height, lobby.model);
  };

  const note = (m, text, seconds = 1.6) => { m.message = text; m.until = m.m.time + seconds; };

  /** 一次「点」：先问 HUD，再问战场（翻成最近的塔位） */
  const tapBattle = (b, x, y) => {
    const action = hitTestBattle(b.layout, x, y);
    if (action) {
      switch (action.type) {
        case 'tower': b.selectedTower = action.value; note(b, `选中 ${action.label}（${action.cost} 金）`, 1.2); return action;
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
      const ok = upgradeTower(b.m, best);
      note(b, ok ? `升级到 ${existing.level + 1} 级` : '金币不足或已满级');
      return { type: 'upgrade', slot: best };
    }
    const ok = buildTower(b.m, best, b.selectedTower, 0);
    note(b, ok ? `建了 ${b.selectedTower}` : '金币不足或这里不能建');
    return { type: 'build', slot: best };
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
  };

  /** 推进内核（小游戏里由帧循环按真实时间驱动；本地验收里手动调它） */
  const tick = (seconds) => {
    if (!battle) return 0;
    const steps = Math.round(seconds / TICK_STEP);
    for (let i = 0; i < steps && !battle.m.result; i += 1) update(battle.m, TICK_STEP);
    return steps;
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
