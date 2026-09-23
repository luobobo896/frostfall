// 联机验收：服务端权威房间 + 两个客户端（含真实 WebSocket 握手与帧编解码）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect as tcpConnect } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';

import { createGameServer } from '../src/server/game-server.js';
import { applyPrivate, applyShared, COMMANDS, FORT_IDS, MOB_IDS, PRIORITY_IDS, PROTOCOL_VERSION, TOWER_IDS } from '../src/protocol.js';
import { clientFrame } from '../src/server/ws.js';
import { buildTower, createMatch, update } from '../src/match.js';
import { resultPanelModel } from '../src/hud-model.js';
import { MONSTERS, TICK_STEP } from '../src/data.js';

globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };
// §3.1 #24：`net.js` 在模块加载时就读 localStorage 拿「uid + token」这一对；
// node 里没有它，补一个最小的（不然身份那一对永远是「没 token」那种，测不出换身份）。
globalThis.localStorage = globalThis.localStorage ?? (() => {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
})();

/** 极简 WS 客户端：握手 + 文本帧收发（与浏览器走同一套协议）。 */
function wsClient(port, path, version = PROTOCOL_VERSION) {
  return new Promise((resolve, reject) => {
    // §157：失败路径必须**自己把 socket 收掉**——不收的话这条连接还是活着的，node --test 的
    // worker 会一直等它，于是整套用例跑完之后进程不退出（外面看起来就是 `npm test` 永远不返回）。
    const handshakeTimer = setTimeout(() => { socket.destroy(); reject(new Error('握手超时')); }, 3000);
    // §120：服务端要校验协议版本（§10.5）。默认带上当前版本；传别的值就能造出「旧客户端」。
    path = `${path}${path.includes('?') ? '&' : '?'}v=${version}`;
    // 请求行必须是 ASCII：含中文的名字要百分号编码（浏览器会自动做，手写客户端得自己来）
    const safePath = path.replace(/[^\x20-\x7E]/g, (ch) => encodeURIComponent(ch));
    const socket = tcpConnect(port, '127.0.0.1', () => {
      const key = randomBytes(16).toString('base64');
      socket.write([
        `GET ${safePath} HTTP/1.1`, 'Host: 127.0.0.1', 'Upgrade: websocket',
        'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
      ].join('\r\n'));
    });
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    let bytes = 0;
    const messages = [];
    const waiters = [];

    socket.on('data', (chunk) => {
      bytes += chunk.length;
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaken) {
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buffer.subarray(0, idx).toString();
        // §150：握手的坏回复要带上**端口**——只写「HTTP/1.1 404 Not Found」看不出它到底有没有连到我们
        // 刚起的那个服务器（整包并发跑时偶发过一次 404，见验证记录 §150）。带上端口下次就能判定。
        if (!/101/.test(head)) {
          clearTimeout(handshakeTimer);
          socket.destroy();
          reject(new Error(`握手失败（端口 ${port}）: ${head.split('\r\n')[0]}`));
          return;
        }
        handshaken = true;
        clearTimeout(handshakeTimer);
        buffer = buffer.subarray(idx + 4);
        resolve(client);
      }
      for (;;) {
        const frame = readServerFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode !== 0x1) continue;
        const text = frame.payload.toString('utf8');
        messages.push(text);
        // 只移除「已满足」的等待者：早期版本每次消息都清空等待队列，导致慢条件永远等不到
        for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]()) waiters.splice(i, 1);
      }
    });
    socket.on('error', (err) => { socket.destroy(); reject(err); });
    // 对端关了就把自己这条也收干净：半开口的 socket 会让 node --test 的 worker 永远不退出
    // （值守时踩到过一次：整套用例跑完，进程挂在那儿 8 小时没退）
    socket.on('end', () => socket.destroy());
    socket.on('close', () => socket.destroy());

    const client = {
      socket,
      messages,
      get bytes() { return bytes; },
      send: (obj) => socket.write(clientFrame(JSON.stringify(obj))),
      /** 等到满足条件的消息出现（或超时）。 */
      waitFor: (predicate, timeoutMs = 3000, label = '') => new Promise((res, rej) => {
        const check = () => {
          const hit = messages.map((t) => JSON.parse(t)).find(predicate);
          if (hit) { res(hit); return true; }
          return false;
        };
        if (check()) return;
        const timer = setTimeout(() => {
          const kinds = messages.map((t) => JSON.parse(t).t);
          const lastTypes = kinds.slice(-6).join(',');
          const towerCounts = messages.map((t) => JSON.parse(t)).filter((m) => m.t === 'snap').map((m) => (m.s.tw ?? []).length);
          rej(new Error(`等待消息超时${label ? `：${label}` : ''}（收到 ${messages.length} 条，最近 ${lastTypes}；snap 塔数序列 ${towerCounts.join('/').slice(-40)}）`));
        }, timeoutMs);
        waiters.push(() => {
          if (!check()) return false;
          clearTimeout(timer);
          return true;
        });
      }),
      close: () => socket.destroy(),
    };
  });
}

function readServerFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f, offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  if (buf.length < offset + len) return null;
  return { opcode, payload: buf.subarray(offset, offset + len), consumed: offset + len };
}

test('联机：建房 → 两个客户端收到同一份权威快照 → 一人建塔两人都看得到', { timeout: 15000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const a = await wsClient(port, '/ws?name=甲方&uid=ua&map=map_01&hero=hero_warrior');
  const helloA = await a.waitFor((m) => m.t === 'hello', 3000, '甲方 hello');
  assert.ok(helloA.roomCode, '应返回 6 位房间码');
  assert.equal(helloA.roomCode.length, 6);
  assert.equal(helloA.playerId, 'ua', '玩家 id 用 uid 表示（重连要认人）');
  assert.ok(helloA.s.gold === 200, '初始金币 200（§8.4）');

  const b = await wsClient(port, `/ws?room=${helloA.roomCode}&name=乙方&uid=ub`);
  const helloB = await b.waitFor((m) => m.t === 'hello', 3000, '乙方 hello');
  assert.equal(helloB.playerId, 'ub');
  assert.equal(helloB.roomCode, helloA.roomCode, '同一房间码应进入同一房间');

  // 甲方建一座箭塔，服务端校验通过后，双方的快照里都应出现
  a.send({ t: 'build', slot: 0, towerId: 'tw_arrow' });
  const snapA = await a.waitFor((m) => m.t === 'snap' && (m.s.tw ?? []).length === 1, 3000, '甲方看到塔');
  const snapB = await b.waitFor((m) => m.t === 'snap' && (m.s.tw ?? []).length === 1, 3000, '乙方看到塔');
  assert.equal(TOWER_IDS[snapA.s.tw[0][1]], 'tw_arrow');
  assert.equal(TOWER_IDS[snapB.s.tw[0][1]], 'tw_arrow');
  assert.equal(snapA.s.gold, 140, '200 - 60');
  assert.equal(snapA.s.tw[0][5], 0, '甲方建塔 → 归属槽位 0（渲染时上队伍色）');

  // 乙方再建一座，归属应是槽位 1：队伍色靠这个字段区分
  b.send({ t: 'build', slot: 2, towerId: 'tw_arrow' });
  const snapB2 = await b.waitFor((m) => m.t === 'snap' && (m.s.tw ?? []).length === 2, 3000, '乙方建塔');
  const owners = snapB2.s.tw.map((row) => row[5]).sort();
  assert.deepEqual(owners, [0, 1], '两座塔应分别归属两个玩家');

  a.close();
  b.close();
});

test('服务端拒绝非法指令：金币不足 / 未知指令 / 超频', { timeout: 15000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const c = await wsClient(port, '/ws?name=测试');
  await c.waitFor((m) => m.t === 'hello');

  // 4 座静电塔要 1040 金，初始只有 200 → 只有第一座能成功
  c.send({ t: 'build', slot: 0, towerId: 'tw_static' });
  c.send({ t: 'build', slot: 1, towerId: 'tw_static' });
  const err = await c.waitFor((m) => m.t === 'error');
  assert.match(err.text, /指令被拒绝/);

  c.send({ t: 'nonsense' });
  const err2 = await c.waitFor((m) => m.t === 'error' && /nonsense/.test(m.text));
  assert.ok(err2);

  for (let i = 0; i < 40; i++) c.send({ t: 'ping' });
  const limited = await c.waitFor((m) => m.t === 'error' && m.code === 'rate_limited');
  assert.equal(limited.code, 'rate_limited', '超过 20 条/秒应被限流');
  c.close();
});

// §148：服务端的「模式边界」要自己拦，别靠 try/catch 兜。
// 两个方向都错了：
//  ① **联机修塔从来没生效过**——`case 'repairTower'` 写的是 `m.mode === 'td'`，而 TD 局的 `m.mode`
//     是 `undefined`（只有防守局写 'defense'，全项目都按「不是防守」判定）→ 这一格永远 false；
//  ② 反方向：TD 专属指令（build / upgrade / sell / priority / early）打进防守房会**抛异常**
//     （防守的 match 没有 `m.map.slots` / `m.wave`），被 §123 的兜底吞成「服务器处理不了」。
// 这里走**真实 WS** 把两条都钉住：修塔要真的修好、防守房要收到「指令被拒绝」而不是「处理不了」。
test('§148 联机修塔真的生效（以前永远被拒）；TD 专属指令打进防守房要「拒绝」而不是「处理不了」', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  // ① 5★ 攻城图（map_05 才有 siege：塔会被攻城怪砸坏 → 修塔按钮才出现）
  const td = await wsClient(port, '/ws?name=修塔手&uid=ur&map=map_05');
  const hello = await td.waitFor((m) => m.t === 'hello', 3000, 'hello');
  const room = game.registry.get(hello.roomCode);
  assert.ok(room.match.map.def.siege, 'map_05 得是攻城图，否则修塔本来就不该出现');
  td.send({ t: 'build', slot: 0, towerId: 'tw_arrow' });
  await td.waitFor((m) => m.t === 'snap' && (m.s.tw ?? []).length === 1, 3000, '建塔');
  // 直接把塔砸坏（真让攻城怪砸要等好几波；这里量的是指令通路，不是伤害公式）
  room.match.towers[0].hp = Math.round(room.match.towers[0].maxHp * 0.4);
  room.match.gold = 500;
  td.send({ t: 'repairTower', slot: 0 });
  const repaired = await td.waitFor((m) => m.t === 'snap' && Math.round(m.s.gold) === 440, 3000, '修塔扣钱');
  assert.equal(Math.round(room.match.towers[0].hp), room.match.towers[0].maxHp, '塔要修满（不是只回 10%）');
  assert.equal(Math.round(repaired.s.gold), 440, '修塔 60 金：500 → 440');
  void repaired;
  td.close();

  // ② 防守房：同一批 TD 专属指令必须被「模式守卫」当场拒，而不是撞进 catch
  const def = await wsClient(port, '/ws?name=守城手&uid=ud&mode=defense&map=def_01');
  await def.waitFor((m) => m.t === 'hello', 3000, '防守 hello');
  for (const cmd of [{ t: 'build', slot: 0, towerId: 'tw_arrow' }, { t: 'upgrade', slot: 0 }, { t: 'early' }, { t: 'repairTower', slot: 0 }]) {
    def.send(cmd);
    const err = await def.waitFor((m) => m.t === 'error' && m.text.includes(cmd.t), 3000, `${cmd.t} 被拒`);
    assert.match(err.text, /指令被拒绝/, `${cmd.t} 该被「拒绝」，不该走 catch 变成「服务器处理不了」`);
  }
  def.close();
});

// §165：**镜像里的怪物 maxHp 要跟服务端一致**——血条画的是 `hp / maxHp`，而服务端的 maxHp 是
// `baseHp × 难度 × 人数缩放`（长局 Boss 还另有血量表）。以前快照只发 hp，镜像只能拿 `def.hp` 当分母：
// 噩梦 2 人房里 mob_01 是 154 血、分母却是 90 → 血条**长时间显示满血**（比例 1.71，被 `bar()` 夹回 1），
// 玩家看不出还差多少。这条按「服务端自己那只怪的 maxHp」对账，最结实。
test('§165 噩梦 + 2 人房：镜像里怪物 maxHp 与服务端一致（血条的分母由服务端给）', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const a = await wsClient(port, '/ws?name=甲&uid=na&map=map_01&difficulty=nightmare');
  const helloA = await a.waitFor((m) => m.t === 'hello', 3000, '甲 hello');
  const b = await wsClient(port, `/ws?room=${helloA.roomCode}&name=乙&uid=nb`);
  await b.waitFor((m) => m.t === 'hello', 3000, '乙 hello');
  const room = game.registry.get(helloA.roomCode);
  a.send({ t: 'early' });   // 提前开波 → 有怪
  const snap = await a.waitFor((m) => m.t === 'snap' && (m.s.mon ?? []).length > 0, 8000, '出怪');
  assert.equal(room.match.difficulty, 'nightmare');
  assert.equal(room.match.scalePlayers, 2, '两人房：人数缩放按 2 人算（`syncPlayerScale` 在开波前重算）');
  // §166：`hello.config` 要带英雄职业——加入者靠它把自己的镜像（按自己大厅选的职业建的）纠正过来
  const helloForHero = await wsClient(port, `/ws?room=${helloA.roomCode}&name=丙&uid=nc`);
  const helloC = await helloForHero.waitFor((m) => m.t === 'hello', 3000, '丙 hello');
  assert.equal(helloC.config?.heroId, room.match.hero.def.id, 'hello.config 要带房主的英雄 id');
  // 顺手把「客户端对齐会用到的字段」钉成一张表：配置少一个字段 = 某一类错配会静默发生
  // （`length` 漏过 → 长局镜像停在 12 波 §163；`heroId` 漏过 → 加入者看到自己选的英雄 §166）。
  assert.deepEqual(Object.keys(helloC.config).sort(),
    ['difficulty', 'heroId', 'length', 'mapId', 'mode'],
    `hello.config 的字段集合要和客户端 onHello 里对齐的字段一一对应（实际 ${JSON.stringify(helloC.config)}）`);
  helloForHero.close();

  const mirror = createMatch({ mapId: 'map_01', difficulty: 'nightmare', seed: 1 });
  applyShared(mirror, snap.s);
  if (snap.me) applyPrivate(mirror, snap.me);
  const srvMon = room.match.monsters.find((x) => !x.dead);
  const mirMon = mirror.monsters.find((x) => x.uid === srvMon.uid);
  assert.ok(mirMon, `镜像里要有这只怪（uid ${srvMon.uid}）`);
  assert.equal(Math.round(mirMon.maxHp), Math.round(srvMon.maxHp),
    `maxHp 要跟服务端一致（服务端 ${Math.round(srvMon.maxHp)}，镜像 ${Math.round(mirMon.maxHp)}）`);
  assert.ok(mirMon.maxHp > 90, `噩梦 2 人房的 mob_01 血量该被缩放（基础 90），实际 ${mirMon.maxHp}`);
  assert.ok(mirMon.hp <= mirMon.maxHp, `血条比例必须 ≤1（实际 ${(mirMon.hp / mirMon.maxHp).toFixed(2)}）`);
  a.close(); b.close();
});

test('快照能还原成客户端可渲染的镜像（towers / monsters / 经济）', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const c = await wsClient(port, '/ws?name=镜像&map=map_02');
  const hello = await c.waitFor((m) => m.t === 'hello');
  c.send({ t: 'build', slot: 0, towerId: 'tw_arrow' });
  const built = await c.waitFor((m) => m.t === 'snap' && (m.s.tw ?? []).length === 1);
  c.send({ t: 'early' });
  const withMonsters = await c.waitFor((m) => m.t === 'snap' && m.s.mon.length > 0, 6000);

  const mirror = createMatch({ mapId: 'map_02', difficulty: 'normal' });
  // 塔只在变化时才随共享快照下发，所以拼上建塔那一帧的 tw（full 表示怪物为全集）
  applyShared(mirror, { ...withMonsters.s, tw: withMonsters.s.tw ?? built.s.tw, full: 1 });
  assert.equal(mirror.towers.length, 1);
  assert.equal(mirror.towers[0].cell.x, mirror.map.slots[0].x, '塔位坐标可还原');
  assert.ok(mirror.monsters.length > 0);
  assert.ok(mirror.monsters[0].cell && mirror.monsters[0].def.name, '怪物可还原为可渲染对象');
  assert.ok(mirror.gold >= 0 && mirror.core.hp > 0);

  // 私人数据（金币之外）走独立通道
  const helloPrivate = hello.me;
  applyPrivate(mirror, helloPrivate);
  assert.equal(mirror.lumber[0], 0);
  assert.ok(Array.isArray(mirror.inventory));
  c.close();
});

test('房间满员与离开：第 5 人进不来，离开后房间被回收', { timeout: 15000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const first = await wsClient(port, '/ws?name=P0');
  const { roomCode } = await first.waitFor((m) => m.t === 'hello');
  const others = [];
  for (let i = 1; i < 4; i++) {
    const c = await wsClient(port, `/ws?room=${roomCode}&name=P${i}`);
    await c.waitFor((m) => m.t === 'hello');
    others.push(c);
  }
  const fifth = await wsClient(port, `/ws?room=${roomCode}&name=P4`);
  const full = await fifth.waitFor((m) => m.t === 'error');
  assert.equal(full.code, 'room_full');

  first.close(); others.forEach((c) => c.close()); fifth.close();
  // 断线后玩家位保留（5 分钟重连窗口），所以房间不会立刻回收：先断言「离线但保留」
  await new Promise((r) => setTimeout(r, 300));
  const room = game.registry.get(roomCode);
  assert.ok(room, '保留窗口内房间不应被回收，否则断线重连无从谈起');
  assert.equal(room.info().online, 0, '全员离线');
  assert.equal(room.info().players, 4, '玩家位与资源仍保留');
});

test('§3.1 #23 主动退房 `leave`：座位立刻释放（不是掉线的 5 分钟保留）', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  // 3 个人在房 + 1 个空位（maxPlayers 4）：第 4 位朋友得等那个人真走开才进得来
  const a = await wsClient(port, '/ws?name=甲&uid=ua');
  const { roomCode } = await a.waitFor((m) => m.t === 'hello');
  const b = await wsClient(port, `/ws?room=${roomCode}&name=乙&uid=ub`);
  await b.waitFor((m) => m.t === 'hello');
  const c = await wsClient(port, `/ws?room=${roomCode}&name=丙&uid=uc`);
  await c.waitFor((m) => m.t === 'hello');

  // 丙主动退房：**先发一条 leave，再关连接**（客户端 net.leave() 就是这么做的）
  c.send({ t: 'leave' });
  await b.waitFor((m) => m.t === 'left' && (m.players ?? []).length === 2, 3000, '乙看到丙走了');
  c.close();
  const room = game.registry.get(roomCode);
  assert.equal(room.info().players, 2, '座位立刻释放（掉线要留 5 分钟，主动退房不留）');

  // 第 4 位朋友现在进得来——以前这一格是「房间已满」（§113 量的场面）
  const d = await wsClient(port, `/ws?room=${roomCode}&name=丁&uid=ud`);
  const helloD = await d.waitFor((m) => m.t === 'hello', 3000, '丁能进房');
  assert.ok(helloD.roomCode, '丁拿到了同一间房');
  assert.equal(room.info().players, 3);

  // 最后一个人也退房 → 名册空了，房间立刻回收（掉线那条路要等 5 分钟）
  a.send({ t: 'leave' });
  b.send({ t: 'leave' });
  d.send({ t: 'leave' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(game.registry.get(roomCode), null, '全员主动退房 → 房间回收');
  a.close(); b.close(); d.close();
});

test('§3.1 #24 设备级 token：uid 对了但 token 不对，顶不掉别人的座位', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  // 主人第一次进房，带上自己的令牌
  const owner = await wsClient(port, '/ws?name=主人&uid=victim&tok=dev-a&map=map_01');
  const hello = await owner.waitFor((m) => m.t === 'hello');
  const { roomCode } = hello;
  owner.send({ t: 'build', slot: 0, towerId: 'tw_arrow' });
  await owner.waitFor((m) => m.t === 'snap' && (m.s.tw ?? []).length === 1);

  // 冒用者知道 uid，但拿不到令牌：当场被拒，**而且原主人那条连接不受影响**
  const impostor = await wsClient(port, `/ws?room=${roomCode}&name=冒充者&uid=victim&tok=dev-b`);
  const err = await impostor.waitFor((m) => m.t === 'error');
  assert.equal(err.code, 'identity');
  const room = game.registry.get(roomCode);
  assert.equal(room.info().players, 1, '冒用者不该占到座位');
  assert.equal(room.info().online, 1, '原主人的连接还活着（没有被顶掉）');
  assert.equal(owner.socket.destroyed, false, '原主人的 socket 没被关掉');

  // 空着 token 也一样拒（「知道 uid 就够了」这条捷径被堵上）
  const noTok = await wsClient(port, `/ws?room=${roomCode}&name=空令牌&uid=victim`);
  assert.equal((await noTok.waitFor((m) => m.t === 'error')).code, 'identity');

  // 本人换设备/刷新后带着同一枚令牌回来：照旧回到原座位，塔还在
  const back = await wsClient(port, `/ws?room=${roomCode}&name=主人&uid=victim&tok=dev-a`);
  const hello2 = await back.waitFor((m) => m.t === 'hello');
  assert.equal(hello2.s.tw.length, 1, '同一枚令牌 = 同一个人，塔还在');
  assert.equal(room.info().players, 1);

  owner.close(); impostor.close(); noTok.close(); back.close();
});

test('断线重连：同一 uid 回到原玩家位，塔与资源都还在', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const first = await wsClient(port, '/ws?name=断线者&uid=stable-1&map=map_01');
  const hello = await first.waitFor((m) => m.t === 'hello');
  const { roomCode, playerId } = hello;
  first.send({ t: 'build', slot: 0, towerId: 'tw_arrow' });
  await first.waitFor((m) => m.t === 'snap' && (m.s.tw ?? []).length === 1);
  first.close();
  await new Promise((r) => setTimeout(r, 300));

  const again = await wsClient(port, `/ws?room=${roomCode}&name=断线者&uid=stable-1`);
  const hello2 = await again.waitFor((m) => m.t === 'hello');
  assert.equal(hello2.playerId, playerId, '应回到原来的玩家位');
  assert.equal(hello2.s.tw.length, 1, '断线前建的塔还在');
  assert.equal(TOWER_IDS[hello2.s.tw[0][1]], 'tw_arrow');
  assert.equal(hello2.s.gold, 140, '金币没有因为重连被重置');
  assert.equal(game.registry.get(roomCode).info().online, 1, '重新上线');
  again.close();
});

test('带宽预算：峰值实体下单客户端下行 ≤ 15KB/s（§10.1 / 附录 B）', { timeout: 30000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const room = game.registry.create({ mapId: 'map_01', difficulty: 'normal' });
  room.match.core.hp = 1e9; // 不让核心被打爆，专注造出峰值实体数
  // 直接灌 30 只怪：这就是快照序列化的峰值场景（§6.4.2 估的单波峰值 34 只）
  const mobIds = Object.keys(MONSTERS);
  for (let i = 0; i < 30; i++) {
    const mobId = mobIds[i % mobIds.length];
    const def = MONSTERS[mobId];
    const pathIndex = i % room.match.map.paths.length;
    room.match.monsters.push({
      uid: 9000 + i, mobId, def, pathIndex, dist: i * 100, cell: room.match.map.paths[pathIndex].spawn,
      hp: def.hp, maxHp: def.hp, armor: def.armor, armorType: def.armorType,
      speed: 120, attack: def.attack, atkSpeed: def.atkSpeed, cooldown: 0,
      isAir: !!def.isAir, effects: [], dead: false, attacking: false,
    });
  }
  const peak = room.match.monsters.length;
  assert.equal(peak, 30);

  const c = await wsClient(port, `/ws?room=${room.code}&name=计量&uid=ubw`);
  await c.waitFor((m) => m.t === 'hello');
  const before = c.bytes;
  await new Promise((r) => setTimeout(r, 3000));
  const perSecond = (c.bytes - before) / 3;
  const kbs = perSecond / 1024;
  assert.ok(kbs <= 15, `下行 ${kbs.toFixed(2)}KB/s 超出 15KB/s 预算（场上 ${peak} 只）`);
  c.close();
});

test('联机下弹道可见：塔开火时快照里带 pr，客户端能还原成可渲染的投射物', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const c = await wsClient(port, '/ws?name=射手&uid=uproj&map=map_01');
  const hello = await c.waitFor((m) => m.t === 'hello');
  c.send({ t: 'build', slot: 0, towerId: 'tw_arrow' });
  c.send({ t: 'early' });
  const withProjectiles = await c.waitFor((m) => m.t === 'snap' && (m.s.pr ?? []).length > 0 && m.s.mon.length > 0, 8000);

  const mirror = createMatch({ mapId: 'map_01', difficulty: 'normal' });
  applyShared(mirror, { ...withProjectiles.s, tw: withProjectiles.s.tw ?? [[0, TOWER_IDS.indexOf('tw_arrow'), 1, 0, 60]], full: 1 });
  assert.ok(mirror.projectiles.length > 0, '快照应带弹道');
  const p = mirror.projectiles[0];
  assert.ok(p.target, '弹道要指向一个真实的怪物');
  assert.ok(p.from && Number.isFinite(p.from.x), '弹道起点用塔位坐标还原（渲染需要）');
  assert.ok(p.progress >= 0 && p.progress <= 1);

  // 服务器有几只怪，客户端镜像就该有几只（uid 重复会让它们被压成一只）
  const room = game.registry.get(hello.roomCode);
  assert.ok(room, '应能按房间码找回服务端房间');
  assert.equal(mirror.monsters.length, room.match.monsters.filter((x) => !x.dead).length,
    '客户端镜像的怪物数量必须与服务端一致（uid 重复会把它们压成一只）');
  c.close();
});

test('性能护栏：200 实体 + 满塔交战下，单 tick 远低于 50ms 预算（§10.2 容量口径）', { timeout: 30000 }, () => {
  const m = createMatch({ mapId: 'map_01', difficulty: 'normal', seed: 1 });
  m.core.hp = 1e9;
  m.gold = 1e9;
  const towerIds = ['tw_arrow', 'tw_cannon', 'tw_frost', 'tw_static'];
  for (let i = 0; i < m.map.slots.length; i++) buildTower(m, i, towerIds[i % towerIds.length]);

  const ids = Object.keys(MONSTERS);
  for (let i = 0; i < 200; i++) {
    const def = MONSTERS[ids[i % ids.length]];
    const pathIndex = i % m.map.paths.length;
    m.monsters.push({
      uid: 10000 + i, mobId: def.id, def, pathIndex, dist: (i * 7) % 6000,
      cell: m.map.paths[pathIndex].spawn, hp: def.hp, maxHp: def.hp,
      armor: def.armor, armorType: def.armorType, speed: 60, attack: def.attack,
      atkSpeed: def.atkSpeed, cooldown: 0, isAir: !!def.isAir, effects: [], dead: false, attacking: false,
    });
  }

  const TICKS = 200;
  const started = process.hrtime.bigint();
  for (let i = 0; i < TICKS; i++) {
    update(m, TICK_STEP);
    for (const mo of m.monsters) { mo.speed = 60; mo.hp = mo.maxHp; }   // 保持满场，别让后半程变空场
  }
  const msPerTick = Number(process.hrtime.bigint() - started) / 1e6 / TICKS;
  assert.ok(msPerTick < 5, `单 tick ${msPerTick.toFixed(2)}ms 超出护栏（实测约 0.09ms，留 50 倍余量防抖动）`);
  assert.ok(m.monsters.length >= 190, '压测期间应保持满场');
});

test('联机的防守模式：房间按模式建局，两人的快照里都有城堡 / 工事 / 移动', { timeout: 25000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const a = await wsClient(port, '/ws?name=甲&uid=da&mode=defense&map=def_01');
  const helloA = await a.waitFor((m) => m.t === 'hello', 3000, '甲方 hello');
  assert.equal(helloA.s.mode, 'defense', '快照要标明模式，客户端才知道怎么还原');
  assert.equal(helloA.s.castle[1], 4000, 'def_01 城堡 4000 血（§2.6）');
  assert.equal(helloA.s.forts.length, 0);
  assert.equal(helloA.s.camps.length, 4, '4 个营地，即使还没刷怪也要下发位置');

  const b = await wsClient(port, `/ws?room=${helloA.roomCode}&name=乙&uid=db&mode=defense`);
  const helloB = await b.waitFor((m) => m.t === 'hello', 3000, '乙方 hello');
  assert.equal(helloB.roomCode, helloA.roomCode, '同房间码进同一局');

  // 甲建一座工事：两人都该看到
  a.send({ t: 'fort', slot: 0, fortId: 'fort_arrow' });
  const fortA = await a.waitFor((m) => m.t === 'snap' && m.s.forts.length === 1, 3000, '甲的工事');
  const fortB = await b.waitFor((m) => m.t === 'snap' && m.s.forts.length === 1, 3000, '乙的工事');
  assert.equal(FORT_IDS[fortA.s.forts[0][1]], 'fort_arrow');
  assert.equal(FORT_IDS[fortB.s.forts[0][1]], 'fort_arrow', '工事是共享的，两个客户端都要看到');

  // 甲点地移动：快照里应带上英雄位置与路径
  a.send({ t: 'move', x: 12, y: 12 });
  const moved = await a.waitFor((m) => m.t === 'snap' && (m.s.hero[8] ?? []).length > 0, 3000, '移动指令');
  assert.ok(moved.s.hero[8].length > 0, '英雄要带行进路径给客户端画虚线');

  // 修城：城堡满血时应被拒绝
  a.send({ t: 'repair' });
  const err = await a.waitFor((m) => m.t === 'error' && /repair/.test(m.text), 3000, '满血修城被拒');
  assert.ok(err, '满血不该收钱');

  // 回城：英雄应在基地附近，且带冷却；冷却中再按会被拒
  a.send({ t: 'move', x: 8, y: 12 });
  await a.waitFor((m) => m.t === 'snap' && (m.s.hero[8] ?? []).length > 0, 3000, '先走远');
  a.send({ t: 'teleport' });
  const home = await a.waitFor((m) => m.t === 'snap' && m.s.hero[11] > 0, 3000, '回城后应有冷却');
  assert.ok(Math.abs(home.s.hero[6] - 32) <= 3 && Math.abs(home.s.hero[7] - 24) <= 3,
    `回城后英雄应在基地附近，实际 (${home.s.hero[6]},${home.s.hero[7]})`);
  a.send({ t: 'teleport' });
  const cdErr = await a.waitFor((m) => m.t === 'error' && /teleport/.test(m.text), 3000, '冷却中被拒');
  assert.ok(cdErr, '冷却中的回城要拒绝');

  a.close();
  b.close();
});

test('防守模式的镜像可渲染：快照能还原成城堡 / 工事 / 怪 / 掉落', { timeout: 25000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const c = await wsClient(port, '/ws?name=镜像D&uid=dm&mode=defense');
  const hello = await c.waitFor((m) => m.t === 'hello');
  c.send({ t: 'fort', slot: 0, fortId: 'fort_arrow' });
  c.send({ t: 'move', x: 8, y: 12 });
  const rich = await c.waitFor((m) => m.t === 'snap' && m.s.forts.length === 1 && m.s.hero[8].length > 0, 5000, '工事 + 移动');

  const { applyDefenseShared } = await import('../src/protocol.js');
  const { createDefenseMatch } = await import('../src/defense.js');
  const mirror = createDefenseMatch({ seed: 1 });
  // 营地按 30 秒刷怪，等真怪太慢；这里直接补一行怪的快照，验证解码这一层（营地刷怪另有内核用例覆盖）
  const mobIndex = MOB_IDS.indexOf('mob_04');
  applyDefenseShared(mirror, { ...rich.s, full: 1, mon: [[777, mobIndex, 1, 20, 24, 220, 2]], rm: [] });
  assert.equal(mirror.forts.length, 1);
  assert.equal(mirror.forts[0].cell.x, mirror.def.fortSlots[0].x, '工事位坐标可还原');
  assert.equal(mirror.monsters.length, 1);
  assert.equal(mirror.monsters[0].def.name, '沼泽巨魔');
  assert.deepEqual(mirror.monsters[0].cell, { x: 20, y: 24 });
  assert.equal(mirror.monsters[0].kind, 'assault', 'kind 要还原，渲染与 AI 都靠它区分野外怪与进攻怪');
  assert.equal(mirror.monsters[0].attacking, true, 'flags 位要还原');
  assert.ok(mirror.castle.hp > 0 && mirror.castle.maxHp === 4000);
  assert.equal(mirror.camps.length, 4);
  c.close();
});

test('/create：防守局也要能建（曾因读 TD 的 wave 字段把服务器打挂）；/rooms 已被删（§124）', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const created = await fetch(`http://127.0.0.1:${port}/create?mode=defense&map=def_01`).then((r) => r.json());
  assert.equal(created.mode, 'defense');
  assert.equal(created.castleHp, 4000, '防守局列表要能报出城堡血量');
  assert.equal(created.wave, 0, '还没开打，轮次 0');

  const tdCreated = await fetch(`http://127.0.0.1:${port}/create?mode=td&map=map_02`).then((r) => r.json());
  assert.equal(tdCreated.mode, 'td');
  assert.equal(tdCreated.wave, 0);

  // 没带 mode 时按地图前缀推模式（客户端点「创建联机房间」曾经漏传 mode，
  // 于是防守图建房变成 500「未知地图 def_01」）
  const inferred = await fetch(`http://127.0.0.1:${port}/create?map=def_02&difficulty=hard`).then((r) => r.json());
  assert.equal(inferred.mode, 'defense', 'def_* 图不带 mode 也该建出防守局');
  assert.equal(inferred.mapId, 'def_02');

  // 一个坏请求不该弄死进程：之后仍能正常服务
  const bad = await fetch(`http://127.0.0.1:${port}/create?mode=defense&seed=not-a-number`);
  assert.ok([200, 500].includes(bad.status));
  const after = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(after.status, 200, '坏请求之后服务仍可用');

  // §124：**房间码就是邀请凭证**（§10.4 靠它分享），所以不能提供一个「列出全服房间码」的接口。
  // 这条把 `/rooms` 钉死在 404 上：它曾经把每一间在进行中的房的房间码公开挂出来。
  const rooms = await fetch(`http://127.0.0.1:${port}/rooms`);
  assert.equal(rooms.status, 404, '/rooms 必须不存在（房间码不能被枚举）');
});

test('只读指令不触发回推快照（否则 ping → 快照 → ping 会自激）', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const c = await wsClient(port, '/ws?name=回声&uid=uecho');
  await c.waitFor((m) => m.t === 'hello');
  const before = c.messages.length;
  c.send({ t: 'ping' });
  await new Promise((r) => setTimeout(r, 400));
  const after = c.messages.length;
  // 400ms 内最多是常规的 10Hz 广播（4 条左右），不该因为 ping 多出成对的快照
  assert.ok(after - before <= 8, `ping 之后消息数 ${after - before} 应只有常规广播`);
  assert.ok(!c.messages.slice(before).some((t) => JSON.parse(t).code === 'rate_limited'), '不该被限流');
  c.close();
});

test('服务端局外结算：通关后每位参战者都拿到声望与人物经验，并推回客户端', { timeout: 25000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const a = await wsClient(port, '/ws?name=甲&uid=pa&map=map_01');
  const helloA = await a.waitFor((m) => m.t === 'hello');
  assert.equal(helloA.profile.reputation, 0, '首次进入是空档案');
  const b = await wsClient(port, `/ws?room=${helloA.roomCode}&name=乙&uid=pb`);
  await b.waitFor((m) => m.t === 'hello');

  // 直接把这一局判定为通关（把塔/波次的慢流程跳过），看结算是否落到两人账上
  const room = game.registry.get(helloA.roomCode);
  room.match.time = 480;
  room.match.core.hp = 900;
  room.match.result = 'win';

  const pa = await a.waitFor((m) => m.t === 'profile', 5000, '甲的档案推送');
  const pb = await b.waitFor((m) => m.t === 'profile', 5000, '乙的档案推送');
  assert.ok(pa.profile.reputation > 0, `甲应拿到声望，实际 ${pa.profile.reputation}`);
  assert.equal(pa.gain, 120, '普通难度通关 120 声望（§1.7.1）');
  assert.equal(pb.profile.reputation, pa.profile.reputation, '两人都参战，记账应一致');
  assert.equal(pa.profile.clears.map_01.wins, 1);
  assert.equal(game.profiles.size, 2, '两个人的档案都建了');

  a.close();
  b.close();
});

// §149：联机结算面板的「伤害占比」是空的。客户端是**纯镜像**（不跑模拟），`stats.damage` 只有跑模拟的
// 那一方才有，而服务端从来不把它发过来 → 面板那一栏直接写「本局没有记录到伤害」（单机同一页有占比条）。
// 现在随结算推送（`msg.profile` 的 extra）一次性发回来，客户端补进镜像——和 §130 的「声望 +N」
// 走同一条消息、同一个理由（只在服务端算得出来的数，就得由服务端送）。
test('§149 联机结算的伤害占比不为空（服务端随结算把账本推回来）', { timeout: 25000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const c = await wsClient(port, '/ws?name=打手&uid=ud&map=map_01');
  const hello = await c.waitFor((m) => m.t === 'hello', 3000, 'hello');
  const room = game.registry.get(hello.roomCode);
  c.send({ t: 'build', slot: 0, towerId: 'tw_arrow' });
  await c.waitFor((m) => m.t === 'snap' && (m.s.tw ?? []).length === 1, 3000, '建塔');
  c.send({ t: 'early' });
  await c.waitFor((m) => m.t === 'snap' && (m.s.mon ?? []).length > 0, 6000, '出怪');
  await new Promise((r) => setTimeout(r, 2000));   // 房间自己按 20Hz 跑，等它真的打出伤害
  assert.ok(Object.keys(room.match.stats.damage).length > 0, '服务端要先有伤害账本');

  room.match.result = 'win';
  const p = await c.waitFor((m) => m.t === 'profile', 5000, '结算推送');
  assert.ok(p.extra?.damage && Object.keys(p.extra.damage).length > 0,
    `结算推送里要带伤害账本，实际 extra=${JSON.stringify(p.extra)}`);

  // 按客户端的真实顺序落进镜像：快照 → 结算推送里的账本
  const snap = await c.waitFor((m) => m.t === 'snap' && m.s.result, 5000, '结算快照');
  const mirror = createMatch({ mapId: 'map_01', difficulty: 'normal' });
  applyShared(mirror, snap.s);
  if (snap.me) applyPrivate(mirror, snap.me);
  assert.deepEqual(mirror.stats.damage, {}, '镜像自己算不出伤害——这就是非要服务端推的原因');
  mirror.stats.damage = { ...p.extra.damage };   // `main.js` 的 onProfile 就是这一步

  const rows = resultPanelModel(mirror, { gain: p.gain }).damage.rows;
  assert.ok(rows.length > 0, '结算面板要有占比条');
  assert.ok(rows.every((r) => r.label && !/^tw_|^fort_/.test(r.label)),
    `占比条要写中文名，实际 ${rows.map((r) => r.label).join(' / ')}`);
  c.close();
});

test('联网档案跨局累积，且房主的人物等级决定初始金币', { timeout: 25000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  // 先给这个 uid 攒一点声望（打两局）
  for (let i = 0; i < 2; i++) {
    const c = await wsClient(port, `/ws?name=老玩家&uid=veteran&map=map_01&seed=${100 + i}`);
    const hello = await c.waitFor((m) => m.t === 'hello');
    const room = game.registry.get(hello.roomCode);
    room.match.result = 'win';
    await c.waitFor((m) => m.t === 'profile', 5000, '结算');
    c.close();
    await new Promise((r) => setTimeout(r, 50));
  }
  const p = game.profiles.get('veteran');
  assert.equal(p.reputation, 240, '两局普通通关共 240 声望');
  assert.ok(p.commanderLevel >= 2, `人物等级应涨到 2 级以上，实际 ${p.commanderLevel}`);

  // 再开一局：房主加成应体现在共享金币池里
  const host = await wsClient(port, '/ws?name=老玩家&uid=veteran&map=map_01');
  const hello2 = await host.waitFor((m) => m.t === 'hello', 3000, '建房');
  assert.ok(hello2.profile.reputation >= 240, 'hello 里带回服务端档案');
  assert.ok(hello2.s.gold > 200, `房主等级加成应让初始金币 >200，实际 ${hello2.s.gold}`);
  host.close();
});

test('服务器重启不丢局外进度：写完盘后新起一个服务器仍能读到（§18.4 那条缺口）', { timeout: 30000 }, async (t) => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dataDir = mkdtempSync(join(tmpdir(), 'frostfall-srv-'));

  // 第一台服务器：打一局，然后正常关闭（关服会 flush）
  const first = createGameServer({ quiet: true, dataDir });
  const port1 = await first.listen(0);
  const c1 = await wsClient(port1, '/ws?name=老玩家&uid=persist-me&map=map_01&seed=42');
  const hello1 = await c1.waitFor((m) => m.t === 'hello');
  first.registry.get(hello1.roomCode).match.result = 'win';
  await c1.waitFor((m) => m.t === 'profile', 5000, '结算');
  c1.close();
  await first.close();

  // 第二台服务器：同一个数据目录，应把档案读回来
  const second = createGameServer({ quiet: true, dataDir });
  const port2 = await second.listen(0);
  t.after(() => second.close());
  assert.equal(second.profiles.size, 1, '重启后应加载到 1 份档案');
  assert.equal(second.profiles.get('persist-me').reputation, 120, '声望要跟着重启活下来');

  const c2 = await wsClient(port2, '/ws?name=老玩家&uid=persist-me&map=map_01');
  const hello2 = await c2.waitFor((m) => m.t === 'hello');
  assert.equal(hello2.profile.reputation, 120, 'hello 里带回来的档案应是重启前的');
  assert.equal(hello2.profile.clears.map_01.wins, 1);
  c2.close();
});

test('重连的升级版：旧连接还挂着（半开口 / 页面跳转）时，新连接直接接管那一席', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const first = await wsClient(port, '/ws?name=半开口&uid=takeover-1&map=map_01');
  const hello = await first.waitFor((m) => m.t === 'hello');
  const { roomCode, playerId, slot } = hello;
  assert.equal(slot, 0);
  // 故意不关第一条连接就再连一次 —— 真实场景是页面跳转/切网，FIN 还没到
  const second = await wsClient(port, `/ws?room=${roomCode}&name=半开口&uid=takeover-1`);
  const hello2 = await second.waitFor((m) => m.t === 'hello');
  assert.equal(hello2.playerId, playerId, '同一 uid 应接管原来那一席，而不是被拒');
  assert.equal(hello2.slot, slot, '槽位也不该变（队伍色 / 自己的塔都靠它）');
  const room = game.registry.get(roomCode);
  assert.equal(room.info().players, 1, '接管不该多出一个玩家位');
  assert.equal(room.info().online, 1);

  // 被顶掉的旧连接关闭时，不该把已经接管进来的玩家判成掉线
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(room.info().online, 1, '旧连接的 close 不能把新连接的人踢下线');

  second.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(room.info().online, 0, '真正断开后才算掉线');
});

test('个人木材归个人：2 号位买技能书 / 快速复活 / 提前开波都不该花房主的木材', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const host = await wsClient(port, '/ws?name=房主&uid=host-money&map=map_01');
  const hello = await host.waitFor((m) => m.t === 'hello');
  const friend = await wsClient(port, `/ws?room=${hello.roomCode}&name=二号位&uid=friend-money`);
  await friend.waitFor((m) => m.t === 'hello');

  const room = game.registry.get(hello.roomCode);
  const m = room.match;
  m.gold = 5000;                 // 金币是共享池，随便够
  m.lumber[0] = 0;               // 房主一分木材都没有
  m.lumber[1] = 100;             // 二号位有 100

  // 二号位买秘传技能书（600 金 + 20 木）：花的必须是他自己的木材
  const waitUntil = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
  };
  friend.send({ t: 'buy', itemId: 'book_secret' });
  await waitUntil(() => m.lumber[1] === 80);
  assert.equal(m.lumber[1], 80, '20 木材应该从二号位扣');
  assert.equal(m.lumber[0], 0, '房主的木材不该被动');
  assert.equal(m.hero.skillUnlocked[2], true, '技能书生效');

  // 提前开波：+3 木材也归按按钮的人
  m.wave = { index: 1, phase: 'prep', timer: 99, spawned: 0, total: 0, queue: [] };
  friend.send({ t: 'early' });
  await waitUntil(() => m.lumber[1] === 83);
  assert.equal(m.lumber[1], 83, '提前开波的 +3 木材归发起人');
  assert.equal(m.lumber[0], 0, '房主仍然没有木材');

  // 快速复活：50 木材从发起人身上扣
  m.hero.hp = 0;
  m.hero.dead = true;
  m.hero.reviveTimer = 15;
  friend.send({ t: 'revive' });
  await waitUntil(() => m.lumber[1] === 33);
  assert.equal(m.lumber[1], 33, '50 木材从二号位扣');
  assert.equal(m.lumber[0], 0, '房主依然没被扣');
  host.close();
  friend.close();
});

test('玩家名单：带座号，而且新进来的人立刻就能拿到完整名单', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const a = await wsClient(port, '/ws?name=甲&uid=list-a&map=map_01');
  const helloA = await a.waitFor((m) => m.t === 'hello');
  assert.equal(helloA.slot, 0);

  // 乙进房：自己应当马上收到一份名单（原来这条广播把自己排除了，面板上别人全是「空位」）
  const b = await wsClient(port, `/ws?room=${helloA.roomCode}&name=乙&uid=list-b`);
  const helloB = await b.waitFor((m) => m.t === 'hello');
  assert.equal(helloB.slot, 1);
  const list = await b.waitFor((m) => (m.t === 'joined' || m.t === 'left') && (m.players ?? []).length >= 2);
  // §125：名单里不再带 uid（那是身份凭证），所以按座号认人——面板本来也是按座号排的
  const mine = list.players.find((p) => p.slot === 1);
  const other = list.players.find((p) => p.slot === 0);
  assert.ok(mine && other, '名单里要有两个人');
  assert.equal(mine.name, '乙', '名单按座号对上人（§125 之后名单里不带 uid 了，只能按 slot/名字认）');
  assert.equal(other.name, '甲');
  assert.equal(mine.slot, 1, '名单必须带座号（客户端面板按座号排）');
  assert.equal(other.slot, 0);
  assert.equal(other.online, true);

  // 甲也应该看到 2 人（原来的行为没问题，这条是防回归）
  await a.waitFor((m) => (m.t === 'joined') && (m.players ?? []).length >= 2);
  assert.equal(game.registry.get(helloA.roomCode).info().players, 2);
  a.close();
  b.close();
});

test('§10.2 / §5.4 指令表双向对齐：COMMANDS 里每条都有服务端分支与客户端发送方', async () => {
  const { readFile } = await import('node:fs/promises');
  const room = await readFile(new URL('../src/server/room.js', import.meta.url), 'utf8');
  const net = await readFile(new URL('../src/net.js', import.meta.url), 'utf8');
  // 反证：这两个断言得有能力失败（否则「includes」写成永远为真就白测了）
  assert.ok(!room.includes("case 'not-a-real-command':"), 'room.js 里不该有这条');
  assert.ok(!net.includes("t: 'not-a-real-command'"), 'net.js 里不该有这条');

  for (const c of COMMANDS) {
    assert.ok(room.includes(`case '${c}':`), `server/room.js 缺少 ${c} 的服务端分支（客户端会收到「指令被拒绝」）`);
    assert.ok(net.includes(`t: '${c}'`), `net.js 没有发送 ${c} 的地方（这条指令玩家发不出去）`);
  }
  // 反向：room.js 里的每个 case 也必须在表里（漏登记 = 这张表不再是契约）
  const cases = [...room.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]);
  for (const c of cases) assert.ok(COMMANDS.includes(c), `room.js 有 ${c} 的分支，但 COMMANDS 里没登记`);
});

test('§1.5 / §1.6 联机房的人数缩放：按真实名册（不是人数上限）定档', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  // 建房时不知道会有几个人来：房间按人数上限 4 建的，但第一波出怪前要按名册重算
  const a = await wsClient(port, '/ws?name=甲');
  const helloA = await a.waitFor((m) => m.t === 'hello');
  const room = game.registry.get(helloA.roomCode);
  assert.deepEqual(room.match.scale, { count: 0.60, hp: 0.85, gold: 0.80 }, '一个人进房 → 单人档');
  assert.equal(room.match.bountyMul, 0.5 * 0.8, '赏金也跟着走（§6.4 的 ×0.5 × 人数系数 0.80）');

  // 第二个人进来 → 名册变了，但已经出过怪/开过波就不再改（免得半局换难度）
  const b = await wsClient(port, `/ws?room=${helloA.roomCode}&name=乙`);
  await b.waitFor((m) => m.t === 'hello');
  assert.deepEqual(room.match.scale, { count: 0.80, hp: 0.95, gold: 0.90 }, '还没出怪 → 跟着名册变');

  room.match.wave.timer = 0;
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 120));   // 等房间 tick 把第一波开出来
  const c = await wsClient(port, `/ws?room=${helloA.roomCode}&name=丙`);
  await c.waitFor((m) => m.t === 'hello');
  assert.deepEqual(room.match.scale, { count: 0.80, hp: 0.95, gold: 0.90 }, '出怪之后名册再变也不改档');

  a.close(); b.close(); c.close();
});

// §1.5：房间码输错/过期时，服务端会**新建一间**——玩家必须知道这件事
test('§1.5 房间码没命中要说出来（joinNotice 的判据）', async () => {
  const { joinNotice } = await import('../src/net.js');
  assert.equal(joinNotice('ABC123', 'ABC123'), null, '码命中就不提示');
  assert.equal(joinNotice(null, 'ABC123'), null, '建房（没给码）不提示');
  assert.equal(joinNotice('TYPO99', 'XYZ789'),
    '房间 TYPO99 不存在或已过期，已新建房间 XYZ789');
});

test('§10.3 序号跳跃 → 请求全量快照（needsResync 的判据 + 服务端真的回全量）', { timeout: 20000 }, async (t) => {
  const { needsResync } = await import('../src/net.js');
  // 判据本身：第一条快照（-1 → N）不算跳跃；连号不算；跳号算
  assert.equal(needsResync(-1, 7), false, '第一条快照不算跳跃');
  assert.equal(needsResync(7, 8), false, '连号');
  assert.equal(needsResync(7, 7), false, '同一份补发（序号不涨）');
  assert.equal(needsResync(7, 9), true, '中间少了一份 → 跳跃');
  assert.equal(needsResync(NaN, 9), false, '脏数据不触发');

  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const c = await wsClient(port, '/ws?name=补发&map=map_01');
  const hello = await c.waitFor((m) => m.t === 'hello');
  const room = game.registry.get(hello.roomCode);
  // 造 5 只怪，让增量快照有内容可省
  room.match.wave.timer = 0;
  room.match.wave.phase = 'prep';
  update(room.match, TICK_STEP);
  for (let i = 0; i < 40; i++) update(room.match, TICK_STEP);
  const firstFull = await c.waitFor((m) => m.t === 'snap' && (m.s.mon ?? []).length > 0, 6000);
  const total = room.match.monsters.filter((x) => !x.dead).length;

  // 请求补发：服务端应当回一份 full=1 的全量（而不是只带变化的那几只）
  c.send({ t: 'resync' });
  const back = await c.waitFor((m) => m.t === 'snap' && m.s.full === 1, 6000);
  assert.equal((back.s.mon ?? []).length, total, `补发要带全部 ${total} 只怪，实际 ${(back.s.mon ?? []).length}`);
  assert.ok(firstFull.s.rev >= 1);
  c.close();
});

test('§10.3 rev 只按广播递增：私有补发的快照不许顶掉广播序号', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const c = await wsClient(port, '/ws?name=甲&map=map_01');
  const hello = await c.waitFor((m) => m.t === 'hello');
  const first = await c.waitFor((m) => m.t === 'snap' && m.s.rev >= 1, 6000);

  // 甲发一条指令 → 服务端会**只给他**补一份 peek 快照（含刚建的塔）
  c.send({ t: 'build', slot: 0, towerId: 'tw_arrow' });
  const ack = await c.waitFor((m) => m.t === 'snap' && (m.s.tw ?? []).length === 1, 6000);
  assert.equal(ack.s.rev, first.s.rev, '私有补发不该推进广播序号（否则别人的下一个序号就跳了）');

  // 下一个真正的广播：序号只 +1（而不是被补发顶成 +2）
  const next = await c.waitFor((m) => m.t === 'snap' && m.s.rev > ack.s.rev, 6000);
  assert.equal(next.s.rev, ack.s.rev + 1, `广播序号该只 +1，实际 ${ack.s.rev} → ${next.s.rev}`);
  c.close();
});

test('§5.5.1 联机防守里买到卷轴要同步给客户端（回城按钮靠它点亮）', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const c = await wsClient(port, '/ws?name=卷轴&mode=defense&map=def_01');
  const hello = await c.waitFor((m) => m.t === 'hello');
  assert.equal(hello.me.scrolls ?? 0, 0, '开局没有卷轴');
  c.send({ t: 'buy', itemId: 'scroll_town' });
  const snap = await c.waitFor((m) => m.t === 'snap' && m.me && (m.me.scrolls ?? 0) > 0, 6000);
  assert.equal(snap.me.scrolls, 1, '买到的卷轴要进私人快照（否则客户端永远以为没有）');
  // 客户端镜像也要跟着变：applyPrivate 是客户端唯一入口
  const mirror = createMatch({ mapId: 'map_01', difficulty: 'normal' });
  mirror.scrolls = 0;
  applyPrivate(mirror, snap.me);
  assert.equal(mirror.scrolls, 1, '镜像的 scrolls 要跟着私人快照走');
  c.close();
});

test('§2.2 map_06 双守护目标：联机快照要带上**每一个**核心的血（否则第二个永远满血）', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const c = await wsClient(port, '/ws?name=双核&map=map_06');
  const hello = await c.waitFor((m) => m.t === 'hello');
  const room = game.registry.get(hello.roomCode);
  assert.equal(room.match.cores.length, 2, '前置：map_06 是两个守护目标');
  room.match.cores[1].hp -= 700;                 // 服务端把第二个核心打掉 700
  const snap = await c.waitFor((m) => m.t === 'snap' && !!m.s.cores, 6000);
  assert.deepEqual(snap.s.cores[1], [room.match.cores[1].hp, room.match.cores[1].maxHp]);

  const mirror = createMatch({ mapId: 'map_06', difficulty: 'normal' });
  applyShared(mirror, snap.s);
  assert.equal(mirror.cores.length, 2);
  assert.equal(mirror.cores[1].hp, room.match.cores[1].hp, '镜像的第二个核心血量要对得上');
  c.close();
});

// 协议表上写着「新增指令必须同时加服务端校验」；服务端是唯一的信任边界（客户端可以随便发）。
// 这条把一堆畸形指令一次性灌进去：**服务端不许崩、不许真的改状态、之后还得能正常干活**。
test('服务端是信任边界：畸形指令不能把服务端打崩，也不能改到对局', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());
  const c = await wsClient(port, '/ws?name=坏客户端&map=map_01');
  const hello = await c.waitFor((m) => m.t === 'hello');
  const room = game.registry.get(hello.roomCode);

  const bad = [
    { t: 'build', slot: 9999, towerId: 'no_such_tower' },
    { t: 'build', slot: 0, towerId: 'no_such_tower' },
    { t: 'build', slot: 0 },                                  // 缺字段
    { t: 'upgrade', slot: 9999 },
    { t: 'sell', slot: -3 },
    { t: 'priority', slot: 0, priority: 'nope' },
    { t: 'cast', index: 99 },
    { t: 'buy', itemId: 'no_such_item' },
    { t: 'potion', itemId: 'no_such_item' },
    { t: 'equip', uid: 'no-such-item' },
    { t: 'enhance', uid: 'no-such-item' },
    { t: 'sellitem', uid: 'no-such-item' },
    { t: 'fort', slot: 0, fortId: 'no_such_fort' },           // TD 局里防守指令本就该被拒
    { t: 'move', x: 1e9, y: -1e9 },
    { t: 'teleport' },
    { t: 'repairTower', slot: 12345 },
    { t: 'unknown_command', whatever: 1 },
  ];

  // ① 写入口（`applyCommand` 是「唯一的写入口」）逐条喂畸形指令：
  //    必须返回 false（= 什么都没改），而且**不许抛异常**
  for (const cmd of bad) {
    let ok;
    assert.doesNotThrow(() => { ok = room.applyCommand(hello.playerId, cmd, 0); }, `畸形指令 ${cmd.t} 把服务端抛崩了`);
    assert.equal(ok, false, `畸形指令 ${JSON.stringify(cmd)} 不该被接受`);
  }
  assert.equal(room.match.towers.length, 0, '畸形指令不许真的建出塔来');
  assert.equal(room.match.gold, 200, '畸形指令不许动金币');
  assert.equal(room.match.hero.hp, room.match.hero.def.hp, '畸形指令不许动英雄血量');
  assert.equal(room.match.result, null, '畸形指令不许把对局判结束');

  // ② 合法指令照样生效（同一入口）
  assert.equal(room.applyCommand(hello.playerId, { t: 'build', slot: 0, towerId: 'tw_arrow' }, 0), true);
  assert.equal(room.match.towers.length, 1, '灌完畸形指令后，正常指令仍然能生效');

  // ③ 走 socket 的那一层：解析不了的消息要回一句人话（不是静默）。
  // 注意 `c.send()` 会自己 JSON.stringify —— 要发「非 JSON」得直接写帧（第一版就是这么红的）
  c.socket.write(clientFrame('这不是 JSON'));
  const parseErr = await c.waitFor((m) => m.t === 'error', 3000);
  assert.match(parseErr.text, /无法解析/, `坏消息要明确拒绝，实际「${parseErr.text}」`);

  // ④ §12.7 的限速得真的挡人（handleMessage 那一层，1 秒最多 20 条）
  const player = room.players.get(hello.playerId);
  player.cmdCount = 0; player.windowStart = Date.now();
  let limited = false;
  for (let i = 0; i < 30; i++) if (!room.allow(player)) limited = true;
  assert.ok(limited, '超频指令要被挡下来（rate_limited）');
  c.close();
});

test('§12.3 中途加入窗口：TD 波次 ≤3、防守 ≤3 分钟；同 uid 重连不受限', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  // 甲建房，把波次推到第 4 波（越过窗口）
  const a = await wsClient(port, '/ws?name=甲&map=map_01');
  const helloA = await a.waitFor((m) => m.t === 'hello');
  const room = game.registry.get(helloA.roomCode);
  assert.equal(room.canJoinNow(), true, '刚开波之前是能进的');
  room.match.wave.index = 1;
  assert.equal(room.canJoinNow(), true, '第 1 波仍在中途加入窗口内');
  room.match.wave.index = 4;
  assert.equal(room.canJoinNow(), false, '第 4 波已经过了窗口（§12.3）');

  // 新面孔被拒，而且理由不是「房间已满」
  const b = await wsClient(port, `/ws?room=${helloA.roomCode}&name=乙`);
  const refused = await b.waitFor((m) => m.t === 'error');
  assert.equal(refused.code, 'in_progress', `拒绝理由要是「已开局」，实际 ${refused.code}`);
  assert.ok(!/满/.test(refused.text), `文案不该说「已满」，实际「${refused.text}」`);
  b.close();

  // 同一个 uid 断线回来：随便第几波都能回原位
  const slot0 = helloA.slot;
  a.close();
  await new Promise((r) => setTimeout(r, 200));
  const back = await wsClient(port, `/ws?room=${helloA.roomCode}&name=甲&uid=${helloA.playerId}`);
  const hello2 = await back.waitFor((m) => m.t === 'hello');
  assert.equal(hello2.slot, slot0, '重连要回原来那个座位');
  back.close();

  // 防守：窗口按时间算（3 分钟）
  const d = await wsClient(port, '/ws?name=丁&mode=defense&map=def_01');
  const helloD = await d.waitFor((m) => m.t === 'hello');
  const defRoom = game.registry.get(helloD.roomCode);
  assert.equal(defRoom.mode, 'defense');
  defRoom.match.time = 100;
  assert.equal(defRoom.canJoinNow(), true, '防守 100 秒时还能进');
  defRoom.match.time = 200;
  assert.equal(defRoom.canJoinNow(), false, '防守超过 3 分钟就不收新人了（§12.3）');
  const later = await wsClient(port, `/ws?room=${helloD.roomCode}&name=戊`);
  const lateRefused = await later.waitFor((m) => m.t === 'error');
  assert.equal(lateRefused.code, 'in_progress');
  later.close();
  d.close();
});

test('§1.5 快速匹配：按「模式+地图+难度」分桶、同桶进同一房、45 秒未满员即开局', { timeout: 20000 }, async (t) => {
  // 窗口调小到 300ms，用例不用真等 45 秒
  const game = createGameServer({ quiet: true, queueWindowMs: 300 });
  const port = await game.listen(0);
  t.after(() => game.close());

  const a = await wsClient(port, '/ws?name=甲&map=map_01&difficulty=normal&match=1');
  const helloA = await a.waitFor((m) => m.t === 'hello');
  const room = game.registry.get(helloA.roomCode);
  assert.equal(room.queued, true, '攒人窗口里不该推进对局');
  assert.equal(room.match.time, 0, '排队期间对局时间是 0');
  assert.deepEqual(game.queue.info(), [{ key: 'td|map_01|normal', players: 1, code: room.code }]);
  // §1.5 的「人数不足按 §1.6 缩放」也要在匹配房里生效：一个人排队 → 单人档（怪量 ×0.60）
  assert.deepEqual(room.match.scale, { count: 0.60, hp: 0.85, gold: 0.80 }, '匹配到 1 人就是单人档');

  // 第二个人：同一个桶 → 同一个房间
  const b = await wsClient(port, '/ws?name=乙&map=map_01&difficulty=normal&match=1');
  const helloB = await b.waitFor((m) => m.t === 'hello');
  assert.equal(helloB.roomCode, helloA.roomCode, '同桶必须进同一房');
  assert.notEqual(helloB.slot, helloA.slot, '两个人两个座位');
  assert.equal(game.registry.get(helloA.roomCode).match.players, 4, '房间仍按人数上限 4 建（§1.6 的缩放按名册走）');

  // 不同桶（换难度）→ 另一个房间
  const c = await wsClient(port, '/ws?name=丙&map=map_01&difficulty=hard&match=1');
  const helloC = await c.waitFor((m) => m.t === 'hello');
  assert.notEqual(helloC.roomCode, helloA.roomCode, '不同难度是不同桶');

  // 等窗口关闭：这一桶要开打（queued 置回 false，时间开始走）
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(game.registry.get(helloA.roomCode).queued, false, '窗口到点就该开局');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(game.registry.get(helloA.roomCode).match.time > 0, '开局之后对局时间要往前走');
  assert.deepEqual(game.queue.info(), [], '开过的桶要清掉');

  a.close(); b.close(); c.close();
});

// §10.3 的「多人局房间态保留 5 分钟」以前**没法验**：那条断言只能写成「房间要么还在、要么已回收」
// （等 5 分钟不现实）。`Room.sweep(now)` 是可注入时钟的，所以直接量边界——
// 差 1ms 不算超时、过 1ms 就该清人并回收房间。
test('§10.3 空房保留窗口：5 分钟内不掉人，超过才回收（时钟可注入）', async () => {
  const { Room } = await import('../src/server/room.js');
  let stopped = null;
  const room = new Room({ mapId: 'map_01', onEmpty: (code) => { stopped = code; } });
  const fake = { send: () => {}, on: () => {}, close: () => {} };
  const p = room.join(fake, '甲');
  assert.ok(p, '加入成功');
  assert.equal(room.players.size, 1);
  // 模拟断线：socket 置空 + 记下离场时刻（leave() 里就是这么写的）
  p.socket = null;
  p.absentSince = 1000;
  room.sweep(1000 + Room.emptyGraceMs);
  assert.equal(room.players.size, 1, '正好 5 分钟还不算超时（边界要留在窗内）');
  room.sweep(1000 + 60_000);
  assert.equal(room.players.size, 1, '1 分钟当然还在窗里');
  room.sweep(1000 + Room.emptyGraceMs + 1);
  assert.equal(room.players.size, 0, '过了窗口才清人');
  assert.equal(stopped, room.code, '人清空后房间要回收（否则 registry 永远涨）');
});

test('§1.5 快速匹配：排队的人立刻掉线，房间不会漏（窗口到点就自己回收）', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true, queueWindowMs: 200 });
  const port = await game.listen(0);
  t.after(() => game.close());

  const c = await wsClient(port, '/ws?name=孤单&map=map_01&match=1');
  const hello = await c.waitFor((m) => m.t === 'hello');
  const code = hello.roomCode;
  assert.ok(game.registry.get(code), '刚进队列时房间在');
  c.close();                                  // 立刻掉线，座位进入 5 分钟保留窗（§10.3）
  await new Promise((r) => setTimeout(r, 400));
  // 窗口关掉之后房间不再 queued；下一帧 tick 会走到 sweep，发现「全员离线超时」才对——
  // 但这里只要求「不会永远挂着」：房间要么还在（等 5 分钟保留窗），要么已经被回收
  const still = game.registry.get(code);
  assert.ok(still === null || still.queued === false, '窗口到点后不该还停在「攒人中」');
  assert.deepEqual(game.queue.info(), [], '队列桶要清掉（不然会一直往上叠人）');
});
test('§1.5 快速匹配：满员立刻开局，不等窗口', { timeout: 20000 }, async (t) => {
  const game = createGameServer({ quiet: true, queueWindowMs: 60000 });   // 窗口给得很大
  const port = await game.listen(0);
  t.after(() => game.close());

  const clients = [];
  let code = null;
  for (let i = 0; i < 4; i++) {
    const c = await wsClient(port, `/ws?name=P${i}&map=map_01&match=1`);
    const hello = await c.waitFor((m) => m.t === 'hello');
    clients.push({ c, hello });
    code = hello.roomCode;
  }
  const room = game.registry.get(code);
  assert.equal(room.players.size, 4, '四个人都在房里');
  assert.equal(room.queued, false, '满员就不该再等窗口（60 秒的窗口没到也开了）');
  clients.forEach(({ c }) => c.close());
});

// §120（§10.5 的「权威副本，版本号校验」）：握手串里带协议版本，不一致当场拒掉。
// 不校验的话，缓存了旧包的客户端会把新服务器的快照往旧形状的镜像上套——§102/§68 那类
// 「整页抛异常 / 字段悄悄对不上」的温床，而玩家的观感是「进不去，也没说为什么」。
test('§120 版本不一致的客户端被当场拒掉（错误码 version，且不进房）', { timeout: 15000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  // ① 旧客户端：版本号比服务端低
  const old = await wsClient(port, '/ws?name=旧客户端&map=map_01', PROTOCOL_VERSION - 1);
  const err = await old.waitFor((m) => m.t === 'error', 3000, '版本不一致的错误帧');
  assert.equal(err.code, 'version', '要用 version 这个错误码，客户端才知道「重连没用、得刷新」');
  assert.ok(/刷新/.test(err.text), `文案要告诉玩家怎么自救（实际「${err.text}」）`);
  assert.ok(!old.messages.some((x) => JSON.parse(x).t === 'hello'), '被拒的客户端不该收到 hello');
  old.close();

  // ② 连版本都不带的客户端（更老的缓存包）：同样拒掉，不能默认放行
  const bare = await wsClient(port, '/ws?name=更老&map=map_01', '');
  const err2 = await bare.waitFor((m) => m.t === 'error', 3000, '不带版本号的错误帧');
  assert.equal(err2.code, 'version', '不带版本 = 版本未知，不能默认放行');
  bare.close();

  // ③ 版本一致照常进房（对照组：这条要是也错，说明门槛设错了）
  const ok = await wsClient(port, '/ws?name=正常的&map=map_01');
  const hello = await ok.waitFor((m) => m.t === 'hello');
  assert.equal(game.registry.get(hello.roomCode).players.size, 1, '同版本客户端照常进房');
  ok.close();
});

// §121：URL 参数是玩家能手改的信任边界（分享链接也可能被改坏）。以前这一层只补默认值、
// 不校验非法值：`?map=bogus` 的**一次 WS 握手**就能让整个服务器进程退出；
// `?difficulty=bogus` 更阴——房间建得出来，30 秒后第一只怪出生读 `m.diff.hp` 才炸在 setInterval 里。
test('§121 畸形 URL 参数被归一化，且不会带崩服务端', { timeout: 15000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  // ① 地图名不存在 → 落回默认图（以前：WS 里直接抛「未知地图」，进程退出）
  const a = await wsClient(port, '/ws?name=坏图&map=bogus');
  const helloA = await a.waitFor((m) => m.t === 'hello');
  assert.equal(helloA.config.mapId, 'map_01', '未知地图要落回默认图，而不是抛异常');
  a.close();

  // ② 难度名不存在 → 落回普通，而且**第一次出怪不能炸**（以前就是这一步读 m.diff.hp 炸的）
  const b = await wsClient(port, '/ws?name=坏难度&map=map_01&difficulty=bogus');
  const helloB = await b.waitFor((m) => m.t === 'hello');
  const roomB = game.registry.get(helloB.roomCode);
  assert.equal(roomB.match.difficulty, 'normal', '未知难度要落回普通');
  roomB.match.wave.timer = 0;                                   // 逼出第一波
  assert.doesNotThrow(() => { for (let i = 0; i < 40; i += 1) roomB.tick(); }, '出怪不许抛异常');
  assert.ok(roomB.match.monsters.length > 0, '怪要真的出来了（否则这条断言什么都没验）');
  b.close();

  // ③ 长度 / 种子也要归一化（`seed=abc` 曾经变成 NaN 种子，随机会退化成常数）
  const c = await wsClient(port, '/ws?name=坏种子&map=map_01&length=bogus&seed=abc');
  const helloC = await c.waitFor((m) => m.t === 'hello');
  const roomC = game.registry.get(helloC.roomCode);
  assert.equal(roomC.match.length ?? 'short', 'short', '未知长度要落回短局');
  assert.ok(Number.isFinite(roomC.match.seed), `种子必须是有限数（实际 ${roomC.match.seed}）`);
  c.close();

  // ④ 对照组：`?mode=defense`（README 的正式入口）**没带图**也必须开成防守局。
  // 第一版归一化写成「模式一律由图决定」，就把这条正式入口变成了 TD 房（同文件那条防守镜像用例当场红了）
  const d = await wsClient(port, '/ws?name=防守入口&mode=defense');
  const helloD = await d.waitFor((m) => m.t === 'hello');
  assert.equal(helloD.config.mode, 'defense', '?mode=defense 不带图时也要是防守局');
  assert.equal(helloD.config.mapId, 'def_01', '防守局的默认图是 def_01');
  d.close();

  // ⑤ §177：**不传 seed 的房间不该都落在同一个常数种子上**。以前 `Number(null)` 是 0（也是有限数），
  // `Date.now()` 那条兜底永远跑不到 → 每间房的掉落/词条序列一模一样；显式 `?seed=0` 仍然要照用 0。
  const seedOf = async (qs) => {
    const s = await wsClient(port, qs);
    const code = (await s.waitFor((m) => m.t === 'hello')).roomCode;
    s.close();
    return game.registry.get(code).match.seed;
  };
  assert.notEqual(await seedOf('/ws?name=随机种&map=map_01'), 0, '不传 seed 时要用随机种子，不是常数 0');
  assert.equal(await seedOf('/ws?name=显式零&map=map_01&seed=0'), 0, '显式的 ?seed=0 要照用');
});

// §121 第二层：内核在**某一局里**抛异常，不许带走整个进程（`setInterval` 里的未捕获异常会让
// node 直接退出，线上表现是「所有人的房间一起掉」）。兜住它：通知房里的人、停表、退租。
test('§121 内核异常只停这一局：房里的人收到错误帧，房间退租，进程照常', { timeout: 15000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const c = await wsClient(port, '/ws?name=幽灵房&map=map_01');
  const hello = await c.waitFor((m) => m.t === 'hello');
  const room = game.registry.get(hello.roomCode);
  const code = room.code;
  room.match.monsters.push({});        // 幽灵怪：内核读它的 pathIndex/def 时会抛（模拟任何未来 bug）
  assert.doesNotThrow(() => room.tick(), 'tick 里的异常必须被兜住');
  const err = await c.waitFor((m) => m.t === 'error' && m.code === 'room_error', 3000, '房里的人要收到错误帧');
  assert.ok(/重开/.test(err.text), `错误文案要告诉玩家怎么办（实际「${err.text}」）`);
  assert.equal(room.timer, null, '这一局要停表');
  assert.equal(game.registry.get(code), null, '停掉的房间要退租，不再占着房间码');
  c.close();
});

// §122：名字是**别人能控制的输入**（它会被广播给全房、再渲染到别人的界面上）。服务端这层
// 只做长度截断（转义是客户端渲染时的事，见 ui.js 的 esc）——不截断的话一个 1MB 的名字
// 会进每一份广播，还会把别人的玩家面板撑爆。
test('§122 玩家名字在服务端被截断（名字广播给全房，不能让它无限长）', { timeout: 15000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const long = '名'.repeat(200);
  const c = await wsClient(port, `/ws?name=${encodeURIComponent(long)}&map=map_01`);
  const hello = await c.waitFor((m) => m.t === 'hello');
  assert.ok(hello.playerId, '还是得正常进房');
  const room = game.registry.get(hello.roomCode);
  // 名字不走 hello，而是之后广播的 joined 名单（hello.players 根本不存在，第一版就是读它才红的）
  const joined = await c.waitFor((m) => m.t === 'joined' || m.t === 'snap', 3000, '名单/快照');
  assert.ok(joined, '要收到名单或快照');
  assert.ok(room.playerList[0].name.length <= 12,
    `广播出去的名字要截断（实际 ${room.playerList[0].name.length} 字）`);
  // 顺带钉住：截断之后**仍然是完整字符**（别把多字节切坏成乱码）
  assert.equal(room.playerList[0].name, '名'.repeat(12), '截断要按字符切，不能切出半个字');
  c.close();
});

// §120 的反向：**客户端**也要查服务端的版本。这里起一个「假服务器」——它照常升级握手，
// 但 hello 里报一个别的版本号。客户端必须：报 version 错误、断开、**不再重连**（重连没意义）。
test('§120 服务端版本不一致时，客户端报错并停止重连（不拿形状不对的快照去套镜像）', { timeout: 15000 }, async (t) => {
  const { createServer } = await import('node:http');
  const { upgrade } = await import('../src/server/ws.js');
  const server = createServer();
  const sockets = [];
  server.on('upgrade', (req, socket) => {
    const conn = upgrade(req, socket);
    if (!conn) return;
    sockets.push(socket);
    // 故意报一个别的版本号：客户端应当**在看到快照之前**就拒绝这份 hello
    conn.send(JSON.stringify({
      t: 'hello', v: PROTOCOL_VERSION + 7, roomCode: 'ZZZZZZ', playerId: 'p1', slot: 0,
      s: { t: 0, w: [0, 0, 0, 0, 12], core: [1, 1], hero: [0, 1, 0, 1, 0, 0, [0, 0, 0], [1, 0, 0]], gold: 0, st: [0, 0], result: 0, mon: [] },
      me: { lumber: 0, bag: {}, potionCd: {}, shopBought: {}, equipped: {}, inventory: [] },
    }));
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  t.after(() => { sockets.forEach((s) => s.destroy()); server.close(); });

  const { connect } = await import('../src/net.js');
  const seen = { errors: [], status: [], snapshots: 0 };
  const net = connect({
    url: `ws://127.0.0.1:${port}/ws`,
    name: '测试机',
    onSnapshot: () => { seen.snapshots += 1; },
    onError: (m) => seen.errors.push(m.code),
    onStatus: (s) => seen.status.push(!!s.connected),
  });
  const t0 = Date.now();
  while (!seen.errors.length && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 400));   // 再等一会儿：如果它偷偷重连，这里会多出一次 connected

  assert.deepEqual(seen.errors, ['version'], `客户端要报 version（实际 ${JSON.stringify(seen.errors)}）`);
  assert.equal(seen.snapshots, 0, '版本不对时**不该**拿这份快照去改镜像');
  assert.ok(net.reconnectInfo().stopped, '版本不一致不是网络问题，重连没有意义（stopped 必须为真）');
  // 注意：WS 握手是先成功的（`onopen` 会把状态置成已连接），版本检查是**应用层**那一步。
  // 所以这里断的是「最后停在断开」，不是「从没连过」——后者物理上做不到。
  assert.equal(seen.status.at(-1), false, '被拒之后状态要停在「未连接」，不能停在「已连上」');
  net.close();
});

// §3.1 #24 的另一半：**本机身份失效时客户端要换一个新身份**，而不是拿着旧 uid 一直撞墙。
// 真实场景：玩家清过站点存储（或这个 uid 在另一台设备上登记过），服务端记着的 token 与本机对不上，
// 于是每次握手都被「身份校验失败」挡回来——玩家看到的是一句报错，然后什么都点不动。
test('§3.1 #24 服务端说「身份校验失败」时，客户端换一个新 uid 重连一次（只换一次）', { timeout: 15000 }, async (t) => {
  const { createServer } = await import('node:http');
  const { upgrade } = await import('../src/server/ws.js');
  const server = createServer();
  const sockets = [];
  const uids = [];
  server.on('upgrade', (req, socket) => {
    const conn = upgrade(req, socket);
    if (!conn) return;
    sockets.push(socket);
    const uid = new URL(req.url, 'http://x').searchParams.get('uid');
    uids.push(uid);
    if (uids.length === 1) {   // 第一条连接：就是那个「身份对不上」的
      conn.send(JSON.stringify({ t: 'error', code: 'identity', text: '身份校验失败：这个身份已绑定到别的设备' }));
      conn.close();
      return;
    }
    conn.send(JSON.stringify({
      t: 'hello', v: PROTOCOL_VERSION, roomCode: 'ZZZZZZ', playerId: uid, playerCount: 1, slot: 0,
      s: { t: 0, w: [0, 0, 0, 0, 12], core: [1, 1], hero: [0, 1, 0, 1, 0, 0, [0, 0, 0], [1, 0, 0]], gold: 0, st: [0, 0], result: 0, mon: [] },
      me: { lumber: 0, bag: {}, potionCd: {}, shopBought: {}, equipped: {}, inventory: [] },
    }));
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  t.after(() => { sockets.forEach((s) => s.destroy()); server.close(); });

  const { connect } = await import('../src/net.js');
  const seen = { notices: [], rooms: [], errors: [] };
  const net = connect({
    url: `ws://127.0.0.1:${port}/ws`,
    name: '换身份的玩家',
    onNotice: (text) => seen.notices.push(text),
    onError: (m) => seen.errors.push(m.code),
    onStatus: () => {},
    onHello: (message) => { seen.rooms.push(message.roomCode); return false; },
  });
  const t0 = Date.now();
  while (!seen.rooms.length && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));

  assert.equal(uids.length, 2, `要正好重连一次（实际连了 ${uids.length} 次）`);
  assert.ok(uids[0] && uids[1] && uids[0] !== uids[1], `换的新 uid 必须不一样（${uids[0]} → ${uids[1]}）`);
  assert.deepEqual(seen.rooms, ['ZZZZZZ'], '第二次握手要真的进房');
  assert.ok(seen.notices.some((x) => x.includes('身份')), `要告诉玩家换了身份：${JSON.stringify(seen.notices)}`);
  assert.equal(net.state.error, null, '换了身份之后不该留着一个红字错误');
  net.close();
});

// §123：畸形**指令值**（形状对、值离谱）不许把服务器弄死。现场是一条真实事故：
// `{t:'build', slot:'abc'}` —— 字符串跟数字比大小永远为 false，两道范围检查形同虚设。
test('§123 畸形指令值不会弄死服务端（内核拒绝 + 房间照常跑）', { timeout: 15000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const c = await wsClient(port, '/ws?name=捣乱的&map=map_01');
  const hello = await c.waitFor((m) => m.t === 'hello');
  const room = game.registry.get(hello.roomCode);
  room.match.gold = 5000;

  const hostile = [
    { t: 'build', slot: 'abc', towerId: 'tw_arrow' },     // ← 真凶
    { t: 'build', slot: 1.5, towerId: 'tw_arrow' },
    { t: 'build', slot: 999, towerId: 'tw_arrow' },
    { t: 'build', slot: 0, towerId: null },
    { t: 'upgrade', slot: 'abc' }, { t: 'sell', slot: 'abc' },
    { t: 'priority', slot: 0, priority: 'bogus' },
    { t: 'cast', index: 99 }, { t: 'cast', index: 'x' },
    { t: 'buy', itemId: 'nope' }, { t: 'potion', itemId: null },
    { t: 'craft', slot: 0, quality: 'mythic' }, { t: 'equip', uid: 999 },
    { t: 'enhance', uid: 'x' }, { t: 'sellitem', uid: {} },
    { t: 'move', x: 1e9, y: -1e9 }, { t: 'fort', slot: 99, fortId: 'nope' },
    { t: 'repairTower', slot: 'abc' }, { t: 'resync' }, { t: 42 }, {},
  ];
  for (const cmd of hostile) c.send(cmd);
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(room.match.towers.length, 0, '一条都不该建出来（畸形值只能是拒绝，不能建了半座）');
  assert.notEqual(room.timer, null, '这一局必须还在跑（以前是进程直接退出）');
  const snapsBefore = c.messages.length;
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(c.messages.length > snapsBefore, `畸形指令不该掐断广播（${snapsBefore} → ${c.messages.length}）`);
  c.close();
});

// §123 第二层：就算某条指令让内核抛了（未来的 bug 也一样），也只该「这条指令失败」，
// 不许像以前那样把整个进程带走——所以这里**故意**把 applyCommand 换成会抛的函数。
test('§123 指令处理里抛异常只丢这一条（房间与进程都不受影响）', { timeout: 15000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const c = await wsClient(port, '/ws?name=炸指令&map=map_01');
  const hello = await c.waitFor((m) => m.t === 'hello');
  const room = game.registry.get(hello.roomCode);
  room.applyCommand = () => { throw new Error('模拟内核 bug'); };
  c.send({ t: 'ping' });
  const err = await c.waitFor((m) => m.t === 'error' && m.code === 'bad_command', 3000, 'bad_command 错误帧');
  assert.ok(/处理不了/.test(err.text), `要给一句人话（实际「${err.text}」）`);
  assert.notEqual(room.timer, null, '房间要照常跑');
  c.close();
});

// §125：uid 就是这一版的身份凭证（§8.2「uid 才是身份」），而名单是**广播给全房**的。
// 以前每个人的 uid 都跟着名单发出去 → 房间里任何人拿它重连就能顶掉原主人（实测：受害者连接当场被关）。
// 现在名单只带渲染要用的字段；自己的 id 仍然是私发的（hello.playerId）。
test('§125 名单里不广播 uid（只带 name / slot / online），自己的 id 仍然私发', { timeout: 15000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());

  const a = await wsClient(port, '/ws?name=甲&uid=ua-secret&map=map_01');
  const helloA = await a.waitFor((m) => m.t === 'hello');
  assert.equal(helloA.playerId, 'ua-secret', '自己的 id 要私发给自己（不然客户端认不出自己）');

  const b = await wsClient(port, `/ws?room=${helloA.roomCode}&name=乙&uid=ub-secret`);   // 同一个房
  const helloB = await b.waitFor((m) => m.t === 'hello');
  const joined = await b.waitFor((m) => m.t === 'joined' && m.players.length >= 2, 5000, '两人的名单');
  assert.equal(joined.players.length, 2);
  assert.deepEqual(Object.keys(joined.players[0]).sort(), ['name', 'online', 'slot'],
    `名单里只该有 name/slot/online（实际 ${Object.keys(joined.players[0]).join('/')}）`);
  // 名单里不许出现任何人的 uid（自己的也不行——面板按 slot 认自己）；
  // 但**自己的** id 仍要私发（`joined.playerId`，客户端靠它认自己）
  assert.ok(!JSON.stringify(joined.players).includes('ua-secret'), '别人的 uid 不许出现');
  assert.ok(!JSON.stringify(joined.players).includes('ub-secret'), '名单里连自己的 uid 也不要');
  assert.equal(joined.playerId, 'ub-secret', '自己的 id 还是要私发给自己');
  // 名字与座号还得照旧（面板按 slot 认自己，缺了就画错）
  assert.deepEqual(joined.players.map((p) => [p.slot, p.name]), [[0, '甲'], [1, '乙']]);
  assert.equal(helloB.slot, 1);
  a.close(); b.close();
});

// §126：把「URL 参数 = 信任边界」这件事钉成一条**结构**检查。
// §121（`?map=bogus` 弄死进程）、§122（名字进 HTML）、§123（`slot:'abc'` 弄死进程）、§125（uid 外泄）
// 都是同一个形状：某个参数在某处被直接拿来用。所以：**开局参数只许从 roomOptions 进**（那里做归一化），
// 其余只读参数（v / room / name / uid / match）必须列在白名单里。新加参数时这张表会红，逼你想一次。
test('§126 服务端读 URL 参数只有一处入口：开局参数必须走 roomOptions（其余在白名单里）', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/server/game-server.js', import.meta.url), 'utf8');
  const start = src.indexOf('function roomOptions(');
  assert.ok(start > 0, '找不到 roomOptions');
  const end = src.indexOf('\n}', start);
  // 只读/已单独处理的：`v` 版本、`room` 房码、`name` 显示名、`uid` + `tok` 身份（§3.1 #24）、`match` 队列
  const RAW_OK = new Set(['v', 'room', 'name', 'uid', 'tok', 'match']);
  const hookStart = src.indexOf('function applyDebugHooks(');     // 调试钩子：单独一处，且默认关
  const hookEnd = src.indexOf('\n}', hookStart);
  const offenders = [];
  for (const m of src.matchAll(/searchParams\.get\('([a-zA-Z_]+)'\)/g)) {
    const key = m[1];
    const inRoomOptions = m.index > start && m.index < end;
    const inDebugHooks = m.index > hookStart && m.index < hookEnd;
    if (!inRoomOptions && !inDebugHooks && !RAW_OK.has(key)) {
      offenders.push(`${key}（${src.slice(0, m.index).split('\n').length} 行，在 roomOptions 之外）`);
    }
  }
  assert.deepEqual(offenders, [],
    `这些参数绕过了 roomOptions（要么搬进去归一化，要么写清为什么可以裸用）：\n${offenders.join('\n')}`);
  // 反向：roomOptions 必须真的在校验（不是把参数原样传下去）
  const body = src.slice(start, end);
  for (const key of ['map', 'mode', 'difficulty', 'hero', 'length', 'seed']) {
    assert.ok(body.includes(`searchParams.get('${key}')`), `roomOptions 该读 ${key}`);
  }
  assert.ok(/Number\.isFinite/.test(body), 'seed 要有有限性检查（NaN 种子会让随机退化）');
  // 调试钩子必须是**显式打开**的（默认关）：否则 `?wave=12` 就是一个人人可用的后门
  assert.ok(hookStart > 0, '调试钩子要单独成一个函数');
  assert.ok(/if \(debugHooks\) applyDebugHooks\(/.test(src), '调试钩子必须由 debugHooks 开关控制');
  assert.ok(/debugHooks = false/.test(src), 'debugHooks 默认必须是 false');
});

// §126：把上面那条结构检查落成**行为**检查——默认起服时 `?wave=12` 不许把房间快进。
test('§126 调试钩子默认关着：`/create?wave=12` 不会把房间推到第 12 波（除非显式打开）', { timeout: 15000 }, async (t) => {
  const off = createGameServer({ quiet: true });
  const port = await off.listen(0);
  t.after(() => off.close());
  const plain = await (await fetch(`http://127.0.0.1:${port}/create?map=map_01&wave=12`)).json();
  assert.equal(plain.wave, 0, '默认不许快进（以前 ?wave=12 对所有人开放）');

  const on = createGameServer({ quiet: true, debugHooks: true });
  const port2 = await on.listen(0);
  t.after(() => on.close());
  const hooked = await (await fetch(`http://127.0.0.1:${port2}/create?map=map_01&wave=12`)).json();
  // 这条**偶发红过一次**（整包跑、并发压满时）：`hooked.wave` 是 `undefined`，说明那一发 `/create`
  // 回了没有 `wave` 字段的 JSON（服务端 catch 里的 `{ error }`）。单跑 net.test.js 5/5 绿、
  // 直连打 300 发也一发不差，原因还没钉住——所以这里把**服务端的原话**带进断言消息里，
  // 下次再红就能直接看到它到底报了什么错（见验证记录 §146）。
  assert.equal(hooked.wave, 12, `显式打开之后快进照常可用（冒烟靠它验中途加入窗口）；响应=${JSON.stringify(hooked)}`);
});

/**
 * §157：**临时端口只绑 127.0.0.1**，以及**握手失败要自己收掉 socket**。
 * 这两个是同一个事故的两半（实测，`lsof` 抓的现场）：
 *   node 46040      TCP 127.0.0.1:53612->127.0.0.1:53611 ESTABLISHED
 *   jetbrains 24826 TCP 127.0.0.1:53611 (LISTEN)        ← 对面是 IDE，不是我们刚起的服务器
 * `listen(0)` 不带 host 时绑的是 `::`（双栈）：另一个程序占着 v4 的同一个临时端口时我们照样绑得上，
 * 而客户端连 `127.0.0.1:port` 就走进了**别人的服务器**——要么握手收到 404（§150 那次），
 * 要么永远等不到 hello（§146.1 那个 3 小时的僵尸 `npm test`）。连错之后 socket 一直开着，
 * node --test 的 worker 因此永远不退出——「挂死」就是这么来的。
 */
test('§157 listen(0) 只绑 127.0.0.1（别让双栈把临时端口借给别人的 v4 服务）', { timeout: 5000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());
  const addr = game.server.address();
  assert.equal(addr.address, '127.0.0.1', `临时端口要绑在 v4 回环上，实际 ${addr.address}:${port}`);
  const hello = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.ok(hello.length > 0, '绑 127.0.0.1 之后本机仍然连得上');
});

test('§157 握手失败（对端回 404）要把 socket 收掉：否则测试进程永远不退出', { timeout: 5000 }, async () => {
  // 一个「不是 WebSocket 服务器」的对端：握手一定失败，而且它会一直把连接挂着（不主动关）
  const fake = createHttpServer((req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope'); });
  let closed = false;
  fake.on('connection', (s) => s.on('close', () => { closed = true; }));
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const port = fake.address().port;
  try {
    await assert.rejects(() => wsClient(port, '/ws?name=测'), /握手失败/);
    await new Promise((r) => setTimeout(r, 150));   // 等 FIN 走完
    assert.equal(closed, true, '握手失败之后这条连接必须被关掉（不关就吊住整个 worker）');
  } finally {
    fake.close();
    fake.closeAllConnections?.();
  }
});

// §146：**绑定失败必须 reject**。这块以前只挂了成功回调（`new Promise((resolve) => server.listen(...))`）——
// 端口被占时没人接住 `error` 事件，net.Server 就把它抛成**未捕获异常**，落到当时正在跑的那条用例头上：
// 报错位置和被怀疑的地方完全不是一个东西（冒烟给服务器起服单独写了「换端口重试」，就是这个坑逼出来的）。
// 现在 `await listen()` 拿到 EADDRINUSE，能重试也能断言——这条就是断言它。
// §186：静态资源要**按需 gzip**。§10.7 的首屏预算（低端 4G ≤ 3 秒）本来只在 localhost 量过，
// 用 CDP 把网络压到 1.6 Mbps / 300ms RTT 再叠 4× CPU 节流，实测首屏 **3.25 秒**（超线）；
// 这一包是 20 个模块，文本压缩率 2-3 倍，压完 2.38 秒。这条钉两件事：说要 gzip 就给压缩的
// （解压后与明文**逐字节一致**），没说要 gzip 就不压（别把客户端弄坏）。
// §199：**房间回收之后注册表不许再留引用**。以前 `retire()` 会把退役的房间塞进第二张表 `stopped`
// （注释写着「用于同码重连」，可那张表**只写不读**：`get()` 只看 `rooms`，`until` 没人读、也没人清理）。
// 服务器跑得越久攒得越多，每间退役的房都带着自己那份 `match` 常驻内存（刚建房的空房就有 4.9KB，
// 打过一局的更大）。这条钉住「回收＝摘掉」：`rooms` 清空，注册表里的 Map 不许有第二张。
test('§199 房间回收后注册表不留引用（`stopped` 那张只写不读的表已删）', { timeout: 10000 }, async (t) => {
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());
  const codes = [];
  for (let i = 0; i < 5; i += 1) {
    codes.push((await (await fetch(`http://127.0.0.1:${port}/create?map=map_01&mode=td`)).json()).code);
  }
  assert.equal(game.registry.rooms.size, 5, '五间房都在注册表里');
  for (const c of codes) game.registry.get(c).stop();   // 等价于空房 sweep：停表 + 从注册表摘掉
  assert.equal(game.registry.rooms.size, 0, '回收之后 rooms 必须清空');
  const maps = Object.entries(game.registry).filter(([, v]) => v instanceof Map);
  assert.deepEqual(maps.map(([k, m]) => `${k}:${m.size}`), ['rooms:0'],
    '注册表里只该有 rooms 这一张 Map，而且要空——第二张就是「攒着退役房间」的漏');
});

test('§186 静态资源按需 gzip（解压后与明文一致；没说要 gzip 的客户端拿到的还是明文）', { timeout: 10000 }, async (t) => {
  const { request } = await import('node:http');
  const { gunzipSync } = await import('node:zlib');
  const game = createGameServer({ quiet: true });
  const port = await game.listen(0);
  t.after(() => game.close());
  const get = (path, headers) => new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, ce: res.headers['content-encoding'] ?? null, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
  const gz = await get('/index.html', { 'accept-encoding': 'gzip' });
  const plain = await get('/index.html', {});
  assert.equal(gz.status, 200);
  assert.equal(gz.ce, 'gzip', '说好了要 gzip 就该给压缩的');
  assert.ok(gz.body.length < plain.body.length, `压完要更小（${gz.body.length} vs ${plain.body.length}）`);
  assert.ok(gunzipSync(gz.body).equals(plain.body), '解压后必须与明文逐字节一致');
  assert.equal(plain.ce, null, '没说要 gzip 的客户端不许收到压缩体');
});

test('§146 端口被占时 listen() 要 reject（错误落在 await 那一行，不甩给别的用例）', { timeout: 5000 }, async (t) => {
  const first = createGameServer({ quiet: true });
  const port = await first.listen(0);
  t.after(() => first.close());
  const second = createGameServer({ quiet: true });
  t.after(() => second.close());
  // §157 之后 `listen(0)` 只绑 127.0.0.1——要造「端口被占」就得**同一族**去占（v4 对 v4），
  // 不然第二次绑定会在 v6 那一半上成功（双栈本来就允许这么绑）。
  await assert.rejects(() => second.listen(port, '127.0.0.1'), (err) => {
    assert.equal(err.code, 'EADDRINUSE', `要拿到系统的绑定错误，实际：${err.code ?? err.message}`);
    return true;
  });
});
