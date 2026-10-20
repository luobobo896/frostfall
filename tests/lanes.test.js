// map_02 急路：短的那条先到核心，长的那条继续分到怪。其余图保持原样。
import test from 'node:test';
import assert from 'node:assert/strict';

import { GRID, MAPS, TICK_STEP } from '../src/data.js';
import { buildMap, spawnPathIndex, URGENT_LANE_GAP } from '../src/core.js';
import { createMatch, update } from '../src/match.js';

globalThis.window = { devicePixelRatio: 1 };

const { createLaneMinimap, createRenderer, invasionArrows, pathProgressOf, URGENT_LANE } = await import('../src/render.js');

const travelSec = (cells) => (cells.length * GRID.unitPerTile) / 300;

function reversals(cells) {
  let n = 0;
  for (let i = 0; i < cells.length - 2; i++) {
    const a = cells[i];
    const b = cells[i + 1];
    const c = cells[i + 2];
    if (a.x === c.x && a.y === c.y && (a.x !== b.x || a.y !== b.y)) n += 1;
  }
  return n;
}

function stepKinds(cells) {
  let ortho = 0;
  let gap = 0;
  for (let i = 1; i < cells.length; i++) {
    const d = Math.abs(cells[i].x - cells[i - 1].x) + Math.abs(cells[i].y - cells[i - 1].y);
    if (d <= 1) ortho += 1;
    else gap += 1;
  }
  return { ortho, gap };
}

test('map_02 上路是急路，下路明显更长，两路都封到核心', () => {
  const built = buildMap(MAPS.map_02);
  const ground = built.paths.filter((p) => !p.air);
  assert.equal(ground.length, 2);
  assert.deepEqual(ground.map((p) => p.cells.length), [32, 57]);
  const [short, long] = ground;
  assert.equal(short.urgent, true);
  assert.equal(long.urgent, false);
  assert.ok(travelSec(long.cells) - travelSec(short.cells) >= 8, '行程差至少 8 秒，玩的时候分得出先后');
  assert.ok(reversals(short.cells) === 0, '急路是直下核心，不是在终点来回折');
  const shortUnique = new Set(short.cells.map((c) => `${c.x},${c.y}`)).size;
  const longUnique = new Set(long.cells.map((c) => `${c.x},${c.y}`)).size;
  assert.ok(shortUnique <= longUnique * 0.7, '急路占的格子要少一截，不能只靠折返垫长度');
  const bands = pathProgressOf(built);
  for (const p of ground) {
    const last = p.cells[p.cells.length - 1];
    assert.deepEqual(last, MAPS.map_02.core);
    assert.equal(bands.prog.get(`${p.spawn.x},${p.spawn.y}`), 0, '入口仍是色带最暗的一头');
    assert.equal(bands.prog.get(`${last.x},${last.y}`), 1, '核心仍是色带最亮的一头');
    for (const c of p.cells) assert.ok(built.blocked.has(`${c.x},${c.y}`), '路径格都封死，不能在路上建塔');
  }
  const shortSteps = stepKinds(short.cells);
  assert.equal(shortSteps.gap, 0, '急路每一步都贴着上一格，硬边不断');
  assert.equal(built.slots.length, 22);
  for (const s of built.slots) assert.equal(built.blocked.has(`${s.x},${s.y}`), false);
  for (const p of ground) {
    const near = built.slots.filter((s) => p.cells.some((c) => Math.abs(c.x - s.x) + Math.abs(c.y - s.y) <= 1)).length;
    assert.ok(near >= 8, `每条路旁边都要有塔位（现在 ${near}）`);
  }
  assert.ok(URGENT_LANE_GAP >= 8);
});

test('等长的图不加急路标记，防守图不走这套长度', () => {
  for (const id of ['map_01', 'map_03', 'map_04', 'map_05', 'map_06']) {
    const built = buildMap(MAPS[id]);
    assert.equal(built.paths.some((p) => p.urgent), false, `${id} 仍是等长，不标急路`);
    const ground = built.paths.filter((p) => !p.air);
    const lens = new Set(ground.map((p) => p.cells.length));
    assert.equal(lens.size, 1, `${id} 地面路长度还是一样的`);
  }
});

test('出怪两路轮流：长路不会整波空着，空中怪仍走航线', () => {
  const paths = buildMap(MAPS.map_02).paths;
  const counts = [0, 0];
  for (let i = 0; i < 11; i++) counts[spawnPathIndex(paths, { spawned: i })] += 1;
  assert.deepEqual(counts, [6, 5]);
  assert.ok(Math.abs(counts[0] - counts[1]) <= 1);

  const m = createMatch({ mapId: 'map_02', difficulty: 'normal', seed: 1 });
  m.wave.timer = 0;
  const seen = new Set();
  for (let i = 0; i < Math.round(12 / TICK_STEP); i++) {
    update(m, TICK_STEP);
    for (const mo of m.monsters) seen.add(mo.pathIndex);
  }
  assert.ok(seen.has(0) && seen.has(1), '开波十几秒里两条路都要见到怪');

  const swamp = buildMap(MAPS.map_03).paths;
  const air = swamp.findIndex((p) => p.air);
  assert.equal(spawnPathIndex(swamp, { isAir: true, spawned: 4 }), air);
  assert.equal(swamp[spawnPathIndex(swamp, { isAir: false, spawned: 4 })].air, undefined);
});

function miniContext() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push({ name, args }); };
  const state = { fillStyle: '', strokeStyle: '' };
  const ctx = {
    calls,
    setTransform: rec('setTransform'), fillRect: rec('fillRect'), fillText: rec('fillText'),
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    closePath: rec('closePath'), fill: rec('fill'), stroke: rec('stroke'),
    arc: rec('arc'), setLineDash: rec('setLineDash'), strokeRect: rec('strokeRect'),
  };
  for (const key of ['fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'lineCap', 'lineJoin', 'font', 'textAlign', 'textBaseline']) {
    Object.defineProperty(ctx, key, {
      set(v) { state[key] = v; calls.push({ name: 'style', key, value: v }); },
      get() { return state[key]; },
    });
  }
  return ctx;
}

test('小地图与下一波箭头能读出急路，点按仍是挪镜头', () => {
  const ctx = miniContext();
  const canvas = { clientWidth: 168, clientHeight: 122, width: 0, height: 0, getContext: () => ctx };
  const mini = createLaneMinimap(canvas, { size: () => ({ w: 168, h: 122 }) });
  const m = createMatch({ mapId: 'map_02', seed: 1 });
  mini.draw(m);
  assert.ok(ctx.calls.some((c) => c.name === 'fillText' && c.args[0] === '急'));
  assert.ok(ctx.calls.some((c) => c.key === 'strokeStyle' && c.value === URGENT_LANE));
  const arrows = invasionArrows(m);
  assert.equal(arrows.length, 2);
  assert.equal(arrows.filter((a) => a.urgent).length, 1);
  assert.equal(arrows.find((a) => a.urgent).pathIndex, 0);
  m.wave.phase = 'spawning';
  m.wave.spawned = 1;
  m.wave.total = 8;
  const next = invasionArrows(m);
  assert.equal(next.length, 1);
  assert.equal(next[0].urgent, false, '下一只走长路时箭头不标急');
  m.wave.spawned = 0;
  assert.equal(invasionArrows(m)[0].urgent, true);
  const at = mini.toMini(10, 8);
  assert.deepEqual(mini.cellAt(at.x, at.y, m), { x: 10, y: 8 });

  const plain = miniContext();
  const plainCanvas = { clientWidth: 168, clientHeight: 122, width: 0, height: 0, getContext: () => plain };
  createLaneMinimap(plainCanvas, { size: () => ({ w: 168, h: 122 }) }).draw(createMatch({ mapId: 'map_01', seed: 1 }));
  assert.equal(plain.calls.some((c) => c.name === 'fillText' && c.args[0] === '急'), false);
});

test('战场入口写「急路」，不是一颗新按钮', () => {
  const ctx = miniContext();
  ctx.ellipse = () => {};
  ctx.save = () => {};
  ctx.restore = () => {};
  const canvas = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => ctx };
  const r = createRenderer(canvas);
  r.draw({ m: createMatch({ mapId: 'map_02', seed: 1 }), selectedSlot: null, selectedTower: null });
  assert.ok(ctx.calls.some((c) => c.name === 'fillText' && c.args[0] === '急路'));

  const other = miniContext();
  other.ellipse = () => {};
  other.save = () => {};
  other.restore = () => {};
  const canvas2 = { clientWidth: 1334, clientHeight: 750, width: 0, height: 0, getContext: () => other };
  createRenderer(canvas2).draw({ m: createMatch({ mapId: 'map_01', seed: 1 }), selectedSlot: null, selectedTower: null });
  assert.equal(other.calls.some((c) => c.name === 'fillText' && c.args[0] === '急路'), false);
});
