// 小游戏那一层的视口门槛与大屏居中。
//
// STATUS §3.1 #33 拍板：**最小支持视口 = 667×375**（比它小就明说，不砍信息、不违反 §1.9.2 的热区线）；
// 浏览器侧对应的是两条 `@media`（竖屏「请横屏」/ 太小「屏幕太小」）。小游戏端虽然能在后台锁横屏，
// 但开发者工具与部分机型仍会给出竖屏尺寸——所以这一层也要有同样的兜底，而且**兜底期间不接触摸**。
// 另外：屏幕比设计画布大时，战场 HUD 按设计单位**居中**（只平移不缩放，缩放会把 44pt 热区改小）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installFakeWx } from '../tools/fake-wx.mjs';
import { DESIGN } from '../src/minigame/battle.js';

const OUT = mkdtempSync(join(tmpdir(), 'ff-mini-viewport-'));
process.env.FF_MINIGAME_OUT = OUT;

const loadFreshApp = (require, n) => {
  const p = join(OUT, `game-${n}.js`);
  copyFileSync(join(OUT, 'game.js'), p);
  require(p);
  return globalThis.__frostfallLobby;
};

test('竖屏（375×812）：只画一句「请横屏」，而且不接触摸', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx({ windowWidth: 375, windowHeight: 812 });
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 1);
    app.drawFrame();
    const drawn = app.canvas.record.texts.join('');
    assert.match(drawn, /请横屏/, `竖屏该说一句「请横屏」（实际画了：${drawn}）`);
    assert.ok(!drawn.includes('冰封之地'), '竖屏下不该再画大厅（那会挤成一团）');

    // 触摸也不接：点大厅「单人开局」那一带也不该进局
    fake.fireTouch(560, 300, 'down');
    fake.fireTouch(560, 300, 'up');
    assert.equal(app.screen(), 'lobby', '竖屏下触摸不该生效');
  } finally { fake.uninstall(); }
});

test('屏幕太小（568×320 = iPhone SE 一代横屏）：说「屏幕太小」，也不接触摸', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx({ windowWidth: 568, windowHeight: 320 });
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 2);
    app.drawFrame();
    assert.match(app.canvas.record.texts.join(''), /屏幕太小/);
    fake.fireTouch(180, 300, 'down');
    assert.equal(app.screen(), 'lobby', '太小的时候触摸不该生效');
  } finally { fake.uninstall(); }
});

test('大屏（812×375）：战场 HUD 按设计单位居中——触摸坐标跟着偏移，按钮不会错位', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx({ windowWidth: 812, windowHeight: 375 });
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 3);
    app.startMatch();
    app.drawFrame();
    assert.ok(app.canvas.record.texts.includes('回大厅'), '这一帧要把 HUD 画出来');

    const ox = (812 - DESIGN.w) / 2;   // 72.5：HUD 居中带来的偏移
    // 设计坐标 (512,30) 是顶栏那颗「暂停」；不偏移的那一下会落到「倍速」（380..464）上——
    // 这一条正好说明「画出来的位置」与「命中的位置」用的是同一个偏移
    fake.fireTouch(512, 30, 'down');
    fake.fireTouch(512, 30, 'up');
    assert.equal(app.getModel().rate, 2, `不偏移的那一下该落在倍速键上（偏移 ${ox}）`);
    assert.equal(app.getModel().paused, false);

    fake.fireTouch(512 + ox, 30, 'down');
    fake.fireTouch(512 + ox, 30, 'up');
    assert.equal(app.getModel().paused, true, '加上偏移之后才是「暂停」');
  } finally { fake.uninstall(); }
});
