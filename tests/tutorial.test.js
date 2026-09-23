// 新手引导：状态机推进、跳过、以及 §1.8 的两条验收口径。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTutorial, TUTORIAL_STEPS, tutorialPasses } from '../src/tutorial.js';

test('步骤推进：建第一座塔 → 再建两座 → 开波 → 用技能 → 清掉第一波', () => {
  const t = createTutorial({ startedAt: 0 });
  assert.equal(t.current().id, 'build_first');
  assert.equal(t.hintSlotCount(), 3, '第一步要标出几个可建塔位');

  t.onTowerBuilt(20);
  assert.equal(t.current().id, 'build_more');
  t.onTowerBuilt(30);   // 建议再建两座
  assert.equal(t.current().id, 'build_more', '建塔数量只是建议，推进靠「开波」这个动作');
  t.onWaveStarted(1, 55);
  assert.equal(t.current().id, 'use_skill');
  t.onSkillCast();
  assert.equal(t.current().id, 'clean_wave');
  t.onWaveCleared(1, 150);
  assert.equal(t.done, true);
  assert.equal(t.current(), null, '完成后不再显示提示');
});

test('时序：先开波也能推进（玩家不按顺序来时不卡死）', () => {
  const t = createTutorial({ startedAt: 0 });
  t.onWaveStarted(1, 30);
  assert.equal(t.current().id, 'build_first', '没建塔时仍停在第一步');
  t.onTowerBuilt(35);
  assert.equal(t.current().id, 'build_more');
  t.onWaveCleared(1, 90);
  assert.ok(t.done === false || t.current() !== null, '中途清波不会跳过剩余提示');
});

test('跳过：跳过后不再给提示，但已经记录的时序仍然保留', () => {
  const t = createTutorial({ startedAt: 0 });
  t.onTowerBuilt(15);
  t.skip();
  t.onWaveStarted(1, 40);
  t.onWaveCleared(1, 100);
  assert.equal(t.current(), null);
  assert.equal(t.summary().secondsToFirstTower, 15);
});

test('§1.8 验收：80 秒建塔 + 140 秒打完第一波 → 两项都过', () => {
  const t = createTutorial({ startedAt: 0 });
  t.onTowerBuilt(80);
  t.onWaveStarted(85);
  t.onWaveCleared(1, 140);
  const s = t.summary();
  assert.equal(s.secondsToFirstTower, 80);
  assert.equal(s.secondsToWaveCleared, 140);
  assert.deepEqual(tutorialPasses(s), { firstTowerOk: true, firstWaveOk: true });
});

test('§1.8 验收：手忙脚乱超时就判不合格（这条要有能力失败）', () => {
  const t = createTutorial({ startedAt: 0 });
  t.onTowerBuilt(120);              // 超过 90 秒
  t.onWaveStarted(130);
  t.onWaveCleared(1, 260);          // 超过 180 秒
  const s = t.summary();
  assert.deepEqual(tutorialPasses(s), { firstTowerOk: false, firstWaveOk: false });
  assert.deepEqual(tutorialPasses({ secondsToFirstTower: null, secondsToWaveCleared: null }),
    { firstTowerOk: false, firstWaveOk: false }, '没建塔/没清波也算不合格');
});

test('提示文案覆盖三个关键动作（建塔 / 开波 / 技能），且不做成长教程', () => {
  const texts = TUTORIAL_STEPS.map((s) => s.text).join(' ');
  assert.match(texts, /箭塔/);
  assert.match(texts, /提前开波/);
  assert.match(texts, /旋风斩/);
  assert.ok(TUTORIAL_STEPS.length <= 5, '引导不能太长——碎片场景里没人看长教程');
});
