// 小游戏的镜头操作（§2.5 的「单指拖空白处平移、双指缩放到局部、双击回核心」＋ §171）。
//
// 浏览器版这三条是 `main.js` 里挂在 canvas 上的 pointer 事件（`pointers` / `pinchDist` / `lastEmptyTap`）。
// 小游戏没有 DOM 事件，只有 wx 的全局触摸（而且**一次只给 changedTouches**），所以这里要验的是：
// 「自己攒出来的触点表」能不能把同一套行为撑起来，以及**别把一次触摸拆成两次点击**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installFakeWx } from '../tools/fake-wx.mjs';
import { gridDist } from '../src/core.js';

const OUT = mkdtempSync(join(tmpdir(), 'ff-mini-camera-'));
process.env.FF_MINIGAME_OUT = OUT;

const loadFreshApp = (require, n) => {
  const p = join(OUT, `game-${n}.js`);
  copyFileSync(join(OUT, 'game.js'), p);
  require(p);
  return globalThis.__frostfallLobby;
};

const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

/** 找一个「空白处」：在图上、且离任何塔位都超过 2 格（`emptyTapAt` 的口径） */
const emptyPoint = (m, r) => {
  for (let y = 40; y < 360; y += 6) {
    for (let x = 40; x < 640; x += 6) {
      const cell = r.toGrid(x, y);
      const g = m.map.grid;
      if (cell.x < 0 || cell.y < 0 || cell.x >= g.w || cell.y >= g.h) continue;
      if (m.map.slots.every((s) => gridDist(s, cell) > 2)) return { x, y };
    }
  }
  throw new Error('这一局找不到空白点（战场上铺满了塔位？）');
};

/**
 * 重开一局 TD，并把「整图可见」关掉（放大档才有可拖的余地——与浏览器版同一个判据），然后继续游戏。
 * 注意它**会换一个 renderer**（新的一局 = 新的渲染器），所以调用方要拿返回值，别用旧的那个。
 */
const startZoomed = (app) => {
  app.startMatch();
  app.tap(500, 30);                                  // 顶栏右侧那颗「暂停」
  const cam = app.getModel().sheet.byId.camera;      // 暂停面板里的「镜头」档
  app.tap(cam.x + cam.w / 2, cam.y + cam.h / 2);
  const resume = app.getModel().sheet.byId.resume;   // 顺便继续游戏：暂停时不接镜头手势（与浏览器版同一条判据）
  app.tap(resume.x + resume.w / 2, resume.y + resume.h / 2);
  return app.renderer();
};

test('小游戏镜头：双指缩放以两指中点为锚点，并从「整图」切到「放大」档', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 1);
    app.startMatch();
    const r = app.renderer();
    const before = r.scale;

    const anchor = r.toGrid(340, 200);            // 缩放锚点（两指中点）底下那一格
    fake.fireTouch(300, 200, 'down', 0);
    fake.fireTouch(340, 200, 'down', 1);          // 第二根手指：进入双指缩放
    fake.fireTouch(380, 200, 'move', 1);          // 间距 40 → 80，放大一倍
    assert.ok(r.scale > before, `双指张开该放大（${before.toFixed(2)} → ${r.scale.toFixed(2)}）`);
    const after = r.toGrid(340, 200);
    assert.ok(near(anchor.x, after.x) && near(anchor.y, after.y),
      `两指中点底下那一格不该跑（${anchor.x},${anchor.y} → ${after.x},${after.y}）`);

    // 松手：这一下本来是缩放，**不许**顺手开出一张面板（一次触摸不能拆成两次点击）
    fake.fireTouch(300, 200, 'up', 0);
    fake.fireTouch(380, 200, 'up', 1);
    assert.equal(app.getModel().sheet, null, '缩放松手不该开出面板');
  } finally { fake.uninstall(); }
});

test('小游戏镜头：放大档下拖空白处真的平移；整图档下拖不动（与浏览器版同一条判据）', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 2);
    app.startMatch();
    const r0 = app.renderer();

    // 整图档：空白处拖一下，相机不该动（整图都看得见了，没有可拖的余地）
    const fit0 = r0.toScreen(0, 0);
    const empty = emptyPoint(app.match(), r0);
    fake.fireTouch(empty.x, empty.y, 'down', 0);
    fake.fireTouch(empty.x + 80, empty.y, 'move', 0);
    fake.fireTouch(empty.x + 80, empty.y, 'up', 0);
    assert.ok(near(r0.toScreen(0, 0).x, fit0.x) && near(r0.toScreen(0, 0).y, fit0.y), '整图档不该被拖走');

    // 整图档里「按在空白处、松手时手指落在塔位旁边」也不许开面板：
    // 松手那一笔要是再点一次，就会顺手弹出一张建造面板（一次触摸只能算一次点击）
    const m0 = app.match();
    const sp0 = r0.toScreen(m0.map.slots[0].x, m0.map.slots[0].y);
    fake.fireTouch(empty.x, empty.y, 'down', 0);
    fake.fireTouch(sp0.x, sp0.y, 'move', 0);
    fake.fireTouch(sp0.x, sp0.y, 'up', 0);
    assert.equal(app.getModel().sheet, null, '松手落在塔位旁边不该弹面板');
    assert.equal(m0.towers.length, 0, '更不该把塔建出来');

    // 放大档：同样的一拖真的要平移，且拖过之后不会顺手开面板
    const r = startZoomed(app);
    const p0 = r.toScreen(0, 0);
    const empty2 = emptyPoint(app.match(), r);
    fake.fireTouch(empty2.x, empty2.y, 'down', 0);
    fake.fireTouch(empty2.x + 80, empty2.y, 'move', 0);
    fake.fireTouch(empty2.x + 80, empty2.y, 'up', 0);
    const p1 = r.toScreen(0, 0);
    assert.ok(p1.x - p0.x > 40 && near(p1.y - p0.y, 0),
      `拖 80 像素地图该跟着走（实际 ${(p1.x - p0.x).toFixed(0)},${(p1.y - p0.y).toFixed(0)}）`);
    assert.equal(app.getModel().sheet, null, '拖动松手不算「点」，不该开面板');

    // 放大档下点塔位照旧（拖动只吃「空白处」那一下）——这条是「别把点选吞掉」的反向保险。
    // 而且**一次触摸只算一次点击**：按下开面板，松手不能连点（那会顺着面板把塔也建了）
    const m = app.match();
    const slot = m.map.slots[0];
    const sp = r.toScreen(slot.x, slot.y);
    fake.fireTouch(sp.x, sp.y, 'down', 0);
    assert.equal(app.getModel().sheet?.kind, 'build', '放大档下点塔位仍然要弹建造面板');
    fake.fireTouch(sp.x, sp.y, 'up', 0);
    assert.equal(app.getModel().sheet?.kind, 'build', '松手那一笔不许再点一次（面板还是刚弹出来那张）');
    assert.equal(m.towers.length, 0, '更不该顺着面板把塔建出来');
  } finally { fake.uninstall(); }
});

test('小游戏镜头：双击空白处回核心（并真的记住「放大」这个档）', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 3);
    const r = startZoomed(app);

    const core = app.match().core.cell;
    // 先把镜头拖走：这会儿核心不在屏幕中心
    const empty = emptyPoint(app.match(), r);
    fake.fireTouch(empty.x, empty.y, 'down', 0);
    fake.fireTouch(empty.x + 240, empty.y, 'move', 0);
    fake.fireTouch(empty.x + 240, empty.y, 'up', 0);
    const c0 = r.toScreen(core.x, core.y);
    assert.ok(!near(c0.x, 333, 4), '前提：拖过之后核心已经不在屏幕中心');

    // 双击空白处 = 回核心（两次落点在 300ms / 30px 内）
    const spot = emptyPoint(app.match(), r);
    for (const _ of [0, 1]) {
      fake.fireTouch(spot.x, spot.y, 'down', 0);
      fake.fireTouch(spot.x, spot.y, 'up', 0);
    }
    const c1 = r.toScreen(core.x, core.y);
    assert.ok(near(c1.x, 333, 2) && near(c1.y, 187, 2),
      `双击之后核心该回到屏幕中心（实际 ${c1.x.toFixed(0)},${c1.y.toFixed(0)}）`);
    // 两下离得远 / 隔得久就只是两次普通点击（不该回核心）——先拖走再验
    fake.fireTouch(spot.x, spot.y, 'down', 0);
    fake.fireTouch(spot.x + 240, spot.y, 'move', 0);
    fake.fireTouch(spot.x + 240, spot.y, 'up', 0);
    fake.fireTouch(spot.x, spot.y, 'down', 0);
    fake.fireTouch(spot.x, spot.y, 'up', 0);
    fake.fireTouch(spot.x + 200, spot.y, 'down', 0);
    fake.fireTouch(spot.x + 200, spot.y, 'up', 0);
    const c2 = r.toScreen(core.x, core.y);
    assert.ok(!near(c2.x, 333, 2), '两次落点离得远时不该当成双击');
  } finally { fake.uninstall(); }
});
