// 小游戏战场那一屏（移植第 3 步的第二屏）：HUD 的布局/命中/绘制 + 一条**能真的打起来**的闭环。
// 前半是纯函数（零 DOM），后半在假 wx 里把打包产物跑起来：点塔位建塔 → 开波 → 跑 90 秒 → 有击杀、波次推进。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CAPSULE, DESIGN, TOWER_ORDER, drawBattleHud, hitTestBattle, layoutBattle } from '../src/minigame/battle.js';
import { installFakeWx } from '../tools/fake-wx.mjs';

// 与 minigame-bundle.test.js 同一个道理：**各有各的产物目录**，否则并发跑会互相踩
const OUT = mkdtempSync(join(tmpdir(), 'ff-mini-battle-'));
process.env.FF_MINIGAME_OUT = OUT;

const BATTLE_MODEL = {
  wave: 3, phase: 'prep', timer: 12, gold: 200, core: 2400, coreMax: 2400,
  result: null, length: 'short', canEarly: true, skills: [true, false],
  selectedTower: 'tw_arrow',
};

const fakeCtx = () => {
  const texts = [];
  const calls = [];
  const state = {};
  return new Proxy(state, {
    get(t, p) {
      if (p === 'texts') return texts;
      if (p === 'calls') return calls;
      if (p in state) return state[p];
      return (...args) => {
        calls.push(p);
        if (p === 'fillText') texts.push(String(args[0]));
        if (p === 'measureText') return { width: String(args[0] ?? '').length * 6 };
        return undefined;
      };
    },
    set(t, p, v) { state[p] = v; return true; },
  });
};

test('小游戏战场 HUD：可点元素 ≥44×44、画布内、互不重叠、避开胶囊区', () => {
  const L = layoutBattle(BATTLE_MODEL);
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const it of L.items) {
    assert.ok(it.x >= 0 && it.y >= 0 && it.x + it.w <= L.w && it.y + it.h <= L.h, `${it.id} 出界`);
    assert.ok(it.w >= 44 && it.h >= 44, `${it.id} 热区 ${it.w}×${it.h} 小于 44×44`);
    assert.ok(!hit(it, L.capsule), `${it.id} 压到右上角胶囊区`);
  }
  for (let i = 0; i < L.items.length; i++) {
    for (let j = i + 1; j < L.items.length; j++) {
      assert.ok(!hit(L.items[i], L.items[j]), `${L.items[i].id} 与 ${L.items[j].id} 压在一起`);
    }
  }
  assert.equal(L.capsule.w, CAPSULE.w);
  assert.ok(L.w === DESIGN.w && L.h === DESIGN.h);
});

test('小游戏战场 HUD：命中测试与画出来的位置同源（每个按钮点中心都拿到自己的动作）', () => {
  const L = layoutBattle(BATTLE_MODEL);
  for (const it of L.items) {
    assert.deepEqual(hitTestBattle(L, it.x + it.w / 2, it.y + it.h / 2), it.action, `${it.id} 点中心没命中自己`);
  }
  assert.equal(hitTestBattle(L, DESIGN.w / 2, 150), null, '战场中间那块要返回 null（交给点塔位的逻辑）');
  assert.deepEqual(TOWER_ORDER.map((id) => L.byId[`tower-${id}`].cost).length, 4, '四种塔都要在 HUD 上');
});

test('小游戏战场 HUD：结算时「开波」换成「再开一局」', () => {
  const L = layoutBattle({ ...BATTLE_MODEL, result: 'win' });
  assert.ok(L.byId.restart, '结果出来之后要给「再开一局」');
  assert.ok(!L.byId.early, '这时候不该还挂着「开波」');
});

test('小游戏战场 HUD：画一帧有波次 / 金币 / 核心 / 塔造价（记录型 ctx 作证）', () => {
  const ctx = fakeCtx();
  drawBattleHud(ctx, {
    wave: { index: 3, phase: 'prep', timer: 9 }, length: 'short',
    gold: 200, lumber: [3], core: { hp: 1800, maxHp: 2400 }, result: null, stats: { leaks: 2 }, time: 100,
  }, layoutBattle(BATTLE_MODEL), { selectedTower: 'tw_arrow' });
  assert.ok(ctx.calls.length > 100, `HUD 这一帧调用太少（${ctx.calls.length}）`);
  assert.ok(ctx.texts.some((t) => t.includes('3 / 12 波')), '波次要画出来');
  assert.ok(ctx.texts.some((t) => t.includes('金 200')), '金币要画出来');
  assert.ok(ctx.texts.some((t) => t.includes('核心 1800/2400')), '核心血要画出来');
  assert.ok(ctx.texts.some((t) => t.includes('60 金')), '塔造价要画出来');
});

test('小游戏战场：在假 wx 里真的能打起来（点塔位建塔 → 开波 → 90 秒后有击杀、波次推进）', async () => {
  await import('../tools/build-minigame.mjs');   // 打一份包（顶层 await）
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    require(join(OUT, 'game.js'));
    const app = globalThis.__frostfallLobby;
    assert.ok(app, '入口要挂出调试口');
    assert.equal(app.screen(), 'lobby');

    app.startMatch();                       // 等同于在大厅点「单人开局」
    const m = app.match();
    const r = app.renderer();
    assert.equal(app.screen(), 'battle');
    assert.equal(m.mapId, 'map_01');

    // 点两个塔位的屏幕坐标（用渲染器的投影算，不手算等距公式）
    for (const i of [0, 1]) {
      const p = r.toScreen(m.map.slots[i].x, m.map.slots[i].y);
      const action = app.tap(p.x, p.y);
      assert.equal(action?.type, 'build', `点第 ${i} 个塔位应该建塔（实际 ${JSON.stringify(action)}）`);
    }
    assert.equal(m.towers.length, 2, '两座塔要真的建出来');

    // 开波（提前开波只把 timer 清零，下一 tick 才真的出怪）→ 跑 90 秒
    const early = app.layout().byId.early;
    app.tap(early.x + early.w / 2, early.y + early.h / 2);
    app.tick(90);
    app.drawFrame();

    assert.ok(m.wave.index >= 2, `90 秒该打完不止一波（实际第 ${m.wave.index} 波）`);
    assert.ok(m.stats.kills > 0, '塔与英雄要真的打出击杀');
    assert.ok(m.time > 80, `对局时间要往前走（实际 ${m.time.toFixed(0)}s）`);
    const texts = app.canvas.record.texts;
    assert.ok(texts.some((t) => /金 \d+/.test(t)), '战场 HUD 要画在这一帧里');
    assert.ok(texts.some((t) => t.includes('回大厅')), '出口要在这一帧里');
  } finally { fake.uninstall(); }
});
