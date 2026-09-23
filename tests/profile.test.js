// M3 局外最小闭环：地图解锁、人物等级、初始金币加成、战绩记录。
import test from 'node:test';
import assert from 'node:assert/strict';

import { COMMANDER, DEFENSE_MAPS, MAPS } from '../src/data.js';
import {
  LEDGER_MAX, UNLOCK_SOURCES, commanderLevelOf, emptyProfile, isFirstRun, loadProfile, mapLocked,
  markTutorialDone, recordResult, saveProfile, startGoldOf, unlockSourceOf, unlockedMaps, unlocksOf,
  UNLOCK_SOURCE_LABEL, normalizeProfile, unlockedFallback,
} from '../src/profile.js';
import { createMatch } from '../src/match.js';
import { createDefenseMatch } from '../src/defense.js';
import { resultSummary } from '../src/result.js';

const win = (profile, mapId, difficulty = 'normal', timeSec = 480) =>
  recordResult(profile, { mapId, difficulty, result: 'win', timeSec, coreHp: 1200, leaks: 2 }).profile;

test('§2.2 地图解锁：初始只有 map_01，通关逐张放开，map_03 还要声望', () => {
  let p = emptyProfile();
  assert.deepEqual(unlockedMaps(p), ['map_01']);
  assert.equal(mapLocked(p, 'map_01'), null);
  assert.deepEqual(mapLocked(p, 'map_02'),
    { reason: 'clear', text: '通关「霜原哨站」', need: 'map_01', source: 'achievement' });

  p = win(p, 'map_01');
  assert.deepEqual(unlockedMaps(p).sort(), ['map_01', 'map_02']);

  p = win(p, 'map_02');
  assert.equal(mapLocked(p, 'map_03').reason, 'reputation', '前置图通了，卡在声望上');
  assert.ok(mapLocked(p, 'map_03').text.includes('500'));

  // 普通通关 120 声望/局：map_03 要 500，即「1 局 map_01 + 4 局 map_02」共 5 局
  p = win(p, 'map_02');   // 240
  p = win(p, 'map_02');   // 360
  assert.ok(p.reputation < 500, '第 3 局打完仍不够——门槛有实际阻力，不是走过场');
  p = win(p, 'map_02');   // 480
  p = win(p, 'map_02');   // 600 ✅
  assert.ok(p.reputation >= 500, `声望应攒到 500 以上，实际 ${p.reputation}`);
  assert.equal(mapLocked(p, 'map_03'), null);
  assert.deepEqual(unlockedMaps(p).sort(), ['map_01', 'map_02', 'map_03']);
});

test('§3.1 #29 深链进锁着的图：按档案归一化到已解锁的图，并说清楚换了哪张', () => {
  const fresh = emptyProfile();
  // 新档案只有 map_01：`?map=map_06` 这种深链（更彻底的是加了 skipstart）以前能直接开局
  const td = unlockedFallback(fresh, 'td', 'map_06');
  assert.equal(td.mapId, 'map_01', '锁着的图要被换成本模式已解锁的那张');
  assert.ok(td.notice.includes('还没解锁') && td.notice.includes('霜原哨站'), `提示要说清换成了哪张：${td.notice}`);
  assert.ok(td.notice.includes('通关'), '还要带上解锁条件（§1.7.3 的文案）');

  // 已解锁的图原样放行，而且**不该**有提示（没出事就别打扰玩家）
  assert.deepEqual(unlockedFallback(fresh, 'td', 'map_01'), { mapId: 'map_01', notice: null });

  // 防守是另一张表：TD 的 mapId 进防守模式要落回 def_01，不能把 map_01 当防守图
  const def = unlockedFallback(fresh, 'defense', 'map_01');
  assert.equal(def.mapId, 'def_01');

  // 归一是按**档案**算的：解锁了 map_03 之后就该放行它（门槛是活的，不是写死的白名单）
  let p = win(win(emptyProfile(), 'map_01'), 'map_02');   // map_02 解锁 map_03 的前置图
  assert.equal(unlockedFallback(p, 'td', 'map_03').mapId, 'map_01', '声望还不够 500，仍然换图');
  for (let i = 0; i < 4; i++) p = win(p, 'map_02');       // 攒够 500 声望
  assert.equal(unlockedFallback(p, 'td', 'map_03').mapId, 'map_03', '打够了就放行');
});

test('§3.6 人物等级与初始金币：只给便利不给战力', () => {
  assert.equal(commanderLevelOf(0), 1);
  assert.equal(commanderLevelOf(COMMANDER.expToNext(1)), 2);

  const p1 = emptyProfile();
  assert.equal(startGoldOf(p1), 200);
  const p11 = { ...emptyProfile(), commanderLevel: 11 };
  assert.equal(startGoldOf(p11), 220, '10 级加成 = +10%');
  const pMax = { ...emptyProfile(), commanderLevel: COMMANDER.maxLevel };
  assert.equal(startGoldOf(pMax), 258, '满级 30 → +29%');

  const m = createMatch({ mapId: 'map_01', startGold: startGoldOf(p11) });
  assert.equal(m.gold, 220, '内核按传入的初始金币开局');
});

test('战绩记录：最快通关 / 最高核心残血 / 局数 / 失败也给声望', () => {
  let p = emptyProfile();
  const first = recordResult(p, { mapId: 'map_01', difficulty: 'normal', result: 'win', timeSec: 600, coreHp: 900, leaks: 5 });
  p = first.profile;
  assert.equal(first.gain, 120);
  assert.equal(p.clears.map_01.bestTimeSec, 600);

  p = win(p, 'map_01', 'normal', 500); // 更快
  assert.equal(p.clears.map_01.bestTimeSec, 500, '更快的一次才覆盖');
  p = win(p, 'map_01', 'normal', 700); // 更慢
  assert.equal(p.clears.map_01.bestTimeSec, 500, '更慢的不覆盖');
  assert.equal(p.clears.map_01.wins, 3);

  const lose = recordResult(p, { mapId: 'map_01', difficulty: 'normal', result: 'lose', timeSec: 300, coreHp: 0, leaks: 40 });
  assert.equal(lose.gain, 30, '失败也给少量声望');
  assert.equal(lose.profile.clears.map_01.wins, 3, '失败不计入通关数');
});

// §12.3 / §12.6：防守模式的成绩是「守住几轮 + 城堡剩多少」，不是「多快通关」
test('§12.6 防守战绩记的是守住轮次（取最好的一次），TD 图不吃这个字段', () => {
  let p = emptyProfile();
  const def = (rounds, coreHp) => recordResult(p, {
    mapId: 'def_01', difficulty: 'normal', result: 'win', timeSec: 760, coreHp, leaks: 77, roundsCleared: rounds,
  });
  p = def(4, 2510).profile;
  assert.equal(p.clears.def_01.bestRounds, 4);
  assert.equal(p.clears.def_01.bestCoreHp, 2510);
  p = def(6, 1800).profile;   // 后面守住更多轮（无尽阶段也算）
  assert.equal(p.clears.def_01.bestRounds, 6, '守住更多轮才覆盖');
  p = def(3, 900).profile;    // 再打一局只守住 3 轮
  assert.equal(p.clears.def_01.bestRounds, 6, '更差的一局不该把记录冲掉');
  assert.equal(p.clears.def_01.bestCoreHp, 2510, '城堡剩血也是取最好');

  p = win(p, 'map_01');
  assert.equal(p.clears.map_01.bestRounds, 0, 'TD 局不带轮次（默认 0，不污染）');
  assert.equal(p.clears.map_01.bestTimeSec, 480);
});

test('人物等级提升会被识别出来（用于结算提示）', () => {
  let p = emptyProfile();
  let leveled = false;
  for (let i = 0; i < 8; i++) {
    const r = recordResult(p, { mapId: 'map_01', difficulty: 'hard', result: 'win', timeSec: 480, coreHp: 800, leaks: 1 });
    p = r.profile;
    leveled ||= r.leveledUp;
  }
  assert.ok(leveled, '连打若干局后应该升过级');
  assert.ok(p.commanderLevel > 1 && p.commanderLevel <= COMMANDER.maxLevel, `等级 ${p.commanderLevel} 应在 1-30`);
});

test('解锁条件与 data.js 的配置一致（别让 UI 和规则各写一份）', () => {
  assert.equal(MAPS.map_01.unlockCond, null);
  assert.deepEqual(MAPS.map_02.unlockCond, { clearMap: 'map_01', source: 'achievement' });
  assert.deepEqual(MAPS.map_03.unlockCond, { clearMap: 'map_02', reputation: 500, source: 'achievement' });
});

test('§1.7.3 预留一：每张图都有合法 unlock_source，免费内容不收钱', () => {
  for (const [id, def] of [...Object.entries(MAPS), ...Object.entries(DEFENSE_MAPS)]) {
    const src = def.unlockCond?.source ?? 'free';
    assert.ok(UNLOCK_SOURCES.includes(src), `${id} 的 source「${src}」不在枚举里`);
    // 免费期：一条 paid 都不该有（有的话说明有人在没接支付系统时就把它挂上了）
    assert.notEqual(src, 'paid', `${id} 标成了付费解锁，但免费期不该有任何付费内容`);
  }
  assert.equal(unlockSourceOf('map_01'), 'free', '默认解锁的是免费内容');
  assert.equal(unlockSourceOf('map_02'), 'achievement');
  // 解锁来源要跟着锁一起给到 UI（不然这个字段就是死数据）
  assert.equal(mapLocked(emptyProfile(), 'map_02').source, 'achievement');
  assert.deepEqual(unlocksOf(emptyProfile()).map((u) => `${u.id}:${u.unlocked ? '开' : '锁'}`),
    ['map_01:开', 'map_02:锁', 'map_03:锁', 'map_04:锁', 'map_05:锁', 'map_06:锁']);
});

// STATUS §3.1 #28（已拍板）：**def_03 的门槛要够得到**。原来写「守住 def_02 + 人物等级 20」——
// Lv20 要累计 24320 声望 ≈ 203 局普通通关（§159 量的），免费期里这张图等于进不去。
// 现在与 map_06 同量级：「守住 def_02 + 声望 1500」（普通通关 120 声望/局 → 约 13 局）。
test('§3.1 #28 def_03 的门槛够得到（声望 1500 ≈ 13 局，而不是等级 20 ≈ 203 局）', () => {
  const cond = DEFENSE_MAPS.def_03.unlockCond;
  assert.equal(cond.clearMap, 'def_02', '前置仍然是「先守住 def_02」');
  assert.equal(cond.commanderLevel, undefined, '不该再卡人物等级');
  assert.equal(cond.reputation, 1500, '改成与 map_06 同量级的声望门槛');
  const winRep = 120;   // §3.6：普通难度通关 +120 声望
  const games = Math.ceil(cond.reputation / winRep);
  assert.ok(games <= 20, `门槛不该超过 20 局（现在是 ${games} 局）`);
  // 对照组：老门槛要多少局——写在这儿，以后不用再算一遍
  assert.equal(Math.ceil(24320 / winRep), 203, 'Lv20 ≈ 203 局，这就是当初要改它的原因');
});

test('§1.7.3 预留二：声望与解锁都进流水账，且流水能对上账', () => {
  let p = emptyProfile();
  assert.deepEqual(p.ledger, [], '空档案没有流水');

  const r = recordResult(p, { mapId: 'map_01', difficulty: 'normal', result: 'win', timeSec: 480, coreHp: 900, leaks: 1 });
  p = r.profile;
  const rep = p.ledger.filter((x) => x.kind === 'reputation');
  assert.equal(rep.length, 1);
  assert.deepEqual([rep[0].delta, rep[0].source], [120, 'match_win'], '声望增长要有来源');
  // 这一局把 map_02 解锁了：解锁事件也要留一条，带 source
  const unlock = p.ledger.filter((x) => x.kind === 'unlock');
  assert.deepEqual(unlock.map((x) => `${x.id}:${x.source}`), ['map_02:achievement']);

  p = recordResult(p, { mapId: 'map_01', difficulty: 'normal', result: 'lose', timeSec: 300, coreHp: 0, leaks: 40 }).profile;
  assert.equal(p.ledger.at(-1).source, 'match_lose', '失败也记一条，来源不同');
  // 对账：流水里的声望增减之和 == 档案里的声望（将来查灰产就靠这条等式）
  const sum = p.ledger.filter((x) => x.kind === 'reputation').reduce((a, x) => a + x.delta, 0);
  assert.equal(sum, p.reputation, `流水合计 ${sum} 应等于声望 ${p.reputation}`);

  // 上限：连打 60 局不会把档案撑爆（超过 50 条就丢最老的）
  let q = emptyProfile();
  for (let i = 0; i < 60; i += 1) q = win(q, 'map_01');
  assert.equal(q.ledger.length, LEDGER_MAX);
  assert.ok(q.ledger.at(-1).t >= q.ledger[0].t, '留下的最新那一批，顺序没乱');
});

test('档案落盘：写进 localStorage 再读回来，解锁状态跟着生效（模拟「打完关掉再打开」）', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    // 第一局：打完 map_01 通关
    let p = loadProfile();
    assert.equal(p.reputation, 0, '首次进入是空档案');
    assert.deepEqual(unlockedMaps(p), ['map_01']);
    p = recordResult(p, { mapId: 'map_01', difficulty: 'normal', result: 'win', timeSec: 610, coreHp: 1100, leaks: 4 }).profile;
    assert.equal(saveProfile(p), true);

    // 关掉再打开：档案还在，map_02 解锁、最快通关记住了
    const reloaded = loadProfile();
    assert.equal(reloaded.reputation, 120);
    assert.equal(reloaded.clears.map_01.bestTimeSec, 610);
    assert.deepEqual(unlockedMaps(reloaded).sort(), ['map_01', 'map_02']);
    assert.equal(mapLocked(reloaded, 'map_02'), null);
    assert.equal(startGoldOf(reloaded), 200);
    // §1.7.3：流水账要跟着档案一起落盘（不然「打完关掉再打开」就丢了对账依据）
    assert.equal(reloaded.ledger.length, 2, '一条声望 + 一条解锁');
    assert.equal(reloaded.ledger[0].source, 'match_win');
    assert.equal(reloaded.ledger[1].source, 'achievement');
  } finally {
    delete globalThis.localStorage;
  }
});

// §153：新手引导的门槛。以前的口径是 `!tutorialDone && playCount === 0`，两个真问题：
// ① 新手第一局打**防守**（引导在防守里一步都推不动）→ 那一局让 playCount 变成 1 → 之后打 TD 再也不出现；
// ② 设置里「重看新手引导」（把 tutorialDone 抹掉）对任何打完过一局的玩家都无效。
// 现在口径只看 `tutorialDone`；「重看」就是把它置回 false，收尾再置回 true。
test('§153 新手引导的门槛：没做过就要出现，做过就不出现，「重看」要真的能再看一次', () => {
  const fresh = emptyProfile();
  assert.equal(isFirstRun(fresh), true, '全新档案：下次开局要挂引导');

  // 打完一局（playCount 变成 1）但引导一次都没做过——比如第一局打的是防守
  const played = { ...win(fresh, 'map_01'), tutorialDone: false };
  assert.equal(played.playCount, 1);
  assert.equal(isFirstRun(played), true, '没做过引导就该出现（以前 playCount 一涨就再也不出现）');

  const done = markTutorialDone(played);
  assert.equal(done.tutorialDone, true);
  assert.equal(isFirstRun(done), false, '做过引导就不再自动出现');

  // 设置里点「重看新手引导」= 把「已看过」抹掉 → 下次开局真的要再挂一次
  const replay = { ...done, tutorialDone: false };
  assert.equal(isFirstRun(replay), true, '点了「重看」→ 下次开局真的要再挂一次');
  assert.equal(isFirstRun(markTutorialDone(replay)), false, '重看再看一次之后就不再自动出现（否则每局都挂）');
});

// §12.6 那条规则防的是一种典型崩盘：在防守里刷局内金币，再想办法带进 TD 套利，
// 于是两个模式的难度设计同时失效。它的可执行形式就是——**档案里只许有账号级资产**。
test('§12.6 局内资源绝不跨局跨模式：档案里只有账号级资产，声望才跨模式累计', () => {
  const ACCOUNT = ['v', 'reputation', 'exp', 'commanderLevel', 'clears', 'playCount', 'tutorialDone', 'lastChoice', 'ledger'];
  assert.deepEqual(Object.keys(emptyProfile()).sort(), [...ACCOUNT].sort(),
    '档案字段 = §12.6 列「✅ 共享」的那几项；加字段等于决定它是不是账号级');
  for (const k of ['gold', 'lumber', 'bag', 'inventory', 'equipped', 'items', 'scrolls', 'shopBought']) {
    assert.ok(!(k in emptyProfile()), `局内资源 ${k} 不该出现在局外档案里（§12.6）`);
  }

  let p = emptyProfile();
  p = win(p, 'map_01');
  const afterTd = p.reputation;
  assert.equal(afterTd, 120);
  p = win(p, 'def_01');   // 防守通关也走同一个 recordResult
  assert.equal(p.reputation, afterTd + 120, '声望是两个模式共用的账号级货币');
  assert.deepEqual(Object.keys(p).sort(), [...ACCOUNT].sort(), '打了两局也不该多出局内字段');
  assert.deepEqual(p.clears.map_01.wins, 1);
  assert.deepEqual(p.clears.def_01.wins, 1, '两个模式的战绩各记各的');
  assert.deepEqual(p.ledger.filter((x) => x.kind === 'reputation').map((x) => x.mapId), ['map_01', 'def_01'],
    '流水能看出每一笔来自哪个模式');
});

test('结算提取：两种模式各自取对数（防守通关曾因为读 TD 的 core.hp 把界面冻住）', () => {
  const td = createMatch({ mapId: 'map_01' });
  td.result = 'win';
  td.core.hp = 1234;
  td.stats.leaks = 5;
  const a = resultSummary(td);
  assert.equal(a.mode, 'td');
  assert.equal(a.coreHp, 1234);
  assert.equal(a.leaks, 5);

  const def = createDefenseMatch({ mapId: 'def_01' });
  def.result = 'win';
  def.castle.hp = 2345;
  def.stats.castleHits = 77;
  def.stats.roundsCleared = 4;
  const b = resultSummary(def);
  assert.equal(b.mode, 'defense');
  assert.equal(b.coreHp, 2345, '防守模式取城堡血量');
  assert.equal(b.leaks, 77, '防守模式用城堡挨打次数当压力指标');
  assert.equal(b.roundsCleared, 4);
  assert.ok(!('core' in def), '前置：防守局确实没有 TD 的 core');

  assert.equal(resultSummary({ result: null }), null, '没结束就没有结算');
});

// §128：设计附录清单里那条「**免费期上线前：除激励视频外，没有任何付费入口或付费引导**
// （包括「即将开放」的灰色按钮）」——原型里已经成立，但它是一条**很容易被后来者破坏**的约束
// （加个「¥12 解锁」按钮就破了），所以钉一条会失败的检查。
test('§128 免费期：代码里没有任何付费入口/付费引导（`paid` 枚举留着，但一条数据都没用）', async () => {
  const { readFile } = await import('node:fs/promises');

  // ① 没有任何地图靠付费解锁（设计表里 4★/6★ 写着「+ 地图包 ¥6 / ¥12」，那是**产品期**的事，
  //    原型按 §10.4「付费期才接，首发不接」只实现成就算解锁）
  for (const id of [...Object.keys(MAPS), ...Object.keys(DEFENSE_MAPS)]) {
    assert.notEqual(unlockSourceOf(id), 'paid', `${id} 不许用付费解锁（免费期）`);
  }
  // ② 枚举本身要留着：将来接支付是「改数据表」，不是改解锁判断的代码
  assert.equal(UNLOCK_SOURCE_LABEL.paid, '付费');

  // ③ 界面与代码里不许出现人民币符号 / 支付 SDK 调用
  const src = ['core', 'data', 'defense', 'hud-model', 'main', 'match', 'net', 'profile', 'protocol',
    'render', 'result', 'save', 'settings', 'ui', 'ai', 'ai-defense', 'audio', 'feedback', 'joystick', 'predict', 'tutorial'];
  const hits = [];
  for (const rel of ['../index.html', ...src.map((f) => `../src/${f}.js`)]) {
    const text = await readFile(new URL(rel, import.meta.url), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/¥|requestMidasPayment|requestPayment|midas/i.test(line)) hits.push(`${rel}:${i + 1} ${line.trim().slice(0, 60)}`);
    });
  }
  assert.deepEqual(hits, [], `免费期不许出现付费入口：\n${hits.join('\n')}`);
});

// §205：**档案是跨界数据**（localStorage）——形状坏了不许把大厅弄死。
// 实测（真浏览器）：`clears: null` → 模块顶层 `TypeError: Cannot read properties of null (reading 'map_01')`
// → 页面只剩 static HTML、按钮全没接线（§177 那个形状，触发源换成档案）。
// `settings.js` 早就做过这件事（`normalizeSettings`），档案这一半一直裸着。
test('§205 档案形状归一化：坏字段不许进 UI（`clears: null` / 记录是 null / ledger 不是数组…）', () => {
  const bad = normalizeProfile({
    v: 1, reputation: 'abc', exp: null, commanderLevel: 0, playCount: 'x', tutorialDone: 'yes',
    clears: { map_01: null, map_02: { wins: 'x', clears: 2, bestTimeSec: 'fast', leaks: null }, map_03: { wins: 1, clears: 1 } },
    ledger: 'not-an-array', lastChoice: 42,
  });
  assert.equal(bad.reputation, 0, '不是有限数就回默认');
  assert.equal(bad.exp, 0);
  assert.equal(bad.commanderLevel, 1, '人物等级至少 1');
  assert.equal(bad.playCount, 0);
  assert.equal(bad.tutorialDone, false, '不是 true 就当没做过（字符串 "yes" 不算做过）');
  assert.deepEqual(Object.keys(bad.clears).sort(), ['map_02', 'map_03'], '坏记录丢掉，好记录留下');
  assert.deepEqual(bad.clears.map_02, { clears: 2, wins: 0, bestTimeSec: null, bestCoreHp: 0, leaks: 0, bestRounds: 0 });
  assert.deepEqual(bad.ledger, []);
  assert.equal(bad.lastChoice, null);
  // 反向：正常档案原样通过（别把玩家的进度洗掉），未知字段要留着（前向兼容）
  const good = { ...emptyProfile(), reputation: 300, clears: { map_01: { clears: 2, wins: 1, bestTimeSec: 500, bestCoreHp: 800, leaks: 3, bestRounds: 0 } }, extraFromFuture: { a: 1 } };
  const kept = normalizeProfile(good);
  assert.equal(kept.reputation, 300);
  assert.deepEqual(kept.clears.map_01, good.clears.map_01);
  assert.deepEqual(kept.extraFromFuture, { a: 1 }, '不认识的字段要原样留着');
  // 压根不是对象（数组 / 字符串 / null）：给一份空档案，不许抛
  for (const junk of [null, undefined, 42, 'x', []]) assert.deepEqual(normalizeProfile(junk), emptyProfile());
});
