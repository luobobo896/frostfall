// 全组合浸泡验证：把「地图 × 难度 × 英雄 × 时长档 × 人数」与防守模式全部跑一遍，
// **每一步都查运行期不变量**，而不是只看最后赢没赢。
//
// 为什么需要它：单个用例只覆盖它自己那张图那种打法，而「NaN 从某个只有长局会走的
// 分支漏进来」「某张图某英雄会卡住不结束」这类问题，只有在全组合里才暴露得出来。
// 用法： node tools/soak.mjs [--seconds=每局上限秒] [--quiet]

import { DIFFICULTY, HEROES, MAPS, MONSTERS, TICK_STEP } from '../src/data.js';
import { createMatch, describe, update } from '../src/match.js';
import { gridDist } from '../src/core.js';
import { createDefenseMatch, describeDefense, updateDefense } from '../src/defense.js';
import { autoPlay } from '../src/ai.js';
import { autoPlayDefense } from '../src/ai-defense.js';
import { deserializeMatch, serializeMatch } from '../src/save.js';
import {
  applyDefenseShared, applyPrivate, applyShared, createDefenseSnapshotter, createSnapshotter, privateSnapshot,
} from '../src/protocol.js';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const capArg = args.find((a) => a.startsWith('--seconds='));
const CAP = capArg ? Number(capArg.split('=')[1]) : 0;   // 0 = 用每档自己的上限

const issues = [];
const note = (where, what, detail = '') => {
  issues.push(`${where} · ${what}${detail ? ` · ${detail}` : ''}`);
  if (!quiet) console.log(`❌ ${where} · ${what}${detail ? ` · ${detail}` : ''}`);
};

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/** 一条通用的运行期不变量检查（TD 与防守共用） */
const checkState = (where, m) => {
  const grid = m.grid ?? m.map?.grid;   // 防守局把网格放在 m.grid，TD 放在 m.map.grid
  if (!finite(m.time) || m.time < 0) note(where, 'time 非法', String(m.time));
  if (!finite(m.gold) || m.gold < 0) note(where, 'gold 非法', String(m.gold));
  // §167：这几项以前没查——它们坏了都不会当场红，但都是「玩家看得见」的：
  // 木材是个人资源（`spend` 扣、赏金加），经验只涨不降，波次号一旦越过波次表，
  // 「第 N / 12 波」与「下一波预告」就一起失真（§163 那类）。
  for (const [i, v] of (m.lumber ?? []).entries()) {
    if (!finite(v) || v < 0) note(where, `木材[${i}] 非法`, String(v));
  }
  if (!finite(m.hero.exp) || m.hero.exp < 0) note(where, '英雄经验非法', String(m.hero.exp));
  if (m.wave && (!finite(m.wave.index) || m.wave.index < 0
    || (m.waves && m.wave.index > m.waves.length))) {
    note(where, '波次号越界', `${m.wave.index} / ${m.waves?.length ?? '?'}`);
  }
  if (m.assault && (!finite(m.assault.round) || m.assault.round < 0)) {
    note(where, '防守轮次非法', String(m.assault.round));
  }
  if (!finite(m.hero.hp) || m.hero.hp < 0) note(where, '英雄 hp 非法', String(m.hero.hp));
  if (!finite(m.hero.level) || m.hero.level < 1) note(where, '英雄等级非法', String(m.hero.level));
  for (const c of (m.cores ?? (m.core ? [m.core] : []))) {   // 防守局没有「核心」，只有城堡
    if (!finite(c.hp) || c.hp < 0) note(where, '核心 hp 非法', String(c.hp));
  }
  if (m.castle) {
    if (!finite(m.castle.hp) || m.castle.hp < 0) note(where, '城堡 hp 非法', String(m.castle.hp));
  }
  const uids = new Set();
  for (const mo of m.monsters) {
    if (mo.dead) continue;
    if (!finite(mo.hp) || mo.hp <= 0) note(where, '怪物 hp 非法', `${mo.mobId} ${mo.hp}`);
    if (uids.has(mo.uid)) note(where, '怪物 uid 重复', String(mo.uid));
    uids.add(mo.uid);
    const cell = mo.cell ?? null;
    if (!cell || !finite(cell.x) || !finite(cell.y)) note(where, '怪物坐标非法', `${mo.mobId} ${JSON.stringify(cell)}`);
    else if (grid && (cell.x < 0 || cell.y < 0 || cell.x >= grid.w || cell.y >= grid.h)) {
      note(where, '怪物跑出地图', `${mo.mobId} (${cell.x},${cell.y})`);
    }
    // 防守模式的野怪没有 dist（它们走 path），只查 TD 那种沿路径推进的
    if (mo.dist !== undefined && (!finite(mo.dist) || mo.dist < 0)) note(where, '怪物 dist 非法', `${mo.mobId} ${mo.dist}`);
    // 进攻怪必须有路可走：`path` 空着就是「永远走不到城堡」，本轮永远清不掉（§65 的那个 bug）
    if (mo.kind === 'assault' && m.castle && gridDist(mo.cell, m.castle.cell) > 1 && !(mo.path ?? []).length && m.time - (mo.pathAt ?? 0) > 2) {
      note(where, '进攻怪卡住（没有路径）', `${mo.mobId} (${mo.cell.x},${mo.cell.y})`);
    }
  }
  for (const t of (m.towers ?? [])) {
    if (!finite(t.cooldown) || t.cooldown < 0) note(where, '塔冷却非法', String(t.cooldown));
    if (!finite(t.hp) || t.hp < 0) note(where, '塔 hp 非法', String(t.hp));
    if (t.slot == null || t.slot < 0) note(where, '塔位非法', String(t.slot));
  }
  for (const f of (m.forts ?? [])) {   // 防守模式：基地工事
    if (!finite(f.hp) || f.hp < 0) note(where, '工事 hp 非法', String(f.hp));
    if (!finite(f.cooldown ?? 0) || (f.cooldown ?? 0) < 0) note(where, '工事冷却非法', String(f.cooldown));
    if (f.slot == null || f.slot < 0) note(where, '工事位非法', String(f.slot));
  }
  // 掉落物坐标（防守模式才有）：NaN/出图会让「自动拾取」永远走不到它
  for (const it of (m.groundItems ?? [])) {
    const c = it.cell;
    if (!c || !finite(c.x) || !finite(c.y)) note(where, '掉落物坐标非法', JSON.stringify(c));
    else if (grid && (c.x < 0 || c.y < 0 || c.x >= grid.w || c.y >= grid.h)) {
      note(where, '掉落物掉出地图', `(${c.x},${c.y})`);
    }
  }
  const slots = (m.towers ?? m.forts ?? []).map((t) => t.slot);
  if (new Set(slots).size !== slots.length) note(where, '同一个塔位建了两座塔', slots.join('/'));
  if (m.hero.cell && (!finite(m.hero.cell.x) || !finite(m.hero.cell.y))) note(where, '英雄坐标非法', JSON.stringify(m.hero.cell));
  if (grid && m.hero.cell && (m.hero.cell.x < 0 || m.hero.cell.y < 0 || m.hero.cell.x >= grid.w || m.hero.cell.y >= grid.h)) {
    note(where, '英雄跑出地图', `(${m.hero.cell.x},${m.hero.cell.y})`);
  }
};

const rows = [];
let runs = 0;

/**
 * 存档往返：**「存档 → 读档 → 再存档」必须是不动点**（两份存档逐字段一致）。
 * 为什么放在浸泡里：每加一个局内字段都得记着同步存档，漏一个的表现是「读档后那件事悄悄没了」——
 * 这种错单测很难覆盖全（§65 之后加过 reviveMul / scrolls / shopCast / cores，一次就漏了四个）。
 * 为什么比「两份存档」而不是「存档 vs 活对象」：活对象里有大量**故意不存**的瞬时状态
 * （半空弹道、英雄攻击冷却、每帧重算的 buff 引用、塔的 uid 重建…），拿它比会满屏假红；
 * 而存档器本身已经把「该存什么」定死了，读档只要不丢东西，再存一遍就该一模一样。
 */
const checkRoundTrip = (where, m) => {
  const s1 = JSON.parse(JSON.stringify(serializeMatch(m)));
  const back = deserializeMatch(s1);
  if (!back) { note(where, '存档读不回来'); return; }
  const s2 = JSON.parse(JSON.stringify(serializeMatch(back)));
  for (const k of Object.keys(s1)) {
    if (k === 'savedAt') continue;   // 时间戳本来就每次不同
    if (JSON.stringify(s1[k]) !== JSON.stringify(s2[k])) {
      note(where, `存档不是不动点：${k}`,
        `存 ${JSON.stringify(s1[k]).slice(0, 36)} → 读回再存 ${JSON.stringify(s2[k]).slice(0, 36)}`);
    }
  }
  // 另一半：**新加的局内字段必须进存档**。活对象里的每个顶层字段（除了下面这些刻意不存的）
  // 都必须在存档里有同名的一份——否则就是「加了字段忘了同步存档」，读档后那件事会悄悄消失。
  for (const k of Object.keys(m)) {
    if (TRANSIENT_KEYS.has(k)) continue;
    if (!(k in s1)) note(where, `新字段没进存档：${k}`, `值 ${String(JSON.stringify(m[k]) ?? m[k]).slice(0, 40)}`);
  }
};

/** 刻意不进存档的东西：派生数据、每帧重算的引用、以及「半空弹道/滚动日志」这类有意丢弃的状态 */
const TRANSIENT_KEYS = new Set([
  'map', 'diff', 'waves', 'scale', 'bountyMul',   // 由 mapId / difficulty / players / length 重建
  'projectiles', 'events',                        // 半空弹道丢弃、日志只留末尾几条
  'onMonsterKilled',                              // 函数，读档后重建
  'walls',                                        // 防守：由「静态基地 + 自建围墙」重建，读档时会重新加
  'shopBlocked',                                  // 模式常量（塔防禁售卷轴），createMatch 建局时写死
  'def', 'grid', 'isBlocked',                     // 防守：地图定义与寻路闭包，由 mapId 重建
  'shopNear',                                     // §3.1 #14：防守商店的位置（基地中心 + 半径），由地图定义重建
]);

/**
 * 镜像一致性：服务端算出来的状态，客户端靠快照能不能看到同一份？
 * 查的是**客户端真正会读的那些字段**（血条、金币、塔、怪、背包、卷轴、结果…）。
 * 这类 bug 的表现是「服务端知道、客户端永远显示旧的」——比如 §55 的卷轴没进私人快照时，
 * 联机防守里回城按钮永远点不亮（见验证记录 §68）。
 */
const checkMirror = (where, m, makeMirror, mode) => {
  const mirror = makeMirror();
  const shared = mode === 'defense'
    ? createDefenseSnapshotter()(m, { full: true })
    : createSnapshotter()(m, { full: true });
  if (mode === 'defense') applyDefenseShared(mirror, shared);
  else applyShared(mirror, shared);
  applyPrivate(mirror, privateSnapshot(m, 0));

  const num = (label, a, b) => { if (Math.abs(a - b) > 0.51) note(where, `镜像不一致：${label}`, `${a} vs ${b}`); };
  const str = (label, a, b) => { if (String(a) !== String(b)) note(where, `镜像不一致：${label}`, `${String(a).slice(0, 40)} vs ${String(b).slice(0, 40)}`); };
  num('对局时间', +m.time.toFixed(1), +mirror.time.toFixed(1));
  num('金币', Math.round(m.gold), Math.round(mirror.gold));
  num('核心 1 血量', Math.round(m.core?.hp ?? m.castle?.hp ?? 0), Math.round(mirror.core?.hp ?? mirror.castle?.hp ?? 0));
  (m.cores ?? []).forEach((c, i) => num(`核心 ${i + 1} 血量`, Math.round(c.hp), Math.round(mirror.cores?.[i]?.hp ?? -1)));
  num('波次', m.wave?.index ?? 0, mirror.wave?.index ?? 0);
  num('英雄等级', m.hero.level, mirror.hero.level);
  num('英雄血量', Math.round(m.hero.hp), Math.round(mirror.hero.hp));
  str('塔阵', (m.towers ?? []).map((t) => `${t.slot}:${t.towerId}:${t.level}`).join(','),
    (mirror.towers ?? []).map((t) => `${t.slot}:${t.towerId}:${t.level}`).join(','));
  str('怪物 uid', m.monsters.filter((x) => !x.dead).map((x) => x.uid).sort((a, b) => a - b).join(','),
    mirror.monsters.map((x) => x.uid).sort((a, b) => a - b).join(','));
  str('个人木材', m.lumber[0] ?? 0, mirror.lumber[0] ?? 0);
  str('背包', JSON.stringify(m.bag ?? {}), JSON.stringify(mirror.bag ?? {}));
  num('回城卷轴', m.scrolls ?? 0, mirror.scrolls ?? 0);
  str('结果', m.result ?? '', mirror.result ?? '');
  if (mode === 'defense') {
    num('城堡血量', Math.round(m.castle.hp), Math.round(mirror.castle.hp));
    str('工事位', (m.forts ?? []).map((f) => f.slot).join(','), (mirror.forts ?? []).map((f) => f.slot).join(','));
    num('守住轮次', m.stats.roundsCleared, mirror.stats.roundsCleared);
  }
};

const runTd = ({ mapId, difficulty, heroId, length, players }) => {
  const where = `TD ${mapId} ${difficulty} ${heroId} ${length} ${players}人`;
  const maxSeconds = (length === 'long' ? 3600 : 1800) * 2;
  const m = createMatch({ mapId, difficulty, heroId, length, players, seed: 11 });
  let lastTrip = 0;
  autoPlay(m, {
    maxSeconds: CAP || maxSeconds,
    onTick: (mm) => {
      if (mm.time % 20 < TICK_STEP) checkState(where, mm);
      if (mm.time - lastTrip >= 60 && mm.wave.index > 1) { lastTrip = mm.time; checkRoundTrip(where, mm); }
    },
  });
  checkState(where, m);
  checkRoundTrip(where, m);
  checkMirror(where, m, () => createMatch({ mapId, difficulty, heroId, length, players, seed: 11 }), 'td');
  runs += 1;
  const d = describe(m);
  if (!m.result) note(where, '跑满上限还没结束', `第 ${d.wave} 波 / ${(d.time / 60).toFixed(1)} 分钟`);
  rows.push({ where, result: d.result ?? '未结束', min: (d.time / 60).toFixed(1), leaks: d.leaks, lv: d.heroLevel });
};

const runDefense = ({ mapId, difficulty, heroId }) => {
  const where = `防守 ${mapId} ${difficulty} ${heroId}`;
  const m = createDefenseMatch({ mapId, difficulty, heroId, seed: 11 });
  let lastTrip = 0;
  autoPlayDefense(m, {
    maxSeconds: CAP || 1800,
    onTick: (mm) => {
      if (mm.time % 20 < TICK_STEP) checkState(where, mm);
      if (mm.time - lastTrip >= 60 && mm.assault.round > 0) { lastTrip = mm.time; checkRoundTrip(where, mm); }
    },
  });
  checkState(where, m);
  checkRoundTrip(where, m);
  checkMirror(where, m, () => createDefenseMatch({ mapId, difficulty, heroId, seed: 11 }), 'defense');
  runs += 1;
  const d = describeDefense(m);
  if (!m.result && !m.over) note(where, '跑满上限还没结束', `${d.round} 轮 / ${(d.time / 60).toFixed(1)} 分钟`);
  rows.push({ where, result: d.result ?? '未结束', min: (d.time / 60).toFixed(1), leaks: d.roundsCleared, lv: d.heroLevel });
};

for (const mapId of Object.keys(MAPS)) {
  const length = (MAPS[mapId].stars ?? 1) >= 4 ? 'long' : 'short';
  for (const difficulty of Object.keys(DIFFICULTY)) {
    for (const heroId of Object.keys(HEROES)) {
      runTd({ mapId, difficulty, heroId, length, players: 4 });
      runTd({ mapId, difficulty, heroId, length, players: 1 });
    }
  }
}
for (const mapId of ['def_01', 'def_02', 'def_03']) {
  for (const difficulty of Object.keys(DIFFICULTY)) {
    for (const heroId of Object.keys(HEROES)) runDefense({ mapId, difficulty, heroId });
  }
}

if (!quiet) {
  const byResult = rows.reduce((acc, r) => { acc[r.result] = (acc[r.result] ?? 0) + 1; return acc; }, {});
  console.log(`\n全组合浸泡：${runs} 局 · 结果分布 ${JSON.stringify(byResult)}`);
  console.log(`怪物表共 ${Object.keys(MONSTERS).length} 种 · 地图 ${Object.keys(MAPS).length} 张 TD + 3 张防守 · 难度 ${Object.keys(DIFFICULTY).length} 档 · 英雄 ${Object.keys(HEROES).length} 个`);
}
console.log(issues.length ? `\n❌ ${issues.length} 处不变量被破坏：\n${issues.slice(0, 20).join('\n')}` : `\n✅ ${runs} 局全部跑完，运行期不变量一条没破`);
process.exit(issues.length ? 1 : 0);
