// 零依赖游戏服务器：静态资源 + WebSocket 房间（§10.2）。
// 房间跑权威内核（room.js），每个房间一个 20Hz 定时器。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { RoomRegistry } from './room.js';
import { MatchQueue } from './match-queue.js';
import { upgrade } from './ws.js';
import { msg, PROTOCOL_VERSION } from '../protocol.js';
import { normalizeChoice } from '../data.js';
import { ProfileStore } from './profiles.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.md': 'text/markdown; charset=utf-8',
};
/**
 * §186：**静态资源按需 gzip**。§10.7 那条首屏预算是「低端 4G ≤ 3 秒」，而这一包是 20 个模块 +
 * 样式 + HTML（未压缩约 388 KB）：1.6 Mbps 的链路上光传输就得 1.9 秒，再叠模块图那几跳 RTT，
 * 实测 **3.25 秒**（超线）。文本压缩率 2-3 倍，压完实测 2.38 秒（验证记录 §186）。
 * 只压文本类型、只在客户端说要 gzip 时压（图片/音频压了反而更大）。零依赖：`node:zlib`。
 */
const TEXTY = /^(text\/|application\/(javascript|json))/;
function sendMaybeGzip(req, res, body, type) {
  if (!/\bgzip\b/.test(req.headers['accept-encoding'] ?? '') || body.length < 1024 || !TEXTY.test(type)) return false;
  const gz = gzipSync(body);
  res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip', 'content-length': gz.length, vary: 'accept-encoding' });
  res.end(gz);
  return true;
}

/**
 * 开局参数。**模式是推出来的**：给了 mode 就用它，否则看地图 id 前缀（def_* = 防守）。
 * /create 与 /ws 必须用同一条规则——两边各写一份的话，「客户端忘了带 mode」就会在
 * 其中一边变成「未知地图 def_01」的 500（防守模式点「创建联机房间」正是这么坏的）。
 *
 * §121：**这里也是信任边界**——URL 是玩家能手改的（分享链接也可能被改坏）。以前这一层只做
 * 「缺参数就补默认」，非法值原样往下传：`?map=bogus&v=1` 的**一次 WS 握手**会让
 * `createMatch` 抛 `未知地图`，而 upgrade 回调里没人接，**整个服务器进程当场退出**；
 * `?difficulty=bogus` 更阴——房间建得出来（200），30 秒后第一只怪出生时读 `m.diff.hp`
 * 才炸，炸在 `setInterval` 里，谁也没法接（验证记录 §121）。现在非法值一律**归一化**成默认值，
 * 保证 create* 永远不抛。
 */
function roomOptions(url) {
  // 归一化的规则只有一份（§177 把它提到 data.js 的 `normalizeChoice`，客户端与这里共用）：
  // 模式可推、地图必须与模式相符、其余非法值落回默认，**保证 create* 永远不抛**
  // （WS 那条路上抛一下就是整个服务器进程退出，见 §121）。
  // 客户端进房后会按 hello 里的 config 把镜像对齐过来（§102 的机制）。
  const c = normalizeChoice({
    mode: url.searchParams.get('mode'),
    map: url.searchParams.get('map') ?? '',
    difficulty: url.searchParams.get('difficulty'),
    hero: url.searchParams.get('hero'),
    length: url.searchParams.get('length'),
  });
  // §177：缺 `seed` 时 `Number(null)` 是 **0**（也是有限数），`Date.now()` 那条兜底因此
  // **永远跑不到**——所有没带种子的房间都是 seed 0（掉落/词条的随机序列每间房一模一样）。
  // 现在：给了数字就用（含显式 0），其余才兜底；`% 1e6 || 1` 保证兜底结果不为 0。
  const rawSeed = url.searchParams.get('seed');
  const wantSeed = Number(rawSeed);
  return {
    mode: c.mode,
    mapId: c.map,
    difficulty: c.difficulty,
    heroId: c.hero,
    length: c.length,
    seed: rawSeed !== null && rawSeed !== '' && Number.isFinite(wantSeed) ? wantSeed : (Date.now() % 1e6 || 1),
  };
}

// 注意：不要用 URL.pathname 当文件根 —— 它是百分号编码的，路径含中文时静态资源会全部 404
/**
 * §126：**调试钩子**（只有起服时显式打开才生效）。
 * `/create?wave=4` 会把新房间直接推到第 4 波——冒烟靠它验「越过中途加入窗口 → 客户端转单人继续」。
 * 这对玩家等于后门（改个分享链接就能用），所以默认关。
 */
function applyDebugHooks(room, url) {
  const wave = Number(url.searchParams.get('wave'));
  if (Number.isFinite(wave) && wave > 0 && room.match.wave) room.match.wave.index = wave;
  // 让「一局马上结束」也能被验：直接指定结果（`?result=lose`）。冒烟靠它验**联机的结算面板**——
  // 那是玩家每局都会看到的一页，此前只有单机侧验过四种结局。
  // 为什么不走「核心压到 1 血」那种玩法钩子：实测英雄会把第一波怪清光（120 秒游戏时间内零漏怪），
  // 逼不出必然的负局，反而要等更久（见验证记录 §130）。
  /**
   * `?result=win|lose`：让「一局马上结束」也能被验（冒烟靠它验结算面板）。
   * §149：带上 `?resultAfter=N` 就**先真打 N 秒再判**——`?result=` 是建房那一刻就判定，
   * 那一局根本没打过（本局数据全是 0、伤害账本是空的），于是「打完一局之后的结算面板」
   * 在冒烟里永远看不到真数据（联机那页的伤害占比就是这么漏过去的）。
   * `resultAfter` 生效时**不能**顺手把 result 立刻设上：那一设，玩家进房看到的就是结算面板。
   */
  const wantResult = url.searchParams.get('result');
  const resultAfter = Number(url.searchParams.get('resultAfter'));
  const delayed = Number.isFinite(resultAfter) && resultAfter > 0;
  if (wantResult === 'win' || wantResult === 'lose') {
    if (delayed) setTimeout(() => { if (!room.match.result) room.match.result = wantResult; }, resultAfter * 1000).unref?.();
    else room.match.result = wantResult;
  }
  // §131：防守「守住 4 轮 → 转无尽」那一刻（`endless=true` + `result='win'`）在真实对局里要等
  // 12 分钟才到，冒烟靠这个钩子把它造出来，验「继续（无尽）」这个出口。
  if (url.searchParams.get('endless') === '1' && room.match.assault) {
    room.match.assault.endless = true;
    room.match.result = 'win';
  }
}

export function createGameServer({
  root = fileURLToPath(new URL('../../', import.meta.url)),
  quiet = false,
  dataDir = null,          // 给了就把局外档案落盘（默认不落盘：测试与临时起服不该写用户目录）
  queueWindowMs = 45000,   // §1.5 快速匹配的攒人窗口（用例传小值就不用等 45 秒）
  debugHooks = false,      // §126：`?wave=` 这类调试钩子，默认关（冒烟起服时显式打开）
} = {}) {
  const registry = new RoomRegistry();
  const queue = new MatchQueue({ windowMs: queueWindowMs, onStart: (room) => log(`[queue] ${room.code} 开打（${room.players.size} 人）`) });
  const profiles = new ProfileStore({ file: dataDir ? join(dataDir, 'profiles.json') : null });
  /**
   * STATUS §3.1 #24（已拍板）：**设备级 token**——uid 之外再加一道。
   *
   * 为什么需要：M0.5 的身份就是 uid（§8.2），§125 只堵住了「名单广播 uid」这一半；
   * **知道你 uid 的人**仍然能用它重连、顶掉你的座位与个人资源（§10.3 把座位交给后到的同 uid）。
   * 而 uid 是客户端自己生成的短字符串，猜/看一次就够。M3 的 `wx.login → 自签 token` 才是终态，
   * 在那之前用设备级 token 先顶上：客户端首次落一个随机串存 localStorage，重连时 `uid + token` 都要对。
   *
   * 边界（写清楚，免得当成安全边界）：**第一次握手没带 token 的 uid 会被记为「没有令牌」**，
   * 此后它也只能用「不带 token」的身份进来——第三方客户端照样能自造一个新 uid 玩，
   * 这里防的是「冒用**别人**的 uid」，不是「不许连服务器」。
   */
  const uidTokens = new Map();
  const tokenOk = (uid, tok) => {
    if (!uid) return true;
    const known = uidTokens.get(uid);
    if (known) return tok === known;      // 这个 uid 有令牌：必须对上
    uidTokens.set(uid, tok ?? null);      // 第一次见到：记下它带的令牌（可能没有）
    return true;
  };
  const baseDir = root;
  const log = (...args) => { if (!quiet) console.log(...args); };
  const upgraded = new Set(); // HTTP 服务器不跟踪 upgrade 后的长连接，得自己收着

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      // 单个坏请求不该弄死整个进程（线上表现会变成「所有人的房间一起掉」）
      log(`[http] ${req.method} ${req.url} 处理失败：${err.message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/create') {
      const room = registry.create({ ...roomOptions(url), profiles });
      // §126：调试钩子默认**关着**（`?wave=4` 能把一局直接推到第 4 波）。以前它对所有人开放——
      // 分享链接改一个参数就能用，等于线上留了个后门。冒烟起服时显式打开（FF_DEBUG_HOOKS=1）。
      if (debugHooks) applyDebugHooks(room, url);
      log(`[room] 新建 ${room.code} ${room.match.mapId}/${room.match.difficulty}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(room.info()));
      return;
    }
    const urlPath = decodeURIComponent(url.pathname);
    let filePath = join(baseDir, normalize(urlPath === '/' ? '/index.html' : urlPath));
    if (!filePath.startsWith(baseDir)) { res.writeHead(403).end('forbidden'); return; }
    if ((await stat(filePath).catch(() => null))?.isDirectory()) filePath = join(filePath, 'index.html');
    const body = await readFile(filePath).catch(() => null);
    if (!body) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found'); return; }
    const type = TYPES[extname(filePath)] ?? 'application/octet-stream';
    if (sendMaybeGzip(req, res, body, type)) return;   // §186：压了就它自己收尾
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  }

  // WebSocket 握手：/ws?room=CODE&name=xxx（不带 room 就自动建房）
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const conn = upgrade(req, socket);
    if (!conn) return;
    // §121：HTTP 那条路早就有这层保护（「单个坏请求不该弄死整个进程」），WS 这边一直没有——
    // 而它同样在建房、进房、读参数。补上：**任何**异常都只关掉这一条连接，不带走整个进程。
    try {
      onSocket(conn, url);
    } catch (err) {
      log(`[ws] ${req.url} 处理失败：${err.message}`);
      try { conn.send(JSON.stringify(msg.error(`开房失败：${err.message}`, 'server_error'))); } catch { /* 连接已经坏了 */ }
      conn.close();
    }
  });

  function onSocket(conn, url) {
    // §120（§10.5 那张表的「权威副本，**版本号校验**」）：客户端在握手串里带上自己那份配置表的
    // 协议版本，不一致就**当场拒掉**。不校验的话，一个缓存了旧包的客户端会把新服务器的快照
    // 往旧形状的镜像上套——正是 §102/§68 那类「整页抛异常 / 字段对不上」的温床，
    // 而玩家的观感是「进不去，也没说为什么」。这里的文案直接进 toast。
    if (Number(url.searchParams.get('v')) !== PROTOCOL_VERSION) {
      conn.send(JSON.stringify(msg.error('客户端版本与服务器不一致，请刷新页面后重试', 'version')));
      conn.close();
      return;
    }
    const roomCode = url.searchParams.get('room');
    // §122：名字是**别人能控制的输入**（它会被广播给房里所有人、并渲染到别人界面上）。
    // ① 长度截断：不截断的话一个 1MB 的名字会进每一份广播，还会把别人的玩家面板撑爆；
    // ② 转义在客户端做（见 ui.js 的 esc）——服务端不该假设对面拿它当 HTML 用。
    const name = String(url.searchParams.get('name') ?? '玩家').slice(0, 12);
    const uid = url.searchParams.get('uid');
    const tok = url.searchParams.get('tok');
    // §3.1 #24：身份对不上就当场拒（不给房间、也不动原来那个座位）
    if (!tokenOk(uid, tok)) {
      conn.send(JSON.stringify(msg.error('身份校验失败：这个身份已绑定到别的设备（换设备请新建身份）', 'identity')));
      conn.close();
      return;
    }
    // §1.5 快速匹配：`?match=1` 走队列（按「模式 + 地图 + 难度」分流，45 秒未满员即开局）。
    // 重连（带 uid 且有房间码）不走队列——那是「回到原房」，不是「找新局」。
    if (!roomCode && url.searchParams.get('match') === '1') {
      // §121：分桶用的三个键也走**同一个** roomOptions（这里以前又拼了一遍，还留着
      // `startsWith('def_')` 那套前缀判断——两处各写一份正是漂移的起点）
      const opts = roomOptions(url);
      const room = queue.enqueue({
        mode: opts.mode,
        mapId: opts.mapId,
        difficulty: opts.difficulty,
        createRoom: () => registry.create({ ...roomOptions(url), profiles }),
      });
      if (!room) { conn.send(JSON.stringify(msg.error('匹配暂时不可用', 'queue_unavailable'))); conn.close(); return; }
      const player = uid ? room.joinAs(conn, name, uid) : room.join(conn, name);
      if (!player) { conn.send(JSON.stringify(msg.error('匹配失败，请重试', 'queue_join_failed'))); conn.close(); return; }
      queue.startFull();   // 刚刚这一下可能刚好把房间凑满（§1.5：满员即开局，不等窗口）
      log(`[queue] ${name} 进入 ${room.code}（${room.players.size}/${room.maxPlayers}）`);
      return;
    }
    let room = roomCode ? registry.get(roomCode) : null;
    if (!room) {
      room = registry.create({ ...roomOptions(url), profiles });
      log(`[room] ${roomCode ? `码 ${roomCode} 不存在，` : ''}新建 ${room.code}`);
    }
    const player = uid ? room.joinAs(conn, name, uid) : room.join(conn, name);
    if (!player) {
      // 区分两种拒绝：满员 vs 已过中途加入窗口（§12.3）——文案不同，玩家才知道该等下一局还是换个房
      const full = room.players.size >= room.maxPlayers;
      conn.send(JSON.stringify(full
        ? msg.error('房间已满', 'room_full')
        : msg.error('这局已经开始了，无法中途加入（重连请用原来的身份）', 'in_progress')));
      conn.close();
      return;
    }
    log(`[room ${room.code}] ${name} 加入（${room.players.size}/${room.maxPlayers}）`);
  }

  return {
    server,
    registry,
    queue,   // §1.5 快速匹配的队列（用例看它攒了几个人）
    profiles,
    /**
     * §146：`listen()` 是 Promise 接口，**绑定失败就该 reject**。
     * 原来是 `new Promise((resolve) => server.listen(port, () => resolve(...)))`——只挂了成功回调，
     * 于是端口被占（EADDRINUSE）时没人接住那个 `error` 事件：net.Server 的 'error' 没有监听者时
     * **直接抛成未捕获异常**，挂到当时正在跑的用例头上（实测：报错位置是这条无辜的用例，
     * 而真正的原因在服务端里，看一眼完全看不懂）。现在错误原样送到 `await listen()` 那一行，
     * 调用方想重试就重试、想断言就断言（`tests/net.test.js` 的 §146 就是断言它）。
     */
    listen: (port = 8788, host = null) => new Promise((resolve, reject) => {
      const onError = (err) => { server.off('listening', onListening); reject(err); };
      const onListening = () => { server.off('error', onError); resolve(server.address().port); };
      server.once('error', onError);
      server.once('listening', onListening);
      /**
       * §157：**端口 0（临时端口）只绑 127.0.0.1**。
       * 不带 host 时 node 绑 `::`（双栈），于是「本机另一个程序把 v4 的同一个临时端口占了」时，
       * 我们的 `listen` 仍然成功（占的是 v6 那一半），而测试/工具随后连的是 `127.0.0.1:port`——
       * 那一发请求进了**别人的服务器**。实测（`lsof`）：
       *   node 46040  TCP 127.0.0.1:53612->127.0.0.1:53611 ESTABLISHED
       *   jetbrains 24826 TCP 127.0.0.1:53611 (LISTEN)     ← 对面是 IDE，不是我们的服务器
       * 后果有两种，都见过：握手收到 404（§150）、或者永远等不到 hello 而**吊住整个测试进程**（§146.1）。
       * 固定端口（`tools/server.mjs` 的 8788）不受影响，仍然绑 `::`——局域网好友要能进房。
       */
      const bindHost = host ?? (port === 0 ? '127.0.0.1' : undefined);
      server.listen(port, bindHost);
    }),
    close: () => new Promise((resolve) => {
      registry.closeAll();
      queue.clear();
      profiles.flush();      // 关服前把档案写下去（正常退出路径）
      for (const s of upgraded) s.destroy();
      upgraded.clear();
      server.close(() => resolve());
      // 房间的 WS 连接是长连接，server.close 会一直等它们；原型阶段直接断开（§10.3 的优雅关闭留到 M2 打磨）
      server.closeAllConnections?.();
      setTimeout(resolve, 200); // 兜底：即使还有连接没断，也不让调用方挂死
    }),
  };
}
