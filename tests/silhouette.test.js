// 剪影墙：涂成纯黑、保住宽高比之后，跨职责的重叠不得超过 30%。
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { BODY_PX, bodyRadius } from '../src/render.js';
import { spriteSrc } from '../src/assets.js';

const decodeAlpha = (buf) => {
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  let off = 8;
  const parts = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') parts.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const alpha = new Uint8Array(w * h);
  const stride = w * 4 + 1;
  for (let y = 0; y < h; y++) {
    if (raw[y * stride] !== 0) throw new Error('只接受无过滤的 PNG');
    for (let x = 0; x < w; x++) alpha[y * w + x] = raw[y * stride + 1 + x * 4 + 3];
  }
  return { w, h, alpha };
};

/** 不拉伸宽高比，放进 N×N，脚和头的比例还在。 */
const shapeMask = (img, n = 48) => {
  let minX = img.w;
  let minY = img.h;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.alpha[y * img.w + x] < 32) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const bw = Math.max(1, maxX - minX + 1);
  const bh = Math.max(1, maxY - minY + 1);
  const scale = (n - 2) / Math.max(bw, bh);
  const ox = (n - bw * scale) / 2;
  const oy = (n - bh * scale) / 2;
  const mask = new Uint8Array(n * n);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (img.alpha[y * img.w + x] < 32) continue;
      const mx = Math.min(n - 1, Math.max(0, Math.floor(ox + (x - minX) * scale)));
      const my = Math.min(n - 1, Math.max(0, Math.floor(oy + (y - minY) * scale)));
      mask[my * n + mx] = 1;
    }
  }
  return mask;
};

/** Jaccard：交集 / 并集。较小的那个完全落进较大的那个里时，这个数仍然低。 */
const collision = (a, b) => {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const on = (a[i] ? 1 : 0) + (b[i] ? 1 : 0);
    if (on) union += 1;
    if (on === 2) inter += 1;
  }
  return union ? inter / union : 0;
};

const load = (key) => shapeMask(decodeAlpha(readFileSync(new URL(`../${spriteSrc(key)}`, import.meta.url))));

const pairs = (keys) => {
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) out.push([keys[i], keys[j]]);
  }
  return out;
};

test('五档身高：Boss > Hero > Elite > Creep，英雄不低于精英，塔随等级变厚', () => {
  assert.ok(BODY_PX.boss > BODY_PX.hero);
  assert.ok(BODY_PX.hero > BODY_PX.elite);
  assert.ok(BODY_PX.elite > BODY_PX.creep);
  assert.ok(BODY_PX.hero >= BODY_PX.elite);
  assert.ok(BODY_PX.tower[0] < BODY_PX.tower[1] && BODY_PX.tower[1] < BODY_PX.tower[2]);
  const scale = 0.74;
  assert.ok(bodyRadius('boss', scale) * 2.5 > bodyRadius('hero', scale) * 2.6);
  assert.ok(bodyRadius('hero', scale) > bodyRadius('elite', scale));
});

test('纯黑剪影墙：跨职责重叠不超过 30%', () => {
  const groups = [
    ['towers/tw_arrow_lv2', 'towers/tw_cannon_lv2', 'towers/tw_frost_lv2', 'towers/tw_static_lv2'],
    [
      'mobs/mob_01_idle', 'mobs/mob_02_idle', 'mobs/mob_03_idle', 'mobs/mob_04_idle',
      'mobs/mob_10_idle', 'mobs/mob_11_idle', 'mobs/mob_12_idle', 'mobs/boss_01_idle',
    ],
    ['heroes/hero_warrior_idle', 'heroes/hero_mage_idle', 'heroes/hero_ranger_idle', 'heroes/hero_paladin_idle'],
    ['heroes/hero_warrior_idle', 'towers/tw_arrow_lv2', 'mobs/mob_01_idle', 'mobs/boss_01_idle'],
  ];
  const bad = [];
  for (const group of groups) {
    const masks = new Map(group.map((key) => [key, load(key)]));
    for (const [a, b] of pairs(group)) {
      const ratio = collision(masks.get(a), masks.get(b));
      if (ratio > 0.30) bad.push(`${a} × ${b} = ${(ratio * 100).toFixed(1)}%`);
    }
  }
  assert.deepEqual(bad, []);
});
