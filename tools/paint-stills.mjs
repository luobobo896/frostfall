// 按 docs/art/DIRECTION.md 画待机静帧和 2 帧短序列。零依赖：手写 PNG。
// 重画：node tools/paint-stills.mjs
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MONSTERS, TOWERS } from '../src/data.js';
import { actionKeys, catalogKeys, spriteCanvasSize, stillKeyOf } from '../src/assets.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTLINE = [20, 28, 40, 255];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const name = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([len, name, data, sum]);
};

const encodePng = (w, h, rgba) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const hex = (s) => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
  255,
];

const shade = (rgb, k) => rgb.map((c, i) => (i === 3 ? c : Math.max(0, Math.min(255, Math.round(c * k)))));

const STONE = hex('#3c4a5a');
const STONE_DARK = hex('#24303c');
const TIMBER = hex('#6b5340');
const IRON = hex('#59636c');
const SNOW = hex('#d7e2ec');
const NECRO = hex('#7f9e92');

const surface = (w, h) => {
  const px = Buffer.alloc(w * h * 4);
  const set = (x, y, color) => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return;
    const a = color[3] ?? 255;
    if (a <= 0) return;
    const i = (iy * w + ix) * 4;
    px[i] = color[0];
    px[i + 1] = color[1];
    px[i + 2] = color[2];
    px[i + 3] = a;
  };
  return { w, h, px, set };
};

/** 单位坐标：x 以中线为 0，y 向上，0 是脚（贴着底边像素）。光源左上。 */
const unitOf = (w, h, pose = {}) => {
  const surf = surface(w, h);
  const dx = pose.dx || 0;
  const dy = pose.dy || 0;
  const sx = pose.sx || 1;
  const sy = pose.sy ?? 1;
  const lean = pose.lean || 0;
  const pt = (x, yUp) => {
    const y = yUp * sy + dy;
    const xx = x * sx + lean * yUp + dx;
    return [w / 2 + xx * w * 0.40, (h - 1) - y * (h - 1)];
  };
  const lit = (color, x, y, ax, ay) => {
    const k = 1 + Math.max(-0.22, Math.min(0.18, ((ax - x) + (ay - y)) / Math.max(12, w * 0.18)));
    return shade(color, k);
  };
  const fillPoly = (pts, color) => {
    const pix = pts.map(([x, y]) => pt(x, y));
    const ys = pix.map((p) => p[1]);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
    const cx = pix.reduce((s, p) => s + p[0], 0) / pix.length;
    const cy = pix.reduce((s, p) => s + p[1], 0) / pix.length;
    for (let y = y0; y <= y1; y++) {
      const scan = y + 0.5;
      const xs = [];
      for (let i = 0; i < pix.length; i++) {
        const [x1, y1] = pix[i];
        const [x2, y2] = pix[(i + 1) % pix.length];
        if ((y1 <= scan && y2 > scan) || (y2 <= scan && y1 > scan)) {
          xs.push(x1 + ((scan - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) surf.set(x, y, lit(color, x, y, cx, cy));
      }
    }
  };
  const line = (a, b, color, width) => {
    const [x0, y0] = pt(a[0], a[1]);
    const [x1, y1] = pt(b[0], b[1]);
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    const r = width / 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          if (ox * ox + oy * oy <= r * r + 0.25) surf.set(x + ox, y + oy, color);
        }
      }
    }
  };
  const strokePoly = (pts, color, width, closed = true) => {
    for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
      line(pts[i], pts[(i + 1) % pts.length], color, width);
    }
  };
  const fillEllipse = (cx, cy, rx, ry, color) => {
    const [px, py] = pt(cx, cy);
    const radX = Math.abs(pt(cx + rx, cy)[0] - px);
    const radY = Math.abs(pt(cx, cy + ry)[1] - py);
    for (let y = Math.floor(py - radY); y <= Math.ceil(py + radY); y++) {
      for (let x = Math.floor(px - radX); x <= Math.ceil(px + radX); x++) {
        const nx = (x - px) / Math.max(0.5, radX);
        const ny = (y - py) / Math.max(0.5, radY);
        if (nx * nx + ny * ny <= 1) surf.set(x, y, lit(color, x, y, px, py));
      }
    }
  };
  const strokeEllipse = (cx, cy, rx, ry, color, width) => {
    const steps = 40;
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * Math.PI * 2;
      const a1 = ((i + 1) / steps) * Math.PI * 2;
      line(
        [cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry],
        [cx + Math.cos(a1) * rx, cy + Math.sin(a1) * ry],
        color,
        width,
      );
    }
  };
  const inkW = Math.max(2, Math.round(w / 48));
  const poly = (pts, color) => {
    fillPoly(pts, color);
    strokePoly(pts, OUTLINE, inkW);
  };
  return { surf, poly, line, strokePoly, fillEllipse, strokeEllipse, inkW };
};

const opaqueCount = (surf) => {
  let n = 0;
  for (let i = 3; i < surf.px.length; i += 4) if (surf.px[i] > 0) n += 1;
  return n;
};

const bottomRow = (surf) => {
  let n = 0;
  const y = surf.h - 1;
  for (let x = 0; x < surf.w; x++) if (surf.px[(y * surf.w + x) * 4 + 3] > 0) n += 1;
  return n;
};

const TOWER_COLOR = {
  tw_arrow: hex('#dbe6f2'),
  tw_cannon: hex('#e0a15c'),
  tw_frost: hex('#79c8ee'),
  tw_static: hex('#b98ce6'),
};

const towerPose = (id, clip, frame) => {
  if (clip === 'death' && frame === 1) return { sy: 0.72, lean: 0.18 };
  if (clip === 'death' && frame === 2) return { sy: 0.28, sx: 1.35 };
  if (clip !== 'attack') return {};
  if (frame === 2) return id === 'tw_cannon' ? { dx: -0.04 } : { sy: 0.97 };
  if (id === 'tw_cannon') return { dx: -0.12 };
  if (id === 'tw_arrow') return { sy: 1.08 };
  if (id === 'tw_frost') return { sy: 1.16 };
  return { sx: 1.22 };
};

const paintTower = (id, level, clip, frame) => {
  const u = unitOf(192, 192, towerPose(id, clip, frame));
  const color = TOWER_COLOR[id];
  const accent = shade(color, 0.82);
  if (id === 'tw_arrow') {
    u.poly([[-0.22, 0], [0.22, 0], [0.16, 0.1], [-0.16, 0.1]], STONE_DARK);
    u.poly([[-0.05, 0.08], [0.05, 0.08], [0.04, 0.58], [-0.04, 0.58]], STONE);
    if (level < 3) u.poly([[-0.82, 0.58], [0.82, 0.58], [0, 1.05]], color);
    else {
      u.poly([[-0.16, 0.48], [0.16, 0.48], [0, 0.7]], color);
      u.poly([[-0.98, 0.16], [-0.66, 0.16], [-0.66, 0.98], [-0.98, 0.98]], color);
      u.poly([[-0.14, 0.4], [0.14, 0.4], [0.14, 1], [-0.14, 1]], accent);
      u.poly([[0.66, 0.16], [0.98, 0.16], [0.98, 0.98], [0.66, 0.98]], color);
    }
    u.poly([[-0.36, 0.52], [-0.12, 0.55], [-0.22, 0.78]], SNOW);
    if (level >= 2) u.poly([[-0.55, 0.08], [-0.16, 0.08], [-0.14, 0.36]], TIMBER);
  } else if (id === 'tw_cannon') {
    u.poly([[-0.55, 0], [0.28, 0], [0.22, 0.28], [-0.48, 0.32]], STONE);
    u.poly([[-0.4, 0.28], [0.08, 0.26], [0.06, 0.4], [-0.36, 0.42]], STONE_DARK);
    const reach = [0.72, 0.98, 1.22][level - 1];
    u.poly([[-0.02, 0.16], [reach, 0.12], [reach, 0.34], [-0.02, 0.38]], color);
    u.poly([[reach - 0.08, 0.1], [reach + 0.06, 0.1], [reach + 0.06, 0.36], [reach - 0.08, 0.36]], IRON);
    if (level >= 3) {
      u.poly([[-0.02, 0.34], [0.4, 0.32], [0.4, 0.44], [-0.02, 0.46]], shade(color, 0.72));
      u.poly([[-0.96, 0], [-0.74, 0], [-0.72, 0.36], [-0.98, 0.34]], STONE_DARK);
      u.poly([[-0.62, 0.02], [-0.48, 0.02], [-0.46, 0.28], [-0.64, 0.26]], IRON);
    }
  } else if (id === 'tw_frost') {
    u.poly([[-0.2, 0], [0.22, 0], [0.16, 0.08], [-0.14, 0.08]], STONE);
    const h = [0.78, 0.92, 1.08][level - 1];
    u.poly([[-0.78, 0.06], [-0.66, 0.06], [-0.74, h * 0.55]], color);
    u.poly([[-0.05, 0.06], [0.05, 0.06], [0, h]], shade(color, 1.15));
    u.poly([[0.64, 0.06], [0.78, 0.06], [0.7, h * 0.48]], accent);
    if (level >= 3) {
      u.poly([[-0.12, 0.18], [0.12, 0.18], [0, 1.02]], SNOW);
      u.poly([[-0.34, 0.12], [-0.16, 0.12], [-0.26, 0.62]], shade(color, 1.25));
      u.poly([[0.16, 0.12], [0.34, 0.12], [0.24, 0.55]], SNOW);
    }
  } else {
    u.poly([[-0.16, 0], [0.16, 0], [0.12, 0.1], [-0.12, 0.1]], STONE);
    u.poly([[-0.045, 0.08], [0.045, 0.08], [0.035, 0.55], [-0.035, 0.55]], IRON);
    u.fillEllipse(0, 0.62, 0.08, 0.06, color);
    const spread = frame === 1 && clip === 'attack' ? 0.28 : 0.08;
    const arc = (side, lift) => {
      const pts = [];
      for (let i = 0; i <= 5; i++) {
        const t = i / 5;
        pts.push([side * (0.04 + spread + Math.sin(t * Math.PI) * (1.15 + spread)), 0.08 + t * 0.2 + lift]);
      }
      u.strokePoly(pts, color, 6, false);
    };
    arc(-1, 0);
    arc(1, 0);
    if (level >= 2) u.poly([[-0.22, 0.5], [0.22, 0.5], [0, 0.7]], shade(color, 0.85));
    if (level >= 3) {
      u.poly([[-0.62, 0.22], [-0.08, 0.3], [-0.08, 0.44], [-0.62, 0.36]], shade(color, 0.7));
      u.poly([[0.08, 0.4], [0.66, 0.5], [0.66, 0.64], [0.08, 0.54]], IRON);
      u.poly([[-0.58, 0.58], [-0.1, 0.66], [-0.1, 0.8], [-0.58, 0.72]], shade(color, 0.85));
    }
  }
  return u.surf;
};

const mobColor = (def) => hex(def.isAir ? '#9ad8ff' : { elite: '#e8a33d', boss: '#d1503f' }[def.tier] ?? '#c9d6e6');

const mobPose = (clip, frame) => {
  if (clip === 'walk' && frame === 1) return { lean: -0.16, dx: -0.04 };
  if (clip === 'walk' && frame === 2) return { lean: 0.16, dx: 0.05, sy: 1.04 };
  if (clip === 'attack' && frame === 1) return { lean: 0.24, dx: 0.08 };
  if (clip === 'attack' && frame === 2) return { lean: -0.1, dx: -0.03 };
  if (clip === 'death' && frame === 1) return { sy: 0.62, lean: 0.32 };
  if (clip === 'death' && frame === 2) return { sy: 0.24, sx: 1.3 };
  return {};
};

const paintMob = (id, clip, frame) => {
  const def = MONSTERS[id];
  const size = def.tier === 'boss' ? 256 : def.tier === 'elite' ? 160 : 128;
  const u = unitOf(size, size, mobPose(clip, frame));
  const color = mobColor(def);
  const dark = shade(color, 0.72);
  if (def.tier === 'boss') {
    const spikes = id === 'boss_03' ? 10 : id === 'boss_02' ? 6 : 8;
    const squash = id === 'boss_01' ? 0.42 : 0.9;
    const raw = [];
    for (let i = 0; i < spikes; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / spikes;
      raw.push([Math.cos(a), 0.15 - Math.sin(a) * squash]);
    }
    const minY = Math.min(...raw.map((p) => p[1]));
    const shifted = raw.map(([x, y]) => [x * 0.86, y - minY]);
    u.fillEllipse(0, 0.2 - minY, 0.14, 0.1, color);
    for (const [x, y] of shifted) {
      u.poly([[-0.05, 0.18 - minY], [0.05, 0.18 - minY], [x, y]], color);
    }
    if (def.aura) u.strokeEllipse(0, 0.46, 0.96, 0.4, NECRO, 4);
  } else if (def.isAir) {
    u.poly([[0, 0.42], [0.12, 0.16], [0, 0], [-0.12, 0.16]], color);
    u.poly([[-0.06, 0.28], [-1.22, 0.92], [-0.95, 0.7], [-0.08, 0.22]], dark);
    u.poly([[0.06, 0.28], [1.22, 0.92], [0.95, 0.7], [0.08, 0.22]], dark);
    u.poly([[-0.06, 0.36], [0.05, 0.34], [0, 0.5]], STONE);
  } else if (def.onDeath) {
    u.fillEllipse(-0.78, 0.28, 0.28, 0.22, color);
    u.fillEllipse(0.82, 0.34, 0.24, 0.2, dark);
    u.strokeEllipse(-0.78, 0.28, 0.28, 0.22, OUTLINE, 2);
    u.strokeEllipse(0.82, 0.34, 0.24, 0.2, OUTLINE, 2);
    u.poly([[-1.02, 0], [-0.82, 0], [-0.9, 0.14]], dark);
    u.poly([[0.62, 0], [0.82, 0], [0.7, 0.16]], dark);
    u.poly([[0.95, 0], [1.12, 0], [1.02, 0.12]], dark);
  } else if (def.armorType === 'fortified' || def.siege) {
    u.poly([[-1.05, 0], [-1.05, 0.22], [0.55, 0.22], [0.55, 0]], color);
    u.poly([[0.15, 0.18], [0.85, 0.55], [0.62, 0.62], [0.05, 0.22]], SNOW);
  } else if (def.aura) {
    u.poly([[-0.06, 0], [-0.07, 0.28], [0, 0.4], [0.07, 0.28], [0.06, 0]], color);
    u.strokeEllipse(0, 0.22, 1.15, 0.32, NECRO, 5);
    u.poly([[0.1, 0.05], [0.16, 0.05], [0.16, 0.55], [0.1, 0.55]], IRON);
  } else if (id === 'mob_02') {
    u.poly([[-1.15, 0], [-1.05, 0.1], [0.45, 0.12], [0.95, 0.07], [0.8, 0], [-1.1, 0]], color);
    u.poly([[0.7, 0.02], [1.25, 0.07], [1.22, 0], [0.72, 0]], dark);
  } else if (id === 'mob_04') {
    u.poly([[-0.82, 0], [-0.88, 0.5], [-0.52, 0.52], [-0.46, 0]], color);
    u.poly([[0.48, 0], [0.44, 0.5], [0.8, 0.46], [0.86, 0]], color);
    u.poly([[-0.72, 0.58], [-0.58, 0.78], [0.62, 0.76], [0.74, 0.54]], dark);
    u.poly([[-0.18, 0.72], [0.16, 0.74], [0, 1.02]], TIMBER);
    u.poly([[-0.7, 0.66], [-0.98, 0.98], [-0.78, 1.04], [-0.5, 0.7]], TIMBER);
  } else {
    u.poly([[-1.02, 0.2], [-1.12, 0.55], [-0.4, 0.7], [-0.18, 0.32]], color);
    u.poly([[-0.78, 0], [-0.62, 0], [-0.7, 0.26]], color);
    u.poly([[-0.72, 0.48], [-0.98, 0.98], [-0.42, 0.52]], dark);
    u.poly([[0.78, 0], [1.16, 0], [1.08, 0.16], [0.7, 0.06]], dark);
    u.line([-0.22, 0.34], [0.78, 0.12], dark, 4);
  }
  return u.surf;
};

const HEROES_PAINT = {
  hero_warrior: { cloth: '#8e99a6', weapon: 'blade' },
  hero_mage: { cloth: '#3d4d66', weapon: 'staff' },
  hero_ranger: { cloth: '#5d6a48', weapon: 'bow' },
  hero_paladin: { cloth: '#8a7d62', weapon: 'hammer' },
};

const paintHero = (id, clip, frame) => {
  const pose = mobPose(clip, frame);
  const u = unitOf(128, 128, pose);
  const spec = HEROES_PAINT[id];
  const cloth = hex(spec.cloth);
  const skin = hex('#c3b39a');
  const ink = hex('#e7eef6');
  u.poly([[-0.08, 0], [-0.05, 0.22], [0.02, 0.22], [0, 0]], shade(cloth, 0.85));
  u.poly([[0.04, 0], [0.02, 0.22], [0.1, 0.22], [0.12, 0]], cloth);
  u.poly([[-0.14, 0.2], [0.12, 0.2], [0.08, 0.5], [-0.1, 0.5]], cloth);
  u.fillEllipse(0, spec.weapon === 'staff' ? 0.58 : 0.62, 0.1, 0.08, skin);
  u.strokeEllipse(0, spec.weapon === 'staff' ? 0.58 : 0.62, 0.1, 0.08, OUTLINE, 2);
  if (spec.weapon === 'staff') {
    u.poly([[0.16, 0], [0.26, 0], [0.26, 1.12], [0.16, 1.12]], ink);
    u.fillEllipse(0.21, 1.16, 0.12, 0.09, hex('#79c8ee'));
    u.strokeEllipse(0.21, 1.16, 0.12, 0.09, OUTLINE, 2);
  } else if (spec.weapon === 'bow') {
    u.poly([[0.08, 1.02], [1.15, 0.5], [0.08, 0], [0.22, 0.18], [0.72, 0.5], [0.22, 0.82]], ink);
  } else if (spec.weapon === 'hammer') {
    u.poly([[-0.95, 0.15], [-1.15, 0.55], [-0.7, 0.95], [-0.42, 0.4]], SNOW);
    u.poly([[0.16, 0.05], [0.26, 0.05], [0.26, 0.5], [0.16, 0.5]], ink);
    u.poly([[0.02, 0.5], [0.55, 0.48], [0.58, 0.78], [0.02, 0.8]], ink);
  } else {
    u.poly([[0.02, 0.12], [0.16, 0.22], [1.2, 1.2], [1.02, 1.05]], ink);
  }
  return u.surf;
};

const paintTile = (name) => {
  const surf = surface(64, 32);
  const diamond = [[32, 1], [62, 16], [32, 30], [1, 16]];
  const fill = {
    tile_a: hex('#10192a'),
    tile_b: hex('#0c1522'),
    path: hex('#6a7a90'),
    swamp: hex('#1d3a2c'),
    lava: hex('#5a2b1f'),
  }[name];
  const ys = diamond.map((p) => p[1]);
  for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
    const scan = y + 0.5;
    const xs = [];
    for (let i = 0; i < diamond.length; i++) {
      const [x1, y1] = diamond[i];
      const [x2, y2] = diamond[(i + 1) % diamond.length];
      if ((y1 <= scan && y2 > scan) || (y2 <= scan && y1 > scan)) {
        xs.push(x1 + ((scan - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) {
        const k = 1 + Math.max(-0.1, Math.min(0.1, (28 - x + 14 - y) / 90));
        surf.set(x, y, shade(fill, k));
      }
    }
  }
  if (name === 'tile_a' || name === 'tile_b') {
    surf.set(24, 12, hex('#8ea0b0'));
    surf.set(40, 18, hex('#6d7e90'));
  } else if (name === 'path') {
    surf.set(32, 16, hex('#8b98aa'));
    surf.set(26, 14, hex('#7e8b9c'));
    surf.set(38, 18, hex('#5c6b7e'));
  } else if (name === 'swamp') {
    surf.set(28, 14, hex('#8eaa96'));
    surf.set(36, 18, hex('#8eaa96'));
  } else if (name === 'lava') {
    surf.set(30, 15, hex('#8a4a32'));
    surf.set(36, 17, hex('#c48a58'));
  }
  return surf;
};

const paintJob = (key) => {
  const still = stillKeyOf(key);
  const action = key.match(/_(walk|attack|death)_(\d+)$/);
  const clip = action ? action[1] : 'idle';
  const frame = action ? Number(action[2]) : 0;
  if (still.startsWith('towers/')) {
    const id = still.slice('towers/'.length).replace(/_lv[123]$/, '');
    const level = Number(still.slice(-1));
    return paintTower(id, level, clip, frame);
  }
  if (still.startsWith('mobs/')) return paintMob(still.slice('mobs/'.length).replace(/_idle$/, ''), clip, frame);
  if (still.startsWith('heroes/')) return paintHero(still.slice('heroes/'.length).replace(/_idle$/, ''), clip, frame);
  if (still.startsWith('tiles/')) return paintTile(still.slice('tiles/'.length));
  throw new Error(`不认识的键 ${key}`);
};

const keys = [...catalogKeys(), ...actionKeys()];
for (const id of Object.keys(TOWERS)) {
  if (!keys.includes(`towers/${id}_lv1`)) throw new Error(`目录漏了 ${id}`);
}

const seen = new Map();
let bytes = 0;
let largest = 0;
for (const key of keys) {
  const expect = spriteCanvasSize(key);
  const surf = paintJob(key);
  if (surf.w !== expect.w || surf.h !== expect.h) throw new Error(`${key} 画布不是 ${expect.w}×${expect.h}`);
  if (opaqueCount(surf) < 12) throw new Error(`${key} 几乎是空的`);
  if (!key.startsWith('tiles/') && bottomRow(surf) < 1) throw new Error(`${key} 底边是空的`);
  const png = encodePng(surf.w, surf.h, surf.px);
  const hash = createHash('sha1').update(png).digest('hex');
  if (seen.has(hash)) throw new Error(`${key} 和 ${seen.get(hash)} 画得一样`);
  seen.set(hash, key);
  bytes += png.length;
  largest = Math.max(largest, png.length);
  const file = join(ROOT, 'assets', `${key}.png`);
  const prev = existsSync(file) ? readFileSync(file) : null;
  if (prev && prev.equals(png)) continue;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, png);
}

console.log(`wrote ${keys.length} pngs · ${bytes} bytes · largest ${largest}`);
