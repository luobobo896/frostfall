// 小游戏的新手引导条（§14.3 稿 11、验收口径 §1.8、门槛与「重看」§153）。
//
// 状态机**与浏览器版是同一份** `src/tutorial.js`（那里面没有 DOM），小游戏只重画那条提示条 +
// 复用 `render.js` 的 `hintSlots`（战场上圈出「建这里」）。这份用例盯三件事：
//   ① 条怎么摆、谁能点（条本身要穿透，只有「跳过」接触摸——浏览器版靠 `.hud` 的 pointer-events）；
//   ② 三处接线真的接上了：建塔 / 放技能 / 开波与清波；
//   ③ 门槛（只在第一局的 TD 挂）与「重看」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installFakeWx } from '../tools/fake-wx.mjs';
import { drawBattleHud, hitTestBattle, layoutBattle } from '../src/minigame/battle.js';
import { TUTORIAL_STEPS } from '../src/tutorial.js';

// 与另外几份小游戏用例同一个道理：**各有各的产物目录**，否则并发跑会互相踩
const OUT = mkdtempSync(join(tmpdir(), 'ff-mini-tutorial-'));
process.env.FF_MINIGAME_OUT = OUT;

/** 把打好的包复制成一个**新文件名**再 require（ESM 缓存按路径走），每条用例拿到独立实例 */
const loadFreshApp = (require, n) => {
  const p = join(OUT, `game-${n}.js`);
  copyFileSync(join(OUT, 'game.js'), p);
  require(p);
  return globalThis.__frostfallLobby;
};

const BATTLE_MODEL = {
  wave: 1, phase: 'prep', timer: 20, gold: 200, core: 3000, coreMax: 3000,
  result: null, length: 'short', canEarly: false, skills: [true, false],
  selectedTower: 'tw_arrow', bagCount: 0, potionCount: 0,
};

const MATCH_VIEW = {
  wave: { index: 1, phase: 'prep', timer: 12 }, length: 'short', gold: 200, lumber: [0],
  core: { hp: 3000, maxHp: 3000 }, result: null, stats: {}, time: 3,
};

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

const profile = (fake) => JSON.parse(String(fake.store.get('frostfall:profile') ?? '{}'));
const tapItem = (app, item) => app.tap(item.x + item.w / 2, item.y + item.h / 2);

test('引导条：只有「跳过」接触摸，条本身穿透给战场（与浏览器版 pointer-events 同一条口径）', () => {
  const text = TUTORIAL_STEPS[0].text;
  const L = layoutBattle({ ...BATTLE_MODEL, tutorial: text });
  assert.ok(L.tutorial, '有引导时要给出那一条');
  assert.equal(L.tutorial.text, text, '条上写的必须是引导状态机给的那一句');
  const skip = L.byId.tutorialSkip;
  assert.ok(skip, '条上要有「跳过」');
  assert.ok(skip.w >= 44 && skip.h >= 44, `跳过键热区 ${skip.w}×${skip.h} 小于 44×44`);
  assert.ok(skip.x + skip.w <= L.w && skip.y + skip.h <= L.h, '跳过键出界');
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.ok(!overlaps(skip, L.capsule), '跳过键压到右上角胶囊区');
  assert.ok(L.tutorial.y + L.tutorial.h <= L.byId.early.y, '引导条压到了底排那颗「开波」');
  // 点条（跳过键以外）= 穿透，交给「点塔位」那套逻辑——条盖在战场上也不该拦住玩家
  assert.equal(hitTestBattle(L, L.tutorial.x + 20, L.tutorial.y + L.tutorial.h / 2), null);
  assert.deepEqual(hitTestBattle(L, skip.x + skip.w / 2, skip.y + skip.h / 2), { type: 'tutorialSkip' });

  const ctx = fakeCtx();
  drawBattleHud(ctx, MATCH_VIEW, L);
  assert.ok(ctx.texts.includes(text), '那一句话要真的画在这一帧里');

  const off = layoutBattle(BATTLE_MODEL);
  assert.equal(off.tutorial, null, '没有引导时不该有条');
  assert.ok(!off.byId.tutorialSkip, '没有引导时也不该有「跳过」');
});

test('小游戏引导：第一局挂上 → 建塔/开波/放技能/清波四步走完 → 自动收尾记档', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 1);
    app.startMatch();
    assert.match(app.getModel().tutorial ?? '', /箭塔/, '第一局要挂第一步（建塔）');
    app.drawFrame();
    assert.ok(app.canvas.record.texts.includes('建这里'), '第一步要在战场上圈出可建的塔位（render.js 的 hintSlots）');

    // ① 建两座箭塔（第一步建完就换第二句；第二句的建议是「再建 2 座」）
    const m = app.match();
    const r = app.renderer();
    for (const i of [0, 1]) {
      const p = r.toScreen(m.map.slots[i].x, m.map.slots[i].y);
      app.tap(p.x, p.y);
      tapItem(app, app.getModel().sheet.byId['build-tw_arrow']);
      tapItem(app, app.getModel().sheet.byId.close);
    }
    assert.match(app.getModel().tutorial ?? '', /提前开波/, '建完塔要换第二句');

    // ② 提前开波 → 换第三句（放技能）
    tapItem(app, app.layout().byId.early);
    app.tick(0.1);
    assert.match(app.getModel().tutorial ?? '', /旋风斩/, '开波之后要换第三句');

    // ③ 放技能 → 换第四句（撑住这一波）
    tapItem(app, app.layout().byId['skill-0']);
    assert.match(app.getModel().tutorial ?? '', /撑住这一波/, '放了技能要换第四句');

    // ④ 清掉第一波 → 收尾：条消失、「已看过」落盘、提示里带上两条验收数字
    // （一秒一 tick + 每 tick 画一帧：那句提示只留 4 秒，一口推 120 秒会把它推过期）
    for (let i = 0; i < 240 && m.wave.index < 2; i += 1) { app.tick(1); app.drawFrame(); }
    assert.ok(m.wave.index >= 2, `第一波该被打完（实际第 ${m.wave.index} 波）`);
    assert.equal(app.getModel().tutorial, null, '走完四步就不该再挂提示');
    assert.equal(profile(fake).tutorialDone, true, '收尾要把「已看过」写进档案（§153 的门槛只看它）');
    assert.ok(app.canvas.record.texts.some((t) => /引导完成.*目标 ≤90 \/ ≤180/.test(t)),
      '收尾要说一句带验收数字的话（§1.8 的口径）');

    // 回大厅再开一局：不该再挂（门槛生效）
    tapItem(app, app.layout().byId.lobby);
    assert.equal(app.screen(), 'lobby');
    app.startMatch();
    assert.equal(app.getModel().tutorial, null, '第二局不该再挂引导');
  } finally { fake.uninstall(); }
});

test('小游戏引导：跳过 = 不再提示 + 记「已看过」；防守局压根不挂', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 2);
    app.startMatch();
    assert.ok(app.getModel().tutorial, '前提：这一局挂着引导');
    tapItem(app, app.layout().byId.tutorialSkip);
    app.drawFrame();
    assert.equal(app.getModel().tutorial, null, '跳过后不再给提示');
    assert.equal(profile(fake).tutorialDone, true, '「跳过」也算看过——否则每次开局都再弹一次');
    assert.ok(!app.layout().byId.tutorialSkip, '条也要跟着没了');

    // 防守：第一局的防守也不挂（那四步全是塔防的）——先把档案重置回「没看过」
    fake.store.delete('frostfall:profile');
    const app2 = loadFreshApp(require, 3);
    tapItem(app2, app2.layout().byId['mode-def']);
    tapItem(app2, app2.layout().byId.start);
    app2.drawFrame();
    assert.equal(app2.match().mode, 'defense', '前提：真的进了防守局');
    // 防守那屏的模型里压根没有这个字段（`defModel` 只带 HUD 只读的那几项），所以是 undefined
    assert.equal(app2.getModel().tutorial ?? null, null, '防守不挂引导');
    assert.ok(!app2.layout().tutorial, '防守 HUD 上也不该有条');
    assert.notEqual(profile(fake).tutorialDone, true, '没挂过就不该记「已看过」');
  } finally { fake.uninstall(); }
});

test('小游戏引导：暂停面板的「重看新手引导」让下一局真的重新挂上（§153）', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 4);
    app.startMatch();
    tapItem(app, app.layout().byId.tutorialSkip);
    tapItem(app, app.layout().byId.lobby);
    app.startMatch();
    assert.equal(app.getModel().tutorial, null, '前提：跳过之后第二局没引导');

    // 暂停 → 重看新手引导（门槛只认一个标记，「重看」就是把它置回 false）
    tapItem(app, app.layout().byId.pause);
    tapItem(app, app.getModel().sheet.byId.replayTutorial);
    assert.equal(profile(fake).tutorialDone, false, '「重看」要立刻写回档案');
    tapItem(app, app.layout().byId.lobby);
    app.startMatch();
    assert.match(app.getModel().tutorial ?? '', /箭塔/, '下一局要重新挂上第一步');
  } finally { fake.uninstall(); }
});
