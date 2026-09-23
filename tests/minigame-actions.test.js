// 小游戏的**动作接线**：界面里每一个能点的东西，背后都得有人接。
//
// 这一类错很难在单个面板的用例里发现：新加一颗键、写了个新 `action.type`，而 `applyAction` 里
// 没有对应分支——它就静静地落进 `default` 分支，按钮点下去什么都不发生（§3.1 #2 那条「不给假选项」
// 说的正是这件事）。这里用一条**静态**检查把「界面给出的动作」与「代码里接的动作」对齐，
// 再加一条「每个弹层都有出口」（别把玩家困在面板里）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { layoutBag, layoutBattle, layoutItem, layoutPause, layoutShop, layoutSheet } from '../src/minigame/battle.js';
import { layoutDefense, layoutFortSheet } from '../src/minigame/defense-screen.js';
import { applyLobbyAction, layoutLobby } from '../src/minigame/lobby.js';
import { defModel, describeBattleModel } from '../src/minigame/game.js';
import { buildTower, createMatch, makeEquipment } from '../src/match.js';
import { createDefenseMatch } from '../src/defense.js';
import { emptyProfile } from '../src/profile.js';

/** 界面里所有 `action={ type: ... }` 的出处（每个面板的各行 / 大厅的每张卡） */
const collectActions = () => {
  const td = createMatch({ seed: 5 });
  td.gold = 5000;
  const dm = createDefenseMatch({ seed: 5 });
  dm.gold = 5000;
  const out = [];
  const push = (where, sheet) => {
    for (const r of sheet?.rows ?? []) if (r.action) out.push({ where, type: r.action.type });
    for (const it of sheet?.items ?? []) if (it.action) out.push({ where, type: it.action.type });
    // 大厅的英雄详情是**覆盖层**（行在 `detail.rows` 里，不在 `items` 里）
    for (const r of sheet?.detail?.rows ?? []) if (r.action) out.push({ where, type: r.action.type });
  };
  buildTower(td, 0, 'tw_arrow');
  const items = [makeEquipment(td, 'weapon', 'blue', 6), makeEquipment(td, 'armor', 'blue', 6)];
  // 背包里凑够 3 件同部位同品质的武器 → 「一键合成」那一行才会出现（`craft` 动作）
  td.inventory.push(...items, makeEquipment(td, 'weapon', 'blue', 6), makeEquipment(td, 'weapon', 'blue', 6));

  const battleModel = {
    wave: 1, phase: 'prep', timer: 9, gold: 200, core: 2400, coreMax: 2400, result: null, length: 'short',
    canEarly: true, skills: [{ name: '旋风斩', lv: 1 }, { name: '战吼', locked: true }],
    potionCount: 1, potionReady: true, bagCount: 1, hero: { level: 1, dead: false, reviveIn: 0 }, lumber: 0,
    tutorial: '点亮的塔位可以建塔 —— 点一个，选「箭塔」', rate: 1, paused: false,
  };
  push('TD HUD', layoutBattle(battleModel));
  // 结算那一帧：底排那颗「开波」换成「再开一局」（`restart` 只在这一帧出现）
  push('TD HUD（结算）', layoutBattle({ ...battleModel, result: 'win', tutorial: null }));
  push('防守 HUD', layoutDefense(dm, { rate: 1, paused: false, potionCount: 1, potionReady: true }));
  push('防守 HUD（无尽出口）', layoutDefense(dm, { rate: 1, endlessExit: true }));
  push('防守 HUD（阵亡）', (() => { dm.hero.dead = true; const L = layoutDefense(dm, { rate: 1 }); dm.hero.dead = false; return L; })());
  push('大厅', layoutLobby(667, 375, {
    mode: 'td', map: 'map_01', difficulty: 'normal', length: 'short', hero: 'hero_warrior',
    profile: emptyProfile(), unlocked: ['map_01'], locked: {}, lockedReason: {}, unlockedCount: 1,
    canStart: true, canContinue: true, hint: null,
  }));
  push('大厅（英雄详情）', layoutLobby(667, 375, {
    mode: 'td', map: 'map_01', difficulty: 'normal', length: 'short', hero: 'hero_warrior',
    profile: emptyProfile(), unlocked: ['map_01'], locked: {}, lockedReason: {}, unlockedCount: 1,
    canStart: true, canContinue: false, hint: null, detail: 'hero_warrior',
  }));
  // 注意：0 号位上面已经建了塔，所以「建造面板」要用另一个空位（1 号），否则拿到的其实是塔面板
  for (const [where, ui] of [['建造', { selectedSlot: 1 }], ['塔面板', { panelSlot: 0 }], ['商店', { sheetKind: 'shop' }],
    ['背包', { sheetKind: 'bag' }], ['物品详情', { sheetKind: 'item', itemUid: items[0].uid }],
    ['暂停', { sheetKind: 'pause', settings: {} }], ['暂停（重置确认）', { sheetKind: 'pause', settings: {}, resetArmed: true }]]) {
    push(where, layoutSheet(td, ui));
  }
  push('工事', layoutFortSheet(dm, { freeSlots: 2 }));
  // 防守那套暂停面板：`stick` / `autoPickup` 这两格只在防守模式出现
  push('暂停（防守）', layoutPause(dm, { sheetKind: 'pause', rate: 1, settings: { stick: 'floating', autoPickup: true, sfx: true, effects: 'high' } }));

  // 攻城图（map_05/06）上「修塔」那一行才会出现：单独造一局、把塔打伤
  const siege = createMatch({ mapId: 'map_05', seed: 5 });
  siege.gold = 5000;
  buildTower(siege, 0, 'tw_arrow');
  siege.towers[0].hp = Math.max(1, (siege.towers[0].maxHp ?? 100) - 10);
  push('塔面板（攻城图 · 可修）', layoutSheet(siege, { panelSlot: 0 }));
  return out;
};

test('小游戏接线：界面里每一个动作，`applyAction` 里都有对应分支（没有点了没反应的键）', () => {
  // 大厅那一屏的选择动作归 `lobby.js` 的 `applyLobbyAction`；战场/防守/弹层归 `game.js` 的 `applyAction`
  const srcOf = {
    'src/minigame/game.js': readFileSync(new URL('../src/minigame/game.js', import.meta.url), 'utf8'),
    'src/minigame/lobby.js': readFileSync(new URL('../src/minigame/lobby.js', import.meta.url), 'utf8'),
  };
  const seen = collectActions();
  assert.ok(seen.length > 40, `动作收集得太少（${seen.length} 个），多半是布局没取全`);
  const missing = [];
  for (const { where, type } of seen) {
    const src = where.startsWith('大厅') ? srcOf['src/minigame/lobby.js'] : srcOf['src/minigame/game.js'];
    if (!src.includes(`case '${type}':`)) missing.push(`${where} → ${type}`);
  }
  assert.deepEqual(missing, [], `这些动作在 applyAction 里没有分支（点了会没反应）：\n${missing.join('\n')}`);
  // 反向也扫一遍：applyAction 里没有「只在注释里出现」的分支名
  const types = new Set(seen.map((x) => x.type));
  for (const t of ['early', 'skill', 'potion', 'shop', 'bag', 'pause', 'speed', 'lobby', 'restart', 'teleport', 'repairCastle', 'build', 'upgrade', 'sell', 'priority', 'repair', 'buy', 'item', 'equip', 'enhance', 'craft', 'resume', 'camera', 'stick', 'sfx', 'effects', 'wavePreview', 'autoPickup', 'replayTutorial', 'resetProgress', 'tutorialSkip', 'fort', 'buildFort', 'endless', 'revive',
    'mode', 'difficulty', 'length', 'hero', 'map', 'start', 'continue', 'closeDetail']) {
    assert.ok(types.has(t), `内核/界面里有的动作「${t}」在布局里没出现（是不是删了入口却留着分支？）`);
  }
});

test('小游戏接线：每个弹层都有出口（别把玩家困在面板里）', () => {
  const td = createMatch({ seed: 5 });
  td.gold = 5000;
  buildTower(td, 0, 'tw_arrow');
  const dm = createDefenseMatch({ seed: 5 });
  const exits = new Set(['close', 'cancel', 'resume', 'lobby', 'restart', 'closeDetail']);
  const sheets = [
    ['建造', layoutSheet(td, { selectedSlot: 0 })],
    ['塔面板', layoutSheet(td, { panelSlot: 0 })],
    ['商店', layoutShop(td, {})],
    ['背包', layoutBag(td, {})],
    ['暂停（TD）', layoutPause(td, { settings: {} })],
    ['暂停（防守）', layoutPause(dm, { settings: {} })],
    ['工事', layoutFortSheet(dm, { freeSlots: 2 })],
    ['大厅英雄详情', layoutLobby(667, 375, {
      mode: 'td', map: 'map_01', difficulty: 'normal', length: 'short', hero: 'hero_warrior',
      profile: emptyProfile(), unlocked: ['map_01'], locked: {}, lockedReason: {}, unlockedCount: 1,
      canStart: true, canContinue: false, hint: null, detail: 'hero_warrior',
    })],
  ];
  for (const [label, sheet] of sheets) {
    assert.ok(sheet, `${label}：没布局出来`);
    if (label === '大厅英雄详情') {
      assert.ok(sheet.detail?.rows?.some((r) => exits.has(r.action?.type)), `${label}：没有出口`);
      continue;
    }
    assert.ok(sheet.rows.some((r) => exits.has(r.action?.type)), `${label}：没有出口（关不掉）`);
  }
});

/**
 * 模型 ↔ 布局的对齐：布局从模型里读的每个字段，模型都得**真的给**。
 *
 * 这一族错已经踩过两次（`skills`、`potionReady`）：内核加了字段、布局开始读它，而某个调用点
 * （样板工具、某条用例）手拼的模型没跟上——字段是 undefined，那一格就按「不可用 / 空」画，
 * 而且**不会报错**。这里把「布局读了什么」与「模型提供了什么」摆在一起对账：
 * 读到的字段要么由模型构造器给，要么在这个白名单里（那几个是 game.js 组装时补的）。
 */
test('小游戏模型对齐：布局读的每个字段，模型都提供了（新字段要么进模型、要么进白名单）', () => {
  const srcOf = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const section = (text, from, to) => {
    const i = text.indexOf(from);
    const j = to ? text.indexOf(to, i + 1) : text.length;
    return text.slice(i, j > i ? j : text.length);
  };
  const modelReads = (text) => [...new Set([...text.matchAll(/model\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))].sort();

  // TD 的 HUD：布局读的字段来自 describeBattleModel，加上 game.js 组装时补的那几个
  const td = createMatch({ seed: 5 });
  const tdModel = Object.keys(describeBattleModel(td));
  const tdExtra = ['paused', 'rate', 'tutorial', 'ui', 'sheet'];
  const tdReads = modelReads(section(srcOf('../src/minigame/battle.js'), 'export function layoutBattle', '/** 触点 → HUD 动作'));
  for (const key of tdReads) {
    assert.ok(tdModel.includes(key) || tdExtra.includes(key),
      `layoutBattle 读了 model.${key}，但 describeBattleModel 没给、也不在白名单里——那一格会静默画成空`);
  }

  // 防守的 HUD：字段来自 defModel（它自己就是 game.js 里那个构造器）
  const dm = createDefenseMatch({ seed: 5 });
  const defModelKeys = Object.keys(defModel({ m: dm, paused: false, rate: 1, stick: { active: false, origin: null }, ui: {} }));
  const defExtra = ['ui'];
  const defReads = modelReads(section(srcOf('../src/minigame/defense-screen.js'), 'export function layoutDefense', '/** HUD 的命中测试'));
  for (const key of defReads) {
    assert.ok(defModelKeys.includes(key) || defExtra.includes(key),
      `layoutDefense 读了 model.${key}，但 defModel 没给、也不在白名单里`);
  }
});
