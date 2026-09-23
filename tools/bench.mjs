// 容量实测：内核每秒能跑多少实体、每进程能开多少房间（§10.2 的容量口径）。
// 用法： node tools/bench.mjs [entities] [ticks]
import { buildTower, createMatch, update } from '../src/match.js';
import { MONSTERS, TICK_STEP } from '../src/data.js';
import { createSnapshotter } from '../src/protocol.js';

const ENTITIES = Number(process.argv[2] ?? 200);
const TICKS = Number(process.argv[3] ?? 600);   // 600 tick = 30 秒的对局时间
const TICK_MS = TICK_STEP * 1000;

const ids = Object.keys(MONSTERS);
const m = createMatch({ mapId: 'map_01', difficulty: 'normal', seed: 1 });
m.core.hp = 1e9;              // 不让核心被打爆，专注压实体
m.wave.timer = 0;

// 先把塔铺满（含不同塔型），让塔索敌 / 弹道 / 伤害结算都进入成本
const towerIds = ['tw_arrow', 'tw_cannon', 'tw_frost', 'tw_static'];
m.gold = 1e9;
for (let i = 0; i < m.map.slots.length; i++) buildTower(m, i, towerIds[i % towerIds.length]);

// 灌到目标实体数（模拟峰值战场）
for (let i = m.monsters.length; i < ENTITIES; i++) {
  const def = MONSTERS[ids[i % ids.length]];
  const pathIndex = i % m.map.paths.length;
  m.monsters.push({
    uid: 10000 + i, mobId: def.id, def, pathIndex, dist: (i * 7) % 6000,
    cell: m.map.paths[pathIndex].spawn, hp: def.hp, maxHp: def.hp,
    armor: def.armor, armorType: def.armorType, speed: 60, attack: def.attack,
    atkSpeed: def.atkSpeed, cooldown: 0, isAir: !!def.isAir, effects: [], dead: false, attacking: false,
  });
}

// 预热
for (let i = 0; i < 50; i++) {
  update(m, TICK_STEP);
  for (const mo of m.monsters) { mo.speed = 60; mo.hp = mo.maxHp; }
}

const snap = createSnapshotter();
let minAlive = Infinity;
const t0 = process.hrtime.bigint();
for (let i = 0; i < TICKS; i++) {
  update(m, TICK_STEP);
  // 让怪不死不掉队：否则后半程场上被清空，会测出一个乐观到失真的数
  for (const mo of m.monsters) { mo.speed = 60; mo.hp = mo.maxHp; }
  snap(m);                                       // 快照序列化也算进成本
  minAlive = Math.min(minAlive, m.monsters.length);
}
const t1 = process.hrtime.bigint();

const msPerTick = Number(t1 - t0) / 1e6 / TICKS;
const entityTicksPerSecond = (ENTITIES * 1000) / msPerTick;
const roomsPerCore = Math.floor((TICK_MS / msPerTick) * 0.7);   // 留 30% 余量给 GC 与网络
const cpuPerRoom = (msPerTick / TICK_MS * 100).toFixed(1);

console.log(`实体 ${ENTITIES} · tick ${TICKS}（模拟 ${(TICKS / 20).toFixed(0)} 秒对局）`);
console.log(`过程最低存活实体数：${minAlive === Infinity ? 0 : minAlive}（应接近 ${ENTITIES}，否则测的是空场）`);
console.log(`单 tick：${msPerTick.toFixed(2)} ms（含快照序列化；预算 ${TICK_MS.toFixed(0)} ms）`);
console.log(`内核吞吐：${(entityTicksPerSecond / 1000).toFixed(0)}k 实体·帧/秒`);
console.log(`单核可承载：约 ${roomsPerCore} 个 ${ENTITIES} 实体的房间（每房间占单核 ${cpuPerRoom}%）`);
console.log(`对照文档：§10.2 的「先按 10,000 实体/秒 起压」→ 实测 ${(entityTicksPerSecond / 1000).toFixed(0)}k，余量 ${(entityTicksPerSecond / 10000).toFixed(0)}×`);
// 空场 = 测出来的吞吐是假的（§110 的教训：带宽工具就退化成了「量一条空连接还报达标」）。
// 这里只印一句「应接近 200」不够——样本空了要**报错退出**，否则这个数会被人当结论引用。
if (minAlive < ENTITIES * 0.9) {
  console.error(`❌ 压测过程里场上最少只剩 ${minAlive} 个实体（目标 ${ENTITIES}）——这次测的是空场，吞吐数不可用`);
  process.exit(1);
}
process.exit(0);
