// 静帧和短序列共用同一套 id。动作帧缺了就回待机静帧，静帧也缺了就留 P0 剪影。
// 死亡不回退到站着的静帧。这一层不解码玩法，也不在导入时发请求。

import { HEROES, MONSTERS, TOWERS } from './data.js';

/** P1 先接的五种地块。角块变体仍按 §14.4 以后再加，加载器不认别的名字。 */
export const TILE_KINDS = ['tile_a', 'tile_b', 'path', 'swamp', 'lava'];

/** 短序列只做这两帧。第 0 帧就是待机静帧，不另存文件。 */
export const ACTION_CLIPS = Object.freeze({
  walk: Object.freeze([1, 2]),
  attack: Object.freeze([1, 2]),
  death: Object.freeze([1, 2]),
});

const ready = new Map();
let bootTask = null;

const clampLevel = (level) => Math.min(3, Math.max(1, Math.round(Number(level) || 1)));

/** 塔：`towers/{id}_lv{1|2|3}`。等级必须对上，缺 Lv3 不借用 Lv1。 */
export function towerSpriteKey(towerId, level = 1) {
  return `towers/${towerId}_lv${clampLevel(level)}`;
}

/** 怪：`mobs/{id}_idle`。这是第 0 帧（休息姿势）。 */
export function mobSpriteKey(mobId) {
  return `mobs/${mobId}_idle`;
}

/** 英雄：`heroes/{id}_idle`。队伍色不进这张图。 */
export function heroSpriteKey(heroId) {
  return `heroes/${heroId}_idle`;
}

/**
 * 动作帧。`frame` 从 1 起；0 就是上面的静帧。
 * 怪和英雄会先去掉 `_idle`：`mobs/mob_01_walk_1`。
 * 塔把等级留在键里：`towers/tw_arrow_lv2_attack_1`。塔不走路。
 */
export function actionSpriteKey(baseKey, clip, frame) {
  const stem = (baseKey.startsWith('mobs/') || baseKey.startsWith('heroes/'))
    ? baseKey.replace(/_idle$/, '')
    : baseKey;
  return `${stem}_${clip}_${frame}`;
}

/** 动作帧、静帧都归一到待机键。认不出就返回 null。 */
export function stillKeyOf(key) {
  if (!key || typeof key !== 'string') return null;
  const tower = key.match(/^(towers\/tw_[a-z]+_lv[123])(?:_(?:attack|death)_\d+)?$/);
  if (tower) return tower[1];
  const mob = key.match(/^(mobs\/(?:mob|boss)_\d+)(?:_idle|_(?:walk|attack|death)_\d+)?$/);
  if (mob) return `${mob[1]}_idle`;
  const hero = key.match(/^(heroes\/hero_[a-z]+)(?:_idle|_(?:walk|attack|death)_\d+)?$/);
  if (hero) return `${hero[1]}_idle`;
  if (key.startsWith('tiles/')) return key;
  return null;
}

/**
 * 地块键。`terrainPaint` 用的是 `tileA` / `tileB`，文件名是 `tile_a` / `tile_b`。
 */
export function tileSpriteKey(kind) {
  const name = kind === 'tileA' ? 'tile_a' : kind === 'tileB' ? 'tile_b' : kind;
  return `tiles/${name}`;
}

/** 相对站点根目录的 URL。`serve.mjs` 从仓库根提供这段路径。 */
export function spriteSrc(key) {
  return `assets/${key}.png`;
}

/** §14.4 的画布。动作帧和它的静帧同一尺寸。未知键返回 null。 */
export function spriteCanvasSize(key) {
  const still = stillKeyOf(key);
  if (!still) return null;
  if (still.startsWith('towers/')) return { w: 192, h: 192 };
  if (still.startsWith('heroes/')) return { w: 128, h: 128 };
  if (still.startsWith('tiles/')) return { w: 64, h: 32 };
  if (still.startsWith('mobs/')) {
    const id = still.slice('mobs/'.length).replace(/_idle$/, '');
    const tier = MONSTERS[id]?.tier;
    if (tier === 'boss') return { w: 256, h: 256 };
    if (tier === 'elite') return { w: 160, h: 160 };
    return { w: 128, h: 128 };
  }
  return null;
}

/** 当前数据表里每一件该有的静帧。开机先要这一份。 */
export function catalogKeys() {
  const keys = [];
  for (const id of Object.keys(TOWERS)) {
    for (const lv of [1, 2, 3]) keys.push(towerSpriteKey(id, lv));
  }
  for (const id of Object.keys(MONSTERS)) keys.push(mobSpriteKey(id));
  for (const id of Object.keys(HEROES)) keys.push(heroSpriteKey(id));
  for (const kind of TILE_KINDS) keys.push(tileSpriteKey(kind));
  return keys;
}

/** 可选短序列。缺文件不影响开机；加载失败就当没有这帧。 */
export function actionKeys() {
  const keys = [];
  const push = (base, clips) => {
    for (const clip of clips) {
      for (const frame of ACTION_CLIPS[clip]) keys.push(actionSpriteKey(base, clip, frame));
    }
  };
  for (const id of Object.keys(TOWERS)) {
    for (const lv of [1, 2, 3]) push(towerSpriteKey(id, lv), ['attack', 'death']);
  }
  for (const id of Object.keys(MONSTERS)) push(mobSpriteKey(id), ['walk', 'attack', 'death']);
  for (const id of Object.keys(HEROES)) push(heroSpriteKey(id), ['walk', 'attack', 'death']);
  return keys;
}

export function spriteFrame(key) {
  const frame = ready.get(key);
  return frame?.image ? frame : null;
}

/**
 * 选一帧。热路径只做 Map 查找，不分配画布。
 * 走/攻：要的那帧没有就回静帧。死亡：不回站立静帧，没有死亡帧就返回 null（调用方画剪影）。
 */
export function resolveSprite(baseKey, clip, index) {
  if (!baseKey) return null;
  if (clip === 'death') {
    const want = index > 0 ? index : 1;
    const hit = ready.get(actionSpriteKey(baseKey, 'death', want));
    if (hit?.image) return hit;
    if (want !== 1) {
      const mid = ready.get(actionSpriteKey(baseKey, 'death', 1));
      if (mid?.image) return mid;
    }
    return null;
  }
  if (index > 0 && (clip === 'walk' || clip === 'attack')) {
    const hit = ready.get(actionSpriteKey(baseKey, clip, index));
    if (hit?.image) return hit;
  }
  const still = ready.get(baseKey);
  return still?.image ? still : null;
}

export function registerSprite(key, image, meta = {}) {
  if (!key || !image) return null;
  const expect = spriteCanvasSize(key) ?? { w: 0, h: 0 };
  const frame = {
    key,
    image,
    w: meta.w || image.naturalWidth || image.width || expect.w,
    h: meta.h || image.naturalHeight || image.height || expect.h,
  };
  ready.set(key, frame);
  return frame;
}

export function clearSprites() {
  ready.clear();
  bootTask = null;
}

function defaultCreateImage() {
  if (typeof Image === 'function') return new Image();
  if (typeof globalThis.wx?.createImage === 'function') return globalThis.wx.createImage();
  return null;
}

function canLoad(opts) {
  if (opts.createImage) return true;
  if (typeof Image === 'function') return true;
  return typeof globalThis.wx?.createImage === 'function';
}

/**
 * 加载一张。失败返回 null，不往表里写——下一帧继续画静帧或剪影。
 * `createImage` 供测试注入；不传就用浏览器 `Image` 或小游戏 `wx.createImage`。
 */
export async function loadSprite(key, opts = {}) {
  const factory = opts.createImage ?? defaultCreateImage;
  const img = factory();
  if (!img) return null;
  const url = opts.src ?? spriteSrc(key);
  const ok = await new Promise((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    try { img.src = url; } catch { resolve(false); }
  });
  if (!ok) return null;
  return registerSprite(key, img);
}

export async function loadSprites(keys, opts = {}) {
  const rows = await Promise.all(keys.map(async (key) => {
    const frame = await loadSprite(key, opts);
    return { key, frame };
  }));
  return rows;
}

/**
 * 开机先拉静帧，再拉短序列。返回的是静帧那一份（和 P1 一样）。
 * 短序列失败不挡静帧。没有 `Image` 的环境直接返回空列表。
 * 重复调用复用同一次加载；测试要重来就 `clearSprites()`。
 */
export function bootSprites(opts = {}) {
  if (!canLoad(opts)) return Promise.resolve([]);
  if (bootTask && !opts.force) return bootTask;
  const stills = opts.keys ?? catalogKeys();
  const actions = opts.actionKeys === false ? [] : (opts.actionKeys ?? (opts.keys ? [] : actionKeys()));
  bootTask = (async () => {
    const rows = await loadSprites(stills, opts);
    if (actions.length) await loadSprites(actions, opts);
    return rows;
  })();
  return bootTask;
}
