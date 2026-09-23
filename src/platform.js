// 平台适配层（微信小游戏移植第一步）：把「浏览器专有 API」收成一处，业务代码只调这里。
//
// 为什么要这一层：小游戏**没有 DOM**、没有 `localStorage`、没有 `location`，网络与音频也各有自己的 API
// （`wx.connectSocket` / `wx.createWebAudioContext`），而我们是先按浏览器写的。把这 7 类能力收成一个文件，
// 「浏览器能跑、小游戏也能跑」就变成两条实现的事，而不是散在 5 个文件里的 60 多处分支。
//
// **覆盖**：存储 / HTTP / WebSocket / 音频上下文 / 视口尺寸 / 前后台生命周期 / 触觉。
// **不覆盖**：DOM 与指针事件——小游戏连 `document` 都没有，那一层是界面（`index.html` + `styles.css` + `ui.js`），
// 得换成 Canvas 绘制，属于移植第 3 步，见 docs/minigame-port.md。
//
// 三种运行环境都要能跑：小游戏（有 `wx`、没有 `document`）、浏览器、Node（单元测试：没有 `wx`、没有 `document`，
// 存储走内存 —— 测试里本来就用假 localStorage，这里给一个等价物）。

const g = globalThis;
const wxApi = () => g.wx;

/** 小游戏环境：有 `wx` 且**没有** `document`（页面里也常有 `wx` 桥，那不算） */
export const isMiniGame = () => typeof g.document === 'undefined' && !!wxApi();

/* ---------- 存储 ---------- */

const memStore = new Map();     // Node / 无 localStorage 时的落点（测试用）

const readRaw = (key) => {
  try {
    if (isMiniGame() && wxApi().getStorageSync) {
      const v = wxApi().getStorageSync(key);
      return v === '' || v === undefined || v === null ? null : String(v);
    }
    if (typeof g.localStorage !== 'undefined') return g.localStorage.getItem(key);
  } catch { /* 隐私模式 / 存储被禁用：当作没有 */ }
  return memStore.has(key) ? memStore.get(key) : null;
};

const writeRaw = (key, text) => {
  try {
    if (isMiniGame() && wxApi().setStorageSync) { wxApi().setStorageSync(key, text); return true; }
    if (typeof g.localStorage !== 'undefined') { g.localStorage.setItem(key, text); return true; }
  } catch { /* 配额满 / 被禁用：返回 false，调用方会提示玩家（§183） */ return false; }
  memStore.set(key, text);
  return true;
};

const dropRaw = (key) => {
  try {
    if (isMiniGame() && wxApi().removeStorageSync) { wxApi().removeStorageSync(key); return; }
    if (typeof g.localStorage !== 'undefined') { g.localStorage.removeItem(key); return; }
  } catch { /* 忽略 */ }
  memStore.delete(key);
};

export const storage = {
  get: (key) => readRaw(key),
  /** 写入成功返回 true；写不进去（配额 / 隐私模式 / 存储被禁）返回 false */
  set: (key, text) => writeRaw(key, text),
  remove: (key) => dropRaw(key),
};

/* ---------- HTTP ---------- */

/**
 * GET 一个 JSON。浏览器走 `fetch`，小游戏走 `wx.request`（小游戏没有 `fetch`/`XHR`，
 * 而且域名必须在公众平台后台配成合法域名 + 已备案，见 docs/minigame-port.md）。
 * 相对路径只有浏览器能用；小游戏要传完整 https 地址。
 */
export function requestJson(url, { timeoutMs = 8000 } = {}) {
  if (isMiniGame() && wxApi().request) {
    return new Promise((resolve, reject) => {
      wxApi().request({
        url, method: 'GET', timeout: timeoutMs,
        success: (res) => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
          else reject(new Error(`HTTP ${res.statusCode}`));
        },
        fail: (err) => reject(new Error(err?.errMsg ?? 'request failed')),
      });
    });
  }
  return fetch(url).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}

/* ---------- WebSocket ---------- */

/**
 * 连一条 WebSocket，返回**统一形状**（浏览器 `WebSocket` 与 `wx.connectSocket` 的方法名不一样）：
 * `{ onOpen, onMessage, onClose, onError, send(text), close(), state() }`。
 * `send`/`close` 在连接建立之前调用时**排队**——小游戏那边 `connectSocket` 是异步的，
 * 而我们的 net.js 习惯「onopen 里立刻 send」，两边都要能work。
 */
export function connectSocket(url) {
  const handlers = { open: [], message: [], close: [], error: [] };
  const queue = [];
  let open = false;
  const fire = (name, arg) => { for (const fn of handlers[name]) fn(arg); };

  if (isMiniGame() && wxApi().connectSocket) {
    const task = wxApi().connectSocket({ url });
    task.onOpen(() => { open = true; fire('open'); for (const m of queue.splice(0)) task.send({ data: m }); });
    task.onMessage((res) => fire('message', { data: res.data }));
    task.onClose((res) => { open = false; fire('close', res); });
    task.onError((err) => fire('error', err));
    return {
      onOpen: (fn) => handlers.open.push(fn),
      onMessage: (fn) => handlers.message.push(fn),
      onClose: (fn) => handlers.close.push(fn),
      onError: (fn) => handlers.error.push(fn),
      send: (text) => (open ? task.send({ data: text }) : queue.push(text)),
      close: () => task.close({}),
      readyState: () => (open ? 1 : 0),
    };
  }

  const ws = new WebSocket(url);
  ws.onopen = () => { open = true; fire('open'); for (const m of queue.splice(0)) ws.send(m); };
  ws.onmessage = (e) => fire('message', { data: e.data });
  ws.onclose = (e) => { open = false; fire('close', e); };
  ws.onerror = (e) => fire('error', e);
  return {
    onOpen: (fn) => handlers.open.push(fn),
    onMessage: (fn) => handlers.message.push(fn),
    onClose: (fn) => handlers.close.push(fn),
    onError: (fn) => handlers.error.push(fn),
    send: (text) => (open ? ws.send(text) : queue.push(text)),
    close: () => ws.close(),
    readyState: () => (open ? 1 : 0),
  };
}

/** 默认的 WebSocket 地址：浏览器按当前页面算；小游戏没有 location，必须由调用方显式给 */
export function defaultWsUrl() {
  if (isMiniGame() || typeof g.location === 'undefined') return null;
  const proto = g.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${g.location.host}/ws`;
}

/* ---------- 音频 ---------- */

/** 一个 WebAudio 上下文（小游戏是 `wx.createWebAudioContext`）；不可用时返回 null，调用方安静跳过 */
export function audioContext() {
  try {
    const AC = g.AudioContext ?? g.webkitAudioContext;
    if (AC) return new AC();
    if (isMiniGame() && wxApi().createWebAudioContext) return wxApi().createWebAudioContext();
  } catch { /* 真机上创建失败也只是这次没声音 */ }
  return null;
}

/* ---------- 视口 ---------- */

/** 逻辑像素尺寸与像素比（小游戏不能读 `window`，要用 `wx.getWindowInfo`） */
export function viewport() {
  if (isMiniGame()) {
    const info = wxApi().getWindowInfo?.() ?? wxApi().getSystemInfoSync?.() ?? {};
    return {
      width: info.windowWidth ?? 0,
      height: info.windowHeight ?? 0,
      dpr: info.pixelRatio ?? 1,
    };
  }
  return {
    width: g.innerWidth ?? 0,
    height: g.innerHeight ?? 0,
    dpr: g.devicePixelRatio ?? 1,
  };
}

/* ---------- 生命周期 ---------- */

/**
 * 切后台 / 关页面时保存（§10.3：切后台、杀进程都要能续上）。
 * 小游戏是 `wx.onHide`；浏览器是 `visibilitychange` + `pagehide`（两件都要，
 * 因为移动端 Safari 有时只给后者）。
 */
export function onHide(fn) {
  if (isMiniGame() && wxApi().onHide) { wxApi().onHide(fn); return; }
  if (typeof g.document !== 'undefined') {
    g.document.addEventListener('visibilitychange', () => {
      if (g.document.visibilityState === 'hidden') fn();
    });
    g.addEventListener?.('pagehide', fn);
  }
}

/* ---------- 触摸 ---------- */

/**
 * 统一的触点回调：`fn({ type: 'down'|'move'|'up', x, y, id })`，坐标是**逻辑像素**。
 * 小游戏用全局 `wx.onTouchStart/Move/End/Cancel`（没有 DOM 事件）；浏览器里挂到 document 上，
 * 好让大厅这一屏也能在预览页里点。
 */
export function onTouch(fn) {
  if (isMiniGame() && wxApi().onTouchStart) {
    const relay = (type) => (e) => {
      for (const t of e.changedTouches ?? e.touches ?? []) {
        fn({ type, x: t.clientX ?? t.x ?? 0, y: t.clientY ?? t.y ?? 0, id: t.identifier ?? 0 });
      }
    };
    wxApi().onTouchStart(relay('down'));
    wxApi().onTouchMove(relay('move'));
    wxApi().onTouchEnd(relay('up'));
    wxApi().onTouchCancel?.(relay('up'));
    return;
  }
  if (typeof g.document === 'undefined') return;   // Node：没有触摸，安静跳过
  const relay = (type) => (e) => fn({ type, x: e.clientX ?? 0, y: e.clientY ?? 0, id: 0 });
  g.document.addEventListener('pointerdown', relay('down'));
  g.document.addEventListener('pointerup', relay('up'));
}

/* ---------- 触觉 ---------- */

/**
 * 短震动。返回 `{ ok, reason }` 而不是布尔：**原因要能带回去**——§1.9.2 的日志要求
 * 「没有能力 / 被禁权限 / 老基础库报错」三种情况都记下具体原因（旧版只记 'no-wx'，
 * 真机上报错时看不出是哪一种）。
 */
export function vibrate(kind = 'light') {
  try {
    if (!wxApi()?.vibrateShort) return { ok: false, reason: 'no-wx' };
    wxApi().vibrateShort({ type: kind });
    return { ok: true };
  } catch (err) { return { ok: false, reason: String(err?.message ?? err) }; }
}
