// 结算面板与英雄卡片（§14.3 稿 3 / 稿 8）的视图模型。
import test from 'node:test';
import assert from 'node:assert/strict';

import { HEROES, TICK_STEP } from '../src/data.js';
import { createMatch, buildTower, update, upgradeTower, craftEquipment, makeEquipment } from '../src/match.js';
import { createDefenseMatch, buildFort, updateDefense } from '../src/defense.js';
import { damageShare, heroCard, heroCards, lootSummary, resultPanelModel, shopRows } from '../src/hud-model.js';
import { shopPriceOf } from '../src/match.js';

test('英雄卡片：4 个职业都有定位 / 属性 / 两个主动 / 两个天赋（§3.8 首发裁剪）', () => {
  const cards = heroCards();
  assert.equal(cards.length, 4);
  for (const c of cards) {
    assert.ok(c.name && c.role, `${c.id} 要有名字与定位`);
    assert.equal(c.stats.length, 6, '六项基础属性：生命/攻击/防御/攻速/射程/移速');
    assert.equal(c.skills.length, 2, '首发放两个主动技');
    assert.equal(c.talents.length, 2, '首发放两个天赋');
    assert.deepEqual(c.skills.map((s) => s.unlockLevel), [1, 8], '解锁等级沿用 §3.3 的 1 / 8');
    assert.deepEqual(c.talents.map((t) => t.unlockLevel), [5, 10]);
    assert.ok(c.secret?.via.includes('技能书'), '第三个技能要标出「靠技能书解锁」');
  }
  assert.equal(heroCard('nope'), null);
  assert.equal(heroCard('hero_warrior').secret.name, HEROES.hero_warrior.thirdSkill.name);
});

test('伤害占比：按来源分摊、降序、总和 100%（没有伤害时不炸）', () => {
  const td = createMatch({ mapId: 'map_01', seed: 3 });
  td.gold = 500;
  buildTower(td, 0, 'tw_arrow');
  buildTower(td, 1, 'tw_cannon');
  td.wave.timer = 0;
  for (let i = 0; i < Math.round(60 / TICK_STEP); i++) update(td, TICK_STEP);

  const share = damageShare(td.stats);
  assert.ok(share.total > 0, '打了一分钟应该有伤害');
  assert.ok(share.rows.length >= 2, '塔与英雄都该出现');
  assert.ok(share.rows[0].value >= share.rows[1].value, '要降序');
  const sum = share.rows.reduce((a, r) => a + r.pct, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `百分比应合到 1，实际 ${sum}`);
  assert.ok(share.rows.some((r) => r.label === '英雄'), '英雄那一条要有中文名');

  assert.deepEqual(damageShare({}).rows, []);
  assert.equal(damageShare({}).total, 0);
});

// §149：防守模式的伤害来源是**工事 id**（`fort_arrow`），而这张表里只有 TOWERS——只查 TOWERS 的话
// 结算面板会直接把内部 id 印给玩家（单机也一样：实测那一行写的是「fort_arrow 45%」）。
test('§149 防守的伤害占比写「箭塔」，不是内部 id（fort_arrow）', () => {
  const m = createDefenseMatch({ heroId: 'hero_warrior', seed: 7 });
  m.gold = 5000;
  buildFort(m, 0, 'fort_arrow');
  for (let i = 0; i < Math.round(200 / TICK_STEP); i++) updateDefense(m, TICK_STEP);
  assert.ok((m.stats.damage.fort_arrow ?? 0) > 0, '工事要真的打出伤害，否则这条检查是空的');

  const rows = damageShare(m.stats).rows;
  const fort = rows.find((r) => r.source === 'fort_arrow');
  assert.ok(fort, '工事那一条要在表里');
  assert.equal(fort.label, '箭塔', `面板要给中文名，实际「${fort.label}」`);
});

test('掉落与合成汇总：品质计数 + 已装备部位', () => {
  const m = createMatch({ mapId: 'map_01', seed: 4 });
  m.inventory.push(makeEquipment(m, 'weapon', 'blue', 5), makeEquipment(m, 'armor', 'blue', 6), makeEquipment(m, 'armor', 'white', 2));
  m.stats.drops = 3;
  m.equipped.weapon = m.inventory[0];
  const loot = lootSummary(m);
  assert.equal(loot.drops, 3);
  assert.equal(loot.byQuality.find((q) => q.quality === 'blue').count, 2);
  assert.equal(loot.byQuality.find((q) => q.quality === 'white').count, 1);
  assert.deepEqual(loot.equipped, [{
    slot: 'weapon', quality: 'blue', ilvl: 5, slotName: '武器', qualityName: '稀有',
  }]);
  // §151：面板上印的是名字——内部 id 不许漏到玩家眼前（那一行以前写「weapon blue15」）
  assert.equal(loot.byQuality.find((q) => q.quality === 'blue').name, '稀有');
  assert.ok(loot.equipped.every((e) => /^[\u4e00-\u9fa5]+$/.test(e.slotName) && /^[\u4e00-\u9fa5]+$/.test(e.qualityName)),
    `部位与品质都要是中文名，实际 ${loot.equipped.map((e) => e.slotName + '/' + e.qualityName).join(' ')}`);
});

test('结算面板：TD 与防守各自取对数，胜负文案不同', () => {
  const td = createMatch({ mapId: 'map_01', seed: 5 });
  td.result = 'win';
  td.time = 480;
  td.core.hp = 900;
  td.stats.leaks = 3;
  td.stats.kills = 230;
  td.stats.drops = 14;
  const a = resultPanelModel(td, { gain: 120, leveledUp: false, commanderLevel: 3 });
  assert.equal(a.mode, 'td');
  assert.equal(a.title, '通关！');
  assert.ok(a.rows.some((r) => r.label === '漏怪' && r.value === '3 只'));
  assert.ok(a.rows.some((r) => r.label === '核心剩余'));
  assert.equal(a.reputationGain, 120);
  assert.equal(a.commanderLevel, 3);

  const def = createDefenseMatch({ seed: 6 });
  def.result = 'win';
  def.time = 760;
  def.stats.roundsCleared = 4;
  def.assault.endless = true;
  def.castle.hp = 1500;
  def.stats.fieldKills = 31;
  def.stats.castleHits = 515;
  const b = resultPanelModel(def, { gain: 120, leveledUp: true, commanderLevel: 4 });
  assert.equal(b.mode, 'defense');
  assert.equal(b.title, '守住了！');
  assert.ok(b.rows.some((r) => r.label === '守住轮次' && r.value.includes('4 / 4')));
  assert.ok(b.rows.some((r) => r.label === '城堡剩余' && r.value.startsWith('1500')));
  assert.equal(b.leveledUp, true);

  assert.equal(resultPanelModel({ result: null }), null, '没结束就不出结算面板');
});

test('商店行：价格递增 / 限购 / 买不起 / 售罄 都能表达', () => {
  const m = { gold: 100, lumber: [0], shopBought: { pot_group: 2 } };
  const rows = shopRows(m, (id) => shopPriceOf(m, id));
  const small = rows.find((r) => r.id === 'pot_small');
  assert.equal(small.price.gold, 30, '§3.1 #17：小药基准价降到 30');
  assert.equal(small.affordable, true);
  const secret = rows.find((r) => r.id === 'book_secret');
  assert.equal(secret.affordable, false, '100 金买不起 300 金 + 木材的秘传（§3.1 #25 降价后仍然买不起）');
  const group = rows.find((r) => r.id === 'pot_group');
  assert.equal(group.soldOut, true, '限购 2 个后应表现为售罄');
});
