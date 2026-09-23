// 小游戏两屏的**观感样张**：把同一份 `lobby.js` / `battle.js`（+ `render.js`）在浏览器里画一遍并截图。
//
// 为什么需要它：这两屏平时只能在微信开发者工具里看，而我要的是「先看观感再决定其余几屏」。
// 它们都是纯 Canvas（零 DOM），所以同一份代码既能在小游戏里跑，也能在浏览器里渲染成 PNG。
// 输出：docs/testing/screenshots/minigame-lobby.png 与 minigame-battle.png（667×375 逻辑像素 @2x）
//
// 用法：npm run minigame:preview            （默认手机横屏）
//       npm run minigame:preview 1024 768   （换个尺寸看缩放）
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const [w = '667', h = '375'] = process.argv.slice(2);
const SHOTS_DIR = join(ROOT, 'docs/testing/screenshots');
const SHOTS = [
  { file: 'minigame-lobby.png', w: Number(w), h: Number(h), page: 'lobby' },
  { file: 'minigame-battle.png', w: Number(w), h: Number(h), page: 'battle' },
  { file: 'minigame-tower.png', w: Number(w), h: Number(h), page: 'tower' },
  { file: 'minigame-shop.png', w: Number(w), h: Number(h), page: 'shop' },
  { file: 'minigame-result.png', w: Number(w), h: Number(h), page: 'result' },
  { file: 'minigame-pause.png', w: Number(w), h: Number(h), page: 'pause' },
];

if (!existsSync(CHROME)) {
  console.log(`跳过：没找到 Chrome（${CHROME}）。这一步只是出样张，不影响别的检查。`);
  process.exit(0);
}

/**
 * 预览页：一份最小 HTML。**两屏共用一套**：`?page=lobby` 画大厅，`?page=battle` 画战场
 * （战场那份要真的开一局：建 6 座塔、跑 70 秒，让场上真有怪——不然截图里是空战场，看不出东西）。
 */
const pageFor = (page, w, h) => `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#05080e}canvas{display:block;width:${w}px;height:${h}px}</style></head>
<body><canvas id="c"></canvas><script type="module">
/**
 * 样张按 **1×** 出（与设计画布 667×375 同尺寸）。
 *
 * 走过两条 2× 的弯路，都记在验证记录 §216：
 *   ① 页面写死 dpr = 2、而 renderer 读真实的 dpr(1) → 「后备尺寸 1×、变换 2×」，
 *      y 大一点的 HUD 全画到画布外（战场样张底部那排按钮就是这么丢的）；
 *   ② 把 devicePixelRatio 顶成 2 或加 --force-device-scale-factor=2 → headless 截出来是空图。
 * 观感样张不需要 2×，1× 就够看版式与配色；要更高清就在微信开发者工具里看真机预览。
 */
const w = ${w}, h = ${h};   // 逻辑尺寸（= 设计画布），页面与 renderer 都用它
const dpr = 1;
const canvas = document.getElementById('c');
canvas.width = w * dpr; canvas.height = h * dpr;
const ctx = canvas.getContext('2d');
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
const page = ${JSON.stringify(page)};

if (page === 'lobby') {
  const { layoutLobby, drawLobby } = await import('/src/minigame/lobby.js');
  // 一份「像玩家档」的模型：解锁两张 TD 图 + 一张防守图，人物 3 级、声望 240
  const model = {
    mode: 'td', map: 'map_02', difficulty: 'normal', length: 'short', hero: 'hero_ranger',
    profile: { commanderLevel: 3, reputation: 240 },
    unlocked: ['map_01', 'map_02', 'def_01'], unlockedCount: 3, canStart: true, hint: null,
    locked: { map_03: '声望 500', def_02: '守住边陲小镇' },
  };
  drawLobby(ctx, model, layoutLobby(w, h, model));
} else {
  const { createMatch, buildTower, update, startWaveEarly } = await import('/src/match.js');
  const { createRenderer } = await import('/src/render.js');
  const { layoutBattle, drawBattleHud, layoutSheet, drawSheet, layoutResult, drawResult } = await import('/src/minigame/battle.js');
  const { TICK_STEP } = await import('/src/data.js');
  const m = createMatch({ mapId: 'map_02', difficulty: 'normal', heroId: 'hero_ranger', seed: 7, players: 1 });
  const renderer = createRenderer(canvas, { size: () => ({ w, h }) });
  renderer.fit(m.map.grid);
  // 建 6 座塔（给得起的那种），再跑 70 秒让场上真的有怪
  for (const i of [0, 1, 2, 3, 4, 5]) buildTower(m, i, i % 3 === 2 ? 'tw_frost' : 'tw_arrow', 0);
  startWaveEarly(m, 0);
  for (let i = 0; i < Math.round(70 / TICK_STEP); i += 1) update(m, TICK_STEP);
  // 结算那张样张：**先把结果摆上再画 HUD**，这样底部那排也跟真机一致（「开波」会变成「再开一局」）
  if (page === 'result') {
    m.time = 486;
    m.stats.leaks = 2;
    m.stats.drops = 12;
    m.stats.crafts = 1;
    m.stats.kills = 88;
    m.stats.damage = { hero: 640, tw_arrow: 320, tw_cannon: 90 };
    m.result = 'win';
  }
  const model = {
    wave: m.wave.index, phase: m.wave.phase, timer: m.wave.timer, gold: Math.round(m.gold),
    core: m.core.hp, coreMax: m.core.maxHp, result: m.result, length: m.length,
    canEarly: false, skills: m.hero.skillUnlocked, selectedTower: 'tw_arrow',
  };
  renderer.draw({ m, selectedSlot: null, selectedTower: null, localSlot: 0, now: m.time, pulses: false });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBattleHud(ctx, m, layoutBattle(model), { selectedTower: 'tw_arrow', message: '点塔位建塔 · 点「开波」提前开打' });
  // 第三张样张：把塔面板摊开（点已建的塔就是这个界面）
  if (page === 'tower') {
    m.gold = 420;   // 让「升级」是亮着的，样张里能看出可点状态
    drawSheet(ctx, layoutSheet(m, { panelSlot: 1, sellArmed: false }));
  }
  // 第四张：商店（药品 3 格 + 技能书，撤柜的也写在行上）
  if (page === 'shop') {
    m.gold = 260;
    m.bag = { pot_small: 1 };   // 让「药品格」看起来有东西
    drawSheet(ctx, layoutSheet(m, { sheetKind: 'shop' }));
  }
  // 第五张：结算面板（内容与浏览器版同一个 resultPanelModel）
  if (page === 'result') drawResult(ctx, layoutResult(m, { gain: 120, leveledUp: true, commanderLevel: 4 }));
  // 第六张：暂停面板（倍速 / 镜头 / 震动三个开关都真的接着东西）
  if (page === 'pause') {
    drawBattleHud(ctx, m, layoutBattle({ ...model, paused: true, rate: 2 }), { selectedTower: 'tw_arrow' });
    drawSheet(ctx, layoutSheet(m, { sheetKind: 'pause', rate: 2, settings: { tdFitAll: true, sfx: true } }));
  }
}
window.__previewReady = true;
</script></body></html>`;

const dir = await mkdtemp(join(tmpdir(), 'ff-lobby-'));
// 预览页通过 http 起一个静态服务才能 import 到 /src（file:// 下 ES 模块会被 CORS 拦）
const { createServer } = await import('node:http');
const { readFile } = await import('node:fs/promises');
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  const page = new URL(req.url, 'http://x').searchParams.get('page') ?? 'lobby';
  try {
    const body = path === '/' ? Buffer.from(pageFor(page, Number(w), Number(h)))
      : await readFile(join(ROOT, path.replace(/^\//, '')));
    res.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

await mkdir(SHOTS_DIR, { recursive: true });
for (const shot of SHOTS) {
  const png = join(dir, `${shot.page}.png`);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    `--window-size=${shot.w},${shot.h}`, `--screenshot=${png}`, '--virtual-time-budget=2500',
    `http://127.0.0.1:${port}/?page=${shot.page}`,
  ], { stdio: 'ignore' });
  await new Promise((r) => chrome.on('exit', r));
  await copyFile(png, join(SHOTS_DIR, shot.file));
  console.log(`样张 → docs/testing/screenshots/${shot.file}（${shot.w}×${shot.h} 逻辑像素 @2x）`);
}
server.close();
