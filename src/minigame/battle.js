// 小游戏战场那一屏（移植第 3 步的第二屏）：**战场用现成的 render.js，外面这一圈 HUD 用 Canvas 重画**。
//
// 与 lobby.js 同一套写法（布局 / 绘制 / 命中 / 状态四件套，纯函数、零 DOM），
// 区别是战场那边直接复用浏览器版已经验过的等距渲染：`createRenderer(canvas, { size })`。
//
// 这一屏的交互是**简化版**：点塔位 = 用当前选中的塔种建塔（已有塔则升级），点「开波」提前开波，
// 点技能键放技能，点「回大厅」退回去。浏览器版那一套「点塔位 → 轮盘选塔 → 塔面板（升级/出售/优先级）」
// 还没搬过来——真机手感确认之后再决定照搬还是换成更适合拇指的两步式（见 docs/minigame-port.md §5.2）。
import {
  EQUIP_SELL_BONUS_LUMBER, EQUIP_SELL_REFUND, EQUIP_SLOTS, QUALITY, QUALITY_ORDER,
  SHOP_ITEMS, TARGET_PRIORITIES, TOWERS, TOWER_SELL_REFUND,
} from '../data.js';
import { attackHint, resultPanelModel, shopRows, wavePreview } from '../hud-model.js';
import {
  REVIVE_LUMBER, TOWER_REPAIR_GOLD, craftableSlots, enhanceCostOf, potionCount, shopPriceOf, skillLevel,
  towerStatsAt, upgradeCost,
} from '../match.js';

export const DESIGN = { w: 667, h: 375 };
/** 右上角胶囊按钮的禁区（和 lobby 同一条要求） */
export const CAPSULE = { w: 96, h: 32 };
export const TOWER_ORDER = ['tw_arrow', 'tw_cannon', 'tw_frost', 'tw_static'];
export const PRIORITY_LABEL = { front: '最靠前', strongest: '最强', weakest: '最弱', air_first: '空中优先' };
export const POTION_BAG_SLOTS = 3;   // §5.5.3：药品共 3 格（与内核同一个数）
const QUALITY_NAME = Object.fromEntries(Object.entries(QUALITY).map(([k, v]) => [k, v.name ?? k]));
const NEXT_QUALITY = { white: 'blue', blue: 'purple', purple: 'orange' };

const COLORS = {
  panel: 'rgba(12, 20, 34, 0.86)',
  panelLine: 'rgba(120, 170, 230, 0.25)',
  ink: '#e8eef7',
  dim: '#93a4bd',
  accent: '#5aa9e6',
  gold: '#e8c15a',
  wood: '#7fc08a',
  danger: '#d1503f',
};

const roundRect = (ctx, x, y, w, h, r) => {
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

const item = (id, x, y, w, h, label, action, extra = {}) => ({ id, x, y, w, h, label, action, ...extra });

/**
 * 技能键的**数据**（名字 / 解锁 / 冷却 / 等级）：TD 与防守两套 HUD 共用这一份来源——
 * 全部取内核那几个出口（`hero.def.skills` + `thirdSkill`、`skillUnlocked`、`skillCd`、`skillLevel`），
 * 与浏览器版 `ui.js` 的 `renderSkills` 同一套。两边各写一遍的话，
 * 「买了技能书、第三颗键却没出现」那种事就会在另一边再犯一次（§231）。
 */
export const skillKeys = (m) => [...m.hero.def.skills, m.hero.def.thirdSkill].filter(Boolean).map((def, i) => ({
  name: def.name,
  locked: !m.hero.skillUnlocked[i],
  cd: m.hero.skillCd?.[i] ?? 0,
  lv: skillLevel(m, def),
}));

/**
 * 把一句话裁到给定宽度（不够就加省略号）：HUD 上那几行文案的长度取决于**数据表**
 * （怪物名与护甲标签都是可变的），量一量再画比「估个字数」靠谱——小游戏没有 CSS 的 `text-overflow`。
 * 用不上 `measureText` 的假 ctx（Node 用例）会给出按字数估的宽度，行为一致。
 */
const fitText = (ctx, str, maxW) => {
  if (ctx.measureText(str).width <= maxW) return str;
  let cut = str;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxW) cut = cut.slice(0, -1);
  return `${cut}…`;
};

/**
 * 战场 HUD 的布局（设计单位 667×375）。战场本身占满整屏，HUD 是压在上面的浮层：
 * 顶部一条状态栏、底部一排行（塔种 / 开波 / 技能 / 回大厅）。
 */
export function layoutBattle(model = {}) {
  const items = [];
  /**
   * 底部一排（从左到右）：商店 / 背包 / 药品 / 开波（结算时变「再开一局」）/ 技能 1 / 技能 2 / 回大厅。
   * 上一版这里是四个塔种快捷键——建塔改成「点塔位弹面板」之后它们就没用了（同一个决定两个入口），
   * 于是让位给局内真正缺的三个入口。
   */
  items.push(item('shop', 12, 315, 74, 48, '商店', { type: 'shop' }));
  items.push(item('bag', 94, 315, 74, 48, `背包${model.bagCount ? `(${model.bagCount})` : ''}`, { type: 'bag' }));
  items.push(item('potion', 176, 315, 74, 48, `药品 ${model.potionCount ?? 0}/${POTION_BAG_SLOTS}`,
    { type: 'potion' }, { disabled: !model.potionCount }));
  items.push(model.result
    ? item('restart', 258, 315, 92, 48, '再开一局', { type: 'restart' })
    // 奖励写在脸上（浏览器版那颗键就是「提前开波 +3木」）：不然玩家不知道自己为什么要点它
    : item('early', 258, 315, 92, 48, '开波 +3木', { type: 'early' }, { disabled: !model.canEarly }));
  /**
   * 技能键：模型里给几个就画几个（首发 2 个 + 技能书解锁的第 3 个）。**写死两个是不行的**——
   * 商店里卖的「技能书·秘传」会把第三个技能解锁，可按钮不存在的话玩家买了等于白买。
   * 每颗键写：技能名 + 一行副标（冷却中写秒数，否则写等级）——与浏览器版技能键同一套读数（§132）。
   */
  /**
   * 阵亡时这一排换成**一颗「快速复活」**（§7.6）：TD 的英雄一样会被怪打死（`match.js` 里
   * 英雄吃伤害、15 秒 × 人物等级后自动复活），而阵亡时本来就放不了技能——
   * 浏览器版这条只有键盘 `r`（手机上够不着），小游戏给按钮。木材不够就灰掉（内核会再判一次）。
   */
  if (model.hero?.dead) {
    items.push(item('revive', 358, 315, 190, 48, `快速复活 · ${REVIVE_LUMBER} 木`, { type: 'revive' },
      { disabled: (model.lumber ?? 0) < REVIVE_LUMBER }));
  } else {
    const skills = model.skills ?? [{ name: '技能 1' }, { name: '技能 2' }];
    skills.forEach((sk, i) => {
      items.push(item(`skill-${i}`, 358 + i * 66, 315, 58, 48, sk.name ?? `技能 ${i + 1}`,
        { type: 'skill', index: i },
        { disabled: !!sk.locked || sk.cd > 0, sub: sk.cd > 0 ? `${Math.ceil(sk.cd)}s` : (sk.lv ? `Lv${sk.lv}` : '') }));
    });
  }
  items.push(item('lobby', 588, 315, 67, 48, '回大厅', { type: 'lobby' }));
  /**
   * 顶栏右侧那两个键：**倍速**与**暂停**（§1.9.3 的设置、§1.9.4 的「随时能停」）。
   * 位置必须避开右上角胶囊区（官方要求），所以它们放在顶栏与胶囊之间那段空档里，高度给到 44（§1.9.2）。
   */
  items.push(item('speed', 380, 8, 84, 44, model.rate === 2 ? '倍速 2×' : '倍速 1×', { type: 'speed' }, { on: model.rate === 2 }));
  items.push(item('pause', 470, 8, 84, 44, model.paused ? '继续' : '暂停', { type: 'pause' }, { on: !!model.paused }));
  /**
   * 新手引导条（§14.3 稿 11）：压在底排上方，**条本身不吃触摸**——浏览器版那边靠 `.hud` 的
   * `pointer-events: none` 做到同一件事，所以它盖在战场上也不挡点塔位，只有「跳过」那颗键接触摸。
   */
  const tutorial = model.tutorial ?? null;
  if (tutorial) items.push(item('tutorialSkip', 574, 261, 81, 44, '跳过', { type: 'tutorialSkip' }));
  return {
    w: DESIGN.w, h: DESIGN.h,
    capsule: { x: DESIGN.w - CAPSULE.w - 8, y: 6, w: CAPSULE.w, h: CAPSULE.h },
    // 顶栏只到 x=368：右边要留给倍速/暂停两个键（再往右是右上角胶囊区，官方要求避开）
    top: { x: 12, y: 8, w: 356, h: 30 },
    result: { x: 173, y: 120, w: 320, h: 130 },
    // 下一波预告那一行（y=48：顶栏到 38 为止，再往下 60 是提示行；宽度在倍速键 380 之前收住）
    preview: { x: 12, y: 48, w: 360 },
    // 英雄读数（等级 / 阵亡倒计时）：写在 y=48 那一行的右端，右对齐（x 是右边界）
    heroLine: { x: DESIGN.w - 12, y: 48 },
    tutorial: tutorial ? { x: 12, y: 261, w: 643, h: 44, text: tutorial } : null,
    items,
    byId: Object.fromEntries(items.map((it) => [it.id, it])),
  };
}

/** 触点 → HUD 动作（返回 null 表示点在战场空白处，交给调用方翻成「点塔位」） */
export function hitTestBattle(L, x, y) {
  for (const it of L.items) {
    // 只有真正可点的才接：灰按钮（买不起的塔 / 还没解锁的技能）点下去要有反馈，所以仍然命中
    if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return it.action;
  }
  return null;
}

/** 画 HUD（战场本身由 render.js 画，这里只画压在上面的那一圈） */
export function drawBattleHud(ctx, m, L, { selectedTower = 'tw_arrow', message = null, preview = null } = {}) {
  const waveLabel = m.length === 'long' ? `${m.wave.index} / 30 波` : `${m.wave.index} / 12 波`;
  const core = `${Math.round(m.core.hp)}/${m.core.maxHp}`;
  const phase = m.wave.phase === 'prep' ? `备战 ${Math.ceil(m.wave.timer)}s` : '交战中';

  ctx.fillStyle = COLORS.panel;
  roundRect(ctx, L.top.x, L.top.y, L.top.w, L.top.h, 8);
  ctx.fill();
  ctx.strokeStyle = COLORS.panelLine;
  ctx.lineWidth = 1;
  ctx.stroke();
  // 顶栏窄了（让出右边给倍速/暂停），所以这几格的位置跟着收——第一版没收，核心血量被按钮压住了
  text(ctx, `第 ${waveLabel}`, L.top.x + 10, L.top.y + 15, { size: 13, weight: 'bold' });
  text(ctx, phase, L.top.x + 96, L.top.y + 15, { size: 11, color: COLORS.dim });
  text(ctx, `金 ${Math.round(m.gold)}`, L.top.x + 150, L.top.y + 15, { size: 12, color: COLORS.gold });
  text(ctx, `木 ${Math.round(m.lumber?.[0] ?? 0)}`, L.top.x + 210, L.top.y + 15, { size: 12, color: COLORS.wood });
  text(ctx, `核心 ${core}`, L.top.x + 258, L.top.y + 15, { size: 11, color: m.core.hp / m.core.maxHp < 0.35 ? COLORS.danger : COLORS.ink });

  /**
   * 下一波预告（§8.3 / §6.2 的克制博弈）：**开波之前**就要能看出这一波是什么、
   * 护甲是什么、有没有空中——不然「补哪种塔」这个决定只能靠猜。文案由 `wavePreview` 算（一份两处用）。
   */
  if (preview) {
    text(ctx, fitText(ctx, preview, L.preview.w), L.preview.x, L.preview.y, { size: 11, color: COLORS.dim });
  }
  /**
   * 英雄那一格（§14.3 稿 6 压缩成一行，与防守那屏同一个写法）：平时写等级，**阵亡写倒计时**——
   * 不然人躺在地上，界面上一个字都不提还要等多久。写在预告那一行的右端（顶栏已满）。
   */
  if (L.heroLine) {
    const dead = !!m.hero?.dead;
    text(ctx, dead ? `阵亡 ${Math.ceil(m.hero.reviveTimer ?? 0)}s` : `英雄 Lv${m.hero?.level ?? 1}`,
      L.heroLine.x, L.heroLine.y, { size: 11, align: 'right', color: dead ? COLORS.danger : COLORS.dim });
  }

  // 引导条先画底、再画键：`items` 那一轮在它上面（跳过键就压在条的右端）
  if (L.tutorial) {
    ctx.fillStyle = COLORS.panel;
    roundRect(ctx, L.tutorial.x, L.tutorial.y, L.tutorial.w, L.tutorial.h, 8);
    ctx.fill();
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 1;
    ctx.stroke();
    text(ctx, L.tutorial.text, L.tutorial.x + 12, L.tutorial.y + L.tutorial.h / 2, { size: 13 });
  }

  for (const it of L.items) {
    const on = !!it.on;
    ctx.fillStyle = on ? 'rgba(90,169,230,0.24)' : COLORS.panel;
    roundRect(ctx, it.x, it.y, it.w, it.h, 8);
    ctx.fill();
    ctx.strokeStyle = on ? COLORS.accent : COLORS.panelLine;
    ctx.lineWidth = on ? 2 : 1;
    ctx.stroke();
    // 有副标就两行写（技能键的「名字 + Lv/冷却秒数」）；没有副标的键位置与以前一模一样
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    text(ctx, it.label, cx, it.sub ? cy - 9 : cy, {
      size: it.label.length > 3 ? 12 : 13, align: 'center',
      color: it.disabled ? COLORS.dim : COLORS.ink, weight: 'bold',
    });
    if (it.sub) {
      text(ctx, it.sub, cx, cy + 11, { size: 10, align: 'center', color: COLORS.dim });
    }
  }

  if (message) {
    text(ctx, message, L.w / 2, 60, { size: 12, align: 'center', color: COLORS.gold });
  }

  return L;
}

/* ---------- 结算面板 ---------- */

/**
 * 结算面板的几何与文案（纯函数）。
 *
 * **内容全部来自浏览器版那个 `resultPanelModel`**（`hud-model.js`）：结果行、伤害占比、掉落与合成、
 * 声望与人物等级——一份视图模型两个渲染器，省得两边各写一套「本局数据」，也就不会出现
 * 「浏览器里写的是稀有武器 ilvl6、小游戏里印的是 weapon blue15」这种两个面板两种说法（§151 的原话）。
 */
export function layoutResult(m, extra = {}) {
  const model = resultPanelModel(m, extra);
  if (!model) return null;
  const box = { x: 12, y: 62, w: 643, h: 240 };
  return {
    kind: 'result',
    box,
    model,
    rows: model.rows,
    damageLine: model.damage.total > 0
      ? model.damage.rows.slice(0, 4).map((r) => `${r.label} ${Math.round(r.pct * 100)}%`).join(' · ')
      : '',
    // 品质明细来自「手上还有的那些」（合成/穿戴会把它们挪走），所以明细可能是空的——
    // 那时只写件数，别留一个孤零零的「·」
    lootLine: [`掉落 ${model.loot.drops} 件`,
      ...model.loot.byQuality.filter((q) => q.count).map((q) => `${q.name} ${q.count}`)].join(' · '),
    craftLine: model.loot.crafts ? `合成 ${model.loot.crafts} 次` : '',
    equippedLine: model.loot.equipped.length
      ? '已装备：' + model.loot.equipped.map((e) => `${e.qualityName}${e.slotName} ilvl${e.ilvl}`).join(' · ')
      : '',
    repLine: model.reputationGain ? `声望 +${model.reputationGain}` : '',
    levelLine: model.leveledUp ? `人物等级 → ${model.commanderLevel}` : '',
    /**
     * 出口那句话（面板右下角那行小字）要按模式说：防守的底排没有「再开一局」——
     * 它的出口是暂停面板里的「回大厅」，转无尽时则是下面那颗「继续（无尽）」。
     */
    exitHint: model.endless ? '出口在下面：继续（无尽） · 回大厅在暂停面板里'
      : model.mode === 'defense' ? '出口：暂停面板里的「回大厅」 / 再开一局'
        : '出口在下面：再开一局 / 回大厅',
  };
}

/** 画结算面板（出口是底部那排的「再开一局 / 回大厅」，这里只画内容） */
export function drawResult(ctx, R) {
  if (!R) return;
  const { box, model } = R;
  ctx.fillStyle = 'rgba(6,10,18,0.94)';
  roundRect(ctx, box.x, box.y, box.w, box.h, 12);
  ctx.fill();
  ctx.strokeStyle = COLORS.panelLine;
  ctx.lineWidth = 1;
  ctx.stroke();

  text(ctx, model.title, box.x + box.w / 2, box.y + 24, {
    size: 20, weight: 'bold', align: 'center', color: model.win ? COLORS.gold : COLORS.danger,
  });
  // 结果行：两列 × 三行
  model.rows.forEach((row, i) => {
    const col = i % 2, line = Math.floor(i / 2);
    const x = box.x + 20 + col * 308, y = box.y + 56 + line * 22;
    text(ctx, row.label, x, y, { size: 11, color: COLORS.dim });
    text(ctx, row.value, x + 150, y, { size: 12, align: 'right' });
  });
  let y = box.y + 132;
  if (R.damageLine) {
    text(ctx, `伤害占比：${R.damageLine}`, box.x + 20, y, { size: 11, color: COLORS.dim });
    // 一条细横条：按占比切色块，比一串百分号好认
    const barW = box.w - 40, x0 = box.x + 20;
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(x0, y + 10, barW, 6);
    const palette = ['#5aa9e6', '#e8c15a', '#b07de0', '#7fc08a', '#d1503f'];
    let cx = x0;
    model.damage.rows.slice(0, 5).forEach((r, i) => {
      const w = Math.max(1, barW * r.pct);
      ctx.fillStyle = palette[i % palette.length];
      ctx.fillRect(cx, y + 10, w, 6);
      cx += w;
    });
    y += 26;
  }
  text(ctx, [R.lootLine, R.craftLine].filter(Boolean).join(' · '), box.x + 20, y, { size: 11 });
  y += 18;
  if (R.equippedLine) { text(ctx, R.equippedLine, box.x + 20, y, { size: 10, color: COLORS.dim }); y += 18; }
  const rep = [R.repLine, R.levelLine].filter(Boolean).join(' · ');
  if (rep) text(ctx, rep, box.x + 20, y, { size: 12, color: COLORS.gold });
  text(ctx, R.exitHint, box.x + box.w - 20, box.y + box.h - 14,
    { size: 10, color: COLORS.dim, align: 'right' });
}

/* ---------- 弹层：建造选塔 / 塔面板 ---------- */

/**
 * 点塔位之后弹出来的那张**底部面板**（两种：空地→选塔种，已有塔→塔面板）。
 *
 * 为什么不用浏览器版那个**轮盘**：轮盘要绕触点画一圈、拇指得精确瞄准，而小游戏的屏幕更小、
 * 手指更粗。这里先给「两步式」——点塔位 → 面板里选/操作，行高 44pt（§1.9.2）。
 * 真机手感确认之后如果轮盘更顺手，再换（换的时候这一层的四件套不用动）。
 */
export function layoutSheet(m, ui = {}) {
  if (ui?.sheetKind === 'shop') return layoutShop(m, ui);
  if (ui?.sheetKind === 'bag') return layoutBag(m, ui);
  if (ui?.sheetKind === 'item') return layoutItem(m, ui);
  if (ui?.sheetKind === 'pause') return layoutPause(m, ui);
  const slot = ui.panelSlot ?? ui.selectedSlot ?? null;
  if (slot == null) return null;
  const t = m.towers.find((x) => x.slot === slot) ?? null;
  const cell = m.map.slots[slot];
  const rows = [];

  if (!t) {
    // 建造：4 种塔两列排（比单列省一半高度）
    TOWER_ORDER.forEach((id, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      rows.push({
        id: `build-${id}`, label: TOWERS[id].name, sub: `${TOWERS[id].cost} 金`,
        x: 20 + col * 314, y: 96 + row * 50, w: 300, h: 44,
        disabled: m.gold < TOWERS[id].cost,
        action: { type: 'build', slot, towerId: id },
      });
    });
    rows.push({
      id: 'cancel', label: '取消', x: 20, y: 200, w: 614, h: 44, action: { type: 'close' },
    });
    return {
      kind: 'build',
      title: `在这里建塔（第 ${slot + 1} 号塔位 · 金币 ${Math.round(m.gold)}）`,
      hint: cell ? `格 ${cell.x},${cell.y}` : '',
      box: { x: 12, y: 62, w: 643, h: 194 },
      rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])),
    };
  }

  // 塔面板：读数 + 升级 / 出售（两步）/ 优先级 / 修塔（只在攻城图）/ 关闭
  const s = t.stats ?? towerStatsAt(m.map, t.cell, t.towerId, t.level);
  const cost = upgradeCost(t.towerId, t.level);
  const refund = Math.floor(t.invested * TOWER_SELL_REFUND);   // 与内核同一个常数，别手写比例
  const canRepair = !!m.map.def.siege && t.maxHp && t.hp < t.maxHp;
  const info = `Lv${t.level} · 伤害 ${s.damage.toFixed(1)} · 攻速 ${s.atkSpeed.toFixed(2)} · 射程 ${s.range.toFixed(1)}`
    + (s.hitsAir ? ' · 对空' : ' · 不对空') + ` · ${attackHint(s.attackType)}`;

  rows.push({
    id: 'upgrade', label: cost == null ? '已满级' : `升级 → Lv${t.level + 1}`, sub: cost == null ? '' : `${cost} 金`,
    x: 20, y: 96, w: 300, h: 44, disabled: cost == null || m.gold < cost,
    action: { type: 'upgrade', slot },
  });
  rows.push({
    id: 'sell', label: ui.sellArmed ? '确认出售' : '出售', sub: `返还 ${refund} 金`,
    x: 334, y: 96, w: 300, h: 44, danger: !!ui.sellArmed,
    action: { type: 'sell', slot },
  });
  // 竖直节奏跟着「有没有修塔那一行」走：没有它就往上收，不留一条空带（第一版固定坐标，样张里一眼看得出来）
  const prioY = canRepair ? 196 : 146;
  const closeY = canRepair ? 246 : 196;
  if (canRepair) {
    rows.push({
      id: 'repair', label: '修塔', sub: `${TOWER_REPAIR_GOLD} 金`,
      x: 20, y: 146, w: 300, h: 44, disabled: m.gold < TOWER_REPAIR_GOLD,
      action: { type: 'repair', slot },
    });
  }
  TARGET_PRIORITIES.forEach((p, i) => {
    rows.push({
      id: `prio-${p}`, label: PRIORITY_LABEL[p], x: 20 + i * 157, y: prioY, w: 148, h: 44,
      on: t.priority === p, action: { type: 'priority', slot, value: p },
    });
  });
  rows.push({
    id: 'close', label: '关闭', x: 20, y: closeY, w: 614, h: 44,
    action: { type: 'close' },
  });
  return {
    kind: 'tower',
    title: `${TOWERS[t.towerId].name} · Lv${t.level}`,
    hint: info,
    box: { x: 12, y: 62, w: 643, h: canRepair ? 240 : 190 },
    rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}

/* ---------- 商店 / 背包 / 物品详情 ---------- */

const itemLabel = (it) =>
  `${QUALITY_NAME[it.quality] ?? it.quality}${EQUIP_SLOTS[it.slot]?.name ?? it.slot} ilvl${it.ilvl}${it.plus ? ` +${it.plus}` : ''}`;

/**
 * 商店（§5.5）：药品 3 格、技能书；**禁售与买满的写在行上**（§3.1 #20 的口径：撤柜也要说清为什么）。
 * 波次中下单会走 3 秒读条（§5.5）——读条进度写在标题里，玩家不用猜为什么按钮点不动。
 */
export function layoutShop(m, ui = {}) {
  const rows = [];
  /**
   * 「能不能买 / 为什么不能」**直接取浏览器版那份 `shopRows`**（`hud-model.js`）——一份判断两个渲染器。
   * 这一版以前自己重算了一遍，于是漏了两条：**§3.1 #14 的「回基地再买」**（防守局的商店在基地里）
   * 与**木材**（秘传书要木材，只比金币的话点下去才发现买不了，提示还写着「金币不足或已买满」）。
   */
  const cast = m.shopCast ?? null;
  shopRows(m, (id) => shopPriceOf(m, id)).forEach((it, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const price = it.price ?? { gold: 0, lumber: 0 };
    /** 买不了的那句原因（`null` = 只是钱不够）——行上写它，点了买不了时也原样说它 */
    const reason = it.blockedReason ? '已撤柜'
      : it.soldOut ? '已买满'
        : it.bagFull ? '药品格已满'
          : it.tooFar ? '回基地再买' : null;
    const sub = reason ?? (cast && cast.itemId === it.id ? '读条中…'
      : `${price.gold} 金${price.lumber ? ` + ${price.lumber} 木` : ''}`);
    rows.push({
      id: `buy-${it.id}`, label: it.name, sub, reason,
      x: 20 + col * 314, y: 96 + row * 50, w: 300, h: 44,
      disabled: !!it.blockedReason || it.soldOut || it.bagFull || it.tooFar || !it.affordable || !!cast,
      action: { type: 'buy', itemId: it.id },
    });
  });
  const closeY = 96 + Math.ceil(SHOP_ITEMS.length / 2) * 50;
  rows.push({ id: 'close', label: '关闭', x: 20, y: closeY, w: 614, h: 44, action: { type: 'close' } });
  const castLabel = cast ? ` · 读条中 ${Math.max(0, (cast.until ?? 0) - m.time).toFixed(1)}s` : '';
  return {
    kind: 'shop',
    title: `商店 · 金币 ${Math.round(m.gold)}${castLabel}`,
    hint: `药品 ${potionCount(m)}/${POTION_BAG_SLOTS} 格 · 波次中下单读条 3 秒`
      + (m.shopNear ? ' · 商店在基地里' : ''),
    box: { x: 12, y: 62, w: 643, h: closeY - 6 },
    rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}

/**
 * 背包（§5.2/§5.4）：已装备 3 格 + 最近掉落的几件；点一件进「物品详情」。
 * 一屏放得下的件数有限（小游戏屏幕就这么大），所以只列最近的，剩下的在提示行里写清总数。
 */
export function layoutBag(m, ui = {}) {
  const rows = [];
  const equipped = Object.keys(EQUIP_SLOTS).map((s) => m.equipped?.[s]).filter(Boolean);
  const inv = [...(m.inventory ?? [])].reverse();
  const shown = [...equipped.map((it) => ({ it, equipped: true })), ...inv.map((it) => ({ it, equipped: false }))].slice(0, 6);
  shown.forEach(({ it, equipped: isEq }, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    rows.push({
      id: `item-${it.uid}`, label: itemLabel(it), sub: isEq ? '已装备' : `${(it.affixes ?? []).length} 词条`,
      x: 20 + col * 314, y: 96 + row * 50, w: 300, h: 44, on: isEq,
      action: { type: 'item', uid: it.uid },
    });
  });
  if (!shown.length) {
    rows.push({ id: 'empty', label: '还没有掉落', x: 20, y: 96, w: 614, h: 44, disabled: true, action: null });
  }
  const craft = craftableSlots(m)[0];
  const rowY = 96 + Math.max(1, Math.ceil(shown.length / 2)) * 50;
  if (craft) {
    rows.push({
      id: 'craft', label: ui.craftArmed ? '确认合成？' : '一键合成',
      sub: `3 件${QUALITY_NAME[craft.quality]}${EQUIP_SLOTS[craft.slot].name} → 1 件${QUALITY_NAME[NEXT_QUALITY[craft.quality]]}`,
      x: 20, y: rowY, w: 300, h: 44, danger: !!ui.craftArmed,
      action: { type: 'craft', slot: craft.slot, quality: craft.quality },
    });
    rows.push({ id: 'close', label: '关闭', x: 334, y: rowY, w: 300, h: 44, action: { type: 'close' } });
  } else {
    rows.push({ id: 'close', label: '关闭', x: 20, y: rowY, w: 614, h: 44, action: { type: 'close' } });
  }
  return {
    kind: 'bag',
    title: `背包 · ${m.inventory?.length ?? 0} 件（显示最近 ${Math.min(6, shown.length)} 件）`,
    hint: craft ? '' : '攒够 3 件同部位同品质即可一键合成',
    box: { x: 12, y: 62, w: 643, h: rowY + 44 + 12 - 62 },
    rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}

/**
 * 暂停面板（单机局才有意义：联机「不假装暂停」是 §114 那条口径；小游戏现在只有单机，所以这是真暂停）。
 *
 * 每一格都**真的接在东西上**，不是摆样子：
 *   倍速　　→ 帧循环按 1× / 2× 推内核；
 *   镜头　　→ `settings.tdFitAll`（整图可见 / 放大到 settings.zoom），与浏览器版同一份设置（仅 TD）；
 *   摇杆　　→ `settings.stick`（固定 / 浮动），仅防守（§1.9.3）；
 *   音效/震动 → `settings.sfx`：提示音走 `audio.js`、短震动走 `feedback.js` 的 `wx.vibrateShort`；
 *   特效　　→ `settings.effects`：低档关掉脉冲（新手引导塔位高亮的呼吸效果，§116）；
 *   波次预告 / 自动拾取 → 各自模式专有的那一格（§154）。
 * 行距 47（44 高 + 3 缝）是这一屏的**上限**：再松就放不下第 6 行了（333 起的「收起面板」会出画布）。
 */
export function layoutPause(m, ui = {}) {
  const rows = [];
  const sv = ui.settings ?? {};
  /**
   * §154：**设置面板按模式取舍**——防守没有「波次」，也就没有「整图可见 / 放大」这条镜头档
   * （防守是跟随相机，每帧被 `drawDefense` 覆盖，摆上去就是个按了没反应的假选项）；
   * 反过来「摇杆固定 / 浮动」是防守专用的（TD 没有摇杆，§1.9.1）。两边各占同一个格。
   */
  const defense = m.mode === 'defense';
  rows.push({ id: 'resume', label: '继续游戏', x: 20, y: 86, w: 614, h: 44, action: { type: 'resume' } });
  rows.push({
    id: 'speed', label: '倍速', sub: ui.rate === 2 ? '2×' : '1×',
    x: 20, y: 133, w: 300, h: 44, on: ui.rate === 2, action: { type: 'speed' },
  });
  rows.push(defense
    ? {
      id: 'stick', label: '摇杆', sub: sv.stick === 'floating' ? '浮动' : '固定',
      x: 334, y: 133, w: 300, h: 44, on: sv.stick === 'floating', action: { type: 'stick' },
    }
    : {
      id: 'camera', label: '镜头', sub: sv.tdFitAll === false ? '放大' : '整图',
      x: 334, y: 133, w: 300, h: 44, on: sv.tdFitAll === false, action: { type: 'camera' },
    });
  rows.push({
    // 这一格同时管**提示音**（§2.6 的回防预警）与短震动（§1.9.2），所以标签要与浏览器版一样写全
    id: 'sfx', label: '音效/震动', sub: sv.sfx === false ? '关' : '开',
    x: 20, y: 180, w: 300, h: 44, on: sv.sfx !== false, action: { type: 'sfx' },
  });
  /**
   * 「特效」这一格现在**不是假选项**了：低档真的关掉脉冲（§116 的 `hintPulseAlpha`），
   * 而且 §10.7 的内存告警会把这一档自动切过来——玩家得能看见、也能自己改回去。
   */
  rows.push({
    id: 'effects', label: '特效', sub: sv.effects === 'low' ? '低' : '高',
    x: 334, y: 180, w: 300, h: 44, on: sv.effects === 'low', action: { type: 'effects' },
  });
  /**
   * §154：这一格也按模式取舍——TD 摆「波次预告」（§8.3：开波前先看这一波是什么），
   * 防守摆「自动拾取」（§12.5：走到掉落物上自己捡）。两个都真的接着东西，不是摆样子。
   */
  rows.push(defense
    ? {
      id: 'autoPickup', label: '自动拾取', sub: sv.autoPickup === false ? '关' : '开',
      x: 334, y: 227, w: 300, h: 44, on: sv.autoPickup !== false, action: { type: 'autoPickup' },
    }
    : {
      id: 'wavePreview', label: '波次预告', sub: sv.showWavePreview === false ? '关' : '开',
      x: 334, y: 227, w: 300, h: 44, on: sv.showWavePreview !== false, action: { type: 'wavePreview' },
    });
  rows.push({ id: 'lobby', label: '回大厅', x: 20, y: 227, w: 300, h: 44, action: { type: 'lobby' } });
  // §153 的「重看」：门槛只认 `profile.tutorialDone` 这一个标记，「重看」就是把它置回 false（下一局再挂）
  rows.push({
    id: 'replayTutorial', label: '重看新手引导', sub: '下一局生效', x: 20, y: 274, w: 300, h: 44,
    action: { type: 'replayTutorial' },
  });
  // 「重置进度」与「收起面板」并排放在最后一行：前者不可逆（§1.9.2），所以点一次只转到「再点一次确认」
  rows.push({
    id: 'resetProgress', label: ui.resetArmed ? '再点一次确认重置' : '重置进度', sub: ui.resetArmed ? '' : '清空声望与解锁',
    x: 334, y: 274, w: 300, h: 44, on: !!ui.resetArmed, action: { type: 'resetProgress' },
  });
  rows.push({ id: 'close', label: '收起面板', x: 20, y: 321, w: 614, h: 44, action: { type: 'close' } });
  return {
    kind: 'pause',
    title: '已暂停',
    // 防守没有 `m.wave`（那是 TD 的波次表），写「第几轮」——这里曾经直接读 `m.wave.index`，
    // 于是**防守局一按暂停就抛异常**（异常从帧循环里冒出去，画面直接冻在那儿）
    hint: defense
      ? `第 ${m.assault?.round ?? 0} 轮 · 金币 ${Math.round(m.gold)}`
      : `第 ${m.wave.index} / ${m.length === 'long' ? 30 : 12} 波 · 金币 ${Math.round(m.gold)}`,
    box: { x: 12, y: 62, w: 643, h: 311 },
    rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}

/** 物品详情（§5.4 的三个动作：穿上 / 强化 / 出售）——与浏览器版 `actionsRow` 同一套动作 */
export function layoutItem(m, ui = {}) {
  const uid = ui.itemUid;
  const inBag = (m.inventory ?? []).find((x) => x.uid === uid) ?? null;
  const it = inBag ?? Object.values(m.equipped ?? {}).find((x) => x?.uid === uid) ?? null;
  if (!it) return null;
  const rows = [];
  if (inBag) {
    rows.push({
      id: 'equip', label: '穿上', sub: '', x: 20, y: 96, w: 614, h: 44,
      action: { type: 'equip', uid },
    });
  }
  const cost = enhanceCostOf(it);
  // 返还比例与「紫装以上多给木材」都取内核那两个常数（§5.4），别在这里手写一份
  const refund = Math.floor((it.invested ?? 0) * EQUIP_SELL_REFUND);
  const bonus = QUALITY_ORDER.indexOf(it.quality) >= QUALITY_ORDER.indexOf('purple')
    ? ` + ${EQUIP_SELL_BONUS_LUMBER} 木` : '';
  rows.push({
    id: 'enhance', label: cost == null ? '强化已满级' : `强化 +${(it.plus ?? 0) + 1}`,
    sub: cost == null ? '' : `${cost} 金`,
    x: 20, y: inBag ? 146 : 96, w: 300, h: 44, disabled: cost == null || m.gold < cost,
    action: { type: 'enhance', uid },
  });
  rows.push({
    id: 'sell', label: ui.sellArmed ? '确认出售' : '出售', sub: `返还 ${refund} 金${bonus}`,
    x: 334, y: inBag ? 146 : 96, w: 300, h: 44, danger: !!ui.sellArmed,
    action: { type: 'sellItem', uid },
  });
  rows.push({ id: 'close', label: '关闭', x: 20, y: inBag ? 196 : 146, w: 614, h: 44, action: { type: 'close' } });
  const closeBox = inBag ? 196 : 146;
  return {
    kind: 'item',
    title: itemLabel(it),
    hint: `词条 ${(it.affixes ?? []).length}`,
    box: { x: 12, y: 62, w: 643, h: closeBox + 44 + 12 - 62 },
    rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])),
  };
}

/** 弹层上的命中测试（弹层开着时，触点先问它） */
export function hitTestSheet(sheet, x, y) {
  if (!sheet) return null;
  for (const r of sheet.rows) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.action;
  }
  return { type: 'close' };   // 点弹层空白处 = 关掉（比"必须点准关闭"友好）
}

/** 画弹层 */
export function drawSheet(ctx, sheet) {
  if (!sheet) return;
  const b = sheet.box;
  ctx.fillStyle = 'rgba(6,10,18,0.94)';
  roundRect(ctx, b.x, b.y, b.w, b.h, 12);
  ctx.fill();
  ctx.strokeStyle = COLORS.panelLine;
  ctx.lineWidth = 1;
  ctx.stroke();
  text(ctx, sheet.title, b.x + 12, b.y + 18, { size: 13, weight: 'bold' });
  if (sheet.hint) text(ctx, sheet.hint, b.x + b.w - 12, b.y + 18, { size: 11, color: COLORS.dim, align: 'right' });
  for (const r of sheet.rows) {
    ctx.fillStyle = r.on ? 'rgba(90,169,230,0.24)' : (r.danger ? 'rgba(209,80,63,0.28)' : 'rgba(18,28,44,0.92)');
    roundRect(ctx, r.x, r.y, r.w, r.h, 8);
    ctx.fill();
    ctx.strokeStyle = r.on ? COLORS.accent : (r.danger ? COLORS.danger : COLORS.panelLine);
    ctx.lineWidth = r.on || r.danger ? 2 : 1;
    ctx.stroke();
    const dim = r.disabled ? COLORS.dim : (r.danger ? COLORS.danger : COLORS.ink);
    if (r.sub) {
      text(ctx, r.label, r.x + 12, r.y + r.h / 2, { size: 13, color: dim });
      text(ctx, r.sub, r.x + r.w - 12, r.y + r.h / 2, { size: 11, color: r.disabled ? COLORS.dim : COLORS.gold, align: 'right' });
    } else {
      text(ctx, r.label, r.x + r.w / 2, r.y + r.h / 2, { size: 13, color: dim, align: 'center' });
    }
  }
}
