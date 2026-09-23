// 小游戏防守那一屏（§12.5 / §2.6）：摇杆数学、HUD 布局、工事面板，以及「推着走 → 建工事 → 回城」的闭环。
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installFakeWx } from '../tools/fake-wx.mjs';
import {
  DESIGN, MINIMAP, SKILL_BAR, STICK, drawDefenseHud, hitTestDefense, inStickZone,
  layoutDefense, layoutFortSheet, stickBase, stickVector,
} from '../src/minigame/defense-screen.js';
import { REVIVE_LUMBER } from '../src/match.js';
import { createDefenseMatch } from '../src/defense.js';
import { DEFENSE_RULES, FORTS } from '../src/data.js';
import { gridDist } from '../src/core.js';

const OUT = mkdtempSync(join(tmpdir(), 'ff-mini-defense-'));
process.env.FF_MINIGAME_OUT = OUT;

/** 复制成新文件名再 require：ESM 缓存按路径走，于是每条用例都能拿到一个**全新的大厅开局** */
const loadFreshApp = (require, n) => {
  const p = join(OUT, `game-${n}.js`);
  copyFileSync(join(OUT, 'game.js'), p);
  require(p);
  return globalThis.__frostfallLobby;
};

/**
 * 找一块**战场空地**：x 落在「固定档有效区」与「浮动档有效区」之间那道夹缝里
 * （0.45×667 = 300 到 0.5×667 = 333.5），y 在下半屏；不在任何 HUD 键上，也离工事位与基地 ≥2 格。
 * 用同一个点在两种档位各点一次，才能干净地量出「有效区变了」这件事。
 */
const fieldPoint = (app, m) => {
  const r = app.renderer();
  const L = app.layout();
  for (let y = 200; y < 310; y += 5) {
    for (let x = 305; x <= 330; x += 5) {
      if (hitTestDefense(L, x, y)) continue;
      const c = r.toGrid(x, y);
      if (c.x < 0 || c.y < 0 || c.x >= m.grid.w || c.y >= m.grid.h) continue;
      if (m.def.fortSlots.some((s) => gridDist(s, c) <= 2)) continue;
      if (gridDist(m.castle.cell, c) <= 2) continue;
      return { x, y };
    }
  }
  throw new Error('这块屏上找不到一块战场空地');
};

const base = () => ({ x: 100, y: 300, r: STICK.radius, floating: false });

/** 记录型 ctx：够断言「这一帧画了什么字」 */
const fakeCtx = () => {
  const texts = [];
  const state = {};
  return new Proxy(state, {
    get(t, p) {
      if (p === 'texts') return texts;
      if (p in state) return state[p];
      return (...args) => {
        if (p === 'fillText') texts.push(String(args[0]));
        if (p === 'measureText') return { width: String(args[0] ?? '').length * 6 };
        return undefined;
      };
    },
    set(t, p, v) { state[p] = v; return true; },
  });
};

test('小游戏摇杆：死区内不动、推满夹紧、方向单位化（与 joystick.js 同一套规则）', () => {
  const b = base();
  assert.deepEqual(stickVector(b, b.x + 4, b.y + 2), { x: 0, y: 0, mag: 0 }, '死区内算没推');
  const half = stickVector(b, b.x + 32, b.y);
  assert.ok(Math.abs(half.mag - 0.5) < 0.01 && half.x === 1 && half.y === 0, `推一半是 0.5（实际 ${half.mag.toFixed(2)}）`);
  const full = stickVector(b, b.x + 300, b.y);
  assert.equal(full.mag, 1, '推出去多远都夹在 1');
  const diag = stickVector(b, b.x + 100, b.y + 100);
  assert.ok(Math.abs(Math.hypot(diag.x, diag.y) - 1) < 1e-6, '方向是单位向量');
  assert.deepEqual(stickVector(b, b.x, b.y), { x: 0, y: 0, mag: 0 }, '正中心不推');
});

test('小游戏防守 HUD：右侧那排避开摇杆区、避开胶囊区、热区 ≥44', () => {
  const m = createDefenseMatch({ seed: 5 });
  const L = layoutDefense(m, { rate: 1, paused: false, potionCount: 1 });
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const it of L.items) {
    assert.ok(it.w >= 44 && it.h >= 44, `${it.id} 热区 ${it.w}×${it.h} 小于 44`);
    assert.ok(it.x + it.w <= DESIGN.w && it.y + it.h <= DESIGN.h, `${it.id} 出界`);
    assert.ok(!hit(it, L.capsule), `${it.id} 压到胶囊区`);
  }
  // 摇杆区在左半屏；右侧那排按钮不该落在它里面（否则一按就变成推摇杆）
  for (const it of L.items) {
    assert.ok(!inStickZone(L, it.x + it.w / 2, it.y + it.h / 2), `${it.id} 落进了摇杆区`);
  }
  assert.ok(inStickZone(L, 100, 300), '左下角该归摇杆');
  assert.ok(!inStickZone(L, 500, 300), '右半屏不该归摇杆');
  assert.deepEqual(stickBase({}, { w: 667, h: 375 }), { x: 107, y: 293, r: 64, floating: false });
  assert.equal(stickBase({ stickOrigin: { x: 200, y: 200 }, stickFloating: true }, { w: 667, h: 375 }).x, 200, '浮动模式底座跟手指');
});

test('小游戏防守 HUD：小地图那一格（§2.6）——不压右排/不压顶栏、点它=回城', () => {
  const m = createDefenseMatch({ seed: 5 });
  const L = layoutDefense(m, { rate: 1, paused: false, potionCount: 1 });
  assert.ok(L.minimap, '防守要有小地图那一块');
  assert.equal(MINIMAP.w >= 44 && MINIMAP.h >= 44, true, '它本身也是可点区域，要 ≥44');
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.ok(!hit(L.minimap, L.capsule), '小地图压到右上角胶囊区');
  assert.ok(!hit(L.minimap, L.top), '小地图压到顶栏');
  for (const it of L.items) {
    if (it.id === 'minimap') continue;
    assert.ok(!hit(L.minimap, it), `小地图压到了 ${it.id}`);
  }
  // 那一格在 items 里，动作就是「回城」（与那颗按钮同一个出口）
  const cell = L.byId.minimap;
  assert.deepEqual(cell.action, { type: 'teleport' });
  assert.deepEqual(hitTestDefense(L, cell.x + cell.w / 2, cell.y + cell.h / 2), { type: 'teleport' });
});

test('小游戏工事面板：两种工事 + 取消，买不起的灰掉', () => {
  const m = createDefenseMatch({ seed: 5 });
  const sheet = layoutFortSheet(m, { freeSlots: m.def.fortSlots.length });
  assert.equal(sheet.kind, 'fort');
  assert.equal(sheet.rows.length, Object.keys(FORTS).length + 1, '两种工事 + 取消');
  for (const f of Object.values(FORTS)) {
    const row = sheet.byId[`fort-${f.id}`];
    assert.ok(row, `少了 ${f.id}`);
    assert.match(row.sub, /金$/);
  }
  m.gold = 10;
  const poor = layoutFortSheet(m, { freeSlots: 1 });
  assert.ok(Object.values(FORTS).every((f) => poor.byId[`fort-${f.id}`].disabled), '钱不够两种工事都该灰');
});

test('小游戏防守闭环：摇杆推着走 → 点工事位建塔 → 回城（在假 wx 里真跑）', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 2);
    const tapBtn = (id) => {
      const b = app.layout().byId[id];
      assert.ok(b, `HUD 上找不到 ${id}`);
      return app.tap(b.x + b.w / 2, b.y + b.h / 2);
    };
    tapBtn('mode-def');
    tapBtn('start');
    const m = app.match();
    assert.equal(app.screen(), 'battle');
    assert.equal(m.mode, 'defense');
    assert.equal(m.mapId, 'def_01');

    // 摇杆：左下推一下就该开始走
    const from = { ...m.hero.cell };
    fake.fireTouch(120, 300, 'down');
    fake.fireTouch(210, 230, 'move');
    assert.equal(app.getModel().stick.active, true, '左侧 45% 的拖动要归摇杆');
    app.tick(4);
    assert.notDeepEqual(m.hero.cell, from, `推着走该动（还在 ${JSON.stringify(m.hero.cell)}）`);
    fake.fireTouch(210, 230, 'up');
    app.tick(3);
    assert.equal(m.hero.path.length, 0, '松手之后不再重发移动指令');

    // 工事：点战场上的工事位 → 选箭塔 → 真建出来
    const p = app.renderer().toScreen(m.def.fortSlots[0].x, m.def.fortSlots[0].y);
    assert.equal(app.tap(p.x, p.y).type, 'openFort');
    const arrow = app.getModel().sheet.byId['fort-fort_arrow'];
    const gold0 = m.gold;
    app.tap(arrow.x + arrow.w / 2, arrow.y + arrow.h / 2);
    assert.equal(m.forts.length, 1, '工事要真的建出来');
    assert.equal(m.gold, gold0 - FORTS.fort_arrow.cost, `扣 ${FORTS.fort_arrow.cost} 金`);
    assert.equal(app.getModel().sheet, null, '建完关掉面板');

    // 回城 + 暂停
    assert.equal(tapBtn('teleport').type, 'teleport');
    assert.ok(m.hero.teleportCd > 0, '回城要进 30 秒冷却');
    assert.ok(Math.abs(m.hero.cell.x - m.castle.cell.x) <= 3, '人要落在基地附近');
    tapBtn('pause');
    const t0 = m.time;
    app.tick(10);
    assert.equal(m.time, t0, '暂停时防守内核也不走');
    /**
     * 暂停面板**画出来**（以前这一步会抛：`layoutPause` 的提示行读的是 TD 的 `m.wave.index`，
     * 而防守局没有 `m.wave`——异常从帧循环里冒出去，画面就冻在那一帧）。
     * §154 那条也在这一屏上：防守摆「摇杆」、不摆「镜头」（跟随相机，改了没用）。
     */
    app.drawFrame();
    const sheet = app.getModel().sheet;
    assert.equal(sheet.kind, 'pause');
    assert.match(sheet.hint, /第 \d+ 轮/, '防守写「第几轮」而不是波次');
    assert.ok(sheet.byId.stick, '防守的设置里有「摇杆」');
    assert.ok(!sheet.byId.camera, '防守不摆「镜头」这个假选项');
  } finally { fake.uninstall(); }
});

test('小游戏防守：摇杆切「浮动」之后左半屏都归摇杆、底座跟手（§1.9.3 的固定 / 浮动）', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 3);
    const tapBtn = (id) => {
      const b = app.layout().byId[id];
      assert.ok(b, `HUD 上找不到 ${id}`);
      return app.tap(b.x + b.w / 2, b.y + b.h / 2);
    };
    const tapSheet = (id) => {
      const r = app.getModel().sheet.byId[id];
      assert.ok(r, `面板上找不到 ${id}`);
      return app.tap(r.x + r.w / 2, r.y + r.h / 2);
    };
    tapBtn('mode-def');
    tapBtn('start');
    const m = app.match();

    // 固定档（默认）：这一块在「左下 45%」（0.45 × 667 = 300）之外，所以不归摇杆，是「点地移动」
    const p = fieldPoint(app, m);
    fake.fireTouch(p.x, p.y, 'down');
    assert.equal(app.getModel().stick.active, false, '固定档下 45% 之外不该归摇杆');
    assert.equal(app.tap(p.x, p.y).type, 'move', '那一下仍然是「点地移动」');
    fake.fireTouch(p.x, p.y, 'up');

    // 切浮动：设置落盘 + 面板读数跟着变
    tapBtn('pause');
    assert.equal(app.getModel().sheet.byId.stick.sub, '固定');
    tapSheet('stick');
    assert.equal(JSON.parse(globalThis.wx.getStorageSync('frostfall:settings') || '{}').stick, 'floating');
    assert.equal(app.getModel().sheet.byId.stick.sub, '浮动', '切完面板要显示浮动');
    tapSheet('resume');

    // 浮动档：左半屏（50%）都归摇杆，而且**底座跟手指**
    fake.fireTouch(p.x, p.y, 'down');
    const st = app.getModel().stick;
    assert.equal(st.active, true, '浮动档下左半屏该归摇杆');
    assert.equal(Math.round(st.origin.x), p.x, '浮动底座要跟到手指那一点');
    assert.equal(Math.round(st.origin.y), p.y);
    const from = { ...m.hero.cell };
    fake.fireTouch(p.x + 100, p.y, 'move');
    app.tick(4);
    assert.notDeepEqual(m.hero.cell, from, `浮动摇杆推着也该走（还在 ${JSON.stringify(m.hero.cell)}）`);
    fake.fireTouch(p.x + 100, p.y, 'up');
  } finally { fake.uninstall(); }
});

test('小游戏防守：守住 4 轮转无尽之后，「继续（无尽）」真的能接着玩（§131 / §190）', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 4);
    const tapBtn = (id) => {
      const b = app.layout().byId[id];
      assert.ok(b, `HUD 上找不到 ${id}`);
      return app.tap(b.x + b.w / 2, b.y + b.h / 2);
    };
    tapBtn('mode-def');
    tapBtn('start');
    const m = app.match();

    // 真打满 4 轮要十几分钟，这里直接把内核在 `checkDefenseWin` 之后的状态摆出来
    m.stats.roundsCleared = 4;
    m.assault.endless = true;
    m.result = 'win';
    app.drawFrame();

    // §131：转无尽那一局**不能停在结算那一刻**（以前小游戏 `tick` 一见 result 就返回 0，无尽根本玩不到）
    const t0 = m.time;
    app.tick(2);
    assert.ok(m.time > t0, `转无尽之后时间要继续走（${t0.toFixed(1)} → ${m.time.toFixed(1)}）`);

    // 面板还在时给一颗出口；点了就收起来，那颗键也不再挂着（它只在面板还在时出现）
    const btn = app.layout().byId.endless;
    assert.ok(btn, '结算面板还在时要给「继续（无尽）」');
    app.tap(btn.x + btn.w / 2, btn.y + btn.h / 2);
    app.drawFrame();
    assert.ok(!app.layout().byId.endless, '收掉面板之后不再挂那颗键');
    const t1 = m.time;
    app.tick(2);
    assert.ok(m.time > t1, '收掉面板之后当然还在跑');

    // 反面：不是无尽的那种结束（城堡陷落）仍然停表——「面板 ≠ 停表」这条只给无尽开
    m.assault.endless = false;
    m.result = 'lose';
    const t2 = m.time;
    app.tick(3);
    assert.equal(m.time, t2, '城堡陷落之后内核不该再走');
  } finally { fake.uninstall(); }
});

test('小游戏防守：小地图真的画出来了、贴到了主画布上，点它回城（§2.6）', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 5);
    const tapBtn = (id) => {
      const b = app.layout().byId[id];
      assert.ok(b, `HUD 上找不到 ${id}`);
      return app.tap(b.x + b.w / 2, b.y + b.h / 2);
    };
    tapBtn('mode-def');
    tapBtn('start');
    const m = app.match();
    app.drawFrame();

    // ① 离屏画布上真的画了东西（走的是浏览器版那套 `createMinimap`：野区 / 围墙 / 营地点 / 人在哪）
    const mini = app.minimap();
    assert.ok(mini, '防守局要有一张小地图');
    const calls = mini.canvas.record.calls;
    const counts = calls.reduce((a, c) => ({ ...a, [c]: (a[c] ?? 0) + 1 }), {});
    // 底 + 野区 + 围墙是方块画的；营地 / 传送点 / 城堡 / 英雄那些点是圆点画的
    assert.ok(counts.fillRect >= 3, `小地图上该有「底 / 野区 / 围墙」（fillRect ${counts.fillRect ?? 0} 次）`);
    assert.ok(counts.arc >= 5, `营地 / 传送点 / 城堡 / 英雄那些点该画出来（arc ${counts.arc ?? 0} 次）`);
    // ② 主画布上贴了它
    assert.ok(app.canvas.record.calls.includes('drawImage'), '主画布这一帧要贴小地图');
    // ③ 点它 = 回城（与「回城」按钮同一个动作、同一个 30 秒冷却）
    assert.ok(m.hero.teleportCd === 0, '前提：这会儿不在冷却');
    const cell = app.layout().minimap;
    app.tap(cell.x + cell.w / 2, cell.y + cell.h / 2);
    assert.ok(m.hero.teleportCd > 0, '点小地图要真的回城（进冷却）');
  } finally { fake.uninstall(); }
});

test('小游戏防守 HUD：右下技能键（§1.9.1）；阵亡时那一排换成「快速复活」（§7.6）', () => {
  const m = createDefenseMatch({ seed: 5 });
  const L = layoutDefense(m, { rate: 1, paused: false, potionCount: 1 });
  // 活着：技能键在右下，名字 / 等级 / 冷却都从内核取（与 TD 那排同一份来源）
  assert.equal(L.byId['skill-0'].label, '旋风斩');
  assert.equal(L.byId['skill-0'].sub, 'Lv1');
  assert.equal(L.byId['skill-1'].disabled, true, '没解锁的「战吼」要灰掉');
  assert.ok(!L.byId.revive, '活着的时候不该有复活键');
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const id of ['skill-0', 'skill-1', 'skill-2']) {
    const it = L.byId[id];
    assert.ok(it.w >= 44 && it.h >= 44, `${id} 热区不够`);
    assert.ok(it.x + it.w <= DESIGN.w && it.y + it.h <= DESIGN.h, `${id} 出界`);
    assert.ok(!hit(it, L.minimap) && !hit(it, L.capsule), `${id} 压到小地图或胶囊区`);
    assert.ok(!inStickZone(L, it.x + it.w / 2, it.y + it.h / 2), `${id} 落进了摇杆区`);
  }
  assert.equal(SKILL_BAR.x + 3 * SKILL_BAR.w + 2 * SKILL_BAR.gap <= DESIGN.w, true, '三颗键要放得下');

  // 阵亡：那一排换成一颗「快速复活 · 50 木」，木材不够时灰掉；顶栏那一格写倒计时
  m.hero.dead = true;
  m.hero.reviveTimer = 8;
  m.lumber[0] = 0;
  const dead = layoutDefense(m, { rate: 1 });
  assert.ok(dead.byId.revive && !dead.byId['skill-0'], '阵亡时换成复活键（技能本来就放不了）');
  assert.match(dead.byId.revive.label, new RegExp(`快速复活 · ${REVIVE_LUMBER} 木`));
  assert.equal(dead.byId.revive.disabled, true, '木材不够要灰掉');
  m.lumber[0] = REVIVE_LUMBER;
  assert.equal(layoutDefense(m, {}).byId.revive.disabled, false, '木材够了就能点');
  const ctx = fakeCtx();
  drawDefenseHud(ctx, m, layoutDefense(m, {}), {});
  assert.ok(ctx.texts.some((t) => /英雄 Lv\d+ · 阵亡 \d+s/.test(t)),
    `英雄那一行要写等级 + 阵亡倒计时（画了：${ctx.texts.join(' / ')}）`);

  // 活着：人在野外区里报「区名 + 等级段 + 掉落加成」（§2.6 / §12.8，与浏览器版同一套文案）
  m.hero.dead = false;
  const zone = m.def.zones[0];
  m.hero.cell = { x: zone.x, y: zone.y };
  const inZone = fakeCtx();
  drawDefenseHud(inZone, m, layoutDefense(m, {}), {});
  assert.ok(inZone.texts.some((t) => /英雄 Lv\d+ · .*Lv\d+-\d+/.test(t)),
    `进了野区要报区名与等级段（画了：${inZone.texts.join(' / ')}）`);
  // 没进区：回落到「待命 / 移动中」
  m.hero.cell = { x: m.castle.cell.x, y: m.castle.cell.y };
  m.hero.moving = true;
  const outside = fakeCtx();
  drawDefenseHud(outside, m, layoutDefense(m, {}), {});
  assert.ok(outside.texts.some((t) => t.includes('移动中')), '没进区就该回落成移动状态');
});

test('小游戏防守闭环：放技能真的进冷却；阵亡后点「快速复活」花 50 木把人拉起来', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 6);
    const tapBtn = (id) => {
      const b = app.layout().byId[id];
      assert.ok(b, `HUD 上找不到 ${id}`);
      return app.tap(b.x + b.w / 2, b.y + b.h / 2);
    };
    tapBtn('mode-def');
    tapBtn('start');
    const m = app.match();

    // 技能：点下去要真的进冷却（防守以前一颗技能键都没有）
    tapBtn('skill-0');
    assert.ok(m.hero.skillCd[0] > 0, '防守局也要能放技能');
    app.drawFrame();
    assert.equal(app.layout().byId['skill-0'].sub, `${Math.ceil(m.hero.skillCd[0])}s`, '键上要写剩余冷却');

    // 阵亡 → 复活：木材不够时点了没用；够了就真的起来
    m.hero.dead = true;
    m.hero.reviveTimer = 12;
    m.lumber[0] = 0;
    app.drawFrame();
    tapBtn('revive');
    assert.equal(m.hero.dead, true, '木材不够不该复活');
    m.lumber[0] = 50;
    app.drawFrame();
    tapBtn('revive');
    assert.equal(m.hero.dead, false, '点了要真的把人拉起来');
    assert.equal(m.lumber[0], 0, `花掉 ${REVIVE_LUMBER} 木材`);
  } finally { fake.uninstall(); }
});

test('小游戏防守：回防预警响一声（§2.6 的提示音 / §178 要在手势里解锁 / 静音时一声不响）', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 7);
    const tapBtn = (id) => {
      const b = app.layout().byId[id];
      assert.ok(b, `HUD 上找不到 ${id}`);
      return app.tap(b.x + b.w / 2, b.y + b.h / 2);
    };
    tapBtn('mode-def');
    tapBtn('start');
    const m = app.match();
    assert.equal(fake.audio.contexts, 0, '前提：还没点过屏幕，音频上下文还没建');

    // ① §178：音频只能在**手势里**解锁——按一下就顺手建/恢复上下文
    fake.fireTouch(500, 120, 'down');
    fake.fireTouch(500, 120, 'up');
    assert.ok(fake.audio.contexts >= 1, '按下时要顺手把音频上下文解出来（真机上第一次预警才响得了）');

    // ② 预警**起的那一下**排两声蜂鸣（§2.6：小地图闪 + 提示音）
    m.assault.warning = true;
    app.tick(0.1);
    assert.ok(fake.audio.oscillators >= 2, `预警该排两声蜂鸣（实际 ${fake.audio.oscillators}）`);
    // ③ 只认边沿：预警一直亮着，不再重复播
    const played = fake.audio.oscillators;
    app.tick(1);
    assert.equal(fake.audio.oscillators, played, '预警没落下去就不该重播');

    // ④ 设置里关掉「音效/震动」：再响一次预警也一声不排（浏览器版那颗开关管着两样）
    tapBtn('pause');
    assert.equal(app.getModel().sheet.byId.sfx.label, '音效/震动', '标签要写全：它同时管提示音与震动');
    const row = app.getModel().sheet.byId.sfx;
    app.tap(row.x + row.w / 2, row.y + row.h / 2);
    assert.equal(JSON.parse(globalThis.wx.getStorageSync('frostfall:settings') || '{}').sfx, false, '要落盘');
    const resume = app.getModel().sheet.byId.resume;
    app.tap(resume.x + resume.w / 2, resume.y + resume.h / 2);
    m.assault.warning = false;
    app.tick(0.1);
    m.assault.warning = true;
    app.tick(0.1);
    assert.equal(fake.audio.oscillators, played, '关掉之后不该再排蜂鸣');
  } finally { fake.uninstall(); }
});

test('小游戏防守：「修城」那一格——钱不够/满血都灰，副标写清多少钱、回多少血', () => {
  const m = createDefenseMatch({ seed: 5 });
  m.gold = DEFENSE_RULES.repairGold - 1;
  m.castle.hp = m.castle.maxHp - 100;
  const poor = layoutDefense(m, { rate: 1 });
  assert.equal(poor.byId.repair.disabled, true, '钱不够要灰（浏览器版那颗按钮同一个判据）');
  assert.match(poor.byId.repair.sub, new RegExp(`${DEFENSE_RULES.repairGold} 金`), '副标要写价格');
  assert.match(poor.byId.repair.sub, /\+/, '副标要写回多少血');
  m.gold = DEFENSE_RULES.repairGold;
  assert.equal(layoutDefense(m, { rate: 1 }).byId.repair.disabled, false, '钱够了就能修');
  m.castle.hp = m.castle.maxHp;
  assert.equal(layoutDefense(m, { rate: 1 }).byId.repair.disabled, true, '满血也要灰（修了没意义）');
});

test('小游戏防守：回城卷轴（§5.5.1）——冷却中也能回，那一格不该被灰掉', () => {
  const m = createDefenseMatch({ seed: 5 });
  m.hero.teleportCd = 12;
  m.scrolls = 0;
  const cold = layoutDefense(m, { rate: 1 });
  assert.equal(cold.byId.teleport.disabled, true, '冷却中又没卷轴，点它确实没用（该灰）');
  assert.match(cold.byId.teleport.sub, /12s/, '副标要写剩余秒数');
  assert.equal(cold.byId.minimap.disabled, true, '小地图那一格同一个判据');

  m.scrolls = 2;
  const warm = layoutDefense(m, { rate: 1 });
  assert.equal(warm.byId.teleport.disabled, false,
    '有卷轴时冷却中也能回（§5.5.1：卷轴只负责把你送回去，不清冷却）');
  assert.match(warm.byId.teleport.sub, /卷轴/, '副标要写卷轴数');
  assert.equal(warm.byId.minimap.disabled, false, '小地图那一格同一个判据');
});

test('小游戏防守闭环：买一张回城卷轴 → 冷却中照样回得去（小游戏以前那格一冷却就灰）', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 8);
    const tapBtn = (id) => {
      const b = app.layout().byId[id];
      assert.ok(b, `HUD 上找不到 ${id}`);
      return app.tap(b.x + b.w / 2, b.y + b.h / 2);
    };
    const tapSheet = (id) => {
      const r = app.getModel().sheet.byId[id];
      assert.ok(r, `面板上找不到 ${id}`);
      app.tap(r.x + r.w / 2, r.y + r.h / 2);
    };
    tapBtn('mode-def');
    tapBtn('start');
    const m = app.match();
    m.gold = 500;

    // 商店买一张卷轴（80 金）——它不是药品，单独记在 `m.scrolls`
    tapBtn('shop');
    tapSheet('buy-scroll_town');
    assert.equal(m.scrolls, 1, '卷轴要到手');
    tapSheet('close');

    // 第一次回城：进 30 秒冷却
    tapBtn('teleport');
    assert.ok(m.hero.teleportCd > 0, '第一次回城要进冷却');
    // 跑远一点，冷却中再点一次：有卷轴，照样回得去（并把卷轴用掉）
    m.hero.cell = { x: m.castle.cell.x + 8, y: m.castle.cell.y + 8 };
    app.drawFrame();
    assert.equal(app.layout().byId.teleport.disabled, false, '有卷轴时不该灰');
    tapBtn('teleport');
    assert.equal(m.scrolls, 0, '用掉一张卷轴');
    assert.ok(Math.abs(m.hero.cell.x - m.castle.cell.x) <= 3, '人回基地了');
    assert.ok(m.hero.teleportCd > 0, '卷轴不清那 30 秒冷却');
    // 卷轴用完、还在冷却：那一格该灰回去
    app.drawFrame();
    assert.equal(app.layout().byId.teleport.disabled, true, '没卷轴又冷却中，就该灰');
  } finally { fake.uninstall(); }
});
