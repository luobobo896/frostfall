// 北极星文案：双模式称呼和文档锁，防止以后又写成通用手游塔防。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { heroDuty } from '../src/hud-model.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('两个模式的称呼成对：驻守英雄 / Guardian，出征英雄 / Champion', () => {
  assert.deepEqual(heroDuty('td'), { zh: '驻守英雄', en: 'Guardian', mark: '驻' });
  assert.deepEqual(heroDuty('defense'), { zh: '出征英雄', en: 'Champion', mark: '征' });
  assert.deepEqual(heroDuty('anything-else'), heroDuty('td'));
});

test('DIRECTION 写明双幻想、剪影阶层、微信帧率，并把手游 TD 降为次要参考', () => {
  const doc = read('../docs/art/DIRECTION.md');
  assert.match(doc, /^## 风格$/m);
  assert.match(doc, /^## 剪影$/m);
  assert.match(doc, /^## 这一批不做什么$/m);
  assert.match(doc, /TD 车道清场与要塞/);
  assert.match(doc, /英雄守护/);
  assert.match(doc, /Boss > Hero > Elite > Normal/);
  assert.match(doc, /塔是建筑体量/);
  assert.match(doc, /英雄是战士/);
  assert.match(doc, /驻守英雄 \/ Guardian/);
  assert.match(doc, /出征英雄 \/ Champion/);
  assert.match(doc, /≥60fps/);
  assert.match(doc, /触摸优先/);
  assert.match(doc, /120fps/);
  for (const name of ['Kingdom Rush', '植物大战僵尸', '气球塔防']) {
    assert.match(doc, new RegExp(name));
  }
  assert.match(doc, /次要参考/);
  assert.doesNotMatch(doc, /不在这批图里做驻点/);
});

test('NORTH_STAR 按当前 main 分开「已落地」和「仍开放」', () => {
  const doc = read('../docs/art/NORTH_STAR.md');
  for (const shipped of [
    '寒霜祭坛', '燎野炮台', '风暴电笼', '穿云箭楼', '哨楼',
    '霜狼冲刺', '亡语蛛后隐身', '霜壳尸',
    '双峰隘口', '32 格', '57 格',
    '驻守点', '记分',
  ]) {
    assert.match(doc, new RegExp(shipped), `已落地清单缺 ${shipped}`);
  }
  assert.match(doc, /M3/);
  assert.match(doc, /map_04/);
  assert.match(doc, /Boss 召唤/);
  assert.match(doc, /≥60fps/);
  const shippedAt = doc.indexOf('## 已在 main');
  const openAt = doc.indexOf('## 仍开放');
  assert.ok(shippedAt > 0 && openAt > shippedAt);
  const shippedBody = doc.slice(shippedAt, openAt);
  const openBody = doc.slice(openAt);
  assert.match(shippedBody, /双峰隘口/);
  assert.doesNotMatch(shippedBody, /map_04/);
  assert.match(openBody, /每人一个英雄/);
  assert.doesNotMatch(openBody, /寒霜祭坛/);
});

test('STATUS 与设计文档不再把冲刺、隐身、霜壳写成还没做', () => {
  const status = read('../docs/STATUS.md');
  const design = read('../docs/game-design.md');
  assert.match(status, /霜狼冲刺、蛛后隐身、霜壳尸/);
  assert.match(status, /map_02/);
  assert.match(design, /霜狼（mob_02）周期性加速/);
  assert.match(design, /NORTH_STAR\.md/);
  assert.match(design, /车道清场与要塞/);
  assert.doesNotMatch(design, /抗性皮肤）没做/);
});
