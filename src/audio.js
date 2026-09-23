// 音效（§2.6：回防预警要「小地图闪烁 + 提示音」——闪烁在 render.js，提示音在这里）。
// 不依赖任何音频资产：用 WebAudio 现场合成两声短促蜂鸣，占位期不用等音频产能（§14.6 的思路）。
// 边界情况必须安静地失败：Node 里没有 AudioContext、浏览器在用户交互前会把 AudioContext 挂起——
// 这两种情况都只是「这次没响」，绝不能让帧循环抛异常。
// §平台适配（小游戏移植）：取上下文那一步走 platform——浏览器是 `new AudioContext()`，
// 小游戏是 `wx.createWebAudioContext()`（见 docs/minigame-port.md）。
import { audioContext } from './platform.js';

export function createCue({ enabled = () => true } = {}) {
  let ctx = null;
  let failures = 0;
  let warmed = 0;   // §178：在手势里解锁过几次（冒烟据此验「按钮按下 → 解锁」这条接线真的接上了）
  const log = [];   // 冒烟/调试用：headless 里听不到声音，靠它验「什么时候响了什么」
  /**
   * §178：**在用户手势里**把 AudioContext 解开。
   *
   * 真机（iOS Safari / 移动 Chrome）的自动播放策略只认「手势里创建或恢复」的上下文：首次预警是
   * 帧循环里响的（`updateDefense` 把 `assault.warning` 置起，主循环 `cue('warning')`），
   * 不在任何手势里 → 那个上下文在真机上永远是 `suspended`，**这条提示音从来没响过**
   * （桌面宽松策略下听不出来，验证记录 §178）。所以主循环的 `pointerdown` 每次都会调这里一下。
   * iOS 切后台回来状态可能是 `interrupted`，所以「每次按都调」而不是只解一次。
   */
  const warm = () => {
    if (!enabled()) return false;
    try {
      ctx = ctx ?? audioContext();
      if (!ctx) return false;
      if (ctx.state !== 'running') ctx.resume?.();
      warmed += 1;
      return ctx.state === 'running';
    } catch { return false; }
  };
  const beep = (ac, { freq, at, dur, gain }) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g);
    g.connect(ac.destination);
    o.start(at);
    o.stop(at + dur + 0.02);
  };
  /** 播一声提示音；kind 只影响音色与日志。关掉音效时直接跳过（不创建 AudioContext）。 */
  const cue = (kind = 'warning') => {
    if (!enabled()) { log.push({ t: Date.now(), kind, played: false, reason: 'muted' }); return false; }
    try {
      ctx = ctx ?? audioContext();
      if (!ctx) { failures += 1; log.push({ t: Date.now(), kind, played: false, reason: 'no-audio-context' }); return false; }
      if (ctx.state === 'suspended') ctx.resume?.();   // 用户交互前会挂起：这次可能不出声，但不报错
      const t0 = ctx.currentTime + 0.01;
      if (kind === 'warning') {
        beep(ctx, { freq: 660, at: t0, dur: 0.16, gain: 0.16 });
        beep(ctx, { freq: 880, at: t0 + 0.18, dur: 0.16, gain: 0.16 });
      } else {
        beep(ctx, { freq: 520, at: t0, dur: 0.12, gain: 0.12 });
      }
      // §178：**日志不许撒谎**——上下文还挂着（真机没解锁）时声音根本没出来，那就记 played:false。
      // 以前这里写死 `played: true`，于是「§2.6 预警真的响了」那条冒烟检查在真机上永远为真、
      // 却在真机上一声不响（检查自己成了安慰）。
      const played = ctx.state === 'running';
      log.push({ t: Date.now(), kind, played, state: ctx.state, ...(played ? {} : { reason: 'suspended' }) });
      if (log.length > 40) log.shift();
      return played;
    } catch (err) {
      failures += 1;
      log.push({ t: Date.now(), kind, played: false, reason: String(err?.message ?? err) });
      return false;
    }
  };
  cue.log = log;
  cue.stats = () => ({ played: log.filter((x) => x.played).length, failures, warmed });
  cue.warm = warm;
  return cue;
}
