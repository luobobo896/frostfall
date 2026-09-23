// 设置：默认值、容错、派生渲染选项，以及低端机档位真的会关掉特效。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS, ZOOM_STEPS, loadSettings, normalizeSettings, renderOptions, resetSettings, saveSettings,
} from '../src/settings.js';

test('默认值：跟随相机 1.5×、特效高、自动拾取开、显示波次预告', () => {
  const s = normalizeSettings(null);
  assert.deepEqual(s, DEFAULT_SETTINGS);
  assert.ok(ZOOM_STEPS.includes(s.zoom));
});

test('容错：坏档 / 版本不符 / 非法值一律回落到默认，不把 UI 带崩', () => {
  assert.deepEqual(normalizeSettings({ v: 999, zoom: 3, effects: 'ultra' }), DEFAULT_SETTINGS, '版本不符整份回落');
  const partial = normalizeSettings({ v: 1, zoom: 9 });
  assert.equal(partial.zoom, DEFAULT_SETTINGS.zoom, '非法缩放回默认');
  const badEffects = normalizeSettings({ v: 1, effects: 'ultra' });
  assert.equal(badEffects.effects, 'high');
  assert.equal(normalizeSettings({ v: 1, zoom: 1.8 }).zoom, 1.8, '合法值要保留');
  // §1.9.3 的摇杆开关（§1.9.1 写「固定（左下），可在设置里切浮动」）
  assert.equal(DEFAULT_SETTINGS.stick, 'fixed', '摇杆默认固定左下');
  assert.equal(normalizeSettings({ v: 1, stick: 'floating' }).stick, 'floating');
  assert.equal(normalizeSettings({ v: 1, stick: '右手' }).stick, 'fixed', '非法值回默认');
});

test('落盘：写进 localStorage 再读回来一致（模拟关掉再打开）', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    assert.deepEqual(loadSettings(), DEFAULT_SETTINGS, '没有存档时用默认');
    saveSettings({ ...DEFAULT_SETTINGS, zoom: 1.8, effects: 'low', autoPickup: false });
    const back = loadSettings();
    assert.equal(back.zoom, 1.8);
    assert.equal(back.effects, 'low');
    assert.equal(back.autoPickup, false);
    assert.deepEqual(resetSettings(), DEFAULT_SETTINGS, '重置回默认');
    assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
  } finally {
    delete globalThis.localStorage;
  }
});

test('派生渲染选项：低特效档真的会关掉飘字与脉冲（低端机保帧）', () => {
  const high = renderOptions({ ...DEFAULT_SETTINGS, effects: 'high', zoom: 1.8 });
  assert.equal(high.showFloaters, true);
  assert.equal(high.showPulses, true);
  assert.equal(high.defenseScale, 1.8);

  const low = renderOptions({ ...DEFAULT_SETTINGS, effects: 'low' });
  assert.equal(low.showFloaters, false);
  assert.equal(low.showPulses, false);
});
