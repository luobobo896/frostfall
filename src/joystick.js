// 防守模式的虚拟摇杆。
//
// 四份文档要求合起来决定了这里的形状：
// - §1.9.1：防守的主操作是**移动（摇杆）**，王者式「左下固定摇杆 + 右下技能」；TD 没有摇杆。
// - §10.1：防守**同时支持虚拟摇杆与点地移动**，两者下发同一条移动指令，让玩家自己选。
// - §1.9.2：有效区「左下 45% 区域（固定）/ 左半屏（浮动）」，最大位移 60-72pt，
//   依据那句「**移动区绝不与技能区重叠**，这是王者的核心做法」。
// - §1.9.3：设置里可切「固定 / 浮动」。
//
// 于是：有效区里**按下**先不定性——位移超过阈值才算摇杆拖动，没超过就当成一次「轻点」原样
// 转发给地图。这样两种操作方式能共存（§10.1），也不会把左下角那片地图的「点地移动」吃掉。
// 底座在浮动模式下用 `transform` 挪（不动 layout）——用 left/top 会让读数自我反馈。
export const STICK = {
  travel: 64,      // 最大位移 64pt（§1.9.2 的 60-72）
  threshold: 8,    // 小于 8pt 的位移仍算「轻点」，别让手指的抖动变成拖动
  deadzone: 0.25,  // 推得比这还少就不发移动指令
  fixedW: 0.45,    // 固定：有效区宽 = 屏宽 45%（左下角，下半屏）
  floatW: 0.5,     // 浮动：左半屏
  lowerY: 0.45,    // 两者都只吃下半屏（上半屏是地图与 HUD 面板）
};

export function createJoystick({
  base, knob, canvas, enabled = () => true, floating = () => false, onTap = () => {},
}) {
  const dir = { x: 0, y: 0, mag: 0 };
  let id = null;          // 正在操控摇杆的那根手指（同时只认一根：§1.9.2 同时按压上限 2 根）
  let origin = null;      // 方向的原点 = 按下那一点
  let baseHome = null;    // 底座初始中心（浮动模式下要把它挪到手指上，松手挪回去）
  let moved = false;      // 这次手势是否已经越过阈值（= 是拖动而不是轻点）

  const zone = () => {
    const r = canvas.getBoundingClientRect();
    return { w: (floating() ? STICK.floatW : STICK.fixedW) * r.width, h: r.height, top: r.top, left: r.left };
  };
  const inZone = (x, y) => {
    const r = canvas.getBoundingClientRect();
    return x - r.left < (floating() ? STICK.floatW : STICK.fixedW) * r.width
      && y - r.top > STICK.lowerY * r.height;
  };

  const setKnob = (dx, dy) => {
    const len = Math.hypot(dx, dy);
    const k = len > STICK.travel ? STICK.travel / len : 1;
    knob.style.transform = `translate(${(dx * k).toFixed(1)}px, ${(dy * k).toFixed(1)}px)`;
  };
  const center = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  const release = () => {
    const tapped = origin && !moved;
    const at = origin;
    id = null; origin = null; moved = false;
    dir.x = 0; dir.y = 0; dir.mag = 0;
    knob.style.transform = '';
    if (baseHome) { base.style.transform = ''; baseHome = null; }
    if (tapped) onTap(at.x, at.y);   // 轻点：这次手势还给地图（§10.1 的点地移动）
  };

  // 用 window 的**捕获**阶段：它比 canvas 上的地图处理器先跑，
  // 这样 `owns()` 才能在地图处理器里查到「这根手指归摇杆」。
  window.addEventListener('pointerdown', (e) => {
    if (id !== null || !enabled()) return;
    if (e.target instanceof Element && e.target.closest('button')) return;   // HUD 按钮永远优先
    if (!inZone(e.clientX, e.clientY)) return;
    id = e.pointerId;
    origin = { x: e.clientX, y: e.clientY };
    moved = false;
    if (floating()) {
      baseHome = center(base);
      base.style.transform = `translate(${e.clientX - baseHome.x}px, ${e.clientY - baseHome.y}px)`;
    }
  }, { capture: true });

  window.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - origin.x, dy = e.clientY - origin.y;
    const len = Math.hypot(dx, dy);
    if (!moved && len < STICK.threshold) return;
    moved = true;
    const mag = Math.min(1, len / STICK.travel);
    dir.x = (dx / (len || 1)) * mag;
    dir.y = (dy / (len || 1)) * mag;
    dir.mag = mag;
    // 视觉上滑块跟手指走（相对底座中心）。浮动模式下底座已经贴在手指上，两者自然一致
    const c = baseHome ?? center(base);
    setKnob(e.clientX - c.x, e.clientY - c.y);
    e.preventDefault();
  }, { capture: true, passive: false });

  for (const ev of ['pointerup', 'pointercancel']) {
    window.addEventListener(ev, (e) => { if (e.pointerId === id) release(); }, { capture: true });
  }

  /** 这次手势归摇杆吗？地图处理器用它决定要不要跳过（跳过的那次轻点会在 release 里补回来）。 */
  const owns = (pointerId) => pointerId === id;
  const state = () => ({
    active: id !== null, moved, floating: floating(), mag: +dir.mag.toFixed(3),
    dir: { x: +dir.x.toFixed(3), y: +dir.y.toFixed(3) },
    travel: STICK.travel, threshold: STICK.threshold,
    zone: zone(), baseCenter: center(base), knob: (() => {
      const r = knob.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) };
    })(),
  });
  return { dir, owns, release, state };
}
