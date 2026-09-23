// 小游戏大厅（移植第 3 步的第一屏）：**纯 Canvas 绘制 + 命中测试，零 DOM**。
//
// 为什么先做这一屏：界面从 DOM+CSS 换成 Canvas 是移植里唯一的大头，先做一屏看观感、
// 再决定其余 10 屏怎么切（见 docs/minigame-port.md §5）。所以这一层刻意写成**纯函数式**：
//   layoutLobby(w, h, model)   → 布局（每个可点元素一个矩形 + 动作）
//   drawLobby(ctx, model, L)   → 画一帧
//   hitTestLobby(L, x, y)      → 触点落在哪个动作上
//   applyLobbyAction(model, …) → 把动作应用成新模型（含解锁校验）
// 于是它能在 Node 里用「记录型 ctx」测（tests/minigame-lobby.test.js），也能在浏览器里截图看。
//
// 坐标：全部按**逻辑像素**（= 小游戏里的 pt，`wx.getWindowInfo().windowWidth/Height`），
// 以 667×375（§14.3 的设计画布）为基准等比缩放并居中 —— §1.9.2 的 44pt 热区下限在这一层直接成立。
import { DEFENSE_MAPS, HEROES, MAPS } from '../data.js';
import { drawMapThumb } from '../render.js';

export const DESIGN = { w: 667, h: 375 };
/** 右上角胶囊按钮要留出来的区域（官方布局要求：关键 UI 避开它） */
export const CAPSULE = { w: 96, h: 32 };

const COLORS = {
  bg: '#05080e',
  panel: 'rgba(12, 20, 34, 0.82)',
  panelLine: 'rgba(120, 170, 230, 0.25)',
  ink: '#e8eef7',
  dim: '#93a4bd',
  accent: '#5aa9e6',
  gold: '#e8c15a',
  locked: 'rgba(20, 28, 44, 0.72)',
};

const HERO_ROLE = { hero_warrior: '前排', hero_mage: '法术', hero_ranger: '远程', hero_paladin: '辅助' };
const DIFF_LABEL = { normal: '普通', hard: '困难', nightmare: '噩梦' };

/** 一个可点元素：`x/y/w/h` 是设计单位，动作由 `action` 描述 */
const btn = (id, x, y, w, h, label, action, extra = {}) => ({ id, x, y, w, h, label, action, ...extra });

/**
 * 算出这一屏的布局。`w/h` 是逻辑像素；返回的所有矩形都已经是**画布坐标**（缩放 + 居中之后），
 * 所以调用方直接画、直接命中测试，不用再算一次缩放。
 */
export function layoutLobby(w, h, model = {}) {
  const s = Math.min(w / DESIGN.w, h / DESIGN.h);
  const ox = (w - DESIGN.w * s) / 2;
  const oy = (h - DESIGN.h * s) / 2;
  const map = (x, y, rw, rh) => ({ x: ox + x * s, y: oy + y * s, w: rw * s, h: rh * s });

  const mode = model.mode ?? 'td';
  const table = mode === 'defense' ? DEFENSE_MAPS : MAPS;
  const raw = [];   // 先按设计单位（667×375）摆，最后统一 scale+居中成画布坐标

  // 所有可点元素都给到 **≥44×44**（§1.9.2 的热区下限；浏览器版当初就是因为 `.btn.small` 36px 被收过一次）
  raw.push(btn('mode-td', 24, 84, 78, 44, 'TD 塔防', { type: 'mode', value: 'td' }, { on: mode === 'td' }));
  raw.push(btn('mode-def', 110, 84, 78, 44, '防守生存', { type: 'mode', value: 'defense' }, { on: mode === 'defense' }));
  ['normal', 'hard', 'nightmare'].forEach((d, i) => {
    raw.push(btn(`diff-${d}`, 24 + i * 66, 134, 60, 44, DIFF_LABEL[d], { type: 'difficulty', value: d }, { on: model.difficulty === d }));
  });
  if (mode === 'td') {
    raw.push(btn('len-short', 24, 184, 92, 44, '12 波', { type: 'length', value: 'short' }, { on: (model.length ?? 'short') === 'short' }));
    raw.push(btn('len-long', 122, 184, 108, 44, '长局 30 波', { type: 'length', value: 'long' }, { on: model.length === 'long' }));
  }

  Object.keys(HEROES).forEach((id, i) => {
    raw.push(btn(`hero-${id}`, 24 + i * 76, 236, 70, 52, HEROES[id].name, { type: 'hero', value: id },
      { on: model.hero === id, sub: HERO_ROLE[id] ?? '' }));
  });

  Object.keys(table).forEach((id, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    raw.push(btn(`map-${id}`, 348 + col * 152, 84 + row * 68, 144, 62, table[id].name,
      { type: 'map', value: id },
      {
        on: model.map === id, locked: !!model.locked?.[id], stars: table[id].stars,
        lanes: mode === 'defense' ? `${DEFENSE_MAPS[id].assaultSpawns.length} 条进攻路线`
          : `${MAPS[id].pathCount} 条路${MAPS[id].airPath ? ' + 1 空中' : ''}`,
        thumb: { mode, mapId: id },
      }));
  });

  // 开始按钮：战斗场景还没接上，**按钮上就写明**（不给一个点了没反应的假按钮）
  // 有存档时右边再挤一个「继续上局」（§10.3：杀进程重开进度不丢）——两个都 ≥44 高
  const startW = model.canContinue ? 190 : 296;
  raw.push(btn('start', 348, 306, startW, 48,
    model.canStart ? '单人开局' : '单人开局（第 4 步接入）', { type: 'start' }, { disabled: !model.canStart }));
  if (model.canContinue) {
    raw.push(btn('continue', 546, 306, 98, 48, model.continueLabel ?? '继续上局', { type: 'continue' }));
  }

  // 统一映射：设计单位 → 画布坐标（等比缩放 + 居中）。命中测试与绘制都用这一份，天然同源。
  const items = raw.map((it) => ({ ...it, ...map(it.x, it.y, it.w, it.h) }));

  return {
    w, h, s, ox, oy,
    capsule: map(DESIGN.w - CAPSULE.w - 8, 6, CAPSULE.w, CAPSULE.h),
    title: map(24, 18, 300, 30),
    subtitle: map(24, 48, 320, 16),
    profile: map(24, 64, 320, 16),
    // 提示区：三行 10px 文案 + 一点余量，**整块在画布内**（第一版贴到底边，第三行被切了）
    hint: map(24, 300, 316, 56),
    items,
    byId: Object.fromEntries(items.map((it) => [it.id, it])),
  };
}

/** 触点 → 动作（画布坐标，与画出来的位置同源）。返回 null 表示点空白。 */
export function hitTestLobby(L, x, y) {
  for (const it of L.items) {
    if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return it.action;
  }
  return null;
}

const roundRect = (ctx, x, y, w, h, r) => {
  // 小游戏 Canvas 的 `roundRect()` 不保证存在，所以手画（社区 skill 与官方示例都建议这样）
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
};

const text = (ctx, str, x, y, { size = 12, color = COLORS.ink, weight = '', align = 'left' } = {}) => {
  ctx.fillStyle = color;
  ctx.font = `${weight ? `${weight} ` : ''}${size}px "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(str, x, y);
};

export const DEFAULT_HINT = [
  '移植第 3 步：大厅 + 战场都跑在 Canvas 上',
  '可点：模式 / 难度 / 时长 / 英雄 / 地图',
  '「单人开局」进局：点塔位建塔、点「开波」开打',
];

/** 画一帧（纯绘制，不改模型） */
export function drawLobby(ctx, model, L) {
  const S = (v) => v * L.s;
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, L.w, L.h);

  text(ctx, '冰封之地', L.title.x, L.title.y + S(14), { size: S(26), weight: 'bold' });
  text(ctx, '碎片时间的一局 · 守住所剩不多的核心', L.subtitle.x, L.subtitle.y + S(7), { size: S(11), color: COLORS.dim });
  const p = model.profile ?? {};
  text(ctx, `人物 Lv${p.commanderLevel ?? 1} · 声望 ${p.reputation ?? 0} · 可玩地图 ${model.unlockedCount ?? 0} 张`,
    L.profile.x, L.profile.y + S(7), { size: S(11), color: COLORS.dim });

  for (const it of L.items) {
    const on = !!it.on;
    const dim = !!it.locked || !!it.disabled;
    const isCard = it.id.startsWith('map-') || it.id.startsWith('hero-') || it.id === 'start';
    const radius = S(isCard ? 8 : 6);
    ctx.fillStyle = on ? 'rgba(90,169,230,0.22)' : (isCard ? COLORS.panel : 'rgba(12,20,34,0.66)');
    roundRect(ctx, it.x, it.y, it.w, it.h, radius);
    ctx.fill();
    ctx.strokeStyle = on ? COLORS.accent : COLORS.panelLine;
    ctx.lineWidth = Math.max(1, S(on ? 2 : 1));
    ctx.stroke();
    if (dim) {
      ctx.fillStyle = COLORS.locked;
      roundRect(ctx, it.x, it.y, it.w, it.h, radius);
      ctx.fill();
    }

    if (it.thumb) {
      const pad = S(4);
      const th = { x: it.x + pad, y: it.y + pad, w: it.w - pad * 2, h: S(34) };
      ctx.save();
      roundRect(ctx, th.x, th.y, th.w, th.h, S(5));
      ctx.clip();
      ctx.translate(th.x, th.y);
      // 复用 render.js 的俯视平面画法：传 surface 就按逻辑单位直接画进这张卡
      drawMapThumb(null, it.thumb.mode, it.thumb.mapId, { ctx, w: th.w, h: th.h });
      ctx.restore();
      text(ctx, `${it.label} ${'★'.repeat(it.stars ?? 1)}`, th.x, th.y + th.h + S(11), { size: S(11) });
      text(ctx, it.lanes ?? '', th.x, th.y + th.h + S(22), { size: S(9), color: COLORS.dim });
      if (it.locked) {
        text(ctx, '未解锁', th.x + th.w - S(4), th.y + th.h + S(11), { size: S(10), color: COLORS.gold, align: 'right' });
      }
      continue;
    }
    if (it.id.startsWith('hero-')) {
      text(ctx, it.label, it.x + it.w / 2, it.y + it.h * 0.36, { size: S(12), align: 'center' });
      text(ctx, it.sub ?? '', it.x + it.w / 2, it.y + it.h * 0.68, { size: S(10), color: COLORS.dim, align: 'center' });
      continue;
    }
    text(ctx, it.label, it.x + it.w / 2, it.y + it.h / 2, {
      size: S(it.id === 'start' ? 16 : 12), align: 'center',
      color: it.disabled ? COLORS.dim : (it.id === 'start' ? COLORS.gold : COLORS.ink),
      weight: it.id === 'start' ? 'bold' : '',
    });
  }

  // 提示区**裁一下再画**：文案长了就让它被裁掉，绝不能压到右边那颗「单人开局」上
  // （第一版就是没裁 + 文案过长，截图里直接把按钮盖住了）
  ctx.save();
  ctx.beginPath();
  ctx.rect(L.hint.x, L.hint.y, L.hint.w, L.hint.h);
  ctx.clip();
  (model.hint ? model.hint.split('\n') : DEFAULT_HINT)
    .forEach((line, i) => text(ctx, line, L.hint.x, L.hint.y + S(9 + i * 15), { size: S(10), color: COLORS.dim }));
  ctx.restore();
  return L;
}

/**
 * 把「点了一下」应用成模型变化（含解锁校验）。纯函数：同样的输入永远同样的输出，方便测。
 * `unlocked` / `lockedReason` 由调用方从档案里取（profile.js 的 `unlockedMaps` / `mapLocked`）。
 */
export function applyLobbyAction(model, action, { unlocked = [], lockedReason = {} } = {}) {
  if (!action) return model;
  const next = { ...model };
  switch (action.type) {
    case 'mode': {
      if (next.mode === action.value) return model;
      next.mode = action.value;
      // 切模式要换地图清单，并落回该模式里**已解锁**的第一张（与浏览器大厅同一条规则）
      const pool = (action.value === 'defense' ? Object.keys(DEFENSE_MAPS) : Object.keys(MAPS))
        .filter((id) => unlocked.includes(id));
      next.map = pool[0] ?? (action.value === 'defense' ? 'def_01' : 'map_01');
      /**
       * 防守模式的战场还没搬过来（那要连摇杆、跟随相机、HUD 一起做，见 docs/minigame-port.md §5.2），
       * 所以「单人开局」在防守模式下是**明写着为什么不行**，而不是点了没反应。
       */
      next.canStart = action.value !== 'defense';
      next.hint = next.canStart ? null : '防守模式的战场还没接过来（下一步）：先玩 TD 塔防。';
      return next;
    }
    case 'difficulty': next.difficulty = action.value; return next;
    case 'length': next.length = action.value; return next;
    case 'hero': next.hero = action.value; return next;
    case 'map': {
      if (!unlocked.includes(action.value)) {
        const name = (MAPS[action.value] ?? DEFENSE_MAPS[action.value])?.name ?? action.value;
        next.hint = `「${name}」还没解锁：${lockedReason[action.value] ?? '先打前面的图'}`;
        return next;
      }
      next.map = action.value;
      next.hint = null;
      return next;
    }
    case 'start': {
      if (!next.canStart) {
        next.hint = next.mode === 'defense'
          ? '防守模式的战场还没接过来（下一步）：先玩 TD 塔防。'
          : '战斗场景还没接上：内核已经能在小游戏里跑，渲染还没挂上去。';
        return next;
      }
      next.started = true;
      return next;
    }
    case 'continue': {
      // 交给 app 处理（它才知道怎么把存档装进战场）；这里只把意图记下来
      if (!next.canContinue) { next.hint = '没有可以继续的一局'; return next; }
      next.continueRequested = true;
      return next;
    }
    default: return model;
  }
}
