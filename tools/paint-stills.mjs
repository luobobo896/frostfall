// 按 docs/art/DIRECTION.md 画一批待机静帧。零依赖：手写 PNG，颜色和剪影跟 P0 对齐。
// 重画：node tools/paint-stills.mjs
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MONSTERS, TOWERS } from '../src/data.js';
import { catalogKeys, spriteCanvasSize } from '../src/assets.js';

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
    chunk('IDAT', deflateSync(raw)),
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

/** 单位坐标：x 以中线为 0，y 向上，0 是脚（贴着底边像素）。 */
const unitOf = (w, h) => {
  const surf = surface(w, h);
  const pt = (x, yUp) => [w / 2 + x * w * 0.40, h - yUp * (h - 2)];
  const lit = (color, x, y, ax, ay) => {
    const k = 1 + Math.max(-0.26, Math.min(0.26, ((ax - x) + (ay - y)) / Math.max(12, w * 0.18)));
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
        const nx = (x - px) / radX;
        const ny = (y - py) / radY;
        if (nx * nx + ny * ny <= 1) surf.set(x, y, lit(color, x, y, px, py));
      }
    }
  };
  const strokeEllipse = (cx, cy, rx, ry, color, width) => {
    const steps = 48;
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
  const poly = (pts, color) => {
    fillPoly(pts, color);
    strokePoly(pts, OUTLINE, Math.max(1, Math.round(w / 64)));
  };
  return { surf, poly, line, strokePoly, fillEllipse, strokeEllipse };
};

const opaqueCount = (surf) => {
  let n = 0;
  for (let i = 3; i < surf.px.length; i += 4) if (surf.px[i] > 0) n += 1;
  return n;
};

const TOWER_COLOR = {
  tw_arrow: hex('#dbe6f2'),
  tw_cannon: hex('#e0a15c'),
  tw_frost: hex('#79c8ee'),
  tw_static: hex('#b98ce6'),
};

const paintTower = (id, level) => {
  const u = unitOf(192, 192);
  const color = TOWER_COLOR[id];
  const accent = shade(color, 1.15);
  if (id === 'tw_arrow') {
    u.poly([[-0.16, 0], [0.16, 0], [0.12, 0.56], [-0.12, 0.56]], color);
    u.poly([[-0.32, 0.50], [0.32, 0.50], [0, 0.90]], accent);
    if (level >= 2) u.poly([[-0.36, 0.06], [-0.16, 0.06], [-0.14, 0.40]], shade(color, 0.82));
    if (level >= 3) u.poly([[-0.08, 0.86], [0.08, 0.86], [0, 1.02]], accent);
  } else if (id === 'tw_cannon') {
    u.poly([[-0.42, 0], [0.42, 0], [0.36, 0.36], [-0.36, 0.36]], color);
    const reach = [0.55, 0.78, 1.02][level - 1];
    u.poly([[0.02, 0.16], [reach, 0.16], [reach, 0.30], [0.02, 0.30]], accent);
    if (level >= 3) u.poly([[0.02, 0.32], [0.72, 0.32], [0.72, 0.42], [0.02, 0.42]], shade(color, 0.8));
  } else if (id === 'tw_frost') {
    const h = [0.62, 0.78, 0.92][level - 1];
    u.poly([[-0.34, 0], [-0.08, 0], [-0.21, h * 0.72]], color);
    u.poly([[-0.06, 0], [0.22, 0], [0.08, h]], accent);
    u.poly([[0.16, 0], [0.40, 0], [0.28, h * 0.64]], shade(color, 0.85));
    if (level >= 3) u.poly([[-0.08, 0], [0.08, 0], [0, h * 1.08]], shade(color, 1.2));
  } else {
    u.poly([[-0.06, 0], [0.06, 0], [0.05, 0.78], [-0.05, 0.78]], color);
    const arc = (side, lift) => {
      const pts = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        pts.push([side * (0.16 + Math.sin(t * Math.PI) * 0.34), 0.18 + t * 0.62 + lift]);
      }
      u.strokePoly(pts, accent, 3, false);
    };
    arc(-1, 0);
    arc(1, 0);
    if (level >= 2) u.poly([[-0.18, 0.74], [0.18, 0.74], [0, 0.96]], accent);
    if (level >= 3) { arc(-1, 0.12); arc(1, 0.12); }
  }
  return u.surf;
};

const mobColor = (def) => hex(def.isAir ? '#9ad8ff' : { elite: '#e8a33d', boss: '#d1503f' }[def.tier] ?? '#c9d6e6');

const paintMob = (id) => {
  const def = MONSTERS[id];
  const size = def.tier === 'boss' ? 256 : def.tier === 'elite' ? 160 : 128;
  const u = unitOf(size, size);
  const color = mobColor(def);
  const accent = shade(color, 0.78);
  if (def.tier === 'boss') {
    const spikes = id === 'boss_03' ? 10 : 8;
    const raw = [];
    for (let i = 0; i < spikes * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / spikes;
      const rad = i % 2 === 0 ? 1 : 0.46;
      raw.push([Math.cos(a) * rad, -Math.sin(a) * rad * 0.78]);
    }
    const minY = Math.min(...raw.map((p) => p[1]));
    const shifted = raw.map(([x, y]) => [x, y - minY]);
    const maxY = Math.max(...shifted.map((p) => p[1]));
    const maxX = Math.max(...shifted.map((p) => Math.abs(p[0])));
    u.poly(shifted.map(([x, y]) => [(x / maxX) * 0.78, (y / maxY) * 0.94]), color);
    if (def.aura) u.strokeEllipse(0, 0.48, 0.92, 0.42, hex('#ffd08a'), 3);
  } else if (def.isAir) {
    u.poly([[0, 0.88], [0.28, 0.28], [0, 0], [-0.28, 0.28]], color);
    u.poly([[-0.12, 0.42], [-1.05, 0.72], [-0.18, 0.16]], accent);
    u.poly([[0.12, 0.42], [1.05, 0.72], [0.18, 0.16]], accent);
  } else if (def.onDeath) {
    u.fillEllipse(-0.28, 0.22, 0.30, 0.22, color);
    u.fillEllipse(0.30, 0.30, 0.26, 0.20, accent);
    u.strokeEllipse(-0.28, 0.22, 0.30, 0.22, OUTLINE, 2);
    u.strokeEllipse(0.30, 0.30, 0.26, 0.20, OUTLINE, 2);
  } else if (def.armorType === 'fortified' || def.siege) {
    u.poly([
      [-0.55, 0.18], [-0.32, 0.62], [0.32, 0.62], [0.55, 0.18],
      [0.55, 0], [-0.55, 0],
    ], color);
    u.poly([[-0.16, 0.22], [0, 0.48], [0.16, 0.22], [0, 0.10]], accent);
  } else if (def.aura) {
    u.fillEllipse(0, 0.28, 0.28, 0.24, color);
    u.strokeEllipse(0, 0.28, 0.28, 0.24, OUTLINE, 2);
    u.strokeEllipse(0, 0.32, 0.62, 0.48, hex('#ffd08a'), 3);
  } else {
    const body = id === 'mob_04' ? 0.40 : id === 'mob_02' ? 0.30 : 0.34;
    const horn = id === 'mob_02' ? 0.55 : 0.42;
    u.fillEllipse(0, body * 0.7, body, body * 0.72, color);
    u.strokeEllipse(0, body * 0.7, body, body * 0.72, OUTLINE, 2);
    u.poly([[-0.12, body], [-horn, body + 0.48], [-0.02, body + 0.08]], accent);
    u.poly([[0.12, body], [horn, body + 0.48], [0.02, body + 0.08]], accent);
  }
  return u.surf;
};

const HEROES_PAINT = {
  hero_warrior: { cloth: '#c5d0dc', weapon: 'blade' },
  hero_mage: { cloth: '#6a7ea6', weapon: 'staff' },
  hero_ranger: { cloth: '#7d8f62', weapon: 'bow' },
  hero_paladin: { cloth: '#c4b48a', weapon: 'hammer' },
};

const paintHero = (id) => {
  const u = unitOf(128, 128);
  const spec = HEROES_PAINT[id];
  const cloth = hex(spec.cloth);
  u.fillEllipse(0, 0.78, 0.16, 0.13, shade(cloth, 1.12));
  u.strokeEllipse(0, 0.78, 0.16, 0.13, OUTLINE, 2);
  u.poly([[-0.22, 0], [-0.14, 0.64], [0.14, 0.64], [0.22, 0]], cloth);
  const ink = hex('#f4f7fb');
  if (spec.weapon === 'staff') {
    u.strokePoly([[0.28, 0.06], [0.28, 0.98]], ink, 3, false);
    u.fillEllipse(0.28, 1.02, 0.07, 0.06, ink);
  } else if (spec.weapon === 'bow') {
    u.strokePoly([[0.30, 0.78], [0.52, 0.40], [0.30, 0.08]], ink, 3, false);
    u.strokePoly([[0.30, 0.78], [0.30, 0.08]], ink, 2, false);
  } else if (spec.weapon === 'hammer') {
    u.strokePoly([[0.26, 0.08], [0.26, 0.70]], ink, 3, false);
    u.poly([[0.10, 0.70], [0.44, 0.70], [0.44, 0.86], [0.10, 0.86]], ink);
  } else {
    u.strokePoly([[0.10, 0.28], [0.55, 0.78]], ink, 3, false);
  }
  return u.surf;
};

const paintTile = (name) => {
  const surf = surface(64, 32);
  const diamond = [[32, 0], [63, 16], [32, 31], [0, 16]];
  const fill = {
    tile_a: hex('#10192a'),
    tile_b: hex('#0c1522'),
    path: hex('#6a7a90'),
    swamp: hex('#1d3a2c'),
    lava: hex('#5a2b1f'),
  }[name];
  const edge = name === 'path' ? hex('#141c28') : name === 'lava' ? hex('#e0a15c') : hex('#243044');
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
        const k = 1 + Math.max(-0.12, Math.min(0.12, (32 - x + 16 - y) / 80));
        surf.set(x, y, shade(fill, k));
      }
    }
  }
  const stroke = (a, b) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      surf.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, edge);
    }
  };
  for (let i = 0; i < diamond.length; i++) stroke(diamond[i], diamond[(i + 1) % diamond.length]);
  if (name === 'swamp') {
    surf.set(28, 14, hex('#a8d6b0'));
    surf.set(36, 18, hex('#a8d6b0'));
  }
  return surf;
};

const paintKey = (key) => {
  if (key.startsWith('towers/')) {
    const id = key.slice('towers/'.length).replace(/_lv[123]$/, '');
    const level = Number(key.slice(-1));
    return paintTower(id, level);
  }
  if (key.startsWith('mobs/')) return paintMob(key.slice('mobs/'.length).replace(/_idle$/, ''));
  if (key.startsWith('heroes/')) return paintHero(key.slice('heroes/'.length).replace(/_idle$/, ''));
  if (key.startsWith('tiles/')) return paintTile(key.slice('tiles/'.length));
  throw new Error(`不认识的键 ${key}`);
};

const keys = catalogKeys();
for (const id of Object.keys(TOWERS)) {
  if (!keys.includes(`towers/${id}_lv1`)) throw new Error(`目录漏了 ${id}`);
}

for (const key of keys) {
  const expect = spriteCanvasSize(key);
  const surf = paintKey(key);
  if (surf.w !== expect.w || surf.h !== expect.h) throw new Error(`${key} 画布不是 ${expect.w}×${expect.h}`);
  if (opaqueCount(surf) < 12) throw new Error(`${key} 几乎是空的`);
  const png = encodePng(surf.w, surf.h, surf.px);
  if (png.readUInt32BE(16) !== surf.w || png.readUInt32BE(20) !== surf.h) throw new Error(`${key} IHDR 不对`);
  const file = join(ROOT, 'assets', `${key}.png`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, png);
}

console.log(`wrote ${keys.length} stills`);
