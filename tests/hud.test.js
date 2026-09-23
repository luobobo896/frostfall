// HUD 纯逻辑：队伍色、下一波预告、伤害飘字、玩家面板。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DAMAGE_MATRIX, TEAM_COLORS, WAVES } from '../src/data.js';
import { armorHint, attackHint, counterTable, damageFloaters, playerPanel, recordLabel, resultPanelModel, teamColor, wavePreview, zoneLabel } from '../src/hud-model.js';
import { createDefenseMatch } from '../src/defense.js';

// §190：结局面板别给「假出口」。城堡陷落之后那一局就结束了（内核 `updateDefense` 在 `m.over` 时直接
// return），可面板还在说「（无尽中）」并摆着「继续（无尽）」——点下去只是让开面板，露出一个
// 城堡 0 血、怪站着不动的死场。这条钉住「还能继续才给出口」，同时确认 §131 的胜局不被覆盖。
test('§190 城堡陷落之后，「继续（无尽）」与「（无尽中）」都要收起来（别给假出口）', () => {
  const m = createDefenseMatch({ mapId: 'def_01', seed: 7 });
  m.result = 'win';
  m.assault = { ...m.assault, endless: true };
  m.stats.roundsCleared = 4;
  const alive = resultPanelModel(m, {});
  assert.equal(alive.endless, true, '还在无尽里：要给「继续（无尽）」');
  assert.match(alive.rows.find((r) => r.label === '守住轮次').value, /（无尽中）$/);
  // 城堡陷落：`m.over` 置起、血归零——**胜局不变**（§131），但出口要收
  const dead = { ...m, over: true, castle: { ...m.castle, hp: 0 } };
  const over = resultPanelModel(dead, {});
  assert.equal(over.title, '守住了！', '已拿到的胜局不被城堡陷落覆盖');
  assert.equal(over.endless, false, '城堡都陷落了，没有「继续」这回事');
  assert.doesNotMatch(over.rows.find((r) => r.label === '守住轮次').value, /无尽中/);
});

// §12.3 / §12.6：两种模式的成绩**不可比**——TD 写「最快 mm:ss」，防守写「守住 N 轮 · 城堡 M」。
// 以前两种图都用 TD 的口径，防守图于是显示一个没有意义的「最快 12:40」（通关时刻由轮次表决定）。
test('§12.6 战绩文案分模式：TD 最快通关 / 防守守住轮次', () => {
  assert.equal(recordLabel('map_01', null), '还没通关');
  assert.equal(recordLabel('map_01', { clears: 1, wins: 1, bestTimeSec: 488 }), '最快 8:08');
  assert.equal(recordLabel('map_01', { clears: 2, wins: 0, bestTimeSec: null }), '还没通关', '没赢过就没有最快通关');
  assert.equal(recordLabel('def_01', { clears: 1, wins: 1, bestTimeSec: 760, bestRounds: 4, bestCoreHp: 2510 }),
    '守住 4 轮 · 城堡 2510');
  assert.equal(recordLabel('def_01', { clears: 1, wins: 0, bestRounds: 0, bestCoreHp: 0 }),
    '守住 0 轮 · 城堡 0', '输了的防守局也是这个口径（0 轮）');
});

// §2.6「越远收益越高」+ §12.8 的 dropBonus：加成要**写出来**，玩家才可能学到这件事
test('§2.6 野外区文案：区名 + 等级段 + 掉落加成（免费区不写 ×1）', () => {
  assert.equal(zoneLabel(null), '', '不在任何区里就没有文案');
  assert.equal(zoneLabel({ name: '近郊林地', lvMin: 1, lvMax: 5, dropBonus: 1 }),
    '近郊林地 Lv1-5', '×1.0 不写出来，免得满屏 ×1');
  assert.equal(zoneLabel({ name: '腐化荒地', lvMin: 5, lvMax: 10, dropBonus: 1.25 }),
    '腐化荒地 Lv5-10 · 掉落 ×1.25');
  assert.equal(zoneLabel({ name: '王座前庭', lvMin: 10, lvMax: 15, dropBonus: 1.75 }),
    '王座前庭 Lv10-15 · 掉落 ×1.75');
  // 缺字段也要能画（老配置 / 手搭对象不该把 HUD 弄崩）
  assert.equal(zoneLabel({ name: '某地', lvMin: 1, lvMax: 3 }), '某地 Lv1-3');
});

// §3.8 / §6.2：「UI 要给克制提示」——这条要求此前一条都没有（验证记录 §90）。
// 提示必须**从克制表算出来**，所以这里用表本身当期望值，而不是手抄一串数字。
test('§6.2 克制提示：从克制表算出「最克谁 / 怕什么」，改表就跟着变', () => {
  const t = counterTable();
  assert.equal(t.length, 5, '五种攻击类型各一行');
  for (const row of t) {
    const mul = DAMAGE_MATRIX[row.atk][row.best.ar];
    assert.equal(row.best.mul, Math.max(...Object.values(DAMAGE_MATRIX[row.atk])), `${row.atk} 的最优护甲要真的是最大值`);
    assert.ok(row.best.mul >= mul);
  }
  // 三条能背下来的：攻城克加强甲、魔法克重甲、穿刺克轻甲（§6.2 那张表）
  assert.equal(attackHint('siege'), '攻城 · 克无甲/加强甲 ×1.50', '并列的两个都要列出来');
  assert.equal(attackHint('magic'), '魔法 · 克重甲 ×2.00');
  assert.equal(attackHint('pierce'), '穿刺 · 克轻甲 ×2.00');
  assert.equal(attackHint('chaos'), '混乱 · 无明显克制（×1.00）', '全 1.00 是「没有克制」，不是「克无甲」');
  // 反过来（给下一波预告用）：加强甲怕攻城、魔法只有 0.35
  assert.equal(armorHint('fortified'), '加强甲 怕 攻城 ×1.50（魔法 只有 ×0.35）');
  // 表改了提示就该改：临时把魔法对加强甲改成 3.0，提示要跟到 3.00
  const saved = DAMAGE_MATRIX.magic.fortified;
  DAMAGE_MATRIX.magic.fortified = 3;
  try {
    assert.equal(attackHint('magic'), '魔法 · 克加强甲 ×3.00');
    assert.match(armorHint('fortified'), /魔法 ×3\.00/);
  } finally { DAMAGE_MATRIX.magic.fortified = saved; }
});

test('队伍色：4 人 4 色，超出循环，和 §14.4 的换色方案一致', () => {
  assert.equal(teamColor(0), TEAM_COLORS[0]);
  assert.equal(teamColor(3), TEAM_COLORS[3]);
  assert.equal(teamColor(4), TEAM_COLORS[0]);
  assert.equal(new Set(TEAM_COLORS).size, 4, '四个玩家要有可区分的颜色');
});

test('下一波预告：把波次表翻成人话，Boss 波要标出来', () => {
  const w1 = wavePreview(1);
  assert.equal(w1.wave, 1);
  assert.equal(w1.total, 8);
  assert.match(w1.text, /8×冰霜食尸鬼/);
  assert.equal(w1.tag, '');

  const w3 = wavePreview(3);
  assert.equal(w3.tag, '精英波');
  assert.ok(w3.groups.some((g) => g.tier === 'elite'));

  const w6 = wavePreview(6);
  assert.equal(w6.tag, '小 Boss');
  assert.ok(w6.groups.some((g) => g.tier === 'boss'));

  const w12 = wavePreview(12);
  assert.equal(w12.tag, '最终 Boss');
  assert.equal(w12.total, WAVES[11].groups.reduce((s, g) => s + g.count, 0));

  const air = wavePreview(2);
  assert.match(air.text, /空中/, '空中单位要提示（只有对空塔打得到）');
  assert.ok(air.groups.some((g) => g.armorType), '要带上护甲类型，供 UI 提示克制');
});

test('伤害飘字：按两帧血量差生成，大伤害单独标记，数量有上限', () => {
  const before = [
    { uid: 1, hp: 100, cell: { x: 1, y: 1 } },
    { uid: 2, hp: 500, cell: { x: 2, y: 2 } },
    { uid: 3, hp: 80, cell: { x: 3, y: 3 } },
  ];
  const after = [
    { uid: 1, hp: 60, cell: { x: 1, y: 1 } },
    { uid: 2, hp: 260, cell: { x: 2, y: 2 } },
    { uid: 3, hp: 80, cell: { x: 3, y: 3 } },
  ];
  const floats = damageFloaters(before, after);
  assert.equal(floats.length, 2, '没掉血的怪不该飘字');
  assert.equal(floats[0].text, '240');
  assert.equal(floats[0].kind, 'big');
  assert.equal(floats[1].text, '40');
  assert.equal(floats[1].kind, 'hit');

  // 新出现的怪（没在上一帧里）不该飘字，避免「刚出生就掉血」的假数字
  assert.equal(damageFloaters([], after).length, 0);
  const many = damageFloaters(
    Array.from({ length: 30 }, (_, i) => ({ uid: i, hp: 100, cell: { x: 0, y: 0 } })),
    Array.from({ length: 30 }, (_, i) => ({ uid: i, hp: 100 - i, cell: { x: 0, y: 0 } })),
  );
  assert.equal(many.length, 12, '飘字数量要有上限');
});

test('玩家面板：4 格固定位，标出自己、空位与掉线', () => {
  const panel = playerPanel([
    { slot: 0, name: '甲', online: true },
    { slot: 2, name: '乙', online: false },
  ], 0);
  assert.equal(panel.length, 4);
  assert.equal(panel[0].name, '甲');
  assert.equal(panel[0].isSelf, true);
  assert.equal(panel[0].online, true);
  assert.equal(panel[1].connected, false);
  assert.equal(panel[1].name, '空位');
  assert.equal(panel[2].name, '乙');
  assert.equal(panel[2].online, false, '掉线要能看出来');
  assert.equal(panel[3].color, TEAM_COLORS[3]);
});

test('§3.7 低血提示：生命 < 20% 才算（边界）', async () => {
  const { isLowHp } = await import('../src/hud-model.js');
  assert.equal(isLowHp(19, 100), true);
  assert.equal(isLowHp(20, 100), false, '刚好 20% 不算低血');
  assert.equal(isLowHp(21, 100), false);
  assert.equal(isLowHp(0, 100), true);
  assert.equal(isLowHp(10, 0), false, '最大生命为 0 时别除以零');
});
