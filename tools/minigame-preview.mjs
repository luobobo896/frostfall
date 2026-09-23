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
import { mkdtemp, mkdir, copyFile, stat } from 'node:fs/promises';
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
  { file: 'minigame-defense.png', w: Number(w), h: Number(h), page: 'defense' },
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
// 页面里一抛错，headless 截出来的就是一张空图（这一路已经踩过两次）；把它写进标题，方便出事时查
window.onerror = (msg) => { document.title = 'ERR: ' + msg; };
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
    canContinue: true, continueLabel: '继续上局',   // 有存档时右边会多这一个出口
    locked: { map_03: '声望 500', def_02: '守住边陲小镇' },
  };
  drawLobby(ctx, model, layoutLobby(w, h, model));
} else {
  // 防守那一屏：单独一条分支（它用 createDefenseMatch + drawDefense + 摇杆那套 HUD）
  if (page === 'defense') {
    const { createDefenseMatch, buildFort, updateDefense } = await import('/src/defense.js');
    const { createRenderer } = await import('/src/render.js');
    const { layoutDefense, drawDefenseHud } = await import('/src/minigame/defense-screen.js');
    const { TICK_STEP } = await import('/src/data.js');
    const m = createDefenseMatch({ mapId: 'def_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 7 });
    const renderer = createRenderer(canvas, { size: () => ({ w, h }) });
    renderer.fit(m.grid);
    // 建两座工事，留在基地附近跑 12 秒：样张要看得见**基地 + 工事 + 摇杆**这套东西
    // （跑到野外去拍，画面里只剩一张空地图，看不出防守在玩什么）
    buildFort(m, 0, 'fort_arrow');
    buildFort(m, 1, 'fort_wall');
    for (let i = 0; i < Math.round(12 / TICK_STEP); i += 1) updateDefense(m, TICK_STEP);
    const model = { rate: 1, paused: false, potionCount: 2 };
    const L = layoutDefense(m, model);
    renderer.draw({ m, scale: 1.5, now: m.time });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawDefenseHud(ctx, m, L, {
      message: '摇杆走路 · 点工事位建塔 · 预警响了就回城',
      stick: { base: L.stick, dir: { x: 0.7, y: -0.7, mag: 1 } },
    });
    window.__previewReady = true;
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
    // 战场那张顺手把**新手引导条**也摆上：第一局进 TD 就是这个样子（引导文案从状态机那唯一一份取）；
    // 别的几张（商店 / 结算 / 暂停）不摆——真机上它们要么盖住条，要么（结算）本来就把条收掉了
    tutorial: page === 'battle' ? (await import('/src/tutorial.js')).TUTORIAL_STEPS[0].text : null,
  };
  renderer.draw({ m, selectedSlot: null, selectedTower: null, localSlot: 0, now: m.time, pulses: false, hintSlots: 3 });
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
  }   // ← 这个 } 收的是「防守分支 else」；少了它整段脚本语法不过（headless 只会给一张空图）
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
  /**
   * headless Chrome 偶发**不退出**（本轮实测卡了 3 分半、零输出，只能手 kill）——所以给它一个上限，
   * 到点就杀，别把整个出样张的工具挂在那一张图上（浏览器冒烟的 §182 是同一类问题的另一个现场）。
   */
  const exited = await Promise.race([
    new Promise((r) => chrome.on('exit', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 30000).unref?.()),
  ]);
  if (!exited) {
    try { chrome.kill('SIGKILL'); } catch { /* 已经退了 */ }
    console.log(`⚠ 样张 ${shot.file}：headless Chrome 30 秒没退出，已强杀（这一张没出，继续下一张）`);
    continue;
  }
  await copyFile(png, join(SHOTS_DIR, shot.file));
  const { size } = await stat(png);
  if (size < 3000) {
    // 空图 = 页面里抛了错（或白屏）。把标题里那句错误打出来，别让样张悄悄变成一块黑
    const dump = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--virtual-time-budget=2000', '--dump-dom', `http://127.0.0.1:${port}/?page=${shot.page}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let html = '';
    dump.stdout.on('data', (d) => { html += d; });
    await new Promise((r) => dump.on('exit', r));
    const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] ?? '(没读到)';
    console.log(`⚠ 样张 ${shot.file} 只有 ${size} 字节，可能是空白：${title}`);
  } else {
    console.log(`样张 → docs/testing/screenshots/${shot.file}（${shot.w}×${shot.h} 逻辑像素 @2x）`);
  }
}
server.close();
