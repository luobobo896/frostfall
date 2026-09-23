// 设置（§14.3 稿 9）。原稿列的六项里，「摇杆固定/浮动」是唯一一项对本作有用的
// （§1.9.1 明确写「固定（左下 45% 区域），可在设置里切浮动」）；
// 「左右手镜像 / 技能拖拽瞄准 / 按钮大小 / 镜头灵敏度」属于摇杆操作方案或本作没有的高频操作，不适用。
// 另外真正需要的是镜头缩放（等距图在手机上偏小）与特效强度（低端机保帧）。

import { storage } from './platform.js';   // §平台适配：设置走适配层（小游戏 = wx storage）

export const SETTINGS_VERSION = 1;
const KEY = 'frostfall:settings';

export const DEFAULT_SETTINGS = {
  v: SETTINGS_VERSION,
  zoom: 1.5,          // 防守模式跟随相机的缩放档位
  tdFitAll: true,     // TD 模式整图可见（false = 放大到 1.2×）
  effects: 'high',    // high | low：低档关掉飘字与脉冲，保低端机帧率
  autoPickup: true,   // 防守模式走到掉落物上自动拾取
  showWavePreview: true,
  sfx: true,          // 提示音（§2.6 的回防预警）：默认开，玩家能关（没有静音开关的音效是坏体验）
  stick: 'fixed',     // 摇杆：fixed 固定左下 / floating 浮动（§1.9.1、§1.9.3）
};

export const ZOOM_STEPS = [1.2, 1.5, 1.8];

export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  if (raw?.v !== SETTINGS_VERSION) return { ...DEFAULT_SETTINGS };
  if (!ZOOM_STEPS.includes(s.zoom)) s.zoom = DEFAULT_SETTINGS.zoom;
  if (!['high', 'low'].includes(s.effects)) s.effects = 'high';
  s.tdFitAll = !!s.tdFitAll;
  s.autoPickup = !!s.autoPickup;
  s.showWavePreview = !!s.showWavePreview;
  s.sfx = s.sfx !== false;
  if (!['fixed', 'floating'].includes(s.stick)) s.stick = DEFAULT_SETTINGS.stick;
  return s;
}

export function loadSettings() {
  try {
    const raw = storage.get(KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(s) {
  try { return storage.set(KEY, JSON.stringify({ ...s, v: SETTINGS_VERSION })); } catch { return false; }
}

export function resetSettings() {
  try { storage.remove(KEY); } catch { /* 忽略 */ }
  return { ...DEFAULT_SETTINGS };
}

/** 渲染层要用的派生值：把设置翻译成「画什么」。 */
export function renderOptions(settings) {
  const s = normalizeSettings(settings);
  return {
    showFloaters: s.effects === 'high',
    showPulses: s.effects === 'high',
    defenseScale: s.zoom,
  };
}
