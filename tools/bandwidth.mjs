// 带宽实测：起一个房间，灌入一局中期的怪量，统计单客户端每秒收到多少字节。
// 用法： node tools/bandwidth.mjs [seconds]
import { createGameServer } from '../src/server/game-server.js';
import { clientFrame } from '../src/server/ws.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import { connect as tcpConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

const seconds = Number(process.argv[2] ?? 8);
const game = createGameServer({ quiet: true });
const port = await game.listen(0);
const room = game.registry.create({ mapId: 'map_01', difficulty: 'normal' });

let bytes = 0;
let firstChunk = null;
let chunks = 0;
const socket = tcpConnect(port, '127.0.0.1', () => {
  const key = randomBytes(16).toString('base64');
  // 请求行必须是 ASCII（同一个坑第三处：昵称要 percent-encode）
  const q = new URLSearchParams({ room: room.code, name: 'meter', v: String(PROTOCOL_VERSION) });   // §120
  socket.write([`GET /ws?${q} HTTP/1.1`, 'Host: 127.0.0.1',
    'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
});
socket.on('data', (d) => {
  bytes += d.length;
  chunks += 1;
  if (firstChunk == null) {
    firstChunk = d.length;
    console.log('首个数据块：', JSON.stringify(d.subarray(0, 120).toString('latin1')));
  }
});

// **必须先让计量客户端进房，再预热**：房间推到第 9-10 波之后 `canJoinNow()` 就是 false（§12.3），
// 那时候才连上来会被服务端直接拒掉——客户端只收到 252 字节的握手头，工具却照样打印「✅ 达标」。
// 这个坑在 §71 加上中途加入窗口之后就存在了：**一个从不失败的测量**（验证记录 §110）。
for (let i = 0; i < 50 && room.players.size === 0; i++) await new Promise((r) => setTimeout(r, 20));
if (room.players.size === 0) {
  console.error('❌ 计量客户端没进房（房间码被拒？）——这次测量是空的，不给出达标结论');
  await game.close();
  process.exit(1);
}

// 再推进内核到中后期（塔阵成型 + 怪量上来）
const { autoPlay } = await import('../src/ai.js');
autoPlay(room.match, { maxSeconds: 600, untilWave: 9 });   // 停在 9-10 波：这一波有 26-30 只
room.match.result = null; // 忽略 AI 打出的胜负，只计量
// 拆掉所有塔，让怪堆在场上 —— 这才是实体数的峰值场景（§6.4.2 估的峰值约 50）
const { sellTower } = await import('../src/match.js');
for (const t of [...room.match.towers]) sellTower(room.match, t.slot);
console.log(`预热完成：第 ${room.match.wave.index} 波 · 场上 ${room.match.monsters.length} 只 · 塔 ${room.match.towers.length} 座 · 房内 ${room.players.size} 人`);

// 让测量窗口内有真实战场：立刻开波
room.match.wave.timer = 0;
const bytes0 = bytes;
await new Promise((r) => setTimeout(r, seconds * 1000));
const kbs = bytes / seconds / 1024;
const windowBytes = bytes - bytes0;
console.log(`握手首包 ${firstChunk ?? 0} 字节 · 测量窗口内 ${windowBytes} 字节 / ${chunks} 个块 · 场上 ${room.match.monsters.length} 只`);
console.log(`单客户端下行：${kbs.toFixed(2)} KB/s（${seconds}s 内 ${bytes} 字节）· 预算 15 KB/s · ${kbs <= 15 ? '✅ 达标' : '❌ 超标'}`);
// 窗口里一个块都没有 = 测的是空连接，这种「达标」没有意义（这个坑真的发生过）
if (windowBytes === 0) {
  console.error('❌ 测量窗口里一个数据块都没收到——服务端没在推快照，这次测量无效');
  await game.close();
  process.exit(1);
}
await game.close();
process.exit(kbs <= 15 ? 0 : 1);
