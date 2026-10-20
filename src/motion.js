// 战场动势（P2）。纯函数，不读图、不碰 DOM。
// now === 0 且冷却为 0 时偏移是 0，静止帧和缺图剪影对齐。

/** 粒子上限。低档少留几条拖尾和命中，起伏仍然算（一个正弦，不占预算）。 */
export const FX_LIMITS = {
  high: { trail: 3, impacts: 8, corpses: 12 },
  low: { trail: 1, impacts: 4, corpses: 6 },
};

export function fxBudget(level) {
  return FX_LIMITS[level] ?? FX_LIMITS.high;
}

/** 刚开火时接近 1，冷却过了前 22% 就回到 0。冷却为 0（待命）不算后坐。 */
export function attackPulse(cooldown, atkSpeed) {
  if (!(cooldown > 0) || !(atkSpeed > 0)) return 0;
  const u = cooldown * atkSpeed;
  if (u > 0.78) return Math.min(1, (u - 0.78) / 0.22);
  return 0;
}

/** 快要开火的那一小段。电塔充电、冰塔聚晶用它，待命时为 0。 */
export function chargePulse(cooldown, atkSpeed) {
  if (!(cooldown > 0) || !(atkSpeed > 0)) return 0;
  const u = cooldown * atkSpeed;
  if (u < 0.18) return 1 - u / 0.18;
  return 0;
}

export function mobMotion({ now = 0, uid = 0, attacking = false, isAir = false, cooldown = 0, atkSpeed = 1 } = {}) {
  const pulse = attackPulse(cooldown, atkSpeed);
  const amp = isAir ? 3.4 : 2.4;
  const bob = now === 0 ? 0 : Math.sin(now * (isAir ? 8 : 6) + uid * 0.6) * amp;
  const lift = bob + (attacking ? pulse * 2 : 0);
  return { dy: lift === 0 ? 0 : -lift, pulse, bob };
}

/** 塔身偏移（像素，调用方再乘缩放）。影子和队伍色环留在原地。 */
export function towerNudge(towerId, pulse) {
  const k = pulse || 0;
  if (towerId === 'tw_cannon') return { dx: k * 5, dy: k * 1.2 };
  if (towerId === 'tw_frost') return { dx: 0, dy: -k * 3 };
  if (towerId === 'tw_static') return { dx: 0, dy: -k * 2 };
  return { dx: 0, dy: k * 3 };
}

/**
 * 后坐 / 蓄力时多出来的笔划。四种塔形状不同，待命时返回空数组，
 * 这样静止帧的折线签名不变。
 */
export function towerMarks(towerId, pulse, charge) {
  const marks = [];
  if (pulse > 0 && towerId === 'tw_arrow') {
    marks.push({ closed: false, points: [[0, -8], [0, -8 - 9 * pulse]] });
  }
  if (pulse > 0 && towerId === 'tw_cannon') {
    marks.push({ closed: false, points: [[2, 0], [2 + 12 * pulse, -1], [2 + 8 * pulse, 3]] });
  }
  if ((pulse > 0 || charge > 0) && towerId === 'tw_frost') {
    const h = 6 + 6 * Math.max(pulse, charge);
    marks.push({ closed: true, points: [[0, -h], [3.5, -h * 0.45], [0, 0], [-3.5, -h * 0.45]] });
  }
  if ((pulse > 0 || charge > 0) && towerId === 'tw_static') {
    const reach = 8 + 8 * Math.max(pulse, charge);
    marks.push({ closed: false, points: [[-4, 1], [-reach, -6], [-reach * 0.6, 2]] });
    marks.push({ closed: false, points: [[4, 1], [reach, -6], [reach * 0.6, 2]] });
  }
  return marks;
}

export function heroMotion({ now = 0, dead = false, cooldown = 0, atkSpeed = 1, uid = 0 } = {}) {
  if (dead) return { dx: 0, dy: 4, dissolve: true, pulse: 0 };
  const pulse = attackPulse(cooldown, atkSpeed);
  const bob = now === 0 ? 0 : Math.sin(now * 5 + uid) * 1.6;
  return { dx: pulse * 5, dy: -bob, dissolve: false, pulse };
}

/** 受击：两道斜线，不是变色。 */
export function hitSlash(size) {
  return [
    { closed: false, points: [[-size, -size * 0.15], [size * 0.35, size * 0.2]] },
    { closed: false, points: [[-size * 0.15, size * 0.45], [size * 0.85, -size * 0.05]] },
  ];
}

/** 减速：身体外三颗菱形，随时间转。不是一圈变蓝。 */
export function slowShards(now = 0) {
  return [0, 1, 2].map((i) => {
    const a = now * 2.2 + (i * Math.PI * 2) / 3;
    const cx = Math.cos(a) * 1.25;
    const cy = Math.sin(a) * 0.62;
    const s = 0.18;
    return [[cx, cy - s], [cx + s * 0.85, cy], [cx, cy + s], [cx - s * 0.85, cy]];
  });
}

export function shotKind(towerId) {
  if (towerId === 'tw_cannon') return 'shell';
  if (towerId === 'tw_frost') return 'shard';
  if (towerId === 'tw_static') return 'bolt';
  return 'chevron';
}

function diamond(x, y, s) {
  return [[x, y - s], [x + s * 0.72, y], [x, y + s], [x - s * 0.72, y]];
}

/** 弹道本体。shell 是封闭菱形，shard 是两颗小菱形，bolt 是折线，chevron 是开口箭头。 */
export function shotGlyphs(kind, x, y, ux, uy, size = 8) {
  const px = -uy;
  const py = ux;
  if (kind === 'shell') return [{ closed: true, points: diamond(x, y, size) }];
  if (kind === 'shard') {
    return [0, 1].map((i) => ({
      closed: true,
      points: diamond(x - ux * size * 0.85 * i, y - uy * size * 0.85 * i, size * 0.48),
    }));
  }
  if (kind === 'bolt') {
    const pts = [];
    for (let i = 0; i < 4; i++) {
      const s = i % 2 === 0 ? 1 : -1;
      pts.push([
        x - ux * size * i * 0.45 + px * s * size * 0.4,
        y - uy * size * i * 0.45 + py * s * size * 0.4,
      ]);
    }
    return [{ closed: false, points: pts }];
  }
  return [{
    closed: false,
    points: [
      [x - ux * size + px * size * 0.45, y - uy * size + py * size * 0.45],
      [x, y],
      [x - ux * size - px * size * 0.45, y - uy * size - py * size * 0.45],
    ],
  }];
}

/** 命中。炮是扁椭圆，冰是菱形爆开，电是折线星，箭是叉。 */
export function impactGlyphs(kind, x, y, size = 10) {
  if (kind === 'shell') return [{ ellipse: [x, y, size * 1.35, size * 0.62] }];
  if (kind === 'shard') {
    return [0, 1, 2, 3].map((i) => {
      const a = (i / 4) * Math.PI * 2;
      return { closed: true, points: diamond(x + Math.cos(a) * size, y + Math.sin(a) * size * 0.6, size * 0.32) };
    });
  }
  if (kind === 'bolt') {
    return [0, 1, 2].map((i) => {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
      return {
        closed: false,
        points: [[x, y], [x + Math.cos(a) * size, y + Math.sin(a) * size * 0.7]],
      };
    });
  }
  return [
    { closed: false, points: [[x - size, y - size * 0.6], [x + size, y + size * 0.6]] },
    { closed: false, points: [[x - size, y + size * 0.6], [x + size, y - size * 0.6]] },
  ];
}
