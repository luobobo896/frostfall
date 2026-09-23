// 假 `wx`：本机没有微信基础库，用它把「小游戏环境」摆出来（冒烟与用例共用一份）。
// 只实现我们真的会用到的那几个能力，行为对齐官方文档：
//   storage 同步读写（wx.getStorageSync/setStorageSync/removeStorageSync）
//   wx.getWindowInfo()（`wx.getSystemInfoSync` 已不推荐，我们优先用新接口）
//   wx.vibrateShort / wx.connectSocket / wx.request（request 这里直接用本机 fetch 顶上）
// **没有** document —— 这一点很关键，platform.isMiniGame() 靠它区分「小游戏」与「浏览器里的 wx 桥」。
export function installFakeWx({ windowWidth = 1334, windowHeight = 750, pixelRatio = 2, onVibrate = null } = {}) {
  const store = new Map();
  const sockets = [];
  const wx = {
    getStorageSync: (k) => (store.has(k) ? store.get(k) : ''),
    setStorageSync: (k, v) => { store.set(k, String(v)); },
    removeStorageSync: (k) => { store.delete(k); },
    getWindowInfo: () => ({ windowWidth, windowHeight, pixelRatio }),
    vibrateShort: (o) => { if (onVibrate) onVibrate(o); else if (!store.get('__failVibrate')) return; },
    request: ({ url, success, fail }) => {
      fetch(url).then(async (res) => success({ statusCode: res.status, data: await res.json() }))
        .catch((err) => fail({ errMsg: String(err?.message ?? err) }));
    },
    connectSocket: ({ url }) => {
      const handlers = {};
      const task = {
        sent: [],
        onOpen: (fn) => { handlers.open = fn; },
        onMessage: (fn) => { handlers.message = fn; },
        onClose: (fn) => { handlers.close = fn; },
        onError: (fn) => { handlers.error = fn; },
        send: ({ data }) => { task.sent.push(data); },
        close: () => setTimeout(() => handlers.close?.({}), 0),
      };
      sockets.push({ url, task, handlers });
      setTimeout(() => handlers.open?.({}), 0);
      return task;
    },
  };
  globalThis.wx = wx;
  return { wx, store, sockets, uninstall: () => { delete globalThis.wx; } };
}
