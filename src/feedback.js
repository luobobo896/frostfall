// 触觉反馈（§1.9.2 的「反馈」行：按下缩放 0.95 + **短震动** `wx.vibrateShort`）。
// 缩放那一半是 CSS（`.btn:active`），震动这一半在这里：小游戏里调 wx，浏览器里安静地跳过。
// 与 audio.js 同一个约定——**没有能力时不能让点击路径抛异常**，否则一次点击就可能打断界面。
// §平台适配：调 wx 这一步收进 platform.vibrate（与存储/网络/音频同一个出口）。
import { vibrate } from './platform.js';

export function createHaptics({ enabled = () => true } = {}) {
  const log = [];   // 调试/冒烟用：headless 里既不能真的震，也听不到，靠它验「什么时候震了几次」
  let count = 0;
  // 封顶放在唯一出口上：以前只在成功分支里截断，静音/无 wx 两个分支会一直涨
  // （玩家关掉开关后连点 200 下就是 200 条），这类日志上限必须三路一致
  const note = (entry) => { log.push(entry); if (log.length > 40) log.shift(); };
  /** 轻震一下（按钮按下、建塔成功这类「确认」场景） */
  const tap = (kind = 'light') => {
    count += 1;
    if (!enabled()) { note({ t: Date.now(), kind, vibrated: false, reason: 'muted' }); return false; }
    try {
      // 微信只接受 heavy / medium / light（iOS 会忽略 type）
      const r = vibrate(kind);
      if (!r.ok) { note({ t: Date.now(), kind, vibrated: false, reason: r.reason }); return false; }
      note({ t: Date.now(), kind, vibrated: true });
      return true;
    } catch (err) {
      note({ t: Date.now(), kind, vibrated: false, reason: String(err?.message ?? err) });
      return false;
    }
  };
  tap.log = log;
  tap.stats = () => ({ calls: count, vibrated: log.filter((x) => x.vibrated).length });
  return tap;
}
