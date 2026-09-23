// 假 `wx`：本机没有微信基础库，用它把「小游戏环境」摆出来（冒烟与用例共用一份）。
// 只实现我们真的会用到的那几个能力，行为对齐官方文档：
//   storage 同步读写（wx.getStorageSync/setStorageSync/removeStorageSync）
//   wx.getWindowInfo()（`wx.getSystemInfoSync` 已不推荐，我们优先用新接口）
//   wx.vibrateShort / wx.connectSocket / wx.request（request 这里直接用本机 fetch 顶上）
// **没有** document —— 这一点很关键，platform.isMiniGame() 靠它区分「小游戏」与「浏览器里的 wx 桥」。
export function installFakeWx({ windowWidth = 667, windowHeight = 375, pixelRatio = 2, onVibrate = null } = {}) {
  const store = new Map();
  const sockets = [];
  const touchHandlers = {};
  const lifeHandlers = {};
  /**
   * 音频记账（headless 里听不见声音，只能记「排了几声」）：`createWebAudioContext` 返回一个最小的
   * WebAudio 门面，`audio` 里累计次数——用例据此验「预警真的排了两声蜂鸣」「静音时一声都没排」。
   */
  const audio = { contexts: 0, oscillators: 0, gains: 0, resumes: 0 };
  /** 平台杂项：屏幕常亮调了几次、内存告警有没有人接（用例据此验这两条接线） */
  const platform = { keepScreenOn: [], memoryWarning: 0 };
  /**
   * 假 canvas + 记录型 2D 上下文：Node 里没有 canvas，但大厅那一屏要真的画一帧才算验过。
   * 用 Proxy 兜住所有 `ctx.*` 调用（未实现的也记一笔），`fillText` 把文字留下来 ——
   * 于是「这一帧画了什么」可以断言（比如标题「冰封之地」真的被画出来了）。
   */
  const makeCanvas = () => {
    const rec = { calls: [], texts: [], styles: [] };
    const state = {};
    const ctx = new Proxy(state, {
      get(target, prop) {
        if (prop === 'record') return rec;
        if (prop in state) return state[prop];
        if (typeof prop !== 'string') return undefined;
        return (...args) => {
          rec.calls.push(prop);
          if (prop === 'fillText') rec.texts.push(String(args[0]));
          if (prop === 'measureText') return { width: String(args[0] ?? '').length * 6 };
          return undefined;
        };
      },
      set(target, prop, value) {
        state[prop] = value;
        // 记一笔「画的时候用了什么颜色/线宽」：低特效档（脉冲）那种差别只能从样式上看出来
        if (prop === 'strokeStyle' || prop === 'fillStyle' || prop === 'globalAlpha') rec.styles.push({ [prop]: value });
        return true;
      },
    });
    return { width: windowWidth * pixelRatio, height: windowHeight * pixelRatio, getContext: () => ctx, record: rec };
  };
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
    createCanvas: () => makeCanvas(),
    createWebAudioContext: () => {
      audio.contexts += 1;
      return {
        state: 'running',
        currentTime: 0,
        destination: {},
        resume: () => { audio.resumes += 1; },
        createOscillator: () => {
          audio.oscillators += 1;
          return { type: 'sine', frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
        },
        createGain: () => {
          audio.gains += 1;
          return {
            gain: {
              setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
            },
            connect() {},
          };
        },
      };
    },
    onTouchStart: (fn) => { touchHandlers.down = fn; },
    onTouchMove: (fn) => { touchHandlers.move = fn; },
    onTouchEnd: (fn) => { touchHandlers.up = fn; },
    onTouchCancel: (fn) => { touchHandlers.cancel = fn; },
    onHide: (fn) => { lifeHandlers.hide = fn; },
    onShow: (fn) => { lifeHandlers.show = fn; },
    onMemoryWarning: (fn) => { platform.memoryWarning += 1; lifeHandlers.memoryWarning = fn; },
    setKeepScreenOn: ({ keepScreenOn }) => { platform.keepScreenOn.push(!!keepScreenOn); },
  };
  globalThis.wx = wx;
  /**
   * 模拟一次触摸（小游戏里是 wx 的全局触摸回调，参数形状照官方：changedTouches[{clientX,clientY,identifier}]）。
   * `id` 是触点编号：双指缩放要两个不同的 id（默认 0，老用例不用改）。
   */
  const fireTouch = (x, y, type = 'down', id = 0) => {
    const fn = touchHandlers[type];
    if (!fn) return false;
    const point = { clientX: x, clientY: y, identifier: id };
    fn({ touches: [point], changedTouches: [point] });
    return true;
  };
  /** 模拟切后台（小游戏里是 wx.onHide） */
  const fireHide = () => { lifeHandlers.hide?.({}); return !!lifeHandlers.hide; };
  /** 模拟回到前台（小游戏里是 wx.onShow） */
  const fireShow = () => { lifeHandlers.show?.({}); return !!lifeHandlers.show; };
  /** 模拟一次内存告警（微信在内存吃紧时抛 `wx.onMemoryWarning`） */
  const fireMemoryWarning = (level = 10) => {
    if (!lifeHandlers.memoryWarning) return false;
    lifeHandlers.memoryWarning({ level });
    return true;
  };
  return {
    wx, store, sockets, audio, platform,
    fireTouch, fireHide, fireShow, fireMemoryWarning,
    uninstall: () => { delete globalThis.wx; },
  };
}
