// 静帧热替换：目录、磁盘尺寸、加载成败，以及「有图就画、没图就留剪影」。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { HEROES, MONSTERS, TOWERS } from '../src/data.js';
import { createMatch, buildTower, upgradeTower } from '../src/match.js';
import { createRenderer } from '../src/render.js';
import {
  TILE_KINDS, actionKeys, actionSpriteKey, bootSprites, catalogKeys, clearSprites, heroSpriteKey, loadSprite,
  mobSpriteKey, registerSprite, resolveSprite, spriteCanvasSize, spriteFrame, spriteSrc, stillKeyOf,
  tileSpriteKey, towerSpriteKey,
} from '../src/assets.js';

globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };

const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

const fakeImage = ({ fail = false, w = 192, h = 192 } = {}) => () => {
  const img = { width: w, height: h, naturalWidth: w, naturalHeight: h };
  Object.defineProperty(img, 'src', {
    set() { queueMicrotask(() => (fail ? img.onerror?.() : img.onload?.())); },
  });
  return img;
};

const drawingContext = () => {
  const calls = [];
  const state = { strokeStyle: '', lineWidth: 1 };
  const rec = (name) => (...args) => {
    calls.push({ name, args, strokeStyle: state.strokeStyle, lineWidth: state.lineWidth });
  };
  const ctx = {
    calls,
    setTransform: rec('setTransform'), fillRect: rec('fillRect'), fillText: rec('fillText'),
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    closePath: rec('closePath'), fill: rec('fill'), stroke: rec('stroke'),
    ellipse: rec('ellipse'), save: rec('save'), restore: rec('restore'),
    drawImage: rec('drawImage'), setLineDash: rec('setLineDash'), strokeRect: rec('strokeRect'),
    measureText: (text) => ({ width: String(text).length * 8 }),
  };
  Object.defineProperty(ctx, 'strokeStyle', {
    set(v) { state.strokeStyle = v; },
    get() { return state.strokeStyle; },
  });
  Object.defineProperty(ctx, 'lineWidth', {
    set(v) { state.lineWidth = v; },
    get() { return state.lineWidth; },
  });
  return ctx;
};

const count = (ctx, name) => ctx.calls.filter((c) => c.name === name).length;

const drawMatch = (setup) => {
  const ctx = drawingContext();
  const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
  const r = createRenderer(canvas);
  const m = setup();
  r.draw({ m, selectedSlot: null, selectedTower: null, floaters: [], now: 0 });
  return { images: count(ctx, 'drawImage'), lines: count(ctx, 'lineTo'), fills: count(ctx, 'fill') };
};

const quietMatch = () => {
  const m = createMatch({ mapId: 'map_01', seed: 1 });
  m.gold = 99999;
  m.towers = [];
  m.monsters = [];
  return m;
};

const mobOn = (def) => {
  const m = quietMatch();
  m.monsters = [{
    uid: 1, mobId: def.id, def, pathIndex: 0, dist: 0,
    cell: { ...m.map.paths[0].spawn }, hp: def.hp, maxHp: def.hp,
    armorType: def.armorType, isAir: !!def.isAir, attacking: false, dead: false,
  }];
  return m;
};

describe('静帧热替换', { concurrency: 1 }, () => {
  beforeEach(() => clearSprites());
  afterEach(() => clearSprites());

  test('目录覆盖四种塔的三级、全部怪物和英雄、五种地块', () => {
    const keys = catalogKeys();
    assert.equal(keys.filter((k) => k.startsWith('towers/')).length, Object.keys(TOWERS).length * 3);
    for (const id of Object.keys(MONSTERS)) assert.ok(keys.includes(mobSpriteKey(id)));
    for (const id of Object.keys(HEROES)) assert.ok(keys.includes(heroSpriteKey(id)));
    for (const kind of TILE_KINDS) assert.ok(keys.includes(tileSpriteKey(kind)));
    assert.equal(towerSpriteKey('tw_arrow', 3), 'towers/tw_arrow_lv3');
    assert.equal(tileSpriteKey('tileA'), 'tiles/tile_a');
    assert.equal(spriteCanvasSize('mobs/boss_01_idle').w, 256);
    assert.equal(spriteCanvasSize('mobs/mob_10_idle').w, 160);
    assert.equal(spriteCanvasSize('mobs/mob_01_idle').w, 128);
  });

  test('每张静帧都在磁盘上，画布符合 §14.4，三级塔的图互不相同', () => {
    const seen = new Map();
    for (const key of catalogKeys()) {
      const buf = readFileSync(new URL(`../${spriteSrc(key)}`, import.meta.url));
      assert.equal(buf[0], 0x89);
      assert.equal(buf.toString('ascii', 1, 4), 'PNG');
      const size = spriteCanvasSize(key);
      assert.deepEqual(pngSize(buf), size, key);
      seen.set(key, createHash('sha1').update(buf).digest('hex'));
    }
    for (const id of Object.keys(TOWERS)) {
      const hashes = [1, 2, 3].map((lv) => seen.get(towerSpriteKey(id, lv)));
      assert.equal(new Set(hashes).size, 3, `${id} 的三级静帧应该画得不一样`);
    }
  });

  test('加载成功就登记，失败或没有 Image 就留空', async () => {
    const key = towerSpriteKey('tw_arrow', 1);
    const frame = await loadSprite(key, { createImage: fakeImage({ w: 192, h: 192 }) });
    assert.equal(frame.key, key);
    assert.equal(spriteFrame(key).w, 192);

    const missing = await loadSprite(towerSpriteKey('tw_cannon', 2), { createImage: fakeImage({ fail: true }) });
    assert.equal(missing, null);
    assert.equal(spriteFrame(towerSpriteKey('tw_cannon', 2)), null);

    const none = await loadSprite(key, { createImage: () => null });
    assert.equal(none, null);

    const image = globalThis.Image;
    const wx = globalThis.wx;
    delete globalThis.Image;
    delete globalThis.wx;
    try {
      assert.deepEqual(await bootSprites(), []);
    } finally {
      if (image) globalThis.Image = image;
      if (wx) globalThis.wx = wx;
    }
  });

  test('bootSprites 把目录里的图登记进去', async () => {
    const rows = await bootSprites({ createImage: fakeImage(), force: true });
    assert.equal(rows.length, catalogKeys().length);
    assert.ok(rows.every((row) => row.frame));
    assert.ok(spriteFrame(heroSpriteKey('hero_mage')));
  });

  test('没登记静帧时仍画剪影，不调用 drawImage', () => {
    const frame = drawMatch(() => {
      const m = quietMatch();
      assert.ok(buildTower(m, 0, 'tw_arrow'));
      assert.ok(upgradeTower(m, 0));
      assert.ok(upgradeTower(m, 0));
      return m;
    });
    assert.equal(frame.images, 0);
    assert.ok(frame.lines > 0);
  });

  test('塔只认自己的等级：Lv1 不能顶替 Lv3', () => {
    const place = () => {
      const m = quietMatch();
      assert.ok(buildTower(m, 0, 'tw_arrow'));
      assert.ok(upgradeTower(m, 0));
      assert.ok(upgradeTower(m, 0));
      assert.equal(m.towers[0].level, 3);
      return m;
    };
    const geometry = drawMatch(place);
    const borrowed = drawMatch(() => {
      registerSprite(towerSpriteKey('tw_arrow', 1), { width: 192, height: 192 });
      return place();
    });
    const swapped = drawMatch(() => {
      registerSprite(towerSpriteKey('tw_arrow', 3), { width: 192, height: 192 });
      return place();
    });
    assert.equal(borrowed.images, 0);
    assert.ok(borrowed.lines >= geometry.lines);
    assert.ok(swapped.images >= 1);
    assert.ok(swapped.lines < geometry.lines);
  });

  test('怪物有待机图就画图，否则仍走剪影', () => {
    const geometry = drawMatch(() => mobOn(MONSTERS.mob_03));
    const swapped = drawMatch(() => {
      registerSprite(mobSpriteKey('mob_03'), { width: 128, height: 128 });
      return mobOn(MONSTERS.mob_03);
    });
    assert.equal(geometry.images, 0);
    assert.ok(swapped.images >= 1);
    assert.ok(swapped.lines < geometry.lines);
  });

  test('可建地有图就贴图，路径格子仍用填色', () => {
    const geometry = drawMatch(quietMatch);
    const swapped = drawMatch(() => {
      registerSprite(tileSpriteKey('tileA'), { width: 64, height: 32 });
      registerSprite(tileSpriteKey('tileB'), { width: 64, height: 32 });
      return quietMatch();
    });
    assert.ok(swapped.images > 50, '大部分可建地应该换成贴图');
    assert.ok(swapped.fills < geometry.fills, '贴上地块之后填色次数要下降');
    assert.ok(swapped.fills > 0, '路径格子没有贴图，仍要填色');
  });

  test('路径贴图外面仍是硬边，可建地贴图走软边', () => {
    const { ctx } = (() => {
      registerSprite(tileSpriteKey('path'), { width: 64, height: 32 });
      registerSprite(tileSpriteKey('tileA'), { width: 64, height: 32 });
      registerSprite(tileSpriteKey('tileB'), { width: 64, height: 32 });
      const drawn = drawingContext();
      const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => drawn };
      const r = createRenderer(canvas);
      const m = quietMatch();
      r.draw({ m, selectedSlot: null, selectedTower: null, floaters: [], now: 0 });
      return { ctx: drawn };
    })();
    const hard = ctx.calls.filter((c) => c.name === 'stroke' && c.strokeStyle === '#141c28' && c.lineWidth >= 2.5);
    const soft = ctx.calls.filter((c) => c.name === 'stroke' && c.strokeStyle === 'rgba(90,140,200,.10)');
    assert.ok(hard.length > 10, '路径格要描硬边');
    assert.ok(soft.length > hard.length, '可建地用软边，而且数量更多');
  });

  test('英雄待机图在死亡时让回灰色剪影', () => {
    const alive = drawMatch(() => {
      registerSprite(heroSpriteKey('hero_warrior'), { width: 128, height: 128 });
      return quietMatch();
    });
    const dead = drawMatch(() => {
      registerSprite(heroSpriteKey('hero_warrior'), { width: 128, height: 128 });
      const m = quietMatch();
      m.hero.dead = true;
      return m;
    });
    assert.ok(alive.images >= 1);
    assert.equal(dead.images, 0);
    assert.ok(dead.lines > alive.lines);
  });

  test('短序列和静帧同一画布，缺了就回退，死亡不借用站立图', async () => {
    assert.ok(actionKeys().length > catalogKeys().length);
    assert.equal(stillKeyOf('mobs/boss_01_walk_2'), 'mobs/boss_01_idle');
    assert.equal(spriteCanvasSize('mobs/boss_01_death_1').w, 256);
    assert.equal(spriteCanvasSize('towers/tw_frost_lv3_attack_2').w, 192);
    assert.equal(actionSpriteKey(heroSpriteKey('hero_mage'), 'walk', 1), 'heroes/hero_mage_walk_1');
    let bytes = 0;
    for (const key of actionKeys()) {
      const buf = readFileSync(new URL(`../${spriteSrc(key)}`, import.meta.url));
      assert.equal(buf.toString('ascii', 1, 4), 'PNG', key);
      assert.deepEqual(pngSize(buf), spriteCanvasSize(key), key);
      assert.ok(buf.length < 12_000, `${key} 有 ${buf.length} 字节，手机上不该这么大`);
      bytes += buf.length;
    }
    assert.ok(bytes < 1_500_000, `动作帧合计 ${bytes} 字节`);

    const idle = { width: 128, height: 128, tag: 'idle' };
    const walk = { width: 128, height: 128, tag: 'walk' };
    registerSprite(mobSpriteKey('mob_01'), idle);
    assert.equal(resolveSprite(mobSpriteKey('mob_01'), 'walk', 1), spriteFrame(mobSpriteKey('mob_01')));
    registerSprite(actionSpriteKey(mobSpriteKey('mob_01'), 'walk', 1), walk);
    assert.equal(resolveSprite(mobSpriteKey('mob_01'), 'walk', 0).image, idle);
    assert.equal(resolveSprite(mobSpriteKey('mob_01'), 'walk', 1).image, walk);
    assert.equal(resolveSprite(mobSpriteKey('mob_01'), 'death', 2), null);

    const drawn = (now) => {
      const ctx = drawingContext();
      const canvas = { clientWidth: 800, clientHeight: 450, width: 0, height: 0, getContext: () => ctx };
      const r = createRenderer(canvas);
      const m = mobOn(MONSTERS.mob_01);
      r.draw({ m, selectedSlot: null, selectedTower: null, floaters: [], now });
      return ctx.calls.filter((c) => c.name === 'drawImage').map((c) => c.args[0]);
    };
    assert.ok(drawn(0).includes(idle));
    assert.ok(!drawn(0).includes(walk));
    assert.ok(drawn(0.2).includes(walk));
  });
});
