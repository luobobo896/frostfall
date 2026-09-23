// 防守模式（§12.5 / §2.6）：寻路、营地激活、回防调度、城堡、工事、通关与拾取。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFENSE_MAPS, DEFENSE_RULES, FORTS, MONSTERS, TICK_STEP } from '../src/data.js';
import { findPath, gridDist } from '../src/core.js';
import {
  buildFort, createDefenseMatch, describeDefense, orderMove, repairCastle, spawnAssaultWave,
  defenseHeroStats, onMonsterKilled, stepPickups, steerGoal, updateDefense, zoneAt,
} from '../src/defense.js';
import { buyItem, castSkill, damageMonster, heroStats, makeEquipment, updateHeroBuffs } from '../src/match.js';
import { emptyProfile, mapLocked, reviveMulOf, unlockedMaps } from '../src/profile.js';

const advance = (m, seconds) => { for (let i = 0; i < Math.round(seconds / TICK_STEP); i++) updateDefense(m, TICK_STEP); };

test('建局：城堡 / 工事位 / 野外区 / 营地都按 §2.6 的配置来', () => {
  const m = createDefenseMatch({ seed: 1 });
  assert.equal(m.castle.hp, DEFENSE_MAPS.def_01.castleHp);
  assert.equal(m.def.fortSlots.length, 8, 'def_01 有 8 个基地工事位');
  assert.equal(m.def.zones.length, 2);
  assert.equal(m.camps.length, 4);
  assert.equal(m.hero.cell.x, m.castle.cell.x, '英雄从城堡出发');
  assert.ok(Object.keys(FORTS).length === 2, '首发只有箭塔与围墙两种工事');
});

test('寻路：基地围墙挡路，必须从门进出（斜向不穿墙角）', () => {
  const m = createDefenseMatch({ seed: 1 });
  const from = { x: 2, y: 24 };
  const to = { x: m.castle.cell.x, y: m.castle.cell.y };
  const path = findPath(m.grid.w, m.grid.h, from, to, m.isBlocked);
  assert.ok(path && path.length > 0, '应能走通');
  assert.ok(path.some((c) => c.x === m.def.base.gate.x && c.y === m.def.base.gate.y), '路径应经过大门');
  for (const c of path) assert.ok(!m.walls.has(`${c.x},${c.y}`), '不能穿墙');
  // 围墙左侧（不是门那一格）不可达
  assert.ok(m.walls.has('28,21'), '前置：基地左墙在 (28,21)');
  assert.equal(findPath(m.grid.w, m.grid.h, from, { x: 28, y: 21 }, m.isBlocked), null, '围墙上没门的格子不可达');
});

test('营地：每 30 秒刷一波，玩家靠近 6 格才激活', () => {
  const m = createDefenseMatch({ seed: 2 });
  advance(m, DEFENSE_RULES.campIntervalSec + 1);
  assert.ok(m.monsters.length >= 4, `4 个营地各刷一只，实际 ${m.monsters.length}`);
  assert.ok(m.monsters.every((x) => x.kind === 'field' && x.active === false), '远处不该被激活');

  const camp = m.camps[0];
  orderMove(m, { x: camp.x, y: camp.y });
  // 边走边看：英雄到营地只要十来秒，而且进射程后会很快把怪打死，所以不能「走完再看」
  let activated = false;
  for (let i = 0; i < Math.round(20 / TICK_STEP) && !activated; i++) {
    updateDefense(m, TICK_STEP);
    activated = m.monsters.some((x) => x.camp === camp && x.active);
  }
  assert.ok(activated, '靠近后营地怪应被激活');
});

test('回防调度：提前 30 秒预警，到点生成直扑城堡的进攻波', () => {
  const m = createDefenseMatch({ seed: 3 });
  advance(m, DEFENSE_RULES.assaultIntervalSec - DEFENSE_RULES.assaultWarnSec + 1);
  assert.equal(m.assault.warning, true, '进入 30 秒预警');
  assert.ok(m.events.some((e) => e.text.includes('进攻预警')), '要给玩家一条明确预警');

  advance(m, DEFENSE_RULES.assaultWarnSec + 1);
  const assault = m.monsters.filter((x) => x.kind === 'assault');
  assert.ok(assault.length >= 8, `第 1 轮应有 12 只，实际 ${assault.length}`);
  assert.ok(assault.every((x) => x.path.length > 0), '进攻怪要有指向城堡的路径');
  assert.equal(m.assault.round, 1);
});

test('城堡：被打掉血、能花 200 金修 10%、满血不可修', () => {
  const m = createDefenseMatch({ seed: 4 });
  m.castle.hp = 2000;
  m.gold = 1000;
  assert.equal(repairCastle(m), true);
  assert.equal(m.castle.hp, 2000 + m.castle.maxHp * DEFENSE_RULES.repairPct);
  assert.equal(m.gold, 800);
  m.castle.hp = m.castle.maxHp;
  assert.equal(repairCastle(m), false, '满血不该收钱');

  // 让一只进攻怪贴着城堡打一会儿
  spawnAssaultWave(m);
  const mon = m.monsters.find((x) => x.kind === 'assault');
  mon.cell = { ...m.castle.cell };
  mon.hp = mon.maxHp = 5000;                                      // 测试用肉盾，别被英雄顺手清掉
  orderMove(m, { x: m.castle.cell.x - 12, y: m.castle.cell.y });   // 英雄走开，否则怪先打英雄
  advance(m, 6);
  const hitsBefore = m.stats.castleHits;
  advance(m, 3);
  assert.ok(m.stats.castleHits > hitsBefore, '贴着城堡的进攻怪应持续攻击城堡');
  assert.ok(m.castle.hp < m.castle.maxHp, '城堡应掉血');
});

test('工事：箭塔会开火，围墙进阻挡集合（怪得绕路）', () => {
  const m = createDefenseMatch({ seed: 5 });
  m.gold = 1000;
  assert.equal(buildFort(m, 0, 'fort_arrow'), true);
  assert.equal(buildFort(m, 1, 'fort_wall'), true);
  assert.equal(buildFort(m, 1, 'fort_wall'), false, '同一工事位不能重复建');
  const wall = m.forts.find((f) => f.fortId === 'fort_wall');
  assert.ok(m.walls.has(`${wall.cell.x},${wall.cell.y}`), '围墙要真的挡路');

  const arrow = m.forts.find((f) => f.fortId === 'fort_arrow');
  spawnAssaultWave(m);
  const target = m.monsters.find((x) => x.kind === 'assault');
  target.cell = { x: arrow.cell.x, y: arrow.cell.y + 2 };
  const before = target.hp;
  advance(m, 4);
  assert.ok(target.hp < before || target.dead, '射程内的怪应被工事打');
});

test('通关：守住第 4 轮判胜，之后转无尽继续跑（不结束对局）', () => {
  const m = createDefenseMatch({ seed: 6 });
  for (let round = 1; round <= DEFENSE_RULES.roundsToWin; round++) {
    spawnAssaultWave(m);
    // 直接把这一波清掉（模拟守住）
    for (const mon of m.monsters) mon.dead = true;
    m.monsters = [];
    advance(m, 0.5);
  }
  assert.equal(m.result, 'win', '守住 4 轮即通关');
  assert.equal(m.assault.endless, true, '通关后转无尽');
  assert.equal(m.over, undefined, '无尽阶段对局不结束');
  const before = { time: m.time, rounds: m.stats.roundsCleared };
  advance(m, 5);
  assert.ok(m.time > before.time, '通关后仍能继续推进');
  assert.ok(m.stats.roundsCleared >= DEFENSE_RULES.roundsToWin);
});

test('拾取：走到掉落物旁自动入包，属性更好时自动换上', () => {
  const m = createDefenseMatch({ seed: 7 });
  const attackBefore = defenseHeroStats(m).attack;
  const item = makeEquipment(m, 'weapon', 'purple', 12);
  m.groundItems.push({ ...item, cell: { ...m.hero.cell }, at: m.time });
  stepPickups(m);
  assert.equal(m.groundItems.length, 0, '脚下的掉落应被拾取');
  assert.equal(m.inventory.length, 1);
  assert.equal(m.equipped.weapon.quality, 'purple', '更好的装备自动换上');
  // §5.2 / §5.4「掉装备必须即时可穿才有爽感」：换上也必须**真的变强**——
  // 以前装备只进背包界面与「哪件更强」的比较，一件属性都没进过战斗公式（验证记录 §58）
  const after = defenseHeroStats(m);
  assert.ok(after.attack > attackBefore, `换上紫武器后攻击要涨，实际 ${attackBefore} → ${after.attack}`);
  assert.equal(after.attack, attackBefore + m.equipped.weapon.baseAttrs.attack + (m.equipped.weapon.affixes.find((a) => a.id === 'attack')?.value ?? 0));
});

test('英雄阵亡：回城复活 20 秒，掉 30% 金币', () => {
  const m = createDefenseMatch({ seed: 8 });
  m.gold = 1000;
  m.hero.hp = 1;
  // 站到营地正中间让怪打
  orderMove(m, { x: m.camps[0].x, y: m.camps[0].y });
  advance(m, 60);
  assert.ok(m.hero.dead || m.hero.hp > 0, '不该出现 NaN 之类的异常状态');
  if (m.hero.dead) {
    assert.equal(m.gold, 700, '阵亡掉 30% 金币');
    assert.ok(m.hero.reviveTimer <= DEFENSE_RULES.heroReviveSec);
  }
});

test('§3.6 人物等级的复活加速在防守模式同样生效（20 秒 × 人物等级倍率）', () => {
  const reviveOf = (reviveMul) => {
    const m = createDefenseMatch({ seed: 8, reviveMul });
    m.gold = 1000;
    m.hero.hp = 1;
    orderMove(m, { x: m.camps[0].x, y: m.camps[0].y });
    advance(m, 60);
    if (!m.hero.dead) return null;
    return m.hero.reviveTimer;
  };
  const base = reviveOf(1);
  const maxed = reviveOf(reviveMulOf({ commanderLevel: 30 }));
  if (base == null || maxed == null) return;   // 这一局没死成就不硬判（随机成分）
  assert.ok(base <= DEFENSE_RULES.heroReviveSec && base > DEFENSE_RULES.heroReviveSec - 1, `基准约 20 秒，实际 ${base.toFixed(1)}`);
  assert.ok(Math.abs(maxed / base - 0.913) < 0.05, `满级人物该快 8.7%（${base.toFixed(1)} → ${maxed.toFixed(1)}）`);
});

test('三张防守图：配置齐全（工事位 / 野外区 / 营地 / 进攻路线 / 关卡数）', () => {
  const tables = Object.values(DEFENSE_MAPS);
  assert.equal(tables.length, 3, 'def_01 / def_02 / def_03');
  for (const def of tables) {
    assert.ok(def.fortSlots.length >= 8, `${def.id} 工事位应 ≥8，实际 ${def.fortSlots.length}`);
    assert.equal(def.camps.length, def.zones.length * 2, `${def.id} 每个野外区两个营地`);
    assert.ok(def.assaultSpawns.length >= 1);
    assert.equal(def.rounds.length, DEFENSE_RULES.roundsToWin, `${def.id} 通关线要有 4 轮`);
    const m = createDefenseMatch({ mapId: def.id, seed: 1 });
    assert.equal(m.castle.maxHp, def.castleHp);
    assert.equal(m.camps.length, def.camps.length);
    // 塔位不能被围墙或营地压住
    for (const s of def.fortSlots) assert.ok(!m.walls.has(`${s.x},${s.y}`), `${def.id} 工事位 (${s.x},${s.y}) 不该在墙上`);
  }
});

test('多路进攻：第 2/3 张图的每一轮都会从多条路线出兵', () => {
  for (const mapId of ['def_02', 'def_03']) {
    const m = createDefenseMatch({ mapId, seed: 2 });
    spawnAssaultWave(m);
    const spawns = new Set(m.monsters.filter((x) => x.kind === 'assault')
      .map((x) => x.cell.y >= 20 && x.cell.y <= 28 ? 'flank' : 'top'));
    assert.ok(m.monsters.some((x) => x.kind === 'assault'), `${mapId} 应有进攻怪`);
    void spawns;
    // 出怪点之间的横向距离应体现多路线（x 跨度大）
    const xs = m.monsters.filter((x) => x.kind === 'assault').map((x) => x.cell.x);
    assert.ok(Math.max(...xs) - Math.min(...xs) > 20, `${mapId} 的出怪应分散在多条路线，实际 x 跨度 ${Math.max(...xs) - Math.min(...xs)}`);
  }
});

test('§2.6 实体传送点：走上去回基地、不占回城冷却、落地锁住落点', () => {
  const m = createDefenseMatch({ mapId: 'def_01', seed: 3 });
  assert.equal((m.def.teleports ?? []).length, 2, 'def_01 按 §2.6 有 2-3 个传送点');
  // 传送点不能压在城堡或营地上：压在营地上会让「走到营地打怪」变成「被传送回家」
  for (const def of Object.values(DEFENSE_MAPS)) {
    for (const t of def.teleports) {
      assert.ok(!(t.x === def.castle.x && t.y === def.castle.y), `${def.id} 的传送点不该压在城堡格上`);
      assert.ok(!def.camps.some((c) => c.x === t.x && c.y === t.y), `${def.id} 的传送点不该压在营地上`);
    }
  }
  const pad = m.def.teleports[1];                 // 野外那一个
  m.hero.cell = { ...pad };
  m.hero.path = [];
  updateDefense(m, TICK_STEP);
  assert.ok(gridDist(m.hero.cell, m.castle.cell) <= 1, `踩上传送点该回到基地，实际 (${m.hero.cell.x},${m.hero.cell.y})`);
  assert.equal(m.hero.teleportCd, 0, '传送点的代价是「先跑过去」，不该再吃回城的 30 秒冷却');

  // 站着不动不该被反复传送（落地锁住落点那个传送点）
  const settled = { ...m.hero.cell };
  for (let i = 0; i < 5; i++) updateDefense(m, TICK_STEP);
  assert.deepEqual(m.hero.cell, settled, '站在基地不动不该被卷回传送点');

  // 离开传送点再踩一次，仍然有效（锁在离开时解开）
  m.hero.cell = { x: pad.x + 5, y: pad.y };
  updateDefense(m, TICK_STEP);
  m.hero.cell = { ...pad };
  m.hero.path = [];
  updateDefense(m, TICK_STEP);
  assert.ok(gridDist(m.hero.cell, m.castle.cell) <= 1, '离开再踩一次仍然能传回基地');
});

test('§2.6 出怪点在边界上时也要夹进地图（出图的怪没有路径 → 本轮永远清不掉）', () => {
  for (const mapId of ['def_02', 'def_03']) {
    const m = createDefenseMatch({ mapId, seed: 3 });
    for (let r = 0; r < 6; r++) spawnAssaultWave(m);   // 多刷几轮，覆盖到所有出怪点
    const assault = m.monsters.filter((x) => x.kind === 'assault');
    assert.ok(assault.length > 20, `${mapId} 应有足量进攻怪`);
    const outside = assault.filter((x) => x.cell.x < 0 || x.cell.y < 0 || x.cell.x >= m.grid.w || x.cell.y >= m.grid.h);
    assert.equal(outside.length, 0,
      `${mapId}: ${outside.length} 只出图了（${outside.slice(0, 3).map((x) => `(${x.cell.x},${x.cell.y})`).join(' ')}）`);
    const stuck = assault.filter((x) => gridDist(x.cell, m.castle.cell) > 1 && !(x.path ?? []).length);
    assert.equal(stuck.length, 0, `${mapId}: ${stuck.length} 只怪没路可走，它们的这一轮永远清不掉`);
  }
});

// STATUS §3.1 #28（已拍板）：def_03 的门槛从「人物等级 20」改成「声望 1500」——
// Lv20 要 24320 声望 ≈ 203 局（§159），免费期里这张图等于进不去；声望 1500 ≈ 13 局。
test('地图解锁：def_02 要守住 def_01，def_03 还要声望 1500（§3.1 #28）', () => {
  let p = { ...emptyProfile(), clears: {} };
  assert.equal(mapLocked(p, 'def_01'), null);
  assert.equal(mapLocked(p, 'def_02').reason, 'clear');
  assert.match(mapLocked(p, 'def_02').text, /边陲小镇/);
  assert.equal(mapLocked(p, 'def_03').reason, 'clear', '前置图未通时先卡前置');

  p = { ...p, clears: { def_01: { wins: 1 }, def_02: { wins: 1 } }, reputation: 200 };
  assert.equal(mapLocked(p, 'def_02'), null, '守住 def_01 就开 def_02');
  assert.equal(mapLocked(p, 'def_03').reason, 'reputation', '前置通了就卡声望');
  assert.match(mapLocked(p, 'def_03').text, /1500/);

  p = { ...p, reputation: 1500 };
  assert.equal(mapLocked(p, 'def_03'), null);
  assert.deepEqual(unlockedMaps(p, 'defense'), ['def_01', 'def_02', 'def_03']);
  assert.deepEqual(unlockedMaps(p, 'td'), ['map_01'], '防守进度不该把 TD 的图解锁');
});

test('跨轮叠加也算守住：新一波已出、老一波还在时，轮次仍然要涨', () => {
  const m = createDefenseMatch({ mapId: 'def_02', seed: 8 });
  m.castle.hp = 1e9;                       // 不让城堡被打爆，专心看轮次
  spawnAssaultWave(m);                     // 第 1 波
  // 故意留一只不死，模拟多路图上「新一波已出、老一波还在」的常见场面
  const straggler = m.monsters.find((x) => x.kind === 'assault');
  assert.ok(straggler);
  m.assault.timer = 0.1;
  advance(m, 3);                           // 跨过下一波的出兵时刻
  assert.equal(m.assault.round, 2, '第二波应该已经出了');
  assert.ok(m.monsters.some((x) => x.kind === 'assault'), '老一波还在场上');
  assert.equal(m.stats.roundsCleared, 1, '挺过第 1 轮就该计一轮，而不是等全清');
});

test('守住 4 轮的通关时刻：在第 4 轮之后、下一波开打时判定（不要求把每轮全清）', () => {
  const m = createDefenseMatch({ seed: 9 });
  m.castle.hp = 1e9;
  for (let round = 0; round < 4; round++) {
    spawnAssaultWave(m);
    m.assault.timer = 0.1;
    advance(m, 3);
  }
  assert.equal(m.result, 'win', '挺过 4 轮即通关');
  assert.equal(m.assault.endless, true);
  assert.ok(m.stats.roundsCleared >= 4);
});

test('§2.6 野外掉落节奏：刷装循环不断——每 5 分钟至少 1 件', async () => {
  const { autoPlayDefense } = await import('../src/ai-defense.js');
  const m = createDefenseMatch({ seed: 7 });
  autoPlayDefense(m, { maxSeconds: 600 });   // 10 分钟参考打法
  assert.ok(m.stats.drops >= 2,
    `10 分钟里野外掉落 ${m.stats.drops} 件，低于「每 5 分钟 1 件」（附录 B）`);
  assert.ok(m.stats.fieldKills > 0, '要有野外击杀才有掉落（打野是刷装循环的入口）');
});

test('§7.6 防守模式也吃复活保护：3 秒无敌 + 10 秒移速 +50%', async () => {
  const { orderMove } = await import('../src/defense.js');
  const { HERO_REVIVE } = await import('../src/data.js');
  const m = createDefenseMatch({ seed: 7 });
  const hero = m.hero;

  // 阵亡 → 推到复活倒计时结束
  hero.hp = 0; hero.dead = true; hero.reviveTimer = 0.01;
  advance(m, 0.1);
  assert.equal(hero.dead, false, '该在城堡复活');
  assert.ok(hero.invulnUntil >= m.time + 2.9, '复活后应有 3 秒无敌');
  assert.ok(hero.fastUntil >= m.time + 9.9, '复活后应有 10 秒加速');

  // 无敌期内挨打不掉血
  const h0 = hero.hp;
  // 用 Boss 而不是小怪：英雄自己有 2%/s 的回血，小怪的伤害会被回血盖住，测不出「有没有无敌」
  const mon = { uid: 7, mobId: 'boss_01', def: MONSTERS.boss_01, hp: 1e9, maxHp: 1e9, armor: 0,
    armorType: 'fortified', attack: MONSTERS.boss_01.attack, atkSpeed: MONSTERS.boss_01.atkSpeed,
    cooldown: 0, isAir: false, effects: [], dead: false, attacking: false, active: true,
    cell: { x: hero.cell.x + 1, y: hero.cell.y }, path: [] };
  m.monsters.push(mon);
  advance(m, 2);
  assert.equal(mon.attacking, true, '这 2 秒里怪确实在打英雄（否则这条断言是空的）');
  assert.equal(hero.hp, h0, '保护期内不该掉血');
  m.monsters.length = 0;

  // 移速：加速期内走同样格数用的时间应该明显更短（≈ 1/1.5）
  const timeToWalk = (tiles) => {
    let left = tiles;
    let t = 0;
    while (left > 0 && t < 20) {
      orderMove(m, { x: hero.cell.x + left, y: hero.cell.y });
      const before = hero.cell.x;
      advance(m, 1 / 10);
      left -= Math.abs(hero.cell.x - before);
      t += 1 / 10;
    }
    return t;
  };
  hero.fastUntil = m.time + 30;      // 先量「加速中」
  const fast = timeToWalk(6);
  hero.fastUntil = 0;                // 再量「正常速度」
  const normal = timeToWalk(6);
  assert.ok(fast < normal * 0.8, `加速期内应该明显更快：${fast.toFixed(1)}s vs ${normal.toFixed(1)}s（1+${HERO_REVIVE.fastPct}）`);
});

// §10.1：摇杆与点地移动下发**同一条**移动指令。摇杆这半只负责「方向 → 目标格」，
// 落地走的是 orderMove（和点地移动完全一样），所以这几条断言的就是那条指令的形状。
test('摇杆 → 目标格：推得不够（死区）不发指令，推满则往那个方向 2 格', () => {
  const m = createDefenseMatch({ seed: 5 });
  const { x, y } = m.hero.cell;
  assert.equal(steerGoal(m, { x: 0, y: 0, mag: 0 }), null, '没推不发指令');
  assert.equal(steerGoal(m, { x: 0.2, y: 0, mag: 0.2 }), null, '死区之内不发指令');
  assert.deepEqual(steerGoal(m, { x: 1, y: 0, mag: 1 }), { x: x + 2, y }, '推满往右 2 格');
  assert.deepEqual(steerGoal(m, { x: -1, y: 0, mag: 1 }), { x: x - 2, y }, '推满往左 2 格');
  assert.deepEqual(steerGoal(m, { x: 0, y: 1, mag: 1 }), { x, y: y + 2 }, '推满往下 2 格');
  // 斜推：每轴 round(0.707×2)=1，走的是斜向那一格
  assert.deepEqual(steerGoal(m, { x: 0.707, y: 0.707, mag: 1 }), { x: x + 1, y: y + 1 }, '斜推走对角线');
});

test('摇杆贴墙不卡死：斜着撞墙退化成只走主轴（推着摇杆沿墙滑）', () => {
  const m = createDefenseMatch({ seed: 6 });
  m.hero.cell = { x: 0, y: 30 };          // 贴着左边界
  assert.deepEqual(steerGoal(m, { x: -0.707, y: 0.707, mag: 1 }), { x: 0, y: 31 },
    '往左下推：左边出界，退化成只往下');
  m.hero.cell = { x: 0, y: 0 };           // 地图左上角
  assert.equal(steerGoal(m, { x: -1, y: -1, mag: 1 }), null,
    '完全没路可走时不发指令（而不是发一条必被拒的）');
});

// §2.6「野外区难度分区递增，**越远收益越高**」+ §12.8 的 field_zone（lvMin / lvMax / dropBonus）
test('§2.6 野外区：越远的区等级越高、掉得越多（dropBonus 真的进掉落判定）', () => {
  const m = createDefenseMatch({ mapId: 'def_03', seed: 4 });
  const zones = m.def.zones;
  assert.deepEqual(zones.map((z) => z.dropBonus), [1.0, 1.25, 1.5, 1.75], '四档递增，且都有值');
  assert.ok(zones.every((z, i) => i === 0 || z.lvMin >= zones[i - 1].lvMax || z.lvMin >= zones[i - 1].lvMin),
    '等级段随区递增');
  for (const z of zones) assert.ok(z.dropBonus > 0 && z.lvMin < z.lvMax, `${z.id} 的字段合法`);

  // zoneAt：矩形内命中、边界外不命中（x+w/y+h 是开区间，别把邻区那一列算进来）
  const za = zones[0];
  assert.equal(zoneAt(m.def, { x: za.x, y: za.y })?.id, za.id);
  assert.equal(zoneAt(m.def, { x: za.x + za.w - 1, y: za.y + za.h - 1 })?.id, za.id);
  assert.equal(zoneAt(m.def, { x: za.x + za.w, y: za.y }), null, '右边界外');
  assert.equal(zoneAt(m.def, { x: za.x, y: za.y + za.h }), null, '下边界外');
  assert.equal(zoneAt(m.def, m.castle.cell), null, '基地不在任何野外区里');

  // 掉落：同样打 5 只普通怪，近区（保底 8）一件不掉，远区（保底 5）掉一件
  const fieldMon = (cell, zone) => ({
    uid: ++m.spawnCounter, mobId: 'mob_01', def: MONSTERS.mob_01, kind: 'field',
    camp: { zone: zone.id }, cell, hp: 1, maxHp: 1, armor: 0, armorType: 'medium', speed: 0,
    attack: 0, atkSpeed: 0, cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
  });
  const near = zones[0], far = zones[3];
  m.stats.normalKills = 0; m.groundItems = [];
  for (let i = 0; i < 5; i += 1) onMonsterKilled(m, fieldMon({ x: near.x + 1, y: near.y + 1 }, near));
  assert.equal(m.groundItems.length, 0, '近区打 5 只还不掉（保底 8）');
  m.stats.normalKills = 0; m.groundItems = [];
  for (let i = 0; i < 5; i += 1) onMonsterKilled(m, fieldMon({ x: far.x + 1, y: far.y + 1 }, far));
  assert.equal(m.groundItems.length, 1, '远区打 5 只掉一件（保底 5）——「越远收益越高」要真的生效');
});

test('摇杆推着走 = 连续移动（每帧用当前格重发，目标格跟着前滑）', () => {
  const m = createDefenseMatch({ seed: 7 });
  const start = { ...m.hero.cell };
  const dir = { x: 1, y: 0, mag: 1 };
  for (let i = 0; i < 40; i++) {   // 2 秒：主循环就是这么干的（每帧算一次目标格）
    const goal = steerGoal(m, dir);
    if (goal) orderMove(m, goal);
    updateDefense(m, TICK_STEP);
  }
  assert.ok(m.hero.cell.x > start.x + 1, `按住 2 秒应该走出好几格：${start.x} → ${m.hero.cell.x}`);
  assert.equal(m.hero.cell.y, start.y, '只往右推，y 不该变');
});

// §134：**防守模式的英雄也要跑 buff 的到期与派生值**（原来只有 TD 的 heroStep 跑了这一遍）。
// 漏掉的后果有两层：① buff 永不失效（`h.buffs` 只增不减）；② §133 把加成改成「从 buff 重算」之后，
// 战吼 / 药剂 / 守护结界在防守里**全都不生效**了——守誓的结界、游侠的疾风步恰恰在防守里才常用。
test('§134 防守模式：药剂加成真的生效、buff 会到期、技能 buff 不再泄漏', () => {
  const m = createDefenseMatch({ heroId: 'hero_warrior', seed: 5 });
  m.gold = 5000;
  const atk = () => Math.round(heroStats(m.hero).attack);
  const base = atk();

  assert.equal(buyItem(m, 'elixir_atk'), true, '防守里也买得到药剂');
  updateDefense(m, TICK_STEP);
  assert.equal(atk(), Math.round(base * 1.25), `防守模式也要吃到 +25%（基线 ${base}）`);
  for (let i = 0; i < Math.round(30 / TICK_STEP) + 2; i += 1) updateDefense(m, TICK_STEP);
  assert.equal(atk(), base, '30 秒到期后要掉回基线');
  assert.equal(m.hero.buffs.length, 0, '到期之后 buff 列表要清空（以前防守这边会一直堆着）');

  // 对照组：战吼（技能）在防守里也要生效、也会到期
  const w = createDefenseMatch({ heroId: 'hero_warrior', seed: 6 });
  w.hero.level = 10;
  w.hero.skillUnlocked = [true, true, true];
  const base2 = Math.round(heroStats(w.hero).attack);
  assert.equal(castSkill(w, 1), true, '战吼要放得出来');
  updateDefense(w, TICK_STEP);
  assert.ok(Math.round(heroStats(w.hero).attack) > base2, '防守模式里战吼也要涨攻击');
  for (let i = 0; i < Math.round(11 / TICK_STEP); i += 1) updateDefense(w, TICK_STEP);
  assert.equal(Math.round(heroStats(w.hero).attack), base2, '战吼到期也要掉回基线');
  assert.equal(w.hero.buffs.length, 0);
});

// §134 的另一半：疾风步写的「移速 +50%」以前**没有任何读取方**（`speedPct` 只写进 buff 就没人管了），
// 而这个技能恰恰是在防守模式里用的（人物要跑图）。这里量「同样 1 秒能走多远」。
test('§134 疾风步的「移速 +50%」在防守里真的生效（以前从没被读过）', () => {
  const walk = (withWind) => {
    const m = createDefenseMatch({ heroId: 'hero_ranger', seed: 8 });
    m.hero.level = 15;
    m.hero.skillUnlocked = [true, true, true];
    if (withWind) assert.equal(castSkill(m, 2), true, '疾风步要放得出来');
    const start = { ...m.hero.cell };
    // 注意：**不能看 x 位移**——英雄从城堡门口的 (32,24) 出发，而基地是有围墙的，
    // 去东边必须先出西门再绕，头 1 秒 x 反而是往左走的（第一版就是这么量错的）
    orderMove(m, { x: start.x + 12, y: start.y });
    const total = m.hero.path.length;
    for (let i = 0; i < Math.round(1 / TICK_STEP); i += 1) updateDefense(m, TICK_STEP);   // 1 秒
    return total - m.hero.path.length;                       // 1 秒里走掉了几格
  };
  const plain = walk(false);
  const wind = walk(true);
  assert.ok(plain > 0, `基线要真的走起来（实际 ${plain} 格）`);
  assert.ok(wind > plain * 1.3, `带疾风步该明显更快：${plain} 格 → ${wind} 格（设计是 +50%）`);
});

// §144：疾行药剂（`elixir_haste`，150 金 / +30% 攻速 / 30 秒）在**防守模式里从来没生效过**——
// 那 30% 写在 TD 的 `heroStep()` 里（`1 / (stats.atkSpeed * (1 + elixir.atkSpeedPct))`），
// 防守的普攻是 `1 / st.atkSpeed`；`npm test` / `soak` / `defense` 全绿但买它等于买了行日志。
// 这里量的是**真实的普攻间隔**（一次普攻之后内核写回来的 `hero.cooldown`），不是查字符串。
// 对照 §134 的疾风步：同样是「加成记进 buff 了，但两个模式的 tick 各写一份、只有一边去读」。
test('§144 疾行药剂的 +30% 攻速在防守里真的生效（以前只有 TD 读它）', () => {
  const interval = (useHaste) => {
    const m = createDefenseMatch({ heroId: 'hero_warrior', seed: 21 });
    m.gold = 5000;
    if (useHaste) assert.equal(buyItem(m, 'elixir_haste'), true, '防守里要买得到疾行药剂');
    // 一只打不死的怪贴在英雄身边（防御模式下英雄会自动普攻射程内的怪）
    const def = MONSTERS.mob_01;
    m.monsters.push({
      uid: 1, mobId: 'mob_01', def, kind: 'field', cell: { x: m.hero.cell.x + 1, y: m.hero.cell.y },
      hp: 1e6, maxHp: 1e6, armor: 0, armorType: def.armorType, attack: 0, atkSpeed: 1, speed: 0,
      cooldown: 0, isAir: false, effects: [], dead: false, attacking: false, active: true,
      path: [], pathAt: -1,
    });
    m.hero.cooldown = 0;
    updateDefense(m, TICK_STEP);
    return m.hero.cooldown;
  };
  const plain = interval(false);
  const haste = interval(true);
  assert.ok(plain > 0, `基线要真的打出一次普攻（实际间隔 ${plain}）`);
  assert.ok(haste < plain, `吃了疾行药剂该打得更快：${plain}s → ${haste}s`);
  assert.ok(Math.abs(plain / haste - 1.3) < 0.02, `正好是 +30%：${plain}s → ${haste}s（比值 ${(plain / haste).toFixed(3)}）`);
});

// §136：**亡语分裂**（§6.3 的 `onDeath.splitInto`）以前只有 TD 那半实现（写在 `killMonster()` 里），
// 防守这半没有——而 mob_11（亡语蛛后）恰恰在三张防守图的第 3/4 轮都出场，等于这个身份在它最主要的
// 战场上是空的。这条钉两件事：① 死后真的分裂；② 子代跟着父本的类型走（进攻怪继续扑城堡、野外怪算野外怪）。
test('§136 亡语分裂在防守里也生效：mob_11 死后分裂出 2 只，类型跟着父本走', () => {
  const put = (m, mobId, kind, cell) => {
    const def = MONSTERS[mobId];
    const mon = {
      uid: 900 + m.monsters.length, mobId, def, kind, camp: undefined,
      cell: { ...cell }, hp: 10, maxHp: def.hp, armor: def.armor, armorType: def.armorType,
      attack: def.attack, atkSpeed: def.atkSpeed, speed: def.speed,
      cooldown: 0, isAir: !!def.isAir, effects: [], dead: false, attacking: false,
      active: true, path: [], pathAt: -1,
    };
    m.monsters.push(mon);
    return mon;
  };

  // ① 进攻怪（def_01 第 4 轮就是它）：分裂出的小怪也要扑城堡 → 得有路径
  const m = createDefenseMatch({ heroId: 'hero_warrior', seed: 9 });
  const assault = put(m, 'mob_11', 'assault', m.def.assaultSpawns[0]);
  damageMonster(m, assault, 9999, 'hero');
  const kids = m.monsters.filter((x) => x.mobId === MONSTERS.mob_11.onDeath.splitInto);
  assert.equal(kids.length, MONSTERS.mob_11.onDeath.count, '分裂数量要按数据表来');
  assert.ok(kids.every((k) => k.kind === 'assault'), '进攻怪的亡语子代还是进攻怪');
  assert.ok(kids.every((k) => k.path.length > 0), '子代要有一条扑向城堡的路径（不然它会站着不动）');
  assert.ok(kids.every((k) => k.hp === MONSTERS[k.mobId].hp * m.diff.hp), '血量按难度缩放，与其它出怪同口径');

  // ② 野外怪：分裂子代也算野外怪（走野外击杀/掉落那条路）
  const f = createDefenseMatch({ heroId: 'hero_warrior', seed: 10 });
  const field = put(f, 'mob_11', 'field', { x: 8, y: 10 });
  const fieldBefore = f.stats.fieldKills;
  damageMonster(f, field, 9999, 'hero');
  assert.equal(f.monsters.filter((x) => x.mobId === 'mob_01' && x.kind === 'field').length, 2, '野外怪的子代也是野外怪');
  assert.equal(f.stats.fieldKills, fieldBefore + 1, '父本那一次野外击杀照旧记账');
});

// §137：防守的怪**从来不看 `mon.effects`**——于是这个模式里减速（冰塔 / 冰霜之触 / 图腾）、
// 眩晕（制裁之锤）、暴风雪 DoT 全是空的，`effects` 还会一直堆着不清理。
// 这里逐条量：眩晕期间不动、减速走得更少、DoT 每秒掉血、到期会清理。
test('§137 防守的怪也要吃眩晕 / 减速 / DoT（以前一条都没读）', () => {
  const SECONDS = Math.round(1 / TICK_STEP);
  /** 造一局真实的进攻波，给那只怪加点效果，跑 1 秒看它走了几格。 */
  const walkWith = (setup, seconds = 1) => {
    const m = createDefenseMatch({ heroId: 'hero_warrior', seed: 11 });
    spawnAssaultWave(m);
    const mon = m.monsters.find((x) => x.kind === 'assault');
    assert.ok(mon && mon.path.length > 1, '先要有一只在走的怪');
    mon.pathAt = m.time;                                  // 这一秒里别重算路径
    setup(m, mon);
    const before = mon.path.length;
    for (let i = 0; i < Math.round(seconds * SECONDS); i += 1) updateDefense(m, TICK_STEP);
    return { steps: before - mon.path.length, mon, m };
  };

  const plain = walkWith(() => {}).steps;
  assert.ok(plain > 0, `基线要真的在走（实际 ${plain} 格）`);

  const stunned = walkWith((m, mon) => mon.effects.push({ type: 'stun', until: m.time + 1.5 }));
  assert.equal(stunned.steps, 0, '眩晕期间一格都不该走（制裁之锤 1.5 秒）');
  // 眩晕是 1.5 秒，上面只跑了 1 秒——再跑 1 秒确认它**会**到期并被清掉（以前防守这边会一直堆着）
  for (let i = 0; i < SECONDS; i += 1) updateDefense(stunned.m, TICK_STEP);
  assert.equal(stunned.mon.effects.length, 0, '眩晕到期之后要清理');
  assert.equal(stunned.mon.dead, false, '这只怪只是被晕，不该死');

  const slowed = walkWith((m, mon) => mon.effects.push({ type: 'slow', pct: 0.5, until: m.time + 5 }));
  assert.ok(slowed.steps < plain, `减速该走得更少：${plain} 格 → ${slowed.steps} 格`);
  assert.ok(slowed.steps > 0, '减速不是定身');

  // DoT 的规则是「每秒掉一次」：效果至少要活过 1 秒才会跳第一次（第一版只给 0.5 秒，掉血 0 ✓不是 bug）
  const dotted = walkWith((m, mon) => {
    mon.hp = 1e9; mon.maxHp = 1e9;                        // 别让 1 秒的 DoT 把它打死，只看掉血
    mon.effects.push({ type: 'dot', dps: 50, until: m.time + 1.6, tickAt: m.time });
  }, 2);
  assert.ok(1e9 - dotted.mon.hp >= 50, `暴风雪那种 DoT 每秒要掉血（实际掉了 ${Math.round(1e9 - dotted.mon.hp)}）`);
  assert.equal(dotted.mon.effects.length, 0, 'DoT 到期要清理');
});

// §138：**防守内容里的怪不许带「防守没实现的能力」**。
// 这条是 §117（mob_12 的光环整条没实现）与 §136（mob_11 的亡语分裂只在 TD 里实现）两次踩出来的：
// 两个模式的怪物 tick 各写一份，**把一只怪放进防守内容**就等于声明「它的能力在防守里也该有效」，
// 而防守的 tick 里没有 `auraAt()`（光环结算）。
// 现在的口径：要么别把带光环的怪放进防守内容，要么先在 `defense.js` 里把 `auraAt` 接上。
test('§138 防守内容里的怪不许带没实现的能力（当前口径：不带光环）', () => {
  const used = new Set();
  for (const map of Object.values(DEFENSE_MAPS)) {
    for (const round of map.rounds ?? []) for (const g of round.groups) used.add(g.mobId);
    for (const zone of map.zones ?? []) for (const id of zone.mobs) used.add(id);
  }
  assert.ok(used.size >= 4, `要真的扫到怪（拿到 ${used.size} 种）`);

  const offenders = [...used].filter((id) => MONSTERS[id].aura);
  assert.deepEqual(offenders, [],
    '这些怪会出现在防守里，但防守的怪物 tick 没有光环结算（要么别放进防守内容，要么在 defense.js 里接 auraAt）：\n'
    + offenders.map((id) => `  ${id} ${MONSTERS[id].name}`).join('\n'));

  // 对照组：亡语分裂在防守里是实现了的（§136）——这条守卫不该把它也算成「没实现」
  assert.ok([...used].some((id) => MONSTERS[id].onDeath?.splitInto), '防守里确实有带亡语的怪（mob_11）');
});
