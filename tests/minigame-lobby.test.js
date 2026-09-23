// 小游戏大厅那一屏（移植第 3 步）：**布局与命中测试都要有能失败的检查**。
// 这一层是纯函数（没有 DOM、没有 wx），所以直接在 Node 里测——ctx 用记录型假对象。
import test from 'node:test';
import assert from 'node:assert/strict';

import { CAPSULE, DEFAULT_HINT, DESIGN, applyLobbyAction, drawLobby, hitTestLobby, layoutLobby } from '../src/minigame/lobby.js';
import { emptyProfile, recordResult } from '../src/profile.js';
import { createLobbyModel } from '../src/minigame/game.js';

/** 记录型 ctx：把画法记下来，够断言「画了什么」 */
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

const model = (over = {}) => ({
  mode: 'td', map: 'map_01', difficulty: 'normal', length: 'short', hero: 'hero_warrior',
  profile: emptyProfile(), unlocked: ['map_01'], locked: {}, lockedReason: {},
  unlockedCount: 1, canStart: false, hint: null, ...over,
});

/**
 * 粗略估宽：中文一字 ≈ 1em、ASCII ≈ 0.5em。
 * 用它把「提示文案会不会溢出提示框」变成一条能失败的检查——
 * 第一版正是文案过长压到了右边的「单人开局」上（截图里一眼看见）。
 */
const estimateWidth = (line, size) => [...line].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? size : size * 0.5), 0);

test('小游戏大厅：可点元素都在画布内、≥44×44、互不重叠，且避开右上角胶囊区', () => {
  const L = layoutLobby(DESIGN.w, DESIGN.h, model());
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const it of L.items) {
    assert.ok(it.x >= 0 && it.y >= 0 && it.x + it.w <= L.w + 0.001 && it.y + it.h <= L.h + 0.001,
      `${it.id} 超出画布：${it.x},${it.y},${it.w}×${it.h}`);
    assert.ok(it.w >= 44 && it.h >= 44, `${it.id} 的热区 ${it.w}×${it.h} 小于 §1.9.2 的 44×44`);
    assert.ok(!hit(it, L.capsule), `${it.id} 压到了右上角胶囊区（官方布局要求避开）`);
  }
  for (let i = 0; i < L.items.length; i++) {
    for (let j = i + 1; j < L.items.length; j++) {
      assert.ok(!hit(L.items[i], L.items[j]), `${L.items[i].id} 与 ${L.items[j].id} 压在一起`);
    }
  }
  assert.ok(L.capsule.x + L.capsule.w <= L.w && L.capsule.y >= 0);
});

test('小游戏大厅：缩放到别的屏幕也守得住（真机 812×375 / 低于最小支持视口的 667×320 / 平板）', () => {
  for (const [w, h] of [[812, 375], [667, 320], [1024, 768]]) {
    const L = layoutLobby(w, h, model());
    const s = Math.min(w / DESIGN.w, h / DESIGN.h);
    for (const it of L.items) {
      assert.ok(it.x >= -0.001 && it.y >= -0.001 && it.x + it.w <= w + 0.001 && it.y + it.h <= h + 0.001,
        `${w}×${h} 下 ${it.id} 出界`);
      /**
       * 44pt 热区只对**声明支持的最小视口（667×375，与浏览器版 §3.1 #33 同一条线）**及以上成立：
       * 更矮的屏（667×320）我们仍然画得下、点得准，但按钮会随整屏等比缩到 37pt 左右——
       * 那属于「低于最小支持视口」，和浏览器版对 568×320 的处理一样（给提示 / 不承诺手感）。
       */
      if (h >= DESIGN.h) assert.ok(it.h >= 44 * s - 0.001, `${w}×${h} 下 ${it.id} 高度 ${it.h} < 44×${s.toFixed(2)}`);
    }
  }
});

test('小游戏大厅：命中测试与画出来的位置同源（点按钮中心拿到它的动作，点空白拿到 null）', () => {
  const L = layoutLobby(DESIGN.w, DESIGN.h, model());
  for (const it of L.items) {
    assert.deepEqual(hitTestLobby(L, it.x + it.w / 2, it.y + it.h / 2), it.action, `${it.id} 点中心没命中自己`);
  }
  assert.equal(hitTestLobby(L, 6, 6), null, '点左上角空白应该是 null');
});

test('小游戏大厅：切模式会换地图清单并落回已解锁的第一张（与浏览器大厅同一条规则）', () => {
  const m = model({ unlocked: ['map_01', 'def_01'], map: 'map_01' });
  const def = applyLobbyAction(m, { type: 'mode', value: 'defense' }, { unlocked: m.unlocked });
  assert.equal(def.mode, 'defense');
  assert.equal(def.map, 'def_01', '防守模式要落回已经解锁的防守图');
  const back = applyLobbyAction(def, { type: 'mode', value: 'td' }, { unlocked: m.unlocked });
  assert.equal(back.map, 'map_01');
});

test('小游戏大厅：点锁着的图只给一句「还没解锁」，不会把选择改过去', () => {
  const m = model({ locked: { map_06: '通关「亡者之径」' }, lockedReason: { map_06: '通关「亡者之径」' } });
  const next = applyLobbyAction(m, { type: 'map', value: 'map_06' }, { unlocked: m.unlocked, lockedReason: m.lockedReason });
  assert.equal(next.map, 'map_01', '锁着的图不许被选中');
  assert.match(next.hint, /还没解锁/);
  assert.match(next.hint, /亡者之径/);
});

test('小游戏大厅：画一帧真的把标题 / 档案 / 地图卡画出来（记录型 ctx 作证）', () => {
  const profile = recordResult(emptyProfile(), { mapId: 'map_01', difficulty: 'normal', result: 'win', timeSec: 500, coreHp: 900, leaks: 2 }).profile;
  const m = model({ profile, unlockedCount: 2 });
  const L = layoutLobby(DESIGN.w, DESIGN.h, m);
  const ctx = fakeCtx();
  drawLobby(ctx, m, L);
  assert.ok(ctx.calls.length > 300, `这一帧调用太少（${ctx.calls.length}），多半没真画`);
  assert.ok(ctx.texts.includes('冰封之地'), '标题没画出来');
  assert.ok(ctx.texts.some((t) => t.startsWith('霜原哨站')), '地图卡名没画出来');
  assert.ok(ctx.texts.some((t) => /人物 Lv\d+ · 声望 \d+/.test(t)), '档案那行没画出来');
  assert.ok(ctx.texts.some((t) => t.includes('第 4 步')), '「战斗还没接上」这句要写在界面上');
});

test('小游戏大厅：提示文案不会溢出提示框（第一版就是这样压到「单人开局」上的）', () => {
  const L = layoutLobby(DESIGN.w, DESIGN.h, model());
  for (const line of DEFAULT_HINT) {
    assert.ok(estimateWidth(line, 10) <= L.hint.w,
      `提示「${line}」估宽 ${estimateWidth(line, 10).toFixed(0)} > 提示框 ${L.hint.w.toFixed(0)}`);
  }
  // 提示框本身也不能和任何可点元素重叠（尤其是右下那颗开始按钮）
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const it of L.items) assert.ok(!hit(L.hint, it), `提示框与 ${it.id} 重叠`);
});

test('小游戏大厅：上次那套配置（§2.1）要能一键沿用，脏值一律落回默认（§177）', () => {
  const base = emptyProfile();
  // 上次打的是防守：模式 / 难度 / 英雄 / 时长 都要照它选
  const last = createLobbyModel({
    ...base,
    lastChoice: { mode: 'defense', map: 'def_01', difficulty: 'nightmare', hero: 'hero_mage', length: 'long' },
  });
  assert.equal(last.mode, 'defense');
  assert.equal(last.map, 'def_01');
  assert.equal(last.difficulty, 'nightmare');
  assert.equal(last.hero, 'hero_mage');
  assert.equal(last.length, 'long');

  // 上次那张图**这号人物没解锁**时落回该模式的第一张（不是照搬一个点不了的图）
  const locked = createLobbyModel({
    ...base,
    lastChoice: { mode: 'td', map: 'map_06', difficulty: 'hard', hero: 'hero_warrior', length: 'long' },
  });
  assert.equal(locked.mode, 'td');
  assert.ok(locked.unlocked.includes(locked.map), `落回的那张要解锁（实际 ${locked.map}）`);
  assert.equal(locked.difficulty, 'hard', '图不合法只影响图，难度照旧沿用');

  // 跨版本的脏值：不抛、也不用它（§177 那条边界）
  const dirty = createLobbyModel({
    ...base,
    lastChoice: { mode: 'bogus', map: 'nope', difficulty: 'impossible', hero: 'hero_nobody', length: 'endless' },
  });
  assert.equal(dirty.mode, 'td');
  assert.equal(dirty.map, 'map_01');
  assert.equal(dirty.difficulty, 'normal');
  assert.equal(dirty.hero, 'hero_warrior');
  assert.equal(dirty.length, 'short');
});
