// §14.6：正式静帧和 P0 剪影共用同一套 id。图加载成功就画图，缺文件或失败就留着剪影。
// 这一层不解码玩法，也不在导入时发请求——调用方（浏览器入口 / 小游戏入口）自己 boot。

import { HEROES, MONSTERS, TOWERS } from './data.js';

/** P1 先接的五种地块。角块变体仍按 §14.4 以后再加，加载器不认别的名字。 */
export const TILE_KINDS = ['tile_a', 'tile_b', 'path', 'swamp', 'lava'];

const ready = new Map();
let bootTask = null;

const clampLevel = (level) => Math.min(3, Math.max(1, Math.round(Number(level) || 1)));

/** 塔：`towers/{id}_lv{1|2|3}`。等级必须对上，缺 Lv3 不借用 Lv1。 */
export function towerSpriteKey(towerId, level = 1) {
  return `towers/${towerId}_lv${clampLevel(level)}`;
}

/** 怪：`mobs/{id}_idle`。只认待机静帧。 */
export function mobSpriteKey(mobId) {
  return `mobs/${mobId}_idle`;
}

/** 英雄：`heroes/{id}_idle`。队伍色不进这张图。 */
export function heroSpriteKey(heroId) {
  return `heroes/${heroId}_idle`;
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

/** §14.4 的画布。未知键返回 null，调用方就当没有这张图。 */
export function spriteCanvasSize(key) {
  if (key.startsWith('towers/')) return { w: 192, h: 192 };
  if (key.startsWith('heroes/')) return { w: 128, h: 128 };
  if (key.startsWith('tiles/')) return { w: 64, h: 32 };
  if (key.startsWith('mobs/')) {
    const id = key.slice('mobs/'.length).replace(/_idle$/, '');
    const tier = MONSTERS[id]?.tier;
    if (tier === 'boss') return { w: 256, h: 256 };
    if (tier === 'elite') return { w: 160, h: 160 };
    return { w: 128, h: 128 };
  }
  return null;
}

/** 当前数据表里每一件该有的静帧。多出来的文件加载器可以登记，但开机只请求这一份。 */
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

export function spriteFrame(key) {
  const frame = ready.get(key);
  return frame?.image ? frame : null;
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
 * 加载一张。失败返回 null，不往表里写——下一帧继续画剪影。
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
 * 开机拉目录里的静帧。没有 `Image` 的环境（Node 用例）直接返回空列表，不挂请求。
 * 重复调用复用同一次加载；测试要重来就 `clearSprites()`。
 */
export function bootSprites(opts = {}) {
  if (!canLoad(opts)) return Promise.resolve([]);
  if (bootTask && !opts.force) return bootTask;
  bootTask = loadSprites(opts.keys ?? catalogKeys(), opts);
  return bootTask;
}
