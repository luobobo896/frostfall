// 大厅一屏的**观感样张**：把同一份 `src/minigame/lobby.js` 在浏览器里画一遍并截图。
//
// 为什么需要它：小游戏那一屏平时只能在微信开发者工具里看，而这里要的是「先看观感再决定其余 10 屏」。
// 大厅这一层是纯 Canvas（零 DOM），所以同一份代码既能在小游戏里跑，也能在浏览器里渲染成一张 PNG。
// 输出：docs/testing/screenshots/minigame-lobby.png（默认 667×375 逻辑像素 @2x）
//
// 用法：node tools/lobby-preview.mjs            （默认手机横屏）
//       node tools/lobby-preview.mjs 1024 768   （换个尺寸看缩放）
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const [w = '667', h = '375'] = process.argv.slice(2);
const OUT = join(ROOT, 'docs/testing/screenshots/minigame-lobby.png');

if (!existsSync(CHROME)) {
  console.log(`跳过：没找到 Chrome（${CHROME}）。这一步只是出样张，不影响别的检查。`);
  process.exit(0);
}

// 预览页：一份最小 HTML，只做「建 canvas → 调 lobby.js 画一帧 → 挂个调试口」
const page = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#05080e}canvas{display:block;width:${w}px;height:${h}px}</style></head>
<body><canvas id="c"></canvas><script type="module">
import { layoutLobby, drawLobby } from '/src/minigame/lobby.js';
const w = ${w}, h = ${h}, dpr = 2;
const canvas = document.getElementById('c');
canvas.width = w * dpr; canvas.height = h * dpr;
const ctx = canvas.getContext('2d');
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
// 一份「像玩家档」的模型：解锁两张 TD 图 + 一张防守图，人物 3 级、声望 240
const model = {
  mode: 'td', map: 'map_02', difficulty: 'normal', length: 'short', hero: 'hero_ranger',
  profile: { commanderLevel: 3, reputation: 240 },
  unlocked: ['map_01', 'map_02', 'def_01'], unlockedCount: 3, canStart: false, hint: null,
  locked: { map_03: '声望 500', def_02: '守住边陲小镇' },
};
drawLobby(ctx, model, layoutLobby(w, h, model));
window.__previewReady = true;
</script></body></html>`;

const dir = await mkdtemp(join(tmpdir(), 'ff-lobby-'));
await writeFile(join(dir, 'index.html'), page);
// 预览页通过 http 起一个静态服务才能 import 到 /src（file:// 下 ES 模块会被 CORS 拦）
const { createServer } = await import('node:http');
const { readFile } = await import('node:fs/promises');
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  try {
    const body = path === '/' ? await readFile(join(dir, 'index.html'))
      : await readFile(join(ROOT, path.replace(/^\//, '')));
    res.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

await mkdir(join(ROOT, 'docs/testing/screenshots'), { recursive: true });
const shot = join(dir, 'shot.png');
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--window-size=${w},${h}`, `--screenshot=${shot}`, '--virtual-time-budget=1200',
  `http://127.0.0.1:${port}/`,
], { stdio: 'ignore' });
await new Promise((r) => chrome.on('exit', r));
server.close();
await copyFile(shot, OUT);
console.log(`大厅样张 → ${OUT}（${w}×${h} 逻辑像素 @2x）`);
