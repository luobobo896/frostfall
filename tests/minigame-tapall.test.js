// 「每一颗键都按一遍」的兜底用例（小游戏这两屏）。
//
// 起因很具体：§226 抓到「防守局一按暂停就崩」，而当时的用例**按过暂停**——只是按完没画帧
// （崩溃发生在 `drawFrame` 里算弹层那一步）。手写用例总会漏路径，所以这里换个办法：
// 把两种模式里 HUD 上的每一颗键、每张弹层里的每一行**都点一遍**，每点一下都画一帧。
// 它不检查观感与数值（那些各有专门的用例），只钉一条底线：**没有一条路能把画面弄崩**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installFakeWx } from '../tools/fake-wx.mjs';

const OUT = mkdtempSync(join(tmpdir(), 'ff-mini-tapall-'));
process.env.FF_MINIGAME_OUT = OUT;

const loadFreshApp = (require, n) => {
  const p = join(OUT, `game-${n}.js`);
  copyFileSync(join(OUT, 'game.js'), p);
  require(p);
  return globalThis.__frostfallLobby;
};

const center = (r) => [r.x + r.w / 2, r.y + r.h / 2];
/** 「回大厅 / 再开一局」会让这一局结束，放在最后专门点——不然扫到一半就换屏了 */
const LAST = new Set(['lobby', 'restart']);

/** 点一下 + 画一帧；返回 false 表示已经离开战场（点了回大厅 / 退到结算之外） */
const poke = (app, rect) => {
  const [x, y] = center(rect);
  app.tap(x, y);
  app.drawFrame();
  return app.screen() === 'battle';
};

/** 把当前弹层里的每一行都点一遍（每点一次都重画一帧——崩溃最容易出在这一步） */
const pokeSheet = (app, ids) => {
  for (const id of ids) {
    if (LAST.has(id)) continue;
    const sheet = app.getModel().sheet;
    if (!sheet) return;                       // 某一行把面板关掉了：这一轮到此为止
    const row = sheet.byId[id];
    if (!row) continue;
    poke(app, row);
  }
};

const sheetIds = (app) => (app.getModel().sheet?.rows ?? []).map((r) => r.id);

/** 把当前弹层收掉（三种面板各有各的关闭行） */
const closeSheet = (app) => {
  for (const id of ['close', 'resume', 'cancel']) {
    const row = app.getModel().sheet?.byId?.[id];
    if (row) { poke(app, row); return true; }
  }
  return false;
};

for (const [mode, label] of [['td', 'TD'], ['defense', '防守']]) {
  test(`小游戏 ${label}：HUD 每一颗键 + 每张弹层的每一行都点一遍，都不许把画面弄崩`, async () => {
    await import('../tools/build-minigame.mjs');
    const fake = installFakeWx();
    try {
      const require = createRequire(import.meta.url);
      const app = loadFreshApp(require, mode === 'td' ? 1 : 2);
      if (mode === 'defense') {
        const def = app.layout().byId['mode-def'];
        poke(app, def);
      }
      const start = app.layout().byId.start;
      app.tap(...center(start));
      app.drawFrame();
      assert.equal(app.screen(), 'battle', '前提：真的进局了');
      // 给足钱：不然买不起的行全灰，等于没点到
      app.match().gold = 99999;
      if (app.match().lumber) app.match().lumber[0] = 99;

      // ① 底排与顶栏的每一颗键（回大厅 / 再开一局会让这一局结束，所以放在最后按）
      const hud = Object.keys(app.layout().byId);
      for (const id of hud) {
        if (LAST.has(id)) continue;
        const item = app.layout().byId[id];
        if (!item) continue;
        poke(app, item);
        // 点进去的弹层（商店 / 背包 / 暂停 / 工事…）也顺手把每一行点一遍
        const ids = sheetIds(app);
        if (ids.length) pokeSheet(app, ids);
      }
      assert.ok(true);

      // ② 建造面板 / 塔面板（TD）：点一个空塔位 → 每种塔都点一遍；再点已建的塔 → 塔面板每行都点一遍
      if (mode === 'td') {
        const m = app.match();
        const r = app.renderer();
        while (app.getModel().sheet) closeSheet(app);      // 先把上一步可能开着的面板收干净
        const p = r.toScreen(m.map.slots[0].x, m.map.slots[0].y);
        app.tap(p.x, p.y);
        app.drawFrame();
        pokeSheet(app, sheetIds(app));          // 四种塔 + 取消
        while (app.getModel().sheet) closeSheet(app);
        const p2 = r.toScreen(m.map.slots[0].x, m.map.slots[0].y);
        app.tap(p2.x, p2.y);
        app.drawFrame();
        assert.equal(app.getModel().sheet?.kind, 'tower', '前提：点已建的塔要弹塔面板');
        pokeSheet(app, sheetIds(app));          // 升级 / 出售 / 四档优先级 / 关闭
      }

      // ③ 最后：回大厅（走暂停面板里那一格——防守的 HUD 上没有「回大厅」，只有面板里有）
      for (let i = 0; i < 4 && app.screen() === 'battle'; i += 1) {
        const sheet = app.getModel().sheet;
        // 注意：不能走 `pokeSheet`（它跳过 `LAST` 里那几个 id）；这里就是要按它
        if (sheet?.byId?.lobby) { poke(app, sheet.byId.lobby); continue; }  // 暂停面板里就有出口
        if (sheet) { closeSheet(app); continue; }                          // 别的面板先收掉
        poke(app, app.layout().byId.pause);                                // 它是个开关，开一次
      }
      assert.equal(app.screen(), 'lobby', '点「回大厅」要真的回去（而且这一路上没崩）');
    } finally { fake.uninstall(); }
  });
}
