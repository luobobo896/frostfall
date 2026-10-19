// 渲染层无头校验：用假 canvas 上下文跑完整帧，确认等距投影、点击反投影与绘制路径不出错。
// 真正的外观验收仍需真机/浏览器（见 docs/testing/ 的待办）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMatch, buildTower, towerStatsAt, update } from '../src/match.js';
import { heroPos, posAt, project } from '../src/core.js';
import { GRID, HEROES, MONSTERS, TICK_STEP } from '../src/data.js';

globalThis.window = { devicePixelRatio: 1 };

function fakeContext() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push({ name, args }); };
  const ctx = {
    calls,
    setTransform: rec('setTransform'), fillRect: rec('fillRect'), fillText: rec('fillText'),
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    closePath: rec('closePath'), fill: rec('fill'), stroke: rec('stroke'),
    ellipse: rec('ellipse'), save: rec('save'), restore: rec('restore'),
  };
  return ctx;
}

const {
  createRenderer, hintPulseAlpha, terrainPaint, towerSilhouette, mobSilhouette, heroSilhouette,
} = await import('../src/render.js');

test('等距投影：格坐标 → 屏幕往返可逆（点击判定依赖它）', () => {
  const ctx = fakeContext();
  const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
  const r = createRenderer(canvas);
  for (const [gx, gy] of [[0, 0], [16, 12], [31, 23], [10, 6]]) {
    const s = r.toScreen(gx, gy);
    const back = r.toGrid(s.x, s.y);
    assert.deepEqual(back, { x: gx, y: gy }, `(${gx},${gy}) 往返应一致`);
  }
  // 2:1 等距：相邻两格的屏幕位移比例（§14.1）
  const a = project(10, 6), b = project(11, 6), c = project(10, 7);
  assert.equal(b.x - a.x, GRID.tileW / 2);
  assert.equal(c.x - a.x, -GRID.tileW / 2);
  assert.equal(b.y - a.y, GRID.tileH / 2);
});

test('整图可见缩放：横屏 1334×750 下垂直利用率 ≥ 85%（§14.1.1）', () => {
  const ctx = fakeContext();
  const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
  const r = createRenderer(canvas);
  const mapH = (GRID.w + GRID.h) * (GRID.tileH / 2) * r.scale;
  assert.ok(mapH / 750 >= 0.85, `垂直利用率 ${(mapH / 750 * 100).toFixed(0)}% 应 ≥ 85%`);
  const mapW = (GRID.w + GRID.h) * (GRID.tileW / 2) * r.scale;
  assert.ok(mapW <= 1334 + 1, '整图宽度不应溢出屏幕');

  // 居中：地图四角的最小/最大屏幕坐标应关于视口中心对称
  const corners = [
    r.toScreen(0, 0), r.toScreen(GRID.w - 1, 0),
    r.toScreen(0, GRID.h - 1), r.toScreen(GRID.w - 1, GRID.h - 1),
  ];
  const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  assert.ok(Math.abs(cx - 1334 / 2) < 8, `地图水平居中，偏差 ${(cx - 1334 / 2).toFixed(1)}px`);
  assert.ok(Math.abs(cy - 750 / 2) < 8, `地图垂直居中，偏差 ${(cy - 750 / 2).toFixed(1)}px`);
});

// §10.3「客户端渲染插值」：内核早就有亚格位置（`dist`，快照里按 1/8 格下发），
// 但渲染此前把它塌回整数格——一格 64px，怪每 0.4 秒才动一格，单机与联机都看得见「跳格」。
test('§10.3 亚格渲染：怪物按 dist 的小数位置画，不再一格一格跳', () => {
  const perTile = GRID.unitPerTile;
  const path = { cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] };
  // 纯函数：整数倍处正好落在格心，半格处正好在中间，末尾夹住不越界
  assert.deepEqual(posAt(path, 0), { x: 0, y: 0 });
  assert.deepEqual(posAt(path, perTile), { x: 1, y: 0 });
  assert.deepEqual(posAt(path, perTile * 1.5), { x: 1.5, y: 0 }, '半格位置 = 两格中点');
  assert.deepEqual(posAt(path, perTile * 99), { x: 2, y: 0 }, '超出路径末端夹在最后一格');
  assert.deepEqual(posAt(path, -50), { x: 0, y: 0 }, '负数夹在第一格');
  // 人物：没有路径就坐在格心上；有路径时按 carry（走向下一格的进度）插值
  assert.deepEqual(heroPos({ cell: { x: 3, y: 4 } }), { x: 3, y: 4 });
  assert.deepEqual(heroPos({ cell: { x: 3, y: 4 }, path: [{ x: 4, y: 4 }], carry: 0.25 }),
    { x: 3.25, y: 4 });

  // 画出来：同一只怪，dist 半格时的落点必须与整数格心不同（改回 mo.cell 就会红）
  const ctx = fakeContext();
  const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
  const r = createRenderer(canvas);
  const m = createMatch({ mapId: 'map_01', seed: 3 });
  m.towers = [];
  m.monsters = [{
    uid: 1, mobId: 'mob_01', def: MONSTERS.mob_01, pathIndex: 0, dist: perTile * 1.5,
    cell: { ...m.map.paths[0].cells[1] }, hp: 90, maxHp: 90, armor: 1, armorType: 'medium',
    isAir: false, attacking: false, effects: [], dead: false,
  }];
  r.draw({ m, selectedSlot: null, selectedTower: null, floaters: [], now: 0 });
  const at = posAt(m.map.paths[0], perTile * 1.5);
  const want = r.toScreen(at.x, at.y);
  const atCell = r.toScreen(m.monsters[0].cell.x, m.monsters[0].cell.y);
  const dots = ctx.calls.filter((c) => c.name === 'ellipse');
  const hit = dots.find((c) => Math.abs(c.args[0] - want.x) < 0.5 && Math.abs(c.args[1] - want.y) < 0.5);
  assert.ok(hit, `怪该画在亚格位置 (${want.x.toFixed(1)},${want.y.toFixed(1)})`);
  assert.ok(!dots.some((c) => Math.abs(c.args[0] - atCell.x) < 0.5 && Math.abs(c.args[1] - atCell.y) < 0.5),
    '不该再画在整数格心上（那就是改回跳格了）');
});

test('一整帧绘制：地块 / 塔位 / 核心 / 塔 / 怪 / 英雄 / 弹道都画到，且不抛异常', () => {
  const ctx = fakeContext();
  const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
  const r = createRenderer(canvas);

  const m = createMatch({ mapId: 'map_01', seed: 3 });
  buildTower(m, 0, 'tw_arrow');
  buildTower(m, 1, 'tw_cannon');
  for (let i = 0; i < Math.round(40 / TICK_STEP); i++) update(m, TICK_STEP); // 推进到出怪
  assert.ok(m.monsters.length > 0, '40 秒后应有怪物在场上');

  r.draw({ m, selectedSlot: 1, selectedTower: 0 });
  const names = ctx.calls.map((c) => c.name);
  assert.ok(names.filter((n) => n === 'fill').length > 100, '应有大量地块绘制');
  assert.ok(names.includes('ellipse'), '怪物/阴影应使用椭圆');
  assert.ok(ctx.calls.some((c) => c.name === 'fillText'), '占位图应带文字标签（§14.6）');
  assert.ok(names.includes('restore'), '核心的发光特效应成对 save/restore');
});

test('空场也能画：没有塔、没有怪时不崩（开局第一帧）', () => {
  const ctx = fakeContext();
  const canvas = { clientWidth: 800, clientHeight: 450, width: 0, height: 0, getContext: () => ctx };
  const r = createRenderer(canvas);
  const m = createMatch({ mapId: 'map_03', seed: 1 });
  r.draw({ m, selectedSlot: null, selectedTower: null });
  assert.ok(ctx.calls.length > 0);
});

test('相机：整图可见 / 拖动平移 / 滚轮缩放（§2.5 的 0.74× 与「放大看局部」）', () => {
  const ctx = fakeContext();
  const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
  const r = createRenderer(canvas);

  const fitScale = r.scale;
  // 关掉「整图可见」：按镜头档位放大，并把地图中心放到屏幕中心
  r.setCamera(GRID.w / 2, GRID.h / 2, 1.5);
  assert.ok(r.scale > fitScale * 1.5, `放大后应明显大于整图缩放（${r.scale.toFixed(2)} vs ${fitScale.toFixed(2)}）`);
  const center = r.toScreen(GRID.w / 2, GRID.h / 2);
  assert.ok(Math.abs(center.x - 667) < 2 && Math.abs(center.y - 375) < 2, '镜头档位应把地图中心放在屏幕中心');

  // 拖动平移：格坐标跟着屏幕一起走，位移一致
  const before = r.toScreen(GRID.w / 2, GRID.h / 2);
  r.panBy(-120, 60);
  const after = r.toScreen(GRID.w / 2, GRID.h / 2);
  assert.equal(Math.round(after.x - before.x), -120, '平移像素应与传入的位移一致');
  assert.equal(Math.round(after.y - before.y), 60, '平移像素应与传入的位移一致');

  // 滚轮缩放：以光标下的格子为锚点，那个格子缩放前后不该跑
  const anchor = { x: 400, y: 300 };
  const grid = r.toGrid(anchor.x, anchor.y);
  r.zoomAt(r.scale * 1.15, anchor.x, anchor.y);
  const anchorAfter = r.toScreen(grid.x, grid.y);
  assert.ok(Math.abs(anchorAfter.x - anchor.x) < 1e-6 && Math.abs(anchorAfter.y - anchor.y) < 1e-6, '缩放时光标下的格子不该跑');

  // 幂等：draw 每帧都会调 resize，不能把玩家的视角弹回去
  const kept = r.scale;
  r.resize();
  assert.equal(r.scale, kept, '画布与地图尺寸没变时 resize 不该重算相机');
  r.fit();
  assert.ok(Math.abs(r.scale - fitScale) < 1e-9, 'fit() 回到整图可见');
});

test('防守模式渲染：跟随相机 + 视口裁剪，只画镜头附近的格子', async () => {
  const { createDefenseMatch, updateDefense, buildFort } = await import('../src/defense.js');
  const ctx = fakeContext();
  const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
  const r = createRenderer(canvas);
  const m = createDefenseMatch({ seed: 4 });
  m.gold = 500;
  buildFort(m, 0, 'fort_arrow');
  for (let i = 0; i < Math.round(40 / TICK_STEP); i++) updateDefense(m, TICK_STEP);

  r.draw({ m, floaters: [], now: 0, scale: 1.5 });

  // 相机以英雄为中心：英雄的屏幕坐标应接近画布中心
  const h = r.toScreen(m.hero.cell.x, m.hero.cell.y);
  assert.ok(Math.abs(h.x - 667) < 80 && Math.abs(h.y - 375) < 80, '跟随相机应把英雄放在画面中心附近');

  // 视口裁剪：可见格数应远小于整图 64×48
  const bounds = r.visibleGrid(m.grid.w, m.grid.h);
  const visible = (bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1);
  assert.ok(visible < 64 * 48 * 0.5, `视口内格数 ${visible} 应明显少于整图（视口裁剪生效）`);
  assert.ok(ctx.calls.length > 0);
  assert.ok(ctx.calls.some((c) => c.name === 'setLineDash' || c.name === 'fillText'), '应画了文字或路径提示');
});

test('小地图：俯视图把城堡/工事/英雄画在各自的格子上，预警闪边（§2.6）', async () => {
  const { createMinimap } = await import('../src/render.js');
  const { createDefenseMatch, buildFort } = await import('../src/defense.js');

  const calls = [];
  const ctx = {
    setTransform: () => {}, fillRect: (...a) => calls.push(['fillRect', ...a]),
    beginPath: () => {}, arc: (...a) => calls.push(['arc', ...a]), fill: () => {}, stroke: () => {},
    strokeRect: (...a) => calls.push(['strokeRect', ...a]),
  };
  const canvas = { clientWidth: 224, clientHeight: 168, width: 0, height: 0, getContext: () => ctx };
  const mini = createMinimap(canvas);
  const m = createDefenseMatch({ seed: 5 });
  m.gold = 500;
  assert.ok(buildFort(m, 0, 'fort_arrow'), '先建一座工事（小地图要画出它）');

  const at = (x, y) => calls.filter((c) => c[0] === 'arc').some(([, ax, ay]) => Math.abs(ax - x) < 0.01 && Math.abs(ay - y) < 0.01);
  mini.draw(m);
  const castle = mini.toMinimap(m.castle.cell.x, m.castle.cell.y);
  const hero = mini.toMinimap(m.hero.cell.x, m.hero.cell.y);
  const fort = mini.toMinimap(m.def.fortSlots[0].x, m.def.fortSlots[0].y);
  assert.ok(at(castle.x, castle.y), '城堡应画在自己的格子上');
  assert.ok(at(hero.x, hero.y), '英雄应画在自己的格子上');
  assert.ok(at(fort.x, fort.y), '工事应画在自己的格子上');

  // 英雄换格子 → 圆点跟着走（不是写死的装饰）
  calls.length = 0;
  m.hero.cell = { x: 8, y: 12 };
  mini.draw(m);
  const moved = mini.toMinimap(8, 12);
  assert.ok(at(moved.x, moved.y), '英雄换格子后圆点要跟过去');

  // 坐标必须落在地图画布内；预警时要有一圈橙边
  const s = mini.size;
  assert.ok(s.scale > 0 && castle.x <= s.w && castle.y <= s.h, '小地图像素应落在地图画布内');
  calls.length = 0;
  m.assault.warning = true;
  mini.draw(m);
  assert.ok(calls.some((c) => c[0] === 'strokeRect'), '回防预警时小地图要闪边（§2.6）');
});

test('地图卡面缩略图：TD 画路/出生点/核心，防守画营地/传送点/城堡（§2.7）', async () => {
  const { drawMapThumb } = await import('../src/render.js');
  const mk = () => {
    const calls = [];
    const ctx = {
      setTransform: () => {}, fillRect: (...a) => calls.push(['fillRect', ...a]),
      beginPath: () => {}, arc: (...a) => calls.push(['arc', ...a]), fill: () => {},
    };
    return { calls, canvas: { clientWidth: 150, clientHeight: 80, width: 0, height: 0, getContext: () => ctx } };
  };

  const td = mk();
  drawMapThumb(td.canvas, 'td', 'map_01');
  assert.ok(td.calls.filter((c) => c[0] === 'fillRect').length > 20, '应画出路径与塔位');
  assert.ok(td.calls.filter((c) => c[0] === 'arc').length >= 2, '应画出出生点与核心');

  const def = mk();
  drawMapThumb(def.canvas, 'defense', 'def_01');
  const dots = def.calls.filter((c) => c[0] === 'arc');
  assert.ok(dots.length >= 7, `防守图要有 4 营地 + 2 传送点 + 城堡（实际 ${dots.length}）`);
  assert.ok(def.calls.some((c) => c[0] === 'fillRect'), '基地围墙与野区要画出来');

  // 所有点都必须落在卡面尺寸内（缩略图最容易悄悄画歪）
  for (const [, x, y] of dots) {
    assert.ok(x >= 0 && y >= 0 && x <= 150 && y <= 80, `圆点越界：( ${x}, ${y} )`);
  }
});

test('§3.7 低血提示：小地图上的英雄点会变红并加一圈环', async () => {
  const { createMinimap } = await import('../src/render.js');
  const { createDefenseMatch } = await import('../src/defense.js');
  const { heroMaxHp } = await import('../src/match.js');

  const calls = [];
  const ctx = {
    setTransform: () => {}, fillRect: () => {}, beginPath: () => {},
    arc: (...a) => calls.push(['arc', ...a]), fill: () => {}, stroke: () => {}, strokeRect: () => {},
  };
  const canvas = { clientWidth: 224, clientHeight: 168, width: 0, height: 0, getContext: () => ctx };
  const mini = createMinimap(canvas);
  const m = createDefenseMatch({ seed: 5 });

  const arcsWith = (fn) => { calls.length = 0; fn(); return calls.filter((c) => c[0] === 'arc').length; };
  m.hero.hp = heroMaxHp(m.hero);
  const healthy = arcsWith(() => mini.draw(m));
  m.hero.hp = heroMaxHp(m.hero) * 0.1;          // 10% → 低血
  const low = arcsWith(() => mini.draw(m));
  assert.ok(low > healthy, `低血时应该多画一圈环：健康 ${healthy} 个圆 → 低血 ${low} 个圆`);

  m.hero.hp = heroMaxHp(m.hero) * 0.25;         // 25% → 不算低血
  const ok = arcsWith(() => mini.draw(m));
  assert.equal(ok, healthy, '回到安全线以上就不该再高亮');
});

// §116：设置面板写着「低特效档会关掉伤害飘字与塔位脉冲」。飘字那半早就生效；
// 脉冲这半以前没人读 `renderOptions().showPulses`，低特效下引导塔位照样闪。
test('§116 低特效档关掉塔位脉冲（同一帧里两个时刻的透明度必须一致）', () => {
  const on = [hintPulseAlpha(0, true), hintPulseAlpha(0.4, true)];
  assert.notEqual(on[0], on[1], '高特效：透明度随时间变（这才是「脉冲」）');
  const off = [hintPulseAlpha(0, false), hintPulseAlpha(0.4, false)];
  assert.equal(off[0], off[1], '低特效：透明度必须是常数，否则还是在闪');
  assert.ok(off[0] > 0 && off[0] < 1, `低特效下仍要看得见（透明度过 0 或 1 都会露馅：${off[0]}）`);
});

// §143：拖动 / 缩放**不许把地图整个推出屏幕**（手机上误拖两下，玩家就只看到一片空画布）。
// 用假 canvas 直接调渲染器的相机：地图四角投影出来的包围盒，必须始终与视口相交。
test('§143 拖多远地图都还看得见（相机有夹取）', () => {
  const ctx = fakeContext();
  const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
  const r = createRenderer(canvas);
  const seen = (grid) => {
    const xs = [], ys = [];
    for (const [gx, gy] of [[0, 0], [grid.w - 1, 0], [0, grid.h - 1], [grid.w - 1, grid.h - 1]]) {
      const p = r.toScreen(gx, gy);
      xs.push(p.x); ys.push(p.y);
    }
    const overlapX = Math.min(1334, Math.max(...xs)) - Math.max(0, Math.min(...xs));
    const overlapY = Math.min(750, Math.max(...ys)) - Math.max(0, Math.min(...ys));
    return { overlapX: Math.round(overlapX), overlapY: Math.round(overlapY) };
  };
  // 两种画布（32×24 的 TD 图与 44×28/52×34 的大图都算一遍）
  for (const grid of [{ w: 32, h: 24 }, { w: 52, h: 34 }]) {
    r.fit(grid);
    for (const [dx, dy] of [[1e6, 0], [-1e6, 0], [0, 1e6], [0, -1e6], [1e6, 1e6], [-1e6, -1e6]]) {
      r.panBy(dx, dy);
      const o = seen(grid);
      assert.ok(o.overlapX >= 60 && o.overlapY >= 60,
        `${grid.w}×${grid.h} 拖 (${dx}, ${dy}) 之后地图只剩 ${o.overlapX}×${o.overlapY} px 在屏幕里`);
    }
    // 缩放也要夹（缩到最小再到最大，来回都不许把图甩出去）
    r.fit(grid);
    r.zoomAt(0.2, 0, 0);
    assert.ok(seen(grid).overlapX >= 60 && seen(grid).overlapY >= 60, '缩到 0.2× 之后地图还在屏幕里');
    r.zoomAt(3, 1334, 750);
    assert.ok(seen(grid).overlapX >= 60 && seen(grid).overlapY >= 60, '放大到 3× 之后地图还在屏幕里');
  }
});

// P0：战场还是 Canvas 几何，但剪影必须能在灰度下分开。下面这些断言看的是
// 形状数据本身（不读像素），再抽一帧确认绘制路径真的把它们画出去了。
const lum = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const silhouetteBounds = (spec) => {
  const xs = [];
  const ys = [];
  for (const part of spec.parts) {
    if (part.ellipse) {
      const [x, y, rx, ry] = part.ellipse;
      xs.push(x - Math.abs(rx), x + Math.abs(rx));
      ys.push(y - Math.abs(ry), y + Math.abs(ry));
    }
    for (const [x, y] of part.points ?? []) { xs.push(x); ys.push(y); }
  }
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

test('P0 塔剪影：箭柱 / 炮管 / 冰晶 / 电弧各不相同，升级会加构件', () => {
  const ids = ['tw_arrow', 'tw_cannon', 'tw_frost', 'tw_static'];
  const sigs = ids.map((id) => JSON.stringify(towerSilhouette(id, 1).parts));
  assert.equal(new Set(sigs).size, 4, '四种塔的 Lv1 轮廓必须互不相同');

  const arrow = towerSilhouette('tw_arrow', 1);
  assert.ok(arrow.parts.some((p) => p.role === 'pillar') && arrow.parts.some((p) => p.role === 'roof'), '箭塔 = 柱 + 三角顶');
  assert.ok(towerSilhouette('tw_cannon', 1).parts.some((p) => p.role === 'barrel'), '炮塔要有炮管');
  assert.ok(towerSilhouette('tw_frost', 1).parts.filter((p) => p.role === 'crystal').length >= 3, '冰塔是一簇水晶，不是单颗菱形');
  const electric = towerSilhouette('tw_static', 1);
  assert.ok(electric.parts.some((p) => p.role === 'rod') && electric.parts.filter((p) => p.role === 'arc').length >= 2, '电塔 = 杆 + 两侧电弧');

  const arrowBox = silhouetteBounds(arrow);
  const cannonBox = silhouetteBounds(towerSilhouette('tw_cannon', 1));
  assert.ok(arrowBox.h / arrowBox.w > cannonBox.h / cannonBox.w, '箭塔应比炮塔更瘦高');

  const legacy = JSON.stringify([[0, -1], [0.8, 0], [0, 0.6], [-0.8, 0]]);
  for (const id of ids) {
    for (const lv of [1, 2, 3]) {
      const spec = towerSilhouette(id, lv);
      assert.ok(spec.parts.length >= 2, `${id} Lv${lv} 至少两块构件，不能退回单颗菱形`);
      for (const part of spec.parts) {
        if (part.points) assert.notEqual(JSON.stringify(part.points), legacy, `${id} Lv${lv} 仍是旧菱形`);
      }
    }
    assert.ok(towerSilhouette(id, 3).parts.length > towerSilhouette(id, 1).parts.length, `${id} Lv3 要比 Lv1 多一块`);
  }
  const barrelReach = (lv) => Math.max(...towerSilhouette('tw_cannon', lv).parts.find((p) => p.role === 'barrel').points.map((p) => p[0]));
  assert.ok(barrelReach(2) > barrelReach(1) && barrelReach(3) > barrelReach(2), '炮管随等级变长');
});

test('P0 怪剪影：空中有翼、重甲方块、分裂双圆、光环外圈、Boss 尖刺星', () => {
  const air = mobSilhouette(MONSTERS.mob_03);
  assert.equal(air.shape, 'air');
  const wings = air.parts.filter((p) => p.role === 'wing');
  assert.equal(wings.length, 2, '空中单位左右各一只翼');
  const wingMin = Math.min(...wings.flatMap((p) => p.points.map((pt) => pt[0])));
  const bodyMin = Math.min(...air.parts.find((p) => p.role === 'body').points.map((pt) => pt[0]));
  assert.ok(wingMin < bodyMin - 0.5, '翅膀要比身体宽，不能只靠抬高来认空中');

  const fort = mobSilhouette(MONSTERS.mob_10);
  assert.equal(fort.shape, 'fortified');
  assert.ok(fort.parts.every((p) => !p.ellipse), '重甲是方块，不是和塔一样的椭圆/菱形');

  const split = mobSilhouette(MONSTERS.mob_11);
  assert.equal(split.shape, 'split');
  assert.equal(split.parts.filter((p) => p.ellipse).length, 2, '死亡分裂是并排的两个圆');

  const aura = mobSilhouette(MONSTERS.mob_12);
  assert.equal(aura.shape, 'ground');
  assert.equal(aura.aura, true);
  assert.ok(aura.parts.some((p) => p.role === 'aura' && p.strokeOnly), '光环是身体外面的一圈');

  const boss = mobSilhouette(MONSTERS.boss_01);
  assert.equal(boss.shape, 'boss');
  assert.ok(boss.parts.find((p) => p.role === 'body').points.length >= 12, 'Boss 是尖刺星，顶点要够多');
  const auraBoss = mobSilhouette(MONSTERS.boss_02);
  assert.equal(auraBoss.shape, 'boss');
  assert.equal(auraBoss.aura, true, '带光环的 Boss 仍是星，光环叠在外面');

  const ground = mobSilhouette(MONSTERS.mob_01);
  assert.equal(ground.shape, 'ground');
  assert.ok(ground.parts.some((p) => p.role === 'body' && p.ellipse && p.ellipse[0] === 0 && p.ellipse[1] === 0));
  assert.ok(ground.parts.some((p) => p.role === 'horn'), '地面普通怪要有角/耳，不能只剩一颗椭圆');
  assert.equal(mobSilhouette(MONSTERS.mob_04).shape, 'ground', '重甲类型才换成方块；普通厚甲仍是地面怪');

  const airBody = JSON.stringify(air.parts.find((p) => p.role === 'body').points);
  for (const id of ['tw_arrow', 'tw_cannon', 'tw_frost', 'tw_static']) {
    for (const lv of [1, 2, 3]) {
      for (const part of towerSilhouette(id, lv).parts) {
        if (part.points) assert.notEqual(JSON.stringify(part.points), airBody, `${id} 不应和空中怪共用同一块菱形`);
      }
    }
  }
});

test('P0 英雄剪影：头 + 身体 + 按职业分开的短武器', () => {
  const ids = ['hero_warrior', 'hero_mage', 'hero_ranger', 'hero_paladin'];
  assert.deepEqual(ids.map((id) => heroSilhouette(id).weapon), ['blade', 'staff', 'bow', 'hammer']);
  const weaponSigs = ids.map((id) => JSON.stringify(heroSilhouette(id).parts.filter((p) => p.role === 'weapon')));
  assert.equal(new Set(weaponSigs).size, 4);
  for (const id of ids) {
    const spec = heroSilhouette(HEROES[id].id);
    assert.ok(spec.parts.some((p) => p.role === 'head' && p.ellipse), `${id} 要有头`);
    assert.ok(spec.parts.some((p) => p.role === 'body' && p.points?.length === 4), `${id} 要有梯形身体`);
    assert.ok(spec.parts.some((p) => p.role === 'weapon'), `${id} 要有武器`);
  }
  const blade = heroSilhouette('hero_warrior').parts.find((p) => p.role === 'weapon').points;
  assert.ok(Math.abs(blade[1][0] - blade[0][0]) > 0.4 && Math.abs(blade[1][1] - blade[0][1]) > 0.4, '武者是斜着的刀');
  const staff = heroSilhouette('hero_mage').parts.find((p) => p.role === 'weapon' && p.points).points;
  assert.ok(Math.abs(staff[1][0] - staff[0][0]) < 0.05 && staff[0][1] - staff[1][1] > 1, '法师是竖着的杖');
  assert.equal(heroSilhouette('nope').weapon, 'blade', '未知职业退回刀，仍然是人形');
});

test('P0 地形：路径比可建地亮，并且描边更深；岩浆保留原色加亮边', () => {
  const path = terrainPaint('path');
  const tileA = terrainPaint('tileA');
  const tileB = terrainPaint('tileB');
  assert.equal(path.fill, '#6a7a90');
  assert.equal(tileA.fill, '#10192a');
  assert.equal(tileB.fill, '#0c1522');
  assert.ok(lum(path.fill) > lum(tileA.fill) + 50, '路径要比可建地亮一档');
  assert.ok(lum(tileB.fill) < lum(tileA.fill), '棋盘两色里 B 更暗');
  assert.ok(lum(path.stroke) + 40 < lum(path.fill), '路径描边要比填充深');
  assert.ok(path.lineWidth >= 2.5, '路径要有硬边，不能和装饰块一样细');
  assert.ok(tileA.lineWidth < path.lineWidth, '可建地不要用路径那圈硬边');
  assert.notEqual(tileA.stroke, path.stroke);
  assert.equal(terrainPaint('swamp').fill, '#1d3a2c');
  const lava = terrainPaint('lava');
  assert.equal(lava.fill, '#5a2b1f');
  assert.ok(lum(lava.stroke) > lum(lava.fill), '岩浆边比岩浆底亮');

  const rects = (mapId) => {
    const ctx = fakeContext();
    const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
    const r = createRenderer(canvas);
    const m = createMatch({ mapId, seed: 1 });
    r.draw({ m, selectedSlot: null, selectedTower: null, now: 0 });
    return ctx.calls.filter((c) => c.name === 'fillRect').length;
  };
  assert.ok(rects('map_03') > rects('map_01') + 10, '沼泽格要多画出噪点');
  const lavaCtx = fakeContext();
  const lavaCanvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => lavaCtx };
  createRenderer(lavaCanvas).draw({ m: createMatch({ mapId: 'map_04', seed: 1 }), selectedSlot: null, selectedTower: null, now: 0 });
  assert.ok(lavaCtx.calls.length > 100, '熔岩地图要能画完一整帧');
});

test('P0 绘制路径：四塔、五种怪、四职业走的折线互不相同，队伍色环还在', () => {
  const frame = (setup) => {
    const ctx = fakeContext();
    const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
    const r = createRenderer(canvas);
    const m = setup(r);
    r.draw({ m, selectedSlot: null, selectedTower: null, now: 0 });
    const sig = ctx.calls
      .filter((c) => c.name === 'moveTo' || c.name === 'lineTo' || c.name === 'ellipse')
      .map((c) => `${c.name}:${c.args.map((n) => (typeof n === 'number' ? n.toFixed(1) : n)).join(',')}`)
      .join(';');
    return { ctx, r, m, sig };
  };
  const towerSigs = ['tw_arrow', 'tw_cannon', 'tw_frost', 'tw_static'].map((id) => frame(() => {
    const m = createMatch({ mapId: 'map_01', seed: 1 });
    m.gold = 999;
    assert.ok(buildTower(m, 0, id), `${id} 应该建得起来`);
    m.towers = m.towers.filter((t) => t.slot === 0);
    m.monsters = [];
    return m;
  }).sig);
  assert.equal(new Set(towerSigs).size, 4, '四种塔画出来的路径必须不同');

  const placed = frame(() => {
    const m = createMatch({ mapId: 'map_01', seed: 1 });
    m.gold = 999;
    buildTower(m, 0, 'tw_arrow');
    m.towers = m.towers.filter((t) => t.slot === 0);
    m.monsters = [];
    return m;
  });
  const tower = placed.m.towers[0];
  const origin = placed.r.toScreen(tower.cell.x, tower.cell.y, 0.9);
  const size = (16 + tower.level * 3) * placed.r.scale + 7;
  const ring = placed.ctx.calls.find((c) => c.name === 'ellipse'
    && Math.abs(c.args[0] - origin.x) < 0.5
    && Math.abs(c.args[1] - (origin.y + size * 0.42)) < 0.5
    && Math.abs(c.args[2] - size * 0.92) < 0.5);
  assert.ok(ring, '队伍色环仍画在塔的底座上');

  const mobOf = (def) => frame(() => {
    const m = createMatch({ mapId: 'map_01', seed: 1 });
    m.towers = [];
    m.monsters = [{
      uid: 1, mobId: def.id, def, pathIndex: 0, dist: 0,
      cell: { ...m.map.paths[0].spawn }, hp: def.hp, maxHp: def.hp,
      armorType: def.armorType, isAir: !!def.isAir, attacking: false, dead: false,
    }];
    return m;
  }).sig;
  const mobSigs = [MONSTERS.mob_01, MONSTERS.mob_03, MONSTERS.mob_10, MONSTERS.mob_11, MONSTERS.boss_01].map(mobOf);
  assert.equal(new Set(mobSigs).size, 5, '五种特性的怪画出来的路径必须不同');

  const heroSigs = ['hero_warrior', 'hero_mage', 'hero_ranger', 'hero_paladin'].map((id) => frame(() => {
    const m = createMatch({ mapId: 'map_01', seed: 1, heroId: id });
    m.towers = [];
    m.monsters = [];
    return m;
  }).sig);
  assert.equal(new Set(heroSigs).size, 4, '四职业英雄画出来的路径必须不同');
});

test('P0 地标：出生点有旗杆，核心脚下有一圈光', () => {
  const ctx = fakeContext();
  const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
  const r = createRenderer(canvas);
  const m = createMatch({ mapId: 'map_01', seed: 1 });
  m.towers = [];
  m.monsters = [];
  r.draw({ m, selectedSlot: null, selectedTower: null, now: 0 });
  const sp = m.map.paths[0].spawn;
  const s = r.toScreen(sp.x, sp.y, 0);
  const pole = ctx.calls.filter((c) => c.name === 'lineTo' && Math.abs(c.args[0] - s.x) < 1.5 && c.args[1] < s.y - 8);
  assert.ok(pole.length >= 1, '出生格应有一根向上的旗杆');
  const g = r.toScreen(m.core.cell.x, m.core.cell.y, 0);
  const expectRx = (GRID.tileW / 2) * r.scale * 0.92;
  const halo = ctx.calls.filter((c) => c.name === 'ellipse'
    && Math.abs(c.args[0] - g.x) < 1 && Math.abs(c.args[1] - g.y) < 1
    && Math.abs(c.args[2] - expectRx) < 1);
  assert.ok(halo.length >= 1, '核心所在格应有一圈大约一格宽的光');
});

function inkContext() {
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
}

const rangeRing = (ctx, at, range, scale) => ctx.calls.find((c) => c.name === 'ellipse'
  && Math.abs(c.args[0] - at.x) < 1
  && Math.abs(c.args[1] - at.y) < 1
  && Math.abs(c.args[2] - range * (GRID.tileW / 2) * scale) < 1
  && Math.abs(c.args[3] - range * (GRID.tileH / 2) * scale) < 1);

test('选中、预测放置、轮盘悬停都画高对比射程圈', () => {
  const draw = (extra, setup) => {
    const ctx = inkContext();
    const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
    const r = createRenderer(canvas);
    const m = createMatch({ mapId: 'map_01', seed: 1 });
    m.gold = 9999;
    m.monsters = [];
    setup?.(m);
    r.draw({ m, selectedSlot: null, selectedTower: null, pending: [], now: 0, ...extra });
    return { ctx, r, m };
  };
  const bright = (ctx) => ctx.calls.filter((c) => c.name === 'stroke' && c.strokeStyle === '#fff4d2' && c.lineWidth === 2);
  const dark = (ctx) => ctx.calls.filter((c) => c.name === 'stroke' && c.strokeStyle === 'rgba(8, 12, 18, .92)' && c.lineWidth === 5);

  const idle = draw();
  assert.equal(bright(idle.ctx).length, 0, '没选中也没在放置时不画射程圈');

  const selected = draw({ selectedTower: 0 }, (m) => { assert.ok(buildTower(m, 0, 'tw_arrow')); });
  const tower = selected.m.towers[0];
  const at = selected.r.toScreen(tower.cell.x, tower.cell.y, 0);
  assert.ok(rangeRing(selected.ctx, at, tower.stats.range, selected.r.scale), '选中的塔要在地面上画出射程');
  assert.equal(bright(selected.ctx).length, 1);
  assert.equal(dark(selected.ctx).length, 1);

  const pending = draw({ pending: [{ slot: 1, towerId: 'tw_cannon' }] });
  const cell = pending.m.map.slots[1];
  const pendingRange = towerStatsAt(pending.m.map, cell, 'tw_cannon', 1).range;
  const pendingAt = pending.r.toScreen(cell.x, cell.y, 0);
  assert.ok(rangeRing(pending.ctx, pendingAt, pendingRange, pending.r.scale), '预测放置要画出这一级的射程');

  const placing = draw({ selectedSlot: 2, placingTowerId: 'tw_frost' });
  const slot = placing.m.map.slots[2];
  const placeRange = towerStatsAt(placing.m.map, slot, 'tw_frost', 1).range;
  assert.ok(rangeRing(placing.ctx, placing.r.toScreen(slot.x, slot.y, 0), placeRange, placing.r.scale), '轮盘悬停要预览该塔种的射程');
  assert.notEqual(placeRange, pendingRange, '不同塔种的预览圈不能一样大');
});

test('英雄比原来大一档，活着时有暖色轮廓，倒下后轮廓变灰', () => {
  const draw = (dead) => {
    const ctx = inkContext();
    const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
    const r = createRenderer(canvas);
    const m = createMatch({ mapId: 'map_01', seed: 1 });
    m.towers = [];
    m.monsters = [];
    m.hero.dead = dead;
    r.draw({ m, selectedSlot: null, selectedTower: null, now: 0 });
    return { ctx, r, m };
  };
  const alive = draw(false);
  const hp = alive.r.toScreen(alive.m.hero.cell.x, alive.m.hero.cell.y, 1);
  const radius = 16 * alive.r.scale + 8;
  const glow = alive.ctx.calls.find((c) => c.name === 'ellipse'
    && Math.abs(c.args[0] - hp.x) < 1
    && Math.abs(c.args[2] - radius * 1.05) < 1);
  assert.ok(glow, '英雄轮廓要按加大后的尺寸画');
  assert.ok(radius > 12 * alive.r.scale + 6, '要比原先的英雄尺寸大一档');
  assert.ok(alive.ctx.calls.some((c) => c.name === 'stroke' && c.strokeStyle === '#ffd68a' && c.lineWidth === 3));
  const dead = draw(true);
  assert.ok(dead.ctx.calls.some((c) => c.name === 'stroke' && c.strokeStyle === '#8b95a3'));
  assert.ok(!dead.ctx.calls.some((c) => c.name === 'stroke' && c.strokeStyle === '#ffd68a'));
});
