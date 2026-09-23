// 小游戏战场那一屏（移植第 3 步的第二屏）：HUD 的布局/命中/绘制 + 一条**能真的打起来**的闭环。
// 前半是纯函数（零 DOM），后半在假 wx 里把打包产物跑起来：点塔位建塔 → 开波 → 跑 90 秒 → 有击杀、波次推进。
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CAPSULE, DESIGN, PRIORITY_LABEL, TOWER_ORDER,
  drawBattleHud, drawSheet, hitTestBattle, hitTestSheet, layoutBattle, layoutSheet,
} from '../src/minigame/battle.js';
import { installFakeWx } from '../tools/fake-wx.mjs';
import { TOWER_MAX_LEVEL } from '../src/data.js';
import { buyItem, createMatch, makeEquipment, potionCount, update } from '../src/match.js';
import { createDefenseMatch } from '../src/defense.js';
import { SHOP_ITEMS } from '../src/data.js';
import { drawResult, layoutBag, layoutItem, layoutPause, layoutResult, layoutShop } from '../src/minigame/battle.js';

// 与 minigame-bundle.test.js 同一个道理：**各有各的产物目录**，否则并发跑会互相踩
const OUT = mkdtempSync(join(tmpdir(), 'ff-mini-battle-'));
process.env.FF_MINIGAME_OUT = OUT;

/** 复制成新文件名再 require：ESM 缓存按路径走，于是能拿到一个**全新的大厅开局**（老用例共用实例，不能选英雄） */
const loadFreshApp = (require, n) => {
  const p = join(OUT, `game-${n}.js`);
  copyFileSync(join(OUT, 'game.js'), p);
  require(p);
  return globalThis.__frostfallLobby;
};

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
  // 小地图是防守专属（跟随相机下才需要那张全局视图）——TD 这边不该有那一格
  assert.ok(!L.items.some((it) => it.id === 'minimap'), 'TD 的 HUD 上不该有小地图');
});

test('小游戏战场 HUD：命中测试与画出来的位置同源（每个按钮点中心都拿到自己的动作）', () => {
  const L = layoutBattle(BATTLE_MODEL);
  for (const it of L.items) {
    assert.deepEqual(hitTestBattle(L, it.x + it.w / 2, it.y + it.h / 2), it.action, `${it.id} 点中心没命中自己`);
  }
  assert.equal(hitTestBattle(L, DESIGN.w / 2, 150), null, '战场中间那块要返回 null（交给点塔位的逻辑）');
  assert.equal(TOWER_ORDER.length, 4, '四种塔（建造改到「点塔位弹面板」之后，HUD 上不再各占一个键）');
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
  assert.ok(ctx.texts.some((t) => t.includes('商店')) && ctx.texts.some((t) => t.includes('背包')), '商店/背包入口要画出来');
});

test('小游戏战场 HUD：下一波预告那一行（§8.3）画出来，太长就裁到宽度里', () => {
  const L = layoutBattle(BATTLE_MODEL);
  const ctx = fakeCtx();
  drawBattleHud(ctx, {
    wave: { index: 3, phase: 'prep', timer: 9 }, length: 'short',
    gold: 200, lumber: [3], core: { hp: 1800, maxHp: 2400 }, result: null, stats: {}, time: 100,
  }, L, { preview: '下一波：【精英波】3×冰霜食尸鬼（中甲） + 2×霜狼（轻甲）' });
  assert.ok(ctx.texts.some((t) => t.includes('下一波：【精英波】') && t.includes('中甲')), '预告要画出来（含护甲）');

  // 一句话长过那一行的宽度时裁成「…」收尾（小游戏没有 CSS 的 text-overflow）
  const long = fakeCtx();
  drawBattleHud(long, {
    wave: { index: 3, phase: 'prep', timer: 9 }, length: 'short',
    gold: 200, lumber: [3], core: { hp: 1800, maxHp: 2400 }, result: null, stats: {}, time: 100,
  }, L, { preview: '下一波：'.repeat(20) });
  const line = long.texts.find((t) => t.startsWith('下一波：'));
  assert.ok(line.endsWith('…'), `裁过的预告要以省略号收尾（实际「${line}」）`);
  assert.ok(line.length < 100 * 4, '裁过之后要明显短于原文');
  assert.equal(L.preview.y, 48, '预告那一行在顶栏（38）与提示行（60）之间');
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
      assert.equal(action?.type, 'openBuild', `点第 ${i} 个空塔位应该弹出建造面板（实际 ${JSON.stringify(action)}）`);
      const sheet = app.getModel().sheet;
      assert.equal(sheet.kind, 'build', '弹出来的应该是「选塔种」那张');
      const row = sheet.byId['build-tw_arrow'];
      app.tap(row.x + row.w / 2, row.y + row.h / 2);
      // 建完会自动切到这座塔的面板 —— 关掉它，否则下一个塔位那一下会被弹层吃掉
      const close = app.getModel().sheet.byId.close;
      app.tap(close.x + close.w / 2, close.y + close.h / 2);
    }
    assert.equal(m.towers.length, 2, '在弹层里选塔之后，两座塔要真的建出来');
    assert.equal(app.getModel().sheet, null, '关掉面板之后就不该再有弹层');

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

test('小游戏弹层：建造面板 4 种塔 + 取消，行的热区 ≥44 且在画布内', () => {
  const m = { gold: 200, towers: [], map: { slots: [{ x: 3, y: 4 }], def: {} } };
  const sheet = layoutSheet(m, { selectedSlot: 0 });
  assert.equal(sheet.kind, 'build');
  assert.equal(sheet.rows.length, TOWER_ORDER.length + 1, '四种塔 + 取消');
  for (const id of TOWER_ORDER) assert.ok(sheet.byId[`build-${id}`], `缺少 ${id} 的建造行`);
  for (const r of sheet.rows) {
    assert.ok(r.h >= 44, `${r.id} 行高 ${r.h} < 44（§1.9.2）`);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= DESIGN.w && r.y + r.h <= DESIGN.h, `${r.id} 出界`);
  }
  // 买不起的塔要灰掉（不给「点了没反应」）
  const poor = layoutSheet({ gold: 10, towers: [], map: { slots: [{ x: 1, y: 1 }], def: {} } }, { selectedSlot: 0 });
  assert.ok(poor.rows.filter((r) => r.id.startsWith('build-')).every((r) => r.disabled), '钱不够时四种塔都该是灰的');
  // 命中：点取消 = 关掉；点面板外 = 也当成关掉（比要求点准关闭友好）
  assert.deepEqual(hitTestSheet(sheet, sheet.byId.cancel.x + 4, sheet.byId.cancel.y + 4), { type: 'close' });
  assert.deepEqual(hitTestSheet(sheet, 700, 370), { type: 'close' });
});

test('小游戏弹层：塔面板给读数 + 升级 / 出售 / 四档优先级，满级与买不起都灰掉', () => {
  const tower = {
    slot: 0, towerId: 'tw_arrow', level: 2, invested: 120, priority: 'front', cell: { x: 3, y: 4 },
    stats: { damage: 18, atkSpeed: 1.5, range: 5, hitsAir: true, attackType: 'normal' },
  };
  const m = {
    gold: 500, towers: [tower], map: { def: {}, slots: [tower.cell] },
  };
  const sheet = layoutSheet(m, { panelSlot: 0 });
  assert.equal(sheet.kind, 'tower');
  assert.ok(sheet.byId.upgrade && sheet.byId.sell && sheet.byId.close, '升级/出售/关闭都要在');
  for (const p of ['front', 'strongest', 'weakest', 'air_first']) {
    assert.ok(sheet.byId[`prio-${p}`], `缺优先级 ${p}`);
    assert.equal(sheet.byId[`prio-${p}`].label, PRIORITY_LABEL[p]);
  }
  assert.ok(sheet.byId['prio-front'].on, '当前优先级要高亮');
  assert.match(sheet.hint, /伤害 18\.0/, '面板要写清塔的读数');
  assert.match(sheet.byId.sell.sub, /返还 \d+ 金/);
  // 满级：升级行灰掉且写「已满级」
  const maxed = layoutSheet({ ...m, towers: [{ ...tower, level: TOWER_MAX_LEVEL }] }, { panelSlot: 0 });
  assert.equal(maxed.byId.upgrade.disabled, true);
  assert.match(maxed.byId.upgrade.label, /已满级/);
  // 出售两步：armed 之后标签变「确认出售」，颜色转危险色
  const armed = layoutSheet(m, { panelSlot: 0, sellArmed: true });
  assert.equal(armed.byId.sell.label, '确认出售');
  assert.equal(armed.byId.sell.danger, true);
});

test('小游戏弹层：画一帧把标题 / 读数 / 各行动作画出来（记录型 ctx 作证）', () => {
  const tower = {
    slot: 0, towerId: 'tw_frost', level: 1, invested: 120, priority: 'air_first', cell: { x: 3, y: 4 },
    stats: { damage: 8, atkSpeed: 1.2, range: 4.5, hitsAir: false, attackType: 'magic' },
  };
  const sheet = layoutSheet({ gold: 300, towers: [tower], map: { def: {}, slots: [tower.cell] } }, { panelSlot: 0 });
  const ctx = fakeCtx();
  drawSheet(ctx, sheet);
  assert.ok(ctx.calls.length > 60, `弹层这一帧调用太少（${ctx.calls.length}）`);
  assert.ok(ctx.texts.some((t) => t.includes('冰塔')), '塔名要画出来');
  assert.ok(ctx.texts.some((t) => t.includes('伤害')), '读数要画出来');
  assert.ok(ctx.texts.some((t) => t.includes('升级')), '升级按钮要画出来');
  assert.ok(ctx.texts.some((t) => t.includes('空中优先')), '优先级按钮要画出来');
});

test('小游戏商店：每件商品一行（含撤柜与买不起的灰态），关闭行在画布内', () => {
  const m = createMatch({ seed: 5 });
  m.gold = 10;   // 都买不起
  const sheet = layoutShop(m, {});
  assert.equal(sheet.kind, 'shop');
  assert.equal(sheet.rows.length, SHOP_ITEMS.length + 1, '每件商品 + 关闭');
  for (const it of SHOP_ITEMS) {
    const row = sheet.byId[`buy-${it.id}`];
    assert.ok(row, `少了 ${it.id} 的行`);
    assert.equal(row.disabled, true, '钱不够时每一行都该灰掉');
    assert.ok(row.y + row.h <= DESIGN.h, `${it.id} 行出界`);
  }
  // §3.1 #20：塔防里回城卷轴与群疗符是「已撤柜」，要说出来而不是静默没有
  const blocked = sheet.byId['buy-scroll_town'];
  assert.match(blocked.sub, /已撤柜/);
  // 给够钱就恢复可点
  m.gold = 5000;
  const rich = layoutShop(m, {});
  assert.ok(rich.rows.filter((r) => r.id.startsWith('buy-') && !r.disabled).length >= 4, '钱够了大部分商品要可点');

  // 木材：秘传书要 20 木材——只有金币时也要灰（以前只比金币，点了才发现买不了）
  const tm = createMatch({ seed: 5 });
  tm.gold = 5000;
  tm.lumber[0] = 0;
  assert.equal(layoutShop(tm, {}).byId['buy-book_secret'].disabled, true, '木材不够也要灰掉');
  tm.lumber[0] = 20;
  assert.equal(layoutShop(tm, {}).byId['buy-book_secret'].disabled, false, '木材补上就恢复可点');
});

test('小游戏商店：防守「走远了」要说「回基地再买」（§3.1 #14 的商店在基地里）', () => {
  const dm = createDefenseMatch({ seed: 5 });
  dm.gold = 5000;
  const near = dm.shopNear;
  dm.hero.cell = { x: Math.min(dm.grid.w - 1, near.x + near.r + 3), y: near.y };
  const far = layoutShop(dm, {});
  const row = far.byId['buy-pot_small'];
  assert.equal(row.reason, '回基地再买', '走远了那一行要说清原因，而不是让玩家点了才发现');
  assert.equal(row.disabled, true);
  assert.match(far.hint, /商店在基地里/);
  // 回到基地就恢复可点；而且内核也不再让你买（两处同一条规则）
  dm.hero.cell = { x: near.x, y: near.y };
  assert.equal(layoutShop(dm, {}).byId['buy-pot_small'].disabled, false, '回基地就该恢复可点');
  assert.ok(buyItem(dm, 'pot_small', 0), '回到基地之后内核也要真的卖给你');
});

test('小游戏背包：列出已装备与最近掉落、可合成时给「一键合成」、点一件进详情', () => {
  const m = createMatch({ seed: 5 });
  m.inventory.push(makeEquipment(m, 'weapon', 'blue', 6), makeEquipment(m, 'armor', 'blue', 6),
    makeEquipment(m, 'trinket', 'blue', 6));
  const sheet = layoutBag(m, {});
  assert.equal(sheet.kind, 'bag');
  assert.equal(sheet.rows.filter((r) => r.id.startsWith('item-')).length, 3, '三件都要列出来');
  assert.ok(!sheet.byId.craft, '三件不同部位合不了，不该出现合成行');
  assert.match(sheet.hint, /同部位同品质/);
  // 三件同部位同品质 → 出现「一键合成」，且两步确认时转危险色
  m.inventory.push(makeEquipment(m, 'weapon', 'blue', 6), makeEquipment(m, 'weapon', 'blue', 6));   // 武器凑到 3 件
  const canCraft = layoutBag(m, {});
  assert.ok(canCraft.byId.craft, '凑够 3 件同部位同品质要给合成入口');
  assert.match(canCraft.byId.craft.sub, /3 件稀有武器 → 1 件/);
  assert.equal(layoutBag(m, { craftArmed: true }).byId.craft.label, '确认合成？');
  assert.equal(layoutBag(m, { craftArmed: true }).byId.craft.danger, true);
  // 点一件 → 详情面板
  const uid = m.inventory[0].uid;
  const item = layoutItem(m, { itemUid: uid });
  assert.equal(item.kind, 'item');
  assert.ok(item.byId.equip && item.byId.enhance && item.byId.sell, '详情要有穿上/强化/出售');
  assert.match(item.byId.sell.sub, /返还 \d+ 金/);
  // 已装备的那件没有「穿上」，但有强化/出售
  const eq = layoutItem(m, { itemUid: uid, equippedUid: uid });
  assert.ok(eq.byId.enhance && eq.byId.sell);
});

test('小游戏商店闭环：在假 wx 里点开商店 → 买药 → 点药品键用掉（走的是内核那几个函数）', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    require(join(OUT, 'game.js'));
    const app = globalThis.__frostfallLobby;
    app.startMatch();
    const m = app.match();
    const gold0 = m.gold;

    const tapBtn = (id) => {
      const b = app.layout().byId[id];
      assert.ok(b, `底部没有 ${id} 这个入口`);
      return app.tap(b.x + b.w / 2, b.y + b.h / 2);
    };
    assert.equal(tapBtn('shop').type, 'shop', '点商店要开商店');
    const sheet = app.getModel().sheet;
    assert.equal(sheet.kind, 'shop');
    const row = sheet.byId['buy-pot_small'];
    app.tap(row.x + row.w / 2, row.y + row.h / 2);
    assert.equal(potionCount(m), 1, '买到的药要进药品格');
    assert.equal(m.gold, gold0 - 30, `小药 30 金（金币 ${gold0} → ${m.gold}）`);

    // 关掉商店 → 点「药品」键真的用掉一瓶
    const close = app.getModel().sheet.byId.close;
    app.tap(close.x + close.w / 2, close.y + close.h / 2);
    assert.equal(app.getModel().sheet, null, '关掉之后不该再有弹层');
    tapBtn('potion');
    assert.equal(potionCount(m), 0, '药品键要把药喝掉');
  } finally { fake.uninstall(); }
});

test('小游戏结算面板：内容取自浏览器版那个 resultPanelModel（结果行 / 伤害占比 / 掉落 / 声望）', () => {
  const m = createMatch({ seed: 5 });
  m.time = 480;
  m.stats.leaks = 2;
  m.stats.drops = 12;
  m.stats.kills = 88;
  m.stats.damage = { hero: 640, tw_arrow: 320, tw_cannon: 90 };
  m.result = 'win';
  const R = layoutResult(m, { gain: 120, leveledUp: true, commanderLevel: 4 });
  assert.equal(R.kind, 'result');
  assert.equal(R.model.title, '通关！');
  assert.ok(R.rows.some((r) => r.label === '单局时长' && r.value === '8.0 分钟'));
  assert.ok(R.rows.some((r) => r.label === '漏怪' && r.value === '2 只'));
  assert.match(R.damageLine, /英雄 \d+% · 箭塔 \d+% · 炮塔 \d+%/);
  assert.match(R.lootLine, /掉落 12 件/);
  assert.equal(R.repLine, '声望 +120');
  assert.equal(R.levelLine, '人物等级 → 4');
  // 画一帧：标题 / 伤害占比 / 掉落 / 声望都要落在这份记录里
  const ctx = fakeCtx();
  drawResult(ctx, R);
  for (const needle of ['通关！', '伤害占比', '掉落 12 件', '声望 +120', '再开一局']) {
    assert.ok(ctx.texts.some((t) => t.includes(needle)), `结算面板缺「${needle}」`);
  }
  // 没结束的局没有面板
  assert.equal(layoutResult(createMatch({ seed: 5 }), {}), null);

  // 防守那一局走的是**同一份视图模型**（§151：一个面板不能两种说法）——标题与结果行都要换成防守那套
  const dm = createDefenseMatch({ seed: 5 });
  dm.time = 900;
  dm.stats.roundsCleared = 4;
  dm.stats.fieldKills = 31;
  dm.stats.castleHits = 7;
  dm.result = 'win';
  const DR = layoutResult(dm, { gain: 60 });
  assert.equal(DR.model.title, '守住了！');
  assert.ok(DR.rows.some((r) => r.label === '守住轮次' && r.value.startsWith('4 / 4')), '防守的结果行要写守住轮次');
  assert.ok(DR.rows.some((r) => r.label === '城堡剩余' && r.label !== '核心剩余'), '防守写城堡，不写核心');
});

test('小游戏结算：一局结束后真的记档（声望 +120、解锁与大厅那行都跟着变），且只记一次', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    require(join(OUT, 'game.js'));
    const app = globalThis.__frostfallLobby;
    app.startMatch();
    const m = app.match();
    m.time = 420;
    m.stats.leaks = 1;
    m.result = 'win';
    app.drawFrame();
    const saved = JSON.parse(globalThis.wx.getStorageSync('frostfall:profile') || '{}');
    assert.equal(saved.reputation, 120, '通关普通档 +120 声望要落到档案里');
    assert.equal(saved.clears?.map_01?.wins, 1, '战绩要记这一局');
    // 再画几帧不许重复记（§188 的「一局只记一次」）
    app.drawFrame();
    app.tick(5);
    app.drawFrame();
    const again = JSON.parse(globalThis.wx.getStorageSync('frostfall:profile') || '{}');
    assert.equal(again.reputation, 120, '同一局不许记第二次');
    assert.equal(again.playCount, 1);
    // 回大厅之后，大厅那行读到的就是新档案（人物等级 / 声望 / 可玩地图）
    app.backToLobby();
    assert.equal(app.screen(), 'lobby');
    assert.equal(app.getModel().profile.reputation, 120);
  } finally { fake.uninstall(); }
});

test('小游戏暂停面板：行都在画布内且 ≥44，倍速/镜头/震动按当前设置显示', () => {
  const m = createMatch({ seed: 5 });
  const sheet = layoutPause(m, { rate: 2, settings: { tdFitAll: false, sfx: false } });
  assert.equal(sheet.kind, 'pause');
  assert.equal(sheet.rows.length, 10,
    '继续 / 倍速 / 镜头 / 音效震动 / 特效 / 波次预告 / 回大厅 / 重看引导 / 重置进度 / 收起面板');
  for (const r of sheet.rows) {
    assert.ok(r.h >= 44 && r.y + r.h <= DESIGN.h, `${r.id} 行高或位置不达标`);
    assert.ok(!(r.x < 448 && r.y < 52 && r.x + r.w > 396), `${r.id} 压到顶栏那两个键上`);
  }
  assert.equal(sheet.byId.speed.sub, '2×');
  assert.equal(sheet.byId.camera.sub, '放大', 'tdFitAll=false 时是放大');
  assert.equal(sheet.byId.sfx.sub, '关');
  assert.equal(sheet.byId.effects.sub, '高', '特效那一格要显示当前档');
  assert.equal(sheet.byId.resume.label, '继续游戏');
  assert.ok(sheet.byId.replayTutorial, '§153 的「重看新手引导」要在这儿（浏览器版在设置面板里同一个动作）');
  assert.ok(sheet.byId.wavePreview, '§154：TD 这边摆「波次预告」');
  assert.ok(!sheet.byId.autoPickup, 'TD 不摆「自动拾取」（那是防守专用）');
  assert.equal(sheet.byId.resetProgress.label, '重置进度', '不可逆的动作走两步确认');
  const armed = layoutPause(m, { settings: {}, resetArmed: true }).byId.resetProgress;
  assert.match(armed.label, /再点一次确认/);
});

test('小游戏暂停与倍速：暂停时内核一步不走，倍速按倍数走，镜头/震动落进设置', async () => {
  await import('../tools/build-minigame.mjs');
  const vib = [];
  const fake = installFakeWx({ onVibrate: (o) => vib.push(o.type) });
  try {
    const require = createRequire(import.meta.url);
    require(join(OUT, 'game.js'));
    const app = globalThis.__frostfallLobby;
    app.startMatch();
    const m = app.match();
    const tapBtn = (id) => {
      const b = app.layout().byId[id];
      assert.ok(b, `顶栏/底排没有 ${id}`);
      return app.tap(b.x + b.w / 2, b.y + b.h / 2);
    };
    // 暂停 → 时间不动
    tapBtn('pause');
    assert.equal(app.getModel().paused, true);
    assert.equal(app.getModel().sheet.kind, 'pause');
    const t0 = m.time;
    app.tick(30);
    assert.equal(m.time, t0, '暂停时内核一步都不该走');

    // 镜头：切成放大 → 设置里 tdFitAll=false
    const cam = app.getModel().sheet.byId.camera;
    app.tap(cam.x + cam.w / 2, cam.y + cam.h / 2);
    assert.equal(JSON.parse(globalThis.wx.getStorageSync('frostfall:settings') || '{}').tdFitAll, false);
    // 震动：关掉之后不再调 wx.vibrateShort
    const sfx = app.getModel().sheet.byId.sfx;
    app.tap(sfx.x + sfx.w / 2, sfx.y + sfx.h / 2);
    assert.equal(JSON.parse(globalThis.wx.getStorageSync('frostfall:settings') || '{}').sfx, false);
    const callsAfterMute = vib.length;
    const resume = app.getModel().sheet.byId.resume;
    app.tap(resume.x + resume.w / 2, resume.y + resume.h / 2);
    assert.equal(app.getModel().paused, false, '继续之后要恢复推进');
    assert.equal(vib.length, callsAfterMute, '关掉震动之后按按钮不该再震');

    // 倍速：同一段时间走两步
    tapBtn('speed');
    assert.equal(app.getModel().rate, 2);
    // 暂停面板里的读数要**跟着活状态走**：以前这里传的是 `b.ui`（只有 `{sheetKind:'pause'}`），
    // 于是跑着 2× 的面板写着「1×」、关了震动的写着「开」——面板不能两种说法（§151 同一条）
    tapBtn('pause');
    assert.equal(app.getModel().sheet.byId.speed.sub, '2×', '面板要显示当前的倍速档');
    assert.equal(app.getModel().sheet.byId.camera.sub, '放大', '面板要显示当前的镜头档');
    assert.equal(app.getModel().sheet.byId.sfx.sub, '关', '面板要显示当前的震动档');
    const back = app.getModel().sheet.byId.resume;
    app.tap(back.x + back.w / 2, back.y + back.h / 2);
    const t1 = m.time;
    app.tick(10);
    assert.ok(Math.abs((m.time - t1) - 10) < 0.2, `倍速下 tick(10) 该走 10 秒（实际 ${(m.time - t1).toFixed(1)}）`);
  } finally { fake.uninstall(); }
});

test('小游戏技能键：名字 / 等级 / 冷却都从内核取，解锁几个就画几个（写死两个是不行的）', () => {
  const L = layoutBattle({
    ...BATTLE_MODEL,
    skills: [
      { name: '旋风斩', lv: 1, cd: 0, locked: false },
      { name: '战吼', lv: 1, cd: 7.4, locked: false },
      { name: '破甲突刺', lv: 2, cd: 0, locked: false },
    ],
  });
  assert.ok(L.byId['skill-0'] && L.byId['skill-1'] && L.byId['skill-2'], '三个技能要三颗键');
  assert.equal(L.byId['skill-2'].label, '破甲突刺', '键上写的是技能名，不是「技能 3」');
  assert.equal(L.byId['skill-0'].sub, 'Lv1', '不在冷却就写等级');
  assert.equal(L.byId['skill-1'].sub, '8s', '冷却中写剩余秒数（向上取整）');
  assert.equal(L.byId['skill-1'].disabled, true, '冷却中那颗要灰掉');
  assert.equal(L.byId['skill-2'].disabled, false);
  // 三颗键不许互相压住，也不许压到「回大厅」
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const id of ['skill-0', 'skill-1', 'skill-2']) {
    assert.ok(!hit(L.byId[id], L.byId.lobby), `${id} 压到了「回大厅」`);
  }
  // 只有两个技能的英雄：第三颗键不该凭空出现
  const two = layoutBattle({ ...BATTLE_MODEL, skills: [{ name: '旋风斩', lv: 1 }, { name: '战吼', locked: true }] });
  assert.ok(two.byId['skill-1'] && !two.byId['skill-2']);
  assert.equal(two.byId['skill-1'].label, '战吼', '没解锁的技能也要写名字（灰掉表示还不能用）');
  assert.equal(two.byId['skill-1'].disabled, true);
});

test('小游戏技能键：商店买了「技能书·秘传」之后，第三颗键真的出现而且能放', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 9);
    /**
     * 选法师再开局：他的第三技能是「时间扭曲」（以自身为中心减速），**空场也能放**；
     * 战士那颗「破甲突刺」要够得着怪，备战期没怪会返回 false——测不出「键到底能不能用」。
     */
    const mage = app.layout().byId['hero-hero_mage'];
    app.tap(mage.x + mage.w / 2, mage.y + mage.h / 2);
    app.startMatch();
    const m = app.match();
    m.gold = 5000;
    m.lumber[0] = 99;
    // 与浏览器版一致：第三个技能键**一开始就在那儿，但是灰的**（玩家知道有这么个东西、书能解锁它）
    assert.equal(app.layout().byId['skill-2'].disabled, true, '前提：没买书之前第三颗键是灰的');

    // 商店 → 买技能书·秘传（内核会把第三个技能解锁）
    const shop = app.layout().byId.shop;
    app.tap(shop.x + shop.w / 2, shop.y + shop.h / 2);
    const buy = app.getModel().sheet.byId['buy-book_secret'];
    app.tap(buy.x + buy.w / 2, buy.y + buy.h / 2);
    assert.equal(m.hero.skillUnlocked[2], true, '前提：书买到手就要解锁第三个技能');
    const close = app.getModel().sheet.byId.close;
    app.tap(close.x + close.w / 2, close.y + close.h / 2);

    // 底部那排要多出一颗键（名字是内核里那个技能名），点了真的能放
    app.drawFrame();
    const third = app.layout().byId['skill-2'];
    assert.ok(third, '第三颗键要在（以前只画两个死键，买书的人根本找不到它）');
    assert.equal(third.label, m.hero.def.thirdSkill.name);
    assert.equal(third.disabled, false, '买了书之后要能点（以前这颗键压根不存在）');
    app.tap(third.x + third.w / 2, third.y + third.h / 2);
    assert.ok(m.hero.skillCd[2] > 0, '点下去要真的进冷却（放出来了）');
    app.drawFrame();   // 布局是每帧重算的：读副标之前先画一帧
    assert.equal(app.layout().byId['skill-2'].sub, `${Math.ceil(m.hero.skillCd[2])}s`, '键上要写剩余冷却');
  } finally { fake.uninstall(); }
});

test('小游戏波次预告：开波前那一行来自波次表，设置里关掉就说「已在设置里关闭」', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 10);
    app.startMatch();
    app.drawFrame();
    // 第一局默认开着：那一行要把下一波的怪与护甲写出来（§6.2 的克制博弈靠它）
    // 记录是**跨帧累积**的，所以要取最后一条（最近一帧画出来的那一句）
    const line = () => app.canvas.record.texts.findLast((t) => t.startsWith('下一波：'));
    assert.match(String(line()), /下一波：.*（.+甲/);
    // 暂停面板里那颗「波次预告」真的能关：面板读数 + HUD 那一行都跟着变
    const pause = app.layout().byId.pause;
    app.tap(pause.x + pause.w / 2, pause.y + pause.h / 2);
    assert.equal(app.getModel().sheet.byId.wavePreview.sub, '开');
    const row = app.getModel().sheet.byId.wavePreview;
    app.tap(row.x + row.w / 2, row.y + row.h / 2);
    assert.equal(app.getModel().sheet.byId.wavePreview.sub, '关', '切完面板要显示「关」');
    assert.equal(JSON.parse(globalThis.wx.getStorageSync('frostfall:settings') || '{}').showWavePreview, false, '要落盘');
    const resume = app.getModel().sheet.byId.resume;
    app.tap(resume.x + resume.w / 2, resume.y + resume.h / 2);
    app.drawFrame();
    assert.match(String(line()), /已在设置里关闭/, '关掉之后那一行要说清是「我关了」，不是把这行藏起来');
  } finally { fake.uninstall(); }
});

test('小游戏「重置进度」：两步确认之后真的清空声望与解锁（不可逆动作的老规矩）', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 11);
    app.startMatch();
    const m = app.match();
    // 先攒一点进度：打完一局（记档那一步会写声望与解锁）
    m.time = 400;
    m.stats.kills = 40;
    m.result = 'win';
    app.drawFrame();
    const saved = JSON.parse(globalThis.wx.getStorageSync('frostfall:profile') || '{}');
    assert.ok(saved.reputation > 0, `前提：这一局记了档（声望 ${saved.reputation}）`);

    // 暂停面板里那一行：第一次点只转到「再点一次确认」，档案一个字都不能动
    const pause = app.layout().byId.pause;
    app.tap(pause.x + pause.w / 2, pause.y + pause.h / 2);
    const tapSheet = (id) => {
      const r = app.getModel().sheet.byId[id];
      assert.ok(r, `面板上找不到 ${id}`);
      app.tap(r.x + r.w / 2, r.y + r.h / 2);
    };
    tapSheet('resetProgress');
    assert.match(app.getModel().sheet.byId.resetProgress.label, /再点一次确认/);
    assert.ok(JSON.parse(globalThis.wx.getStorageSync('frostfall:profile') || '{}').reputation > 0,
      '第一次点不许真的清掉');
    // 第二次点：清空（不可逆动作两步确认，§1.9.2）
    tapSheet('resetProgress');
    const after = globalThis.wx.getStorageSync('frostfall:profile');
    assert.ok(!after || JSON.parse(String(after)).reputation === 0, `档案要清掉（实际 ${after}）`);
    // 回大厅：那行档案按新档案算（声望 0、可玩 1 张）
    // 重置之后面板收起了（这一局还是暂停态）：先「继续」再「暂停」，把面板重新摊开
    app.tap(pause.x + pause.w / 2, pause.y + pause.h / 2);
    assert.equal(app.getModel().paused, false, '那一下是「继续」');
    app.tap(pause.x + pause.w / 2, pause.y + pause.h / 2);
    tapSheet('lobby');
    assert.equal(app.screen(), 'lobby');
    assert.equal(app.getModel().profile.reputation, 0, '大厅那行要按新档案算');
    // 起点就是「一张 TD + 一张防守」（新档案默认解锁 map_01 / def_01）
    assert.equal(app.getModel().unlockedCount, 2, '解锁也回到起点');
  } finally { fake.uninstall(); }
});

test('小游戏平台杂项：玩的时候屏幕常亮；§10.7 的内存告警自动切低特效（并能改回来）', async () => {
  await import('../tools/build-minigame.mjs');
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    const app = loadFreshApp(require, 12);
    // ① 屏幕常亮：启动时就调一次（一局十几分钟，盯塔时可能一直不碰屏幕）
    assert.ok(fake.platform.keepScreenOn.includes(true), `启动要申请屏幕常亮（实际 ${JSON.stringify(fake.platform.keepScreenOn)}）`);
    assert.ok(fake.platform.memoryWarning >= 1, '要接上 wx.onMemoryWarning，否则系统只会直接杀进程');

    app.startMatch();
    // 把渲染器的 draw 包一层：只看它拿到什么 pulses（§116 的低特效档关的就是这个）
    const seen = [];
    const r = app.renderer();
    const orig = r.draw;
    r.draw = (view) => { seen.push(view.pulses); return orig(view); };
    app.drawFrame();
    assert.equal(seen.at(-1), true, '默认是高档：脉冲开着');

    // ② 内存告警 → 自动切低特效（同一份设置），并给玩家一句提示
    assert.equal(fake.fireMemoryWarning(10), true, '告警要真的送到入口那个回调');
    assert.equal(JSON.parse(globalThis.wx.getStorageSync('frostfall:settings') || '{}').effects, 'low', '要落盘成低特效');
    app.drawFrame();
    assert.equal(seen.at(-1), false, '低特效档要把脉冲关掉');
    assert.ok(app.canvas.record.texts.some((t) => t.includes('内存告警')), '要提示一句，别让玩家以为画面坏了');

    // ③ 暂停面板里那一格能改回来（不是一条单行道）
    const pause = app.layout().byId.pause;
    app.tap(pause.x + pause.w / 2, pause.y + pause.h / 2);
    assert.equal(app.getModel().sheet.byId.effects.sub, '低', '面板要显示当前是低档');
    const row = app.getModel().sheet.byId.effects;
    app.tap(row.x + row.w / 2, row.y + row.h / 2);
    assert.equal(JSON.parse(globalThis.wx.getStorageSync('frostfall:settings') || '{}').effects, 'high', '点一下切回高档');
    const resume = app.getModel().sheet.byId.resume;
    app.tap(resume.x + resume.w / 2, resume.y + resume.h / 2);
    app.drawFrame();
    assert.equal(seen.at(-1), true, '切回高档之后脉冲回来');
  } finally { fake.uninstall(); }
});
