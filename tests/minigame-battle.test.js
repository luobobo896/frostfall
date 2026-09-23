// 小游戏战场那一屏（移植第 3 步的第二屏）：HUD 的布局/命中/绘制 + 一条**能真的打起来**的闭环。
// 前半是纯函数（零 DOM），后半在假 wx 里把打包产物跑起来：点塔位建塔 → 开波 → 跑 90 秒 → 有击杀、波次推进。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CAPSULE, DESIGN, PRIORITY_LABEL, TOWER_ORDER,
  drawBattleHud, drawSheet, hitTestBattle, hitTestSheet, layoutBattle, layoutSheet,
} from '../src/minigame/battle.js';
import { installFakeWx } from '../tools/fake-wx.mjs';
import { TOWER_MAX_LEVEL } from '../src/data.js';
import { createMatch, makeEquipment, potionCount, update } from '../src/match.js';
import { SHOP_ITEMS } from '../src/data.js';
import { drawResult, layoutBag, layoutItem, layoutResult, layoutShop } from '../src/minigame/battle.js';

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
