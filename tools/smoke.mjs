// 真浏览器冒烟：headless Chrome 走一遍玩家的操作路径（点塔位建塔 / 升级 / 出售 / 商店 / 背包 / 设置 / 暂停）。
// 覆盖的是用例测不到的那层——「面板写好了但按钮没接线」这类问题，`npm test` 里的 DOM 桩抓不到。
// 用法：node tools/smoke.mjs [url] [--keep]   （不给 url 就自己起一个静态服务器）
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROTOCOL_VERSION } from '../src/protocol.js';   // §122：Node 侧那条「恶意客户端」也要带对版本

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** 要一个当前没人用的端口：固定端口会和「上一次没退干净的冒烟」或别的进程撞车，
 *  撞上之后冒烟会连着**别人的**服务器跑，报出一堆莫名其妙的红（我为此查了半小时）。 */
const freePort = () => new Promise((res, rej) => {
  const probe = createServer();
  probe.on('error', rej);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => res(port));
  });
});
const PORT = await freePort();          // 浏览器调试端口
let SERVE_PORT = await freePort();      // 静态服务器端口（只在没传 url 时用；起不来会再换一个，见下）

if (!existsSync(CHROME)) {
  console.log(`跳过：没找到 Chrome（${CHROME}）。这条检查依赖本机浏览器。`);
  process.exit(0);
}

const fails = [];
let total = 0;
const check = (name, ok, detail = '') => {
  total += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
/**
 * §182.3：**冒烟自己炸了也要说人话**。§182 的 CDP 20 秒上限把「永久挂住」降级成了「这次没答」，
 * 于是 `js()` 可能拿到 `undefined` → 后面那些「拼 detail 字符串」的地方（`hud.castle` 之类）会当场
 * 抛 TypeError，屏幕上只剩一段堆栈（本轮实测过一次）。这里统一收住：说清是**工具链/机器**的问题、
 * 提示空出机器重跑，而不是让人以为代码坏了。
 */
process.on('uncaughtException', (err) => {
  console.error(`\n❌ 冒烟工具自己抛了异常：${err?.message ?? err}`);
  console.error('   多半是 CDP 请求超时或页面在导航交接（见 §182/§182.2）——空出机器、单独重跑一次再判断。');
  console.error(`   进度：已跑 ${total} 条检查，其中 ${fails.length} 条没过。`);
  process.exit(1);
});

/* ---------- 起服务器（除非调用方给了 url） ---------- */

const urlArg = process.argv.find((a) => a.startsWith('http'));
let server = null;
if (!urlArg) {
  // 用联机服务器（它同时提供静态资源），这样第三遍还能验「创建联机房间」这条路径。
  // 档案写到临时目录，别污染玩家自己的 .data/profiles.json。
  // 端口是「先探一个空闲的、再交给服务器去绑」，两次绑定之间有窗口——被别的进程抢走时服务器直接退出。
  // 所以这里**换端口重试**，并把服务器自己的报错吐出来（以前 stdio 全 ignore，失败只剩一句「端口被占了」）。
  const dataDir = mkdtempSync(join(tmpdir(), 'ff-data-'));
  for (let attempt = 0; attempt < 3 && !server; attempt += 1) {
    if (attempt) SERVE_PORT = await freePort();
    const child = spawn(process.execPath, ['tools/server.mjs', String(SERVE_PORT)],
      // FF_DEBUG_HOOKS=1：冒烟要用 `/create?wave=4` 那个快进钩子（§126 之后它默认关着）
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, FF_DATA_DIR: dataDir, FF_DEBUG_HOOKS: '1' } });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += String(b).slice(0, 400); });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) console.error(`⚠️ 冒烟用的服务器退出了（code ${code}），后面的红可能是它引起的`);
    });
    let up = false;
    for (let i = 0; i < 50; i += 1) {
      if (child.exitCode !== null) break;
      try { if ((await fetch(`http://127.0.0.1:${SERVE_PORT}/`)).ok) { up = true; break; } } catch { /* 还没起来 */ }
      await sleep(100);
    }
    if (up) { server = child; break; }
    child.kill();
    console.error(`服务器第 ${attempt + 1} 次没起来（端口 ${SERVE_PORT}）：${stderr.trim() || '无输出'}`);
  }
  if (!server) { console.error('服务器起不来（试了 3 个端口），后面没法跑'); process.exit(1); }
}
const url = urlArg ?? `http://127.0.0.1:${SERVE_PORT}/?notutorial=1`;
/** 同一个服务器的另一个入口（换查询串用；localStorage 是同一个 origin，存档/档案都还在） */
const lobbyUrl = (query = '') => { const u = new URL(url); u.search = query; return u.toString(); };

/* ---------- 起 Chrome，接 DevTools 协议 ---------- */

const profile = mkdtempSync(join(tmpdir(), 'ff-smoke-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--mute-audio', '--window-size=1334,750', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  // §178：真机（iOS / 移动 Chrome）的自动播放策略是「要有用户手势」。默认 headless 是宽松的，
  // 于是「提示音真的响了」这条检查在这里**永远为真**，在真机上却一声不响——用真机那条策略跑。
  '--autoplay-policy=document-user-activation-required',
  // §197：把 `game.test` 指到本机——用来验「`sim` 钩子在**非本机**域名下不生效」（不想改 /etc/hosts）
  `--host-resolver-rules=MAP game.test 127.0.0.1`,
  'about:blank'], { stdio: 'ignore' });

// 中途抛异常/被 Ctrl-C 也要把自己起的东西收掉，否则下次跑会撞端口、留一堆僵尸 Chrome
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch { /* 已经退出了 */ }
  try { server?.kill('SIGTERM'); } catch { /* 已经退出了 */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });
process.on('SIGTERM', () => { cleanup(); process.exit(1); });

let target = null;
for (let i = 0; i < 100 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch {}
  if (!target) await sleep(100);
}
if (!target) { console.error('Chrome DevTools 没起来'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
const pageErrors = [];
/**
 * §182.2：**导航交接的读取闸门**。`Page.navigate` 之后、新文档提交之前，`Runtime.evaluate` 回答的
 * 还是**上一页**——于是「等 `!!__frostfall`」这种就绪条件会被上一页直接满足，后面几条检查全在
 * 读者上一页的状态（§177 假红过一次、§183 一次、§188 那一轮又整段崩过）。
 * 这里在 `send('Page.navigate')` 上挂一个闸：没收到 `Page.frameNavigated` 之前，`js()` 一律返回
 * `undefined`（让 `waitFor` 继续等），从根上杜绝「读到上一页」。
 */
let navPending = false;
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Page.frameNavigated') navPending = false;
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    pageErrors.push(`未捕获异常：${d.exception?.description ?? d.text}${d.url ? ` @${d.url}:${d.lineNumber + 1}` : ''}`);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    pageErrors.push(`console.error：${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  if (method === 'Page.navigate') navPending = true;   // §182.2：闸门关到 frameNavigated 为止
  ws.send(JSON.stringify({ id, method, params }));
  /**
   * §182：**导航交接时 CDP 会丢响应**——`Runtime.evaluate` 正好撞上 `Page.navigate` 的提交，
   * 那条响应就永远不会回来，于是 `await` 挂住**整条冒烟**（本轮实测：卡了 13 分钟，零输出，
   * 只能自己 kill）。给每个请求一个上限：超时当作「这次没答」（`js()` 拿到 undefined，
   * `waitFor` 继续轮询），并打一行警告——把「永久挂住」降级成「这一条可能慢一轮」。
   */
  setTimeout(() => {
    if (pending.delete(id)) { console.error(`⚠️ CDP 20 秒没响应：${method}（当作这次没答）`); res({}); }
  }, 20000).unref?.();
});
/** 在页面里求值（用 returnByValue 拿回 JSON）。导航交接期间一律不答（见上面那道闸）。 */
const js = async (expr) => {
  if (navPending) return undefined;
  return (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;
};
/** 等页面上某个条件成立（比固定 sleep 稳：机器忙的时候页面慢一点也不会误判）。 */
const waitFor = async (expr, timeoutMs = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await js(expr)) return true;
    await sleep(150);
  }
  return false;
};
/** 点一个 DOM 元素（走真实的 onclick，不是直接调函数）。 */
const click = async (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
  if(!e) return 'no-el'; if(e.closest('.hidden')) return 'hidden'; if(e.disabled) return 'disabled';
  e.click(); return 'ok';})()`);
/**
 * §154：设置里的开关列表**按模式变**（TD 摆波次预告 / 整图可见，防守摆自动拾取），
 * 下标不再稳定——按**文字**取下标，别再写 `:nth-child(3)`（那几条以前就为此错过按钮）。
 */
const toggleSel = async (label) => `#setToggles button:nth-child(${await js(
  `[...document.querySelectorAll('#setToggles button')].findIndex((b) => b.textContent.startsWith(${JSON.stringify(label)})) + 1`)})`;
/** 在画布上按格坐标点一下（走真实 pointerdown，用来点塔位）。 */
const clickSlot = async (slotIndex) => {
  const p = await js(`(()=>{const s=__frostfall.match.map.slots[${slotIndex}];
    const q=__frostfall.renderer.toScreen(s.x,s.y); const r=__frostfall.renderer ? document.getElementById('game').getBoundingClientRect() : null;
    return {x:Math.round(r.left+q.x), y:Math.round(r.top+q.y)};})()`);
  await clickCell(p);
  return p;
};
/**
 * 找一个**没被 HUD 盖住**的空工事位再点它。
 * 直接取「第一个空位」会假红：HUD（技能行 / 操作行 / 面板）本来就压在屏幕边上，
 * 相机跟随英雄时那个工事位可能正好在 HUD 底下，点上去命中的是面板而不是地图。
 */
const fortPoint = () => js(`(()=>{const m=__frostfall.match, rct=document.getElementById('game').getBoundingClientRect();
  for (let i=0;i<m.def.fortSlots.length;i++){
    if (m.forts.some((f)=>f.slot===i)) continue;
    const s=m.def.fortSlots[i]; const p=__frostfall.renderer.toScreen(s.x,s.y);
    const x=Math.round(rct.left+p.x), y=Math.round(rct.top+p.y);
    if (document.elementFromPoint(x,y)?.id !== 'game') continue;
    return {x,y,slot:i};
  }
  return null;})()`);
/** 挑一个「真的能点到」的塔位（HUD 会盖住一部分塔位，联机时顶栏布局还会变） */
const pickSlot = async (onlyEmpty = false) => js(`(()=>{const m=__frostfall.match, r=__frostfall.renderer;
  const box=document.getElementById('game').getBoundingClientRect();
  for(let i=0;i<m.map.slots.length;i++){
    if(${onlyEmpty} && m.towers.some((t)=>t.slot===i)) continue;
    const s=m.map.slots[i], p=r.toScreen(s.x,s.y);
    if(p.x<box.left+2||p.y<box.top+2||p.x>box.right-2||p.y>box.bottom-2) continue;
    if(document.elementFromPoint(p.x,p.y)?.id!=='game') continue;
    return i;
  }
  return -1;})()`);
/** 在画布上的某个屏幕点按一下（真实 pointerdown，走 pointer 输入链路）。 */
const clickCell = async (p) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }
  await sleep(80);
};
const screenshot = async (name) => {
  const data = (await send('Page.captureScreenshot', { format: 'png' })).result?.data;
  const path = join(tmpdir(), name);
  if (data) writeFileSync(path, Buffer.from(data, 'base64'));
  return path;
};
/** 版式体检：可见元素不许溢出视口；可点元素热区必须 ≥44×44（§1.9.2 / 附录 B）。 */
const layoutIssues = () => js(`(()=>{const vw=innerWidth,vh=innerHeight;const out=[],small=[];
  const vis=(e)=>{const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&+s.opacity>0.05;};
  for(const e of document.getElementById('stage').querySelectorAll('*')){
    if(e.id==='game') continue;
    if(!vis(e)) continue;
    const r=e.getBoundingClientRect();
    if(r.width<1||r.height<1) continue;
    // 可滚动容器里的内容允许「越过折叠线」——这是设计好的：.overlay 是 overflow-y:auto，
    // 内容比视口高时靠滚动看；§158 起地图行是 overflow-x:auto 的横滑条，右边被裁的那两张
    // 同样是「滚一下就能看到」。**只在祖先真的可滚动**时才放过，顶部被裁（上下越界）仍然算问题。
    const scrollable=(el,axis='Y')=>{let p=el.parentElement;while(p&&p!==document.body){const st=getComputedStyle(p);
      if(/(auto|scroll)/.test(st['overflow'+axis]))return true;p=p.parentElement;}return false;};
    if((r.right>vw+1&&!scrollable(e,'X'))||r.left<-1||r.top<-1||(r.bottom>vh+1&&!scrollable(e))){
      if(out.length<6) out.push((e.id||e.className||e.tagName)+' ['+[r.left|0,r.top|0,r.right|0,r.bottom|0].join(',')+']');
    }
    if(e.tagName==='BUTTON'&&(r.height<44||r.width<44)){
      if(small.length<6) small.push((e.id||e.textContent.trim().slice(0,6))+Math.round(r.width)+'×'+Math.round(r.height));
    }
  }
  return {out,small,vw,vh};})()`);
/**
 * §145：HUD 是**一层层浮层**，所以「两块面板盖在一起」是这套版式最容易出的问题，
 * 而 `layoutIssues()` 查的是「溢出视口 / 热区 ≥44」——盖在一起它一点都看不出来（下一波预告压在
 * 核心血条上、每条 toast 糊在资源卡上，都是**看图**才发现的）。这里量成对的矩形相交。
 * toast 是瞬时的（1.6 秒），所以先把一条**较长**的文案打上去，量完把原来的状态还回去。
 */
const hudOverlaps = () => js(`(()=>{
  const t=document.getElementById('toast');
  const prevText=t.textContent, wasShown=t.classList.contains('show');
  __frostfall.ui.toast('版式体检：一条较长的提示文案（用来量它会不会压住别的面板）');
  const box=(sel)=>{const e=document.querySelector(sel);
    if(!e||e.closest('.hidden')) return null;
    const s=getComputedStyle(e);
    if(s.display==='none'||s.visibility==='hidden'||+s.opacity<0.05) return null;
    const r=e.getBoundingClientRect();
    return (r.width<1||r.height<1)?null:{sel,x:r.left,y:r.top,w:r.width,h:r.height};};
  const PAIRS=[['.hud-next-wave .panel','.wave-panel'],['#toast','.economy-panel'],['#toast','.wave-panel'],
    ['#toast','.player-panel'],['.economy-panel','.wave-panel'],['.economy-panel','.player-panel'],
    ['.wave-panel','.player-panel'],['#toast','.hud-right'],['.hud-next-wave .panel','.hud-right'],
    // §161：防守专用的那几块（TD 页面里它们是 hidden，会自动跳过）——真机视口下防守 HUD 曾经
    // 四组重叠：小地图压操作行、技能排压轮次面板的「修城/回城」、小地图还顶出屏幕下沿。
    ['#defensePanel','#skillRow'],['#defensePanel','#minimapBox'],['#minimapBox','#skillRow'],
    ['#minimapBox','.op-row'],['#defensePanel','.op-row'],['#minimapBox','.hero-panel']];
  const bad=[];
  for(const [a,b] of PAIRS){
    const A=box(a),B=box(b); if(!A||!B) continue;
    const w=Math.min(A.x+A.w,B.x+B.w)-Math.max(A.x,B.x), h=Math.min(A.y+A.h,B.y+B.h)-Math.max(A.y,B.y);
    if(w>0&&h>0) bad.push(a+' × '+b+' 重叠 '+Math.round(w)+'×'+Math.round(h)+'px');
  }
  t.textContent=prevText; t.classList.toggle('show',wasShown);
  return bad;})()`);
const checkLayout = async (where, { skipOverlap = null } = {}) => {
  const ov = await hudOverlaps();
  // §203：只有「568×320 的防守」这一格允许跳过互压（那是一个**已知的、待拍板的设计冲突**：
  // 320pt 高度下「76pt 技能键 + 60pt 拇指弧 + 轮次面板」三者放不下，见 STATUS 第 33 条）。
  // 别的格一律不许跳过——`skipOverlap` 只接受 `where` 自己的名字，写错地方不会生效。
  if (skipOverlap === where) check(`${where}：HUD 浮层互压（§145，§203 记为待拍板）`, true, `跳过：${ov.join(' | ') || '无'}`);
  else check(`${where}：HUD 浮层之间不互相压（§145）`, ov.length === 0, ov.join(' | '));
  const l = await layoutIssues();
  const panelH = await js(`(()=>{const p=document.querySelector('#startScreen .panel');return p?Math.round(p.getBoundingClientRect().height):null;})()`);
  check(`${where}：${l.vw}×${l.vh} 下没有元素溢出视口`, l.out.length === 0,
    [l.out.join(' | '), panelH ? `开始面板高 ${panelH}px` : ''].filter(Boolean).join(' · '));
  check(`${where}：可点元素热区都 ≥44×44（§1.9.2）`, l.small.length === 0, l.small.join(' | '));
};
/**
 * §1.9.2 的人体工学数值：技能按钮直径 76-88pt、按钮间距 ≥24pt、
 * 关键按钮落在拇指舒适弧（距底边 60-200pt、距右侧边 0-120pt）。
 */
const ergonomics = () => js(`(()=>{
  const vw=innerWidth, vh=innerHeight;
  const box=(sel)=>{const bs=[...document.querySelectorAll(sel)].filter((b)=>b.offsetParent!==null);
    const r=bs.map((b)=>{const x=b.getBoundingClientRect();
      return {name:b.textContent.trim().slice(0,4), w:Math.round(x.width), h:Math.round(x.height),
        left:Math.round(x.left), right:Math.round(x.right), top:Math.round(x.top), bottom:Math.round(x.bottom)};});
    // 只量**同一行**内相邻按钮的间距：窄视口下操作行会折行（真机 667px 宽放不下 6 个），
    // 跨行的「左减右」是负数，那不是间距问题
    const gaps=[]; for(let i=1;i<r.length;i++) if(Math.abs(r[i].top-r[i-1].top)<=2) gaps.push(r[i].left-r[i-1].right);
    return {n:r.length,r,gaps,rows:new Set(r.map((x)=>x.top)).size,
      fromBottom: r.length?Math.round(vh-Math.max(...r.map(x=>x.bottom))):null,
      fromRight: r.length?Math.round(vw-Math.max(...r.map(x=>x.right))):null};};
  return {vw,vh,skill:box('#skillRow button'),ops:box('.op-row button')};
})()`);
const checkErgonomics = async (where) => {
  const e = await ergonomics();
  const bad = e.skill.r.filter((x) => x.w < 76 || x.h < 76 || x.w > 88 || x.h > 88);
  check(`${where}：技能按钮直径 76-88pt（§1.9.2）`, bad.length === 0, e.skill.r.map((x) => `${x.name} ${x.w}×${x.h}`).join(' · '));
  for (const [label, g] of [['技能', e.skill], ['操作按钮', e.ops]]) {
    check(`${where}：${label}间距 ≥24pt（§1.9.2）`, g.gaps.every((x) => x >= 24), `${g.rows} 行 · 间距 ${g.gaps.join('/')}pt`);
    check(`${where}：${label}行落在拇指舒适弧（距底 60-200pt、距右 0-120pt）`,
      g.fromBottom >= 60 && g.fromBottom <= 200 && g.fromRight >= 0 && g.fromRight <= 120,
      `距底 ${g.fromBottom}pt · 距右 ${g.fromRight}pt`);
  }
};
const state = () => js(`({towers: __frostfall.match.towers.length, gold: Math.round(__frostfall.match.gold),
  wave: __frostfall.match.wave.index, zoom: __frostfall.renderer.scale,
  probe: __frostfall.renderer.toScreen(__frostfall.match.map.grid.w/2, __frostfall.match.map.grid.h/2),
  wheel: !document.getElementById('wheel').classList.contains('hidden'),
  towerPanel: !document.getElementById('towerPanel').classList.contains('hidden'),
  shop: !document.getElementById('shopPanel').classList.contains('hidden'),
  bag: !document.getElementById('bagPanel').classList.contains('hidden'),
  settings: !document.getElementById('settingsPanel').classList.contains('hidden'),
  overlay: !document.getElementById('overlay').classList.contains('hidden'),
  toast: document.getElementById('toast').textContent})`);
/** 拖一次（真实 pointer 事件），用来验「单指拖空白处平移」。起点挑一块视野内、离所有塔位最远的空地。 */
const dragBy = async (dx, dy) => {
  const base = await js(`(()=>{const m=__frostfall.match, r=__frostfall.renderer;
    const box=document.getElementById('game').getBoundingClientRect();
    let best={x:Math.floor(m.map.grid.w/2),y:Math.floor(m.map.grid.h/2)}, bestD=-1;
    for(let y=1;y<m.map.grid.h;y++) for(let x=1;x<m.map.grid.w;x++){
      const s=r.toScreen(x,y);
      if(s.x<box.left+60||s.x>box.right-60||s.y<box.top+60||s.y>box.bottom-60) continue;
      if(document.elementFromPoint(s.x,s.y)?.id!=='game') continue;   // HUD 盖住的地方点不到画布
      const d=Math.min(...m.map.slots.map(t=>Math.hypot(t.x-x,t.y-y)));
      if(d>bestD){bestD=d;best={x,y};}
    }
    const s=r.toScreen(best.x,best.y); return {x:Math.round(s.x),y:Math.round(s.y),dist:bestD};})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: base.x, y: base.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x + dx, y: base.y + dy, button: 'none', buttons: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: base.x + dx, y: base.y + dy, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(120);
  return base;
};

await send('Runtime.enable');
await send('Page.enable');
// 按设计基准分辨率量版式（§14.1 的 1334×750 横屏）；不设的话 headless 的 innerHeight 只有 663
await send('Emulation.setDeviceMetricsOverride', { width: 1334, height: 750, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(2000);

/* ---------- 真正跑一遍 ---------- */

// §10.7：首包预算与首屏耗时（本机口径；真机 4G 与低端机只能真机验）
const firstLoad = await js(`(()=>{
  const nav = performance.getEntriesByType('navigation')[0] ?? {};
  const res = performance.getEntriesByType('resource');
  const bytes = (res.reduce((s, r) => s + (r.transferSize || r.encodedBodySize || 0), 0) || 0)
    + (nav.transferSize || nav.encodedBodySize || 0);
  return { bytes, domReady: Math.round(nav.domContentLoadedEventEnd ?? 0), loaded: Math.round(nav.loadEventEnd ?? 0), files: res.length };
})()`);
check('§10.7 首包 < 4MB（本机口径：HTML + 样式 + 全部脚本，不计将来接入的美术/音频）',
  firstLoad.bytes > 0 && firstLoad.bytes < 4 * 1024 * 1024,
  `${(firstLoad.bytes / 1024).toFixed(0)} KB · ${firstLoad.files} 个资源`);
check('§10.7 首次进入 ≤ 3 秒（本机口径，真机 4G 另算）',
  firstLoad.domReady > 0 && firstLoad.domReady <= 3000,
  `DOMContentLoaded ${firstLoad.domReady}ms · load ${firstLoad.loaded}ms`);

check('大厅渲染出英雄卡片与地图', await js(`document.querySelectorAll('#optHero .hero-card').length === 4
  && document.querySelectorAll('#optMap button').length >= 3 && document.querySelectorAll('#optMap button.on').length === 1`),
  `卡片 ${await js(`document.querySelectorAll('#optHero .hero-card').length`)} 张` + ` · 地图 ${await js(`document.querySelectorAll('#optMap button').length`)} 张（选中 ${await js(`document.querySelectorAll('#optMap button.on').length`)}）` + ` · 未解锁带 🔒：${await js(`[...document.querySelectorAll('#optMap button')].some(b=>b.textContent.includes('🔒'))`)}`);
// §3.4 的阵容建议要真的写进游戏内引导（文档标题原文就是「写进游戏内引导」）
check('大厅：§3.4 的推荐阵容写在选人旁边（四档强度都在）',
  await js(`(()=>{const t=document.getElementById('compGuide')?.textContent ?? '';
    return ['（S）','（S+）','（A）','（C）'].every((k)=>t.includes(k));})()`),
  await js(`(document.getElementById('compGuide')?.textContent ?? '').replace(/\\s+/g,' ').slice(0,70)`));
// 「大厅能开局」比「大厅不溢出」更硬：面板再好看，开局按钮被顶到折叠线以下就是坏体验
check('大厅：四个开局入口都在视口内（不用滚动就能开局）',
  await js(`(()=>{const ids=['btnSolo','btnMatch','btnCreateRoom','btnJoinRoom'];
    return ids.every((id)=>{const r=document.getElementById(id).getBoundingClientRect();
      return r.bottom<=innerHeight+1&&r.top>=-1&&r.right<=innerWidth+1;});})()`),
  await js(`(()=>{const r=document.getElementById('btnSolo').getBoundingClientRect();
    return '开始面板高 '+Math.round(document.querySelector('#startScreen .panel').getBoundingClientRect().height)+'px · 按钮底 '+Math.round(r.bottom)+'px / 视口 '+innerHeight+'px';})()`));
check('地图卡面有缩略图 + 路线数/战绩（§2.7）',
  await js(`[...document.querySelectorAll('#optMap .map-card')].every(c=>c.querySelector('canvas.thumb')?.width > 0)
    && document.querySelector('#optMap .map-card .mmeta').textContent.includes('条路')`),
  await js(`document.querySelector('#optMap .map-card .mmeta').textContent`));
// §156：空中航线要写在卡面上——迷雾沼泽生成的是 3 条路（2 地面 + 1 空中），卡面以前只印「2 条路」
// （§2.2 的地图表写的是「2 + 1 空中」）。这里连「生成出来的图真的有一条 air 路」一起查。
const mistCard = await js(`(()=>{const c=[...document.querySelectorAll('#optMap .map-card')].find((x)=>x.textContent.includes('迷雾沼泽'));
  return {meta: c?.querySelector('.mmeta')?.textContent ?? '（没有这张卡）',
    airPath: !!__frostfall.MAPS?.map_03?.airPath, pathCount: __frostfall.MAPS?.map_03?.pathCount};})()`);
check('§156 空中航线写在卡面上（迷雾沼泽 = 2 条路 + 1 条空中航线）',
  /2 条路 \+ 1 条空中航线/.test(mistCard.meta) && mistCard.airPath === true && mistCard.pathCount === 2,
  `卡面「${mistCard.meta}」· 数据 airPath=${mistCard.airPath} pathCount=${mistCard.pathCount}`);
// 锁着的图点一下要说清缺什么（不是静默无反应）
check('大厅：点锁着的图会提示解锁条件',
  (await click('#optMap .map-card.locked')) === 'ok'
  && (await js(`document.getElementById('startHint').textContent`)).includes('未解锁'),
  await js(`document.getElementById('startHint').textContent`));
// §115：防守模式没有「局内时长」（内核里 createDefenseMatch 不收 length，防守按轮次无尽推进）。
// 以前这排照样显示「12 波 / 长局 30 波」——玩家选「长局 30 波」开局，防守局不会因此变成 30 波。
check('大厅：TD 模式下「局内」有 12 波 / 长局两个选项',
  await js(`document.querySelectorAll('#optLength button').length === 2`));
await click('#optMode button:nth-child(2)');       // 切到防守生存
await sleep(250);
const lenDefense = await js(`({buttons: document.querySelectorAll('#optLength button').length,
  text: document.getElementById('optLength').textContent.trim()})`);
check('§115 防守模式下不摆「局内时长」这排假选项，改写清它是无尽轮次',
  lenDefense.buttons === 0 && /无尽/.test(lenDefense.text),
  `按钮 ${lenDefense.buttons} 个 · 文案「${lenDefense.text}」`);
await click('#optMode button:nth-child(1)');       // 切回 TD：后面几条用例的前提是 TD
await sleep(250);
check('§115 切回 TD 后「局内」选项回来（同一段渲染逻辑，两个模式各显示各的）',
  await js(`document.querySelectorAll('#optLength button').length === 2
    && [...document.querySelectorAll('#optLength button')].some((b) => b.textContent.includes('30 波'))`));
await checkLayout('大厅');
const shotLobby = await screenshot('ff-smoke-lobby.png');

check('进局：单人开局后大厅收起', await click('#btnSolo') === 'ok' && await js(`document.getElementById('startScreen').classList.contains('hidden')`));
await sleep(500);
await checkLayout('TD 开局');
await checkErgonomics('TD 开局');
// §14.3 稿 4：TD 局里右侧日志面板要在（与防守那边的「让位」是一对；以前防守 hide 完不恢复）
check('§14.3 稿 4：TD 局里右侧日志面板可见（计算样式不是 none）',
  !(await js(`document.getElementById('stage').classList.contains('defense')`))
  && (await js(`getComputedStyle(document.getElementById('log').parentElement).display`)) !== 'none',
  `stage=${await js(`document.getElementById('stage').className`)} · display=${
    await js(`getComputedStyle(document.getElementById('log').parentElement).display`)}`);
// §1.9.1：摇杆只属于防守（「TD 塔防：主操作 点选建造，**不需要摇杆**」）
const tdStick = await js(`({ mode: __frostfall.match.mode,
  hidden: document.getElementById('stickBase').classList.contains('hidden') })`);
// 注意：TD 局的 `match.mode` 是 undefined（只有防守才写 'defense'），全项目都按
// `=== 'defense'` 判定——所以这里的判据是「不是防守」，别写成 `=== 'td'`
check('§1.9.1 TD 模式没有摇杆（底座收起）',
  tdStick.mode !== 'defense' && tdStick.hidden, JSON.stringify(tdStick));

// 真机视口：§14.3 的设计画布是「1334×750 px @2x = 667×375 pt」，而我们用的是
// `width=device-width` —— 真机横屏拿到的 CSS 视口就是 667×375，不是 1334×750。
// 验收视口（§14.1.1 / 附录 B）量一遍，真机视口也得量一遍，两套都要不溢出、热区不缩水。
await send('Emulation.setDeviceMetricsOverride', { width: 667, height: 375, deviceScaleFactor: 1, mobile: false });
await sleep(400);
await checkLayout('真机视口 667×375');
await checkErgonomics('真机视口 667×375');
// 设置面板刚多了一行（§1.9.3 的摇杆）：这一面只在 1334 下量过，小屏上会不会溢出没人知道
await click('#btnSettings');
await sleep(300);
await checkLayout('真机视口 667×375 · 设置面板');
await click('#settingsPanel [data-close]');
await sleep(200);
// 真机视口下的**建造轮盘**与**塔面板**：§61 只在小屏量过版式与设置面板，
// 而轮盘是最吃触控的那个元素（60pt 半径 + 贴边夹紧），小屏上会不会被裁到屏外没人验过
const phoneSlot = await pickSlot(true);
await clickSlot(phoneSlot);
await sleep(250);
const phoneWheel = await js(`(()=>{const w=document.getElementById('wheel');
  const wr=w.getBoundingClientRect(); const cx=wr.left, cy=wr.top;
  const opts=[...w.querySelectorAll('.opt')].map((b)=>{const r=b.getBoundingClientRect();
    return {d:Math.hypot((r.left+r.width/2)-cx,(r.top+r.height/2)-cy),
      on:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};});
  return {n:opts.length, allOn:opts.every((o)=>o.on), maxD:+Math.max(...opts.map((o)=>o.d)).toFixed(1),
    vw:innerWidth, vh:innerHeight};})()`);
check('真机视口 667×375：建造轮盘的四个选项都在屏内、离中心 ≤60pt（§1.9.1）',
  phoneWheel.n === 4 && phoneWheel.allOn && phoneWheel.maxD <= 60.5,
  `${phoneWheel.n} 个选项 · 最远 ${phoneWheel.maxD}pt · 视口 ${phoneWheel.vw}×${phoneWheel.vh}`);
// 轮盘量完就**取消**，别真建塔——这一节的后面还有一堆「塔数从 0 到 1」的用例（第一版真建了一座，
// 直接把后面 5 条打红：塔数、升级、出售、优先级、压测全对不上）
await click('#wheel .cancel');
await sleep(200);
check('真机视口：取消按钮能关掉轮盘且没有建塔', await js(`document.getElementById('wheel').classList.contains('hidden')
  && __frostfall.match.towers.length === 0`),
  `塔 ${await js(`__frostfall.match.towers.length`)}`);
// 塔面板：往内核里塞一座**临时**塔来开面板（量完就撤，绝不改变这一局的账）
await js(`(()=>{const m=__frostfall.match, s=m.map.slots[${phoneSlot}];
  m.towers.push({slot:${phoneSlot}, towerId:'tw_arrow', level:1, priority:'front', invested:60, cell:s});
  __frostfall.ui.openTower(m, ${phoneSlot}, __frostfall.renderer.toScreen(s.x, s.y)); return true;})()`);
await sleep(250);
const phonePanel = await js(`(()=>{const p=document.getElementById('towerPanel').getBoundingClientRect();
  return {hidden: document.getElementById('towerPanel').classList.contains('hidden'),
    inside: p.left>=0 && p.top>=0 && p.right<=innerWidth && p.bottom<=innerHeight,
    rect:[Math.round(p.left),Math.round(p.top),Math.round(p.right),Math.round(p.bottom)],
    vw:innerWidth, vh:innerHeight};})()`);
check('真机视口 667×375：塔面板整块落在视口里（小屏上不会被裁掉按钮）',
  !phonePanel.hidden && phonePanel.inside,
  `面板 ${phonePanel.rect.join(',')} · 视口 ${phonePanel.vw}×${phonePanel.vh}`);
await js(`(()=>{const m=__frostfall.match;
  m.towers = m.towers.filter((t)=>t.slot !== ${phoneSlot});
  __frostfall.ui.closeTower(); return true;})()`);
await sleep(200);
check('真机视口：量完把临时塔撤掉（这一局的账目没有被动过）',
  await js(`__frostfall.match.towers.length === 0 && document.getElementById('towerPanel').classList.contains('hidden')`));
const shotPhone = await screenshot('ff-smoke-td-phone.png');
await send('Emulation.setDeviceMetricsOverride', { width: 1334, height: 750, deviceScaleFactor: 1, mobile: false });
await sleep(300);

// 建塔：点塔位 → 轮盘 → 选第一种塔
let st0 = await state();
const slotIndex = await pickSlot();
const slot = await clickSlot(slotIndex);
check('点塔位弹出建造轮盘', (await state()).wheel, `落点 (${slot.x}, ${slot.y})`);
await checkLayout('建造轮盘打开时');
// §1.9.1：建造轮盘「4 个塔图标环绕，最远不超过 60 pt」，而且贴边点塔位时不能把选项甩到屏外
const wheelGeo = await js(`(()=>{const w=document.getElementById('wheel');
  const wr=w.getBoundingClientRect(); const cx=wr.left, cy=wr.top;   // .wheel 是 0×0 的点，left/top 就是轮盘中心
  const opts=[...w.querySelectorAll('.opt')].map((b)=>{const r=b.getBoundingClientRect();
    return {name:b.textContent.trim().slice(0,3), d:Math.hypot((r.left+r.width/2)-cx,(r.top+r.height/2)-cy), on:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};});
  const tap={x:${slot.x}, y:${slot.y}};
  return {ds:opts.map((o)=>+o.d.toFixed(1)), allOn:opts.every((o)=>o.on), n:opts.length,
    originOffset:Math.round(Math.hypot(cx-tap.x, cy-tap.y))};})()`);
check('建造轮盘：四个选项离轮盘中心 ≤60pt（§1.9.1）',
  wheelGeo && Array.isArray(wheelGeo.ds) && wheelGeo.ds.length > 0 && Math.max(...wheelGeo.ds) <= 60.5,
  `选项 ${JSON.stringify(wheelGeo)}`);
check('建造轮盘：所有选项都在屏幕内（贴边点塔位时轮盘会被夹进来）',
  wheelGeo.allOn, `中心离触点 ${wheelGeo.originOffset}pt（夹紧的代价，见验证记录 §77）`);
check('轮盘里点了塔就能建起来', (await click('#wheel button')) === 'ok' && (await state()).towers === 1);
await sleep(200);
let st1 = await state();
check('建塔扣了金币', st1.gold < st0.gold, `${st0.gold} → ${st1.gold}`);

// 点已有的塔 → 面板 → 升级 → 两步出售
await clickSlot(slotIndex);
check('点已有的塔弹出塔面板（不是轮盘）', (await state()).towerPanel && !(await state()).wheel);
await checkLayout('塔面板打开时');
// §3.8 / §6.2「UI 要给克制提示」：面板那行要写出这塔克什么（数字由克制表算，见 hud-model.attackHint）
const twStats = await js(`document.getElementById('twStats').textContent`);
check('§6.2 塔面板写出克制提示（不是只列伤害/攻速/射程）',
  twStats.includes('克') || twStats.includes('无明显克制'), `面板行「${twStats}」`);
// 面板的标题与等级（twName / twLevel 这两个 id 以前从没被断过）
const twHeader = await js(`({name: document.getElementById('twName').textContent.trim(),
  lv: document.getElementById('twLevel').textContent.trim(),
  wantName: __frostfall.TOWERS[__frostfall.match.towers[0].towerId].name,
  wantLv: __frostfall.match.towers[0].level})`);
check('塔面板的塔名与等级与内核一致',
  twHeader.name === twHeader.wantName && twHeader.lv === `Lv${twHeader.wantLv}`,
  `面板「${twHeader.name} ${twHeader.lv}」 · 内核「${twHeader.wantName} Lv${twHeader.wantLv}」`);
// §8.3：塔面板里的「攻击优先级」是玩家打 Boss 的杠杆（四种模式），四个按钮要真的写进内核，
// 而且面板上的那行字要就地跟着变（塔面板不是每帧重画的，只发 toast 会留下旧值）
const prioBefore = await js(`__frostfall.match.towers[0].priority`);
const prioButtons = await js(`(()=>{const bs=[...document.querySelectorAll('#prioRow button')];
  const b=bs.find(x=>x.textContent==='最强'); if(!b) return -1; b.click(); return bs.length;})()`);
await sleep(250);
check('§8.3 优先级按钮真的改到内核，面板那行字跟着变（不是只弹一条 toast）',
  prioButtons === 4 && await js(`__frostfall.match.towers[0].priority === 'strongest'`)
  && (await js(`document.getElementById('twPriority').textContent`)).includes('最强')
  && await js(`[...document.querySelectorAll('#prioRow button')].filter(b=>b.classList.contains('on')).length === 1`),
  `按钮 ${prioButtons} 个 · 优先级 ${prioBefore} → ${await js(`__frostfall.match.towers[0].priority`)}`
  + ` · 面板「${await js(`document.getElementById('twPriority').textContent`)}」`);
check('升级', (await click('#btnUpgrade')) === 'ok' && await js(`__frostfall.match.towers[0].level === 2`));
await click('#btnSell');
const armed = await js(`document.getElementById('btnSell').textContent`);
check('出售要先确认（两步）', armed === '确认出售', `按钮文案「${armed}」`);
await click('#btnSell');
await sleep(150);
check('确认后塔被卖掉', (await state()).towers === 0);

// §2.5：塔位热区会重叠，所以判定是「取距触点最近的塔位」——但同时要有个门槛：
// 离所有塔位都远的地方点下去不该冒出建造轮盘（那是拖动地图的手势）
const farPoint = await js(`(()=>{const m=__frostfall.match, r=__frostfall.renderer;
  const box=document.getElementById('game').getBoundingClientRect();
  let best=null, bestD=-1;
  for(let y=1;y<m.map.grid.h;y++) for(let x=1;x<m.map.grid.w;x++){
    const s=r.toScreen(x,y);
    if(s.x<box.left+60||s.x>box.right-60||s.y<box.top+60||s.y>box.bottom-60) continue;
    if(document.elementFromPoint(s.x,s.y)?.id!=='game') continue;
    const d=Math.min(...m.map.slots.map((t)=>Math.hypot(t.x-x,t.y-y)));
    if(d>bestD){bestD=d;best={x:Math.round(s.x),y:Math.round(s.y),d:+d.toFixed(1)};}
  }
  return best;})()`);
const toastBeforeHint = await js(`document.getElementById('toast').textContent`);
await clickCell(farPoint);
await sleep(200);
check('空格子点下去不出建造轮盘（§2.5 的「取最近塔位」有 2 格门槛）',
  !(await state()).wheel && await js(`__frostfall.view.selectedSlot === null`),
  `点 (${farPoint.x},${farPoint.y}) 离最近塔位 ${farPoint.d} 格（门槛 2 格）`);
// §14.3 稿 4：「标出『点击取最近塔位』的判定规则」。默认档（整图可见）下点空地原本什么都不发生，
// 玩家分不清「界面没响应」和「这儿没塔位」——所以要有一条把规则说出来的提示
// （断言「这一下**换了**提示文案」，不是「提示框里有塔位两个字」——后者会被上一条遗留的 toast 蒙过去）
const toastAfterHint = await js(`document.getElementById('toast').textContent`);
check('§14.3 稿 4：点空地会说明「取最近塔位」的判定规则（不是静默无响应）',
  toastAfterHint !== toastBeforeHint && toastAfterHint.includes('塔位')
  && (await js(`document.getElementById('toast').classList.contains('show')`)),
  `「${toastBeforeHint}」→「${toastAfterHint}」`);

// 提前开波 + 技能
await click('#btnEarly');
await sleep(300);
check('提前开波', (await state()).wave === 1, `第 ${(await state()).wave} 波 · ${(await state()).toast}`);
check('技能按钮能放技能', (await click('#skillRow .skill')) === 'ok'
  && await js(`__frostfall.match.hero.skillCd.some(c=>c>0) || __frostfall.match.events.some(e=>e.text.includes('旋风斩'))`));

// 商店 / 背包 / 设置
check('商店能打开', (await click('#btnShop')) === 'ok' && (await state()).shop);
await sleep(250);   // 面板里的行由下一帧渲染出来，等一帧再点
await checkLayout('商店打开时');
const goldBefore = (await state()).gold;
const buyClicked = await click('#shopList button');
await sleep(200);
check('商店能买东西', buyClicked === 'ok' && (await state()).gold < goldBefore,
  `点击 ${buyClicked} · 金币 ${goldBefore} → ${(await state()).gold} · ${(await state()).toast}`);
// §5.5：波次进行中买东西要读条 3 秒——钱当场扣、货 3 秒后才到
check('商店：波次中买的东西要读条 3 秒才到手（读条中包里没有）',
  await js(`!!__frostfall.match.shopCast`) && await js(`(__frostfall.match.bag.pot_small ?? 0) === 0`)
  && await js(`document.getElementById('shopHint').textContent.includes('读条中')`),
  `${await js(`document.getElementById('shopHint').textContent`)}`);
await sleep(3200);
check('商店：读条走完药品到手（金币已在那一下扣掉）',
  await js(`(__frostfall.match.bag.pot_small ?? 0) === 1`) && !(await js(`!!__frostfall.match.shopCast`)),
  `瓶数 ${await js(`__frostfall.match.bag.pot_small ?? 0`)} · 金币 ${(await state()).gold}`);
// §5.5.3：药品共 3 格——背包满了按钮要禁用并说明原因
await js(`__frostfall.match.bag = { pot_small: 3 }`);
await sleep(250);
check('商店：药品背包满 3 格后按钮禁用并写「背包已满」',
  (await js(`document.querySelector('#shopList button').textContent`)) === '背包已满'
  && await js(`document.querySelector('#shopList button').disabled`),
  await js(`document.querySelector('#shopList button').textContent`));
await js(`__frostfall.match.bag = { pot_small: 1 }`);
await sleep(200);
// §5.5.1：回城卷轴在塔防里没有作用 → 按钮禁用并写明「本模式不卖」（别让玩家白扔 80 金）
check('商店：塔防里回城卷轴禁用并写「本模式不卖」',
  await js(`(()=>{const rows=[...document.querySelectorAll('#shopList .shop-item')];
    const row=rows.find(r=>r.textContent.includes('回城卷轴'));
    const b=row?.querySelector('button');
    return !!b && b.disabled && b.textContent==='本模式不卖';})()`),
  await js(`(()=>{const rows=[...document.querySelectorAll('#shopList .shop-item')];
    return rows.find(r=>r.textContent.includes('回城卷轴'))?.querySelector('button')?.textContent ?? '(没有这一行)';})()`));
await click('#shopPanel [data-close]');
// §3.8 / §5.5.2：秘传技能书是「把砍掉的第 3 个主动技变成可选」的调节阀——
// 内核那侧有「买了就 skillUnlocked[2]=true」的用例，但**技能栏里真的多出一个按钮**这半
// 从来没在浏览器里验过（技能栏是每帧重建的，动态接线最容易坏）
await click('#btnShop');
await sleep(250);
await js(`(()=>{const m=__frostfall.match; m.gold=Math.max(m.gold,2000); m.lumber[0]=Math.max(m.lumber[0],50); return true;})()`);
await sleep(250);
// 前置：第 3 个技能按钮**本来就在栏里**（§3.8 把第 3 技砍掉了，所以它一直显示为「锁着」），
// 买书要改的是它的状态，不是把它变出来——第一版按「按钮数 +1」写，当然红
const thirdLockedBefore = await js(`(()=>{const b=document.querySelectorAll('#skillRow .skill')[2];
  return b ? b.classList.contains('locked') && b.disabled : null;})()`);
const bookClicked = await js(`(()=>{const rows=[...document.querySelectorAll('#shopList .shop-item')];
  const row=rows.find(r=>r.textContent.includes('秘传'));
  const b=row?.querySelector('button');
  if(!b || b.disabled) return 'no-button';
  b.click(); return 'ok';})()`);
// §5.5「补给有代价」：波次里下单要读条 3 秒才发货（上面那条用例刚验过），这里等它真的落地——
// 别拿「刚点完」的状态去断言（第一版只睡了 400ms，红在一个假问题上）
const bookLanded = await waitFor(`__frostfall.match.hero.skillUnlocked[2] === true`, 6000);
await sleep(300);   // 再等一帧把技能栏重画出来
check('§5.5.2 买「秘传技能书」后技能栏里第 3 个技能从「锁着」变成「能按」（不是只在数据里解锁）',
  bookClicked === 'ok' && await js(`__frostfall.match.hero.skillUnlocked[2] === true`)
  && thirdLockedBefore === true
  && await js(`(()=>{const b=document.querySelectorAll('#skillRow .skill')[2];
    return !!b && !b.classList.contains('locked') && !b.disabled;})()`),
  `点击=${bookClicked} · 书到手=${bookLanded} · 买之前锁着=${thirdLockedBefore} · 买之后「${
    await js(`document.querySelectorAll('#skillRow .skill')[2]?.textContent ?? ''`)}」（locked=${
    await js(`document.querySelectorAll('#skillRow .skill')[2]?.classList.contains('locked')`)}）· 金币 ${
    await js(`Math.round(__frostfall.match.gold)`)} · 木材 ${await js(`__frostfall.match.lumber[0]`)} · toast「${
    await js(`document.getElementById('toast').textContent`)}」`);

// §132：**精研技能书**（300 金、限购 2）写的是「技能等级 +1」。以前它买了没有任何效果
// （内核那半截 `+ (… ? 0 : 0)` 是占位符，`bookLevelBonus` 从没被读过；技能行还有一份内联公式）。
// 这里验**界面**上那一格真的从 Lv1 变成 Lv2——它和内核走的是同一个 `skillLevel()`。
await click('#btnShop');
await sleep(250);
await js(`(()=>{const m=__frostfall.match; m.gold=Math.max(m.gold, 3000); return true;})()`);
await sleep(200);
// 注意：技能格上的那行字**冷却中显示秒数、不冷却才显示 Lv**——所以先等到它落回 Lv 形态再读
const lvTextExpr = (i) => `document.querySelectorAll('#skillRow .skill')[${i}]?.querySelector('.cd')?.textContent ?? ''`;
await waitFor(`/^Lv\\d+$/.test(${lvTextExpr(1)})`, 6000);
const lvBefore = await js(lvTextExpr(1));
const upBookClicked = await js(`(()=>{const rows=[...document.querySelectorAll('#shopList .shop-item')];
  const row=rows.find(r=>r.textContent.includes('精研'));
  const b=row?.querySelector('button');
  if(!b || b.disabled) return 'no-button';
  b.click(); return 'ok';})()`);
const lvUp = await waitFor(`__frostfall.match.bookLevelBonus >= 1`, 6000);
const lvShown = await waitFor(`${lvTextExpr(1)} === 'Lv2'`, 5000);
const lvAfter = await js(lvTextExpr(1));
check('§132 买「精研技能书」→ 技能行那一格真的从 Lv1 变成 Lv2（以前买了什么都不发生）',
  upBookClicked === 'ok' && lvUp && lvShown && lvBefore === 'Lv1' && lvAfter === 'Lv2',
  `点击=${upBookClicked} · 加成=${await js(`__frostfall.match.bookLevelBonus`)} · 技能行 ${lvBefore} → ${lvAfter}`);
await click('#shopPanel [data-close]');
check('背包能打开', (await click('#btnBag')) === 'ok' && (await state()).bag);
await sleep(250);
// 背包此前是唯一没做版式体检的面板（§1.9.2 的热区检查漏了它）——§5.4 加了「穿上/强化/出售」之后补上
await checkLayout('背包打开时');
check('合成按钮与提示一致（没材料就禁用）', await js(`(()=>{const b=document.getElementById('btnCraft');
  const noMat=document.getElementById('craftHint').textContent.includes('攒够 3 件'); return b.disabled === noMat;})()`),
  `${await js(`document.getElementById('btnCraft').disabled ? '禁用' : '可点'`)} · ${await js(`document.getElementById('craftHint').textContent`)}`);
// 凑够 3 件同部位同品质 → 合成也要两步确认（不可逆操作，§5.4.1）
await js(`(()=>{const m=__frostfall.match;
  for(let i=0;i<3;i++) m.inventory.push({uid:'smoke'+i, slot:'weapon', quality:'white', ilvl:3, baseAttrs:{attack:5}, affixes:[]});
  return m.inventory.length;})()`);
await sleep(250);
check('凑够 3 件后合成按钮点亮', await js(`!document.getElementById('btnCraft').disabled`));
await click('#btnCraft');
await sleep(150);
check('合成要先确认（不可逆操作走两步）',
  (await js(`document.getElementById('btnCraft').textContent`)).includes('确认')
  && await js(`__frostfall.match.inventory.filter((i) => i.uid === 'smoke0').length === 1`),
  `按钮文案「${await js(`document.getElementById('btnCraft').textContent`)}」`);
await click('#btnCraft');
await sleep(250);
check('确认后才真的合成（3 件白武器 → 1 件蓝武器）',
  await js(`__frostfall.match.stats.crafts >= 1`)
  && await js(`__frostfall.match.inventory.filter((i) => i.uid === 'smoke0').length === 0`),
  `合成次数 ${await js(`__frostfall.match.stats.crafts`)}`);

// §5.4：每件装备的三个动作——穿上 / 强化（§4.4 无失败）/ 出售（不可逆，两步确认）
await js(`(()=>{const m=__frostfall.match;
  m.gold = 1000;
  m.inventory.push({uid:'smoke-e1', slot:'weapon', quality:'white', ilvl:1, baseAttrs:{attack:10}, affixes:[], plus:0, invested:0});
  m.inventory.push({uid:'smoke-e2', slot:'weapon', quality:'blue', ilvl:2, baseAttrs:{attack:20}, affixes:[], plus:0, invested:0});
  return true;})()`);
await sleep(250);
const equipClicked = await click('#invList .item[data-uid="smoke-e1"] button[data-act="equip"]');
await sleep(200);
check('背包：装备有「穿上 / 强化 / 出售」三个动作，且强化标着价钱',
  equipClicked === 'ok'
  && await js(`!!document.querySelector('#invList .item[data-uid="smoke-e2"] button[data-act="enhance"]')`)
  && await js(`document.querySelector('#invList .item[data-uid="smoke-e2"] button[data-act="enhance"]').textContent.includes('金')`),
  await js(`document.querySelector('#invList .item[data-uid="smoke-e2"] button[data-act="enhance"]').textContent`));
check('背包：点「穿上」真的换了武器，换下来的那件回背包',
  await js(`__frostfall.match.equipped.weapon?.uid === 'smoke-e1'`)
  && await js(`__frostfall.match.inventory.some((i) => i.uid === 'smoke-e2')`),
  `身上 ${await js(`__frostfall.match.equipped.weapon?.uid`)} · 背包 ${await js(`__frostfall.match.inventory.length`)} 件`);
const goldBeforeEnh = await js(`Math.round(__frostfall.match.gold)`);
const enhClicked = await click('#invList .item[data-uid="smoke-e2"] button[data-act="enhance"]');
await sleep(200);
check('背包：强化 +1 扣 60 金、无失败（§4.4 线性必成）',
  enhClicked === 'ok' && await js(`__frostfall.match.inventory.find((i) => i.uid === 'smoke-e2')?.plus === 1`)
  && await js(`Math.round(__frostfall.match.gold)`) === goldBeforeEnh - 60,
  `点击=${enhClicked} · 金币 ${goldBeforeEnh} → ${await js(`Math.round(__frostfall.match.gold)`)} · 界面「${await js(`document.querySelector('#invList .item[data-uid="smoke-e2"] button[data-act="enhance"]').textContent`)}」`);
const sellFirst = await click('#invList .item[data-uid="smoke-e2"] button[data-act="sell"]');
await sleep(200);
check('背包：出售装备要先确认（不可逆操作走两步）',
  sellFirst === 'ok'
  && (await js(`document.querySelector('#invList .item[data-uid="smoke-e2"] button[data-act="sell"]').textContent`)) === '确认出售'
  && await js(`__frostfall.match.inventory.some((i) => i.uid === 'smoke-e2')`),
  `按钮「${await js(`document.querySelector('#invList .item[data-uid="smoke-e2"] button[data-act="sell"]').textContent`)}」`);
const goldBeforeSell = await js(`Math.round(__frostfall.match.gold)`);
const sellSecond = await click('#invList .item[data-uid="smoke-e2"] button[data-act="sell"]');
await sleep(200);
check('确认后才真的卖掉（返还投入的 70%）',
  sellSecond === 'ok' && !(await js(`__frostfall.match.inventory.some((i) => i.uid === 'smoke-e2')`))
  && await js(`Math.round(__frostfall.match.gold)`) === goldBeforeSell + 42,   // 强化过 60 金 → 返还 42
  `金币 ${goldBeforeSell} → ${await js(`Math.round(__frostfall.match.gold)`)}`);
// 脏数据不该把背包（以及整个帧循环）带崩：塞一件品质/部位都不认识的装备进去
await js(`(()=>{const m=__frostfall.match;
  m.inventory.push({uid:'smoke-dirty', slot:'unknown-slot', quality:'legendary', ilvl:3, affixes:[]});
  m.equipped.weapon = {uid:'smoke-dirty2', slot:'unknown-slot', quality:'legendary', ilvl:3, affixes:[]};
  return m.inventory.length;})()`);
await sleep(250);
check('背包：装备带脏数据（未知品质/部位）也不能把界面弄崩',
  await js(`document.getElementById('invList').children.length >= 1
    && document.getElementById('equippedList').children.length >= 1
    && document.getElementById('invList').textContent.includes('legendary')`),   // 兜底会把原值打出来，而不是抛异常
  `${await js(`document.getElementById('invList').textContent.replace(/\\s+/g,' ').slice(0,40)`)}`);
await js(`(()=>{const m=__frostfall.match;
  m.inventory = m.inventory.filter((i) => i.uid !== 'smoke-dirty');
  m.equipped.weapon = null; return m.inventory.length;})()`);
await click('#bagPanel [data-close]');
const zoom0 = (await state()).zoom;
check('设置能打开', (await click('#btnSettings')) === 'ok' && (await state()).settings);
await sleep(250);
await checkLayout('设置打开时');
// §154：设置面板只摆**这个模式真的会读**的项。TD 里没有掉落物（自动拾取唯一读取方在 defense.js）、
// 也没有摇杆（主操作是点选建造）——以前这两项照样摆着，玩家切了什么都不会发生。
const tdSettings = await js(`({toggles: [...document.querySelectorAll('#setToggles button')].map((b) => b.textContent),
  rows: [...document.querySelectorAll('#settingsPanel .start-row')].filter((r) => !r.classList.contains('hidden')).map((r) => r.querySelector('.label')?.textContent ?? ''),
  stickRowHidden: document.getElementById('setStick').closest('.start-row').classList.contains('hidden')})`);
check('§154 TD 的设置面板不摆防守专用的项（自动拾取 / 摇杆）',
  !tdSettings.toggles.some((t) => t.startsWith('自动拾取')) && tdSettings.stickRowHidden
  && tdSettings.toggles.some((t) => t.startsWith('波次预告')) && tdSettings.toggles.some((t) => t.startsWith('TD 整图可见')),
  `开关=${tdSettings.toggles.join(' / ')} · 可见行=${tdSettings.rows.join(' / ')} · 摇杆行收起=${tdSettings.stickRowHidden}`);
// 特效档：低档要真的关掉飘字与脉冲（§10.1 低端机降级）
check('设置：特效切「低」后渲染选项真的降级',
  (await click('#setEffects button:nth-child(2)')) === 'ok'
  && await js(`__frostfall.view.render.showFloaters === false && __frostfall.view.render.showPulses === false`),
  `showFloaters=${await js(`__frostfall.view.render.showFloaters`)}`);
// §116：上面那条只断「选项对象」——而 `showPulses` 以前**根本没人读**（低特效下引导塔位照样闪）。
// 这里包一层 renderer.draw，看主循环真正交出去的实参，才算验到「降级生效」。
await js(`(()=>{const r=__frostfall.renderer; window.__origDraw=r.draw;
  r.draw=(v)=>{window.__lastDraw=v; return window.__origDraw(v);}; return true;})()`);
await sleep(300);
const lowDraw = await js(`({pulses: window.__lastDraw?.pulses, floaters: window.__lastDraw?.floaters?.length})`);
check('§116 低特效档：主循环真的把 pulses:false 交给渲染器（不只是选项对象里有个字段）',
  lowDraw.pulses === false && lowDraw.floaters === 0,
  `pulses=${lowDraw.pulses} · 飘字 ${lowDraw.floaters} 条`);
await js(`__frostfall.renderer.draw = window.__origDraw`);   // 还原，别让包装影响后面的截图与版式检查
check('设置：镜头档 / 特效档 / 开关都写进了存档',
  await js(`!!localStorage.getItem('frostfall:settings')
    && JSON.parse(localStorage.getItem('frostfall:settings')).effects === 'low'`));
// §10.7：内存告警来了要自动降级特效（微信那边是 wx.onMemoryWarning；这里用同一个出口模拟，不刷新页面）
await click('#setEffects button:nth-child(1)');   // 先切回「高」，再让告警把它打下来
await sleep(200);
const degraded = await js(`__frostfall.simulateMemoryWarning()`);
await sleep(250);
check('§10.7 内存告警：自动把特效切到「低」档并提示（不崩）',
  degraded?.from === 'high' && degraded?.to === 'low'
  && await js(`__frostfall.view.render.showFloaters === false && __frostfall.view.render.showPulses === false`)
  && await js(`JSON.parse(localStorage.getItem('frostfall:settings')).effects === 'low'`),
  `特效 ${degraded?.from} → ${degraded?.to} · ${await js(`document.getElementById('toast').textContent`)}`);
check('§10.7 内存告警之后界面照常（设置面板还开着、局还在）',
  await js(`!document.getElementById('settingsPanel').classList.contains('hidden') && !!__frostfall.match`));
// 波次预告开关：关掉之后「下一波」那格要说明原因，而不是留个空标签
const wavePreviewSel = await toggleSel('波次预告');
const waveToggle = await click(wavePreviewSel);
await sleep(200);   // 提示条由下一帧渲染
check('设置：关掉「波次预告」后下一波提示条换成说明文案',
  waveToggle === 'ok' && (await js(`document.getElementById('nextWaveLabel').textContent`)).includes('关闭'),
  await js(`document.getElementById('nextWaveLabel').textContent`));
await click(wavePreviewSel);   // 再打开，后面的截图保持默认观感
await sleep(150);
// §6.2：预告要写清下一波的护甲类型，玩家才能决定补哪种塔（克制博弈的前提）
const previewText = await js(`document.getElementById('nextWaveLabel').textContent`);
check('§6.2 下一波预告带护甲类型（开波前就能决定补哪种塔）',
  /（(无甲|轻甲|中甲|重甲|加强甲)/.test(previewText), `预告「${previewText}」`);
// TD 默认「整图可见」（相机取整图缩放的 0.725×），关掉它才轮到镜头档位接管
check('关掉「TD 整图可见」后镜头档位真的接管相机',
  (await click(await toggleSel('TD 整图可见'))) === 'ok' && (await click('#setZoom button')) === 'ok'
  && (await state()).zoom !== zoom0, `缩放 ${zoom0.toFixed(2)} → ${(await state()).zoom}`);
await click('#settingsPanel [data-close]');
// 放大到局部之后，拖动与滚轮才是可用的（§1.9 / §2.5）
const before = (await state()).probe;
const dragInfo = await dragBy(180, -90);
const after = (await state()).probe;
check('放大后单指拖空白处能平移地图', Math.abs(after.x - before.x - 180) < 14 && Math.abs(after.y - before.y + 90) < 14,
  `参考点 (${before.x | 0},${before.y | 0}) → (${after.x | 0},${after.y | 0})`
  + ` · 起点 (${dragInfo.x},${dragInfo.y}) 离最近塔位 ${dragInfo.dist?.toFixed(1)} 格`);
const zoomBeforeWheel = (await state()).zoom;
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 400, deltaX: 0, deltaY: -120 });
await sleep(120);
check('滚轮能缩放（桌面上的双指缩放）', (await state()).zoom > zoomBeforeWheel,
  `缩放 ${zoomBeforeWheel} → ${(await state()).zoom}`);

// 暂停 / 继续
check('暂停弹出遮罩', (await click('#btnPause')) === 'ok');
await sleep(250);
await checkLayout('暂停遮罩时');
await sleep(300);
check('暂停后遮罩出现（可继续）', (await state()).overlay);
await click('#btnResume');
await sleep(300);
check('继续收起遮罩', !(await state()).overlay);

// §1.8 速度按钮（1× → 2× → 3× → 1×）：以前冒烟从没点过它，改坏了也没人知道
const rateBefore = await js(`__frostfall.view.rate`);
const speedClick = await click('#btnSpeed');
await sleep(250);
const rateAfter = await js(`__frostfall.view.rate`);
check('速度按钮真的改了推进倍率，按钮文案跟着变',
  speedClick === 'ok' && rateAfter !== rateBefore
  && (await js(`document.getElementById('btnSpeed').textContent`)) === `${rateAfter}×`,
  `${rateBefore}× → ${rateAfter}× · 按钮「${await js(`document.getElementById('btnSpeed').textContent`)}」`);
await js(`__frostfall.view.rate = 1`);   // 调回正常档，别让后面的用例跑在加速上
await sleep(250);
check('速度能调回 1×（后面的用例按正常速度跑）',
  await js(`__frostfall.view.rate === 1 && document.getElementById('btnSpeed').textContent === '1×'`));

// HUD 的数值显示：冒烟一直断的是内核状态，从没断过「屏幕上那几个数字跟内核一致」。
// 改内核 → 等两帧 → 读 DOM，四处一起验（金币 / 核心 / 漏怪 / 英雄等级）
const hudSync = await js(`(async()=>{const m=__frostfall.match;
  m.gold += 137; m.core.hp = Math.max(1, m.core.hp - 100); m.stats.leaks += 3; m.hero.level += 1;
  m.lumber[0] += 7; m.hero.exp += 13;
  await new Promise((r)=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const t=(id)=>document.getElementById(id).textContent.trim();
  return {gold:t('goldLabel'), core:t('coreLabel'), leaks:t('leakLabel'), hero:t('heroLevel'),
    lumber:t('lumberLabel'), exp:t('heroExpLabel'), wave:t('waveLabel'), phase:t('phaseLabel'),
    want:{gold:String(Math.round(m.gold)), core:String(Math.round(m.core.hp)) + ' / ' + m.core.maxHp,
      leaks:'漏怪 ' + m.stats.leaks, hero:'Lv' + m.hero.level,
      lumber:String(m.lumber[0]), exp:'EXP ' + Math.round(m.hero.exp),
      wave:'第 ' + m.wave.index + ' / ' + (m.waves?.length ?? 12) + ' 波'}};})()`);
check('HUD 的数字跟着内核走（金币 / 核心 / 漏怪 / 等级 / 木材 / 经验 / 波次）',
  hudSync.gold === hudSync.want.gold && hudSync.core === hudSync.want.core
  && hudSync.leaks === hudSync.want.leaks && hudSync.hero === hudSync.want.hero
  && hudSync.lumber === hudSync.want.lumber && hudSync.exp === hudSync.want.exp
  && hudSync.wave === hudSync.want.wave && hudSync.phase.length > 0,
  `金币「${hudSync.gold}」/「${hudSync.want.gold}」· 核心「${hudSync.core}」/「${hudSync.want.core}」`
  + ` · 漏怪「${hudSync.leaks}」/「${hudSync.want.leaks}」· 等级「${hudSync.hero}」/「${hudSync.want.hero}」`
  + ` · 木材「${hudSync.lumber}」/「${hudSync.want.lumber}」· 经验「${hudSync.exp}」/「${hudSync.want.exp}」`
  + ` · 波次「${hudSync.wave}」/「${hudSync.want.wave}」`);

// 跑一会儿，确认波次真的在推进
await sleep(4000);
const fin = await state();
check('TD 的波次在推进（游戏真的在跑）', fin.wave >= 1, `第 ${fin.wave} 波 · 金币 ${fin.gold}`);

// §3.7 低血提示：血条要转红（小地图那边是同一条规则，见 render 用例）
await js(`__frostfall.match.hero.hp = __frostfall.match.hero.def.hp * 0.1`);
await sleep(250);
check('低血提示：生命 < 20% 时血条转红',
  await js(`document.getElementById('heroHpBar').classList.contains('low')`));
await js(`__frostfall.match.hero.hp = __frostfall.match.hero.def.hp`);
await sleep(250);
check('低血提示：回满血之后红色撤掉',
  await js(`!document.getElementById('heroHpBar').classList.contains('low')`));

// §10.7 的压测口径：同屏 120 单位（设计峰值是 34，120 是压力值）
const injected = await js(`(()=>{const m=__frostfall.match;
  if(!m.monsters.length) return 0;
  const proto=m.monsters[0], paths=m.map.paths;
  for(let i=m.monsters.length;i<120;i++){const p=paths[i%paths.length];
    m.monsters.push({...proto, uid:90000+i, pathIndex:i%paths.length, dist:(i*137)%4000,
      hp:1e9, maxHp:1e9, dead:false, cooldown:0, effects:[], cell:{...p.spawn}});}
  return m.monsters.length;})()`);
check('§10.7 压测：同屏 120 单位灌得进去', injected >= 120, `场上 ${injected} 只`);
const frame = await js(`new Promise(res=>{const d=[];let last=performance.now();const t0=last;
  function tick(now){d.push(now-last);last=now;
    if(now-t0<2000) requestAnimationFrame(tick);
    else{d.sort((a,b)=>a-b);res({frames:d.length,avg:(now-t0)/d.length,p95:d[Math.floor(d.length*0.95)],max:d[d.length-1]});}}
  requestAnimationFrame(tick);})`);
check('§10.7 压测：120 单位下平均帧时间 ≤40ms（25fps 下限；本机口径，低端机待真机）', frame.avg <= 40,
  `${frame.frames} 帧 · 平均 ${frame.avg.toFixed(1)}ms · p95 ${frame.p95.toFixed(1)}ms · 最差 ${frame.max.toFixed(1)}ms`);
await js(`(()=>{const m=__frostfall.match; m.monsters = m.monsters.filter((x) => x.uid < 90000); return m.monsters.length;})()`);
const shotTd = await screenshot('ff-smoke-td.png');

/* ---------- 上一局的浮层不许跟到新局（页面级 UI 单例的粘性状态，§94 同源） ---------- */

// §141：`?sim=` 是**给玩家占便宜**的钩子（让 AI 先把前几分钟打完再交给自己），所以按 §126 的规矩
// 默认关——要显式带 `?debug=1` 才生效。这里两个方向都断。
await send('Page.navigate', { url: lobbyUrl('?mode=td&map=map_01&sim=180&skipstart=1&notutorial=1') });
await sleep(1500);
check('§141 不带 ?debug 时 `?sim=` 不生效（快进钩子默认关）',
  (await js(`+__frostfall.match.time.toFixed(1)`)) < 10,
  `对局时间 ${await js(`+__frostfall.match.time.toFixed(1)`)} 秒（带 sim=180）`);
await send('Page.navigate', { url: lobbyUrl('?mode=td&map=map_01&sim=180&debug=1&skipstart=1&notutorial=1') });
await sleep(2500);
check('§141 带上 ?debug=1 之后 `?sim=180` 照常快进（冒烟与截图要用）',
  (await js(`+__frostfall.match.time.toFixed(1)`)) > 170,
  `对局时间 ${await js(`+__frostfall.match.time.toFixed(1)`)} 秒`);

// 用一局「快进 + 默认相机」的干净页面来做：AI 已经造了几座塔，点它们就能开面板
// （直接在当前这页造塔会撞上「相机被前面几节改过、可点塔位为 0」的问题——先踩过一次）
await js(`(()=>{const s=JSON.parse(localStorage.getItem('frostfall:settings') ?? '{}');
  s.tdFitAll=true; localStorage.setItem('frostfall:settings', JSON.stringify(s)); return true;})()`);
// skipstart=1：这一页不进大厅（否则 `view.inLobby` 会让结算面板按设计不弹）
await send('Page.navigate', { url: lobbyUrl('?mode=td&map=map_01&sim=180&debug=1&skipstart=1&notutorial=1') });
await sleep(2500);
await waitFor(`__frostfall.match.towers.length > 0`, 6000);
// 直接调 UI 的开面板入口：这一条要验的是「面板会不会跨局留下」，不是「点得到点不到那座塔」
// （点法在 TD 那节的「点已有的塔弹出塔面板」里已经验过了；这里再依赖一次点击，
//   只会把相机/缩放这些无关变量拖进来——已经为此浪费了两轮冒烟）
const openedPanel = await js(`(()=>{const m=__frostfall.match, t=m.towers[0];
  if(!t) return false;
  __frostfall.ui.openTower(m, t.slot, __frostfall.renderer.toScreen(t.cell.x, t.cell.y));
  return true;})()`);
await sleep(250);
check('前置：塔面板正开着（准备验它不会跨局留在屏幕上）',
  openedPanel && await js(`!document.getElementById('towerPanel').classList.contains('hidden')`),
  `场上 ${await js(`__frostfall.match.towers.length`)} 座塔`);
// 面板上的关闭按钮（X）——冒烟从没点过它：关不掉的话玩家只能靠点别处
const closeTwClick = await click('#btnCloseTw');
await sleep(200);
check('塔面板的关闭按钮能收起面板',
  closeTwClick === 'ok' && await js(`document.getElementById('towerPanel').classList.contains('hidden')`),
  `点击=${closeTwClick}`);
await js(`(()=>{const m=__frostfall.match, t=m.towers[0];
  __frostfall.ui.openTower(m, t.slot, __frostfall.renderer.toScreen(t.cell.x, t.cell.y)); return true;})()`);
await sleep(200);
await js(`__frostfall.match.result = 'lose'`);   // 直接判负，等价于「核心被摧毁」那一瞬间
await sleep(500);
check('前置：这一局的结算面板已弹出（同一页面，没刷新）',
  await js(`!document.getElementById('overlay').classList.contains('hidden')`));
// 「再开一局」这条路径（restart）也走「先收浮层」的修法，但它和「回大厅」不是同一段代码
const restartClick = await click('#btnRestart');
await sleep(700);
check('结算面板的「再开一局」：新局是干净的，且上一局的浮层都收起了',
  restartClick === 'ok' && await js(`!__frostfall.match.result && __frostfall.match.time < 5
    && __frostfall.match.towers.length === 0
    && document.getElementById('towerPanel').classList.contains('hidden')
    && document.getElementById('wheel').classList.contains('hidden')
    && document.getElementById('overlay').classList.contains('hidden')`),
  `点击=${restartClick} · 时间 ${await js(`Math.round(__frostfall.match.time)`)}s · 塔 ${
    await js(`__frostfall.match.towers.length`)} · 塔面板 hidden=${
    await js(`document.getElementById('towerPanel').classList.contains('hidden')`)}`);
// 再把浮层开起来判负一次，验「回大厅」那条路径。这一局是刚开的（场上没有塔，AI 也不会替我造），
// 所以开**建造轮盘**——它同样是「页面级浮层」，同样归 closeWheel 管
await js(`(()=>{const m=__frostfall.match; const s=m.map.slots[0];
  __frostfall.ui.openWheel(m, 0, __frostfall.renderer.toScreen(s.x, s.y));
  m.result = 'lose'; return true;})()`);
await sleep(500);
check('前置：第二次结算面板也弹出来了，且轮盘正开着（接着验「回大厅」）',
  await js(`!document.getElementById('overlay').classList.contains('hidden')
    && !document.getElementById('wheel').classList.contains('hidden')`),
  `轮盘 hidden=${await js(`document.getElementById('wheel').classList.contains('hidden')`)}`);
check('结算：点「回大厅」', (await click('#btnLobby')) === 'ok');
await sleep(700);
check('回大厅后塔面板/建造轮盘都已收起（不会带到下一局的界面上）',
  await js(`document.getElementById('towerPanel').classList.contains('hidden')
    && document.getElementById('wheel').classList.contains('hidden')`),
  `塔面板 hidden=${await js(`document.getElementById('towerPanel').classList.contains('hidden')`)}`
  + ` · 轮盘 hidden=${await js(`document.getElementById('wheel').classList.contains('hidden')`)}`);
check('回大厅后的新局里没有上一局的残留选中态（selectedSlot / selectedTower 归零）',
  await js(`__frostfall.view.selectedSlot === null && __frostfall.view.selectedTower === null
    && document.getElementById('towerPanel').classList.contains('hidden')`),
  `selectedSlot=${await js(`String(__frostfall.view.selectedSlot)`)} · selectedTower=${
    await js(`String(__frostfall.view.selectedTower)`)}`);

/* ---------- §2.1「上次配置一键开局」：换一套配置开局，回大厅要沿用 ---------- */

await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await sleep(1500);
await js(`localStorage.removeItem('frostfall:profile')`);   // 从干净档案开始
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await sleep(1500);
// 大厅里改成「困难 + 圣徒」（点按钮而不是改 URL，走玩家真会走的路径）。
// 注意保持 TD 模式：后面「回访」那一节默认存档是 TD 局（防守局没有 towers 字段）
await click('#optDiff button:nth-child(2)');
await sleep(150);
await js(`(()=>{const bs=[...document.querySelectorAll('#optHero .hero-card')];bs[3]?.click();return true;})()`);
await sleep(150);
const pickedBefore = await js(`(()=>{const on=(sel)=>document.querySelector(sel+' button.on')?.textContent ?? null;
  return {mode:on('#optMode'), diff:on('#optDiff'), hero:document.querySelector('#optHero .hero-card.on')?.textContent?.slice(0,4) ?? null};})()`);
await click('#btnSolo');
await sleep(800);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });   // 回大厅（刷新）
await sleep(1800);
const pickedAfter = await js(`(()=>{const on=(sel)=>document.querySelector(sel+' button.on')?.textContent ?? null;
  return {mode:on('#optMode'), diff:on('#optDiff'), hero:document.querySelector('#optHero .hero-card.on')?.textContent?.slice(0,4) ?? null,
    saved:JSON.parse(localStorage.getItem('frostfall:profile') ?? '{}').lastChoice ?? null};})()`);
check('§2.1 上次配置一键开局：刷新回大厅后沿用上次选的难度/英雄',
  pickedAfter.diff === pickedBefore.diff && pickedAfter.hero === pickedBefore.hero
  && pickedAfter.saved?.difficulty === 'hard' && pickedAfter.saved?.hero === 'hero_paladin',
  `开局前 ${JSON.stringify(pickedBefore)} → 刷新后 ${JSON.stringify(pickedAfter)}`);

/* ---------- 回访：继续上局 / 新手引导 / 设置里那两个动作按钮 ---------- */



await sleep(5500);                       // 等一次自动存档（每 5 秒一次）
const savedSnap = await state();
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await sleep(2000);
check('回访：有存档时大厅多出「继续上局」', await js(`!!document.getElementById('btnResumeSave')`));
check('回访：点「继续上局」回到那一局（不是新开一局）', (await click('#btnResumeSave')) === 'ok');
await sleep(600);
const resumed = await state();
check('回访：读回来的局与存档一致（塔数相同、波次±1、金币接近）',
  resumed.towers === savedSnap.towers && Math.abs(resumed.wave - savedSnap.wave) <= 1
  && Math.abs(resumed.gold - savedSnap.gold) <= 150,
  `存档时 塔${savedSnap.towers}/第${savedSnap.wave}波/金${savedSnap.gold} → 读回 塔${resumed.towers}/第${resumed.wave}波/金${resumed.gold}`);

// §139：存档**版本对不上**（模拟以后 `SAVE_VERSION` 升级）时，大厅不该再弹「继续上局」——
// 点下去只能开一局新的（`loadFromStorage()` 会返回 null），等于骗人。口径：**能读的才算有**。
// 注意：**先把这一局标成「联机镜像」**——`saveToStorage()` 有一条「联机镜像不进本地存档」的守卫，
// 于是离开这一页时 `pagehide` 的自动存档会变成 no-op，不会覆盖我们刚注入的旧存档。
// （原来这里标的是 `result='win'`：那要靠「导航比帧循环快」才不出事——本轮就翻车过一次，
//   帧循环抢先跑了 `maybeRecordResult()`，它顺手 `clearSave()`，把注入的存档删了。）
await js(`(()=>{__frostfall.match.online = true;
  const raw = JSON.parse(localStorage.getItem('frostfall:save')); raw.v = 999;
  localStorage.setItem('frostfall:save', JSON.stringify(raw)); return true;})()`);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await sleep(1500);
check('§139 存档版本对不上时大厅不弹「继续上局」（点了也只能开新局，等于骗人）',
  !(await js(`!!document.getElementById('btnResumeSave')`)),
  `存档 v=${await js(`JSON.parse(localStorage.getItem('frostfall:save') ?? '{}').v`)} · 按钮=${await js(`!!document.getElementById('btnResumeSave')`)}`);

// §204：§139 只堵住了「版本号」那一半——**版本号对、内容读不出来**的存档（改版后地图 id 变了、
// 字段缺了、存档半截）照样弹「继续上局」，点下去 `loadFromStorage()` 返回 null、只能开一局新的。
// 这里把版本号改回 1、只把地图 id 改坏：按钮必须**不出现**。
// 同样先把这局标成「联机镜像」（理由见上面 §139 那段）
await js(`(()=>{__frostfall.match.online = true;
  const raw = JSON.parse(localStorage.getItem('frostfall:save'));
  raw.v = 1; raw.mapId = 'map_99';                       // 版本对、内容读不出来
  localStorage.setItem('frostfall:save', JSON.stringify(raw)); return true;})()`);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await sleep(1500);
// 断言里带上**前置条件**（注入的坏存档真的还在、版本号真的是 1）：否则「存档被别处删了」
// 也会让这条检查通过——那是个假绿（本轮就遇上过一次：`v=undefined · mapId=undefined · 按钮=false`）
const badSave = await js(`(()=>{const s=JSON.parse(localStorage.getItem('frostfall:save') ?? 'null');
  return JSON.stringify({v:s?.v ?? null, mapId:s?.mapId ?? null,
    btn:!!document.getElementById('btnResumeSave')});})()`);
const bs = JSON.parse(badSave);
check('§204 存档版本对但**内容**读不出来时也不弹「继续上局」（§139 漏掉的那一半）',
  bs.v === 1 && bs.mapId === 'map_99' && bs.btn === false,
  `存档 v=${bs.v} · mapId=${bs.mapId} · 按钮=${bs.btn}`);
await js(`localStorage.removeItem('frostfall:save')`);   // 收干净，别影响后面的用例

// §205：**档案形状坏了也不许把大厅弄死**。档案和存档一样是「跨界数据」（localStorage 里、
// 玩家能改、跨版本留着）。实测修之前：`clears: null` → 模块顶层 TypeError，页面只剩 static HTML、
// 按钮全没接线（§177 那个形状）。这里注入一份坏档案，重载后大厅必须**活着且零异常**。
await js(`localStorage.setItem('frostfall:profile', JSON.stringify({v:1, reputation:'abc', clears:null,
  ledger:'x', lastChoice:42, playCount:'y'}))`);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await sleep(1200);
const brokenProfile = await js(`JSON.stringify({alive:!!window.__frostfall,
  lobby:!document.getElementById('startScreen').classList.contains('hidden'),
  bar:document.getElementById('profileBar').textContent,
  canStart:!!document.getElementById('btnSolo').onclick})`);
const bp = JSON.parse(brokenProfile);
check('§205 档案形状坏了（clears=null / ledger 不是数组…）大厅照样起来、按钮照样接线',
  bp.alive === true && bp.lobby === true && bp.canStart === true && /人物 Lv1/.test(bp.bar),
  `页面活着=${bp.alive} · 大厅=${bp.lobby} · 档案条「${bp.bar}」· 开始按钮已接线=${bp.canStart}`);
await js(`localStorage.removeItem('frostfall:profile')`);   // 收干净

// 新手引导：清掉档案 = 首次进入
await js(`localStorage.removeItem('frostfall:profile')`);
await send('Page.navigate', { url: lobbyUrl() });
await sleep(2000);
await click('#optMode button:nth-child(1)');   // §2.1：显式选回 TD（引导只在 TD 挂）
await sleep(150);
await click('#btnSolo');                 // 引导叠在局内，大厅里本来就不显示
await sleep(600);
check('回访：首次开局自动开新手引导（提示条 + 引导状态）',
  await js(`!document.getElementById('tutorialBar').classList.contains('hidden')
    && !!__frostfall.view.tutorial && document.getElementById('tutorialText').textContent.length > 0`),
  await js(`document.getElementById('tutorialText').textContent`));
await checkLayout('新手引导条');
check('回访：点「跳过」后提示条收起并记档',
  (await click('#btnTutorialSkip')) === 'ok');
await sleep(400);
check('回访：跳过记进档案（下次不再弹）',
  await js(`document.getElementById('tutorialBar').classList.contains('hidden')
    && JSON.parse(localStorage.getItem('frostfall:profile') ?? '{}').tutorialDone === true`));

// 设置里的两个动作按钮：重看引导 / 恢复默认
await click('#btnSettings');
await sleep(250);
await click('#btnReplayTutorial');
await sleep(200);
// 这一条只是中间态（真正的检验是下面 §153 ①：「下一局要真的再出现」）——原来只查中间态，
// 所以按钮承诺的那件事一直没被验过（§153）。
check('回访：设置里「重看新手引导」清掉已看标记',
  await js(`JSON.parse(localStorage.getItem('frostfall:profile') ?? '{}').tutorialDone === false`),
  await js(`document.getElementById('toast').textContent`));

await click('#btnResetSettings');
await sleep(200);
check('回访：「恢复默认」把设置清回默认（存档里的设置键被删掉）',
  await js(`localStorage.getItem('frostfall:settings') === null`),
  await js(`document.getElementById('toast').textContent`));
await click('#settingsPanel [data-close]');

/* ---------- §153 新手引导的门槛：三个状态各量一次（以前只看中间态，三条都绿着但行为是坏的） ---------- */

// 这一节的几个状态都要**真的开一局**看提示条，而不是读 localStorage 里那个标记——
// 老冒烟查的就是「tutorialDone 被置成 false 了吗」，所以「重看」按钮承诺的那件事一直没被验过。
// 放在「恢复默认」之后：这一段会连续换页，别把上一节还开着的设置面板甩掉。
// 走**大厅**这条真实路径（点「单人开局」进局），不走 `?skipstart=1`：后者会让 `setupStartScreen()`
// 提前 return，提示条上那颗「跳过」的 onclick 根本没接上（第一版探针就踩了这个坑，见 §153.3）。
const tutorialViaLobby = async (query) => {
  await send('Page.navigate', { url: lobbyUrl(query) });
  await send('Page.bringToFront');
  await waitFor(`!!window.__frostfall && !document.getElementById('startScreen').classList.contains('hidden')`, 10000);
  await sleep(300);
  await click('#btnSolo');
  await sleep(700);
  return js(`({bar: !document.getElementById('tutorialBar').classList.contains('hidden'),
    tut: !!__frostfall.view.tutorial, mode: __frostfall.match.mode ?? 'td',
    text: document.getElementById('tutorialText').textContent})`);
};

// ① 点了「重看」→ 下一次开局要真的再挂一次（这是那颗按钮上写的话）
const replayBack = await tutorialViaLobby('?mode=td&map=map_01');
check('§153 点过「重看新手引导」之后，下一局真的又出现（以前那颗按钮对打完过一局的玩家无效）',
  replayBack.bar && replayBack.tut && replayBack.text.length > 0,
  `提示条=${replayBack.bar} · tutorial=${replayBack.tut} · 文案「${replayBack.text}」`);

// ①b「看一遍」不能变成「以后每局都挂」。收尾那一段挂在帧循环的「波次变化」上——它的判据曾经是
// `tutorial.done && !profile.tutorialDone`，在「重看」这条路上曾经会让收尾整段不执行
// （那只发生在「重看 = 抹掉 tutorialDone 之外的另一种记法」的中间版本里，§153.2 记了这段弯路）。
// 这里按引导自己的事件接口（四个公开方法）把它推到「完成」，再点一次「提前开波」让波次动起来
// （收尾那段的触发条件），最后开下一局看还在不在。
// 四步的推进条件各不一样（读 tutorial.js）：建第一座 → **开波** → 放技能 → 清掉这一波。
// 第一版按「建 3 座 → 技能 → 开波 → 清波」喂，`done` 还是 false——两个 no-op 悄悄吃掉了事件。
const tutDone = await js(`(()=>{const t=__frostfall.view.tutorial; if(!t) return 'no-tutorial';
  t.onTowerBuilt(10);
  t.onWaveStarted(1, 20);
  t.onSkillCast();
  t.onWaveCleared(1, 40);
  return t.done;})()`);
await click('#btnEarly');
await sleep(700);
const tutAfter = await js(`({tut: !!__frostfall.view.tutorial,
  bar: !document.getElementById('tutorialBar').classList.contains('hidden'),
  mark: JSON.parse(localStorage.getItem('frostfall:profile') ?? '{}').tutorialDone})`);
check('§153 重看的引导**完成**后就地收尾（面板收起 + 重新记上「已看过」）',
  tutDone === true && !tutAfter.tut && !tutAfter.bar && tutAfter.mark === true,
  `喂事件后 done=${tutDone} · 收尾后 tutorial=${tutAfter.tut} · 提示条=${tutAfter.bar} · 已看过标记=${tutAfter.mark}`);
const replayOnce = await tutorialViaLobby('?mode=td&map=map_01');
check('§153 重看并完成过一次之后，下一局不再挂（别变成「以后每局都挂」）',
  !replayOnce.bar && !replayOnce.tut,
  `提示条=${replayOnce.bar} · tutorial=${replayOnce.tut}`);

// ② 「打完一局但没做过引导」（新手第一局打的是防守就是这个状态）→ 打 TD 还要出现
await js(`(()=>{const p=JSON.parse(localStorage.getItem('frostfall:profile') ?? '{}');
  p.playCount = 1; p.tutorialDone = false;
  localStorage.setItem('frostfall:profile', JSON.stringify(p)); return true;})()`);
const afterOneGame = await tutorialViaLobby('?mode=td&map=map_01');
check('§153 打完一局（playCount=1）但没做过引导 → 打 TD 仍要挂引导（以前 playCount 一涨就再也不出现）',
  afterOneGame.bar && afterOneGame.tut,
  `提示条=${afterOneGame.bar} · tutorial=${afterOneGame.tut} · 文案「${afterOneGame.text}」`);

// ③ 引导只在 TD 挂：全新档案直接开防守 → 不许出现（四步全是塔防的，防守里一步都推不动）
await js(`localStorage.removeItem('frostfall:profile')`);
const firstRunDefense = await tutorialViaLobby('?mode=defense&map=def_01');
check('§153 新手第一局打防守时**不挂**引导（引导只在 TD 挂）',
  firstRunDefense.mode === 'defense' && !firstRunDefense.bar && !firstRunDefense.tut,
  `模式=${firstRunDefense.mode} · 提示条=${firstRunDefense.bar} · tutorial=${firstRunDefense.tut}`);

/* ---------- 防守模式：换一个模式，同一套真实操作再走一遍 ---------- */

const defenseUrl = new URL(url);
defenseUrl.searchParams.set('mode', 'defense');
await send('Page.navigate', { url: defenseUrl.toString() });
await sleep(2200);

check('防守：大厅切到防守模式（地图换成 def_01）',
  (await js(`document.querySelector('#optMode button.on')?.textContent ?? ''`)).includes('防守')
  && (await js(`document.querySelector('#optMap button.on')?.textContent ?? ''`)).includes('边陲'),
  `模式=${await js(`document.querySelector('#optMode button.on')?.textContent ?? '（无选中）'`)}`
  + ` · 地图=${await js(`document.querySelector('#optMap button.on')?.textContent ?? '（无选中）'`)}`);
await click('#btnSolo');
await sleep(500);
check('防守：HUD 换成轮次/城堡，TD 的波次条收起',
  await js(`!document.getElementById('defensePanel').classList.contains('hidden')
    && document.querySelector('.wave-panel').classList.contains('hidden')`));
await checkLayout('防守开局');
await checkErgonomics('防守开局');   // §14.3 稿 5：防守的 2 技能键也该在右下拇指弧里

// §154：反过来那一半——防守里要摆「自动拾取」与「摇杆」，不摆 TD 专用的「波次预告 / TD 整图可见」
await click('#btnSettings');
await sleep(250);
const defSettings = await js(`({toggles: [...document.querySelectorAll('#setToggles button')].map((b) => b.textContent),
  stickRowHidden: document.getElementById('setStick').closest('.start-row').classList.contains('hidden'),
  stickOpts: [...document.querySelectorAll('#setStick button')].map((b) => b.textContent)})`);
check('§154 防守的设置面板不摆 TD 专用的项，但摇杆/自动拾取要在',
  !defSettings.toggles.some((t) => t.startsWith('波次预告') || t.startsWith('TD 整图可见'))
  && defSettings.toggles.some((t) => t.startsWith('自动拾取')) && !defSettings.stickRowHidden
  && defSettings.stickOpts.length === 2,
  `开关=${defSettings.toggles.join(' / ')} · 摇杆行收起=${defSettings.stickRowHidden} · 摇杆选项=${defSettings.stickOpts.join('/')}`);
await click('#settingsPanel [data-close]');
await sleep(150);

// 点空工事位 → 工事轮盘 → 建箭塔
const goldBeforeFort = await js(`Math.round(__frostfall.match.gold)`);
await clickCell(await fortPoint());
check('防守：点空工事位弹出工事轮盘', (await js(`!document.getElementById('wheel').classList.contains('hidden')`)));
check('防守：轮盘里建起工事并扣钱',
  (await click('#wheel button')) === 'ok' && await js(`__frostfall.match.forts.length === 1`)
  && await js(`Math.round(__frostfall.match.gold)`) < goldBeforeFort,
  `金币 ${goldBeforeFort} → ${await js(`Math.round(__frostfall.match.gold)`)} · ${await js(`document.getElementById('toast').textContent`)}`);
// 工事轮盘里的第二个选项（围墙）以前从没在浏览器里点过：墙要**进阻挡集合**才算真建起来
const wallSpot = await js(`(()=>{const m=__frostfall.match;
  const i=m.def.fortSlots.findIndex((s,idx)=>!m.forts.some((f)=>f.slot===idx));
  if(i<0) return -1;
  const s=m.def.fortSlots[i], p=__frostfall.renderer.toScreen(s.x,s.y);
  return {i, x:Math.round(p.x), y:Math.round(p.y)};})()`);
await clickCell({ x: wallSpot.x, y: wallSpot.y });
await sleep(250);
const wallBuilt = await js(`(()=>{const bs=[...document.querySelectorAll('#wheel button')];
  const b=bs.find(x=>x.textContent.includes('围墙')); if(!b) return 'no-button'; b.click(); return 'ok';})()`);
await sleep(300);
check('防守：工事轮盘里能建围墙，且围墙真的进了阻挡集合（§12.5 围墙可被拆 / 要挡路）',
  wallBuilt === 'ok' && await js(`__frostfall.match.forts.some((f)=>f.fortId==='fort_wall')`)
  && await js(`(()=>{const m=__frostfall.match; const f=m.forts.find(x=>x.fortId==='fort_wall');
    return !!f && m.isBlocked(f.cell.x, f.cell.y);})()`),
  `点轮盘=${wallBuilt} · 工事 ${await js(`__frostfall.match.forts.length`)} 座 · toast「${await js(`document.getElementById('toast').textContent`)}」`);

// 点地面 → 英雄走过去（A* 绕墙）
const moveTarget = await js(`(()=>{const m=__frostfall.match, r=__frostfall.renderer;
  const box=document.getElementById('game').getBoundingClientRect(); const h=m.hero.cell;
  for(let d=14;d>=4;d--) for(const [dx,dy] of [[d,0],[-d,0],[0,d],[0,-d],[d,d],[-d,-d],[d,-d],[-d,d]]){
    const x=h.x+dx, y=h.y+dy;
    if(x<1||y<1||x>=m.grid.w-1||y>=m.grid.h-1) continue;
    if(m.isBlocked(x,y)) continue;
    const s=r.toScreen(x,y);
    if(s.x<box.left+40||s.x>box.right-40||s.y<box.top+40||s.y>box.bottom-40) continue;
    if(document.elementFromPoint(s.x,s.y)?.id!=='game') continue;
    return {x:Math.round(s.x),y:Math.round(s.y),cell:{x,y}};
  }
  return null;})()`);
const heroBefore = await js(`({...__frostfall.match.hero.cell})`);
await clickCell(moveTarget);
check('防守：点地面后英雄拿到行进路径',
  await js(`__frostfall.match.hero.path.length > 0`) && !!(await js(`__frostfall.match.hero.goal`)),
  `(${heroBefore.x},${heroBefore.y}) → (${moveTarget.cell.x},${moveTarget.cell.y})`);
await sleep(1200);
check('防守：英雄真的在移动', await js(`__frostfall.match.hero.cell.x !== ${heroBefore.x} || __frostfall.match.hero.cell.y !== ${heroBefore.y}`));

/* ---------- §1.9.1 / §10.1：防守的虚拟摇杆（与点地移动共存，下发同一条移动指令） ---------- */

// 摇杆在左下（§14.3 稿 5「左下固定摇杆 + 右下 2 技能键」），尺寸按 §1.9.2 量。
const stickGeom = async () => js(`(()=>{const b=document.getElementById('stickBase').getBoundingClientRect();
  const k=document.getElementById('stickKnob').getBoundingClientRect();
  const box=document.getElementById('game').getBoundingClientRect();
  return { hidden:document.getElementById('stickBase').classList.contains('hidden'), w:Math.round(b.width), h:Math.round(b.height),
    cx:Math.round(b.left+b.width/2), cy:Math.round(b.top+b.height/2),
    fromBottom:Math.round(box.bottom-b.bottom), fromLeft:Math.round(b.left-box.left),
    shift:Math.round(Math.hypot((k.left+k.width/2)-(b.left+b.width/2),(k.top+k.height/2)-(b.top+b.height/2))),
    viewport:{ w:Math.round(box.width), h:Math.round(box.height) } };})()`);
const geo = await stickGeom();
check('§1.9.1 防守有摇杆且底座在左下（TD 没有；底座落在 §1.9.2 的拇指弧与左下 45% 有效区内）',
  !geo.hidden && geo.cx < geo.viewport.w * 0.45 && geo.cy > geo.viewport.h * 0.45
  && geo.fromBottom >= 60 && geo.fromBottom <= 200 && geo.fromLeft <= 120 && geo.w >= 120,
  `${geo.w}×${geo.h}px · 中心 (${geo.cx},${geo.cy}) · 距底 ${geo.fromBottom}pt · 距左 ${geo.fromLeft}pt`);

/** 按住并拖动（不松手，方便中途读摇杆状态）。 */
const holdDrag = async (from, to, steps = 4) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(60);
  for (let i = 1; i <= steps; i += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from.x + ((to.x - from.x) * i) / steps),
      y: Math.round(from.y + ((to.y - from.y) * i) / steps),
      button: 'none', buttons: 1,
    });
    await sleep(50);
  }
};
const releaseMouse = async (at) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(120);
};

// 先把上一段「点地移动」的行进目标清干净：不然英雄"还在走"会被误判成摇杆推动的结果
// （第一版就是这么绿的：把推摇杆那段代码整个短路掉，检查照样过——绿色不代表验到了）
await waitFor(`!__frostfall.match.hero.dead`);
await js(`__frostfall.match.hero.path = []; __frostfall.match.hero.goal = null;`);
await sleep(150);
const heroBeforeStick = await js(`({...__frostfall.match.hero.cell})`);
// 挑一个走得通的方位推（贴着墙推会被正确地拒绝，那样这条检查就变成在测边界而不是测摇杆）
const pushDir = await js(`(()=>{const m=__frostfall.match,h=m.hero.cell;
  for(const o of [{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1}]){
    const g={x:h.x+o.x*3,y:h.y+o.y*3};
    if(g.x<1||g.y<1||g.x>=m.grid.w-1||g.y>=m.grid.h-1) continue;
    if(m.isBlocked(g.x,g.y)) continue;
    return o;
  } return null;})()`);
// 推 200px：位移该被夹在 60-72pt（§1.9.2）
await holdDrag({ x: geo.cx, y: geo.cy }, { x: geo.cx + pushDir.x * 200, y: geo.cy + pushDir.y * 200 });
const stickState = await js(`__frostfall.stick.state()`);
const geoDrag = await stickGeom();
const heroStickMoving = await js(`({ moving: !!__frostfall.match.hero.moving, goal: __frostfall.match.hero.goal })`);
await sleep(900);
const heroAfterStick = await js(`({...__frostfall.match.hero.cell})`);
check('§1.9.2 摇杆被推满时位移夹在 60-72pt、方向就是推的那个方位',
  stickState.active && stickState.mag > 0.9
  && Math.abs(stickState.dir.x - pushDir.x) < 0.1 && Math.abs(stickState.dir.y - pushDir.y) < 0.1
  && geoDrag.shift >= 60 && geoDrag.shift <= 72,
  `推 (${pushDir.x},${pushDir.y}) · 位移 ${geoDrag.shift}pt · dir=(${stickState.dir.x},${stickState.dir.y}) mag=${stickState.mag}`);
const ddx = heroAfterStick.x - heroBeforeStick.x;
const ddy = heroAfterStick.y - heroBeforeStick.y;
const wentAxis = (d, want) => (want > 0 ? d > 0 : want < 0 ? d < 0 : d === 0);
check('§10.1 摇杆推着走 = 英雄真的在移动（走的是和点地移动同一条移动指令）',
  heroStickMoving.moving && !!heroStickMoving.goal
  && wentAxis(ddx, pushDir.x) && wentAxis(ddy, pushDir.y) && (ddx !== 0 || ddy !== 0),
  `(${heroBeforeStick.x},${heroBeforeStick.y}) → (${heroAfterStick.x},${heroAfterStick.y}) · 目标格 ${JSON.stringify(heroStickMoving.goal)}`);
await releaseMouse({ x: geo.cx + pushDir.x * 200, y: geo.cy + pushDir.y * 200 });
check('松手即停：摇杆归零、方向清零',
  await js(`(()=>{const s=__frostfall.stick.state();return s.mag===0 && !s.active;})()`));

// §1.9.2「移动区绝不与技能区重叠」：右下那片（技能区）按下拖动不该激活摇杆
// （挑画面中右部的空地：别压在技能/操作按钮上，那样测的就是按钮不是摇杆了）
const offFrom = { x: Math.round(geo.viewport.w * 0.82), y: Math.round(geo.viewport.h * 0.5) };
const offTo = { x: offFrom.x - 60, y: offFrom.y + 40 };
await holdDrag(offFrom, offTo);
const offZone = await js(`__frostfall.stick.state()`);
await releaseMouse(offTo);
check('§1.9.2 右半屏（技能区那一侧）拖动不会激活摇杆（移动区与技能区不重叠）',
  !offZone.active && offZone.mag === 0,
  `按下 (${offFrom.x},${offFrom.y}) 在有效区外（有效区宽 ${Math.round(offZone.zone.w)}px）`);

// §10.1：有效区里**轻点**（没拖动）仍然走「点地移动」——两套输入必须共存，不能吃掉地图点击
// 摇杆有效区（左下 45%、下半屏）里扫出一串候选空地屏幕点（能不能走到要点了才知道，所以列一串逐个试）
const zoneTap = await js(`(()=>{const m=__frostfall.match, r=__frostfall.renderer, out=[];
  const box=document.getElementById('game').getBoundingClientRect();
  for(let sy=box.top+box.height*0.55; sy<box.bottom-30; sy+=48)
    for(let sx=box.left+30; sx<box.left+box.width*0.45; sx+=48){
      if(document.elementFromPoint(Math.round(sx),Math.round(sy))?.id!=='game') continue;
      const c=r.toGrid(Math.round(sx),Math.round(sy));
      if(c.x<1||c.y<1||c.x>=m.grid.w-1||c.y>=m.grid.h-1||m.isBlocked(c.x,c.y)) continue;
      if(c.x===m.hero.cell.x&&c.y===m.hero.cell.y) continue;
      if(out.some(o=>o.cell.x===c.x&&o.cell.y===c.y)) continue;
      out.push({x:Math.round(sx),y:Math.round(sy),cell:c});
      if(out.length>=8) return out;
    }
  return out;})()`);
// 逐个候选点试：目标是「点一下就真的把行进目标设成了那一格」（不是「随便有个目标就算过」）
let zoneTapOk = null;
if (zoneTap) {
  for (const cand of zoneTap) {
    await clickCell({ x: cand.x, y: cand.y });
    await sleep(250);
    const goal = await js(`__frostfall.match.hero.goal`);
    if (goal && goal.x === cand.cell.x && goal.y === cand.cell.y) { zoneTapOk = cand; break; }
  }
}
check('§10.1 摇杆有效区里「轻点」仍然点地移动（两种操作方式共存）',
  !!zoneTapOk,
  zoneTapOk ? `点到 (${zoneTapOk.cell.x},${zoneTapOk.cell.y}) 并成为行进目标`
    : `有效区里 ${zoneTap?.length ?? 0} 个候选点都没点动（检查失效或功能坏了）`);

// §1.9.3：设置里切「浮动」→ 底座跟到手指按下的地方（不再是固定左下）
await click('#btnSettings');
await sleep(250);
const stickOpt = await click('#setStick button:nth-child(2)');
await sleep(150);
await click('#settingsPanel [data-close]');
await sleep(150);
const floatAt = await js(`(()=>{const box=document.getElementById('game').getBoundingClientRect();
  return {x:Math.round(box.left+box.width*0.28), y:Math.round(box.top+box.height*0.62), left0:Math.round(document.getElementById('stickBase').getBoundingClientRect().left)};})()`);
await holdDrag(floatAt, { x: floatAt.x + 40, y: floatAt.y });
const floatState = await js(`__frostfall.stick.state()`);
await releaseMouse({ x: floatAt.x + 40, y: floatAt.y });
check('§1.9.3 切「浮动」后底座跟手：按在左半屏任意处，底座中心就在那里',
  stickOpt === 'ok' && floatState.active && floatState.floating
  && Math.abs(floatState.baseCenter.x - floatAt.x) <= 2 && floatState.baseCenter.y === floatAt.y,
  `底部选项=${stickOpt} · 按下 (${floatAt.x},${floatAt.y}) · 底座中心 (${Math.round(floatState.baseCenter.x)},${floatState.baseCenter.y})`);
check('浮动模式松手后底座回到原位（不把布局留在半路）',
  await js(`Math.abs(document.getElementById('stickBase').getBoundingClientRect().left - ${floatAt.left0}) <= 1`));
// 切回固定：后面的用例与截图按默认观感走
await click('#btnSettings');
await sleep(250);
await click('#setStick button:nth-child(1)');
await sleep(150);
await click('#settingsPanel [data-close]');
await sleep(150);
check('§1.9.3 摇杆开关落盘（切回固定后存档里就是 fixed）',
  await js(`JSON.parse(localStorage.getItem('frostfall:settings')??'{}').stick === 'fixed'`));

// §61 的教训：设计画布与真机 CSS 视口是两回事，版式必须两边都量。摇杆也不例外。
await send('Emulation.setDeviceMetricsOverride', { width: 667, height: 375, deviceScaleFactor: 1, mobile: false });
await sleep(400);
const geoPhone = await stickGeom();
check('真机视口 667×375：摇杆底座还在左下 45% 内、整块在视口里、离底边 ≥60pt',
  !geoPhone.hidden && geoPhone.cx < geoPhone.viewport.w * 0.45 && geoPhone.cy > geoPhone.viewport.h * 0.45
  && geoPhone.fromBottom >= 60 && geoPhone.fromBottom + geoPhone.h <= geoPhone.viewport.h
  && geoPhone.w >= 120,
  `${geoPhone.w}×${geoPhone.h}px · 中心 (${geoPhone.cx},${geoPhone.cy}) · 距底 ${geoPhone.fromBottom}pt · 视口 ${geoPhone.viewport.w}×${geoPhone.viewport.h}`);
await send('Emulation.setDeviceMetricsOverride', { width: 1334, height: 750, deviceScaleFactor: 1, mobile: false });
await sleep(400);

// §2.6「越远收益越高」：人走进野外区时，HUD 要报出「区名 + 等级段 + 掉落加成」，
// 否则玩家永远不知道远处掉得多（这条规则上一轮刚实现，这里验它真的露出来了）
const zoneHud = await js(`(()=>{const m=__frostfall.match;
  const far = m.def.zones[m.def.zones.length - 1];
  m.hero.cell = { x: far.x + 1, y: far.y + 1 };   // 直接把人放进最远的那个区（只动镜像的位置，验 HUD）
  return { name: far.name, lv: [far.lvMin, far.lvMax], bonus: far.dropBonus };})()`);
await sleep(300);   // HUD 由下一帧渲染
const zoneTextNow = await js(`document.getElementById('heroState').textContent`);
check('§2.6 走进野外区：HUD 报出区名/等级段/掉落加成（越远收益越高要看得见）',
  zoneTextNow.includes(zoneHud.name) && zoneTextNow.includes(`Lv${zoneHud.lv[0]}-${zoneHud.lv[1]}`)
  && zoneTextNow.includes(`×${zoneHud.bonus}`),
  `区「${zoneHud.name} Lv${zoneHud.lv[0]}-${zoneHud.lv[1]}」×${zoneHud.bonus} → HUD「${zoneTextNow}」`);
// 防守 HUD 的三处读数（城堡 / 工事计数 / 轮次）：同样「改内核 → 读 DOM」
const hudDef = await js(`(async()=>{const m=__frostfall.match;
  m.castle.hp = Math.max(1, m.castle.hp - 250);
  await new Promise((r)=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const t=(id)=>document.getElementById(id).textContent.trim();
  return {castle:t('defCastle'), forts:t('defFortCount'), rounds:t('defRound'),
    want:{castle:String(Math.round(m.castle.hp)) + ' / ' + m.castle.maxHp,
      forts:'工事 ' + m.forts.length + '/' + m.def.fortSlots.length, rounds:String(m.assault.round)}};})()`);
check('防守 HUD 的三处读数跟着内核走（城堡血量 / 工事计数 / 轮次）',
  hudDef.castle === hudDef.want.castle && hudDef.forts === hudDef.want.forts
  && hudDef.rounds === hudDef.want.rounds,
  `城堡「${hudDef.castle}」/「${hudDef.want.castle}」· 工事「${hudDef.forts}」/「${hudDef.want.forts}」`
  + ` · 轮次「${hudDef.rounds}」/「${hudDef.want.rounds}」`);
await js(`__frostfall.match.hero.cell = { x: __frostfall.match.castle.cell.x, y: __frostfall.match.castle.cell.y }`);
await sleep(200);

// 回城（30 秒冷却）——先把英雄挪远，再按回城
await waitFor(`!__frostfall.match.hero.dead`);          // 英雄可能在野外打怪时阵亡，阵亡时回城按钮是禁用的
const teleportClick = await click('#btnTeleport');
await sleep(250);   // 按钮文案/禁用态由下一帧渲染
check('防守：回城落到基地门前并进冷却',
  teleportClick === 'ok' && await js(`__frostfall.match.hero.teleportCd > 0`)
  && await js(`Math.abs(__frostfall.match.hero.cell.x - (__frostfall.match.castle.cell.x - 2)) <= 1
    && __frostfall.match.hero.cell.y === __frostfall.match.castle.cell.y`),
  `${await js(`document.getElementById('defTeleportHint').textContent`)}`);
check('防守：冷却中回城按钮禁用、冷却不会被重置',
  await js(`document.getElementById('btnTeleport').disabled`) && await js(`__frostfall.match.hero.teleportCd > 25`),
  `按钮 ${await js(`document.getElementById('btnTeleport').textContent`)}`);

// §5.5.1 回城卷轴：冷却中也能回基地（消耗 1 张），但卷轴只负责送人、不清 30 秒冷却
await js(`__frostfall.match.hero.cell = { x: 50, y: 34 }; __frostfall.match.scrolls = 1;`);
await sleep(250);
check('防守：冷却中有一张回城卷轴时按钮仍可点，且写明卷轴数',
  !(await js(`document.getElementById('btnTeleport').disabled`))
  && (await js(`document.getElementById('btnTeleport').textContent`)).includes('卷轴'),
  `按钮 ${await js(`document.getElementById('btnTeleport').textContent`)}`);
const scrollClick = await click('#btnTeleport');
await sleep(250);
check('防守：用卷轴回城消耗 1 张、且不会把 30 秒冷却清零',
  scrollClick === 'ok' && await js(`__frostfall.match.scrolls === 0`)
  && await js(`__frostfall.match.hero.teleportCd > 0`)
  && await js(`Math.abs(__frostfall.match.hero.cell.x - (__frostfall.match.castle.cell.x - 2)) <= 1`),
  `卷轴 ${await js(`__frostfall.match.scrolls`)} · 剩余冷却 ${await js(`Math.round(__frostfall.match.hero.teleportCd)`)}s`);

// 修城：砸一下城堡再修（满血、或金币被 AI 花到 200 以下时按钮都是禁用的，所以先把两个前提摆好）
await js(`__frostfall.match.castle.hp = __frostfall.match.castle.maxHp - 900; __frostfall.match.gold = 500;`);
await sleep(300);
const hpBefore = await js(`Math.round(__frostfall.match.castle.hp)`);
const goldBeforeRepair = await js(`Math.round(__frostfall.match.gold)`);
const repairClick = await click('#btnRepair');
await sleep(200);
check('防守：修城扣 200 金并回血',
  repairClick === 'ok' && await js(`Math.round(__frostfall.match.castle.hp)`) > hpBefore
  && await js(`Math.round(__frostfall.match.gold)`) === goldBeforeRepair - 200,
  `点击=${repairClick} · 城堡 ${hpBefore} → ${await js(`Math.round(__frostfall.match.castle.hp)`)}`
  + ` · 金币 ${goldBeforeRepair} → ${await js(`Math.round(__frostfall.match.gold)`)}`
  + ` · ${await js(`document.getElementById('toast').textContent`)}`);

// 防守模式的镜头：跟随英雄（缩放档位单独生效）
check('防守：相机跟随英雄（英雄在画面中心附近）',
  await js(`(()=>{const p=__frostfall.renderer.toScreen(__frostfall.match.hero.cell.x, __frostfall.match.hero.cell.y);
    const r=document.getElementById('game').getBoundingClientRect();
    return Math.abs(p.x-r.width/2)<90 && Math.abs(p.y-r.height/2)<90;})()`));

// 小地图（§2.6）：防守模式才出现，点它 = 回城
check('防守：小地图出现（TD 模式下它该收起来）',
  await js(`!document.getElementById('minimapBox').classList.contains('hidden')`));
check('防守：小地图压在轮次面板下面，不互相遮挡',
  await js(`(()=>{const p=document.getElementById('defensePanel').getBoundingClientRect();
    const mm=document.getElementById('minimap').getBoundingClientRect();
    return mm.top >= p.bottom - 1;})()`),
  await js(`(()=>{const p=document.getElementById('defensePanel').getBoundingClientRect();
    const mm=document.getElementById('minimap').getBoundingClientRect();
    return '面板底 '+(p.bottom|0)+' / 小地图顶 '+(mm.top|0);})()`));
await js(`__frostfall.match.hero.cell = { x: 50, y: 34 }; __frostfall.match.hero.teleportCd = 0;`);
const miniBox = await js(`(()=>{const r=document.getElementById('minimap').getBoundingClientRect();
  return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), w:r.width};})()`);
await clickCell(miniBox);
await sleep(250);
check('防守：点小地图回城（与按钮同一套冷却）',
  await js(`__frostfall.match.hero.teleportCd > 25`)
  && await js(`Math.abs(__frostfall.match.hero.cell.x - (__frostfall.match.castle.cell.x - 2)) <= 1`),
  `${miniBox.w}×? 的小地图 · ${await js(`document.getElementById('toast').textContent`)}`);
await sleep(3000);
check('防守：轮次/城堡在推进', await js(`__frostfall.match.time > 0`));
// §2.6 回防预警：小地图闪一圈橙边（render.js）+ 提示音（audio.js）。headless 里听不到声音，
// 所以验的是「同一时刻确实调用了提示音 + 上下文当时是 running」——cue.log 记下了每次播放与它的状态。
// §178：这一条以前只断 `played`，而 `played` 是写死的 true；冒烟又跑在宽松的自动播放策略下，
// 于是「真机上音频没被解锁、一声不响」这件事谁也不会红。现在：真机策略跑冒烟 + `played` 由
// `ctx.state === 'running'` 决定 + 这里额外断「当时状态就是 running」。
await js(`__frostfall.match.assault.timer = 20`);
await waitFor(`__frostfall.match.assault.warning === true`, 5000);
await sleep(400);
const cueLog = await js(`__frostfall.cue.log`);
check('§2.6 回防预警：进预警那一刻响一次提示音（上升沿只响一次）',
  Array.isArray(cueLog) && cueLog.filter((x) => x.played && x.kind === 'warning').length === 1
  && cueLog.every((x) => x.played === (x.state === 'running')),   // §178：日志不许撒谎
  `日志 ${JSON.stringify(cueLog?.slice(-2))}`);
check('§178 提示音在手势之后是「真的响了」（AudioContext 处于 running，不是挂起状态）',
  Array.isArray(cueLog) && cueLog.some((x) => x.played && x.state === 'running'),
  `最后一条 ${JSON.stringify(cueLog?.at(-1))}`);
// 用设置面板把「提示音」关掉，再触发一次预警：应当记 muted、不再播放（走的是玩家真会走的路径）
await click('#btnSettings');
await sleep(250);
const sfxToggle = await click(await toggleSel('音效'));   // 按文字取：列表按模式变（§154）
await sleep(150);
await click('#settingsPanel [data-close]');
// 先把 timer 抬到预警线以上，让**帧循环确实看到一次 false**，再压回 20 触发上升沿——
// 直接写「false + 20」有竞态：游戏下一 tick 立刻把它设回 true，主循环可能从没见过 false
await js(`__frostfall.match.assault.warning = false; __frostfall.match.assault.timer = 60;`);
await sleep(300);
const warnedAgain = await waitFor(`__frostfall.match.assault.warning === false`, 2000);
await js(`__frostfall.match.assault.timer = 20;`);
const roseAgain = await waitFor(`__frostfall.match.assault.warning === true`, 5000);
await sleep(400);
check('§2.6 关掉「提示音」后预警不再播放（记 muted，不建 AudioContext）',
  warnedAgain && roseAgain &&
  sfxToggle === 'ok' && await js(`(()=>{const l=__frostfall.cue.log;return l.some((x)=>x.reason==='muted');})()`),
  `点击=${sfxToggle} · sfx=${await js(`JSON.parse(localStorage.getItem('frostfall:settings') ?? '{}').sfx`)} · 日志=${await js(`JSON.stringify(__frostfall.cue.log)`)}`);
await click('#btnSettings');
await sleep(200);
await click(await toggleSel('音效'));   // 开回来，后面的截图保持默认观感
await sleep(150);
await click('#settingsPanel [data-close]');
const shotDef = await screenshot('ff-smoke-defense.png');

/* ---------- §1.9.2 短震动：按下缩放那半是 CSS（.btn:active），震动这半是 feedback.js ---------- */

// 真机的震感验不了，但**接线**能验：注入一个假的 window.wx，走一次**真实按下**
// （pointerdown，不是 e.click()——`click()` 只发 click 事件，压根碰不到那条委托监听），
// 看有没有真的调到 wx.vibrateShort。少了这条，vibrateShort 拼错、委托漏了某类元素，都不会有人发现。
const pressButton = async (selector) => {
  const box = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
    if(!e||e.closest('.hidden')) return null;
    const r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};})()`);
  if (!box) return false;
  await clickCell(box);
  return true;
};

await js(`window.wx = { vibrateShort: (o) => { window.__vibe = (window.__vibe ?? 0) + 1; window.__vibeType = o.type; } };
  __frostfall.tap.log.length = 0;`);
const pressedSettings = await pressButton('#btnSettings');
await sleep(250);
const tapOn = await js(`({ n: __frostfall.tap.log.length, vibe: window.__vibe ?? 0, type: window.__vibeType,
  open: !document.getElementById('settingsPanel').classList.contains('hidden'), last: __frostfall.tap.log.at(-1) })`);
check('§1.9.2 真按一下按钮 → 按钮能点开、且确实调到了 wx.vibrateShort',
  pressedSettings && tapOn.open && tapOn.n === 1 && tapOn.vibe === 1 && tapOn.type === 'light' && tapOn.last?.vibrated === true,
  `${JSON.stringify(tapOn)}`);

// 关掉「音效/震动」开关后，同一个动作一次都不该震（记 muted，也不碰 wx）。
// 注意开关值是在 click（鼠标抬起后）才翻的，所以**按下开关那一下本身**还在震——从它之后再数。
const pressedToggle = await pressButton(await toggleSel('音效'));
await sleep(200);
const vibeBefore = await js(`window.__vibe ?? 0`);
const sfxOff = await js(`JSON.parse(localStorage.getItem('frostfall:settings')??'{}').sfx`);
const pressedClose = await pressButton('#settingsPanel [data-close]');
await sleep(200);
const tapMuted = await js(`({ vibe: window.__vibe ?? 0, last: __frostfall.tap.log.at(-1) })`);
check('§1.9.2 关掉开关后按下按钮：记 muted，且震动次数不再增加',
  pressedToggle && pressedClose && sfxOff === false && tapMuted.vibe === vibeBefore &&
  tapMuted.last?.vibrated === false && tapMuted.last?.reason === 'muted',
  `开关=${pressedToggle} · sfx=${sfxOff} · 震动 ${vibeBefore}→${tapMuted.vibe} · ${JSON.stringify(tapMuted.last)}`);

// 摘掉假 wx（模拟桌面浏览器），把开关开回来，再真按一下：界面照常工作，震动安静跳过（no-wx）。
// 这条是「一次点击不能把界面打断」的守卫——真机上 wx 缺失时点按钮必须照常。
const openedAgain = await pressButton('#btnSettings');
await sleep(200);
const toggledBack = await pressButton(await toggleSel('音效'));
await sleep(200);
await js(`delete window.wx; __frostfall.tap.log.length = 0;`);
const pressedNoWx = await pressButton('#settingsPanel [data-close]');
await sleep(250);
const tapNoWx = await js(`({ closed: document.getElementById('settingsPanel').classList.contains('hidden'),
  sfx: JSON.parse(localStorage.getItem('frostfall:settings')??'{}').sfx, last: __frostfall.tap.log.at(-1) })`);
check('§1.9.2 没有 wx 的桌面浏览器：按下按钮照常生效，震动安静跳过（no-wx）',
  openedAgain && toggledBack && pressedNoWx && tapNoWx.closed && tapNoWx.sfx !== false &&
  tapNoWx.last?.vibrated === false && tapNoWx.last?.reason === 'no-wx',
  `${JSON.stringify(tapNoWx)}`);

/* ---------- 联机：大厅的「创建联机房间」+ 服务端权威回包 ---------- */

const onlineUrl = new URL(url);
onlineUrl.search = '';                       // 干净入口，走大厅那排按钮
onlineUrl.searchParams.set('notutorial', '1');
// 第一遍的滚轮把「TD 整图可见」关掉了并且存了档；这里清掉，别让上一遍的设置影响这一遍
await js(`localStorage.removeItem('frostfall:settings')`);
await send('Page.navigate', { url: onlineUrl.toString() });
await sleep(2200);
// §2.1 落地之后大厅会沿用「上次配置」——上一节刚打过防守局，所以这里要**显式选回 TD**
await click('#optMode button:nth-child(1)');
await sleep(200);
await click('#optMap button:nth-child(1)');
await sleep(200);
check('联机：大厅有「创建联机房间」按钮', (await click('#btnCreateRoom')) === 'ok');
await sleep(600);
await waitFor('!!__frostfall.view?.net?.roomCode', 8000);
const room = await js(`__frostfall.view?.net?.roomCode ?? null`);
check('联机：建房后拿到 6 位房间码、徽标显示房间号', !!room && /^[A-Z0-9]{6}$/.test(room)
  && (await js(`document.getElementById('netBadge').classList.contains('hidden')`)) === false,
  `房间 ${room} · ${await js(`document.getElementById('netBadge').textContent`)}`);
check('联机：跳转 URL 保住了入口参数（notutorial 没被丢掉 → 不弹新手引导）',
  await js(`location.search.includes('notutorial=1')`) && await js(`!__frostfall.view.tutorial`),
  `URL ${await js(`location.search`)}`);

// 联机下建塔：本地不直接改 match，塔必须由服务端快照回来（这条才是真的权威链路）
const onlineSlot = await clickSlot(await pickSlot());
await sleep(150);
check('联机：点塔位先弹建造轮盘（预测鬼影）', await js(`!document.getElementById('wheel').classList.contains('hidden')`));
await click('#wheel button');
await sleep(1500);
check('联机：点塔位建的塔由服务端快照回来（本地不自己造塔）',
  await js(`__frostfall.match.towers.length === 1`),
  `服务端快照塔数 ${await js(`__frostfall.match.towers.length`)} · 落点 (${onlineSlot.x}, ${onlineSlot.y})`);
check('联机：快照带回了作者与队伍色',
  await js(`__frostfall.match.towers[0].owner === 0`));

// §10.1：4G ↔ WiFi 切换那种**被动掉线**，客户端要自己回到原房间（以前只能靠玩家刷新页面）
const beforeSwitch = await js(`({room: __frostfall.view?.net?.roomCode, towers: __frostfall.match.towers.length,
  slot: __frostfall.view?.net?.slot})`);
await js(`__frostfall.net.simulateDrop()`);
// 先等「掉线被处理」，再等「连回来」——第一版直接从 `connected===true` 开始等，
// 第一次轮询赶在 close 事件之前，读到的还是掉线**前**的 true（`waitFor` 当场就返回了）
const dropped = await waitFor(`__frostfall.view?.net?.connected === false`, 3000);
const reconnected = await waitFor(`__frostfall.view?.net?.connected === true`, 12000);
await sleep(600);
const afterSwitch = await js(`({room: __frostfall.view?.net?.roomCode, towers: __frostfall.match.towers.length,
  slot: __frostfall.view?.net?.slot, connected: __frostfall.view?.net?.connected,
  info: __frostfall.net.reconnectInfo?.() ?? null})`);
check('§10.1 网络切换掉线后自动重连回原房间（同 uid 回原座，塔与房间码都还在）',
  // 注意：房间码/座位/塔数在**没重连**时也不会变（state 里存着），所以必须单独断「真的连回来了」——
  // 第一版就是漏了这一句，把自动重连整段删掉照样全绿
  dropped && reconnected && afterSwitch.connected === true
  && afterSwitch.room === beforeSwitch.room && afterSwitch.slot === beforeSwitch.slot
  && afterSwitch.towers === beforeSwitch.towers,
  `掉线=${dropped} 重连=${reconnected} · connected=${afterSwitch.connected} · 房间 ${beforeSwitch.room} → ${afterSwitch.room}`
  + ` · 座位 ${beforeSwitch.slot} → ${afterSwitch.slot} · 塔 ${beforeSwitch.towers} → ${afterSwitch.towers}`
  + ` · ${JSON.stringify(afterSwitch.info)}`);

// 主动关闭（"转单人继续"那条路）：客户端不能卡死，指令要给出「掉线」而不是「金币不足」；再用 ?rejoin=1 回来
const towersBeforeDrop = await js(`__frostfall.match.towers.length`);
await js(`__frostfall.net.close()`);
await sleep(400);
// 这里是**主动关闭**（`net.close()` → 不再重连；产品路径上只有「转单人继续」走它，那时徽标会被收起）。
// 被动掉线的「重连中：5 分钟内可回原座」文案在上一节单独验（§114）。
check('联机主动断开：徽标转成「已断开连接」、镜像还在（不崩不黑屏）',
  await js(`__frostfall.view.net.connected === false`)
  && await js(`__frostfall.match.towers.length === ${towersBeforeDrop}`)
  && await js(`document.getElementById('netBadge').textContent.includes('已断开连接')`),
  await js(`document.getElementById('netBadge').textContent`));
await clickSlot(await pickSlot(true));
await sleep(150);
await click('#wheel button');
await sleep(200);
check('联机掉线：这时点建塔要说「掉线中」而不是「金币不足」（指令根本没发出去）',
  (await js(`document.getElementById('toast').textContent`)).includes('掉线'),
  await js(`document.getElementById('toast').textContent`));
const rejoinUrl = new URL(url);
rejoinUrl.search = '';
rejoinUrl.searchParams.set('rejoin', '1');
rejoinUrl.searchParams.set('notutorial', '1');
await send('Page.navigate', { url: rejoinUrl.toString() });
await sleep(800);
await waitFor(`__frostfall.view?.net?.connected === true && __frostfall.view?.net?.slot === 0`, 10000);
check('联机掉线：用 ?rejoin=1 重开能回到原房间原座位（塔还在）',
  await js(`__frostfall.view?.net?.roomCode === ${JSON.stringify(room)}`)
  && await js(`__frostfall.match.towers.length >= ${towersBeforeDrop}`),
  `房间 ${await js(`__frostfall.view?.net?.roomCode`)} · 塔 ${await js(`__frostfall.match.towers.length`)} · slot ${await js(`__frostfall.view?.net?.slot`)}`);
const shotOnline = await screenshot('ff-smoke-online.png');

/* ---------- 联机双人：第二个客户端走「好友用 ?room= 码进来」这条路 ---------- */

const hostUid = await js(`localStorage.getItem('frostfall:uid')`);
const friendUrl = new URL(url);
friendUrl.search = '';
friendUrl.searchParams.set('room', room);
friendUrl.searchParams.set('notutorial', '1');
await js(`localStorage.setItem('frostfall:uid', 'u-smoke-friend')`);   // 换个人（uid 才是身份，见 §8.2）
await send('Page.navigate', { url: friendUrl.toString() });
await sleep(600);
await waitFor('__frostfall.view?.net?.slot === 1', 10000);
const twoP = await js(`({players: __frostfall.view?.net?.players?.length ?? 0, slot: __frostfall.view?.net?.slot ?? -1,
  towers: __frostfall.match.towers.length, owners: __frostfall.match.towers.map((t) => t.owner),
  badge: document.getElementById('netBadge').textContent})`);
// 注意：服务端的玩家列表只列「在线」的人，主机这时是掉线态，所以这里不能断言 2 人
check('联机双人：好友用 ?room= 进房，拿到 1 号位（服务端认了第二个座）',
  twoP.slot === 1, `slot ${twoP.slot} · ${twoP.badge}`);
check('联机双人：好友看到主机建的塔（服务端同步过来）', twoP.towers === 1,
  `塔 ${twoP.towers} · owner ${twoP.owners.join('/')}`);

await clickSlot(await pickSlot(true));      // 挑一个空塔位（别人的塔点了会开塔面板，不是轮盘）
await sleep(150);
await click('#wheel button');
await sleep(1800);
const afterFriend = await js(`({towers: __frostfall.match.towers.length, owners: __frostfall.match.towers.map((t) => t.owner)})`);
check('联机双人：好友建的塔也进服务端（两座塔、owner 0/1）',
  afterFriend.towers === 2 && afterFriend.owners.includes(0) && afterFriend.owners.includes(1),
  `owner ${afterFriend.owners.join('/')}`);
const shotDuo = await screenshot('ff-smoke-two-players.png');

const hostUrl = new URL(url);
hostUrl.search = '';
hostUrl.searchParams.set('room', room);
hostUrl.searchParams.set('notutorial', '1');
await js(`localStorage.setItem('frostfall:uid', ${JSON.stringify(hostUid)})`);
await sleep(300);
await send('Page.navigate', { url: hostUrl.toString() });
await sleep(600);
await waitFor('__frostfall.view?.net?.slot === 0', 10000);
const hostBack = await js(`({players: __frostfall.view?.net?.players?.length ?? 0, slot: __frostfall.view?.net?.slot ?? -1,
  towers: __frostfall.match.towers.length, owners: __frostfall.match.towers.map((t) => t.owner)})`);
check('联机双人：主机重连回原房间（回到 0 号位，而不是被发一个新座）',
  hostBack.slot === 0,
  `slot ${hostBack.slot} · 在线 ${hostBack.players} 人 · uid ${await js(`localStorage.getItem('frostfall:uid')`)}`
  + `（主机 uid ${hostUid}）· search ${await js(`location.search`)} · connected ${await js(`__frostfall.view?.net?.connected ?? null`)}`
  + ` · error ${await js(`__frostfall.view?.net?.error ?? null`)}`);
check('联机双人：主机能看到好友建的塔（双向同步）', hostBack.towers === 2,
  `塔 ${hostBack.towers} · owner ${hostBack.owners.join('/')}`);

/* ---------- 联机并发：两个客户端**同时在**房间里（前面那遍是「一人在线、一人掉线」） ---------- */

// 开第二个页面（同一个 Chrome 里的另一个 target）。localStorage 是同一个 origin，
// 所以先注入一段「换 uid」的脚本，让第二个客户端是另一个人（uid 才是身份，见 §8.2）。
const tab2 = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
// 注意：两个 target 共用同一个 profile，**localStorage 是共享的**。谁后加载谁就能覆盖
// `frostfall:uid`，于是两个「人」可能撞成同一个 uid（服务端按 §36 的逻辑会让后来的接管座位，
// 先来的那条连接被顶掉）。所以这里给**两个** target 都注入「每次加载都把自己的 uid 写回去」。
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: "try{localStorage.setItem('frostfall:uid','u-smoke-a')}catch(e){}",
});
const ws2 = new WebSocket(tab2.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej; });
let seq2 = 0;
const pending2 = new Map();
ws2.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending2.has(msg.id)) { pending2.get(msg.id)(msg); pending2.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    pageErrors.push(`[第二个客户端] 未捕获异常：${d.exception?.description ?? d.text}`);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    pageErrors.push(`[第二个客户端] console.error：${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  }
};
const send2 = (method, params = {}) => new Promise((res) => {
  const id = ++seq2;
  pending2.set(id, res);
  ws2.send(JSON.stringify({ id, method, params }));
});
const js2 = async (expr) => (await send2('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
  .result?.result?.value;
const waitFor2 = async (expr, timeoutMs = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await js2(expr)) return true;
    await sleep(150);
  }
  return false;
};
await send2('Runtime.enable');
await send2('Page.enable');
await send2('Emulation.setDeviceMetricsOverride', { width: 1334, height: 750, deviceScaleFactor: 1, mobile: false });
await send2('Page.addScriptToEvaluateOnNewDocument', {
  source: "try{localStorage.setItem('frostfall:uid','u-smoke-b')}catch(e){}",
});
await send2('Page.navigate', { url: friendUrl.toString().replace('u-smoke-friend', 'u-smoke-b') });
await waitFor2('__frostfall.view?.net?.slot === 1 && __frostfall.match.towers.length === 2', 15000);
const both = await js(`({players: (__frostfall.view?.net?.players ?? []).length, slot: __frostfall.view?.net?.slot,
  towers: __frostfall.match.towers.length, self: document.getElementById('playerPanel').textContent.includes('（我）')})`);
const both2 = await js2(`({players: (__frostfall.view?.net?.players ?? []).length, slot: __frostfall.view?.net?.slot,
  towers: __frostfall.match.towers.length, self: document.getElementById('playerPanel').textContent.includes('（我）')})`);
check('联机并发：两人同时在房（两边看到的玩家数一致，且 ≥2 人）',
  both.players >= 2 && both.players === both2.players,
  `主机看到 ${both.players} 人 · 第二个客户端看到 ${both2.players} 人`);
check('联机并发：两边座号不同，且玩家面板都把自己标成「我」',
  both.slot !== both2.slot && both.self && both2.self,
  `slot ${both.slot}/${both2.slot} · 自我标记 ${both.self}/${both2.self}`);
check('联机并发：两边都已经有 2 座塔（此前两人各建了一座）',
  both.towers === 2 && both2.towers === 2, `主机 ${both.towers} · 第二个客户端 ${both2.towers}`);

// 主机建第三座塔 → 第二个客户端应当**实时**看到（这才是「并发」要验的东西）
await clickSlot(await pickSlot(true));
await sleep(150);
await click('#wheel button');
await waitFor2('__frostfall.match.towers.length === 3', 5000);
check('联机并发：主机建塔后，第二个客户端不用刷新就看到第三座塔',
  await js2(`__frostfall.match.towers.length === 3`),
  `第二个客户端看到 ${await js2(`__frostfall.match.towers.length`)} 座`);

// 并发 + 防守：两个客户端同时进一个**防守房**，主机建工事，对面要实时看到
const defRoom = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/create?mode=defense&map=def_01`)).json();
const defRoomUrl = (query) => {
  const u = new URL(url);
  u.search = '';
  u.searchParams.set('room', defRoom.code);
  u.searchParams.set('mode', 'defense');
  u.searchParams.set('notutorial', '1');
  if (query) u.search += `&${query}`;
  return u.toString();
};
// 两个页面**不能同时加载**：localStorage 是共享的，谁后加载谁就可能把 uid 写进去，
// 而另一页的脚本可能还没读到自己的 uid（实测会撞成同一个人 → 一个被顶掉、另一个拿到它的座位）。
// 所以先让主机进房、确认它已拿到座位，再放第二个客户端进来。
await send('Page.navigate', { url: defRoomUrl() });
await waitFor('__frostfall.match.mode === \u0027defense\u0027 && __frostfall.view?.net?.slot === 0', 15000);
await send2('Page.navigate', { url: defRoomUrl() });
await waitFor2('__frostfall.match.mode === \u0027defense\u0027 && __frostfall.view?.net?.slot === 1', 15000);
check('联机并发（防守）：两个客户端是两个不同的 uid（不是同一个人被顶掉）',
  (await js(`__frostfall.view?.net?.playerId`)) !== (await js2(`__frostfall.view?.net?.playerId`)),
  `${await js(`__frostfall.view?.net?.playerId`)} vs ${await js2(`__frostfall.view?.net?.playerId`)}`);
await waitFor('__frostfall.match.forts !== undefined && __frostfall.match.castle.hp > 0', 8000);
// 主机点一个空工事位 → 建工事
await clickCell(await fortPoint());
await sleep(200);
check('联机并发（防守）：点空工事位弹出工事轮盘',
  await js(`!document.getElementById('wheel').classList.contains('hidden')`),
  `金币 ${await js(`Math.round(__frostfall.match.gold)`)}`);
await click('#wheel button');
await waitFor2('__frostfall.match.forts.length === 1', 6000);
const defSync = { a: await js(`__frostfall.match.forts.length`), b: await js2(`__frostfall.match.forts.length`) };
const defTime = { a: await js(`Math.round(__frostfall.match.time * 10) / 10`), b: await js2(`Math.round(__frostfall.match.time * 10) / 10`) };
check('联机并发（防守）：主机建工事，第二个客户端实时看到',
  defSync.a === 1 && defSync.b === 1,
  `主机 ${defSync.a} 座 · 第二个客户端 ${defSync.b} 座 · 对局时间 ${defTime.a}s/${defTime.b}s`
  + `（时间也要跟着走，否则只说明它压根没收到快照）`);
const castles = { a: await js(`Math.round(__frostfall.match.castle.hp)`), b: await js2(`Math.round(__frostfall.match.castle.hp)`) };
check('联机并发（防守）：两边的城堡血量一致（同一份权威快照）',
  castles.a === castles.b && castles.a > 0, `主机 ${castles.a} · 第二个客户端 ${castles.b}`);

// §122：别人的**名字**是能被控制的输入（它从 URL 来、经服务器广播、再渲染到别人的玩家面板里）。
// 攻击者用 Node 侧的一条真 WS（它想报什么名字都行——浏览器客户端做不到，但别人可以），
// 受害者是浏览器里的两个客户端：名字必须只当文字显示，绝不能执行。
// 注意：玩家面板只在 **TD** 模式出现（防守模式那块面板是收起的），所以这一条要开一间 TD 房。
const xssRoom = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/create?map=map_01&mode=td`)).json();
const xssUrl = new URL(url);
xssUrl.search = '';
xssUrl.searchParams.set('room', xssRoom.code);
xssUrl.searchParams.set('map', 'map_01');
xssUrl.searchParams.set('notutorial', '1');
await send('Page.navigate', { url: xssUrl.toString() });
await waitFor(`__frostfall.view?.net?.roomCode === '${xssRoom.code}'`, 15000);
// **必须把这一页切回前台**：开了第二个 tab 之后，第一个 tab 是后台页，rAF 不跑 → 它的 DOM
// 永远停在初始 HTML 上（这一条第一次就是因此读到「空面板」，看着像功能坏了，其实是检查手段的问题）
await send('Page.bringToFront');
const evilName = '<img src=x onerror="window.__xss=1">';
const evil = new WebSocket(`ws://127.0.0.1:${SERVE_PORT}/ws?` + new URLSearchParams({
  room: xssRoom.code, name: evilName, uid: 'u-smoke-evil', v: String(PROTOCOL_VERSION),
}));
await new Promise((res, rej) => { evil.onopen = res; evil.onerror = () => rej(new Error('恶意客户端连不上')); });
// 等**面板里真的出现这段文字**（不是只等网络层收到）——坏名字要进到 DOM 里才算验过
const nameAppeared = await waitFor(`document.getElementById('playerPanel').textContent.includes('img')`, 12000);
const xss = await js(`({executed: window.__xss === 1,
  imgs: document.getElementById('playerPanel').querySelectorAll('img').length,
  text: document.getElementById('playerPanel').textContent.replace(/\\s+/g, ' ').trim().slice(0, 60),
  players: (__frostfall.view.net?.players ?? []).map((p) => p.name)})`);
check('§122 别人的名字只能是文字（带 <img onerror> 的名字不会在主机页面里执行）',
  nameAppeared && !xss.executed && xss.imgs === 0 && /img/.test(xss.text),
  `文字进面板=${nameAppeared} · 执行=${xss.executed} · img 元素 ${xss.imgs} 个 · 文字「${xss.text}」`
  + ` · 房内名单 ${JSON.stringify(xss.players)}`);
evil.close();

// §206：**日志面板是拼 innerHTML 的**——今天日志文案全是内核/服务端自己造的（塔名、怪名、轮次…），
// 没有携带玩家名字的那一行；但「X 加入了房间 / X 掉线」正是最可能新增的一句（§122 就是这么中招的）。
// 这里直接往事件列表里塞一段带 `<img onerror>` 的文案，验它进到日志面板后**只是文字**。
// （先撤掉 §122 那一步留下的坏名字，免得它盖过这条的信息。）
await js(`(()=>{const m=__frostfall.match;
  m.events.push({ t: m.time, kind: 'warn', text: '<img src=x onerror=window.__logXss=1> 加入' });
  return true;})()`);
await sleep(500);
const logXss = await js(`JSON.stringify({xss: window.__logXss === 1,
  imgs: document.getElementById('log').querySelectorAll('img').length,
  text: document.getElementById('log').textContent.replace(/\\s+/g, ' ').trim().slice(-70)})`);
const lx = JSON.parse(logXss);
check('§206 日志面板里的外部字符串只会当文字（这个口子今天还没人用，但先堵上）',
  lx.xss === false && lx.imgs === 0 && /onerror=/.test(lx.text),
  `执行=${lx.xss} · img 元素 ${lx.imgs} 个 · 面板文字「${lx.text}」`);
await js(`(()=>{window.__logXss = 0; return true;})()`);

await ws2.close();
await fetch(`http://127.0.0.1:${PORT}/json/close/${tab2.id}`).catch(() => {});

/* ---------- §130 联机的结算面板：服务端判负 → 客户端要弹结算，并把「声望 +N」写上 ---------- */

// 用调试钩子（默认关，起服时 FF_DEBUG_HOOKS=1）造一间「马上开波 + 核心 1 血」的房：第一只漏怪就判负。
// 这一页是玩家每局都会看到的，但此前只验过单机侧的四种结局——联机那页从来没人看过。
/**
 * §193：**别用「建房即判定」**。房间刚建出来时**一个人都没有**，服务端的第一个 tick（50ms）就会
 * `recordResultIfFinished()` 把这局记掉（`resultRecorded = true`）——那一刻 `players` 是空的，
 * `msg.profile` 一个接收者都没有；之后进来的玩家**再也拿不到那条推送**（实测：面板照样弹
 * 「核心被摧毁」，但 `view.resultExtra` 永远是 null，面板上就没有「声望 +N」）。
 * 这正是这条检查偶发红的根因（§164 记过一次，当时只补了等待、没动时序）。现在让服务端**等 4 秒**
 * 再判——那时浏览器早就连进来了，推送有接收者。
 */
const quickLoss = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/create?map=map_01&mode=td&result=lose&resultAfter=4`)).json();
const lossUrl = new URL(url);
lossUrl.search = '';
lossUrl.searchParams.set('room', quickLoss.code);
lossUrl.searchParams.set('map', 'map_01');
lossUrl.searchParams.set('notutorial', '1');
await send('Page.navigate', { url: lossUrl.toString() });
await send('Page.bringToFront');   // 前面开过第二个 tab，这一页可能是后台页（rAF 不跑）
await waitFor(`!!__frostfall.view?.net?.connected`, 10000);
const lost = await waitFor(`__frostfall.match.result === 'lose'`, 12000);
/**
 * §164：**等「你要断的那个东西」，别等它的代理**。
 * 「声望 +N」不是快照给的，是服务端那条 `profile` 推送（一局结束才发一次）写进 `view.resultExtra` 的，
 * 比「面板弹出」晚一帧到几帧。这条检查以前只等 `result === 'lose'` 就去读 `extra`——面板已经弹出、
 * 声望那行还没到，于是偶发红（实测整包跑红过一次，单独复跑又绿）。现在先等 `extra.gain > 0` 本身。
 */
const gotRep = await waitFor(`(__frostfall.view.resultExtra?.gain ?? 0) > 0`, 5000);
const lossPanel = await js(`({title: document.getElementById('overTitle').textContent,
  body: document.getElementById('overBody').textContent,
  rows: document.getElementById('resultRows').textContent.replace(/\\s+/g, ' ').trim().slice(0, 100),
  overlay: !document.getElementById('overlay').classList.contains('hidden'),
  extra: __frostfall.view.resultExtra ?? null})`);
check('§130 联机判负：结算面板自动弹出（服务端判的负，客户端要跟上）',
  lost && lossPanel.overlay && /核心被摧毁/.test(lossPanel.title),
  `结果=${await js(`__frostfall.match.result`)} · 标题「${lossPanel.title}」· 面板可见=${lossPanel.overlay}`);
check('§130 联机结算面板也要写「声望 +N」（以前只有单机那半写，联机这半只弹了个 toast）',
  lost && gotRep && (lossPanel.extra?.gain ?? 0) > 0 && /声望 \+\d+/.test(lossPanel.body),
  `extra=${JSON.stringify(lossPanel.extra)} · 面板正文「${lossPanel.body}」`);
check('§131 普通胜负的结局面板**不该**出现「继续（无尽）」',
  await js(`document.getElementById('btnEndless').classList.contains('hidden')`));

/* ---------- §131 防守：守住第 4 轮后转无尽，面板要留一个「继续（无尽）」出口 ---------- */

// 真实对局里这一刻要等 12 分钟，用调试钩子造出来（`?endless=1`：assault.endless = true + 判定为胜）
const endlessRoom = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/create?mode=defense&map=def_01&endless=1`)).json();
const endlessUrl = new URL(url);
endlessUrl.search = '';
endlessUrl.searchParams.set('room', endlessRoom.code);
endlessUrl.searchParams.set('mode', 'defense');
endlessUrl.searchParams.set('map', 'def_01');
endlessUrl.searchParams.set('notutorial', '1');
await send('Page.navigate', { url: endlessUrl.toString() });
await send('Page.bringToFront');
await waitFor(`__frostfall.match.assault?.endless === true`, 12000);
await sleep(400);
check('§131 防守通关转无尽：结局面板多一个「继续（无尽）」出口（以前只能看着面板）',
  await js(`!document.getElementById('btnEndless').classList.contains('hidden')
    && !document.getElementById('overlay').classList.contains('hidden')`),
  `面板可见=${await js(`!document.getElementById('overlay').classList.contains('hidden')`)}`
  + ` · 按钮=${await js(`[...document.querySelectorAll('#overlay button')].filter((b) => b.offsetParent && !b.classList.contains('hidden')).map((b) => b.textContent.trim()).join('/')`)}`);
const endlessT0 = await js(`+__frostfall.match.time.toFixed(1)`);
await click('#btnEndless');
await sleep(1200);
const endlessAfter = await js(`({t: +__frostfall.match.time.toFixed(1),
  overlay: !document.getElementById('overlay').classList.contains('hidden')})`);
check('§131 点「继续（无尽）」→ 面板收起、对局继续推进（无尽真的打得上）',
  !endlessAfter.overlay && endlessAfter.t > endlessT0,
  `面板=${endlessAfter.overlay} · 对局时间 ${endlessT0}s → ${endlessAfter.t}s`);

// 单机那半要单独验：联机的「时间在走」是服务端推的，验不到客户端**自己的**模拟循环
// （以前 `match.result` 一被设上，单机就停表 → 无尽阶段根本跑不起来）
const soloUrl = new URL(url);
soloUrl.search = '';
soloUrl.searchParams.set('mode', 'defense');
soloUrl.searchParams.set('map', 'def_01');
soloUrl.searchParams.set('notutorial', '1');
soloUrl.searchParams.set('skipstart', '1');
await send('Page.navigate', { url: soloUrl.toString() });
await send('Page.bringToFront');
await waitFor(`!!__frostfall.match && __frostfall.match.mode === 'defense'`, 10000);
await js(`(()=>{const m=__frostfall.match; m.stats.roundsCleared = 4; m.assault.endless = true; m.result = 'win'; return true;})()`);
const soloT0 = await js(`+__frostfall.match.time.toFixed(1)`);
await sleep(1000);
const soloT1 = await js(`+__frostfall.match.time.toFixed(1)`);
check('§131 单机防守通关后**继续跑模拟**（以前 result 一设就停表，无尽跑不起来）',
  soloT1 > soloT0 + 0.5, `对局时间 ${soloT0}s → ${soloT1}s`);

/* ---------- 快速匹配（§1.5）：点按钮 → 服务端分桶 → 拿到房间与座位 ---------- */

/* ---------- §149 联机结算的「伤害占比」：真打一局再判（面板上要真的有条） ---------- */

// `?resultAfter=12`：房间先真打 12 秒再判负 —— 建一座塔、提前开波，让服务端真的记上伤害。
// 这一页原先验不到：`?result=lose` 是建房那一刻就判定，那一局根本没打过，伤害账本必然是空的。
const dmgRoom = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/create?mode=td&map=map_01&result=lose&resultAfter=12`)).json();
const dmgUrl = new URL(url);
dmgUrl.search = '';
dmgUrl.searchParams.set('room', dmgRoom.code);
dmgUrl.searchParams.set('map', 'map_01');
dmgUrl.searchParams.set('notutorial', '1');
await send('Page.navigate', { url: dmgUrl.toString() });
await send('Page.bringToFront');
await waitFor(`!!__frostfall.view?.net?.connected`, 10000);
await sleep(600);
const dmgSlot = await pickSlot();
await clickSlot(dmgSlot);
await click('#wheel button');                        // 第一项 = 箭塔
await sleep(300);
await click('#btnEarly');                            // 提前开波 → 怪真的来，塔真的打
await waitFor(`__frostfall.match.result === 'lose'`, 20000);
await sleep(600);                                    // 等结算推送（伤害账本随 profile 一起来）
const dmgPanel = await js(`({say: document.getElementById('resultDamage').textContent.trim(),
  rows: document.querySelectorAll('#resultDamage .dmg-row').length,
  mirror: Object.keys(__frostfall.match.stats.damage ?? {}).length})`);
check('§149 联机结算面板的伤害占比不为空（服务端随结算把账本推回来，客户端补进镜像）',
  dmgPanel.rows > 0 && dmgPanel.mirror > 0 && !/没有记录到伤害/.test(dmgPanel.say),
  `占比条 ${dmgPanel.rows} 条 · 镜像里有 ${dmgPanel.mirror} 个来源 · 面板文案「${dmgPanel.say.slice(0, 60)}」`);

const matchUrl = new URL(url);
matchUrl.search = '';
matchUrl.searchParams.set('notutorial', '1');
await send('Page.navigate', { url: matchUrl.toString() });
await sleep(1500);
check('快速匹配：大厅里有这个入口', await js(`!!document.getElementById('btnMatch')`));
const matchClick = await click('#btnMatch');
await waitFor(`__frostfall.view?.net?.roomCode`, 8000);
await sleep(400);
check('快速匹配：点它就排进服务端的桶，并拿到房间与座位（§1.5）',
  matchClick === 'ok' && await js(`!!__frostfall.view?.net?.roomCode`)
  && await js(`__frostfall.view?.net?.slot === 0`)
  && /match=1/.test(await js(`location.search`)),
  `房间 ${await js(`__frostfall.view?.net?.roomCode`)} · 座位 ${await js(`__frostfall.view?.net?.slot`)} · URL ${await js(`location.search`)}`);
check('快速匹配：进房后走的是同一套联机界面（队列只负责「找局」）',
  await js(`!!__frostfall.match && document.getElementById('startScreen').classList.contains('hidden')`));
// §152：排队期间服务端**一份快照都不发**，所以玩家看到的是一块冻住的战场（时间停在 0）。
// 以前徽标只写「房间 XXX · 1 人 · 0ms」——不说在等什么、还要等多久（这条同时钉住「时间真的是 0」，
// 否则这条检查会变成空跑）。
check('§152 排队中要写明「在等」（以前只有一块冻住的战场 + 房间号）',
  await js(`__frostfall.match.time === 0 && /匹配中/.test(document.getElementById('netBadge').textContent)`),
  `对局时间 ${await js(`__frostfall.match.time`)} · 徽标「${await js(`document.getElementById('netBadge').textContent`)}」`);

/* ---------- 联机指令：UI 的每一次操作都要**真的回到服务端**（不是只改本地镜像） ---------- */

// 之前只验过「建塔」这一条走服务端；其余十几条指令（升级/优先级/出售/技能/购买/提前开波…）
// 在联机下有没有真的发出去、服务端认不认，从来没验过——如果哪个 handler 忘了走 net，
// 本地会先变、下一份快照又把它打回去，玩家看到的是一次「自己弹回来的操作」。
// 断法统一：**操作 UI → 等服务端快照把镜像改成预期值**（镜像只由快照改写，所以这就等于「服务端做了」）。
const cmdRoom = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/create?mode=td&map=map_01`)).json();
// 前面几节把「整图可见」关掉并存了档（滚轮缩放那条用例）——新开的页面会继承，塔位就点不到了。
// 这一节要的是「能点到塔位」，先把设置写回去（同 §95 的做法）
await js(`(()=>{const s=JSON.parse(localStorage.getItem('frostfall:settings') ?? '{}');
  s.tdFitAll=true; localStorage.setItem('frostfall:settings', JSON.stringify(s)); return true;})()`);
const cmdUrl = new URL(url);
cmdUrl.search = '';
cmdUrl.searchParams.set('room', cmdRoom.code);
cmdUrl.searchParams.set('mode', 'td');
cmdUrl.searchParams.set('map', 'map_01');
cmdUrl.searchParams.set('notutorial', '1');
await send('Page.navigate', { url: cmdUrl.toString() });
await sleep(1800);
await waitFor(`__frostfall.view?.net?.connected === true`, 8000);
const cmdSlot = await pickSlot();
check('前置：能找到一座点得到的塔位（相机整图可见）', cmdSlot >= 0, `塔位 ${cmdSlot}`);
if (cmdSlot >= 0) await clickSlot(cmdSlot);
await sleep(150);
await click('#wheel button');
await waitFor(`__frostfall.match.towers.length === 1`, 5000);

await clickSlot(cmdSlot);                       // 点自己的塔 → 塔面板
await sleep(250);
const upClicked = await click('#btnUpgrade');
const upOk = await waitFor(`__frostfall.match.towers[0]?.level === 2`, 5000);
check('联机指令② 升级：点面板的升级 → 服务端把塔升到 2 级（快照回来才算）',
  upClicked === 'ok' && upOk, `点击=${upClicked} · 塔等级 ${await js(`__frostfall.match.towers[0]?.level`)}`);

await clickSlot(cmdSlot);
await sleep(250);
const prioClicked = await js(`(()=>{const b=[...document.querySelectorAll('#prioRow button')].find((x)=>x.textContent==='最强');
  if(!b) return 'no-button'; b.click(); return 'ok';})()`);
const prioOk = await waitFor(`__frostfall.match.towers[0]?.priority === 'strongest'`, 5000);
check('联机指令③ 优先级：点「最强」→ 服务端改了（快照回来才算）',
  prioClicked === 'ok' && prioOk, `点击=${prioClicked} · 优先级 ${await js(`__frostfall.match.towers[0]?.priority`)}`);

// 技能：点第一个可用技能，冷却要从**快照**里回来（本地只发指令，不自己算冷却）
const skillClicked = await js(`(()=>{const b=document.querySelector('#skillRow .skill');
  if(!b || b.disabled) return 'no-button'; b.click(); return 'ok';})()`);
const skillOk = await waitFor(`(__frostfall.match.hero.skillCd ?? []).some((c) => c > 0)`, 5000);
check('联机指令④ 技能：点技能键 → 服务端进冷却（本地不自己算）',
  skillClicked === 'ok' && skillOk, `点击=${skillClicked} · 冷却 ${JSON.stringify(await js(`__frostfall.match.hero.skillCd`))}`);

// 购买：开商店买第一件（波次里要读条 3 秒，所以等久一点：背包里有东西才算到货）
await click('#btnShop');
await sleep(300);
const cmdBuyClicked = await js(`(()=>{const b=document.querySelector('#shopList button');
  if(!b || b.disabled) return 'no-button'; b.click(); return 'ok';})()`);
const buyOk = await waitFor(`Object.values(__frostfall.match.bag ?? {}).some((n) => n > 0)`, 8000);
check('联机指令⑤ 购买：点商店 → 服务端发货（私人快照里背包有货）',
  cmdBuyClicked === 'ok' && buyOk, `点击=${cmdBuyClicked} · 背包 ${JSON.stringify(await js(`__frostfall.match.bag`))}`);
await click('#shopPanel [data-close]');

// 提前开波：点一下 → 波次要往前走
const waveBeforeEarly = await js(`__frostfall.match.wave.index`);
const earlyClicked = await click('#btnEarly');
const earlyOk = await waitFor(`__frostfall.match.wave.index > ${waveBeforeEarly} || __frostfall.match.wave.phase !== 'prep'`, 6000);
check('联机指令⑥ 提前开波：点按钮 → 服务端把波次推起来',
  earlyClicked === 'ok' && earlyOk, `点击=${earlyClicked} · 第 ${waveBeforeEarly} 波 → 第 ${await js(`__frostfall.match.wave.index`)} 波/${await js(`__frostfall.match.wave.phase`)}`);
// §165：开波之后场上就有怪了——镜像里**每只怪的 hp 都必须 ≤ maxHp**（血条画的是这个比值）。
// 以前快照不发 maxHp，镜像拿 `def.hp` 当分母，噩梦/多人/长局 Boss 的血条会长时间显示满血。
const monBars = await waitFor(`__frostfall.match.monsters.length > 0`, 6000);
check('§165 联机镜像里怪物的 maxHp 由服务端给（血条不会长时间假装满血）',
  monBars && await js(`__frostfall.match.monsters.every((mo) => mo.maxHp > 0 && mo.hp <= mo.maxHp)`),
  `场上 ${await js(`__frostfall.match.monsters.length`)} 只 · ${await js(`JSON.stringify(__frostfall.match.monsters.slice(0,3).map((mo)=>Math.round(mo.hp)+'/'+Math.round(mo.maxHp)+'='+(mo.hp/mo.maxHp).toFixed(2)))`)}`);

// 出售：两步确认之后塔要从快照里消失（房主自己的塔、服务端才认）
await clickSlot(cmdSlot);
await sleep(250);
await click('#btnSell');
await sleep(200);
const sellClicked = await click('#btnSell');
const sellOk = await waitFor(`__frostfall.match.towers.length === 0`, 5000);
check('联机指令⑦ 出售：两步确认后塔从服务端消失（快照里也没了）',
  sellClicked === 'ok' && sellOk, `点击=${sellClicked} · 塔 ${await js(`__frostfall.match.towers.length`)}`);

/* ---------- §1.5 房间码没命中：服务端会另起一间，**必须说出来** ---------- */

// 服务端日志写的是「码 X 不存在，新建」——不说出来的话，玩家会以为进了朋友的房、一个人干等。
// 用 URL 直接进（`#btnJoinRoom` 的实现就是 `location.href = ?room=CODE`；
// 直接点它会触发页面跳转，CDP 的 evaluate 有可能等不到返回——第一版就这么挂死的，见验证记录 §102.2）
const badJoinUrl = new URL(lobbyUrl('?notutorial=1'));
badJoinUrl.searchParams.set('room', 'TYPO99');
await send('Page.navigate', { url: badJoinUrl.toString() });
await sleep(1500);
await waitFor(`!!__frostfall.view?.net?.roomCode`, 8000);
await sleep(400);
const badJoin = await js(`({code: __frostfall.view?.net?.roomCode, notice: __frostfall.view?.net?.notice ?? null,
  toast: document.getElementById('toast').textContent})`);
check('§1.5 输入不存在的房间码：要明说「已新建房间 X」，且新房间号与原码不同',
  badJoin.code !== 'TYPO99' && /TYPO99/.test(badJoin.notice ?? '') && /新建房间/.test(badJoin.notice ?? ''),
  `新房间 ${badJoin.code} · 提示「${badJoin.notice}」· toast「${badJoin.toast}」`);

// §1.5 / §102：**房间配置以服务端为准**。客户端镜像按自己「上次配置」建，
// 一个刚打完防守的玩家用房间码进 TD 房时，镜像是防守形状——第一份 TD 快照就会抛异常
// （`applyShared` 去写不存在的 `m.core.hp`，整页报未捕获异常）。
// 这里故意带着**错的模式**进一个 TD 房，看客户端会不会被纠正。
const tdRoom = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/create?mode=td&map=map_01`)).json();
const wrongModeUrl = new URL(lobbyUrl('?notutorial=1'));
wrongModeUrl.searchParams.set('room', tdRoom.code);
wrongModeUrl.searchParams.set('mode', 'defense');   // 故意带错
wrongModeUrl.searchParams.set('map', 'def_01');
await send('Page.navigate', { url: wrongModeUrl.toString() });
await sleep(3000);   // 客户端会按 hello 里的配置**自动重载一次**对齐，多等一会儿
const aligned = await js(`({mode: __frostfall.match.mode === 'defense' ? 'defense' : 'td',
  mapId: __frostfall.match.mapId, hasCore: !!__frostfall.match.core, hasCastle: !!__frostfall.match.castle,
  room: __frostfall.view?.net?.roomCode ?? null, search: location.search,
  cfg: __frostfall.view?.net?.config ?? null})`);
check('§1.5 用房间码进房：镜像按服务端配置对齐（带错模式也会被纠正，而不是崩掉）',
  aligned.mode === 'td' && aligned.mapId === 'map_01' && aligned.hasCore && !aligned.hasCastle
  && aligned.room === tdRoom.code && aligned.cfg?.mode === 'td' && /aligned=1/.test(aligned.search),
  `镜像 ${aligned.mode}/${aligned.mapId}（core=${aligned.hasCore} castle=${aligned.hasCastle}）`
  + ` · 房间 ${aligned.room}（服务端配置 ${JSON.stringify(aligned.cfg)}）· search ${aligned.search}`);
// 反方向 + 换图：防守房是 def_02（10 个工事位），客户端却带着 def_01（8 个）——镜像不换的话
// `applyDefenseShared` 会按服务端的工事位下标去写 `m.def.fortSlots[i].cell`，第 9 个就越界
const defRoom2 = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/create?mode=defense&map=def_02`)).json();
const wrongMapUrl = new URL(lobbyUrl('?notutorial=1'));
wrongMapUrl.searchParams.set('room', defRoom2.code);
wrongMapUrl.searchParams.set('mode', 'defense');
wrongMapUrl.searchParams.set('map', 'def_01');
await send('Page.navigate', { url: wrongMapUrl.toString() });
await sleep(3000);
const alignedDef = await js(`({mode: __frostfall.match.mode === 'defense' ? 'defense' : 'td',
  mapId: __frostfall.match.mapId, slots: __frostfall.match.def?.fortSlots?.length ?? 0,
  hasCastle: !!__frostfall.match.castle, room: __frostfall.view?.net?.roomCode ?? null,
  cfg: __frostfall.view?.net?.config ?? null})`);
check('§1.5 带错**地图**进防守房（def_01 → def_02）：镜像也要对齐（工事位数量跟着换）',
  alignedDef.mode === 'defense' && alignedDef.mapId === 'def_02' && alignedDef.slots === 10
  && alignedDef.hasCastle && alignedDef.room === defRoom2.code && alignedDef.cfg?.mapId === 'def_02',
  `镜像 ${alignedDef.mode}/${alignedDef.mapId}（工事位 ${alignedDef.slots}）· 房间 ${alignedDef.room}`
  + `（服务端配置 ${JSON.stringify(alignedDef.cfg)}）`);

/* ---------- §163 联机长局：加入者的镜像也要拿到 30 波的波次表 ---------- */

// `hello.config` 以前只有 模式+地图+难度 —— 长局（30 波）的信息没带，加入者按自己的「上次配置」
// 建镜像，于是 HUD 一直写「第 N / 12 波」，第 13 波起的「下一波预告」全是「—」（§6.2 靠它看护甲）。
const longRoom = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/create?mode=td&map=map_01&length=long`)).json();
const longJoinUrl = new URL(url);
longJoinUrl.search = '';
longJoinUrl.searchParams.set('room', longRoom.code);
longJoinUrl.searchParams.set('mode', 'td');
longJoinUrl.searchParams.set('map', 'map_01');
longJoinUrl.searchParams.set('length', 'short');   // 故意带错：客户端应当被服务端纠正
longJoinUrl.searchParams.set('notutorial', '1');
await send('Page.navigate', { url: longJoinUrl.toString() });
await send('Page.bringToFront');
await waitFor(`__frostfall?.match?.waves?.length === 30`, 12000);
const longMirror = await js(`({waves: __frostfall.match.waves.length, length: __frostfall.match.length,
  label: document.getElementById('waveLabel').textContent, url: location.search})`);
// 第 13 波起短表查不到 → 以前预告直接「—」；对齐之后要能报出这一波有什么怪
await js(`(()=>{__frostfall.match.wave.index = 12; return true;})()`);
await sleep(400);
const longPreview = await js(`document.getElementById('nextWaveLabel').textContent`);
check('§163 进长局房（30 波）：镜像换成 30 波的表，「下一波预告」第 13 波起也报得出内容',
  longMirror.waves === 30 && longMirror.length === 'long' && /\/\s*30\s*波/.test(longMirror.label)
  && longPreview.length > 1 && longPreview !== '—',
  `waves=${longMirror.waves} · length=${longMirror.length} · 标签「${longMirror.label}」 · 第 13 波预告「${longPreview}」`);

/* ---------- §166 联机房的英雄职业：加入者要按房主的英雄对齐 ---------- */

// M0.5 是一房一个英雄（服务端只有 `m.hero`）。加入者按自己大厅选的职业建镜像 → 技能栏写着
// 自己那个职业的技能名、属性栏也是别人的数。这里故意「带着法师进战士房」，看镜像与界面会不会被纠正。
const heroRoom = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/create?mode=td&map=map_01&hero=hero_warrior`)).json();
const heroJoinUrl = new URL(url);
heroJoinUrl.search = '';
heroJoinUrl.searchParams.set('room', heroRoom.code);
heroJoinUrl.searchParams.set('mode', 'td');
heroJoinUrl.searchParams.set('map', 'map_01');
heroJoinUrl.searchParams.set('hero', 'hero_mage');   // 故意带错：我自己选的是法师
heroJoinUrl.searchParams.set('notutorial', '1');
await send('Page.navigate', { url: heroJoinUrl.toString() });
await send('Page.bringToFront');
const heroAligned = await waitFor(`__frostfall?.match?.hero?.def?.id === 'hero_warrior'`, 12000);
await sleep(300);
const heroMirror = await js(`({id: __frostfall.match.hero.def.id,
  skills: __frostfall.match.hero.def.skills.map((s) => s.name).join('/'),
  ui: [...document.querySelectorAll('#skillRow button')].map((b) => b.querySelector('span')?.textContent?.trim() ?? '').join('/'),
  url: location.search})`);
check('§166 带着法师进战士房：镜像与技能栏都换成房主的英雄（一房一个英雄）',
  heroAligned && heroMirror.id === 'hero_warrior' && heroMirror.skills === '旋风斩/战吼'
  && heroMirror.ui.includes('旋风斩') && !heroMirror.ui.includes('暴风雪'),
  `镜像英雄=${heroMirror.id} · 技能=${heroMirror.skills} · 技能栏「${heroMirror.ui}」 · URL ${heroMirror.url}`);

/* ---------- §113 联机局里的「回大厅 / 再开一局」必须先离房 ---------- */

// §114：联机局没有暂停、也没有本地加速——以前「暂停」会弹一块写着「塔与波次都已冻结」的遮罩，
// 把屏幕挡住，玩家一边读「已冻结」一边看核心被推掉；`view.rate` 在联机下更是死变量（只有本地
// update 循环读它）。§1.8/§1569 对多人局的措辞是「挂机不判负、**塔继续自动攻击**」。
const pauseClick = await click('#btnPause');
await sleep(200);
const paused2 = await js(`({paused: __frostfall.view.paused,
  overlay: !document.getElementById('overlay').classList.contains('hidden'),
  title: document.getElementById('overTitle').textContent,
  toast: document.getElementById('toast').textContent})`);
check('§114 联机点「暂停」：不弹「已冻结」遮罩，改说人话（服务端继续推进）',
  pauseClick === 'ok' && paused2.paused !== true && !paused2.overlay && /多人局没有暂停/.test(paused2.toast),
  `点击=${pauseClick} · paused=${paused2.paused} · 遮罩=${paused2.overlay} · toast「${paused2.toast}」`);
await click('#btnSpeed');
await sleep(200);
const speed2 = await js(`({rate: __frostfall.view.rate, label: document.getElementById('btnSpeed').textContent,
  toast: document.getElementById('toast').textContent})`);
check('§114 联机点「加速」：不改本地倍速（标签仍是 1×），并说明由服务端决定',
  speed2.rate === 1 && speed2.label === '1×' && /多人局没有加速/.test(speed2.toast),
  `rate=${speed2.rate} · 标签 ${speed2.label} · toast「${speed2.toast}」`);
// §14.3 稿 10 要的第二条文案（多人掉线只有 5 分钟）。直接喂状态给渲染函数——
// 真掉线只有 ~300ms 就重连回来了，靠 sleep 去抢那个窗口是会假红的
const badgeCopy = await js(`(()=>{const el=document.getElementById('netBadge');
  __frostfall.renderNetBadge({ connected: false, players: [] }); return el.textContent;})()`);
check('§114 联机掉线的徽标文案要写清「5 分钟内可回原座」',
  /重连中.*5 分钟/.test(badgeCopy), badgeCopy);
await js(`__frostfall.renderNetBadge(__frostfall.view.net)`);   // 还原成真实状态

// 以前这两条只重置本地镜像：服务端那一局还在，10Hz 的快照立刻把状态推回来（「再开一局」点了没反应），
// 「回大厅」更绝——`setupStartScreen` 见到 `online` 就 return、`#startScreen` 一直 hidden、结算面板又被
// `view.inLobby` 藏掉，最后是**一块冻住的战场、零个可点按钮**，只能自己刷新页面。
await js(`__frostfall.view.paused = true`);         // 暂停面板里也有这两个按钮（结算面板同一对）
await sleep(200);
// 存档清空再走：离房那一瞬间 `pagehide` 会看到 `net` 已经是 null，差点把**联机镜像**写进本地存档
// ——大厅于是多出一个「继续上局」，点进去是一局没有服务端的鬼局（§113 的同一条根因）。
await js(`localStorage.removeItem('frostfall:save')`);
const homeClick = await click('#btnLobby');
check('§113 联机：结算/暂停共用那排按钮里「回大厅」可点（不是被藏起来的按钮）', homeClick === 'ok',
  `点击=${homeClick} · paused=${await js(`__frostfall.view.paused`)}`
  + ` · overlay 可见=${await js(`!document.getElementById('overlay').classList.contains('hidden')`)}`
  + ` · net=${await js(`__frostfall.view?.net?.connected ?? null`)}`);
const backHome = await waitFor(`!!window.__frostfall
  && !document.getElementById('startScreen').classList.contains('hidden')`, 8000);
await sleep(500);
const home = await js(`({search: location.search, net: !!__frostfall.net,
  hidden: document.getElementById('startScreen').classList.contains('hidden'),
  save: localStorage.getItem('frostfall:save'),
  resume: !!document.getElementById('btnResumeSave'),
  buttons: [...document.querySelectorAll('#startScreen button')].filter((b) => b.offsetParent).length})`);
check('§113 联机：点「回大厅」→ 真的离房（连接关掉、URL 不再带房间码）',
  backHome && !home.net && !/room=/.test(home.search) && !/online=1/.test(home.search),
  `URL ${home.search} · net=${home.net}`);
check('§113 联机：点「回大厅」后大厅界面真的出现（以前是零个可点按钮的死路）',
  !home.hidden && home.buttons >= 6, `大厅按钮 ${home.buttons} 个 · hidden=${home.hidden}`);
check('§113 联机：离房不会把联机镜像写成本地存档（大厅不该冒出「继续上局」）',
  home.save === null && !home.resume,
  `存档 ${home.save === null ? '空' : home.save.slice(0, 40)} · 继续上局按钮=${home.resume}`);

// 「再开一局」：同一套配置新开一间。断「房间码变了」而不是「连上了」——
// 重载前旧页面也读得到旧房间码，只断 connected 会读到跳转前的值（§105 踩过同样的坑）。
const restartRoom = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/create?mode=td&map=map_01`)).json();
const restartUrl = new URL(lobbyUrl('?notutorial=1'));
restartUrl.searchParams.set('room', restartRoom.code);
restartUrl.searchParams.set('mode', 'td');
restartUrl.searchParams.set('map', 'map_01');
await send('Page.navigate', { url: restartUrl.toString() });
await sleep(2000);
const restartPaused = await js(`(()=>{__frostfall.view.paused = true; return __frostfall.view.paused;})()`);
await sleep(200);
const rerunClick = await click('#btnRestart');
check('§113 联机：「再开一局」可点', rerunClick === 'ok',
  `点击=${rerunClick} · paused=${restartPaused}`
  + ` · overlay 可见=${await js(`!document.getElementById('overlay').classList.contains('hidden')`)}`
  + ` · net=${await js(`__frostfall.view?.net?.connected ?? null`)}`);
const newRoom = await waitFor(`__frostfall.view?.net?.roomCode
  && __frostfall.view.net.roomCode !== '${restartRoom.code}'`, 10000);
const rerun = await js(`({room: __frostfall.view?.net?.roomCode ?? null, connected: !!__frostfall.view?.net?.connected,
  t: Math.round(__frostfall.match.time), towers: __frostfall.match.towers.length})`);
check('§113 联机：点「再开一局」→ 换了一间新房（新房间码，不是被旧快照推回原地）',
  newRoom && rerun.connected && rerun.room !== restartRoom.code,
  `房间 ${restartRoom.code} → ${rerun.room} · 局内 ${rerun.t} 秒 / ${rerun.towers} 塔`);

/* ---------- §10.3 进不去房间 → 转单人继续（以前只剩一块冻住的画面） ---------- */

// `/create?wave=4` 把房间推到第 4 波（越过 §12.3 的中途加入窗口），新面孔进必被拒。
// 文档原话：「超过 5 分钟则以『当前波次进度 + 个人资产』重建单机态继续」——这条以前没实现。
const busyRoom = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/create?mode=td&map=map_01&wave=4`)).json();
const busyUrl = new URL(lobbyUrl('?notutorial=1'));
busyUrl.searchParams.set('room', busyRoom.code);
// **显式带上 mode/map**：不带的话客户端会按「上次配置」建镜像，还会把 lastChoice 写成那个模式，
// 后面的用例（默认 TD 的四处假设）就跟着飘——§2.1 的回填里记过这个坑，我这轮又踩了一次
busyUrl.searchParams.set('mode', 'td');
busyUrl.searchParams.set('map', 'map_01');
await send('Page.navigate', { url: busyUrl.toString() });
await sleep(1500);
await waitFor(`__frostfall.view?.net === null || __frostfall.view?.net?.error`, 8000);
await sleep(600);
const t0Solo = await js(`+__frostfall.match.time.toFixed(1)`);
await sleep(1200);
const solo = await js(`({net: !!__frostfall.view?.net, t: +__frostfall.match.time.toFixed(1),
  wave: __frostfall.match.wave.index, phase: __frostfall.match.wave.phase,
  badge: document.getElementById('netBadge').classList.contains('hidden'),
  toast: document.getElementById('toast').textContent})`);
check('§10.3 进不去房间（中途加入窗口已过）→ 客户端转单人继续，画面**继续跑**而不是冻住',
  !!solo && !solo.net && solo.t > (t0Solo ?? 0) + 0.8 && solo.badge && /单人继续/.test(solo.toast),
  `net=${solo?.net} · 时间 ${t0Solo} → ${solo?.t} · 第 ${solo?.wave} 波/${solo?.phase}`
  + ` · 徽标隐藏=${solo?.badge} · toast「${solo?.toast}」 · 页面错误 ${JSON.stringify(pageErrors.slice(-2))}`);

/* ---------- 服务端不在时的建房：要给一句人话，别把界面带崩 ---------- */

const offlineUrl = new URL(url);
offlineUrl.search = '';
offlineUrl.searchParams.set('notutorial', '1');
await send('Page.navigate', { url: offlineUrl.toString() });
await sleep(1800);
await js(`window.fetch = () => Promise.reject(new Error('offline'));`);   // 模拟「服务端没开」
await click('#btnCreateRoom');
await sleep(600);
check('建房失败：服务端不在时要提示「创建失败」而不是静默',
  (await js(`document.getElementById('startHint').textContent`)).includes('创建失败'),
  await js(`document.getElementById('startHint').textContent`));
check('建房失败：失败后大厅还能用（单人开局照样进得去）',
  (await click('#btnSolo')) === 'ok'
  && await js(`!__frostfall.match.result && document.getElementById('startScreen').classList.contains('hidden')`));

/* ---------- 联机 · 防守：建房那一步必须把 mode 一起带上（曾经漏传 → 500） ---------- */

await send('Page.navigate', { url: onlineUrl.toString() });
await sleep(2000);
await click('#optMode button:nth-child(2)');
await sleep(300);
check('联机防守：大厅能切到防守生存', (await js(`document.querySelector('#optMode button.on').textContent`)).includes('防守'));
check('联机防守：大厅有「创建联机房间」按钮', (await click('#btnCreateRoom')) === 'ok');
await sleep(1500);
await waitFor('!!__frostfall.view?.net?.roomCode && !document.getElementById("minimapBox").classList.contains("hidden")', 15000);
check('联机防守：建出的是防守局（城堡/工事 HUD + 房间码）',
  !!await js(`__frostfall.view?.net?.roomCode`)
  && await js(`__frostfall.match.mode === 'defense'`)
  && await js(`!document.getElementById('defensePanel').classList.contains('hidden')`)
  && await js(`!document.getElementById('minimapBox').classList.contains('hidden')`),
  `房间 ${await js(`__frostfall.view?.net?.roomCode`)} · 模式 ${await js(`__frostfall.match.mode`)}`
  + ` · ${await js(`document.getElementById('netBadge').textContent`)}`);
const shotOnlineDef = await screenshot('ff-smoke-online-defense.png');

/* ---------- 结算面板 + 回大厅：玩家每局最后看到的那一屏（用 ?sim 快进到打完） ---------- */

const endUrl = new URL(url);
endUrl.search = '';
endUrl.searchParams.set('notutorial', '1');
endUrl.searchParams.set('mode', 'td');      // §2.1 之后大厅会沿用上次配置，这里显式声明，别靠默认
endUrl.searchParams.set('sim', '700'); endUrl.searchParams.set('debug', '1');   // 客户端启动时先无头快进 700 秒 → 一局已经打完
endUrl.searchParams.set('skipstart', '1');   // 不跳大厅的话，快进完会停在大厅上，看不到结算面板
await js(`localStorage.removeItem('frostfall:save'); localStorage.removeItem('frostfall:profile');`);
await send('Page.navigate', { url: endUrl.toString() });
await sleep(1200);
await waitFor('!document.getElementById("overlay").classList.contains("hidden") && document.getElementById("resultRows").children.length >= 4', 30000);
check('结算：打完一局后结算面板自动弹出（标题 + 本局数据）',
  await js(`!document.getElementById('overlay').classList.contains('hidden')
    && !document.getElementById('resultDetail').classList.contains('hidden')
    && document.getElementById('resultRows').children.length >= 4`),
  `标题「${await js(`document.getElementById('overTitle').textContent`)}」· ${await js(`document.getElementById('overBody').textContent`)}`);
await checkLayout('结算面板（TD 胜局）');
check('结算：伤害占比有分档、掉落与合成有数',
  await js(`document.getElementById('resultDamage').children.length >= 1
    && /掉落/.test(document.getElementById('resultLoot').textContent)`),
  await js(`document.getElementById('resultLoot').textContent.replace(/\\s+/g,' ').slice(0,60)`));
// §151：这一栏以前写的是「weapon blue15」——部位与品质都是内部 id。背包面板早就翻了中文名，
// 结算这半没翻（同一个面板两种写法）。这条就查「英文 id 一个都不许出现」。
check('§151 结算的掉落栏写中文名（部位/品质不许漏内部 id）',
  await js(`!/\\b(weapon|armor|trinket|white|blue|purple|orange)\\b/
    .test(document.getElementById('resultLoot').textContent)`),
  await js(`document.getElementById('resultLoot').textContent.replace(/\\s+/g,' ').slice(0,80)`));
check('结算：这一局记进了局外档案（声望不为 0）',
  await js(`__frostfall && Number((document.getElementById('profileBar').textContent.match(/声望 (\\d+)/) ?? [0,0])[1]) > 0`)
  || await js(`Number((localStorage.getItem('frostfall:profile') ?? '{}').match?.(/"reputation":(\\d+)/)?.[1] ?? 0) > 0`),
  `档案条「${await js(`document.getElementById('profileBar').textContent`)}」`);
const shotResult = await screenshot('ff-smoke-result.png');
check('结算：点「回大厅」真的回到大厅', (await click('#btnLobby')) === 'ok');
await sleep(500);
check('结算：回大厅后换成全新的一局（时间归零、结算收起）',
  await js(`!__frostfall.match.result && __frostfall.match.time < 5 && __frostfall.match.towers.length === 0`),
  `时间 ${await js(`Math.round(__frostfall.match.time)`)}s · 塔 ${await js(`__frostfall.match.towers.length`)}`);

/* ---------- 防守模式的结算：守住 4 轮之后的那一屏（也验一遍野外掉落拾取） ---------- */

const defEndUrl = new URL(url);
defEndUrl.search = '';
defEndUrl.searchParams.set('mode', 'defense');
defEndUrl.searchParams.set('notutorial', '1');
defEndUrl.searchParams.set('skipstart', '1');
defEndUrl.searchParams.set('sim', '900');
defEndUrl.searchParams.set('debug', '1');   // §141：`?sim=` 要显式带 debug 才生效
await js(`localStorage.removeItem('frostfall:profile')`);
await send('Page.navigate', { url: defEndUrl.toString() });
await sleep(1200);
await waitFor('!document.getElementById("overlay").classList.contains("hidden") && document.getElementById("resultRows").children.length >= 4', 30000);
check('防守结算：守住 4 轮后自动弹结算面板（标题 + 本局数据）',
  await js(`!document.getElementById('overlay').classList.contains('hidden')
    && !document.getElementById('resultDetail').classList.contains('hidden')
    && document.getElementById('resultRows').children.length >= 4`),
  `标题「${await js(`document.getElementById('overTitle').textContent`)}」· ${await js(`document.getElementById('overBody').textContent`)}`);
await checkLayout('结算面板（防守胜局）');
check('防守结算：本局数据是防守口径（城堡 / 轮次 / 野外击杀）',
  await js(`/城堡|轮|野外/.test(document.getElementById('resultRows').textContent)`),
  await js(`document.getElementById('resultRows').textContent.replace(/\\s+/g,' ').slice(0,70)`));
check('防守：野外掉落被捡起来并换上了（跑完 4 轮至少 1 件）',
  await js(`__frostfall.match.stats.drops >= 1`)
  && await js(`Object.values(__frostfall.match.equipped).some((x) => !!x)`),
  `掉落 ${await js(`__frostfall.match.stats.drops`)} 件 · 已装备 ${await js(`Object.entries(__frostfall.match.equipped).filter(([,v]) => v).map(([k,v]) => k + ' ' + v.quality + v.ilvl).join(' / ')`)}`);
// §5.2 / §5.4：换上的装备必须**真的进了战斗数值**（以前只进背包界面与品质色，验证记录 §58）。
// 做法：把三件装备临时全摘掉，英雄的「攻+防+血/10+暴击」必须掉下来，然后原样还回去。
check('防守：换上的装备真的进了战斗数值（全摘掉之后数值会掉）',
  await js(`(()=>{const m=__frostfall.match;
    if(!Object.values(m.equipped).some(Boolean)) return false;
    const score=()=>{const x=__frostfall.heroStats(m.hero);return x.attack+x.def+x.maxHp/10+x.critRate*100;};
    const before=score(); const saved={...m.equipped};
    for(const k of Object.keys(m.equipped)) m.equipped[k]=null;
    const after=score();
    Object.assign(m.equipped, saved);
    return after < before - 0.01;})()`),
  await js(`(()=>{const m=__frostfall.match;const x=__frostfall.heroStats(m.hero);
    return '攻击 ' + x.attack.toFixed(1) + ' · 防御 ' + x.def.toFixed(1) + ' · 生命 ' + Math.round(x.maxHp)
      + ' · 暴击 ' + (x.critRate * 100).toFixed(1) + '% · 已装备 ' + Object.values(m.equipped).filter(Boolean).length + ' 件';})()`));
check('防守结算：这一局也记进了局外档案',
  await js(`Number((document.getElementById('profileBar')?.textContent.match(/声望 (\\d+)/) ?? [0,0])[1]) > 0`)
  || await js(`Number(JSON.parse(localStorage.getItem('frostfall:profile') ?? '{}').reputation ?? 0) > 0`),
  `档案「${await js(`document.getElementById('profileBar')?.textContent ?? ''`)}」`);
const shotDefEnd = await screenshot('ff-smoke-defense-result.png');

// §14.3 稿 4：右侧日志面板在防守模式让位、回 TD 必须回来。以前是每帧去 add('hidden')（只加不减），
// 打完一局防守后**整页**的 TD 日志就永远没了——现在改成 CSS 说了算（`#stage.defense .hud-right`），
// 类名每帧 toggle，幂等，不存在「留在元素上」这回事。这里断的是**计算后的样式**，不是某个类。
check('§14.3 稿 4：防守模式下右侧日志面板让位（CSS 生效）',
  await js(`document.getElementById('stage').classList.contains('defense')
    && getComputedStyle(document.getElementById('log').parentElement).display === 'none'`),
  `stage=${await js(`document.getElementById('stage').className`)} · display=${
    await js(`getComputedStyle(document.getElementById('log').parentElement).display`)}`);

/* ---------- 防守的另两张图也要在浏览器里渲染正常（10 / 12 个工事位、多路） ---------- */

// §3.1 #29 之后的收尾：**深链进锁着的图不再放行**（按档案换成已解锁的那张）。
// 冒烟里有十几处是「故意深链到 4-6★ / ★5 图」去验渲染、结算与档案的——它们要的就是那几张图本身，
// 所以先把档案推到「全部解锁」。锁那半由 §3.1 #29 的两条检查守着（那条用的是全新档案）。
// 注意 `bestTimeSec: null`：解锁只看「有没有赢过」，而**留一个假的最快通关会盖掉**后面那些
// 「胜局写最快通关」的检查（§191 就是踩了这个：假记录 1100 秒 < 本局 2105 秒，永远不会被写进去）。
const unlockAllMaps = () => js(`(()=>{const rec=()=>({clears:1,wins:1,bestTimeSec:null,leaks:0,bestCoreHp:1000,bestRounds:4});
  localStorage.setItem('frostfall:profile', JSON.stringify({v:1, reputation:9999, exp:9999, commanderLevel:30,
    clears:{map_01:rec(),map_02:rec(),map_03:rec(),map_04:rec(),map_05:rec(),map_06:rec(),
      def_01:rec(),def_02:rec(),def_03:rec()},
    playCount:9, tutorialDone:true, lastChoice:null, ledger:[]}));
  return true;})()`);
await unlockAllMaps();

for (const [mapId, forts] of [['def_02', 10], ['def_03', 12]]) {
  const mapUrl = new URL(url);
  mapUrl.search = '';
  mapUrl.searchParams.set('mode', 'defense');
  mapUrl.searchParams.set('map', mapId);
  mapUrl.searchParams.set('notutorial', '1');
  mapUrl.searchParams.set('skipstart', '1');
  mapUrl.searchParams.set('sim', '60'); mapUrl.searchParams.set('debug', '1');
  await send('Page.navigate', { url: mapUrl.toString() });
  await sleep(1200);
  await waitFor(`__frostfall.match.mapId === '${mapId}'`, 8000);
  check(`${mapId}：进局后 HUD / 工事位 / 小地图都在`,
    await js(`__frostfall.match.mapId === '${mapId}'
      && __frostfall.match.def.fortSlots.length === ${forts}
      && !document.getElementById('defensePanel').classList.contains('hidden')
      && !document.getElementById('minimapBox').classList.contains('hidden')`),
    `${await js(`__frostfall.match.def.fortSlots.length`)} 个工事位 · 城堡 ${await js(`Math.round(__frostfall.match.castle.hp)`)}`);
  await checkLayout(`${mapId} 开局`);
  check(`${mapId}：跟随相机把英雄放在画面中心附近`,
    await js(`(()=>{const p=__frostfall.renderer.toScreen(__frostfall.match.hero.cell.x, __frostfall.match.hero.cell.y);
      const r=document.getElementById('game').getBoundingClientRect();
      return Math.abs(p.x-r.width/2)<90 && Math.abs(p.y-r.height/2)<90;})()`));
}

/* ---------- 长局（30 波）：自己的波次表与节奏，HUD 必须按 30 波报（§6.4） ---------- */

const longUrl = new URL(url);
longUrl.search = '';
longUrl.searchParams.set('mode', 'td');
longUrl.searchParams.set('length', 'long');
longUrl.searchParams.set('map', 'map_04');
longUrl.searchParams.set('notutorial', '1');
longUrl.searchParams.set('skipstart', '1');
await send('Page.navigate', { url: longUrl.toString() });
await sleep(1500);
await waitFor(`!!__frostfall.match.waves && __frostfall.match.waves.length === 30`, 8000);
const longHud = await js(`({wave: document.getElementById('waveLabel').textContent.trim(),
  waves: __frostfall.match.waves.length, mode: __frostfall.match.length ?? 'short',
  prep: __frostfall.match.wave.timer, preview: document.getElementById('nextWaveLabel').textContent.trim()})`);
check('长局（§6.4）：HUD 按 30 波报，备战期用长局自己的 30 秒',
  // 第一段备战期时波次索引是 0（与短局一致），所以断的是「/ 30 波」而不是写死第 1 波
  longHud.waves === 30 && /^第 \d+ \/ 30 波$/.test(longHud.wave) && longHud.prep > 12 && longHud.prep <= 30,
  `「${longHud.wave}」· 备战 ${Math.round(longHud.prep)}s（短局是 12s）· 下一波「${longHud.preview.slice(0, 40)}」`);

/* ---------- 4-6★ 大图（44×28 / 52×34）：画布尺寸与整图缩放都不一样，得单独验一遍 ---------- */

for (const [mapId, size] of [['map_04', '44×28'], ['map_06', '52×34']]) {
  const bigUrl = new URL(url);
  bigUrl.search = '';
  bigUrl.searchParams.set('map', mapId);
  bigUrl.searchParams.set('mode', 'td');    // 同上：大图验收是 TD 的，别被「上次配置」带到防守
  bigUrl.searchParams.set('notutorial', '1');
  bigUrl.searchParams.set('skipstart', '1');
  bigUrl.searchParams.set('sim', '60'); bigUrl.searchParams.set('debug', '1');
  await send('Page.navigate', { url: bigUrl.toString() });
  await sleep(1200);
  // 等**渲染层也换到大图**：match.mapId 在开局那一刻就有了，但相机的整图缩放要等第一帧才重算。
  // 不然后面按 toScreen 算出来的塔位坐标是旧缩放下的，点过去落不到塔位上（第一版就栽在这）。
  await waitFor(`__frostfall.match.mapId === '${mapId}'
    && (()=>{const m=__frostfall.match, r=__frostfall.renderer; const s=m.map.slots[0];
      const p=r.toScreen(s.x,s.y), b=r.toGrid(p.x,p.y); return b.x===s.x && b.y===s.y;})()`, 10000);
  check(`${mapId}（${size}）大图能渲染，且地图整图落在视口里`,
    await js(`__frostfall.match.map.grid.w === ${mapId === 'map_06' ? 52 : 44}
      && document.getElementById('game').width > 0`),
    `画布 ${await js(`__frostfall.match.map.grid.w`)}×${await js(`__frostfall.match.map.grid.h`)} · 缩放 ${await js(`__frostfall.renderer.scale.toFixed(3)`)}`);
  await checkLayout(`${mapId} 大图`);
  // 大图上点塔位：热区是按「最近塔位 ≤2 格」判的，缩得小也得点得中
  const bigSlot = await pickSlot(true);
  const towersBeforeBig = await js(`__frostfall.match.towers.length`);   // ?sim 快进时 AI 已经造了几座
  await clickSlot(bigSlot);
  const wheelOpen = await js(`!document.getElementById('wheel').classList.contains('hidden')`);
  const built = wheelOpen
    ? ((await click('#wheel button')) === 'ok' && await js(`__frostfall.match.towers.length === ${towersBeforeBig + 1}`))
    : false;
  check(`${mapId}：大图上点塔位能开轮盘并建起来`, wheelOpen && built,
    `塔位 #${bigSlot} · 轮盘 ${wheelOpen} · 塔 ${await js(`__frostfall.match.towers.length`)}`
    + ` · selectedSlot ${await js(`__frostfall.view.selectedSlot`)} · 缩放 ${await js(`__frostfall.renderer.scale.toFixed(3)`)}`
    + ` · toast「${await js(`document.getElementById('toast').textContent`)}」`);

  // §7.4：5★/6★ 图的塔会被攻城怪拆（塔有血量）→ 面板要能花 60 金修满。
  // 内核那条早有用例（tests/maps-4star.test.js），但**界面接线**从来没在浏览器里验过，
  // 而「修塔」按钮是 openTower 里**动态插进 DOM** 的——动态接线正是最容易坏的地方。
  if (await js(`!!__frostfall.match.map.def.siege`)) {
    // 暂停：这一小段要的是精确的金币差，不能让「击杀赏金」在两次读数之间混进来
    const repair = await js(`(()=>{const m=__frostfall.match, t=m.towers[0]; if(!t) return null;
      __frostfall.view.paused = true;
      m.gold = Math.max(m.gold, 500);          // 修一次 60 金，先把钱备足（这一步是测试铺垫，不是断言）
      t.hp = Math.round(t.maxHp * 0.4);
      __frostfall.ui.openTower(m, t.slot, __frostfall.renderer.toScreen(t.cell.x, t.cell.y));
      return {slot: t.slot, hp: t.hp, maxHp: t.maxHp, gold: Math.round(m.gold)};})()`);
    await sleep(300);
    const repairBtn = await js(`(()=>{const b=document.getElementById('btnRepairTower');
      return b ? {hidden: b.classList.contains('hidden'), text: b.textContent} : null;})()`);
    const repairClick = await click('#btnRepairTower');
    await sleep(300);
    const repaired = await js(`(()=>{const m=__frostfall.match;
      const t=m.towers.find((x)=>x.slot===${repair?.slot});
      __frostfall.view.paused = false;
      return {hp: t?.hp ?? -1, maxHp: t?.maxHp ?? -1, gold: Math.round(m.gold)};})()`);
    check(`${mapId}：塔被砸坏后能花 60 金修满（§7.4 的 UI 接线）`,
      !!repair && repairBtn && !repairBtn.hidden && repairBtn.text === '修塔 60 金'
      && repairClick === 'ok' && repaired.hp === repaired.maxHp && repair.gold - repaired.gold === 60,
      `塔位 ${repair?.slot} · 按钮「${repairBtn?.text}」· 血 ${repair?.hp}→${repaired.hp}/${repaired.maxHp}`
      + ` · 金 ${repair?.gold}→${repaired.gold}`);
  }
}

// 打完防守局回大厅：档案里已经有 def_* 的通关记录，档案条必须还能画出来（曾经在这里抛异常）
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await sleep(2000);
check('防守结算：回大厅后档案条能画出防守图的通关记录',
  await js(`document.getElementById('profileBar').textContent.includes('边陲小镇')`),
  await js(`document.getElementById('profileBar').textContent`));
// §12.6：两个模式的成绩不可比——防守图要写「守住几轮 · 城堡剩多少」，不是 TD 的「最快 mm:ss」
check('§12.6 防守图的战绩用「守住 N 轮」，不是 TD 的「最快通关」',
  await js(`(()=>{const t=document.getElementById('profileBar').textContent;
    return t.includes('守住') && /守.+?轮/.test(t) && !t.includes('边陲小镇 0:') ;})()`),
  `档案条「${await js(`document.getElementById('profileBar').textContent`)}」`);
// 大厅的「重置进度」：打了几局之后点它要真的清空（声望/等级/解锁），不是只改个界面
const resetBefore = await js(`JSON.parse(localStorage.getItem('frostfall:profile') ?? '{}').reputation ?? 0`);
await js(`window.confirm = () => true`);   // 无头里 confirm 默认返回 false，不接管的话这条检查是空的
const resetClicked = await click('#btnResetProfile');
await sleep(500);
const resetAfter = await js(`(()=>{const p=JSON.parse(localStorage.getItem('frostfall:profile') ?? '{}');
  return {rep: p.reputation ?? 0, maps: [...document.querySelectorAll('#optMap .map-card:not(.locked)')].length,
    bar: document.getElementById('profileBar').textContent};})()`);
check('大厅：重置进度真的清空（声望归零、只剩 map_01、档案条跟着变）',
  resetClicked === 'ok' && resetBefore > 0 && resetAfter.rep === 0 && resetAfter.maps === 1
  && resetAfter.bar.includes('声望 0'),
  `点前声望 ${resetBefore} → 点后 ${resetAfter.rep} · 可玩地图 ${resetAfter.maps} 张 · 「${resetAfter.bar}」`);
check('防守结算：大厅正常渲染（地图卡面在、可开局）',
  await js(`document.querySelectorAll('#optMap .map-card').length >= 1
    && !document.getElementById('startScreen').classList.contains('hidden')`));

/* ---------- 失败分支：核心被摧毁 / 城堡陷落（赢的那两个已经验过了） ---------- */

const loseTdUrl = new URL(url);
loseTdUrl.search = '';
loseTdUrl.searchParams.set('map', 'map_01');
loseTdUrl.searchParams.set('mode', 'td');           // 同上：显式声明模式，别沿用上次配置
loseTdUrl.searchParams.set('length', 'long');     // 18 塔位打 30 波：参考打法会卡在最终 Boss（§23.2）
loseTdUrl.searchParams.set('notutorial', '1');
loseTdUrl.searchParams.set('skipstart', '1');
loseTdUrl.searchParams.set('sim', '2000'); loseTdUrl.searchParams.set('debug', '1');
await js(`localStorage.removeItem('frostfall:profile')`);
await send('Page.navigate', { url: loseTdUrl.toString() });
await sleep(1200);
await waitFor("document.getElementById('overTitle').textContent.includes('核心')", 40000);
check('失败分支 TD：核心被打爆后出「核心被摧毁」结算（不是通关）',
  await js(`__frostfall.match.result === 'lose'
    && document.getElementById('overTitle').textContent.includes('核心')
    && !document.getElementById('resultDetail').classList.contains('hidden')`),
  `结果 ${await js(`__frostfall.match.result`)} · 标题「${await js(`document.getElementById('overTitle').textContent`)}」· ${await js(`document.getElementById('overBody').textContent`)}`);

const loseDefUrl = new URL(url);
loseDefUrl.search = '';
loseDefUrl.searchParams.set('mode', 'defense');
// ★★★★★ 双路多线：这里的目的是**造一场败局**来验结算面板，所以要钉住一个会输的种子。
// §24.4 那句「单英雄 AI 守不住第 4 轮」在 §58 接线装备之后只对部分种子成立了
// （12 个种子里 4 个能守住），不能再靠运气——seed 7 实测 758-760s 城堡陷落。
loseDefUrl.searchParams.set('map', 'def_03');
loseDefUrl.searchParams.set('seed', '7');
loseDefUrl.searchParams.set('notutorial', '1');
loseDefUrl.searchParams.set('skipstart', '1');
loseDefUrl.searchParams.set('sim', '1200'); loseDefUrl.searchParams.set('debug', '1');
// §3.1 #29：def_03 是 ★5 图（要「守住 def_02 + 声望 1500」），深链进不去了——先解锁再打，
// 这条要验的是「城堡陷落那一下的结算面板」，不是锁。
await unlockAllMaps();
await send('Page.navigate', { url: loseDefUrl.toString() });
await sleep(1200);
await waitFor("document.getElementById('overTitle').textContent.includes('城堡')", 40000);
check('失败分支防守：城堡陷落也出结算（标题 + 守住轮次）',
  await js(`__frostfall.match.result === 'lose'
    && document.getElementById('overTitle').textContent.includes('城堡')
    && /轮/.test(document.getElementById('resultRows').textContent)`),
  `结果 ${await js(`__frostfall.match.result`)} · 标题「${await js(`document.getElementById('overTitle').textContent`)}」· ${await js(`document.getElementById('overBody').textContent`)}`);
check('失败分支：输了也给声望（§3.6 的 30 点），且档案没崩',
  await js(`Number(JSON.parse(localStorage.getItem('frostfall:profile') ?? '{}').reputation ?? 0) > 0`),
  `档案声望 ${await js(`JSON.parse(localStorage.getItem('frostfall:profile') ?? '{}').reputation ?? 0`)}`);
const shotLose = await screenshot('ff-smoke-lose.png');

/* ---------- §158 4★-6★ 的长局图：大厅里要能选到（不是只有 ?map= 深链） ---------- */

// 先把档案推到「map_01-03 都通关 + 声望 2000」——map_04（通关 map_03 + 声望 800）因此解锁
await js(`(()=>{localStorage.setItem('frostfall:profile', JSON.stringify({v:1, reputation:2000, exp:2000,
  commanderLevel:5, clears:{map_01:{clears:1,wins:1,bestTimeSec:600,leaks:0},
  map_02:{clears:1,wins:1,bestTimeSec:700,leaks:0}, map_03:{clears:1,wins:1,bestTimeSec:800,leaks:0}},
  playCount:3, tutorialDone:true, lastChoice:null, ledger:[]})); return true;})()`);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await send('Page.bringToFront');
await waitFor(`!!window.__frostfall && !document.getElementById('startScreen').classList.contains('hidden')`, 10000);
await sleep(400);
const lobbyMaps = await js(`(()=>{const cards=[...document.querySelectorAll('#optMap .map-card')];
  const lava=cards.find((c)=>c.textContent.includes('熔岩裂谷')) ?? null;
  return {count: cards.length, names: cards.map((c)=>c.querySelector('.mname')?.textContent.trim() ?? '?'),
    lava: lava ? !lava.classList.contains('locked') : null};})()`);
check('§158 大厅的地图清单来自数据表：4★ 图解锁后要出现（以前只有手抄的三张，长局图只能靠深链）',
  lobbyMaps.count === 6 && lobbyMaps.lava === true,
  `卡片 ${lobbyMaps.count} 张：${lobbyMaps.names.join(' / ')} · 熔岩裂谷可点=${lobbyMaps.lava}`);
const pickedLava = await js(`(()=>{const c=[...document.querySelectorAll('#optMap .map-card')].find((x)=>x.textContent.includes('熔岩裂谷'));
  if (!c) return 'no-card'; c.click(); return 'ok';})()`);
await sleep(250);
await click('#btnSolo');
await sleep(700);
check('§158 从大厅点 4★ 图开局：真的开在 map_04（长局内容不再「只有深链能进」）',
  pickedLava === 'ok' && await js(`__frostfall.match.mapId`) === 'map_04',
  `点击=${pickedLava} · mapId=${await js(`__frostfall.match.mapId`)} · 画布=${await js(`JSON.stringify(__frostfall.match.map.grid)`)}`);

/* ---------- §159 真机视口（667×375）下的大厅：动作行要粘在底部 ---------- */

// 大厅在真机视口下是 **971px** 高的面板（设计画布 1334×750 = 667×375pt），「单人开局」原本落在折叠线
// 以下 500 多像素——玩家要滚 2.6 屏才能开局。动作行改成 sticky 之后，任何时候都在屏幕底部
// （§1.9.2 的拇指弧本来也在底部）。
await send('Emulation.setDeviceMetricsOverride', { width: 667, height: 375, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await send('Page.bringToFront');
await waitFor(`!!window.__frostfall && !document.getElementById('startScreen').classList.contains('hidden')`, 10000);
await sleep(500);
const lobbyPhone = await js(`(()=>{const vh=innerHeight; const ids=['btnSolo','btnMatch','btnCreateRoom','btnJoinRoom'];
  const rows=ids.map((id)=>{const r=document.getElementById(id).getBoundingClientRect();
    return {id, top:Math.round(r.top), bottom:Math.round(r.bottom), in: r.top>=-1 && r.bottom<=vh+1};});
  const panel=document.querySelector('#startScreen .panel').getBoundingClientRect();
  const row=document.querySelector('#startScreen .row.center.gap').getBoundingClientRect();
  return {vh, panel:Math.round(panel.height), rows, rowRight:Math.round(row.right), panelRight:Math.round(panel.right),
    stuck: getComputedStyle(document.querySelector('#startScreen .row.center.gap')).position};})()`);
check('§159 真机视口下大厅的动作行粘在底部（面板比屏幕高时也不用滚就能开局）',
  lobbyPhone.vh === 375 && lobbyPhone.panel > lobbyPhone.vh
  && lobbyPhone.stuck === 'sticky' && lobbyPhone.rows.every((r) => r.in)
  && lobbyPhone.rowRight <= lobbyPhone.panelRight + 1,
  `视口 ${lobbyPhone.vh} · 面板 ${lobbyPhone.panel}px · 位置=${lobbyPhone.stuck}`
  + ` · 按钮 ${lobbyPhone.rows.map((r) => `${r.id}:${r.top}-${r.bottom}${r.in ? '' : '✗'}`).join(' ')}`
  + ` · 动作行右缘 ${lobbyPhone.rowRight} / 面板右缘 ${lobbyPhone.panelRight}`);

// §160：结算面板在同一个视口下也是 424px 高，「再开一局 / 回大厅」原本被折叠线切断（y 365~413，
// 只有 10px 露在外面）。动作行同样粘底之后就够得着了——这条用**真的结算页**量（调试钩子造胜局）。
const phoneResultRoom = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/create?map=map_01&mode=td&result=win`)).json();
const phoneResultUrl = new URL(url);
phoneResultUrl.search = '';
phoneResultUrl.searchParams.set('room', phoneResultRoom.code);
phoneResultUrl.searchParams.set('map', 'map_01');
phoneResultUrl.searchParams.set('notutorial', '1');
await send('Page.navigate', { url: phoneResultUrl.toString() });
await send('Page.bringToFront');
await waitFor(`document.getElementById('overTitle').textContent.includes('通关')`, 12000);
await sleep(400);
const phoneResult = await js(`(()=>{const vh=innerHeight;const p=document.getElementById('overPanel');
  const bs=[...p.querySelectorAll('button')].filter((b)=>b.offsetParent!==null).map((b)=>{const r=b.getBoundingClientRect();
    return {id:b.id, top:Math.round(r.top), bottom:Math.round(r.bottom), in: r.top>=-1 && r.bottom<=vh+1};});
  return {vh, panelH:Math.round(p.getBoundingClientRect().height), buttons:bs,
    stuck: getComputedStyle(p.querySelector('.row.center')).position};})()`);
check('§160 真机视口下结算面板的出口（再开一局 / 回大厅）不被折叠线切断',
  phoneResult.vh === 375 && phoneResult.panelH > phoneResult.vh && phoneResult.stuck === 'sticky'
  && phoneResult.buttons.length >= 2 && phoneResult.buttons.every((b) => b.in),
  `视口 ${phoneResult.vh} · 面板 ${phoneResult.panelH}px · 位置=${phoneResult.stuck}`
  + ` · 按钮 ${phoneResult.buttons.map((b) => `${b.id}:${b.top}-${b.bottom}${b.in ? '' : '✗'}`).join(' ')}`);

// §161：真机视口下的**防守 HUD**——这一面以前只在验收视口（1334×750）量过，于是短屏上四组重叠
// （小地图压操作行、技能排压「修城/回城」、小地图顶出屏幕）没人发现。这里把整页版式体检搬到
// 真机视口 + 防守模式：`checkLayout` 里既有「面板不许互相压」也有「不许溢出视口」。
await send('Page.navigate', { url: lobbyUrl('?mode=defense&map=def_01&notutorial=1&skipstart=1') });
await send('Page.bringToFront');
await waitFor(`!!__frostfall?.match && __frostfall.match.mode === 'defense'`, 10000);
await sleep(600);
check('§161 真机视口下的防守 HUD 真的换成了紧凑排布（轮次面板压成两行、小地图缩小）',
  await js(`(()=>{const p=document.getElementById('defensePanel').getBoundingClientRect();
    const m=document.getElementById('minimap').getBoundingClientRect();
    const bars=[...document.querySelectorAll('#defensePanel .bar')].every((b)=>getComputedStyle(b).display==='none');
    return Math.round(p.height) <= 110 && m.width <= 160 && bars;})()`),
  `轮次面板 ${await js(`Math.round(document.getElementById('defensePanel').getBoundingClientRect().height)`)}px`
  + ` · 小地图 ${await js(`Math.round(document.getElementById('minimap').getBoundingClientRect().width)`)}×${await js(`Math.round(document.getElementById('minimap').getBoundingClientRect().height)`)}`
  + ` · 进度条已收 ${await js(`[...document.querySelectorAll('#defensePanel .bar')].every((b)=>getComputedStyle(b).display==='none')`)}`);
await checkLayout('真机视口 667×375 · 防守');
// 之前只有验收视口（1334×750）量过防守的人体工学；§161 的紧凑排布动了轮次面板与小地图，
// 顺手把真机视口下的防守人体工学也量上（技能直径 76-88pt、间距 ≥24pt、落在拇指弧）。
await checkErgonomics('真机视口 667×375 · 防守');

// §162：真机视口下的**新手引导条**——`.hud-tutorial { bottom: 120px }` 是照 750 高的画布定的，
// 短屏上落在 y 189~255，正压在英雄面板（血条）与操作行（商店/背包/暂停）上，而第二步提示
// 恰恰是「点右下『提前开波』马上开打」：让玩家去点被自己盖住的按钮。这条量「引导条不许压任何交互件」。
await js(`localStorage.removeItem('frostfall:profile')`);   // 首次进入才会挂引导
await send('Page.navigate', { url: lobbyUrl('?mode=td&map=map_01') });
await send('Page.bringToFront');
await waitFor(`!!window.__frostfall && !document.getElementById('startScreen').classList.contains('hidden')`, 10000);
await sleep(300);
await click('#btnSolo');
await sleep(700);
const phoneTut = await js(`(()=>{const vh=innerHeight;
  const bar=document.getElementById('tutorialBar').getBoundingClientRect();
  const pick=(sel)=>document.querySelector(sel)?.getBoundingClientRect() ?? null;
  const parts={skills:pick('#skillRow'), ops:pick('.op-row'), hero:pick('.hero-panel'), stick:pick('#stickBase')};
  const hit=(a,b)=>!!a&&!!b&&Math.min(a.right,b.right)-Math.max(a.left,b.left)>0
    &&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>0;
  return {vh, hidden:document.getElementById('tutorialBar').classList.contains('hidden'),
    bar:[Math.round(bar.top),Math.round(bar.bottom)],
    clash:Object.entries(parts).filter(([,r])=>hit(bar,r)).map(([k])=>k),
    off: bar.bottom>vh+1||bar.top<-1};})()`);
check('§162 真机视口下引导条不压操作行/英雄面板（原来正好盖住它让你去点的那排按钮）',
  phoneTut.hidden === false && phoneTut.bar[1] - phoneTut.bar[0] > 20 && phoneTut.vh === 375
  && phoneTut.clash.length === 0 && !phoneTut.off,
  `引导条 y ${phoneTut.bar.join('-')} · 视口 ${phoneTut.vh} · 压到 ${phoneTut.clash.join('/') || '无'} · 越界=${phoneTut.off}`);

/* ---------- §180 真机手势卫生：双击缩放与长按选择菜单 ---------- */

// iOS Safari 为了无障碍会**忽略** `user-scalable=no`，于是「快速连点」任何 `touch-action: auto`
// 的元素都会被当成双击缩放：整页放大、HUD 跟着跑位——而技能键正是全场点得最多的东西；
// 长按同理会弹选择/查询菜单。这条**量不到症状**（headless 里没有那条手势识别器，试过：连点两下
// `visualViewport.scale` 纹丝不动），所以量的是「规则有没有真的落到元素上」：
// 每个可见按钮的 computed `touch-action` 不许是 `auto`，页面不许可选中。
// 变异：删掉 styles.css 里 §180 那两行 → 这条红。
await send('Page.navigate', { url: lobbyUrl('?mode=td&map=map_01&notutorial=1&skipstart=1') });
await send('Page.bringToFront');
await waitFor(`!!__frostfall?.match`, 10000);
await sleep(500);
const touchHygiene = await js(`(()=>{const btns=[...document.querySelectorAll('button')].filter((b)=>b.offsetParent!==null);
  const auto=btns.filter((b)=>getComputedStyle(b).touchAction==='auto').map((b)=>b.id||b.textContent.trim().slice(0,6));
  const body=getComputedStyle(document.body);
  const badge=getComputedStyle(document.getElementById('netBadge'));
  return {buttons:btns.length, auto, select:body.userSelect || body.webkitUserSelect || '',
    badge:badge.userSelect || badge.webkitUserSelect || ''};})()`);
check('§180 可点元素都关掉了浏览器的双击缩放（真机连点技能键不会把整页放大），且页面不可被选中',
  touchHygiene.buttons > 3 && touchHygiene.auto.length === 0 && touchHygiene.select === 'none'
  && touchHygiene.badge === 'text',   // 唯一的例外：房间码要能选中复制（好友房靠它）
  `${touchHygiene.buttons} 个可见按钮 · 仍是 auto 的：${touchHygiene.auto.join('/') || '无'}`
  + ` · user-select=${touchHygiene.select}（房间码徽标 ${touchHygiene.badge}）`);

/* ---------- §181 刘海 / 圆角 / home 条的安全区（§14.3 的「避开刘海与 home 条」） ---------- */

// 页面用 `viewport-fit=cover` 明确表示「铺满整块屏」，于是**躲开刘海是 CSS 的责任**——而 HUD 的
// 偏移原本全是写死的 12px / 60px。用 CDP 的安全区模拟（iPhone 14 Pro 横屏：左右 59、下 21）
// 量到的是：顶栏 / 操作行 / 技能行 / 防守轮次面板 / 小地图**全部压进刘海 47px**（验证记录 §181）。
// 这条在两个模式各量一次「**画出来的**元素有没有越过安全区」——`.hud` 这种全宽定位壳子不算
// （它没有底色/边框，真正画东西的是它的子元素，子元素各自会被量到）。
const SAFE = { top: 0, left: 59, bottom: 21, right: 59 };
const safeAreaProbe = await send('Emulation.setSafeAreaInsetsOverride', { insets: SAFE });
const safeSupported = !safeAreaProbe.error;   // 老版本 Chrome 没这条命令 → 跳过（不当失败）
const safeScan = `(()=>{const vw=innerWidth, vh=innerHeight, L=${SAFE.left}, R=vw-${SAFE.right}, T=${SAFE.top}, B=vh-${SAFE.bottom};
  const out=[];
  for (const e of document.querySelectorAll('#stage *')) {
    if (e.id === 'game' || e.closest('.hidden')) continue;
    const s=getComputedStyle(e);
    if (s.display==='none'||s.visibility==='hidden'||+s.opacity<0.05) continue;
    const r=e.getBoundingClientRect();
    if (r.width<2||r.height<2) continue;
    // 只有「真的画出来」的才算：有底色 / 有边框 / 是按钮或画布
    const painted = s.backgroundColor!=='rgba(0, 0, 0, 0)' || parseFloat(s.borderTopWidth)>0
      || e.tagName==='BUTTON' || e.tagName==='CANVAS';
    if (!painted) continue;
    const bad=[];
    if (r.left<L-0.5) bad.push('左'+Math.round(L-r.left));
    if (r.right>R+0.5) bad.push('右'+Math.round(r.right-R));
    if (r.top<T-0.5) bad.push('上'+Math.round(T-r.top));
    if (r.bottom>B+0.5) bad.push('下'+Math.round(r.bottom-B));
    if (bad.length) out.push((e.id?('#'+e.id):('.'+String(e.className).split(' ').filter(Boolean)[0]||e.tagName))+':'+bad.join('/'));
  }
  return out;})()`;
const safeHits = [];
for (const [label, q] of [['TD', '?mode=td&map=map_01&notutorial=1&skipstart=1'],
  ['防守', '?mode=defense&map=def_01&notutorial=1&skipstart=1']]) {
  await send('Page.navigate', { url: lobbyUrl(q) });
  await send('Page.bringToFront');
  await waitFor(`!!__frostfall?.match && Math.round(innerWidth)===667`, 10000);
  await sleep(600);
  const hits = await js(safeScan);
  safeHits.push(`${label}：${Array.isArray(hits) && hits.length ? hits.join(' ') : '无'}`);
}
check('§181 刘海/圆角安全区：HUD 不许压进刘海（iPhone 横屏左右各 59px）',
  !safeSupported || safeHits.every((h) => h.endsWith('无')),
  safeSupported ? safeHits.join(' · ') : '这台 Chrome 不支持安全区模拟（跳过）');
if (safeSupported) await send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, bottom: 0, right: 0 } });

/* ---------- §203 第三个视口：小屏手机 568×320（iPhone SE 一代横屏） ---------- */

// §159-§162 与 §181 都是「只在某一种视口量过」逼出来的教训：设计画布 1334×750（=667×375pt）量过、
// 真机 667×375 量过，但**更小的屏**（568×320）从来没量过——短屏专用那套紧凑排布（`max-height: 520px`）
// 在 568 宽下够不够用、热区还保不保得住，此前没有任何证据。这里把三个面各量一遍（版式 + 人体工学）。
await send('Emulation.setDeviceMetricsOverride', { width: 568, height: 320, deviceScaleFactor: 2, mobile: true });
for (const [label, q] of [['TD', '?notutorial=1&mode=td&map=map_01&skipstart=1'],
  ['防守', '?notutorial=1&mode=defense&map=def_01&skipstart=1'],
  ['大厅', '?notutorial=1']]) {
  await send('Page.navigate', { url: lobbyUrl(q) });
  await send('Page.bringToFront');
  await waitFor(`!!__frostfall?.match && Math.round(innerWidth) === 568`, 15000);
  await sleep(600);
  // 防守那一格：568×320 现在**不面向玩家**（STATUS §3.1 #33 已拍板：最小支持视口 = 667×375，
  // 更小的屏给一条「屏幕太小」），所以互压不比了；剩下两项（不许溢出、热区 ≥44）照旧必须过
  // ——它们保证「万一那条提示没出来，底下的界面也不会更糟」。
  await checkLayout(`小屏 568×320 · ${label}`, { skipOverlap: label === '防守' ? `小屏 568×320 · ${label}` : null });
  if (label !== '大厅') await checkErgonomics(`小屏 568×320 · ${label}`);
}
// STATUS §3.1 #33（已拍板）：最小支持视口 667×375——更小的屏要**明说**，而不是把挤坏的界面摆给玩家
const smallNote = await js(`(()=>{const st=document.getElementById('stage');
  return JSON.stringify({content:String(getComputedStyle(st,'::after').content),
    center:(document.elementFromPoint(Math.round(innerWidth/2), Math.round(innerHeight/2))||{}).id ?? ''});})()`);
const sn = JSON.parse(smallNote);
check('§3.1 #33 568×320 下给「屏幕太小」的明说（不再把挤坏的防守 HUD 摆给玩家）',
  /屏幕太小/.test(sn.content) && sn.center === 'stage',
  `内容「${sn.content.slice(0, 24)}…」 · 中心点命中 ${sn.center || '（无 id）'}`);
// 后面几节（§171/§183/§184…）都按真机 667×375 量，量完还原
await send('Emulation.setDeviceMetricsOverride', { width: 667, height: 375, deviceScaleFactor: 2, mobile: true });
// 反面：667×375（最小支持视口）**不许**出现那条提示——否则正常玩家会被挡在门外
await sleep(400);
const atMin = await js(`String(getComputedStyle(document.getElementById('stage'),'::after').content)`);
check('§3.1 #33 最小支持视口 667×375 下那条提示必须不在（别把正常玩家挡住）',
  atMin === 'none', `::after 内容 ${atMin}`);

/* ---------- §171 真机视口下的镜头手势：双指缩放 + 双击回核心（§2.5 / §296） ---------- */

// §2.5/§296 写的是「单指拖空白处平移、**双指缩放**、**双击回核心**」。以前只有第一条 + 桌面滚轮
// （注释还写着「滚轮缩放 = 桌面上的双指缩放」）——可手机没有滚轮，真机上这两条**完全不可用**。
// 这里在真机视口下发**合成的 PointerEvent**：多点触控 → 多个 pointer 是浏览器的保证，
// 我们要验的是页面自己那套 pointer 处理（CDP 的 touch 模拟在 headless 下只给得出一个 pointerId）。
await send('Page.navigate', { url: lobbyUrl('?mode=td&map=map_01&notutorial=1&skipstart=1') });
await send('Page.bringToFront');
await waitFor(`!!__frostfall?.match && !!__frostfall.renderer`, 10000);
await sleep(600);
const gesture = await js(`(()=>{const c=document.getElementById('game'); const box=c.getBoundingClientRect();
  const pe=(type,id,x,y)=>c.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType:'touch',
    isPrimary:id===1,clientX:x,clientY:y,bubbles:true,cancelable:true}));
  let pt=null;
  for (let y=Math.round(box.top+30); y<box.bottom-30 && !pt; y+=12)
    for (let x=Math.round(box.left+30); x<box.right-30; x+=12)
      if (document.elementFromPoint(x,y)?.id==='game') { pt={x,y}; break; }
  if (!pt) return {err:'找不到画布点'};
  const scale0=__frostfall.renderer.scale;
  pe('pointerdown',1,pt.x-40,pt.y); pe('pointerdown',2,pt.x+40,pt.y);
  for (const d of [120,160,200]) { pe('pointermove',1,pt.x-d/2,pt.y); pe('pointermove',2,pt.x+d/2,pt.y); }
  pe('pointerup',1,pt.x-100,pt.y); pe('pointerup',2,pt.x+100,pt.y);
  const scale1=__frostfall.renderer.scale;
  // 双击那半要有自己的前置：先放大（合成一个滚轮事件，走的是既有那条路），
  // 否则「整图可见」下相机被夹在地图边界里、挪不开，判据就成了空的。
  c.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,clientX:pt.x,clientY:pt.y,bubbles:true,cancelable:true}));
  const core=__frostfall.match.core.cell;
  __frostfall.renderer.setCamera(core.x+10, core.y+8, __frostfall.renderer.scale);
  const away=__frostfall.renderer.toScreen(core.x,core.y);
  const tap=(x,y)=>{ pe('pointerdown',7,x,y); pe('pointerup',7,x,y); };
  tap(pt.x,pt.y); tap(pt.x+2,pt.y+1);
  const back=__frostfall.renderer.toScreen(core.x,core.y);
  return {scale0:+scale0.toFixed(3), scale1:+scale1.toFixed(3),
    away:[Math.round(away.x),Math.round(away.y)], back:[Math.round(back.x),Math.round(back.y)],
    vw:innerWidth, vh:innerHeight};})()`);
check('§171 真机视口下双指缩放真的改相机（以前只有桌面滚轮，手机没滚轮）',
  !gesture.err && gesture.scale1 > gesture.scale0 * 1.2,
  `缩放 ${gesture.scale0} → ${gesture.scale1}（双指从 80px 拉开到 200px）`);
check('§171 真机视口下双击回核心（§2.5）',
  !gesture.err && Math.abs(gesture.back[0] - gesture.vw / 2) < 80 && Math.abs(gesture.back[1] - gesture.vh / 2) < 80
  && (Math.abs(gesture.away[0] - gesture.vw / 2) > 100 || Math.abs(gesture.away[1] - gesture.vh / 2) > 100),
  `挪开时核心在 ${gesture.away.join(',')} · 双击后回到 ${gesture.back.join(',')}（视口中心 ${Math.round(gesture.vw / 2)},${Math.round(gesture.vh / 2)}）`);

/* ---------- §178 提示音：冷启动不许假装响了，按下按钮要真的解锁 ---------- */

// 真机（iOS Safari / 移动 Chrome）的自动播放策略只认「**手势里**创建或恢复的 AudioContext」。
// 首次预警是帧循环里响的，不在任何手势里 —— 所以真机上这一声是静的，只有玩家先按过一下才响得出来。
// 这一节两条都量在**刚导航过来的干净文档**上（`Page.navigate` 不给用户激活）：
//   ① 冷启动那一声必须**老实地**记「没响」（以前写死 `played: true`，「提示音真的响了」那条检查
//      在真机上永远是绿的、而真机一声不响）；② 真按一下之后必须解锁并真的出声。
// 顺带：整个冒烟现在跑在真机那条自动播放策略下（见起 Chrome 的参数），所以这两条不是空跑。
await send('Page.navigate', { url: lobbyUrl('?notutorial=1&mode=defense&map=def_01&skipstart=1') });
await send('Page.bringToFront');
await waitFor(`location.search.includes('def_01') && !!__frostfall?.match`, 10000);
const coldCue = await js(`__frostfall.cue('warning'); __frostfall.cue.log.at(-1)`);
check('§178 还没按过任何东西时不许声称「提示音响了」（记 suspended，而不是写死 played:true）',
  coldCue?.played === false && coldCue?.reason === 'suspended' && coldCue?.state === 'suspended',
  `冷启动那一声：${JSON.stringify(coldCue)}`);
const tapPoint = await js(`(()=>{const r=document.getElementById('game').getBoundingClientRect();
  return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};})()`);
await clickCell(tapPoint);            // 真 pointerdown（不是 element.click()）
await sleep(200);
const warmedStats = await js(`__frostfall.cue.stats()`);
const warmCue = await js(`__frostfall.cue('warning'); __frostfall.cue.log.at(-1)`);
check('§178 玩家真按一下就把音频解锁了（手势里 warm → 之后那一声是 running，不是 suspended）',
  warmedStats?.warmed >= 1 && warmCue?.played === true && warmCue?.state === 'running',
  `warm ${warmedStats?.warmed} 次 · 之后那一声 ${JSON.stringify(warmCue)}`);

/* ---------- §177 坏 URL 参数不许弄死页面（它也是「档案」的污染源） ---------- */

// 开局参数（模式/地图/难度/英雄/时长）有两个来源，两个都是玩家能改的：URL 与档案里的 `lastChoice`。
// 以前都不校验、一路传到 `createMatch`，「未知英雄 / 未知地图」抛在**模块顶层**——整页白屏
// （只剩 index.html 里那 6 个没接线的静态按钮）；更糟的是 `startMatch()` 先写档案再建局，
// 脏值进了 `lastChoice` 之后**之后每次打开都白屏**（验证记录 §177）。
// 这条走真浏览器 + 真 localStorage，三步都要活着：坏参数 → 干净首页 → 防守图不带 mode。
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await send('Page.bringToFront');
await waitFor(`location.search === '?notutorial=1' && !!window.__frostfall`, 10000);
await js('localStorage.clear()');   // 干净档案：后面的「有没有被污染」才有意义
await send('Page.navigate', { url: lobbyUrl('?notutorial=1&hero=bogus&map=bogus&difficulty=bogus&length=bogus') });
await send('Page.bringToFront');
// 等「新页面自己」就绪：只等 `window.__frostfall` 会在导航交接的那一瞬读到**上一页**（§177 第一版就这么假绿过）
await waitFor(`location.search.includes('hero=bogus') && !!window.__frostfall`, 10000);
const badParams = await js(`(()=>({alive:!!window.__frostfall,
  mapId:window.__frostfall?.match?.mapId, hero:window.__frostfall?.match?.heroId,
  href:location.search,
  lobby:!document.getElementById('startScreen').classList.contains('hidden'),
  saved:JSON.parse(localStorage.getItem('frostfall:profile')??'{}')?.lastChoice ?? null}))()`);
check('§177 坏 URL 参数（?hero=bogus…）不再整页白屏，落回默认且大厅可玩',
  badParams.alive && badParams.mapId === 'map_01' && badParams.hero === 'hero_warrior' && badParams.lobby,
  `页面活着=${badParams.alive} · 图=${badParams.mapId} · 英雄=${badParams.hero} · 大厅可见=${badParams.lobby}`
  + ` · URL=${badParams.href}`);
const savedChoice = badParams.saved ?? {};
check('§177 坏参数不会被写进档案 lastChoice（否则之后每次打开都白屏）',
  savedChoice.mode === 'td' && savedChoice.map === 'map_01' && savedChoice.difficulty === 'normal'
  && savedChoice.hero === 'hero_warrior' && savedChoice.length === 'short',
  `档案里存的是 ${JSON.stringify(badParams.saved)}`);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await send('Page.bringToFront');
await waitFor(`location.search === '?notutorial=1' && !!window.__frostfall`, 10000);
const afterBad = await js(`!!window.__frostfall && __frostfall.match.mapId`);
check('§177 被脏链接写过档案之后，再打开干净首页仍然是活的', afterBad === 'map_01',
  `页面拿到的图=${afterBad ?? '（白屏）'}`);
// 同一个信任边界的另一半：防守图不带 mode 时**按地图推模式**（服务端 §121 早就是这么做的，
// 客户端漏了——`?map=def_01` 在客户端会走 TD 分支去建 `def_01`，同样白屏）。
await unlockAllMaps();   // §3.1 #29：def_03 是 ★5 图，先解锁（这条验的是「按地图推模式」）
await send('Page.navigate', { url: lobbyUrl('?notutorial=1&map=def_03&skipstart=1') });
await send('Page.bringToFront');
await waitFor(`location.search.includes('def_03') && !!__frostfall?.match && __frostfall.match.mapId === 'def_03'`, 10000);
const deepLink = await js(`({mode:__frostfall?.match?.mode, mapId:__frostfall?.match?.mapId, href:location.search})`);
check('§177 深链 `?map=def_03`（不带 mode）按地图推成防守模式，而不是白屏',
  deepLink.mode === 'defense' && deepLink.mapId === 'def_03',
  `模式=${deepLink.mode} · 图=${deepLink.mapId} · URL=${deepLink.href}`);
// 上面那条为了「进得去 def_03」写了一份全解锁档案；§184 要的是一个**干净档案**
// （它验的是「停在大厅那一局不许记档」——档案里一有战绩就看不出有没有多记），所以这里收干净。
await js(`localStorage.removeItem('frostfall:profile')`);

/* ---------- §183 本机存不了档（隐私模式 / 站点禁用存储 / 配额满）要说一声，且只说一次 ---------- */

// `saveProfile` / `saveToStorage` 一直返回成败，只是**全项目没人看过这个返回值**：隐私模式或
// 站点禁用了存储时，玩家打完一局、刷新回来什么都没有，一句解释都没有。这条把「写存储必抛」
// 的情况摆出来（`Page.addScriptToEvaluateOnNewDocument` 在页面脚本之前注入），验两件事：
// ① 启动就把这件事说出来；② **不许每 5 秒的自动存档失败一次就弹一次**（只报一次）。
const { result: failScript } = await send('Page.addScriptToEvaluateOnNewDocument', {
  // `__storagePatched` 是「这条补丁真的落到**新文档**上了」的标记：只等 `window.__frostfall`
  // 会在导航交接那一瞬读到**上一页**（§177 第一版就是这么假红过）
  source: `(()=>{window.__storagePatched=true;Storage.prototype.setItem=function(){const e=new Error('模拟：本机存不了档');e.name='QuotaExceededError';throw e;};})()`,
});
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await send('Page.bringToFront');
await waitFor(`window.__storagePatched === true && !!window.__frostfall`, 10000);
await sleep(400);
const saveWarn = await js(`JSON.stringify({toast:document.getElementById('toast').textContent,
  shown:document.getElementById('toast').classList.contains('show')})`);
check('§183 本机存不了档时要说一声（以前是静默失败：打完一局刷新全没了，零解释）',
  /存不了档/.test(JSON.parse(saveWarn).toast) && JSON.parse(saveWarn).shown === true,
  saveWarn);
// 一边打一边等自动存档跑两轮（5 秒一次）：计数必须停在 1
await js(`(()=>{window.__toasts=[]; const u=__frostfall.ui; const orig=u.toast.bind(u);
  u.toast=(t)=>{window.__toasts.push(String(t)); return orig(t);};})()`);
await click('#btnSolo');
await sleep(12000);
// 计数是从「装上计数器」那一刻开始的：开局那一声已经过去了，所以这里期望的是 **0 次新增**——
// 自动存档在 5 秒、10 秒各失败一次，如果提示会重复（没过 `saveTold` 那道闸），这里就会是 2。
const warnCount = await js(`JSON.stringify({count:window.__toasts.filter((t)=>/存不了档/.test(t)).length,
  time:Math.round(__frostfall.match?.time ?? -1), alive:!!__frostfall})`);
check('§183 存不了档只说一次（开局后自动存档连失败两次，不许再弹第二条）',
  JSON.parse(warnCount).count === 0 && JSON.parse(warnCount).time > 10 && JSON.parse(warnCount).alive,
  warnCount);
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: failScript.identifier });
// 反面：正常浏览器里**不许**出现这条提示（否则每个玩家开局都被吓一次）
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await send('Page.bringToFront');
await waitFor(`window.__storagePatched === undefined && !!window.__frostfall`, 10000);
await sleep(600);
const noWarn = await js(`document.getElementById('toast').textContent`);
check('§183 存得了档的时候不许出现这条提示（反面：别吓正常玩家）',
  !/存不了档/.test(noWarn ?? ''), `toast「${noWarn}」`);

/* ---------- §184 大厅里不许打游戏（那一局玩家还没点开局） ---------- */

// 以前只有「点回大厅」那条路会 `view.paused = true`，**首次进页面**这条初始化路径没有——于是
// 停在大厅干等的时候那一局已经在后台跑：对局时间照走、第 1 波真的出怪、漏怪会判负并**记进档案**
// （实测 `clears: {map_01: {clears:1, wins:0}}` + 声望 30），而屏幕上只有一块大厅、连结算面板都不弹。
// 这条把三件事一起钉住：时间不走 · 不出怪 · 逼一次漏怪也不会在档案里多出一局败绩。
await send('Page.navigate', { url: lobbyUrl('?notutorial=1&mode=td&map=map_01') });
await send('Page.bringToFront');
await waitFor(`location.search.includes('map_01') && !!window.__frostfall`, 10000);
await sleep(400);
const lobbyIdle0 = await js(`JSON.stringify({lobby:!document.getElementById('startScreen').classList.contains('hidden'),
  inLobby:!!__frostfall.view.inLobby, t0:+__frostfall.match.time.toFixed(2)})`);
await sleep(3000);
await js(`__frostfall.match.wave.timer = 0`);      // 逼一波：模拟真的在跑的话，这一下就会出怪
await sleep(900);
// 再逼一次「漏怪」：模拟在跑的话，怪会走到核心 → 判负 → **记进档案**（这是最疼的那半）
await js(`(()=>{const m=__frostfall.match; m.core.hp = 1; const mo=m.monsters[0]; if (mo) mo.dist = 1e9; return true;})()`);
await sleep(1200);
const lobbyIdle = await js(`JSON.stringify({t:+__frostfall.match.time.toFixed(2), wave:__frostfall.match.wave.index,
  monsters:__frostfall.match.monsters.length, result:__frostfall.match.result ?? null,
  toast:document.getElementById('toast').textContent,
  clears:JSON.parse(localStorage.getItem('frostfall:profile')??'{}').clears ?? {},
  rep:JSON.parse(localStorage.getItem('frostfall:profile')??'{}').reputation ?? 0})`);
const li = JSON.parse(lobbyIdle);
check('§184 停在大厅时那一局不许在后台跑（时间不走 · 不出怪 · 不判负 · 不记档）',
  JSON.parse(lobbyIdle0).lobby === true && JSON.parse(lobbyIdle0).inLobby === true
  && li.t === 0 && li.wave === 0 && li.monsters === 0 && li.result === null
  && Object.keys(li.clears).length === 0 && li.rep === 0 && li.toast === '',
  `大厅 ${JSON.parse(lobbyIdle0).inLobby ? '在' : '不在'} · 3 秒后对局时间 ${li.t} · 波次 ${li.wave}`
  + ` · 怪 ${li.monsters} · 结果 ${li.result} · 档案战绩 ${JSON.stringify(li.clears)} · 声望 ${li.rep} · toast「${li.toast}」`);
// 防守局建局时自己会写一条日志（「出城打野…」）——大厅里也不该把它当战斗事件弹出来
await send('Page.navigate', { url: lobbyUrl('?notutorial=1&mode=defense&map=def_01') });
await send('Page.bringToFront');
await waitFor(`location.search.includes('def_01') && !!__frostfall?.match`, 10000);
await sleep(1200);
check('§184 大厅里不弹战斗事件（防守局建局那条日志以前会直接弹在大厅上）',
  (await js(`document.getElementById('toast').textContent`)) === '',
  `toast「${await js(`document.getElementById('toast').textContent`)}」`);

/* ---------- §185 竖屏兜底：浏览器里锁不住方向，那就明说「请横屏」 ---------- */

// §14.1.1 把横屏拍死了（小游戏端能锁方向），但**浏览器端锁不住**：手机竖着打开以前一句提示都没有，
// 而布局全是横屏算的（实测竖屏 375×667：大厅要滚两屏、局内「玩家面板」被切掉 39px）。
// 这条量两件事：竖屏下有一条盖住全屏的「请横屏」（还真的挡住输入——中心点命中的是遮罩），
// 横屏下它必须**不在**（别把正常玩家挡住）。
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await send('Page.bringToFront');
await waitFor(`!!window.__frostfall && Math.round(innerWidth) === 375`, 10000);
await sleep(500);
const portrait = await js(`(()=>{const st=document.getElementById('stage');
  return JSON.stringify({vw:innerWidth, vh:innerHeight,
    content:String(getComputedStyle(st,'::after').content),
    center:(document.elementFromPoint(Math.round(innerWidth/2), Math.round(innerHeight/2))||{}).id ?? '',
    alive:!!window.__frostfall});})()`);
await send('Emulation.setDeviceMetricsOverride', { width: 667, height: 375, deviceScaleFactor: 2, mobile: true });
await sleep(400);
const landscape = await js(`(()=>{const st=document.getElementById('stage');
  return JSON.stringify({content:String(getComputedStyle(st,'::after').content),
    center:(document.elementFromPoint(Math.round(innerWidth/2), Math.round(innerHeight/2))||{}).id ?? ''});})()`);
const pr = JSON.parse(portrait); const ls = JSON.parse(landscape);
check('§185 竖屏时有一条盖住全屏的「请横屏」（并且真的挡住了输入）',
  pr.alive === true && /横屏/.test(pr.content) && pr.center === 'stage',
  `${pr.vw}×${pr.vh} · 内容「${pr.content.slice(0, 20)}…」 · 中心点命中 ${pr.center || '（无 id）'}`);
check('§185 横屏时这条遮罩必须不在（别把正常玩家挡住）',
  ls.content === 'none' && ls.center !== 'stage',
  `内容 ${ls.content} · 中心点命中 ${ls.center || '（无 id）'}`);

/* ---------- §186 首屏预算：把网络与 CPU 压到「低端 4G + 低端机」再量 ---------- */

// §10.7 那条预算是「首次进入 ≤ 3 秒（低端 4G）」，可它此前**只在 localhost 量过**（99ms），
// 4G 那一半一直写着「只能真机验」。这里用 CDP 的两把尺子把它量出来：
// `Network.emulateNetworkConditions`（1.6 Mbps / 300ms RTT，DevTools 的 Slow 4G）+ `setCPUThrottlingRate`（4×）。
// 量之前是 **3.25 秒**（超线：388 KB 的 20 个模块，光传输就 1.9 秒，再叠模块图那几跳 RTT）；
// 静态资源按需 gzip 之后 **2.38 秒**。这条以后就一直盯着这条线。
await send('Network.enable');
await send('Network.emulateNetworkConditions',
  { offline: false, latency: 300, downloadThroughput: 200000, uploadThroughput: 93750, connectionType: 'cellular4g' });
await send('Emulation.setCPUThrottlingRate', { rate: 4 });
const slowT0 = Date.now();
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await send('Page.bringToFront');
let slowUsable = 0;
for (let i = 0; i < 200 && !slowUsable; i += 1) {
  const ok = await js(`!!window.__frostfall && !document.getElementById('startScreen').classList.contains('hidden')
    && document.getElementById('btnSolo').offsetParent !== null`);
  if (ok) slowUsable = Date.now() - slowT0;
  else await sleep(50);
}
const slowBytes = await js(`(()=>{const n=performance.getEntriesByType('navigation')[0]??{};
  const res=performance.getEntriesByType('resource');
  return Math.round((res.reduce((s,r)=>s+(r.transferSize||r.encodedBodySize||0),0))+(n.transferSize||n.encodedBodySize||0));})()`);
await send('Emulation.setCPUThrottlingRate', { rate: 1 });
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
check('§186 低端 4G（1.6Mbps/300ms）+ 4× CPU 节流下，首屏仍 ≤ 3 秒（§10.7 那条线的真机那一半）',
  slowUsable > 0 && slowUsable <= 3000,
  `大厅可点 ${slowUsable}ms · 传输 ${(slowBytes / 1024).toFixed(0)} KB（未压缩时 388 KB / 3.25 秒）`);

/* ---------- §188 连打两局：第二局也要记档（「再开一局」那条路） ---------- */

// `recorded`（一局只记一次的闸）以前只在「回大厅」那条路复位，于是**点「再开一局」连打的第二局
// 战绩与声望全都不记**：结算面板照样弹、声望 toast 照样弹，档案纹丝不动（实测 30/1 局 → 还是 30/1 局）。
// 这条连打两局（两局都用「让一只怪真的走到核心」触发内核自己的漏怪分支，秒级出结果），
// 断言档案**第二局也涨**。
const loseFast = async () => {
  await js(`__frostfall.match.wave.timer = 0`);
  await sleep(600);
  await js(`(()=>{const m=__frostfall.match; m.core.hp = 1; const mo=m.monsters[0]; if (mo) mo.dist = 1e9; return true;})()`);
  await sleep(1500);
};
const profileNow = () => js(`(()=>{const p=JSON.parse(localStorage.getItem('frostfall:profile')??'{}');
  const c=p.clears?.['map_01'] ?? {};
  return JSON.stringify({rep:p.reputation??0, clears:c.clears??0, result:__frostfall.match.result ?? null});})()`);
/** §198：连打两局时顺便看 DOM 有没有一局一局长——每局挂一个监听/节点的写法在这里会露馅 */
const domNodes = () => js(`document.getElementById('stage').querySelectorAll('*').length`);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1&mode=td&map=map_01') });
await send('Page.bringToFront');
await waitFor(`location.search.includes('map_01') && !!window.__frostfall`, 10000);
await sleep(500);
await click('#btnSolo');
await sleep(900);
await loseFast();
const g1 = JSON.parse(await profileNow());
const nodes1 = await domNodes();
await click('#btnRestart');       // 「再开一局」：不经过大厅
await sleep(900);
await loseFast();
const g2 = JSON.parse(await profileNow());
const nodes2 = await domNodes();
check('§188 「再开一局」连打的第二局也记档（声望与战绩都要再涨一次）',
  g1.result === 'lose' && g2.result === 'lose' && g1.clears === 1 && g2.rep > g1.rep && g2.clears === g1.clears + 1,
  `第一局 声望 ${g1.rep}/战绩 ${g1.clears} 局 → 再开一局打完 声望 ${g2.rep}/战绩 ${g2.clears} 局`);
check('§198 连打两局 DOM 不长（每局挂一个监听/节点这类泄漏在这里会露馅）',
  typeof nodes1 === 'number' && typeof nodes2 === 'number' && nodes2 - nodes1 <= 2,
  `第一局后 ${nodes1} 个节点 → 第二局后 ${nodes2} 个（差 ${nodes2 - nodes1}）`);

// §182.2 的闸门自己也要有人守：它靠 `Page.frameNavigated` 放下。要是那条事件没来（换 CDP 版本、
// 导航失败……），`js()` 会**一直**返回 undefined，整条冒烟会变成一片看不懂的红。
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await send('Page.bringToFront');
await waitFor(`!!window.__frostfall && location.search === '?notutorial=1'`, 10000);
await sleep(300);
const gateOpen = await js('1 + 1');
check('§182.2 导航完成之后读取闸门必须放开（卡住的话整条冒烟什么都读不到）',
  gateOpen === 2, `导航后读到的值：${gateOpen}`);

/* ---------- §189 浏览器里**真的**把 12 波打完（不是用 `?result=` 直接摆结局） ---------- */

// 冒烟此前所有的「结算」都是靠调试钩子**摆出来的**（`?result=win|lose`），也就是说
// 「从大厅打到结算」这句 README 的门面话，在浏览器里从没被完整跑过一遍（12 波、Boss、结算数据、
// 记档、解锁）。这里用 app 自己的 `?debug=1&sim=` 钩子（§141）让参考打法在**浏览器里**把整局打完
// （`autoPlay` 遇到 `result` 就停），再核对结算面板与档案。实测：整段快进 + 加载约 1.7 秒。
const repBefore = await js(`JSON.parse(localStorage.getItem('frostfall:profile')??'{}').reputation ?? 0`);
const winsBefore = await js(`JSON.parse(localStorage.getItem('frostfall:profile')??'{}').clears?.map_01?.wins ?? 0`);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1&mode=td&map=map_01&skipstart=1&debug=1&sim=3000') });
await send('Page.bringToFront');
await waitFor(`!!__frostfall?.match && __frostfall.match.result === 'win'`, 20000);
await sleep(800);
const fullRun = await js(`(()=>{const m=__frostfall.match, p=JSON.parse(localStorage.getItem('frostfall:profile')??'{}');
  return JSON.stringify({result:m.result, wave:m.wave.index, time:Math.round(m.time), towers:m.towers.length,
    leaks:m.stats?.leaks ?? -1, core:m.core.hp,
    panel:!document.getElementById('overPanel').closest('.hidden'),
    title:document.getElementById('overTitle').textContent,
    rows:document.getElementById('resultRows').textContent.replace(/\\s+/g,' '),
    rep:p.reputation ?? 0, wins:p.clears?.map_01?.wins ?? 0, best:p.clears?.map_01?.bestTimeSec ?? null,
    unlocked:Object.keys(p.unlocks ?? {}).length});})()`);
const fr = JSON.parse(fullRun);
check('§189 浏览器里真的把 12 波打完：结局是通关、第 12 波、结算面板跟着弹（数据不是摆出来的）',
  fr.result === 'win' && fr.wave === 12 && fr.towers >= 12 && fr.time > 240 && fr.time < 1200
  && fr.panel === true && /通关/.test(fr.title) && /单局时长/.test(fr.rows) && /漏怪/.test(fr.rows),
  `第 ${fr.wave} 波 · ${(fr.time / 60).toFixed(1)} 分钟 · 塔 ${fr.towers} 座 · 漏 ${fr.leaks} · 核心 ${fr.core}`
  + ` · 面板「${fr.title}」`);
check('§189 这一局**真的**记进了档案（声望 +120、战绩 +1 胜、最快通关时间=本局）',
  fr.rep === repBefore + 120 && fr.wins === winsBefore + 1 && fr.best === fr.time,
  `声望 ${repBefore} → ${fr.rep} · 胜场 ${winsBefore} → ${fr.wins} · bestTimeSec ${fr.best}（本局 ${fr.time}s）`);

/* ---------- §190 防守也真的从开局打到「守住了」的结算 ---------- */

// §189 把 TD 那条「从大厅打到结算」跑通了，防守这一半同样是靠 `?result=` 摆结局的（§131 那几条）。
// 这条用同一套 `?debug=1&sim=` 让参考打法在**浏览器里**守住 4 轮（autoPlayDefense 跑到 `m.over` 停），
// 再核对结算面板与档案；最后把「无尽里被反推」那个状态摆出来，验 §190 的假出口有没有收掉。
const repBeforeD = await js(`JSON.parse(localStorage.getItem('frostfall:profile')??'{}').reputation ?? 0`);
const winsBeforeD = await js(`JSON.parse(localStorage.getItem('frostfall:profile')??'{}').clears?.def_01?.wins ?? 0`);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1&mode=defense&map=def_01&skipstart=1&debug=1&sim=1200') });
await send('Page.bringToFront');
await waitFor(`!!__frostfall?.match && __frostfall.match.result === 'win'`, 25000);
await sleep(800);
const defRun = await js(`(()=>{const m=__frostfall.match, p=JSON.parse(localStorage.getItem('frostfall:profile')??'{}');
  const rec=p.clears?.def_01 ?? {};
  return JSON.stringify({result:m.result, rounds:m.stats.roundsCleared, time:Math.round(m.time),
    panel:!document.getElementById('overPanel').closest('.hidden'),
    title:document.getElementById('overTitle').textContent,
    rows:document.getElementById('resultRows').textContent.replace(/\\s+/g,' '),
    endlessBtn:!document.getElementById('btnEndless').classList.contains('hidden'),
    rep:p.reputation ?? 0, wins:rec.wins ?? 0, bestRounds:rec.bestRounds ?? 0});})()`);
const dr = JSON.parse(defRun);
// §3.1 #27 之后，无尽爬升从 1.25ⁿ 放缓到 1.15ⁿ：这场 `?sim=1200` 会一直跑到城堡陷落，
// 于是「守住的轮次」比 4 更多（实测 5-6 轮、18 分钟左右）。这里断言的是**至少**守住 4 轮——
// 它原本想验的是「真的打到了通关线」，写成 `=== 4` 会随无尽强度变化偶发红。
check('§190 浏览器里真的守住 4 轮：结算面板「守住了！」+ 出口「继续（无尽）」都在',
  dr.result === 'win' && dr.rounds >= 4 && dr.panel === true && /守住了/.test(dr.title)
  && /守住轮次/.test(dr.rows) && dr.time > 400,
  `第 ${dr.rounds} 轮守住 · ${(dr.time / 60).toFixed(1)} 分钟 · 面板「${dr.title}」`);
check('§190 这一局也真的进了档案（声望 +120、def_01 守住 4 轮）',
  dr.rep === repBeforeD + 120 && dr.wins === winsBeforeD + 1 && dr.bestRounds >= 4,
  `声望 ${repBeforeD} → ${dr.rep} · def_01 胜场 ${winsBeforeD} → ${dr.wins} · 最好轮次 ${dr.bestRounds}`);
// 「继续（无尽）」这个出口的开合必须与「还能继续」一致。注意这场快进会一直打到 `m.over`（无尽被反推），
// 所以不能假定「现在一定还活着」——两个方向各摆一次，都看面板：
const endlessState = () => js(`(()=>{const m=__frostfall.match;
  return JSON.stringify({alive:!!m.assault?.endless && !m.over,
    btn:!document.getElementById('btnEndless').classList.contains('hidden'),
    title:document.getElementById('overTitle').textContent,
    rows:document.getElementById('resultRows').textContent.replace(/\\s+/g,' ')});})()`);
await js(`(()=>{const m=__frostfall.match; m.castle.hp = 0; m.over = true; return true;})()`);
await sleep(500);
const on = JSON.parse(await endlessState());
check('§190 城堡陷落之后不许再给「继续（无尽）」（点下去只是露出一个死场），胜局仍然保留',
  on.alive === false && on.btn === false && /守住了/.test(on.title) && !/无尽中/.test(on.rows),
  `面板「${on.title}」· 无尽出口 ${on.btn} · 轮次行「${(on.rows.match(/守住轮次[^城]*/) ?? [''])[0].trim()}」`);
// 反过来：还在无尽里（城堡有血、`m.over` 复位）时，出口必须给回来
await js(`(()=>{const m=__frostfall.match; m.castle.hp = 1200; m.over = false; return true;})()`);
await sleep(500);
const back = JSON.parse(await endlessState());
check('§190 还在无尽里时「继续（无尽）」要给回来（这道闸不能单向卡死）',
  back.alive === true && back.btn === true && /无尽中/.test(back.rows),
  `无尽出口 ${back.btn} · 轮次行「${(back.rows.match(/守住轮次[^城]*/) ?? [''])[0].trim()}」`);

/* ---------- §191 长局（30 波）在浏览器里真的打完 ---------- */

// §189/§190 把两种模式的**短局**跑通了；长局（§6.4 的 30 波 + 三个 Boss）在浏览器里从没打完过——
// 冒烟只有「长局 HUD 报 30 波」那一条（而且是在第 0 波量的）。这条同样用 `?debug=1&sim=3600` 打满：
// 断言「真的到了第 30 波、HUD 与结算面板都对上、时长落在 §2201 的 25-40 分钟带里、档案按结果记」
// （结局不写死：参考打法在 4★ 图上实测会输，胜负随档案等级也会飘——写死胜负就成了偶发红）。
await unlockAllMaps();   // §3.1 #29：map_06 是 6★ 图（要通关 map_05），深链进不去——先解锁
const longBefore = await js(`(()=>{const p=JSON.parse(localStorage.getItem('frostfall:profile')??'{}');
  const r=p.clears?.map_06 ?? {}; return JSON.stringify({rep:p.reputation??0, clears:r.clears??0, wins:r.wins??0, best:r.bestTimeSec??null});})()`);
const lb = JSON.parse(longBefore);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1&mode=td&map=map_06&length=long&skipstart=1&debug=1&sim=3600') });
await send('Page.bringToFront');
await waitFor(`!!__frostfall?.match && !!__frostfall.match.result`, 30000);
await sleep(800);
const longRun = await js(`(()=>{const m=__frostfall.match, p=JSON.parse(localStorage.getItem('frostfall:profile')??'{}');
  const r=p.clears?.map_06 ?? {};
  return JSON.stringify({result:m.result, wave:m.wave.index, waves:m.waves.length, time:Math.round(m.time),
    towers:m.towers.length, hero:m.hero.level, waveLabel:document.getElementById('waveLabel')?.textContent ?? '',
    panel:!document.getElementById('overPanel').closest('.hidden'),
    title:document.getElementById('overTitle').textContent,
    rows:document.getElementById('resultRows').textContent.replace(/\\s+/g,' '),
    rep:p.reputation??0, clears:r.clears??0, wins:r.wins??0, best:r.bestTimeSec??null});})()`);
const lr = JSON.parse(longRun);
check('§191 长局在浏览器里真的打到第 30 波（HUD 与结算面板都对上，时长落在 25-40 分钟带里）',
  (lr.result === 'win' || lr.result === 'lose') && lr.wave === 30 && lr.waves === 30
  && lr.time >= 25 * 60 && lr.time <= 40 * 60
  && lr.waveLabel === '第 30 / 30 波' && lr.panel === true
  && (lr.result === 'win' ? /通关/.test(lr.title) : /核心被摧毁/.test(lr.title))
  && /结算时刻/.test(lr.rows) && /第 30 波/.test(lr.rows),
  `${lr.result} · 第 ${lr.wave}/${lr.waves} 波 · ${(lr.time / 60).toFixed(1)} 分钟 · 塔 ${lr.towers} · Lv${lr.hero}`
  + ` · HUD「${lr.waveLabel}」· 面板「${lr.title}」`);
check('§191 长局这一局也真的进了档案（胜局写最快通关，败局不动那个字段）',
  lr.clears === lb.clears + 1
  && lr.rep === lb.rep + (lr.result === 'win' ? 120 : 30)
  && (lr.result === 'win' ? lr.wins === lb.wins + 1 && lr.best === lr.time : lr.wins === lb.wins && lr.best === lb.best),
  `声望 ${lb.rep} → ${lr.rep} · 通关 ${lb.clears} → ${lr.clears} 局 · 胜 ${lb.wins} → ${lr.wins}`
  + ` · bestTimeSec ${lb.best} → ${lr.best}（本局 ${lr.time}s）`);

/* ---------- §192 中途加入一个**已经在打**的房（正面路径，以前只验过「过窗口被拒」） ---------- */

// §12.3 的窗口那条只验了拒绝（第 4 波起不收新人）；**正面路径**（第 3 波时新面孔进来，镜像与 HUD
// 直接对齐到那一局，而不是从第 0 波开始）此前一次都没验过。这里用调试钩子 `/create?wave=3` 先把房
// 推到第 3 波（冒烟起服时 FF_DEBUG_HOOKS=1），再让浏览器以新面孔进去。
const midRoom = await (await fetch(`http://127.0.0.1:${SERVE_PORT}/create?map=map_01&mode=td&wave=3&length=short`)).json();
await sleep(2500);
const midUrl = new URL(lobbyUrl('?notutorial=1'));
for (const [k, v] of Object.entries({ room: midRoom.code, map: 'map_01', mode: 'td', length: 'short', difficulty: 'normal', hero: 'hero_warrior' })) {
  midUrl.searchParams.set(k, v);
}
await send('Page.navigate', { url: midUrl.toString() });
await send('Page.bringToFront');
await waitFor(`!!__frostfall?.net?.state?.connected`, 15000);
await sleep(1200);
const midA = await js(`JSON.stringify({room:__frostfall.net.state.roomCode, slot:__frostfall.net.state.slot,
  players:__frostfall.net.state.players.length, wave:__frostfall.match.wave.index, time:Math.round(__frostfall.match.time),
  hudWave:document.getElementById('waveLabel')?.textContent ?? '',
  err:__frostfall.net.state.error ?? null, connected:!!__frostfall.net.state.connected,
  search:location.search, uid:localStorage.getItem('frostfall:uid')})`);
await sleep(1800);
const midB = await js(`JSON.stringify({time:Math.round(__frostfall.match.time), wave:__frostfall.match.wave.index})`);
const ma = JSON.parse(midA); const mb = JSON.parse(midB);
check('§192 中途加入已在打第 3 波的房：镜像与 HUD 直接对齐到那一局（不是从第 0 波开始）',
  ma.room === midRoom.code && ma.wave === 3 && /第 3 \/ 12 波/.test(ma.hudWave),
  `房间 ${ma.room}（期望 ${midRoom.code}）· 座位 ${ma.slot} · ${ma.players} 人 · 镜像第 ${ma.wave} 波`
  + ` · HUD「${ma.hudWave}」· connected=${ma.connected} · 错误「${ma.err}」· uid ${ma.uid} · ${ma.search}`);
check('§192 中途加入之后快照在推（时间自己往前走，不是冻住的一张图）',
  mb.time > ma.time && mb.wave === ma.wave,
  `${ma.time}s → ${mb.time}s（第 ${mb.wave} 波）`);

/* ---------- §197 调试钩子 `sim` 只在**本机**生效（URL 参数挡不住玩家，§126 的同一条规矩） ---------- */

// §141 给 `?sim=` 加的闸是「要显式带 `?debug=1` 才生效」——可那也是个 URL 参数，玩家照样能加：
// 分享链接后面补两个参数，AI 替他把整局打完，声望 +120、地图解锁照给（§189 探针实测过）。
// 服务端同款钩子（`?wave=`）在 §126 已经改成「用**非 URL** 的开关」，这里照同一条规矩：
// `sim` 只在 localhost / 127.0.0.1 / ::1 生效。冒烟用 Chrome 的 host-resolver-rules 把
// `game.test` 指到本机来验「换个域名就不认」——不用改 /etc/hosts，也不依赖外网 DNS。
const alienUrl = new URL(lobbyUrl('?notutorial=1&mode=td&map=map_01&debug=1&sim=600'));
alienUrl.hostname = 'game.test';
await send('Page.navigate', { url: alienUrl.toString() });
await send('Page.bringToFront');
await waitFor(`!!window.__frostfall?.match`, 15000);
await sleep(800);
const alienSim = await js(`JSON.stringify({host:location.hostname, time:+__frostfall.match.time.toFixed(2),
  wave:__frostfall.match.wave.index, inLobby:!!__frostfall.view.inLobby})`);
const as = JSON.parse(alienSim);
check('§197 非本机域名下 `?debug=1&sim=` 不生效（钩子不能跟着分享链接走出去）',
  as.host === 'game.test' && as.time < 5 && as.wave === 0,
  `${as.host} · 对局时间 ${as.time}s · 波次 ${as.wave}（本机跑同一串是会快进到 ~600 秒的）`);
// 反面：本机（127.0.0.1）下同一个钩子必须照常快进——别把开发工具一起关掉
await send('Page.navigate', { url: lobbyUrl('?notutorial=1&mode=td&map=map_01&skipstart=1&debug=1&sim=300') });
await send('Page.bringToFront');
await waitFor(`!!__frostfall?.match && __frostfall.match.time > 100`, 15000);
const localSim = await js(`JSON.stringify({host:location.hostname, time:Math.round(__frostfall.match.time)})`);
const ls2 = JSON.parse(localSim);
check('§197 本机下同一个钩子照常快进（开发/截图用的路没被封）',
  ls2.host === '127.0.0.1' && ls2.time >= 100, `${ls2.host} · 对局时间 ${ls2.time}s`);

/* ---------- §200 画布真的画了东西（版式体检管不到「一片空白」） ---------- */

// 冒烟里所有关于画面的断言都是**几何**的（元素位置、热区、互相不压）——一条也不看画布内容。
// 于是「渲染整个坏掉、只剩背景色」这种事故在这里是**全绿**的（截图靠人看，人总有没看的时候）。
// 这条数画布上的**颜色种类**：正常一帧（地形 + 塔 + 怪 + 血条 + 飘字）远不止几种颜色；
// 空画布/单色画布会当场露馅。
const inkKinds = async (sel) => js(`(()=>{const c=document.querySelector(${JSON.stringify(sel)});
  if(!c||!c.width||!c.height) return -1;
  const g=c.getContext('2d'); if(!g) return -1;
  const w=c.width, h=c.height, d=g.getImageData(0,0,w,h).data, seen=new Set();
  for (let y=0;y<h;y+=3) for (let x=0;x<w;x+=3){ const o=(y*w+x)*4; seen.add(d[o]+','+d[o+1]+','+d[o+2]); if (seen.size>60) return seen.size; }
  return seen.size;})()`);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1&mode=td&map=map_01&skipstart=1') });
await send('Page.bringToFront');
await waitFor(`!!__frostfall?.match && __frostfall.match.time > 0`, 15000);
await js(`__frostfall.match.wave.timer = 0`);     // 让场上有怪（颜色更多，也更接近玩家看到的那一帧）
await sleep(1500);
const inkTd = await inkKinds('#game');
check('§200 战场画布真的画了东西（颜色种类远超「一片底色」）', inkTd > 20, `主画布颜色种类 ${inkTd}`);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1&mode=defense&map=def_01&skipstart=1') });
await send('Page.bringToFront');
await waitFor(`!!__frostfall?.match && __frostfall.match.mode === 'defense'`, 15000);
await sleep(1500);
const inkMap = await inkKinds('#minimap');
check('§200 防守的小地图也真的画了东西（它是跟随相机下唯一的全局视图）', inkMap > 5, `小地图颜色种类 ${inkMap}`);
// §201：同一条尺子换个地方——**防守的战场**是另一条渲染路径（`drawDefense`），
// 大厅的**地图缩略图**又是第三个（`drawMapThumb`）。三块画布三个函数，一条中招另外两条不会红。
const inkDefArena = await inkKinds('#game');
check('§201 防守的战场画布也真的画了东西（和 TD 走的是不同的绘制分支）', inkDefArena > 20,
  `防守主画布颜色种类 ${inkDefArena}`);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1') });
await send('Page.bringToFront');
await waitFor(`!!window.__frostfall && !document.getElementById('startScreen').classList.contains('hidden')`, 15000);
await sleep(600);
const inkThumb = await inkKinds('.map-card .thumb');
check('§201 大厅的地图缩略图也真的画了东西（第三个画布函数 drawMapThumb）', inkThumb > 2,
  `缩略图颜色种类 ${inkThumb}`);

/* ---------- §202 画布不只要「画了东西」，还要**在动** ---------- */

// §200/§201 只采样**一帧**——「画了一帧就不再更新」照样能过（画布留着一帧旧像素，颜色种类还是那么多）。
// 这条量「画面在动」：同一块画布隔 400ms 取两次像素哈希，必须不同。场上有怪在走（速度 320/秒 ≈ 5 格/秒），
// 所以差异是必然的；真正会红的是「渲染只跑了一次」或「时间在走、画面不动」这类事故。
const canvasHash = (sel) => js(`(()=>{const c=document.querySelector(${JSON.stringify(sel)});
  if(!c||!c.width||!c.height) return -1;
  const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let h=0;
  for (let y=0;y<c.height;y+=7) for (let x=0;x<c.width;x+=7){ const o=(y*c.width+x)*4;
    h=(h*31+d[o]+d[o+1]*3+d[o+2]*7)>>>0; }
  return h;})()`);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1&mode=td&map=map_01&skipstart=1') });
await send('Page.bringToFront');
await waitFor(`!!__frostfall?.match && __frostfall.match.time > 0`, 15000);
await js(`__frostfall.match.wave.timer = 0`);
await sleep(1200);
const alive1 = await js(`__frostfall.match.monsters.length`);
const hash1 = await canvasHash('#game');
await sleep(400);
const alive2 = await js(`__frostfall.match.monsters.length`);
const hash2 = await canvasHash('#game');
check('§202 战场画布在**动**（两帧像素不同；「画了一帧就不更新」这条会红）',
  alive1 > 0 && alive2 > 0 && hash1 !== -1 && hash2 !== -1 && hash1 !== hash2,
  `场上怪 ${alive1}→${alive2} · 像素哈希 ${hash1} → ${hash2}${hash1 === hash2 ? '（没变！）' : ''}`);

/* ---------- §3.1 #29 深链进锁着的图 / `skipstart` 页上的「回大厅」 ---------- */

// ① 大厅里锁着的图点不动，但**深链能绕过去**：`?map=map_06`（更彻底的是 `skipstart`，连大厅都不进）
//    以前直接开局、结束照样记档。这条用**全新档案**（只有 map_01）深链进 map_06，断言换成能玩的图 + 有提示。
//    （toast 的 textContent 在隐藏后仍留着最后一条文案，所以读它不必抢那 1.6 秒。）
await js(`localStorage.removeItem('frostfall:profile')`);
await send('Page.navigate', { url: lobbyUrl('?mode=td&map=map_06&skipstart=1&notutorial=1') });
await send('Page.bringToFront');
await waitFor(`!!__frostfall?.match`, 12000);
await sleep(500);
const lockedDeepLink = await js(`({map: __frostfall.match.mapId, toast: document.getElementById('toast').textContent})`);
check('§3.1 #29 深链进锁着的图 → 按档案换成已解锁的图，并把这件事说出来',
  lockedDeepLink.map === 'map_01' && String(lockedDeepLink.toast).includes('还没解锁'),
  `实际跑的是 ${lockedDeepLink.map} · 提示「${lockedDeepLink.toast}」`);

// ② `skipstart` 只该跳过**这一页开头**那次大厅：以前它永久生效，于是深链页上点「回大厅」时
//    `setupStartScreen()` 又一次直接 return —— 玩家看到的是一块空白战场、一个可点的按钮都没有（§113 的同一场面）。
await click('#btnPause');
await sleep(200);
await click('#btnLobby');
await sleep(400);
const backToLobby = await js(`({hidden: document.getElementById('startScreen').classList.contains('hidden'),
  solo: !!document.getElementById('btnSolo')?.offsetParent, time: __frostfall.match.time})`);
check('§3.1 #29 `skipstart` 页上点「回大厅」真的回到大厅（不是一块空白战场）',
  backToLobby.hidden === false && backToLobby.solo === true && backToLobby.time === 0,
  `开始界面 hidden=${backToLobby.hidden} · 「单人开局」可见=${backToLobby.solo} · 新局时间=${backToLobby.time}`);

/* ---------- §3.1 #31 联机局的「离开房间」出口 ---------- */

// 单人局里这一格必须收起（单人的出口在暂停面板上，重复摆一个只会让人以为点了会掉线）；
// 联机局里必须摆出来，**而且点了真的退房回大厅**（§3.1 #23 的 `leave`：座位立刻释放）。
await click('#btnSettings');
await sleep(250);
const soloLeaveRow = await js(`document.getElementById('rowLeaveRoom').classList.contains('hidden')`);
await send('Page.navigate', { url: lobbyUrl('?notutorial=1&online=1&map=map_01') });
await send('Page.bringToFront');
await waitFor(`!!__frostfall?.net?.state?.connected`, 12000);
await sleep(400);
await click('#btnSettings');
await sleep(250);
const onlineLeaveRow = await js(`!document.getElementById('rowLeaveRoom').classList.contains('hidden')`);
await click('#btnLeaveRoom');
await sleep(1200);
const afterLeave = await js(`({lobby: !document.getElementById('startScreen').classList.contains('hidden'),
  online: !!__frostfall.net, search: location.search})`);
check('§3.1 #31 联机局有「离开房间（回大厅）」出口（单人局收起），点了真的退房回大厅',
  soloLeaveRow === true && onlineLeaveRow === true && afterLeave.lobby === true && afterLeave.online === false,
  `单人局里收起=${soloLeaveRow} · 联机局里可见=${onlineLeaveRow} · 点后大厅可见=${afterLeave.lobby}`
  + ` · 仍在联机=${afterLeave.online} · URL=${afterLeave.search}`);

check('全部路径零未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));
console.log(`截图：${shotLobby}\n      ${shotTd}\n      ${shotPhone}\n      ${shotDef}\n      ${shotOnline}\n      ${shotDuo}\n      ${shotOnlineDef}\n      ${shotResult}\n      ${shotDefEnd}\n      ${shotLose}`);

ws.close();
chrome.kill('SIGKILL');
server?.kill('SIGTERM');
console.log(fails.length ? `\n❌ ${fails.length}/${total} 项没过：${fails.join('、')}` : `\n✅ 全部通过（共 ${total} 条）`);
process.exit(fails.length ? 1 : 0);
