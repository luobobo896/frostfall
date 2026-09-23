// §1.9.2「反馈：按下缩放 0.95 + 短震动」——缩放那半是 CSS（冒烟里按下时量 transform），
// 震动这半在这里。四条路径各有断言，哪条坏掉都会红：
// 没 wx 要静默跳过、关掉开关要记 muted、wx 抛异常不能炸、真 wx 要真的调到。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHaptics } from '../src/feedback.js';

test('§1.9.2 无 wx 环境（Node / 桌面浏览器）：不抛异常，记 no-wx，点击路径照常走', () => {
  const tap = createHaptics();
  assert.equal(tap('light'), false);
  assert.equal(tap.log.at(-1).reason, 'no-wx');
  assert.equal(tap.stats().vibrated, 0);
});

test('§1.9.2 关掉「音效/震动」开关后记 muted：一次都不震', () => {
  let wxCalls = 0;
  globalThis.wx = { vibrateShort: () => { wxCalls += 1; } };
  try {
    const tap = createHaptics({ enabled: () => false });
    assert.equal(tap('light'), false);
    assert.equal(tap.log.at(-1).reason, 'muted');
    assert.equal(wxCalls, 0, '静音时不该碰 wx');
  } finally { delete globalThis.wx; }
});

test('§1.9.2 有 wx 时真的调到 vibrateShort，并把 kind 传下去（heavy / light 区分场景）', () => {
  const seen = [];
  globalThis.wx = { vibrateShort: (o) => seen.push(o.type) };
  try {
    const tap = createHaptics();
    assert.equal(tap('light'), true);
    assert.equal(tap('heavy'), true);
    assert.deepEqual(seen, ['light', 'heavy']);
    assert.equal(tap.stats().vibrated, 2);
  } finally { delete globalThis.wx; }
});

test('§1.9.2 wx 抛异常时安静失败（老基础库 / 用户禁权限），并把原因留在日志里', () => {
  globalThis.wx = { vibrateShort: () => { throw new Error('vibrateShort:fail'); } };
  try {
    const tap = createHaptics();
    assert.equal(tap('light'), false);
    assert.equal(tap.log.at(-1).reason, 'vibrateShort:fail');
  } finally { delete globalThis.wx; }
});

test('§1.9.2 日志有上限，且三条路径（震了 / 静音 / 无 wx）都封顶：狂点不吃内存', () => {
  const run = (tap) => { for (let i = 0; i < 200; i += 1) tap('light'); return tap; };
  globalThis.wx = { vibrateShort: () => {} };
  try {
    const live = run(createHaptics());
    assert.ok(live.log.length <= 40, `震了那条长度 ${live.log.length}`);
    assert.equal(live.stats().calls, 200, '次数统计不受日志上限影响');
  } finally { delete globalThis.wx; }
  const muted = run(createHaptics({ enabled: () => false }));
  assert.ok(muted.log.length <= 40, `静音那条长度 ${muted.log.length}`);
  const bare = run(createHaptics());
  assert.ok(bare.log.length <= 40, `无 wx 那条长度 ${bare.log.length}`);
});
