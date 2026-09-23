// 小游戏的「继续上局」（§10.3「随时能停」）：自动存档 / 切后台补存 / 关掉再打开能接着打。
// 存档本身是浏览器版现成的 `save.js`（序列化 + 反序列化 + hasSave 的「读得出来才算有」），
// 这份用例盯的是**小游戏这条新路径有没有把三处接线接上**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installFakeWx } from '../tools/fake-wx.mjs';
import { applyLobbyAction, layoutLobby } from '../src/minigame/lobby.js';
import { emptyProfile } from '../src/profile.js';

const OUT = mkdtempSync(join(tmpdir(), 'ff-mini-resume-'));
process.env.FF_MINIGAME_OUT = OUT;

/** 把打好的包复制成一个**新文件名**再 require：ESM 缓存按路径走，不换名就还是同一个模块实例 */
const loadFreshApp = (require, n) => {
  const p = join(OUT, `game-${n}.js`);
  copyFileSync(join(OUT, 'game.js'), p);
  require(p);
  require(p);   // 同一份文件第二次 require 走缓存，都是同一个 app
  return globalThis.__frostfallLobby;
};

const lobbyModel = (over = {}) => ({
  mode: 'td', map: 'map_01', difficulty: 'normal', length: 'short', hero: 'hero_warrior',
  profile: emptyProfile(), unlocked: ['map_01'], locked: {}, lockedReason: {},
  unlockedCount: 1, canStart: true, canContinue: false, hint: null, ...over,
});

test('小游戏大厅：有存档时才出现「继续上局」，它不会挤掉「单人开局」', () => {
  const without = layoutLobby(667, 375, lobbyModel());
  assert.ok(!without.byId.continue, '没有存档就不该有「继续上局」');
  assert.equal(without.byId.start.w, 296, '没有它时「单人开局」占满右边');

  const withSave = layoutLobby(667, 375, lobbyModel({ canContinue: true }));
  assert.ok(withSave.byId.continue, '有存档要给出口');
  assert.ok(withSave.byId.continue.h >= 44 && withSave.byId.continue.w >= 44, '热区 ≥44');
  assert.ok(withSave.byId.start.x + withSave.byId.start.w <= withSave.byId.continue.x,
    '两个按钮不许压在一起');
  assert.ok(withSave.byId.continue.x + withSave.byId.continue.w <= 667, '别越界');
});

test('小游戏大厅：点「继续上局」只表达意图（真正装存档是 app 的事），没存档时给一句人话', () => {
  const asked = applyLobbyAction(lobbyModel({ canContinue: true }), { type: 'continue' });
  assert.equal(asked.continueRequested, true);
  const none = applyLobbyAction(lobbyModel(), { type: 'continue' });
  assert.match(none.hint, /没有可以继续的一局/);
});

test('小游戏存档三处接线：每 5 秒自动存 + 切后台补一笔 + 关掉再打开能接着打', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 1);
    app.startMatch();
    const m = app.match();

    app.tick(4);
    assert.equal(globalThis.wx.getStorageSync('frostfall:save'), '', '不到 5 秒不该有存档');
    app.tick(2);
    assert.notEqual(globalThis.wx.getStorageSync('frostfall:save'), '', '每 5 秒要自动存一次');
    const t0 = m.time;
    assert.ok(t0 >= 5.9, `跑够 6 秒（实际 ${t0.toFixed(1)}）`);

    // 切后台补一笔（小游戏是 wx.onHide）
    app.tick(1);
    fake.fireHide();
    const saved = JSON.parse(globalThis.wx.getStorageSync('frostfall:save'));
    assert.ok(saved && saved.v, '存档要有版本号（§139/§204 的「读得出来才算有」）');

    // 「关掉再打开」：同一份包、全新模块实例 → 大厅应该给出「继续上局」
    const reopened = loadFreshApp(require, 2);
    assert.equal(reopened.screen(), 'lobby');
    assert.equal(reopened.getModel().canContinue, true, '有存档时大厅要给「继续上局」');
    const cont = reopened.layout().byId.continue;
    reopened.tap(cont.x + cont.w / 2, cont.y + cont.h / 2);
    assert.equal(reopened.screen(), 'battle', '点「继续上局」要真的回到战场');
    assert.ok(reopened.match().time >= t0, `接着上一局的进度（存档 ${t0.toFixed(1)} → 回来 ${reopened.match().time.toFixed(1)}）`);

    // 打完这一局：存档要收掉，大厅不该再出现「继续上局」
    reopened.match().result = 'win';
    reopened.drawFrame();
    assert.equal(globalThis.wx.getStorageSync('frostfall:save'), '', '一局结束就收掉存档');
    reopened.backToLobby();
    assert.equal(reopened.getModel().canContinue, false, '回大厅后不该再给「继续上局」');
  } finally { fake.uninstall(); }
});
