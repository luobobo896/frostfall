// 存档验收（附录 B：「单人局杀进程后重开，波次进度、金币、塔位一个不丢」）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMatch, describe, update, buildTower, upgradeTower, castSkill } from '../src/match.js';
import { TICK_STEP } from '../src/data.js';
import { deserializeMatch, hasSave, loadFromStorage, saveToStorage, serializeMatch } from '../src/save.js';
import { buildFort, createDefenseMatch, describeDefense, orderMove, teleportHome, updateDefense } from '../src/defense.js';

/** 同一套脚本动作打到两个局上，保证对比是「同输入 → 同结果」。 */
function step(m, seconds, onSecond) {
  const steps = Math.round(seconds / TICK_STEP);
  for (let i = 0; i < steps; i++) {
    update(m, TICK_STEP);
    if (onSecond && i % 20 === 0) onSecond(Math.floor(i / 20));
  }
}

const script = (m) => (sec) => {
  if (sec === 1) buildTower(m, 0, 'tw_arrow');
  if (sec === 5) buildTower(m, 1, 'tw_arrow');
  if (sec === 20) upgradeTower(m, 0);
  if (sec === 35) buildTower(m, 2, 'tw_cannon');
  if (sec === 50) castSkill(m, 0);
  if (sec === 60) upgradeTower(m, 1);
};

test('存档往返：关键状态一致（金币 / 塔 / 波次 / 英雄 / 掉落 / 随机流）', () => {
  const a = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_mage', seed: 99 });
  step(a, 70, script(a));

  const save = serializeMatch(a);
  const b = deserializeMatch(JSON.parse(JSON.stringify(save)));
  assert.ok(b, '应能反序列化');

  assert.equal(b.time, a.time);
  assert.equal(b.gold, a.gold);
  assert.deepEqual(b.lumber, a.lumber);
  assert.equal(b.core.hp, a.core.hp);
  assert.equal(b.wave.index, a.wave.index);
  assert.equal(b.wave.phase, a.wave.phase);
  assert.equal(b.towers.length, a.towers.length);
  assert.deepEqual(b.towers.map((t) => [t.towerId, t.slot, t.level]), a.towers.map((t) => [t.towerId, t.slot, t.level]));
  assert.equal(b.monsters.length, a.monsters.length);
  assert.equal(b.hero.level, a.hero.level);
  assert.equal(b.hero.exp, a.hero.exp);
  assert.equal(b.rng.getState(), a.rng.getState(), '随机流要续上，否则读档后掉落会重来');
});

test('读档后继续推进：与未中断的那一局逐步一致（同输入同结果）', () => {
  const a = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_ranger', seed: 7 });
  step(a, 60, script(a));
  const b = deserializeMatch(serializeMatch(a));

  // 两边继续跑同样的脚本 40 秒
  const cont = (m) => (sec) => {
    if (sec === 5) buildTower(m, 3, 'tw_frost');
    if (sec === 15) castSkill(m, 0);
    if (sec === 25) upgradeTower(m, 2);
  };
  step(a, 40, cont(a));
  step(b, 40, cont(b));

  assert.deepEqual(describe(b), describe(a), '金币 / 核心 / 波次 / 等级 / 掉落都不该有漂移');
  assert.equal(b.monsters.length, a.monsters.length, '场上怪物数一致');
  assert.deepEqual(
    b.monsters.map((x) => [x.mobId, Math.round(x.dist), Math.round(x.hp)]).sort(),
    a.monsters.map((x) => [x.mobId, Math.round(x.dist), Math.round(x.hp)]).sort(),
    '怪物位置与血量逐个一致',
  );
});

test('存档能扛过「关掉再打开」：JSON 往返 + 半空弹道丢弃后不影响后续', () => {
  const a = createMatch({ mapId: 'map_02', difficulty: 'hard', heroId: 'hero_warrior', seed: 1234 });
  step(a, 45, script(a));
  assert.ok(a.projectiles.length >= 0);
  const text = JSON.stringify(serializeMatch(a));   // 模拟写进 localStorage
  const b = deserializeMatch(JSON.parse(text));
  assert.equal(b.projectiles.length, 0, '半空弹道不落盘，重开后由塔自己重发');
  step(b, 10, null);
  assert.ok(b.time > a.time, '读档后能继续推进');
  assert.ok(Number.isFinite(b.core.hp) && Number.isFinite(b.gold));
});

test('§10.3 存档要把**后加的字段**也带上（人物等级复活加速 / 卷轴 / 波次中读条 / 双核心血量）', () => {
  // 这条的来历：每加一个局内字段（§55 卷轴、§56 读条、§63 复活倍率、§2.2 双核心）都得记着同步存档，
  // 漏一个的表现是「读档后那件事悄悄没了」——比如复活又变回 15 秒、卷轴清零、map_06 的第二个核心被治满。
  const td = createMatch({ mapId: 'map_06', difficulty: 'normal', seed: 3, players: 4, reviveMul: 0.913 });
  td.scrolls = 2;
  td.shopCast = { itemId: 'pot_small', until: td.time + 2 };
  td.cores[1].hp -= 500;
  const back = deserializeMatch(JSON.parse(JSON.stringify(serializeMatch(td))));
  assert.equal(back.reviveMul, 0.913, '复活倍率（§3.6）要跟着存档');
  assert.equal(back.scrolls, 2, '回城卷轴（§5.5.1）要跟着存档');
  assert.deepEqual(back.shopCast, td.shopCast, '波次中那 3 秒读条（§5.5）要跟着存档');
  assert.equal(back.cores[1].hp, td.cores[1].hp, 'map_06 的第二个守护目标血量要跟着存档');
  assert.equal(back.cores.length, 2);
  // 逐个字段对一遍：以后再加字段，这条会立刻告诉你漏了哪个
  const bad = Object.keys(td).filter((k) => typeof td[k] !== 'function' && JSON.stringify(td[k]) !== JSON.stringify(back[k]));
  assert.deepEqual(bad, [], `这些字段读档后不一致：${bad.join(', ')}`);

  const dm = createDefenseMatch({ mapId: 'def_01', seed: 3, reviveMul: 0.913 });
  dm.scrolls = 1;
  dm.over = true;               // 城堡陷落 = 这一局结束，读档后不许又「活过来」
  const dback = deserializeMatch(JSON.parse(JSON.stringify(serializeMatch(dm))));
  assert.equal(dback.reviveMul, 0.913);
  assert.equal(dback.scrolls, 1);
  assert.equal(dback.over, true, '防守局结束标记也要跟着存档（否则读档后画面又在动）');
  const dbad = Object.keys(dm).filter((k) => typeof dm[k] !== 'function' && JSON.stringify(dm[k]) !== JSON.stringify(dback[k]));
  assert.deepEqual(dbad, [], `防守这些字段读档后不一致：${dbad.join(', ')}`);
});

test('存档版本不匹配时拒绝载入（避免旧档把新字段带崩）', () => {
  const a = createMatch({});
  const save = serializeMatch(a);
  save.v = 999;
  assert.equal(deserializeMatch(save), null);
});

/* ---------- 防守模式存档（§12.5） ---------- */

const stepDefense = (m, seconds, onSecond) => {
  for (let i = 0; i < Math.round(seconds / TICK_STEP); i++) {
    updateDefense(m, TICK_STEP);
    if (onSecond && i % 20 === 0) onSecond(Math.floor(i / 20));
  }
};

const defenseScript = (m) => (sec) => {
  if (sec === 2) { m.gold += 400; buildFort(m, 0, 'fort_arrow'); }
  if (sec === 5) orderMove(m, { x: 8, y: 12 });          // 去第一个营地
  if (sec === 60) buildFort(m, 1, 'fort_wall');
  if (sec === 120) orderMove(m, { x: m.castle.cell.x - 3, y: m.castle.cell.y });
};

test('防守存档往返：城堡 / 工事 / 怪 / 英雄 / 营地计时 / 随机流都对得上', () => {
  const a = createDefenseMatch({ heroId: 'hero_ranger', seed: 31 });
  stepDefense(a, 150, defenseScript(a));
  const save = JSON.parse(JSON.stringify(serializeMatch(a)));   // 模拟写进 localStorage
  assert.equal(save.mode, 'defense');

  const b = deserializeMatch(save);
  assert.deepEqual(describeDefense(b), describeDefense(a));
  assert.equal(b.forts.length, a.forts.length);
  assert.deepEqual(b.forts.map((f) => [f.slot, f.fortId, Math.round(f.hp)]), a.forts.map((f) => [f.slot, f.fortId, Math.round(f.hp)]));
  assert.equal(b.monsters.length, a.monsters.length);
  assert.deepEqual(b.hero.cell, a.hero.cell);
  assert.equal(b.hero.path.length, a.hero.path.length, '行进路径也要存（读档后英雄不该停住）');
  assert.equal(b.rng.getState(), a.rng.getState());
  assert.equal(typeof b.onMonsterKilled, 'function', '击杀回调要重建，否则读档后打怪不掉装备');
});

// §147：**回城那 30 秒冷却也是状态**，两件事一起钉——
// ① 它要进存档（不进就是「存档 → 刷新 → 白送一次回城」的刷子，可以反复刷）；
// ② 它要**真的走 30 秒**（`stepHero()` 与 `updateDefense()` 各扣了一次，实测 15 秒就冷却完毕）。
// 回城是防守模式里唯一能把英雄从野外捞回基地的手段，§2.6 的整套节奏（出城打野 → 预警 30 秒 →
// 回防）都压在它上面；冷却中想回城只认回城卷轴。同一类坑还有 §69 的「读一次少一次」。
test('§147 回城冷却既进存档、也真的走满 30 秒（以前是 15 秒 + 刷新白送）', () => {
  const a = createDefenseMatch({ heroId: 'hero_warrior', seed: 41 });
  stepDefense(a, 10, (sec) => { if (sec === 1) teleportHome(a); if (sec === 2) orderMove(a, { x: 20, y: 20 }); });
  // t=1 回城（冷却 30s），到 t=10 应该刚好过掉 9 秒 → 剩 21 秒左右；两倍速的话这里只剩 12 秒
  assert.ok(Math.abs(a.hero.teleportCd - 21) < 1,
    `§2.6 写的是 30 秒冷却：t=1 回城、t=10 时该剩 ~21s，实际 ${a.hero.teleportCd.toFixed(1)}s`);
  const save = JSON.parse(JSON.stringify(serializeMatch(a)));
  assert.ok('teleportCd' in save.hero, '这个字段要出现在存档里（不然下次加状态又会漏）');

  const b = deserializeMatch(save);
  assert.ok(Math.abs(b.hero.teleportCd - a.hero.teleportCd) < 0.001,
    `冷却要原样回来：存档 ${a.hero.teleportCd.toFixed(1)}s → 读档 ${b.hero.teleportCd.toFixed(1)}s`);
  assert.equal(teleportHome(b), false, '冷却中读档后再点回城必须被拒（以前这里是 true：白送一次）');

  // 读档之后接着走：再过 15 秒（全程才 25 秒）**还不该**冷却完毕
  stepDefense(b, 15);
  assert.equal(teleportHome(b), false,
    `回城才过了 25 秒，不该又能回城（两倍速的时候这里就漏了：实际剩 ${b.hero.teleportCd.toFixed(1)}s）`);
  // 走满 30 秒之后照常可用（别把这半修死）
  stepDefense(b, 10);
  assert.equal(teleportHome(b), true, '冷却走满 30 秒之后回城照常可用');
});

test('防守读档后继续跑：与未中断那一局同输入同结果', () => {
  const a = createDefenseMatch({ heroId: 'hero_warrior', seed: 12 });
  stepDefense(a, 100, defenseScript(a));
  const b = deserializeMatch(serializeMatch(a));

  const cont = (m) => (sec) => {
    if (sec === 5) m.gold += 300;
    if (sec === 10) buildFort(m, 2, 'fort_arrow');
    if (sec === 20) orderMove(m, { x: m.camps[1].x, y: m.camps[1].y });
  };
  stepDefense(a, 60, cont(a));
  stepDefense(b, 60, cont(b));

  assert.deepEqual(describeDefense(b), describeDefense(a), '城堡 / 金币 / 轮次 / 掉落都不该漂移');
  assert.deepEqual(
    b.monsters.map((x) => [x.mobId, x.cell.x, x.cell.y, Math.round(x.hp)]).sort(),
    a.monsters.map((x) => [x.mobId, x.cell.x, x.cell.y, Math.round(x.hp)]).sort(),
    '怪物位置与血量逐个一致',
  );
});

test('自建围墙会进阻挡集合，读档后依然挡路', () => {
  const a = createDefenseMatch({ seed: 5 });
  a.gold = 500;
  buildFort(a, 4, 'fort_wall');
  const wall = a.def.fortSlots[4];
  assert.ok(a.walls.has(`${wall.x},${wall.y}`));
  const b = deserializeMatch(serializeMatch(a));
  assert.ok(b.walls.has(`${wall.x},${wall.y}`), '读档后围墙要重新挡路，否则怪会穿墙');
});

// §113：联机镜像不许进本地存档。服务端才是权威，存下来只会在大厅多一个「继续上局」，
// 点进去是没有服务端的鬼局。这条要能失败：去掉 saveToStorage 里的 `m.online` 守卫即红。
test('§113 联机镜像不写本地存档（而转单人继续之后又该写）', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    const m = createMatch({ mapId: 'map_01', heroId: 'hero_mage', seed: 7 });
    assert.equal(saveToStorage(m), true, '普通单机局该存');

    m.online = true;                       // 联机镜像（main.js 在连上房间之后打这个标记）
    assert.equal(saveToStorage(m), false, '联机镜像不该存');
    assert.equal(loadFromStorage().time, 0, '读回来还得是上一份单机存档，不是镜像');

    m.online = false;                      // §10.3：转单人继续之后它真的变回单机局
    assert.equal(saveToStorage(m), true, '转单人继续后要能存（否则杀进程就丢进度）');
  } finally {
    delete globalThis.localStorage;
  }
});

// §139：「继续上局」只在**存档真的能读**时出现。
// 以前 `hasSave()` 只看「键在不在」——于是 `SAVE_VERSION` 一升级（或存档坏了），大厅照样弹这个按钮，
// 点下去 `loadFromStorage()` 返回 null、只能开一局新的：玩家以为那局还在，其实没了。
test('§139 「有存档」的口径 = 能读（键在但版本对不上 / JSON 坏了都不算）', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    assert.equal(hasSave(), false, '空存档不算有');

    const m = createMatch({ mapId: 'map_01', heroId: 'hero_mage', seed: 21 });
    assert.equal(saveToStorage(m), true);
    assert.equal(hasSave(), true, '正常存档算有');
    assert.ok(loadFromStorage(), '而且真的读得出来（两个口径一致）');

    // 版本对不上：模拟「以后 SAVE_VERSION 升到 2、玩家手里是 v1 的存档」
    const stale = JSON.parse(store.get('frostfall:save'));
    stale.v = 999;
    store.set('frostfall:save', JSON.stringify(stale));
    assert.equal(loadFromStorage(), null, '前置：确实读不出来');
    assert.equal(hasSave(), false, '读不出来就不该弹「继续上局」');

    // §204：**版本号对、内容读不出来**（改版后地图 id 变了 / 字段缺了）——同一形状的另一半。
    // §139 当时只查了版本号，于是这种存档照样弹「继续上局」，点下去只能开一局新的。
    saveToStorage(createMatch({ mapId: 'map_01', heroId: 'hero_mage', seed: 21 }));
    const badMap = JSON.parse(store.get('frostfall:save'));
    badMap.mapId = 'map_99';                       // 存档说自己在某张已经不存在的图上
    store.set('frostfall:save', JSON.stringify(badMap));
    assert.equal(loadFromStorage(), null, '前置：内容读不出来');
    assert.equal(hasSave(), false, '版本对但内容读不出来同样不算「有存档」');

    // JSON 坏了同理
    store.set('frostfall:save', '{坏掉的');
    assert.equal(hasSave(), false);
  } finally {
    delete globalThis.localStorage;
  }
});
