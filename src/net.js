// 客户端网络层：连房间、发指令、收快照（§10.2/§10.3）。
// 本地镜像仍然用 createMatch 建（拿地图几何与定义表），但不再调用 update()，一切以快照为准。

import { applyDefenseShared, applyPrivate, applyShared, decode, PROTOCOL_VERSION } from './protocol.js';

/**
 * 本机身份与上次房间：刷新 / 断线后能回到原位（§10.3）。
 * §3.1 #24：同时落一个**设备级 token**——光有 uid 不算身份（§125 只堵住了名单外泄那一半）。
 */
function loadIdentity() {
  try {
    const uid = localStorage.getItem('frostfall:uid') ?? `u${Math.floor(Math.random() * 1e9)}`;
    localStorage.setItem('frostfall:uid', uid);
    const token = localStorage.getItem('frostfall:token') ?? `t${Math.floor(Math.random() * 1e12).toString(36)}${Date.now().toString(36)}`;
    localStorage.setItem('frostfall:token', token);
    return { uid, token, lastRoom: localStorage.getItem('frostfall:room') };
  } catch {
    // 隐私模式：没有 localStorage，每次刷新身份都会变（M0.5 接受；M3 的 wx.login 不受影响）
    return { uid: `u${Math.floor(Math.random() * 1e9)}`, token: null, lastRoom: null };
  }
}

export const identity = loadIdentity();
export const rememberRoom = (code) => { try { localStorage.setItem('frostfall:room', code ?? ''); } catch { /* 隐私模式 */ } };

/**
 * §10.3：「广播带 revision 序号；客户端发现序号跳跃即请求全量快照」。
 * 跳跃 = 中间丢了广播（TCP 上不常见，但重连 / 服务端补发私有快照之后会出现），
 * 而增量快照只发「变化的怪物」，丢一帧就会在客户端留下永不消失的幽灵怪——所以要能自愈。
 */
export const needsResync = (lastRev, rev) =>
  Number.isFinite(lastRev) && lastRev >= 0 && Number.isFinite(rev) && rev > lastRev + 1;

/**
 * §1.5 好友房：输错/过期的房间码，服务端会**新建一间**（`码 X 不存在，新建`）。
 * 这件事必须**说出来**——否则玩家以为进了朋友的房，一个人干等（验证记录 §102）。
 * 返回提示文案；码一致或本来就没给码时返回 null。
 */
export const joinNotice = (requested, actual) =>
  (requested && actual && requested !== actual
    ? `房间 ${requested} 不存在或已过期，已新建房间 ${actual}`
    : null);

export function connect({
  url, room, name, mapId, difficulty, heroId, mode, length, seed, match,
  onSnapshot, onStatus, onPlayerList, onEvents, onError, onProfile, onNotice, onHello,
}) {
  const wsUrl = url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  // §120：把自己的协议版本带上，服务端会校验（§10.5 的「版本号校验」）
  // 握手串每次现拼（换身份时要重拼，见下面的 rotateIdentity）
  const buildQs = () => {
    const q = new URLSearchParams({ name: name ?? '玩家', uid: identity.uid, v: String(PROTOCOL_VERSION) });
    if (identity.token) q.set('tok', identity.token);   // §3.1 #24：重连要 uid + token 都对
    if (room) q.set('room', room);
    if (match) q.set('match', '1');   // §1.5：没有房间码，交给服务端队列分桶
    if (mapId) q.set('map', mapId);
    if (difficulty) q.set('difficulty', difficulty);
    if (heroId) q.set('hero', heroId);
    if (mode) q.set('mode', mode);
    if (length) q.set('length', length);
    if (seed != null) q.set('seed', String(seed));
    return q;
  };
  let qs = buildQs();
  let rotated = false;

  /**
   * §3.1 #24：服务端认的是「uid + token」这一**对**。本机的 token 没了（清过存储、隐私模式）或者
   * 这个 uid 已被别的设备占着时，这一对就废了——那时候正确做法是**换一个新身份**重新进房，
   * 而不是拿着旧 uid 一直撞墙（玩家看到的会是一句「身份校验失败」然后什么都点不动）。
   * 换完会把新的一对写回 localStorage；只换一次，免得两边都不认时来回刷。
   */
  const rotateIdentity = () => {
    if (rotated) return false;
    rotated = true;
    const uid = `u${Math.floor(Math.random() * 1e9)}`;
    const token = `t${Math.floor(Math.random() * 1e12).toString(36)}${Date.now().toString(36)}`;
    identity.uid = uid;
    identity.token = token;
    try { localStorage.setItem('frostfall:uid', uid); localStorage.setItem('frostfall:token', token); } catch { /* 存不了就只在这一次生效 */ }
    qs = buildQs();
    onNotice?.('本机身份已失效（存储被清过，或这个身份在别的设备上）：已换一个新身份重新进房');
    return true;
  };

  const state = { connected: false, roomCode: null, playerId: null, ping: 0, players: [], lastRev: -1, error: null };
  /**
   * §10.1「网络切换：4G ↔ WiFi 切换必须能重连回原房间」——以前断了就断了：`onclose` 只把
   * `connected` 置假，客户端于是停在一块不动的画面上，只能靠玩家自己刷新页面（验证记录 §105）。
   * 现在断线自动重连（退避 300ms→5s，最多 8 次）：同 uid 回到原座位，服务端会补一份全量快照。
   */
  const reconnect = { attempts: 0, timer: null, stopped: false };
  let socket;
  let pingSentAt = 0;
  let lastResyncAt = -Infinity;

  const open = () => {
    socket = new WebSocket(`${wsUrl}?${qs}`);
    socket.onopen = () => {
      reconnect.attempts = 0;
      state.connected = true;
      state.error = null;
      onStatus?.(state);
      pingSentAt = performance.now();
      socket.send(JSON.stringify({ t: 'ping' }));
    };
    socket.onmessage = handleMessage;
    socket.onclose = () => {
      state.connected = false;
      onStatus?.(state);
      if (!reconnect.stopped) scheduleReconnect();
    };
    socket.onerror = () => { state.error = '连接失败'; onStatus?.(state); };
  };

  function scheduleReconnect() {
    if (reconnect.timer || reconnect.stopped) return;
    if (reconnect.attempts >= 8) {           // 约 30 秒还没回来：别再无声无息地转
      state.error = '重连失败，请回大厅重开一局';
      onStatus?.(state);
      return;
    }
    reconnect.attempts += 1;
    const delay = Math.min(5000, 300 * reconnect.attempts);
    reconnect.timer = setTimeout(() => { reconnect.timer = null; open(); }, delay);
    reconnect.timer.unref?.();
  }

  function handleMessage(event) {
    let message;
    try { message = decode(event.data); } catch { return; }
    switch (message.t) {
      case 'hello':
        // §120：反向也要查——服务端的协议版本与本地不一致时，快照的字段形状可能已经变了，
        // 硬套上去就是 §102/§68 那类「整页抛异常」。说清楚 + 不再重连（重连一百次也一样）。
        if (message.v !== PROTOCOL_VERSION) {
          state.error = '客户端版本与服务器不一致，请刷新页面后重试';
          reconnect.stopped = true;
          onError?.({ code: 'version', text: state.error });
          onStatus?.(state);
          socket.close();
          break;
        }
        state.roomCode = message.roomCode;
        state.config = message.config ?? null;   // 房间的模式/地图/难度（服务端权威）
        // onHello 返回真值 = 「这次握手先别用」：客户端发现镜像配置与房间不一致、正在重载对齐，
        // 此时**绝不能**再拿这份快照去套一个形状不对的镜像（会抛异常，见验证记录 §102）
        if (onHello?.(message)) break;
        // 房间码没命中（输错 / 房间过期）时告诉玩家：服务端另起了一间，别以为进了朋友的房
        const notice = joinNotice(room, message.roomCode);
        if (notice) { state.notice = notice; onNotice?.(notice); }   // 只提示一次；别塞进 error（那条每次状态变化都会再弹）
        state.playerId = message.playerId;
        // 自己的资源槽位（0-3）：队伍色、玩家面板的「（我）」、塔线加粗都要用它。
        // 漏接这个字段的话，非房主会一直以为自己是 0 号位——自己的塔被判成别人的。
        state.slot = message.slot ?? 0;
        state.profile = message.profile ?? state.profile;
        // 自己的那一条要带上 slot：面板按座号找自己，缺了就标不出「（我）」。
        // （服务端随后还会推一份完整名单，这里只是先有个像样的初值。）
        state.players = [{ id: message.playerId, name, slot: message.slot ?? 0, online: true }];
        rememberRoom(message.roomCode);
        onSnapshot?.(message.s, message.me);
        onStatus?.(state);
        break;
      case 'profile':
        // 服务端结算：声望 / 人物等级 / 地图解锁都以它为准（联机下客户端不再自己记账）
        state.profile = message.profile;
        onProfile?.(message.profile, message.gain, message.leveledUp, message.extra ?? null);
        onStatus?.(state);
        break;
      case 'snap':
        // §10.3：序号跳跃 → 请求一次全量（限 1 次/秒，别在抖动时变成请求风暴）
        if (needsResync(state.lastRev, message.s.rev) && performance.now() - lastResyncAt > 1000) {
          lastResyncAt = performance.now();
          socket.send(JSON.stringify({ t: 'resync' }));
        }
        state.lastRev = message.s.rev;
        // 延迟探测 1Hz 就够，别每帧都发（10Hz 的 ping 既是浪费，也容易撞上服务端限流）
        if (performance.now() - pingSentAt > 1000) {
          state.ping = Math.max(1, Math.round(performance.now() - pingSentAt));
          pingSentAt = performance.now();
          socket.send(JSON.stringify({ t: 'ping' }));
        }
        onSnapshot?.(message.s, message.me);
        onStatus?.(state);
        break;
      case 'ev':
        onEvents?.(message.e);
        break;
      case 'joined':
        state.players = message.players;
        onPlayerList?.(state.players);
        break;
      case 'left':
        state.players = message.players;
        onPlayerList?.(state.players);
        break;
      case 'error':
        // §3.1 #24：身份那一对失效 → 换新身份重连一次（旧连接关掉，走正常的重连退避）
        if (message.code === 'identity' && rotateIdentity()) {
          reconnect.attempts = 0;
          state.error = null;
          onStatus?.(state);
          try { socket.close(); } catch { /* 服务端可能已经关了 */ }
          scheduleReconnect();
          break;
        }
        state.error = message.text;
        // §120：版本不一致**别重连**——重连一百次也还是那一条。停在这里，让玩家看到提示去刷新。
        if (message.code === 'version') reconnect.stopped = true;
        onError?.(message);
        onStatus?.(state);
        break;
      default: break;
    }
  }

  const send = (command) => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(command));
    return true;
  };

  open();

  return {
    state,
    send,
    // 主动关闭 = 不再重连（例如 §10.3 的「转单人继续」）；这不是掉线
    close: () => { reconnect.stopped = true; clearTimeout(reconnect.timer); socket.close(); },
    /**
     * STATUS §3.1 #23：**主动退房**要先说一声再走。
     * 直接 `close()` 在服务端看起来和掉线一模一样（§10.3 的 5 分钟保留窗口会留着座位），
     * 于是 3 人在玩 + 1 个刚离开 = 满员，第 4 个朋友进不来。`leave` 只释放自己那一席。
     */
    leave: () => { send({ t: 'leave' }); reconnect.stopped = true; clearTimeout(reconnect.timer); socket.close(); },
    /** 掉线重连的状态（调试/冒烟用：能断言「真的重试过」） */
    reconnectInfo: () => ({ attempts: reconnect.attempts, pending: !!reconnect.timer, stopped: reconnect.stopped }),
    /** 调试/冒烟用：模拟「网络切换」造成的掉线（**不是主动关闭**，所以会走自动重连） */
    simulateDrop: () => socket.close(),
    // 指令封装：与 ui.js 的回调一一对应
    build: (slot, towerId) => send({ t: 'build', slot, towerId }),
    upgrade: (slot) => send({ t: 'upgrade', slot }),
    sell: (slot) => send({ t: 'sell', slot }),
    priority: (slot, p) => send({ t: 'priority', slot, priority: p }),
    cast: (index) => send({ t: 'cast', index }),
    buy: (itemId) => send({ t: 'buy', itemId }),
    potion: (itemId) => send({ t: 'potion', itemId }),
    craft: (slot, quality) => send({ t: 'craft', slot, quality }),
    equip: (uid) => send({ t: 'equip', uid }),
    enhance: (uid) => send({ t: 'enhance', uid }),
    sellItem: (uid) => send({ t: 'sellitem', uid }),
    early: () => send({ t: 'early' }),
    revive: () => send({ t: 'revive' }),
    move: (x, y) => send({ t: 'move', x, y }),
    fort: (slot, fortId) => send({ t: 'fort', slot, fortId }),
    repair: () => send({ t: 'repair' }),
    teleport: () => send({ t: 'teleport' }),
    repairTower: (slot) => send({ t: 'repairTower', slot }),
  };
}

/** 把一条共享快照 + 可选私人数据写进本地镜像。 */
export function applyRemoteMessage(match, shared, me) {
  if (shared.mode === 'defense') applyDefenseShared(match, shared);
  else applyShared(match, shared);
  if (me) applyPrivate(match, me);
  return match;
}

export { PROTOCOL_VERSION };
