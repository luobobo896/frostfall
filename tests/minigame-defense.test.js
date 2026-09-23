// 小游戏防守那一屏（§12.5 / §2.6）：摇杆数学、HUD 布局、工事面板，以及「推着走 → 建工事 → 回城」的闭环。
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installFakeWx } from '../tools/fake-wx.mjs';
import {
  DESIGN, STICK, hitTestDefense, inStickZone, layoutDefense, layoutFortSheet, stickBase, stickVector,
} from '../src/minigame/defense-screen.js';
import { createDefenseMatch } from '../src/defense.js';
import { FORTS } from '../src/data.js';

const OUT = mkdtempSync(join(tmpdir(), 'ff-mini-defense-'));
process.env.FF_MINIGAME_OUT = OUT;

/** 复制成新文件名再 require：ESM 缓存按路径走，于是每条用例都能拿到一个**全新的大厅开局** */
const loadFreshApp = (require, n) => {
  const p = join(OUT, `game-${n}.js`);
  copyFileSync(join(OUT, 'game.js'), p);
  require(p);
  return globalThis.__frostfallLobby;
};

const base = () => ({ x: 100, y: 300, r: STICK.radius, floating: false });

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

    // 固定档（默认）：x=320 已经在「左下 45%」（0.45 × 667 = 300）之外，这一下不归摇杆
    fake.fireTouch(320, 320, 'down');
    assert.equal(app.getModel().stick.active, false, '固定档下 45% 之外不该归摇杆');
    fake.fireTouch(320, 320, 'up');
    assert.equal(m.hero.path.length > 0, true, '那一下仍然是「点地移动」');

    // 切浮动：设置落盘 + 面板读数跟着变
    tapBtn('pause');
    assert.equal(app.getModel().sheet.byId.stick.sub, '固定');
    tapSheet('stick');
    assert.equal(JSON.parse(globalThis.wx.getStorageSync('frostfall:settings') || '{}').stick, 'floating');
    assert.equal(app.getModel().sheet.byId.stick.sub, '浮动', '切完面板要显示浮动');
    tapSheet('resume');

    // 浮动档：左半屏（50%）都归摇杆，而且**底座跟手指**
    fake.fireTouch(320, 320, 'down');
    const st = app.getModel().stick;
    assert.equal(st.active, true, '浮动档下左半屏该归摇杆');
    assert.equal(Math.round(st.origin.x), 320, '浮动底座要跟到手指那一点');
    assert.equal(Math.round(st.origin.y), 320);
    const from = { ...m.hero.cell };
    fake.fireTouch(420, 320, 'move');
    app.tick(4);
    assert.notDeepEqual(m.hero.cell, from, `浮动摇杆推着也该走（还在 ${JSON.stringify(m.hero.cell)}）`);
    fake.fireTouch(420, 320, 'up');
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
