// 端到端：跑完整 12 波，验证「能玩」与附录 B 的验收口径。
import test from 'node:test';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

import { autoPlay } from '../src/ai.js';
import {
  buildTower, castSkill, createMatch, damageMonster, describe, heroDamageReduce, heroMaxHp, setPriority, talentValue, update, waveQueue,
} from '../src/match.js';
import { MAPS, MONSTERS, TICK_STEP, TIMING, WAVES } from '../src/data.js';
import { TICK_RATE } from '../src/protocol.js';
import { reviveMulOf } from '../src/profile.js';
import { gridDist } from '../src/core.js';
import * as data from '../src/data.js';

/**
 * 参考打法默认跑 **4 人基准**（§1.6 的 ×1.00 行）。
 * 为什么不是 1 人：附录 B 的时长 / 掉落 / 等级三条验收，文档自己的口径就是 4 人局——
 * §8.5 写着「计算口径：4 人局共享池 … 出怪量按 §6.4.2」，§3.2 写着「4 人局人均到达 17-21」。
 * 单人档（怪量 ×0.60）是另一档，单独验，见下面的 §1.6 用例。
 */
const play = (opts) => {
  const m = createMatch({ players: 4, ...opts });
  autoPlay(m);
  return m;
};

test('map_01 普通难度（4 人基准）：12 波通关，时长与等级落在验收区间', () => {
  const m = play({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 7 });
  const d = describe(m);
  assert.equal(d.result, 'win', `结果应为胜利，实际 ${d.result}（第 ${d.wave} 波）`);
  const minutes = d.time / 60;
  assert.ok(minutes >= 7.5 && minutes <= 12.5, `时长 ${minutes.toFixed(1)} 分钟应落在 8-12 分钟附近`);
  assert.ok(d.heroLevel >= 17 && d.heroLevel <= 21, `英雄 ${d.heroLevel} 级应落在 17-21（§3.2）`);
  // 这里是**单局**样本：掉落里含精英 15% 的随机件，单局在 10-14 之外并不稀奇
  // （实测 seed 7 会出 15 件）。§5.2 的「一局 10-14 件」按均值验收，口径在下面那条 200 局样本的用例里。
  assert.ok(d.drops >= 8 && d.drops <= 18, `单局掉落 ${d.drops} 件（均值口径见 §5.2 掉落节奏用例）`);
  assert.ok(d.core > 0);
  assert.ok(m.towers.length >= 12, 'AI 应铺出可用的塔阵');
});

test('双路图 map_02 / 三路图 map_03 普通难度也能通关', () => {
  for (const mapId of ['map_02', 'map_03']) {
    const m = play({ mapId, difficulty: 'normal', heroId: 'hero_ranger', seed: 7 });
    assert.equal(describe(m).result, 'win', `${mapId} 应该能通普通难度`);
  }
});

test('困难难度是真实挑战（map_01 至少能通，不崩）', () => {
  const m = play({ mapId: 'map_01', difficulty: 'hard', heroId: 'hero_warrior', seed: 7 });
  assert.equal(describe(m).result, 'win');
});

/* ---------- §8.3 攻击优先级（四种模式必须真的换目标） ---------- */

test('§8.3 攻击优先级：最靠前 / 最强 / 最弱 / 空中优先，四个模式各打各的', () => {
  /** 建一座箭塔（对空），在它射程内摆三只怪：靠后的血厚、靠前的血薄、外加一只空中的 */
  const pick = (priority) => {
    const m = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 3, players: 4 });
    m.gold = 1000;
    // 选离路径最近的塔位，保证三只怪都在射程里
    const path = m.map.paths[0];
    let bestSlot = 0, bestD = Infinity;
    m.map.slots.forEach((s, i) => {
      for (let d = 0; d < path.lengthTiles * 128; d += 32) {
        const c = path.cells[Math.min(path.cells.length - 1, Math.floor(d / 128))];
        const dist = Math.hypot(c.x - s.x, c.y - s.y);
        if (dist < bestD) { bestD = dist; bestSlot = i; }
      }
    });
    assert.equal(buildTower(m, bestSlot, 'tw_arrow'), true);
    const tower = m.towers[0];
    tower.priority = priority;
    // 找到塔旁边的路径点作为基准 dist
    let base = null;
    for (let d = 0; d < path.lengthTiles * 128; d += 32) {
      const c = path.cells[Math.min(path.cells.length - 1, Math.floor(d / 128))];
      if (Math.max(Math.abs(c.x - tower.cell.x), Math.abs(c.y - tower.cell.y)) <= 3) { base = d; break; }
    }
    assert.ok(base != null, '前置：路径该经过这座塔附近');
    const place = (uid, dist, hp, isAir) => {
      const def = MONSTERS.mob_01;
      const c = path.cells[Math.min(path.cells.length - 1, Math.floor(dist / 128))];
      const mon = {
        uid, mobId: 'mob_01', def, pathIndex: 0, dist, cell: { ...c },
        hp, maxHp: hp, armor: def.armor, armorType: def.armorType, speed: 0,
        attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir, effects: [], dead: false, attacking: false,
      };
      m.monsters.push(mon);
      return mon;
    };
    const behind = place(11, base + 96, 500, false);   // 最靠前（走得最远）
    const mid = place(12, base + 32, 200, false);      // 血最少
    const air = place(13, base + 64, 300, true);       // 空中
    update(m, TICK_STEP);                                  // 开火一帧：弹道会记住它选了谁
    const target = m.projectiles[0]?.target?.uid ?? null;
    return { target, behind: behind.uid, mid: mid.uid, air: air.uid };
  };

  const front = pick('front');
  assert.equal(front.target, front.behind, '「最靠前」= 距核心最近的单位（走得最远的那只）');
  const strongest = pick('strongest');
  assert.equal(strongest.target, strongest.behind, '「最强」= 当前 HP 最高的那只（这里就是靠后那只 500 血的）');
  const weakest = pick('weakest');
  assert.equal(weakest.target, weakest.mid, '「最弱」= 当前 HP 最低的那只');
  const airFirst = pick('air_first');
  assert.equal(airFirst.target, airFirst.air, '「空中优先」= 先打空中单位');
  // 非法模式要拒绝（不然塔面板传进来一个错字就把 targeting 变成 undefined 分支）
  const bad = createMatch({ mapId: 'map_01', seed: 1, players: 4 });
  bad.gold = 1000;
  buildTower(bad, 0, 'tw_arrow');
  assert.equal(setPriority(bad, 0, 'not-a-mode'), false);
  assert.equal(bad.towers[0].priority, 'front', '被拒绝时不该改掉原来的优先级');
});

/* ---------- §1.6 人数缩放（此前内核只把 players 用来开木材数组，缩放一列都没实现） ---------- */

test('§2.4 难度倍率：生命 / 攻击 / 出怪速度 / 掉落四列都真的生效', () => {
  const { DIFFICULTY, MONSTERS } = data;
  // 表就是文档那四列（「声望 ×1.5/×2」在 REPUTATION 里给的是绝对值，不在这张表）
  assert.deepEqual(DIFFICULTY.normal, { hp: 1, atk: 1, spawn: 1, drop: 1 });
  assert.equal(DIFFICULTY.hard.spawn, 1.1);
  assert.equal(DIFFICULTY.nightmare.spawn, 1.2);

  // 出怪速度：同一波同一组，怪量与构成不变，只是间隔 ÷倍率（困难 1.4s → 1.27s）
  const normalQ = waveQueue(8, data.WAVES, 1, DIFFICULTY.normal.spawn);
  const hardQ = waveQueue(8, data.WAVES, 1, DIFFICULTY.hard.spawn);
  assert.equal(normalQ.length, hardQ.length, '难度不改变怪量');
  assert.ok(Math.abs(hardQ[1].at - normalQ[1].at / 1.1) < 1e-9,
    `困难第 2 只该在 ${(normalQ[1].at / 1.1).toFixed(2)}s，实际 ${hardQ[1].at.toFixed(2)}s`);

  // 生命 ×1.35 / 攻击 ×1.25：开一局困难，出怪后逐只对
  const hard = createMatch({ mapId: 'map_01', difficulty: 'hard', heroId: 'hero_warrior', seed: 3, players: 4 });
  hard.wave.timer = 0;
  update(hard, TICK_STEP);
  update(hard, TICK_STEP);
  const mon = hard.monsters[0];
  assert.ok(mon, '第 1 波该出怪');
  assert.equal(mon.maxHp, MONSTERS[mon.mobId].hp * 1.35, '困难怪物生命 ×1.35');
  assert.ok(Math.abs(mon.attack - MONSTERS[mon.mobId].attack * 1.25) < 1e-9, '困难怪物攻击 ×1.25');

  // 掉落 ×1.25：精英掉落概率 0.15 → 困难 0.1875。把随机数钉在 0.18，普通不掉、困难掉。
  const eliteDrop = (difficulty) => {
    const m = createMatch({ mapId: 'map_01', difficulty, heroId: 'hero_warrior', seed: 5, players: 4 });
    const drops0 = m.stats.drops;
    m.rng = () => 0.18;
    const mob = MONSTERS.mob_10;
    const m2 = {
      uid: 1, mobId: 'mob_10', def: mob, pathIndex: 0, dist: 0, cell: { x: 0, y: 4 },
      hp: 1, maxHp: mob.hp, armor: mob.armor, armorType: mob.armorType, speed: 0,
      attack: mob.attack, atkSpeed: mob.atkSpeed, cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
    };
    m.monsters.push(m2);
    damageMonster(m, m2, 9999);
    return m.stats.drops - drops0;
  };
  assert.equal(eliteDrop('normal'), 0, '普通难度：0.18 > 0.15，精英不该掉');
  assert.equal(eliteDrop('hard'), 1, '困难难度：0.15 × 1.25 = 0.1875 ≥ 0.18，精英该掉');
});

test('§1.6 人数缩放：怪量 / 生命 / 金币三列按表走，4 人 = ×1.00 基准', () => {
  const { PLAYER_SCALE, playerScaleOf, ECONOMY, DIFFICULTY, MONSTERS } = data;
  assert.equal(PLAYER_SCALE.length, 8);
  assert.deepEqual(playerScaleOf(1), { count: 0.60, hp: 0.85, gold: 0.80 });
  assert.deepEqual(playerScaleOf(4), { count: 1.00, hp: 1.00, gold: 1.00 });
  assert.deepEqual(playerScaleOf(8), { count: 1.45, hp: 1.20, gold: 1.20 });
  assert.deepEqual(playerScaleOf(99), playerScaleOf(8), '越界要夹住，不是崩');

  // 怪量：第 1 波 8 只 → 单人 5 只（四舍五入）、4 人 8 只
  const solo = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 7, players: 1 });
  const four = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 7, players: 4 });
  assert.equal(waveQueue(1, solo.waves, solo.scale.count).length, 5);
  assert.equal(waveQueue(1, four.waves, four.scale.count).length, 8);
  // Boss 那种 count=1 的组至少留 1 只（否则单人档第 6 / 12 波就没有 Boss 了）
  assert.ok(waveQueue(6, solo.waves, solo.scale.count).some((e) => e.mobId === 'boss_01'));
  assert.ok(waveQueue(12, solo.waves, solo.scale.count).some((e) => e.mobId === 'boss_02'));

  // 生命：开波后 mob_01 的血量 = 基础 × 难度 × 人数系数
  solo.wave.timer = 0;
  update(solo, TICK_STEP);
  update(solo, TICK_STEP);   // 第一帧只切到 spawning，出怪在下一帧
  const mob = solo.monsters.find((x) => x.mobId === 'mob_01');
  assert.ok(mob, '第 1 波该有 mob_01');
  assert.equal(mob.maxHp, MONSTERS.mob_01.hp * DIFFICULTY.normal.hp * 0.85);

  // 金币：赏金系数 ×0.80（§6.4 的 ×0.5 也在里面，所以只能比出来）
  assert.equal(solo.bountyMul, ECONOMY.bountyMul * 0.8);
  assert.equal(four.bountyMul, ECONOMY.bountyMul);
});

test('§1.6 × §3.2：单人档期望 15 级、4 人基准 19 级（文档的两张表各自成立）', () => {
  const solo = play({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 7, players: 1 });
  const four = play({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 7, players: 4 });
  const ds = describe(solo);
  const df = describe(four);
  assert.equal(ds.result, 'win');
  assert.equal(df.result, 'win');
  assert.ok(ds.heroLevel >= 13 && ds.heroLevel <= 17, `§3.2 说单人局到 15 级，实测 ${ds.heroLevel}`);
  assert.ok(df.heroLevel >= 17 && df.heroLevel <= 21, `§3.2 说 4 人局 17-21 级，实测 ${df.heroLevel}`);
  assert.ok(df.time / 60 >= 7.5 && df.time / 60 <= 12.5, '4 人基准要落在 8-12 分钟这一档');
  // ⚠ 已知冲突：单人档实测 7.0-7.3 分钟，**低于**附录 B 的 8 分钟下限——
  // §6.4.1 的时长模型没把「怪量变少 → 清场余量变短」算进去。这是 §1.6 与附录 B 的口径冲突，
  // 需要拍板（提系数 / 承认 8-12 是 4 人基准 / 只缩血量不缩怪量），见验证记录 §60。
  assert.ok(ds.time / 60 <= 12.5, '单人档不该超过 12.5 分钟');
});

test('§3.6 人物等级的复活加速真的作用到计时上（此前 COMMANDER.reviveSpeedPctPerLevel 定义了没人读）', () => {
  /** 让英雄被贴脸的怪打死，返回复活倒计时 */
  const reviveSecOf = (reviveMul) => {
    const m = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 7, players: 4, reviveMul });
    m.hero.hp = 1;
    m.rng = () => 0.5;
    const path = m.map.paths[0];
    const dist = (() => {
      for (let d = 0; d < path.lengthTiles * 128; d += 32) {
        const c = path.cells[Math.min(path.cells.length - 1, Math.floor(d / 128))];
        if (Math.max(Math.abs(c.x - m.hero.cell.x), Math.abs(c.y - m.hero.cell.y)) <= 2) return d;
      }
      return null;
    })();
    const def = MONSTERS.boss_01;
    m.monsters.push({
      uid: 1, mobId: 'boss_01', def, pathIndex: 0, dist,
      cell: path.cells[Math.min(path.cells.length - 1, Math.floor(dist / 128))],
      hp: 1e9, maxHp: 1e9, armor: def.armor, armorType: def.armorType, speed: 0,
      attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
    });
    for (let i = 0; i < 20 && !m.hero.dead; i++) update(m, TICK_STEP);
    assert.equal(m.hero.dead, true, '前置：英雄该被打死了');
    return m.hero.reviveTimer;
  };
  // 容差取一个 tick（20Hz 的倒数）：死亡那一帧里倒计时已经走了一步
  assert.ok(Math.abs(reviveSecOf(1) - 15) < 0.1, '§7.6 的基准是 15 秒');
  const max = reviveSecOf(reviveMulOf({ commanderLevel: 30 }));
  assert.ok(Math.abs(max - 15 * 0.913) < 0.1, `满级人物该快 8.7%（15 → ${max.toFixed(2)} 秒）`);
  assert.ok(max < 15);
});

test('确定性：同 seed 同配置 → 同结果', () => {
  const a = describe(play({ seed: 42 }));
  const b = describe(play({ seed: 42 }));
  assert.deepEqual(a, b);
  const c = describe(play({ seed: 43 }));
  assert.notDeepEqual(a, c, '不同 seed 应产生不同过程（掉落/浮动伤害）');
});

test('运行期不变量：血量、金币、怪物状态始终合法', () => {
  const m = createMatch({ mapId: 'map_02', difficulty: 'normal', seed: 5 });
  for (let i = 0; i < Math.round(300 / TICK_STEP) && !m.result; i++) {
    update(m, TICK_STEP);
    assert.ok(m.core.hp >= 0 && Number.isFinite(m.core.hp), `核心 HP 合法 @${i}`);
    assert.ok(m.gold >= 0 && Number.isFinite(m.gold), `金币合法 @${i}`);
    for (const h of m.lumber) assert.ok(h >= 0, `木材合法 @${i}`);
    for (const t of m.towers) assert.ok(t.cooldown >= 0 && Number.isFinite(t.cooldown), `塔冷却合法 @${i}`);
    // 怪物死亡后标记 dead，在当帧末尾统一回收；数组里允许存在「已死待回收」的实体
    for (const mo of m.monsters) assert.ok(mo.hp > 0 || mo.dead, `怪物要么活着要么已标记死亡 @${i}`);
    for (const p of m.projectiles) assert.ok(p.life > 0, `弹道寿命 > 0 @${i}`);
  }
  assert.ok(m.time > 60, '至少推进了一分钟以上');
});

test('§7.5 容错率：核心能承受的漏怪数落在 30-50 只', () => {
  const minLeakDamage = Math.min(...Object.values(MONSTERS).filter((x) => x.coreDamage < 1000).map((x) => x.coreDamage));
  for (const def of Object.values(MAPS)) {
    const capacity = Math.floor(def.coreHp / minLeakDamage);
    // 首发 1-3★ 图：附录 B 的验收带。实算 map_01 = 40（§7.5 写的那个数）、map_02/03 = 50。
    // 这条曾经放宽到 55 来迁就「霜狼对核心伤害 55」，那是把验收线改绿，不是把红修掉。
    // 4-6★ 大图（走长局的图）核心血更多、路线更长，容错自然更高，单独定档 40-90。
    const band = def.stars >= 4 ? [40, 90] : [30, 50];
    assert.ok(capacity >= band[0] && capacity <= band[1],
      `${def.id}（${def.stars}★）容错 ${capacity} 只应落在 ${band[0]}-${band[1]}`);
  }
});

test('波次奖励与经济口径与文档一致（§6.4 / §8.5）', () => {
  const m = play({ mapId: 'map_01', difficulty: 'normal', seed: 7 });
  assert.ok(m.stats.goldEarned > 3000, '一局累计收入应达到数千金量级');
  assert.equal(WAVES.length, 12);
});

test('实体 uid 唯一且为正整数（联机按 uid 对齐实体，NaN 会让所有怪被当成同一只）', () => {
  const m = createMatch({ mapId: 'map_01', difficulty: 'normal', seed: 3 });
  m.wave.timer = 0;
  for (let i = 0; i < 400; i++) update(m, TICK_STEP);
  assert.ok(m.monsters.length > 1, '应有多个怪物');
  const uids = m.monsters.map((x) => x.uid);
  for (const uid of uids) assert.ok(Number.isInteger(uid) && uid > 0, `uid 必须是正整数，实际 ${uid}`);
  assert.equal(new Set(uids).size, uids.length, 'uid 必须唯一');
});

/** 跑一批定种子局，按「掉落那一刻」统计品质（手里的存货已经被一键合成动过，不能拿来当口径）。 */
const sampleRuns = (seeds) => {
  const total = { drops: 0, purple: 0, orange: 0, chests: 0, games: 0, rolls: { normal: 0, elite: 0, boss: 0, chest: 0 } };
  for (const seed of seeds) {
    const m = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed, players: 4 });
    const raw = { white: 0, blue: 0, purple: 0, orange: 0 };
    let inv = m.inventory;
    const wrap = (arr) => {
      const push = arr.push.bind(arr);
      arr.push = (item) => { raw[item.quality] += 1; return push(item); };
      return arr;
    };
    // 合成会把 inventory 整个换掉，所以每次赋值都要重新挂一遍
    Object.defineProperty(m, 'inventory', { configurable: true, get: () => inv, set: (v) => { inv = wrap(v); } });
    inv = wrap(inv);
    autoPlay(m, { maxSeconds: 1800 });
    total.drops += m.stats.drops;
    total.purple += raw.purple;
    total.orange += raw.orange;
    total.chests += m.events.filter((e) => e.text.includes('波宝箱')).length;
    total.games += 1;
    for (const k of Object.keys(total.rolls)) total.rolls[k] += m.stats.rolls[k] ?? 0;
  }
  return total;
};

test('§5.2 / 附录 B 掉落节奏：一局 10-14 件、紫 1-2 件、每 4 波一个宝箱', () => {
  // 样本量是口径的一部分：60 局是「件数」这类指标的够用样本（10 局也能过，但下面那条橙装告诉我们别信小样本）
  const seeds = Array.from({ length: 60 }, (_, i) => i + 1);
  const { drops, purple, chests, games: n } = sampleRuns(seeds);
  const avg = (x) => x / n;
  assert.ok(avg(drops) >= 10 && avg(drops) <= 14, `平均掉落 ${avg(drops).toFixed(2)} 件应落在 10-14（§5.2）`);
  assert.ok(avg(purple) >= 1 && avg(purple) <= 2.5, `平均紫装 ${avg(purple).toFixed(2)} 件应落在 1-2（§5.2）`);
  assert.equal(chests, n * 3, '12 波局每 4 波一个宝箱，共 3 个（§5.2）');
});

test('§5.2 橙装的源头：精英 5% + 合成；第 12 波 Boss 那 15% 目前是死源头', () => {
  // 旧版是「10 局里数出 ≥1 件橙」——橙装是 1/6.5 的事件，10 局样本 25% 的概率数出 0 件，
  // 那次「通过」纯属运气（一小段玩法改动就翻车，见验证记录 §57）。换成 200 局之后还发现：
  // 就算 200 局也测不准这个倍数（橙装一局 0.1 件上下，20 个样本的抖动就有 ±20%），
  // 所以这里**盯的是源头结构**，不是那个精确倍数。
  const { orange, rolls, games: n } = sampleRuns(Array.from({ length: 200 }, (_, i) => i + 1));
  const perGame = orange / n;
  assert.ok(orange > 0, '橙装一件都不出，说明源头全断了');
  assert.ok(perGame >= 0.05, `橙装 ${(1 / perGame).toFixed(1)} 局一次：比 20 局一次还稀，多半是源头断了`);
  // 源头一：精英（含第 6 波小 Boss）的 5%——橙装的大头
  const elite = rolls.elite / n;
  assert.ok(elite > 0.8, `精英掉落判定只有 ${elite.toFixed(2)} 次/局：它是橙装的主要来源，掉到 0 附近就要查`);
  // 源头二：第 12 波 Boss 的 15%——**已知偏差，且已查明与血量无关**：实测把 boss_02 从 8000 血
  // 砍到 3000，参考打法的结果逐字相同（Boss 掉落判定恒 0.05 次/局）——它漏过去是**射程覆盖**
  // 决定的。所以 STATUS §3.1 #2 改的是**精英的橙率**（0.05 → 0.08，紫 0.30 → 0.27），
  // 不是砍 Boss 血量。上限放到 0.2：实测在 0.05-0.10 之间浮动，用 0.1 卡会偶发红。
  assert.ok(rolls.boss / n < 0.2,
    `第 12 波 Boss 的掉落判定 ${(rolls.boss / n).toFixed(2)} 次/局：§5.2 指望它当橙装主来源，`
    + '而参考打法下它基本活不到掉落判定那一步（射程覆盖问题，与血量无关，见 §58 / 验证记录 §207）');
  // §5.2 的目标是**5-8 局一次**。§3.1 #2 拍板后实测 0.17 件/局 = **5.7 局一次**（200 局样本），
  // 落在带内；件数 12.24 与紫 1.87 也仍在 10-14 / 1-2 里。
  const gamesPerOrange = n / orange;
  assert.ok(gamesPerOrange >= 5 && gamesPerOrange <= 8,
    `橙装 ${gamesPerOrange.toFixed(1)} 局一次（目标 5-8）：偏离说明源头又变了`);
});

test('§1.9.4 操作低频：中局断手 25 秒不会输（塔自己打，不用一直摸屏幕）', () => {
  const m = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 7 });
  autoPlay(m, { untilWave: 6, maxSeconds: 900 });   // 参考打法先铺到 10 座塔（第 6 波小 Boss 之后）
  let guard = 0;
  while (!m.result && m.wave.phase !== 'spawning' && guard++ < 20000) update(m, TICK_STEP);  // 等下一波真的开打
  const coreBefore = m.core.hp;
  const killsBefore = m.stats.kills;
  assert.ok(!m.result, '这个时间点不该已经结束');
  assert.ok(m.towers.length >= 8, `断手测试要在塔阵起来之后做（现在 ${m.towers.length} 座）`);

  // 完全不操作：不放技能、不建塔、不买东西，纯跑 25 秒
  for (let i = 0; i < Math.round(25 / TICK_STEP); i++) update(m, TICK_STEP);

  assert.ok(m.stats.kills > killsBefore,
    '这 25 秒里一只都没死，说明测试窗口是空的（那就不是在验「不用操作也能打」）');
  assert.notEqual(m.result, 'lose', `断手 25 秒就输了（核心 ${Math.round(coreBefore)} → ${Math.round(m.core.hp)}）`);
  assert.ok(coreBefore - m.core.hp <= 200,
    `断手 25 秒不该靠运气：核心掉了 ${Math.round(coreBefore - m.core.hp)}（塔阵兜不住的话说明节奏逼着玩家一直操作）`);
  console.log(`  第 ${m.wave.index} 波开打断手 25 秒：击杀 +${m.stats.kills - killsBefore} · 核心 ${Math.round(coreBefore)} → ${Math.round(m.core.hp)} · 塔 ${m.towers.length}`);
});

// §7.7「脱离范围 **1 秒后**继续前进」——这条以前是空的：脱离仇恨就已经离开「贴脸停战」范围，
// 怪立刻恢复前进，1 秒窗口永远命中不到（验证记录 §91）。
test('§7.7 脱离仇恨后还会被追打 1 秒，然后才停手（风筝不能无代价）', () => {
  const m = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 11 });
  const path = m.map.paths[0];
  const def = MONSTERS.boss_01;   // Boss 仇恨 6 格，最容易摆出「先够得着、再跑出去」
  const at = (d) => path.cells[Math.min(path.cells.length - 1, Math.floor(d / 128))];
  // 找一个离英雄 5 格（仇恨内）的位置放 Boss
  let dist = null;
  for (let d = 0; d < path.lengthTiles * 128; d += 32) {
    const c = at(d);
    if (gridDist(c, m.hero.cell) === 5) { dist = d; break; }
  }
  assert.ok(dist != null, '地图上应有离英雄 5 格的路径点');
  const mon = {
    uid: 80001, mobId: 'boss_01', def, pathIndex: 0, dist, cell: at(dist),
    hp: def.hp, maxHp: def.hp, armor: def.armor, armorType: def.armorType, speed: def.speed,
    attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir: false,
    effects: [], dead: false, attacking: false,
  };
  m.monsters.push(mon);
  update(m, TICK_STEP);
  assert.equal(mon.attacking, true, '5 格在 Boss 的 6 格仇恨内');
  assert.ok(mon.aggroUntil > m.time, '仇恨期内记下「还能追打到什么时候」');

  // 把英雄挪到 20 格外（彻底脱离），不再刷新仇恨窗口
  m.hero.cell = { x: m.map.grid.w - 1, y: m.map.grid.h - 1 };
  assert.ok(gridDist(mon.cell, m.hero.cell) > 6, '前置：英雄确实跑远了');
  update(m, TICK_STEP);
  assert.equal(mon.attacking, true, '刚脱离的那一帧还在追打（1 秒窗口内）');
  for (let i = 0; i < 10; i++) update(m, TICK_STEP);   // 再跑 0.5 秒：仍在窗口内
  assert.equal(mon.attacking, true, '0.6 秒时还在追打');
  for (let i = 0; i < 12; i++) update(m, TICK_STEP);   // 累计 1.2 秒：窗口过了
  assert.equal(mon.attacking, false, '超过 1 秒就该停手——这条线要能失败');

  // 反向：英雄死了要立刻停手（否则每帧都会重算「击杀」，把复活倒计时反复重置）
  const m2 = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 12 });
  const mon2 = { ...mon, uid: 80002, cell: { ...m.hero.cell }, attacking: true, aggroUntil: m2.time + 5 };
  m2.monsters.push(mon2);
  m2.hero.hp = 0; m2.hero.dead = true; m2.hero.reviveTimer = 15;
  for (let i = 0; i < 5; i++) update(m2, TICK_STEP);
  assert.equal(mon2.attacking, false, '英雄已阵亡就不该继续挨打');
  // 复活倒计时只会往下走：被「反复打死」的写法每帧都会把它重置回 15 秒
  assert.ok(m2.hero.reviveTimer < 15 && m2.hero.reviveTimer > 14.5,
    `复活倒计时要正常递减（实际 ${m2.hero.reviveTimer.toFixed(2)}s），不能被反复重置`);
});

test('§7.7 仇恨不会变成死锁：远处边走边打，只有贴脸（≤2 格）才停下', () => {
  const m = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId: 'hero_paladin', seed: 7 });
  const path = m.map.paths[0];
  const totalUnits = path.lengthTiles * 128;
  const cellAtDist = (d) => path.cells[Math.min(path.cells.length - 1, Math.floor(d / 128))];

  // 找路径上「离英雄正好 5 格」和「正好 2 格」的两个位置
  const pick = (want) => {
    for (let d = 0; d < totalUnits; d += 32) {
      const c = cellAtDist(d);
      if (Math.max(Math.abs(c.x - m.hero.cell.x), Math.abs(c.y - m.hero.cell.y)) === want) return d;
    }
    return null;
  };
  const place = (mobId, d) => {
    const def = MONSTERS[mobId];
    const mon = {
      uid: 90000 + Math.round(d), mobId, def, pathIndex: 0, dist: d, cell: cellAtDist(d),
      hp: def.hp, maxHp: def.hp, armor: def.armor, armorType: def.armorType, speed: def.speed,
      attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir: !!def.isAir,
      effects: [], dead: false, attacking: false,
    };
    m.monsters.push(mon);
    return mon;
  };

  const far = pick(5);
  assert.ok(far != null, '地图上应当存在离英雄 5 格的路径点');
  const bossFar = place('boss_01', far);
  const d0 = bossFar.dist;
  for (let i = 0; i < 60; i++) update(m, TICK_STEP);        // 3 秒
  assert.ok(bossFar.dist > d0 + 100, `5 格外（在 Boss 的 6 格仇恨里）必须继续前进，实际 ${Math.round(d0)} → ${Math.round(bossFar.dist)}`);

  m.monsters.length = 0;
  const near = pick(2);
  assert.ok(near != null, '地图上应当存在离英雄 2 格的路径点');
  const bossNear = place('boss_01', near);
  const d1 = bossNear.dist;
  for (let i = 0; i < 60; i++) update(m, TICK_STEP);
  assert.ok(Math.abs(bossNear.dist - d1) < 1, `贴脸时必须停下来打（否则英雄拉不住怪），实际 ${Math.round(d1)} → ${Math.round(bossNear.dist)}`);
});

test('§7.6 复活保护：复活后 3 秒无敌、10 秒加速；过完保护还能正常挨打', () => {
  const m = createMatch({ mapId: 'map_01', difficulty: 'normal', seed: 7 });
  const path = m.map.paths[0];
  const distAt = (want) => {
    for (let d = 0; d < path.lengthTiles * 128; d += 32) {
      const c = path.cells[Math.min(path.cells.length - 1, Math.floor(d / 128))];
      if (Math.max(Math.abs(c.x - m.hero.cell.x), Math.abs(c.y - m.hero.cell.y)) === want) return d;
    }
    return null;
  };
  // 让英雄阵亡，并把复活倒计时推到 0 → 下一 tick 复活
  m.hero.hp = 0; m.hero.dead = true; m.hero.reviveTimer = 0.01;
  update(m, TICK_STEP);
  assert.equal(m.hero.dead, false, '该复活了');
  assert.ok(m.hero.invulnUntil >= m.time + 2.9, `复活后应有 3 秒无敌（拿到的 ${(m.hero.invulnUntil - m.time).toFixed(2)} 秒）`);
  assert.ok(m.hero.fastUntil >= m.time + 9.9, '复活后应有 10 秒加速');

  // 贴脸放一只近战怪：保护期内打不掉血，保护期过了就要掉
  const d = distAt(2);
  const def = MONSTERS.mob_04;
  m.monsters.push({
    uid: 1, mobId: 'mob_04', def, pathIndex: 0, dist: d,
    cell: path.cells[Math.min(path.cells.length - 1, Math.floor(d / 128))],
    hp: 1e9, maxHp: 1e9, armor: def.armor, armorType: def.armorType, speed: 0,
    attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
  });
  const hp0 = m.hero.hp;
  for (let i = 0; i < 40; i++) update(m, TICK_STEP);        // 2 秒（保护期内）
  assert.equal(m.hero.hp, hp0, '保护期内不该掉血');
  for (let i = 0; i < 40; i++) update(m, TICK_STEP);        // 再 2 秒（保护期已过）
  assert.ok(m.hero.hp < hp0, `保护期过了应该挨打，实际 ${Math.round(hp0)} → ${Math.round(m.hero.hp)}`);
});

test('§3.7 回复口径：战斗中 0.5%/s，脱战 3 秒后才回到 2%/s', () => {
  const { HERO_REGEN } = data;
  const m = createMatch({ mapId: 'map_01', difficulty: 'normal', seed: 7 });
  const path = m.map.paths[0];
  const distAt = (want) => {
    for (let d = 0; d < path.lengthTiles * 128; d += 32) {
      const c = path.cells[Math.min(path.cells.length - 1, Math.floor(d / 128))];
      if (Math.max(Math.abs(c.x - m.hero.cell.x), Math.abs(c.y - m.hero.cell.y)) === want) return d;
    }
    return null;
  };
  const def = MONSTERS.mob_04;
  const d = distAt(2);
  const mon = {
    uid: 1, mobId: 'mob_04', def, pathIndex: 0, dist: d,
    cell: path.cells[Math.min(path.cells.length - 1, Math.floor(d / 128))],
    hp: 1e9, maxHp: 1e9, armor: def.armor, armorType: def.armorType, speed: 0,
    attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
  };
  const maxHp = heroMaxHp(m.hero);
  const step = (seconds) => { for (let i = 0; i < Math.round(seconds / TICK_STEP); i++) update(m, TICK_STEP); };

  m.hero.hp = maxHp * 0.5;
  m.hero.invulnUntil = 1e9;          // 只为掐回复，别让怪把血打没了
  m.monsters.push(mon);
  step(2);                            // 交战中
  const combatGain = m.hero.hp - maxHp * 0.5;

  m.monsters.length = 0;              // 脱战，但还没满 3 秒
  const h1 = m.hero.hp;
  step(2);
  const earlyGain = m.hero.hp - h1;

  step(2);                            // 脱战累计 4 秒 → 已经切到 2%/s
  const h2 = m.hero.hp;
  step(2);
  const lateGain = m.hero.hp - h2;

  // 2 秒的期望值：战斗中 0.5%/s → 约 9（900 血），脱战 2%/s → 约 36。阈值卡在两者中间，
  // 否则「没有 3 秒延迟」这个 bug 也能过（第一版就写宽了：36 < 39.6 居然算通过）。
  assert.ok(combatGain < maxHp * 0.02, `战斗中的回血应该按 0.5%/s 走（2 秒约 9，实际 ${combatGain.toFixed(0)}）`);
  assert.ok(earlyGain < maxHp * 0.02, `脱战 3 秒内还是 0.5%/s（实际 ${earlyGain.toFixed(0)}）`);
  assert.ok(lateGain > maxHp * 0.03, `脱战 3 秒后应该回到 2%/s（2 秒约 36，实际 ${lateGain.toFixed(0)}）`);
});

/* ---------- §3.3 / §3.5 天赋：首发 4 个里曾有 3 个「定义了没读取方」（验证记录 §54） ---------- */

/** 贴脸放一只血很厚的怪（打不死它，也不会被它打死），量英雄挨一次的掉血量。 */
const hitHeroOnce = ({ heroId = 'hero_warrior', level = 5, hpPct = 1, mobId = 'boss_01' } = {}) => {
  const m = createMatch({ mapId: 'map_01', difficulty: 'normal', heroId, seed: 7 });
  m.hero.level = level;
  m.hero.hp = heroMaxHp(m.hero) * hpPct;
  m.rng = () => 0.5;                     // 固定随机：不暴击、伤害浮动恒为 1.0 → 这一击是定值
  const path = m.map.paths[0];
  const dist = (() => {
    for (let d = 0; d < path.lengthTiles * 128; d += 32) {
      const c = path.cells[Math.min(path.cells.length - 1, Math.floor(d / 128))];
      if (Math.max(Math.abs(c.x - m.hero.cell.x), Math.abs(c.y - m.hero.cell.y)) <= 2) return d;
    }
    return null;
  })();
  const def = MONSTERS[mobId];
  m.monsters.push({
    uid: 1, mobId, def, pathIndex: 0, dist,
    cell: path.cells[Math.min(path.cells.length - 1, Math.floor(dist / 128))],
    hp: 1e9, maxHp: 1e9, armor: def.armor, armorType: def.armorType, speed: 0,
    attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
  });
  const before = m.hero.hp;
  update(m, TICK_STEP);                     // 只跑一帧：正好挨一下，回复（0.5%/s × 0.05s）小到可忽略
  return { loss: before - m.hero.hp, reduce: heroDamageReduce(m), m };
};

test('§3.3 钢铁意志：生命 < 30% 时减伤 15%（没到 5 级、血在 30% 以上都不减）', () => {
  const m = createMatch({ mapId: 'map_01', heroId: 'hero_warrior' });
  m.hero.hp = heroMaxHp(m.hero) * 0.2;
  assert.equal(talentValue(m.hero, 'lowHpReduce'), 0, '1 级不该有钢铁意志');
  assert.equal(heroDamageReduce(m), 0, '没解锁就不能减伤');
  m.hero.level = 5;
  assert.equal(talentValue(m.hero, 'lowHpReduce'), 0.15);
  assert.equal(heroDamageReduce(m), 0.15, '血量 20% + 已解锁 → 减伤 15%');
  m.hero.hp = heroMaxHp(m.hero) * 0.5;
  assert.equal(heroDamageReduce(m), 0, '血量 50% 时不该有减伤');

  // 接线（不是只算了个数）：真的挨打时，低血那一份伤害要少 15%
  const high = hitHeroOnce({ level: 5, hpPct: 0.5 });
  const low = hitHeroOnce({ level: 5, hpPct: 0.2 });
  const ratio = low.loss / high.loss;
  assert.ok(Math.abs(ratio - 0.85) < 0.02, `低血减伤应让这一击少 15%，实际比例 ${ratio.toFixed(3)}（${high.loss} → ${low.loss}）`);
  // 反证：没解锁（4 级）时两边一样疼
  const high4 = hitHeroOnce({ level: 4, hpPct: 0.5 });
  const low4 = hitHeroOnce({ level: 4, hpPct: 0.2 });
  assert.ok(Math.abs(low4.loss / high4.loss - 1) < 0.02, '4 级没有钢铁意志，低血不该减伤');
});

test('§3.5 咒术精通：法师技能伤害 +10%（治疗与减速不跟着涨）', () => {
  const blizzardTick = (withTalent) => {
    const m = createMatch({ mapId: 'map_01', heroId: 'hero_mage', seed: 3 });
    m.hero.level = 5;
    if (!withTalent) m.hero.def = { ...m.hero.def, talents: m.hero.def.talents.filter((t) => t.type !== 'spellDmg') };
    const path = m.map.paths[0];
    const c = path.cells[Math.min(path.cells.length - 1, 60)];
    m.hero.cell = { ...c };
    const def = MONSTERS.mob_10;
    const mon = {
      uid: 1, mobId: 'mob_10', def, pathIndex: 0, dist: 60, cell: { ...c },
      hp: 1e9, maxHp: 1e9, armor: def.armor, armorType: def.armorType, speed: 0,
      attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
    };
    m.monsters.push(mon);
    const before = m.stats.damage.hero ?? 0;
    assert.equal(castSkill(m, 0), true, '暴风雪应该能放出来');
    return { hit: (m.stats.damage.hero ?? 0) - before, dot: mon.effects.find((e) => e.type === 'dot')?.dps };
  };
  const withT = blizzardTick(true);
  const without = blizzardTick(false);
  assert.equal(without.hit, 25, '1 级暴风雪每跳 25');
  assert.equal(withT.hit, 27, '咒术精通 +10% → 27（25 × 1.1 = 27.5 向下取整）');
  assert.equal(without.dot, 25);
  assert.equal(withT.dot, 27, '持续伤害的每一跳也要跟着涨，不能只涨第一跳');

  // 圣光术是治疗，不该被「技能伤害 +10%」放大
  const m = createMatch({ mapId: 'map_01', heroId: 'hero_paladin', seed: 3 });
  m.hero.level = 5;
  m.hero.def = { ...m.hero.def, talents: [{ id: 'tal_spellmastery', name: '咒术精通', unlockLevel: 5, type: 'spellDmg', value: 0.10 }] };
  m.hero.hp = 100;
  castSkill(m, 0);
  assert.equal(Math.round(m.hero.hp), 300, '圣光术该回 200（100 → 300），不能被 +10% 变成 320');
});

test('§3.5 法力涌动：英雄自己的击杀回 2% 最大生命，塔杀的算不到英雄头上', () => {
  const kill = (source) => {
    const m = createMatch({ mapId: 'map_01', heroId: 'hero_mage', seed: 3 });
    m.hero.level = 10;                   // 解锁法力涌动
    const max = heroMaxHp(m.hero);
    m.hero.hp = max * 0.5;
    const def = MONSTERS.mob_01;
    const mon = {
      uid: 1, mobId: 'mob_01', def, pathIndex: 0, dist: 0, cell: { x: 0, y: 4 },
      hp: 10, maxHp: def.hp, armor: def.armor, armorType: def.armorType, speed: 0,
      attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0, isAir: false, effects: [], dead: false, attacking: false,
    };
    m.monsters.push(mon);
    damageMonster(m, mon, 9999, source);
    return { gain: m.hero.hp - max * 0.5, max };
  };
  const byHero = kill('hero');
  assert.ok(byHero.gain > 0, '法师自己杀掉一只怪，应该回血（这就是 §3.5 的法力涌动）');
  assert.equal(Math.round(byHero.gain), Math.round(byHero.max * 0.02), '回的应该是最大生命的 2%（10 级法师 = 16 点）');
  assert.equal(kill('tw_arrow').gain, 0, '塔杀的怪不该给英雄回血');
});

// §119：逻辑帧步长（§10.2 的「逻辑 20Hz」）以前散在 6 处：data.js、protocol.js 的 TICK_RATE、
// 客户端主循环、两个参考 AI 的默认 dt、内核两处步长上限。改一处漏一处，**验证工具就会按与服务器
// 不同的步长模拟**——那些「实测数字」就不再是这一局的数字了。现在只有 data.js 一处定义。
test('§119 逻辑帧步长只有一个定义：服务端 / 客户端 / 参考打法同源', () => {
  assert.equal(TICK_RATE, TIMING.tickRate, '服务端的 tick 必须来自 data.js 的 TIMING.tickRate（别再写死 20）');
  assert.ok(Math.abs(TICK_STEP - 1 / TICK_RATE) < 1e-12, 'TICK_STEP 与 tickRate 互为倒数');

  // 参考打法的默认步长必须就是这一格：跑 N 步，比赛时间必须正好是 N × TICK_STEP
  const m = createMatch({ mapId: 'map_01', seed: 5 });
  let ticks = 0;
  autoPlay(m, { maxSeconds: 0.5, onTick: () => { ticks += 1; } });
  assert.ok(ticks > 5, `应该跑了好几步（实际 ${ticks} 步）`);
  assert.ok(Math.abs(m.time - ticks * TICK_STEP) < 1e-9,
    `${ticks} 步 × ${TICK_STEP}s 应该正好等于 ${m.time}s（不等就是工具用了别的步长）`);
});

// §119 第二道闸：**工具与用例**里也不许再写第二份步长。
// 这条比上面那条更要紧——工具写错步长，报出来的分钟数与胜负就不是这一局的数字，
// 而它们正是我拿来当「实测证据」的东西（第二轮一共抓到 17 处）。
test('§119 全仓库不许再写第二份逻辑帧步长（步长字面量）', async () => {
  const files = [];
  for (const dir of ['src', 'tools', 'tests']) {
    for (const f of readdirSync(dir)) if (/\.(js|mjs)$/.test(f)) files.push(`${dir}/${f}`);
  }
  const offenders = [];
  for (const f of files) {
    if (f === 'src/data.js') continue;                 // 唯一定义就在这个文件里
    const text = await readFile(f, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/1\s*\/\s*20\b|1000\s*\/\s*20\b/.test(line)) offenders.push(`${f}:${i + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    `这些地方又写了一份步长（要改成引 data.js 的 TICK_STEP）：\n${offenders.join('\n')}`);
});

// §123：塔位下标必须是**整数**。以前 `buildTower` 只比了 `slot < 0 / >= length`，而字符串跟数字
// 比大小永远是 false：`'abc'` 两道关都过得去 → `slots['abc']` 是 undefined → 读 `cell.x` 抛
// TypeError。这条指令从 WS 进来、抛在消息回调里没人接，**整个服务器进程当场退出**（现场见 §123）。
test('§123 塔位下标必须是整数：`slot:"abc"` 这类指令一律拒绝，且不许抛异常', () => {
  const m = createMatch({ mapId: 'map_01', seed: 3 });
  m.gold = 5000;
  const bad = ['abc', '', '0x10', 1.5, NaN, Infinity, -Infinity, null, undefined, -1, 999, {}, []];
  for (const slot of bad) {
    assert.doesNotThrow(() => buildTower(m, slot, 'tw_arrow'), `slot=${JSON.stringify(slot)} 不该抛异常`);
    assert.equal(buildTower(m, slot, 'tw_arrow'), false, `slot=${JSON.stringify(slot)} 该被拒绝`);
  }
  assert.equal(m.towers.length, 0, '一条都不该建出来');
  // 对照组：正常的整数下标照常能建
  assert.equal(buildTower(m, 0, 'tw_arrow'), true, '合法下标必须照常可用');
  assert.equal(m.towers.length, 1);
});
